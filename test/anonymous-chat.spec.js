import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as telegramApi from "../src/telegram/api.js";
import {
  appendAndNotify,
  handleAnonymousChatCallback,
  handleAnonymousConversationMessage,
  handlePersonalLinkStart,
  deliverAnonymousMessageNotification,
  registerAnonymousMessageNotification,
  renderOwnerAnonymousArchive,
  renderOwnerConnectionArchive,
  renderPersonalLink,
  renderUserMessageInbox
} from "../src/services/anonymous-chat.js";
import { handleConnectionMessage } from "../src/services/connections.js";

const userIds = new Set();
const conversationIds = new Set();
const connectionIds = new Set();
const linkIds = new Set();
const notificationIds = new Set();
const settingKeys = new Set();
let telegramCalls = [];

async function createUser(username = null) {
  const userId = 740000000 + Math.floor(Math.random() * 10000000);
  userIds.add(userId);
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES (?, ?, 'Anonymous test')
  `).bind(userId, username).run();
  return userId;
}

function installTelegramMock() {
  let messageId = 100;
  telegramCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    telegramCalls.push({ method: String(url).split("/").at(-1), body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: ++messageId } })
    };
  }));
}

function callback(userId, data, messageId = 90) {
  return {
    id: `anon-${Math.random()}`,
    data,
    from: { id: userId },
    message: {
      chat: { id: userId, type: "private" },
      message_id: messageId
    }
  };
}

async function handleConnectionMessageForTest(userId) {
  await handleConnectionMessage(env, {
    message_id: 552,
    from: { id: userId },
    chat: { id: userId, type: "private" },
    text: "پاسخ به همان درخواست"
  }, userId);
}

async function openPersonalConversation(ownerId, visitorId) {
  const key = `telegram_bot_username`;
  settingKeys.add(key);
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO bot_settings (key, value) VALUES (?, 'test_crash_bot')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).bind(key).run();
  await renderPersonalLink(env, ownerId, ownerId);
  const linkMessage = telegramCalls.find((item) =>
    item.method === "sendMessage" && String(item.body.text).includes("?start=anon_")
  );
  const token = /start=(anon_[a-f0-9]{32})/.exec(linkMessage.body.text)?.[1];
  expect(token).toBeTruthy();
  const link = await env.CRASH_BOT_DB.prepare(
    "SELECT user_id FROM anonymous_personal_links WHERE token = ?"
  ).bind(token).first();
  linkIds.add(link.user_id);
  await handlePersonalLinkStart(env, visitorId, visitorId, token);
  const conversation = await env.CRASH_BOT_DB.prepare(`
    SELECT id FROM anonymous_conversations
    WHERE source_type = 'personal_link'
      AND ((user_a_id = ? AND user_b_id = ?) OR (user_a_id = ? AND user_b_id = ?))
  `).bind(
    Math.min(ownerId, visitorId), Math.max(ownerId, visitorId),
    Math.min(ownerId, visitorId), Math.max(ownerId, visitorId)
  ).first();
  conversationIds.add(conversation.id);
  return conversation.id;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await env.CRASH_BOT_DB.prepare(
    "DELETE FROM owner_archive_text_exports WHERE owner_id = ?"
  ).bind(Number(env.OWNER_TELEGRAM_ID)).run();
  await env.CRASH_BOT_DB.prepare(
    "DELETE FROM owner_archive_display_messages WHERE owner_id = ?"
  ).bind(Number(env.OWNER_TELEGRAM_ID)).run();
  for (const userId of userIds) {
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM anonymous_blocked_messages
      WHERE sender_id = ? OR recipient_id = ?
    `).bind(userId, userId).run();
  }
  for (const notificationId of notificationIds) {
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM anonymous_message_inbox WHERE id = ?"
    ).bind(notificationId).run();
  }
  notificationIds.clear();
  for (const conversationId of conversationIds) {
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM anonymous_messages WHERE conversation_id = ?"
    ).bind(conversationId).run();
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM anonymous_conversations WHERE id = ?"
    ).bind(conversationId).run();
  }
  conversationIds.clear();
  for (const connectionId of connectionIds) {
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM anonymous_messages WHERE connection_id = ?"
    ).bind(connectionId).run();
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM connection_requests WHERE id = ?"
    ).bind(connectionId).run();
  }
  connectionIds.clear();
  for (const userId of userIds) {
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM bot_settings WHERE key IN (?, ?, ?)"
    ).bind(
      `ui_inline_section_message:${userId}`,
      `ui_section_message:${userId}`,
      `ui_main_screen_message:${userId}`
    ).run();
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM anonymous_chat_states WHERE user_id = ?"
    ).bind(userId).run();
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM anonymous_personal_links WHERE user_id = ?"
    ).bind(userId).run();
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM anonymous_messages WHERE sender_id = ? OR recipient_id = ?"
    ).bind(userId, userId).run();
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM users WHERE telegram_id = ?"
    ).bind(userId).run();
  }
  userIds.clear();
  for (const key of settingKeys) {
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM bot_settings WHERE key = ?"
    ).bind(key).run();
  }
  settingKeys.clear();
});

