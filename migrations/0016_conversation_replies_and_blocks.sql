ALTER TABLE anonymous_messages
  ADD COLUMN reply_to_message_id INTEGER REFERENCES anonymous_messages(id);

ALTER TABLE anonymous_message_inbox
  ADD COLUMN telegram_message_id INTEGER;

CREATE TABLE conversation_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_type TEXT NOT NULL CHECK (
    conversation_type IN ('random_chat', 'connection', 'personal_link', 'username')
  ),
  conversation_id INTEGER NOT NULL,
  blocker_id INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (blocker_id <> blocked_id),
  UNIQUE (conversation_type, conversation_id, blocker_id)
);

CREATE INDEX idx_conversation_blocks_peer
  ON conversation_blocks(conversation_type, blocked_id, blocker_id);

CREATE TABLE conversation_reply_contexts (
  actor_id INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES anonymous_messages(id) ON DELETE CASCADE,
  conversation_type TEXT NOT NULL CHECK (
    conversation_type IN ('random_chat', 'connection', 'personal_link', 'username')
  ),
  conversation_id INTEGER NOT NULL,
  peer_id INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (actor_id <> peer_id),
  PRIMARY KEY (actor_id, conversation_type, conversation_id, peer_id)
);

CREATE INDEX idx_conversation_reply_contexts_expiry
  ON conversation_reply_contexts(expires_at);

CREATE TABLE conversation_display_messages (
  actor_id INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL,
  conversation_type TEXT NOT NULL CHECK (
    conversation_type IN ('random_chat', 'connection', 'personal_link', 'username')
  ),
  conversation_id INTEGER NOT NULL,
  PRIMARY KEY (actor_id, message_id)
);

CREATE TABLE active_conversation_selections (
  actor_id INTEGER PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  conversation_type TEXT NOT NULL CHECK (
    conversation_type IN ('random_chat', 'connection', 'personal_link', 'username')
  ),
  conversation_id INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
