import {
  sendDocumentBytesDetailed,
  sendMessageTelegramDetailed
} from "../telegram/api.js";

const EXPORT_LIMIT = 500;
const encoder = new TextEncoder();
const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function zipStored(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = encoder.encode(name);
    const data = typeof content === "string" ? encoder.encode(content) : content;
    const crc = crc32(data);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const local = new DataView(localHeader.buffer);
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, 33, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);
    localParts.push(localHeader, data);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const central = new DataView(centralHeader.buffer);
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, 0, true);
    central.setUint16(14, 33, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint16(30, 0, true);
    central.setUint16(32, 0, true);
    central.setUint16(34, 0, true);
    central.setUint16(36, 0, true);
    central.setUint32(38, 0, true);
    central.setUint32(42, localOffset, true);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);
    localOffset += localHeader.length + data.length;
  }

  const centralDirectory = concatBytes(centralParts);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, centralParts.length, true);
  endView.setUint16(10, centralParts.length, true);
  endView.setUint32(12, centralDirectory.length, true);
  endView.setUint32(16, localOffset, true);
  endView.setUint16(20, 0, true);
  return concatBytes([...localParts, centralDirectory, end]);
}

function sanitizeSpreadsheetText(value) {
  let text = String(value ?? "").replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g,
    ""
  );
  if (/^[\t\r\n ]*[=+\-@]/.test(text)) text = `'${text}`;
  return text.slice(0, 32767);
}

function xmlEscape(value) {
  return sanitizeSpreadsheetText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnName(number) {
  let result = "";
  while (number > 0) {
    const remainder = (number - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    number = Math.floor((number - 1) / 26);
  }
  return result;
}

function cellXml(reference, value) {
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

function dateTehran(value) {
  if (!value) return "";
  const input = String(value);
  const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(input)
    ? input
    : `${input.replace(" ", "T")}Z`);
  if (!Number.isFinite(date.getTime())) return input;
  return new Intl.DateTimeFormat("fa-IR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Tehran"
  }).format(date);
}

function rowValues(post) {
  const status = {
    pending: "در انتظار بررسی",
    approved: "تأییدشده",
    rejected: "ردشده",
    published: "منتشرشده"
  }[post.status] ?? post.status;
  return [
    post.id,
    post.reply_to_post_id ? "پاسخ" : "پست",
    post.nickname || "بدون لقب",
    post.reply_to_post_id ?? "",
    status,
    post.content,
    dateTehran(post.created_at),
    dateTehran(post.reviewed_at)
  ];
}

export function buildManagementWorkbook(posts) {
  const headers = [
    "شناسهٔ رکورد",
    "نوع",
    "لقب نویسنده",
    "شناسهٔ پست اصلی",
    "وضعیت",
    "متن",
    "زمان ثبت (Asia/Tehran)",
    "زمان تصمیم (Asia/Tehran)"
  ];
  const rows = [headers, ...posts.map(rowValues)];
  const sheetRows = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) =>
      cellXml(`${columnName(columnIndex + 1)}${rowIndex + 1}`, value)
    ).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData><autoFilter ref="A1:H${rows.length}"/></worksheet>`;
  const entries = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="آرشیو پست‌ها" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": worksheet
  };
  return zipStored(entries);
}

export async function exportManagementWorkbook(env, ownerId, chatId) {
  if (
    String(ownerId) !== String(env.OWNER_TELEGRAM_ID) ||
    String(chatId) !== String(ownerId)
  ) {
    await sendMessageTelegramDetailed(env, chatId, "خروجی Excel فقط برای مالک اصلی در دسترس است.");
    return { outcome: "rejected" };
  }
  const result = await env.CRASH_BOT_DB.prepare(`
    SELECT p.id, p.reply_to_post_id, p.content, p.status, p.created_at,
           p.reviewed_at, pr.nickname,
           CASE WHEN length(p.content) > 2000
             THEN substr(p.content, 1, 2000) || ' [متن ادامه دارد]'
             ELSE p.content END AS export_content
    FROM posts p
    LEFT JOIN profiles pr ON pr.user_id = p.user_id
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT ?
  `).bind(EXPORT_LIMIT + 1).all();
  const records = result.results ?? [];
  const truncated = records.length > EXPORT_LIMIT;
  const workbook = buildManagementWorkbook(records.slice(0, EXPORT_LIMIT).map((record) => ({
    ...record,
    content: record.export_content
  })));
  const filename = `crash-bot-post-archive-${new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date())}.xlsx`;
  const delivery = await sendDocumentBytesDetailed(env, chatId, filename, workbook);
  if (delivery.outcome !== "sent") {
    await sendMessageTelegramDetailed(
      env,
      chatId,
      delivery.outcome === "unknown"
        ? "⚠️ وضعیت ارسال فایل Excel نامشخص است؛ ارسال خودکار دوباره انجام نمی‌شود."
        : "❌ فایل Excel ارسال نشد."
    );
    return { ...delivery, rows: Math.min(records.length, EXPORT_LIMIT), truncated };
  }
  await sendMessageTelegramDetailed(
    env,
    chatId,
    `خروجی شامل ${Math.min(records.length, EXPORT_LIMIT)} رکورد پست و پاسخ است.${truncated ? "\nبه‌دلیل سقف ایمنی، رکوردهای قدیمی‌تر در فایل نیستند." : ""}\nمتن هر رکورد نیز برای حفظ حجم فایل حداکثر ۲۰۰۰ نویسه است.`
  );
  return { ...delivery, rows: Math.min(records.length, EXPORT_LIMIT), truncated };
}
