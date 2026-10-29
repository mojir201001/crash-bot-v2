import {
  answerCallbackQuery,
  sendTrackedSectionInlineTelegram,
  sendTrackedSectionNoticeTelegram
} from "../telegram/api.js";
import { getRequiredChannels } from "./forced-membership.js";
import { showForcedMembershipPanel } from "./forced-membership-panel.js";

const EDITABLE_SETTINGS = {
  crash_channel_id: {
    label: "شناسهٔ کانال انتشار",
    envKey: "CRASH_CHANNEL_ID",
    validate: (value) => /^@[A-Za-z0-9_]{5,32}$/.test(value) || /^-100\d+$/.test(value)
  },
  crash_channel_url: {
    label: "پیوند کانال",
    envKey: "CRASH_CHANNEL_URL",
    validate: (value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" &&
          ["t.me", "www.t.me"].includes(url.hostname) &&
          /^\/(?:[A-Za-z0-9_]{5,32}|\+[A-Za-z0-9_-]+)\/?$/.test(url.pathname);
      } catch {
        return false;
      }
    }
  },
  telegram_bot_username: {
    label: "نام کاربری ربات",
    envKey: "TELEGRAM_BOT_USERNAME",
    validate: (value) => /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value)
  }
};
const MAX_SETTING_LENGTH = 200;

function pendingKey(ownerId) {
  return `settings_edit_pending:${String(ownerId)}`;
}

async function readSetting(env, key) {
  const row = await env.CRASH_BOT_DB.prepare(
    "SELECT value FROM bot_settings WHERE key = ?"
  ).bind(key).first();
  return row?.value ?? null;
}

async function writeSetting(env, key, value) {
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO bot_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).bind(key, value).run();
}

async function savePending(env, ownerId, pending) {
  await writeSetting(env, pendingKey(ownerId), JSON.stringify(pending));
}

async function getPending(env, ownerId) {
  const value = await readSetting(env, pendingKey(ownerId));
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Invalid pending settings edit state");
  }
}

async function clearPending(env, ownerId) {
  await env.CRASH_BOT_DB.prepare(
    "DELETE FROM bot_settings WHERE key = ?"
  ).bind(pendingKey(ownerId)).run();
}

export async function getBotEnabledState(env) {
  const value = await readSetting(env, "bot_enabled");
  if (value === null) return { enabled: true, valid: true };
  if (value === "1") return { enabled: true, valid: true };
  if (value === "0") return { enabled: false, valid: true };
  return { enabled: false, valid: false };
}

export async function renderSettings(env, ownerId, chatId) {
  if (
    String(ownerId) !== String(env.OWNER_TELEGRAM_ID) ||
    String(chatId) !== String(ownerId)
  ) return false;

  const [enabled, channels, persisted] = await Promise.all([
    getBotEnabledState(env),
    getRequiredChannels(env),
    env.CRASH_BOT_DB.prepare(`
      SELECT key, value FROM bot_settings
      WHERE key IN ('crash_channel_id', 'crash_channel_url', 'telegram_bot_username')
    `).all()
  ]);
  const saved = Object.fromEntries(
    (persisted.results ?? []).map((row) => [row.key, row.value])
  );
  const configLines = Object.entries(EDITABLE_SETTINGS).map(([key, setting]) => {
    const value = saved[key] ?? env[setting.envKey] ?? "تنظیم نشده";
    return `${setting.label}: ${value}`;
  });
  const readiness = [
    ["توکن ربات", Boolean(env.TELEGRAM_BOT_TOKEN)],
    ["راز وب‌هوک", Boolean(env.WEBHOOK_SECRET)],
    ["شناسهٔ مالک", Boolean(env.OWNER_TELEGRAM_ID)],
    ["اتصال D1", Boolean(env.CRASH_BOT_DB)]
  ].map(([label, ready]) => `${label}: ${ready ? "آماده" : "نیازمند تنظیم"}`);
  const text = [
    "⚙️ تنظیمات ربات — فقط مالک",
    `وضعیت: ${enabled.valid ? (enabled.enabled ? "فعال" : "خاموش") : "نامعتبر؛ برای ایمنی خاموش در نظر گرفته شده"}`,
    `عضویت اجباری: ${channels.length} کانال`,
    "",
    ...configLines,
    "",
    "وضعیت environment (مقادیر محرمانه نمایش داده نمی‌شوند):",
    ...readiness,
    "",
    "در حالت خاموش، کاربران عادی فقط می‌توانند /start، /menu، راهنما و بررسی عضویت را استفاده کنند. مالک و مدیران برای بازیابی دسترسی دارند."
  ].join("\n");
  const keyboard = [
    [{ text: "🔘 تغییر وضعیت ربات", callback_data: "settings:toggle" }],
    [{ text: "🔗 مدیریت عضویت اجباری", callback_data: "settings:membership" }],
    [
      { text: "شناسهٔ کانال", callback_data: "settings:edit:crash_channel_id" },
      { text: "پیوند کانال", callback_data: "settings:edit:crash_channel_url" }
    ],
    [{ text: "نام کاربری ربات", callback_data: "settings:edit:telegram_bot_username" }]
  ];
  const sent = await sendTrackedSectionInlineTelegram(env, chatId, text, keyboard);
  if (!sent) throw new Error("Could not display settings panel");
  return true;
}

