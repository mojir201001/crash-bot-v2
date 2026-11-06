import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as telegramApi from "../src/telegram/api.js";
import {
  appendAndNotify,
  handleAnonymousChatCallback,
  handleAnonymousConversationMessage,
  handlePersonalLinkStart,
  renderAnonymousHome,
  renderPersonalLink,
  selectConversation
} from "../src/services/anonymous-chat.js";
import { handleConnectionMessage } from "../src/services/connections.js";
import { stage3Routes } from "../src/telegram/keyboards.js";

const users = new Set();
const conversations = new Set();

async function createUser() {
  const userId = 890000000 + Math.floor(Math.random() * 9000000);
  users.add(userId);
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES (?, 'message_route_test', 'Routing test')
  `).bind(userId).run();
  return userId;
}

async function createConversation(userA, userB, sourceType) {
  const lower = Math.min(userA, userB);
  const upper = Math.max(userA, userB);
  const row = await env.CRASH_BOT_DB.prepare(`
    INSERT INTO anonymous_conversations (user_a_id, user_b_id, source_type)
    VALUES (?, ?, ?) RETURNING id
  `).bind(lower, upper, sourceType).first();
  conversations.add(row.id);
  return row.id;
}

function message(userId, messageId, text) {
  return {
    from: { id: userId },
    chat: { id: userId, type: "private" },
    message_id: messageId,
    text
  };
}

function callback(userId, data) {
  return {
    id: `route-${Math.random()}`,
    data,
    from: { id: userId },
    message: {
      chat: { id: userId, type: "private" },
      message_id: 501
    }
  };
}

function mockTelegram() {
  vi.spyOn(telegramApi, "sendInlineTelegramDetailed")
    .mockResolvedValue({ outcome: "sent", messageId: 9001 });
  vi.spyOn(telegramApi, "sendMessageTelegramDetailed")
    .mockResolvedValue({ outcome: "sent", messageId: 9002 });
  vi.spyOn(telegramApi, "editTelegramReplyMarkupDetailed")
    .mockResolvedValue({ outcome: "sent" });
  vi.spyOn(telegramApi, "sendMediaTelegramDetailed")
    .mockResolvedValue({ outcome: "sent", messageId: 9003 });
  vi.spyOn(telegramApi, "answerCallbackQuery").mockResolvedValue(true);
  vi.spyOn(telegramApi, "deleteTelegramMessage").mockResolvedValue(true);
  vi.spyOn(telegramApi, "sendTrackedSectionInlineTelegram").mockResolvedValue(true);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await env.CRASH_BOT_DB.prepare(
    "DROP TRIGGER IF EXISTS test_store_blocked_anonymous_race"
  ).run();
  const ids = [...users];
  if (ids.length) {
    const marks = ids.map(() => "?").join(",");
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM anonymous_blocked_messages
      WHERE sender_id IN (${marks}) OR recipient_id IN (${marks})
    `).bind(...ids, ...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM anonymous_message_inbox
      WHERE recipient_id IN (${marks})
    `).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM anonymous_messages
      WHERE sender_id IN (${marks}) OR recipient_id IN (${marks})
    `).bind(...ids, ...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM conversation_blocks
      WHERE blocker_id IN (${marks}) OR blocked_id IN (${marks})
    `).bind(...ids, ...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM anonymous_conversations
      WHERE user_a_id IN (${marks}) OR user_b_id IN (${marks})
    `).bind(...ids, ...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM anonymous_sessions
      WHERE user_a_id IN (${marks}) OR user_b_id IN (${marks})
    `).bind(...ids, ...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM connection_requests
      WHERE requester_id IN (${marks}) OR recipient_id IN (${marks})
    `).bind(...ids, ...ids).run();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM users WHERE telegram_id IN (${marks})
    `).bind(...ids).run();
  }
  users.clear();
  await env.CRASH_BOT_DB.prepare(`
    DELETE FROM bot_settings WHERE key = 'telegram_bot_username'
  `).run();
  conversations.clear();
});

describe("private anonymous message routing", () => {
  it("exposes all three anonymous routes and delivers personal-link messages through the inbox", async () => {
    mockTelegram();
    vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);
    const owner = await createUser();
    const sender = await createUser();
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO bot_settings (key, value)
      VALUES ('telegram_bot_username', 'crash_test_bot')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();

    await renderAnonymousHome(env, owner);
    const home = telegramApi.sendTelegram.mock.calls.at(-1);
    const labels = home[3].flat().map((button) => button.text);
    expect(labels).toEqual(expect.arrayContaining([
      "🔗 لینک ناشناس من",
      "🔎 ارتباط با آیدی",
      "🎭 چت ناشناس تصادفی"
    ]));
    expect(stage3Routes["🔗 لینک ناشناس من"]).toBe("anonymous_link");
    expect(stage3Routes["🔎 ارتباط با آیدی"]).toBe("anonymous_username");
    expect(stage3Routes["🎭 چت ناشناس تصادفی"]).toBe("anonymous_random");

    await renderPersonalLink(env, owner, owner);
    const linkText = telegramApi.sendTelegram.mock.calls.at(-1)[2];
    const token = linkText.match(/start=(anon_[a-f0-9]{32})/)?.[1];
    expect(token).toBeTruthy();
    await renderPersonalLink(env, owner, owner);
    expect(telegramApi.sendTelegram.mock.calls.at(-1)[2])
      .toContain(`start=${token}`);
    await handlePersonalLinkStart(env, sender, sender, token);
    expect(await handleAnonymousConversationMessage(
      env, message(sender, 899, "پیام از لینک ناشناس"), sender
    )).toBe(true);

    const saved = await env.CRASH_BOT_DB.prepare(`
      SELECT id, sender_id, recipient_id, message_type, source_message_id
      FROM anonymous_messages
      WHERE sender_id = ? AND recipient_id = ? AND source_message_id = 899
    `).bind(sender, owner).first();
    expect(saved).toMatchObject({
      sender_id: sender,
      recipient_id: owner,
      message_type: "personal_link",
      source_message_id: 899
    });
    const notice = telegramApi.sendInlineTelegramDetailed.mock.calls
      .find((call) => call[1] === owner);
    expect(notice[2]).toContain("شما یک پیام دارید");
    expect(notice[3][0][0]).toMatchObject({
      text: "مشاهده پیام",
      callback_data: expect.any(String)
    });
    await handleAnonymousChatCallback(
      env, callback(owner, notice[3][0][0].callback_data)
    );
    const inbox = await env.CRASH_BOT_DB.prepare(`
      SELECT viewed_at FROM anonymous_message_inbox WHERE message_id = ?
    `).bind(saved.id).first();
    expect(inbox.viewed_at).toBeTruthy();
    const receipt = telegramApi.sendMessageTelegramDetailed.mock.calls.find((call) =>
      call[1] === sender && String(call[2]).includes("پیام شما از طریق ربات مشاهده شد.")
    );
    expect(receipt?.[4]).toBe(899);
  });

  it("supports numeric target IDs only when the target has started the bot", async () => {
    mockTelegram();
    vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);
    const sender = await createUser();
    const activeTarget = await createUser();
    const inactiveTarget = 999000001;
    await env.CRASH_BOT_DB.prepare(`
      UPDATE users SET started_at = CURRENT_TIMESTAMP WHERE telegram_id = ?
    `).bind(activeTarget).run();
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO anonymous_chat_states (user_id, state)
      VALUES (?, 'username_lookup')
    `).bind(sender).run();

    expect(await handleAnonymousConversationMessage(
      env, message(sender, 920, String(activeTarget)), sender
    )).toBe(true);
    const activeState = await env.CRASH_BOT_DB.prepare(`
      SELECT state, target_user_id FROM anonymous_chat_states WHERE user_id = ?
    `).bind(sender).first();
    expect(activeState).toMatchObject({
      state: "username_message",
      target_user_id: activeTarget
    });

    await env.CRASH_BOT_DB.prepare(`
      UPDATE anonymous_chat_states
      SET state = 'username_lookup', target_user_id = NULL, conversation_id = NULL
      WHERE user_id = ?
    `).bind(sender).run();
    await handleAnonymousConversationMessage(
      env, message(sender, 921, String(inactiveTarget)), sender
    );
    const inactiveState = await env.CRASH_BOT_DB.prepare(`
      SELECT state FROM anonymous_chat_states WHERE user_id = ?
    `).bind(sender).first();
    expect(inactiveState.state).toBe("username_lookup");
    expect(telegramApi.sendTelegram.mock.calls.at(-1)[2])
      .toContain("ربات را باز کند");

    await env.CRASH_BOT_DB.prepare(`
      UPDATE users SET username = ? WHERE telegram_id = ?
    `).bind(`target_${activeTarget}`, activeTarget).run();
    await env.CRASH_BOT_DB.prepare(`
      UPDATE anonymous_chat_states
      SET state = 'username_lookup', target_user_id = NULL, conversation_id = NULL
      WHERE user_id = ?
    `).bind(sender).run();
    await handleAnonymousConversationMessage(
      env, message(sender, 922, `@target_${activeTarget}`), sender
    );
    const usernameState = await env.CRASH_BOT_DB.prepare(`
      SELECT state, target_user_id FROM anonymous_chat_states WHERE user_id = ?
    `).bind(sender).first();
    expect(usernameState).toMatchObject({
      state: "username_message",
      target_user_id: activeTarget
    });
  });

  it("holds blocked messages, releases once for the recipient, and replies to the source ID", async () => {
    mockTelegram();
    const receiver = await createUser();
    const sender = await createUser();
    const personal = await createConversation(receiver, sender, "personal_link");
    const username = await createConversation(receiver, sender, "username");
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO conversation_blocks
        (conversation_type, conversation_id, blocker_id, blocked_id)
      VALUES ('personal_link', ?, ?, ?)
    `).bind(personal, receiver, sender).run();

    const held = await appendAndNotify(env, {
      senderId: sender,
      recipientId: receiver,
      sourceType: "personal_link",
      conversationId: personal,
      message: message(sender, 901, "محتوای محرمانهٔ مسدودشده"),
      sourceMessageId: 901
    });
    expect(held.status).toBe("blocked");
    const pending = await env.CRASH_BOT_DB.prepare(`
      SELECT id, status FROM anonymous_blocked_messages
      WHERE conversation_type = 'personal_link' AND conversation_id = ?
    `).bind(personal).first();
    expect(pending.status).toBe("pending");
    const initialNotice = telegramApi.sendInlineTelegramDetailed.mock.calls
      .find((call) => call[1] === receiver);
    expect(initialNotice[2]).not.toContain("محتوای محرمانهٔ مسدودشده");
    expect(initialNotice[2]).toBe(
      "شما از فردی که در حال حاضر بلاک کرده‌اید یک پیام جدید دارید. برای مشاهده پیام، ابتدا بلاک فرستنده را بردارید."
    );
    expect(initialNotice[3][0][0].text).toBe("رفع بلاک و مشاهده پیام");
    expect(initialNotice[3][0][0].callback_data)
      .toBe(`anon:unblock_view:${pending.id}`);
    expect(telegramApi.sendMessageTelegramDetailed.mock.calls.some((call) =>
      call[1] === sender &&
      call[2] === "پیام ثبت شد؛ گیرنده برای مشاهده باید آن را تأیید کند."
    )).toBe(true);

    const otherRoute = await appendAndNotify(env, {
      senderId: sender,
      recipientId: receiver,
      sourceType: "username",
      conversationId: username,
      message: message(sender, 902, "پیام در مسیر مستقل"),
      sourceMessageId: 902
    });
    expect(otherRoute.status).toBe("sent");

    await handleAnonymousChatCallback(
      env, callback(receiver, `anon:unblock_view:${pending.id}`)
    );
    const released = await env.CRASH_BOT_DB.prepare(`
      SELECT status, released_message_id FROM anonymous_blocked_messages WHERE id = ?
    `).bind(pending.id).first();
    expect(released.status).toBe("released");
    const read = await env.CRASH_BOT_DB.prepare(`
      SELECT viewed_at FROM anonymous_message_inbox
      WHERE message_id = ? AND recipient_id = ?
    `).bind(released.released_message_id, receiver).first();
    expect(read.viewed_at).toBeTruthy();
    expect(telegramApi.sendInlineTelegramDetailed.mock.calls.some((call) =>
      call[1] === receiver &&
      String(call[2]).includes("محتوای محرمانهٔ مسدودشده")
    )).toBe(true);
    const receipt = telegramApi.sendMessageTelegramDetailed.mock.calls.find((call) =>
      call[1] === sender && String(call[2]).includes("پیام شما از طریق ربات مشاهده شد.")
    );
    expect(receipt?.[4]).toBe(901);

    await handleAnonymousChatCallback(
      env, callback(receiver, `anon:unblock_view:${pending.id}`)
    );
    expect(telegramApi.sendMessageTelegramDetailed.mock.calls.filter((call) =>
      call[1] === sender && String(call[2]).includes("پیام شما از طریق ربات مشاهده شد.")
    )).toHaveLength(1);
  });

  it("uses the blocked-message notice for random, channel, personal-link, and username routes", async () => {
    mockTelegram();
    const receiver = await createUser();
    const sender = await createUser();
    const personal = await createConversation(receiver, sender, "personal_link");
    const username = await createConversation(receiver, sender, "username");
    const connection = await env.CRASH_BOT_DB.prepare(`
      INSERT INTO connection_requests (requester_id, recipient_id, status)
      VALUES (?, ?, 'accepted') RETURNING id
    `).bind(receiver, sender).first();
    const random = await env.CRASH_BOT_DB.prepare(`
      INSERT INTO anonymous_sessions
        (user_a_id, user_b_id, requested_gender, status)
      VALUES (?, ?, 'woman', 'active') RETURNING id
    `).bind(receiver, sender).first();
    const routes = [
      { type: "personal_link", id: personal, args: { conversationId: personal } },
      { type: "username", id: username, args: { conversationId: username } },
      { type: "connection", id: connection.id, args: { connectionId: connection.id } },
      { type: "random_chat", id: random.id, args: { sessionId: random.id } }
    ];

    for (const [index, route] of routes.entries()) {
      await env.CRASH_BOT_DB.prepare(`
        INSERT INTO conversation_blocks
          (conversation_type, conversation_id, blocker_id, blocked_id)
        VALUES (?, ?, ?, ?)
      `).bind(route.type, route.id, receiver, sender).run();
      const sourceMessageId = 950 + index;
      const result = await appendAndNotify(env, {
        senderId: sender,
        recipientId: receiver,
        sourceType: route.type,
        ...route.args,
        message: message(sender, sourceMessageId, `محتوای مسیر ${route.type}`),
        sourceMessageId
      });

      expect(result.status).toBe("blocked");
      const notice = telegramApi.sendInlineTelegramDetailed.mock.calls
        .filter((call) => call[1] === receiver).at(-1);
      expect(notice[2]).toBe(
        "شما از فردی که در حال حاضر بلاک کرده‌اید یک پیام جدید دارید. برای مشاهده پیام، ابتدا بلاک فرستنده را بردارید."
      );
      expect(notice[2]).not.toContain(`محتوای مسیر ${route.type}`);
      expect(notice[3][0][0]).toMatchObject({
        text: "رفع بلاک و مشاهده پیام",
        callback_data: expect.stringMatching(/^anon:unblock_view:\d+$/)
      });
    }
  });

  it("holds real Channel Connections, Personal Link, and Username messages until their recipient accepts", async () => {
    mockTelegram();
    vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);
    const receiver = await createUser();
    const sender = await createUser();
    const outsider = await createUser();
    const unrelated = await createUser();
    const routes = [];
    const personal = await createConversation(receiver, sender, "personal_link");
    const username = await createConversation(receiver, sender, "username");
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO connection_requests (requester_id, recipient_id, status)
      VALUES (?, ?, 'accepted')
    `).bind(sender, receiver).run();
    const connection = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM connection_requests
      WHERE requester_id = ? AND recipient_id = ? AND status = 'accepted'
      ORDER BY id DESC LIMIT 1
    `).bind(sender, receiver).first();

    const personalToken = `anon_${"a".repeat(32)}`;
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO anonymous_personal_links (user_id, token) VALUES (?, ?)
    `).bind(receiver, personalToken).run();
    conversations.add(personal);
    routes.push({
      type: "personal_link",
      id: personal,
      sourceMessageId: 971,
      text: "پیام محرمانهٔ لینک شخصی",
      send: async () => {
        await handlePersonalLinkStart(env, sender, sender, personalToken);
        return handleAnonymousConversationMessage(
          env, message(sender, 971, "پیام محرمانهٔ لینک شخصی"), sender
        );
      }
    });

    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO anonymous_chat_states
        (user_id, state, target_user_id, conversation_id)
      VALUES (?, 'username_lookup', NULL, NULL)
      ON CONFLICT(user_id) DO UPDATE SET
        state = 'username_lookup', target_user_id = NULL,
        conversation_id = NULL,
        updated_at = CURRENT_TIMESTAMP
    `).bind(sender).run();
    await env.CRASH_BOT_DB.prepare(`
      UPDATE users SET started_at = CURRENT_TIMESTAMP WHERE telegram_id = ?
    `).bind(receiver).run();
    routes.push({
      type: "username",
      id: username,
      sourceMessageId: 972,
      text: "پیام محرمانهٔ آیدی",
      send: async () => {
        await env.CRASH_BOT_DB.prepare(`
          UPDATE anonymous_chat_states
          SET state = 'username_lookup', target_user_id = NULL,
            conversation_id = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ?
        `).bind(sender).run();
        await handleAnonymousConversationMessage(
          env, message(sender, 970, String(receiver)), sender
        );
        return handleAnonymousConversationMessage(
          env, message(sender, 972, "پیام محرمانهٔ آیدی"), sender
        );
      }
    });

    routes.push({
      type: "connection",
      id: connection.id,
      sourceMessageId: 973,
      text: "پیام محرمانهٔ کانال",
      send: async () => {
        await env.CRASH_BOT_DB.prepare(`
          INSERT INTO user_conversations (user_id, flow_type, entity_id)
          VALUES (?, 'connection_chat', ?)
          ON CONFLICT(user_id) DO UPDATE SET
            flow_type = 'connection_chat', entity_id = excluded.entity_id,
            payload = '{}', updated_at = CURRENT_TIMESTAMP
        `).bind(sender, connection.id).run();
        await selectConversation(env, sender, "connection", connection.id);
        return handleConnectionMessage(
          env, message(sender, 973, "پیام محرمانهٔ کانال"), sender
        );
      }
    });

    const unrelatedConversation = await createConversation(
      receiver, unrelated, "personal_link"
    );
    expect(routes.map(({ type, id }) => [type, id])).toEqual([
      ["personal_link", personal],
      ["username", username],
      ["connection", expect.any(Number)]
    ]);
    expect([receiver, sender]).toEqual([
      expect.any(Number), expect.any(Number)
    ]);
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO conversation_blocks
        (conversation_type, conversation_id, blocker_id, blocked_id)
      VALUES ('personal_link', ?, ?, ?)
    `).bind(unrelatedConversation, receiver, unrelated).run();

    for (const route of routes) {
      expect([route.type, route.id, receiver, sender]).not.toContain(undefined);
      await env.CRASH_BOT_DB.prepare(`
        INSERT INTO conversation_blocks
          (conversation_type, conversation_id, blocker_id, blocked_id)
        VALUES (?, ?, ?, ?)
      `).bind(route.type, route.id, receiver, sender).run();
      expect(await route.send(), route.type).toBe(true);

      const held = await env.CRASH_BOT_DB.prepare(`
        SELECT id, status FROM anonymous_blocked_messages
        WHERE conversation_type = ? AND conversation_id = ?
          AND sender_id = ? AND source_message_id = ?
      `).bind(route.type, route.id, sender, route.sourceMessageId).first();
      expect(held?.status, route.type).toBe("pending");
      const leaked = await env.CRASH_BOT_DB.prepare(`
        SELECT COUNT(*) AS count FROM anonymous_messages
        WHERE sender_id = ? AND source_message_id = ?
      `).bind(sender, route.sourceMessageId).first();
      expect(leaked.count).toBe(0);

      const notice = telegramApi.sendInlineTelegramDetailed.mock.calls
        .filter((call) => String(call[1]) === String(receiver))
        .at(-1);
      expect(notice[2]).toBe(
        "شما از فردی که در حال حاضر بلاک کرده‌اید یک پیام جدید دارید. برای مشاهده پیام، ابتدا بلاک فرستنده را بردارید."
      );
      expect(notice[2]).not.toContain(route.text);
      expect(notice[2]).not.toContain(String(sender));
      expect(notice[3][0][0]).toEqual({
        text: "رفع بلاک و مشاهده پیام",
        callback_data: `anon:unblock_view:${held.id}`
      });

      for (const unauthorizedActor of [sender, outsider]) {
        await handleAnonymousChatCallback(
          env, callback(unauthorizedActor, `anon:unblock_view:${held.id}`)
        );
      }
      await handleAnonymousChatCallback(
        env, callback(receiver, `anon:unblock_view:${held.id + 100000}`)
      );
      const stillHeld = await env.CRASH_BOT_DB.prepare(`
        SELECT status FROM anonymous_blocked_messages WHERE id = ?
      `).bind(held.id).first();
      expect(stillHeld.status).toBe("pending");

      await Promise.all([
        handleAnonymousChatCallback(
          env, callback(receiver, `anon:unblock_view:${held.id}`)
        ),
        handleAnonymousChatCallback(
          env, callback(receiver, `anon:unblock_view:${held.id}`)
        )
      ]);
      const released = await env.CRASH_BOT_DB.prepare(`
        SELECT status, released_message_id FROM anonymous_blocked_messages
        WHERE id = ?
      `).bind(held.id).first();
      expect(released.status).toBe("released");
      expect(released.released_message_id).toBeTruthy();
      const recipientMessages = telegramApi.sendInlineTelegramDetailed.mock.calls
        .filter((call) => String(call[1]) === String(receiver))
        .filter((call) => String(call[2]).includes(route.text));
      expect(recipientMessages).toHaveLength(1);

      const routeBlock = await env.CRASH_BOT_DB.prepare(`
        SELECT COUNT(*) AS count FROM conversation_blocks
        WHERE conversation_type = ? AND conversation_id = ?
          AND blocker_id = ? AND blocked_id = ?
      `).bind(route.type, route.id, receiver, sender).first();
      expect(routeBlock.count).toBe(0);

      await handleAnonymousChatCallback(
        env, callback(receiver, `anon:unblock_view:${held.id}`)
      );
      expect(telegramApi.sendInlineTelegramDetailed.mock.calls
        .filter((call) => String(call[1]) === String(receiver))
        .filter((call) => String(call[2]).includes(route.text))).toHaveLength(1);
    }

    const unrelatedBlock = await env.CRASH_BOT_DB.prepare(`
      SELECT COUNT(*) AS count FROM conversation_blocks
      WHERE conversation_type = 'personal_link' AND conversation_id = ?
        AND blocker_id = ? AND blocked_id = ?
    `).bind(unrelatedConversation, receiver, unrelated).first();
    expect(unrelatedBlock.count).toBe(1);
  });

  it("keeps the blocked sender's active route and only clears the blocker's state", async () => {
    mockTelegram();
    vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);
    const sourceTypes = ["connection", "personal_link", "username"];

    for (const [index, sourceType] of sourceTypes.entries()) {
      const receiver = await createUser();
      const sender = await createUser();
      const unrelatedUser = await createUser();
      let referenceId;
      if (sourceType === "connection") {
        await env.CRASH_BOT_DB.prepare(`
          INSERT INTO connection_requests (requester_id, recipient_id, status)
          VALUES (?, ?, 'accepted')
        `).bind(sender, receiver).run();
        const connection = await env.CRASH_BOT_DB.prepare(`
          SELECT id FROM connection_requests
          WHERE requester_id = ? AND recipient_id = ? AND status = 'accepted'
          ORDER BY id DESC LIMIT 1
        `).bind(sender, receiver).first();
        referenceId = connection.id;
        for (const userId of [receiver, sender]) {
          await env.CRASH_BOT_DB.prepare(`
            INSERT INTO user_conversations (user_id, flow_type, entity_id)
            VALUES (?, 'connection_chat', ?)
          `).bind(userId, referenceId).run();
          await selectConversation(env, userId, sourceType, referenceId);
        }
      } else {
        referenceId = await createConversation(
          receiver, sender, sourceType
        );
        for (const userId of [receiver, sender]) {
          await env.CRASH_BOT_DB.prepare(`
            INSERT INTO anonymous_chat_states
              (user_id, state, target_user_id, conversation_id)
            VALUES (?, 'active', NULL, ?)
          `).bind(userId, referenceId).run();
          await selectConversation(env, userId, sourceType, referenceId);
        }
      }

      const unrelatedConversation = await createConversation(
        receiver, unrelatedUser, "personal_link"
      );
      await env.CRASH_BOT_DB.prepare(`
        INSERT INTO conversation_blocks
          (conversation_type, conversation_id, blocker_id, blocked_id)
        VALUES ('personal_link', ?, ?, ?)
      `).bind(unrelatedConversation, receiver, unrelatedUser).run();

      const sourceMessageId = 12000 + index * 10;
      const initialMessage = await appendAndNotify(env, {
        senderId: sender,
        recipientId: receiver,
        sourceType,
        ...(sourceType === "connection"
          ? { connectionId: referenceId }
          : { conversationId: referenceId }),
        message: message(sender, sourceMessageId, "پیام اولیه برای ساخت کنترل بلاک"),
        sourceMessageId
      });
      expect(initialMessage.status, sourceType).toBe("sent");

      for (const userId of [receiver, sender]) {
        await env.CRASH_BOT_DB.prepare(`
          INSERT INTO conversation_reply_contexts (
            actor_id, message_id, conversation_type, conversation_id,
            peer_id, expires_at
          ) VALUES (?, ?, ?, ?, ?, datetime('now', '+15 minutes'))
        `).bind(
          userId, initialMessage.messageId, sourceType, referenceId,
          userId === receiver ? sender : receiver
        ).run();
      }

      await handleAnonymousChatCallback(
        env, callback(receiver, `anon:block:${initialMessage.messageId}`)
      );

      const senderState = sourceType === "connection"
        ? await env.CRASH_BOT_DB.prepare(`
          SELECT flow_type, entity_id FROM user_conversations WHERE user_id = ?
        `).bind(sender).first()
        : await env.CRASH_BOT_DB.prepare(`
          SELECT state, conversation_id FROM anonymous_chat_states
          WHERE user_id = ?
        `).bind(sender).first();
      expect(senderState, sourceType).toEqual(sourceType === "connection"
        ? { flow_type: "connection_chat", entity_id: referenceId }
        : { state: "active", conversation_id: referenceId });

      const receiverState = sourceType === "connection"
        ? await env.CRASH_BOT_DB.prepare(`
          SELECT flow_type FROM user_conversations WHERE user_id = ?
        `).bind(receiver).first()
        : await env.CRASH_BOT_DB.prepare(`
          SELECT state FROM anonymous_chat_states WHERE user_id = ?
        `).bind(receiver).first();
      expect(receiverState, sourceType).toBeNull();
      expect(await env.CRASH_BOT_DB.prepare(`
        SELECT conversation_id FROM active_conversation_selections
        WHERE actor_id = ? AND conversation_type = ?
      `).bind(sender, sourceType).first()).toEqual({
        conversation_id: referenceId
      });
      expect(await env.CRASH_BOT_DB.prepare(`
        SELECT actor_id FROM active_conversation_selections
        WHERE actor_id = ? AND conversation_type = ?
      `).bind(receiver, sourceType).first()).toBeNull();
      expect(await env.CRASH_BOT_DB.prepare(`
        SELECT message_id FROM conversation_reply_contexts
        WHERE actor_id = ? AND conversation_type = ? AND conversation_id = ?
          AND peer_id = ?
      `).bind(sender, sourceType, referenceId, receiver).first()).toEqual({
        message_id: initialMessage.messageId
      });
      expect(await env.CRASH_BOT_DB.prepare(`
        SELECT actor_id FROM conversation_reply_contexts
        WHERE actor_id = ? AND conversation_type = ? AND conversation_id = ?
      `).bind(receiver, sourceType, referenceId).first()).toBeNull();

      const blockedByReceiver = await env.CRASH_BOT_DB.prepare(`
        SELECT id FROM conversation_blocks
        WHERE conversation_type = ? AND conversation_id = ?
          AND blocker_id = ? AND blocked_id = ?
      `).bind(sourceType, referenceId, receiver, sender).first();
      const reciprocalBlock = await env.CRASH_BOT_DB.prepare(`
        SELECT id FROM conversation_blocks
        WHERE conversation_type = ? AND conversation_id = ?
          AND blocker_id = ? AND blocked_id = ?
      `).bind(sourceType, referenceId, sender, receiver).first();
      const unrelatedBlock = await env.CRASH_BOT_DB.prepare(`
        SELECT id FROM conversation_blocks
        WHERE conversation_type = 'personal_link' AND conversation_id = ?
          AND blocker_id = ? AND blocked_id = ?
      `).bind(unrelatedConversation, receiver, unrelatedUser).first();
      expect(blockedByReceiver).toBeTruthy();
      expect(reciprocalBlock).toBeNull();
      expect(unrelatedBlock).toBeTruthy();

      const followupMessageId = sourceMessageId + 1;
      const deliveredToRoute = sourceType === "connection"
        ? await handleConnectionMessage(
          env,
          message(sender, followupMessageId, `پیام بعد از بلاک ${sourceType}`),
          sender
        )
        : await handleAnonymousConversationMessage(
          env,
          message(sender, followupMessageId, `پیام بعد از بلاک ${sourceType}`),
          sender
        );
      expect(deliveredToRoute, sourceType).toBe(true);

      const blockedMessage = await env.CRASH_BOT_DB.prepare(`
        SELECT id, status, notice_status, message, sender_id, recipient_id
        FROM anonymous_blocked_messages
        WHERE conversation_type = ? AND conversation_id = ?
          AND sender_id = ? AND source_message_id = ?
      `).bind(sourceType, referenceId, sender, followupMessageId).first();
      expect(blockedMessage, sourceType).toMatchObject({
        status: "pending",
        notice_status: "sent",
        message: `پیام بعد از بلاک ${sourceType}`,
        sender_id: sender,
        recipient_id: receiver
      });
      expect(await env.CRASH_BOT_DB.prepare(`
        SELECT id FROM anonymous_messages
        WHERE sender_id = ? AND source_message_id = ?
      `).bind(sender, followupMessageId).first()).toBeNull();

      const notice = telegramApi.sendInlineTelegramDetailed.mock.calls
        .filter((call) => String(call[1]) === String(receiver))
        .at(-1);
      expect(notice[2]).toBe(
        "شما از فردی که در حال حاضر بلاک کرده‌اید یک پیام جدید دارید. برای مشاهده پیام، ابتدا بلاک فرستنده را بردارید."
      );
      expect(notice[2]).not.toContain(`پیام بعد از بلاک ${sourceType}`);
      expect(notice[2]).not.toContain(String(sender));
      expect(notice[3][0][0]).toEqual({
        text: "رفع بلاک و مشاهده پیام",
        callback_data: `anon:unblock_view:${blockedMessage.id}`
      });
    }
  });

  it("rejects Personal Link and numeric-ID entry when both users have blocked each other", async () => {
    mockTelegram();
    vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);
    const recipient = await createUser();
    const sender = await createUser();
    const personalConversation = await createConversation(
      recipient, sender, "personal_link"
    );
    const usernameConversation = await createConversation(
      recipient, sender, "username"
    );
    const personalToken = `anon_${"b".repeat(32)}`;
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO anonymous_personal_links (user_id, token) VALUES (?, ?)
    `).bind(recipient, personalToken).run();
    await env.CRASH_BOT_DB.prepare(`
      UPDATE users SET started_at = CURRENT_TIMESTAMP WHERE telegram_id = ?
    `).bind(recipient).run();
    for (const [type, conversationId] of [
      ["personal_link", personalConversation],
      ["username", usernameConversation]
    ]) {
      await env.CRASH_BOT_DB.prepare(`
        INSERT INTO conversation_blocks
          (conversation_type, conversation_id, blocker_id, blocked_id)
        VALUES (?, ?, ?, ?), (?, ?, ?, ?)
      `).bind(
        type, conversationId, recipient, sender,
        type, conversationId, sender, recipient
      ).run();
    }

    await handlePersonalLinkStart(env, sender, sender, personalToken);
    const personalState = await env.CRASH_BOT_DB.prepare(`
      SELECT state FROM anonymous_chat_states WHERE user_id = ?
    `).bind(sender).first();
    expect(personalState).toBeNull();

    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO anonymous_chat_states (user_id, state)
      VALUES (?, 'username_lookup')
    `).bind(sender).run();
    await handleAnonymousConversationMessage(
      env, message(sender, 974, String(recipient)), sender
    );
    const usernameState = await env.CRASH_BOT_DB.prepare(`
      SELECT state, target_user_id FROM anonymous_chat_states WHERE user_id = ?
    `).bind(sender).first();
    expect(usernameState).toEqual({
      state: "username_lookup",
      target_user_id: null
    });
    expect(telegramApi.sendInlineTelegramDetailed.mock.calls
      .some((call) => call[1] === recipient)).toBe(false);
  });

  it("preserves a message when the recipient blocks between the preflight and atomic insert", async () => {
    mockTelegram();
    const receiver = await createUser();
    const sender = await createUser();
    const conversationId = await createConversation(
      receiver, sender, "personal_link"
    );
    await env.CRASH_BOT_DB.prepare(`
      CREATE TRIGGER test_store_blocked_anonymous_race
      BEFORE INSERT ON anonymous_messages
      WHEN NEW.message_type = 'personal_link' AND NEW.source_message_id = 974
      BEGIN
        INSERT OR IGNORE INTO conversation_blocks
          (conversation_type, conversation_id, blocker_id, blocked_id)
        VALUES ('personal_link', ${conversationId}, ${receiver}, ${sender});
        SELECT RAISE(IGNORE);
      END
    `).run();

    const result = await appendAndNotify(env, {
      senderId: sender,
      recipientId: receiver,
      sourceType: "personal_link",
      conversationId,
      message: message(sender, 974, "پیامی در لحظهٔ بلاک"),
      sourceMessageId: 974
    });
    expect(result.status).toBe("blocked");

    const stored = await env.CRASH_BOT_DB.prepare(`
      SELECT id, status, message FROM anonymous_blocked_messages
      WHERE conversation_type = 'personal_link' AND conversation_id = ?
        AND sender_id = ? AND source_message_id = 974
    `).bind(conversationId, sender).first();
    expect(stored).toMatchObject({
      status: "pending",
      message: "پیامی در لحظهٔ بلاک"
    });
    const leaked = await env.CRASH_BOT_DB.prepare(`
      SELECT COUNT(*) AS count FROM anonymous_messages
      WHERE sender_id = ? AND source_message_id = 974
    `).bind(sender).first();
    expect(leaked.count).toBe(0);
    const notice = telegramApi.sendInlineTelegramDetailed.mock.calls
      .find((call) => String(call[1]) === String(receiver));
    expect(notice[2]).not.toContain("پیامی در لحظهٔ بلاک");
    expect(notice[3][0][0]).toMatchObject({
      text: "رفع بلاک و مشاهده پیام",
      callback_data: `anon:unblock_view:${stored.id}`
    });
  });

  it("records rejected notices and retries a definite failure without duplicating the blocked message", async () => {
    mockTelegram();
    const receiver = await createUser();
    const sender = await createUser();
    const conversationId = await createConversation(
      receiver, sender, "personal_link"
    );
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO conversation_blocks
        (conversation_type, conversation_id, blocker_id, blocked_id)
      VALUES ('personal_link', ?, ?, ?)
    `).bind(conversationId, receiver, sender).run();
    telegramApi.sendInlineTelegramDetailed
      .mockResolvedValueOnce({ outcome: "rejected" })
      .mockResolvedValueOnce({ outcome: "sent", messageId: 9300 });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const blockedMessage = {
      senderId: sender,
      recipientId: receiver,
      sourceType: "personal_link",
      conversationId,
      message: message(sender, 976, "اعلانِ قابل تلاش مجدد"),
      sourceMessageId: 976
    };

    await appendAndNotify(env, blockedMessage);
    let row = await env.CRASH_BOT_DB.prepare(`
      SELECT id, notice_status FROM anonymous_blocked_messages
      WHERE conversation_type = 'personal_link' AND conversation_id = ?
        AND sender_id = ? AND source_message_id = 976
    `).bind(conversationId, sender).first();
    expect(row.notice_status).toBe("failed");
    expect(error).toHaveBeenCalledWith(
      "Could not deliver blocked-message notice: Telegram rejected the send"
    );
    expect(telegramApi.sendMessageTelegramDetailed.mock.calls.some((call) =>
      call[1] === sender &&
      String(call[2]).includes("اعلان به گیرنده تحویل نشد")
    )).toBe(true);

    await appendAndNotify(env, blockedMessage);
    row = await env.CRASH_BOT_DB.prepare(`
      SELECT id, notice_status FROM anonymous_blocked_messages
      WHERE conversation_type = 'personal_link' AND conversation_id = ?
        AND sender_id = ? AND source_message_id = 976
    `).bind(conversationId, sender).first();
    expect(row.notice_status).toBe("sent");
    const count = await env.CRASH_BOT_DB.prepare(`
      SELECT COUNT(*) AS count FROM anonymous_blocked_messages
      WHERE conversation_type = 'personal_link' AND conversation_id = ?
        AND sender_id = ? AND source_message_id = 976
    `).bind(conversationId, sender).first();
    expect(count.count).toBe(1);
    expect(telegramApi.sendInlineTelegramDetailed).toHaveBeenCalledTimes(2);
  });

  it("rejects a stale unblock callback after its conversation block was removed", async () => {
    mockTelegram();
    const receiver = await createUser();
    const sender = await createUser();
    const conversationId = await createConversation(
      receiver, sender, "username"
    );
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO conversation_blocks
        (conversation_type, conversation_id, blocker_id, blocked_id)
      VALUES ('username', ?, ?, ?)
    `).bind(conversationId, receiver, sender).run();
    await appendAndNotify(env, {
      senderId: sender,
      recipientId: receiver,
      sourceType: "username",
      conversationId,
      message: message(sender, 975, "پیام مربوط به دکمهٔ منقضی"),
      sourceMessageId: 975
    });
    const pending = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM anonymous_blocked_messages
      WHERE conversation_type = 'username' AND conversation_id = ?
        AND source_message_id = 975
    `).bind(conversationId).first();
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM conversation_blocks
      WHERE conversation_type = 'username' AND conversation_id = ?
        AND blocker_id = ? AND blocked_id = ?
    `).bind(conversationId, receiver, sender).run();

    await handleAnonymousChatCallback(
      env, callback(receiver, `anon:unblock_view:${pending.id}`)
    );

    const state = await env.CRASH_BOT_DB.prepare(`
      SELECT status FROM anonymous_blocked_messages WHERE id = ?
    `).bind(pending.id).first();
    expect(state.status).toBe("pending");
    const visible = await env.CRASH_BOT_DB.prepare(`
      SELECT COUNT(*) AS count FROM anonymous_messages
      WHERE sender_id = ? AND source_message_id = 975
    `).bind(sender).first();
    expect(visible.count).toBe(0);
    expect(telegramApi.sendInlineTelegramDetailed.mock.calls
      .filter((call) => String(call[1]) === String(receiver))
      .some((call) => String(call[2]).includes("پیام مربوط به دکمهٔ منقضی")))
      .toBe(false);
  });

  it("does not release a blocked message or remove either block in a mutual block", async () => {
    mockTelegram();
    const receiver = await createUser();
    const sender = await createUser();
    const conversationId = await createConversation(
      receiver, sender, "personal_link"
    );
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO conversation_blocks
        (conversation_type, conversation_id, blocker_id, blocked_id)
      VALUES ('personal_link', ?, ?, ?), ('personal_link', ?, ?, ?)
    `).bind(
      conversationId, receiver, sender,
      conversationId, sender, receiver
    ).run();
    const held = await appendAndNotify(env, {
      senderId: sender,
      recipientId: receiver,
      sourceType: "personal_link",
      conversationId,
      message: message(sender, 961, "پیام با بلاک دوطرفه"),
      sourceMessageId: 961
    });
    expect(held.status).toBe("blocked");
    const pending = await env.CRASH_BOT_DB.prepare(`
      SELECT id FROM anonymous_blocked_messages
      WHERE conversation_type = 'personal_link' AND conversation_id = ?
    `).bind(conversationId).first();

    await handleAnonymousChatCallback(
      env, callback(receiver, `anon:unblock_view:${pending.id}`)
    );

    const blocks = await env.CRASH_BOT_DB.prepare(`
      SELECT blocker_id FROM conversation_blocks
      WHERE conversation_type = 'personal_link' AND conversation_id = ?
      ORDER BY blocker_id
    `).bind(conversationId).all();
    expect(blocks.results).toEqual([
      { blocker_id: receiver },
      { blocker_id: sender }
    ].sort((a, b) => a.blocker_id - b.blocker_id));
    const state = await env.CRASH_BOT_DB.prepare(`
      SELECT status FROM anonymous_blocked_messages WHERE id = ?
    `).bind(pending.id).first();
    expect(state.status).toBe("pending");
    expect(telegramApi.sendInlineTelegramDetailed.mock.calls.some((call) =>
      call[1] === receiver && String(call[2]).includes("پیام با بلاک دوطرفه")
    )).toBe(false);
  });

  it("keeps released and recovering blocked messages hidden while the reciprocal block is active", async () => {
    mockTelegram();
    const receiver = await createUser();
    const sender = await createUser();
    const outsider = await createUser();
    const conversationId = await createConversation(
      receiver, sender, "personal_link"
    );
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO conversation_blocks
        (conversation_type, conversation_id, blocker_id, blocked_id)
      VALUES ('personal_link', ?, ?, ?), ('personal_link', ?, ?, ?)
    `).bind(
      conversationId, receiver, sender,
      conversationId, sender, receiver
    ).run();

    for (const [sourceMessageId, state] of [
      [962, "released"],
      [963, "releasing"]
    ]) {
      await env.CRASH_BOT_DB.prepare(`
        INSERT INTO anonymous_blocked_messages
          (conversation_type, conversation_id, sender_id, recipient_id,
           source_message_id, message, status, released_message_id)
        VALUES ('personal_link', ?, ?, ?, ?, ?, ?, NULL)
      `).bind(
        conversationId, sender, receiver, sourceMessageId,
        `محتوای محرمانهٔ ${state}`, state
      ).run();
      const blocked = await env.CRASH_BOT_DB.prepare(`
        SELECT id FROM anonymous_blocked_messages
        WHERE conversation_type = 'personal_link' AND conversation_id = ?
          AND source_message_id = ?
      `).bind(conversationId, sourceMessageId).first();
      const saved = await env.CRASH_BOT_DB.prepare(`
        INSERT INTO anonymous_messages
          (sender_id, recipient_id, message, message_type, source_message_id,
           conversation_id)
        VALUES (?, ?, ?, 'personal_link', ?, ?) RETURNING id
      `).bind(
        sender, receiver, `محتوای محرمانهٔ ${state}`,
        sourceMessageId, conversationId
      ).first();
      const inbox = await env.CRASH_BOT_DB.prepare(`
        INSERT INTO anonymous_message_inbox
          (message_id, recipient_id, source_type, delivery_status)
        VALUES (?, ?, 'personal_link', 'sent') RETURNING id
      `).bind(saved.id, receiver).first();
      if (state === "released") {
        await env.CRASH_BOT_DB.prepare(`
          UPDATE anonymous_blocked_messages
          SET released_message_id = ? WHERE id = ?
        `).bind(saved.id, blocked.id).run();
        await handleAnonymousChatCallback(
          env, callback(outsider, `anon:unblock_view:${blocked.id}`)
        );
        await handleAnonymousChatCallback(
          env, callback(outsider, `anon:inbox:open:${inbox.id}`)
        );
        const unauthorizedView = await env.CRASH_BOT_DB.prepare(`
          SELECT viewed_at FROM anonymous_message_inbox WHERE id = ?
        `).bind(inbox.id).first();
        expect(unauthorizedView.viewed_at).toBeNull();
        await handleAnonymousChatCallback(
          env, callback(receiver, `anon:unblock_view:${blocked.id}`)
        );
        await handleAnonymousChatCallback(
          env, callback(receiver, `anon:inbox:open:${inbox.id}`)
        );
        const unread = await env.CRASH_BOT_DB.prepare(`
          SELECT viewed_at FROM anonymous_message_inbox WHERE id = ?
        `).bind(inbox.id).first();
        expect(unread.viewed_at).toBeNull();
      } else {
        await handleAnonymousChatCallback(
          env, callback(receiver, `anon:unblock_view:${blocked.id}`)
        );
        const recovering = await env.CRASH_BOT_DB.prepare(`
          SELECT status FROM anonymous_blocked_messages WHERE id = ?
        `).bind(blocked.id).first();
        expect(recovering.status).toBe("releasing");
      }
    }

    const remainingBlocks = await env.CRASH_BOT_DB.prepare(`
      SELECT COUNT(*) AS count FROM conversation_blocks
      WHERE conversation_type = 'personal_link' AND conversation_id = ?
    `).bind(conversationId).first();
    expect(remainingBlocks.count).toBe(2);
    expect(telegramApi.sendInlineTelegramDetailed.mock.calls
      .flatMap((call) => [call[2], JSON.stringify(call[3] ?? [])])
      .join("\n")).not.toContain("محتوای محرمانهٔ released");
    expect(telegramApi.sendInlineTelegramDetailed.mock.calls
      .flatMap((call) => [call[2], JSON.stringify(call[3] ?? [])])
      .join("\n")).not.toContain("محتوای محرمانهٔ releasing");
  });

  it("ignores commands and forged private-message identities and rejects self delivery", async () => {
    mockTelegram();
    const user = await createUser();
    const peer = await createUser();
    const conversationId = await createConversation(user, peer, "username");
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO anonymous_chat_states (user_id, state, target_user_id)
      VALUES (?, 'username_message', ?)
    `).bind(user, peer).run();

    expect(await handleAnonymousConversationMessage(
      env, message(user, 911, "/help"), user
    )).toBe(false);
    expect(await handleAnonymousConversationMessage(
      env, { ...message(user, 912, "forged"), from: { id: peer } }, user
    )).toBe(false);
    const selfSend = await handleAnonymousConversationMessage(
      env, message(user, 913, "self"), user
    );
    expect(selfSend).toBe(true);
    const selfState = await env.CRASH_BOT_DB.prepare(`
      UPDATE anonymous_chat_states
      SET state = 'username_message', target_user_id = ?, conversation_id = NULL
      WHERE user_id = ?
    `).bind(user, user).run();
    expect(selfState.success).toBe(true);
    expect(await handleAnonymousConversationMessage(
      env, message(user, 914, "self"), user
    )).toBe(true);
    const own = await env.CRASH_BOT_DB.prepare(`
      SELECT COUNT(*) AS count FROM anonymous_messages
      WHERE sender_id = ? AND recipient_id = ?
    `).bind(user, user).first();
    expect(own.count).toBe(0);
    const sentToPeer = await env.CRASH_BOT_DB.prepare(`
      SELECT COUNT(*) AS count FROM anonymous_messages
      WHERE sender_id = ? AND recipient_id = ? AND conversation_id = ?
    `).bind(user, peer, conversationId).first();
    expect(sentToPeer.count).toBe(1);
  });
});
