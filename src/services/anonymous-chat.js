import {
  answerCallbackQuery,
  deleteTelegramMessage,
  editTelegramReplyMarkupDetailed,
  sendInlineTelegramDetailed,
  sendMediaTelegramDetailed,
  sendMessageTelegramDetailed,
  sendTelegram,
  sendTrackedSectionInlineTelegram
} from "../telegram/api.js";
import {
  conversationMediaFromMessage,
  conversationMessageControls,
  deliverClaimedConversationMessage,
  isBotCommand,
  isPrivateConversationMessage,
  sendConversationReadReceipt,
  sendConversationContent
} from "./conversation-engine.js";

const INBOX_PAGE_SIZE = 8;
const ARCHIVE_PAGE_SIZE = 8;
const HISTORY_PAGE_SIZE = 6;
const OWNER_TEXT_EXPORT_PAGE_SIZE = 8;
const OWNER_TEXT_EXPORT_MESSAGE_LENGTH = 3600;
export const CHAT_RETURN_BUTTON = "بازگشت به منوی اصلی";
export const CHAT_RETURN_KEYBOARD = [[{ text: CHAT_RETURN_BUTTON }]];

const MEDIA_METHODS = {
  photo: "sendPhoto",
  video: "sendVideo",
  document: "sendDocument",
  audio: "sendAudio",
  voice: "sendVoice",
  animation: "sendAnimation",
  video_note: "sendVideoNote",
  sticker: "sendSticker"
};

const SOURCE_LABELS = {
  random_chat: "چت ناشناس تصادفی",
  connection: "ارتباط از پست کانال",
  personal_link: "لینک اختصاصی",
  username: "ارتباط با آیدی"
};

const NAVIGATION_TEXTS = new Set([
  "/start", "/menu", "🏠 منوی اصلی", "⬅️ بازگشت",
  CHAT_RETURN_BUTTON,
  "🎭 ارتباط ناشناس", "🎭 چت ناشناس تصادفی",
  "🔗 لینک ناشناس من", "🔗 لینک اختصاصی چت", "🔎 ارتباط با آیدی", "🔔 اعلان‌ها",
  "🤝 درخواست‌های ارتباط از کانال", "👤 پروفایل من",
  "💌 ثبت پست کراش", "📚 ثبت کراش‌های من",
  "📖 راهنما و قوانین", "📢 ثبت درخواست تبلیغات",
  "🛠 پنل مدیریت", "👤 پنل کاربر"
]);

function mediaFromMessage(message) {
  return conversationMediaFromMessage(message);
}

function messageContent(message) {
  return String(message?.text ?? message?.caption ?? "").trim();
}

function privateActor(query) {
  const actorId = query?.from?.id;
  const chatId = query?.message?.chat?.id;
  return Number.isSafeInteger(actorId) && actorId > 0 &&
    Number.isSafeInteger(query?.message?.message_id) &&
    query?.message?.chat?.type === "private" &&
    String(actorId) === String(chatId) ? actorId : null;
}

function validPage(page) {
  return Number.isSafeInteger(page) && page >= 0 &&
    Number.isSafeInteger(page * ARCHIVE_PAGE_SIZE);
}

function newToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `anon_${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
}

async function botUsername(env) {
  const saved = await env.CRASH_BOT_DB.prepare(
    "SELECT value FROM bot_settings WHERE key = 'telegram_bot_username'"
  ).first();
  const value = String(saved?.value ?? env.TELEGRAM_BOT_USERNAME ?? "")
    .replace(/^@/, "");
  return /^[A-Za-z0-9_]{5,32}$/.test(value) ? value : null;
}

async function createConversation(env, firstUserId, secondUserId, sourceType) {
  const userAId = Math.min(Number(firstUserId), Number(secondUserId));
  const userBId = Math.max(Number(firstUserId), Number(secondUserId));
  const row = await env.CRASH_BOT_DB.prepare(`
    INSERT INTO anonymous_conversations
      (user_a_id, user_b_id, source_type, status, updated_at)
    VALUES (?, ?, ?, 'active', CURRENT_TIMESTAMP)
    ON CONFLICT(user_a_id, user_b_id, source_type) DO UPDATE SET
      status = 'active',
      ended_at = NULL,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id
  `).bind(userAId, userBId, sourceType).first();
  if (!row?.id) throw new Error("Could not open anonymous conversation");
  return row.id;
}

export async function selectConversation(env, actorId, conversationType, conversationId) {
  if (!["random_chat", "connection", "personal_link", "username"].includes(conversationType) ||
      !Number.isSafeInteger(Number(conversationId)) || Number(conversationId) <= 0) {
    throw new Error("Invalid active conversation selection");
  }
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO active_conversation_selections (
      actor_id, conversation_type, conversation_id, updated_at
    ) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(actor_id) DO UPDATE SET
      conversation_type = excluded.conversation_type,
      conversation_id = excluded.conversation_id,
      updated_at = CURRENT_TIMESTAMP
  `).bind(actorId, conversationType, conversationId).run();
}

export async function clearConversationSelection(env, actorId, reference) {
  if (reference) {
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM active_conversation_selections
      WHERE actor_id = ? AND conversation_type = ? AND conversation_id = ?
    `).bind(actorId, reference.type, reference.id).run();
    return;
  }
  await env.CRASH_BOT_DB.prepare(
    "DELETE FROM active_conversation_selections WHERE actor_id = ?"
  ).bind(actorId).run();
}

export async function getConversationSelection(env, actorId) {
  return env.CRASH_BOT_DB.prepare(`
    SELECT conversation_type, conversation_id
    FROM active_conversation_selections WHERE actor_id = ?
  `).bind(actorId).first();
}

async function setConversationState(
  env, userId, conversationId, conversationType = "personal_link"
) {
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO anonymous_chat_states
      (user_id, state, target_user_id, conversation_id, updated_at)
    VALUES (?, 'active', NULL, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      state = 'active',
      target_user_id = NULL,
      conversation_id = excluded.conversation_id,
      updated_at = CURRENT_TIMESTAMP
  `).bind(userId, conversationId).run();
  await selectConversation(env, userId, conversationType, conversationId);
}

async function saveMessageNotification(env, messageId, recipientId, sourceType) {
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO anonymous_message_inbox (message_id, recipient_id, source_type)
    SELECT m.id, m.recipient_id, ?
    FROM anonymous_messages m
    WHERE m.id = ? AND m.recipient_id = ?
    ON CONFLICT(message_id) DO NOTHING
  `).bind(sourceType, messageId, recipientId).run();
  return env.CRASH_BOT_DB.prepare(`
    SELECT id, message_id, recipient_id, source_type, delivery_status
    FROM anonymous_message_inbox WHERE message_id = ? AND recipient_id = ?
  `).bind(messageId, recipientId).first();
}

function threadReference(sourceType, conversationId, sessionId, connectionId) {
  if (sourceType === "random_chat") {
    return { type: "random_chat", id: sessionId };
  }
  if (sourceType === "connection") {
    return { type: "connection", id: connectionId };
  }
  return { type: sourceType, id: conversationId };
}

export async function isConversationBlocked(env, reference, firstUserId, secondUserId) {
  if (!reference?.id) return false;
  const row = await env.CRASH_BOT_DB.prepare(`
    SELECT 1 FROM conversation_blocks
    WHERE conversation_type = ? AND conversation_id = ?
      AND (
        (blocker_id = ? AND blocked_id = ?)
        OR (blocker_id = ? AND blocked_id = ?)
      )
    LIMIT 1
  `).bind(
    reference.type, reference.id,
    firstUserId, secondUserId, secondUserId, firstUserId
  ).first();
  return Boolean(row);
}

async function setReplyContext(env, actorId, messageId, reference, peerId) {
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO conversation_reply_contexts (
      actor_id, message_id, conversation_type, conversation_id, peer_id,
      expires_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, datetime('now', '+15 minutes'), CURRENT_TIMESTAMP)
    ON CONFLICT(actor_id, conversation_type, conversation_id, peer_id) DO UPDATE SET
      message_id = excluded.message_id,
      conversation_type = excluded.conversation_type,
      conversation_id = excluded.conversation_id,
      peer_id = excluded.peer_id,
      expires_at = excluded.expires_at,
      updated_at = CURRENT_TIMESTAMP
  `).bind(actorId, messageId, reference.type, reference.id, peerId).run();
}

export async function getConversationReplyMessageId(env, actorId, reference, peerId) {
  const row = await env.CRASH_BOT_DB.prepare(`
    SELECT message_id FROM conversation_reply_contexts
    WHERE actor_id = ? AND conversation_type = ? AND conversation_id = ?
      AND peer_id = ? AND expires_at > CURRENT_TIMESTAMP
  `).bind(actorId, reference.type, reference.id, peerId).first();
  return row?.message_id ?? null;
}

export async function clearConversationReplyContext(env, actorId, reference, peerId) {
  if (reference && peerId != null) {
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM conversation_reply_contexts
      WHERE actor_id = ? AND conversation_type = ? AND conversation_id = ?
        AND peer_id = ?
    `).bind(actorId, reference.type, reference.id, peerId).run();
    return;
  }
  if (reference) {
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM conversation_reply_contexts
      WHERE actor_id = ? AND conversation_type = ? AND conversation_id = ?
    `).bind(actorId, reference.type, reference.id).run();
    return;
  }
  await env.CRASH_BOT_DB.prepare(
    "DELETE FROM conversation_reply_contexts WHERE actor_id = ?"
  ).bind(actorId).run();
}

export async function registerAnonymousMessageNotification(
  env, messageId, recipientId, sourceType
) {
  await saveMessageNotification(env, messageId, recipientId, sourceType);
  return deliverAnonymousMessageNotification(env, messageId);
}

async function recoverStaleAnonymousWork(env, messageId = null) {
  const messageFilter = messageId === null ? "" : "AND message_id = ?";
  const stale = await env.CRASH_BOT_DB.prepare(`
    SELECT id, message_id FROM anonymous_message_inbox
    WHERE delivery_status = 'sending'
      AND updated_at < datetime('now', '-15 minutes')
      ${messageFilter}
  `).bind(...(messageId === null ? [] : [messageId])).all();
  for (const item of stale.results ?? []) {
    await env.CRASH_BOT_DB.batch([
      env.CRASH_BOT_DB.prepare(`
        UPDATE anonymous_message_inbox
        SET delivery_status = 'unknown',
          last_error = 'Stale delivery claim; automatic retry suppressed',
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND delivery_status = 'sending'
          AND updated_at < datetime('now', '-15 minutes')
      `).bind(item.id),
      env.CRASH_BOT_DB.prepare(`
        UPDATE anonymous_messages
        SET delivery_status = 'unknown',
          delivery_error = 'Stale notification delivery claim; automatic retry suppressed'
        WHERE id = ? AND delivery_status = 'sending'
      `).bind(item.message_id)
    ]);
  }
  await env.CRASH_BOT_DB.prepare(`
    UPDATE anonymous_message_inbox
    SET sender_notice_status = 'unknown',
      last_error = COALESCE(last_error, 'Stale message display or sender notice; retry suppressed'),
      updated_at = CURRENT_TIMESTAMP
    WHERE sender_notice_status = 'sending'
      AND updated_at < datetime('now', '-15 minutes')
  `).run();
  await env.CRASH_BOT_DB.prepare(`
    UPDATE anonymous_messages
    SET sender_display_status = 'unknown'
    WHERE sender_display_status = 'sending'
      AND created_at < datetime('now', '-15 minutes')
  `).run();
}

async function displaySenderCopy(env, messageId) {
  const claimed = await env.CRASH_BOT_DB.prepare(`
    UPDATE anonymous_messages
    SET sender_display_status = 'sent',
        sender_display_message_id = NULL
    WHERE id = ? AND sender_display_status = 'pending'
    RETURNING id
  `).bind(messageId).first();

  return claimed ? "sent" : null;
}

export async function deliverAnonymousMessageNotification(env, messageId) {
  await recoverStaleAnonymousWork(env, messageId);
  const notification = await env.CRASH_BOT_DB.prepare(`
    SELECT id, recipient_id, source_type, delivery_status
    FROM anonymous_message_inbox WHERE message_id = ?
  `).bind(messageId).first();
  if (!notification) return "failed";
  const claimed = await env.CRASH_BOT_DB.prepare(`
    UPDATE anonymous_message_inbox
    SET delivery_status = 'sending', last_error = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND delivery_status = 'pending'
    RETURNING id, recipient_id, source_type
  `).bind(notification.id).first();
  if (!claimed) {
    const current = await env.CRASH_BOT_DB.prepare(`
      SELECT delivery_status FROM anonymous_message_inbox WHERE id = ?
    `).bind(notification.id).first();
    return current?.delivery_status ?? "failed";
  }

  const delivery = await deliverClaimedConversationMessage({
    label: "anonymous message notification",
    deliver: () => sendInlineTelegramDetailed(
      env,
      claimed.recipient_id,
      `🔔 شما یک پیام دارید\nمنبع: ${SOURCE_LABELS[claimed.source_type]}\nبرای مشاهده و پاسخ، دکمه را بزن.`,
      [[{
        text: "مشاهده پیام",
        callback_data: `anon:inbox:open:${claimed.id}`
      }]]
    ),
    settle: async (status, result) => {
      const errorText = status === "sent" ? null : `Telegram delivery ${status}`;
      await env.CRASH_BOT_DB.batch([
        env.CRASH_BOT_DB.prepare(`
          UPDATE anonymous_messages
          SET delivery_status = ?, delivery_error = ?
          WHERE id = ? AND delivery_status = 'sending'
        `).bind(status, errorText, messageId),
        env.CRASH_BOT_DB.prepare(`
          UPDATE anonymous_message_inbox
          SET delivery_status = ?, last_error = ?, telegram_message_id = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND delivery_status = 'sending'
        `).bind(status, errorText,
          status === "sent" ? result.messageId ?? null : null, claimed.id)
      ]);
    }
  });
  const status = delivery.status;
  return status;
}

