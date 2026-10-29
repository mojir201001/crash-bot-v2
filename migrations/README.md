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
advertising inbox tables. The inbox is a user-to-owner conversation only; it
does not implement pricing, payment, ad publication, or the legacy `ads`
workflow. It preserves existing tables and data.

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

The management post archive and Excel export use `Asia/Tehran` for date
presentation. Excel export is owner-only and includes at most 500 newest
posts/replies, with post text capped at 2,000 characters per row. It excludes
Telegram user IDs, usernames, credentials, and environment values; cells are
written as text and formula-like input is escaped. No spreadsheet is retained
after it is sent.

Persistent `bot_settings` values may contain operational settings such as
`bot_enabled`, `bot_rules_text`, and non-secret channel configuration. Bot
tokens, webhook secrets, and the owner ID remain environment-only and are
never rendered in the settings panel. When `bot_enabled` is `0` or invalid,
ordinary users retain only `/start`, `/menu`, help/rules, and membership
verification; owner and staff access remains available for recovery.

If `0012` or `0013` is unrecorded but partly applied in an environment, do not
rerun it or alter `d1_migrations`. Inspect the ledger and affected table
definitions, then restore a consistent pre-migration backup/Time Travel point
before applying the complete sequence with Wrangler. If the ledger and schema
disagree and restoration is unavailable, stop and require a reviewed,
database-specific recovery plan.
