import {
  answerCallbackQuery,
  editInlineTelegram,
  sendInlineTelegram,
  sendTelegram
} from "../telegram/api.js";
import { deliverConnectionOutboxNotification } from "./connections.js";
import { deliverPostOutboxNotification } from "./posts.js";

const STALE_SENDING_MINUTES = 15;

function newClaimToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function markStaleSending(env, notificationId = null) {
  const idClause = notificationId === null ? "" : "AND id = ?";
  const statement = env.CRASH_BOT_DB.prepare(`
    UPDATE notification_outbox
    SET status = 'unknown', claim_token = NULL,
      last_error = 'Previous delivery attempt did not finish; outcome is unknown',
      updated_at = CURRENT_TIMESTAMP
    WHERE status = 'sending'
      AND updated_at <= datetime('now', '-${STALE_SENDING_MINUTES} minutes')
      ${idClause}
  `);
  if (notificationId === null) await statement.run();
  else await statement.bind(notificationId).run();
}

export async function renderNotificationOutbox(env, actorId, chatId) {
  if (String(actorId) !== String(env.OWNER_TELEGRAM_ID)) {
    await sendTelegram(env, chatId, "این بخش فقط برای مالک اصلی در دسترس است.");
    return;
  }
  await markStaleSending(env);
  const result = await env.CRASH_BOT_DB.prepare(`
    SELECT id, operation_type, event_key, message_snapshot, status, attempts,
      created_at, updated_at
    FROM notification_outbox
    WHERE status IN ('pending', 'failed', 'unknown', 'sending')
    ORDER BY created_at ASC, id ASC LIMIT 30
  `).all();
  if (!result.results?.length) {
    await sendTelegram(env, chatId, "اعلان نیازمند بررسی وجود ندارد.");
    return;
  }
  for (const item of result.results) {
    const legacyPostNotification = item.operation_type.startsWith("post_") &&
      (!item.message_snapshot || item.event_key?.startsWith("legacy:"));
    const retryable = ["pending", "failed", "unknown"].includes(item.status) &&
      !legacyPostNotification;
    const note = legacyPostNotification
      ? "\nرخداد قدیمی فاقد متن/شناسهٔ قابل اتکاست؛ retry خودکار غیرفعال است."
      : "";
    await sendInlineTelegram(
      env,
      chatId,
      `اعلان #${item.id} · ${item.operation_type}\nوضعیت: ${item.status} · تلاش‌ها: ${item.attempts}\nایجاد: ${item.created_at} UTC · آخرین تغییر: ${item.updated_at} UTC${note}`,
      retryable ? [[{
        text: item.status === "unknown"
          ? "بررسی و تلاش دوباره (ممکن است تکراری شود)"
          : item.status === "pending" ? "بررسی و ارسال کنترل‌شده" : "تلاش دوباره",
        callback_data: `notification:retry:${item.id}`
      }]] : []
    );
  }
}

