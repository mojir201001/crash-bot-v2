CREATE TABLE anonymous_blocked_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_type TEXT NOT NULL CHECK (
    conversation_type IN ('random_chat', 'connection', 'personal_link', 'username')
  ),
  conversation_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  source_message_id INTEGER NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  media_type TEXT,
  media_file_id TEXT,
  caption TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'releasing', 'released')),
  notice_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (notice_status IN ('pending', 'sending', 'sent', 'failed', 'unknown')),
  released_message_id INTEGER REFERENCES anonymous_messages(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (sender_id <> recipient_id),
  CHECK ((media_type IS NULL) = (media_file_id IS NULL)),
  UNIQUE (conversation_type, conversation_id, sender_id, source_message_id)
);

CREATE INDEX idx_anonymous_blocked_messages_recipient
  ON anonymous_blocked_messages(recipient_id, status, id DESC);
