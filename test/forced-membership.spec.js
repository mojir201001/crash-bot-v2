import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getRequiredChannels,
  saveRequiredChannels,
  checkRequiredMembership
} from "../src/services/forced-membership.js";

function createEnv(channels = []) {
  const rows = new Map();

  if (channels.length) {
    rows.set("forced_membership_channels", JSON.stringify(channels));
  }

  const db = {
    prepare: vi.fn((sql) => ({
      bind: (...args) => ({
        first: async () => {
          if (sql.includes("SELECT value")) {
            const value = rows.get(args[0]);
            return value === undefined ? null : { value };
          }
          return null;
        },
        run: async () => {
          if (sql.includes("INSERT INTO bot_settings")) {
            rows.set(args[0], args[1]);
          }
          return { success: true };
        }
      })
    }))
  };

  return { CRASH_BOT_DB: db, TELEGRAM_BOT_TOKEN: "test-token" };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("forced membership service", () => {
  it("returns no required channels when none are configured", async () => {
    const env = createEnv();
    await expect(getRequiredChannels(env)).resolves.toEqual([]);
  });

  it("saves and reads required channels", async () => {
    const env = createEnv();
    const channels = [
      { chatId: "@required_channel", inviteUrl: "https://t.me/required_channel" }
    ];

    await saveRequiredChannels(env, channels);

    await expect(getRequiredChannels(env)).resolves.toEqual(channels);
  });

  it("passes when no channels are configured", async () => {
    const env = createEnv();
    await expect(checkRequiredMembership(env, 123)).resolves.toEqual({
      passed: true,
      missing: [],
      error: false
    });
  });

  it("passes when the user is a member", async () => {
    const env = createEnv([
      { chatId: "@required_channel", inviteUrl: "https://t.me/required_channel" }
    ]);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: { status: "member" }
      })
    }));

    const result = await checkRequiredMembership(env, 123);
    expect(result.passed).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.error).toBe(false);
  });

  it("blocks users who are not members", async () => {
    const channel = {
      chatId: "@required_channel",
      inviteUrl: "https://t.me/required_channel"
    };
    const env = createEnv([channel]);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: { status: "left" }
      })
    }));

    const result = await checkRequiredMembership(env, 123);
    expect(result.passed).toBe(false);
    expect(result.missing).toEqual([channel]);
    expect(result.error).toBe(false);
  });

  it("fails closed when Telegram cannot verify membership", async () => {
    const env = createEnv([
      { chatId: "@required_channel", inviteUrl: "https://t.me/required_channel" }
    ]);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const result = await checkRequiredMembership(env, 123);
    expect(result.passed).toBe(false);
    expect(result.error).toBe(true);
  });
});
