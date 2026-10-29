import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as telegramApi from "../src/telegram/api.js";
import {
  handleNotificationCallback,
  renderNotificationOutbox
} from "../src/services/notifications.js";
import { submitPost } from "../src/services/posts.js";

const fixtureUsers = new Set();
const notificationIds = new Set();

async function createUser(id = null) {
  const userId = id ?? 920000000 + Math.floor(Math.random() * 70000000);
  fixtureUsers.add(userId);
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES (?, NULL, 'Notification test')
  `).bind(userId).run();
  return userId;
}

function callback(actorId, data) {
  return {
    id: `notification-${Math.random()}`,
    data,
    from: { id: actorId },
    message: { chat: { id: actorId }, message_id: 432 }
  };
}

async function createRejectedPost(senderId, moderatorId) {
  const post = await submitPost(env, { id: senderId }, {
    message_id: Math.floor(Math.random() * 1000000),
    text: "immutable rejected post"
  });
  const queue = await env.CRASH_BOT_DB.prepare(
    "SELECT id FROM admin_queue WHERE item_id = ?"
  ).bind(post.id).first();
  await env.CRASH_BOT_DB.prepare(`
    UPDATE admin_queue
    SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?
    WHERE id = ?
  `).bind(moderatorId, queue.id).run();
  return { postId: post.id, queueId: queue.id };
}

async function createNotification(recipientId, operation, entityId, status) {
  const notification = await env.CRASH_BOT_DB.prepare(`
    INSERT INTO notification_outbox (
      recipient_id, operation_type, entity_id, event_key, message_snapshot, status, attempts
    ) VALUES (?, ?, ?, ?, 'پیام ثبت‌شدهٔ شما رد شد.', ?, 1) RETURNING id
  `).bind(recipientId, operation, entityId,
    `test-notification:${recipientId}:${operation}:${entityId}`, status).first();
  notificationIds.add(notification.id);
  return notification.id;
}

async function clearFixtures() {
  const notificationList = [...notificationIds];
  if (notificationList.length) {
    const marks = notificationList.map(() => "?").join(",");
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM notification_retry_confirmations
      WHERE notification_id IN (${marks})
    `).bind(...notificationList).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM notification_outbox WHERE id IN (${marks})
    `).bind(...notificationList).run();
  }
  const ids = [...fixtureUsers];
  if (ids.length) {
    const marks = ids.map(() => "?").join(",");
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM notification_retry_confirmations
      WHERE actor_id IN (${marks})
    `).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM notification_outbox WHERE recipient_id IN (${marks})
    `).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM deep_link_tokens WHERE intended_user_id IN (${marks})
    `).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM post_events WHERE post_id IN (
        SELECT id FROM posts WHERE user_id IN (${marks})
      )
    `).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM review_decisions WHERE queue_id IN (
        SELECT id FROM admin_queue WHERE sender_id IN (${marks})
      )
    `).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM publication_jobs WHERE item_id IN (
        SELECT id FROM posts WHERE user_id IN (${marks})
      )
    `).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM admin_queue WHERE sender_id IN (${marks})
    `).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(
      `DELETE FROM posts WHERE user_id IN (${marks})`
    ).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(
      `DELETE FROM users WHERE telegram_id IN (${marks})`
    ).bind(...ids).run();
  }
  notificationIds.clear();
  fixtureUsers.clear();
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await clearFixtures();
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { message_id: 901 } })
  })));
});

