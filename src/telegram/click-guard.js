export async function acquireUserActionLock(env, telegramId, ttlSeconds = 120) {
  const db = env.CRASH_BOT_DB;

  if (!db) {
    throw new Error("CRASH_BOT_DB is not configured");
  }

  const now = Math.floor(Date.now() / 1000);
  const token = crypto.randomUUID();
  const expiresAt = now + ttlSeconds;

  const row = await db.prepare(`
    INSERT INTO user_action_locks (telegram_id, lock_token, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      lock_token = excluded.lock_token,
      expires_at = excluded.expires_at
    WHERE user_action_locks.expires_at <= ?
    RETURNING lock_token
  `).bind(String(telegramId), token, expiresAt, now).first();

  if (row?.lock_token !== token) {
    return { acquired: false, token: null };
  }

  return { acquired: true, token };
}

export async function releaseUserActionLock(env, telegramId, token) {
  if (!token) return false;

  const result = await env.CRASH_BOT_DB.prepare(`
    DELETE FROM user_action_locks
    WHERE telegram_id = ? AND lock_token = ?
  `).bind(String(telegramId), token).run();

  return (result.meta?.changes ?? 0) > 0;
}
