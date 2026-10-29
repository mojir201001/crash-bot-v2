import {
  answerCallbackQuery,
  sendInlineTelegram,
  sendInlineTelegramDetailed,
  sendMediaTelegramDetailed,
  sendMessageTelegramDetailed,
  sendTelegram
} from "../telegram/api.js";
import { getProfile, isProfileComplete } from "./profile.js";

const SEARCH_LIMIT = 5;
const MESSAGE_LIMIT = 10;
const SEARCH_WINDOW_MINUTES = 10;
const MESSAGE_WINDOW_MINUTES = 1;
const WAITING_SESSION_MINUTES = 30;
const navigationTexts = new Set([
  "/start", "/menu", "🏠 منوی اصلی", "⬅️ بازگشت",
  "👤 پنل کاربر", "🛠 پنل مدیریت",
  "🎭 ارتباط ناشناس", "🎭 چت ناشناس تصادفی",
  "👤 پروفایل من", "💌 ثبت پست کراش", "🤝 درخواست‌های ارتباط از کانال",
  "📚 ثبت کراش‌های من", "📢 ثبت درخواست تبلیغات", "📖 راهنما و قوانین"
]);
const mediaTypes = [
  "photo", "video", "document", "audio", "voice",
  "animation", "video_note", "sticker"
];

function mediaFromMessage(message) {
  for (const type of mediaTypes) {
    const value = message?.[type];
    const item = Array.isArray(value) ? value.at(-1) : value;
    if (item?.file_id) return { type, fileId: item.file_id };
  }
  return null;
}

async function expireWaitingSessions(env) {
  await env.CRASH_BOT_DB.batch([
    env.CRASH_BOT_DB.prepare(`
      UPDATE anonymous_sessions
      SET status = 'cancelled', ended_at = CURRENT_TIMESTAMP,
        ended_reason = 'waiting_timeout', updated_at = CURRENT_TIMESTAMP
      WHERE status = 'waiting'
        AND created_at <= datetime('now', '-${WAITING_SESSION_MINUTES} minutes')
    `).bind(),
    env.CRASH_BOT_DB.prepare(`
      DELETE FROM anonymous_chat_members
      WHERE session_id IN (
        SELECT id FROM anonymous_sessions WHERE status = 'cancelled'
          AND ended_reason = 'waiting_timeout'
      )
    `).bind()
  ]);
}

async function currentSession(env, userId) {
  return env.CRASH_BOT_DB.prepare(`
    SELECT s.id, s.user_a_id, s.user_b_id, s.requested_gender,
      s.status, s.notice_a_status, s.notice_b_status, s.created_at
    FROM anonymous_chat_members m
    JOIN anonymous_sessions s ON s.id = m.session_id
    WHERE m.user_id = ? AND s.status IN ('waiting', 'active')
    LIMIT 1
  `).bind(userId).first();
}

function statusKeyboard(session) {
  return [[{
    text: session.status === "waiting" ? "❌ لغو جست‌وجو" : "⛔ پایان چت",
    callback_data: session.status === "waiting"
      ? `random:cancel:${session.id}`
      : `random:end:${session.id}`
  }]];
}

async function sendSessionNotice(env, session, participantRole) {
  const userId = participantRole === "a" ? session.user_a_id : session.user_b_id;
  const statusColumn = participantRole === "a" ? "notice_a_status" : "notice_b_status";
  const claimed = await env.CRASH_BOT_DB.prepare(`
    UPDATE anonymous_sessions
    SET ${statusColumn} = 'sending', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'active' AND ${statusColumn} = 'pending'
    RETURNING id
  `).bind(session.id).first();
  if (!claimed) return;
  const result = await sendInlineTelegramDetailed(
    env,
    userId,
    "✅ چت ناشناس فعال شد. پیام‌ها از طریق ربات منتقل می‌شوند و هویت تلگرام شما پنهان می‌ماند.",
    statusKeyboard(session)
  );
  await env.CRASH_BOT_DB.prepare(`
    UPDATE anonymous_sessions SET ${statusColumn} = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND ${statusColumn} = 'sending'
  `).bind(result.outcome === "rejected" ? "failed" : result.outcome,
    session.id).run();
}

