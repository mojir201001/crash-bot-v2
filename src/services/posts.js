import {
  answerCallbackQuery,
  editInlineTelegram,
  sendInlineTelegram,
  sendInlineTelegramDetailed,
  sendMediaTelegram,
  sendTelegram
} from "../telegram/api.js";
import { canAccess, getUserRole } from "./permissions.js";
import { enqueueNotification, sendPendingNotification } from "./notification-outbox.js";
import {
  getCurrentPersianYear,
  getPersianMonthRange
} from "./persian-calendar.js";

const SUPPORTED_MEDIA = [
  ["photo", "photo"],
  ["video", "video"],
  ["document", "document"],
  ["audio", "audio"],
  ["voice", "voice"],
  ["animation", "animation"],
  ["video_note", "video_note"],
  ["sticker", "sticker"]
];

const HTML = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

function mediaFromMessage(message) {
  for (const [field, type] of SUPPORTED_MEDIA) {
    const value = message?.[field];
    const item = Array.isArray(value) ? value[value.length - 1] : value;
    if (item?.file_id) return { type, fileId: item.file_id };
  }
  return { type: null, fileId: null };
}

export async function setPostConversation(env, userId, flowType, entityId = null) {
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO user_conversations (user_id, flow_type, entity_id, payload, updated_at)
    VALUES (?, ?, ?, '{}', CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      flow_type = excluded.flow_type,
      entity_id = excluded.entity_id,
      payload = '{}',
      updated_at = CURRENT_TIMESTAMP
  `).bind(userId, flowType, entityId).run();
}

export async function clearPostConversation(env, userId) {
  await env.CRASH_BOT_DB.prepare(
    "DELETE FROM user_conversations WHERE user_id = ?"
  ).bind(userId).run();
}

export async function createDeepLinkToken(
  env, tokenType, entityId, intendedUserId = null
) {
  if (!["profile", "reply", "connect", "post_history", "connection", "submit"].includes(tokenType)) {
    throw new Error("Unsupported deep link token type");
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO deep_link_tokens (token, token_type, entity_id, intended_user_id)
    VALUES (?, ?, ?, ?)
  `).bind(token, tokenType, entityId, intendedUserId).run();
  return token;
}

export async function resolveDeepLinkToken(env, token, userId) {
  if (typeof token !== "string" || !/^[a-f0-9]{32}$/.test(token)) return null;
  const result = await env.CRASH_BOT_DB.prepare(`
    SELECT token_type, entity_id, intended_user_id
    FROM deep_link_tokens
    WHERE token = ? AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
  `).bind(token).first();
  if (!result || (
    result.intended_user_id !== null &&
    String(result.intended_user_id) !== String(userId)
  )) return null;
  return { type: result.token_type, entityId: result.entity_id };
}

async function botUsername(env) {
  const row = await env.CRASH_BOT_DB.prepare(
    "SELECT value FROM bot_settings WHERE key = 'telegram_bot_username'"
  ).first();
  return String(row?.value ?? env.TELEGRAM_BOT_USERNAME ?? "").replace(/^@/, "");
}

async function channelConfiguration(env) {
  const rows = await env.CRASH_BOT_DB.prepare(`
    SELECT key, value FROM bot_settings
    WHERE key IN ('crash_channel_id', 'crash_channel_url')
  `).all();
  const settings = Object.fromEntries((rows.results ?? []).map(({ key, value }) => [key, value]));
  return {
    channelId: settings.crash_channel_id ?? env.CRASH_CHANNEL_ID ?? "",
    channelUrl: settings.crash_channel_url ?? env.CRASH_CHANNEL_URL ?? ""
  };
}

function getHtmlLink(label, url) {
  return `<a href="${HTML(url)}">${HTML(label)}</a>`;
}

async function operationLinks(env, post) {
  const username = await botUsername(env);
  if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) {
    throw new Error("TELEGRAM_BOT_USERNAME is not configured");
  }
  const [reply, profile, connect, submit, channel] = await Promise.all([
    createDeepLinkToken(env, "reply", post.id),
    createDeepLinkToken(env, "profile", post.id),
    createDeepLinkToken(env, "connect", post.id),
    createDeepLinkToken(env, "submit", post.id),
    channelConfiguration(env)
  ]);
  if (!/^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\/?$/.test(channel.channelUrl)) {
    throw new Error("CRASH_CHANNEL_URL is not configured");
  }
  return [
    ["پاسخ به پیام", reply],
    ["پروفایل فرستنده", profile],
    ["درخواست ارتباط با فرستنده", connect],
    ["ثبت پیام ناشناس", submit],
    ["کانال کراشیابی ادیب", channel.channelUrl]
  ].map(([label, target]) => [
    label,
    label === "کانال کراشیابی ادیب"
      ? target
      : `https://t.me/${username}?start=${target}`
  ]);
}

function telegramMethod(mediaType) {
  return ({
    photo: "sendPhoto",
    video: "sendVideo",
    document: "sendDocument",
    audio: "sendAudio",
    voice: "sendVoice",
    animation: "sendAnimation",
    video_note: "sendVideoNote",
    sticker: "sendSticker"
  })[mediaType];
}

