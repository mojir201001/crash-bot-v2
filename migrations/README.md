# D1 migrations

Apply schema changes only with Wrangler's D1 migration commands so the
`d1_migrations` ledger remains authoritative. Do not re-run a migration whose
name is already recorded in that table. Migration `0002` contains SQLite
`ALTER TABLE ... ADD COLUMN` statements and is intentionally not rewritten:
SQLite versions used by D1 do not provide a portable `ADD COLUMN IF NOT
EXISTS`, and changing an applied migration would make environments diverge.

If an environment has an unrecorded, partially applied `0002`, stop before
applying later migrations. First inspect the migration ledger and
`PRAGMA table_info(users)`, `PRAGMA table_info(posts)`, and
`PRAGMA table_info(anonymous_messages)` against every statement in `0002`.
Wrangler applies migrations transactionally and rolls back a failed migration;
an ordinary recorded application therefore needs no repair and later
migrations will be applied once. If SQL was run manually and the ledger is
missing or disagrees with the schema, stop writes and restore a D1 Time Travel
point or backup from before that manual run, then use Wrangler to apply the
complete migration sequence. Do not rerun `0002`, drop tables, or edit the
internal migration ledger by hand. If restoration is unavailable, require a
reviewed database-specific recovery plan before applying any migration.

Migration `0005` adds profile fields and persistent workflow state without
replacing existing profile or interest rows. `0006` adds integrity triggers
for interest media and workflow payloads. `0007` copies the legacy `location`
value to the new `city` field only when `city` is empty. All run through the
same Wrangler ledger and preserve existing records.

Migration `0008_posts_connections_and_links.sql` extends the existing posts,
moderation queue, publication jobs, connection requests, and message tables.
Insert triggers create a single shared queue record for each new post/reply and
preserve review/repost history. Its `ALTER TABLE` statements are forward-only.
If a database has an unrecorded partial `0008`, do not rerun it or edit the
ledger: inspect the migration ledger and affected table definitions, then
restore a consistent pre-migration D1 backup/Time Travel point before retrying
through Wrangler. Do not apply this migration remotely as part of local
development.

Channel publication and deep links require runtime settings; no production
values are supplied here. The expected names are `CRASH_CHANNEL_ID`,
`CRASH_CHANNEL_URL`, and `TELEGRAM_BOT_USERNAME`, or corresponding D1
`bot_settings` keys `crash_channel_id`, `crash_channel_url`, and
`telegram_bot_username`. The bot must be an administrator with publishing
rights in the configured channel. An ambiguous Telegram delivery is retained
as `unknown` and is never retried automatically. Only the owner can start the
manual recovery flow, and only after checking the channel for an existing post.

Before deployment, configure the Worker secrets `TELEGRAM_BOT_TOKEN` and
`WEBHOOK_SECRET`, and the required `OWNER_TELEGRAM_ID` runtime variable. Set
`TELEGRAM_BOT_USERNAME` plus `CRASH_CHANNEL_ID` and `CRASH_CHANNEL_URL` as
Worker variables or their documented D1 settings. Confirm the production D1
binding is the intended database and that the bot has the required channel
posting and forced-membership permissions. This repository configuration does
not declare the secret values, channel values, or owner ID.

Migration `0009_notification_retry_claims.sql` adds a compare-and-set claim
token and short-lived owner confirmation records for manual outbox retries. A
stale `sending` notification is treated as uncertain after 15 minutes and
requires the same explicit confirmation. This prevents parallel retries from
claiming one row, but Telegram does not offer an idempotency key: retrying an
uncertain delivery can still produce a duplicate notification.
As with other forward-only schema changes, inspect the migration ledger before
applying `0009`; do not rerun it manually or edit the ledger if the schema and
ledger disagree.

Migration `0010_notification_event_identity.sql` preserves existing outbox
rows and assigns legacy event keys. It marks pre-existing `pending`
notifications as `unknown` because earlier versions could have sent Telegram
requests before updating outbox state. New notifications receive a stable
event key and a snapshot of their notification text, so retries do not derive
the notification from a message's later moderation state. Database triggers
create outbox records in the same D1 transaction as moderation decisions,
connection request decisions, and connection messages; handlers then claim
and deliver those existing records.

Migration `0011_connection_message_idempotency.sql` adds the Telegram source
message identifier to connection-chat messages and a partial unique index.
This makes webhook redelivery idempotent for connection messages without
changing legacy records. Apply it only through Wrangler after confirming the
target database and migration ledger.

Migration `0012_random_chat_and_ad_inbox.sql` adds independent random-chat
membership, webhook deduplication, rate limits, delivery status, and private
advertising inbox tables. The `anonymous_sessions.updated_at` column uses a
constant default, backfills existing rows, and uses an insert trigger to set
timestamps for new sessions. SQLite does not permit `DEFAULT CURRENT_TIMESTAMP`
directly in `ALTER TABLE ADD COLUMN`. The inbox is a user-to-owner conversation
only; it does not implement pricing, payment, ad publication, or the legacy
`ads` workflow. It preserves existing tables and data.

Migration `0013_rules_and_broadcast.sql` adds the read marker and rules
version history plus persistent broadcast campaigns and per-recipient
delivery state. Broadcast recipients are snapshotted at confirmation from
users who started the bot, are active, are not blocked, and are not the owner
who created the campaign. Only one campaign can be in the sending state, and
sends are paced at no more than 20 per second in batches of 20. A stale or uncertain
Telegram delivery is marked `unknown`, not retried automatically; Telegram
does not provide an idempotency key. The same migration is applied by the
local D1 test harness during `npx vitest run`; do not apply it remotely as
part of development.

