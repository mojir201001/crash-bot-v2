ALTER TABLE posts ADD COLUMN sender_username TEXT;
ALTER TABLE posts ADD COLUMN reply_to_post_id INTEGER REFERENCES posts(id);
ALTER TABLE posts ADD COLUMN approved_at TEXT;
ALTER TABLE posts ADD COLUMN admin_note TEXT;
ALTER TABLE posts ADD COLUMN source_message_id INTEGER;

ALTER TABLE anonymous_messages ADD COLUMN connection_id INTEGER REFERENCES connection_requests(id);

CREATE INDEX IF NOT EXISTS idx_posts_status_created
  ON posts(status, created_at, id);
CREATE INDEX IF NOT EXISTS idx_posts_user_created
  ON posts(user_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_posts_reply_to
  ON posts(reply_to_post_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_source_message
  ON posts(user_id, source_message_id)
  WHERE source_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_admin_queue_sender_created
  ON admin_queue(sender_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_publication_jobs_status_updated
  ON publication_jobs(status, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_connection_messages_connection
  ON anonymous_messages(connection_id, created_at, id);

CREATE TABLE IF NOT EXISTS post_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  queue_id INTEGER REFERENCES admin_queue(id),
  actor_id INTEGER,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'submitted', 'approved', 'rejected', 'publish_started',
      'published', 'publish_failed', 'publish_unknown', 'repost_queued',
      'publish_reconciled'
    )
  ),
  details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_post_events_post_created
  ON post_events(post_id, created_at, id);

CREATE TABLE IF NOT EXISTS deep_link_tokens (
  token TEXT PRIMARY KEY,
  token_type TEXT NOT NULL CHECK (
    token_type IN ('profile', 'reply', 'connect', 'post_history', 'connection', 'submit')
  ),
  entity_id INTEGER NOT NULL,
  intended_user_id INTEGER REFERENCES users(telegram_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_deep_link_tokens_expiry
  ON deep_link_tokens(expires_at);

CREATE TABLE IF NOT EXISTS user_conversations (
  user_id INTEGER PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  flow_type TEXT NOT NULL CHECK (
    flow_type IN ('post', 'reply', 'connection_confirm', 'connection_chat', 'profile_view')
  ),
  entity_id INTEGER,
  payload TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS moderation_confirmations (
  actor_id INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  queue_id INTEGER NOT NULL REFERENCES admin_queue(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, queue_id)
);

CREATE TABLE IF NOT EXISTS owner_repost_confirmations (
  actor_id INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, post_id)
);

CREATE TABLE IF NOT EXISTS owner_publication_confirmations (
  actor_id INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, post_id)
);

CREATE INDEX IF NOT EXISTS idx_user_conversations_flow
  ON user_conversations(flow_type, updated_at);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_id INTEGER NOT NULL REFERENCES users(telegram_id),
  operation_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'sending', 'sent', 'failed', 'unknown')
  ),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (recipient_id, operation_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_status
  ON notification_outbox(status, created_at, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_connection_requests_pending_unique
  ON connection_requests(requester_id, recipient_id, post_id)
  WHERE status = 'pending';

CREATE TRIGGER IF NOT EXISTS trg_post_queue_review_guard
BEFORE UPDATE OF status ON admin_queue
WHEN OLD.status = 'pending'
  AND NEW.status IN ('approved', 'rejected')
  AND NEW.item_type IN ('post', 'reply')
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM posts WHERE id = NEW.item_id AND status = 'pending'
    )
    THEN RAISE(ABORT, 'post is no longer pending')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_post_queue_review
AFTER UPDATE OF status ON admin_queue
WHEN OLD.status = 'pending'
  AND NEW.status IN ('approved', 'rejected')
  AND NEW.item_type IN ('post', 'reply')
BEGIN
  UPDATE posts
  SET status = NEW.status,
    reviewed_by = NEW.reviewed_by,
    reviewed_at = NEW.reviewed_at,
    approved_at = CASE
      WHEN NEW.status = 'approved' THEN NEW.reviewed_at
      ELSE approved_at
    END
  WHERE id = NEW.item_id AND status = 'pending';

  INSERT INTO review_decisions (queue_id, decision, decided_by)
  VALUES (NEW.id, NEW.status, NEW.reviewed_by);

  INSERT INTO post_events (post_id, queue_id, actor_id, event_type)
  VALUES (
    NEW.item_id, NEW.id, NEW.reviewed_by,
    CASE NEW.status WHEN 'approved' THEN 'approved' ELSE 'rejected' END
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_posts_enqueue
AFTER INSERT ON posts
BEGIN
  INSERT INTO admin_queue (item_type, item_id, sender_id)
  VALUES (
    CASE WHEN NEW.reply_to_post_id IS NULL THEN 'post' ELSE 'reply' END,
    NEW.id, NEW.user_id
  );
  INSERT INTO post_events (post_id, event_type)
  VALUES (NEW.id, 'submitted');
END;

CREATE TRIGGER IF NOT EXISTS trg_posts_repost_enqueue
AFTER UPDATE OF status ON posts
WHEN OLD.status = 'rejected' AND NEW.status = 'pending'
BEGIN
  INSERT INTO admin_queue (item_type, item_id, sender_id)
  VALUES (
    CASE WHEN NEW.reply_to_post_id IS NULL THEN 'post' ELSE 'reply' END,
    NEW.id, NEW.user_id
  );
  INSERT INTO post_events (post_id, queue_id, event_type)
  VALUES (NEW.id, last_insert_rowid(), 'repost_queued');
END;
