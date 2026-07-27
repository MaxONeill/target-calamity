/**
 * Re-apply the counter-effort gate to candidates already retrieved. No network.
 *
 * The expensive half of the efforts pipeline is retrieval; the judgement about
 * what to admit is cheap and will be tuned repeatedly. This replays the current
 * gate over `counter_effort_candidates`, promoting anything that now clears it
 * and retiring anything that no longer does — so tuning a threshold costs a
 * query rather than a re-crawl.
 *
 * This is what "sweep the logs" has to mean in practice. A rejection LOG LINE
 * carries a publisher, two scores and a name truncated to 40 characters: no URL,
 * no quote, no description. Rebuilding an effort from one would mean inventing
 * exactly the fields that make it citable, which is the failure this whole
 * subsystem is built to avoid. Candidates recorded from migration 016 onward can
 * be replayed honestly; anything rejected BEFORE that has to be re-retrieved,
 * and `--report` says how much of each there is.
 *
 *   npm run replay:efforts             # apply the current gate, write changes
 *   DRY_RUN=1 npm run replay:efforts   # show what would change, write nothing
 *
 * Promotions get no embedding here (that would need a live client). The
 * embedding is only used for cross-subject dedupe, so it is left null and
 * backfilled by the next `resolve:efforts` run.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import { createDatabase, type Database } from '../db.js';
import { notifyFieldChanged } from './notifyFieldChanged.js';
import { EFFORT_CREDIBILITY_MIN, EFFORT_SUPPORT_MIN } from './reputability.js';

interface CandidateRow {
  id: string;
  requirement_id: string | null;
  factor_id: string | null;
  name: string;
  description: string;
  stage: string | null;
  source_url: string;
  publisher: string | null;
  quote: string;
  credibility: number;
  support: number;
  admitted: boolean;
  /** Whether an effort row for this candidate currently exists. */
  present: boolean;
}

async function candidates(db: Database): Promise<CandidateRow[]> {
  const { rows } = await sql<CandidateRow>`
    SELECT c.id, c.requirement_id, c.factor_id, c.name, c.description, c.stage,
           c.source_url, c.publisher, c.quote, c.credibility, c.support, c.admitted,
           EXISTS (
             SELECT 1 FROM counter_efforts e
              WHERE lower(e.name) = lower(c.name)
                AND e.requirement_id IS NOT DISTINCT FROM c.requirement_id
                AND e.factor_id IS NOT DISTINCT FROM c.factor_id
           ) AS present
      FROM counter_effort_candidates c
     ORDER BY c.credibility DESC, c.id
  `.execute(db);
  return rows;
}

export async function replayEffortGate(
  logger: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    logger.warn('[replay] no DATABASE_URL — nothing to do, exiting.');
    return;
  }
  const args = process.argv.slice(2);
  const dryRun =
    args.includes('--plan') || args.includes('--dry-run') || process.env.DRY_RUN === '1';

  const { db, pool } = createDatabase(databaseUrl);
  try {
    const rows = await candidates(db);
    logger.info(
      `[replay] ${rows.length} stored candidate(s). Gate: credibility ≥ ` +
        `${EFFORT_CREDIBILITY_MIN}, support ≥ ${EFFORT_SUPPORT_MIN}. No network.`,
    );
    if (rows.length === 0) {
      // Said plainly, because it is the likely case right after migration 016
      // and it is easy to misread an empty replay as "nothing to recover".
      logger.info(
        '[replay] nothing stored yet — candidates are only recorded from ' +
          'migration 016 onward. Anything rejected before that must be ' +
          're-retrieved (research:efforts on the empty targets).',
      );
      return;
    }

    let promote = 0;
    let retire = 0;
    for (const c of rows) {
      const passes = c.credibility >= EFFORT_CREDIBILITY_MIN && c.support >= EFFORT_SUPPORT_MIN;
      if (passes && !c.present) {
        promote += 1;
        logger.info(
          `[replay] + ${c.name.slice(0, 46)} (cred ${c.credibility.toFixed(2)} · ` +
            `sup ${c.support.toFixed(2)}) · ${c.publisher ?? 'source'}`,
        );
        if (!dryRun) {
          await sql`
            INSERT INTO counter_efforts
              (requirement_id, factor_id, name, description, stage, source_url, publisher, quote)
            VALUES (${c.requirement_id}::uuid, ${c.factor_id}::uuid, ${c.name}, ${c.description},
                    ${c.stage}, ${c.source_url}, ${c.publisher}, ${c.quote})
            ON CONFLICT DO NOTHING
          `.execute(db);
        }
      } else if (!passes && c.present) {
        retire += 1;
        logger.info(`[replay] − ${c.name.slice(0, 46)} (no longer clears the gate)`);
        if (!dryRun) {
          await sql`
            DELETE FROM counter_efforts
             WHERE lower(name) = lower(${c.name})
               AND requirement_id IS NOT DISTINCT FROM ${c.requirement_id}::uuid
               AND factor_id IS NOT DISTINCT FROM ${c.factor_id}::uuid
          `.execute(db);
        }
      }
      if (!dryRun && passes !== c.admitted) {
        await sql`
          UPDATE counter_effort_candidates SET admitted = ${passes} WHERE id = ${c.id}::uuid
        `.execute(db);
      }
    }

    logger.info(
      `[replay] ${dryRun ? 'would promote' : 'promoted'} ${promote}, ` +
        `${dryRun ? 'would retire' : 'retired'} ${retire}.`,
    );
    if (!dryRun && (promote > 0 || retire > 0)) await notifyFieldChanged(db);
  } finally {
    await pool.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  replayEffortGate().catch((err: unknown) => {
    console.error('[replay] fatal:', err);
    process.exitCode = 1;
  });
}
