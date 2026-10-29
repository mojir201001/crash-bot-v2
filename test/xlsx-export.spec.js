import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as telegramApi from "../src/telegram/api.js";
import {
  buildManagementWorkbook,
  exportManagementWorkbook
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
    expect(sheet).toContain("&apos;=HYPERLINK");
    expect(sheet).not.toContain("<f>");
    expect(sheet).toContain("Asia/Tehran");
  });

  it("exports only through the owner-only route and sends a real xlsx document payload", async () => {
    const post = await env.CRASH_BOT_DB.prepare(`
      INSERT INTO posts (user_id, content, status)
      VALUES (?, 'محتوای آزمایشی', 'pending') RETURNING id
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
    expect(sheet).not.toContain(String(userId));
    expect(post.id).toBeTruthy();
  });

  it("does not send a spreadsheet to an admin or a non-owner", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await exportManagementWorkbook(env, 740000002, 740000002);
    expect(result.outcome).toBe("rejected");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(telegramApi.sendMessageTelegramDetailed).toHaveBeenCalled();
  });
});
