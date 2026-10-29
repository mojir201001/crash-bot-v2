import {
  answerCallbackQuery,
  sendInlineTelegram,
  sendInlineTelegramDetailed,
  sendMediaTelegramDetailed,
  sendMediaTelegram,
  sendTelegram
} from "../telegram/api.js";
import { calculatePersianAge } from "./profile.js";
import {
  clearPostConversation,
  createDeepLinkToken,
  escapeHtml,
  resolveDeepLinkToken,
  setPostConversation
} from "./posts.js";
import { enqueueNotification, sendPendingNotification } from "./notification-outbox.js";

function mediaFromMessage(message) {
  const types = [
    "photo", "video", "document", "audio", "voice",
    "animation", "video_note", "sticker"
  ];
  for (const type of types) {
    const found = message?.[type];
    const media = Array.isArray(found) ? found[found.length - 1] : found;
    if (media?.file_id) return { type, fileId: media.file_id };
  }
  return { type: null, fileId: null };
}

async function publicBotUsername(env) {
  const saved = await env.CRASH_BOT_DB.prepare(
    "SELECT value FROM bot_settings WHERE key = 'telegram_bot_username'"
  ).first();
  const username = String(saved?.value ?? env.TELEGRAM_BOT_USERNAME ?? "").replace(/^@/, "");
  return /^[A-Za-z0-9_]{5,32}$/.test(username) ? username : null;
}

async function sendConnectionRequestNotification(env, requestId, recipientId) {
  const request = await env.CRASH_BOT_DB.prepare(`
    SELECT p.nickname, p.bio, p.city, p.job, p.field, c.requester_id
    FROM connection_requests c JOIN profiles p ON p.user_id = c.requester_id
    WHERE c.id = ? AND c.recipient_id = ? AND c.status = 'pending'
  `).bind(requestId, recipientId).first();
  if (!request) return false;
  const age = await env.CRASH_BOT_DB.prepare(
    "SELECT birth_year, birth_month FROM profiles WHERE user_id = ?"
  ).bind(request.requester_id).first();
  const ageLabel = age?.birth_year && age?.birth_month
    ? `\nسن: ${calculatePersianAge(age.birth_year, age.birth_month)}`
    : "";
  const snapshot = [
    `درخواست ارتباط از «${escapeHtml(request.nickname)}»`,
    request.bio ? `\nدربارهٔ من: ${escapeHtml(request.bio)}` : "",
    request.city ? `\nشهر: ${escapeHtml(request.city)}` : "",
    request.job ? `\nشغل: ${escapeHtml(request.job)}` : "",
    request.field ? `\nرشته: ${escapeHtml(request.field)}` : "",
    ageLabel,
    "\n\nدرخواست را قبول می‌کنی؟"
  ].join("");
  const notification = await enqueueNotification(env, {
    recipientId,
    operation: "connection_request",
    entityId: requestId,
    eventKey: `connection-request:${requestId}`,
    messageSnapshot: snapshot
  });
  return await sendPendingNotification(env, notification,
    (claimed) => deliverConnectionOutboxNotification(env, claimed)) === "sent";
}