function splitTelegramText(text, limit = 4096) {
  const chunks = [];
  let chunk = "";
  let length = 0;
  for (const character of text) {
    if (length + character.length > limit) {
      chunks.push(chunk);
      chunk = "";
      length = 0;
    }
    chunk += character;
    length += character.length;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

async function sendStoredMedia(env, chatId, post) {
  const method = telegramMethod(post.media_type);
  if (!method || !post.media_file_id) return;
  await sendMediaTelegram(env, method, {
    chat_id: chatId,
    [post.media_type === "photo" ? "photo" : post.media_type]: post.media_file_id
  });
}

async function sendPublishedContent(env, post, channelId, replyMessageId) {
  const links = await operationLinks(env, post);
  const linkText = links.map(([label, url]) => getHtmlLink(label, url)).join(" | ");
  const visibleLinkText = links.map(([label]) => label).join(" | ");
  const replyParameters = replyMessageId
    ? { reply_parameters: { message_id: replyMessageId, allow_sending_without_reply: false } }
    : {};
  const content = String(post.content ?? "");
  const original = post.media_file_id ? String(post.caption ?? content) : content;
  let sentAnyMessage = false;
  const send = async (method, payload) => {
    try {
      const result = await sendMediaTelegram(env, method, payload);
      sentAnyMessage = true;
      return result;
    } catch (error) {
      if (sentAnyMessage) error.telegramDefiniteFailure = false;
      throw error;
    }
  };

  if (!post.media_file_id) {
    if (!original.trim()) throw new Error("Post has no content");
    const visibleText = `${original}\n\n${visibleLinkText}`;
    if (visibleText.length <= 4096) {
      const result = await send("sendMessage", {
        chat_id: channelId,
        text: `${HTML(original)}\n\n${linkText}`,
        parse_mode: "HTML",
        ...replyParameters
      });
      return result.message_id;
    }
    const chunks = splitTelegramText(original);
    let contentResult;
    let previousMessageId;
    for (const [index, chunk] of chunks.entries()) {
      const result = await send("sendMessage", {
        chat_id: channelId,
        text: HTML(chunk),
        parse_mode: "HTML",
        ...(index === 0
          ? replyParameters
          : {
            reply_parameters: {
              message_id: previousMessageId,
              allow_sending_without_reply: false
            }
          })
      });
      contentResult ??= result;
      previousMessageId = result.message_id;
    }
    await send("sendMessage", {
      chat_id: channelId,
      text: linkText,
      parse_mode: "HTML",
      reply_parameters: {
        message_id: previousMessageId,
        allow_sending_without_reply: false
      }
    });
    return contentResult.message_id;
  }

  const method = telegramMethod(post.media_type);
  if (!method) throw new Error("Unsupported media type");
  const captionAllowed = !["sticker", "video_note"].includes(post.media_type);
  const captionWithLinks = original
    ? `${original}\n\n${visibleLinkText}`
    : visibleLinkText;
  const canAppendLinks = captionAllowed && captionWithLinks.length <= 1024;
  const mediaResult = await send(method, {
    chat_id: channelId,
    [post.media_type === "photo" ? "photo" : post.media_type]: post.media_file_id,
    ...(captionAllowed && (canAppendLinks || original.length <= 1024 && original)
      ? {
      caption: canAppendLinks
        ? `${HTML(original)}${original ? "\n\n" : ""}${linkText}`
        : HTML(original),
      parse_mode: "HTML"
      }
      : {}),
    ...replyParameters
  });
  if (canAppendLinks) return mediaResult.message_id;
  let linksReplyId = mediaResult.message_id;
  if (original && (!captionAllowed || original.length > 1024)) {
    for (const chunk of splitTelegramText(original)) {
      const contentResult = await send("sendMessage", {
        chat_id: channelId,
        text: HTML(chunk),
        parse_mode: "HTML",
        reply_parameters: {
          message_id: linksReplyId,
          allow_sending_without_reply: false
        }
      });
      linksReplyId = contentResult.message_id;
    }
  }
  await send("sendMessage", {
    chat_id: channelId,
    text: linkText,
    parse_mode: "HTML",
    reply_parameters: {
      message_id: linksReplyId,
      allow_sending_without_reply: false
    }
  });
  return mediaResult.message_id;
}

async function publishApprovedPost(env, postId, actorId, allowRetry = false) {
  const db = env.CRASH_BOT_DB;
  const post = await db.prepare(`
    SELECT p.*, p.reply_to_post_id, parent.channel_message_id AS parent_channel_message_id
    FROM posts p
    LEFT JOIN posts parent ON parent.id = p.reply_to_post_id
    WHERE p.id = ? AND p.status = 'approved'
  `).bind(postId).first();
  if (!post) return { status: "not_approved" };

  const jobType = post.reply_to_post_id ? "reply" : "post";
  const claim = allowRetry
    ? await db.prepare(`
      UPDATE publication_jobs SET status = 'sending', attempts = attempts + 1,
        last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE item_type = ? AND item_id = ? AND status IN ('failed', 'unknown')
      RETURNING id
    `).bind(jobType, postId).first()
    : await db.prepare(`
      INSERT INTO publication_jobs (item_type, item_id, status, attempts)
      VALUES (?, ?, 'sending', 1)
      ON CONFLICT(item_type, item_id) DO NOTHING
      RETURNING id
    `).bind(jobType, postId).first();
  if (!claim?.id) {
    const existing = await db.prepare(`
      SELECT status FROM publication_jobs WHERE item_type = ? AND item_id = ?
    `).bind(jobType, postId).first();
    return { status: existing?.status ?? "unknown" };
  }

  await db.prepare(`
    INSERT INTO post_events (post_id, actor_id, event_type)
    VALUES (?, ?, 'publish_started')
  `).bind(postId, actorId).run();

  try {
    const { channelId } = await channelConfiguration(env);
    if (!channelId || !(/^-100\d+$/.test(channelId) || /^@[A-Za-z0-9_]{5,32}$/.test(channelId))) {
      throw new Error("CRASH_CHANNEL_ID is not configured");
    }
    if (post.reply_to_post_id && !post.parent_channel_message_id) {
      throw new Error("Reply target is not published");
    }
    const channelMessageId = await sendPublishedContent(
      env, post, channelId, post.parent_channel_message_id
    );
    await db.batch([
      db.prepare(`
        UPDATE publication_jobs
        SET status = 'sent', channel_message_id = ?, last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE item_type = ? AND item_id = ? AND status = 'sending'
      `).bind(channelMessageId, jobType, postId),
      db.prepare(`
        UPDATE posts SET status = 'published', channel_message_id = ?
        WHERE id = ? AND status = 'approved'
      `).bind(channelMessageId, postId),
      db.prepare(`
        INSERT INTO post_events (post_id, actor_id, event_type)
        VALUES (?, ?, 'published')
      `).bind(postId, actorId)
    ]);
    return { status: "sent", channelMessageId };
  } catch (error) {
    const uncertain = !/not configured|not published|Unsupported media|no content/.test(
      String(error?.message ?? "")
    ) && error?.telegramDefiniteFailure !== true;
    const status = uncertain ? "unknown" : "failed";
    await db.batch([
      db.prepare(`
        UPDATE publication_jobs SET status = ?, last_error = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE item_type = ? AND item_id = ? AND status = 'sending'
      `).bind(status, String(error?.message ?? "Telegram request failed").slice(0, 500), jobType, postId),
      db.prepare(`
        INSERT INTO post_events (post_id, actor_id, event_type, details)
        VALUES (?, ?, ?, ?)
      `).bind(postId, actorId, uncertain ? "publish_unknown" : "publish_failed",
        uncertain ? "Delivery outcome is uncertain; automatic retry disabled." : String(error?.message ?? "").slice(0, 500))
    ]);
    return { status };
  }
}

async function markStalePublicationJobs(env) {
  await env.CRASH_BOT_DB.prepare(`
    UPDATE publication_jobs
    SET status = 'unknown',
      last_error = 'Previous publication attempt did not finish; channel delivery must be checked',
      updated_at = CURRENT_TIMESTAMP
    WHERE item_type IN ('post', 'reply')
      AND status = 'sending'
      AND updated_at <= datetime('now', '-15 minutes')
  `).run();
}

export async function submitPost(env, user, message, replyToPostId = null) {
  const media = mediaFromMessage(message);
  const originalText = message?.text ?? message?.caption ?? "";
  if (!String(originalText).trim() && !media.fileId) {
    throw new Error("Post must contain text or supported media");
  }
  if (replyToPostId !== null) {
    const parent = await env.CRASH_BOT_DB.prepare(`
      SELECT id, channel_message_id, status FROM posts WHERE id = ?
    `).bind(replyToPostId).first();
    if (!parent || parent.status !== "published" || !parent.channel_message_id) {
      throw new Error("Reply target is unavailable");
    }
  }

  const inserted = await env.CRASH_BOT_DB.prepare(`
    INSERT INTO posts (
      user_id, sender_username, content, caption, media_type, media_file_id,
      status, reply_to_post_id, source_message_id
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT(user_id, source_message_id) WHERE source_message_id IS NOT NULL
    DO NOTHING
    RETURNING id
  `).bind(
    user.id,
    user.username ?? null,
    originalText,
    message?.caption ?? null,
    media.type,
    media.fileId,
    replyToPostId,
    Number.isSafeInteger(message?.message_id) ? message.message_id : null
  ).first();
  const postId = inserted?.id ?? (await env.CRASH_BOT_DB.prepare(`
    SELECT id FROM posts WHERE user_id = ? AND source_message_id = ?
  `).bind(user.id, message?.message_id).first())?.id;
  if (!postId) throw new Error("Could not store post");
  await clearPostConversation(env, user.id);
  return { id: postId, duplicate: !inserted?.id };
}

export async function handlePostConversation(env, message, userId) {
  const conversation = await env.CRASH_BOT_DB.prepare(`
    SELECT flow_type, entity_id FROM user_conversations WHERE user_id = ?
  `).bind(userId).first();
  if (!conversation || !["post", "reply"].includes(conversation.flow_type)) return false;
  if ([
    "/start", "/menu", "🏠 منوی اصلی", "⬅️ بازگشت", "🛠 پنل مدیریت",
    "👤 پنل کاربر", "💌 ثبت پست کراش", "✍️ شروع ثبت پست",
    "🤝 درخواست‌های ارتباط از کانال"
  ].includes(message.text?.trim())) {
    await clearPostConversation(env, userId);
    return false;
  }
  try {
    const submitted = await submitPost(
      env,
      { id: userId, username: message.from?.username ?? null },
      message,
      conversation.flow_type === "reply" ? conversation.entity_id : null
    );
    const queue = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM admin_queue
      WHERE item_id = ? AND item_type IN ('post', 'reply')
      ORDER BY id DESC LIMIT 1
    `).bind(submitted.id).first();
    if (queue?.id && !submitted.duplicate) {
      try {
        await notifyModerators(env, queue.id);
      } catch (error) {
        console.error("Could not notify moderators of a new post:", error);
      }
    }
  } catch (error) {
    const text = error.message === "Reply target is unavailable"
      ? "پیام اصلی دیگر برای پاسخ‌دادن در دسترس نیست."
      : "ثبت پیام انجام نشد. لطفاً متن یا رسانهٔ پشتیبانی‌شده بفرست.";
    await sendTelegram(env, message.chat.id, text);
    return true;
  }
  await sendTelegram(env, message.chat.id, "پیامت برای بررسی ثبت شد. نتیجه در بخش «ثبت کراش‌ها» نمایش داده می‌شود.");
  return true;
}

async function sendQueueCard(env, chatId, item, owner) {
  const senderDetail = owner
    ? `\nشناسهٔ تلگرام: ${item.sender_id}\nنام کاربری: ${item.sender_username ? `@${HTML(item.sender_username)}` : ""}`
    : "";
  const content = item.caption ?? item.content ?? "";
  const reply = item.reply_to_post_id
    ? `\nپاسخ به پیام داخلی #${item.reply_to_post_id}`
    : "";
  const text = `🆕 مورد صف مدیریت #${item.queue_id}\nنوع: ${item.reply_to_post_id ? "پاسخ" : (item.media_type ?? "متن")}\nدریافت: ${item.created_at} UTC${reply}${senderDetail}\n\n${HTML(content)}`;
  if (item.media_file_id) {
    await sendMediaTelegram(env, telegramMethod(item.media_type), {
      chat_id: chatId,
      [item.media_type === "photo" ? "photo" : item.media_type]: item.media_file_id,
      ...(!["sticker", "video_note"].includes(item.media_type) && content
        ? { caption: HTML(content.slice(0, 900)), parse_mode: "HTML" }
        : {})
    });
  }
  await sendInlineTelegram(env, chatId, text.slice(0, 4096), [[
    { text: "✅ تأیید", callback_data: `post:review:${item.queue_id}:approved` },
    { text: "❌ رد", callback_data: `post:review:${item.queue_id}:rejected` }
  ]], "HTML");
}

export async function notifyModerators(env, queueId) {
  const item = await env.CRASH_BOT_DB.prepare(`
    SELECT q.id AS queue_id, q.sender_id, p.sender_username, p.content, p.caption,
      p.media_type, p.media_file_id, p.reply_to_post_id, q.created_at
    FROM admin_queue q JOIN posts p ON p.id = q.item_id
    WHERE q.id = ? AND q.status = 'pending'
  `).bind(queueId).first();
  if (!item) return;
  const admins = await env.CRASH_BOT_DB.prepare(
    "SELECT user_id FROM admin_roles"
  ).all();
  const recipients = new Set([
    String(env.OWNER_TELEGRAM_ID),
    ...(admins.results ?? []).map((row) => String(row.user_id))
  ]);
  for (const recipient of recipients) {
    try {
      await sendQueueCard(env, recipient, item, recipient === String(env.OWNER_TELEGRAM_ID));
    } catch (error) {
      console.error("Could not notify a moderator about a queued post:", error);
    }
  }
}

async function loadQueueItem(env, queueId) {
  return env.CRASH_BOT_DB.prepare(`
    SELECT q.id AS queue_id, q.item_id, q.item_type, q.sender_id, q.status AS queue_status,
      q.created_at, p.user_id, p.content, p.caption, p.media_type, p.media_file_id,
      p.reply_to_post_id, p.status AS post_status, p.sender_username, p.channel_message_id
    FROM admin_queue q JOIN posts p ON p.id = q.item_id
    WHERE q.id = ?
  `).bind(queueId).first();
}

async function finalizeReview(env, queueId, actorId, decision) {
  const item = await loadQueueItem(env, queueId);
  if (!item || item.queue_status !== "pending" || item.post_status !== "pending") {
    return { status: "already_decided" };
  }
  let result;
  try {
    result = await env.CRASH_BOT_DB.prepare(`
      UPDATE admin_queue
      SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending'
      RETURNING id
    `).bind(decision, actorId, queueId).first();
  } catch (error) {
    if (String(error?.message ?? "").includes("no longer pending")) {
      return { status: "already_decided" };
    }
    throw error;
  }
  if (!result?.id) return { status: "already_decided" };
  if (decision === "approved") {
    const result = await publishApprovedPost(env, item.item_id, actorId);
    return { status: "approved", publication: result, item };
  }
  return { status: "rejected", item };
}

async function notifyPostDecision(env, item, decision, publication) {
  const decisionRow = await env.CRASH_BOT_DB.prepare(`
    SELECT id, decision FROM review_decisions WHERE queue_id = ?
  `).bind(item.queue_id).first();
  if (!decisionRow) throw new Error("Review event is unavailable");
  const operationBase = decision === "rejected" ? "post_rejected" : "post_approved";
  const eventKey = `post-review:${decisionRow.id}`;
  const operation = `${operationBase}:${decisionRow.id}`;
  const messageSnapshot = decision === "rejected"
    ? "پیام ثبت‌شدهٔ شما رد شد."
    : publication?.status === "sent"
      ? "پیام شما تأیید و در کانال منتشر شد."
      : "پیام شما تأیید شده است؛ وضعیت انتشار در سابقه قابل مشاهده است.";
  const notification = await enqueueNotification(env, {
    recipientId: item.user_id,
    operation,
    entityId: item.item_id,
    eventKey,
    messageSnapshot
  });
  await sendPendingNotification(env, notification, async (claimed) => {
    const token = await createDeepLinkToken(
      env, "post_history", claimed.entity_id, claimed.recipient_id
    );
    const username = await botUsername(env);
    const result = await sendInlineTelegramDetailed(
      env, claimed.recipient_id, claimed.message_snapshot, [[username ? {
        text: "مشاهدهٔ سابقه",
        url: `https://t.me/${username}?start=${token}`
      } : {
        text: "مشاهدهٔ سابقه",
        callback_data: `post:history:${claimed.entity_id}`
      }]]
    );
    return result.outcome;
  });
}

export async function deliverPostOutboxNotification(env, outbox, publication = null) {
  if (!outbox || !outbox.operation_type.startsWith("post_") ||
      !outbox.message_snapshot) {
    return false;
  }
  const post = await env.CRASH_BOT_DB.prepare(`
    SELECT status, user_id FROM posts WHERE id = ?
  `).bind(outbox.entity_id).first();
  if (!post || String(post.user_id) !== String(outbox.recipient_id)) return false;
  const token = await createDeepLinkToken(
    env, "post_history", outbox.entity_id, outbox.recipient_id
  );
  const username = await botUsername(env);
  const result = await sendInlineTelegramDetailed(env, outbox.recipient_id, outbox.message_snapshot, [[
    username ? {
      text: "مشاهدهٔ سابقه",
      url: `https://t.me/${username}?start=${token}`
    } : {
      text: "مشاهدهٔ سابقه",
      callback_data: `post:history:${outbox.entity_id}`
    }
  ]]);
  return result.outcome;
}

export async function handlePostCallback(env, query) {
  const match = /^post:(review|confirm|repost|repost-confirm|cancel|recover|retry):(\d+)(?::(approved|rejected))?$/.exec(
    query.data ?? ""
  );
  if (!match) return false;
  const [, action, rawId, decision] = match;
  const actorId = query.from?.id;
  if (!actorId || String(query.message?.chat?.id) !== String(actorId)) {
    await answerCallbackQuery(env, query.id, "این عملیات فقط در گفت‌وگوی خصوصی ربات در دسترس است.");
    return true;
  }
  const role = await getUserRole(env, actorId);
  if (!canAccess(role, "moderation")) {
    await answerCallbackQuery(env, query.id, "دسترسی مدیریت ندارید.");
    return true;
  }
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    await answerCallbackQuery(env, query.id, "درخواست معتبر نیست.");
    return true;
  }
  if (action === "review") {
    if (!["approved", "rejected"].includes(decision)) {
      await answerCallbackQuery(env, query.id, "انتخاب معتبر نیست.");
      return true;
    }
    const item = await loadQueueItem(env, id);
    if (!item || item.queue_status !== "pending") {
      await answerCallbackQuery(env, query.id, "این مورد قبلاً بررسی شده است.");
      return true;
    }
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO moderation_confirmations (actor_id, queue_id, decision, expires_at)
      VALUES (?, ?, ?, datetime('now', '+10 minutes'))
      ON CONFLICT(actor_id, queue_id) DO UPDATE SET
        decision = excluded.decision,
        expires_at = excluded.expires_at
    `).bind(actorId, id, decision).run();
    await editInlineTelegram(env, query.message.chat.id, query.message.message_id,
      `آیا از ${decision === "approved" ? "تأیید" : "رد"} مورد #${id} مطمئن هستی؟`, [[
        { text: "✅ بله، نهایی کن", callback_data: `post:confirm:${id}:${decision}` },
        { text: "لغو", callback_data: `post:cancel:${id}` }
      ]]);
    await answerCallbackQuery(env, query.id);
    return true;
  }
  if (action === "cancel") {
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM moderation_confirmations WHERE actor_id = ? AND queue_id = ?
    `).bind(actorId, id).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM owner_repost_confirmations WHERE actor_id = ? AND post_id = ?
    `).bind(actorId, id).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM owner_publication_confirmations WHERE actor_id = ? AND post_id = ?
    `).bind(actorId, id).run();
    await editInlineTelegram(env, query.message.chat.id, query.message.message_id,
      `بررسی مورد #${id} لغو شد.`, []);
    await answerCallbackQuery(env, query.id, "لغو شد.");
    return true;
  }
  if (action === "confirm") {
    if (!["approved", "rejected"].includes(decision)) {
      await answerCallbackQuery(env, query.id, "درخواست معتبر نیست.");
      return true;
    }
    const confirmation = await env.CRASH_BOT_DB.prepare(`
      SELECT decision FROM moderation_confirmations
      WHERE actor_id = ? AND queue_id = ? AND decision = ?
        AND expires_at > CURRENT_TIMESTAMP
    `).bind(actorId, id, decision).first();
    if (!confirmation) {
      await answerCallbackQuery(env, query.id, "تأیید منقضی یا برای مدیر دیگری صادر شده است.");
      return true;
    }
    const result = await finalizeReview(env, id, actorId, decision);
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM moderation_confirmations WHERE actor_id = ? AND queue_id = ?
    `).bind(actorId, id).run();
    if (result.status === "already_decided") {
      await answerCallbackQuery(env, query.id, "این مورد توسط مدیر دیگری بررسی شده است.");
      return true;
    }
    await answerCallbackQuery(env, query.id,
      result.publication?.status === "sent" ? "پیام تأیید و منتشر شد." :
        result.status === "rejected" ? "پیام رد شد." : "تأیید ثبت شد؛ انتشار نیاز به بررسی دارد.");
    await notifyPostDecision(
      env, result.item, result.status, result.publication
    );
    await editInlineTelegram(env, query.message.chat.id, query.message.message_id,
      result.status === "rejected" ? `مورد #${id} رد شد.` :
        result.publication?.status === "sent" ? `مورد #${id} منتشر شد.` :
          `مورد #${id} تأیید شد؛ نتیجهٔ انتشار: ${result.publication?.status ?? "نامشخص"}.`);
    return true;
  }
  if (action === "recover") {
    if (role !== "owner") {
      await answerCallbackQuery(env, query.id, "این عملیات فقط برای مالک فعال است.");
      return true;
    }
    const job = await env.CRASH_BOT_DB.prepare(`
      SELECT status FROM publication_jobs WHERE item_id = ?
      ORDER BY id DESC LIMIT 1
    `).bind(id).first();
    if (!["failed", "unknown"].includes(job?.status)) {
      await answerCallbackQuery(env, query.id, "این انتشار نیاز به بازیابی ندارد.");
      return true;
    }
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO owner_publication_confirmations (actor_id, post_id, expires_at)
      VALUES (?, ?, datetime('now', '+10 minutes'))
      ON CONFLICT(actor_id, post_id) DO UPDATE SET expires_at = excluded.expires_at
    `).bind(actorId, id).run();
    await editInlineTelegram(env, query.message.chat.id, query.message.message_id,
      `وضعیت فعلی انتشار «${job.status}» است. فقط پس از بررسی کانال و اطمینان از نبود پست، تلاش دوباره را تأیید کن.`, [[
        { text: "تأیید بررسی و تلاش دوباره", callback_data: `post:retry:${id}` },
        { text: "لغو", callback_data: `post:cancel:${id}` }
      ]]);
    await answerCallbackQuery(env, query.id);
    return true;
  }
  if (action === "retry") {
    if (role !== "owner") {
      await answerCallbackQuery(env, query.id, "این عملیات فقط برای مالک فعال است.");
      return true;
    }
    const confirmation = await env.CRASH_BOT_DB.prepare(`
      SELECT post_id FROM owner_publication_confirmations
      WHERE actor_id = ? AND post_id = ? AND expires_at > CURRENT_TIMESTAMP
    `).bind(actorId, id).first();
    if (!confirmation) {
      await answerCallbackQuery(env, query.id, "تأیید بازیابی منقضی یا برای مالک دیگری صادر شده است.");
      return true;
    }
    const post = await env.CRASH_BOT_DB.prepare(
      "SELECT status FROM posts WHERE id = ?"
    ).bind(id).first();
    if (post?.status !== "approved") {
      await env.CRASH_BOT_DB.prepare(`
        DELETE FROM owner_publication_confirmations WHERE actor_id = ? AND post_id = ?
      `).bind(actorId, id).run();
      await answerCallbackQuery(env, query.id, "فقط پیام تأییدشده قابل بازیابی است.");
      return true;
    }
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM owner_publication_confirmations WHERE actor_id = ? AND post_id = ?
    `).bind(actorId, id).run();
    const result = await publishApprovedPost(env, id, actorId, true);
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO post_events (post_id, actor_id, event_type, details)
      VALUES (?, ?, 'publish_reconciled', ?)
    `).bind(id, actorId,
      `Owner-authorized retry after manual channel review; result=${result.status}`).run();
    await answerCallbackQuery(env, query.id,
      result.status === "sent" ? "انتشار موفق شد." : `نتیجهٔ انتشار: ${result.status}`);
    await editInlineTelegram(env, query.message.chat.id, query.message.message_id,
      `نتیجهٔ تلاش کنترل‌شده برای پیام #${id}: ${result.status}`, []);
    return true;
  }
  if (action === "repost") {
    if (role !== "owner") {
      await answerCallbackQuery(env, query.id, "این عملیات فقط برای مالک فعال است.");
      return true;
    }
    const post = await env.CRASH_BOT_DB.prepare(
      "SELECT status FROM posts WHERE id = ?"
    ).bind(id).first();
    if (!post || post.status !== "rejected") {
      await answerCallbackQuery(env, query.id, "فقط پیام ردشده قابل انتشار مجدد است.");
      return true;
    }
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO owner_repost_confirmations (actor_id, post_id, expires_at)
      VALUES (?, ?, datetime('now', '+10 minutes'))
      ON CONFLICT(actor_id, post_id) DO UPDATE SET expires_at = excluded.expires_at
    `).bind(actorId, id).run();
    await editInlineTelegram(env, query.message.chat.id, query.message.message_id,
      `انتشار مجدد پیام #${id} با متن اصلی و حفظ سابقهٔ رد قبلی؟`, [[
        { text: "✅ تأیید انتشار مجدد", callback_data: `post:repost-confirm:${id}` },
        { text: "لغو", callback_data: `post:cancel:${id}` }
      ]]);
    await answerCallbackQuery(env, query.id);
    return true;
  }
  if (action === "repost-confirm") {
    if (role !== "owner") {
      await answerCallbackQuery(env, query.id, "این عملیات فقط برای مالک فعال است.");
      return true;
    }
    const confirmation = await env.CRASH_BOT_DB.prepare(`
      SELECT post_id FROM owner_repost_confirmations
      WHERE actor_id = ? AND post_id = ? AND expires_at > CURRENT_TIMESTAMP
    `).bind(actorId, id).first();
    if (!confirmation) {
      await answerCallbackQuery(env, query.id, "تأیید انتشار مجدد منقضی شده است.");
      return true;
    }
    const result = await env.CRASH_BOT_DB.prepare(`
      UPDATE posts SET status = 'pending', reviewed_at = NULL, reviewed_by = NULL
      WHERE id = ? AND status = 'rejected'
      RETURNING id
    `).bind(id).first();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM owner_repost_confirmations WHERE actor_id = ? AND post_id = ?
    `).bind(actorId, id).run();
    if (!result?.id) {
      await answerCallbackQuery(env, query.id, "این پیام قبلاً برای بررسی دوباره ارسال شده است.");
      return true;
    }
    await env.CRASH_BOT_DB.prepare(`
      UPDATE post_events SET actor_id = ?
      WHERE id = (
        SELECT MAX(id) FROM post_events
        WHERE post_id = ? AND event_type = 'repost_queued' AND actor_id IS NULL
      )
    `).bind(actorId, id).run();
    const itemType = (await env.CRASH_BOT_DB.prepare(
      "SELECT reply_to_post_id FROM posts WHERE id = ?"
    ).bind(id).first())?.reply_to_post_id ? "reply" : "post";
    const queue = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM admin_queue WHERE item_id = ? AND item_type = ?
        AND status = 'pending' ORDER BY id DESC LIMIT 1
    `).bind(id, itemType).first();
    if (!queue?.id) {
      await answerCallbackQuery(env, query.id, "مورد به صف بررسی وارد نشد؛ وضعیت را بررسی کن.");
      return true;
    }
    await notifyModerators(env, queue.id);
    await answerCallbackQuery(env, query.id, "برای بررسی دوباره به صف رفت.");
    await editInlineTelegram(env, query.message.chat.id, query.message.message_id,
      `پیام #${id} با متن اصلی دوباره به صف بررسی رفت.`, []);
    return true;
  }
  return false;
}