async function isActiveConversation(env, reference, firstUserId, secondUserId) {
  if (reference.type === "connection") {
    return Boolean(await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM connection_requests
      WHERE id = ? AND status = 'accepted' AND ended_at IS NULL
        AND ((requester_id = ? AND recipient_id = ?)
          OR (requester_id = ? AND recipient_id = ?))
    `).bind(
      reference.id, firstUserId, secondUserId, secondUserId, firstUserId
    ).first());
  }
  if (reference.type === "random_chat") {
    return Boolean(await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM anonymous_sessions
      WHERE id = ? AND status = 'active'
        AND ((user_a_id = ? AND user_b_id = ?)
          OR (user_a_id = ? AND user_b_id = ?))
    `).bind(
      reference.id, firstUserId, secondUserId, secondUserId, firstUserId
    ).first());
  }
  return Boolean(await env.CRASH_BOT_DB.prepare(`
    SELECT id FROM anonymous_conversations
    WHERE id = ? AND source_type = ? AND status = 'active'
      AND ((user_a_id = ? AND user_b_id = ?)
        OR (user_a_id = ? AND user_b_id = ?))
  `).bind(
    reference.id, reference.type,
    firstUserId, secondUserId, secondUserId, firstUserId
  ).first());
}

async function holdBlockedMessage(env, {
  reference, senderId, recipientId, message, sourceMessageId
}) {
  if (!await isActiveConversation(env, reference, senderId, recipientId)) {
    return { status: "inactive" };
  }
  const rows = await env.CRASH_BOT_DB.prepare(`
    SELECT blocker_id FROM conversation_blocks
    WHERE conversation_type = ? AND conversation_id = ?
      AND ((blocker_id = ? AND blocked_id = ?)
        OR (blocker_id = ? AND blocked_id = ?))
  `).bind(
    reference.type, reference.id, recipientId, senderId, senderId, recipientId
  ).all();
  const blockedByRecipient = (rows.results ?? []).some((row) =>
    String(row.blocker_id) === String(recipientId));
  if (blockedByRecipient) {
    await storeBlockedMessageForReview(env, {
      reference, senderId, recipientId, message, sourceMessageId
    });
  } else {
    await sendMessageTelegramDetailed(
      env, senderId, "پیام تحویل نشد؛ این گفت‌وگو در دسترس نیست.",
      null, sourceMessageId
    );
  }
  return { status: "blocked" };
}

export async function appendAndNotify(env, {
  senderId,
  recipientId,
  sourceType,
  conversationId,
  sessionId,
  connectionId,
  message,
  sourceMessageId,
  skipRecipientNotification = false
}) {
  if (!Number.isSafeInteger(senderId) || senderId <= 0 ||
      !Number.isSafeInteger(recipientId) || recipientId <= 0 ||
      senderId === recipientId) return { status: "invalid" };
  const content = messageContent(message);
  const media = mediaFromMessage(message);
  if (!content && !media) return { status: "invalid" };
  if (!Number.isSafeInteger(sourceMessageId) || sourceMessageId <= 0) {
    return { status: "invalid" };
  }

  const messageType = sourceType === "username" ? "username" :
    sourceType === "personal_link" ? "personal_link" :
      sourceType;
  if (!["random_chat", "connection", "personal_link", "username"].includes(sourceType)) {
    return { status: "invalid" };
  }
  const reference = threadReference(
    sourceType, conversationId, sessionId, connectionId
  );
  if (!Number.isSafeInteger(Number(reference.id)) || Number(reference.id) <= 0) {
    return { status: "inactive" };
  }
  if (await isConversationBlocked(env, reference, senderId, recipientId)) {
    return holdBlockedMessage(env, {
      reference, senderId, recipientId, message, sourceMessageId
    });
  }
  const replyToMessageId = await getConversationReplyMessageId(
    env, senderId, reference, recipientId
  );
  let inserted;
  let isDuplicate = false;
  if (sourceType === "random_chat") {
    inserted = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM anonymous_messages
      WHERE sender_id = ? AND source_message_id = ? AND message_type = 'random_chat'
    `).bind(senderId, sourceMessageId).first();
    isDuplicate = Boolean(inserted);
    if (!inserted) {
      inserted = await env.CRASH_BOT_DB.prepare(`
        INSERT INTO anonymous_messages
          (sender_id, recipient_id, message, message_type, session_id,
           media_type, media_file_id, caption, source_message_id,
           reply_to_message_id, delivery_status)
        SELECT ?, ?, ?, 'random_chat', ?, ?, ?, ?, ?, ?, 'sending'
        WHERE EXISTS (
          SELECT 1 FROM anonymous_sessions s
          WHERE s.id = ? AND s.status = 'active'
            AND (
              (s.user_a_id = ? AND s.user_b_id = ?)
              OR (s.user_b_id = ? AND s.user_a_id = ?)
            )
            AND NOT EXISTS (
              SELECT 1 FROM conversation_blocks b
              WHERE b.conversation_type = 'random_chat'
                AND b.conversation_id = s.id
                AND ((b.blocker_id = ? AND b.blocked_id = ?)
                  OR (b.blocker_id = ? AND b.blocked_id = ?))
            )
        )
        ON CONFLICT(sender_id, source_message_id)
          WHERE message_type = 'random_chat' AND source_message_id IS NOT NULL
        DO NOTHING
        RETURNING id
      `).bind(
        senderId, recipientId, content, sessionId,
        media?.type ?? null, media?.fileId ?? null,
        message?.caption ?? null, sourceMessageId, replyToMessageId,
        sessionId, senderId, recipientId, senderId, recipientId,
        senderId, recipientId, recipientId, senderId
      ).first();
    }
  } else if (sourceType === "connection") {
    inserted = await env.CRASH_BOT_DB.prepare(`
      INSERT INTO anonymous_messages
        (sender_id, recipient_id, message, message_type, connection_id,
         media_type, media_file_id, caption, source_message_id,
         reply_to_message_id, delivery_status)
      SELECT ?, ?, ?, 'connection', ?, ?, ?, ?, ?, ?, 'sending'
      WHERE EXISTS (
        SELECT 1 FROM connection_requests c
        WHERE c.id = ? AND c.status = 'accepted' AND c.ended_at IS NULL
          AND (
            (c.requester_id = ? AND c.recipient_id = ?)
            OR (c.recipient_id = ? AND c.requester_id = ?)
          )
      )
        AND NOT EXISTS (
          SELECT 1 FROM conversation_blocks b
          WHERE b.conversation_type = 'connection' AND b.conversation_id = ?
            AND ((b.blocker_id = ? AND b.blocked_id = ?)
              OR (b.blocker_id = ? AND b.blocked_id = ?))
        )
      ON CONFLICT(sender_id, source_message_id)
        WHERE message_type = 'connection' AND source_message_id IS NOT NULL
      DO NOTHING
      RETURNING id
    `).bind(
      senderId, recipientId, content, connectionId,
      media?.type ?? null, media?.fileId ?? null,
      message?.caption ?? null, sourceMessageId, replyToMessageId,
      connectionId, senderId, recipientId, senderId, recipientId,
      connectionId, senderId, recipientId, recipientId, senderId
    ).first();
  } else {
    inserted = await env.CRASH_BOT_DB.prepare(`
      INSERT INTO anonymous_messages
        (sender_id, recipient_id, message, message_type, conversation_id,
         connection_id, media_type, media_file_id, caption, source_message_id,
         reply_to_message_id, delivery_status)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending'
      WHERE EXISTS (
        SELECT 1 FROM anonymous_conversations c
        WHERE c.id = ? AND c.status = 'active'
          AND (
            (c.user_a_id = ? AND c.user_b_id = ?)
            OR (c.user_b_id = ? AND c.user_a_id = ?)
          )
      )
        AND NOT EXISTS (
          SELECT 1 FROM conversation_blocks b
          WHERE b.conversation_type = ? AND b.conversation_id = ?
            AND ((b.blocker_id = ? AND b.blocked_id = ?)
              OR (b.blocker_id = ? AND b.blocked_id = ?))
        )
      ON CONFLICT(sender_id, source_message_id)
        WHERE message_type IN ('personal_link', 'username') AND source_message_id IS NOT NULL
      DO NOTHING
      RETURNING id
    `).bind(
      senderId, recipientId, content, messageType,
      conversationId, connectionId ?? null,
      media?.type ?? null, media?.fileId ?? null,
      message?.caption ?? null, sourceMessageId, replyToMessageId,
      conversationId, senderId, recipientId, senderId, recipientId,
      reference.type, reference.id,
      senderId, recipientId, recipientId, senderId
    ).first();
  }

  if (!inserted?.id) {
    const duplicate = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM anonymous_messages
      WHERE sender_id = ? AND source_message_id = ? AND message_type = ?
    `).bind(senderId, sourceMessageId, messageType).first();
    if (!duplicate) {
      if (await isConversationBlocked(env, reference, senderId, recipientId)) {
        return holdBlockedMessage(env, {
          reference, senderId, recipientId, message, sourceMessageId
        });
      }
      return { status: "inactive" };
    }
    inserted = duplicate;
    isDuplicate = true;
  } else {
    await clearConversationReplyContext(env, senderId, reference, recipientId);
  }

  const notification = await saveMessageNotification(
    env, inserted.id, recipientId, sourceType
  );
  await displaySenderCopy(env, inserted.id, reference);
  let status;
  if (skipRecipientNotification) {
    await env.CRASH_BOT_DB.batch([
      env.CRASH_BOT_DB.prepare(`
        UPDATE anonymous_messages SET delivery_status = 'sent', delivery_error = NULL
        WHERE id = ?
      `).bind(inserted.id),
      env.CRASH_BOT_DB.prepare(`
        UPDATE anonymous_message_inbox
        SET delivery_status = 'sent', last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND delivery_status = 'pending'
      `).bind(notification.id)
    ]);
    status = "sent";
  } else {
    status = await deliverAnonymousMessageNotification(env, inserted.id);
  }
  if (!isDuplicate && !skipRecipientNotification) {
    await sendMessageTelegramDetailed(
      env,
      senderId,
      "\u2705 \u067e\u06cc\u0627\u0645 \u0634\u0645\u0627 \u0627\u0631\u0633\u0627\u0644 \u0634\u062f.",
      null,
      sourceMessageId
    );
  }
  return { status, messageId: inserted.id, notificationId: notification.id };
}

async function storeBlockedMessageForReview(env, {
  reference, senderId, recipientId, message, sourceMessageId
}) {
  const media = mediaFromMessage(message);
  const stored = await env.CRASH_BOT_DB.prepare(`
    INSERT INTO anonymous_blocked_messages (
      conversation_type, conversation_id, sender_id, recipient_id,
      source_message_id, message, media_type, media_file_id, caption
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_type, conversation_id, sender_id, source_message_id)
    DO NOTHING
    RETURNING id
  `).bind(
    reference.type, reference.id, senderId, recipientId, sourceMessageId,
    messageContent(message), media?.type ?? null, media?.fileId ?? null,
    message?.caption ?? null
  ).first();
  const row = stored ?? await env.CRASH_BOT_DB.prepare(`
    SELECT id, notice_status FROM anonymous_blocked_messages
    WHERE conversation_type = ? AND conversation_id = ?
      AND sender_id = ? AND source_message_id = ?
  `).bind(reference.type, reference.id, senderId, sourceMessageId).first();
  if (!row?.id) throw new Error("Could not store blocked anonymous message");

  const claimed = await env.CRASH_BOT_DB.prepare(`
    UPDATE anonymous_blocked_messages
    SET notice_status = 'sending', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND notice_status IN ('pending', 'failed')
    RETURNING id
  `).bind(row.id).first();
  if (claimed) {
    let outcome = "unknown";
    try {
      outcome = (await sendInlineTelegramDetailed(
        env,
        recipientId,
        "شما از فردی که در حال حاضر بلاک کرده‌اید یک پیام جدید دارید. برای مشاهده پیام، ابتدا بلاک فرستنده را بردارید.",
        [[{
          text: "رفع بلاک و مشاهده پیام",
          callback_data: `anon:unblock_view:${row.id}`
        }]]
      )).outcome;
    } catch (error) {
      console.error("Could not deliver blocked-message notice:", error?.name ?? "unknown error");
    }
    if (outcome === "rejected") {
      console.error("Could not deliver blocked-message notice: Telegram rejected the send");
    } else if (outcome === "unknown") {
      console.error("Blocked-message notice delivery outcome is unknown");
    }
    await env.CRASH_BOT_DB.prepare(`
      UPDATE anonymous_blocked_messages SET notice_status = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND notice_status = 'sending'
    `).bind(
      outcome === "sent" ? "sent" : outcome === "rejected" ? "failed" : "unknown",
      row.id
    ).run();
    const senderNotice = outcome === "sent"
      ? "پیام ثبت شد؛ گیرنده برای مشاهده باید آن را تأیید کند."
      : outcome === "rejected"
        ? "پیام ذخیره شد، اما اعلان به گیرنده تحویل نشد. پردازش دوبارهٔ همین پیام می‌تواند اعلان را مجدداً تلاش کند."
        : "پیام ذخیره شد، اما وضعیت اعلان مشخص نیست؛ برای جلوگیری از اعلان تکراری خودکار تکرار نمی‌شود.";
    await sendMessageTelegramDetailed(
      env, senderId, senderNotice, null, sourceMessageId
    );
  }
}

