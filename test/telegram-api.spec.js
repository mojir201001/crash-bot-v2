import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sendInlineTelegramDetailed,
  sendMediaTelegram,
  sendMediaTelegramDetailed,
  sendMessageTelegramDetailed,
  sendTelegram
} from "../src/telegram/api.js";

const env = {};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Telegram send outcome classification", () => {
  it("classifies a well-formed Telegram rejection as definite", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, description: "Bad Request" })
    })));

    await expect(sendMediaTelegram(env, "sendPhoto", {
      chat_id: 123,
      photo: "unit-file-id"
    })).rejects.toMatchObject({
      telegramOutcome: "rejected",
      telegramDefiniteFailure: true
    });
  });

  it("classifies network errors and invalid responses as uncertain", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connection reset");
    }));
    await expect(sendMediaTelegram(env, "sendPhoto", {
      chat_id: 123,
      photo: "unit-file-id"
    })).rejects.toMatchObject({
      telegramOutcome: "unknown",
      telegramDefiniteFailure: false
    });

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new Error("invalid response"); }
    })));
    await expect(sendMediaTelegramDetailed(env, "sendPhoto", {
      chat_id: 123,
      photo: "unit-file-id"
    })).resolves.toEqual({ outcome: "unknown" });
  });

  it("does not throw on network failures in boolean Telegram helpers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connection reset");
    }));

    await expect(sendTelegram(env, 123, "safe failure"))
      .resolves.toBe(false);
  });

  it("treats server errors and malformed success payloads as uncertain", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ ok: false, description: "Service unavailable" })
    })));
    await expect(sendInlineTelegramDetailed(env, 123, "text", []))
      .resolves.toEqual({ outcome: "unknown" });

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} })
    })));
    await expect(sendInlineTelegramDetailed(env, 123, "text", []))
      .resolves.toEqual({ outcome: "unknown" });
  });
});

describe("Reply keyboard lifecycle", () => {
  it("replies to the specified message without changing keyboard semantics", async () => {
    let payload;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      payload = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 10 } })
      };
    }));

    await sendMessageTelegramDetailed(env, 123, "status", null, 456);

    expect(payload).toMatchObject({
      chat_id: 123,
      text: "status",
      reply_parameters: { message_id: 456 }
    });
    expect(payload.reply_markup).toBeUndefined();
  });

  it("preserves, replaces, and removes the keyboard only when requested", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: { message_id: calls.length }
        })
      };
    }));

    await sendMessageTelegramDetailed(env, 123, "Keep current keyboard");
    const replacement = [[{ text: "🏠 منوی اصلی" }]];
    await sendMessageTelegramDetailed(env, 123, "Replace keyboard", replacement);
    await sendMessageTelegramDetailed(env, 123, "Remove keyboard", []);

    expect(calls.map(({ body }) => body.reply_markup)).toEqual([
      undefined,
      { keyboard: replacement, resize_keyboard: true, is_persistent: false },
      { remove_keyboard: true }
    ]);
  });

  it("does not delete an earlier main-screen message", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: calls.length } })
      };
    }));

    const keyboard = [[{ text: "🏠 منوی اصلی" }]];
    await sendTelegram(env, 123, "👋 سلام، به کراش‌یاب ادیب خوش اومدی!", keyboard);
    await sendTelegram(env, 123, "👋 سلام، به کراش‌یاب ادیب خوش اومدی!", keyboard);

    expect(calls.map(({ url }) => url.split("/").at(-1)))
      .toEqual(["sendMessage", "sendMessage"]);
  });
});
