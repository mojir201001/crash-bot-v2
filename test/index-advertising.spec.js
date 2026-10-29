import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import * as telegramApi from "../src/telegram/api.js";
import { saveProfileField } from "../src/services/profile.js";

const userId = 730000001;

async function seedCompleteUser() {
  await env.CRASH_BOT_DB.prepare(`
    INSERT OR IGNORE INTO users (telegram_id, username, first_name)
    VALUES (?, 'active_ad_user', 'Ad request test')
  `).bind(userId).run();
  for (const [field, value] of [
    ["nickname", "لقب"],
    ["bio", "درباره"],
    ["city", "تهران"],
    ["birth_year", "1380"],
    ["birth_month", "فروردین"],
    ["marital_status", "مجرد"],
    ["gender", "مرد"],
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

afterEach(async () => {
  vi.restoreAllMocks();
  await env.CRASH_BOT_DB.prepare(`
    DELETE FROM advertising_conversations WHERE requester_id = ?
  `).bind(userId).run();
  await env.CRASH_BOT_DB.prepare(
    "DELETE FROM users WHERE telegram_id = ?"
  ).bind(userId).run();
  await env.CRASH_BOT_DB.prepare(
    "DELETE FROM bot_settings WHERE key = 'bot_enabled'"
  ).run();
  await env.CRASH_BOT_DB.prepare(
    "DELETE FROM bot_settings WHERE key = ?"
  ).bind(`broadcast_input:${env.OWNER_TELEGRAM_ID}`).run();
});

describe("active Worker advertising route", () => {
  it("opens a private request and forwards the next user message only to the owner", async () => {
    await seedCompleteUser();
    vi.spyOn(telegramApi, "sendTrackedSectionInlineTelegram").mockResolvedValue(true);
    vi.spyOn(telegramApi, "sendMessageTelegramDetailed")
      .mockResolvedValue({ outcome: "sent" });
    vi.spyOn(telegramApi, "deleteTelegramMessage").mockResolvedValue(false);

    const entry = await postUpdate({
      update_id: 9001,
      message: {
        message_id: 1,
        from: { id: userId, username: "active_ad_user", first_name: "Ad request test" },
        chat: { id: userId, type: "private" },
        text: "📢 ثبت درخواست تبلیغات"
      }
    });
    expect(entry.status).toBe(200);

    const sent = await postUpdate({
      update_id: 9002,
      message: {
        message_id: 2,
        from: { id: userId, username: "active_ad_user", first_name: "Ad request test" },
        chat: { id: userId, type: "private" },
        text: "می‌خواهم دربارهٔ تبلیغ گفت‌وگو کنم"
      }
    });
    expect(sent.status).toBe(200);
    const saved = await env.CRASH_BOT_DB.prepare(`
      SELECT sender_id, sender_role, message, delivery_status
      FROM advertising_messages
      WHERE sender_id = ? ORDER BY id DESC LIMIT 1
    `).bind(userId).first();
    expect(saved).toEqual({
      sender_id: userId,
      sender_role: "requester",
      message: "می‌خواهم دربارهٔ تبلیغ گفت‌وگو کنم",
      delivery_status: "sent"
    });
    expect(telegramApi.sendMessageTelegramDetailed.mock.calls.some((call) =>
      String(call[1]) === String(env.OWNER_TELEGRAM_ID) &&
      call[2].includes(`Telegram ID: ${userId}`)
    )).toBe(true);
  });

  it("keeps menu and help available while the owner has disabled ordinary features", async () => {
    await env.CRASH_BOT_DB.prepare(`
      INSERT OR IGNORE INTO users (telegram_id, first_name)
      VALUES (?, 'Paused user')
    `).bind(userId).run();
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO bot_settings (key, value) VALUES ('bot_enabled', '0')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();
    const menuSpy = vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);
    const rulesSpy = vi.spyOn(telegramApi, "sendTrackedSectionNoticeTelegram")
      .mockResolvedValue(true);
    vi.spyOn(telegramApi, "deleteTelegramMessage").mockResolvedValue(false);

    await postUpdate({
      update_id: 9003,
      message: {
        message_id: 3,
        from: { id: userId, first_name: "Paused user" },
        chat: { id: userId, type: "private" },
        text: "/start"
      }
    });
    expect(menuSpy.mock.calls.some((call) =>
      call[1] === userId && call[2].includes("به کراش‌یاب ادیب")
    )).toBe(true);

    await postUpdate({
      update_id: 9004,
      message: {
        message_id: 4,
        from: { id: userId, first_name: "Paused user" },
        chat: { id: userId, type: "private" },
        text: "💌 ثبت پست کراش"
      }
    });
    expect(menuSpy.mock.calls.some((call) =>
      call[2].includes("ربات موقتاً غیرفعال است")
    )).toBe(true);

    await postUpdate({
      update_id: 9005,
      message: {
        message_id: 5,
        from: { id: userId, first_name: "Paused user" },
        chat: { id: userId, type: "private" },
        text: "📖 راهنما و قوانین"
      }
    });
    expect(rulesSpy).toHaveBeenCalled();
  });

  it("routes owner broadcast and settings menu actions in the active Worker", async () => {
    const ownerId = Number(env.OWNER_TELEGRAM_ID);
    const inlineSpy = vi.spyOn(telegramApi, "sendTrackedSectionInlineTelegram")
      .mockResolvedValue(true);
    const noticeSpy = vi.spyOn(telegramApi, "sendTrackedSectionNoticeTelegram")
      .mockResolvedValue(true);
    vi.spyOn(telegramApi, "deleteTelegramMessage").mockResolvedValue(false);

    await postUpdate({
      update_id: 9006,
      message: {
        message_id: 6,
        from: { id: ownerId, first_name: "Owner" },
        chat: { id: ownerId, type: "private" },
        text: "📣 پیام همگانی"
      }
    });
    expect(inlineSpy.mock.calls.some((call) =>
      call[1] === ownerId && call[2].includes("فقط یک کمپین")
    )).toBe(true);

    await postUpdate({
      update_id: 9007,
      message: {
        message_id: 7,
        from: { id: ownerId, first_name: "Owner" },
        chat: { id: ownerId, type: "private" },
        text: "📣 شروع پیام همگانی"
      }
    });
    expect(noticeSpy.mock.calls.some((call) =>
      call[1] === ownerId && call[2].includes("محتوای پیام همگانی")
    )).toBe(true);

    await postUpdate({
      update_id: 9008,
      message: {
        message_id: 8,
        from: { id: ownerId, first_name: "Owner" },
        chat: { id: ownerId, type: "private" },
        text: "⚙️ تنظیمات ربات"
      }
    });
    expect(inlineSpy.mock.calls.some((call) =>
      call[1] === ownerId && call[2].includes("وضعیت environment")
    )).toBe(true);
  });

  it("routes the Excel menu action through the Worker without a real Telegram request", async () => {
    const ownerId = Number(env.OWNER_TELEGRAM_ID);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 301 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    vi.spyOn(telegramApi, "deleteTelegramMessage").mockResolvedValue(false);
    const response = await postUpdate({
      update_id: 9009,
      message: {
        message_id: 9,
        from: { id: ownerId, first_name: "Owner" },
        chat: { id: ownerId, type: "private" },
        text: "📊 خروجی Excel"
      }
    });
    expect(response.status).toBe(200);
    expect(fetchSpy.mock.calls.some((call) =>
      String(call[0]).endsWith("/sendDocument")
    )).toBe(true);
    expect(fetchSpy.mock.calls.some((call) =>
      call[1]?.body instanceof FormData &&
      call[1].body.get("document")?.name.endsWith(".xlsx")
    )).toBe(true);
  });
});
