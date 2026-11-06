import {
  sendInlineTelegramDetailed,
  sendMediaTelegramDetailed,
  sendMessageTelegramDetailed
} from "../telegram/api.js";

export const CONVERSATION_MEDIA_METHODS = {
  photo: "sendPhoto",
  video: "sendVideo",
  document: "sendDocument",
  audio: "sendAudio",
  voice: "sendVoice",
  animation: "sendAnimation",
  video_note: "sendVideoNote",
  sticker: "sendSticker"
};

export function conversationMediaFromMessage(message) {
  for (const [type, method] of Object.entries(CONVERSATION_MEDIA_METHODS)) {
    const value = message?.[type];
    const item = Array.isArray(value) ? value.at(-1) : value;
    if (typeof item?.file_id === "string" && item.file_id.trim()) {
      return { type, method, fileId: item.file_id };
    }
  }
  return null;
}

export function isPrivateConversationMessage(message, userId) {
  return Number.isSafeInteger(userId) && userId > 0 &&
    Number.isSafeInteger(message?.from?.id) &&
    String(message.from.id) === String(userId) &&
    message?.chat?.type === "private" &&
    String(message.chat.id) === String(userId) &&
    Number.isSafeInteger(message?.message_id) &&
    message.message_id > 0;
}

export function isBotCommand(message) {
  return /^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?(?:\s|$)/
    .test(String(message?.text ?? message?.caption ?? "").trim());
}

export function conversationMessageControls(message, actorId, {
  namespace = "anon",
  includeView = false,
  includeHistory = false,
  historyPage = 0,
  blockedByViewer = false,
  blockedByOther = false
} = {}) {
  const blocked = message.visibility_status === "blocked";
  const isSender = String(message.sender_id) === String(actorId);
  if (message.blocked_by) {
    blockedByViewer = String(message.blocked_by) === String(actorId);
    blockedByOther = !blockedByViewer;
  }
  if (blockedByOther && !blocked) return null;

  const buttons = [];
  if (includeView && !isSender &&
      (blocked || message.view_delivery_status !== "sent")) {
    buttons.push([{
      text: blocked ? "رفع بلاک و مشاهده پیام" : "👁 مشاهده پیام",
      callback_data: `${namespace}:${blocked ? "unblock_view" : "view"}:${message.id}`
    }]);
  }
  if (!blocked && !blockedByOther) {
    if (blockedByViewer) {
      buttons.push([{
        text: "🔓 رفع بلاک",
        callback_data: `${namespace}:unblock:${message.id}`
      }]);
    } else {
      buttons.push([{
        text: namespace === "ad" ? "↩️ پاسخ" : "↩️ پاسخ به پیام",
        callback_data: `${namespace}:reply:${message.id}`
      }, {
        text: namespace === "ad" ? "🚫 بلاک" : "🚫 مسدود کردن گفت‌وگو",
        callback_data: `${namespace}:block:${message.id}`
      }]);
    }
  }
  if (includeHistory && (namespace === "ad" || message.source_type === "connection")) {
    buttons.push([{
      text: namespace === "ad" ? "📜 تاریخچه چت" : "📜 تازه‌سازی همین تاریخچه",
      callback_data: `${namespace}:history:${message.id}:${historyPage}`
    }]);
  }
  return buttons.length ? buttons : null;
}

export async function deliverClaimedConversationMessage({
  deliver,
  settle,
  label = "conversation message"
}) {
  let result;
  try {
    result = await deliver();
  } catch (error) {
    console.error(`Could not deliver ${label}:`, error?.name ?? "unknown error");
    result = { outcome: "unknown" };
  }
  const status = result?.outcome === "sent"
    ? "sent"
    : result?.outcome === "rejected" ? "failed" : "unknown";
  await settle(status, result);
  return { status, result };
}

export async function sendConversationContent(env, chatId, {
  text,
  mediaType = null,
  mediaFileId = null,
  caption = null,
  inlineKeyboard = null
}) {
  if (!mediaType || !mediaFileId) {
    return inlineKeyboard
      ? sendInlineTelegramDetailed(env, chatId, text, inlineKeyboard)
      : sendMessageTelegramDetailed(env, chatId, text);
  }

  const method = CONVERSATION_MEDIA_METHODS[mediaType];
  if (!method) return { outcome: "rejected" };

  const noCaption = ["sticker", "video_note"].includes(mediaType);
  let headerMessageId = null;
  if (noCaption && text) {
    const header = await sendMessageTelegramDetailed(env, chatId, text);
    if (header.outcome !== "sent") return header;
    headerMessageId = header.messageId;
  }
  const mediaCaption = noCaption
    ? null
    : [text, caption].filter(Boolean).join("\n").slice(0, 1024);
  const result = await sendMediaTelegramDetailed(env, method, {
    chat_id: chatId,
    [mediaType]: mediaFileId,
    ...(inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {}),
    ...(mediaCaption ? { caption: mediaCaption } : {})
  });
  return headerMessageId
    ? { ...result, messageIds: [headerMessageId, result.messageId].filter(Boolean) }
    : result;
}

export async function sendConversationReadReceipt(
  env, senderId, sourceMessageId, text = "✅ پیام شما خوانده شد."
) {
  if (!Number.isSafeInteger(sourceMessageId) || sourceMessageId <= 0) {
    return sendMessageTelegramDetailed(env, senderId, text);
  }
  const reply = await sendMessageTelegramDetailed(
    env, senderId, text, null, sourceMessageId
  );
  if (reply.outcome !== "rejected") return reply;
  return sendMessageTelegramDetailed(
    env, senderId, `${text}\nپیام اصلی: #${sourceMessageId}`
  );
}
