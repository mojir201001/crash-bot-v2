import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as telegramApi from "../src/telegram/api.js";
import {
  handleRandomChatCallback,
  handleRandomChatMessage,
  joinRandomChat
} from "../src/services/random-chat.js";
import { saveProfileField } from "../src/services/profile.js";
import { setPostConversation } from "../src/services/posts.js";

const fixtureUsers = new Set();
const fixtureSessions = new Set();

async function createUser(gender) {
  const userId = 780000000 + Math.floor(Math.random() * 10000000);
  fixtureUsers.add(userId);
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES (?, 'private_user', 'Random chat test')
  `).bind(userId).run();
  for (const [field, value] of [
    ["nickname", "خصوصی"],
    ["bio", "اطلاعات خصوصی"],
    ["city", "تهران"],
    ["birth_year", "1380"],
    ["birth_month", "فروردین"],
    ["marital_status", "مجرد"],
    ["gender", gender === "woman" ? "زن" : "مرد"],
    ["job", "آزمایش"],
    ["religion", "محرمانه"],
    ["religious_sect", "محرمانه"],
    ["field", "علوم آزمایشگاهی"]
  ]) {
    await saveProfileField(env, userId, field, value);
  }
  return userId;
}

function message(userId, messageId, text) {
  return {
    from: { id: userId },
    chat: { id: userId, type: "private" },
    message_id: messageId,
    text
  };
}

function callback(userId, data) {
  return {
    id: `random-${Math.random()}`,
    data,
    from: { id: userId },
    message: { chat: { id: userId, type: "private" }, message_id: 50 }
  };
}

async function activeSession(userA, userB, aWants, status = "active") {
  const row = await env.CRASH_BOT_DB.prepare(`
    INSERT INTO anonymous_sessions (user_a_id, user_b_id, requested_gender, status)
    VALUES (?, ?, ?, ?) RETURNING id
  `).bind(userA, userB, aWants, status).first();
  fixtureSessions.add(row.id);
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO anonymous_chat_members (user_id, session_id, role)
    VALUES (?, ?, 'a'), (?, ?, 'b')
  `).bind(userA, row.id, userB, row.id).run();
  return row.id;
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (fixtureSessions.size) {
    const ids = [...fixtureSessions];
    const marks = ids.map(() => "?").join(",");
    await env.CRASH_BOT_DB.prepare(
      `DELETE FROM anonymous_chat_members WHERE session_id IN (${marks})`
    ).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(
      `DELETE FROM anonymous_messages WHERE session_id IN (${marks})`
    ).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(
      `DELETE FROM anonymous_sessions WHERE id IN (${marks})`
    ).bind(...ids).run();
    fixtureSessions.clear();
  }
  for (const userId of fixtureUsers) {
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM user_conversations WHERE user_id = ?"
    ).bind(userId).run();
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM anonymous_chat_actions WHERE user_id = ?"
    ).bind(userId).run();
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM random_chat_rate_limits WHERE user_id = ?"
    ).bind(userId).run();
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM anonymous_messages WHERE sender_id = ? OR recipient_id = ?"
    ).bind(userId, userId).run();
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM users WHERE telegram_id = ?"
    ).bind(userId).run();
  }
  fixtureUsers.clear();
});

