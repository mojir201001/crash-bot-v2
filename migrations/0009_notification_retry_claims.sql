ALTER TABLE notification_outbox ADD COLUMN claim_token TEXT;

CREATE TABLE notification_retry_confirmations (
  actor_id INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  notification_id INTEGER NOT NULL REFERENCES notification_outbox(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, notification_id)
);

CREATE INDEX idx_notification_retry_confirmations_expiry
  ON notification_retry_confirmations(expires_at);
