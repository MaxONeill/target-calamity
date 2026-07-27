/**
 * Migration runner — `npm run db:migrate`.
 *
 * Applies every `db/migrations/NNN_*.sql` file, in ascending filename order, that
 * has not already been recorded in the `schema_migrations` ledger. Re-running is
 * therefore IDEMPOTENT: already-applied files are skipped, so this is the safe
 * "re-run path for an already-initialised volume" the docker-compose header and
 * db/README describe.
 *
 * Two bootstrap paths converge on the same ledger, with no fragile baseline
 * heuristics:
 *
 *   1. Docker first boot — docker-compose mounts `db/migrations` into
 *      `docker-entrypoint-initdb.d`, which runs every `*.sql` once on an empty
 *      data dir. Each migration file SELF-REGISTERS (it ends with an
 *      `INSERT INTO schema_migrations ... ON CONFLICT DO NOTHING`), so a
 *      docker-initialised volume already has its ledger populated.
 *
 *   2. `npm run db:migrate` — this runner. It reads the ledger and applies only
 *      the files not yet in it. On a docker-initialised volume every shipped
 *      migration is already recorded, so a later `db:migrate` applies nothing
 *      until a genuinely new migration file is added; on a bare Postgres (managed
 *      host, hand-created DB) it applies the whole set from scratch.
 *
 * `.planned` files are NOT migrations (the suffix keeps both this runner and the
 * initdb hook from applying them). Only `^\d+_.*\.sql$` is picked up.
 *
 * Requires `DATABASE_URL`. Uses `pg` directly (no Kysely) — this is a plain SQL
 * script runner, not a typed query site.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'db',
  'migrations',
);

/** A file is a migration iff it is `NNN_something.sql` (excludes `.planned`). */
const MIGRATION_FILE = /^\d+_.*\.sql$/;

const LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => MIGRATION_FILE.test(name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    console.error(
      '[db:migrate] DATABASE_URL is not set. Set it (see .env.example) and retry; ' +
        'in seed mode there is no database to migrate.',
    );
    process.exit(1);
  }

  const pool = new Pool({ connectionString });
  try {
    // Ensure the ledger exists before we query it — a bare Postgres has none yet.
    await pool.query(LEDGER_DDL);

    const appliedRows = await pool.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations',
    );
    const applied = new Set(appliedRows.rows.map((r) => r.filename));

    const files = listMigrationFiles();
    if (files.length === 0) {
      console.warn(`[db:migrate] no migration files found in ${MIGRATIONS_DIR}`);
    }

    let appliedCount = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`[db:migrate] skip   ${file} (already applied)`);
        continue;
      }

      const sqlText = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sqlText);
        // The file self-registers, but record it here too so a migration that
        // forgets the self-insert is still tracked via this path.
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
          [file],
        );
        await client.query('COMMIT');
        appliedCount++;
        console.log(`[db:migrate] apply  ${file} (ok)`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        console.error(`[db:migrate] FAILED ${file}: ${String(err)}`);
        throw err;
      } finally {
        client.release();
      }
    }

    console.log(
      `[db:migrate] done — ${appliedCount} applied, ${files.length - appliedCount} already present.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[db:migrate] migration run failed:', err);
  process.exit(1);
});
