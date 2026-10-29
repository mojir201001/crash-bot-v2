ALTER TABLE notification_outbox ADD COLUMN event_key TEXT;
ALTER TABLE notification_outbox ADD COLUMN message_snapshot TEXT;

UPDATE notification_outbox
SET status = 'unknown',
  last_error = 'Legacy pending notification may have been delivered before its status was saved',
  updated_at = CURRENT_TIMESTAMP
WHERE status = 'pending';

UPDATE notification_outbox
SET event_key = 'legacy:' || id
WHERE event_key IS NULL;

CREATE UNIQUE INDEX idx_notification_outbox_event_key
  ON notification_outbox(event_key);

CREATE TRIGGER notification_review_outbox
AFTER INSERT ON review_decisions
BEGIN
  INSERT INTO notification_outbox (
    recipient_id, operation_type, entity_id, event_key, message_snapshot
  )
  SELECT q.sender_id,
    'post_' || NEW.decision || ':' || NEW.id,
    q.item_id,
    'post-review:' || NEW.id,
    CASE NEW.decision
      WHEN 'rejected' THEN 'پیام ثبت‌شدهٔ شما رد شد.'
      ELSE 'پیام شما تأیید شده است؛ وضعیت انتشار در سابقه قابل مشاهده است.'
    END
  FROM admin_queue q
  WHERE q.id = NEW.queue_id
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER connection_request_outbox
AFTER INSERT ON connection_requests
WHEN NEW.status = 'pending'
BEGIN
  INSERT INTO notification_outbox (
    recipient_id, operation_type, entity_id, event_key
  ) VALUES (
    NEW.recipient_id, 'connection_request', NEW.id,
    'connection-request:' || NEW.id
  )
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER connection_decision_outbox
AFTER UPDATE OF status ON connection_requests
WHEN OLD.status = 'pending' AND NEW.status IN ('accepted', 'rejected')
BEGIN
  INSERT INTO notification_outbox (
    recipient_id, operation_type, entity_id, event_key, message_snapshot
  ) VALUES (
    NEW.requester_id, 'connection_decision', NEW.id,
    'connection-decision:' || NEW.id,
    CASE NEW.status
      WHEN 'accepted' THEN 'درخواست ارتباط پذیرفته شد. گفت‌وگوی رباتی فعال است.'
      ELSE 'درخواست ارتباط شما رد شد.'
    END
  )
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER connection_message_outbox
AFTER INSERT ON anonymous_messages
WHEN NEW.message_type = 'connection' AND NEW.connection_id IS NOT NULL
  AND NEW.recipient_id IS NOT NULL
BEGIN
  INSERT INTO notification_outbox (
    recipient_id, operation_type, entity_id, event_key, message_snapshot
  ) VALUES (
    NEW.recipient_id, 'connection_message', NEW.id,
    'connection-message:' || NEW.id,
    'پیام جدید در گفت‌وگوی فعال دریافت شد.' || char(10) || char(10) || NEW.message
  )
  ON CONFLICT DO NOTHING;
END;
