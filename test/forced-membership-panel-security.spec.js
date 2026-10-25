import { describe, it, expect, vi, afterEach } from "vitest";
import {
  handleForcedMembershipCallback,
  handleForcedMembershipChatUpdate
} from "../src/services/forced-membership-panel.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeEnv() {
  const settings = new Map();
  const env = {
    TELEGRAM_BOT_TOKEN: "test-token",
    OWNER_TELEGRAM_ID: "100",
    CRASH_BOT_DB: {
      prepare(sql) {
        let key;
        let value;
        return {
          bind(...args) {
            key = args[0];
            value = args[1];
            return this;
          },
          async first() {
            return settings.has(key) ? { value: settings.get(key) } : null;
          },
          async run() {
            if (sql.includes("DELETE FROM bot_settings")) {
              settings.delete(key);
            } else if (sql.includes("INSERT INTO bot_settings")) {
              settings.set(key, value);
            }
            return { success: true };
          }
        };
      }
    }
  };
  return { env, settings };
}

function mockFetch() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, result: true })
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Forced membership panel security", () => {
  it("ignores callbacks from non-owners", async () => {
    const { env, settings } = makeEnv();
    const fetchMock = mockFetch();

    await handleForcedMembershipCallback(env, {
      id: "cb1",
      data: "fm:add",
      from: { id: 200 },
      message: { chat: { id: 200, type: "private" }, message_id: 1 }
    });

    expect(settings.size).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toContain("/answerCallbackQuery");
  });

  it("rejects owner callbacks outside the private owner chat", async () => {
    const { env, settings } = makeEnv();
    const fetchMock = mockFetch();

    await handleForcedMembershipCallback(env, {
      id: "cb2",
      data: "fm:add",
      from: { id: 100 },
      message: { chat: { id: -100, type: "supergroup" }, message_id: 1 }
    });

    expect(settings.size).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toContain("/answerCallbackQuery");
  });

  it("does not process a callback from an unknown message context", async () => {
    const { env, settings } = makeEnv();
    const fetchMock = mockFetch();

    await handleForcedMembershipCallback(env, {
      id: "cb3",
      data: "fm:add",
      from: { id: 100 }
    });

    expect(settings.size).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toContain("/answerCallbackQuery");
  });

  it("does not accept a private chat until the owner confirms it", async () => {
    const { env, settings } = makeEnv();
    const fetchMock = mockFetch();

    settings.set("forced_membership_pending_add", JSON.stringify({
      mode: "private",
      inviteUrl: "https://t.me/+privateInvite"
    }));

    await handleForcedMembershipChatUpdate(env, {
      my_chat_member: {
        from: { id: 100 },
        chat: { id: -100123, title: "Private group", type: "supergroup" },
        new_chat_member: { status: "administrator" }
      }
    });

    const channels = JSON.parse(settings.get("forced_membership_channels") || "[]");
    const pending = JSON.parse(settings.get("forced_membership_pending_add"));

    expect(channels).toEqual([]);
    expect(pending.mode).toBe("private-confirm");
    expect(pending.chatId).toBe("-100123");
    expect(fetchMock).toHaveBeenCalled();
  });
});
