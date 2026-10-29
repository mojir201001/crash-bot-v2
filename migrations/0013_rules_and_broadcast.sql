ALTER TABLE advertising_messages ADD COLUMN read_at TEXT;

CREATE TABLE bot_rules_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  changed_by INTEGER NOT NULL REFERENCES users(telegram_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bot_rules_history_created
  ON bot_rules_history(created_at DESC, id DESC);

CREATE TABLE broadcast_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_by INTEGER NOT NULL REFERENCES users(telegram_id),
  content TEXT NOT NULL DEFAULT '',
  media_type TEXT,
  media_file_id TEXT,
  caption TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sending', 'paused', 'completed', 'unknown', 'cancelled')),
  recipient_count INTEGER NOT NULL DEFAULT 0 CHECK (recipient_count >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processing_token TEXT,
  processing_until TEXT,
  CHECK ((media_type IS NULL) = (media_file_id IS NULL)),
  CHECK (trim(content) <> '' OR media_file_id IS NOT NULL)
);

CREATE TABLE broadcast_deliveries (
  campaign_id INTEGER NOT NULL REFERENCES broadcast_campaigns(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'unknown')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_token TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (campaign_id, user_id)
);

CREATE INDEX idx_broadcast_deliveries_status
  ON broadcast_deliveries(campaign_id, status, user_id);

CREATE INDEX idx_broadcast_campaigns_status
  ON broadcast_campaigns(status, created_at DESC, id DESC);

CREATE UNIQUE INDEX idx_broadcast_single_active_campaign
  ON broadcast_campaigns(status) WHERE status = 'sending';
