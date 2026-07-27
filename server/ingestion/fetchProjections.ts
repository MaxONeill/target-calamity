/**
 * Fill in the projections that quantity-stated thresholds need.
 *
 * Reads every `tipping_point.quantityThreshold` in the factor set, works out
 * which (quantity, unit) pairs have no usable projection yet, and researches
 * one per pair. Retrieval is per DISTINCT QUANTITY, not per factor — every
 * climate threshold collapses onto a handful of quantities, so this is tens of
 * calls across the whole set rather than hundreds.
 *
 *   npm run ingest:projections               # fetch what is missing
 *   npm run ingest:projections -- --plan     # list what is missing, no calls
 *   npm run ingest:projections -- --limit 3  # cap the number fetched (cost)
 *
 * `--plan`, not `--dry-run`: npm claims the latter as its own config and eats it
 * even after `--`, so the script never sees it and runs for real. DRY_RUN=1 also
 * works.
 *
 * A projection is only stored if it clears the reputability gate. Its blast
 * radius is larger than a factor's — a wrong curve mis-dates every threshold on
 * its quantity — so it is held to the same source standard and simply dropped
 * when it fails, leaving the threshold undated rather than wrongly dated.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import { createDatabase, type Database } from '../db.js';
import { notifyFieldChanged } from './notifyFieldChanged.js';
import { scoreSource, REPUTABILITY_VERIFY_THRESHOLD } from './reputability.js';
import { publisherFromUrl } from './retrieval.js';
import {
  researchProjection,
  startsInTheFuture,
  type ProjectionCandidate,
  type QuantityRequest,
} from './projections.js';

/** Rows: the quantity thresholds currently in the factor set. */
interface WantedRow {
  quantity: string;
  unit: string;
  baseline: string | null;
}

/**
 * Quantities a threshold asks for that no stored projection satisfies.
 *
 * Matching mirrors the model's fallback exactly — case-insensitive quantity and
 * unit, plus baselines that agree or are both absent. If the two ever diverge
 * this would fetch curves the Clock then refuses to use, so the rule lives in
 * one shape in both places until the semantic resolver replaces it.
 */
async function unmatchedQuantities(db: Database): Promise<QuantityRequest[]> {
  const { rows } = await sql<WantedRow>`
    WITH wanted AS (
      SELECT DISTINCT
             lower(trim(tipping_point->'quantityThreshold'->>'quantity')) AS quantity,
             lower(trim(tipping_point->'quantityThreshold'->>'unit'))     AS unit,
             nullif(lower(trim(tipping_point->'quantityThreshold'->>'baseline')), '') AS baseline
        FROM factors
       WHERE tipping_point ? 'quantityThreshold'
    )
    SELECT w.quantity, w.unit, w.baseline
      FROM wanted w
     WHERE w.quantity IS NOT NULL AND w.unit IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM projections p
          WHERE lower(trim(p.quantity)) = w.quantity
            AND lower(trim(p.unit)) = w.unit
            AND COALESCE(nullif(lower(trim(p.baseline)), ''), '') = COALESCE(w.baseline, '')
       )
     ORDER BY w.quantity
  `.execute(db);

  return rows.map((r) => ({
    quantity: r.quantity,
    unit: r.unit,
    ...(r.baseline !== null ? { baseline: r.baseline } : {}),
  }));
}

/**
 * Upsert on the identity index from migration 010. Re-fetching the same source
 * updates the curve in place instead of accumulating near-duplicates that would
 * date the same threshold differently on different reads.
 */
async function storeProjection(db: Database, p: ProjectionCandidate): Promise<void> {
  await sql`
    INSERT INTO projections
      (quantity, unit, baseline, scenario, assumes_future_action, points, source_url, source_title)
    VALUES (
      ${p.quantity}, ${p.unit}, ${p.baseline ?? null}, ${p.scenario ?? null},
      ${p.assumesFutureAction ?? null},
      ${sql.val(JSON.stringify(p.points))}::jsonb,
      ${p.sourceUrl}, ${p.sourceTitle ?? null}
    )
    ON CONFLICT (quantity, unit, COALESCE(baseline, ''), COALESCE(scenario, ''))
    DO UPDATE SET
      assumes_future_action = EXCLUDED.assumes_future_action,
      points        = EXCLUDED.points,
      source_url    = EXCLUDED.source_url,
      source_title  = EXCLUDED.source_title,
      updated_at    = NOW()
  `.execute(db);
}

