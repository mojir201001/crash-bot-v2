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

async function insertTimelineEntry(conversationId, senderId, {
  message: text = "",
  mediaType = null,
  mediaFileId = null,
  caption = null
} = {}) {
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO advertising_messages
      (conversation_id, sender_id, sender_role, message, media_type,
       media_file_id, caption, delivery_status, visibility_status,
       view_delivery_status)
    VALUES (?, ?, 'requester', ?, ?, ?, ?, 'sent', 'visible', 'sent')
  `).bind(
    conversationId,
    senderId,
    text ?? "",
    mediaType,
    mediaFileId,
    caption
  ).run();
}

function mockTelegram(outcome = "sent") {
  vi.spyOn(telegramApi, "sendTrackedSectionInlineTelegram").mockResolvedValue(true);
  vi.spyOn(telegramApi, "sendTrackedSectionNoticeTelegram").mockResolvedValue(true);
  vi.spyOn(telegramApi, "sendInlineTelegramDetailed")
    .mockResolvedValue({ outcome });
  vi.spyOn(telegramApi, "sendMessageTelegramDetailed")
    .mockResolvedValue({ outcome });
  vi.spyOn(telegramApi, "sendMediaTelegramDetailed")
    .mockResolvedValue({ outcome });
  vi.spyOn(telegramApi, "deleteTelegramMessage").mockResolvedValue(true);
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
      "DELETE FROM bot_settings WHERE key = ?"
    ).bind(`advertising_timeline_messages:${userId}`).run();
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM users WHERE telegram_id = ?"
    ).bind(userId).run();
  }
  await env.CRASH_BOT_DB.prepare(
    "DELETE FROM bot_settings WHERE key = ?"
  ).bind(`advertising_timeline_messages:${String(env.OWNER_TELEGRAM_ID)}`).run();
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
    const ownerDeliveries = telegramApi.sendInlineTelegramDetailed.mock.calls
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

    const stored = await env.CRASH_BOT_DB.prepare(`
      SELECT id, conversation_id, sender_id, sender_role, message
      FROM advertising_messages WHERE message = 'پاسخ به A'
    `).first();
    expect(stored).toMatchObject({
      conversation_id: conversationA,
      sender_id: ownerId,
      sender_role: "owner",
      message: "پاسخ به A"
    });
    const requesterNotice = telegramApi.sendInlineTelegramDetailed.mock.calls
      .find((call) => call[1] === userA && String(call[2]).includes("پیام در گفت‌وگوی تبلیغات"));
    expect(requesterNotice?.[2]).not.toContain(String(ownerId));
    expect(telegramApi.sendInlineTelegramDetailed.mock.calls.some((call) =>
      call[1] === userB && String(call[2]).includes("پاسخ به A")
    )).toBe(false);
    await handleAdvertisingCallback(env, callback(userA, `ad:view:${stored.id}`));
    expect(telegramApi.sendInlineTelegramDetailed.mock.calls.some((call) =>
      call[1] === userA && String(call[2]).includes("پاسخ به A")
    )).toBe(true);
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
    const reply = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM advertising_messages
      WHERE conversation_id = ? AND message = 'پاسخ خصوصی'
    `).bind(conversationId).first();
    await handleAdvertisingCallback(
      env, callback(requesterId, `ad:view:${reply.id}`)
    );
    const requesterMessages = [
      ...telegramApi.sendMessageTelegramDetailed.mock.calls,
      ...telegramApi.sendInlineTelegramDetailed.mock.calls
    ].filter((call) => call[1] === requesterId).map((call) => call[2]);
    expect(requesterMessages.some((text) => text.includes("پاسخ خصوصی"))).toBe(true);
    expect(requesterMessages.join("\n")).not.toContain(String(ownerId));
  });

  it("holds blocked advertising messages until the blocker releases and views them", async () => {
    mockTelegram();
    const requesterId = await createUser();
    const outsiderId = await createUser();
    const ownerId = Number(env.OWNER_TELEGRAM_ID);
    await openAdvertisingConversation(env, requesterId, requesterId);
    await handleAdvertisingMessage(
      env, message(requesterId, 71, "پیام اولیه"), requesterId
    );
    const conversationId = await conversationFor(requesterId);
    const initial = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM advertising_messages
      WHERE conversation_id = ? AND source_message_id = 71
    `).bind(conversationId).first();
    await handleAdvertisingCallback(
      env, callback(ownerId, `ad:block:${initial.id}`)
    );
    await handleAdvertisingMessage(
      env, message(requesterId, 72, "محتوای محرمانهٔ مسدودشده"), requesterId
    );
    const blocked = await env.CRASH_BOT_DB.prepare(`
      SELECT id, visibility_status, view_delivery_status
      FROM advertising_messages
      WHERE conversation_id = ? AND source_message_id = 72
    `).bind(conversationId).first();
    expect(blocked).toMatchObject({
      visibility_status: "blocked",
      view_delivery_status: "pending"
    });
    const heldNotice = telegramApi.sendInlineTelegramDetailed.mock.calls
      .find((call) => String(call[1]) === String(ownerId) &&
        String(call[2]).includes("کاربر بلاک‌شده"));
    expect(heldNotice?.[3][0][0]).toEqual({
      text: "🔓 خروج از بلاک و مشاهده",
      callback_data: `ad:unblock_view:${blocked.id}`
    });
    const ownerNotice = telegramApi.sendInlineTelegramDetailed.mock.calls
      .filter((call) => String(call[1]) === String(ownerId))
      .map((call) => call[2]).join("\n");
    expect(ownerNotice).toContain("کاربر بلاک‌شده");
    expect(ownerNotice).not.toContain("محتوای محرمانهٔ مسدودشده");

    await handleAdvertisingCallback(
      env, callback(outsiderId, `ad:unblock_view:${blocked.id}`)
    );
    await handleAdvertisingCallback(
      env, callback(ownerId, `ad:unblock_view:${blocked.id}`)
    );
    const released = await env.CRASH_BOT_DB.prepare(`
      SELECT m.visibility_status, m.view_delivery_status, m.read_at,
        c.blocked_by
      FROM advertising_messages m
      JOIN advertising_conversations c ON c.id = m.conversation_id
      WHERE m.id = ?
    `).bind(blocked.id).first();
    expect(released).toMatchObject({
      visibility_status: "visible",
      view_delivery_status: "sent",
      blocked_by: null
    });
    expect(released.read_at).toBeTruthy();
    expect(telegramApi.sendInlineTelegramDetailed.mock.calls.some((call) =>
      call[1] === ownerId && String(call[2]).includes("محتوای محرمانهٔ مسدودشده")
    )).toBe(true);
    expect(telegramApi.sendMessageTelegramDetailed.mock.calls.some((call) =>
      call[1] === requesterId &&
      String(call[2]).includes("طرف مقابل پیام شما را مشاهده کرد") &&
      call[4] === 72
    )).toBe(true);
  });

  it("routes an explicit reply to its selected advertising message", async () => {
    mockTelegram();
    const requesterId = await createUser();
    const ownerId = Number(env.OWNER_TELEGRAM_ID);
    await openAdvertisingConversation(env, requesterId, requesterId);
    await handleAdvertisingMessage(
      env, message(requesterId, 81, "درخواست اولیه"), requesterId
    );
    const conversationId = await conversationFor(requesterId);
    const original = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM advertising_messages
      WHERE conversation_id = ? AND source_message_id = 81
    `).bind(conversationId).first();
    await handleAdvertisingCallback(env, callback(ownerId, `ad:reply:${original.id}`));
    await handleAdvertisingMessage(
      env, message(ownerId, 82, "پاسخ مشخص"), ownerId
    );
    const reply = await env.CRASH_BOT_DB.prepare(`
      SELECT id, conversation_id, reply_to_message_id
      FROM advertising_messages WHERE source_message_id = 82 AND sender_id = ?
    `).bind(ownerId).first();
    expect(reply).toMatchObject({
      conversation_id: conversationId,
      reply_to_message_id: original.id
    });
    const notice = telegramApi.sendInlineTelegramDetailed.mock.calls
      .find((call) => call[1] === requesterId &&
        String(call[2]).includes("پیام در گفت‌وگوی تبلیغات"));
    expect(notice?.[2]).not.toContain(String(ownerId));
  });

  it("shows reply and block controls on the sender's own advertising message", async () => {
    mockTelegram();
    const requesterId = await createUser();
    await openAdvertisingConversation(env, requesterId, requesterId);
    await handleAdvertisingMessage(
      env, message(requesterId, 85, "پیام خودم"), requesterId
    );
    const conversationId = await conversationFor(requesterId);
    const original = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM advertising_messages
      WHERE conversation_id = ? AND source_message_id = 85
    `).bind(conversationId).first();

    await openAdvertisingConversation(env, requesterId, requesterId);
    const ownMessage = telegramApi.sendInlineTelegramDetailed.mock.calls
      .find((call) => call[1] === requesterId &&
        String(call[2]).includes("پیام خودم"));
    expect(ownMessage?.[3].flat().map((button) => button.callback_data))
      .toEqual([`ad:reply:${original.id}`, `ad:block:${original.id}`]);

    await handleAdvertisingCallback(
      env, callback(requesterId, `ad:reply:${original.id}`)
    );
    const state = await env.CRASH_BOT_DB.prepare(`
      SELECT reply_to_message_id FROM advertising_conversation_state
      WHERE actor_id = ? AND conversation_id = ?
    `).bind(requesterId, conversationId).first();
    expect(state.reply_to_message_id).toBe(original.id);
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
    expect(telegramApi.sendInlineTelegramDetailed).toHaveBeenCalledTimes(1);
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

  it("holds supported media behind a private view action and records uncertain display", async () => {
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
    expect(telegramApi.sendMediaTelegramDetailed).not.toHaveBeenCalled();
    const conversationId = await conversationFor(requesterId);
    const photo = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM advertising_messages
      WHERE conversation_id = ? AND source_message_id = 61
    `).bind(conversationId).first();
    await handleAdvertisingCallback(env, callback(ownerId, `ad:view:${photo.id}`));
    const mediaCall = telegramApi.sendMediaTelegramDetailed.mock.calls[0];
    expect(mediaCall[1]).toBe("sendPhoto");
    expect(String(mediaCall[2].chat_id)).toBe(String(ownerId));
    expect(mediaCall[2].photo).toBe("private-photo-id");
    expect(mediaCall[2].caption).toContain(`Telegram ID: ${requesterId}`);
    expect(mediaCall[2].caption).toContain("توضیح رسانه");

    await openAdvertisingConversation(env, requesterId, requesterId);
    await handleAdvertisingMessage(env, message(
      requesterId,
      62,
      "",
      { text: undefined, sticker: { file_id: "private-sticker-id" } }
    ), requesterId);
    const record = await env.CRASH_BOT_DB.prepare(`
      SELECT id, delivery_status, view_delivery_status FROM advertising_messages
      WHERE conversation_id = ? AND source_message_id = 62
    `).bind(conversationId).first();
    expect(record.delivery_status).toBe("sent");
    telegramApi.sendMediaTelegramDetailed
      .mockResolvedValue({ outcome: "unknown" });
    await handleAdvertisingCallback(
      env, callback(ownerId, `ad:view:${record.id}`)
    );
    const uncertain = await env.CRASH_BOT_DB.prepare(`
      SELECT view_delivery_status FROM advertising_messages WHERE id = ?
    `).bind(record.id).first();
    expect(uncertain.view_delivery_status).toBe("unknown");
  });

  it("renders each message's text before its media in chronological order", async () => {
    mockTelegram();
    const requesterId = await createUser();
    const ownerId = Number(env.OWNER_TELEGRAM_ID);
    await openAdvertisingConversation(env, requesterId, requesterId);
    const conversationId = await conversationFor(requesterId);
    await insertTimelineEntry(conversationId, requesterId, { message: "متن اول" });
    await insertTimelineEntry(conversationId, requesterId, {
      mediaType: "photo",
      mediaFileId: "timeline-photo",
      caption: "توضیح عکس"
    });
    await insertTimelineEntry(conversationId, requesterId, { message: "متن سوم" });

    const events = [];
    let messageId = 100;
    telegramApi.sendTrackedSectionInlineTelegram.mockImplementation(async () => true);
    telegramApi.sendMessageTelegramDetailed.mockImplementation(async (_env, _chatId, text) => {
      events.push({ type: "text", text });
      return { outcome: "sent", messageId: messageId++ };
    });
    telegramApi.sendInlineTelegramDetailed.mockImplementation(async (_env, _chatId, text) => {
      events.push({ type: "text", text });
      return { outcome: "sent", messageId: messageId++ };
    });
    telegramApi.sendMediaTelegramDetailed.mockImplementation(async (_env, method, payload) => {
      events.push({ type: "media", method, payload });
      return { outcome: "sent", messageId: messageId++ };
    });

    await handleAdvertisingCallback(
      env,
      callback(ownerId, `ad:open:${conversationId}:0`)
    );

    expect(events.filter((event) =>
      event.type !== "text" || !event.text.includes("برای خروج")
    ).map((event) => event.type === "media"
      ? `media:${event.payload.photo}`
      : `text:${event.text.includes("متن اول") ? "first" : event.text.includes("توضیح عکس") ? "caption" : "third"}`
    )).toEqual([
      "text:first",
      "text:caption",
      "media:timeline-photo",
      "text:third"
    ]);
  });

  it("paginates the chronological timeline and clears prior page output without deleting history", async () => {
    mockTelegram();
    const requesterId = await createUser();
    const ownerId = Number(env.OWNER_TELEGRAM_ID);
    await openAdvertisingConversation(env, requesterId, requesterId);
    const conversationId = await conversationFor(requesterId);
    for (let number = 1; number <= 10; number += 1) {
      if (number % 2 === 0) {
        await insertTimelineEntry(conversationId, requesterId, {
          mediaType: "photo",
          mediaFileId: `page-photo-${number}`,
          caption: `entry-${String(number).padStart(2, "0")}`
        });
      } else {
        await insertTimelineEntry(conversationId, requesterId, {
          message: `entry-${String(number).padStart(2, "0")}`
        });
      }
    }

    const events = [];
    let messageId = 200;
    telegramApi.sendTrackedSectionInlineTelegram.mockImplementation(async (_env, _chatId, text, keyboard) => {
      events.push({ type: "screen", text, keyboard });
      return true;
    });
    telegramApi.sendMessageTelegramDetailed.mockImplementation(async (_env, _chatId, text) => {
      events.push({ type: "text", text });
      return { outcome: "sent", messageId: messageId++ };
    });
    telegramApi.sendInlineTelegramDetailed.mockImplementation(async (_env, _chatId, text) => {
      events.push({ type: "text", text });
      return { outcome: "sent", messageId: messageId++ };
    });
    telegramApi.sendMediaTelegramDetailed.mockImplementation(async (_env, method, payload) => {
      events.push({ type: "media", method, payload });
      return { outcome: "sent", messageId: messageId++ };
    });

    await handleAdvertisingCallback(
      env,
      callback(ownerId, `ad:open:${conversationId}:0`)
    );
    const firstPageEvents = [...events];
    const firstPageIds = Array.from({ length: 12 }, (_, index) => 200 + index);
    const firstPageScreen = firstPageEvents.find((event) => event.type === "screen");
    expect(firstPageScreen.keyboard.flat().map((button) => button.callback_data))
      .toContain(`ad:open:${conversationId}:1`);
    expect(firstPageEvents.filter((event) => event.type === "text")
      .filter((event) => !event.text.includes("برای خروج"))
      .map((event) => event.text)).toHaveLength(8);
    expect(firstPageEvents.filter((event) => event.type === "media")
      .map((event) => event.payload.photo)).toEqual([
      "page-photo-4", "page-photo-6", "page-photo-8", "page-photo-10"
    ]);
    expect(firstPageEvents.filter((event) => event.type === "text")
      .some((event) => event.text.includes("entry-01") || event.text.includes("entry-02")))
      .toBe(false);

    events.length = 0;
    await handleAdvertisingCallback(
      env,
      callback(ownerId, `ad:open:${conversationId}:1`)
    );
    const secondPageScreen = events.find((event) => event.type === "screen");
    expect(secondPageScreen.keyboard.flat().map((button) => button.callback_data))
      .toContain(`ad:open:${conversationId}:0`);
    expect(events.filter((event) => event.type === "text")
      .map((event) => event.text)).toHaveLength(2);
    expect(events.filter((event) => event.type === "media")
      .map((event) => event.payload.photo)).toEqual(["page-photo-2"]);
    expect(events.filter((event) => event.type === "text")
      .some((event) => event.text.includes("entry-03"))).toBe(false);
    expect(telegramApi.deleteTelegramMessage.mock.calls.map((call) => call[2]))
      .toEqual(firstPageIds);

    const savedHistory = await env.CRASH_BOT_DB.prepare(`
      SELECT COUNT(*) AS count
      FROM advertising_messages
      WHERE conversation_id = ?
    `).bind(conversationId).first();
    expect(savedHistory.count).toBe(10);
  });

  it("does not offer an empty next page when an archive page has exactly eight items", async () => {
    mockTelegram();
    const requesters = [];
    const conversationIdsForPage = [];
    for (let index = 0; index < 8; index += 1) {
      const requesterId = await createUser(`page_user_${index}`);
      requesters.push(requesterId);
      await openAdvertisingConversation(env, requesterId, requesterId);
      conversationIdsForPage.push(await conversationFor(requesterId));
    }

    const ownerId = Number(env.OWNER_TELEGRAM_ID);
    await handleAdvertisingCallback(env, callback(ownerId, "ad:list:0"));
    let screen = telegramApi.sendTrackedSectionInlineTelegram.mock.calls.at(-1);
    expect(screen[3].flat().map((button) => button.callback_data))
      .not.toContain("ad:list:1");

    const conversationId = conversationIdsForPage[0];
    for (let index = 0; index < 8; index += 1) {
      await insertTimelineEntry(conversationId, requesters[0], {
        message: `exact-page-item-${index}`
      });
    }
    await handleAdvertisingCallback(
      env, callback(ownerId, `ad:open:${conversationId}:0`)
    );
    screen = telegramApi.sendTrackedSectionInlineTelegram.mock.calls.at(-1);
    expect(screen[3].flat().map((button) => button.callback_data))
      .not.toContain(`ad:open:${conversationId}:1`);
  });

  it("does not contact Telegram when message persistence fails", async () => {
    mockTelegram();
    const requesterId = await createUser();
    await openAdvertisingConversation(env, requesterId, requesterId);
    telegramApi.sendMessageTelegramDetailed.mockClear();
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
