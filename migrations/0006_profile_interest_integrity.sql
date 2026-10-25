CREATE TRIGGER IF NOT EXISTS interests_validate_insert
BEFORE INSERT ON interests
WHEN trim(NEW.category) = ''
  OR (NEW.media_type IS NOT NULL AND NEW.media_type NOT IN (
    'photo', 'video', 'document', 'audio', 'voice', 'animation',
    'video_note', 'sticker'
  ))
  OR (NEW.media_file_id IS NOT NULL AND trim(NEW.media_file_id) = '')
  OR ((NEW.media_type IS NULL) <> (NEW.media_file_id IS NULL))
  OR (
    trim(coalesce(NEW.content, '')) = ''
    AND trim(coalesce(NEW.caption, '')) = ''
    AND NEW.media_file_id IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid interest content or media');
END;

CREATE TRIGGER IF NOT EXISTS interests_validate_update
BEFORE UPDATE OF category, content, media_type, media_file_id, caption ON interests
WHEN trim(NEW.category) = ''
  OR (NEW.media_type IS NOT NULL AND NEW.media_type NOT IN (
    'photo', 'video', 'document', 'audio', 'voice', 'animation',
    'video_note', 'sticker'
  ))
  OR (NEW.media_file_id IS NOT NULL AND trim(NEW.media_file_id) = '')
  OR ((NEW.media_type IS NULL) <> (NEW.media_file_id IS NULL))
  OR (
    trim(coalesce(NEW.content, '')) = ''
    AND trim(coalesce(NEW.caption, '')) = ''
    AND NEW.media_file_id IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid interest content or media');
END;

CREATE TRIGGER IF NOT EXISTS user_workflows_validate_insert
BEFORE INSERT ON user_workflows
WHEN trim(NEW.stage) = ''
  OR CASE
    WHEN json_valid(NEW.payload) THEN json_type(NEW.payload) <> 'object'
    ELSE 1
  END
BEGIN
  SELECT RAISE(ABORT, 'invalid workflow stage or payload');
END;

CREATE TRIGGER IF NOT EXISTS user_workflows_validate_update
BEFORE UPDATE OF flow_type, stage, payload ON user_workflows
WHEN trim(NEW.stage) = ''
  OR CASE
    WHEN json_valid(NEW.payload) THEN json_type(NEW.payload) <> 'object'
    ELSE 1
  END
BEGIN
  SELECT RAISE(ABORT, 'invalid workflow stage or payload');
END;