export async function fetchProjections(
  logger: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    logger.warn('[projections] no DATABASE_URL — nothing to do, exiting.');
    return;
  }

  const args = process.argv.slice(2);
  const dryRun =
    args.includes('--plan') || args.includes('--dry-run') || process.env.DRY_RUN === '1';
  const limitArg = args.indexOf('--limit');
  const limit = limitArg >= 0 ? Number.parseInt(args[limitArg + 1] ?? '', 10) : NaN;

  const { db, pool } = createDatabase(databaseUrl);
  try {
    let wanted = await unmatchedQuantities(db);
    if (Number.isFinite(limit) && limit > 0) wanted = wanted.slice(0, limit);

    logger.info(`[projections] ${wanted.length} quantity/unit pair(s) without a curve.`);
    for (const w of wanted) {
      logger.info(
        `[projections]   want: ${w.quantity} (${w.unit})${w.baseline ? ` vs ${w.baseline}` : ''}`,
      );
    }
    if (dryRun || wanted.length === 0) {
      logger.info(
        dryRun ? '[projections] plan only — no calls made.' : '[projections] nothing to do.',
      );
      return;
    }

    let stored = 0;
    for (const request of wanted) {
      const researched = await researchProjection(request, { logger });
      if (!researched) {
        logger.warn(`[projections] no usable curve for "${request.quantity}" — left undated.`);
        continue;
      }

      // Same bar as a factor's source, applied to a claim with a wider blast
      // radius. Failing it drops the curve: an undated threshold is recoverable,
      // a wrongly-dated one is not visibly wrong at all.
      const verdict = await scoreSource({
        url: researched.candidate.sourceUrl,
        publisher: publisherFromUrl(researched.candidate.sourceUrl),
        claim:
          `${researched.candidate.quantity} projected trajectory in ${researched.candidate.unit}` +
          (researched.candidate.scenario ? ` under "${researched.candidate.scenario}"` : ''),
        // The verbatim sentence from the source, not its title: the gate scores
        // whether THIS quote supports THIS claim, and a title supports nothing.
        quoteSnippet: researched.quote,
      });
      if (verdict.score < REPUTABILITY_VERIFY_THRESHOLD) {
        logger.warn(
          `[projections] rejected ${researched.candidate.sourceUrl} for "${researched.candidate.quantity}" ` +
            `(reputability ${verdict.score.toFixed(2)}): ${verdict.reasoning.slice(0, 120)}`,
        );
        continue;
      }

      if (startsInTheFuture(researched.candidate, new Date().getFullYear())) {
        logger.warn(
          `[projections] "${researched.candidate.quantity}" curve begins at ` +
            `${Math.min(...researched.candidate.points.map((p) => p.year))}, after today. It can ` +
            `date thresholds ahead of us but NOT any already crossed, which will ` +
            `read as "not dateable" rather than "already behind us".`,
        );
      }

      await storeProjection(db, researched.candidate);
      stored += 1;
      logger.info(
        `[projections] stored ${researched.candidate.quantity} (${researched.candidate.unit}) ` +
          `${researched.candidate.points.length} points · scenario=${researched.candidate.scenario ?? 'unstated'} ` +
          `· assumesFutureAction=${researched.candidate.assumesFutureAction} · ${researched.candidate.sourceUrl}`,
      );
    }

    logger.info(`[projections] done — ${stored}/${wanted.length} stored.`);
    // Open clients fetched the field once; without this they keep rendering
    // the values this run replaced.
    await notifyFieldChanged(db);
  } finally {
    await pool.end();
  }
}

// Run when invoked directly, not when imported.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  fetchProjections().catch((err: unknown) => {
    console.error('[projections] fatal:', err);
    process.exitCode = 1;
  });
}