export async function renderAnonymousHome(env, chatId) {
  await sendTelegram(env, chatId,
    "🎭 ارتباط ناشناس\n\nیک روش ارتباط انتخاب کن. نام کاربری و شناسهٔ تلگرام در پیام‌های گفت‌وگو نمایش داده نمی‌شود.",
    [
      [{ text: "🎭 چت ناشناس تصادفی" }],
      [{ text: "🔗 لینک ناشناس من" }, { text: "🔎 ارتباط با آیدی" }],
      [{ text: "🔔 اعلان‌ها" }],
      [{ text: "🏠 منوی اصلی" }]
    ]);
}

export async function renderPersonalLink(env, userId, chatId) {
  if (!Number.isSafeInteger(userId) || userId <= 0 ||
      !Number.isSafeInteger(chatId) || userId !== chatId) return false;
  const username = await botUsername(env);
  if (!username) {
    await sendTelegram(env, chatId,
      "لینک اختصاصی هنوز آماده نیست؛ تنظیم نام کاربری ربات برای مالک لازم است.");
    return true;
  }
  let row = await env.CRASH_BOT_DB.prepare(
    "SELECT token FROM anonymous_personal_links WHERE user_id = ?"
  ).bind(userId).first();
  if (!row) {
    row = await env.CRASH_BOT_DB.prepare(`
      INSERT INTO anonymous_personal_links (user_id, token)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO NOTHING
      RETURNING token
    `).bind(userId, newToken()).first();
    if (!row) {
      row = await env.CRASH_BOT_DB.prepare(
        "SELECT token FROM anonymous_personal_links WHERE user_id = ?"
      ).bind(userId).first();
    }
  }
  if (!row?.token) throw new Error("Could not create personal anonymous link");
  await sendTelegram(env, chatId,
    `🔗 لینک اختصاصی گفت‌وگوی ناشناس تو:\nhttps://t.me/${username}?start=${row.token}\n\nبا بازکردن لینک، گفت‌وگو مستقیماً فعال می‌شود و نیازی به تأیید نیست.`);
  return true;
}

async function activeConversation(env, firstUserId, secondUserId, sourceType) {
  const userAId = Math.min(Number(firstUserId), Number(secondUserId));
  const userBId = Math.max(Number(firstUserId), Number(secondUserId));
  const row = await env.CRASH_BOT_DB.prepare(`
    SELECT id FROM anonymous_conversations
    WHERE user_a_id = ? AND user_b_id = ?
      AND source_type = ? AND status = 'active'
  `).bind(userAId, userBId, sourceType).first();
  return row?.id ?? null;
}

async function pairBlockState(env, firstUserId, secondUserId, sourceType) {
  const userAId = Math.min(Number(firstUserId), Number(secondUserId));
  const userBId = Math.max(Number(firstUserId), Number(secondUserId));
  const rows = await env.CRASH_BOT_DB.prepare(`
    SELECT b.blocker_id
    FROM anonymous_conversations c
    JOIN conversation_blocks b
      ON b.conversation_type = c.source_type AND b.conversation_id = c.id
    WHERE c.user_a_id = ? AND c.user_b_id = ? AND c.source_type = ?
      AND ((b.blocker_id = ? AND b.blocked_id = ?)
        OR (b.blocker_id = ? AND b.blocked_id = ?))
  `).bind(
    userAId, userBId, sourceType,
    firstUserId, secondUserId, secondUserId, firstUserId
  ).all();
  return {
    blockedByViewer: (rows.results ?? []).some((row) =>
      String(row.blocker_id) === String(firstUserId)),
    blockedByOther: (rows.results ?? []).some((row) =>
      String(row.blocker_id) === String(secondUserId))
  };
}

export async function handlePersonalLinkStart(env, userId, chatId, token) {
  if (!Number.isSafeInteger(userId) || userId <= 0 ||
      !Number.isSafeInteger(chatId) || chatId !== userId ||
      !/^anon_[a-f0-9]{32}$/.test(String(token ?? ""))) {
    await sendTelegram(env, chatId, "این لینک ناشناس نامعتبر است؛ آن را از گفت‌وگوی خصوصی ربات باز کن.");
    return true;
  }
  const row = await env.CRASH_BOT_DB.prepare(`
    SELECT l.user_id, u.account_status, u.is_blocked
    FROM anonymous_personal_links l
    JOIN users u ON u.telegram_id = l.user_id
    WHERE l.token = ?
  `).bind(token).first();
  if (!row || String(row.user_id) === String(userId) ||
      row.is_blocked === 1 ||
      (row.account_status && row.account_status !== "active")) {
    await sendTelegram(env, chatId, "این لینک ناشناس معتبر یا در دسترس نیست.");
    return true;
  }
  const blocks = await pairBlockState(
    env, userId, row.user_id, "personal_link"
  );
  if (blocks.blockedByViewer) {
    await sendTelegram(env, chatId, "این گفت‌وگو در این مسیر مسدود شده است.");
    return true;
  }
  const existingConversationId = await activeConversation(
    env, userId, row.user_id, "personal_link"
  );
  const conversationId = existingConversationId ?? await createConversation(
    env, userId, row.user_id, "personal_link"
  );
  await setConversationState(env, userId, conversationId);
  await sendTelegram(env, chatId,
    "گفت‌وگوی ناشناس مستقیم باز شد؛ پیام متنی یا رسانه‌ای بفرست. هویت دو طرف نمایش داده نمی‌شود.",
    CHAT_RETURN_KEYBOARD);
  return true;
}

export async function renderUserMessageInbox(env, userId, chatId, page = 0) {
  if (String(userId) !== String(chatId) || !validPage(page)) return false;
  await recoverStaleAnonymousWork(env);
  const rows = await env.CRASH_BOT_DB.prepare(`
    SELECT n.id, n.source_type, n.created_at
    FROM anonymous_message_inbox n
    WHERE n.recipient_id = ? AND n.viewed_at IS NULL
      AND n.delivery_status NOT IN ('pending', 'sending')
    ORDER BY n.id DESC LIMIT ? OFFSET ?
  `).bind(userId, INBOX_PAGE_SIZE + 1, page * INBOX_PAGE_SIZE).all();
  const results = rows.results ?? [];
  const visible = results.slice(0, INBOX_PAGE_SIZE);
  const keyboard = visible.map((item) => [{
    text: `مشاهده پیام · ${SOURCE_LABELS[item.source_type]}`,
    callback_data: `anon:inbox:open:${item.id}`
  }]);
  if (page > 0) {
    keyboard.push([{
      text: "پیام‌های جدیدتر",
      callback_data: `anon:inbox:list:${page - 1}`
    }]);
  }
  if (results.length > INBOX_PAGE_SIZE) {
    keyboard.push([{
      text: "پیام‌های قدیمی‌تر",
      callback_data: `anon:inbox:list:${page + 1}`
    }]);
  }
  keyboard.push([{ text: "🏠 منوی اصلی" }]);
  await sendTrackedSectionInlineTelegram(
    env,
    chatId,
    visible.length
      ? `🔔 اعلان‌های خوانده‌نشده — ${visible.length} پیام در این صفحه`
      : "اعلان خوانده‌نشده‌ای وجود ندارد.",
    keyboard
  );
  return true;
}

