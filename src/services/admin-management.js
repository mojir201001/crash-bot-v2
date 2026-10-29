import {
  answerCallbackQuery,
  editInlineTelegram,
  sendInlineTelegram,
  sendTelegram
} from "../telegram/api.js";
import { normalizeDigits } from "./profile.js";

const PENDING_ADD_KEY = "admin_management_pending_add";

function ownerOnly(env, actorId, chatId) {
  return actorId &&
    String(actorId) === String(env.OWNER_TELEGRAM_ID) &&
    String(chatId) === String(env.OWNER_TELEGRAM_ID);
}

async function renderAdminList(env, chatId) {
  const result = await env.CRASH_BOT_DB.prepare(`
    SELECT r.user_id, r.granted_at, r.granted_by, u.username, u.first_name
    FROM admin_roles r
    LEFT JOIN users u ON u.telegram_id = r.user_id
    ORDER BY r.granted_at, r.user_id
    LIMIT 100
  `).all();
  const admins = result.results ?? [];
  const rows = admins.map((admin) => [{
    text: `🗑 ${admin.first_name ?? "مدیر"}${admin.username ? ` @${admin.username}` : ""} · ${admin.user_id}`,
    callback_data: `admin:remove:${admin.user_id}`
  }]);
  rows.push([{ text: "➕ افزودن مدیر", callback_data: "admin:add" }]);
  await sendInlineTelegram(env, chatId, [
    "👥 مدیریت مدیران",
    `مالک اصلی: ${env.OWNER_TELEGRAM_ID}`,
    `مدیران ثبت‌شده: ${admins.length}`,
    ...admins.map((admin) =>
      `\n${admin.first_name ?? "بدون نام"}${admin.username ? ` (@${admin.username})` : ""} · شناسه ${admin.user_id}`
    )
  ].join("\n"), rows);
}

export async function renderAdminManagement(env, actorId, chatId) {
  if (!ownerOnly(env, actorId, chatId)) {
    await sendTelegram(env, chatId, "مدیریت مدیران فقط در پنل خصوصی مالک اصلی در دسترس است.");
    return;
  }
  await renderAdminList(env, chatId);
}

export async function handleAdminManagementCallback(env, query) {
  const data = query?.data ?? "";
  if (!data.startsWith("admin:")) return false;
  const actorId = query.from?.id;
  const chatId = query.message?.chat?.id;
  if (query.message?.chat?.type !== "private" ||
      !ownerOnly(env, actorId, chatId)) {
    await answerCallbackQuery(env, query.id, "این عملیات فقط برای مالک اصلی در گفت‌وگوی خصوصی است.");
    return true;
  }

  if (data === "admin:list") {
    await answerCallbackQuery(env, query.id);
    await renderAdminList(env, chatId);
    return true;
  }
  if (data === "admin:add") {
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO bot_settings (key, value, updated_at)
      VALUES (?, '1', CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = CURRENT_TIMESTAMP
    `).bind(PENDING_ADD_KEY).run();
    await editInlineTelegram(env, chatId, query.message.message_id,
      "شناسهٔ عددی کاربری را که قبلاً ربات را شروع کرده بفرست. این عملیات فقط به مالک دسترسی مدیر می‌دهد.",
      [[{ text: "↩️ فهرست مدیران", callback_data: "admin:list" }]]);
    await answerCallbackQuery(env, query.id);
    return true;
  }

  const remove = /^admin:remove:(\d{5,16})$/.exec(data);
  if (!remove || !Number.isSafeInteger(Number(remove?.[1]))) {
    await answerCallbackQuery(env, query.id, "درخواست مدیریت مدیر معتبر نیست.");
    return true;
  }
  const targetId = Number(remove[1]);
  if (String(targetId) === String(env.OWNER_TELEGRAM_ID)) {
    await answerCallbackQuery(env, query.id, "مالک اصلی از این فهرست حذف نمی‌شود.");
    return true;
  }

  const results = await env.CRASH_BOT_DB.batch([
    env.CRASH_BOT_DB.prepare(`
      DELETE FROM admin_roles WHERE user_id = ? RETURNING user_id
    `).bind(targetId),
    env.CRASH_BOT_DB.prepare(`
      INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details)
      SELECT ?, 'admin_revoked', 'admin_role', ?, 'owner revoked admin access'
      WHERE changes() = 1
    `).bind(actorId, targetId)
  ]);
  const removed = results[0]?.results?.length > 0;
  await answerCallbackQuery(env, query.id,
    removed ? "دسترسی مدیر لغو شد." : "این مدیر قبلاً حذف شده یا وجود ندارد.");
  await renderAdminList(env, chatId);
  return true;
}

export async function handleAdminManagementMessage(env, message, actorId) {
  if (!ownerOnly(env, actorId, message?.chat?.id)) return false;
  const pending = await env.CRASH_BOT_DB.prepare(
    "SELECT value FROM bot_settings WHERE key = ?"
  ).bind(PENDING_ADD_KEY).first();
  if (pending?.value !== "1") return false;

  const text = String(message.text ?? "").trim();
  if (["/start", "/menu", "🏠 منوی اصلی", "⬅️ بازگشت"].includes(text)) {
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM bot_settings WHERE key = ?"
    ).bind(PENDING_ADD_KEY).run();
    return false;
  }
  const normalized = normalizeDigits(text);
  if (!/^\d{5,16}$/.test(normalized) ||
      !Number.isSafeInteger(Number(normalized))) {
    await sendTelegram(env, message.chat.id, "شناسه باید یک عدد صحیح معتبر باشد؛ عملیات افزودن لغو نشده است.");
    return true;
  }
  const targetId = Number(normalized);
  if (String(targetId) === String(env.OWNER_TELEGRAM_ID)) {
    await sendTelegram(env, message.chat.id, "مالک اصلی از قبل دسترسی کامل دارد.");
    return true;
  }

  const results = await env.CRASH_BOT_DB.batch([
    env.CRASH_BOT_DB.prepare(`
      INSERT INTO admin_roles (user_id, granted_by)
      SELECT telegram_id, ? FROM users WHERE telegram_id = ?
      ON CONFLICT(user_id) DO NOTHING
    `).bind(actorId, targetId),
    env.CRASH_BOT_DB.prepare(`
      INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details)
      SELECT ?, 'admin_granted', 'admin_role', ?, 'owner granted admin access'
      WHERE changes() = 1
    `).bind(actorId, targetId),
    env.CRASH_BOT_DB.prepare(
      "DELETE FROM bot_settings WHERE key = ?"
    ).bind(PENDING_ADD_KEY)
  ]);
  const inserted = Number(results[0]?.meta?.changes ?? 0) > 0;
  const target = await env.CRASH_BOT_DB.prepare(
    "SELECT telegram_id FROM users WHERE telegram_id = ?"
  ).bind(targetId).first();
  await sendTelegram(env, message.chat.id, !target
    ? "این کاربر هنوز ربات را شروع نکرده است؛ ابتدا باید به ربات پیام بدهد."
    : inserted
      ? "دسترسی مدیر اعطا شد."
      : "این کاربر از قبل مدیر است.");
  await renderAdminList(env, message.chat.id);
  return true;
}
