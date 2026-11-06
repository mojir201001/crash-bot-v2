import {
  answerCallbackQuery,
  deleteTelegramMessage,
  editTelegramReplyMarkupDetailed,
  sendInlineTelegramDetailed,
  sendMessageTelegramDetailed,
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
import { calculatePersianAge } from "./profile.js";
import { upsertTelegramUser } from "./telegram-users.js";
import {
  CHAT_RETURN_BUTTON,
  CHAT_RETURN_KEYBOARD
} from "./anonymous-chat.js";

const PAGE_SIZE = 8;
const MESSAGE_PAGE_SIZE = 8;
const TIMELINE_MESSAGES_KEY_PREFIX = "advertising_timeline_messages:";
const NAVIGATION_TEXTS = new Set([
  "/start", "/menu", "🏠 منوی اصلی", "⬅️ بازگشت",
  CHAT_RETURN_BUTTON,
  "🛠 پنل مدیریت", "👤 پنل کاربر", "👤 پروفایل من", "💌 ثبت پست کراش",
  "🎭 چت ناشناس تصادفی", "🤝 درخواست‌های ارتباط از کانال",
  "🔗 لینک ناشناس من",
  "📢 ثبت درخواست تبلیغات", "📖 راهنما و قوانین",
  "🔎 بررسی پیام‌های ناشناس", "🗂 آرشیو پیام‌های ناشناس",
  "📢 درخواست‌های تبلیغات", "🗃 آرشیو پیام‌های کانال",
  "🔔 اعلان‌های نیازمند بررسی", "💬 آرشیو چت‌های کاربران",
  "🎭 آرشیو ارتباط ناشناس", "📣 پیام همگانی",
  "📖 ویرایش راهنما و قوانین", "🔗 عضویت اجباری",
  "⚙️ تنظیمات ربات", "👥 مدیریت ادمین‌ها", "📚 ثبت کراش‌های من",
  "🎭 ارتباط ناشناس", "🏫 خرید ربات برای دانشگاه", "❓ راهنما",
  "📜 قوانین ربات", "👤 پنل کاربر", "↩️ بازگشت به پنل مدیریت"
]);
function textFromMessage(message) {
  return String(message?.text ?? message?.caption ?? "").trim();
}

function mediaFromMessage(message) {
  return conversationMediaFromMessage(message);
}

function validPage(value) {
  return Number.isSafeInteger(value) && value >= 0 &&
    Number.isSafeInteger(value * MESSAGE_PAGE_SIZE);
}

function formatMessage(message, viewerId, ownerId) {
  const sender = message.sender_role === "owner"
    ? "پاسخ مالک"
    : String(viewerId) === String(ownerId)
      ? `درخواست‌دهنده · Telegram ID: ${message.sender_id}`
      : "پیام ناشناس";
  const hidden = String(message.sender_id) !== String(viewerId) &&
    (message.visibility_status === "blocked" ||
      message.view_delivery_status !== "sent" ||
      message.viewer_blocked || message.other_blocked);
  const content = hidden
    ? message.visibility_status === "blocked"
      ? "محتوای پیام تا خروج از بلاک و تأیید شما مخفی است."
      : "برای مشاهدهٔ محتوای پیام، دکمهٔ مشاهده را بزنید."
    : message.caption || message.message || "";
  const media = hidden
    ? ""
    : message.media_type ? `\n[رسانه: ${message.media_type}]` : "";
  const reply = message.reply_to_message_id
    ? `\n↪️ پاسخ به پیام #${message.reply_to_message_id}`
    : "";
  const delivery = message.delivery_status === "unknown"
    ? "\nوضعیت ارسال: نامشخص؛ ارسال دوباره انجام نشده است."
    : message.delivery_status === "failed"
      ? "\nوضعیت ارسال: ناموفق"
      : "";
  return `${sender} — ${message.created_at}\n${content}${media}${reply}${delivery}`;
}

async function saveActorState(env, actorId, conversationId, actorRole) {
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO advertising_conversation_state
      (actor_id, conversation_id, actor_role, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(actor_id) DO UPDATE SET
      conversation_id = excluded.conversation_id,
      actor_role = excluded.actor_role,
      reply_to_message_id = NULL,
      updated_at = CURRENT_TIMESTAMP
  `).bind(actorId, conversationId, actorRole).run();
}

async function clearActorState(env, actorId) {
  await env.CRASH_BOT_DB.prepare(
    "DELETE FROM advertising_conversation_state WHERE actor_id = ?"
  ).bind(actorId).run();
}

async function ensureConversation(env, requesterId) {
  const conversation = await env.CRASH_BOT_DB.prepare(`
    INSERT INTO advertising_conversations (requester_id, status)
    VALUES (?, 'open')
    ON CONFLICT(requester_id) DO UPDATE SET
      status = 'open',
      updated_at = CURRENT_TIMESTAMP
    RETURNING id
  `).bind(requesterId).first();
  if (!conversation?.id) throw new Error("Could not create advertising conversation");
  return conversation.id;
}

async function advertisingBlockState(
  env, conversationId, actorId, requesterId, legacyBlockedBy = null
) {
  const rows = await env.CRASH_BOT_DB.prepare(`
    SELECT blocker_role FROM advertising_conversation_blocks
    WHERE conversation_id = ?
  `).bind(conversationId).all();
  const actorRole = String(actorId) === String(requesterId)
    ? "requester" : "owner";
  const otherRole = actorRole === "requester" ? "owner" : "requester";
  const roles = new Set((rows.results ?? []).map((row) => row.blocker_role));
  if (legacyBlockedBy != null) {
    roles.add(String(legacyBlockedBy) === String(requesterId)
      ? "requester" : "owner");
  }
  return {
    actorRole,
    otherRole,
    blockedByViewer: roles.has(actorRole),
    blockedByOther: roles.has(otherRole)
  };
}

async function readConversationMessages(env, conversationId, page, actorId) {
  const messages = await env.CRASH_BOT_DB.prepare(`
    SELECT m.id, m.sender_id, m.sender_role, m.message, m.media_type,
           m.media_file_id, m.caption, m.delivery_status, m.visibility_status,
           m.reply_to_message_id, m.view_delivery_status, m.created_at,
           (EXISTS (
             SELECT 1 FROM advertising_conversation_blocks b
             WHERE b.conversation_id = c.id
               AND b.blocker_role = CASE WHEN ? = c.requester_id
                 THEN 'requester' ELSE 'owner' END
           ) OR c.blocked_by = ?) AS viewer_blocked,
           (EXISTS (
             SELECT 1 FROM advertising_conversation_blocks b
             WHERE b.conversation_id = c.id
               AND b.blocker_role = CASE WHEN ? = c.requester_id
                 THEN 'owner' ELSE 'requester' END
           ) OR (c.blocked_by IS NOT NULL AND c.blocked_by <> ?))
             AS other_blocked
    FROM advertising_messages m
    JOIN advertising_conversations c ON c.id = m.conversation_id
    WHERE m.conversation_id = ?
      AND (m.sender_id = ? OR m.visibility_status IN ('visible', 'blocked'))
    ORDER BY m.id DESC
    LIMIT ? OFFSET ?
  `).bind(
    actorId,
    actorId,
    actorId,
    actorId,
    conversationId,
    actorId,
    MESSAGE_PAGE_SIZE + 1,
    page * MESSAGE_PAGE_SIZE
  ).all();
  const rows = messages.results ?? [];
  return {
    messages: rows.slice(0, MESSAGE_PAGE_SIZE).reverse(),
    hasOlder: rows.length > MESSAGE_PAGE_SIZE
  };
}

function timelineMessagesKey(chatId) {
  return `${TIMELINE_MESSAGES_KEY_PREFIX}${String(chatId)}`;
}

async function readTimelineMessageIds(env, chatId) {
  const row = await env.CRASH_BOT_DB.prepare(
    "SELECT value FROM bot_settings WHERE key = ?"
  ).bind(timelineMessagesKey(chatId)).first();
  try {
    const ids = JSON.parse(row?.value ?? "[]");
    return Array.isArray(ids)
      ? ids.filter((id) => Number.isSafeInteger(id) && id > 0)
      : [];
  } catch {
    return [];
  }
}

async function clearTimelineMessages(env, chatId) {
  const key = timelineMessagesKey(chatId);
  const ids = await readTimelineMessageIds(env, chatId);
  const remainingIds = [];
  for (const id of ids) {
    try {
      if (!await deleteTelegramMessage(env, chatId, id)) remainingIds.push(id);
    } catch {
      remainingIds.push(id);
    }
  }
  if (remainingIds.length) {
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO bot_settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).bind(key, JSON.stringify(remainingIds)).run();
  } else {
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM bot_settings WHERE key = ?"
    ).bind(key).run();
  }
}

async function rememberTimelineMessage(env, chatId, result) {
  const messageIds = result?.messageIds ?? [result?.messageId];
  const safeIds = messageIds.filter((messageId) =>
    Number.isSafeInteger(messageId) && messageId > 0
  );
  if (!safeIds.length) return;
  const key = timelineMessagesKey(chatId);
  const ids = await readTimelineMessageIds(env, chatId);
  ids.push(...safeIds);
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO bot_settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).bind(key, JSON.stringify(ids)).run();
}

function messageControls(message, actorId) {
  const {
    blocked_by,
    viewer_blocked,
    other_blocked,
    ...controlMessage
  } = message;
  return conversationMessageControls(controlMessage, actorId, {
    namespace: "ad",
    includeView: true,
    blockedByViewer: Boolean(viewer_blocked),
    blockedByOther: Boolean(other_blocked)
  });
}

async function sendTimelineMessages(env, chatId, messages, actorId) {
  for (const message of messages) {
    const keyboard = messageControls(message, actorId);
    const text = formatMessage(message, actorId, env.OWNER_TELEGRAM_ID)
      .slice(0, 3900);
    const textResult = await sendConversationContent(env, chatId, {
      text,
      inlineKeyboard: keyboard
    });
    await rememberTimelineMessage(env, chatId, textResult);

    if (String(message.sender_id) !== String(actorId) &&
        (message.visibility_status === "blocked" ||
          message.view_delivery_status !== "sent" ||
          message.viewer_blocked || message.other_blocked)) continue;
    if (!message.media_type || !message.media_file_id) continue;
    const caption = ["sticker", "video_note"].includes(message.media_type)
      ? null
      : `${message.sender_role === "owner" ? "پاسخ مالک" : "پیام درخواست‌دهنده"}${message.caption ? `: ${message.caption}` : ""}`;
    const mediaResult = await sendConversationContent(env, chatId, {
      text: ["sticker", "video_note"].includes(message.media_type) ? text : "",
      mediaType: message.media_type,
      mediaFileId: message.media_file_id,
      caption,
      inlineKeyboard: keyboard
    });
    await rememberTimelineMessage(env, chatId, mediaResult);
  }
}

async function renderRequesterConversation(env, chatId, userId, conversationId, page = 0) {
  if (String(chatId) !== String(userId)) return false;
  const row = await env.CRASH_BOT_DB.prepare(`
    SELECT id FROM advertising_conversations
    WHERE id = ? AND requester_id = ? AND status = 'open'
  `).bind(conversationId, userId).first();
  if (!row) return false;

  await clearTimelineMessages(env, chatId);
  await env.CRASH_BOT_DB.prepare(`
    UPDATE advertising_messages
    SET delivery_status = 'unknown',
        delivery_error = 'stale delivery claim; outcome requires review'
    WHERE conversation_id = ? AND delivery_status = 'sending'
      AND created_at < datetime('now', '-15 minutes')
  `).bind(conversationId).run();
  await env.CRASH_BOT_DB.prepare(`
    UPDATE advertising_messages
    SET view_delivery_status = 'unknown'
    WHERE conversation_id = ? AND view_delivery_status = 'sending'
      AND created_at < datetime('now', '-15 minutes')
  `).bind(conversationId).run();
  await saveActorState(env, userId, conversationId, "requester");
  const { messages, hasOlder } = await readConversationMessages(
    env, conversationId, page, userId
  );
  const text = [
    "📢 گفت‌وگوی درخواست تبلیغات",
    "پیامت به مالک ربات ارسال می‌شود؛ پاسخ‌ها را همین‌جا دریافت می‌کنی.",
    messages.length ? "پیام‌های این صفحه:" : "\nهنوز پیامی در این گفت‌وگو نیست."
  ].filter(Boolean).join("\n\n").slice(0, 3900);
  const keyboard = [];
  if (page > 0) keyboard.push([{ text: "پیام‌های جدیدتر", callback_data: `ad:user:${page - 1}` }]);
  if (hasOlder) {
    keyboard.push([{ text: "پیام‌های قدیمی‌تر", callback_data: `ad:user:${page + 1}` }]);
  }
  await sendTrackedSectionInlineTelegram(env, chatId, text, keyboard);
  await sendTimelineMessages(env, chatId, messages, userId);
  if (page === 0) {
    await sendMessageTelegramDetailed(
      env, chatId, "برای خروج از گفت‌وگو از دکمهٔ بازگشت استفاده کن.",
      CHAT_RETURN_KEYBOARD
    );
  }
  return true;
}

async function renderOwnerConversationList(env, ownerId, chatId, page = 0) {
  if (String(ownerId) !== String(env.OWNER_TELEGRAM_ID)) return false;
  if (String(chatId) !== String(ownerId)) return false;
  await clearTimelineMessages(env, chatId);
  await clearActorState(env, ownerId);
  await env.CRASH_BOT_DB.prepare(`
    UPDATE advertising_messages
    SET delivery_status = 'unknown',
        delivery_error = 'stale delivery claim; outcome requires review'
    WHERE delivery_status = 'sending'
      AND created_at < datetime('now', '-15 minutes')
  `).run();
  await env.CRASH_BOT_DB.prepare(`
    UPDATE advertising_messages
    SET view_delivery_status = 'unknown'
    WHERE view_delivery_status = 'sending'
      AND created_at < datetime('now', '-15 minutes')
  `).run();
  const rows = await env.CRASH_BOT_DB.prepare(`
    SELECT c.id, c.requester_id, c.updated_at, u.username, u.first_name,
           u.last_name,
           p.nickname,
           (SELECT message FROM advertising_messages m
            WHERE m.conversation_id = c.id AND m.visibility_status = 'visible'
              AND (m.sender_role = 'owner' OR m.view_delivery_status = 'sent')
            ORDER BY m.id DESC LIMIT 1) AS last_message,
           (SELECT COUNT(*) FROM advertising_messages unread
            WHERE unread.conversation_id = c.id
              AND unread.sender_role = 'requester' AND unread.read_at IS NULL) AS unread_count
    FROM advertising_conversations c
    JOIN users u ON u.telegram_id = c.requester_id
    LEFT JOIN profiles p ON p.user_id = c.requester_id
    WHERE c.status = 'open'
    ORDER BY c.updated_at DESC, c.id DESC
    LIMIT ? OFFSET ?
  `).bind(PAGE_SIZE + 1, page * PAGE_SIZE).all();

  const results = rows.results ?? [];
  const conversations = results.slice(0, PAGE_SIZE);
  const keyboard = conversations.map((row) => [{
    text: `${row.nickname || row.first_name || row.username || row.requester_id} · ${row.unread_count} خوانده‌نشده`,
    callback_data: `ad:open:${row.id}:0`
  }]);
  if (page > 0) keyboard.push([{ text: "صفحهٔ قبل", callback_data: `ad:list:${page - 1}` }]);
  if (results.length > PAGE_SIZE) {
    keyboard.push([{ text: "صفحهٔ بعد", callback_data: `ad:list:${page + 1}` }]);
  }

  const list = conversations.length
    ? conversations.map((row) => {
        const identity = [
          [row.first_name, row.last_name].filter(Boolean).join(" "),
          row.username ? `@${row.username}` : null,
          `ID: ${row.requester_id}`
        ].filter(Boolean).join(" · ");
        const last = String(row.last_message ?? "").replace(/\s+/g, " ").slice(0, 90);
        return `• ${identity}\nآخرین پیام: ${last || "رسانه"}\nزمان: ${row.updated_at}`;
      }).join("\n\n")
    : "درخواستی ثبت نشده است.";
  await sendTrackedSectionInlineTelegram(
    env,
    chatId,
    `📢 درخواست‌های تبلیغات\n\n${list}`,
    keyboard
  );
  return true;
}

async function renderOwnerConversation(env, ownerId, chatId, conversationId, page = 0) {
  if (
    String(ownerId) !== String(env.OWNER_TELEGRAM_ID) ||
    String(chatId) !== String(ownerId)
  ) return false;
  const conversation = await env.CRASH_BOT_DB.prepare(`
    SELECT c.id, c.requester_id, u.username, u.first_name, u.last_name,
           p.nickname, p.bio, p.city, p.birth_year, p.birth_month,
           p.marital_status, p.gender, p.job, p.religion, p.religious_sect,
           p.field
    FROM advertising_conversations c
    JOIN users u ON u.telegram_id = c.requester_id
    LEFT JOIN profiles p ON p.user_id = c.requester_id
    WHERE c.id = ? AND c.status = 'open'
  `).bind(conversationId).first();
  if (!conversation) return false;

  await clearTimelineMessages(env, chatId);
  await env.CRASH_BOT_DB.prepare(`
    UPDATE advertising_messages
    SET delivery_status = 'unknown',
        delivery_error = 'stale delivery claim; outcome requires review'
    WHERE conversation_id = ? AND delivery_status = 'sending'
      AND created_at < datetime('now', '-15 minutes')
  `).bind(conversationId).run();
  await env.CRASH_BOT_DB.prepare(`
    UPDATE advertising_messages
    SET view_delivery_status = 'unknown'
    WHERE conversation_id = ? AND view_delivery_status = 'sending'
      AND created_at < datetime('now', '-15 minutes')
  `).bind(conversationId).run();
  await saveActorState(env, ownerId, conversationId, "owner");
  const { messages, hasOlder } = await readConversationMessages(
    env, conversationId, page, ownerId
  );
  const identity = [
    conversation.first_name,
    conversation.last_name,
    conversation.nickname ? `لقب پروفایل: ${conversation.nickname}` : null,
    conversation.bio ? `دربارهٔ من: ${conversation.bio}` : null,
    conversation.city ? `شهر: ${conversation.city}` : null,
    conversation.birth_year && conversation.birth_month
      ? `سن: ${calculatePersianAge(conversation.birth_year, conversation.birth_month) ?? "نامشخص"}`
      : null,
    conversation.marital_status
      ? `وضعیت تأهل: ${conversation.marital_status === "married" ? "متأهل" : "مجرد"}`
      : null,
    conversation.gender
      ? `جنسیت: ${conversation.gender === "woman" ? "زن" : "مرد"}`
      : null,
    conversation.job ? `شغل: ${conversation.job}` : null,
    conversation.religion ? `مذهب: ${conversation.religion}` : null,
    conversation.religious_sect ? `فرقه/مذهب: ${conversation.religious_sect}` : null,
    conversation.field ? `رشتهٔ تحصیلی: ${conversation.field}` : null,
    conversation.username ? `@${conversation.username}` : "بدون username",
    `Telegram ID: ${conversation.requester_id}`
  ].filter(Boolean).join("\n");
  const text = [
    `📢 مکالمهٔ تبلیغات — ${identity}`,
    messages.length ? "پیام‌های این صفحه:" : "\nهنوز پیامی در این گفت‌وگو نیست."
  ].filter(Boolean).join("\n\n").slice(0, 3900);
  const keyboard = [
    [{ text: "↩️ فهرست درخواست‌ها", callback_data: `ad:list:${Math.floor(page / 2)}` }]
  ];
  if (page > 0) keyboard.push([{ text: "پیام‌های جدیدتر", callback_data: `ad:open:${conversationId}:${page - 1}` }]);
  if (hasOlder) {
    keyboard.push([{ text: "پیام‌های قدیمی‌تر", callback_data: `ad:open:${conversationId}:${page + 1}` }]);
  }
  await sendTrackedSectionInlineTelegram(env, chatId, text, keyboard);
  await sendTimelineMessages(env, chatId, messages, ownerId);
  if (page === 0) {
    await sendMessageTelegramDetailed(
      env, chatId, "برای خروج از گفت‌وگو از دکمهٔ بازگشت استفاده کن.",
      CHAT_RETURN_KEYBOARD
    );
  }
  return true;
}

async function saveAndDeliverMessage(env, {
  conversationId,
  senderId,
  senderRole,
  recipientId,
  message,
  sourceMessageId
}) {
  if (!Number.isSafeInteger(senderId) || senderId <= 0 ||
      !Number.isSafeInteger(recipientId) || recipientId <= 0 ||
      senderId === recipientId ||
      !Number.isSafeInteger(sourceMessageId) || sourceMessageId <= 0) {
    return { handled: false, outcome: "rejected" };
  }
  const content = textFromMessage(message);
  const media = mediaFromMessage(message);
  if (!content && !media) return { handled: false };
  if (content.length > 4000) {
    await sendMessageTelegramDetailed(env, senderId, "پیام بیش از حد طولانی است؛ حداکثر ۴۰۰۰ نویسه بفرست.");
    return { handled: true, outcome: "rejected" };
  }

  const conversation = await env.CRASH_BOT_DB.prepare(`
    SELECT c.blocked_by, c.requester_id, s.reply_to_message_id
    FROM advertising_conversations c
    JOIN advertising_conversation_state s
      ON s.conversation_id = c.id AND s.actor_id = ?
    WHERE c.id = ? AND c.status = 'open'
  `).bind(senderId, conversationId).first();
  if (!conversation) return { handled: false };
  const blockState = await advertisingBlockState(
    env, conversationId, senderId, conversation.requester_id,
    conversation.blocked_by
  );
  if (blockState.blockedByViewer) {
    await sendMessageTelegramDetailed(
      env, senderId, "این گفت‌وگو مسدود شده است؛ پیام ارسال نشد.",
      null, sourceMessageId
    );
    return { handled: true, outcome: "blocked" };
  }
  const heldForReview = blockState.blockedByOther;
  const inserted = await env.CRASH_BOT_DB.prepare(`
    INSERT INTO advertising_messages
      (conversation_id, sender_id, sender_role, message, media_type,
       media_file_id, caption, source_message_id, reply_to_message_id,
       visibility_status, delivery_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending')
    ON CONFLICT(sender_id, source_message_id) WHERE source_message_id IS NOT NULL
    DO NOTHING
    RETURNING id
  `).bind(
    conversationId,
    senderId,
    senderRole,
    content,
    media?.type ?? null,
    media?.fileId ?? null,
    message?.caption ?? null,
    sourceMessageId ?? null,
    conversation.reply_to_message_id ?? null,
    heldForReview ? "blocked" : "visible"
  ).first();

  if (!inserted?.id) {
    await sendMessageTelegramDetailed(
      env,
      senderId,
      "این پیام قبلاً پردازش شده است؛ ارسال دوبارهٔ خودکار انجام نمی‌شود."
    );
    return { handled: true, duplicate: true };
  }

  await env.CRASH_BOT_DB.prepare(`
    UPDATE advertising_conversations SET updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(conversationId).run();
  if (conversation.reply_to_message_id) {
    await env.CRASH_BOT_DB.prepare(`
      UPDATE advertising_conversation_state
      SET reply_to_message_id = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE actor_id = ? AND conversation_id = ? AND reply_to_message_id = ?
    `).bind(senderId, conversationId, conversation.reply_to_message_id).run();
  }

  const notice = heldForReview
    ? "شما از فردی که در حال حاضر بلاک کرده‌اید یک پیام جدید دارید. برای مشاهده پیام، ابتدا بلاک فرستنده را بردارید."
    : senderRole === "requester"
      ? `🔔 شما یک پیام دارید.\n📢 از بخش درخواست تبلیغات یک پیام ناشناس دارید.\nTelegram ID: ${senderId}`
      : "🔔 شما یک پیام دارید.\nاز طرف مالک ربات یک پیام در گفت‌وگوی تبلیغات دارید.";
  const recipientMessage = {
    id: inserted.id,
    sender_id: senderId,
    visibility_status: heldForReview ? "blocked" : "visible"
  };
  const delivery = await deliverClaimedConversationMessage({
    label: "advertising conversation notification",
    deliver: () => sendInlineTelegramDetailed(
      env, recipientId, notice, messageControls(recipientMessage, recipientId)
    ),
    settle: (status) => env.CRASH_BOT_DB.prepare(`
      UPDATE advertising_messages
      SET delivery_status = ?, delivery_error = ?, read_at = NULL
      WHERE id = ?
    `).bind(
      status,
      status === "failed" ? "Telegram rejected the message" : null,
      inserted.id
    ).run()
  });
  const outcome = delivery.result.outcome;
  const storedOutcome = delivery.status;
  await sendMessageTelegramDetailed(
    env,
    senderId,
    outcome === "sent"
      ? "✅ پیام شما ارسال شد."
      : outcome === "unknown"
        ? "⚠️ وضعیت ارسال نامشخص است؛ برای جلوگیری از پیام تکراری، خودکار دوباره ارسال نمی‌کنیم."
        : "❌ اعلان پیام ارسال نشد. وضعیت ثبت پیام را از تاریخچه بررسی کن.",
    null,
    sourceMessageId
  );
  return { handled: true, outcome };
}

async function loadAdvertisingMessage(env, messageId, actorId) {
  const row = await env.CRASH_BOT_DB.prepare(`
    SELECT m.*, c.requester_id, c.blocked_by
    FROM advertising_messages m
    JOIN advertising_conversations c ON c.id = m.conversation_id
    WHERE m.id = ? AND c.status = 'open'
  `).bind(messageId).first();
  if (!row) return null;
  const owner = String(actorId) === String(env.OWNER_TELEGRAM_ID);
  if (!owner && String(row.requester_id) !== String(actorId)) return null;
  const blocks = await advertisingBlockState(
    env, row.conversation_id, actorId, row.requester_id, row.blocked_by
  );
  return {
    ...row,
    actor_role: blocks.actorRole,
    viewer_blocked: blocks.blockedByViewer,
    other_blocked: blocks.blockedByOther
  };
}

async function deliverAdvertisingMessageView(env, query, actorId, message, release) {
  const received = String(message.sender_id) !== String(actorId);
  if (!received) {
    await answerCallbackQuery(env, query.id, "پیام دریافتی معتبر نیست.");
    return true;
  }
  const blocks = await advertisingBlockState(
    env, message.conversation_id, actorId, message.requester_id,
    message.blocked_by
  );
  if (message.visibility_status === "blocked") {
    if (!release || !blocks.blockedByViewer || blocks.blockedByOther) {
      await answerCallbackQuery(env, query.id, "محتوای پیام تا تأیید گیرنده مخفی است.");
      return true;
    }
    await env.CRASH_BOT_DB.batch([
      env.CRASH_BOT_DB.prepare(`
        DELETE FROM advertising_conversation_blocks
        WHERE conversation_id = ? AND blocker_role = ?
          AND blocker_id = ?
      `).bind(message.conversation_id, message.actor_role, actorId),
      env.CRASH_BOT_DB.prepare(`
        UPDATE advertising_conversations
        SET blocked_by = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND blocked_by = ?
      `).bind(message.conversation_id, actorId),
      env.CRASH_BOT_DB.prepare(`
        UPDATE advertising_messages
        SET visibility_status = 'visible'
        WHERE id = ? AND visibility_status = 'blocked'
          AND NOT EXISTS (
            SELECT 1 FROM advertising_conversation_blocks
            WHERE conversation_id = ? AND blocker_role = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM advertising_conversations
            WHERE id = ? AND blocked_by IS NOT NULL
          )
      `).bind(
        message.id, message.conversation_id, blocks.otherRole,
        message.conversation_id
      )
    ]);
    const released = await env.CRASH_BOT_DB.prepare(`
      SELECT visibility_status
      FROM advertising_messages m
      WHERE m.id = ?
    `).bind(message.id).first();
    const currentBlocks = await advertisingBlockState(
      env, message.conversation_id, actorId, message.requester_id
    );
    if (released?.visibility_status !== "visible" ||
        currentBlocks.blockedByViewer || currentBlocks.blockedByOther) {
      await answerCallbackQuery(env, query.id, "این پیام دیگر قابل آزادسازی نیست.");
      return true;
    }
    message.visibility_status = "visible";
    message.blocked_by = null;
    message.viewer_blocked = false;
    message.other_blocked = false;
  } else if (release) {
    await answerCallbackQuery(env, query.id, "این پیام دیگر در صف بررسی بلاک نیست.");
    return true;
  } else if (blocks.blockedByViewer || blocks.blockedByOther) {
    await answerCallbackQuery(env, query.id,
      "این پیام تا رفع محدودیت بلاک در دسترس نیست.");
    return true;
  }

  const claim = await env.CRASH_BOT_DB.prepare(`
    UPDATE advertising_messages SET view_delivery_status = 'sending'
    WHERE id = ? AND visibility_status = 'visible'
      AND view_delivery_status = 'pending'
    RETURNING id
  `).bind(message.id).first();
  if (!claim?.id) {
    const state = await env.CRASH_BOT_DB.prepare(`
      SELECT view_delivery_status FROM advertising_messages WHERE id = ?
    `).bind(message.id).first();
    await answerCallbackQuery(env, query.id,
      state?.view_delivery_status === "sent"
        ? "این پیام قبلاً باز شده است."
        : "وضعیت نمایش پیام نامشخص است؛ ارسال تکراری انجام نمی‌شود.");
    return true;
  }

  const heading = message.sender_role === "owner"
    ? "پاسخ مالک"
    : message.actor_role === "owner"
      ? `درخواست‌دهنده · Telegram ID: ${message.sender_id}`
      : "پیام ناشناس";
  const body = message.caption || message.message || "رسانه";
  const text = `${heading} — ${message.created_at}\n\n${body}`.slice(0, 3900);
  const keyboard = messageControls({
    ...message,
    visibility_status: "visible",
    view_delivery_status: "sent"
  }, actorId);
  const result = await sendConversationContent(env, actorId, {
    text,
    mediaType: message.media_type,
    mediaFileId: message.media_file_id,
    inlineKeyboard: keyboard
  });

  const viewStatus = result.outcome === "sent"
    ? "sent"
    : result.outcome === "rejected" ? "failed" : "unknown";
  await env.CRASH_BOT_DB.prepare(`
    UPDATE advertising_messages
    SET view_delivery_status = ?, read_at = CASE
      WHEN ? = 'sent' THEN CURRENT_TIMESTAMP ELSE read_at END
    WHERE id = ? AND view_delivery_status = 'sending'
  `).bind(viewStatus, viewStatus, message.id).run();
  if (viewStatus === "sent" && message.source_message_id) {
    await sendConversationReadReceipt(
      env,
      message.sender_id,
      message.source_message_id,
      "✅ پیام شما خوانده شد."
    );
  }
  await answerCallbackQuery(env, query.id,
    viewStatus === "sent"
      ? "پیام نمایش داده شد."
      : viewStatus === "unknown"
        ? "وضعیت نمایش نامشخص است؛ ارسال دوباره انجام نمی‌شود."
        : "نمایش پیام ناموفق بود.");
  return true;
}

async function handleAdvertisingChatCallback(env, query, actorId) {
  const action = /^(ad:view|ad:unblock_view|ad:reply|ad:block|ad:unblock):(\d+)$/
    .exec(String(query.data ?? ""));
  if (!action) return false;
  const messageId = Number(action[2]);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    await answerCallbackQuery(env, query.id, "شناسهٔ پیام معتبر نیست.");
    return true;
  }
  const message = await loadAdvertisingMessage(env, messageId, actorId);
  if (!message) {
    await answerCallbackQuery(env, query.id, "این پیام در دسترس نیست.");
    return true;
  }
  if (action[1] === "ad:view" || action[1] === "ad:unblock_view") {
    return deliverAdvertisingMessageView(
      env, query, actorId, message, action[1] === "ad:unblock_view"
    );
  }
  if (action[1] === "ad:reply") {
    if (message.visibility_status !== "visible" ||
        message.viewer_blocked || message.other_blocked) {
      await answerCallbackQuery(env, query.id, "ابتدا پیام را از حالت بلاک خارج کن.");
      return true;
    }
    await saveActorState(env, actorId, message.conversation_id, message.actor_role);
    await env.CRASH_BOT_DB.prepare(`
      UPDATE advertising_conversation_state
      SET reply_to_message_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE actor_id = ? AND conversation_id = ?
    `).bind(message.id, actorId, message.conversation_id).run();
    await sendMessageTelegramDetailed(
      env, actorId,
      "متن، ویس یا رسانهٔ دلخواه خود را برای طرف مقابل ارسال کنید.",
      CHAT_RETURN_KEYBOARD
    );
    await answerCallbackQuery(env, query.id, "پاسخ آماده است.");
    return true;
  }
  if (action[1] === "ad:unblock") {
    if (!message.viewer_blocked) {
      await answerCallbackQuery(env, query.id, "این گفت‌وگو توسط شما بلاک نشده است.");
      return true;
    }
    const removed = await env.CRASH_BOT_DB.prepare(`
      DELETE FROM advertising_conversation_blocks
      WHERE conversation_id = ? AND blocker_role = ? AND blocker_id = ?
      RETURNING conversation_id
    `).bind(message.conversation_id, message.actor_role, actorId).first();
    const legacy = await env.CRASH_BOT_DB.prepare(`
      UPDATE advertising_conversations
      SET blocked_by = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'open' AND blocked_by = ?
      RETURNING id
    `).bind(message.conversation_id, actorId).first();
    if (!removed && !legacy) {
      await answerCallbackQuery(env, query.id, "این گفت‌وگو دیگر بلاک نیست.");
      return true;
    }
    const blocks = await advertisingBlockState(
      env, message.conversation_id, actorId, message.requester_id
    );
    const keyboard = messageControls({
      ...message,
      viewer_blocked: blocks.blockedByViewer,
      other_blocked: blocks.blockedByOther,
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
  if (message.viewer_blocked) {
    await answerCallbackQuery(env, query.id, "این گفت‌وگو قبلاً توسط شما مسدود شده است.");
    return true;
  }
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO advertising_conversation_blocks
      (conversation_id, blocker_role, blocker_id)
    VALUES (?, ?, ?)
    ON CONFLICT(conversation_id, blocker_role) DO NOTHING
  `).bind(message.conversation_id, message.actor_role, actorId).run();
  await env.CRASH_BOT_DB.prepare(`
    UPDATE advertising_conversations
    SET blocked_by = COALESCE(blocked_by, ?), updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'open'
  `).bind(actorId, message.conversation_id).run();
  await env.CRASH_BOT_DB.prepare(`
    UPDATE advertising_conversation_state
    SET reply_to_message_id = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE conversation_id = ?
  `).bind(message.conversation_id).run();
  const keyboard = messageControls({
    ...message,
    viewer_blocked: true,
    visibility_status: "visible",
    view_delivery_status: "sent"
  }, actorId);
  const edited = await editTelegramReplyMarkupDetailed(
    env, query.message.chat.id, query.message.message_id, keyboard
  );
  await answerCallbackQuery(env, query.id, edited.outcome === "sent"
    ? "این گفت‌وگوی تبلیغات مسدود شد."
    : "گفت‌وگو مسدود شد، اما دکمه به‌روزرسانی نشد؛ صفحه را دوباره باز کن.");
  return true;
}

export async function openAdvertisingConversation(env, userId, chatId) {
  if (String(userId) === String(env.OWNER_TELEGRAM_ID)) {
    return renderOwnerConversationList(env, userId, chatId, 0);
  }
  const conversationId = await ensureConversation(env, userId);
  return renderRequesterConversation(env, chatId, userId, conversationId);
}

export async function handleAdvertisingCallback(env, callback) {
  const data = String(callback?.data ?? "");
  const ownerId = callback?.from?.id;
  const chatId = callback?.message?.chat?.id;
  if (
    !Number.isSafeInteger(ownerId) ||
    ownerId <= 0 ||
    !chatId ||
    String(chatId) !== String(ownerId) ||
    callback?.message?.chat?.type !== "private" ||
    !Number.isSafeInteger(callback?.message?.message_id) ||
    callback.message.message_id <= 0
  ) return false;

  let matched = false;
  const list = /^ad:list:(\d+)$/.exec(data);
  const open = /^ad:open:(\d+):(\d+)$/.exec(data);
  const userPage = /^ad:user:(\d+)$/.exec(data);
  if (await handleAdvertisingChatCallback(env, callback, ownerId)) return true;
  if (list) {
    matched = true;
    const page = Number(list[1]);
    if (String(ownerId) !== String(env.OWNER_TELEGRAM_ID) || !validPage(page)) {
      await answerCallbackQuery(env, callback.id, "این گزینه فقط برای مالک در دسترس است.");
      return true;
    }
    await renderOwnerConversationList(env, ownerId, chatId, page);
  } else if (open) {
    matched = true;
    const conversationId = Number(open[1]);
    const page = Number(open[2]);
    if (
      String(ownerId) !== String(env.OWNER_TELEGRAM_ID) ||
      !Number.isSafeInteger(conversationId) ||
      !validPage(page)
    ) {
      await answerCallbackQuery(env, callback.id, "این گزینه فقط برای مالک در دسترس است.");
      return true;
    }
    await upsertTelegramUser(env, callback.from);
    const ok = await renderOwnerConversation(env, ownerId, chatId, conversationId, page);
    if (!ok) await answerCallbackQuery(env, callback.id, "این مکالمه در دسترس نیست.");
  } else if (userPage) {
    matched = true;
    const page = Number(userPage[1]);
    const conversation = await env.CRASH_BOT_DB.prepare(`
      SELECT conversation_id FROM advertising_conversation_state
      WHERE actor_id = ? AND actor_role = 'requester'
    `).bind(ownerId).first();
    if (!validPage(page) || !conversation || String(chatId) !== String(ownerId)) {
      await answerCallbackQuery(env, callback.id, "این مکالمه در دسترس نیست.");
      return true;
    }
    await renderRequesterConversation(env, chatId, ownerId, conversation.conversation_id, page);
  }

  if (matched) {
    await answerCallbackQuery(env, callback.id);
  }
  return matched;
}

export async function handleAdvertisingMessage(env, message, userId, isNavigation = false) {
  if (!isPrivateConversationMessage(message, userId)) return false;
  const state = await env.CRASH_BOT_DB.prepare(`
    SELECT s.conversation_id, s.actor_role, c.requester_id, c.status
    FROM advertising_conversation_state s
    JOIN advertising_conversations c ON c.id = s.conversation_id
    WHERE s.actor_id = ?
  `).bind(userId).first();
  if (!state) return false;

  const text = textFromMessage(message);
  if (isBotCommand(message) &&
      !NAVIGATION_TEXTS.has(String(message.text ?? "").trim())) return false;
  if (isNavigation || NAVIGATION_TEXTS.has(text)) {
    await clearActorState(env, userId);
    return false;
  }
  if (
    state.status !== "open" ||
    (state.actor_role === "owner" &&
      String(userId) !== String(env.OWNER_TELEGRAM_ID)) ||
    (state.actor_role === "requester" &&
      String(state.requester_id) !== String(userId))
  ) {
    await clearActorState(env, userId);
    return false;
  }

  const isOwner = state.actor_role === "owner" &&
    String(userId) === String(env.OWNER_TELEGRAM_ID);
  const recipientId = Number(isOwner ? state.requester_id : env.OWNER_TELEGRAM_ID);
  if (!Number.isSafeInteger(recipientId) || recipientId <= 0 ||
      recipientId === userId) return false;
  const result = await saveAndDeliverMessage(env, {
    conversationId: state.conversation_id,
    senderId: userId,
    senderRole: isOwner ? "owner" : "requester",
    recipientId,
    message,
    sourceMessageId: message.message_id
  });
  return result.handled;
}