export async function deliverConnectionOutboxNotification(env, outbox) {
  if (!outbox) return false;
  const { operation_type: operation, entity_id: entityId, recipient_id: recipientId } = outbox;
  if (operation === "connection_request") {
    const request = await env.CRASH_BOT_DB.prepare(`
      SELECT p.nickname, p.bio, p.city, p.job, p.field,
        c.requester_id, c.recipient_id, c.post_id, c.status
      FROM connection_requests c
      JOIN profiles p ON p.user_id = c.requester_id
      WHERE c.id = ? AND c.recipient_id = ?
    `).bind(entityId, recipientId).first();
    if (!request) return false;
    const token = await createDeepLinkToken(env, "connection", entityId, recipientId);
    const profileText = outbox.message_snapshot ??
      `درخواست ارتباط «${escapeHtml(request.nickname)}» اکنون ${request.status === "accepted" ? "پذیرفته شده" : "بسته شده"} است.`;
    const username = await publicBotUsername(env);
    const keyboard = request.status === "pending" ? [
      [
        { text: "✅ قبول", callback_data: `connection:decision:${entityId}:accepted` },
        { text: "❌ رد", callback_data: `connection:decision:${entityId}:rejected` }
      ],
      [username
        ? { text: "بازکردن درخواست", url: `https://t.me/${username}?start=${token}` }
        : { text: "بازکردن درخواست", callback_data: `connection:open:${entityId}` }]
    ] : [[
      { text: "مشاهدهٔ وضعیت", callback_data: `connection:open:${entityId}` }
    ]];
    const result = await sendInlineTelegramDetailed(
      env, recipientId, profileText, keyboard, "HTML"
    );
    return result.outcome;
  }

  if (operation === "connection_decision") {
    const request = await env.CRASH_BOT_DB.prepare(`
      SELECT requester_id, status FROM connection_requests WHERE id = ?
    `).bind(entityId).first();
    if (!request || String(request.requester_id) !== String(recipientId)) return false;
    const username = await publicBotUsername(env);
    const token = await createDeepLinkToken(env, "connection", entityId, recipientId);
    const urlButton = username
      ? { text: "مشاهدهٔ وضعیت", url: `https://t.me/${username}?start=${token}` }
      : { text: "مشاهدهٔ وضعیت", callback_data: `connection:open:${entityId}` };
    const message = request.status === "accepted"
      ? "درخواست ارتباط پذیرفته شد. گفت‌وگوی رباتی فعال است."
      : request.status === "rejected"
        ? "درخواست ارتباط شما رد شد."
        : "وضعیت درخواست ارتباط تغییر کرده است.";
    return (await sendInlineTelegramDetailed(
      env, recipientId, outbox.message_snapshot ?? message, [[urlButton]]
    )).outcome;
  }

  if (operation === "connection_message") {
    const message = await env.CRASH_BOT_DB.prepare(`
      SELECT m.sender_id, m.recipient_id, m.message, m.media_type,
        m.media_file_id, m.caption, m.connection_id, c.status AS connection_status
      FROM anonymous_messages m
      JOIN connection_requests c ON c.id = m.connection_id
      WHERE m.id = ? AND m.message_type = 'connection'
    `).bind(entityId).first();
    if (!message || String(message.recipient_id) !== String(recipientId)) return false;
    const username = await publicBotUsername(env);
    if (!username) throw new Error("TELEGRAM_BOT_USERNAME is not configured");
    const token = await createDeepLinkToken(env, "connection", message.connection_id, recipientId);
    const keyboard = { inline_keyboard: [[{
      text: "بازکردن گفت‌وگو",
      url: `https://t.me/${username}?start=${token}`
    }]] };
    if (message.connection_status !== "accepted") {
      return (await sendInlineTelegramDetailed(
        env,
        recipientId,
        outbox.message_snapshot ??
          "یک پیام ثبت‌شده در گفت‌وگو در دسترس است؛ این ارتباط اکنون فعال نیست.",
        keyboard.inline_keyboard
      )).outcome;
    }
    if (message.media_file_id) {
      const methods = {
        photo: "sendPhoto", video: "sendVideo", document: "sendDocument",
        audio: "sendAudio", voice: "sendVoice", animation: "sendAnimation",
        video_note: "sendVideoNote", sticker: "sendSticker"
      };
      const method = methods[message.media_type];
      if (!method) return false;
      const field = message.media_type === "photo" ? "photo" : message.media_type;
      const result = await sendMediaTelegramDetailed(env, method, {
        chat_id: recipientId,
        [field]: message.media_file_id,
        ...(!["sticker", "video_note"].includes(message.media_type) && message.caption
          ? { caption: message.caption } : {}),
        reply_markup: keyboard
      });
      return result.outcome;
    }
    return (await sendInlineTelegramDetailed(env, recipientId,
      outbox.message_snapshot ?? `پیام جدید در گفت‌وگوی فعال دریافت شد.\n\n${message.message ?? ""}`,
      keyboard.inline_keyboard)).outcome;
  }

  return false;
}

