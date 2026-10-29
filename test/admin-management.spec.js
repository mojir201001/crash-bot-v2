import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as telegramApi from "../src/telegram/api.js";
import {
  handleAdminManagementCallback,
  handleAdminManagementMessage,
  renderAdminManagement
} from "../src/services/admin-management.js";
import { getUserRole } from "../src/services/permissions.js";
import { handlePostCallback } from "../src/services/posts.js";

const fixtureUsers = new Set();
const fixturePostIds = new Set();
const pendingKey = "admin_management_pending_add";

async function createUser(id = null) {
  const userId = id ?? 760000000 + Math.floor(Math.random() * 40000000);
  fixtureUsers.add(userId);
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES (?, NULL, 'Admin test')
  `).bind(userId).run();
  return userId;
}

function callback(actorId, data) {
  return {
    id: `admin-${Math.random()}`,
    data,
    from: { id: actorId },
    message: { chat: { id: actorId, type: "private" }, message_id: 55 }
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await env.CRASH_BOT_DB.prepare(
    "DELETE FROM bot_settings WHERE key = ?"
  ).bind(pendingKey).run();
  if (fixturePostIds.size) {
    const ids = [...fixturePostIds];
    const marks = ids.map(() => "?").join(",");
    await env.CRASH_BOT_DB.prepare(`
      DELETE FROM review_decisions WHERE queue_id IN (
        SELECT id FROM admin_queue WHERE item_id IN (${marks})
      )
    `).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(
      `DELETE FROM post_events WHERE post_id IN (${marks})`
    ).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(
      `DELETE FROM admin_queue WHERE item_id IN (${marks})`
    ).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(
      `DELETE FROM posts WHERE id IN (${marks})`
    ).bind(...ids).run();
    fixturePostIds.clear();
  }
  for (const userId of fixtureUsers) {
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM audit_log WHERE entity_id = ? AND entity_type = 'admin_role'"
    ).bind(userId).run();
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM admin_roles WHERE user_id = ?"
    ).bind(userId).run();
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM users WHERE telegram_id = ?"
    ).bind(userId).run();
  }
  fixtureUsers.clear();
});

describe("owner-only administrator management", () => {
  it("adds and revokes an admin, records actors, and invalidates stale permissions", async () => {
    const ownerId = Number(env.OWNER_TELEGRAM_ID);
    const owner = await createUser(ownerId);
    const manager = await createUser();
    const post = await env.CRASH_BOT_DB.prepare(`
      INSERT INTO posts (user_id, content) VALUES (?, 'moderation test')
      RETURNING id
    `).bind(manager).first();
    fixturePostIds.add(post.id);
    const queue = await env.CRASH_BOT_DB.prepare(
      "SELECT id FROM admin_queue WHERE item_id = ?"
    ).bind(post.id).first();
    const answers = vi.spyOn(telegramApi, "answerCallbackQuery").mockResolvedValue(true);
    vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);
    vi.spyOn(telegramApi, "sendInlineTelegram").mockResolvedValue(true);
    vi.spyOn(telegramApi, "editInlineTelegram").mockResolvedValue(true);

    await handleAdminManagementCallback(env, callback(owner, "admin:add"));
    await handleAdminManagementMessage(env, {
      from: { id: owner },
      chat: { id: owner, type: "private" },
      text: String(manager)
    }, owner);
    expect(await getUserRole(env, manager)).toBe("admin");
    const grant = await env.CRASH_BOT_DB.prepare(`
      SELECT granted_by FROM admin_roles WHERE user_id = ?
    `).bind(manager).first();
    expect(String(grant.granted_by)).toBe(String(owner));

    await handleAdminManagementCallback(env, callback(owner, `admin:remove:${manager}`));
    expect(await getUserRole(env, manager)).toBe("user");
    const audit = await env.CRASH_BOT_DB.prepare(`
      SELECT action, actor_id FROM audit_log
      WHERE entity_type = 'admin_role' AND entity_id = ?
      ORDER BY id
    `).bind(manager).all();
    expect(audit.results.map((row) => row.action)).toEqual([
      "admin_granted", "admin_revoked"
    ]);
    expect(audit.results.every((row) => String(row.actor_id) === String(owner))).toBe(true);

    await handlePostCallback(env, callback(manager,
      `post:review:${queue.id}:approved`));
    const state = await env.CRASH_BOT_DB.prepare(
      "SELECT status FROM admin_queue WHERE id = ?"
    ).bind(queue.id).first();
    expect(state.status).toBe("pending");
    expect(answers.mock.calls.some((call) =>
      String(call[2]).includes("دسترسی مدیریت ندارید")
    )).toBe(true);
  });

  it("rejects manipulated callbacks by ordinary users and protects the owner role", async () => {
    const outsider = await createUser();
    const manager = await createUser();
    await env.CRASH_BOT_DB.prepare(
      "INSERT INTO admin_roles (user_id) VALUES (?)"
    ).bind(manager).run();
    const ownerId = Number(env.OWNER_TELEGRAM_ID);
    const answers = vi.spyOn(telegramApi, "answerCallbackQuery").mockResolvedValue(true);
    vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);
    vi.spyOn(telegramApi, "sendInlineTelegram").mockResolvedValue(true);

    await handleAdminManagementCallback(env, callback(outsider,
      `admin:remove:${manager}`));
    await handleAdminManagementCallback(env, callback(ownerId,
      `admin:remove:${ownerId}`));
    await renderAdminManagement(env, manager, manager);

    expect(await getUserRole(env, manager)).toBe("admin");
    expect(answers.mock.calls[0][2]).toContain("فقط برای مالک اصلی");
    expect(answers.mock.calls[1][2]).toContain("مالک اصلی");
  });

  it("does not grant a role to a user who has not started the bot", async () => {
    const owner = await createUser(Number(env.OWNER_TELEGRAM_ID));
    const send = vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO bot_settings (key, value) VALUES (?, '1')
    `).bind(pendingKey).run();

    await handleAdminManagementMessage(env, {
      from: { id: owner },
      chat: { id: owner, type: "private" },
      text: "770000001"
    }, owner);

    expect(await getUserRole(env, 770000001)).toBe("user");
    expect(send.mock.calls[0][2]).toContain("هنوز ربات را شروع نکرده");
  });
});
