import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as telegramApi from "../src/telegram/api.js";
import {
  handleArchiveCallback,
  renderPostArchive
} from "../src/services/posts.js";
import { getPersianMonthRange } from "../src/services/persian-calendar.js";

const fixtureUsers = new Set();
const fixturePosts = new Set();

async function createUser(id = null, admin = false) {
  const userId = id ?? 740000000 + Math.floor(Math.random() * 50000000);
  fixtureUsers.add(userId);
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES (?, NULL, 'Archive test')
  `).bind(userId).run();
  if (admin) {
    await env.CRASH_BOT_DB.prepare(
      "INSERT INTO admin_roles (user_id) VALUES (?)"
    ).bind(userId).run();
  }
  return userId;
}

async function createPost(userId, createdAt, content) {
  const row = await env.CRASH_BOT_DB.prepare(`
    INSERT INTO posts (user_id, content, created_at)
    VALUES (?, ?, ?) RETURNING id
  `).bind(userId, content, createdAt).first();
  fixturePosts.add(row.id);
  return row.id;
}

function callback(actorId, data) {
  return {
    id: `archive-${Math.random()}`,
    data,
    from: { id: actorId },
    message: { chat: { id: actorId, type: "private" }, message_id: 100 }
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (fixturePosts.size) {
    const ids = [...fixturePosts];
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
      `DELETE FROM publication_jobs WHERE item_id IN (${marks})`
    ).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(
      `DELETE FROM admin_queue WHERE item_id IN (${marks})`
    ).bind(...ids).run();
    await env.CRASH_BOT_DB.prepare(
      `DELETE FROM posts WHERE id IN (${marks})`
    ).bind(...ids).run();
    fixturePosts.clear();
  }
  for (const userId of fixtureUsers) {
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM admin_roles WHERE user_id = ?"
    ).bind(userId).run();
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM users WHERE telegram_id = ?"
    ).bind(userId).run();
  }
  fixtureUsers.clear();
});

describe("Persian archive calendar and active archive route", () => {
  it("uses Tehran midnight boundaries and handles a Persian leap year", () => {
    const leapEsfand = getPersianMonthRange(1403, 12);
    const commonEsfand = getPersianMonthRange(1404, 12);
    expect(Date.parse(`${leapEsfand.end}Z`) - Date.parse(`${leapEsfand.start}Z`))
      .toBe(30 * 86400000);
    expect(Date.parse(`${commonEsfand.end}Z`) - Date.parse(`${commonEsfand.start}Z`))
      .toBe(29 * 86400000);
    expect(leapEsfand.start.endsWith("20:30:00")).toBe(true);
    expect(leapEsfand.end).toBe(getPersianMonthRange(1404, 1).start);
    expect(() => getPersianMonthRange(1405, 13)).toThrow(RangeError);
    expect(() => getPersianMonthRange(1200, 1)).toThrow(RangeError);
  });

  it("filters the start boundary inclusively and the next month exclusively", async () => {
    const owner = await createUser(Number(env.OWNER_TELEGRAM_ID));
    const range = getPersianMonthRange(1404, 12);
    const endMinusSecond = new Date(Date.parse(`${range.end}Z`) - 1000)
      .toISOString().replace("T", " ").slice(0, 19);
    const first = await createPost(owner, range.start, "at start");
    const last = await createPost(owner, endMinusSecond, "before end");
    await createPost(owner, range.end, "at next month");
    const send = vi.spyOn(telegramApi, "sendInlineTelegram").mockResolvedValue(true);
    vi.spyOn(telegramApi, "answerCallbackQuery").mockResolvedValue(true);

    await handleArchiveCallback(env, callback(
      owner, "archive:month:1404:12:0"
    ));

    const screen = send.mock.calls.at(-1)[2];
    expect(screen).toContain("#" + first);
    expect(screen).toContain("#" + last);
    expect(screen).not.toContain("at next month");
    expect(screen).toContain("2 مورد");
  });

  it("paginates long months and reports an empty month", async () => {
    const owner = await createUser(Number(env.OWNER_TELEGRAM_ID));
    const range = getPersianMonthRange(1405, 1);
    for (let index = 0; index < 11; index += 1) {
      await createPost(owner, range.start, `entry ${index}`);
    }
    const send = vi.spyOn(telegramApi, "sendInlineTelegram").mockResolvedValue(true);
    vi.spyOn(telegramApi, "answerCallbackQuery").mockResolvedValue(true);

    await handleArchiveCallback(env, callback(owner, "archive:month:1405:1:0"));
    expect(send.mock.calls.at(-1)[2]).toContain("11 مورد");
    expect(send.mock.calls.at(-1)[3].flat().some((button) =>
      button.callback_data === "archive:month:1405:1:1"
    )).toBe(true);

    await handleArchiveCallback(env, callback(owner, "archive:month:1405:2:0"));
    expect(send.mock.calls.at(-1)[2]).toContain("0 مورد");
    expect(send.mock.calls.at(-1)[2]).toContain("در این بازه پیامی ثبت نشده است");
  });

  it("enforces server-side role checks and rejects stale invalid periods", async () => {
    const user = await createUser();
    const admin = await createUser(null, true);
    const denied = vi.spyOn(telegramApi, "answerCallbackQuery").mockResolvedValue(true);
    const send = vi.spyOn(telegramApi, "sendInlineTelegram").mockResolvedValue(true);
    const message = vi.spyOn(telegramApi, "sendTelegram").mockResolvedValue(true);

    await handleArchiveCallback(env, callback(user, "archive:all:0"));
    expect(denied.mock.calls.at(-1)[2]).toContain("مجوز مدیریت");
    expect(send).not.toHaveBeenCalled();

    await handleArchiveCallback(env, callback(admin, "archive:month:1405:13:0"));
    expect(message.mock.calls.at(-1)[2]).toContain("ماه یا سال آرشیو معتبر نیست");

    await renderPostArchive(env, admin, admin);
    expect(send.mock.calls.at(-1)[2]).toContain("سال آرشیو");
  });
});