export async function handleStartToken(env, userId, chatId, token) {
  const link = await resolveDeepLinkToken(env, token, userId);
  if (!link) {
    await sendTelegram(env, chatId, "این لینک نامعتبر یا منقضی شده است.");
    return true;
  }
  if (link.type === "submit") {
    await setPostConversation(env, userId, "post");
    await sendTelegram(env, chatId, "پیام ناشناس یا رسانه‌ای را بفرست تا برای بررسی ثبت شود.");
    return true;
  }
  if (link.type === "reply") {
    const post = await env.CRASH_BOT_DB.prepare(`
      SELECT id, user_id FROM posts
      WHERE id = ? AND status = 'published' AND channel_message_id IS NOT NULL
    `).bind(link.entityId).first();
    if (!post) {
      await sendTelegram(env, chatId, "پیام اصلی دیگر برای پاسخ‌دادن در دسترس نیست.");
      return true;
    }
    await setPostConversation(env, userId, "reply", post.id);
    await sendTelegram(env, chatId, "پاسخ متنی یا رسانه‌ای خود را بفرست؛ پیام به مورد اصلی وصل خواهد شد.");
    return true;
  }
  if (link.type === "profile") {
    const post = await env.CRASH_BOT_DB.prepare(
      "SELECT user_id FROM posts WHERE id = ?"
    ).bind(link.entityId).first();
    const profile = post && await env.CRASH_BOT_DB.prepare(`
      SELECT nickname, bio, city, birth_year, birth_month, job, field,
        image_file_id
      FROM profiles WHERE user_id = ?
    `).bind(post.user_id).first();
    if (!profile) {
      await sendTelegram(env, chatId, "پروفایل عمومی در دسترس نیست.");
      return true;
    }
    const age = profile.birth_year && profile.birth_month
      ? calculatePersianAge(profile.birth_year, profile.birth_month)
      : null;
    const body = [
      `👤 ${escapeHtml(profile.nickname ?? "کاربر")}`,
      profile.bio ? `\nدربارهٔ من: ${escapeHtml(profile.bio)}` : "",
      profile.city ? `\nشهر: ${escapeHtml(profile.city)}` : "",
      age !== null ? `\nسن: ${age}` : "",
      profile.job ? `\nشغل: ${escapeHtml(profile.job)}` : "",
      profile.field ? `\nرشته: ${escapeHtml(profile.field)}` : ""
    ].join("");
    await setPostConversation(env, userId, "profile_view", post.user_id);
    if (profile.image_file_id) {
      try {
        if (body.length <= 1024) {
          await sendMediaTelegram(env, "sendPhoto", {
            chat_id: chatId,
            photo: profile.image_file_id,
            caption: body,
            parse_mode: "HTML"
          });
        } else {
          await sendMediaTelegram(env, "sendPhoto", {
            chat_id: chatId,
            photo: profile.image_file_id
          });
          await sendMediaTelegram(env, "sendMessage", {
            chat_id: chatId,
            text: body,
            parse_mode: "HTML"
          });
        }
      } catch (error) {
        console.error("Could not send public profile picture:", error);
        await sendMediaTelegram(env, "sendMessage", {
          chat_id: chatId,
          text: body,
          parse_mode: "HTML"
        });
      }
    } else {
      await sendMediaTelegram(env, "sendMessage", {
        chat_id: chatId,
        text: body,
        parse_mode: "HTML"
      });
    }
    await sendInlineTelegram(env, chatId, "نمایش پروفایل فعال است.", [[
      { text: "خروج از پروفایل", callback_data: "profile:exit" }
    ]]);
    return true;
  }
  if (link.type === "connect") {
    const post = await env.CRASH_BOT_DB.prepare(`
      SELECT p.id, p.user_id, pr.nickname, pr.bio, pr.city
      FROM posts p JOIN profiles pr ON pr.user_id = p.user_id
      WHERE p.id = ? AND p.status = 'published' AND p.channel_message_id IS NOT NULL
    `).bind(link.entityId).first();
    if (!post || String(post.user_id) === String(userId)) {
      await sendTelegram(env, chatId, "درخواست ارتباط برای این مورد امکان‌پذیر نیست.");
      return true;
    }
    await setPostConversation(env, userId, "connection_confirm", post.id);
    await sendInlineTelegram(env, chatId,
      `درخواست ارتباط با «${escapeHtml(post.nickname)}» دربارهٔ پست #${post.id}\n\nمطمئنی می‌خواهی درخواست ارتباط ارسال شود؟`,
      [[
        { text: "✅ بله، ارسال درخواست", callback_data: `connection:confirm:${post.id}` },
        { text: "لغو", callback_data: "connection:cancel" }
      ]]);
    return true;
  }
  if (link.type === "connection") {
    const request = await env.CRASH_BOT_DB.prepare(`
      SELECT id, status, requester_id, recipient_id
      FROM connection_requests WHERE id = ?
        AND (requester_id = ? OR recipient_id = ?)
    `).bind(link.entityId, userId, userId).first();
    if (!request) {
      await sendTelegram(env, chatId, "این ارتباط دیگر فعال نیست.");
      return true;
    }
    if (request.status === "pending" && String(request.recipient_id) === String(userId)) {
      await sendConnectionRequestNotification(env, request.id, userId);
      return true;
    }
    if (request.status !== "accepted") {
      await sendTelegram(env, chatId, `وضعیت درخواست ارتباط: ${request.status === "rejected" ? "ردشده" : "در انتظار پاسخ"}.`);
      return true;
    }
    await setPostConversation(env, userId, "connection_chat", request.id);
    await sendTelegram(env, chatId, "گفت‌وگو باز شد. پیام متنی یا رسانه‌ای خود را بفرست.");
    return true;
  }
  if (link.type === "post_history") {
    const post = await env.CRASH_BOT_DB.prepare(`
      SELECT id, status, content, caption, created_at, reviewed_at, admin_note
      FROM posts WHERE id = ? AND user_id = ?
    `).bind(link.entityId, userId).first();
    if (!post) {
      await sendTelegram(env, chatId, "این سابقه در دسترس نیست.");
      return true;
    }
    await sendTelegram(env, chatId,
      `سابقهٔ #${post.id}\nوضعیت: ${post.status}\nدریافت: ${post.created_at}\nاقدام: ${post.reviewed_at ?? "—"}${post.admin_note ? `\nتوضیح مدیر: ${post.admin_note}` : ""}\n\n${post.caption ?? post.content}`);
    return true;
  }
  return false;
}