async function showSessionStatus(env, chatId, session) {
  if (session.status === "waiting") {
    await sendInlineTelegram(
      env,
      chatId,
      "🔎 در صف جست‌وجوی ناشناس هستی. اگر تا ۳۰ دقیقه جفتی پیدا نشود، صف منقضی می‌شود.",
      statusKeyboard(session)
    );
    return;
  }
  await sendInlineTelegram(
    env,
    chatId,
    "✅ گفت‌وگوی ناشناس فعال است. برای پایان از دکمهٔ زیر استفاده کن.",
    statusKeyboard(session)
  );
}

export async function renderRandomChatHome(env, userId, chatId) {
  await expireWaitingSessions(env);
  const session = await currentSession(env, userId);
  if (session) {
    await showSessionStatus(env, chatId, session);
    return;
  }
  await sendTelegram(env, chatId,
    "🎭 چت ناشناس تصادفی\n\nاین گفت‌وگو از ارتباط‌های پذیرفته‌شده جداست. برای شروع، ترجیح جنسیتی فرد مقابل را انتخاب کن.",
    [[{ text: "🔍 پیدا کردن فرد" }], [{ text: "🏠 منوی اصلی" }]]);
}

export async function renderRandomChatPreferences(env, userId, chatId) {
  await expireWaitingSessions(env);
  if (await currentSession(env, userId)) {
    await renderRandomChatHome(env, userId, chatId);
    return;
  }
  await sendTelegram(env, chatId,
    "جنسیت فردی را که می‌خواهی با او گفت‌وگو کنی انتخاب کن. تطبیق فقط در صورت سازگاری دوطرفه انجام می‌شود.",
    [[{ text: "👧 دختر" }, { text: "👦 پسر" }], [{ text: "↩️ بازگشت به ارتباط ناشناس" }]]);
}

