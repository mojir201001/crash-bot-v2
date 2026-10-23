CREATE TABLE IF NOT EXISTS admin_roles (
  user_id INTEGER PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  granted_by INTEGER,
  granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_restrictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(telegram_id),
  restriction_type TEXT NOT NULL
    CHECK (restriction_type IN ('temporary','permanent')),
  reason TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  lifted_by INTEGER,
  lifted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_restrictions_user
  ON user_restrictions(user_id, lifted_at, expires_at);

CREATE TABLE IF NOT EXISTS user_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blocker_id INTEGER NOT NULL REFERENCES users(telegram_id),
  blocked_id INTEGER NOT NULL REFERENCES users(telegram_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lifted_at TEXT,
  CHECK (blocker_id <> blocked_id),
  UNIQUE (blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS abuse_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL REFERENCES users(telegram_id),
  reported_user_id INTEGER NOT NULL REFERENCES users(telegram_id),
  source_type TEXT NOT NULL,
  source_id INTEGER,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','reviewed','dismissed')),
  reviewed_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT,
  CHECK (reporter_id <> reported_user_id)
);

CREATE TABLE IF NOT EXISTS anonymous_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_a_id INTEGER NOT NULL REFERENCES users(telegram_id),
  user_b_id INTEGER REFERENCES users(telegram_id),
  requested_gender TEXT NOT NULL
    CHECK (requested_gender IN ('man','woman')),
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting','active','ended','cancelled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  matched_at TEXT,
  ended_at TEXT,
  ended_by INTEGER,
  CHECK (user_b_id IS NULL OR user_a_id <> user_b_id)
);

CREATE INDEX IF NOT EXISTS idx_anon_sessions_queue
  ON anonymous_sessions(status, requested_gender, created_at);

CREATE TABLE IF NOT EXISTS review_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_id INTEGER NOT NULL UNIQUE REFERENCES admin_queue(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  decided_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS publication_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_type TEXT NOT NULL CHECK (item_type IN ('post','reply','ad')),
  item_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','sent','unknown','failed')),
  channel_message_id INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (item_type, item_id)
);

CREATE TABLE IF NOT EXISTS backup_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_by INTEGER NOT NULL,
  backup_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'started'
    CHECK (status IN ('started','completed','failed')),
  details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS account_deletion_requests (
  user_id INTEGER PRIMARY KEY REFERENCES users(telegram_id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','completed','cancelled')),
  requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

ALTER TABLE users ADD COLUMN account_status TEXT NOT NULL DEFAULT 'active'
  CHECK (account_status IN ('active','disabled','deletion_pending','deleted'));

ALTER TABLE users ADD COLUMN deleted_at TEXT;

ALTER TABLE posts ADD COLUMN media_type TEXT;
ALTER TABLE posts ADD COLUMN media_file_id TEXT;
ALTER TABLE posts ADD COLUMN caption TEXT;

ALTER TABLE anonymous_messages ADD COLUMN session_id INTEGER
  REFERENCES anonymous_sessions(id);
ALTER TABLE anonymous_messages ADD COLUMN media_type TEXT;
ALTER TABLE anonymous_messages ADD COLUMN media_file_id TEXT;
ALTER TABLE anonymous_messages ADD COLUMN caption TEXT;

CREATE INDEX IF NOT EXISTS idx_anon_messages_session
  ON anonymous_messages(session_id, created_at);
