import {
  answerCallbackQuery,
  sendTrackedSectionInlineTelegram,
  sendTrackedSectionNoticeTelegram
} from "../telegram/api.js";

export const DEFAULT_BOT_RULES = `📖 راهنما و قوانین ربات

از امکانات ربات محترمانه و مسئولانه استفاده کن.
اطلاعات شخصی خودت یا دیگران را بدون رضایت منتشر نکن.
ارسال محتوای توهین‌آمیز، آزاردهنده، غیرقانونی یا تبلیغ ناخواسته ممنوع است.
درخواست ارتباط فقط با رضایت طرف مقابل انجام می‌شود.
پیام‌های ثبت‌شده برای بررسی و نگهداری در پایگاه دادهٔ ربات پردازش می‌شوند.

با ادامهٔ استفاده از ربات، این موارد را رعایت کن.`;

const RULES_KEY = "bot_rules_text";
const MAX_RULES_LENGTH = 3500;

function pendingKey(ownerId) {
  return `rules_edit_pending:${String(ownerId)}`;
}

function validRules(text) {
  return typeof text === "string" &&
    text.trim().length > 0 &&
    text.trim().length <= MAX_RULES_LENGTH;
}

async function readPending(env, ownerId) {
  const row = await env.CRASH_BOT_DB.prepare(
    "SELECT value FROM bot_settings WHERE key = ?"
  ).bind(pendingKey(ownerId)).first();
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    throw new Error("Invalid pending rules edit state");
  }
}

async function savePending(env, ownerId, value) {
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO bot_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).bind(pendingKey(ownerId), JSON.stringify(value)).run();
}

async function clearPending(env, ownerId) {
  await env.CRASH_BOT_DB.prepare(
    "DELETE FROM bot_settings WHERE key = ?"
  ).bind(pendingKey(ownerId)).run();
}

export async function getBotRules(env) {
  const row = await env.CRASH_BOT_DB.prepare(
    "SELECT value FROM bot_settings WHERE key = ?"
  ).bind(RULES_KEY).first();
  if (!row) return DEFAULT_BOT_RULES;
  if (!validRules(row.value)) {
    throw new Error("Stored bot rules are invalid");
  }
  return row.value.trim();
}

export async function renderBotRules(env, chatId) {
  const rules = await getBotRules(env);
  const sent = await sendTrackedSectionNoticeTelegram(env, chatId, rules, []);
  if (!sent) throw new Error("Could not display bot rules");
}

export async function startRulesEdit(env, ownerId, chatId) {
  if (String(ownerId) !== String(env.OWNER_TELEGRAM_ID) ||
      String(chatId) !== String(ownerId)) return false;
  await savePending(env, ownerId, { stage: "input" });
  const current = await getBotRules(env);
  const sent = await sendTrackedSectionNoticeTelegram(
    env,
    chatId,
    `📖 متن فعلی قوانین:\n\n${current.slice(0, 3000)}\n\nمتن جدید را بفرست (حداکثر ${MAX_RULES_LENGTH} نویسه). برای لغو «لغو» بنویس.`,
    []
  );
  if (!sent) throw new Error("Could not start rules edit");
  return true;
}

export async function handleRulesMessage(env, message, ownerId, isNavigation = false) {
  if (
    String(ownerId) !== String(env.OWNER_TELEGRAM_ID) ||
    message?.chat?.type !== "private" ||
    String(message?.chat?.id) !== String(ownerId)
  ) return false;
  const pending = await readPending(env, ownerId);
  if (!pending) return false;
  const text = String(message?.text ?? "").trim();
  if (isNavigation || ["لغو"].includes(text)) {
    await clearPending(env, ownerId);
    return false;
  }
  if (pending.stage !== "input") {
    return false;
  }
  if (!validRules(text)) {
    await sendTrackedSectionNoticeTelegram(
      env,
      message.chat.id,
      `متن قوانین باید غیرخالی و حداکثر ${MAX_RULES_LENGTH} نویسه باشد. متن دیگری بفرست یا «لغو» بنویس.`,
      []
    );
    return true;
  }
  await savePending(env, ownerId, { stage: "confirm", text: text.trim() });
  const sent = await sendTrackedSectionInlineTelegram(
    env,
    message.chat.id,
    `پیش‌نمایش قوانین جدید:\n\n${text.trim()}`,
    [[
      { text: "✅ تأیید و ذخیره", callback_data: "rules:confirm" },
      { text: "لغو", callback_data: "rules:cancel" }
    ]]
  );
  if (!sent) throw new Error("Could not display rules preview");
  return true;
}

export async function handleRulesCallback(env, callback) {
  const data = String(callback?.data ?? "");
  if (!["rules:edit", "rules:confirm", "rules:cancel"].includes(data)) return false;
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

  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name
  `).bind(
    ownerId,
    callback.from.username ?? null,
    callback.from.first_name ?? null
  ).run();

  if (data === "rules:edit") {
    await startRulesEdit(env, ownerId, chatId);
    await answerCallbackQuery(env, callback.id);
  } else if (data === "rules:cancel") {
    await clearPending(env, ownerId);
    await answerCallbackQuery(env, callback.id, "ویرایش لغو شد.");
  } else {
    const pending = await readPending(env, ownerId);
    if (pending?.stage !== "confirm" || !validRules(pending.text)) {
      await answerCallbackQuery(env, callback.id, "پیش‌نمایش معتبر نیست؛ دوباره شروع کن.");
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
        `).bind(RULES_KEY, pending.text),
        env.CRASH_BOT_DB.prepare(`
          INSERT INTO bot_rules_history (content, changed_by)
          VALUES (?, ?)
        `).bind(pending.text, ownerId),
        env.CRASH_BOT_DB.prepare(
          "DELETE FROM bot_settings WHERE key = ?"
        ).bind(pendingKey(ownerId))
      ]);
    } catch (error) {
      console.error("Could not save bot rules; previous rules remain active.");
      await answerCallbackQuery(env, callback.id, "ذخیره انجام نشد؛ متن قبلی حفظ شد.");
      return true;
    }
    await answerCallbackQuery(env, callback.id, "قوانین ذخیره شد.");
    await renderBotRules(env, chatId);
  }
  return true;
}
