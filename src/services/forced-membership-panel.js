import {
  sendInlineTelegram,
  sendTrackedSectionInlineTelegram,
  answerCallbackQuery,
  editInlineTelegram
} from "../telegram/api.js";
import {
  getRequiredChannels,
  saveRequiredChannels
} from "./forced-membership.js";

const KEY = "forced_membership_pending_add";

async function savePending(env, value) {
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO bot_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).bind(KEY, JSON.stringify(value)).run();
}

async function getPending(env) {
  const row = await env.CRASH_BOT_DB.prepare(
    "SELECT value FROM bot_settings WHERE key = ?"
  ).bind(KEY).first();

  if (!row) return null;

  try {
    return JSON.parse(row.value);
  } catch {
    throw new Error("Invalid pending membership state");
  }
}

async function clearPending(env) {
  await env.CRASH_BOT_DB.prepare(
    "DELETE FROM bot_settings WHERE key = ?"
  ).bind(KEY).run();
}

function validInviteUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      ["t.me", "www.t.me"].includes(url.hostname) &&
      url.username === "" &&
      url.password === "" &&
      !url.port &&
      !url.search &&
      !url.hash;
  } catch {
    return false;
  }
}

function panelText(channels) {
  if (!channels.length) {
    return "🔗 مدیریت عضویت اجباری\n\nهنوز کانالی ثبت نشده است.";
  }

  return "🔗 مدیریت عضویت اجباری\n\n" +
    channels.map((item, i) =>
      `${i + 1}. ${item.chatId}\n${item.inviteUrl}`
    ).join("\n\n");
}

function panelKeyboard(channels) {
  const rows = channels.map((item, i) => [
    {
      text: `🗑 حذف مورد ${i + 1}`,
      callback_data: `fm:delete:${encodeURIComponent(item.chatId)}`
    }
  ]);

  rows.push([{ text: "➕ افزودن کانال یا گروه", callback_data: "fm:add" }]);

  if (channels.length) {
    rows.push([{ text: "🗑 حذف همه", callback_data: "fm:clear-confirm" }]);
  }

  rows.push([{ text: "🔄 تازه‌سازی فهرست", callback_data: "fm:list" }]);

  return rows;
}

export async function showForcedMembershipPanel(env, chatId) {
  const channels = await getRequiredChannels(env);

  return sendTrackedSectionInlineTelegram(
    env,
    chatId,
    panelText(channels),
    panelKeyboard(channels)
  );
}

