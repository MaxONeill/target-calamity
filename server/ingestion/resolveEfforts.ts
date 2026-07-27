/**
 * Route each requirement to the counter-efforts already in the factor set.
 *
 * The contingency tree says what reversing a crossed threshold would take. Its
 * leaves are the actionable end of the product — and the factor set already
 * holds Humanity factors describing work on exactly those things, which until
 * now were only weight in an aggregate. This is the join that turns a detector
 * into a router.
 *
 *   npm run resolve:efforts             # embed requirements and match
 *   DRY_RUN=1 npm run resolve:efforts   # report only, no calls, no writes
 *   FORCE=1 npm run resolve:efforts     # re-match everything
 *
 * COST: NO RETRIEVAL. Embeddings only, over rows that already exist — one small
 * vector per unembedded requirement, then an index-served k-NN each. Cheap
 * enough to re-run freely, unlike anything that goes out and reads the web.
 *
 * WHAT A MATCH MEANS: that a requirement's wording and a factor's are
 * semantically close. NOT that the factor satisfies the requirement. The
 * distance is stored and the UI presents these as related work, because
 * overstating the link would be the same failure as an invented dependency,
 * only dressed as helpfulness.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import { createDatabase, type Database } from '../db.js';
import { notifyFieldChanged } from './notifyFieldChanged.js';
import { createEmbeddingClient } from './embeddings.js';
import { hasLiveCredentials } from './llmClient.js';

/**
 * Cosine-distance ceiling for calling a factor relevant to a requirement.
 *
 * Looser than the quantity resolver's 0.18, because that match DATES a
 * threshold — a wrong one produces a confidently wrong year — while this one
 * only suggests reading. But not open-ended: a page of vaguely-related links
 * is worse than none, since it teaches a reader the routing is noise.
 */
const EFFORT_DISTANCE_CEILING = 0.32;

/** Efforts kept per requirement. Beyond a few, this stops being a route. */
const MAX_EFFORTS = 3;

interface RequirementRow {
  id: string;
  statement: string;
  has_embedding: boolean;
}

async function requirementRows(db: Database, force: boolean): Promise<RequirementRow[]> {
  const { rows } = await sql<RequirementRow>`
    SELECT r.id, r.statement, (r.embedding IS NOT NULL) AS has_embedding
      FROM requirements r
     WHERE ${force} OR NOT EXISTS (
       SELECT 1 FROM requirement_efforts e WHERE e.requirement_id = r.id
     )
     ORDER BY r.depth, r.id
  `.execute(db);
  return rows;
}

/**
 * Nearest HUMANITY factors, index-served.
 *
 * Restricted to `effect > 0` because a requirement is a thing that needs doing,
 * and the counter-effort is what is being done about it. A Calamity factor may
 * be semantically adjacent — "coral bleaching" is close to "coral restoration" —
 * and routing a reader to the problem when they asked for the work would invert
 * the whole point.
 */
async function nearestEfforts(
  db: Database,
  embedding: number[],
): Promise<{ id: string; name: string; distance: number }[]> {
  const vec = `[${embedding.join(',')}]`;
  const { rows } = await sql<{ id: string; name: string; distance: number }>`
    SELECT id, name, (embedding <=> ${vec}::halfvec) AS distance
      FROM factors
     WHERE embedding IS NOT NULL
       AND effect > 0
       AND verification_state = 'verified'
     ORDER BY embedding <=> ${vec}::halfvec
     LIMIT 10
  `.execute(db);
  return rows;
}

export async function resolveEfforts(
  logger: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    logger.warn('[efforts] no DATABASE_URL — nothing to do, exiting.');
    return;
  }
  if (!hasLiveCredentials()) {
    logger.warn(
      '[efforts] no FIREWORKS_API_KEY — the stub embedding client is non-semantic, ' +
        'so matching on it would route readers to unrelated work. Exiting.',
    );
    return;
  }

  const args = process.argv.slice(2);
  const dryRun =
    args.includes('--plan') || args.includes('--dry-run') || process.env.DRY_RUN === '1';
  const force = args.includes('--force') || process.env.FORCE === '1';

  const { db, pool } = createDatabase(databaseUrl);
  try {
    const rows = await requirementRows(db, force);
    logger.info(
      `[efforts] ${rows.length} requirement(s) to route. Embeddings only — no retrieval.`,
    );
    if (dryRun || rows.length === 0) {
      for (const r of rows) logger.info(`[efforts]   ${r.statement.slice(0, 70)}`);
      logger.info(dryRun ? '[efforts] dry run — no calls, no writes.' : '[efforts] nothing to do.');
      return;
    }

    const embeddings = createEmbeddingClient(process.env);
    let matched = 0;
    let unmatched = 0;

    for (const r of rows) {
      const [vector] = await embeddings.embed([r.statement]);
      if (!vector) continue;

      if (!r.has_embedding) {
        await sql`
          UPDATE requirements SET embedding = ${`[${vector.join(',')}]`}::halfvec
           WHERE id = ${r.id}::uuid
        `.execute(db);
      }

      const candidates = (await nearestEfforts(db, vector))
        .filter((c) => c.distance <= EFFORT_DISTANCE_CEILING)
        .slice(0, MAX_EFFORTS);

      if (force) {
        await sql`DELETE FROM requirement_efforts WHERE requirement_id = ${r.id}::uuid`.execute(db);
      }

      if (candidates.length === 0) {
        unmatched += 1;
        // Worth logging rather than passing over: a requirement nothing in the
        // set addresses is a GAP in what the tracker knows about, and the list
        // of those is a genuinely useful artifact.
        logger.warn(`[efforts] nothing tracked addresses "${r.statement.slice(0, 60)}"`);
        continue;
      }

      for (const c of candidates) {
        await sql`
          INSERT INTO requirement_efforts (requirement_id, factor_id, distance)
          VALUES (${r.id}::uuid, ${c.id}::uuid, ${c.distance})
          ON CONFLICT (requirement_id, factor_id) DO UPDATE SET distance = EXCLUDED.distance
        `.execute(db);
        matched += 1;
        logger.info(
          `[efforts] ${r.statement.slice(0, 44)} → ${c.name.slice(0, 44)} ` +
            `(${c.distance.toFixed(3)})`,
        );
      }
    }

    logger.info(
      `[efforts] done — ${matched} link(s); ${unmatched} requirement(s) with nothing tracked.`,
    );
    await notifyFieldChanged(db);
  } finally {
    await pool.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  resolveEfforts().catch((err: unknown) => {
    console.error('[efforts] fatal:', err);
    process.exitCode = 1;
  });
}
