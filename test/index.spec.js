import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src";
import * as telegramApi from "../src/telegram/api.js";

describe("Crash Bot worker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns healthy status", async () => {
    const request = new Request("http://example.com/health");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "crash-bot-v2"
    });
  });

  it("returns 404 for unknown routes", async () => {
    const request = new Request("http://example.com/unknown");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(404);
  });

  it("rejects webhook requests with an invalid secret", async () => {
    const request = new Request("http://example.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "invalid-secret"
      },
      body: JSON.stringify({ update_id: 1 })
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });

  it("denies a regular user access to the admin moderation section", async () => {
    const sendSpy = vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);

    const originalPrepare = env.CRASH_BOT_DB.prepare.bind(env.CRASH_BOT_DB);
    const prepareSpy = vi.spyOn(env.CRASH_BOT_DB, "prepare").mockImplementation((query) => {
      if (query.includes("INSERT INTO users")) {
        return {
          bind: () => ({ run: async () => ({ success: true }) })
        };
      }

      if (query.includes("SELECT is_blocked, account_status")) {
        return {
          bind: () => ({ first: async () => ({ is_blocked: 0, account_status: "active" }) })
        };
      }

      if (query.includes("SELECT value FROM bot_settings")) {
        return {
          bind: () => ({ first: async () => null })
        };
      }

      if (query.includes("FROM admin_roles")) {
        return {
          bind: () => ({ first: async () => null })
        };
      }

      return originalPrepare(query);
    });

    const request = new Request("http://example.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET
      },
      body: JSON.stringify({
        update_id: 100,
        message: {
          from: { id: 87654321, first_name: "Test" },
          chat: { id: 87654321, type: "private" },
          text: "🔎 بررسی پیام‌های ناشناس"
        }
      })
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(prepareSpy).toHaveBeenCalled();
    expect(sendSpy).toHaveBeenCalledWith(
      env,
      87654321,
      "برای دسترسی به این بخش مجوز مدیریت لازم است.",
      expect.any(Array)
    );
  });

  it("denies an admin access to the owner-only admin management section", async () => {
    const sendSpy = vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);

    const originalPrepare = env.CRASH_BOT_DB.prepare.bind(env.CRASH_BOT_DB);
    vi.spyOn(env.CRASH_BOT_DB, "prepare").mockImplementation((query) => {
      if (query.includes("INSERT INTO users")) {
        return {
          bind: () => ({ run: async () => ({ success: true }) })
        };
      }

      if (query.includes("SELECT is_blocked, account_status")) {
        return {
          bind: () => ({ first: async () => ({ is_blocked: 0, account_status: "active" }) })
        };
      }

      if (query.includes("SELECT value FROM bot_settings")) {
        return {
          bind: () => ({ first: async () => null })
        };
      }

      if (query.includes("FROM admin_roles")) {
        return {
          bind: () => ({ first: async () => ({ user_id: 87654321 }) })
        };
      }

      return originalPrepare(query);
    });

    const request = new Request("http://example.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET
      },
      body: JSON.stringify({
        update_id: 101,
        message: {
          from: { id: 87654321, first_name: "TestAdmin" },
          chat: { id: 87654321, type: "private" },
          text: "👥 مدیریت ادمین‌ها"
        }
      })
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(sendSpy).toHaveBeenCalledWith(
      env,
      87654321,
      "این بخش فقط برای مالک اصلی در دسترس است.",
      expect.any(Array)
    );
  });
});

  it("requires profile completion when the user presses /start", async () => {
    const screenSpy = vi.spyOn(telegramApi, "sendTrackedSectionNoticeTelegram")
      .mockResolvedValue(true);

    vi.spyOn(env.CRASH_BOT_DB, "prepare").mockImplementation((query) => {
      if (query.includes("INSERT INTO users")) {
        return { bind: () => ({ run: async () => ({ success: true }) }) };
      }
      if (query.includes("SELECT is_blocked, account_status")) {
        return { bind: () => ({ first: async () => ({ is_blocked: 0, account_status: "active" }) }) };
      }
      if (query.includes("SELECT value FROM bot_settings")) {
        return {
          bind: () => ({ first: async () => null })
        };
      }

      if (query.includes("FROM admin_roles")) {
        return { bind: () => ({ first: async () => null }) };
      }
      return { bind: () => ({ first: async () => null, run: async () => ({ success: true }) }) };
    });

    const request = new Request("http://example.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET
      },
      body: JSON.stringify({
        update_id: 102,
        message: {
          from: { id: 87654322, first_name: "Test" },
          chat: { id: 87654322, type: "private" },
          text: "/start"
        }
      })
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(screenSpy).toHaveBeenCalled();
    expect(screenSpy.mock.calls.some((call) =>
      String(call[2]).includes("تکمیل پروفایل") &&
      String(call[2]).includes("لقب اجباری")
    )).toBe(true);
  });

  it("opens the owner admin panel when the owner presses the management button", async () => {
    const sendSpy = vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);

    vi.spyOn(env.CRASH_BOT_DB, "prepare").mockImplementation((query) => {
      if (query.includes("INSERT INTO users")) {
        return { bind: () => ({ run: async () => ({ success: true }) }) };
      }
      if (query.includes("SELECT is_blocked, account_status")) {
        return { bind: () => ({ first: async () => ({ is_blocked: 0, account_status: "active" }) }) };
      }
      return { bind: () => ({ first: async () => null, run: async () => ({ success: true }) }) };
    });

    const request = new Request("http://example.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET
      },
      body: JSON.stringify({
        update_id: 103,
        message: {
          from: { id: Number(env.OWNER_TELEGRAM_ID), first_name: "Owner" },
          chat: { id: Number(env.OWNER_TELEGRAM_ID), type: "private" },
          text: "🛠 پنل مدیریت"
        }
      })
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(sendSpy).toHaveBeenCalledWith(
      env,
      Number(env.OWNER_TELEGRAM_ID),
      expect.stringContaining("پنل مدیریت مالک اصلی"),
      expect.any(Array)
    );
  });


