import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sendInlineTelegramDetailed,
  sendMediaTelegram,
  sendMediaTelegramDetailed
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
