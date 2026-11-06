ALTER TABLE connection_requests ADD COLUMN ended_at TEXT;
ALTER TABLE connection_requests ADD COLUMN ended_by INTEGER REFERENCES users(telegram_id);

CREATE TABLE advertising_conversation_blocks (
  conversation_id INTEGER NOT NULL
    REFERENCES advertising_conversations(id) ON DELETE CASCADE,
  blocker_role TEXT NOT NULL CHECK (blocker_role IN ('requester', 'owner')),
  blocker_id INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (conversation_id, blocker_role)
);

CREATE INDEX idx_advertising_conversation_blocks_actor
  ON advertising_conversation_blocks(blocker_id, conversation_id);

INSERT OR IGNORE INTO advertising_conversation_blocks
  (conversation_id, blocker_role, blocker_id)
SELECT id,
  CASE WHEN blocked_by = requester_id THEN 'requester' ELSE 'owner' END,
  blocked_by
FROM advertising_conversations
WHERE blocked_by IS NOT NULL;