export async function handlePostHistoryCallback(env, query) {
  const match = /^post:history:(\d+)$/.exec(query.data ?? "");
  if (!match) return false;
  if (String(query.message?.chat?.id) !== String(query.from?.id)) {
    await answerCallbackQuery(env, query.id, "این سابقه فقط در گفت‌وگوی خصوصی ربات در دسترس است.");
    return true;
  }
  const postId = Number(match[1]);
  const role = await getUserRole(env, query.from?.id);
  const post = await env.CRASH_BOT_DB.prepare(`
    SELECT id, user_id, content, caption, media_type, media_file_id, status, created_at,
    reviewed_at, reviewed_by, admin_note, sender_username, channel_message_id
  FROM posts WHERE id = ?
  `).bind(postId).first();
  const owner = role === "owner";
  if (!post || (
    !canAccess(role, "message_archive") &&
    String(post.user_id) !== String(query.from?.id)
  )) {
    await answerCallbackQuery(env, query.id, "این سابقه در دسترس نیست.");
    return true;
  }
  const job = await env.CRASH_BOT_DB.prepare(`
    SELECT status, last_error FROM publication_jobs
    WHERE item_id = ? AND item_type = (
      SELECT CASE WHEN reply_to_post_id IS NULL THEN 'post' ELSE 'reply' END
      FROM posts WHERE id = ?
    ) ORDER BY id DESC LIMIT 1
  `).bind(postId, postId).first();
  await answerCallbackQuery(env, query.id);
  if (post.media_file_id) await sendStoredMedia(env, query.message.chat.id, post);
  await sendTelegram(env, query.message.chat.id,
    `🗂 سابقهٔ ثبت کراش #${post.id}\nوضعیت مدیریتی: ${post.status}\nنتیجهٔ انتشار: ${job?.status ?? "ثبت نشده"}\nتاریخ دریافت: ${post.created_at} UTC\nتاریخ اقدام: ${post.reviewed_at ? `${post.reviewed_at} UTC` : "—"}${owner ? `\nفرستنده: ${post.user_id}\nنام کاربری: ${post.sender_username ? `@${post.sender_username}` : ""}\nمدیر اقدام‌کننده: ${post.reviewed_by ?? ""}\nشناسهٔ پیام کانال: ${post.channel_message_id ?? ""}` : ""}${post.admin_note ? `\nتوضیح مدیر: ${post.admin_note}` : ""}\n\n${post.caption ?? post.content}`);
  if (post.status === "rejected" && owner) {
    await sendInlineTelegram(env, query.message.chat.id, "گزینه‌های مالک:", [[{
      text: "انتشار مجدد",
      callback_data: `post:repost:${post.id}`
    }]]);
  }
  return true;
}

