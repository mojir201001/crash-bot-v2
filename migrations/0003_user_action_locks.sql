CREATE TABLE IF NOT EXISTS user_action_locks (
  telegram_id TEXT PRIMARY KEY,
  lock_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_action_locks_expires
ON user_action_locks(expires_at);