describe("random anonymous chat", () => {
  it("sets updated_at for newly inserted anonymous sessions", async () => {
    const user = await createUser("man");
    const inserted = await env.CRASH_BOT_DB.prepare(`
      INSERT INTO anonymous_sessions (user_a_id, requested_gender, status)
      VALUES (?, 'woman', 'waiting')
      RETURNING id
    `).bind(user).first();

    fixtureSessions.add(inserted.id);
    const session = await env.CRASH_BOT_DB.prepare(
      "SELECT updated_at FROM anonymous_sessions WHERE id = ?"
    ).bind(inserted.id).first();

    expect(typeof session.updated_at).toBe("string");
    expect(session.updated_at.length).toBeGreaterThan(0);
  });

  it("matches two users only when both stored preferences are compatible", async () => {
    const man = await createUser("man");
    const woman = await createUser("woman");
    vi.spyOn(telegramApi, "sendInlineTelegram").mockResolvedValue(true);
    vi.spyOn(telegramApi, "sendInlineTelegramDetailed")
      .mockResolvedValue({ outcome: "sent", messageId: 88 });
    vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);

    await joinRandomChat(env, message(man, 101, "👧 دختر"), man, "woman");
    await joinRandomChat(env, message(woman, 201, "👦 پسر"), woman, "man");

    const session = await env.CRASH_BOT_DB.prepare(`
      SELECT user_a_id, user_b_id, requested_gender, status
      FROM anonymous_sessions
      WHERE user_a_id = ? OR user_b_id = ?
    `).bind(man, man).first();
    fixtureSessions.add((await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM anonymous_sessions WHERE user_a_id = ? OR user_b_id = ?
    `).bind(man, man).first()).id);
    expect(session).toMatchObject({
      user_a_id: man,
      user_b_id: woman,
      requested_gender: "woman",
      status: "active"
    });
    expect(telegramApi.sendInlineTelegramDetailed).toHaveBeenCalledTimes(2);
  });

  it("keeps incompatible preferences in separate waiting sessions and deduplicates search input", async () => {
    const man = await createUser("man");
    const woman = await createUser("woman");
    vi.spyOn(telegramApi, "sendInlineTelegram").mockResolvedValue(true);
    vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);

    await joinRandomChat(env, message(man, 301, "👧 دختر"), man, "woman");
    await joinRandomChat(env, message(man, 301, "👧 دختر"), man, "woman");
    await joinRandomChat(env, message(woman, 302, "👧 دختر"), woman, "woman");
    const sessions = await env.CRASH_BOT_DB.prepare(`
      SELECT id, user_a_id, user_b_id, requested_gender, status
      FROM anonymous_sessions WHERE user_a_id IN (?, ?) ORDER BY id
    `).bind(man, woman).all();
    sessions.results.forEach((row) => fixtureSessions.add(row.id));

    expect(sessions.results).toHaveLength(2);
    expect(sessions.results.every((row) =>
      row.status === "waiting" && row.user_b_id === null
    )).toBe(true);
    expect(sessions.results.some((row) => row.user_a_id === row.user_b_id)).toBe(false);
  });

  it("prevents parallel duplicate sessions and self-matching", async () => {
    const man = await createUser("man");
    const woman = await createUser("woman");
    vi.spyOn(telegramApi, "sendInlineTelegram").mockResolvedValue(true);
    vi.spyOn(telegramApi, "sendInlineTelegramDetailed")
      .mockResolvedValue({ outcome: "sent", messageId: 99 });
    vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);

    await Promise.all([
      joinRandomChat(env, message(man, 401, "👧 دختر"), man, "woman"),
      joinRandomChat(env, message(man, 402, "👧 دختر"), man, "woman")
    ]);
    const count = await env.CRASH_BOT_DB.prepare(`
      SELECT COUNT(*) AS count FROM anonymous_sessions
      WHERE user_a_id = ? OR user_b_id = ?
    `).bind(man, man).first();
    const session = await env.CRASH_BOT_DB.prepare(`
      SELECT user_a_id, user_b_id, status FROM anonymous_sessions
      WHERE user_a_id = ? OR user_b_id = ? LIMIT 1
    `).bind(man, man).first();
    fixtureSessions.add((await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM anonymous_sessions WHERE user_a_id = ? OR user_b_id = ?
      ORDER BY id DESC LIMIT 1
    `).bind(man, man).first()).id);
    expect(count.count).toBe(1);
    expect(session.user_b_id).toBeNull();
    expect(session.status).toBe("waiting");
    expect(session.user_a_id).toBe(man);
  });

  it("ends once for concurrent participants, rejects stale controls, and allows a new search", async () => {
    const first = await createUser("man");
    const second = await createUser("woman");
    const sessionId = await activeSession(first, second, "woman");
    const answer = vi.spyOn(telegramApi, "answerCallbackQuery").mockResolvedValue(true);
    vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);

    await Promise.all([
      handleRandomChatCallback(env, callback(first, `random:end:${sessionId}`)),
      handleRandomChatCallback(env, callback(second, `random:end:${sessionId}`))
    ]);
    const ended = await env.CRASH_BOT_DB.prepare(
      "SELECT status, ended_by FROM anonymous_sessions WHERE id = ?"
    ).bind(sessionId).first();
    expect(ended.status).toBe("ended");
    const memberCount = await env.CRASH_BOT_DB.prepare(
      "SELECT COUNT(*) AS count FROM anonymous_chat_members WHERE session_id = ?"
    ).bind(sessionId).first();
    expect(memberCount.count).toBe(0);

    await handleRandomChatCallback(env, callback(first, `random:end:${sessionId}`));
    expect(answer.mock.calls.at(-1)[2]).toContain("گفت‌وگوی فعالی نیست");
    await joinRandomChat(env, message(first, 501, "👧 دختر"), first, "woman");
    const next = await env.CRASH_BOT_DB.prepare(`
      SELECT id, status FROM anonymous_sessions WHERE user_a_id = ?
      ORDER BY id DESC LIMIT 1
    `).bind(first).first();
    fixtureSessions.add(next.id);
    expect(next.id).not.toBe(sessionId);
    expect(next.status).toBe("waiting");
  });

  it("relays one message without identity and refuses messages after the session ends", async () => {
    const first = await createUser("man");
    const second = await createUser("woman");
    const sessionId = await activeSession(first, second, "woman");
    const delivery = vi.spyOn(telegramApi, "sendMessageTelegramDetailed")
      .mockResolvedValue({ outcome: "sent", messageId: 900 });
    vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);

    await handleRandomChatMessage(env, message(first, 601, "hello"), first);
    await handleRandomChatMessage(env, message(first, 601, "hello"), first);
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(delivery).toHaveBeenCalledWith(env, second, "hello");
    const saved = await env.CRASH_BOT_DB.prepare(`
      SELECT sender_id, recipient_id, message_type, session_id, delivery_status
      FROM anonymous_messages WHERE source_message_id = ? AND message_type = 'random_chat'
    `).bind(601).first();
    expect(saved).toEqual({
      sender_id: first,
      recipient_id: second,
      message_type: "random_chat",
      session_id: sessionId,
      delivery_status: "sent"
    });

    await handleRandomChatCallback(env, callback(first, `random:end:${sessionId}`));
    delivery.mockClear();
    await handleRandomChatMessage(env, message(first, 602, "after end"), first);
    expect(delivery).not.toHaveBeenCalled();
  });

  it("does not expose participant identity or cross into accepted-connection chats", async () => {
    const first = await createUser("man");
    const second = await createUser("woman");
    await activeSession(first, second, "woman");
    await setPostConversation(env, first, "connection_chat", 1);
    const delivery = vi.spyOn(telegramApi, "sendMessageTelegramDetailed")
      .mockResolvedValue({ outcome: "sent", messageId: 901 });
    vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);

    await handleRandomChatMessage(env, message(first, 701, "not crossed"), first);
    expect(delivery).not.toHaveBeenCalled();

    const connectionMessages = await env.CRASH_BOT_DB.prepare(`
      SELECT COUNT(*) AS count FROM anonymous_messages
      WHERE message_type = 'random_chat'
    `).first();
    expect(connectionMessages.count).toBe(0);
  });

  it("does not leave half a queue entry after a database failure", async () => {
    const user = await createUser("man");
    vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);
    const originalPrepare = env.CRASH_BOT_DB.prepare.bind(env.CRASH_BOT_DB);
    vi.spyOn(env.CRASH_BOT_DB, "prepare").mockImplementation((query) => {
      if (query.includes("INSERT INTO anonymous_sessions")) {
        throw new Error("simulated database failure");
      }
      return originalPrepare(query);
    });

    await expect(joinRandomChat(env, message(user, 801, "👧 دختر"), user, "woman"))
      .rejects.toThrow("simulated database failure");
    vi.restoreAllMocks();
    const sessions = await env.CRASH_BOT_DB.prepare(
      "SELECT COUNT(*) AS count FROM anonymous_sessions WHERE user_a_id = ?"
    ).bind(user).first();
    expect(sessions.count).toBe(0);
    const actions = await env.CRASH_BOT_DB.prepare(
      "SELECT COUNT(*) AS count FROM anonymous_chat_actions WHERE user_id = ?"
    ).bind(user).first();
    expect(actions.count).toBe(0);
  });
});
