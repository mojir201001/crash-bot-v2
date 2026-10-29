import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as telegramApi from "../src/telegram/api.js";
import {
  handleConnectionCallback,
  handleConnectionMessage,
  handleStartToken
} from "../src/services/connections.js";
import { createDeepLinkToken } from "../src/services/posts.js";
import { saveProfileField, getProfile } from "../src/services/profile.js";

const fixtureUsers = new Set();
const fixtureSettings = new Set();

async function createUser(username = null) {
  const userId = 810000000 + Math.floor(Math.random() * 70000000);
  fixtureUsers.add(userId);
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES (?, ?, 'Connection test')
  `).bind(userId, username).run();
  for (const [field, value] of [
    ["nickname", "لقب عمومی"],
    ["bio", "اطلاعات عمومی"],
    ["city", "تهران"],
    ["birth_year", "1380"],
    ["birth_month", "فروردین"],
    ["marital_status", "single"],
    ["gender", "woman"],
    ["job", "آزمایش"],
    ["religion", "محرمانه"],
    ["religious_sect", "خصوصی"],
    ["field", "علوم آزمایشگاهی"],
    ["image_file_id", "profile-file-id"]
  ]) {
    await saveProfileField(env, userId, field, value);
  }
  return userId;
}

async function setting(key, value) {
  fixtureSettings.add(key);
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO bot_settings (key, value)
    VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).bind(key, value).run();
}

async function createPublishedPost(ownerId) {
  const row = await env.CRASH_BOT_DB.prepare(`
    INSERT INTO posts (user_id, content, status, channel_message_id)
    VALUES (?, 'post', 'published', 555) RETURNING id
  `).bind(ownerId).first();
  return row.id;
}

async function clearFixtures() {
  const ids = [...fixtureUsers];
  if (ids.length) {
    const marks = ids.map(() => "?").join(",");
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM notification_outbox WHERE recipient_id IN (${marks})
    `).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM anonymous_messages WHERE sender_id IN (${marks}) OR recipient_id IN (${marks})
    `).bind(...ids, ...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM connection_requests WHERE requester_id IN (${marks}) OR recipient_id IN (${marks})
    `).bind(...ids, ...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM deep_link_tokens WHERE intended_user_id IN (${marks})
        OR entity_id IN (SELECT id FROM posts WHERE user_id IN (${marks}))
    `).bind(...ids, ...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM user_conversations WHERE user_id IN (${marks})
    `).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM post_events WHERE post_id IN (SELECT id FROM posts WHERE user_id IN (${marks}))
    `).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM publication_jobs WHERE item_id IN (SELECT id FROM posts WHERE user_id IN (${marks}))
    `).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM admin_queue WHERE sender_id IN (${marks})
    `).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM posts WHERE user_id IN (${marks})
    `).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM users WHERE telegram_id IN (${marks})
    `).bind(...ids).run();
  }
  fixtureUsers.clear();
  for (const key of fixtureSettings) {
    await env.CRASH_BOT_DB.prepare("DELETE FROM bot_settings WHERE key = ?")
      .bind(key).run();
  }
  fixtureSettings.clear();
}

function callback(actorId, data) {
  return {
    id: `connection-${Math.random()}`,
    data,
    from: { id: actorId },
    message: { chat: { id: actorId }, message_id: 888 }
  };
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

describe("channel connection requests and private profile", () => {
  it("requires explicit confirmation and rejects self or duplicate requests", async () => {
    const owner = await createUser();
    const requester = await createUser();
    const postId = await createPublishedPost(owner);
    const token = await createDeepLinkToken(env, "connect", postId);
    const inline = vi.spyOn(telegramApi, "sendInlineTelegram").mockResolvedValue(true);
    const answers = vi.spyOn(telegramApi, "answerCallbackQuery").mockResolvedValue(true);
    const send = vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);

    await handleStartToken(env, requester, requester, token);
    let count = await env.CRASH_BOT_DB.prepare(
      "SELECT COUNT(*) AS count FROM connection_requests WHERE requester_id = ?"
    ).bind(requester).first();
    expect(count.count).toBe(0);
    expect(inline.mock.calls[0][2]).toContain("مطمئنی می‌خواهی درخواست ارتباط ارسال شود؟");

    await handleConnectionCallback(env, callback(requester, `connection:confirm:${postId}`));
    await handleConnectionCallback(env, callback(requester, `connection:confirm:${postId}`));
    count = await env.CRASH_BOT_DB.prepare(
      "SELECT COUNT(*) AS count FROM connection_requests WHERE requester_id = ?"
    ).bind(requester).first();
    expect(count.count).toBe(1);
    expect(answers).toHaveBeenCalled();

    const ownToken = await createDeepLinkToken(env, "connect", postId);
    await handleStartToken(env, owner, owner, ownToken);
    expect(send.mock.calls.at(-1)[2]).toContain("درخواست ارتباط برای این مورد امکان‌پذیر نیست.");
  });

  it("rejects an empty message without supported media in an active connection chat", async () => {
    const first = await createUser();
    const second = await createUser();
    const row = await env.CRASH_BOT_DB.prepare(`
      INSERT INTO connection_requests (requester_id, recipient_id, status)
      VALUES (?, ?, 'accepted') RETURNING id
    `).bind(first, second).first();
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO user_conversations (user_id, flow_type, entity_id)
      VALUES (?, 'connection_chat', ?)
    `).bind(first, row.id).run();
    const send = vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);

    await expect(handleConnectionMessage(env, {
      from: { id: first },
      chat: { id: first },
      message_id: 992
    }, first)).resolves.toBe(true);

    expect(send.mock.calls.at(-1)[2]).toContain("پیام متنی یا رسانهٔ پشتیبانی‌شده");
    const stored = await env.CRASH_BOT_DB.prepare(
      "SELECT COUNT(*) AS count FROM anonymous_messages WHERE connection_id = ?"
    ).bind(row.id).first();
    expect(stored.count).toBe(0);
  });

  it("allows only the recipient to accept once, then activates a two-party chat", async () => {
    const recipient = await createUser();
    const requester = await createUser();
    const outsider = await createUser();
    const postId = await createPublishedPost(recipient);
    await setting("telegram_bot_username", "example_bot");
    const token = await createDeepLinkToken(env, "connect", postId);
    const inline = vi.spyOn(telegramApi, "sendInlineTelegram").mockResolvedValue(true);
    vi.spyOn(telegramApi, "answerCallbackQuery").mockResolvedValue(true);
    vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);
    await handleStartToken(env, requester, requester, token);
    await handleConnectionCallback(env, callback(requester, `connection:confirm:${postId}`));
    const request = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM connection_requests WHERE requester_id = ? AND recipient_id = ?
    `).bind(requester, recipient).first();

    await handleConnectionCallback(env, callback(outsider, `connection:decision:${request.id}:accepted`));
    let state = await env.CRASH_BOT_DB.prepare(
      "SELECT status FROM connection_requests WHERE id = ?"
    ).bind(request.id).first();
    expect(state.status).toBe("pending");
    await handleConnectionCallback(env, callback(recipient, `connection:decision:${request.id}:accepted`));
    await handleConnectionCallback(env, callback(recipient, `connection:decision:${request.id}:rejected`));
    state = await env.CRASH_BOT_DB.prepare(
      "SELECT status FROM connection_requests WHERE id = ?"
    ).bind(request.id).first();
    expect(state.status).toBe("accepted");

    const chatMessage = {
      from: { id: requester },
      chat: { id: requester },
      message_id: 991,
      text: "سلام"
    };
    expect(await handleConnectionMessage(env, chatMessage, requester)).toBe(true);
    expect(await handleConnectionMessage(env, chatMessage, requester)).toBe(true);
    const stored = await env.CRASH_BOT_DB.prepare(`
      SELECT sender_id, recipient_id, message, message_type, connection_id,
        source_message_id
      FROM anonymous_messages WHERE connection_id = ?
    `).bind(request.id).first();
    expect(stored).toEqual({
      sender_id: requester,
      recipient_id: recipient,
      message: "سلام",
      message_type: "connection",
      connection_id: request.id,
      source_message_id: 991
    });
    const notificationCount = await env.CRASH_BOT_DB.prepare(`
      SELECT COUNT(*) AS count FROM notification_outbox
      WHERE event_key = (
        SELECT 'connection-message:' || id FROM anonymous_messages
        WHERE connection_id = ? AND source_message_id = 991
      )
    `).bind(request.id).first();
    expect(notificationCount.count).toBe(1);
    expect(fetch.mock.calls.some((call) =>
      String(call[1]?.body ?? "").includes("start=")
    )).toBe(true);

    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO user_conversations (user_id, flow_type, entity_id)
      VALUES (?, 'connection_chat', ?)
    `).bind(outsider, request.id).run();
    await handleConnectionMessage(env, {
      from: { id: outsider },
      chat: { id: outsider },
      text: "نباید ارسال شود"
    }, outsider);
    const outsiderMessages = await env.CRASH_BOT_DB.prepare(
      "SELECT COUNT(*) AS count FROM anonymous_messages WHERE sender_id = ?"
    ).bind(outsider).first();
    expect(outsiderMessages.count).toBe(0);
  });

  it("shows only selected bot-profile fields and exits without deleting the source profile", async () => {
    const owner = await createUser("private_username");
    const viewer = await createUser();
    const postId = await createPublishedPost(owner);
    const token = await createDeepLinkToken(env, "profile", postId);
    const media = vi.spyOn(telegramApi, "sendMediaTelegram").mockResolvedValue({ message_id: 700 });
    const inline = vi.spyOn(telegramApi, "sendInlineTelegram").mockResolvedValue(true);
    const answers = vi.spyOn(telegramApi, "answerCallbackQuery").mockResolvedValue(true);
    const send = vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);

    await handleStartToken(env, viewer, viewer, token);
    expect(media).toHaveBeenCalledWith(env, "sendPhoto", expect.objectContaining({
      chat_id: viewer,
      photo: expect.any(String),
      parse_mode: "HTML"
    }));
    const publicText = media.mock.calls[0][2].caption;
    expect(publicText).toContain("لقب عمومی");
    expect(publicText).toContain("سن:");
    expect(publicText).not.toContain(String(owner));
    expect(publicText).not.toContain("private_username");
    expect(publicText).not.toContain("محرمانه");
    expect(publicText).not.toContain("1380");

    await handleConnectionCallback(env, callback(viewer, "profile:exit"));
    const flow = await env.CRASH_BOT_DB.prepare(
      "SELECT flow_type FROM user_conversations WHERE user_id = ?"
    ).bind(viewer).first();
    expect(flow).toBeNull();
    expect((await getProfile(env, owner)).nickname).toBe("لقب عمومی");
    expect(answers).toHaveBeenCalled();
    expect(send).toHaveBeenCalled();
    expect(inline).toHaveBeenCalled();
  });
});