export async function handleConnectionMessage(env, message, userId) {
  const flow = await env.CRASH_BOT_DB.prepare(`
    SELECT flow_type, entity_id FROM user_conversations WHERE user_id = ?
  `).bind(userId).first();
  if (!flow) return false;
  const navigation = [
    "/start", "/menu", "🏠 منوی اصلی", "⬅️ بازگشت", "🛠 پنل مدیریت",
    "👤 پنل کاربر", "💌 ثبت پست کراش", "✍️ شروع ثبت پست",
    "🤝 درخواست‌های ارتباط از کانال", "📚 ثبت کراش‌های من"
  ];
  if (navigation.includes(message.text?.trim())) {
    await clearPostConversation(env, userId);
    return false;
  }
  if (flow.flow_type === "profile_view") return false;
  if (flow.flow_type === "connection_confirm") {
    await sendTelegram(env, message.chat.id, "برای ثبت درخواست از دکمه‌های تأیید یا لغو استفاده کن.");
    return true;
  }
  if (flow.flow_type !== "connection_chat") return false;
  const request = await env.CRASH_BOT_DB.prepare(`
    SELECT requester_id, recipient_id FROM connection_requests
    WHERE id = ? AND status = 'accepted'
      AND (requester_id = ? OR recipient_id = ?)
  `).bind(flow.entity_id, userId, userId).first();
  if (!request) {
    await clearPostConversation(env, userId);
    await sendTelegram(env, message.chat.id, "این ارتباط فعال نیست و امکان ارسال پیام ندارد.");
    return true;
  }
  const peerId = String(request.requester_id) === String(userId)
    ? request.recipient_id : request.requester_id;
  const media = mediaFromMessage(message);
  const body = message.text ?? message.caption ?? "";
  if (!String(body).trim() && !media?.fileId) {
    await sendTelegram(env, message.chat.id, "پیام متنی یا رسانهٔ پشتیبانی‌شده بفرست.");
    return true;
  }
  if (!Number.isSafeInteger(message.message_id) || message.message_id <= 0) {
    await sendTelegram(env, message.chat.id, "شناسهٔ پیام معتبر نیست؛ لطفاً دوباره تلاش کن.");
    return true;
  }
  const inserted = await env.CRASH_BOT_DB.prepare(`
    INSERT INTO anonymous_messages (
      sender_id, recipient_id, message, message_type, connection_id,
      media_type, media_file_id, caption, source_message_id
    ) VALUES (?, ?, ?, 'connection', ?, ?, ?, ?, ?)
    ON CONFLICT(sender_id, source_message_id)
      WHERE message_type = 'connection' AND source_message_id IS NOT NULL
    DO NOTHING
    RETURNING id
  `).bind(userId, peerId, body, flow.entity_id, media.type, media.fileId,
    message.caption ?? null, message.message_id).first();
  if (!inserted?.id) {
    await sendTelegram(env, message.chat.id, "این پیام قبلاً در گفت‌وگو ثبت شده است.");
    return true;
  }
  const notification = await enqueueNotification(env, {
    recipientId: peerId,
    operation: "connection_message",
    entityId: inserted.id,
    eventKey: `connection-message:${inserted.id}`,
    messageSnapshot: `پیام جدید در گفت‌وگوی فعال دریافت شد.\n\n${body}`
  });
  const deliveryStatus = await sendPendingNotification(env, notification,
    (claimed) => deliverConnectionOutboxNotification(env, claimed));
  await sendTelegram(env, message.chat.id,
    deliveryStatus === "sent"
      ? "پیام به گفت‌وگوی فعال ارسال شد."
      : deliveryStatus === "unknown"
        ? "نتیجهٔ تحویل نامشخص است؛ از ارسال دوبارهٔ همان پیام خودداری کن."
        : "پیام ثبت شد، اما اعلان آن ارسال نشد.");
  return true;
}

