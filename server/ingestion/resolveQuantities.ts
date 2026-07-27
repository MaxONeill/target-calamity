/**
 * Resolve each quantity-stated threshold to the projection that dates it.
 *
 * Quantity identity is a semantic problem, and the data proves it: four
 * thresholds produced four different strings for one or two quantities —
 * "global warming", "global mean temperature increase", "global mean
 * temperature increase above pre-industrial". Exact matching cannot join those,
 * so four near-duplicate curves were fetched where one would do, and a
 * threshold whose wording drifts from its curve simply goes undated.
 *
 * This is the same problem factor dedupe already solves, so it uses the same
 * machinery: embed, k-NN by cosine over `projections.embedding`, accept only
 * inside a distance ceiling. The winner's id is written to
 * `tipping_point.quantityThreshold.projectionId`, which `deriveClock` prefers
 * over its string fallback.
 *
 *   npm run resolve:quantities              # embed and match
 *   npm run resolve:quantities -- --limit 5 # cap work (cost)
 *   DRY_RUN=1 npm run resolve:quantities    # report only, no calls, no writes
 *
 * Use DRY_RUN=1 rather than --plan or --dry-run: npm eats flags it recognises
 * before the script sees them, and both have been observed not to arrive.
 *
 * Matching is NOT purely semantic. Unit and baseline must still agree, because
 * "1.5 degC above pre-industrial" and "1.5 degC above 1986-2005" are the same
 * quantity ~0.6 degC apart. Embeddings would happily call those identical; the
 * hard checks are what stop a semantically-perfect match producing a
 * confidently wrong year.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import { createDatabase, type Database } from '../db.js';
import { notifyFieldChanged } from './notifyFieldChanged.js';
import { createEmbeddingClient } from './embeddings.js';
import { hasLiveCredentials } from './llmClient.js';

/**
 * Cosine-distance ceiling for accepting a projection as "the same quantity".
 *
 * Tighter than the factor dedupe ceiling (0.30) on purpose. A wrong factor
 * merge is visible in the feed; a wrong quantity match silently dates a
 * threshold off someone else's curve, and nothing about the result looks wrong.
 * Beyond this the threshold stays undated, which is the recoverable failure.
 */
const QUANTITY_DISTANCE_CEILING = 0.18;

interface ProjectionRow {
  id: string;
  quantity: string;
  unit: string;
  baseline: string | null;
  has_embedding: boolean;
}

interface ThresholdRow {
  id: string;
  name: string;
  quantity: string;
  unit: string;
  baseline: string | null;
  projection_id: string | null;
}

const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

async function projectionRows(db: Database): Promise<ProjectionRow[]> {
  const { rows } = await sql<ProjectionRow>`
    SELECT id, quantity, unit, baseline, (embedding IS NOT NULL) AS has_embedding
      FROM projections ORDER BY id
  `.execute(db);
  return rows;
}

async function thresholdRows(db: Database): Promise<ThresholdRow[]> {
  const { rows } = await sql<ThresholdRow>`
    SELECT id, name,
           tipping_point->'quantityThreshold'->>'quantity'     AS quantity,
           tipping_point->'quantityThreshold'->>'unit'         AS unit,
           tipping_point->'quantityThreshold'->>'baseline'     AS baseline,
           tipping_point->'quantityThreshold'->>'projectionId' AS projection_id
      FROM factors
     WHERE tipping_point ? 'quantityThreshold'
     ORDER BY id
  `.execute(db);
  return rows.filter((r) => r.quantity !== null && r.unit !== null);
}

/** Nearest projections by cosine, index-served k-NN (same shape as dedupe). */
async function nearestProjections(
  db: Database,
  embedding: number[],
): Promise<{ id: string; distance: number }[]> {
  const vec = `[${embedding.join(',')}]`;
  const { rows } = await sql<{ id: string; distance: number }>`
    SELECT id, (embedding <=> ${vec}::halfvec) AS distance
      FROM projections
     WHERE embedding IS NOT NULL
     ORDER BY embedding <=> ${vec}::halfvec
     LIMIT 10
  `.execute(db);
  return rows;
}

