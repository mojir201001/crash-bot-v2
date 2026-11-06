import {
  answerCallbackQuery,
  sendInlineTelegram,
  sendInlineTelegramDetailed,
  sendMessageTelegramDetailed,
  sendTelegram
} from "../telegram/api.js";
import { getProfile, isProfileComplete } from "./profile.js";
import {
  conversationMediaFromMessage,
  isBotCommand,
  isPrivateConversationMessage
} from "./conversation-engine.js";
import {
  appendAndNotify,
  clearConversationReplyContext,
  clearConversationSelection,
  CHAT_RETURN_BUTTON,
  CHAT_RETURN_KEYBOARD,
  getConversationSelection,
  selectConversation
} from "./anonymous-chat.js";

const SEARCH_LIMIT = 5;
const MESSAGE_LIMIT = 10;
const SEARCH_WINDOW_MINUTES = 10;
const MESSAGE_WINDOW_MINUTES = 1;
const WAITING_SESSION_MINUTES = 30;
const navigationTexts = new Set([
  "/start", "/menu", "🏠 منوی اصلی", "⬅️ بازگشت",
  CHAT_RETURN_BUTTON,
  "👤 پنل کاربر", "🛠 پنل مدیریت",
  "🎭 ارتباط ناشناس", "🎭 چت ناشناس تصادفی",
  "🔗 لینک ناشناس من",
  "🔗 لینک اختصاصی چت", "🔎 ارتباط با آیدی", "🔔 اعلان‌ها",
  "👤 پروفایل من", "💌 ثبت پست کراش", "🤝 درخواست‌های ارتباط از کانال",
  "📚 ثبت کراش‌های من", "📢 ثبت درخواست تبلیغات", "📖 راهنما و قوانین"
]);
function mediaFromMessage(message) {
  return conversationMediaFromMessage(message);
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
  await sendMessageTelegramDetailed(
    env, userId, "برای خروج از گفت‌وگو از دکمهٔ بازگشت استفاده کن.",
    CHAT_RETURN_KEYBOARD
  );
}

