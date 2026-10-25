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