export async function handleConnectionCallback(env, query) {
  const data = query.data ?? "";
  const actorId = query.from?.id;
  if (!actorId || String(query.message?.chat?.id) !== String(actorId)) {
    await answerCallbackQuery(env, query.id, "این عملیات فقط در گفت‌وگوی خصوصی ربات در دسترس است.");
    return true;
  }
  if (data === "profile:exit") {
    const flow = await env.CRASH_BOT_DB.prepare(`
      SELECT flow_type FROM user_conversations WHERE user_id = ?
    `).bind(actorId).first();
    if (flow?.flow_type !== "profile_view") {
      await answerCallbackQuery(env, query.id, "صفحهٔ پروفایل فعال نیست.");
      return true;
    }
    await clearPostConversation(env, actorId);
    await answerCallbackQuery(env, query.id, "از پروفایل خارج شدی.");
    await sendTelegram(env, query.message.chat.id, "به منوی کاربر برگشتی.");
    return true;
  }
  const openChat = /^connection:chat:(\d+)$/.exec(data);
  if (openChat) {
    const connectionId = Number(openChat[1]);
    const active = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM connection_requests
      WHERE id = ? AND status = 'accepted'
        AND (requester_id = ? OR recipient_id = ?)
    `).bind(connectionId, actorId, actorId).first();
    if (!active) {
      await answerCallbackQuery(env, query.id, "این ارتباط فعال نیست یا متعلق به شما نیست.");
      return true;
    }
    await setPostConversation(env, actorId, "connection_chat", connectionId);
    await answerCallbackQuery(env, query.id, "گفت‌وگوی فعال باز شد.");
    await sendTelegram(env, query.message.chat.id, "پیام متنی یا رسانه‌ای خود را بفرست.");
    return true;
  }
  if (data === "connection:cancel") {
    await clearPostConversation(env, actorId);
    await answerCallbackQuery(env, query.id, "درخواست لغو شد.");
    await sendTelegram(env, query.message.chat.id, "درخواست ارتباط ارسال نشد.");
    return true;
  }
  const confirm = /^connection:confirm:(\d+)$/.exec(data);
  if (confirm) {
    const postId = Number(confirm[1]);
    const flow = await env.CRASH_BOT_DB.prepare(`
      SELECT flow_type, entity_id FROM user_conversations WHERE user_id = ?
    `).bind(actorId).first();
    if (flow?.flow_type !== "connection_confirm" || Number(flow.entity_id) !== postId) {
      await answerCallbackQuery(env, query.id, "درخواست دیگر فعال نیست.");
      return true;
    }
    const post = await env.CRASH_BOT_DB.prepare(`
      SELECT user_id FROM posts WHERE id = ? AND status = 'published'
    `).bind(postId).first();
    if (!post || String(post.user_id) === String(actorId)) {
      await clearPostConversation(env, actorId);
      await answerCallbackQuery(env, query.id, "درخواست ارتباط امکان‌پذیر نیست.");
      return true;
    }
    const inserted = await env.CRASH_BOT_DB.prepare(`
      INSERT INTO connection_requests (requester_id, recipient_id, post_id, status)
      SELECT ?, ?, ?, 'pending'
      WHERE NOT EXISTS (
        SELECT 1 FROM connection_requests
        WHERE requester_id = ? AND recipient_id = ? AND post_id = ?
      )
      ON CONFLICT(requester_id, recipient_id, post_id) WHERE status = 'pending'
      DO NOTHING
      RETURNING id
    `).bind(actorId, post.user_id, postId, actorId, post.user_id, postId).first();
    await clearPostConversation(env, actorId);
    if (!inserted?.id) {
      await answerCallbackQuery(env, query.id, "درخواست تکراری یا در حال بررسی است.");
      return true;
    }
    await answerCallbackQuery(env, query.id, "درخواست ارتباط ثبت شد.");
    const delivered = await sendConnectionRequestNotification(env, inserted.id, post.user_id);
    await sendTelegram(env, query.message.chat.id, delivered
      ? "درخواست ارتباط برای دریافت‌کننده ارسال شد."
      : "درخواست ثبت شد، اما دریافت‌کننده هنوز ربات را شروع نکرده یا پیام خصوصی در دسترس نیست.");
    return true;
  }
  const decision = /^connection:decision:(\d+):(accepted|rejected)$/.exec(data);
  if (decision) {
    const requestId = Number(decision[1]);
    const newStatus = decision[2];
    const result = await env.CRASH_BOT_DB.prepare(`
      UPDATE connection_requests SET status = ?, responded_at = CURRENT_TIMESTAMP
      WHERE id = ? AND recipient_id = ? AND status = 'pending'
      RETURNING id
    `).bind(newStatus, requestId, actorId).first();
    if (!result?.id) {
      await answerCallbackQuery(env, query.id, "این درخواست قبلاً پاسخ داده شده یا متعلق به شما نیست.");
      return true;
    }
    await answerCallbackQuery(env, query.id, newStatus === "accepted" ? "درخواست پذیرفته شد." : "درخواست رد شد.");
    const requester = await env.CRASH_BOT_DB.prepare(
      "SELECT requester_id FROM connection_requests WHERE id = ?"
    ).bind(requestId).first();
    await sendTelegram(env, query.message.chat.id,
      newStatus === "accepted" ? "ارتباط فعال شد؛ پیام خود را برای گفت‌وگو بفرست." : "درخواست ارتباط رد شد.");
    const notification = await enqueueNotification(env, {
      recipientId: requester.requester_id,
      operation: "connection_decision",
      entityId: requestId,
      eventKey: `connection-decision:${requestId}`,
      messageSnapshot: newStatus === "accepted"
        ? "درخواست ارتباط پذیرفته شد. گفت‌وگوی رباتی فعال است."
        : "درخواست ارتباط شما رد شد."
    });
    await sendPendingNotification(env, notification,
      (claimed) => deliverConnectionOutboxNotification(env, claimed));
    if (newStatus === "accepted") {
      await setPostConversation(env, actorId, "connection_chat", requestId);
      await setPostConversation(env, requester.requester_id, "connection_chat", requestId);
    }
    return true;
  }
  const open = /^connection:open:(\d+)$/.exec(data);
  if (open) {
    const request = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM connection_requests
      WHERE id = ? AND recipient_id = ? AND status = 'pending'
    `).bind(Number(open[1]), actorId).first();
    await answerCallbackQuery(env, query.id, request ? "درخواست فعال است." : "درخواست در دسترس نیست.");
    return true;
  }
  return false;
}