async function startSettingEdit(env, ownerId, chatId, key) {
  const setting = EDITABLE_SETTINGS[key];
  if (!setting) return false;
  await savePending(env, ownerId, { stage: "input", key });
  const sent = await sendTrackedSectionNoticeTelegram(
    env,
    chatId,
    `مقدار جدید برای «${setting.label}» را بفرست. مقدار خالی پذیرفته نیست. برای لغو «لغو» بنویس.`,
    []
  );
  if (!sent) throw new Error("Could not start settings edit");
  return true;
}

export async function handleSettingsMessage(env, message, ownerId, isNavigation = false) {
  if (
    String(ownerId) !== String(env.OWNER_TELEGRAM_ID) ||
    message?.chat?.type !== "private" ||
    String(message?.chat?.id) !== String(ownerId)
  ) return false;
  const pending = await getPending(env, ownerId);
  if (!pending) return false;
  const text = String(message?.text ?? "").trim();
  if (isNavigation || text === "لغو") {
    await clearPending(env, ownerId);
    return false;
  }
  if (pending.stage !== "input") return false;
  const setting = EDITABLE_SETTINGS[pending.key];
  if (
    !setting ||
    text.length === 0 ||
    text.length > MAX_SETTING_LENGTH ||
    !setting.validate(text)
  ) {
    await sendTrackedSectionNoticeTelegram(
      env,
      message.chat.id,
      `مقدار برای «${setting?.label ?? "تنظیم"}» نامعتبر است. مقدار قبلی تغییر نکرده؛ مقدار معتبر دیگری بفرست یا «لغو» بنویس.`,
      []
    );
    return true;
  }
  await savePending(env, ownerId, { stage: "confirm", key: pending.key, value: text });
  const sent = await sendTrackedSectionInlineTelegram(
    env,
    message.chat.id,
    `پیش‌نمایش تغییر ${setting.label}:\n\n${text}\n\nتغییر ذخیره شود؟`,
    [[
      { text: "✅ ذخیره", callback_data: "settings:save" },
      { text: "لغو", callback_data: "settings:cancel" }
    ]]
  );
  if (!sent) throw new Error("Could not display settings preview");
  return true;
}

export async function handleSettingsCallback(env, callback) {
  const data = String(callback?.data ?? "");
  if (
    !["settings:toggle", "settings:membership", "settings:cancel", "settings:save"].includes(data) &&
    !/^settings:(?:edit:[a-z_]+|enabled:[01])$/.test(data)
  ) return false;

  const ownerId = callback?.from?.id;
  const chatId = callback?.message?.chat?.id;
  if (
    String(ownerId) !== String(env.OWNER_TELEGRAM_ID) ||
    String(chatId) !== String(ownerId) ||
    callback?.message?.chat?.type !== "private"
  ) {
    await answerCallbackQuery(env, callback.id, "این عملیات فقط برای مالک در دسترس است.");
    return true;
  }

  if (data === "settings:membership") {
    await showForcedMembershipPanel(env, chatId);
  } else if (data === "settings:toggle") {
    const current = await getBotEnabledState(env);
    const next = current.enabled ? "0" : "1";
    await sendTrackedSectionInlineTelegram(
      env,
      chatId,
      `وضعیت ربات به ${next === "1" ? "فعال" : "خاموش"} تغییر کند؟`,
      [[
        { text: "✅ تأیید", callback_data: `settings:enabled:${next}` },
        { text: "لغو", callback_data: "settings:cancel" }
      ]]
    );
  } else if (data.startsWith("settings:edit:")) {
    await startSettingEdit(env, ownerId, chatId, data.slice("settings:edit:".length));
  } else if (data.startsWith("settings:enabled:")) {
    const value = data.endsWith(":1") ? "1" : "0";
    await writeSetting(env, "bot_enabled", value);
    await renderSettings(env, ownerId, chatId);
  } else if (data === "settings:cancel") {
    await clearPending(env, ownerId);
    await renderSettings(env, ownerId, chatId);
  } else if (data === "settings:save") {
    const pending = await getPending(env, ownerId);
    const setting = EDITABLE_SETTINGS[pending?.key];
    if (
      pending?.stage !== "confirm" ||
      !setting ||
      !setting.validate(pending.value)
    ) {
      await answerCallbackQuery(env, callback.id, "پیش‌نمایش تنظیمات معتبر نیست.");
      return true;
    }
    try {
      await env.CRASH_BOT_DB.batch([
        env.CRASH_BOT_DB.prepare(`
          INSERT INTO bot_settings (key, value, updated_at)
          VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = CURRENT_TIMESTAMP
        `).bind(pending.key, pending.value),
        env.CRASH_BOT_DB.prepare(
          "DELETE FROM bot_settings WHERE key = ?"
        ).bind(pendingKey(ownerId))
      ]);
    } catch {
      console.error("Could not save bot setting; previous value remains active.");
      await answerCallbackQuery(env, callback.id, "ذخیره انجام نشد؛ مقدار قبلی حفظ شد.");
      return true;
    }
    await renderSettings(env, ownerId, chatId);
  }
  await answerCallbackQuery(env, callback.id);
  return true;
}