function tehranTime(value) {
  const date = new Date(`${String(value).replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return String(value ?? "—");
  return new Intl.DateTimeFormat("fa-IR", {
    timeZone: "Asia/Tehran",
    dateStyle: "short",
    timeStyle: "short"
  }).format(date);
}

async function renderOpenedMessage(env, chatId, row) {
  const reference = threadReference(
    row.source_type, row.conversation_id, row.session_id, row.connection_id
  );
  if (String(row.recipient_id) !== String(chatId) ||
      String(row.sender_id) === String(chatId) ||
      await isConversationBlocked(env, reference, chatId, row.sender_id)) {
    return "blocked";
  }
  const label = SOURCE_LABELS[row.source_type];
  const header = `💬 پیام دریافتی · ${label}`;
  const blocks = await conversationBlockState(
    env, reference, chatId, row.sender_id
  );
  const keyboard = conversationMessageControls({
    ...row,
    id: row.message_id,
    sender_id: row.sender_id,
    view_delivery_status: "sent"
  }, chatId, { includeHistory: true, ...blocks });
  const result = await sendConversationContent(env, chatId, {
    text: `${header}\n\n${row.message || row.caption || "رسانه"}`,
    mediaType: row.media_type,
    mediaFileId: row.media_file_id,
    inlineKeyboard: keyboard
  });
  return result.outcome;
}

async function sendSenderViewedNotice(env, notificationId, senderId) {
  const claimed = await env.CRASH_BOT_DB.prepare(`
    UPDATE anonymous_message_inbox
    SET sender_notice_status = 'sending', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND viewed_at IS NOT NULL AND sender_notice_status = 'pending'
    RETURNING id
  `).bind(notificationId).first();
  if (!claimed) return false;
  const message = await env.CRASH_BOT_DB.prepare(`
    SELECT source_message_id FROM anonymous_messages
    WHERE id = (SELECT message_id FROM anonymous_message_inbox WHERE id = ?)
      AND sender_id = ?
  `).bind(notificationId, senderId).first();
  const sent = await sendConversationReadReceipt(env, senderId,
    message?.source_message_id ?? null,
    "✅ پیام شما از طریق ربات مشاهده شد.",
  );
  const status = sent.outcome === "sent" ? "sent"
    : sent.outcome === "rejected" ? "failed" : "unknown";
  await env.CRASH_BOT_DB.prepare(`
    UPDATE anonymous_message_inbox SET sender_notice_status = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND sender_notice_status = 'sending'
  `).bind(status, notificationId).run();
  return status === "sent";
}

async function conversationBlockState(env, reference, actorId, peerId) {
  if (!reference?.id || !Number.isSafeInteger(Number(actorId)) ||
      !Number.isSafeInteger(Number(peerId)) || String(actorId) === String(peerId)) {
    return { blockedByViewer: false, blockedByOther: false };
  }
  const rows = await env.CRASH_BOT_DB.prepare(`
    SELECT blocker_id FROM conversation_blocks
    WHERE conversation_type = ? AND conversation_id = ?
      AND ((blocker_id = ? AND blocked_id = ?)
        OR (blocker_id = ? AND blocked_id = ?))
  `).bind(reference.type, reference.id, actorId, peerId, peerId, actorId).all();
  return {
    blockedByViewer: (rows.results ?? []).some((row) =>
      String(row.blocker_id) === String(actorId)),
    blockedByOther: (rows.results ?? []).some((row) =>
      String(row.blocker_id) === String(peerId))
  };
}

async function activateOpenedConversation(env, row, actorId) {
  if (row.source_type === "connection") {
    const request = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM connection_requests
      WHERE id = ? AND status = 'accepted' AND ended_at IS NULL
        AND (requester_id = ? OR recipient_id = ?)
    `).bind(row.connection_id, actorId, actorId).first();
    if (!request) return "این ارتباط دیگر فعال نیست؛ پیام فقط برای مشاهده باز شد.";
    await env.CRASH_BOT_DB.batch([
      env.CRASH_BOT_DB.prepare(
        "DELETE FROM anonymous_chat_states WHERE user_id = ?"
      ).bind(actorId),
      env.CRASH_BOT_DB.prepare(`
        INSERT INTO user_conversations (user_id, flow_type, entity_id, payload, updated_at)
        VALUES (?, 'connection_chat', ?, '{}', CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
          flow_type = 'connection_chat',
          entity_id = excluded.entity_id,
          payload = '{}',
          updated_at = CURRENT_TIMESTAMP
      `).bind(actorId, request.id)
    ]);
    await selectConversation(env, actorId, "connection", request.id);
    return "گفت‌وگوی همان درخواست فعال شد؛ پاسخ تو به همان ارتباط فرستاده می‌شود.";
  }

  if (row.source_type === "random_chat") {
    const session = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM anonymous_sessions
      WHERE id = ? AND status = 'active'
        AND (user_a_id = ? OR user_b_id = ?)
    `).bind(row.session_id, actorId, actorId).first();
    if (session) await selectConversation(env, actorId, "random_chat", row.session_id);
    return session
      ? "پاسخ خود را همین‌جا بفرست؛ گفت‌وگوی ناشناس تصادفی فعال است."
      : "این گفت‌وگوی تصادفی پایان یافته است؛ پیام فقط برای مشاهده باز شد.";
  }

  const conversation = await env.CRASH_BOT_DB.prepare(`
    SELECT id FROM anonymous_conversations
    WHERE id = ? AND status = 'active' AND (user_a_id = ? OR user_b_id = ?)
  `).bind(row.conversation_id, actorId, actorId).first();
  if (!conversation) return "این گفت‌وگو دیگر فعال نیست؛ پیام فقط برای مشاهده باز شد.";
  await setConversationState(env, actorId, conversation.id, row.source_type);
  return "گفت‌وگوی ناشناس باز شد؛ پاسخ متنی یا رسانه‌ای خود را همین‌جا بفرست.";
}

async function refreshInboxAfterOpen(env, query, actorId) {
  const section = await env.CRASH_BOT_DB.prepare(`
    SELECT value FROM bot_settings WHERE key = ?
  `).bind(`ui_inline_section_message:${String(actorId)}`).first();
  const sectionMessageId = Number(section?.value);
  if (sectionMessageId !== query.message?.message_id) {
    await deleteTelegramMessage(env, actorId, query.message?.message_id);
  }
  await renderUserMessageInbox(env, actorId, actorId);
}

async function openInboxItem(env, query, actorId) {
  const match = /^anon:inbox:open:(\d+)$/.exec(query.data ?? "");
  if (!match) return false;
  const notificationId = Number(match[1]);
  if (!Number.isSafeInteger(notificationId) || notificationId <= 0) {
    await answerCallbackQuery(env, query.id, "شناسهٔ اعلان معتبر نیست.");
    return true;
  }
  await recoverStaleAnonymousWork(env);
  const row = await env.CRASH_BOT_DB.prepare(`
    SELECT n.id, n.message_id, n.source_type, n.viewed_at,
      m.sender_id, m.recipient_id, m.message, m.caption,
      m.media_type, m.media_file_id, m.session_id, m.connection_id,
      m.conversation_id, m.message_type, m.source_message_id, n.sender_notice_status,
      n.delivery_status
    FROM anonymous_message_inbox n
    JOIN anonymous_messages m ON m.id = n.message_id
    WHERE n.id = ? AND n.recipient_id = ?
  `).bind(notificationId, actorId).first();
  if (!row) {
    await answerCallbackQuery(env, query.id, "این اعلان در دسترس نیست.");
    return true;
  }
  const reference = threadReference(
    row.source_type, row.conversation_id, row.session_id, row.connection_id
  );
  if (String(row.recipient_id) !== String(actorId) ||
      String(row.sender_id) === String(actorId) ||
      await isConversationBlocked(env, reference, actorId, row.sender_id)) {
    await answerCallbackQuery(env, query.id,
      "این پیام تا رفع محدودیت بلاک در دسترس نیست.");
    return true;
  }
  if (row.viewed_at) {
    const responseHint = await activateOpenedConversation(env, row, actorId);
    await sendMessageTelegramDetailed(
      env, actorId, responseHint, CHAT_RETURN_KEYBOARD
    );
    await sendSenderViewedNotice(env, notificationId, row.sender_id);
    await refreshInboxAfterOpen(env, query, actorId);
    await answerCallbackQuery(env, query.id, "این پیام قبلاً از طریق ربات مشاهده شده است.");
    return true;
  }
  if (row.sender_notice_status === "sending") {
    await answerCallbackQuery(env, query.id, "نمایش این پیام در حال انجام است؛ کمی صبر کن.");
    return true;
  }
  if (row.sender_notice_status === "unknown") {
    await answerCallbackQuery(env, query.id,
      "نتیجهٔ نمایش قبلی نامشخص است؛ برای جلوگیری از نمایش تکراری، پیام دوباره باز نمی‌شود.");
    return true;
  }
  const claimed = await env.CRASH_BOT_DB.prepare(`
    UPDATE anonymous_message_inbox
    SET sender_notice_status = 'sending', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND recipient_id = ? AND viewed_at IS NULL
      AND sender_notice_status = 'pending'
    RETURNING id
  `).bind(notificationId, actorId).first();
  if (!claimed) {
    await answerCallbackQuery(env, query.id, "این پیام قبلاً مشاهده شده است.");
    return true;
  }

  let outcome;
  try {
    outcome = await renderOpenedMessage(env, actorId, row);
  } catch (error) {
    console.error("Could not display anonymous message:", error?.name ?? "unknown error");
    outcome = "unknown";
  }
  if (outcome !== "sent") {
    await env.CRASH_BOT_DB.prepare(`
      UPDATE anonymous_message_inbox
      SET sender_notice_status = ?, last_error = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND sender_notice_status = 'sending' AND viewed_at IS NULL
    `).bind(
      outcome === "unknown" ? "unknown" : "pending",
      outcome === "unknown"
        ? "Message display outcome is unknown; automatic replay suppressed"
        : "Telegram rejected message display",
      notificationId
    ).run();
    if (outcome === "blocked") {
      await answerCallbackQuery(env, query.id,
        "این پیام تا رفع محدودیت بلاک در دسترس نیست.");
      return true;
    }
    await answerCallbackQuery(env, query.id,
      outcome === "unknown"
        ? "نتیجهٔ نمایش نامشخص است؛ برای جلوگیری از نمایش تکراری دوباره تلاش نمی‌شود."
        : "نمایش پیام ناموفق بود؛ اعلان باقی می‌ماند تا دوباره تلاش کنی.");
    return true;
  }

  const viewed = await env.CRASH_BOT_DB.prepare(`
    UPDATE anonymous_message_inbox
    SET viewed_at = CURRENT_TIMESTAMP, sender_notice_status = 'pending',
      last_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND recipient_id = ? AND viewed_at IS NULL
      AND sender_notice_status = 'sending'
    RETURNING id
  `).bind(notificationId, actorId).first();
  if (!viewed) {
    await answerCallbackQuery(env, query.id,
      "وضعیت این اعلان تغییر کرده است؛ فهرست را دوباره باز کن.");
    return true;
  }
  const responseHint = await activateOpenedConversation(env, row, actorId);
  await sendMessageTelegramDetailed(
    env, actorId, responseHint, CHAT_RETURN_KEYBOARD
  );
  await sendSenderViewedNotice(env, notificationId, row.sender_id);
  await refreshInboxAfterOpen(env, query, actorId);
  await answerCallbackQuery(env, query.id,
    "پیام باز شد.");
  return true;
}

async function loadConversationMessage(env, messageId, actorId) {
  return env.CRASH_BOT_DB.prepare(`
    SELECT m.id AS message_id, m.sender_id, m.recipient_id, m.message,
      m.caption, m.media_type, m.media_file_id, m.message_type,
      m.session_id, m.connection_id, m.conversation_id,
      CASE
        WHEN m.message_type = 'random_chat' THEN 'random_chat'
        WHEN m.message_type = 'connection' THEN 'connection'
        ELSE m.message_type
      END AS source_type
    FROM anonymous_messages m
    WHERE m.id = ? AND (m.sender_id = ? OR m.recipient_id = ?)
  `).bind(messageId, actorId, actorId).first();
}

async function isThreadActive(env, row, actorId) {
  if (row.source_type === "connection") {
    return Boolean(await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM connection_requests
      WHERE id = ? AND status = 'accepted' AND ended_at IS NULL
        AND (requester_id = ? OR recipient_id = ?)
    `).bind(row.connection_id, actorId, actorId).first());
  }
  if (row.source_type === "random_chat") {
    return Boolean(await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM anonymous_sessions
      WHERE id = ? AND status = 'active'
        AND (user_a_id = ? OR user_b_id = ?)
    `).bind(row.session_id, actorId, actorId).first());
  }
  return Boolean(await env.CRASH_BOT_DB.prepare(`
    SELECT id FROM anonymous_conversations
    WHERE id = ? AND status = 'active' AND (user_a_id = ? OR user_b_id = ?)
  `).bind(row.conversation_id, actorId, actorId).first());
}

async function openReplyContext(env, query, actorId) {
  const match = /^anon:reply:(\d+)$/.exec(query.data ?? "");
  if (!match) return false;
  const messageId = Number(match[1]);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    await answerCallbackQuery(env, query.id, "شناسهٔ پیام معتبر نیست.");
    return true;
  }
  const row = await loadConversationMessage(env, messageId, actorId);
  if (!row) {
    await answerCallbackQuery(env, query.id, "پیام یا گفت‌وگو در دسترس نیست.");
    return true;
  }
  const reference = threadReference(
    row.source_type, row.conversation_id, row.session_id, row.connection_id
  );
  const peerId = String(row.sender_id) === String(actorId)
    ? row.recipient_id : row.sender_id;
  if (!peerId || !await isThreadActive(env, row, actorId) ||
      await isConversationBlocked(env, reference, actorId, peerId)) {
    await answerCallbackQuery(env, query.id,
      "این گفت‌وگو پایان یافته یا مسدود شده است.");
    return true;
  }
  await activateOpenedConversation(env, row, actorId);
  await setReplyContext(env, actorId, messageId, reference, peerId);
  await sendMessageTelegramDetailed(env, actorId,
    "متن، ویس یا رسانه دلخواه خود را برای طرف مقابل ارسال کنید.",
    CHAT_RETURN_KEYBOARD);
  await sendInlineTelegramDetailed(env, actorId,
    "برای لغو پاسخ از دکمهٔ زیر استفاده کن.",
    [[{
      text: "لغو پاسخ",
      callback_data: `anon:reply:cancel:${messageId}`
    }]]);
  await answerCallbackQuery(env, query.id, "گفت‌وگوی دقیق انتخاب شد.");
  return true;
}

async function cancelReplyContext(env, query, actorId) {
  const match = /^anon:reply:cancel:(\d+)$/.exec(query.data ?? "");
  if (!match) return false;
  const messageId = Number(match[1]);
  const row = Number.isSafeInteger(messageId) && messageId > 0
    ? await loadConversationMessage(env, messageId, actorId)
    : null;
  if (!row) {
    await answerCallbackQuery(env, query.id, "زمینهٔ پاسخ دیگر در دسترس نیست.");
    return true;
  }
  const reference = threadReference(
    row.source_type, row.conversation_id, row.session_id, row.connection_id
  );
  const peerId = String(row.sender_id) === String(actorId)
    ? row.recipient_id : row.sender_id;
  await clearConversationReplyContext(env, actorId, reference, peerId);
  await answerCallbackQuery(env, query.id, "پاسخ لغو شد.");
  return true;
}

async function blockConversationFromMessage(env, query, actorId) {
  const match = /^anon:block:(\d+)$/.exec(query.data ?? "");
  if (!match) return false;
  const messageId = Number(match[1]);
  const row = Number.isSafeInteger(messageId) && messageId > 0
    ? await loadConversationMessage(env, messageId, actorId)
    : null;
  if (!row) {
    await answerCallbackQuery(env, query.id, "این گفت‌وگو در دسترس نیست.");
    return true;
  }
  const reference = threadReference(
    row.source_type, row.conversation_id, row.session_id, row.connection_id
  );
  const peerId = String(row.sender_id) === String(actorId)
    ? row.recipient_id : row.sender_id;
  if (!reference.id || !Number.isSafeInteger(Number(peerId)) ||
      String(peerId) === String(actorId) ||
      !await isThreadActive(env, row, actorId)) {
    await answerCallbackQuery(env, query.id, "شناسهٔ گفت‌وگو معتبر نیست.");
    return true;
  }
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO conversation_blocks (
      conversation_type, conversation_id, blocker_id, blocked_id
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(conversation_type, conversation_id, blocker_id) DO NOTHING
  `).bind(reference.type, reference.id, actorId, peerId).run();
  if (reference.type === "connection") {
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM user_conversations
      WHERE flow_type = 'connection_chat' AND entity_id = ?
        AND user_id = ?
    `).bind(reference.id, actorId).run();
  } else if (["personal_link", "username"].includes(reference.type)) {
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM anonymous_chat_states
      WHERE conversation_id = ? AND user_id = ?
    `).bind(reference.id, actorId).run();
  }
  await env.CRASH_BOT_DB.batch([
    env.CRASH_BOT_DB.prepare(`
      DELETE FROM active_conversation_selections
      WHERE conversation_type = ? AND conversation_id = ?
        AND actor_id = ?
    `).bind(reference.type, reference.id, actorId),
    env.CRASH_BOT_DB.prepare(`
      DELETE FROM conversation_reply_contexts
      WHERE conversation_type = ? AND conversation_id = ?
        AND actor_id = ?
    `).bind(reference.type, reference.id, actorId)
  ]);
  await sendMessageTelegramDetailed(env, actorId,
    "این گفت‌وگوی ناشناس مسدود شد؛ ارتباط‌های دیگر شما تغییری نکردند.");
  await sendMessageTelegramDetailed(env, peerId,
    "این گفت‌وگوی ناشناس توسط طرف مقابل مسدود شد.");
  const keyboard = conversationMessageControls({
    ...row,
    id: row.message_id,
    visibility_status: "visible",
    view_delivery_status: "sent"
  }, actorId, { blockedByViewer: true });
  const edited = await editTelegramReplyMarkupDetailed(
    env, query.message.chat.id, query.message.message_id, keyboard
  );
  await answerCallbackQuery(env, query.id, edited.outcome === "sent"
    ? "گفت‌وگو مسدود شد."
    : "گفت‌وگو مسدود شد، اما دکمه به‌روزرسانی نشد؛ صفحه را دوباره باز کن.");
  return true;
}

