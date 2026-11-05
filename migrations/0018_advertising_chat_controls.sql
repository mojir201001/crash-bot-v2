ALTER TABLE advertising_conversations
  ADD COLUMN blocked_by INTEGER REFERENCES users(telegram_id);

ALTER TABLE advertising_conversation_state
  ADD COLUMN reply_to_message_id INTEGER REFERENCES advertising_messages(id);

ALTER TABLE advertising_messages
  ADD COLUMN reply_to_message_id INTEGER REFERENCES advertising_messages(id);

ALTER TABLE advertising_messages
  ADD COLUMN visibility_status TEXT NOT NULL DEFAULT 'visible'
  CHECK (visibility_status IN ('visible', 'blocked'));

ALTER TABLE advertising_messages
  ADD COLUMN view_delivery_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (view_delivery_status IN ('pending', 'sending', 'sent', 'failed', 'unknown'));

UPDATE advertising_messages
SET view_delivery_status = 'sent'
WHERE delivery_status = 'sent';