async function recordSearch(env, message, userId, requestedGender) {
  const sourceMessageId = message?.message_id;
  if (!Number.isSafeInteger(sourceMessageId) || sourceMessageId <= 0) {
    throw new Error("Random chat search requires a valid Telegram message id");
  }
  const profile = await getProfile(env, userId);
  if (!isProfileComplete(profile) || !["man", "woman"].includes(profile.gender)) {
    return { status: "profile_incomplete" };
  }
  const user = await env.CRASH_BOT_DB.prepare(`
    SELECT is_blocked, account_status FROM users WHERE telegram_id = ?
  `).bind(userId).first();
  if (!user || user.is_blocked === 1 ||
      (user.account_status && user.account_status !== "active")) {
    return { status: "account_unavailable" };
  }
  const workflow = await env.CRASH_BOT_DB.prepare(`
    SELECT flow_type FROM user_conversations WHERE user_id = ?
  `).bind(userId).first();
  if (workflow && ["post", "reply", "connection_chat"].includes(workflow.flow_type)) {
    return { status: "other_chat_active" };
  }
  await expireWaitingSessions(env);

  const existing = await currentSession(env, userId);
  if (existing) return { status: existing.status, session: existing };

  try {
    const results = await env.CRASH_BOT_DB.batch([
      env.CRASH_BOT_DB.prepare(`
        INSERT OR IGNORE INTO anonymous_chat_actions
          (user_id, source_message_id, action_type)
        VALUES (?, ?, 'search')
      `).bind(userId, sourceMessageId),
      env.CRASH_BOT_DB.prepare(`
        INSERT INTO random_chat_rate_limits
          (user_id, action_type, window_started_at, action_count)
        SELECT ?, 'search', CURRENT_TIMESTAMP, 1 WHERE changes() = 1
        ON CONFLICT(user_id, action_type) DO UPDATE SET
          action_count = CASE
            WHEN window_started_at <= datetime('now', '-${SEARCH_WINDOW_MINUTES} minutes')
              THEN 1
            ELSE action_count + 1
          END,
          window_started_at = CASE
            WHEN window_started_at <= datetime('now', '-${SEARCH_WINDOW_MINUTES} minutes')
              THEN CURRENT_TIMESTAMP
            ELSE window_started_at
          END
      `).bind(userId),
      env.CRASH_BOT_DB.prepare(`
        UPDATE anonymous_sessions
        SET user_b_id = ?, status = 'active', matched_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = (
          SELECT s.id
          FROM anonymous_sessions s
          JOIN profiles candidate ON candidate.user_id = s.user_a_id
          JOIN anonymous_chat_members member
            ON member.session_id = s.id AND member.user_id = s.user_a_id
          WHERE s.status = 'waiting'
            AND s.requested_gender = ?
            AND candidate.gender = ?
            AND s.user_a_id <> ?
            AND s.created_at > datetime('now', '-${WAITING_SESSION_MINUTES} minutes')
            AND NOT EXISTS (
              SELECT 1 FROM user_blocks b
              WHERE b.lifted_at IS NULL AND (
                (b.blocker_id = s.user_a_id AND b.blocked_id = ?)
                OR (b.blocker_id = ? AND b.blocked_id = s.user_a_id)
              )
            )
            AND (SELECT action_count FROM random_chat_rate_limits
              WHERE user_id = ? AND action_type = 'search') <= ${SEARCH_LIMIT}
            AND NOT EXISTS (
              SELECT 1 FROM anonymous_chat_members
              WHERE user_id = ?
            )
          ORDER BY s.created_at, s.id
          LIMIT 1
        ) AND status = 'waiting'
        RETURNING id
      `).bind(userId, profile.gender, requestedGender, userId,
        userId, userId, userId, userId),
      env.CRASH_BOT_DB.prepare(`
        INSERT INTO anonymous_chat_members (user_id, session_id, role)
        SELECT ?, id, 'b' FROM anonymous_sessions
        WHERE status = 'active' AND user_b_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM anonymous_chat_members WHERE user_id = ?
          )
      `).bind(userId, userId, userId),
      env.CRASH_BOT_DB.prepare(`
        INSERT INTO anonymous_sessions (user_a_id, requested_gender, status)
        SELECT ?, ?, 'waiting'
        WHERE NOT EXISTS (
          SELECT 1 FROM anonymous_chat_members WHERE user_id = ?
        )
          AND (SELECT action_count FROM random_chat_rate_limits
            WHERE user_id = ? AND action_type = 'search') <= ${SEARCH_LIMIT}
        RETURNING id
      `).bind(userId, requestedGender, userId, userId),
      env.CRASH_BOT_DB.prepare(`
        INSERT INTO anonymous_chat_members (user_id, session_id, role)
        SELECT ?, last_insert_rowid(), 'a' WHERE changes() = 1
      `).bind(userId)
    ]);
    if (Number(results[2]?.meta?.changes ?? 0) === 0 &&
        Number(results[4]?.meta?.changes ?? 0) === 0) {
      const rate = await env.CRASH_BOT_DB.prepare(`
        SELECT action_count FROM random_chat_rate_limits
        WHERE user_id = ? AND action_type = 'search'
      `).bind(userId).first();
      if (Number(rate?.action_count ?? 0) > SEARCH_LIMIT) {
        return { status: "rate_limited" };
      }
    }
    const current = await currentSession(env, userId);
    if (Number(results[2]?.meta?.changes ?? 0) > 0 && current?.status === "active") {
      return { status: "matched", session: current };
    }
    if (Number(results[4]?.meta?.changes ?? 0) > 0 && current?.status === "waiting") {
      return { status: "waiting", session: current };
    }
    const action = await env.CRASH_BOT_DB.prepare(`
      SELECT action_type FROM anonymous_chat_actions
      WHERE user_id = ? AND source_message_id = ?
    `).bind(userId, sourceMessageId).first();
    return { status: action ? "duplicate" : "unavailable" };
  } catch (error) {
    if (!String(error?.message ?? "").includes("UNIQUE constraint failed")) throw error;
    const session = await currentSession(env, userId);
    if (session) return { status: session.status, session };
    throw error;
  }
}