it("ignores ordinary messages from groups", async () => {
  const sendSpy = vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);

  const request = new Request("http://example.com/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET
    },
    body: JSON.stringify({
      update_id: 104,
      message: {
        from: { id: 87654323, first_name: "GroupTest" },
        chat: { id: -1001234567890, type: "supergroup" },
        text: "/start"
      }
    })
  });

  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);

  expect(response.status).toBe(200);
  expect(sendSpy).not.toHaveBeenCalled();
});

it("denies a regular user direct access to the admin home route", async () => {
  const sendSpy = vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);

  vi.spyOn(env.CRASH_BOT_DB, "prepare").mockImplementation((query) => {
    if (query.includes("INSERT INTO users")) {
      return { bind: () => ({ run: async () => ({ success: true }) }) };
    }
    if (query.includes("SELECT is_blocked, account_status")) {
      return { bind: () => ({ first: async () => ({ is_blocked: 0, account_status: "active" }) }) };
    }
    if (query.includes("SELECT value FROM bot_settings")) {
      return { bind: () => ({ first: async () => null }) };
    }
    if (query.includes("FROM admin_roles")) {
      return { bind: () => ({ first: async () => null }) };
    }
    return { bind: () => ({ first: async () => null, run: async () => ({ success: true }) }) };
  });

  const request = new Request("http://example.com/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET
    },
    body: JSON.stringify({
      update_id: 105,
      message: {
        from: { id: 87654324, first_name: "Test" },
        chat: { id: 87654324, type: "private" },
        text: "↩️ بازگشت به پنل مدیریت"
      }
    })
  });

  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);

  expect(response.status).toBe(200);
  expect(sendSpy).toHaveBeenCalledWith(
    env,
    87654324,
    "⛔️ دسترسی به پنل مدیریت ندارید.",
    expect.any(Array)
  );
});