describe("private anonymous conversations and inbox", () => {
  it("creates a stable private link and opens a direct chat without approval", async () => {
    installTelegramMock();
    const ownerId = await createUser();
    const visitorId = await createUser();
    const firstConversation = await openPersonalConversation(ownerId, visitorId);
    const secondConversation = await openPersonalConversation(ownerId, visitorId);
    expect(secondConversation).toBe(firstConversation);
    const row = await env.CRASH_BOT_DB.prepare(`
      SELECT state FROM anonymous_chat_states WHERE user_id = ?
    `).bind(visitorId).first();
    expect(row.state).toBe("active");
  });

  it("opens a second personal-link conversation without replacing either existing selection", async () => {
    installTelegramMock();
    const ownerId = await createUser();
    const currentVisitor = await createUser();
    const nextVisitor = await createUser();
    const activeId = await openPersonalConversation(ownerId, currentVisitor);
    const token = (await env.CRASH_BOT_DB.prepare(`
      SELECT token FROM anonymous_personal_links WHERE user_id = ?
    `).bind(ownerId).first()).token;

    await handlePersonalLinkStart(env, nextVisitor, nextVisitor, token);

    const activeVisitorSelection = await env.CRASH_BOT_DB.prepare(`
      SELECT conversation_id FROM active_conversation_selections WHERE actor_id = ?
    `).bind(currentVisitor).first();
    const ownerState = await env.CRASH_BOT_DB.prepare(`
      SELECT conversation_id FROM anonymous_chat_states WHERE user_id = ?
    `).bind(ownerId).first();
    const nextVisitorState = await env.CRASH_BOT_DB.prepare(`
      SELECT conversation_id FROM anonymous_chat_states WHERE user_id = ?
    `).bind(nextVisitor).first();
    const conversation = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM anonymous_conversations
      WHERE user_a_id = ? AND user_b_id = ? AND source_type = 'personal_link'
    `).bind(
      Math.min(ownerId, nextVisitor),
      Math.max(ownerId, nextVisitor)
    ).first();
    expect(ownerState).toBeNull();
    expect(activeVisitorSelection.conversation_id).toBe(activeId);
    expect(nextVisitorState.conversation_id).toBe(conversation.id);
    expect(conversation.id).not.toBe(activeId);
  });

  it("stores one notification per received message and opens only the selected alert", async () => {
    installTelegramMock();
    const mediaSpy = vi.spyOn(telegramApi, "sendMediaTelegramDetailed")
      .mockResolvedValue({ outcome: "sent", messageId: 900 });
    const ownerId = await createUser("owner_test");
    const visitorOne = await createUser("visitor_one");
    await openPersonalConversation(ownerId, visitorOne);
    const senderConversationState = await env.CRASH_BOT_DB.prepare(`
      SELECT conversation_id FROM anonymous_chat_states WHERE user_id = ?
    `).bind(visitorOne).first();
    await handleAnonymousConversationMessage(env, {
      message_id: 501,
      from: { id: visitorOne },
      chat: { id: visitorOne, type: "private" },
      photo: [{ file_id: "small-photo" }, { file_id: "full-photo" }],
      caption: "سلام اول"
    }, visitorOne);
    await handleAnonymousConversationMessage(env, {
      message_id: 502,
      from: { id: visitorOne },
      chat: { id: visitorOne, type: "private" },
      text: "سلام دوم"
    }, visitorOne);
    await handleAnonymousConversationMessage(env, {
      message_id: 502,
      from: { id: visitorOne },
      chat: { id: visitorOne, type: "private" },
      text: "سلام دوم"
    }, visitorOne);

    const senderCopy = telegramCalls.find((item) =>
      item.method === "sendMessage" &&
      String(item.body.text).includes("پیام شما") &&
      String(item.body.text).includes("سلام دوم")
    );
    expect(senderCopy.body.reply_markup.inline_keyboard.flat().map((button) =>
      button.callback_data.split(":")[1]
    )).toEqual(["reply", "block", "history"]);
    const senderCopyState = await env.CRASH_BOT_DB.prepare(`
      SELECT sender_display_status, sender_display_message_id
      FROM anonymous_messages WHERE sender_id = ? AND source_message_id = 502
    `).bind(visitorOne).first();
    expect(senderCopyState.sender_display_status).toBe("sent");
    expect(senderCopyState.sender_display_message_id).toBeTruthy();
    expect(telegramCalls.filter((item) =>
      item.method === "sendMessage" &&
      String(item.body.text).includes("پیام شما") &&
      String(item.body.text).includes("سلام دوم")
    )).toHaveLength(1);

    const notifications = await env.CRASH_BOT_DB.prepare(`
      SELECT id, message_id, source_type, delivery_status, viewed_at
      FROM anonymous_message_inbox WHERE recipient_id = ? ORDER BY id
    `).bind(ownerId).all();
    expect(notifications.results).toHaveLength(2);
    notifications.results.forEach((item) => notificationIds.add(item.id));
    expect(notifications.results.map((item) => item.source_type))
      .toEqual(["personal_link", "personal_link"]);
    const savedMedia = await env.CRASH_BOT_DB.prepare(`
      SELECT media_type, media_file_id, caption FROM anonymous_messages
      WHERE id = ?
    `).bind(notifications.results[0].message_id).first();
    expect(savedMedia).toEqual({
      media_type: "photo",
      media_file_id: "full-photo",
      caption: "سلام اول"
    });
    await expect(registerAnonymousMessageNotification(
      env, notifications.results[0].message_id, ownerId, "personal_link"
    )).resolves.toBe("sent");
    expect(telegramCalls.filter((item) =>
      item.method === "sendMessage" && String(item.body.text).includes("سلام اول")
    )).toHaveLength(0);

    await renderUserMessageInbox(env, ownerId, ownerId);
    const inboxMarkup = telegramCalls.filter((item) =>
      item.body.reply_markup?.inline_keyboard?.some((row) =>
        row.some((button) => String(button.callback_data).startsWith("anon:inbox:open:"))
      )
    ).at(-1).body.reply_markup.inline_keyboard;
    expect(inboxMarkup.flat().filter((button) =>
      String(button.callback_data).startsWith("anon:inbox:open:")
    )).toHaveLength(2);

    await handleAnonymousChatCallback(
      env,
      callback(ownerId, `anon:inbox:open:${notifications.results[0].id}`, 811)
    );
    const after = await env.CRASH_BOT_DB.prepare(`
      SELECT id, viewed_at, sender_notice_status
      FROM anonymous_message_inbox WHERE recipient_id = ? ORDER BY id
    `).bind(ownerId).all();
    expect(after.results[0].viewed_at).toBeTruthy();
    expect(after.results[1].viewed_at).toBeNull();
    expect(after.results[0].sender_notice_status).toBe("sent");
    const senderStateAfterOpen = await env.CRASH_BOT_DB.prepare(`
      SELECT conversation_id FROM anonymous_chat_states WHERE user_id = ?
    `).bind(visitorOne).first();
    expect(senderStateAfterOpen).toEqual(senderConversationState);
    expect(mediaSpy).toHaveBeenCalledWith(env, "sendPhoto", expect.objectContaining({
      chat_id: ownerId,
      photo: "full-photo",
      caption: expect.stringContaining("سلام اول")
    }));
    expect(telegramCalls.filter((item) =>
      item.method === "deleteMessage" && item.body.message_id === 811
    )).toHaveLength(1);
    const refreshedInbox = telegramCalls.filter((item) =>
      item.method === "sendMessage" &&
      item.body.reply_markup?.inline_keyboard?.some((buttons) =>
        buttons.some((button) => String(button.callback_data).startsWith("anon:inbox:open:"))
      )
    ).at(-1);
    expect(refreshedInbox.body.reply_markup.inline_keyboard.flat()
      .filter((button) => String(button.callback_data).startsWith("anon:inbox:open:"))
      .map((button) => button.callback_data))
      .toEqual([`anon:inbox:open:${notifications.results[1].id}`]);
    expect(telegramCalls.some((item) =>
      item.method === "sendMessage" &&
      String(item.body.text).includes("از طریق ربات مشاهده شد")
    )).toBe(true);
    expect(telegramCalls.find((item) =>
      item.method === "sendMessage" &&
      String(item.body.text).includes("از طریق ربات مشاهده شد")
    )?.body.reply_parameters).toEqual({ message_id: 501 });
  });

  it("replaces a shared inbox page without deleting the other notification buttons", async () => {
    installTelegramMock();
    const senderId = await createUser("page_sender");
    const recipientId = await createUser("page_recipient");
    await openPersonalConversation(recipientId, senderId);
    for (const [sourceMessageId, text] of [[560, "پیام یک"], [561, "پیام دو"]]) {
      await handleAnonymousConversationMessage(env, {
        message_id: sourceMessageId,
        from: { id: senderId },
        chat: { id: senderId, type: "private" },
        text
      }, senderId);
    }
    const notifications = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM anonymous_message_inbox WHERE recipient_id = ? ORDER BY id
    `).bind(recipientId).all();
    notifications.results.forEach((row) => notificationIds.add(row.id));
    const listMessageId = 901;
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO bot_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).bind(`ui_inline_section_message:${recipientId}`, String(listMessageId)).run();

    await handleAnonymousChatCallback(env, callback(
      recipientId, `anon:inbox:open:${notifications.results[0].id}`, listMessageId
    ));

    expect(telegramCalls.some((item) =>
      item.method === "deleteMessage" && item.body.message_id === listMessageId
    )).toBe(true);
    const latestInbox = telegramCalls.filter((item) =>
      item.method === "sendMessage" &&
      item.body.reply_markup?.inline_keyboard?.some((buttons) =>
        buttons.some((button) => String(button.callback_data).startsWith("anon:inbox:open:"))
      )
    ).at(-1);
    expect(latestInbox.body.reply_markup.inline_keyboard.flat()
      .filter((button) => String(button.callback_data).startsWith("anon:inbox:open:"))
      .map((button) => button.callback_data))
      .toEqual([`anon:inbox:open:${notifications.results[1].id}`]);
    const viewed = await env.CRASH_BOT_DB.prepare(`
      SELECT viewed_at FROM anonymous_message_inbox WHERE id = ?
    `).bind(notifications.results[1].id).first();
    expect(viewed.viewed_at).toBeNull();
  });

  it("marks abandoned notification sends unknown and never automatically retries them", async () => {
    installTelegramMock();
    const senderId = await createUser("stale_sender");
    const recipientId = await createUser("stale_recipient");
    const conversationId = await openPersonalConversation(recipientId, senderId);
    await handleAnonymousConversationMessage(env, {
      message_id: 570,
      from: { id: senderId },
      chat: { id: senderId, type: "private" },
      text: "وضعیت ارسال"
    }, senderId);
    const notification = await env.CRASH_BOT_DB.prepare(`
      SELECT n.id, n.message_id FROM anonymous_message_inbox n
      JOIN anonymous_messages m ON m.id = n.message_id
      WHERE m.source_message_id = 570
    `).first();
    notificationIds.add(notification.id);
    await env.CRASH_BOT_DB.prepare(`
      UPDATE anonymous_message_inbox
      SET delivery_status = 'sending', updated_at = datetime('now', '-20 minutes')
      WHERE id = ?
    `).bind(notification.id).run();
    await env.CRASH_BOT_DB.prepare(`
      UPDATE anonymous_messages SET delivery_status = 'sending'
      WHERE id = ?
    `).bind(notification.message_id).run();
    const alertCountBefore = telegramCalls.filter((item) =>
      item.method === "sendMessage" &&
      item.body.reply_markup?.inline_keyboard?.flat().some((button) =>
        String(button.callback_data).startsWith("anon:inbox:open:")
      )
    ).length;

    await expect(deliverAnonymousMessageNotification(
      env, notification.message_id
    )).resolves.toBe("unknown");

    const stored = await env.CRASH_BOT_DB.prepare(`
      SELECT n.delivery_status, m.delivery_status AS message_status
      FROM anonymous_message_inbox n
      JOIN anonymous_messages m ON m.id = n.message_id
      WHERE n.id = ?
    `).bind(notification.id).first();
    expect(stored).toEqual({ delivery_status: "unknown", message_status: "unknown" });
    const alertCountAfter = telegramCalls.filter((item) =>
      item.method === "sendMessage" &&
      item.body.reply_markup?.inline_keyboard?.flat().some((button) =>
        String(button.callback_data).startsWith("anon:inbox:open:")
      )
    ).length;
    expect(alertCountAfter).toBe(alertCountBefore);
    expect(conversationId).toBeTruthy();
  });

  it("does not mark an alert viewed or notify its sender when message display is rejected", async () => {
    installTelegramMock();
    const senderId = await createUser("failed_display_sender");
    const recipientId = await createUser("failed_display_recipient");
    await openPersonalConversation(recipientId, senderId);
    await handleAnonymousConversationMessage(env, {
      message_id: 550,
      from: { id: senderId },
      chat: { id: senderId, type: "private" },
      text: "پیام آزمایشی"
    }, senderId);
    const notification = await env.CRASH_BOT_DB.prepare(`
      SELECT n.id FROM anonymous_message_inbox n
      JOIN anonymous_messages m ON m.id = n.message_id
      WHERE m.source_message_id = 550
    `).first();
    notificationIds.add(notification.id);
    const sendMessage = vi.spyOn(telegramApi, "sendInlineTelegramDetailed")
      .mockResolvedValue({ outcome: "rejected" });
    const callbackQuery = callback(
      recipientId, `anon:inbox:open:${notification.id}`, 812
    );

    await handleAnonymousChatCallback(env, callbackQuery);

    let row = await env.CRASH_BOT_DB.prepare(`
      SELECT viewed_at, sender_notice_status
      FROM anonymous_message_inbox WHERE id = ?
    `).bind(notification.id).first();
    expect(row).toEqual({ viewed_at: null, sender_notice_status: "pending" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][2]).toContain("پیام آزمایشی");
    expect(sendMessage.mock.calls.some((call) =>
      call[2].includes("از طریق ربات مشاهده شد")
    )).toBe(false);
    expect(telegramCalls.some((item) =>
      item.method === "deleteMessage" && item.body.message_id === 812
    )).toBe(false);

    sendMessage.mockResolvedValue({ outcome: "sent", messageId: 920 });
    await handleAnonymousChatCallback(env, callbackQuery);
    row = await env.CRASH_BOT_DB.prepare(`
      SELECT viewed_at, sender_notice_status
      FROM anonymous_message_inbox WHERE id = ?
    `).bind(notification.id).first();
    expect(row.viewed_at).toBeTruthy();
    expect(row.sender_notice_status).toBe("sent");
  });

  it("keeps reply contexts isolated by conversation and consumes only the matching context", async () => {
    installTelegramMock();
    const ownerId = await createUser();
    const firstSender = await createUser();
    const secondSender = await createUser();
    const firstConversationId = await openPersonalConversation(ownerId, firstSender);
    const secondConversationId = await openPersonalConversation(ownerId, secondSender);

    await handleAnonymousConversationMessage(env, {
      message_id: 581,
      from: { id: firstSender },
      chat: { id: firstSender, type: "private" },
      text: "پیام گفت‌وگوی اول"
    }, firstSender);
    await handleAnonymousConversationMessage(env, {
      message_id: 582,
      from: { id: secondSender },
      chat: { id: secondSender, type: "private" },
      text: "پیام گفت‌وگوی دوم"
    }, secondSender);
    const firstMessage = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM anonymous_messages
      WHERE sender_id = ? AND source_message_id = 581
    `).bind(firstSender).first();
    const secondMessage = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM anonymous_messages
      WHERE sender_id = ? AND source_message_id = 582
    `).bind(secondSender).first();

    await handleAnonymousChatCallback(env, callback(
      ownerId, `anon:reply:${firstMessage.id}`
    ));
    await handleAnonymousChatCallback(env, callback(
      ownerId, `anon:reply:${secondMessage.id}`
    ));
    const contexts = await env.CRASH_BOT_DB.prepare(`
      SELECT conversation_id, peer_id, message_id
      FROM conversation_reply_contexts
      WHERE actor_id = ? ORDER BY conversation_id
    `).bind(ownerId).all();
    expect(contexts.results).toEqual([
      {
        conversation_id: firstConversationId,
        peer_id: firstSender,
        message_id: firstMessage.id
      },
      {
        conversation_id: secondConversationId,
        peer_id: secondSender,
        message_id: secondMessage.id
      }
    ]);

    await handleAnonymousConversationMessage(env, {
      message_id: 583,
      from: { id: ownerId },
      chat: { id: ownerId, type: "private" },
      text: "پاسخ به گفت‌وگوی دوم"
    }, ownerId);
    const reply = await env.CRASH_BOT_DB.prepare(`
      SELECT reply_to_message_id, conversation_id
      FROM anonymous_messages
      WHERE sender_id = ? AND source_message_id = 583
    `).bind(ownerId).first();
    expect(reply).toEqual({
      reply_to_message_id: secondMessage.id,
      conversation_id: secondConversationId
    });
    const remainingContext = await env.CRASH_BOT_DB.prepare(`
      SELECT conversation_id, message_id
      FROM conversation_reply_contexts WHERE actor_id = ?
    `).bind(ownerId).all();
    expect(remainingContext.results).toEqual([{
      conversation_id: firstConversationId,
      message_id: firstMessage.id
    }]);
  });

  it("blocks only the selected conversation and rejects messages in that thread", async () => {
    installTelegramMock();
    const ownerId = await createUser();
    const blockedPeerId = await createUser();
    const availablePeerId = await createUser();
    const blockedConversationId = await openPersonalConversation(ownerId, blockedPeerId);
    const availableConversationId = await openPersonalConversation(ownerId, availablePeerId);

    await handleAnonymousConversationMessage(env, {
      message_id: 591,
      from: { id: blockedPeerId },
      chat: { id: blockedPeerId, type: "private" },
      text: "گفت‌وگوی مسدودشونده"
    }, blockedPeerId);
    await handleAnonymousConversationMessage(env, {
      message_id: 592,
      from: { id: availablePeerId },
      chat: { id: availablePeerId, type: "private" },
      text: "گفت‌وگوی مستقل"
    }, availablePeerId);
    const blockedMessage = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM anonymous_messages
      WHERE sender_id = ? AND source_message_id = 591
    `).bind(blockedPeerId).first();
    await handleAnonymousChatCallback(env, callback(
      ownerId, `anon:block:${blockedMessage.id}`
    ));

    const block = await env.CRASH_BOT_DB.prepare(`
      SELECT conversation_type, conversation_id, blocker_id, blocked_id
      FROM conversation_blocks WHERE blocker_id = ?
    `).bind(ownerId).first();
    expect(block).toEqual({
      conversation_type: "personal_link",
      conversation_id: blockedConversationId,
      blocker_id: ownerId,
      blocked_id: blockedPeerId
    });
    const blockedResult = await appendAndNotify(env, {
      senderId: blockedPeerId,
      recipientId: ownerId,
      sourceType: "personal_link",
      conversationId: blockedConversationId,
      message: { text: "پیام پس از مسدودسازی" },
      sourceMessageId: 593
    });
    expect(blockedResult).toEqual({ status: "blocked" });

    await handleAnonymousConversationMessage(env, {
      message_id: 594,
      from: { id: availablePeerId },
      chat: { id: availablePeerId, type: "private" },
      text: "پیام مستقل بعدی"
    }, availablePeerId);
    const availableMessages = await env.CRASH_BOT_DB.prepare(`
      SELECT COUNT(*) AS count FROM anonymous_messages
      WHERE conversation_id = ? AND sender_id = ?
    `).bind(availableConversationId, availablePeerId).first();
    const blockedMessages = await env.CRASH_BOT_DB.prepare(`
      SELECT COUNT(*) AS count FROM anonymous_messages
      WHERE conversation_id = ? AND source_message_id = 593
    `).bind(blockedConversationId).first();
    expect(availableMessages.count).toBe(2);
    expect(blockedMessages.count).toBe(0);
  });

  it("keeps blocked content hidden until the recipient explicitly unblocks and views it", async () => {
    installTelegramMock();
    const senderId = await createUser("blocked_sender");
    const recipientId = await createUser("blocking_recipient");
    const conversationId = await openPersonalConversation(recipientId, senderId);
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO conversation_blocks (
        conversation_type, conversation_id, blocker_id, blocked_id
      ) VALUES ('personal_link', ?, ?, ?)
    `).bind(conversationId, recipientId, senderId).run();

    await handleAnonymousConversationMessage(env, {
      message_id: 595,
      from: { id: senderId },
      chat: { id: senderId, type: "private" },
      text: "محتوای محرمانهٔ پیام بلاک‌شده"
    }, senderId);
    const blocked = await env.CRASH_BOT_DB.prepare(`
      SELECT id, status FROM anonymous_blocked_messages
      WHERE sender_id = ? AND recipient_id = ?
    `).bind(senderId, recipientId).first();
    const unexposed = await env.CRASH_BOT_DB.prepare(`
      SELECT COUNT(*) AS count FROM anonymous_messages
      WHERE sender_id = ? AND source_message_id = 595
    `).bind(senderId).first();
    expect(blocked.status).toBe("pending");
    expect(unexposed.count).toBe(0);
    expect(telegramCalls.some((item) =>
      item.body.chat_id === recipientId &&
      String(item.body.text).includes("محتوای محرمانه")
    )).toBe(false);
    expect(telegramCalls.some((item) =>
      item.body.chat_id === recipientId &&
      item.body.reply_markup?.inline_keyboard?.flat().some((button) =>
        button.callback_data === `anon:unblock_view:${blocked.id}`
      )
    )).toBe(true);

    const outsiderId = await createUser("blocked_outsider");
    await handleAnonymousChatCallback(env, callback(
      outsiderId, `anon:unblock_view:${blocked.id}`
    ));
    expect((await env.CRASH_BOT_DB.prepare(`
      SELECT status FROM anonymous_blocked_messages WHERE id = ?
    `).bind(blocked.id).first()).status).toBe("pending");

    await handleAnonymousChatCallback(env, callback(
      recipientId, `anon:unblock_view:${blocked.id}`
    ));
    const saved = await env.CRASH_BOT_DB.prepare(`
      SELECT id, message, conversation_id
      FROM anonymous_messages WHERE sender_id = ? AND source_message_id = 595
    `).bind(senderId).first();
    const inbox = await env.CRASH_BOT_DB.prepare(`
      SELECT viewed_at FROM anonymous_message_inbox WHERE message_id = ?
    `).bind(saved.id).first();
    const remainingBlock = await env.CRASH_BOT_DB.prepare(`
      SELECT COUNT(*) AS count FROM conversation_blocks
      WHERE conversation_type = 'personal_link' AND conversation_id = ?
        AND blocker_id = ? AND blocked_id = ?
    `).bind(conversationId, recipientId, senderId).first();
    expect(saved).toEqual({
      id: expect.any(Number),
      message: "محتوای محرمانهٔ پیام بلاک‌شده",
      conversation_id: conversationId
    });
    expect(inbox.viewed_at).toBeTruthy();
    expect(remainingBlock.count).toBe(0);
    expect(telegramCalls.some((item) =>
      item.body.chat_id === recipientId &&
      String(item.body.text).includes("محتوای محرمانه")
    )).toBe(true);
    expect(telegramCalls.some((item) =>
      item.body.chat_id === recipientId &&
      item.body.reply_markup?.inline_keyboard?.flat().some((button) =>
        String(button.callback_data).startsWith("anon:reply:")
      )
    )).toBe(true);
  });

  it("cleans up only displayed history messages when moving between pages", async () => {
    installTelegramMock();
    const ownerId = await createUser();
    const peerId = await createUser();
    const conversationId = await openPersonalConversation(ownerId, peerId);
    for (let index = 0; index < 7; index += 1) {
      await insertMessage(
        conversationId, peerId, ownerId, `تاریخچه ${index + 1}`,
        610 + index, `2026-02-01 10:0${index}:00`
      );
    }
    const firstMessage = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM anonymous_messages
      WHERE conversation_id = ? ORDER BY id LIMIT 1
    `).bind(conversationId).first();

    await handleAnonymousChatCallback(env, callback(
      ownerId, `anon:history:${firstMessage.id}:0`
    ));
    const firstPageDisplays = await env.CRASH_BOT_DB.prepare(`
      SELECT message_id FROM conversation_display_messages
      WHERE actor_id = ? AND conversation_id = ?
    `).bind(ownerId, conversationId).all();
    expect(firstPageDisplays.results).toHaveLength(6);

    await handleAnonymousChatCallback(env, callback(
      ownerId, `anon:history:${firstMessage.id}:1`
    ));
    const remainingDisplays = await env.CRASH_BOT_DB.prepare(`
      SELECT message_id FROM conversation_display_messages
      WHERE actor_id = ? AND conversation_id = ?
    `).bind(ownerId, conversationId).all();
    expect(remainingDisplays.results).toHaveLength(1);
    const deletedDisplayIds = telegramCalls.filter((item) =>
      item.method === "deleteMessage"
    ).map((item) => item.body.message_id);
    for (const row of firstPageDisplays.results) {
      expect(deletedDisplayIds).toContain(row.message_id);
    }
    const storedHistory = await env.CRASH_BOT_DB.prepare(`
      SELECT COUNT(*) AS count FROM anonymous_messages WHERE conversation_id = ?
    `).bind(conversationId).first();
    expect(storedHistory.count).toBe(7);
  });

  it("keeps a media alert unread when Telegram rejects the media display", async () => {
    installTelegramMock();
    const senderId = await createUser("media_failure_sender");
    const recipientId = await createUser("media_failure_recipient");
    await openPersonalConversation(recipientId, senderId);
    await handleAnonymousConversationMessage(env, {
      message_id: 553,
      from: { id: senderId },
      chat: { id: senderId, type: "private" },
      photo: [{ file_id: "media-failure-photo" }],
      caption: "عکس آزمایشی"
    }, senderId);
    const notification = await env.CRASH_BOT_DB.prepare(`
      SELECT n.id FROM anonymous_message_inbox n
      JOIN anonymous_messages m ON m.id = n.message_id
      WHERE m.source_message_id = 553
    `).first();
    notificationIds.add(notification.id);
    const mediaSend = vi.spyOn(telegramApi, "sendMediaTelegramDetailed")
      .mockResolvedValue({ outcome: "rejected" });

    await handleAnonymousChatCallback(env, callback(
      recipientId, `anon:inbox:open:${notification.id}`, 814
    ));

    const row = await env.CRASH_BOT_DB.prepare(`
      SELECT viewed_at, sender_notice_status
      FROM anonymous_message_inbox WHERE id = ?
    `).bind(notification.id).first();
    expect(row).toEqual({ viewed_at: null, sender_notice_status: "pending" });
    expect(mediaSend).toHaveBeenCalledWith(env, "sendPhoto", expect.objectContaining({
      chat_id: recipientId,
      photo: "media-failure-photo",
      caption: expect.stringContaining("عکس آزمایشی")
    }));
    expect(telegramCalls.some((item) =>
      item.method === "sendMessage" &&
      String(item.body.text).includes("از طریق ربات مشاهده شد")
    )).toBe(false);
  });

  it("opens a channel alert into its own accepted conversation without changing the sender state", async () => {
    installTelegramMock();
    const requesterId = await createUser("connection_sender");
    const recipientId = await createUser("connection_recipient");
    const otherUserId = await createUser("other_chat_user");
    const sideConversationId = await openPersonalConversation(otherUserId, requesterId);
    const previousConnection = await env.CRASH_BOT_DB.prepare(`
      INSERT INTO connection_requests (requester_id, recipient_id, status)
      VALUES (?, ?, 'accepted') RETURNING id
    `).bind(recipientId, otherUserId).first();
    connectionIds.add(previousConnection.id);
    const expectedConnection = await env.CRASH_BOT_DB.prepare(`
      INSERT INTO connection_requests (requester_id, recipient_id, status)
      VALUES (?, ?, 'accepted') RETURNING id
    `).bind(requesterId, recipientId).first();
    connectionIds.add(expectedConnection.id);
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO anonymous_messages
        (sender_id, recipient_id, message, message_type, connection_id,
         source_message_id, delivery_status)
      VALUES (?, ?, 'درخواست‌کننده', 'connection', ?, 551, 'sent')
    `).bind(requesterId, recipientId, expectedConnection.id).run();
    const stored = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM anonymous_messages
      WHERE connection_id = ? AND source_message_id = 551
    `).bind(expectedConnection.id).first();
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO anonymous_message_inbox
        (message_id, recipient_id, source_type, delivery_status)
      VALUES (?, ?, 'connection', 'sent')
    `).bind(stored.id, recipientId).run();
    const notification = await env.CRASH_BOT_DB.prepare(
      "SELECT id FROM anonymous_message_inbox WHERE message_id = ?"
    ).bind(stored.id).first();
    notificationIds.add(notification.id);
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO user_conversations (user_id, flow_type, entity_id)
      VALUES (?, 'connection_chat', ?)
    `).bind(recipientId, previousConnection.id).run();

    await handleAnonymousChatCallback(env, callback(
      recipientId, `anon:inbox:open:${notification.id}`, 813
    ));

    const flow = await env.CRASH_BOT_DB.prepare(`
      SELECT flow_type, entity_id FROM user_conversations WHERE user_id = ?
    `).bind(recipientId).first();
    const senderState = await env.CRASH_BOT_DB.prepare(`
      SELECT conversation_id FROM anonymous_chat_states WHERE user_id = ?
    `).bind(requesterId).first();
    expect(flow).toEqual({
      flow_type: "connection_chat",
      entity_id: expectedConnection.id
    });
    expect(senderState).toEqual({ conversation_id: sideConversationId });

    await env.CRASH_BOT_DB.prepare(`
      UPDATE user_conversations SET entity_id = ? WHERE user_id = ?
    `).bind(previousConnection.id, recipientId).run();
    await handleAnonymousChatCallback(env, callback(
      recipientId, `anon:inbox:open:${notification.id}`, 815
    ));
    const restoredFlow = await env.CRASH_BOT_DB.prepare(`
      SELECT flow_type, entity_id FROM user_conversations WHERE user_id = ?
    `).bind(recipientId).first();
    expect(restoredFlow).toEqual({
      flow_type: "connection_chat",
      entity_id: expectedConnection.id
    });

    await handleConnectionMessageForTest(recipientId);
    const reply = await env.CRASH_BOT_DB.prepare(`
      SELECT recipient_id, connection_id FROM anonymous_messages
      WHERE sender_id = ? AND source_message_id = 552
    `).bind(recipientId).first();
    expect(reply).toEqual({
      recipient_id: requesterId,
      connection_id: expectedConnection.id
    });
  });

  it("resolves @username only for started users and never includes sender identity", async () => {
    installTelegramMock();
    const senderId = await createUser("sender_name");
    const recipientId = await createUser("ready_target");
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO anonymous_chat_states (user_id, state)
      VALUES (?, 'username_lookup')
    `).bind(senderId).run();
    await handleAnonymousConversationMessage(env, {
      message_id: 601,
      from: { id: senderId },
      chat: { id: senderId, type: "private" },
      text: "@ready_target"
    }, senderId);
    await handleAnonymousConversationMessage(env, {
      message_id: 602,
      from: { id: senderId, username: "sender_name" },
      chat: { id: senderId, type: "private" },
      text: "پیام ناشناس"
    }, senderId);

    const row = await env.CRASH_BOT_DB.prepare(`
      SELECT sender_id, recipient_id, message_type, delivery_status
      FROM anonymous_messages WHERE sender_id = ? AND source_message_id = 602
    `).bind(senderId).first();
    expect(row).toEqual({
      sender_id: senderId,
      recipient_id: recipientId,
      message_type: "username",
      delivery_status: "sent"
    });
    const alert = telegramCalls.find((item) =>
      item.method === "sendMessage" &&
      String(item.body.text).includes("منبع: ارتباط با آیدی")
    );
    expect(alert).toBeTruthy();
    expect(alert.body.text).not.toContain("sender_name");
    expect(alert.body.text).not.toContain(String(senderId));
  });

  it("allows owner-only archives and renders historical messages chronologically", async () => {
    installTelegramMock();
    vi.spyOn(telegramApi, "sendTrackedSectionInlineTelegram").mockResolvedValue(true);
    const ownerId = Number(env.OWNER_TELEGRAM_ID);
    const ordinaryAdmin = await createUser();
    const participantA = await createUser("archive_party_a");
    const participantB = await createUser("archive_party_b");
    await env.CRASH_BOT_DB.prepare(`
      UPDATE users SET first_name = 'Archive', last_name = 'Person A'
      WHERE telegram_id = ?
    `).bind(participantA).run();
    await env.CRASH_BOT_DB.prepare(`
      UPDATE users SET first_name = 'Archive', last_name = 'Person B'
      WHERE telegram_id = ?
    `).bind(participantB).run();
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO profiles (user_id, nickname) VALUES (?, 'لقب الف')
    `).bind(participantA).run();
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO admin_roles (user_id)
      VALUES (?)
    `).bind(ordinaryAdmin).run();
    const conversationId = await createConversationForTest(participantA, participantB);
    conversationIds.add(conversationId);
    await insertMessage(conversationId, participantA, participantB, "قديم", 701, "2026-01-01 10:00:00");
    await insertMessage(conversationId, participantB, participantA, "جديد", 702, "2026-01-01 10:01:00");

    const sendTracked = vi.spyOn(telegramApi, "sendTrackedSectionInlineTelegram");
    await renderOwnerAnonymousArchive(env, ordinaryAdmin, ordinaryAdmin);
    expect(sendTracked).not.toHaveBeenCalled();
    await renderOwnerAnonymousArchive(env, ownerId, ownerId);
    expect(sendTracked).toHaveBeenCalled();
    const archiveButtons = sendTracked.mock.calls.at(-1)[3].flat();
    expect(archiveButtons.every((button) =>
      typeof button.callback_data === "string" || typeof button.url === "string"
    )).toBe(true);
    expect(archiveButtons[0].text).toContain("@archive_party_a");
    expect(archiveButtons[0].text).toContain("@archive_party_b");
    expect(telegramCalls.some((item) =>
      item.body.reply_markup?.keyboard?.flat().some((button) =>
        button.text === "بازگشت به منوی اصلی"
      )
    )).toBe(true);

    const before = telegramCalls.length;
    await handleAnonymousChatCallback(
      env,
      callback(ownerId,
        `ownerarchive:open:anonymous:personal_link:${conversationId}:0`)
    );
    const playback = telegramCalls.slice(before)
      .filter((item) => item.method === "sendMessage")
      .map((item) => item.body.text)
      .filter((text) => String(text).includes("قديم") || String(text).includes("جديد"));
    expect(playback[0]).toContain("قديم");
    expect(playback[0]).toContain("@archive_party_a");
    expect(playback[0]).toContain(String(participantA));
    expect(playback[0]).toContain("نام تلگرام: Archive Person A");
    expect(playback[0]).toContain("لقب ربات: لقب الف");
    expect(playback[1]).toContain("جديد");
    expect(playback[1]).toContain("@archive_party_b");
    expect(playback[1]).toContain(String(participantB));
    expect(playback[1]).toContain("نام تلگرام: Archive Person B");

    await handleAnonymousChatCallback(
      env,
      callback(ordinaryAdmin,
        `ownerarchive:open:anonymous:personal_link:${conversationId}:0`)
    );
    expect(sendTracked).toHaveBeenCalledTimes(2);
    const displayed = await env.CRASH_BOT_DB.prepare(`
      SELECT message_id FROM owner_archive_display_messages WHERE owner_id = ?
    `).bind(ownerId).all();
    expect(displayed.results).toHaveLength(2);
    await renderOwnerAnonymousArchive(env, ownerId, ownerId);
    const cleared = await env.CRASH_BOT_DB.prepare(`
      SELECT COUNT(*) AS count FROM owner_archive_display_messages WHERE owner_id = ?
    `).bind(ownerId).first();
    expect(cleared.count).toBe(0);
    expect(telegramCalls.filter((item) =>
      item.method === "deleteMessage" &&
      displayed.results.some((row) => row.message_id === item.body.message_id)
    )).toHaveLength(2);
  });

  it("exports a complete owner archive as ordered, cursor-paginated text", async () => {
    installTelegramMock();
    const trackedSection = vi.spyOn(
      telegramApi, "sendTrackedSectionInlineTelegram"
    ).mockResolvedValue(true);
    const ownerId = Number(env.OWNER_TELEGRAM_ID);
    const participantA = await createUser("text_export_a");
    const participantB = await createUser();
    const conversationId = await createConversationForTest(participantA, participantB);
    conversationIds.add(conversationId);
    for (let index = 0; index < 10; index += 1) {
      await insertMessage(
        conversationId,
        index % 2 ? participantB : participantA,
        index % 2 ? participantA : participantB,
        `متن آرشیو ${index + 1}`,
        720 + index,
        `2026-01-03 10:${String(index).padStart(2, "0")}:00`
      );
    }
    await env.CRASH_BOT_DB.prepare(`
      UPDATE anonymous_messages
      SET media_type = 'photo', media_file_id = 'archive-photo',
        caption = 'کپشن رسانه'
      WHERE conversation_id = ? AND source_message_id = 721
    `).bind(conversationId).run();

    await handleAnonymousChatCallback(
      env, callback(ownerId,
        `ownerarchive:open:anonymous:personal_link:${conversationId}:0`)
    );
    const detailsMarkup = trackedSection.mock.calls.at(-1)[3];
    const exportCallback = detailsMarkup.flat().find((button) =>
      button.text.includes("خروجی متنی کامل")
    ).callback_data;
    await handleAnonymousChatCallback(env, callback(ownerId, exportCallback));

    const firstPageTexts = telegramCalls.map((item) => item.body.text)
      .filter((text) => String(text).includes("متن آرشیو "));
    expect(firstPageTexts.join("\n")).toContain("@text_export_a: متن آرشیو 1");
    expect(firstPageTexts.join("\n")).toContain(
      `${participantB}: [رسانه: photo] کپشن رسانه`
    );
    expect(firstPageTexts.join("\n")).toContain("متن آرشیو 8");
    expect(firstPageTexts.join("\n")).not.toContain("متن آرشیو 9");
    const continuation = telegramCalls.findLast((item) =>
      item.body.reply_markup?.inline_keyboard?.flat().some((button) =>
        button.text.includes("ادامهٔ خروجی متنی")
      )
    ).body.reply_markup.inline_keyboard.flat().find((button) =>
      button.text.includes("ادامهٔ خروجی متنی")
    ).callback_data;
    await handleAnonymousChatCallback(env, callback(ownerId, continuation));

    const completeTexts = telegramCalls.map((item) => item.body.text)
      .filter((text) => String(text).includes("متن آرشیو "));
    expect(completeTexts.join("\n")).toContain("متن آرشیو 1");
    expect(completeTexts.join("\n")).toContain("متن آرشیو 10");
    expect(completeTexts.join("\n")).toContain("زمان:");
    const pendingExports = await env.CRASH_BOT_DB.prepare(`
      SELECT COUNT(*) AS count FROM owner_archive_text_exports WHERE owner_id = ?
    `).bind(ownerId).first();
    expect(pendingExports.count).toBe(0);
  });

  it("includes one-way private conversations in the owner archive", async () => {
    installTelegramMock();
    vi.spyOn(telegramApi, "sendTrackedSectionInlineTelegram").mockResolvedValue(true);
    const ownerId = Number(env.OWNER_TELEGRAM_ID);
    const senderId = await createUser("one_way_sender");
    const recipientId = await createUser("one_way_recipient");
    const conversationId = await createConversationForTest(senderId, recipientId);
    conversationIds.add(conversationId);
    await insertMessage(
      conversationId, senderId, recipientId, "پیام یک‌طرفه", 703,
      "2026-01-02 10:00:00"
    );

    await renderOwnerAnonymousArchive(env, ownerId, ownerId);
    const buttons = telegramApi.sendTrackedSectionInlineTelegram.mock.calls
      .at(-1)[3].flat();
    expect(buttons.some((button) =>
      button.text.includes("@one_way_sender") &&
      button.text.includes("@one_way_recipient")
    )).toBe(true);

    const before = telegramCalls.length;
    await handleAnonymousChatCallback(
      env,
      callback(ownerId,
        `ownerarchive:open:anonymous:personal_link:${conversationId}:0`)
    );
    expect(telegramCalls.slice(before).some((item) =>
      item.method === "sendMessage" &&
      String(item.body.text).includes("پیام یک‌طرفه")
    )).toBe(true);
  });

  it("limits the accepted channel-conversation archive to the owner", async () => {
    installTelegramMock();
    vi.spyOn(telegramApi, "sendTrackedSectionInlineTelegram").mockResolvedValue(true);
    const ownerId = Number(env.OWNER_TELEGRAM_ID);
    const requesterId = await createUser("channel_party_a");
    const recipientId = await createUser("channel_party_b");
    const adminId = await createUser();
    await env.CRASH_BOT_DB.prepare(
      "INSERT INTO admin_roles (user_id) VALUES (?)"
    ).bind(adminId).run();
    const request = await env.CRASH_BOT_DB.prepare(`
      INSERT INTO connection_requests (requester_id, recipient_id, status)
      VALUES (?, ?, 'accepted') RETURNING id
    `).bind(requesterId, recipientId).first();
    connectionIds.add(request.id);
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO anonymous_messages
        (sender_id, recipient_id, message, message_type, connection_id, source_message_id)
      VALUES (?, ?, 'درخواست', 'connection', ?, 801)
    `).bind(requesterId, recipientId, request.id).run();

    const sendTracked = vi.spyOn(telegramApi, "sendTrackedSectionInlineTelegram");
    await renderOwnerConnectionArchive(env, adminId, adminId);
    expect(sendTracked).not.toHaveBeenCalled();
    await renderOwnerConnectionArchive(env, ownerId, ownerId);
    expect(sendTracked).toHaveBeenCalledTimes(1);
    const archiveButtons = sendTracked.mock.calls.at(-1)[3].flat();
    expect(archiveButtons[0].text).toContain("@channel_party_a");
    expect(archiveButtons[0].text).toContain("@channel_party_b");

    await handleAnonymousChatCallback(
      env,
      callback(adminId, "ownerarchive:list:posts:0")
    );
    expect(sendTracked).toHaveBeenCalledTimes(1);
    await handleAnonymousChatCallback(
      env,
      callback(ownerId, `ownerarchive:open:posts:connection:${request.id}:0`)
    );
    expect(sendTracked).toHaveBeenCalledTimes(2);
  });
});

async function createConversationForTest(userA, userB) {
  const first = Math.min(userA, userB);
  const second = Math.max(userA, userB);
  const row = await env.CRASH_BOT_DB.prepare(`
    INSERT INTO anonymous_conversations (user_a_id, user_b_id, source_type)
    VALUES (?, ?, 'personal_link') RETURNING id
  `).bind(first, second).first();
  return row.id;
}

async function insertMessage(conversationId, sender, recipient, text, sourceId, time) {
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO anonymous_messages
      (sender_id, recipient_id, message, message_type, conversation_id,
       source_message_id, delivery_status, created_at)
    VALUES (?, ?, ?, 'personal_link', ?, ?, 'sent', ?)
  `).bind(sender, recipient, text, conversationId, sourceId, time).run();
}
