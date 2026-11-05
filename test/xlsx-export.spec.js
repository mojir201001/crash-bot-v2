import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as telegramApi from "../src/telegram/api.js";
import {
  buildManagementWorkbook,
  exportManagementWorkbook,
  handleExportWorkbookCallback
} from "../src/services/xlsx-export.js";

const userId = 740000001;
const ownerId = Number(env.OWNER_TELEGRAM_ID);

function unzipStored(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries = new Map();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const compressedSize = view.getUint32(offset + 18, true);
    const filenameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const filename = decoder.decode(bytes.slice(offset + 30, offset + 30 + filenameLength));
    const dataStart = offset + 30 + filenameLength + extraLength;
    const data = bytes.slice(dataStart, dataStart + compressedSize);
    entries.set(filename, decoder.decode(data));
    offset = dataStart + compressedSize;
  }
  expect(view.getUint32(offset, true)).toBe(0x02014b50);
  expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50);
  return entries;
}

beforeEach(async () => {
  vi.spyOn(telegramApi, "sendMessageTelegramDetailed")
    .mockResolvedValue({ outcome: "sent" });
  await env.CRASH_BOT_DB.prepare(`
    INSERT OR IGNORE INTO users (telegram_id, first_name)
    VALUES (?, 'Excel test')
  `).bind(userId).run();
  await env.CRASH_BOT_DB.prepare(`
    INSERT OR IGNORE INTO profiles (user_id, nickname)
    VALUES (?, 'لقب فارسی')
  `).bind(userId).run();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.CRASH_BOT_DB.prepare(
    "DELETE FROM owner_export_documents WHERE owner_id = ?"
  ).bind(ownerId).run();
  await env.CRASH_BOT_DB.prepare(
    "DELETE FROM owner_export_jobs WHERE owner_id = ?"
  ).bind(ownerId).run();
  await env.CRASH_BOT_DB.prepare(`
    DELETE FROM post_events
    WHERE post_id IN (SELECT id FROM posts WHERE user_id = ?)
  `).bind(userId).run();
  await env.CRASH_BOT_DB.prepare(`
    DELETE FROM connection_requests
    WHERE post_id IN (SELECT id FROM posts WHERE user_id = ?)
  `).bind(userId).run();
  await env.CRASH_BOT_DB.prepare(`
    DELETE FROM admin_queue
    WHERE item_type IN ('post', 'reply')
      AND item_id IN (SELECT id FROM posts WHERE user_id = ?)
  `).bind(userId).run();
  await env.CRASH_BOT_DB.prepare("DELETE FROM posts WHERE user_id = ?")
    .bind(userId).run();
  await env.CRASH_BOT_DB.prepare("DELETE FROM profiles WHERE user_id = ?")
    .bind(userId).run();
  await env.CRASH_BOT_DB.prepare("DELETE FROM users WHERE telegram_id = ?")
    .bind(userId).run();
});

