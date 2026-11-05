ALTER TABLE anonymous_messages
  ADD COLUMN sender_display_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (sender_display_status IN ('pending', 'sending', 'sent', 'failed', 'unknown'));

ALTER TABLE anonymous_messages
  ADD COLUMN sender_display_message_id INTEGER;

UPDATE anonymous_messages
SET sender_display_status = 'sent'
WHERE sender_display_status = 'pending';

CREATE TABLE owner_export_documents (
  owner_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  export_token TEXT,
  status TEXT NOT NULL DEFAULT 'current'
    CHECK (status IN ('current', 'staging')),
  delete_attempted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_id, message_id)
);

CREATE TABLE owner_export_jobs (
  token TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  source_message_id INTEGER,
  max_id INTEGER NOT NULL,
  total_rows INTEGER NOT NULL,
  exported_rows INTEGER NOT NULL DEFAULT 0,
  cursor_created_at TEXT,
  cursor_id INTEGER,
  next_part INTEGER NOT NULL DEFAULT 1,
  part_count INTEGER NOT NULL,
  export_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'cleaning', 'unknown', 'complete')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX owner_export_source_message
  ON owner_export_jobs(owner_id, source_message_id)
  WHERE source_message_id IS NOT NULL;

CREATE UNIQUE INDEX owner_export_one_active_job
  ON owner_export_jobs(owner_id)
  WHERE status IN ('pending', 'sending', 'cleaning');

CREATE TABLE owner_archive_text_exports (
  token TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL,
  archive_type TEXT NOT NULL CHECK (archive_type IN ('anonymous', 'posts')),
  source_type TEXT NOT NULL CHECK (
    source_type IN ('random_chat', 'personal_link', 'username', 'connection')
  ),
  entity_id INTEGER NOT NULL,
  cursor_created_at TEXT,
  cursor_message_id INTEGER,
  part_number INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'unknown')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX owner_archive_text_exports_owner
  ON owner_archive_text_exports(owner_id, updated_at);
