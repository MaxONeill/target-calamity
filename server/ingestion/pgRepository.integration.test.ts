/**
 * The ONE test that touches real SQL against the real schema.
 *
 * Every other ingestion test writes to `memoryRepository`, which is a plain
 * object graph with no constraints — so the whole suite passed while production
 * rejected every placed factor for a full commit. The gap was structural, not an
 * oversight: nothing exercised the INSERT statements, so a migration could add a
 * CHECK and no test could possibly notice.
 *
 * SKIPPED WITHOUT `DATABASE_URL`. `npm test` stays fully offline and
 * credential-free, exactly as CLAUDE.md promises. With a database present —
 * `npm run db:up`, or any local `npm run verify` — these run and catch schema
 * drift. No provider credentials are needed: inserting a factor makes no model
 * call, and the embedding here is a fixed stub vector.
 *
 * CLEANUP IS EXPLICIT, not a rollback. The repository's only write entry point
 * is `withBucketLock`, which owns its transaction and commits it — that is the
 * behaviour under test, so wrapping it in an outer transaction would test
 * something else. Every id created here is therefore deleted afterwards, in an
 * `afterEach` that runs even when an expectation failed.
 */
import { afterEach, afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createDatabase, type Database } from '../db.js';
import { createPgIngestionRepository } from './pgRepository.js';
import { locationKindFor } from './locationKind.js';
import type { NewFactorInput } from './ports.js';

const CONNECTION = process.env.DATABASE_URL?.trim();
const EMBEDDING_DIMS = 512;

// `describe.skipIf` rather than a silent early return: a skipped suite is
// visible in the run output, so "0 integration tests ran" cannot masquerade as
// "the integration tests passed".
const describeIfDb = describe.skipIf(!CONNECTION);

describeIfDb('pgRepository — real schema', () => {
  let db: Database;
  let close: () => Promise<void>;
  const created: string[] = [];

  beforeAll(() => {
    const c = createDatabase(CONNECTION ?? '');
    db = c.db;
    close = () => c.pool.end();
  });

  afterEach(async () => {
    for (const id of created.splice(0)) {
      // Children first — the test must not depend on how the FKs are declared.
      await sql`DELETE FROM citations WHERE factor_id = ${id}::uuid`.execute(db);
      await sql`DELETE FROM factor_revisions WHERE factor_id = ${id}::uuid`.execute(db);
      await sql`DELETE FROM factors WHERE id = ${id}::uuid`.execute(db);
    }
  });

  afterAll(async () => {
    await close();
  });

  const draft = (lat: number | null, lon: number | null): NewFactorInput => ({
    name: `[integration-test] placement ${String(lat)}`,
    description: 'Written by the integration suite and deleted immediately after.',
    effect: -0.5,
    significance: 0.5,
    lat,
    lon,
    locationKind: locationKindFor(lat),
    spatialPath: 'global',
    embedding: Array.from({ length: EMBEDDING_DIMS }, () => 0.01),
    verificationState: 'pending',
    domains: [],
    citation: {
      sourceUrl: 'https://example.org/integration-test',
      publisher: 'Integration Test',
      quoteSnippet: 'A quote that is never published.',
      contentHash: `integration-${String(lat)}-${String(Math.abs(lat ?? 0))}`,
    },
    revision: {
      effect: -0.5,
      significance: 0.5,
      directionality: null,
      reason: 'insert (integration test)',
    },
  });

  async function insert(input: NewFactorInput): Promise<string> {
    const repo = createPgIngestionRepository(db);
    const id = await repo.withBucketLock('integration-test', (tx) => tx.insertFactor(input));
    created.push(id);
    return id;
  }

  it('inserts a PLACED factor — the case migration 018 broke', async () => {
    // The regression itself. Before `location_kind` was written, this threw
    // `factors_location_kind_check` and ALL ingestion of placed factors failed.
    const id = await insert(draft(51.5, -0.12));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const { rows } = await sql<{ lat: number; location_kind: string }>`
      SELECT lat, location_kind FROM factors WHERE id = ${id}::uuid
    `.execute(db);
    expect(rows[0]?.location_kind).toBe('measured');
  });

  it('inserts a PLACELESS factor with a null kind', async () => {
    const id = await insert(draft(null, null));

    const { rows } = await sql<{ location_kind: string | null }>`
      SELECT location_kind FROM factors WHERE id = ${id}::uuid
    `.execute(db);
    expect(rows[0]?.location_kind).toBeNull();
  });

  it('the constraint is real: a coordinate without a kind is rejected', async () => {
    // Proves the two tests above are not passing merely because this database
    // lacks the constraint. If this INSERT ever succeeds, migration 018 has not
    // been applied here and their green is meaningless.
    await expect(
      sql`
        INSERT INTO factors (spatial_path, name, description, effect, significance, lat, lon)
        VALUES ('global'::ltree, '[integration-test] no kind', 'rejected', -0.1, 0.1, 10, 10)
      `.execute(db),
    ).rejects.toThrow(/location_kind/);
  });
});
