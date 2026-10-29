import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as telegramApi from "../src/telegram/api.js";
import {
  DEFAULT_BOT_RULES,
  getBotRules,
  handleRulesCallback,
  handleRulesMessage,
  startRulesEdit
} from "../src/services/rules.js";
import {
  getBotEnabledState,
  handleSettingsCallback,
  handleSettingsMessage,
  renderSettings
} from "../src/services/settings.js";

const ownerId = Number(env.OWNER_TELEGRAM_ID);
const RULES_KEY = "bot_rules_text";
const SETTINGS_KEYS = [
  "bot_enabled",
  "crash_channel_id",
  "crash_channel_url",
  "telegram_bot_username",
  `rules_edit_pending:${ownerId}`,
  `settings_edit_pending:${ownerId}`
];

function callback(userId, data) {
  return {
    id: `settings-${Math.random()}`,
    data,
    from: { id: userId },
    message: {
      chat: { id: userId, type: "private" },
      message_id: 200
    }
  };
}

function message(text) {
  return {
    from: { id: ownerId },
    chat: { id: ownerId, type: "private" },
    message_id: 201,
    text
  };
}

async function readStored(key) {
  return env.CRASH_BOT_DB.prepare(
    "SELECT value FROM bot_settings WHERE key = ?"
  ).bind(key).first();
}

beforeEach(async () => {
  await env.CRASH_BOT_DB.prepare(`
    INSERT OR IGNORE INTO users (telegram_id, first_name)
    VALUES (?, 'Owner test')
  `).bind(ownerId).run();
  vi.spyOn(telegramApi, "sendTrackedSectionInlineTelegram").mockResolvedValue(true);
  vi.spyOn(telegramApi, "sendTrackedSectionNoticeTelegram").mockResolvedValue(true);
  vi.spyOn(telegramApi, "answerCallbackQuery").mockResolvedValue(true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.CRASH_BOT_DB.prepare(
    "DELETE FROM bot_rules_history WHERE changed_by = ?"
  ).bind(ownerId).run();
  for (const key of [...SETTINGS_KEYS, RULES_KEY]) {
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM bot_settings WHERE key = ?"
    ).bind(key).run();
  }
});

describe("owner-managed rules and settings", () => {
  it("serves a single default rules source and stores owner-confirmed versions", async () => {
    expect(await getBotRules(env)).toBe(DEFAULT_BOT_RULES);
    await startRulesEdit(env, ownerId, ownerId);
    await handleRulesMessage(env, message("قانون جدید و معتبر"), ownerId);
    expect(telegramApi.sendTrackedSectionInlineTelegram).toHaveBeenCalled();
    await handleRulesCallback(env, callback(ownerId, "rules:confirm"));
    expect(await getBotRules(env)).toBe("قانون جدید و معتبر");
    const history = await env.CRASH_BOT_DB.prepare(`
      SELECT content, changed_by FROM bot_rules_history
      WHERE changed_by = ? ORDER BY id DESC LIMIT 1
    `).bind(ownerId).first();
    expect(history).toEqual({ content: "قانون جدید و معتبر", changed_by: ownerId });
  });

  it("rejects empty or oversized rules and does not allow a regular user to save", async () => {
    await startRulesEdit(env, ownerId, ownerId);
    await handleRulesMessage(env, message("   "), ownerId);
    const state = await readStored(`rules_edit_pending:${ownerId}`);
    expect(JSON.parse(state.value).stage).toBe("input");
    await handleRulesMessage(env, message("x".repeat(3501)), ownerId);
    expect((await getBotRules(env)).length).toBe(DEFAULT_BOT_RULES.length);
    await handleRulesCallback(env, callback(88112233, "rules:confirm"));
    expect(await getBotRules(env)).toBe(DEFAULT_BOT_RULES);
  });

  it("fails closed for invalid enabled values and persists owner toggles", async () => {
    expect(await getBotEnabledState(env)).toEqual({ enabled: true, valid: true });
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO bot_settings (key, value) VALUES ('bot_enabled', 'invalid')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();
    expect(await getBotEnabledState(env)).toEqual({ enabled: false, valid: false });

    await handleSettingsCallback(env, callback(ownerId, "settings:enabled:1"));
    expect(await getBotEnabledState(env)).toEqual({ enabled: true, valid: true });
    await handleSettingsCallback(env, callback(ownerId, "settings:enabled:0"));
    expect(await getBotEnabledState(env)).toEqual({ enabled: false, valid: true });
  });

  it("validates and confirms operational settings without exposing environment secrets", async () => {
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO bot_settings (key, value) VALUES ('crash_channel_id', '@oldchannel')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();
    await handleSettingsCallback(
      env,
      callback(ownerId, "settings:edit:crash_channel_id")
    );
    await handleSettingsMessage(env, message("نامعتبر"), ownerId);
    expect((await readStored("crash_channel_id")).value).toBe("@oldchannel");
    await handleSettingsMessage(env, message("@newchannel"), ownerId);
    await handleSettingsCallback(env, callback(ownerId, "settings:save"));
    expect((await readStored("crash_channel_id")).value).toBe("@newchannel");

    await renderSettings(env, ownerId, ownerId);
    const rendered = telegramApi.sendTrackedSectionInlineTelegram.mock.calls
      .map((call) => call[2]).join("\n");
    expect(rendered).not.toContain(String(env.TELEGRAM_BOT_TOKEN));
    expect(rendered).not.toContain(String(env.WEBHOOK_SECRET));
    expect(rendered).toContain("شناسهٔ کانال انتشار");
  });

  it("does not let admins alter settings via forged callbacks", async () => {
    const adminId = 88112233;
    await handleSettingsCallback(env, callback(adminId, "settings:enabled:0"));
    expect(await getBotEnabledState(env)).toEqual({ enabled: true, valid: true });
    expect(telegramApi.answerCallbackQuery).toHaveBeenCalled();
  });

  it("keeps the previous rules and setting values when the database batch fails", async () => {
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO bot_settings (key, value) VALUES (?, 'قانون قبلی')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).bind(RULES_KEY).run();
    await startRulesEdit(env, ownerId, ownerId);
    await handleRulesMessage(env, message("قانون جدید"), ownerId);
    const rulesBatch = vi.spyOn(env.CRASH_BOT_DB, "batch")
      .mockRejectedValue(new Error("local database unavailable"));
    await handleRulesCallback(env, callback(ownerId, "rules:confirm"));
    expect(await getBotRules(env)).toBe("قانون قبلی");
    rulesBatch.mockRestore();

    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO bot_settings (key, value) VALUES ('crash_channel_id', '@oldchannel')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();
    await handleSettingsCallback(
      env,
      callback(ownerId, "settings:edit:crash_channel_id")
    );
    await handleSettingsMessage(env, message("@newchannel"), ownerId);
    const settingsBatch = vi.spyOn(env.CRASH_BOT_DB, "batch")
      .mockRejectedValue(new Error("local database unavailable"));
    await handleSettingsCallback(env, callback(ownerId, "settings:save"));
    expect((await readStored("crash_channel_id")).value).toBe("@oldchannel");
    settingsBatch.mockRestore();
  });
});
