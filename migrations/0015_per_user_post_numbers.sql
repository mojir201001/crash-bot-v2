ALTER TABLE posts ADD COLUMN user_record_number INTEGER;

WITH numbered_posts AS (
  SELECT id,
    ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at, id) AS record_number
  FROM posts
)
UPDATE posts
SET user_record_number = (
  SELECT record_number
  FROM numbered_posts
  WHERE numbered_posts.id = posts.id
);

CREATE TABLE post_record_counters (
  user_id INTEGER PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  next_record_number INTEGER NOT NULL CHECK (next_record_number > 0)
);

INSERT INTO post_record_counters (user_id, next_record_number)
SELECT user_id, MAX(user_record_number) + 1
FROM posts
GROUP BY user_id;

CREATE UNIQUE INDEX idx_posts_user_record_number
  ON posts(user_id, user_record_number);

CREATE TRIGGER posts_assign_user_record_number
AFTER INSERT ON posts
WHEN NEW.user_record_number IS NULL
BEGIN
  INSERT INTO post_record_counters (user_id, next_record_number)
  VALUES (NEW.user_id, 2)
  ON CONFLICT(user_id) DO UPDATE SET
    next_record_number = next_record_number + 1;

  UPDATE posts
  SET user_record_number = (
    SELECT next_record_number - 1
    FROM post_record_counters
    WHERE user_id = NEW.user_id
  )
  WHERE id = NEW.id;
END;
