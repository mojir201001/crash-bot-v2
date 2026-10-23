CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_blocked INTEGER NOT NULL DEFAULT 0 CHECK (is_blocked IN (0,1))
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  nickname TEXT,
  birth_year INTEGER,
  birth_month INTEGER CHECK (birth_month BETWEEN 1 AND 12),
  religion TEXT,
  location TEXT,
  marital_status TEXT CHECK (marital_status IN ('single','married')),
  gender TEXT CHECK (gender IN ('man','woman')),
  bio TEXT,
  job TEXT,
  field TEXT,
  personality_type TEXT,
  image_file_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS interests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(telegram_id),
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','published')),
  channel_message_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT,
  reviewed_by INTEGER
);

CREATE TABLE IF NOT EXISTS admin_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_type TEXT NOT NULL CHECK (item_type IN ('post','reply','connection','ad')),
  item_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL REFERENCES users(telegram_id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT,
  reviewed_by INTEGER
);

CREATE INDEX IF NOT EXISTS idx_admin_queue_status_created
  ON admin_queue(status, created_at, id);

CREATE TABLE IF NOT EXISTS connection_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL REFERENCES users(telegram_id),
  recipient_id INTEGER NOT NULL REFERENCES users(telegram_id),
  post_id INTEGER REFERENCES posts(id),
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','rejected')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  responded_at TEXT,
  CHECK (requester_id <> recipient_id)
);

CREATE INDEX IF NOT EXISTS idx_connections_recipient_status
  ON connection_requests(recipient_id, status, created_at);

CREATE TABLE IF NOT EXISTS anonymous_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL REFERENCES users(telegram_id),
  recipient_id INTEGER REFERENCES users(telegram_id),
  message TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'chat',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_sender
  ON anonymous_messages(sender_id, created_at);

CREATE TABLE IF NOT EXISTS ads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL REFERENCES users(telegram_id),
  content TEXT,
  price_amount INTEGER,
  currency TEXT,
  payment_method TEXT,
  payment_reference TEXT,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','negotiating','awaiting_payment','paid','published','rejected')),
  channel_message_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS bot_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
