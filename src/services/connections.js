import {
  answerCallbackQuery,
  sendInlineTelegram,
  sendInlineTelegramDetailed,
  sendMediaTelegramDetailed,
  sendMediaTelegram,
  sendTelegram
} from "../telegram/api.js";
import { calculatePersianAge } from "./profile.js";
import { isBotCommand, isPrivateConversationMessage } from "./conversation-engine.js";
import {
  clearPostConversation,
  createDeepLinkToken,
  escapeHtml,
  resolveDeepLinkToken,
  setPostConversation
} from "./posts.js";
import { enqueueNotification, sendPendingNotification } from "./notification-outbox.js";
import {
  CHAT_RETURN_KEYBOARD,
  CHAT_RETURN_BUTTON,
  appendAndNotify,
  clearConversationReplyContext,
  clearConversationSelection,
  getConversationSelection,
  renderRecentConversationMessages,
  selectConversation
} from "./anonymous-chat.js";

const PROFILE_MEDIA_METHODS = {
  photo: "sendPhoto",
  video: "sendVideo",
  document: "sendDocument",
  audio: "sendAudio",
  voice: "sendVoice",
  animation: "sendAnimation",
  video_note: "sendVideoNote",
  sticker: "sendSticker"
};

function publicProfileLines(profile, interests) {
  const maritalStatus = {
    single: "مجرد",
    married: "متأهل"
  }[profile.marital_status] ?? "ثبت نشده";
  const gender = {
    woman: "زن",
    man: "مرد"
  }[profile.gender] ?? "ثبت نشده";
  const age = profile.birth_year && profile.birth_month
    ? calculatePersianAge(profile.birth_year, profile.birth_month)
    : null;
  const lines = [
    `👤 ${escapeHtml(profile.nickname || "ثبت نشده")}`,
    `دربارهٔ من: ${escapeHtml(profile.bio || "ثبت نشده")}`,
    `شهر: ${escapeHtml(profile.city || "ثبت نشده")}`,
    `سن: ${age === null ? "ثبت نشده" : age}`,
    `شغل: ${escapeHtml(profile.job || "ثبت نشده")}`,
    `رشتهٔ تحصیلی: ${escapeHtml(profile.field || "ثبت نشده")}`,
    `وضعیت تأهل: ${maritalStatus}`,
    `جنسیت: ${gender}`,
    `مذهب: ${escapeHtml(profile.religion || "ثبت نشده")}`,
    `فرقه: ${escapeHtml(profile.religious_sect || "ثبت نشده")}`,
    "",
    "❤️ علاقه‌مندی‌ها:"
  ];

  if (!interests.length) {
    lines.push("علاقه‌مندی ثبت نشده است.");
  } else {
    for (const [index, interest] of interests.entries()) {
      const description = interest.content || interest.caption || "رسانه";
      lines.push(
        `${index + 1}. ${escapeHtml(interest.category)}: ${escapeHtml(description)}`
      );
    }
  }
  return lines;
}

