ALTER TABLE anonymous_sessions ADD COLUMN ended_reason TEXT;
-- SQLite requires a constant default when adding a column.
ALTER TABLE anonymous_sessions ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
UPDATE anonymous_sessions
SET updated_at = CURRENT_TIMESTAMP
WHERE updated_at = '';

CREATE TRIGGER anonymous_sessions_set_updated_at
AFTER INSERT ON anonymous_sessions
WHEN NEW.updated_at = ''
BEGIN
  UPDATE anonymous_sessions
  SET updated_at = CURRENT_TIMESTAMP
  WHERE id = NEW.id;
END;
ALTER TABLE anonymous_sessions ADD COLUMN notice_a_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (notice_a_status IN ('pending', 'sending', 'sent', 'failed', 'unknown'));
ALTER TABLE anonymous_sessions ADD COLUMN notice_b_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (notice_b_status IN ('pending', 'sending', 'sent', 'failed', 'unknown'));

ALTER TABLE anonymous_messages ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'sent'
  CHECK (delivery_status IN ('pending', 'sending', 'sent', 'failed', 'unknown'));
ALTER TABLE anonymous_messages ADD COLUMN delivery_error TEXT;

CREATE TABLE anonymous_chat_members (
  user_id INTEGER PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES anonymous_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('a', 'b')),
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (session_id, role)
);

INSERT OR IGNORE INTO anonymous_chat_members (user_id, session_id, role)
SELECT user_a_id, id, 'a' FROM anonymous_sessions
WHERE status IN ('waiting', 'active');

INSERT OR IGNORE INTO anonymous_chat_members (user_id, session_id, role)
SELECT user_b_id, id, 'b' FROM anonymous_sessions
WHERE status = 'active' AND user_b_id IS NOT NULL;

CREATE INDEX idx_anonymous_chat_members_session
  ON anonymous_chat_members(session_id, role);

CREATE TABLE anonymous_chat_actions (
  user_id INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  source_message_id INTEGER NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('search', 'cancel', 'end')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, source_message_id)
);

CREATE TABLE random_chat_rate_limits (
  user_id INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN ('search', 'message')),
  window_started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  action_count INTEGER NOT NULL DEFAULT 1 CHECK (action_count > 0),
  PRIMARY KEY (user_id, action_type)
);

CREATE UNIQUE INDEX idx_random_chat_source_message
  ON anonymous_messages(sender_id, source_message_id)
  WHERE message_type = 'random_chat' AND source_message_id IS NOT NULL;

CREATE INDEX idx_anonymous_sessions_status_created
  ON anonymous_sessions(status, created_at, id);

CREATE TABLE advertising_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL UNIQUE REFERENCES users(telegram_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE advertising_conversation_state (
  actor_id INTEGER PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES advertising_conversations(id) ON DELETE CASCADE,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('requester', 'owner')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE advertising_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES advertising_conversations(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(telegram_id),
  sender_role TEXT NOT NULL CHECK (sender_role IN ('requester', 'owner')),
  message TEXT NOT NULL DEFAULT '',
  media_type TEXT,
  media_file_id TEXT,
  caption TEXT,
  source_message_id INTEGER,
  delivery_status TEXT NOT NULL DEFAULT 'received'
    CHECK (delivery_status IN ('received', 'sending', 'sent', 'failed', 'unknown')),
  delivery_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((media_type IS NULL) = (media_file_id IS NULL))
);

CREATE UNIQUE INDEX idx_advertising_source_message
  ON advertising_messages(sender_id, source_message_id)
  WHERE source_message_id IS NOT NULL;

CREATE INDEX idx_advertising_messages_conversation
  ON advertising_messages(conversation_id, created_at, id);

CREATE INDEX idx_advertising_conversations_updated
  ON advertising_conversations(updated_at DESC, id DESC);
