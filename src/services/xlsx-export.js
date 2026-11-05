import {
  answerCallbackQuery,
  deleteTelegramMessage,
  sendDocumentBytesDetailed,
  sendInlineTelegramDetailed,
  sendMessageTelegramDetailed
} from "../telegram/api.js";

const EXPORT_CHUNK_SIZE = 1000;
const EXPORT_PARTS_PER_RUN = 10;
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

function numericCellXml(reference, value) {
  if (!Number.isSafeInteger(value)) return cellXml(reference, value);
  return `<c r="${reference}"><v>${value}</v></c>`;
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
    post.user_id,
    post.sender_username ? `@${post.sender_username}` : "",
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
    "شناسهٔ تلگرام فرستنده",
    "نام کاربری فرستنده",
    "شناسهٔ پست اصلی",
    "وضعیت",
    "متن",
    "زمان ثبت (Asia/Tehran)",
    "زمان تصمیم (Asia/Tehran)"
  ];
  const rows = [headers, ...posts.map(rowValues)];
  const sheetRows = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      const reference = `${columnName(columnIndex + 1)}${rowIndex + 1}`;
      return rowIndex > 0 && columnIndex === 3
        ? numericCellXml(reference, value)
        : cellXml(reference, value);
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData><autoFilter ref="A1:J${rows.length}"/></worksheet>`;
  const entries = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="آرشیو پست‌ها" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": worksheet
  };
  return zipStored(entries);
}

export async function exportManagementWorkbook(
  env, ownerId, chatId, sourceMessageId = null
) {
  if (
    String(ownerId) !== String(env.OWNER_TELEGRAM_ID) ||
    String(chatId) !== String(ownerId)
  ) {
    await sendMessageTelegramDetailed(env, chatId, "خروجی Excel فقط برای مالک اصلی در دسترس است.");
    return { outcome: "rejected" };
  }
  if (Number.isSafeInteger(sourceMessageId) && sourceMessageId > 0) {
    const previousRequest = await env.CRASH_BOT_DB.prepare(`
      SELECT token, status FROM owner_export_jobs
      WHERE owner_id = ? AND source_message_id = ?
    `).bind(ownerId, sourceMessageId).first();
    if (previousRequest) {
      await sendMessageTelegramDetailed(
        env, chatId,
        previousRequest.status === "complete"
          ? "این درخواست Excel قبلاً کامل شده است؛ برای جلوگیری از فایل تکراری، دوباره اجرا نشد."
          : previousRequest.status === "unknown"
            ? "وضعیت درخواست قبلی نامشخص است؛ برای جلوگیری از فایل تکراری، دوباره اجرا نشد."
            : "این درخواست Excel هنوز در حال انجام است؛ از دکمهٔ ادامهٔ همان خروجی استفاده کن."
      );
      return {
        outcome: previousRequest.status === "complete"
          ? "sent" : previousRequest.status,
        duplicate: true,
        token: previousRequest.token
      };
    }
  }
  await env.CRASH_BOT_DB.prepare(`
    UPDATE owner_export_jobs SET status = 'unknown',
      updated_at = CURRENT_TIMESTAMP
    WHERE owner_id = ? AND status = 'sending'
      AND updated_at < datetime('now', '-15 minutes')
  `).bind(ownerId).run();
  const activeJob = await env.CRASH_BOT_DB.prepare(`
    SELECT token FROM owner_export_jobs
    WHERE owner_id = ? AND status IN ('pending', 'sending', 'cleaning')
    LIMIT 1
  `).bind(ownerId).first();
  if (activeJob) {
    await sendMessageTelegramDetailed(
      env, chatId,
      "خروجی Excel قبلی هنوز در حال انجام است؛ ابتدا دکمهٔ ادامهٔ همان خروجی را بزن."
    );
    return { outcome: "pending", token: activeJob.token };
  }

  const total = await env.CRASH_BOT_DB.prepare(`
    SELECT COUNT(*) AS count, MAX(id) AS max_id FROM posts
  `).first();
  const totalRows = Number(total?.count ?? 0);
  const maxId = Number(total?.max_id ?? 0);
  await env.CRASH_BOT_DB.prepare(`
    UPDATE owner_export_documents SET delete_attempted_at = NULL
    WHERE owner_id = ?
  `).bind(ownerId).run();
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
  const partCount = Math.max(1, Math.ceil(totalRows / EXPORT_CHUNK_SIZE));
  const token = newExportToken();
  try {
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO owner_export_jobs (
        token, owner_id, chat_id, source_message_id, max_id, total_rows,
        part_count, export_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      token, ownerId, chatId, sourceMessageId, maxId, totalRows, partCount, date
    ).run();
  } catch (error) {
    if (!String(error?.message ?? "").includes("UNIQUE constraint failed")) throw error;
    await sendMessageTelegramDetailed(
      env, chatId, "خروجی Excel دیگری هم‌زمان آغاز شده است؛ همان خروجی را ادامه بده."
    );
    return { outcome: "pending" };
  }
  return processExportJob(env, ownerId, chatId, token);
}

function newExportToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sendExportContinuation(env, chatId, token, job, phase) {
  const text = phase === "cleaning"
    ? `فایل‌های Excel جدید آماده‌اند. پاک‌سازی فایل‌های قبلی ادامه دارد (${job.exported_rows}/${job.total_rows} رکورد صادر شد).`
    : `خروجی Excel در حال ساخت است (${job.exported_rows}/${job.total_rows} رکورد، بخش بعدی ${job.next_part} از ${job.part_count}).`;
  const result = await sendInlineTelegramDetailed(env, chatId, text, [[{
    text: phase === "cleaning" ? "ادامهٔ پاک‌سازی فایل‌های قبلی" : "ادامهٔ خروجی Excel",
    callback_data: `xlsx:continue:${token}`
  }]]);
  return result.outcome;
}

async function cleanupPreviousExportDocuments(env, ownerId, chatId, token, job) {
  const documents = await env.CRASH_BOT_DB.prepare(`
    SELECT chat_id, message_id FROM owner_export_documents
    WHERE owner_id = ? AND (export_token IS NULL OR export_token != ?)
      AND delete_attempted_at IS NULL
    ORDER BY message_id
    LIMIT ?
  `).bind(ownerId, token, EXPORT_PARTS_PER_RUN + 1).all();
  const batch = documents.results ?? [];
  for (const document of batch.slice(0, EXPORT_PARTS_PER_RUN)) {
    if (await deleteTelegramMessage(env, document.chat_id, document.message_id)) {
      await env.CRASH_BOT_DB.prepare(`
        DELETE FROM owner_export_documents
        WHERE owner_id = ? AND message_id = ?
      `).bind(ownerId, document.message_id).run();
    } else {
      await env.CRASH_BOT_DB.prepare(`
        UPDATE owner_export_documents SET delete_attempted_at = CURRENT_TIMESTAMP
        WHERE owner_id = ? AND message_id = ?
      `).bind(ownerId, document.message_id).run();
    }
  }
  if (batch.length > EXPORT_PARTS_PER_RUN) {
    await env.CRASH_BOT_DB.prepare(`
      UPDATE owner_export_jobs SET status = 'cleaning',
        updated_at = CURRENT_TIMESTAMP WHERE token = ? AND status = 'sending'
    `).bind(token).run();
    const outcome = await sendExportContinuation(
      env, chatId, token, job, "cleaning"
    );
    if (outcome !== "sent") {
      await env.CRASH_BOT_DB.prepare(`
        UPDATE owner_export_jobs SET status = 'unknown',
          updated_at = CURRENT_TIMESTAMP WHERE token = ? AND status = 'cleaning'
      `).bind(token).run();
      await sendMessageTelegramDetailed(
        env, chatId, "⚠️ پاک‌سازی فایل‌های قبلی متوقف شد؛ خروجی جدید ساخته شده اما ارجاع‌های قبلی حفظ شده‌اند."
      );
    }
    return { outcome: outcome === "sent" ? "pending" : outcome };
  }

  const remaining = await env.CRASH_BOT_DB.prepare(`
    SELECT COUNT(*) AS count FROM owner_export_documents
    WHERE owner_id = ? AND (export_token IS NULL OR export_token != ?)
  `).bind(ownerId, token).first();
  const previousFilesDeleted = Number(remaining?.count ?? 0) === 0;
  await env.CRASH_BOT_DB.batch([
    env.CRASH_BOT_DB.prepare(`
      UPDATE owner_export_documents
      SET export_token = NULL, status = 'current', delete_attempted_at = NULL
      WHERE owner_id = ? AND export_token = ?
    `).bind(ownerId, token),
    env.CRASH_BOT_DB.prepare(`
      UPDATE owner_export_jobs SET status = 'complete',
        updated_at = CURRENT_TIMESTAMP
      WHERE token = ? AND status IN ('sending', 'cleaning')
    `).bind(token)
  ]);
  await sendMessageTelegramDetailed(
    env, chatId,
    `خروجی شامل تمام ${job.exported_rows} رکورد پست و پاسخ در ${job.part_count} فایل Excel است.\nهر فایل حداکثر ${EXPORT_CHUNK_SIZE} رکورد دارد و متن هر رکورد طبق قالب فعلی حداکثر ۲۰۰۰ نویسه است.${previousFilesDeleted ? "" : "\n⚠️ حذف برخی فایل‌های قبلی از تلگرام ناموفق بود؛ خروجی جدید آماده است و ارجاع فایل‌های قبلی برای بررسی باقی مانده."}`
  );
  return {
    outcome: "sent",
    rows: Number(job.exported_rows),
    parts: Number(job.part_count),
    previousFilesDeleted
  };
}

async function discardStagedExportDocuments(env, ownerId, token) {
  const documents = await env.CRASH_BOT_DB.prepare(`
    SELECT chat_id, message_id FROM owner_export_documents
    WHERE owner_id = ? AND export_token = ?
  `).bind(ownerId, token).all();
  let cleanupFailed = false;
  for (const document of documents.results ?? []) {
    if (await deleteTelegramMessage(env, document.chat_id, document.message_id)) {
      await env.CRASH_BOT_DB.prepare(`
        DELETE FROM owner_export_documents
        WHERE owner_id = ? AND message_id = ?
      `).bind(ownerId, document.message_id).run();
    } else {
      cleanupFailed = true;
      await env.CRASH_BOT_DB.prepare(`
        UPDATE owner_export_documents SET delete_attempted_at = CURRENT_TIMESTAMP
        WHERE owner_id = ? AND message_id = ?
      `).bind(ownerId, document.message_id).run();
    }
  }
  return cleanupFailed;
}

async function processExportJob(env, ownerId, chatId, token) {
  await env.CRASH_BOT_DB.prepare(`
    UPDATE owner_export_jobs SET status = 'unknown',
      updated_at = CURRENT_TIMESTAMP
    WHERE token = ? AND owner_id = ? AND status = 'sending'
      AND updated_at < datetime('now', '-15 minutes')
  `).bind(token, ownerId).run();
  const current = await env.CRASH_BOT_DB.prepare(`
    SELECT * FROM owner_export_jobs WHERE token = ? AND owner_id = ?
      AND chat_id = ? AND status IN ('pending', 'cleaning')
  `).bind(token, ownerId, chatId).first();
  if (!current) return { outcome: "unknown" };
  const wasCleaning = current.status === "cleaning";
  const claimed = await env.CRASH_BOT_DB.prepare(`
    UPDATE owner_export_jobs SET status = 'sending',
      updated_at = CURRENT_TIMESTAMP
    WHERE token = ? AND owner_id = ? AND status = ?
    RETURNING *
  `).bind(token, ownerId, current.status).first();
  if (!claimed) return { outcome: "pending" };

  if (wasCleaning) {
    return cleanupPreviousExportDocuments(
      env, ownerId, chatId, token, claimed
    );
  }

  const startPart = Number(claimed.next_part);
  const endPart = Math.min(
    Number(claimed.part_count),
    startPart + EXPORT_PARTS_PER_RUN - 1
  );
  let cursor = claimed.cursor_created_at
    ? { createdAt: claimed.cursor_created_at, id: Number(claimed.cursor_id) }
    : null;
  let exportedRows = Number(claimed.exported_rows);
  for (let part = startPart; part <= endPart; part += 1) {
    let records = [];
    if (Number(claimed.total_rows) > 0) {
      const statement = cursor
        ? env.CRASH_BOT_DB.prepare(`
            SELECT p.id, p.user_id, p.sender_username, p.reply_to_post_id,
                   p.content, p.status, p.created_at, p.reviewed_at, pr.nickname,
                   CASE WHEN length(p.content) > 2000
                     THEN substr(p.content, 1, 2000) || ' [متن ادامه دارد]'
                     ELSE p.content END AS export_content
            FROM posts p
            LEFT JOIN profiles pr ON pr.user_id = p.user_id
            WHERE p.id <= ?
              AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))
            ORDER BY p.created_at DESC, p.id DESC
            LIMIT ?
          `).bind(
          claimed.max_id, cursor.createdAt, cursor.createdAt,
          cursor.id, EXPORT_CHUNK_SIZE
        )
        : env.CRASH_BOT_DB.prepare(`
            SELECT p.id, p.user_id, p.sender_username, p.reply_to_post_id,
                   p.content, p.status, p.created_at, p.reviewed_at, pr.nickname,
                   CASE WHEN length(p.content) > 2000
                     THEN substr(p.content, 1, 2000) || ' [متن ادامه دارد]'
                     ELSE p.content END AS export_content
            FROM posts p
            LEFT JOIN profiles pr ON pr.user_id = p.user_id
            WHERE p.id <= ?
            ORDER BY p.created_at DESC, p.id DESC
            LIMIT ?
          `).bind(claimed.max_id, EXPORT_CHUNK_SIZE);
      records = (await statement.all()).results ?? [];
      if (!records.length) {
        const cleanupFailed = await discardStagedExportDocuments(
          env, ownerId, token
        );
        await env.CRASH_BOT_DB.prepare(`
          UPDATE owner_export_jobs SET status = 'unknown',
            updated_at = CURRENT_TIMESTAMP WHERE token = ? AND status = 'sending'
        `).bind(token).run();
        await sendMessageTelegramDetailed(
          env, chatId,
          `⚠️ هنگام خواندن رکوردهای Excel تغییری رخ داد؛ خروجی قبلی حفظ شد و این اجرا متوقف شد.${cleanupFailed ? " پاک‌سازی فایل‌های ناقص جدید کامل نشد." : ""}`
        );
        return { outcome: "unknown", rows: exportedRows, parts: part - startPart };
      }
    }

    const lastRecord = records[records.length - 1];
    if (lastRecord) cursor = { createdAt: lastRecord.created_at, id: lastRecord.id };
    const workbook = buildManagementWorkbook(records.map((record) => ({
      ...record,
      content: record.export_content
    })));
    const partSuffix = Number(claimed.part_count) > 1
      ? `-${String(part).padStart(3, "0")}-of-${String(claimed.part_count).padStart(3, "0")}`
      : "";
    const delivery = await sendDocumentBytesDetailed(
      env, chatId,
      `crash-bot-post-archive-${claimed.export_date}${partSuffix}.xlsx`,
      workbook
    );
    if (delivery.outcome !== "sent" ||
        !Number.isSafeInteger(delivery.messageId)) {
      const cleanupFailed = await discardStagedExportDocuments(
        env, ownerId, token
      );
      await env.CRASH_BOT_DB.prepare(`
        UPDATE owner_export_jobs SET status = 'unknown',
          updated_at = CURRENT_TIMESTAMP WHERE token = ? AND status = 'sending'
      `).bind(token).run();
      await sendMessageTelegramDetailed(
        env, chatId,
        delivery.outcome === "unknown"
          ? `⚠️ وضعیت ارسال فایل Excel بخش ${part} نامشخص است؛ فایل‌های قبلی حفظ شدند و ارسال خودکار دوباره انجام نمی‌شود.`
          : `❌ ارسال فایل Excel بخش ${part} انجام نشد؛ فایل‌های قبلی حفظ شدند.${cleanupFailed ? " پاک‌سازی فایل‌های ناقص جدید کامل نشد." : ""}`
      );
      return {
        ...delivery,
        rows: exportedRows,
        remainingRows: Number(claimed.total_rows) - exportedRows,
        parts: part - startPart
      };
    }

    exportedRows += records.length;
    const nextPart = part + 1;
    try {
      await env.CRASH_BOT_DB.batch([
        env.CRASH_BOT_DB.prepare(`
          INSERT INTO owner_export_documents
            (owner_id, chat_id, message_id, export_token, status)
          VALUES (?, ?, ?, ?, 'staging')
        `).bind(ownerId, chatId, delivery.messageId, token),
        env.CRASH_BOT_DB.prepare(`
          UPDATE owner_export_jobs
          SET exported_rows = ?, cursor_created_at = ?, cursor_id = ?,
            next_part = ?, updated_at = CURRENT_TIMESTAMP
          WHERE token = ? AND status = 'sending'
        `).bind(
          exportedRows, cursor?.createdAt ?? null, cursor?.id ?? null,
          nextPart, token
        )
      ]);
    } catch (error) {
      if (!await deleteTelegramMessage(env, chatId, delivery.messageId)) {
        console.error("Could not remove an Excel file after saving its reference failed.");
      }
      await env.CRASH_BOT_DB.prepare(`
        UPDATE owner_export_jobs SET status = 'unknown',
          updated_at = CURRENT_TIMESTAMP WHERE token = ? AND status = 'sending'
      `).bind(token).run();
      throw error;
    }
  }

  const updated = await env.CRASH_BOT_DB.prepare(`
    SELECT * FROM owner_export_jobs WHERE token = ? AND status = 'sending'
  `).bind(token).first();
  if (!updated) return { outcome: "unknown", rows: exportedRows };
  if (Number(updated.next_part) <= Number(updated.part_count)) {
    await env.CRASH_BOT_DB.prepare(`
      UPDATE owner_export_jobs SET status = 'pending',
        updated_at = CURRENT_TIMESTAMP WHERE token = ? AND status = 'sending'
    `).bind(token).run();
    const outcome = await sendExportContinuation(
      env, chatId, token, updated, "sending"
    );
    if (outcome !== "sent") {
      await env.CRASH_BOT_DB.prepare(`
        UPDATE owner_export_jobs SET status = 'unknown',
          updated_at = CURRENT_TIMESTAMP WHERE token = ? AND status = 'pending'
      `).bind(token).run();
      await sendMessageTelegramDetailed(
        env, chatId, "⚠️ ارسال دکمهٔ ادامهٔ Excel ناموفق بود؛ فایل‌های قبلی حذف نشدند."
      );
    }
    return {
      outcome: outcome === "sent" ? "pending" : outcome,
      rows: Number(updated.exported_rows),
      parts: Number(updated.next_part) - 1,
      totalRows: Number(updated.total_rows)
    };
  }
  if (Number(updated.exported_rows) !== Number(updated.total_rows)) {
    const cleanupFailed = await discardStagedExportDocuments(
      env, ownerId, token
    );
    await env.CRASH_BOT_DB.prepare(`
      UPDATE owner_export_jobs SET status = 'unknown',
        updated_at = CURRENT_TIMESTAMP WHERE token = ? AND status = 'sending'
    `).bind(token).run();
    await sendMessageTelegramDetailed(
      env, chatId,
      `⚠️ تعداد رکوردهای خوانده‌شده با تصویر اولیهٔ خروجی برابر نیست؛ فایل‌های قبلی حفظ شدند و خروجی جدید تأیید نشد.${cleanupFailed ? " پاک‌سازی فایل‌های ناقص نیز کامل نشد." : ""}`
    );
    return {
      outcome: "unknown",
      rows: Number(updated.exported_rows),
      totalRows: Number(updated.total_rows)
    };
  }

  await env.CRASH_BOT_DB.prepare(`
    UPDATE owner_export_jobs SET status = 'cleaning',
      updated_at = CURRENT_TIMESTAMP WHERE token = ? AND status = 'sending'
  `).bind(token).run();
  return cleanupPreviousExportDocuments(
    env, ownerId, chatId, token, { ...updated, status: "sending" }
  );
}

export async function handleExportWorkbookCallback(env, query) {
  const match = /^xlsx:continue:([a-f0-9]{32})$/.exec(
    String(query?.data ?? "")
  );
  if (!match) return false;
  const actorId = query?.from?.id;
  const chatId = query?.message?.chat?.id;
  if (String(actorId) !== String(env.OWNER_TELEGRAM_ID) ||
      String(chatId) !== String(actorId) ||
      query?.message?.chat?.type !== "private") {
    await answerCallbackQuery(env, query.id, "ادامهٔ خروجی فقط برای مالک در دسترس است.");
    return true;
  }
  const result = await processExportJob(env, actorId, chatId, match[1]);
  if (result.outcome === "pending") {
    await answerCallbackQuery(env, query.id, "بخش بعدی آماده است.");
  } else if (result.outcome === "sent") {
    await answerCallbackQuery(env, query.id, "خروجی Excel کامل شد.");
  } else {
    await answerCallbackQuery(env, query.id,
      "وضعیت خروجی نامشخص یا ناموفق است؛ برای جلوگیری از تکرار خودکار متوقف شد.");
  }
  return true;
}
