import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as telegramApi from "../src/telegram/api.js";
import {
  createDeepLinkToken,
  handleArchiveCallback,
  handlePostCallback,
  renderPostArchive,
  resolveDeepLinkToken,
  submitPost
} from "../src/services/posts.js";

const fixtureUsers = new Set();
const fixtureSettings = new Set();

async function createUser(username = null, id = null) {
  const userId = id ?? 710000000 + Math.floor(Math.random() * 80000000);
  fixtureUsers.add(userId);
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES (?, ?, ?)
  `).bind(userId, username, "Post test").run();
  return userId;
}

async function setting(key, value) {
  fixtureSettings.add(key);
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO bot_settings (key, value)
    VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).bind(key, value).run();
}

async function createPost(userId, message = { message_id: 111, text: "متن اصلی" }) {
  return submitPost(env, { id: userId, username: null }, message);
}

function callback(actorId, data) {
  return {
    id: `callback-${Math.random()}`,
    data,
    from: { id: actorId },
    message: { chat: { id: actorId, type: "private" }, message_id: 777 }
  };
}

async function clearFixtures() {
  const ids = [...fixtureUsers];
  if (ids.length) {
    const marks = ids.map(() => "?").join(",");
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM review_decisions WHERE queue_id IN (
        SELECT id FROM admin_queue WHERE sender_id IN (${marks})
      )
    `).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM moderation_confirmations WHERE actor_id IN (${marks})
    `).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM owner_repost_confirmations WHERE actor_id IN (${marks})
    `).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM owner_publication_confirmations WHERE actor_id IN (${marks})
    `).bind(...ids).run();
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
      DELETE FROM post_events WHERE post_id IN (SELECT id FROM posts WHERE user_id IN (${marks}))
    `).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM publication_jobs WHERE item_id IN (SELECT id FROM posts WHERE user_id IN (${marks}))
    `).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM admin_queue WHERE sender_id IN (${marks})
    `).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM deep_link_tokens WHERE intended_user_id IN (${marks})
        OR entity_id IN (SELECT id FROM posts WHERE user_id IN (${marks}))
    `).bind(...ids, ...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM user_conversations WHERE user_id IN (${marks})
    `).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM posts WHERE user_id IN (${marks})
    `).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM admin_roles WHERE user_id IN (${marks})
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

describe("post submission and shared queue", () => {
  it("stores the original text and media with a real nullable Telegram username", async () => {
    const sender = await createUser();
    const textPost = await createPost(sender, {
      message_id: 111,
      text: "  original <text>  ",
      from: { username: undefined }
    });
    const mediaPost = await createPost(sender, {
      message_id: 112,
      photo: [{ file_id: "small" }, { file_id: "largest" }],
      caption: "  photo caption  "
    });
    expect(textPost.duplicate).toBe(false);
    expect(mediaPost.duplicate).toBe(false);

    const rows = await env.CRASH_BOT_DB.prepare(`
      SELECT p.content, p.caption, p.media_type, p.media_file_id, p.sender_username,
        q.item_type, q.status
      FROM posts p JOIN admin_queue q ON q.item_id = p.id
      WHERE p.user_id = ? ORDER BY p.id
    `).bind(sender).all();
    expect(rows.results).toEqual([
      {
        content: "  original <text>  ",
        caption: null,
        media_type: null,
        media_file_id: null,
        sender_username: null,
        item_type: "post",
        status: "pending"
      },
      {
        content: "  photo caption  ",
        caption: "  photo caption  ",
        media_type: "photo",
        media_file_id: "largest",
        sender_username: null,
        item_type: "post",
        status: "pending"
      }
    ]);
  });

  it("associates replies with a published parent and deduplicates a retried Telegram message", async () => {
    const sender = await createUser("actual_username");
    const parentId = await createPost(sender);
    await env.CRASH_BOT_DB.prepare(`
      UPDATE posts SET status = 'published', channel_message_id = 4321 WHERE id = ?
    `).bind(parentId.id).run();
    const reply = await submitPost(env, { id: sender, username: "actual_username" }, {
      message_id: 222,
      video: { file_id: "video-id" },
      caption: "reply caption"
    }, parentId.id);
    const retried = await submitPost(env, { id: sender, username: "actual_username" }, {
      message_id: 222,
      video: { file_id: "video-id" },
      caption: "reply caption"
    }, parentId.id);
    const row = await env.CRASH_BOT_DB.prepare(`
      SELECT p.reply_to_post_id, p.sender_username, p.media_type, q.item_type
      FROM posts p JOIN admin_queue q ON q.item_id = p.id
      WHERE p.id = ?
    `).bind(reply.id).first();

    expect(reply.duplicate).toBe(false);
    expect(retried).toEqual({ id: reply.id, duplicate: true });
    expect(row).toEqual({
      reply_to_post_id: parentId.id,
      sender_username: "actual_username",
      media_type: "video",
      item_type: "reply"
    });
  });
});

describe("atomic moderation and publishing", () => {
  it("allows only one concurrent moderator decision", async () => {
    const sender = await createUser();
    const adminA = await createUser();
    const adminB = await createUser();
    await env.CRASH_BOT_DB.prepare(
      "INSERT INTO admin_roles (user_id) VALUES (?), (?)"
    ).bind(adminA, adminB).run();
    const post = await createPost(sender);
    const queue = await env.CRASH_BOT_DB.prepare(
      "SELECT id FROM admin_queue WHERE item_id = ?"
    ).bind(post.id).first();
    vi.spyOn(telegramApi, "editInlineTelegram").mockResolvedValue(true);
    vi.spyOn(telegramApi, "answerCallbackQuery").mockResolvedValue(true);
    vi.spyOn(telegramApi, "sendInlineTelegram").mockResolvedValue(true);

    await handlePostCallback(env, callback(adminA, `post:review:${queue.id}:approved`));
    await handlePostCallback(env, callback(adminB, `post:review:${queue.id}:rejected`));
    const results = await Promise.all([
      handlePostCallback(env, callback(adminA, `post:confirm:${queue.id}:approved`)),
      handlePostCallback(env, callback(adminB, `post:confirm:${queue.id}:rejected`))
    ]);
    const decisions = await env.CRASH_BOT_DB.prepare(`
      SELECT q.status, p.status AS post_status, COUNT(d.id) AS decision_count
      FROM admin_queue q JOIN posts p ON p.id = q.item_id
      LEFT JOIN review_decisions d ON d.queue_id = q.id WHERE q.id = ?
      GROUP BY q.id
    `).bind(queue.id).first();

    expect(results).toEqual([true, true]);
    expect(["approved", "rejected"]).toContain(decisions.status);
    expect(decisions.post_status).toBe(decisions.status);
    expect(decisions.decision_count).toBe(1);
  });

  it("does not apply a moderation transition when the related post is stale", async () => {
    const sender = await createUser();
    const admin = await createUser();
    const post = await createPost(sender);
    const queue = await env.CRASH_BOT_DB.prepare(
      "SELECT id FROM admin_queue WHERE item_id = ?"
    ).bind(post.id).first();
    await env.CRASH_BOT_DB.prepare(
      "UPDATE posts SET status = 'rejected' WHERE id = ?"
    ).bind(post.id).run();

    await expect(env.CRASH_BOT_DB.prepare(`
      UPDATE admin_queue SET status = 'approved', reviewed_by = ?,
        reviewed_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(admin, queue.id).run()).rejects.toThrow("post is no longer pending");

    const state = await env.CRASH_BOT_DB.prepare(`
      SELECT q.status AS queue_status, p.status AS post_status
      FROM admin_queue q JOIN posts p ON p.id = q.item_id WHERE q.id = ?
    `).bind(queue.id).first();
    expect(state).toEqual({ queue_status: "pending", post_status: "rejected" });
  });

  it("publishes escaped original text and all five links once", async () => {
    const sender = await createUser();
    const admin = await createUser();
    await env.CRASH_BOT_DB.prepare("INSERT INTO admin_roles (user_id) VALUES (?)")
      .bind(admin).run();
    await setting("telegram_bot_username", "example_bot");
    await setting("crash_channel_id", "-1001234567890");
    await setting("crash_channel_url", "https://t.me/example_channel");
    const post = await createPost(sender, {
      message_id: 333,
      text: "<script>safe & sound</script>"
    });
    const queue = await env.CRASH_BOT_DB.prepare(
      "SELECT id FROM admin_queue WHERE item_id = ?"
    ).bind(post.id).first();
    const telegramCalls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      telegramCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return {
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 901 } })
      };
    }));
    vi.spyOn(telegramApi, "editInlineTelegram").mockResolvedValue(true);
    vi.spyOn(telegramApi, "answerCallbackQuery").mockResolvedValue(true);
    vi.spyOn(telegramApi, "sendInlineTelegram").mockResolvedValue(true);

    await handlePostCallback(env, callback(admin, `post:review:${queue.id}:approved`));
    await handlePostCallback(env, callback(admin, `post:confirm:${queue.id}:approved`));
    await handlePostCallback(env, callback(admin, `post:confirm:${queue.id}:approved`));

    const publish = telegramCalls.find((call) => call.url.endsWith("/sendMessage"));
    const row = await env.CRASH_BOT_DB.prepare(`
      SELECT p.status, p.channel_message_id, j.status AS job_status, j.channel_message_id AS job_message_id
      FROM posts p JOIN publication_jobs j ON j.item_id = p.id WHERE p.id = ?
    `).bind(post.id).first();
    expect(publish.body.chat_id).toBe("-1001234567890");
    expect(publish.body.text).toContain("&lt;script&gt;safe &amp; sound&lt;/script&gt;");
    for (const label of [
      "پاسخ به پیام", "پروفایل فرستنده", "درخواست ارتباط با فرستنده",
      "ثبت پیام ناشناس", "کانال کراشیابی ادیب"
    ]) expect(publish.body.text).toContain(label);
    expect(row).toEqual({
      status: "published",
      channel_message_id: 901,
      job_status: "sent",
      job_message_id: 901
    });
    expect(telegramCalls.filter((call) =>
      call.url.endsWith("/sendMessage") &&
      call.body.chat_id === "-1001234567890"
    )).toHaveLength(1);
  });

  it("rejects a post and sends a direct link to that sender's history", async () => {
    const sender = await createUser();
    const admin = await createUser();
    await env.CRASH_BOT_DB.prepare("INSERT INTO admin_roles (user_id) VALUES (?)")
      .bind(admin).run();
    const post = await createPost(sender);
    const queue = await env.CRASH_BOT_DB.prepare(
      "SELECT id FROM admin_queue WHERE item_id = ?"
    ).bind(post.id).first();
    const send = fetch;
    vi.spyOn(telegramApi, "editInlineTelegram").mockResolvedValue(true);
    vi.spyOn(telegramApi, "answerCallbackQuery").mockResolvedValue(true);

    await handlePostCallback(env, callback(admin, `post:review:${queue.id}:rejected`));
    await handlePostCallback(env, callback(admin, `post:confirm:${queue.id}:rejected`));

    const row = await env.CRASH_BOT_DB.prepare(`
      SELECT p.status, n.status AS notification_status
      FROM posts p JOIN notification_outbox n
        ON n.entity_id = p.id AND n.operation_type LIKE 'post_rejected:%'
      WHERE p.id = ?
    `).bind(post.id).first();
    expect(row).toEqual({ status: "rejected", notification_status: "sent" });
    expect(send).toHaveBeenCalledTimes(1);
    const notificationBody = JSON.parse(send.mock.calls[0][1].body);
    expect(notificationBody.text).toContain("رد شد");
    expect(notificationBody.reply_markup.inline_keyboard[0][0].callback_data)
      .toBe(`post:history:${post.id}`);
  });

  it("marks a network-ambiguous publish unknown and blocks a stale retry", async () => {
    const sender = await createUser();
    const admin = await createUser();
    await env.CRASH_BOT_DB.prepare("INSERT INTO admin_roles (user_id) VALUES (?)")
      .bind(admin).run();
    await setting("telegram_bot_username", "example_bot");
    await setting("crash_channel_id", "-1001234567890");
    await setting("crash_channel_url", "https://t.me/example_channel");
    const post = await createPost(sender);
    const queue = await env.CRASH_BOT_DB.prepare(
      "SELECT id FROM admin_queue WHERE item_id = ?"
    ).bind(post.id).first();
    const failedFetch = vi.fn(async () => { throw new Error("network reset"); });
    vi.stubGlobal("fetch", failedFetch);
    vi.spyOn(telegramApi, "editInlineTelegram").mockResolvedValue(true);
    vi.spyOn(telegramApi, "answerCallbackQuery").mockResolvedValue(true);
    vi.spyOn(telegramApi, "sendInlineTelegram").mockResolvedValue(true);

    await handlePostCallback(env, callback(admin, `post:review:${queue.id}:approved`));
    await handlePostCallback(env, callback(admin, `post:confirm:${queue.id}:approved`));
    await handlePostCallback(env, callback(admin, `post:confirm:${queue.id}:approved`));
    const job = await env.CRASH_BOT_DB.prepare(
      "SELECT status, attempts FROM publication_jobs WHERE item_id = ?"
    ).bind(post.id).first();

    expect(job).toEqual({ status: "unknown", attempts: 1 });
    expect(failedFetch).toHaveBeenCalledTimes(2);
  });

  it("does not contact Telegram when publication settings are missing", async () => {
    const sender = await createUser();
    const admin = await createUser();
    await env.CRASH_BOT_DB.prepare("INSERT INTO admin_roles (user_id) VALUES (?)")
      .bind(admin).run();
    const post = await createPost(sender);
    const queue = await env.CRASH_BOT_DB.prepare(
      "SELECT id FROM admin_queue WHERE item_id = ?"
    ).bind(post.id).first();
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return {
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 901 } })
      };
    }));
    vi.spyOn(telegramApi, "editInlineTelegram").mockResolvedValue(true);
    vi.spyOn(telegramApi, "answerCallbackQuery").mockResolvedValue(true);
    vi.spyOn(telegramApi, "sendInlineTelegram").mockResolvedValue(true);

    await handlePostCallback(env, callback(admin, `post:review:${queue.id}:approved`));
    await handlePostCallback(env, callback(admin, `post:confirm:${queue.id}:approved`));

    const job = await env.CRASH_BOT_DB.prepare(
      "SELECT status, attempts FROM publication_jobs WHERE item_id = ?"
    ).bind(post.id).first();
    expect(job).toEqual({ status: "failed", attempts: 1 });
    expect(calls.some(({ body }) => body.chat_id === "-1001234567890"))
      .toBe(false);
  });

  it("requires a fresh owner confirmation before retrying an uncertain publication", async () => {
    const ownerId = Number(env.OWNER_TELEGRAM_ID);
    const owner = await createUser(null, ownerId);
    const sender = await createUser();
    const admin = await createUser();
    await env.CRASH_BOT_DB.prepare("INSERT INTO admin_roles (user_id) VALUES (?)")
      .bind(admin).run();
    await setting("telegram_bot_username", "example_bot");
    await setting("crash_channel_id", "-1001234567890");
    await setting("crash_channel_url", "https://t.me/example_channel");
    const post = await createPost(sender);
    const queue = await env.CRASH_BOT_DB.prepare(
      "SELECT id FROM admin_queue WHERE item_id = ?"
    ).bind(post.id).first();
    const failedFetch = vi.fn(async () => { throw new Error("network reset"); });
    vi.stubGlobal("fetch", failedFetch);
    vi.spyOn(telegramApi, "editInlineTelegram").mockResolvedValue(true);
    vi.spyOn(telegramApi, "answerCallbackQuery").mockResolvedValue(true);
    vi.spyOn(telegramApi, "sendInlineTelegram").mockResolvedValue(true);

    await handlePostCallback(env, callback(admin, `post:review:${queue.id}:approved`));
    await handlePostCallback(env, callback(admin, `post:confirm:${queue.id}:approved`));
    await handlePostCallback(env, callback(owner, `post:retry:${post.id}`));
    expect(failedFetch).toHaveBeenCalledTimes(2);

    await handlePostCallback(env, callback(owner, `post:recover:${post.id}`));
    const confirmation = await env.CRASH_BOT_DB.prepare(`
      SELECT post_id FROM owner_publication_confirmations
      WHERE actor_id = ? AND post_id = ?
    `).bind(owner, post.id).first();
    expect(confirmation).toEqual({ post_id: post.id });
    await handlePostCallback(env, callback(owner, `post:retry:${post.id}`));
    await handlePostCallback(env, callback(owner, `post:retry:${post.id}`));

    const job = await env.CRASH_BOT_DB.prepare(
      "SELECT status, attempts FROM publication_jobs WHERE item_id = ?"
    ).bind(post.id).first();
    expect(job).toEqual({ status: "unknown", attempts: 2 });
    expect(failedFetch).toHaveBeenCalledTimes(3);
  });

  it("publishes replies to the parent channel message and separates long media captions safely", async () => {
    const sender = await createUser();
    const admin = await createUser();
    await env.CRASH_BOT_DB.prepare("INSERT INTO admin_roles (user_id) VALUES (?)")
      .bind(admin).run();
    await setting("telegram_bot_username", "example_bot");
    await setting("crash_channel_id", "-1001234567890");
    await setting("crash_channel_url", "https://t.me/example_channel");

    const parent = await createPost(sender, { message_id: 401, text: "parent" });
    const parentQueue = await env.CRASH_BOT_DB.prepare(
      "SELECT id FROM admin_queue WHERE item_id = ?"
    ).bind(parent.id).first();
    await env.CRASH_BOT_DB.prepare(`
      UPDATE admin_queue SET status = 'approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(admin, parentQueue.id).run();
    await env.CRASH_BOT_DB.prepare(`
      UPDATE posts SET status = 'published', channel_message_id = 456 WHERE id = ?
    `).bind(parent.id).run();

    const caption = "ر".repeat(5000);
    const reply = await submitPost(env, { id: sender }, {
      message_id: 402,
      photo: [{ file_id: "large-photo" }],
      caption
    }, parent.id);
    const replyQueue = await env.CRASH_BOT_DB.prepare(
      "SELECT id FROM admin_queue WHERE item_id = ?"
    ).bind(reply.id).first();
    const telegramCalls = [];
    let nextMessageId = 1000;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      telegramCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return {
        ok: true,
        json: async () => ({ ok: true, result: { message_id: nextMessageId++ } })
      };
    }));
    vi.spyOn(telegramApi, "editInlineTelegram").mockResolvedValue(true);
    vi.spyOn(telegramApi, "answerCallbackQuery").mockResolvedValue(true);
    vi.spyOn(telegramApi, "sendInlineTelegram").mockResolvedValue(true);

    await handlePostCallback(env, callback(admin, `post:review:${replyQueue.id}:approved`));
    await handlePostCallback(env, callback(admin, `post:confirm:${replyQueue.id}:approved`));
    const mediaCall = telegramCalls.find((call) => call.url.endsWith("/sendPhoto"));
    const linksCall = telegramCalls.find((call) =>
      call.url.endsWith("/sendMessage") &&
      String(call.body.text).includes("پاسخ به پیام")
    );
    const published = await env.CRASH_BOT_DB.prepare(
      "SELECT channel_message_id FROM posts WHERE id = ?"
    ).bind(reply.id).first();

    expect(mediaCall.body.photo).toBe("large-photo");
    expect(mediaCall.body.caption).toBeUndefined();
    expect(mediaCall.body.reply_parameters.message_id).toBe(456);
    const textCalls = telegramCalls.filter((call) =>
      call.url.endsWith("/sendMessage") &&
      call.body.chat_id === "-1001234567890" &&
      !call.body.text.includes("<a href=")
    );
    expect(textCalls.map((call) => call.body.text).join("")).toBe(caption);
    expect(textCalls.every((call) => call.body.text.length <= 4096)).toBe(true);
    expect(textCalls[0].body.reply_parameters.message_id).toBe(1000);
    expect(textCalls[1].body.reply_parameters.message_id).toBe(1001);
    expect(linksCall.body.reply_parameters.message_id).toBe(1002);
    expect(linksCall.body.text).toContain("کانال کراشیابی ادیب");
    expect(published.channel_message_id).toBe(1000);
  });

  it("splits long original text within Telegram limits without losing content", async () => {
    const sender = await createUser();
    const admin = await createUser();
    await env.CRASH_BOT_DB.prepare("INSERT INTO admin_roles (user_id) VALUES (?)")
      .bind(admin).run();
    await setting("telegram_bot_username", "example_bot");
    await setting("crash_channel_id", "-1001234567890");
    await setting("crash_channel_url", "https://t.me/example_channel");
    const original = "🙂".repeat(2500);
    const post = await createPost(sender, { message_id: 440, text: original });
    const queue = await env.CRASH_BOT_DB.prepare(
      "SELECT id FROM admin_queue WHERE item_id = ?"
    ).bind(post.id).first();
    const calls = [];
    let nextMessageId = 2000;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return {
        ok: true,
        json: async () => ({ ok: true, result: { message_id: nextMessageId++ } })
      };
    }));
    vi.spyOn(telegramApi, "editInlineTelegram").mockResolvedValue(true);
    vi.spyOn(telegramApi, "answerCallbackQuery").mockResolvedValue(true);
    vi.spyOn(telegramApi, "sendInlineTelegram").mockResolvedValue(true);

    await handlePostCallback(env, callback(admin, `post:review:${queue.id}:approved`));
    await handlePostCallback(env, callback(admin, `post:confirm:${queue.id}:approved`));

    const publishedMessages = calls
      .filter((call) => call.url.endsWith("/sendMessage") &&
        call.body.chat_id === "-1001234567890")
      .map((call) => call.body);
    const contentMessages = publishedMessages.filter((body) => body.text !== undefined &&
      !body.text.includes("<a href="));
    expect(contentMessages.slice(0, 2).map((body) => body.text).join(""))
      .toBe(original);
    expect(contentMessages.slice(0, 2).every((body) => body.text.length <= 4096))
      .toBe(true);
    expect(contentMessages[1].reply_parameters.message_id).toBe(2000);
    expect(publishedMessages.at(-1).text).toContain("پاسخ به پیام");
    expect(publishedMessages.at(-1).reply_parameters.message_id).toBe(2001);
  });
});

describe("owner-only archive repost", () => {
  it("includes media in the archive and exposes stale publications for controlled recovery", async () => {
    const ownerId = Number(env.OWNER_TELEGRAM_ID);
    const owner = await createUser(null, ownerId);
    const sender = await createUser();
    const post = await createPost(sender, {
      message_id: 504,
      photo: [{ file_id: "archive-photo" }],
      caption: "archive caption"
    });
    await env.CRASH_BOT_DB.prepare(
      "UPDATE posts SET status = 'approved' WHERE id = ?"
    ).bind(post.id).run();
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO publication_jobs (item_type, item_id, status, attempts, updated_at)
      VALUES ('post', ?, 'sending', 1, datetime('now', '-16 minutes'))
    `).bind(post.id).run();
    const media = vi.spyOn(telegramApi, "sendMediaTelegram").mockResolvedValue({
      message_id: 808
    });
    vi.spyOn(telegramApi, "sendInlineTelegram").mockResolvedValue(true);

    await renderPostArchive(env, owner, owner);
    await handleArchiveCallback(env, callback(owner, "archive:all:0"));

    expect(media).toHaveBeenCalledWith(env, "sendPhoto", expect.objectContaining({
      chat_id: owner,
      photo: "archive-photo"
    }));
    const job = await env.CRASH_BOT_DB.prepare(
      "SELECT status FROM publication_jobs WHERE item_id = ?"
    ).bind(post.id).first();
    expect(job.status).toBe("unknown");
    expect(telegramApi.sendInlineTelegram.mock.calls.some((call) =>
      call[3]?.some((row) => row.some((button) =>
        button.callback_data === `post:recover:${post.id}`))
    )).toBe(true);
  });

  it("requeues a rejected post without changing its original text or review history", async () => {
    const ownerId = Number(env.OWNER_TELEGRAM_ID);
    const owner = await createUser(null, ownerId);
    const sender = await createUser();
    const admin = await createUser();
    await env.CRASH_BOT_DB.prepare("INSERT INTO admin_roles (user_id) VALUES (?)")
      .bind(admin).run();
    const post = await createPost(sender, { message_id: 505, text: "immutable text" });
    const queue = await env.CRASH_BOT_DB.prepare(
      "SELECT id FROM admin_queue WHERE item_id = ?"
    ).bind(post.id).first();
    await env.CRASH_BOT_DB.prepare(`
      UPDATE admin_queue SET status = 'rejected', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(admin, queue.id).run();
    vi.spyOn(telegramApi, "editInlineTelegram").mockResolvedValue(true);
    vi.spyOn(telegramApi, "answerCallbackQuery").mockResolvedValue(true);
    vi.spyOn(telegramApi, "sendInlineTelegram").mockResolvedValue(true);

    await renderPostArchive(env, owner, owner);
    await handleArchiveCallback(env, callback(owner, "archive:all:0"));
    expect(telegramApi.sendInlineTelegram.mock.calls.some((call) =>
      call[3]?.some((row) => row.some((button) =>
        button.callback_data === `post:repost:${post.id}`))
    )).toBe(true);
    await handlePostCallback(env, callback(admin, `post:repost:${post.id}`));
    await handlePostCallback(env, callback(owner, `post:repost:${post.id}`));
    await handlePostCallback(env, callback(owner, `post:repost-confirm:${post.id}`));
    const stored = await env.CRASH_BOT_DB.prepare(`
      SELECT content, status FROM posts WHERE id = ?
    `).bind(post.id).first();
    const events = await env.CRASH_BOT_DB.prepare(`
      SELECT event_type FROM post_events WHERE post_id = ? ORDER BY id
    `).bind(post.id).all();
    const queues = await env.CRASH_BOT_DB.prepare(`
      SELECT status FROM admin_queue WHERE item_id = ? ORDER BY id
    `).bind(post.id).all();

    expect(stored).toEqual({ content: "immutable text", status: "pending" });
    expect(events.results.map((event) => event.event_type))
      .toContain("rejected");
    expect(events.results.map((event) => event.event_type))
      .toContain("repost_queued");
    expect(queues.results.map((item) => item.status)).toEqual(["rejected", "pending"]);
  });

  it("records distinct notification identities for separate moderation decisions", async () => {
    const ownerId = Number(env.OWNER_TELEGRAM_ID);
    const owner = await createUser(null, ownerId);
    const sender = await createUser();
    const admin = await createUser();
    await env.CRASH_BOT_DB.prepare("INSERT INTO admin_roles (user_id) VALUES (?)")
      .bind(admin).run();
    await setting("telegram_bot_username", "example_bot");
    const post = await createPost(sender, { message_id: 606, text: "immutable event text" });
    const queue = await env.CRASH_BOT_DB.prepare(
      "SELECT id FROM admin_queue WHERE item_id = ?"
    ).bind(post.id).first();
    vi.spyOn(telegramApi, "editInlineTelegram").mockResolvedValue(true);
    vi.spyOn(telegramApi, "answerCallbackQuery").mockResolvedValue(true);
    vi.spyOn(telegramApi, "sendInlineTelegram").mockResolvedValue(true);

    await handlePostCallback(env, callback(admin, `post:review:${queue.id}:rejected`));
    await handlePostCallback(env, callback(admin, `post:confirm:${queue.id}:rejected`));
    await handlePostCallback(env, callback(owner, `post:repost:${post.id}`));
    await handlePostCallback(env, callback(owner, `post:repost-confirm:${post.id}`));
    const repostQueue = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM admin_queue WHERE item_id = ? AND status = 'pending'
    `).bind(post.id).first();
    await handlePostCallback(env, callback(admin, `post:review:${repostQueue.id}:approved`));
    await handlePostCallback(env, callback(admin, `post:confirm:${repostQueue.id}:approved`));

    const rows = await env.CRASH_BOT_DB.prepare(`
      SELECT operation_type, event_key, message_snapshot, status
      FROM notification_outbox WHERE recipient_id = ? AND entity_id = ?
        AND operation_type LIKE 'post_%'
      ORDER BY id
    `).bind(sender, post.id).all();
    expect(rows.results).toHaveLength(2);
    expect(new Set(rows.results.map((row) => row.event_key)).size).toBe(2);
    expect(rows.results[0].operation_type).toMatch(/^post_rejected:/);
    expect(rows.results[0].message_snapshot).toContain("رد شد");
    expect(rows.results[1].operation_type).toMatch(/^post_approved:/);
    expect(rows.results[1].message_snapshot).toContain("تأیید شده");
  });
});

describe("deep link privacy", () => {
  it("uses opaque tokens and enforces the intended account for private history", async () => {
    const owner = await createUser();
    const other = await createUser();
    const post = await createPost(owner);
    const token = await createDeepLinkToken(env, "post_history", post.id, owner);
    expect(token).toMatch(/^[a-f0-9]{32}$/);
    await expect(resolveDeepLinkToken(env, token, owner)).resolves.toEqual({
      type: "post_history",
      entityId: post.id
    });
    await expect(resolveDeepLinkToken(env, token, other)).resolves.toBeNull();
    await expect(resolveDeepLinkToken(env, "1", other)).resolves.toBeNull();
  });
});
