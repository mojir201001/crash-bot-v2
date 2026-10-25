async function telegramRequest(env, method, payload) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

  let result;

  try {
    result = await response.json();
  } catch {
    console.error(`Telegram ${method}: invalid JSON response`);
    return { ok: false };
  }

  if (!response.ok || result?.ok !== true) {
    console.error(
      `Telegram ${method} failed:`,
      result?.description ?? response.status
    );

    return {
      ok: false,
      description: result?.description
    };
  }

  return result;
}

/*
 * Reply keyboards must not be tied to an automatic
 * delete-old-screen workflow. Deleting a bot message
 * that supplied a reply keyboard can disrupt navigation.
 */
export async function sendTelegram(env, chatId, text, keyboard) {
  const result = await telegramRequest(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...(keyboard ? {
      reply_markup: {
        keyboard,
        resize_keyboard: true,
        is_persistent: false
      }
    } : {})
  });

  if (result?.ok !== true) {
    return false;
  }

  const textValue = String(text ?? "");
  const isMainScreen =
    Boolean(keyboard) &&
    (
      textValue.includes("به کراش‌یاب ادیب خوش اومدی") ||
      textValue.startsWith("🛠 پنل مدیریت")
    );

  if (isMainScreen && env?.CRASH_BOT_DB) {
    const settingKey = `ui_main_screen_message:${String(chatId)}`;
    const newMessageId = Number(result?.result?.message_id);
    let previousMessageId = null;

    try {
      const row = await env.CRASH_BOT_DB
        .prepare("SELECT value FROM bot_settings WHERE key = ?")
        .bind(settingKey)
        .first();

      const oldId = Number(row?.value);
      if (Number.isSafeInteger(oldId) && oldId > 0) {
        previousMessageId = oldId;
      }
    } catch (error) {
      console.error("Could not read previous main-screen message:", error);
    }

    if (Number.isSafeInteger(newMessageId) && newMessageId > 0) {
      try {
        await env.CRASH_BOT_DB.prepare(`
          INSERT INTO bot_settings (key, value)
          VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).bind(settingKey, String(newMessageId)).run();
      } catch (error) {
        console.error("Could not save new main-screen message:", error);
      }

      if (previousMessageId && previousMessageId !== newMessageId) {
        try {
          await deleteTelegramMessage(env, chatId, previousMessageId);
        } catch (error) {
          console.error("Could not delete previous main-screen message:", error);
        }
      }
    }
  }

  return true;
}

export async function sendInlineTelegram(env, chatId, text, inlineKeyboard) {
  const result = await telegramRequest(env, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: inlineKeyboard
    }
  });

  return result?.ok === true;
}

export async function deleteTelegramMessage(env, chatId, messageId) {
  if (!chatId || !messageId) {
    return false;
  }

  const result = await telegramRequest(env, "deleteMessage", {
    chat_id: chatId,
    message_id: messageId
  });

  return result?.ok === true;
}

export async function answerCallbackQuery(env, callbackQueryId, text) {
  const result = await telegramRequest(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {})
  });

  return result?.ok === true;
}

export async function editInlineTelegram(
  env,
  chatId,
  messageId,
  text,
  inlineKeyboard
) {
  const result = await telegramRequest(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...(inlineKeyboard ? {
      reply_markup: {
        inline_keyboard: inlineKeyboard
      }
    } : {})
  });

  return result?.ok === true;
}


const sectionScreenKey = (chatId) =>
  `ui_section_message:${String(chatId)}`;

export async function clearTrackedSectionMessage(env, chatId) {
  const key = sectionScreenKey(chatId);

  let row;
  try {
    row = await env.CRASH_BOT_DB.prepare(
      "SELECT value FROM bot_settings WHERE key = ?"
    ).bind(key).first();
  } catch (error) {
    console.error("Could not read tracked section message:", error);
    return false;
  }

  const messageId = Number(row?.value);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    return false;
  }

  const deleted = await deleteTelegramMessage(env, chatId, messageId);

  // حتی اگر تلگرام بگوید پیام قبلاً حذف شده، شناسهٔ قدیمی را پاک می‌کنیم.
  try {
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM bot_settings WHERE key = ?"
    ).bind(key).run();
  } catch (error) {
    console.error("Could not clear tracked section state:", error);
  }

  return deleted;
}

export async function sendTrackedSectionInlineTelegram(
  env, chatId, text, inlineKeyboard
) {
  const key = sectionScreenKey(chatId);
  let previousId = null;

  try {
    const row = await env.CRASH_BOT_DB.prepare(
      "SELECT value FROM bot_settings WHERE key = ?"
    ).bind(key).first();

    const id = Number(row?.value);
    if (Number.isSafeInteger(id) && id > 0) {
      previousId = id;
    }
  } catch (error) {
    console.error("Could not read previous section message:", error);
  }

  // ابتدا پیام جدید ارسال می‌شود؛ صفحهٔ قبلی فقط پس از موفقیت حذف می‌شود.
  const result = await telegramRequest(env, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: inlineKeyboard }
  });

  if (result?.ok !== true) return false;

  const newId = result.result?.message_id;
  if (!Number.isSafeInteger(newId) || newId <= 0) return false;

  try {
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO bot_settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `).bind(key, String(newId)).run();
  } catch (error) {
    console.error("Could not save section message ID:", error);
    return true;
  }

  if (previousId && previousId !== newId) {
    await deleteTelegramMessage(env, chatId, previousId);
  }

  return true;
}


// ??? ???? ???? ??? ???? ? ??? ???? ???? ??

export async function sendTrackedSectionNoticeTelegram(env, chatId, text, keyboard) {
  const db = env.CRASH_BOT_DB;
  const settingKey = `ui_section_message:${String(chatId)}`;
  let previousMessageId = null;

  try {
    const row = await db
      .prepare("SELECT value FROM bot_settings WHERE key = ?")
      .bind(settingKey)
      .first();

    const parsedId = Number(row?.value);
    if (Number.isSafeInteger(parsedId) && parsedId > 0) {
      previousMessageId = parsedId;
    }
  } catch (error) {
    console.error("Could not read previous section message:", error);
  }

  const result = await telegramRequest(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...(keyboard ? {
      reply_markup: {
        keyboard,
        resize_keyboard: true,
        is_persistent: false
      }
    } : {})
  });

  if (result?.ok !== true) return false;

  const newMessageId = result.result?.message_id;
  if (!Number.isSafeInteger(newMessageId) || newMessageId <= 0) {
    return false;
  }

  try {
    await db.prepare(`
      INSERT INTO bot_settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `).bind(settingKey, String(newMessageId)).run();
  } catch (error) {
    console.error("Could not track new section message:", error);
  }

  if (previousMessageId && previousMessageId !== newMessageId) {
    try {
      await deleteTelegramMessage(env, chatId, previousMessageId);
    } catch (error) {
      console.error("Could not delete previous section message:", error);
    }
  }

  return true;
}
export async function sendTrackedMainScreenTelegram(env, chatId, text, keyboard) {
  const db = env.CRASH_BOT_DB;
  const settingKey = `ui_main_screen_message:${chatId}`;
  let previousMessageId = null;

  try {
    const row = await db
      .prepare("SELECT value FROM bot_settings WHERE key = ?")
      .bind(settingKey)
      .first();
    previousMessageId = row?.value ?? null;
  } catch (error) {
    console.error("?????? ???? ???? ??? ???? ?????? ???:", error);
  }

  const response = await sendTelegram(env, chatId, text, keyboard);
  const newMessageId = response?.result?.message_id;

  if (newMessageId) {
    try {
      await db
        .prepare(
          "INSERT INTO bot_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )
        .bind(settingKey, String(newMessageId))
        .run();
    } catch (error) {
      console.error("??? ???? ???? ??? ???? ?????? ???:", error);
    }

    if (
      previousMessageId &&
      String(previousMessageId) !== String(newMessageId)
    ) {
      try {
        await deleteTelegramMessage(env, chatId, Number(previousMessageId));
      } catch (error) {
        console.error("??? ???? ???? ??? ???? ?????? ???:", error);
      }
    }
  }

  return response;
}