export async function handleForcedMembershipCallback(env, query) {
  const data = query?.data ?? "";
  if (!data.startsWith("fm:")) return false;

  if (String(query.from?.id) !== String(env.OWNER_TELEGRAM_ID)) {
    await answerCallbackQuery(env, query.id, "این بخش فقط برای مالک اصلی است.");
    return true;
  }

  const callbackChat = query.message?.chat;
  if (
    callbackChat?.type !== "private" ||
    String(callbackChat.id) !== String(env.OWNER_TELEGRAM_ID)
  ) {
    await answerCallbackQuery(
      env,
      query.id,
      "این پنل فقط در گفت‌وگوی خصوصی مالک قابل استفاده است."
    );
    return true;
  }

  await answerCallbackQuery(env, query.id);

  const chatId = callbackChat.id;
  const messageId = query.message?.message_id;
  if (!messageId) return true;

  try {
    if (data === "fm:add") {
      await savePending(env, { mode: "add" });
      await sendTrackedSectionInlineTelegram(
        env,
        chatId,
        "🔗 لینک عمومی یا خصوصی کانال/گروه را در پیام بعدی بفرست.\n\nبرای لینک خصوصی، پس از ارسال لینک، ربات را به همان کانال یا گروه اضافه کن و دسترسی ادمین بده.",
        [[{ text: "↩️ بازگشت به پنل", callback_data: "fm:list" }]]
      );
      return true;
    }

    if (data === "fm:clear-confirm") {
      await editInlineTelegram(
        env, chatId, messageId,
        "⚠️ مطمئنی می‌خواهی تمام کانال‌های عضویت اجباری حذف شوند؟",
        [[
          { text: "بله، حذف همه", callback_data: "fm:clear-confirmed" },
          { text: "انصراف", callback_data: "fm:list" }
        ]]
      );
      return true;
    }

    if (data === "fm:clear-confirmed") {
      await saveRequiredChannels(env, []);
      await clearPending(env);
      await editInlineTelegram(
        env, chatId, messageId,
        "تمام کانال‌های عضویت اجباری حذف شدند.",
        [[{ text: "↩️ بازگشت به پنل", callback_data: "fm:list" }]]
      );
      return true;
    }

    if (data === "fm:private-confirm") {
      const pending = await getPending(env);

      if (
        pending?.mode !== "private-confirm" ||
        !pending.chatId ||
        !pending.inviteUrl
      ) {
        await editInlineTelegram(
          env, chatId, messageId,
          "⚠️ موردی برای تأیید وجود ندارد یا درخواست منقضی شده است.",
          [[{ text: "↩️ بازگشت به پنل", callback_data: "fm:list" }]]
        );
        return true;
      }

      const newItem = {
        chatId: String(pending.chatId),
        inviteUrl: pending.inviteUrl
      };
      const channels = await getRequiredChannels(env);
      const updated = channels.some(item => item.chatId === newItem.chatId)
        ? channels.map(item => item.chatId === newItem.chatId ? newItem : item)
        : [...channels, newItem];

      await saveRequiredChannels(env, updated);
      await clearPending(env);

      await editInlineTelegram(
        env, chatId, messageId,
        "✅ کانال یا گروه پس از تأیید شما ثبت شد.\n\n" + panelText(updated),
        panelKeyboard(updated)
      );
      return true;
    }

    if (data === "fm:private-cancel") {
      await clearPending(env);
      await editInlineTelegram(
        env, chatId, messageId,
        "افزودن کانال یا گروه خصوصی لغو شد؛ فهرست قبلی تغییری نکرد.",
        [[{ text: "↩️ بازگشت به پنل", callback_data: "fm:list" }]]
      );
      return true;
    }

    if (data === "fm:list") {
      await clearPending(env);
      const channels = await getRequiredChannels(env);
      await editInlineTelegram(
        env, chatId, messageId,
        panelText(channels),
        panelKeyboard(channels)
      );
      return true;
    }

    if (data.startsWith("fm:delete:")) {
      const chatToDelete = decodeURIComponent(data.slice("fm:delete:".length));
      const channels = await getRequiredChannels(env);
      const updated = channels.filter(item => item.chatId !== chatToDelete);

      if (updated.length === channels.length) {
        await sendTrackedSectionInlineTelegram(
          env, chatId, "این مورد قبلاً حذف شده است.",
          [[{ text: "↩️ بازگشت به پنل", callback_data: "fm:list" }]]
        );
        return true;
      }

      await saveRequiredChannels(env, updated);
      await editInlineTelegram(
        env, chatId, messageId,
        panelText(updated),
        panelKeyboard(updated)
      );
      return true;
    }
  } catch (error) {
    console.error("Forced membership panel error:", error);
    await sendTrackedSectionInlineTelegram(
      env, chatId,
      "⚠️ عملیات انجام نشد؛ تنظیمات قبلی حفظ شده‌اند.",
      [[{ text: "🔄 تلاش دوباره", callback_data: "fm:list" }]]
    );
  }

  return true;
}
export async function handleForcedMembershipMessage(env, message) {
  if (String(message?.from?.id) !== String(env.OWNER_TELEGRAM_ID)) {
    return false;
  }

  const pending = await getPending(env);
  if (pending?.mode !== "add") return false;

  const text = message.text?.trim() ?? "";
  const chatId = message.chat?.id;

  // Non-URL messages (menu taps, /start, /menu, and other navigation)
  // cancel the pending add flow and continue through normal routing.
  if (!/^https?:\/\//i.test(text)) {
    await clearPending(env);
    return false;
  }

  if (!validInviteUrl(text)) {
    await sendTrackedSectionInlineTelegram(
      env,
      chatId,
      "لطفاً یک لینک معتبر از دامنه t.me بفرست.",
      [[{ text: "↩️ بازگشت به پنل", callback_data: "fm:list" }]]
    );
    return true;
  }

  const url = new URL(text);
  const segments = url.pathname.split("/").filter(Boolean);
  const first = segments[0] ?? "";

  if (first.startsWith("+") || first === "joinchat") {
    await savePending(env, {
      mode: "private",
      inviteUrl: text
    });

    await sendTrackedSectionInlineTelegram(
      env,
      chatId,
      "لینک خصوصی ثبت موقت شد. حالا ربات را به همان کانال یا گروه اضافه کن و دسترسی ادمین بده. پس از دریافت رویداد تلگرام، شناسهٔ چت ثبت می‌شود.",
      [[{ text: "↩️ بازگشت به پنل", callback_data: "fm:list" }]]
    );

    return true;
  }

  if (!/^[A-Za-z0-9_]{5,32}$/.test(first)) {
    await sendTrackedSectionInlineTelegram(
      env,
      chatId,
      "این لینک، شناسهٔ عمومی قابل‌تشخیصی ندارد. برای کانال خصوصی لینک دعوت را بفرست.",
      [[{ text: "↩️ بازگشت به پنل", callback_data: "fm:list" }]]
    );
    return true;
  }

  const channelId = `@${first}`;
  const channels = await getRequiredChannels(env);
  const updated = channels.some(item => item.chatId === channelId)
    ? channels.map(item => item.chatId === channelId
        ? { chatId: channelId, inviteUrl: text }
        : item)
    : [...channels, { chatId: channelId, inviteUrl: text }];

  await saveRequiredChannels(env, updated);
  await clearPending(env);

  await sendTrackedSectionInlineTelegram(
    env,
    chatId,
    "✅ لینک عمومی به فهرست اضافه شد. برای بررسی عضویت، مطمئن شو ربات اجازهٔ بررسی اعضا را دارد.",
    [[{ text: "↩️ بازگشت به پنل", callback_data: "fm:list" }]]
  );

  return true;
}

