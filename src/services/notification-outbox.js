import { sendInlineTelegramDetailed } from "../telegram/api.js";

function createClaimToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function enqueueNotification(
  env, { recipientId, operation, entityId, eventKey, messageSnapshot = null }
) {
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO notification_outbox (
      recipient_id, operation_type, entity_id, event_key, message_snapshot
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `).bind(recipientId, operation, entityId, eventKey, messageSnapshot).run();
  await env.CRASH_BOT_DB.prepare(`
    UPDATE notification_outbox
    SET message_snapshot = COALESCE(message_snapshot, ?)
    WHERE event_key = ?
  `).bind(messageSnapshot, eventKey).run();
  return env.CRASH_BOT_DB.prepare(`
    SELECT id, recipient_id, operation_type, entity_id, event_key,
      message_snapshot, status, attempts
    FROM notification_outbox WHERE event_key = ?
  `).bind(eventKey).first();
}

export async function sendPendingNotification(env, notification, deliver) {
  if (!notification?.id) return "failed";
  const claimToken = createClaimToken();
  const claimed = await env.CRASH_BOT_DB.prepare(`
    UPDATE notification_outbox
    SET status = 'sending', attempts = attempts + 1, claim_token = ?,
      last_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'pending'
    RETURNING id, recipient_id, operation_type, entity_id, event_key,
      message_snapshot, attempts
  `).bind(claimToken, notification.id).first();
  if (!claimed) return notification.status ?? "sending";
  let status = "failed";
  let error = null;
  try {
    const outcome = await deliver(claimed);
    status = outcome === "sent" ? "sent" : outcome === "unknown" ? "unknown" : "failed";
    if (status !== "sent") error = status === "unknown"
      ? "Telegram delivery outcome is unknown"
      : "Telegram definitely rejected the notification";
  } catch (deliveryError) {
    status = deliveryError?.telegramOutcome === "unknown" ||
      deliveryError?.telegramDefiniteFailure !== true
      ? "unknown" : "failed";
    error = status === "unknown"
      ? "Notification delivery outcome is unknown"
      : "Notification could not be delivered";
    console.error("Notification delivery failed:", deliveryError);
  }
  await env.CRASH_BOT_DB.prepare(`
    UPDATE notification_outbox SET status = ?, last_error = ?,
      claim_token = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'sending' AND claim_token = ?
  `).bind(status, error, claimed.id, claimToken).run();
  return status;
}

export async function deliverSnapshotNotification(env, notification, keyboard) {
  if (!notification?.message_snapshot) return "failed";
  const result = await sendInlineTelegramDetailed(
    env, notification.recipient_id, notification.message_snapshot, keyboard
  );
  return result.outcome;
}
