ALTER TABLE anonymous_messages ADD COLUMN source_message_id INTEGER;

CREATE UNIQUE INDEX idx_connection_source_message
  ON anonymous_messages(sender_id, source_message_id)
  WHERE message_type = 'connection' AND source_message_id IS NOT NULL;