async function unblockConversationFromMessage(env, query, actorId) {
  const match = /^anon:unblock:(\d+)$/.exec(query.data ?? "");
  if (!match) return false;
  const messageId = Number(match[1]);
  const row = Number.isSafeInteger(messageId) && messageId > 0
    ? await loadConversationMessage(env, messageId, actorId)
    : null;
  if (!row) {
    await answerCallbackQuery(env, query.id, "این گفت‌وگو در دسترس نیست.");
    return true;
  }
  const reference = threadReference(
    row.source_type, row.conversation_id, row.session_id, row.connection_id
  );
  const peerId = String(row.sender_id) === String(actorId)
    ? row.recipient_id : row.sender_id;
  if (!Number.isSafeInteger(Number(peerId)) || String(peerId) === String(actorId) ||
      !await isThreadActive(env, row, actorId)) {
    await answerCallbackQuery(env, query.id, "این ارتباط دیگر فعال نیست.");
    return true;
  }
  const removed = await env.CRASH_BOT_DB.prepare(`
    DELETE FROM conversation_blocks
    WHERE conversation_type = ? AND conversation_id = ?
      AND blocker_id = ? AND blocked_id = ?
    RETURNING conversation_id
  `).bind(reference.type, reference.id, actorId, peerId).first();
  if (!removed) {
    await answerCallbackQuery(env, query.id, "این گفت‌وگو قبلاً رفع بلاک شده است.");
    return true;
  }
  const keyboard = conversationMessageControls({
    ...row,
    id: row.message_id,
    visibility_status: "visible",
    view_delivery_status: "sent"
  }, actorId);
  const edited = await editTelegramReplyMarkupDetailed(
    env, query.message.chat.id, query.message.message_id, keyboard
  );
  await answerCallbackQuery(env, query.id, edited.outcome === "sent"
    ? "گفت‌وگو رفع بلاک شد."
    : "گفت‌وگو رفع بلاک شد، اما دکمه به‌روزرسانی نشد؛ صفحه را دوباره باز کن.");
  return true;
}

async function unblockAndViewMessage(env, query, actorId) {
  const match = /^anon:unblock_view:(\d+)$/.exec(query.data ?? "");
  if (!match) return false;
  const blockedMessageId = Number(match[1]);
  if (!Number.isSafeInteger(blockedMessageId) || blockedMessageId <= 0) {
    await answerCallbackQuery(env, query.id, "شناسهٔ پیام معتبر نیست.");
    return true;
  }

  const row = await env.CRASH_BOT_DB.prepare(`
    SELECT id, conversation_type, conversation_id, sender_id, recipient_id,
      source_message_id, message, media_type, media_file_id, caption, status,
      released_message_id
    FROM anonymous_blocked_messages
    WHERE id = ? AND recipient_id = ?
  `).bind(blockedMessageId, actorId).first();
  if (!row) {
    await answerCallbackQuery(env, query.id, "این پیام در دسترس نیست.");
    return true;
  }

  if (row.status === "released" && row.released_message_id) {
    const blocks = await conversationBlockState(
      env,
      { type: row.conversation_type, id: row.conversation_id },
      actorId,
      row.sender_id
    );
    if (blocks.blockedByViewer || blocks.blockedByOther) {
      await answerCallbackQuery(env, query.id,
        "این پیام تا رفع محدودیت بلاک در دسترس نیست.");
      return true;
    }
    const inbox = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM anonymous_message_inbox WHERE message_id = ?
    `).bind(row.released_message_id).first();
    if (inbox) {
      const blocks = await conversationBlockState(
        env,
        { type: row.conversation_type, id: row.conversation_id },
        actorId,
        row.sender_id
      );
      if (blocks.blockedByViewer || blocks.blockedByOther) {
        await answerCallbackQuery(env, query.id,
          "این پیام تا رفع محدودیت بلاک در دسترس نیست.");
        return true;
      }
      return openInboxItem(env, {
        ...query,
        data: `anon:inbox:open:${inbox.id}`
      }, actorId);
    }
    await answerCallbackQuery(env, query.id, "پیام آزادشده در دسترس نیست.");
    return true;
  }

  if (row.status === "releasing") {
    const currentBlocks = await conversationBlockState(
      env,
      { type: row.conversation_type, id: row.conversation_id },
      actorId,
      row.sender_id
    );
    if (currentBlocks.blockedByOther) {
      await answerCallbackQuery(env, query.id,
        "طرف مقابل نیز شما را بلاک کرده است؛ پیام قابل مشاهده نیست.");
      return true;
    }
    const recovered = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM anonymous_messages
      WHERE sender_id = ? AND source_message_id = ? AND message_type = ?
        AND (
          (message_type = 'random_chat' AND session_id = ?)
          OR (message_type = 'connection' AND connection_id = ?)
          OR (message_type IN ('personal_link', 'username') AND conversation_id = ?)
        )
    `).bind(
      row.sender_id, row.source_message_id, row.conversation_type,
      row.conversation_id, row.conversation_id, row.conversation_id
    ).first();
    if (recovered?.id) {
      await env.CRASH_BOT_DB.prepare(`
        UPDATE anonymous_blocked_messages
        SET status = 'released', released_message_id = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'releasing'
      `).bind(recovered.id, row.id).run();
      const inbox = await env.CRASH_BOT_DB.prepare(`
        SELECT id FROM anonymous_message_inbox WHERE message_id = ?
      `).bind(recovered.id).first();
      if (inbox) {
        return openInboxItem(env, {
          ...query,
          data: `anon:inbox:open:${inbox.id}`
        }, actorId);
      }
    } else {
      const stale = await env.CRASH_BOT_DB.prepare(`
        UPDATE anonymous_blocked_messages
        SET status = 'pending', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'releasing'
          AND updated_at < datetime('now', '-15 minutes')
        RETURNING id
      `).bind(row.id).first();
      if (!stale) {
        await answerCallbackQuery(env, query.id, "درخواست مشاهده در حال انجام است؛ کمی صبر کن.");
        return true;
      }
      await env.CRASH_BOT_DB.prepare(`
        INSERT INTO conversation_blocks
          (conversation_type, conversation_id, blocker_id, blocked_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(conversation_type, conversation_id, blocker_id) DO NOTHING
      `).bind(
        row.conversation_type, row.conversation_id, actorId, row.sender_id
      ).run();
    }
  }

  const [recipientBlock, senderBlock] = await Promise.all([
    env.CRASH_BOT_DB.prepare(`
      SELECT id FROM conversation_blocks
      WHERE conversation_type = ? AND conversation_id = ?
        AND blocker_id = ? AND blocked_id = ?
    `).bind(
      row.conversation_type, row.conversation_id, actorId, row.sender_id
    ).first(),
    env.CRASH_BOT_DB.prepare(`
      SELECT id FROM conversation_blocks
      WHERE conversation_type = ? AND conversation_id = ?
        AND blocker_id = ? AND blocked_id = ?
    `).bind(
      row.conversation_type, row.conversation_id, row.sender_id, actorId
    ).first()
  ]);
  if (!recipientBlock) {
    await answerCallbackQuery(env, query.id, "این بلاک دیگر فعال نیست.");
    return true;
  }
  if (senderBlock) {
    await answerCallbackQuery(env, query.id,
      "طرف مقابل نیز شما را بلاک کرده است؛ پیام قابل مشاهده نیست.");
    return true;
  }
  if (row.status !== "pending" && recipientBlock) {
    await answerCallbackQuery(env, query.id,
      "این پیام تا رفع محدودیت بلاک در دسترس نیست.");
    return true;
  }

  const claim = await env.CRASH_BOT_DB.prepare(`
    UPDATE anonymous_blocked_messages
    SET status = 'releasing', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND recipient_id = ? AND status = 'pending'
    RETURNING id
  `).bind(row.id, actorId).first();
  if (!claim) {
    await answerCallbackQuery(env, query.id, "این پیام دیگر در انتظار تصمیم نیست.");
    return true;
  }

  const removedBlock = await env.CRASH_BOT_DB.prepare(`
    DELETE FROM conversation_blocks
    WHERE conversation_type = ? AND conversation_id = ?
      AND blocker_id = ? AND blocked_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM conversation_blocks
        WHERE conversation_type = ? AND conversation_id = ?
          AND blocker_id = ? AND blocked_id = ?
      )
    RETURNING id
  `).bind(
    row.conversation_type, row.conversation_id, actorId, row.sender_id,
    row.conversation_type, row.conversation_id, row.sender_id, actorId
  ).first();
  if (!removedBlock) {
    await env.CRASH_BOT_DB.prepare(`
      UPDATE anonymous_blocked_messages SET status = 'pending',
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'releasing'
    `).bind(row.id).run();
    await answerCallbackQuery(env, query.id,
      "وضعیت بلاک تغییر کرده است؛ پیام قابل مشاهده نیست.");
    return true;
  }

  const inserted = await appendAndNotify(env, {
    senderId: row.sender_id,
    recipientId: actorId,
    sourceType: row.conversation_type,
    conversationId: ["personal_link", "username"].includes(row.conversation_type)
      ? row.conversation_id : undefined,
    sessionId: row.conversation_type === "random_chat"
      ? row.conversation_id : undefined,
    connectionId: row.conversation_type === "connection"
      ? row.conversation_id : undefined,
    message: {
      text: row.message,
      caption: row.caption,
      ...(row.media_type ? {
        [row.media_type]: { file_id: row.media_file_id }
      } : {})
    },
    sourceMessageId: row.source_message_id,
    skipRecipientNotification: true
  });
  if (!inserted.messageId || inserted.status !== "sent") {
    await env.CRASH_BOT_DB.batch([
      env.CRASH_BOT_DB.prepare(`
        INSERT INTO conversation_blocks
          (conversation_type, conversation_id, blocker_id, blocked_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(conversation_type, conversation_id, blocker_id) DO NOTHING
      `).bind(
        row.conversation_type, row.conversation_id, actorId, row.sender_id
      ),
      env.CRASH_BOT_DB.prepare(`
      UPDATE anonymous_blocked_messages SET status = 'pending',
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'releasing'
      `).bind(row.id)
    ]);
    await answerCallbackQuery(env, query.id,
      "ارتباط دیگر فعال نیست یا پیام هنوز قابل مشاهده نیست.");
    return true;
  }
  await env.CRASH_BOT_DB.prepare(`
    UPDATE anonymous_blocked_messages
    SET status = 'released', released_message_id = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'releasing'
  `).bind(inserted.messageId, row.id).run();
  return openInboxItem(env, {
    ...query,
    data: `anon:inbox:open:${inserted.notificationId}`
  }, actorId);
}

async function clearConversationDisplay(env, actorId, reference) {
  const rows = await env.CRASH_BOT_DB.prepare(`
    SELECT message_id FROM conversation_display_messages
    WHERE actor_id = ? AND conversation_type = ? AND conversation_id = ?
  `).bind(actorId, reference.type, reference.id).all();
  for (const row of rows.results ?? []) {
    await deleteTelegramMessage(env, actorId, row.message_id);
  }
  await env.CRASH_BOT_DB.prepare(`
    DELETE FROM conversation_display_messages
    WHERE actor_id = ? AND conversation_type = ? AND conversation_id = ?
  `).bind(actorId, reference.type, reference.id).run();
}

