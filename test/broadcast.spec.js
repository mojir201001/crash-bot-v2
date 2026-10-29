import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as telegramApi from "../src/telegram/api.js";
import {
  handleBroadcastCallback,
  handleBroadcastMessage,
  startBroadcast
} from "../src/services/broadcast.js";

const users = new Set();
const campaigns = new Set();

beforeEach(async () => {
  await env.CRASH_BOT_DB.prepare(`
    INSERT OR IGNORE INTO users (telegram_id, first_name)
    VALUES (?, 'Owner test')
  `).bind(Number(env.OWNER_TELEGRAM_ID)).run();
});

async function createUser(blocked = false) {
  const userId = 750000000 + Math.floor(Math.random() * 10000000);
  users.add(userId);
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO users (telegram_id, is_blocked, account_status)
    VALUES (?, ?, 'active')
  `).bind(userId, blocked ? 1 : 0).run();
  return userId;
}

function callback(userId, data) {
  return {
    id: `broadcast-${Math.random()}`,
    data,
    from: { id: userId },
    message: {
      chat: { id: userId, type: "private" },
      message_id: 100
    }
  };
}

function mockTelegram(outcome = "sent") {
  vi.spyOn(telegramApi, "sendTrackedSectionInlineTelegram").mockResolvedValue(true);
  vi.spyOn(telegramApi, "sendTrackedSectionNoticeTelegram").mockResolvedValue(true);
  vi.spyOn(telegramApi, "sendMessageTelegramDetailed").mockResolvedValue({ outcome });
  vi.spyOn(telegramApi, "sendMediaTelegramDetailed").mockResolvedValue({ outcome });
  vi.spyOn(telegramApi, "answerCallbackQuery").mockResolvedValue(true);
}

async function createCampaign(content = "اعلان آزمایشی") {
  const row = await env.CRASH_BOT_DB.prepare(`
    INSERT INTO broadcast_campaigns (created_by, content)
    VALUES (?, ?) RETURNING id
  `).bind(Number(env.OWNER_TELEGRAM_ID), content).first();
  campaigns.add(row.id);
  return row.id;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const campaignId of campaigns) {
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM broadcast_deliveries WHERE campaign_id = ?"
    ).bind(campaignId).run();
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM broadcast_campaigns WHERE id = ?"
    ).bind(campaignId).run();
  }
  campaigns.clear();
  for (const userId of users) {
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM users WHERE telegram_id = ?"
    ).bind(userId).run();
  }
  users.clear();
});

describe("owner broadcast campaigns", () => {
  it("requires an owner preview and final confirmation before sending", async () => {
    mockTelegram();
    const ownerId = Number(env.OWNER_TELEGRAM_ID);
    const userId = await createUser();
    await startBroadcast(env, ownerId, ownerId);
    await handleBroadcastMessage(env, {
      from: { id: ownerId },
      chat: { id: ownerId, type: "private" },
      message_id: 101,
      text: "پیام آزمایشی"
    }, ownerId);
    const row = await env.CRASH_BOT_DB.prepare(`
      SELECT id, status, content FROM broadcast_campaigns
      WHERE created_by = ? ORDER BY id DESC LIMIT 1
    `).bind(ownerId).first();
    campaigns.add(row.id);
    expect(row.status).toBe("draft");
    expect(row.content).toBe("پیام آزمایشی");
    expect(telegramApi.sendMessageTelegramDetailed).not.toHaveBeenCalled();
    expect(userId).toBeTruthy();
  });

  it("snapshots eligible recipients, sends in bounded batches, and resumes only pending deliveries", async () => {
    mockTelegram();
    const ownerId = Number(env.OWNER_TELEGRAM_ID);
    const recipients = [];
    for (let index = 0; index < 25; index += 1) {
      recipients.push(await createUser());
    }
    const blocked = await createUser(true);
    const campaignId = await createCampaign();

    await handleBroadcastCallback(env, callback(ownerId, `broadcast:send:${campaignId}`));
    let rows = await env.CRASH_BOT_DB.prepare(`
      SELECT status FROM broadcast_deliveries WHERE campaign_id = ?
    `).bind(campaignId).all();
    expect(rows.results).toHaveLength(25);
    expect(rows.results.filter((row) => row.status === "sent")).toHaveLength(20);
    expect(rows.results.filter((row) => row.status === "pending")).toHaveLength(5);
    expect(telegramApi.sendMessageTelegramDetailed).toHaveBeenCalledTimes(20);
    expect((await env.CRASH_BOT_DB.prepare(
      "SELECT COUNT(*) AS total FROM broadcast_deliveries WHERE campaign_id = ? AND user_id = ?"
    ).bind(campaignId, blocked).first()).total).toBe(0);

    await handleBroadcastCallback(env, callback(ownerId, `broadcast:continue:${campaignId}`));
    rows = await env.CRASH_BOT_DB.prepare(`
      SELECT status FROM broadcast_deliveries WHERE campaign_id = ?
    `).bind(campaignId).all();
    expect(rows.results.filter((row) => row.status === "sent")).toHaveLength(25);
    expect(telegramApi.sendMessageTelegramDetailed).toHaveBeenCalledTimes(25);
  });

  it("prevents concurrent duplicate delivery and does not retry unknown results", async () => {
    mockTelegram("unknown");
    const ownerId = Number(env.OWNER_TELEGRAM_ID);
    const recipient = await createUser();
    const campaignId = await createCampaign("نامشخص");
    await Promise.all([
      handleBroadcastCallback(env, callback(ownerId, `broadcast:send:${campaignId}`)),
      handleBroadcastCallback(env, callback(ownerId, `broadcast:send:${campaignId}`))
    ]);
    const row = await env.CRASH_BOT_DB.prepare(`
      SELECT status, attempts FROM broadcast_deliveries
      WHERE campaign_id = ? AND user_id = ?
    `).bind(campaignId, recipient).first();
    expect(row.status).toBe("unknown");
    expect(row.attempts).toBe(1);
    expect(telegramApi.sendMessageTelegramDetailed).toHaveBeenCalledTimes(1);

    await handleBroadcastCallback(env, callback(ownerId, `broadcast:send:${campaignId}`));
    const after = await env.CRASH_BOT_DB.prepare(`
      SELECT attempts FROM broadcast_deliveries
      WHERE campaign_id = ? AND user_id = ?
    `).bind(campaignId, recipient).first();
    expect(after.attempts).toBe(1);
    expect(telegramApi.sendMessageTelegramDetailed).toHaveBeenCalledTimes(1);
  });

  it("rejects manager callbacks even when the callback data is forged", async () => {
    mockTelegram();
    const adminId = await createUser();
    await handleBroadcastCallback(env, callback(adminId, "broadcast:new"));
    expect(telegramApi.sendTrackedSectionNoticeTelegram).not.toHaveBeenCalled();
    expect(telegramApi.answerCallbackQuery).toHaveBeenCalled();
  });
});

