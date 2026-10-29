import {
  answerCallbackQuery,
  sendMediaTelegramDetailed,
  sendMessageTelegramDetailed,
  sendTrackedSectionInlineTelegram
} from "../telegram/api.js";
import { calculatePersianAge } from "./profile.js";

const PAGE_SIZE = 8;
const MESSAGE_PAGE_SIZE = 8;
const NAVIGATION_TEXTS = new Set([
  "/start", "/menu", "🏠 منوی اصلی", "⬅️ بازگشت",
  "🛠 پنل مدیریت", "👤 پنل کاربر", "👤 پروفایل من", "💌 ثبت پست کراش",
  "🎭 چت ناشناس تصادفی", "🤝 درخواست‌های ارتباط از کانال",
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

function textFromMessage(message) {
  return String(message?.text ?? message?.caption ?? "").trim();
}

function mediaFromMessage(message) {
  const photo = Array.isArray(message?.photo) ? message.photo.at(-1) : null;
  if (photo?.file_id) return { type: "photo", fileId: photo.file_id };
  for (const type of Object.keys(MEDIA_METHODS).filter((item) => item !== "photo")) {
    if (message?.[type]?.file_id) {
      return { type, fileId: message[type].file_id };
    }
  }
  return null;
}

function validPage(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 10000;
}

function formatMessage(message) {
  const sender = message.sender_role === "owner" ? "پاسخ مالک" : "درخواست‌دهنده";
  const content = message.caption || message.message || "";
  const media = message.media_type ? `\n[رسانه: ${message.media_type}]` : "";
  const delivery = message.delivery_status === "unknown"
    ? "\nوضعیت ارسال: نامشخص؛ ارسال دوباره انجام نشده است."
    : message.delivery_status === "failed"
      ? "\nوضعیت ارسال: ناموفق"
      : "";
  return `${sender} — ${message.created_at}\n${content}${media}${delivery}`;
}

async function sendMedia(env, recipientId, media, caption) {
  const method = MEDIA_METHODS[media.type];
  if (!method) return { outcome: "rejected" };
  return sendMediaTelegramDetailed(env, method, {
    chat_id: recipientId,
    [media.type]: media.fileId,
    ...(caption && !["sticker", "video_note"].includes(media.type)
      ? { caption: caption.slice(0, 1024) }
      : {})
  });
}

async function saveActorState(env, actorId, conversationId, actorRole) {
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO advertising_conversation_state
      (actor_id, conversation_id, actor_role, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(actor_id) DO UPDATE SET
      conversation_id = excluded.conversation_id,
      actor_role = excluded.actor_role,
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

async function readConversationMessages(env, conversationId, page) {
  const messages = await env.CRASH_BOT_DB.prepare(`
    SELECT id, sender_id, sender_role, message, media_type, media_file_id,
           caption, delivery_status, created_at
    FROM advertising_messages
    WHERE conversation_id = ?
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).bind(
    conversationId,
    MESSAGE_PAGE_SIZE,
    page * MESSAGE_PAGE_SIZE
  ).all();
  return (messages.results ?? []).reverse();
}

async function sendTimelineMedia(env, chatId, messages) {
  for (const message of messages) {
    if (!message.media_type || !message.media_file_id) continue;
    const caption = ["sticker", "video_note"].includes(message.media_type)
      ? null
      : `${message.sender_role === "owner" ? "پاسخ مالک" : "پیام درخواست‌دهنده"}${message.caption ? `: ${message.caption}` : ""}`;
    await sendMedia(env, chatId, {
      type: message.media_type,
      fileId: message.media_file_id
    }, caption);
  }
}

async function renderRequesterConversation(env, chatId, userId, conversationId, page = 0) {
  if (String(chatId) !== String(userId)) return false;
  const row = await env.CRASH_BOT_DB.prepare(`
    SELECT id FROM advertising_conversations
    WHERE id = ? AND requester_id = ? AND status = 'open'
  `).bind(conversationId, userId).first();
  if (!row) return false;

  await env.CRASH_BOT_DB.prepare(`
    UPDATE advertising_messages
    SET delivery_status = 'unknown',
        delivery_error = 'stale delivery claim; outcome requires review'
    WHERE conversation_id = ? AND delivery_status = 'sending'
      AND created_at < datetime('now', '-15 minutes')
  `).bind(conversationId).run();
  await saveActorState(env, userId, conversationId, "requester");
  await env.CRASH_BOT_DB.prepare(`
    UPDATE advertising_messages SET read_at = CURRENT_TIMESTAMP
    WHERE conversation_id = ? AND sender_role = 'owner' AND read_at IS NULL
  `).bind(conversationId).run();
  const messages = await readConversationMessages(env, conversationId, page);
  const text = [
    "📢 گفت‌وگوی درخواست تبلیغات",
    "پیامت به مالک ربات ارسال می‌شود؛ پاسخ‌ها را همین‌جا دریافت می‌کنی.",
    messages.length ? "" : "\nهنوز پیامی در این گفت‌وگو نیست.",
    ...messages.map(formatMessage)
  ].filter(Boolean).join("\n\n").slice(0, 3900);
  const keyboard = [];
  if (page > 0) keyboard.push([{ text: "پیام‌های جدیدتر", callback_data: `ad:user:${page - 1}` }]);
  if (messages.length === MESSAGE_PAGE_SIZE) {
    keyboard.push([{ text: "پیام‌های قدیمی‌تر", callback_data: `ad:user:${page + 1}` }]);
  }
  await sendTrackedSectionInlineTelegram(env, chatId, text, keyboard);
  await sendTimelineMedia(env, chatId, messages);
  return true;
}

async function renderOwnerConversationList(env, ownerId, chatId, page = 0) {
  if (String(ownerId) !== String(env.OWNER_TELEGRAM_ID)) return false;
  if (String(chatId) !== String(ownerId)) return false;
  await clearActorState(env, ownerId);
  await env.CRASH_BOT_DB.prepare(`
    UPDATE advertising_messages
    SET delivery_status = 'unknown',
        delivery_error = 'stale delivery claim; outcome requires review'
    WHERE delivery_status = 'sending'
      AND created_at < datetime('now', '-15 minutes')
  `).run();
  const rows = await env.CRASH_BOT_DB.prepare(`
    SELECT c.id, c.requester_id, c.updated_at, u.username, u.first_name,
           p.nickname,
           (SELECT message FROM advertising_messages m
            WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message,
           (SELECT COUNT(*) FROM advertising_messages unread
            WHERE unread.conversation_id = c.id
              AND unread.sender_role = 'requester' AND unread.read_at IS NULL) AS unread_count
    FROM advertising_conversations c
    JOIN users u ON u.telegram_id = c.requester_id
    LEFT JOIN profiles p ON p.user_id = c.requester_id
    WHERE c.status = 'open'
    ORDER BY c.updated_at DESC, c.id DESC
    LIMIT ? OFFSET ?
  `).bind(PAGE_SIZE, page * PAGE_SIZE).all();

  const conversations = rows.results ?? [];
  const keyboard = conversations.map((row) => [{
    text: `${row.nickname || row.first_name || row.username || row.requester_id} · ${row.unread_count} خوانده‌نشده`,
    callback_data: `ad:open:${row.id}:0`
  }]);
  if (page > 0) keyboard.push([{ text: "صفحهٔ قبل", callback_data: `ad:list:${page - 1}` }]);
  if (conversations.length === PAGE_SIZE) {
    keyboard.push([{ text: "صفحهٔ بعد", callback_data: `ad:list:${page + 1}` }]);
  }

  const list = conversations.length
    ? conversations.map((row) => {
        const identity = [
          row.first_name,
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
    SELECT c.id, c.requester_id, u.username, u.first_name,
           p.nickname, p.bio, p.city, p.birth_year, p.birth_month,
           p.marital_status, p.gender, p.job, p.religion, p.religious_sect,
           p.field
    FROM advertising_conversations c
    JOIN users u ON u.telegram_id = c.requester_id
    LEFT JOIN profiles p ON p.user_id = c.requester_id
    WHERE c.id = ? AND c.status = 'open'
  `).bind(conversationId).first();
  if (!conversation) return false;

  await env.CRASH_BOT_DB.prepare(`
    UPDATE advertising_messages
    SET delivery_status = 'unknown',
        delivery_error = 'stale delivery claim; outcome requires review'
    WHERE conversation_id = ? AND delivery_status = 'sending'
      AND created_at < datetime('now', '-15 minutes')
  `).bind(conversationId).run();
  await saveActorState(env, ownerId, conversationId, "owner");
  await env.CRASH_BOT_DB.prepare(`
    UPDATE advertising_messages SET read_at = CURRENT_TIMESTAMP
    WHERE conversation_id = ? AND sender_role = 'requester' AND read_at IS NULL
  `).bind(conversationId).run();
  const messages = await readConversationMessages(env, conversationId, page);
  const identity = [
    conversation.first_name,
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
    messages.length ? "" : "\nهنوز پیامی در این گفت‌وگو نیست.",
    ...messages.map(formatMessage)
  ].filter(Boolean).join("\n\n").slice(0, 3900);
  const keyboard = [
    [{ text: "↩️ فهرست درخواست‌ها", callback_data: `ad:list:${Math.floor(page / 2)}` }]
  ];
  if (page > 0) keyboard.push([{ text: "پیام‌های جدیدتر", callback_data: `ad:open:${conversationId}:${page - 1}` }]);
  if (messages.length === MESSAGE_PAGE_SIZE) {
    keyboard.push([{ text: "پیام‌های قدیمی‌تر", callback_data: `ad:open:${conversationId}:${page + 1}` }]);
  }
  await sendTrackedSectionInlineTelegram(env, chatId, text, keyboard);
  await sendTimelineMedia(env, chatId, messages);
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
  const content = textFromMessage(message);
  const media = mediaFromMessage(message);
  if (!content && !media) return { handled: false };
  if (content.length > 4000) {
    await sendMessageTelegramDetailed(env, senderId, "پیام بیش از حد طولانی است؛ حداکثر ۴۰۰۰ نویسه بفرست.");
    return { handled: true, outcome: "rejected" };
  }

  const inserted = await env.CRASH_BOT_DB.prepare(`
    INSERT INTO advertising_messages
      (conversation_id, sender_id, sender_role, message, media_type,
       media_file_id, caption, source_message_id, delivery_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sending')
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
    sourceMessageId ?? null
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

  let outcome;
  if (media) {
    const prefix = senderRole === "requester"
      ? `درخواست تبلیغات\nTelegram ID: ${senderId}`
      : null;
    const fullCaption = [prefix, content].filter(Boolean).join("\n\n");
    const noCaption = ["sticker", "video_note"].includes(media.type);
    let deliveredAnything = false;
    if (["sticker", "video_note"].includes(media.type)) {
      if (prefix) {
        const header = await sendMessageTelegramDetailed(env, recipientId, prefix);
        if (header.outcome === "sent") deliveredAnything = true;
        else outcome = header.outcome;
      }
    }
    if (!outcome) {
      const caption = noCaption ? null : fullCaption.slice(0, 1024);
      const result = await sendMedia(env, recipientId, media, caption);
      if (result.outcome === "sent") deliveredAnything = true;
      else outcome = deliveredAnything ? "unknown" : result.outcome;
    }
    const remainingContent = noCaption
      ? (senderRole === "owner" ? content : "")
      : fullCaption.slice(1024);
    if (!outcome && remainingContent) {
      const remaining = await sendMessageTelegramDetailed(
        env,
        recipientId,
        remainingContent
      );
      if (remaining.outcome !== "sent") {
        outcome = deliveredAnything ? "unknown" : remaining.outcome;
      }
    }
    if (!outcome) outcome = deliveredAnything ? "sent" : "unknown";
  } else {
    const prefix = senderRole === "requester"
      ? `📢 درخواست تبلیغات\nTelegram ID: ${senderId}\n\n`
      : "";
    outcome = (await sendMessageTelegramDetailed(
      env, recipientId, `${prefix}${content}`
    )).outcome;
  }

  const storedOutcome = outcome === "sent"
    ? "sent"
    : outcome === "rejected"
      ? "failed"
      : "unknown";
  await env.CRASH_BOT_DB.prepare(`
    UPDATE advertising_messages
    SET delivery_status = ?, delivery_error = ?, read_at = NULL
    WHERE id = ?
  `).bind(
    storedOutcome,
    outcome === "rejected" ? "Telegram rejected the message" : null,
    inserted.id
  ).run();
  await sendMessageTelegramDetailed(
    env,
    senderId,
    outcome === "sent"
      ? "✅ پیام ارسال شد."
      : outcome === "unknown"
        ? "⚠️ وضعیت ارسال نامشخص است؛ برای جلوگیری از پیام تکراری، خودکار دوباره ارسال نمی‌کنیم."
        : "❌ ارسال پیام انجام نشد. می‌توانی پس از بررسی دوباره پیام بدهی."
  );
  return { handled: true, outcome };
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
    !ownerId ||
    !chatId ||
    String(chatId) !== String(ownerId) ||
    callback?.message?.chat?.type !== "private"
  ) return false;

  let matched = false;
  const list = /^ad:list:(\d+)$/.exec(data);
  const open = /^ad:open:(\d+):(\d+)$/.exec(data);
  const userPage = /^ad:user:(\d+)$/.exec(data);
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
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO users (telegram_id, username, first_name)
      VALUES (?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name
    `).bind(
      ownerId,
      callback.from.username ?? null,
      callback.from.first_name ?? null
    ).run();
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
  if (
    message?.chat?.type !== "private" ||
    String(message?.chat?.id) !== String(userId)
  ) return false;
  const state = await env.CRASH_BOT_DB.prepare(`
    SELECT s.conversation_id, s.actor_role, c.requester_id, c.status
    FROM advertising_conversation_state s
    JOIN advertising_conversations c ON c.id = s.conversation_id
    WHERE s.actor_id = ?
  `).bind(userId).first();
  if (!state) return false;

  const text = textFromMessage(message);
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
  const recipientId = isOwner ? state.requester_id : env.OWNER_TELEGRAM_ID;
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