export async function handleNotificationCallback(env, query) {
  const data = query.data ?? "";
  if (!/^notifications?:/.test(data)) return false;
  const actorId = query.from?.id;
  if (!actorId || String(actorId) !== String(env.OWNER_TELEGRAM_ID)) {
    await answerCallbackQuery(env, query.id, "این عملیات فقط برای مالک اصلی فعال است.");
    return true;
  }
  if (String(query.message?.chat?.id) !== String(actorId)) {
    await answerCallbackQuery(env, query.id, "این عملیات فقط در گفت‌وگوی خصوصی ربات در دسترس است.");
    return true;
  }
  if (data === "notifications:list") {
    await answerCallbackQuery(env, query.id);
    await renderNotificationOutbox(env, actorId, query.message.chat.id);
    return true;
  }
  const match = /^notification:(retry|confirm|cancel):(\d+)$/.exec(data);
  if (!match) {
    await answerCallbackQuery(env, query.id, "درخواست معتبر نیست.");
    return true;
  }
  const [, action, idText] = match;
  const id = Number(idText);
  if (!Number.isSafeInteger(id) || id <= 0) {
    await answerCallbackQuery(env, query.id, "شناسهٔ اعلان معتبر نیست.");
    return true;
  }
  if (action === "cancel") {
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM notification_retry_confirmations
      WHERE actor_id = ? AND notification_id = ?
    `).bind(actorId, id).run();
    await editInlineTelegram(env, query.message.chat.id, query.message.message_id,
      `تلاش دوباره برای اعلان #${id} لغو شد.`, []);
    await answerCallbackQuery(env, query.id, "لغو شد.");
    return true;
  }
  if (action === "retry") {
    await markStaleSending(env, id);
    const row = await env.CRASH_BOT_DB.prepare(`
      SELECT status, operation_type, event_key, message_snapshot
      FROM notification_outbox WHERE id = ?
    `).bind(id).first();
    if (!row || !["pending", "failed", "unknown"].includes(row.status)) {
      await answerCallbackQuery(env, query.id, "این اعلان برای تلاش دوباره آماده نیست.");
      return true;
    }
    if (row.operation_type.startsWith("post_") &&
        (!row.message_snapshot || row.event_key?.startsWith("legacy:"))) {
      await answerCallbackQuery(env, query.id,
        "این رخداد قدیمی هویت قابل اتکای retry ندارد؛ برای جلوگیری از اعلان نادرست بررسی دستی لازم است.");
      return true;
    }
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO notification_retry_confirmations (actor_id, notification_id, expires_at)
      VALUES (?, ?, datetime('now', '+10 minutes'))
      ON CONFLICT(actor_id, notification_id) DO UPDATE SET expires_at = excluded.expires_at
    `).bind(actorId, id).run();
    const warning = row.status === "unknown"
      ? "نتیجهٔ ارسال قبلی نامشخص است؛ تلاش دوباره ممکن است اعلان تکراری بسازد."
      : row.status === "pending"
        ? "اعلان هنوز claim نشده است؛ ارسال کنترل‌شده فقط همان اعلان را انجام می‌دهد."
        : "ارسال قبلی قطعاً ناموفق گزارش شده است.";
    await editInlineTelegram(env, query.message.chat.id, query.message.message_id,
      `${warning}\nتلاش دوباره فقط اعلان #${id} را می‌فرستد و عملیات اصلی را اجرا نمی‌کند. ادامه می‌دهی؟`, [[
        { text: "✅ تأیید تلاش اعلان", callback_data: `notification:confirm:${id}` },
        { text: "لغو", callback_data: `notification:cancel:${id}` }
      ]]);
    await answerCallbackQuery(env, query.id);
    return true;
  }

  const confirmation = await env.CRASH_BOT_DB.prepare(`
    SELECT notification_id FROM notification_retry_confirmations
    WHERE actor_id = ? AND notification_id = ? AND expires_at > CURRENT_TIMESTAMP
  `).bind(actorId, id).first();
  if (!confirmation) {
    await answerCallbackQuery(env, query.id, "تأیید تلاش دوباره منقضی شده است.");
    return true;
  }
  await markStaleSending(env, id);
  const claimToken = newClaimToken();
  const claimed = await env.CRASH_BOT_DB.prepare(`
    UPDATE notification_outbox
    SET status = 'sending', attempts = attempts + 1, last_error = NULL,
      claim_token = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('pending', 'failed', 'unknown')
    RETURNING id, recipient_id, operation_type, entity_id, event_key,
      message_snapshot, attempts
  `).bind(claimToken, id).first();
  await env.CRASH_BOT_DB.prepare(`
    DELETE FROM notification_retry_confirmations
    WHERE actor_id = ? AND notification_id = ?
  `).bind(actorId, id).run();
  if (!claimed) {
    await answerCallbackQuery(env, query.id, "این اعلان قبلاً در حال ارسال یا تعیین‌تکلیف شده است.");
    return true;
  }

  let status = "failed";
  let error = null;
  try {
    const sent = claimed.operation_type.startsWith("post_")
      ? await deliverPostOutboxNotification(env, claimed)
      : await deliverConnectionOutboxNotification(env, claimed);
    status = sent === "sent" ? "sent" : sent === "unknown" ? "unknown" : "failed";
    if (!sent) error = "Notification record is unavailable or Telegram rejected the request";
  } catch (deliveryError) {
    status = deliveryError?.telegramDefiniteFailure ? "failed" : "unknown";
    error = status === "failed"
      ? "Telegram rejected the notification"
      : "Delivery outcome is unknown";
    console.error("Notification retry did not complete:", deliveryError);
  }
  await env.CRASH_BOT_DB.prepare(`
    UPDATE notification_outbox
    SET status = ?, last_error = ?, claim_token = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'sending' AND claim_token = ?
  `).bind(status, error, id, claimToken).run();
  await answerCallbackQuery(env, query.id,
    status === "sent" ? "اعلان ارسال شد." :
      status === "unknown" ? "نتیجهٔ ارسال نامشخص است؛ پیش از تلاش دوباره وضعیت را دستی بررسی کن." :
        "ارسال اعلان ناموفق بود.");
  await editInlineTelegram(env, query.message.chat.id, query.message.message_id,
    `نتیجهٔ تلاش اعلان #${id}: ${status} · تعداد تلاش: ${claimed.attempts}`, []);
  return true;
}
