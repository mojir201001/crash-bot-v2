ALTER TABLE profiles ADD COLUMN city TEXT;
ALTER TABLE profiles ADD COLUMN religious_sect TEXT;

ALTER TABLE interests ADD COLUMN category TEXT NOT NULL DEFAULT 'سایر موارد';
ALTER TABLE interests ADD COLUMN media_type TEXT;
ALTER TABLE interests ADD COLUMN media_file_id TEXT;
ALTER TABLE interests ADD COLUMN caption TEXT;

CREATE INDEX IF NOT EXISTS idx_interests_user_category_created
  ON interests(user_id, category, created_at, id);

CREATE TABLE IF NOT EXISTS user_workflows (
  user_id INTEGER PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  flow_type TEXT NOT NULL CHECK (flow_type IN ('profile', 'interests')),
  stage TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_workflows_type_updated
  ON user_workflows(flow_type, updated_at);