export async function renderPendingQueue(env, chatId) {
  const rows = await env.CRASH_BOT_DB.prepare(`
    SELECT q.id AS queue_id, q.sender_id, p.sender_username, p.content, p.caption,
      p.media_type, p.media_file_id, p.reply_to_post_id, q.created_at
    FROM admin_queue q JOIN posts p ON p.id = q.item_id
    WHERE q.status = 'pending'
    ORDER BY q.created_at ASC, q.id ASC LIMIT 10
  `).all();
  const items = rows.results ?? [];
  if (!items.length) {
    await sendTelegram(env, chatId, "صف بررسی خالی است.");
    return;
  }
  for (const item of items) {
    const owner = String(chatId) === String(env.OWNER_TELEGRAM_ID);
    await sendQueueCard(env, chatId, item, owner);
  }
}

const ARCHIVE_PAGE_SIZE = 10;
const PERSIAN_MONTH_NAMES = [
  "فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
  "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"
];
const archiveDateFormatter = new Intl.DateTimeFormat(
  "fa-IR-u-ca-persian-nu-latn",
  {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Tehran"
  }
);

function formatArchiveDate(value) {
  const utc = new Date(`${String(value).replace(" ", "T")}Z`);
  if (Number.isNaN(utc.getTime())) return String(value);
  return archiveDateFormatter.format(utc);
}