async function showSessionStatus(env, chatId, session) {
  if (session.status === "waiting") {
    await sendInlineTelegram(
      env,
      chatId,
      "🔎 در صف جست‌وجوی ناشناس هستی. اگر تا ۳۰ دقیقه جفتی پیدا نشود، صف منقضی می‌شود.",
      statusKeyboard(session)
    );
    await sendMessageTelegramDetailed(
      env, chatId, "برای خروج از صف از دکمهٔ بازگشت استفاده کن.",
      CHAT_RETURN_KEYBOARD
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
    await selectConversation(env, userId, "random_chat", session.id);
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
  if (existing) {
    await selectConversation(env, userId, "random_chat", existing.id);
    return { status: existing.status, session: existing };
  }

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
      await Promise.all([
        selectConversation(env, current.user_a_id, "random_chat", current.id),
        selectConversation(env, current.user_b_id, "random_chat", current.id)
      ]);
      return { status: "matched", session: current };
    }
    if (Number(results[4]?.meta?.changes ?? 0) > 0 && current?.status === "waiting") {
      await selectConversation(env, userId, "random_chat", current.id);
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

async function relayRandomMessage(env, message, userId, session) {
  if (!Number.isSafeInteger(session?.id) || !Number.isSafeInteger(userId) ||
      userId <= 0 ||
      (String(session.user_a_id) !== String(userId) &&
        String(session.user_b_id) !== String(userId))) {
    return false;
  }
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
  const rate = await env.CRASH_BOT_DB.prepare(`
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
  `).bind(userId, userId, message.message_id).first();
  const actionCount = Number(rate?.action_count ?? 0);
  if (actionCount > MESSAGE_LIMIT) {
    await sendTelegram(env, message.chat.id, "تعداد پیام‌ها زیاد است؛ یک دقیقه بعد دوباره تلاش کن.");
    return true;
  }

  const recipientId = String(session.user_a_id) === String(userId)
    ? session.user_b_id : session.user_a_id;
  const result = await appendAndNotify(env, {
    senderId: userId,
    recipientId,
    sourceType: "random_chat",
    sessionId: session.id,
    message,
    sourceMessageId: message.message_id
  });
  if (result.status === "inactive") {
    await sendTelegram(env, message.chat.id, "گفت‌وگو دیگر فعال نیست و پیام ارسال نشد.");
  } else if (result.status === "invalid") {
    await sendTelegram(env, message.chat.id, "پیام متنی یا رسانهٔ پشتیبانی‌شده بفرست.");
  }
  return true;
}

export async function handleRandomChatMessage(env, message, userId, destination, text) {
  if (!isPrivateConversationMessage(message, userId)) return false;
  if (isBotCommand(message) && !navigationTexts.has(String(text ?? "").trim())) {
    return false;
  }
  const randomDestinations = [
    "anonymous", "anonymous_random", "anonymous_gender",
    "anonymous_queue_girl", "anonymous_queue_boy"
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
  if (destination === "anonymous_random") {
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
      if (session.status === "waiting") {
        await finishRandomSession(env, userId, session.id, "cancel");
        return false;
      }
      await sendInlineTelegram(env, message.chat.id,
        "برای جلوگیری از تداخل گفت‌وگوها، ابتدا چت ناشناس را پایان بده یا جست‌وجو را لغو کن.",
        statusKeyboard(session));
      return true;
    }
  }
  if (navigationTexts.has(text)) {
    if (text === CHAT_RETURN_BUTTON) {
      const active = await currentSession(env, userId);
      if (active) {
        const action = active.status === "waiting" ? "cancel" : "end";
        const ended = await finishRandomSession(env, userId, active.id, action);
        if (ended?.peerId) {
          await sendTelegram(env, ended.peerId,
            "طرف گفت‌وگو چت ناشناس را پایان داد.",
            [[{ text: "🎭 ارتباط ناشناس" }], [{ text: "🏠 منوی اصلی" }]]);
        }
      }
    }
    return false;
  }

  let session = await currentSession(env, userId);
  if (!session) return false;
  const selection = await getConversationSelection(env, userId);
  if (selection && (
    selection.conversation_type !== "random_chat" ||
    Number(selection.conversation_id) !== Number(session.id)
  )) return false;
  if (!selection) {
    await selectConversation(env, userId, "random_chat", session.id);
  }
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

async function finishRandomSession(env, actorId, sessionId, action) {
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
  if (!updated) return null;
  await env.CRASH_BOT_DB.prepare(
    "DELETE FROM anonymous_chat_members WHERE session_id = ?"
  ).bind(sessionId).run();
  const reference = { type: "random_chat", id: sessionId };
  await Promise.all([updated.user_a_id, updated.user_b_id]
    .filter(Boolean)
    .flatMap((participantId) => [
      clearConversationSelection(env, participantId, reference),
      clearConversationReplyContext(env, participantId, reference)
    ]));
  return {
    peerId: !updated.user_b_id
      ? null
      : String(updated.user_a_id) === String(actorId)
        ? updated.user_b_id
        : updated.user_a_id
  };
}

export async function handleRandomChatCallback(env, query) {
  const match = /^random:(cancel|end):(\d+)$/.exec(query?.data ?? "");
  if (!match) return false;
  const [, action, rawId] = match;
  const actorId = query.from?.id;
  const chatId = query.message?.chat?.id;
  const sessionId = Number(rawId);
  if (query.message?.chat?.type !== "private" ||
      !Number.isSafeInteger(actorId) || actorId <= 0 ||
      String(actorId) !== String(chatId) ||
      !Number.isSafeInteger(query.message?.message_id) ||
      query.message.message_id <= 0 ||
      !Number.isSafeInteger(sessionId) || sessionId <= 0) {
    await answerCallbackQuery(env, query.id, "این عملیات فقط در گفت‌وگوی خصوصی خودت معتبر است.");
    return true;
  }

  const ended = await finishRandomSession(env, actorId, sessionId, action);
  if (!ended) {
    await answerCallbackQuery(env, query.id,
      "این دکمه مربوط به جست‌وجو یا گفت‌وگوی فعالی نیست.");
    return true;
  }
  await answerCallbackQuery(env, query.id,
    action === "cancel" ? "جست‌وجو لغو شد." : "گفت‌وگو پایان یافت.");
  await sendTelegram(env, chatId,
    action === "cancel" ? "جست‌وجو لغو شد." : "گفت‌وگوی ناشناس پایان یافت.",
    [[{ text: "🎭 ارتباط ناشناس" }], [{ text: "🏠 منوی اصلی" }]]);
  if (action === "end" && ended.peerId) {
    await sendTelegram(env, ended.peerId, "طرف گفت‌وگو چت ناشناس را پایان داد.",
      [[{ text: "🎭 ارتباط ناشناس" }], [{ text: "🏠 منوی اصلی" }]]);
  }
  return true;
}