export async function joinRandomChat(env, message, userId, requestedGender) {
  if (!["man", "woman"].includes(requestedGender)) {
    await sendTelegram(env, message.chat.id, "ترجیح انتخاب‌شده معتبر نیست.");
    return true;
  }
  const result = await recordSearch(env, message, userId, requestedGender);
  if (result.status === "duplicate") return true;
  if (result.status === "profile_incomplete") {
    await sendTelegram(env, message.chat.id, "برای جست‌وجو ابتدا پروفایل کامل خود را ثبت کن.");
    return true;
  }
  if (result.status === "account_unavailable") {
    await sendTelegram(env, message.chat.id, "حساب در حال حاضر برای این عملیات فعال نیست.");
    return true;
  }
  if (result.status === "other_chat_active") {
    await sendTelegram(env, message.chat.id,
      "ابتدا از گفت‌وگوی فعال دیگر خارج شو، سپس جست‌وجوی ناشناس را شروع کن.");
    return true;
  }
  if (result.status === "rate_limited") {
    await sendTelegram(env, message.chat.id, "تعداد جست‌وجوها زیاد است؛ ۱۰ دقیقه بعد دوباره تلاش کن.");
    return true;
  }
  if (result.status === "matched") {
    await sendSessionNotice(env, result.session, "a");
    await sendSessionNotice(env, result.session, "b");
    return true;
  }
  if (result.status === "waiting") {
    await showSessionStatus(env, message.chat.id, result.session);
    return true;
  }
  if (result.session) {
    await showSessionStatus(env, message.chat.id, result.session);
    return true;
  }
  await sendTelegram(env, message.chat.id, "درخواست جست‌وجو انجام نشد؛ دوباره تلاش کن.");
  return true;
}

async function deliverRandomMessage(env, row, message) {
  const media = mediaFromMessage(message);
  if (!media) {
    return sendMessageTelegramDetailed(env, row.recipient_id, row.message);
  }
  const methods = {
    photo: "sendPhoto",
    video: "sendVideo",
    document: "sendDocument",
    audio: "sendAudio",
    voice: "sendVoice",
    animation: "sendAnimation",
    video_note: "sendVideoNote",
    sticker: "sendSticker"
  };
  const field = media.type === "photo" ? "photo" : media.type;
  return sendMediaTelegramDetailed(env, methods[media.type], {
    chat_id: row.recipient_id,
    [field]: media.fileId,
    ...(!["sticker", "video_note"].includes(media.type) && message.caption
      ? { caption: message.caption }
      : {})
  });
}