async function replayConversationMessage(
  env, actorId, reference, message, page, trackDisplay = true, returnDetail = false
) {
  const senderLabel = String(message.sender_id) === String(actorId)
    ? "پیام شما" : "پیام دریافتی";
  const heading = `${senderLabel} · ${tehranTime(message.created_at)}`;
  const reply = message.reply_to_message_id
    ? `\n↪️ پاسخ به پیام ذخیره‌شدهٔ #${message.reply_to_message_id}`
    : "";
  const peerId = String(message.sender_id) === String(actorId)
    ? message.recipient_id : message.sender_id;
  const blocks = await conversationBlockState(env, reference, actorId, peerId);
  const hiddenByBlock = String(message.sender_id) !== String(actorId) &&
    (blocks.blockedByViewer || blocks.blockedByOther);
  const keyboard = conversationMessageControls({
    ...message,
    source_type: reference.type
  }, actorId, {
    includeHistory: true,
    historyPage: page,
    ...blocks
  });
  const remember = async (result) => {
    const messageIds = result?.messageIds ?? [result?.messageId];
    if (trackDisplay) {
      for (const messageId of messageIds) {
        if (!Number.isSafeInteger(messageId)) continue;
        await env.CRASH_BOT_DB.prepare(`
          INSERT OR IGNORE INTO conversation_display_messages
            (actor_id, message_id, conversation_type, conversation_id)
          VALUES (?, ?, ?, ?)
        `).bind(actorId, messageId, reference.type, reference.id).run();
      }
    }
    return returnDetail ? result : result.outcome;
  };
  const content = String(message.message || message.caption || "رسانه");
  const result = await sendConversationContent(env, actorId, {
    text: hiddenByBlock
      ? `${heading}\n\nاین پیام به‌دلیل وضعیت بلاک فعلی مخفی است.`
      : `${heading}${reply}\n\n${content}`.slice(0, 4096),
    mediaType: hiddenByBlock ? null : message.media_type,
    mediaFileId: hiddenByBlock ? null : message.media_file_id,
    inlineKeyboard: hiddenByBlock && blocks.blockedByOther ? null : keyboard
  });
  return remember(result);
}

