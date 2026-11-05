import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { upsertTelegramUser } from "../src/services/telegram-users.js";

const userIds = new Set();

afterEach(async () => {
  for (const userId of userIds) {
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM users WHERE telegram_id = ?"
    ).bind(userId).run();
  }
  userIds.clear();
});

describe("Telegram identity snapshots", () => {
  it("updates names and username without changing the numeric identity", async () => {
    const id = 780000000 + Math.floor(Math.random() * 10000000);
    userIds.add(id);
    await upsertTelegramUser(env, {
      id,
      username: "old_name",
      first_name: "Old",
      last_name: "Name"
    });
    await upsertTelegramUser(env, {
      id,
      username: "new_name",
      first_name: "New",
      last_name: "Surname"
    });

    const row = await env.CRASH_BOT_DB.prepare(`
      SELECT telegram_id, username, first_name, last_name
      FROM users WHERE telegram_id = ?
    `).bind(id).first();
    expect(row).toEqual({
      telegram_id: id,
      username: "new_name",
      first_name: "New",
      last_name: "Surname"
    });
    await expect(upsertTelegramUser(env, {
      id: Number.MAX_SAFE_INTEGER + 1,
      username: "unsafe"
    })).rejects.toThrow("positive safe integer");
  });
});