async function archiveRole(env, actorId, chatId) {
  if (!actorId || String(actorId) !== String(chatId)) return null;
  const role = await getUserRole(env, actorId);
  return canAccess(role, "message_archive") ? role : null;
}

async function renderArchiveYears(env, chatId, actorId) {
  const role = await archiveRole(env, actorId, chatId);
  if (!role) {
    await sendTelegram(env, chatId, "برای دسترسی به آرشیو مجوز مدیریت لازم است.");
    return;
  }
  const currentYear = getCurrentPersianYear();
  const storedYears = await env.CRASH_BOT_DB.prepare(`
    SELECT DISTINCT CAST(substr(created_at, 1, 4) AS INTEGER) AS year
    FROM posts ORDER BY year DESC LIMIT 30
  `).all();
  const years = new Set([currentYear]);
  for (const row of storedYears.results ?? []) {
    years.add(Number(row.year) - 621);
    years.add(Number(row.year) - 622);
  }
  const validYears = [...years]
    .filter((year) => Number.isInteger(year) && year >= 1300 && year <= currentYear)
    .sort((left, right) => right - left);
  const rows = [];
  for (let index = 0; index < validYears.length; index += 2) {
    rows.push(validYears.slice(index, index + 2).map((year) => ({
      text: `📅 سال ${year}`,
      callback_data: `archive:year:${year}`
    })));
  }
  rows.push([{ text: "🗂 آرشیو کلی", callback_data: "archive:all:0" }]);
  await sendInlineTelegram(env, chatId, "🗂 سال آرشیو را انتخاب کن.", rows);
}