export async function renderRecentConversationMessages(
  env, actorId, conversationType, conversationId, limit = 20
) {
  const reference = { type: conversationType, id: Number(conversationId) };
  if (!reference.id || !Number.isSafeInteger(Number(reference.id)) ||
      Number(reference.id) <= 0 || !Number.isSafeInteger(limit) ||
      limit <= 0 || limit > 20) return false;

  let active;
  let column;
  if (reference.type === "connection") {
    active = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM connection_requests
      WHERE id = ? AND status = 'accepted' AND ended_at IS NULL
        AND (requester_id = ? OR recipient_id = ?)
    `).bind(reference.id, actorId, actorId).first();
    column = "connection_id";
  } else if (reference.type === "random_chat") {
    active = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM anonymous_sessions
      WHERE id = ? AND status = 'active'
        AND (user_a_id = ? OR user_b_id = ?)
    `).bind(reference.id, actorId, actorId).first();
    column = "session_id";
  } else if (["personal_link", "username"].includes(reference.type)) {
    active = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM anonymous_conversations
      WHERE id = ? AND status = 'active'
        AND (user_a_id = ? OR user_b_id = ?)
    `).bind(reference.id, actorId, actorId).first();
    column = "conversation_id";
  } else {
    return false;
  }
  if (!active) return false;

  const messages = await env.CRASH_BOT_DB.prepare(`
    SELECT id, sender_id, recipient_id, message, caption, media_type, media_file_id,
      reply_to_message_id, created_at
    FROM (
      SELECT id, sender_id, recipient_id, message, caption, media_type, media_file_id,
        reply_to_message_id, created_at
      FROM anonymous_messages
      WHERE ${column} = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    )
    ORDER BY created_at ASC, id ASC
  `).bind(reference.id, limit).all();
  await sendTelegram(env, actorId,
    `💬 ${messages.results?.length ?? 0} پیام آخر این گفت‌وگو، از قدیمی به جدید:`);
  for (const message of messages.results ?? []) {
    const outcome = await replayConversationMessage(
      env, actorId, reference, message, 0, false
    );
    if (outcome !== "sent") {
      console.error("Could not display a recent conversation message:", outcome);
    }
  }
  return true;
}

async function renderConversationHistory(env, query, actorId, sourceMessageId, page) {
  if (!validPage(page)) {
    await answerCallbackQuery(env, query.id, "شمارهٔ صفحه معتبر نیست.");
    return true;
  }
  const origin = await loadConversationMessage(env, sourceMessageId, actorId);
  if (!origin) {
    await answerCallbackQuery(env, query.id, "این گفت‌وگو در دسترس نیست.");
    return true;
  }
  const reference = threadReference(
    origin.source_type, origin.conversation_id, origin.session_id, origin.connection_id
  );
  if (reference.type !== "connection") {
    await answerCallbackQuery(env, query.id, "این بخش تاریخچه ندارد.");
    return true;
  }
  const column = reference.type === "random_chat" ? "session_id"
    : reference.type === "connection" ? "connection_id" : "conversation_id";
  const total = Number((await env.CRASH_BOT_DB.prepare(`
    SELECT COUNT(*) AS count FROM anonymous_messages WHERE ${column} = ?
  `).bind(reference.id).first())?.count ?? 0);
  const pageSize = 6;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const messages = await env.CRASH_BOT_DB.prepare(`
    SELECT id, sender_id, recipient_id, message, caption, media_type, media_file_id,
      reply_to_message_id, created_at
    FROM anonymous_messages WHERE ${column} = ?
    ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?
  `).bind(reference.id, pageSize, currentPage * pageSize).all();
  await clearConversationDisplay(env, actorId, reference);
  const navigation = [];
  if (currentPage > 0) navigation.push({
    text: "پیام‌های قبلی",
    callback_data: `anon:history:${sourceMessageId}:${currentPage - 1}`
  });
  if (currentPage + 1 < pageCount) navigation.push({
    text: "پیام‌های بعدی",
    callback_data: `anon:history:${sourceMessageId}:${currentPage + 1}`
  });
  const keyboard = navigation.length ? [navigation] : [];
  await sendTrackedSectionInlineTelegram(
    env, actorId,
    `📜 تاریخچهٔ گفت‌وگوی ناشناس · صفحه ${currentPage + 1}/${pageCount}`,
    keyboard
  );
  for (const message of messages.results ?? []) {
    const outcome = await replayConversationMessage(
      env, actorId, reference, message, currentPage
    );
    if (outcome !== "sent") {
      console.error("Could not display a conversation history item:", outcome);
    }
  }
  await answerCallbackQuery(env, query.id);
  return true;
}

async function archiveCount(env, archiveType) {
  if (archiveType === "posts") {
    const row = await env.CRASH_BOT_DB.prepare(`
      SELECT COUNT(*) AS total
      FROM connection_requests c
      WHERE c.status = 'accepted'
        AND EXISTS (
          SELECT 1 FROM anonymous_messages m
          WHERE m.connection_id = c.id AND m.message_type = 'connection'
          GROUP BY m.connection_id
        )
    `).first();
    return Number(row?.total ?? 0);
  }
  const row = await env.CRASH_BOT_DB.prepare(`
    SELECT COUNT(*) AS total FROM (
      SELECT c.id
      FROM anonymous_conversations c
      WHERE c.source_type IN ('personal_link', 'username')
        AND EXISTS (
          SELECT 1 FROM anonymous_messages m
          WHERE m.conversation_id = c.id
          GROUP BY m.conversation_id
        )
      UNION ALL
      SELECT s.id
      FROM anonymous_sessions s
      WHERE s.user_b_id IS NOT NULL AND s.status IN ('active', 'ended')
        AND EXISTS (
          SELECT 1 FROM anonymous_messages m
          WHERE m.session_id = s.id AND m.message_type = 'random_chat'
          GROUP BY m.session_id
        )
    )
  `).first();
  return Number(row?.total ?? 0);
}

function archiveButtonIdentity(username, userId) {
  const identity = username
    ? `@${String(username).replace(/^@/, "")}`
    : String(userId);
  const characters = Array.from(identity);
  return characters.length <= 30
    ? identity
    : `${characters.slice(0, 13).join("")}…${characters.slice(-13).join("")}`;
}

function archiveParticipantIdentity(user) {
  const telegramName = [user?.first_name, user?.last_name]
    .filter(Boolean).join(" ");
  const username = String(user?.username ?? "").replace(/^@/, "");
  return [
    telegramName ? `نام تلگرام: ${telegramName}` : null,
    user?.nickname ? `لقب ربات: ${user.nickname}` : null,
    username ? `@${username}` : null,
    `ID: ${user.telegram_id}`
  ].filter(Boolean).join(" · ");
}

async function loadArchiveParticipant(env, userId) {
  return env.CRASH_BOT_DB.prepare(`
    SELECT u.telegram_id, u.username, u.first_name, u.last_name, p.nickname
    FROM users u LEFT JOIN profiles p ON p.user_id = u.telegram_id
    WHERE u.telegram_id = ?
  `).bind(userId).first();
}

async function renderOwnerArchiveList(env, actorId, chatId, archiveType, page) {
  if (String(actorId) !== String(env.OWNER_TELEGRAM_ID) ||
      String(chatId) !== String(actorId) || !validPage(page)) return false;
  await clearOwnerArchiveDisplay(env, actorId);
  const offset = page * ARCHIVE_PAGE_SIZE;
  let rows;
  if (archiveType === "posts") {
    rows = await env.CRASH_BOT_DB.prepare(`
      SELECT c.id AS entity_id, 'connection' AS source_type,
        c.requester_id AS user_a_id, c.recipient_id AS user_b_id,
        ua.username AS user_a_username, ub.username AS user_b_username,
        MAX(m.created_at) AS latest_message
      FROM connection_requests c
      JOIN anonymous_messages m ON m.connection_id = c.id
        AND m.message_type = 'connection'
      JOIN users ua ON ua.telegram_id = c.requester_id
      JOIN users ub ON ub.telegram_id = c.recipient_id
      WHERE c.status = 'accepted'
      GROUP BY c.id, c.requester_id, c.recipient_id,
        ua.username, ub.username
      ORDER BY latest_message DESC, entity_id DESC
      LIMIT ? OFFSET ?
    `).bind(ARCHIVE_PAGE_SIZE + 1, offset).all();
  } else {
    rows = await env.CRASH_BOT_DB.prepare(`
      SELECT * FROM (
        SELECT c.id AS entity_id, c.source_type,
          c.user_a_id, c.user_b_id,
          ua.username AS user_a_username, ub.username AS user_b_username,
          MAX(m.created_at) AS latest_message
        FROM anonymous_conversations c
        JOIN anonymous_messages m ON m.conversation_id = c.id
        JOIN users ua ON ua.telegram_id = c.user_a_id
        JOIN users ub ON ub.telegram_id = c.user_b_id
        WHERE c.source_type IN ('personal_link', 'username')
        GROUP BY c.id, c.source_type, c.user_a_id, c.user_b_id,
          ua.username, ub.username
        UNION ALL
        SELECT s.id AS entity_id, 'random_chat' AS source_type,
          s.user_a_id, s.user_b_id,
          ua.username AS user_a_username, ub.username AS user_b_username,
          MAX(m.created_at) AS latest_message
        FROM anonymous_sessions s
        JOIN anonymous_messages m ON m.session_id = s.id
          AND m.message_type = 'random_chat'
        JOIN users ua ON ua.telegram_id = s.user_a_id
        JOIN users ub ON ub.telegram_id = s.user_b_id
        WHERE s.user_b_id IS NOT NULL AND s.status IN ('active', 'ended')
        GROUP BY s.id, s.user_a_id, s.user_b_id,
          ua.username, ub.username
      )
      ORDER BY latest_message DESC, entity_id DESC
      LIMIT ? OFFSET ?
    `).bind(ARCHIVE_PAGE_SIZE + 1, offset).all();
  }
  const results = rows.results ?? [];
  const visible = results.slice(0, ARCHIVE_PAGE_SIZE);
  const total = await archiveCount(env, archiveType);
  const buttons = visible.map((item) => [{
    text: `${archiveButtonIdentity(item.user_a_username, item.user_a_id)} ↔ ${archiveButtonIdentity(item.user_b_username, item.user_b_id)}`,
    callback_data: `ownerarchive:open:${archiveType}:${item.source_type}:${item.entity_id}:0`
  }]);
  if (page > 0) {
    buttons.push([{
      text: "صفحهٔ قبلی",
      callback_data: `ownerarchive:list:${archiveType}:${page - 1}`
    }]);
  }
  if (results.length > ARCHIVE_PAGE_SIZE) {
    buttons.push([{
      text: "صفحهٔ بعدی",
      callback_data: `ownerarchive:list:${archiveType}:${page + 1}`
    }]);
  }
  await sendTrackedSectionInlineTelegram(
    env,
    chatId,
    `📚 ${archiveType === "posts" ? "آرشیو ارتباط‌های پذیرفته‌شدهٔ کانال" : "آرشیو گفت‌وگوهای ناشناس"}\nگفت‌وگوهای واجد شرایط: ${total}\nصفحه: ${page + 1}`,
    buttons
  );
  await sendMessageTelegramDetailed(
    env, chatId, "برای بازگشت از آرشیو از دکمهٔ منوی اصلی استفاده کن.",
    CHAT_RETURN_KEYBOARD
  );
  return true;
}

async function ownerHistoryMessages(env, archiveType, sourceType, entityId, page) {
  const offset = page * HISTORY_PAGE_SIZE;
  if (archiveType === "posts") {
    const connection = await env.CRASH_BOT_DB.prepare(`
      SELECT requester_id, recipient_id
      FROM connection_requests
      WHERE id = ? AND status = 'accepted'
        AND EXISTS (
          SELECT 1 FROM anonymous_messages m
          WHERE m.connection_id = connection_requests.id
          GROUP BY m.connection_id
        )
    `).bind(entityId).first();
    if (!connection) return null;
    const result = await env.CRASH_BOT_DB.prepare(`
      SELECT id, sender_id, recipient_id, message, caption,
        media_type, media_file_id, delivery_status, created_at
      FROM anonymous_messages
      WHERE connection_id = ? AND message_type = 'connection'
      ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?
    `).bind(entityId, HISTORY_PAGE_SIZE + 1, offset).all();
    return {
      firstId: connection.requester_id,
      secondId: connection.recipient_id,
      total: Number((await env.CRASH_BOT_DB.prepare(`
        SELECT COUNT(*) AS total FROM anonymous_messages
        WHERE connection_id = ? AND message_type = 'connection'
      `).bind(entityId).first())?.total ?? 0),
      messages: result.results ?? []
    };
  }

  if (sourceType === "random_chat") {
    const session = await env.CRASH_BOT_DB.prepare(`
      SELECT user_a_id, user_b_id FROM anonymous_sessions
      WHERE id = ? AND user_b_id IS NOT NULL
        AND status IN ('active', 'ended')
        AND EXISTS (
          SELECT 1 FROM anonymous_messages m
          WHERE m.session_id = anonymous_sessions.id
            AND m.message_type = 'random_chat'
          GROUP BY m.session_id
        )
    `).bind(entityId).first();
    if (!session) return null;
    const result = await env.CRASH_BOT_DB.prepare(`
      SELECT id, sender_id, recipient_id, message, caption,
        media_type, media_file_id, delivery_status, created_at
      FROM anonymous_messages
      WHERE session_id = ? AND message_type = 'random_chat'
      ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?
    `).bind(entityId, HISTORY_PAGE_SIZE + 1, offset).all();
    const total = await env.CRASH_BOT_DB.prepare(`
      SELECT COUNT(*) AS total FROM anonymous_messages
      WHERE session_id = ? AND message_type = 'random_chat'
    `).bind(entityId).first();
    return {
      firstId: session.user_a_id,
      secondId: session.user_b_id,
      total: Number(total?.total ?? 0),
      messages: result.results ?? []
    };
  }

  if (!["personal_link", "username"].includes(sourceType)) return null;
  const conversation = await env.CRASH_BOT_DB.prepare(`
    SELECT user_a_id, user_b_id FROM anonymous_conversations
    WHERE id = ? AND source_type = ? AND EXISTS (
      SELECT 1 FROM anonymous_messages m
      WHERE m.conversation_id = anonymous_conversations.id
      GROUP BY m.conversation_id
    )
  `).bind(entityId, sourceType).first();
  if (!conversation) return null;
  const result = await env.CRASH_BOT_DB.prepare(`
    SELECT id, sender_id, recipient_id, message, caption,
      media_type, media_file_id, delivery_status, created_at
    FROM anonymous_messages
    WHERE conversation_id = ? AND message_type = ?
    ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?
  `).bind(entityId, sourceType, HISTORY_PAGE_SIZE + 1, offset).all();
  const total = await env.CRASH_BOT_DB.prepare(`
    SELECT COUNT(*) AS total FROM anonymous_messages
    WHERE conversation_id = ? AND message_type = ?
  `).bind(entityId, sourceType).first();
  return {
    firstId: conversation.user_a_id,
    secondId: conversation.user_b_id,
    total: Number(total?.total ?? 0),
    messages: result.results ?? []
  };
}

async function replayOwnerHistory(env, chatId, history) {
  const displayedMessageIds = [];
  const remember = (result) => {
    if (Number.isSafeInteger(result?.messageId)) {
      displayedMessageIds.push(result.messageId);
    }
  };
  for (const item of history.messages) {
    const senderLabel = String(item.sender_id) === String(history.firstId)
      ? history.firstLabel : history.secondLabel;
    const heading = `${senderLabel} · ${tehranTime(item.created_at)}`;
    if (!item.media_type || !item.media_file_id) {
      const result = await sendMessageTelegramDetailed(
        env, chatId, `${heading}\n${item.message || item.caption || "[رسانه]"}`
      );
      remember(result);
      if (result.outcome !== "sent") {
        console.error("Could not display an owner archive text message:", result.outcome);
      }
      continue;
    }
    const method = MEDIA_METHODS[item.media_type];
    if (!method) continue;
    const noCaption = ["sticker", "video_note"].includes(item.media_type);
    if (noCaption) {
      const headingResult = await sendMessageTelegramDetailed(env, chatId, heading);
      remember(headingResult);
      if (headingResult.outcome !== "sent") continue;
    }
    const caption = noCaption ? null :
      `${heading}\n${item.caption || item.message || ""}`.slice(0, 1024);
    const result = await sendMediaTelegramDetailed(env, method, {
      chat_id: chatId,
      [item.media_type]: item.media_file_id,
      ...(caption ? { caption } : {})
    });
    remember(result);
    if (result.outcome !== "sent") {
      console.error("Could not display an owner archive media message:", result.outcome);
    }
  }
  if (displayedMessageIds.length) {
    await env.CRASH_BOT_DB.batch(displayedMessageIds.map((messageId) =>
      env.CRASH_BOT_DB.prepare(`
        INSERT OR IGNORE INTO owner_archive_display_messages (owner_id, message_id)
        VALUES (?, ?)
      `).bind(chatId, messageId)
    ));
  }
}

function newOwnerExportToken() {
  return newToken().slice("anon_".length);
}

async function createOwnerTextExport(env, {
  ownerId, archiveType, sourceType, entityId, cursorCreatedAt = null,
  cursorMessageId = null, partNumber = 1
}) {
  const token = newOwnerExportToken();
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO owner_archive_text_exports (
      token, owner_id, archive_type, source_type, entity_id,
      cursor_created_at, cursor_message_id, part_number
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    token, ownerId, archiveType, sourceType, entityId,
    cursorCreatedAt, cursorMessageId, partNumber
  ).run();
  return token;
}

function splitOwnerExportText(text) {
  const chunks = [];
  let remainder = text;
  while (remainder.length > OWNER_TEXT_EXPORT_MESSAGE_LENGTH) {
    let end = OWNER_TEXT_EXPORT_MESSAGE_LENGTH;
    const lastCodeUnit = remainder.charCodeAt(end - 1);
    if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
    chunks.push(remainder.slice(0, end));
    remainder = remainder.slice(end);
  }
  if (remainder) chunks.push(remainder);
  return chunks;
}

function ownerArchiveTextLabel(participant) {
  const username = String(participant?.username ?? "").replace(/^@/, "").trim();
  return username ? `@${username}` : String(participant?.telegram_id ?? "نامشخص");
}

async function ownerTextExportRows(env, exportState) {
  let column;
  let messageType;
  if (exportState.source_type === "random_chat") {
    column = "session_id";
    messageType = "random_chat";
  } else if (exportState.source_type === "connection") {
    column = "connection_id";
    messageType = "connection";
  } else {
    column = "conversation_id";
    messageType = exportState.source_type;
  }

  const base = `
    SELECT id, sender_id, message, caption, media_type, created_at
    FROM anonymous_messages
    WHERE ${column} = ? AND message_type = ?
  `;
  const query = exportState.cursor_created_at
    ? `${base}
      AND (created_at > ? OR (created_at = ? AND id > ?))
      ORDER BY created_at ASC, id ASC LIMIT ?`
    : `${base}
      ORDER BY created_at ASC, id ASC LIMIT ?`;
  const statement = env.CRASH_BOT_DB.prepare(query);
  return exportState.cursor_created_at
    ? statement.bind(
      exportState.entity_id, messageType,
      exportState.cursor_created_at, exportState.cursor_created_at,
      exportState.cursor_message_id, OWNER_TEXT_EXPORT_PAGE_SIZE + 1
    ).all()
    : statement.bind(
      exportState.entity_id, messageType,
      OWNER_TEXT_EXPORT_PAGE_SIZE + 1
    ).all();
}

async function handleOwnerTextExport(env, query, actorId, token) {
  const ownerId = env.OWNER_TELEGRAM_ID;
  await env.CRASH_BOT_DB.prepare(`
    UPDATE owner_archive_text_exports
    SET status = 'unknown', updated_at = CURRENT_TIMESTAMP
    WHERE token = ? AND owner_id = ? AND status = 'sending'
      AND updated_at < datetime('now', '-15 minutes')
  `).bind(token, ownerId).run();
  const exportState = await env.CRASH_BOT_DB.prepare(`
    UPDATE owner_archive_text_exports
    SET status = 'sending', updated_at = CURRENT_TIMESTAMP
    WHERE token = ? AND owner_id = ? AND status = 'pending'
    RETURNING *
  `).bind(token, ownerId).first();
  if (!exportState) {
    await answerCallbackQuery(env, query.id,
      "این خروجی قبلاً آغاز شده، پایان یافته یا دیگر در دسترس نیست.");
    return true;
  }

  const history = await ownerHistoryMessages(
    env, exportState.archive_type, exportState.source_type,
    exportState.entity_id, 0
  );
  if (!history) {
    await env.CRASH_BOT_DB.prepare(`
      UPDATE owner_archive_text_exports SET status = 'unknown',
        updated_at = CURRENT_TIMESTAMP WHERE token = ?
    `).bind(token).run();
    await answerCallbackQuery(env, query.id, "این گفت‌وگو دیگر در آرشیو در دسترس نیست.");
    return true;
  }
  const [firstParticipant, secondParticipant] = await Promise.all([
    loadArchiveParticipant(env, history.firstId),
    loadArchiveParticipant(env, history.secondId)
  ]);
  const firstLabel = ownerArchiveTextLabel(firstParticipant ?? {
    telegram_id: history.firstId
  });
  const secondLabel = ownerArchiveTextLabel(secondParticipant ?? {
    telegram_id: history.secondId
  });
  const rows = await ownerTextExportRows(env, exportState);
  const messages = (rows.results ?? []).slice(0, OWNER_TEXT_EXPORT_PAGE_SIZE);
  const hasMore = (rows.results ?? []).length > OWNER_TEXT_EXPORT_PAGE_SIZE;
  const outputLines = [
    `گفت‌وگو #${exportState.entity_id} · بخش ${exportState.part_number}`
  ];
  for (const message of messages) {
    const sender = String(message.sender_id) === String(history.firstId)
      ? firstLabel : secondLabel;
    const content = message.media_type
      ? `[رسانه: ${message.media_type}] ${message.caption || message.message || ""}`.trim()
      : message.message || message.caption || "[پیام بدون متن]";
    outputLines.push(
      `${sender}: ${content}\nزمان: ${tehranTime(message.created_at)}`
    );
  }
  const chunks = splitOwnerExportText(outputLines.join("\n\n"));
  const nextToken = hasMore
    ? await createOwnerTextExport(env, {
      ownerId,
      archiveType: exportState.archive_type,
      sourceType: exportState.source_type,
      entityId: exportState.entity_id,
      cursorCreatedAt: messages.at(-1)?.created_at ?? exportState.cursor_created_at,
      cursorMessageId: messages.at(-1)?.id ?? exportState.cursor_message_id,
      partNumber: Number(exportState.part_number) + 1
    })
    : null;

  const keyboardResult = await sendMessageTelegramDetailed(
    env, actorId, "برای خروج از آرشیو از دکمهٔ منوی اصلی استفاده کن.",
    CHAT_RETURN_KEYBOARD
  );
  let outcome = keyboardResult.outcome;
  if (outcome === "sent") {
    for (let index = 0; index < chunks.length; index += 1) {
      const lastChunk = index === chunks.length - 1;
      const result = hasMore && lastChunk
        ? await sendInlineTelegramDetailed(env, actorId, chunks[index], [[{
          text: "ادامهٔ خروجی متنی",
          callback_data: `ownerarchive:text:${nextToken}`
        }]])
        : await sendMessageTelegramDetailed(env, actorId, chunks[index]);
      if (result.outcome !== "sent") {
        outcome = result.outcome;
        break;
      }
    }
  }
  if (outcome !== "sent") {
    if (nextToken) {
      await env.CRASH_BOT_DB.prepare(
        "DELETE FROM owner_archive_text_exports WHERE token = ?"
      ).bind(nextToken).run();
    }
    await env.CRASH_BOT_DB.prepare(`
      UPDATE owner_archive_text_exports SET status = 'unknown',
        updated_at = CURRENT_TIMESTAMP WHERE token = ?
    `).bind(token).run();
    await sendMessageTelegramDetailed(
      env, actorId,
      "⚠️ خروجی متنی کامل ارسال نشد؛ برای جلوگیری از تکرار ناخواسته، ادامهٔ خودکار متوقف شد."
    );
    await answerCallbackQuery(env, query.id, "ارسال خروجی کامل نشد.");
    return true;
  }

  await env.CRASH_BOT_DB.prepare(
    "DELETE FROM owner_archive_text_exports WHERE token = ?"
  ).bind(token).run();
  await answerCallbackQuery(env, query.id);
  return true;
}