describe("owner-controlled notification retries", () => {
  it("retries only the outbox notification and does not repeat its rejected-post operation", async () => {
    const owner = await createUser(Number(env.OWNER_TELEGRAM_ID));
    const sender = await createUser();
    const moderator = await createUser();
    const { postId, queueId } = await createRejectedPost(sender, moderator);
    const notificationId = await createNotification(
      sender, "post_rejected", postId, "failed"
    );
    const send = fetch;
    const edit = vi.spyOn(telegramApi, "editInlineTelegram").mockResolvedValue(true);
    vi.spyOn(telegramApi, "answerCallbackQuery").mockResolvedValue(true);

    await handleNotificationCallback(env, callback(owner, `notification:retry:${notificationId}`));
    await Promise.all([
      handleNotificationCallback(env, callback(owner, `notification:confirm:${notificationId}`)),
      handleNotificationCallback(env, callback(owner, `notification:confirm:${notificationId}`))
    ]);

    const result = await env.CRASH_BOT_DB.prepare(`
      SELECT n.status, n.attempts, p.status AS post_status, q.status AS queue_status,
        (SELECT COUNT(*) FROM review_decisions d WHERE d.queue_id = q.id) AS decisions
      FROM notification_outbox n
      JOIN posts p ON p.id = n.entity_id
      JOIN admin_queue q ON q.item_id = p.id
      WHERE n.id = ?
    `).bind(notificationId).first();
    expect(result).toEqual({
      status: "sent",
      attempts: 2,
      post_status: "rejected",
      queue_status: "rejected",
      decisions: 1
    });
    expect(send).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(send.mock.calls[0][1].body);
    expect(sentBody.text).toContain("رد شد");
    expect(sentBody.reply_markup.inline_keyboard[0][0].callback_data)
      .toMatch(/^post:history:\d+$/);
    expect(edit).toHaveBeenCalledTimes(2);
  });

  it("requires owner confirmation and preserves unknown outcomes without blind re-retry", async () => {
    const owner = await createUser(Number(env.OWNER_TELEGRAM_ID));
    const other = await createUser();
    const sender = await createUser();
    const moderator = await createUser();
    const { postId } = await createRejectedPost(sender, moderator);
    const notificationId = await createNotification(
      sender, "post_rejected", postId, "unknown"
    );
    const send = vi.fn(async () => { throw new Error("network reset"); });
    vi.stubGlobal("fetch", send);
    vi.spyOn(telegramApi, "editInlineTelegram").mockResolvedValue(true);
    vi.spyOn(telegramApi, "answerCallbackQuery").mockResolvedValue(true);

    await handleNotificationCallback(env, callback(other, `notification:retry:${notificationId}`));
    let row = await env.CRASH_BOT_DB.prepare(
      "SELECT status, attempts FROM notification_outbox WHERE id = ?"
    ).bind(notificationId).first();
    expect(row).toEqual({ status: "unknown", attempts: 1 });

    await handleNotificationCallback(env, callback(owner, `notification:retry:${notificationId}`));
    await handleNotificationCallback(env, callback(owner, `notification:confirm:${notificationId}`));
    await handleNotificationCallback(env, callback(owner, `notification:confirm:${notificationId}`));
    row = await env.CRASH_BOT_DB.prepare(
      "SELECT status, attempts FROM notification_outbox WHERE id = ?"
    ).bind(notificationId).first();
    expect(row).toEqual({ status: "unknown", attempts: 2 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps pending notifications visible and sends them only after explicit confirmation", async () => {
    const owner = await createUser(Number(env.OWNER_TELEGRAM_ID));
    const sender = await createUser();
    const moderator = await createUser();
    const { postId } = await createRejectedPost(sender, moderator);
    const notificationId = await createNotification(
      sender, "post_rejected", postId, "pending"
    );
    const sent = fetch;
    const edit = vi.spyOn(telegramApi, "editInlineTelegram").mockResolvedValue(true);
    vi.spyOn(telegramApi, "answerCallbackQuery").mockResolvedValue(true);

    await renderNotificationOutbox(env, owner, owner);
    const listedNotification = sent.mock.calls
      .map((call) => JSON.parse(call[1].body))
      .find((body) => body.text.includes(`اعلان #${notificationId}`));
    expect(listedNotification.text).toContain(`اعلان #${notificationId}`);
    expect(listedNotification.reply_markup.inline_keyboard[0][0].callback_data)
      .toBe(`notification:retry:${notificationId}`);
    const beforeConfirm = await env.CRASH_BOT_DB.prepare(
      "SELECT status, attempts FROM notification_outbox WHERE id = ?"
    ).bind(notificationId).first();
    expect(beforeConfirm).toEqual({ status: "pending", attempts: 1 });

    await handleNotificationCallback(env, callback(owner, `notification:retry:${notificationId}`));
    await handleNotificationCallback(env, callback(owner, `notification:confirm:${notificationId}`));
    const afterConfirm = await env.CRASH_BOT_DB.prepare(
      "SELECT status, attempts FROM notification_outbox WHERE id = ?"
    ).bind(notificationId).first();
    expect(afterConfirm).toEqual({ status: "sent", attempts: 2 });
    expect(edit).toHaveBeenCalled();
  });
});