async function relayRandomMessage(env, message, userId, session) {
  if (!Number.isSafeInteger(message?.message_id) || message.message_id <= 0) {
    await sendTelegram(env, message.chat.id, "شناسهٔ پیام معتبر نیست و پیام ثبت نشد.");
    return true;
  }
  const content = String(message.text ?? message.caption ?? "").trim();
  const media = mediaFromMessage(message);
  if (!content && !media) {
    await sendTelegram(env, message.chat.id, "پیام متنی یا رسانهٔ پشتیبانی‌شده بفرست.");
    return true;
  }
  const rate = await env.CRASH_BOT_DB.batch([
    env.CRASH_BOT_DB.prepare(`
      INSERT INTO random_chat_rate_limits
        (user_id, action_type, window_started_at, action_count)
      SELECT ?, 'message', CURRENT_TIMESTAMP, 1
      WHERE NOT EXISTS (
        SELECT 1 FROM anonymous_messages
        WHERE sender_id = ? AND source_message_id = ? AND message_type = 'random_chat'
      )
      ON CONFLICT(user_id, action_type) DO UPDATE SET
        action_count = CASE
          WHEN window_started_at <= datetime('now', '-${MESSAGE_WINDOW_MINUTES} minutes')
            THEN 1
          ELSE action_count + 1
        END,
        window_started_at = CASE
          WHEN window_started_at <= datetime('now', '-${MESSAGE_WINDOW_MINUTES} minutes')
            THEN CURRENT_TIMESTAMP
          ELSE window_started_at
        END
      RETURNING action_count
    `).bind(userId, userId, message.message_id),
    env.CRASH_BOT_DB.prepare(`
      INSERT INTO anonymous_messages (
        sender_id, recipient_id, message, message_type, session_id,
        media_type, media_file_id, caption, source_message_id, delivery_status
      )
      SELECT ?, ?, ?, 'random_chat', ?, ?, ?, ?, ?, 'sending'
      WHERE EXISTS (
        SELECT 1 FROM anonymous_sessions s
        JOIN anonymous_chat_members m ON m.session_id = s.id
        WHERE s.id = ? AND s.status = 'active' AND m.user_id = ?
          AND (s.user_a_id = ? OR s.user_b_id = ?)
      )
        AND (SELECT action_count FROM random_chat_rate_limits
          WHERE user_id = ? AND action_type = 'message') <= ${MESSAGE_LIMIT}
      ON CONFLICT(sender_id, source_message_id)
        WHERE message_type = 'random_chat' AND source_message_id IS NOT NULL
      DO NOTHING
      RETURNING id, recipient_id, message
    `).bind(userId, session.user_a_id === userId ? session.user_b_id : session.user_a_id,
      content, session.id, media?.type ?? null, media?.fileId ?? null,
      message.caption ?? null, message.message_id, session.id, userId,
      userId, userId, userId)
  ]);
  const actionCount = Number(rate[0]?.results?.[0]?.action_count ?? 0);
  const inserted = rate[1]?.results?.[0];
  if (!inserted) {
    const duplicate = await env.CRASH_BOT_DB.prepare(`
      SELECT id, delivery_status FROM anonymous_messages
      WHERE sender_id = ? AND source_message_id = ? AND message_type = 'random_chat'
    `).bind(userId, message.message_id).first();
    if (duplicate) {
      if (duplicate.delivery_status === "sending") {
        await sendTelegram(env, message.chat.id,
          "وضعیت تحویل پیام قبلی نامشخص است؛ برای جلوگیری از تکرار، دوباره ارسال نشده.");
      }
      return true;
    }
    await sendTelegram(env, message.chat.id, actionCount > MESSAGE_LIMIT
      ? "تعداد پیام‌ها زیاد است؛ یک دقیقه بعد دوباره تلاش کن."
      : "گفت‌وگو دیگر فعال نیست و پیام ارسال نشد.");
    return true;
  }

  const delivery = await deliverRandomMessage(env, inserted, message);
  const deliveryStatus = delivery.outcome === "rejected" ? "failed" : delivery.outcome;
  await env.CRASH_BOT_DB.prepare(`
    UPDATE anonymous_messages SET delivery_status = ?, delivery_error = ?
    WHERE id = ? AND delivery_status = 'sending'
  `).bind(deliveryStatus, delivery.outcome === "sent"
    ? null
    : delivery.outcome === "unknown"
      ? "Telegram delivery outcome is unknown"
      : "Telegram rejected the message", inserted.id).run();
  await sendTelegram(env, message.chat.id,
    deliveryStatus === "sent"
      ? "پیام به گفت‌وگوی ناشناس ارسال شد."
      : deliveryStatus === "unknown"
        ? "نتیجهٔ تحویل نامشخص است؛ پیام را دوباره نفرست."
        : "پیام به طرف گفت‌وگو تحویل نشد.");
  return true;
}

export async function handleRandomChatMessage(env, message, userId, destination, text) {
  const randomDestinations = [
    "anonymous", "anonymous_gender", "anonymous_queue_girl", "anonymous_queue_boy"
  ];
  const isRandomRoute = randomDestinations.includes(destination);
  if (isRandomRoute) {
    const [existingFlow, profileWorkflow] = await Promise.all([
      env.CRASH_BOT_DB.prepare(`
        SELECT flow_type FROM user_conversations WHERE user_id = ?
      `).bind(userId).first(),
      env.CRASH_BOT_DB.prepare(`
        SELECT flow_type FROM user_workflows WHERE user_id = ?
      `).bind(userId).first()
    ]);
    if ((existingFlow &&
        ["post", "reply", "connection_chat"].includes(existingFlow.flow_type)) ||
        profileWorkflow) {
      await sendTelegram(env, message.chat.id,
        "ابتدا فرم یا گفت‌وگوی فعال فعلی را تمام کن و سپس چت ناشناس را شروع کن.");
      return true;
    }
  }
  if (destination === "anonymous") {
    await renderRandomChatHome(env, userId, message.chat.id);
    return true;
  }
  if (destination === "anonymous_gender") {
    await renderRandomChatPreferences(env, userId, message.chat.id);
    return true;
  }
  if (destination === "anonymous_queue_girl") {
    return joinRandomChat(env, message, userId, "woman");
  }
  if (destination === "anonymous_queue_boy") {
    return joinRandomChat(env, message, userId, "man");
  }
  if (destination && !isRandomRoute) {
    const session = await currentSession(env, userId);
    if (session) {
      await sendInlineTelegram(env, message.chat.id,
        "برای جلوگیری از تداخل گفت‌وگوها، ابتدا چت ناشناس را پایان بده یا جست‌وجو را لغو کن.",
        statusKeyboard(session));
      return true;
    }
  }
  if (navigationTexts.has(text)) return false;

  let session = await currentSession(env, userId);
  if (!session) return false;
  if (session.status === "waiting" &&
      new Date(`${session.created_at.replace(" ", "T")}Z`).getTime() <=
        Date.now() - WAITING_SESSION_MINUTES * 60000) {
    await expireWaitingSessions(env);
    session = await currentSession(env, userId);
    if (!session) return false;
  }
  const [existingFlow, profileWorkflow] = await Promise.all([
    env.CRASH_BOT_DB.prepare(`
      SELECT flow_type FROM user_conversations WHERE user_id = ?
    `).bind(userId).first(),
    env.CRASH_BOT_DB.prepare(`
      SELECT flow_type FROM user_workflows WHERE user_id = ?
    `).bind(userId).first()
  ]);
  if (existingFlow || profileWorkflow) return false;
  if (session.status === "waiting") {
    await sendInlineTelegram(env, message.chat.id,
      "هنوز در صف جست‌وجو هستی؛ پس از پیدا شدن جفت می‌توانی پیام بفرستی.",
      statusKeyboard(session));
    return true;
  }
  return relayRandomMessage(env, message, userId, session);
}