Migration `0014_anonymous_inbox_and_archives.sql` adds persistent anonymous
conversations, per-message inbox notifications, delivery/view state, and
indexes for the owner-only conversation archives. It tracks only Telegram
message IDs used to render the current archive page so that page navigation
can remove those display copies without touching stored history. It links new personal-link
and username messages to their conversation and removes the legacy
connection-message outbox trigger so new connection messages use the same
per-message inbox flow as other anonymous chats. Existing messages and outbox
rows are preserved; historical messages are not backfilled into the new inbox
because old delivery/view state cannot be inferred. The local D1 test harness
applies this migration during `npx vitest run`; do not apply it remotely as
part of development.

Migration `0015_per_user_post_numbers.sql` adds a per-sender record number to
each post/reply, backfills existing records in creation order, and seeds an
atomic counter for later inserts. The internal post ID remains the stable
identifier for callbacks and foreign keys; user-facing history and moderation
screens show the per-sender number. The unique `(user_id, user_record_number)`
index prevents duplicate numbers. If `0015` is partially applied but absent
from the migration ledger, do not rerun it or repair the ledger manually;
inspect the affected table, counter and trigger definitions, then restore a
consistent pre-migration backup/Time Travel point before applying the complete
migration through Wrangler. The local D1 test harness applies this migration;
it has not been applied to the remote database as part of development.

The management post archive and Excel export use `Asia/Tehran` for date
presentation. Excel export is owner-only and reads every post/reply by a
stable `(created_at, id)` cursor, with at most 1,000 rows materialized per
workbook and at most ten workbooks processed per Worker invocation. Larger
exports continue through an owner-only persisted callback; these are per-batch
working sizes, not a total-record ceiling. Post text remains capped at 2,000
characters per row, and columns, order, values, and formatting are preserved.
It includes the sender's numeric Telegram ID and username as stored when the
post/reply was submitted; credentials and environment values are excluded.
Cells are written as text and formula-like input is escaped. Each completed
part is tracked by its Telegram message reference; prior output messages are
deleted only after the replacement export has been completely delivered.

Migration `0016_conversation_replies_and_blocks.sql` adds the stored reply
target for anonymous messages, Telegram message IDs for inbox alerts,
conversation-scoped blocks, per-actor reply contexts and active conversation
selections, and tracking for temporary history display messages. It preserves
existing message and inbox rows. It is forward-only and must follow migrations
`0014` and `0015`; the local D1 test harness applies it during `npx vitest run`.
It has not been applied remotely as part of development. If it is partially
applied but missing from a database's migration ledger, do not rerun it or edit
the ledger manually. Inspect the ledger and affected table definitions, then
restore a consistent pre-migration backup/Time Travel point before applying
the complete sequence through Wrangler.

Migration `0017_blocked_message_review.sql` stores messages sent into a
conversation blocked by the recipient without exposing their content. The
recipient receives a private review action; only after choosing to unblock and
view is the message moved into the normal anonymous history and marked viewed.
This keeps block enforcement scoped to the existing conversation and preserves
the message for idempotent review. The local D1 test harness applies this
migration; it has not been applied remotely.

Migration `0018_advertising_chat_controls.sql` adds per-conversation advertising
blocks, per-message reply references, and a visibility state for messages held
until the recipient explicitly unblocks and views them. Messages previously
recorded as delivered are marked as already displayed; uncertain and failed
deliveries remain pending for an explicit view action. Existing message content
is preserved. The local D1 test harness applies this migration; do not apply it
remotely as part of development.

Migration `0019_anonymous_sender_echo.sql` tracks the sender-side display copy
independently from delivery to the recipient. Existing records are marked as
already displayed so applying the migration never replays historical messages.
New messages can therefore be echoed to their sender with controls while
duplicate webhook updates remain idempotent. It also stores references to the
owner-delivered Excel files and export progress. Data is read and sent in
bounded per-invocation chunks; old document messages are deleted only after
the replacement is complete. It also stores cursor state for owner-triggered
text archive exports and source Telegram message IDs for Excel requests, so
webhook redelivery cannot start the same export twice.
The local D1 test harness applies this migration; do not apply it remotely as
part of development.

Migration `0020_telegram_last_name.sql` adds the current Telegram last name to
the user identity record. Webhook updates refresh username and Telegram name
fields while the numeric Telegram ID remains the stable identity key. This
migration is local/test-only in this work and must not be applied remotely
without explicit approval.

Persistent `bot_settings` values may contain operational settings such as
`bot_enabled`, `bot_rules_text`, and non-secret channel configuration. Bot
tokens, webhook secrets, and the owner ID remain environment-only and are
never rendered in the settings panel. When `bot_enabled` is `0` or invalid,
ordinary users retain only `/start`, `/menu`, help/rules, and membership
verification; owner and staff access remains available for recovery.

If a migration is unrecorded but partly applied in an environment, do not
rerun it or alter `d1_migrations`. Inspect the ledger and affected table
definitions, then restore a consistent pre-migration backup/Time Travel point
before applying the complete sequence with Wrangler. If the ledger and schema
disagree and restoration is unavailable, stop and require a reviewed,
database-specific recovery plan.