async function renderOwnerArchiveHistory(
  env, actorId, chatId, archiveType, sourceType, entityId, page
) {
  if (String(actorId) !== String(env.OWNER_TELEGRAM_ID) ||
      String(chatId) !== String(actorId) || !validPage(page)) return false;
  await clearOwnerArchiveDisplay(env, actorId);
  const history = await ownerHistoryMessages(
    env, archiveType, sourceType, entityId, page
  );
  if (!history) {
    await sendMessageTelegramDetailed(env, chatId, "این گفت‌وگو در آرشیو واجد شرایط نیست.");
    return true;
  }
  const [firstParticipant, secondParticipant] = await Promise.all([
    loadArchiveParticipant(env, history.firstId),
    loadArchiveParticipant(env, history.secondId)
  ]);
  history.firstLabel = archiveParticipantIdentity(firstParticipant ?? {
    telegram_id: history.firstId
  });
  history.secondLabel = archiveParticipantIdentity(secondParticipant ?? {
    telegram_id: history.secondId
  });
  const visible = history.messages.slice(0, HISTORY_PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(history.total / HISTORY_PAGE_SIZE));
  const buttons = [];
  if (page > 0) {
    buttons.push([{
      text: "پیام‌های قبلی",
      callback_data: `ownerarchive:open:${archiveType}:${sourceType}:${entityId}:${page - 1}`
    }]);
  }
  if (page + 1 < pageCount) {
    buttons.push([{
      text: "پیام‌های بعدی",
      callback_data: `ownerarchive:open:${archiveType}:${sourceType}:${entityId}:${page + 1}`
    }]);
  }
  const exportToken = await createOwnerTextExport(env, {
    ownerId: actorId, archiveType, sourceType, entityId
  });
  buttons.push([{
    text: "📄 ارسال خروجی متنی کامل",
    callback_data: `ownerarchive:text:${exportToken}`
  }]);
  buttons.push([{
    text: "بازگشت به فهرست",
    callback_data: `ownerarchive:list:${archiveType}:0`
  }]);
  await sendTrackedSectionInlineTelegram(
    env,
    chatId,
    `🔒 آرشیو فقط‌خواندنی · ${SOURCE_LABELS[sourceType]}\nگفت‌وگو #${entityId}\n${history.firstLabel} ↔ ${history.secondLabel}\nپیام‌های ${page * HISTORY_PAGE_SIZE + 1} تا ${Math.min((page + 1) * HISTORY_PAGE_SIZE, history.total)} از ${history.total}\nترتیب صفحه: قدیمی‌ترین به جدیدترین`,
    buttons
  );
  await replayOwnerHistory(env, chatId, { ...history, messages: visible });
  await sendMessageTelegramDetailed(
    env, chatId, "برای خروج از آرشیو از دکمهٔ منوی اصلی استفاده کن.",
    CHAT_RETURN_KEYBOARD
  );
  return true;
}

export async function renderOwnerAnonymousArchive(env, actorId, chatId) {
  return renderOwnerArchiveList(env, actorId, chatId, "anonymous", 0);
}

export async function renderOwnerConnectionArchive(env, actorId, chatId) {
  return renderOwnerArchiveList(env, actorId, chatId, "posts", 0);
}

export async function clearOwnerArchiveDisplay(env, ownerId) {
  if (String(ownerId) !== String(env.OWNER_TELEGRAM_ID)) return false;
  const rows = await env.CRASH_BOT_DB.prepare(`
    SELECT message_id FROM owner_archive_display_messages WHERE owner_id = ?
  `).bind(ownerId).all();
  for (const row of rows.results ?? []) {
    try {
      await deleteTelegramMessage(env, ownerId, row.message_id);
    } catch (error) {
      console.error("Could not remove a previous owner archive display:", error);
    }
  }
  await env.CRASH_BOT_DB.prepare(`
    DELETE FROM owner_archive_display_messages WHERE owner_id = ?
  `).bind(ownerId).run();
  return true;
}

async function handleOwnerArchiveCallback(env, query, actorId) {
  const data = String(query?.data ?? "");
  const list = /^ownerarchive:list:(anonymous|posts):(\d+)$/.exec(data);
  const open = /^ownerarchive:open:(anonymous|posts):(random_chat|personal_link|username|connection):(\d+):(\d+)$/.exec(data);
  const textExport = /^ownerarchive:text:([a-f0-9]{32})$/.exec(data);
  if (!list && !open && !textExport) return false;
  if (String(actorId) !== String(env.OWNER_TELEGRAM_ID) ||
      String(query.message.chat.id) !== String(actorId)) {
    await answerCallbackQuery(env, query.id, "این آرشیو فقط برای مالک اصلی در دسترس است.");
    return true;
  }
  if (list) {
    const page = Number(list[2]);
    if (!validPage(page)) {
      await answerCallbackQuery(env, query.id, "شمارهٔ صفحه معتبر نیست.");
      return true;
    }
    await renderOwnerArchiveList(env, actorId, actorId, list[1], page);
  } else if (open) {
    const page = Number(open[4]);
    const entityId = Number(open[3]);
    if (!validPage(page) || !Number.isSafeInteger(entityId) || entityId <= 0 ||
        (open[1] === "posts" && open[2] !== "connection") ||
        (open[1] === "anonymous" && open[2] === "connection")) {
      await answerCallbackQuery(env, query.id, "درخواست آرشیو معتبر نیست.");
      return true;
    }
    await renderOwnerArchiveHistory(
      env, actorId, actorId, open[1], open[2], entityId, page
    );
  } else {
    return handleOwnerTextExport(env, query, actorId, textExport[1]);
  }
  await answerCallbackQuery(env, query.id);
  return true;
}

export async function handleAnonymousChatCallback(env, query) {
  const data = String(query?.data ?? "");
  if (!data.startsWith("anon:") && !data.startsWith("ownerarchive:")) return false;
  const actorId = privateActor(query);
  if (!actorId) {
    await answerCallbackQuery(env, query.id, "این گزینه فقط در گفت‌وگوی خصوصی خودت معتبر است.");
    return true;
  }
  if (data.startsWith("ownerarchive:")) {
    return handleOwnerArchiveCallback(env, query, actorId);
  }
  const list = /^anon:inbox:list:(\d+)$/.exec(data);
  if (list) {
    const page = Number(list[1]);
    if (!validPage(page)) {
      await answerCallbackQuery(env, query.id, "شمارهٔ صفحه معتبر نیست.");
      return true;
    }
    await renderUserMessageInbox(env, actorId, actorId, page);
    await answerCallbackQuery(env, query.id);
    return true;
  }
  if (data.startsWith("anon:inbox:open:")) {
    return openInboxItem(env, query, actorId);
  }
  if (data.startsWith("anon:unblock_view:")) {
    return unblockAndViewMessage(env, query, actorId);
  }
  if (await cancelReplyContext(env, query, actorId)) return true;
  if (data.startsWith("anon:reply:")) {
    return openReplyContext(env, query, actorId);
  }
  if (data.startsWith("anon:block:")) {
    return blockConversationFromMessage(env, query, actorId);
  }
  if (data.startsWith("anon:unblock:")) {
    return unblockConversationFromMessage(env, query, actorId);
  }
  const history = /^anon:history:(\d+):(\d+)$/.exec(data);
  if (history) {
    return renderConversationHistory(
      env, query, actorId, Number(history[1]), Number(history[2])
    );
  }
  await answerCallbackQuery(env, query.id, "این عملیات ناشناخته است.");
  return true;
}

async function handleUsernameLookup(env, message, userId) {
  const state = await env.CRASH_BOT_DB.prepare(`
    SELECT state FROM anonymous_chat_states WHERE user_id = ?
  `).bind(userId).first();
  if (state?.state !== "username_lookup") return false;
  const input = messageContent(message);
  const telegramId = /^\d{1,16}$/.test(input) ? Number(input) : null;
  const username = telegramId === null
    ? /^@?([A-Za-z0-9_]{5,32})$/.exec(input)
    : null;
  if (!username && (!Number.isSafeInteger(telegramId) || telegramId <= 0)) {
    await sendTelegram(env, message.chat.id,
      "نام کاربری معتبر مانند @username یا شناسهٔ عددی تلگرام را بفرست.");
    return true;
  }
  const target = await env.CRASH_BOT_DB.prepare(`
    SELECT telegram_id, is_blocked, account_status, started_at
    FROM users
    WHERE (? IS NOT NULL AND lower(replace(username, '@', '')) = lower(?))
      OR (? IS NOT NULL AND telegram_id = ?)
    LIMIT 1
  `).bind(username ? username[1] : null, username ? username[1] : null,
    telegramId, telegramId).first();
  if (!target || target.is_blocked === 1 ||
      (target.account_status && target.account_status !== "active") ||
      String(target.telegram_id) === String(userId) || !target.started_at) {
    await sendTelegram(env, message.chat.id,
      "این کاربر هنوز امکان دریافت پیام خصوصی از ربات را ندارد. از او بخواه ربات را باز کند و «شروع / Start» را بزند، سپس دوباره آیدی را وارد کن.");
    return true;
  }
  const blocks = await pairBlockState(
    env, userId, target.telegram_id, "username"
  );
  if (blocks.blockedByViewer) {
    await sendTelegram(env, message.chat.id,
      "این گفت‌وگو در مسیر ارتباط با آیدی مسدود شده است.");
    return true;
  }
  const existingConversationId = await activeConversation(
    env, userId, target.telegram_id, "username"
  );
  await env.CRASH_BOT_DB.prepare(`
    UPDATE anonymous_chat_states
    SET state = 'username_message', target_user_id = ?,
      conversation_id = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND state = 'username_lookup'
  `).bind(target.telegram_id, userId).run();
  await sendTelegram(env, message.chat.id,
    "آیدی قابل دسترسی است. حالا پیام متنی یا رسانه‌ای خود را بفرست؛ نام کاربری تو برای گیرنده نمایش داده نمی‌شود.",
    CHAT_RETURN_KEYBOARD);
  return true;
}

export async function handleAnonymousConversationMessage(env, message, userId) {
  if (!isPrivateConversationMessage(message, userId)) return false;
  const text = messageContent(message);
  if (isBotCommand(message) && !NAVIGATION_TEXTS.has(text)) return false;
  const state = await env.CRASH_BOT_DB.prepare(`
    SELECT state, target_user_id, conversation_id
    FROM anonymous_chat_states WHERE user_id = ?
  `).bind(userId).first();
  if (!state) return false;
  const selection = await getConversationSelection(env, userId);
  if (state.state === "active" && selection && (
    !["personal_link", "username"].includes(selection.conversation_type) ||
    Number(selection.conversation_id) !== Number(state.conversation_id)
  )) return false;
  if (NAVIGATION_TEXTS.has(text)) {
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM anonymous_chat_states WHERE user_id = ?"
    ).bind(userId).run();
    if (selection && ["personal_link", "username"].includes(selection.conversation_type)) {
      await clearConversationSelection(env, userId);
      await clearConversationReplyContext(env, userId, {
        type: selection.conversation_type,
        id: Number(selection.conversation_id)
      });
    }
    return false;
  }
  if (state.state === "username_lookup") {
    return handleUsernameLookup(env, message, userId);
  }
  if (state.state === "username_message") {
    if (!Number.isSafeInteger(state.target_user_id) || state.target_user_id <= 0 ||
        state.target_user_id === userId) {
      await sendTelegram(env, message.chat.id,
        "ارسال پیام به خودت امکان‌پذیر نیست؛ یک آیدی دیگر انتخاب کن.");
      return true;
    }
    const existingConversationId = await activeConversation(
      env, userId, state.target_user_id, "username"
    );
    const conversationId = existingConversationId ?? await createConversation(
      env, userId, state.target_user_id, "username"
    );
    await setConversationState(env, userId, conversationId, "username");
    const result = await appendAndNotify(env, {
      senderId: userId,
      recipientId: state.target_user_id,
      sourceType: "username",
      conversationId,
      message,
      sourceMessageId: message.message_id
    });
    if (result.status === "invalid") {
      await sendTelegram(env, message.chat.id, "پیام متنی یا رسانهٔ پشتیبانی‌شده بفرست.");
    }
    return true;
  }
  if (state.state !== "active" || !state.conversation_id) return false;
  const conversation = await env.CRASH_BOT_DB.prepare(`
    SELECT id, user_a_id, user_b_id, source_type, status
    FROM anonymous_conversations
    WHERE id = ? AND (user_a_id = ? OR user_b_id = ?)
  `).bind(state.conversation_id, userId, userId).first();
  if (!conversation || conversation.status !== "active") {
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM anonymous_chat_states WHERE user_id = ?"
    ).bind(userId).run();
    await sendTelegram(env, message.chat.id, "این گفت‌وگو دیگر فعال نیست.");
    return true;
  }
  const recipientId = String(conversation.user_a_id) === String(userId)
    ? conversation.user_b_id : conversation.user_a_id;
  const result = await appendAndNotify(env, {
    senderId: userId,
    recipientId,
    sourceType: conversation.source_type,
    conversationId: conversation.id,
    message,
    sourceMessageId: message.message_id
  });
  if (result.status === "invalid") {
    await sendTelegram(env, message.chat.id, "پیام متنی یا رسانهٔ پشتیبانی‌شده بفرست.");
  }
  return true;
}