export async function renderConnections(env, userId, chatId, section) {
  const conditions = section === "incoming"
    ? "recipient_id = ?"
    : section === "outgoing"
      ? "requester_id = ?"
      : "(requester_id = ? OR recipient_id = ?) AND status = 'accepted'";
  const bind = section === "active" ? [userId, userId] : [userId];
  const rows = await env.CRASH_BOT_DB.prepare(`
    SELECT c.id, c.requester_id, c.recipient_id, c.post_id, c.status, c.created_at,
      p.nickname AS requester_nickname
    FROM connection_requests c
    LEFT JOIN profiles p ON p.user_id = c.requester_id
    WHERE ${conditions.replaceAll("requester_id", "c.requester_id").replaceAll("recipient_id", "c.recipient_id").replaceAll("status", "c.status")}
    ORDER BY created_at DESC, id DESC LIMIT 30
  `).bind(...bind).all();
  if (!rows.results?.length) {
    await sendTelegram(env, chatId, "موردی برای نمایش وجود ندارد.");
    return;
  }
  for (const request of rows.results) {
    const displayStatus = request.status === "accepted" ? "فعال"
      : request.status === "rejected" ? "ردشده" : "در انتظار";
    const keyboard = request.status === "accepted"
      ? [[{ text: "گفت‌وگوی فعال", callback_data: `connection:chat:${request.id}` }]]
      : section === "incoming" && request.status === "pending"
        ? [[
          { text: "✅ قبول", callback_data: `connection:decision:${request.id}:accepted` },
          { text: "❌ رد", callback_data: `connection:decision:${request.id}:rejected` }
        ]]
        : [];
    await sendInlineTelegram(env, chatId,
      `درخواست #${request.id} · ${displayStatus}${section === "incoming" ? ` · ${request.requester_nickname ?? ""}` : ""}\n${request.created_at} UTC`, keyboard);
  }
}