function chunkHtmlLines(lines, maxLength = 3900) {
  const chunks = [];
  let chunk = "";
  for (const line of lines) {
    if (chunk && chunk.length + line.length + 1 > maxLength) {
      chunks.push(chunk);
      chunk = "";
    }
    if (line.length > maxLength) {
      if (chunk) {
        chunks.push(chunk);
        chunk = "";
      }
      let segment = "";
      for (const token of line.match(/&(?:amp|lt|gt|quot);|[\s\S]/gu) ?? []) {
        if (segment.length + token.length > maxLength) {
          chunks.push(segment);
          segment = "";
        }
        segment += token;
      }
      chunk = segment;
    } else {
      chunk = chunk ? `${chunk}\n${line}` : line;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

async function sendPublicProfile(env, chatId, profile, interests) {
  const chunks = chunkHtmlLines(publicProfileLines(profile, interests));
  const firstChunk = chunks.shift() ?? "پروفایل در دسترس نیست.";
  if (profile.image_file_id) {
    const caption = firstChunk.length <= 1024
      ? firstChunk
      : "👤 عکس پروفایل";
    const result = await sendMediaTelegramDetailed(env, "sendPhoto", {
      chat_id: chatId,
      photo: profile.image_file_id,
      caption,
      parse_mode: "HTML"
    });
    if (result.outcome !== "sent") {
      console.error("Could not send public profile picture:", result.outcome);
      chunks.unshift(firstChunk);
    } else if (caption !== firstChunk) {
      chunks.unshift(firstChunk);
    }
  } else {
    chunks.unshift(firstChunk);
  }

  for (const text of chunks) {
    const result = await sendMediaTelegramDetailed(env, "sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML"
    });
    if (result.outcome !== "sent") {
      console.error("Could not send public profile details:", result.outcome);
      return false;
    }
  }

  for (const interest of interests) {
    const method = PROFILE_MEDIA_METHODS[interest.media_type];
    if (!method || !interest.media_file_id) continue;
    const caption = [
      `❤️ ${escapeHtml(interest.category)}`,
      escapeHtml(String(interest.caption || interest.content || "").slice(0, 150))
    ].filter(Boolean).join("\n");
    if (["video_note", "sticker"].includes(interest.media_type)) {
      const label = await sendMediaTelegramDetailed(env, "sendMessage", {
        chat_id: chatId,
        text: `❤️ ${escapeHtml(interest.category)}`
      });
      if (label.outcome !== "sent") {
        console.error("Could not label public profile interest media:", label.outcome);
        continue;
      }
    }
    const result = await sendMediaTelegramDetailed(env, method, {
      chat_id: chatId,
      [interest.media_type]: interest.media_file_id,
      ...(caption && !["video_note", "sticker"].includes(interest.media_type)
        ? { caption, parse_mode: "HTML" }
        : {})
    });
    if (result.outcome !== "sent") {
      console.error("Could not send public profile interest media:", result.outcome);
    }
  }
  return true;
}

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
    SELECT p.nickname, p.bio, p.city, p.job, p.field, p.religion,
      p.religious_sect, p.marital_status, p.gender, c.requester_id
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
  const interests = await env.CRASH_BOT_DB.prepare(`
    SELECT category, content, caption, media_type, media_file_id
    FROM interests WHERE user_id = ? ORDER BY id
  `).bind(request.requester_id).all();
  const interestText = (interests.results ?? []).map((interest) =>
    `\n• ${escapeHtml(interest.category)}: ${escapeHtml(
      interest.content || interest.caption || "رسانه"
    )}${interest.media_file_id ? " [رسانهٔ پیوست]" : ""}`
  ).join("");
  const snapshot = [
    `درخواست ارتباط از «${escapeHtml(request.nickname)}»`,
    request.bio ? `\nدربارهٔ من: ${escapeHtml(request.bio)}` : "",
    request.city ? `\nشهر: ${escapeHtml(request.city)}` : "",
    request.job ? `\nشغل: ${escapeHtml(request.job)}` : "",
    request.field ? `\nرشته: ${escapeHtml(request.field)}` : "",
    request.religion ? `\nمذهب: ${escapeHtml(request.religion)}` : "",
    request.religious_sect ? `\nفرقه/مذهب: ${escapeHtml(request.religious_sect)}` : "",
    request.marital_status
      ? `\nوضعیت تأهل: ${request.marital_status === "married" ? "متأهل" : "مجرد"}`
      : "",
    request.gender
      ? `\nجنسیت: ${request.gender === "woman" ? "زن" : "مرد"}`
      : "",
    ageLabel,
    interestText ? `\n\nعلاقه‌مندی‌ها:${interestText}` : "\n\nعلاقه‌مندی ثبت نشده است.",
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

async function findActiveConnection(env, firstUserId, secondUserId, excludeId = null) {
  const exclude = excludeId === null ? "" : "AND id <> ?";
  const statement = env.CRASH_BOT_DB.prepare(`
    SELECT id FROM connection_requests
    WHERE status = 'accepted' AND ended_at IS NULL
      AND ((requester_id = ? AND recipient_id = ?)
        OR (requester_id = ? AND recipient_id = ?))
      ${exclude}
    ORDER BY id LIMIT 1
  `);
  return excludeId === null
    ? statement.bind(firstUserId, secondUserId, secondUserId, firstUserId).first()
    : statement.bind(
      firstUserId, secondUserId, secondUserId, firstUserId, excludeId
    ).first();
}

async function findConnectionBlock(env, firstUserId, secondUserId, requestId = null) {
  const statement = env.CRASH_BOT_DB.prepare(`
    SELECT 1
    WHERE EXISTS (
      SELECT 1 FROM user_blocks b
      WHERE b.lifted_at IS NULL
        AND ((b.blocker_id = ? AND b.blocked_id = ?)
          OR (b.blocker_id = ? AND b.blocked_id = ?))
    ) OR EXISTS (
      SELECT 1 FROM conversation_blocks b
      JOIN connection_requests c
        ON c.id = b.conversation_id AND b.conversation_type = 'connection'
      WHERE ((c.requester_id = ? AND c.recipient_id = ?)
          OR (c.requester_id = ? AND c.recipient_id = ?))
        AND ((b.blocker_id = ? AND b.blocked_id = ?)
          OR (b.blocker_id = ? AND b.blocked_id = ?))
    )
  `);
  const common = [
    firstUserId, secondUserId, secondUserId, firstUserId
  ];
  const pair = [
    firstUserId, secondUserId, secondUserId, firstUserId,
    firstUserId, secondUserId, secondUserId, firstUserId
  ];
  return Boolean(await statement.bind(...common, ...pair).first());
}

async function sendConnectionDecisionNotification(env, requestId, requesterId, status) {
  const notification = await enqueueNotification(env, {
    recipientId: requesterId,
    operation: "connection_decision",
    entityId: requestId,
    eventKey: `connection-decision:${requestId}`,
    messageSnapshot: status === "accepted"
      ? "درخواست ارتباط پذیرفته شد. گفت‌وگوی رباتی فعال است."
      : "درخواست ارتباط شما رد شد."
  });
  await sendPendingNotification(env, notification,
    (claimed) => deliverConnectionOutboxNotification(env, claimed));
}

async function postPermalink(env, postId, messageId) {
  if (!postId || !messageId) return null;
  const [urlRow, idRow] = await Promise.all([
    env.CRASH_BOT_DB.prepare(
      "SELECT value FROM bot_settings WHERE key = 'crash_channel_url'"
    ).first(),
    env.CRASH_BOT_DB.prepare(
      "SELECT value FROM bot_settings WHERE key = 'crash_channel_id'"
    ).first()
  ]);
  const channelUrl = String(urlRow?.value ?? "").trim();
  if (channelUrl) {
    try {
      const url = new URL(channelUrl);
      if (url.protocol === "https:" &&
          ["t.me", "www.t.me"].includes(url.hostname) &&
          !url.pathname.includes("/+")) {
        return `${url.origin}${url.pathname.replace(/\/+$/, "")}/${messageId}`;
      }
    } catch (error) {
      console.error("Could not construct a channel post link from configured URL:", error);
    }
  }
  const channelId = String(idRow?.value ?? "");
  const internalId = /^-100\d+$/.test(channelId) ? channelId.slice(4) : null;
  return internalId ? `https://t.me/c/${internalId}/${messageId}` : null;
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
    if (result.outcome !== "sent") return result.outcome;
    const interests = await env.CRASH_BOT_DB.prepare(`
      SELECT id, category, content, caption, media_type, media_file_id
      FROM interests WHERE user_id = ? AND media_file_id IS NOT NULL
      ORDER BY id
    `).bind(request.requester_id).all();
    for (const interest of interests.results ?? []) {
      const method = {
        photo: "sendPhoto", video: "sendVideo", document: "sendDocument",
        audio: "sendAudio", voice: "sendVoice", animation: "sendAnimation",
        video_note: "sendVideoNote", sticker: "sendSticker"
      }[interest.media_type];
      if (!method) continue;
      const noCaption = ["sticker", "video_note"].includes(interest.media_type);
      const caption = noCaption ? null :
        `علاقه‌مندی: ${interest.category}\n${interest.caption || interest.content || ""}`.slice(0, 1024);
      const mediaResult = await sendMediaTelegramDetailed(env, method, {
        chat_id: recipientId,
        [interest.media_type]: interest.media_file_id,
        ...(caption ? { caption } : {})
      });
      if (mediaResult.outcome !== "sent") return mediaResult.outcome;
    }
    return result.outcome;
  }

  if (operation === "connection_decision") {
    const request = await env.CRASH_BOT_DB.prepare(`
      SELECT c.requester_id, c.status, c.post_id, p.channel_message_id
      FROM connection_requests c
      LEFT JOIN posts p ON p.id = c.post_id
      WHERE c.id = ?
    `).bind(entityId).first();
    if (!request || String(request.requester_id) !== String(recipientId)) return false;
    const username = await publicBotUsername(env);
    const token = await createDeepLinkToken(env, "connection", entityId, recipientId);
    const keyboard = [[username
      ? { text: "مشاهدهٔ گفت‌وگو", url: `https://t.me/${username}?start=${token}` }
      : { text: "مشاهدهٔ گفت‌وگو", callback_data: `connection:open:${entityId}` }]];
    const permalink = await postPermalink(env, request.post_id, request.channel_message_id);
    if (permalink) keyboard.push([{ text: "مشاهدهٔ همان پست کانال", url: permalink }]);
    const message = request.status === "accepted"
      ? "درخواست ارتباط پذیرفته شد. گفت‌وگوی رباتی فعال است."
      : request.status === "rejected"
        ? "درخواست ارتباط شما رد شد."
        : "وضعیت درخواست ارتباط تغییر کرده است.";
    return (await sendInlineTelegramDetailed(
      env, recipientId, outbox.message_snapshot ?? message, keyboard
    )).outcome;
  }

  if (operation === "connection_message") {
    return "sent";
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
        marital_status, gender, religion, religious_sect, image_file_id
      FROM profiles WHERE user_id = ?
    `).bind(post.user_id).first();
    if (!profile) {
      await sendTelegram(env, chatId, "پروفایل عمومی در دسترس نیست.");
      return true;
    }
    const interests = await env.CRASH_BOT_DB.prepare(`
      SELECT category, content, caption, media_type, media_file_id
      FROM interests WHERE user_id = ? ORDER BY id
    `).bind(post.user_id).all();
    await setPostConversation(env, userId, "profile_view", post.user_id);
    await sendPublicProfile(env, chatId, profile, interests.results ?? []);
    await sendInlineTelegram(env, chatId, "نمایش پروفایل فعال است.", [[
      { text: "خروج از پروفایل", callback_data: "profile:exit" }
    ]]);
    return true;
  }
  if (link.type === "connect") {
    const post = await env.CRASH_BOT_DB.prepare(`
      SELECT p.id, p.user_id, p.user_record_number, pr.nickname, pr.bio, pr.city
      FROM posts p JOIN profiles pr ON pr.user_id = p.user_id
      WHERE p.id = ? AND p.status = 'published' AND p.channel_message_id IS NOT NULL
    `).bind(link.entityId).first();
    if (!post || String(post.user_id) === String(userId)) {
      await sendTelegram(env, chatId, "درخواست ارتباط برای این مورد امکان‌پذیر نیست.");
      return true;
    }
    await setPostConversation(env, userId, "connection_confirm", post.id);
    await sendInlineTelegram(env, chatId,
      `درخواست ارتباط با «${escapeHtml(post.nickname)}» دربارهٔ پست #${post.user_record_number ?? "نامشخص"}\n\nمطمئنی می‌خواهی درخواست ارتباط ارسال شود؟`,
      [[
        { text: "✅ بله، ارسال درخواست", callback_data: `connection:confirm:${post.id}` },
        { text: "لغو", callback_data: `connection:cancel:${post.id}` }
      ]]);
    return true;
  }
  if (link.type === "connection") {
    const request = await env.CRASH_BOT_DB.prepare(`
      SELECT id, status, requester_id, recipient_id, ended_at
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
    if (request.status !== "accepted" || request.ended_at) {
      if (request.ended_at) {
        await sendTelegram(env, chatId, "این ارتباط پایان یافته است.");
        return true;
      }
      await sendTelegram(env, chatId, `وضعیت درخواست ارتباط: ${request.status === "rejected" ? "ردشده" : "در انتظار پاسخ"}.`);
      return true;
    }
    await setPostConversation(env, userId, "connection_chat", request.id);
    await sendTelegram(env, chatId, "گفت‌وگو باز شد. پیام متنی یا رسانه‌ای خود را بفرست.");
    return true;
  }
  if (link.type === "post_history") {
    const post = await env.CRASH_BOT_DB.prepare(`
      SELECT id, user_record_number, status, content, caption, created_at,
        reviewed_at, admin_note
      FROM posts WHERE id = ? AND user_id = ?
    `).bind(link.entityId, userId).first();
    if (!post) {
      await sendTelegram(env, chatId, "این سابقه در دسترس نیست.");
      return true;
    }
    await sendTelegram(env, chatId,
      `سابقهٔ #${post.user_record_number ?? "نامشخص"}\nوضعیت: ${post.status}\nدریافت: ${post.created_at}\nاقدام: ${post.reviewed_at ?? "—"}${post.admin_note ? `\nتوضیح مدیر: ${post.admin_note}` : ""}\n\n${post.caption ?? post.content}`);
    return true;
  }
  return false;
}

export async function handleConnectionMessage(env, message, userId) {
  if (!isPrivateConversationMessage(message, userId)) return false;
  const selection = await getConversationSelection(env, userId);
  if (selection && selection.conversation_type !== "connection") return false;
  const flow = selection
    ? { flow_type: "connection_chat", entity_id: selection.conversation_id }
    : await env.CRASH_BOT_DB.prepare(`
      SELECT flow_type, entity_id FROM user_conversations WHERE user_id = ?
    `).bind(userId).first();
  if (!flow) return false;
  const navigation = [
    "/start", "/menu", "🏠 منوی اصلی", "⬅️ بازگشت", "🛠 پنل مدیریت",
    CHAT_RETURN_BUTTON,
    "👤 پنل کاربر", "💌 ثبت پست کراش", "✍️ شروع ثبت پست",
    "🤝 درخواست‌های ارتباط از کانال", "📚 ثبت کراش‌های من"
  ];
  const text = String(message.text ?? "").trim();
  if (navigation.includes(text)) {
    await clearPostConversation(env, userId);
    if (selection?.conversation_type === "connection") {
      await clearConversationSelection(env, userId);
      await clearConversationReplyContext(env, userId, {
        type: "connection", id: Number(selection.conversation_id)
      });
    }
    return false;
  }
  if (isBotCommand(message)) return false;
  if (flow.flow_type === "profile_view") return false;
  if (flow.flow_type === "connection_confirm") {
    await sendTelegram(env, message.chat.id, "برای ثبت درخواست از دکمه‌های تأیید یا لغو استفاده کن.");
    return true;
  }
  if (flow.flow_type !== "connection_chat") return false;
  const request = await env.CRASH_BOT_DB.prepare(`
    SELECT requester_id, recipient_id FROM connection_requests
    WHERE id = ? AND status = 'accepted' AND ended_at IS NULL
      AND (requester_id = ? OR recipient_id = ?)
  `).bind(flow.entity_id, userId, userId).first();
  if (!request) {
    await clearPostConversation(env, userId);
    await sendTelegram(env, message.chat.id, "این ارتباط فعال نیست و امکان ارسال پیام ندارد.");
    return true;
  }
  const peerId = String(request.requester_id) === String(userId)
    ? request.recipient_id : request.requester_id;
  const result = await appendAndNotify(env, {
    senderId: userId,
    recipientId: peerId,
    sourceType: "connection",
    connectionId: Number(flow.entity_id),
    message,
    sourceMessageId: message.message_id
  });
  if (result.status === "invalid") {
    await sendTelegram(env, message.chat.id,
      "پیام متنی یا رسانهٔ پشتیبانی‌شده بفرست.");
  } else if (result.status === "blocked") {} else if (result.status === "inactive") {
    await sendTelegram(env, message.chat.id,
      "این ارتباط دیگر فعال نیست و پیام ثبت نشد.");
  }
  return true;
}

export async function handleConnectionCallback(env, query) {
  const data = query.data ?? "";
  const actorId = query.from?.id;
  if (!Number.isSafeInteger(actorId) || actorId <= 0 ||
      !Number.isSafeInteger(query.message?.message_id) ||
      query.message.message_id <= 0 ||
      query.message?.chat?.type !== "private" ||
      String(query.message?.chat?.id) !== String(actorId)) {
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
  const endConfirm = /^connection:end:confirm:(\d+)$/.exec(data);
  if (endConfirm) {
    const connectionId = Number(endConfirm[1]);
    const active = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM connection_requests
      WHERE id = ? AND status = 'accepted' AND ended_at IS NULL
        AND (requester_id = ? OR recipient_id = ?)
    `).bind(connectionId, actorId, actorId).first();
    if (!active) {
      await answerCallbackQuery(env, query.id,
        "این ارتباط فعال نیست یا متعلق به شما نیست.");
      return true;
    }
    await sendInlineTelegram(env, query.message.chat.id,
      "آیا می‌خواهی این ارتباط را پایان بدهی؟ تاریخچه پیام‌ها حفظ می‌شود.",
      [[
        { text: "پایان ارتباط", callback_data: `connection:end:do:${connectionId}` },
        { text: "لغو", callback_data: `connection:end:cancel:${connectionId}` }
      ]]);
    await answerCallbackQuery(env, query.id);
    return true;
  }
  const endCancel = /^connection:end:cancel:(\d+)$/.exec(data);
  if (endCancel) {
    await answerCallbackQuery(env, query.id, "پایان ارتباط لغو شد.");
    return true;
  }
  const end = /^connection:end:do:(\d+)$/.exec(data);
  if (end) {
    const connectionId = Number(end[1]);
    const connection = await env.CRASH_BOT_DB.prepare(`
      UPDATE connection_requests
      SET ended_at = CURRENT_TIMESTAMP, ended_by = ?
      WHERE id = ? AND status = 'accepted' AND ended_at IS NULL
        AND (requester_id = ? OR recipient_id = ?)
      RETURNING requester_id, recipient_id
    `).bind(actorId, connectionId, actorId, actorId).first();
    if (!connection) {
      await answerCallbackQuery(env, query.id,
        "این ارتباط قبلاً پایان یافته یا متعلق به شما نیست.");
      return true;
    }
    const peerId = String(connection.requester_id) === String(actorId)
      ? connection.recipient_id : connection.requester_id;
    const reference = { type: "connection", id: connectionId };
    for (const participantId of [actorId, peerId]) {
      await clearPostConversation(env, participantId);
      await clearConversationSelection(env, participantId);
      await clearConversationReplyContext(env, participantId, reference);
    }
    await answerCallbackQuery(env, query.id, "ارتباط پایان یافت.");
    await sendTelegram(env, actorId,
      "این ارتباط پایان یافت؛ تاریخچه پیام‌ها حفظ شده است.");
    await sendTelegram(env, peerId,
      "طرف مقابل این ارتباط را پایان داد؛ تاریخچه پیام‌ها حفظ شده است.");
    return true;
  }
  const openChat = /^connection:chat:(\d+)$/.exec(data);
  if (openChat) {
    const connectionId = Number(openChat[1]);
    const active = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM connection_requests
      WHERE id = ? AND status = 'accepted' AND ended_at IS NULL
        AND (requester_id = ? OR recipient_id = ?)
    `).bind(connectionId, actorId, actorId).first();
    if (!active) {
      await answerCallbackQuery(env, query.id, "این ارتباط فعال نیست یا متعلق به شما نیست.");
      return true;
    }
    await selectConversation(env, actorId, "connection", connectionId);
    await answerCallbackQuery(env, query.id, "گفت‌وگوی فعال باز شد.");
    await sendTelegram(
      env, query.message.chat.id, "پیام متنی یا رسانه‌ای خود را بفرست.",
      CHAT_RETURN_KEYBOARD
    );
    await renderRecentConversationMessages(
      env, actorId, "connection", connectionId, 20
    );
    return true;
  }
  const cancel = /^connection:cancel:(\d+)$/.exec(data);
  if (cancel) {
    const postId = Number(cancel[1]);
    const flow = await env.CRASH_BOT_DB.prepare(`
      SELECT flow_type, entity_id FROM user_conversations WHERE user_id = ?
    `).bind(actorId).first();
    if (!Number.isSafeInteger(postId) || postId <= 0 ||
        flow?.flow_type !== "connection_confirm" ||
        Number(flow.entity_id) !== postId) {
      await answerCallbackQuery(env, query.id, "این درخواست دیگر فعال نیست.");
      return true;
    }
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
    if (await findActiveConnection(env, actorId, post.user_id)) {
      await clearPostConversation(env, actorId);
      await answerCallbackQuery(env, query.id,
        "شما و این کاربر از قبل ارتباط فعال دارید و نیازی به ارسال درخواست جدید نیست.");
      await sendTelegram(env, query.message.chat.id,
        "شما و این کاربر از قبل ارتباط فعال دارید و نیازی به ارسال درخواست جدید نیست.");
      return true;
    }
    if (await findConnectionBlock(env, actorId, post.user_id)) {
      await clearPostConversation(env, actorId);
      await answerCallbackQuery(env, query.id,
        "به‌دلیل تنظیمات بلاک، ارسال درخواست ارتباط امکان‌پذیر نیست.");
      await sendTelegram(env, query.message.chat.id,
        "به‌دلیل تنظیمات بلاک، ارسال درخواست ارتباط امکان‌پذیر نیست.");
      return true;
    }
    const inserted = await env.CRASH_BOT_DB.prepare(`
      INSERT INTO connection_requests (requester_id, recipient_id, post_id, status)
      SELECT ?, ?, ?, 'pending'
      WHERE NOT EXISTS (
        SELECT 1 FROM connection_requests
        WHERE requester_id = ? AND recipient_id = ? AND post_id = ?
            AND status = 'pending'
      ) AND NOT EXISTS (
        SELECT 1 FROM connection_requests
        WHERE status = 'accepted' AND ended_at IS NULL
          AND ((requester_id = ? AND recipient_id = ?)
            OR (requester_id = ? AND recipient_id = ?))
      ) AND NOT EXISTS (
        SELECT 1 FROM user_blocks
        WHERE lifted_at IS NULL
          AND ((blocker_id = ? AND blocked_id = ?)
            OR (blocker_id = ? AND blocked_id = ?))
      ) AND NOT EXISTS (
        SELECT 1 FROM conversation_blocks b
        JOIN connection_requests c
          ON c.id = b.conversation_id AND b.conversation_type = 'connection'
        WHERE ((c.requester_id = ? AND c.recipient_id = ?)
          OR (c.requester_id = ? AND c.recipient_id = ?))
          AND ((b.blocker_id = ? AND b.blocked_id = ?)
            OR (b.blocker_id = ? AND b.blocked_id = ?))
      )
      ON CONFLICT(requester_id, recipient_id, post_id) WHERE status = 'pending'
      DO NOTHING
      RETURNING id
    `).bind(
      actorId, post.user_id, postId,
      actorId, post.user_id, postId,
      actorId, post.user_id, post.user_id, actorId,
      actorId, post.user_id, post.user_id, actorId,
      actorId, post.user_id, post.user_id, actorId,
      actorId, post.user_id, post.user_id, actorId
    ).first();
    await clearPostConversation(env, actorId);
    if (!inserted?.id) {
      if (await findActiveConnection(env, actorId, post.user_id)) {
        const notice =
          "شما و این کاربر از قبل ارتباط فعال دارید و نیازی به ارسال درخواست جدید نیست.";
        await answerCallbackQuery(env, query.id, notice);
        await sendTelegram(env, query.message.chat.id, notice);
        return true;
      }
      if (await findConnectionBlock(env, actorId, post.user_id)) {
        await answerCallbackQuery(env, query.id,
          "به‌دلیل تنظیمات بلاک، ارسال درخواست ارتباط امکان‌پذیر نیست.");
        await sendTelegram(env, query.message.chat.id,
          "به‌دلیل تنظیمات بلاک، ارسال درخواست ارتباط امکان‌پذیر نیست.");
        return true;
      }
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
        AND (? = 'rejected' OR (
          NOT EXISTS (
            SELECT 1 FROM connection_requests active
            WHERE active.status = 'accepted' AND active.ended_at IS NULL
              AND active.id <> connection_requests.id
              AND ((active.requester_id = connection_requests.requester_id
                  AND active.recipient_id = connection_requests.recipient_id)
                OR (active.requester_id = connection_requests.recipient_id
                  AND active.recipient_id = connection_requests.requester_id))
          )
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks b
            WHERE b.lifted_at IS NULL
              AND ((b.blocker_id = connection_requests.requester_id
                    AND b.blocked_id = connection_requests.recipient_id)
                OR (b.blocker_id = connection_requests.recipient_id
                    AND b.blocked_id = connection_requests.requester_id))
          )
          AND NOT EXISTS (
            SELECT 1 FROM conversation_blocks b
            JOIN connection_requests blocked_connection
              ON blocked_connection.id = b.conversation_id
              AND b.conversation_type = 'connection'
            WHERE ((blocked_connection.requester_id = connection_requests.requester_id
                  AND blocked_connection.recipient_id = connection_requests.recipient_id)
                OR (blocked_connection.requester_id = connection_requests.recipient_id
                  AND blocked_connection.recipient_id = connection_requests.requester_id))
              AND ((b.blocker_id = connection_requests.requester_id
                    AND b.blocked_id = connection_requests.recipient_id)
                OR (b.blocker_id = connection_requests.recipient_id
                    AND b.blocked_id = connection_requests.requester_id))
          )
        ))
      RETURNING id, requester_id
    `).bind(newStatus, requestId, actorId, newStatus).first();
    if (!result?.id) {
      const request = await env.CRASH_BOT_DB.prepare(`
        SELECT requester_id, recipient_id, status FROM connection_requests
        WHERE id = ? AND recipient_id = ?
      `).bind(requestId, actorId).first();
      if (request?.status === "pending" && newStatus === "accepted") {
        const active = await findActiveConnection(
          env, request.requester_id, request.recipient_id, requestId
        );
        const blocked = await findConnectionBlock(
          env, request.requester_id, request.recipient_id, requestId
        );
        if (active || blocked) {
          const rejected = await env.CRASH_BOT_DB.prepare(`
            UPDATE connection_requests SET status = 'rejected',
              responded_at = CURRENT_TIMESTAMP
            WHERE id = ? AND recipient_id = ? AND status = 'pending'
            RETURNING id, requester_id
          `).bind(requestId, actorId).first();
          if (rejected) {
            const notice = active
              ? "با فرستنده این درخواست از قبل ارتباط فعال دارید."
              : "به‌دلیل تنظیمات بلاک، این درخواست قابل پذیرش نیست.";
            await answerCallbackQuery(env, query.id, notice);
            await sendTelegram(env, query.message.chat.id, notice);
            await sendConnectionDecisionNotification(
              env, rejected.id, rejected.requester_id, "rejected"
            );
            return true;
          }
        }
      }
      await answerCallbackQuery(env, query.id, "این درخواست قبلاً پاسخ داده شده یا متعلق به شما نیست.");
      return true;
    }
    await answerCallbackQuery(env, query.id, newStatus === "accepted" ? "درخواست پذیرفته شد." : "درخواست رد شد.");
    const requester = await env.CRASH_BOT_DB.prepare(
      "SELECT requester_id FROM connection_requests WHERE id = ?"
    ).bind(requestId).first();
    await sendTelegram(env, query.message.chat.id,
      newStatus === "accepted" ? "ارتباط فعال شد؛ پیام خود را برای گفت‌وگو بفرست." : "درخواست ارتباط رد شد.",
      newStatus === "accepted" ? CHAT_RETURN_KEYBOARD : undefined);
    await sendConnectionDecisionNotification(
      env, requestId, requester.requester_id, newStatus
    );
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
      : "(requester_id = ? OR recipient_id = ?) AND status = 'accepted' AND ended_at IS NULL";
  const bind = section === "active" ? [userId, userId] : [userId];
  const rows = await env.CRASH_BOT_DB.prepare(`
    SELECT c.id, c.requester_id, c.recipient_id, c.post_id, c.status,
      c.ended_at, c.created_at,
      requester_profile.nickname AS requester_nickname,
      recipient_profile.nickname AS recipient_nickname
    FROM connection_requests c
    LEFT JOIN profiles requester_profile
      ON requester_profile.user_id = c.requester_id
    LEFT JOIN profiles recipient_profile
      ON recipient_profile.user_id = c.recipient_id
    WHERE ${conditions.replaceAll("requester_id", "c.requester_id").replaceAll("recipient_id", "c.recipient_id").replaceAll("status", "c.status")}
    ORDER BY created_at DESC, id DESC LIMIT 30
  `).bind(...bind).all();
  if (!rows.results?.length) {
    await sendTelegram(env, chatId, "موردی برای نمایش وجود ندارد.");
    return;
  }
  for (const request of rows.results) {
    const displayStatus = request.ended_at ? "پایان‌یافته"
      : request.status === "accepted" ? "فعال"
      : request.status === "rejected" ? "ردشده" : "در انتظار";
    const peerNickname = String(request.requester_id) === String(userId)
      ? request.recipient_nickname : request.requester_nickname;
    const keyboard = request.status === "accepted" && !request.ended_at
      ? [[{
        text: section === "active" ? peerNickname || "گفت‌وگوی ناشناس" : "گفت‌وگوی فعال",
        callback_data: `connection:chat:${request.id}`
      }], [{
        text: "پایان ارتباط",
        callback_data: `connection:end:confirm:${request.id}`
      }]]
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
