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
    if (item?.file_id) return { type, method, fileId: item.file_id };
  }
  return null;
}

export function conversationMessageControls(message, actorId, {
  namespace = "anon",
  includeView = false,
  includeHistory = false,
  historyPage = 0
} = {}) {
  const blocked = message.visibility_status === "blocked";
  const isSender = String(message.sender_id) === String(actorId);
  if (message.blocked_by && !blocked) return null;

  const buttons = [];
  if (includeView && !isSender &&
      (blocked || message.view_delivery_status !== "sent")) {
    buttons.push([{
      text: blocked ? "🔓 خروج از بلاک و مشاهده" : "👁 مشاهده پیام",
      callback_data: `${namespace}:${blocked ? "unblock_view" : "view"}:${message.id}`
    }]);
  }
  if (!blocked) {
    buttons.push([{
      text: namespace === "ad" ? "↩️ پاسخ" : "↩️ پاسخ به پیام",
      callback_data: `${namespace}:reply:${message.id}`
    }, {
      text: namespace === "ad" ? "🚫 بلاک" : "🚫 مسدود کردن گفت‌وگو",
      callback_data: `${namespace}:block:${message.id}`
    }]);
  }
  if (includeHistory) {
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
