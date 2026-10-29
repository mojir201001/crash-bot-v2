import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import * as telegramApi from "../src/telegram/api.js";
import { saveProfileField } from "../src/services/profile.js";

const users = [760000001, 760000002];

async function seedUser(userId, username, gender) {
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES (?, ?, 'Random chat integration')
  `).bind(userId, username).run();
  for (const [field, value] of [
    ["nickname", `لقب ${username}`],
    ["bio", "درباره"],
    ["city", "تهران"],
    ["birth_year", "1380"],
    ["birth_month", "فروردین"],
    ["marital_status", "مجرد"],
    ["gender", gender],
    ["job", "کار ندارم"],
    ["religion", "مذهب"],
    ["religious_sect", "ندارم"],
    ["field", "علوم آزمایشگاهی"]
  ]) {
    await saveProfileField(env, userId, field, value);
  }
}

async function postUpdate(update) {
  const request = new Request("http://example.com/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET
    },
    body: JSON.stringify(update)
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function sendMessage(userId, messageId, updateId, text) {
  return postUpdate({
    update_id: updateId,
    message: {
      message_id: messageId,
      from: { id: userId },
      chat: { id: userId, type: "private" },
      text
    }
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  const placeholders = users.map(() => "?").join(",");
  await env.CRASH_BOT_DB.prepare(`
    DELETE FROM anonymous_chat_members WHERE user_id IN (${placeholders})
  `).bind(...users).run();
  await env.CRASH_BOT_DB.prepare(`
    DELETE FROM anonymous_messages
    WHERE sender_id IN (${placeholders}) OR recipient_id IN (${placeholders})
  `).bind(...users, ...users).run();
  await env.CRASH_BOT_DB.prepare(`
    DELETE FROM anonymous_sessions
    WHERE user_a_id IN (${placeholders}) OR user_b_id IN (${placeholders})
  `).bind(...users, ...users).run();
  await env.CRASH_BOT_DB.prepare(`
    DELETE FROM random_chat_rate_limits WHERE user_id IN (${placeholders})
  `).bind(...users).run();
  await env.CRASH_BOT_DB.prepare(`
    DELETE FROM anonymous_chat_actions WHERE user_id IN (${placeholders})
  `).bind(...users).run();
  await env.CRASH_BOT_DB.prepare(`
    DELETE FROM users WHERE telegram_id IN (${placeholders})
  `).bind(...users).run();
});

describe("active Worker random chat route", () => {
  it("matches users through the menus and relays messages only inside the random session", async () => {
    await seedUser(users[0], "random_a", "مرد");
    await seedUser(users[1], "random_b", "زن");
    vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);
    vi.spyOn(telegramApi, "sendInlineTelegram").mockResolvedValue(true);
    vi.spyOn(telegramApi, "sendInlineTelegramDetailed")
      .mockResolvedValue({ outcome: "sent", messageId: 88 });
    vi.spyOn(telegramApi, "sendMessageTelegramDetailed")
      .mockResolvedValue({ outcome: "sent" });
    vi.spyOn(telegramApi, "deleteTelegramMessage").mockResolvedValue(false);

    expect((await sendMessage(users[0], 1, 11001, "🎭 چت ناشناس تصادفی")).status)
      .toBe(200);
    expect((await sendMessage(users[0], 2, 11002, "🔍 پیدا کردن فرد")).status)
      .toBe(200);
    expect((await sendMessage(users[0], 3, 11003, "👧 دختر")).status)
      .toBe(200);
    expect((await sendMessage(users[1], 1, 11004, "🎭 چت ناشناس تصادفی")).status)
      .toBe(200);
    expect((await sendMessage(users[1], 2, 11005, "🔍 پیدا کردن فرد")).status)
      .toBe(200);
    expect((await sendMessage(users[1], 3, 11006, "👦 پسر")).status)
      .toBe(200);

    const session = await env.CRASH_BOT_DB.prepare(`
      SELECT id, user_a_id, user_b_id, status FROM anonymous_sessions
      WHERE user_a_id = ? OR user_b_id = ?
    `).bind(users[0], users[0]).first();
    expect(session).toMatchObject({
      user_a_id: users[0],
      user_b_id: users[1],
      status: "active"
    });

    expect((await sendMessage(users[0], 4, 11007, "پیام ناشناس")).status)
      .toBe(200);
    const saved = await env.CRASH_BOT_DB.prepare(`
      SELECT sender_id, recipient_id, message_type, session_id, message
      FROM anonymous_messages WHERE sender_id = ? AND source_message_id = ?
    `).bind(users[0], 4).first();
    expect(saved).toEqual({
      sender_id: users[0],
      recipient_id: users[1],
      message_type: "random_chat",
      session_id: session.id,
      message: "پیام ناشناس"
    });
    expect(telegramApi.sendMessageTelegramDetailed).toHaveBeenCalledWith(
      env,
      users[1],
      "پیام ناشناس"
    );
  });
});