export async function handleRandomChatCallback(env, query) {
  const match = /^random:(cancel|end):(\d+)$/.exec(query?.data ?? "");
  if (!match) return false;
  const [, action, rawId] = match;
  const actorId = query.from?.id;
  const chatId = query.message?.chat?.id;
  const sessionId = Number(rawId);
  if (query.message?.chat?.type !== "private" ||
      !actorId || String(actorId) !== String(chatId) ||
      !Number.isSafeInteger(sessionId) || sessionId <= 0) {
    await answerCallbackQuery(env, query.id, "این عملیات فقط در گفت‌وگوی خصوصی خودت معتبر است.");
    return true;
  }

  const expectedStatus = action === "cancel" ? "waiting" : "active";
  const results = await env.CRASH_BOT_DB.batch([
    env.CRASH_BOT_DB.prepare(`
      UPDATE anonymous_sessions
      SET status = ?, ended_at = CURRENT_TIMESTAMP, ended_by = ?,
        ended_reason = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = ?
        AND (user_a_id = ? OR user_b_id = ?)
      RETURNING id, user_a_id, user_b_id
    `).bind(action === "cancel" ? "cancelled" : "ended", actorId,
      action === "cancel" ? "user_cancelled_search" : "user_ended_chat",
      sessionId, expectedStatus, actorId, actorId),
    env.CRASH_BOT_DB.prepare(`
      DELETE FROM anonymous_chat_members
      WHERE session_id = ? AND changes() = 1
    `).bind(sessionId)
  ]);
  const updated = results[0]?.results?.[0];
  if (!updated) {
    await answerCallbackQuery(env, query.id,
      "این دکمه مربوط به جست‌وجو یا گفت‌وگوی فعالی نیست.");
    return true;
  }
  await env.CRASH_BOT_DB.prepare(
    "DELETE FROM anonymous_chat_members WHERE session_id = ?"
  ).bind(sessionId).run();
  await answerCallbackQuery(env, query.id,
    action === "cancel" ? "جست‌وجو لغو شد." : "گفت‌وگو پایان یافت.");
  const peerId = String(updated.user_a_id) === String(actorId)
    ? updated.user_b_id
    : updated.user_a_id;
  await sendTelegram(env, chatId,
    action === "cancel" ? "جست‌وجو لغو شد." : "گفت‌وگوی ناشناس پایان یافت.",
    [[{ text: "🎭 ارتباط ناشناس" }], [{ text: "🏠 منوی اصلی" }]]);
  if (action === "end" && peerId) {
    await sendTelegram(env, peerId, "طرف گفت‌وگو چت ناشناس را پایان داد.",
      [[{ text: "🎭 ارتباط ناشناس" }], [{ text: "🏠 منوی اصلی" }]]);
  }
  return true;
}
