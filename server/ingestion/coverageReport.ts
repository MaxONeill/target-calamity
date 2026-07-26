/**
 * Where is retrieval failing to produce anchors?
 *
 * The alternative to this is a hand-written list of tipping elements we think
 * ought to be present — which caps discovery at whatever the author thought of
 * and bakes their priors into the data. This asks the data instead: which
 * domains carry plenty of factors and no thresholds? A domain with 46 factors
 * and zero anchors is not evidence that it has none; it is evidence that the
 * sweep covering it is retrieving the wrong genre of document.
 *
 *   npm run report:coverage
 *
 * Read-only. No provider calls, no writes, safe to run any time.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import { createDatabase, type Database } from '../db.js';

interface DomainRow {
  domain: string;
  factors: number;
  with_threshold: number;
  anchors: number;
  assessment_cited: number;
}

async function domainCoverage(db: Database): Promise<DomainRow[]> {
  const { rows } = await sql<DomainRow>`
    SELECT d AS domain,
           COUNT(DISTINCT f.id)::int AS factors,
           COUNT(DISTINCT f.id) FILTER (WHERE f.tipping_point IS NOT NULL)::int AS with_threshold,
           COUNT(DISTINCT f.id) FILTER (WHERE f.tipping_point->>'closesWindow' = 'true')::int AS anchors,
           COUNT(DISTINCT f.id) FILTER (
             WHERE EXISTS (
               SELECT 1 FROM citations c
                WHERE c.factor_id = f.id
                  AND c.source_url ~* 'ipcc|nature\.com|science\.org|pnas|copernicus|springer|wiley|sciencedirect|\.edu'
             )
           )::int AS assessment_cited
      FROM factors f,
           unnest(CASE WHEN f.domains = '{}' THEN ARRAY['(unclassified)'] ELSE f.domains END) d
     WHERE f.verification_state = 'verified'
     GROUP BY d
     ORDER BY factors DESC
  `.execute(db);
  return rows;
}

export async function coverageReport(
  logger: Pick<Console, 'info' | 'warn'> = console,
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    logger.warn('[coverage] no DATABASE_URL — nothing to report.');
    return;
  }

  const { db, pool } = createDatabase(databaseUrl);
  try {
    const rows = await domainCoverage(db);

    logger.info('domain            factors  dated  anchors  assessment-cited');
    for (const r of rows) {
      logger.info(
        `${r.domain.padEnd(17)} ${String(r.factors).padStart(6)} ` +
          `${String(r.with_threshold).padStart(6)} ${String(r.anchors).padStart(8)} ` +
          `${String(r.assessment_cited).padStart(17)}`,
      );
    }

    // The signal worth acting on: mass without anchors. Ranked by how much
    // retrieval is being spent for no threshold yield.
    const starved = rows
      .filter((r) => r.anchors === 0 && r.factors >= 5)
      .sort((a, b) => b.factors - a.factors);

    if (starved.length === 0) {
      logger.info('\n[coverage] every substantial domain has at least one anchor.');
    } else {
      logger.info('\n[coverage] domains carrying weight but no anchor:');
      for (const r of starved) {
        logger.info(
          `  ${r.domain} — ${r.factors} factors, ${r.assessment_cited} citing assessment literature`,
        );
      }
      logger.info(
        '\n[coverage] A domain with many factors and no anchor usually means the\n' +
          '           sweep covering it is retrieving news rather than assessments.\n' +
          '           Compare its assessment-cited count against its factor count.',
      );
    }
  } finally {
    await pool.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  coverageReport().catch((err: unknown) => {
    console.error('[coverage] fatal:', err);
    process.exitCode = 1;
  });
}
