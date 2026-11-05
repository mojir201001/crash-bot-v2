export async function upsertTelegramUser(env, telegramUser) {
  const telegramId = telegramUser?.id;
  if (!Number.isSafeInteger(telegramId) || telegramId <= 0) {
    throw new TypeError("Telegram user ID must be a positive safe integer");
  }
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO users (telegram_id, username, first_name, last_name)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name
  `).bind(
    telegramId,
    telegramUser.username ?? null,
    telegramUser.first_name ?? null,
    telegramUser.last_name ?? null
  ).run();
}