async function renderArchiveMonths(env, chatId, actorId, year) {
  const role = await archiveRole(env, actorId, chatId);
  if (!role || !Number.isInteger(year) ||
      year < 1300 || year > getCurrentPersianYear()) {
    await sendTelegram(env, chatId, "سال آرشیو نامعتبر است یا دسترسی ندارید.");
    return;
  }
  const rows = [];
  for (let month = 1; month <= 12; month += 3) {
    rows.push([month, month + 1, month + 2].map((value) => ({
      text: PERSIAN_MONTH_NAMES[value - 1],
      callback_data: `archive:month:${year}:${value}:0`
    })));
  }
  rows.push([{ text: "↩️ انتخاب سال", callback_data: "archive:years" }]);
  rows.push([{ text: "🗂 آرشیو کلی", callback_data: "archive:all:0" }]);
  await sendInlineTelegram(env, chatId, `🗂 سال ${year} · ماه را انتخاب کن.`, rows);
}

async function renderArchivePage(env, chatId, actorId, period, page) {
  const role = await archiveRole(env, actorId, chatId);
  if (!role) {
    await sendTelegram(env, chatId, "برای دسترسی به آرشیو مجوز مدیریت لازم است.");
    return;
  }
  if (!Number.isSafeInteger(page) || page < 0 || page > 100000) {
    await sendTelegram(env, chatId, "شمارهٔ صفحهٔ آرشیو معتبر نیست.");
    return;
  }
  const conditions = [];
  const bindings = [];
  if (period) {
    let range;
    try {
      range = getPersianMonthRange(period.year, period.month);
    } catch {
      await sendTelegram(env, chatId, "ماه یا سال آرشیو معتبر نیست.");
      return;
    }
    conditions.push("p.created_at >= ? AND p.created_at < ?");
    bindings.push(range.start, range.end);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const total = Number((await env.CRASH_BOT_DB.prepare(`
    SELECT COUNT(*) AS count FROM posts p ${where}
  `).bind(...bindings).first())?.count ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / ARCHIVE_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const posts = await env.CRASH_BOT_DB.prepare(`
    SELECT p.id, p.content, p.caption, p.media_type, p.media_file_id,
      p.status, p.created_at, p.reviewed_at, p.reply_to_post_id,
      j.status AS publication_status
    FROM posts p
    LEFT JOIN publication_jobs j ON j.item_id = p.id
      AND j.item_type = CASE WHEN p.reply_to_post_id IS NULL THEN 'post' ELSE 'reply' END
    ${where}
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT ? OFFSET ?
  `).bind(...bindings, ARCHIVE_PAGE_SIZE, currentPage * ARCHIVE_PAGE_SIZE).all();
  const items = posts.results ?? [];
  for (const post of items) {
    if (post.media_file_id) await sendStoredMedia(env, chatId, post);
  }
  const periodLabel = period
    ? `${PERSIAN_MONTH_NAMES[period.month - 1]} ${period.year}`
    : "کلی";
  const lines = items.length
    ? items.map((post) => {
      const excerpt = String(post.caption ?? post.content ?? "")
        .replace(/\s+/g, " ").slice(0, 130);
      const kind = post.reply_to_post_id ? `پاسخ به #${post.reply_to_post_id}` :
        (post.media_type ? `رسانه: ${post.media_type}` : "متن");
      return `#${post.id} · ${post.status} · انتشار: ${post.publication_status ?? "ثبت‌نشده"}\n${formatArchiveDate(post.created_at)} · ${kind}\n${excerpt}`;
    })
    : ["در این بازه پیامی ثبت نشده است."];
  const keyboard = items.map((post) => {
    const actions = [{
      text: `جزئیات و سابقهٔ #${post.id}`,
      callback_data: `post:history:${post.id}`
    }];
    if (role === "owner" && post.status === "rejected") {
      actions.push({
        text: "انتشار مجدد",
        callback_data: `post:repost:${post.id}`
      });
    }
    if (role === "owner" && post.status === "approved" &&
        ["failed", "unknown"].includes(post.publication_status)) {
      actions.push({
        text: "بازیابی انتشار",
        callback_data: `post:recover:${post.id}`
      });
    }
    return actions;
  });
  if (currentPage > 0 || currentPage + 1 < pageCount) {
    const navigation = [];
    if (currentPage > 0) {
      navigation.push({
        text: "صفحهٔ قبلی",
        callback_data: period
          ? `archive:month:${period.year}:${period.month}:${currentPage - 1}`
          : `archive:all:${currentPage - 1}`
      });
    }
    if (currentPage + 1 < pageCount) {
      navigation.push({
        text: "صفحهٔ بعدی",
        callback_data: period
          ? `archive:month:${period.year}:${period.month}:${currentPage + 1}`
          : `archive:all:${currentPage + 1}`
      });
    }
    keyboard.push(navigation);
  }
  if (period) {
    keyboard.push([{ text: "↩️ انتخاب ماه", callback_data: `archive:year:${period.year}` }]);
  }
  keyboard.push([{ text: "↩️ انتخاب سال", callback_data: "archive:years" }]);
  keyboard.push([{ text: "🗂 آرشیو کلی", callback_data: "archive:all:0" }]);
  await sendInlineTelegram(
    env,
    chatId,
    `🗂 آرشیو ${periodLabel} · ${total} مورد · صفحه ${currentPage + 1}/${pageCount}\n\n${lines.join("\n\n")}`.slice(0, 4096),
    keyboard
  );
}

export async function renderPostArchive(env, chatId, actorId) {
  if (!(await archiveRole(env, actorId, chatId))) {
    await sendTelegram(env, chatId, "برای دسترسی به آرشیو مجوز مدیریت لازم است.");
    return;
  }
  await markStalePublicationJobs(env);
  await renderArchiveYears(env, chatId, actorId);
}

export async function handleArchiveCallback(env, query) {
  const data = query?.data ?? "";
  if (!data.startsWith("archive:")) return false;
  const actorId = query.from?.id;
  const chatId = query.message?.chat?.id;
  if (query.message?.chat?.type !== "private" ||
      String(actorId) !== String(chatId)) {
    await answerCallbackQuery(env, query.id, "این آرشیو فقط در گفت‌وگوی خصوصی مدیر در دسترس است.");
    return true;
  }
  const role = await archiveRole(env, actorId, chatId);
  if (!role) {
    await answerCallbackQuery(env, query.id, "برای دسترسی به آرشیو مجوز مدیریت لازم است.");
    return true;
  }
  if (data === "archive:years") {
    await answerCallbackQuery(env, query.id);
    await renderArchiveYears(env, chatId, actorId);
    return true;
  }
  const yearMatch = /^archive:year:(\d{4})$/.exec(data);
  if (yearMatch) {
    await answerCallbackQuery(env, query.id);
    await renderArchiveMonths(env, chatId, actorId, Number(yearMatch[1]));
    return true;
  }
  const allMatch = /^archive:all:(\d+)$/.exec(data);
  if (allMatch) {
    await answerCallbackQuery(env, query.id);
    await renderArchivePage(env, chatId, actorId, null, Number(allMatch[1]));
    return true;
  }
  const monthMatch = /^archive:month:(\d{4}):(\d{1,2}):(\d+)$/.exec(data);
  if (monthMatch) {
    await answerCallbackQuery(env, query.id);
    await renderArchivePage(env, chatId, actorId, {
      year: Number(monthMatch[1]),
      month: Number(monthMatch[2])
    }, Number(monthMatch[3]));
    return true;
  }
  await answerCallbackQuery(env, query.id, "درخواست آرشیو معتبر نیست.");
  return true;
}

export async function listUserPosts(env, userId, chatId) {
  const rows = await env.CRASH_BOT_DB.prepare(`
    SELECT p.id, p.content, p.caption, p.media_type, p.media_file_id,
      p.status, p.created_at, j.status AS publication_status
    FROM posts p LEFT JOIN publication_jobs j ON j.item_id = p.id
    AND j.item_type = CASE WHEN p.reply_to_post_id IS NULL THEN 'post' ELSE 'reply' END
    WHERE p.user_id = ? ORDER BY p.created_at DESC, p.id DESC LIMIT 30
  `).bind(userId).all();
  if (!rows.results?.length) {
    await sendTelegram(env, chatId, "هنوز موردی برای نمایش در سابقهٔ شما ثبت نشده است.");
    return;
  }
  for (const post of rows.results) {
    if (post.media_file_id) await sendStoredMedia(env, chatId, post);
    await sendInlineTelegram(env, chatId,
      `#${post.id} · وضعیت: ${post.status} · انتشار: ${post.publication_status ?? "ثبت‌نشده"}\n${post.created_at}\n\n${post.caption ?? post.content}`,
      [[{ text: "جزئیات", callback_data: `post:history:${post.id}` }]]);
  }
}

export function escapeHtml(value) {
  return HTML(value);
}
