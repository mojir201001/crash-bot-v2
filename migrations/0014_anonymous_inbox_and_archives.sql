CREATE TABLE anonymous_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_a_id INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  user_b_id INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (
    source_type IN ('personal_link', 'username')
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TEXT,
  CHECK (user_a_id < user_b_id),
  UNIQUE (user_a_id, user_b_id, source_type)
);

CREATE INDEX idx_anonymous_conversations_source_updated
  ON anonymous_conversations(source_type, updated_at DESC, id DESC);

CREATE TABLE anonymous_personal_links (
  user_id INTEGER PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE anonymous_chat_states (
  user_id INTEGER PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('username_lookup', 'username_message', 'active')),
  target_user_id INTEGER REFERENCES users(telegram_id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES anonymous_conversations(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (state = 'username_lookup' AND target_user_id IS NULL AND conversation_id IS NULL)
    OR
    (state = 'username_message' AND target_user_id IS NOT NULL AND conversation_id IS NULL)
    OR
    (state = 'active' AND conversation_id IS NOT NULL)
  )
);

CREATE TABLE anonymous_message_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL UNIQUE
    REFERENCES anonymous_messages(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (
    source_type IN ('random_chat', 'connection', 'personal_link', 'username')
  ),
  delivery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'sending', 'sent', 'failed', 'unknown')),
  viewed_at TEXT,
  sender_notice_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (sender_notice_status IN ('pending', 'sending', 'sent', 'failed', 'unknown')),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_anonymous_message_inbox_unread
  ON anonymous_message_inbox(recipient_id, viewed_at, id DESC);

CREATE TABLE owner_archive_display_messages (
  owner_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  PRIMARY KEY (owner_id, message_id)
);

ALTER TABLE anonymous_messages
  ADD COLUMN conversation_id INTEGER REFERENCES anonymous_conversations(id);

CREATE UNIQUE INDEX idx_anonymous_private_source_message
  ON anonymous_messages(sender_id, source_message_id)
  WHERE message_type IN ('personal_link', 'username') AND source_message_id IS NOT NULL;

CREATE INDEX idx_anonymous_messages_conversation
  ON anonymous_messages(conversation_id, created_at, id);

DROP TRIGGER IF EXISTS connection_message_outbox;