describe("management Excel export", () => {
  it("builds a valid OOXML zip workbook and prevents spreadsheet formula injection", () => {
    const workbook = buildManagementWorkbook([{
      id: 10,
      reply_to_post_id: null,
      nickname: "لقب فارسی",
      user_id: 740000001,
      sender_username: "excel_sender",
      status: "pending",
      content: "=HYPERLINK(\"https://example.invalid\")",
      created_at: "2026-01-01 12:00:00",
      reviewed_at: null
    }]);
    const entries = unzipStored(workbook);
    expect(entries.has("[Content_Types].xml")).toBe(true);
    expect(entries.has("xl/workbook.xml")).toBe(true);
    const sheet = entries.get("xl/worksheets/sheet1.xml");
    expect(sheet).toContain("شناسهٔ رکورد");
    expect(sheet).toContain("لقب فارسی");
    expect(sheet).toContain("شناسهٔ تلگرام فرستنده");
    expect(sheet).toContain("<c r=\"D2\"><v>740000001</v></c>");
    expect(sheet).toContain("@excel_sender");
    expect(sheet).toContain("&apos;=HYPERLINK");
    expect(sheet).not.toContain("<f>");
    expect(sheet).toContain("Asia/Tehran");
    expect(sheet).toContain("۱۵:۳۰");
  });

  it("exports only through the owner-only route and sends a real xlsx document payload", async () => {
    const post = await env.CRASH_BOT_DB.prepare(`
      INSERT INTO posts (user_id, sender_username, content, status)
      VALUES (?, 'excel_sender', 'محتوای آزمایشی', 'pending') RETURNING id
    `).bind(userId).first();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 200 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    const result = await exportManagementWorkbook(env, ownerId, ownerId);
    expect(result.outcome).toBe("sent");
    const request = fetchSpy.mock.calls[0][1];
    expect(request.method).toBe("POST");
    expect(request.body).toBeInstanceOf(FormData);
    const file = request.body.get("document");
    expect(file.name).toMatch(/\.xlsx$/);
    const workbook = new Uint8Array(await file.arrayBuffer());
    const entries = unzipStored(workbook);
    const sheet = entries.get("xl/worksheets/sheet1.xml");
    expect(sheet).toContain("محتوای آزمایشی");
    expect(sheet).toContain("لقب فارسی");
    expect(sheet).toContain("<c r=\"D2\"><v>740000001</v></c>");
    expect(sheet).toContain("@excel_sender");
    expect(post.id).toBeTruthy();
  });

  it("exports all records beyond the former cap in bounded files with unchanged columns", async () => {
    const inserts = Array.from({ length: 1001 }, (_, index) =>
      env.CRASH_BOT_DB.prepare(`
        INSERT INTO posts (user_id, sender_username, content, status)
        VALUES (?, 'excel_sender', ?, 'pending')
      `).bind(userId, `batch-row-${String(index + 1).padStart(3, "0")}`)
    );
    for (let offset = 0; offset < inserts.length; offset += 200) {
      await env.CRASH_BOT_DB.batch(inserts.slice(offset, offset + 200));
    }
    let messageId = 200;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: ++messageId } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );

    const result = await exportManagementWorkbook(env, ownerId, ownerId);

    expect(result).toEqual({
      outcome: "sent", rows: 1001, parts: 2, previousFilesDeleted: true
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const files = fetchSpy.mock.calls.map((call) => call[1].body.get("document"));
    expect(files.map((file) => file.name)).toEqual([
      expect.stringMatching(/-001-of-002\.xlsx$/),
      expect.stringMatching(/-002-of-002\.xlsx$/)
    ]);
    const sheets = await Promise.all(files.map(async (file) =>
      unzipStored(new Uint8Array(await file.arrayBuffer()))
        .get("xl/worksheets/sheet1.xml")
    ));
    expect((sheets[0].match(/<row r=/g) ?? [])).toHaveLength(1001);
    expect((sheets[1].match(/<row r=/g) ?? [])).toHaveLength(2);
    expect(sheets[0]).toContain("batch-row-1001");
    expect(sheets[1]).toContain("batch-row-001");
    const headers = [
      "شناسهٔ رکورد", "نوع", "لقب نویسنده",
      "شناسهٔ تلگرام فرستنده", "نام کاربری فرستنده",
      "شناسهٔ پست اصلی", "وضعیت", "متن",
      "زمان ثبت (Asia/Tehran)", "زمان تصمیم (Asia/Tehran)"
    ];
    let previousPosition = -1;
    for (const header of headers) {
      const position = sheets[0].indexOf(header);
      expect(position).toBeGreaterThan(previousPosition);
      previousPosition = position;
    }
  });

  it("replaces the previous Excel files only after the replacement is fully delivered", async () => {
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO posts (user_id, sender_username, content, status)
      VALUES (?, 'excel_sender', 'replacement test', 'pending')
    `).bind(userId).run();
    let nextMessageId = 300;
    let failDocument = false;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/deleteMessage")) {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (failDocument) {
        return new Response(JSON.stringify({ ok: false, description: "failed" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({
        ok: true, result: { message_id: ++nextMessageId }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    await exportManagementWorkbook(env, ownerId, ownerId);
    const previous = await env.CRASH_BOT_DB.prepare(`
      SELECT message_id FROM owner_export_documents WHERE owner_id = ?
    `).bind(ownerId).all();
    expect(previous.results).toHaveLength(1);

    failDocument = true;
    const failed = await exportManagementWorkbook(env, ownerId, ownerId);
    expect(failed.outcome).toBe("rejected");
    expect(fetchSpy.mock.calls.some((call) =>
      String(call[0]).endsWith("/deleteMessage")
    )).toBe(false);
    const preserved = await env.CRASH_BOT_DB.prepare(`
      SELECT message_id FROM owner_export_documents WHERE owner_id = ?
    `).bind(ownerId).all();
    expect(preserved.results).toEqual(previous.results);

    failDocument = false;
    const replacement = await exportManagementWorkbook(env, ownerId, ownerId);
    expect(replacement.previousFilesDeleted).toBe(true);
    expect(fetchSpy.mock.calls.some((call) =>
      String(call[0]).endsWith("/deleteMessage")
    )).toBe(true);
    const current = await env.CRASH_BOT_DB.prepare(`
      SELECT message_id FROM owner_export_documents WHERE owner_id = ?
    `).bind(ownerId).all();
    expect(current.results).toHaveLength(1);
    expect(current.results[0].message_id).not.toBe(previous.results[0].message_id);
  });

  it("continues exports beyond one Worker invocation without losing rows", async () => {
    const inserts = Array.from({ length: 10001 }, (_, index) =>
      env.CRASH_BOT_DB.prepare(`
        INSERT INTO posts (user_id, sender_username, content, status)
        VALUES (?, 'excel_sender', ?, 'pending')
      `).bind(userId, `worker-batch-row-${index + 1}`)
    );
    for (let offset = 0; offset < inserts.length; offset += 250) {
      await env.CRASH_BOT_DB.batch(inserts.slice(offset, offset + 250));
    }

    let messageId = 500;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({
        ok: true, result: { message_id: ++messageId }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    const first = await exportManagementWorkbook(env, ownerId, ownerId);
    expect(first).toMatchObject({
      outcome: "pending", rows: 10000, parts: 10, totalRows: 10001
    });

    const continuationCall = fetchSpy.mock.calls.map(([url, init]) => {
      if (!String(url).endsWith("/sendMessage") || typeof init.body !== "string") {
        return null;
      }
      return JSON.parse(init.body);
    }).find((body) => body?.reply_markup?.inline_keyboard?.flat().some((button) =>
      String(button.callback_data).startsWith("xlsx:continue:")
    ));
    const continuation = continuationCall.reply_markup.inline_keyboard.flat()
      .find((button) => String(button.callback_data).startsWith("xlsx:continue:"))
      .callback_data;
    const completed = await handleExportWorkbookCallback(env, {
      id: "xlsx-continuation",
      data: continuation,
      from: { id: ownerId },
      message: { chat: { id: ownerId, type: "private" }, message_id: 999 }
    });
    expect(completed).toBe(true);
    expect(fetchSpy.mock.calls.filter(([url]) =>
      String(url).endsWith("/sendDocument")
    )).toHaveLength(11);
    const documents = await env.CRASH_BOT_DB.prepare(`
      SELECT COUNT(*) AS count FROM owner_export_documents
      WHERE owner_id = ? AND status = 'current'
    `).bind(ownerId).first();
    expect(documents.count).toBe(11);
    const remaining = await env.CRASH_BOT_DB.prepare(`
      SELECT COUNT(*) AS count FROM owner_export_jobs
      WHERE owner_id = ? AND status != 'complete'
    `).bind(ownerId).first();
    expect(remaining.count).toBe(0);
  });

  it("does not start a second Excel export for a duplicate Telegram update", async () => {
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO posts (user_id, sender_username, content, status)
      VALUES (?, 'excel_sender', 'duplicate update test', 'pending')
    `).bind(userId).run();
    let messageId = 700;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({
        ok: true, result: { message_id: ++messageId }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    const first = await exportManagementWorkbook(env, ownerId, ownerId, 456);
    const duplicate = await exportManagementWorkbook(env, ownerId, ownerId, 456);
    expect(first.outcome).toBe("sent");
    expect(duplicate).toMatchObject({ outcome: "sent", duplicate: true });
    expect(fetchSpy.mock.calls.filter(([url]) =>
      String(url).endsWith("/sendDocument")
    )).toHaveLength(1);
  });

  it("does not send a spreadsheet to an admin or a non-owner", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await exportManagementWorkbook(env, 740000002, 740000002);
    expect(result.outcome).toBe("rejected");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(telegramApi.sendMessageTelegramDetailed).toHaveBeenCalled();
  });
});