export async function handleForcedMembershipChatUpdate(env, update) {
  const event = update?.my_chat_member;
  if (!event) return false;

  const pending = await getPending(env);

  if (pending?.mode !== "private" || !pending.inviteUrl) {
    return false;
  }

  // The owner confirms the destination; another admin may add the bot.

  const status = event.new_chat_member?.status;
  const chat = event.chat;

  if (
    !chat?.id ||
    !["channel", "supergroup", "group"].includes(chat.type) ||
    !["administrator", "creator"].includes(status)
  ) {
    return false;
  }

  const candidate = {
    mode: "private-confirm",
    inviteUrl: pending.inviteUrl,
    chatId: String(chat.id),
    title: String(chat.title ?? chat.username ?? chat.id),
    type: chat.type
  };

  await savePending(env, candidate);

  const sent = await sendTrackedSectionInlineTelegram(
    env,
    env.OWNER_TELEGRAM_ID,
    "🔎 ربات در یک کانال یا گروه پیدا شد.\n\n" +
      `نام: ${candidate.title}\n` +
      `نوع: ${candidate.type}\n` +
      `شناسه: ${candidate.chatId}\n\n` +
      "اگر این همان مقصد لینک دعوتی است که فرستادی، ثبت را تأیید کن.",
    [[
      { text: "✅ تأیید و ثبت", callback_data: "fm:private-confirm" },
      { text: "❌ لغو", callback_data: "fm:private-cancel" }
    ]]
  );

  if (!sent) {
    console.error("Could not send private membership confirmation to owner");
  }

  return true;
}
