import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as telegramApi from "../src/telegram/api.js";
import {
  handleAdvertisingCallback,
  handleAdvertisingMessage,
  openAdvertisingConversation
} from "../src/services/advertising-inbox.js";

const users = new Set();
const conversations = new Set();

beforeEach(async () => {
  await env.CRASH_BOT_DB.prepare(`
    INSERT OR IGNORE INTO users (telegram_id, first_name)
    VALUES (?, 'Owner test')
  `).bind(Number(env.OWNER_TELEGRAM_ID)).run();
});

async function createUser(username = null) {
  const userId = 760000000 + Math.floor(Math.random() * 10000000);
  users.add(userId);
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES (?, ?, ?)
  `).bind(userId, username, "Advertising test").run();
  return userId;
}

function message(userId, messageId, text, extra = {}) {
  return {
    from: { id: userId, first_name: "Advertising test" },
    chat: { id: userId, type: "private" },
    message_id: messageId,
    text,
    ...extra
  };
}

function callback(userId, data) {
  return {
    id: `ad-${Math.random()}`,
    data,
    from: { id: userId },
    message: {
      chat: { id: userId, type: "private" },
      message_id: 50
    }
  };
}

async function conversationFor(requesterId) {
  const row = await env.CRASH_BOT_DB.prepare(
    "SELECT id FROM advertising_conversations WHERE requester_id = ?"
  ).bind(requesterId).first();
  if (row) conversations.add(row.id);
  return row?.id;
}

function mockTelegram(outcome = "sent") {
  vi.spyOn(telegramApi, "sendTrackedSectionInlineTelegram").mockResolvedValue(true);
  vi.spyOn(telegramApi, "sendTrackedSectionNoticeTelegram").mockResolvedValue(true);
  vi.spyOn(telegramApi, "sendMessageTelegramDetailed")
    .mockResolvedValue({ outcome });
  vi.spyOn(telegramApi, "sendMediaTelegramDetailed")
    .mockResolvedValue({ outcome });
  vi.spyOn(telegramApi, "answerCallbackQuery").mockResolvedValue(true);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await env.CRASH_BOT_DB.prepare(
    "DROP TRIGGER IF EXISTS test_fail_advertising_insert"
  ).run();
  for (const conversationId of conversations) {
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM advertising_conversation_state WHERE conversation_id = ?"
    ).bind(conversationId).run();
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM advertising_messages WHERE conversation_id = ?"
    ).bind(conversationId).run();
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM advertising_conversations WHERE id = ?"
    ).bind(conversationId).run();
  }
  conversations.clear();
  for (const userId of users) {
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM advertising_conversation_state WHERE actor_id = ?"
    ).bind(userId).run();
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM users WHERE telegram_id = ?"
    ).bind(userId).run();
  }
  users.clear();
});

describe("private advertising inbox", () => {
  it("keeps requesters in separate conversations and sends each message only to the owner", async () => {
    mockTelegram();
    const userA = await createUser("requester_a");
    const userB = await createUser("requester_b");
    const ownerId = Number(env.OWNER_TELEGRAM_ID);

    await openAdvertisingConversation(env, userA, userA);
    await handleAdvertisingMessage(env, message(userA, 11, "درخواست A"), userA);
    const conversationA = await conversationFor(userA);
    await openAdvertisingConversation(env, userB, userB);
    await handleAdvertisingMessage(env, message(userB, 12, "درخواست B"), userB);
    const conversationB = await conversationFor(userB);

    expect(conversationA).not.toBe(conversationB);
    const records = await env.CRASH_BOT_DB.prepare(`
      SELECT conversation_id, sender_id, message, delivery_status
      FROM advertising_messages
      WHERE conversation_id IN (?, ?)
      ORDER BY id
    `).bind(conversationA, conversationB).all();
    expect(records.results).toEqual([
      expect.objectContaining({
        conversation_id: conversationA,
        sender_id: userA,
        message: "درخواست A",
        delivery_status: "sent"
      }),
      expect.objectContaining({
        conversation_id: conversationB,
        sender_id: userB,
        message: "درخواست B",
        delivery_status: "sent"
      })
    ]);
    const ownerDeliveries = telegramApi.sendMessageTelegramDetailed.mock.calls
      .filter((call) => String(call[1]) === String(ownerId))
      .map((call) => call[2]);
    expect(ownerDeliveries.some((text) => text.includes(`Telegram ID: ${userA}`))).toBe(true);
    expect(ownerDeliveries.some((text) => text.includes(`Telegram ID: ${userB}`))).toBe(true);
  });

  it("lets only the owner select conversations and routes replies to the selected requester", async () => {
    mockTelegram();
    const userA = await createUser();
    const userB = await createUser("other_user");
    const ownerId = Number(env.OWNER_TELEGRAM_ID);
    await openAdvertisingConversation(env, userA, userA);
    await handleAdvertisingMessage(env, message(userA, 21, "A"), userA);
    const conversationA = await conversationFor(userA);
    await openAdvertisingConversation(env, userB, userB);
    await handleAdvertisingMessage(env, message(userB, 22, "B"), userB);
    const conversationB = await conversationFor(userB);

    const listCall = vi.spyOn(telegramApi, "sendTrackedSectionInlineTelegram");
    await openAdvertisingConversation(env, ownerId, ownerId);
    expect(listCall.mock.calls.some((call) =>
      String(call[1]) === String(ownerId) &&
      call[2].includes(`ID: ${userA}`)
    )).toBe(true);
    await handleAdvertisingCallback(
      env,
      callback(ownerId, `ad:open:${conversationA}:0`)
    );
    await handleAdvertisingMessage(env, message(ownerId, 23, "پاسخ به A"), ownerId);

    const requesterDeliveries = telegramApi.sendMessageTelegramDetailed.mock.calls
      .filter((call) =>
        (call[1] === userA || call[1] === userB) &&
        call[2] === "پاسخ به A"
      );
    expect(requesterDeliveries.some((call) => call[1] === userA)).toBe(true);
    expect(requesterDeliveries.some((call) => call[1] === userB)).toBe(false);
    const stored = await env.CRASH_BOT_DB.prepare(`
      SELECT conversation_id, sender_id, sender_role, message
      FROM advertising_messages WHERE message = 'پاسخ به A'
    `).first();
    expect(stored).toEqual({
      conversation_id: conversationA,
      sender_id: ownerId,
      sender_role: "owner",
      message: "پاسخ به A"
    });
    expect(conversationA).not.toBe(conversationB);
  });

  it("does not reveal the owner's identity in requester-facing replies", async () => {
    mockTelegram();
    const requesterId = await createUser();
    const ownerId = Number(env.OWNER_TELEGRAM_ID);
    await openAdvertisingConversation(env, requesterId, requesterId);
    const conversationId = await conversationFor(requesterId);
    await handleAdvertisingCallback(
      env,
      callback(ownerId, `ad:open:${conversationId}:0`)
    );
    await handleAdvertisingMessage(env, message(ownerId, 31, "پاسخ خصوصی"), ownerId);
    const requesterMessages = telegramApi.sendMessageTelegramDetailed.mock.calls
      .filter((call) => call[1] === requesterId)
      .map((call) => call[2]);
    expect(requesterMessages).toContain("پاسخ خصوصی");
    expect(requesterMessages.join("\n")).not.toContain(String(ownerId));
  });

  it("rejects forged conversation callbacks from requesters and ordinary admins", async () => {
    mockTelegram();
    const userA = await createUser();
    const userB = await createUser();
    const conversationB = await openAdvertisingConversation(env, userB, userB)
      .then(() => conversationFor(userB));
    await openAdvertisingConversation(env, userA, userA);

    await handleAdvertisingCallback(
      env,
      callback(userA, `ad:open:${conversationB}:0`)
    );
    await handleAdvertisingCallback(env, callback(userA, "ad:list:0"));
    expect(telegramApi.sendTrackedSectionInlineTelegram.mock.calls.some((call) =>
      call[1] === userA && call[2].includes(`ID: ${userB}`)
    )).toBe(false);
    expect(telegramApi.answerCallbackQuery).toHaveBeenCalled();
  });

  it("deduplicates repeated Telegram updates and persists uncertain delivery without retry", async () => {
    mockTelegram("unknown");
    const requesterId = await createUser();
    await openAdvertisingConversation(env, requesterId, requesterId);
    const update = message(requesterId, 41, "یک پیام");
    await handleAdvertisingMessage(env, update, requesterId);
    await handleAdvertisingMessage(env, update, requesterId);
    const conversationId = await conversationFor(requesterId);
    const messages = await env.CRASH_BOT_DB.prepare(`
      SELECT delivery_status FROM advertising_messages
      WHERE conversation_id = ?
    `).bind(conversationId).all();
    expect(messages.results).toHaveLength(1);
    expect(messages.results[0].delivery_status).toBe("unknown");
    expect(telegramApi.sendMessageTelegramDetailed).toHaveBeenCalledTimes(3);
  });

  it("records Telegram rejection as a failed delivery", async () => {
    mockTelegram("rejected");
    const requesterId = await createUser();
    await openAdvertisingConversation(env, requesterId, requesterId);
    await handleAdvertisingMessage(env, message(requesterId, 51, "ارسال ناموفق"), requesterId);
    const conversationId = await conversationFor(requesterId);
    const record = await env.CRASH_BOT_DB.prepare(`
      SELECT delivery_status, delivery_error FROM advertising_messages
      WHERE conversation_id = ?
    `).bind(conversationId).first();
    expect(record.delivery_status).toBe("failed");
    expect(record.delivery_error).toBe("Telegram rejected the message");
  });

  it("forwards supported media to the owner and marks a partial sticker delivery uncertain", async () => {
    mockTelegram("sent");
    const requesterId = await createUser();
    const ownerId = Number(env.OWNER_TELEGRAM_ID);
    await openAdvertisingConversation(env, requesterId, requesterId);
    await handleAdvertisingMessage(env, message(
      requesterId,
      61,
      "",
      { text: undefined, caption: "توضیح رسانه", photo: [{ file_id: "private-photo-id" }] }
    ), requesterId);
    const mediaCall = telegramApi.sendMediaTelegramDetailed.mock.calls[0];
    expect(mediaCall[1]).toBe("sendPhoto");
    expect(String(mediaCall[2].chat_id)).toBe(String(ownerId));
    expect(mediaCall[2].photo).toBe("private-photo-id");
    expect(mediaCall[2].caption).toContain(`Telegram ID: ${requesterId}`);
    expect(mediaCall[2].caption).toContain("توضیح رسانه");

    await openAdvertisingConversation(env, requesterId, requesterId);
    telegramApi.sendMediaTelegramDetailed
      .mockResolvedValue({ outcome: "rejected" });
    await handleAdvertisingMessage(env, message(
      requesterId,
      62,
      "",
      { text: undefined, sticker: { file_id: "private-sticker-id" } }
    ), requesterId);
    const conversationId = await conversationFor(requesterId);
    const record = await env.CRASH_BOT_DB.prepare(`
      SELECT delivery_status FROM advertising_messages
      WHERE conversation_id = ? AND source_message_id = 62
    `).bind(conversationId).first();
    expect(record.delivery_status).toBe("unknown");
  });

  it("does not contact Telegram when message persistence fails", async () => {
    mockTelegram();
    const requesterId = await createUser();
    await openAdvertisingConversation(env, requesterId, requesterId);
    await env.CRASH_BOT_DB.prepare(`
      CREATE TRIGGER test_fail_advertising_insert
      BEFORE INSERT ON advertising_messages
      BEGIN
        SELECT RAISE(ABORT, 'simulated local database failure');
      END
    `).run();
    await expect(handleAdvertisingMessage(
      env,
      message(requesterId, 71, "ثبت ناموفق"),
      requesterId
    )).rejects.toThrow();
    expect(telegramApi.sendMessageTelegramDetailed).not.toHaveBeenCalled();
  });
});