export async function resolveQuantities(
  logger: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    logger.warn('[resolve] no DATABASE_URL — nothing to do, exiting.');
    return;
  }
  if (!hasLiveCredentials()) {
    logger.warn(
      '[resolve] no FIREWORKS_API_KEY — the stub embedding client is non-semantic, ' +
        'so matching on it would pair unrelated quantities. Exiting; thresholds ' +
        'fall back to exact string matching.',
    );
    return;
  }

  const args = process.argv.slice(2);
  const dryRun =
    args.includes('--plan') || args.includes('--dry-run') || process.env.DRY_RUN === '1';
  const limitArg = args.indexOf('--limit');
  const limit = limitArg >= 0 ? Number.parseInt(args[limitArg + 1] ?? '', 10) : NaN;

  const { db, pool } = createDatabase(databaseUrl);
  try {
    const projections = await projectionRows(db);
    let thresholds = await thresholdRows(db);
    if (Number.isFinite(limit) && limit > 0) thresholds = thresholds.slice(0, limit);

    const needEmbedding = projections.filter((p) => !p.has_embedding);
    logger.info(
      `[resolve] ${projections.length} projection(s), ${needEmbedding.length} unembedded; ` +
        `${thresholds.length} quantity threshold(s).`,
    );
    if (dryRun) {
      for (const t of thresholds) {
        logger.info(
          `[resolve]   ${t.projection_id ? 'resolved' : 'UNRESOLVED'}  ` +
            `${t.quantity} (${t.unit})${t.baseline ? ` vs ${t.baseline}` : ''} · ${t.name.slice(0, 40)}`,
        );
      }
      logger.info('[resolve] dry run — no calls, no writes.');
      return;
    }

    const embeddings = createEmbeddingClient(process.env);

    // Embed the projections' quantity wording, not the whole row: what is being
    // matched is "what is measured", and folding in scenario or source text
    // would pull two curves of the same quantity apart.
    for (const p of needEmbedding) {
      const [vector] = await embeddings.embed([`${p.quantity} (${p.unit})`]);
      if (!vector) continue;
      await sql`
        UPDATE projections SET embedding = ${`[${vector.join(',')}]`}::halfvec
         WHERE id = ${p.id}::uuid
      `.execute(db);
      logger.info(`[resolve] embedded projection "${p.quantity}"`);
    }

    let matched = 0;
    let unmatched = 0;
    for (const t of thresholds) {
      const [vector] = await embeddings.embed([`${t.quantity} (${t.unit})`]);
      if (!vector) continue;

      const candidates = await nearestProjections(db, vector);
      const byId = new Map(projections.map((p) => [p.id, p]));

      // Semantic proximity proposes; unit and baseline dispose. Embeddings will
      // happily rate two baselines identical — they read as the same sentence —
      // which is exactly the mistake that produces a wrong year.
      const winner = candidates.find((c) => {
        if (c.distance > QUANTITY_DISTANCE_CEILING) return false;
        const p = byId.get(c.id);
        if (!p) return false;
        return norm(p.unit) === norm(t.unit) && norm(p.baseline) === norm(t.baseline);
      });

      if (!winner) {
        unmatched += 1;
        const nearest = candidates[0];
        logger.warn(
          `[resolve] no match for "${t.quantity}" (${t.unit})` +
            `${t.baseline ? ` vs ${t.baseline}` : ''} — left undated` +
            (nearest ? ` (nearest distance ${nearest.distance.toFixed(3)})` : ''),
        );
        continue;
      }

      await sql`
        UPDATE factors
           SET tipping_point = jsonb_set(
                 tipping_point, '{quantityThreshold,projectionId}', ${sql.val(JSON.stringify(winner.id))}::jsonb
               )
         WHERE id = ${t.id}::uuid
      `.execute(db);
      matched += 1;
      logger.info(
        `[resolve] ${t.quantity} → ${byId.get(winner.id)?.quantity} ` +
          `(distance ${winner.distance.toFixed(3)}) · ${t.name.slice(0, 40)}`,
      );
    }

    logger.info(`[resolve] done — ${matched} resolved, ${unmatched} left undated.`);
    // Open clients fetched the field once; without this they keep rendering
    // the values this run replaced.
    await notifyFieldChanged(db);
  } finally {
    await pool.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  resolveQuantities().catch((err: unknown) => {
    console.error('[resolve] fatal:', err);
    process.exitCode = 1;
  });
}
