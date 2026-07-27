/**
 * One-time backfill: assign causal domains to factors that predate LLM
 * classification (their `domains` column is empty and the field route currently
 * falls back to the keyword classifier for them).
 *
 * Runs the same model the extraction turn uses, one small constrained call per
 * row, and writes the result. Idempotent and resumable: it only selects rows
 * with an empty `domains`, so a re-run picks up whatever an interrupted run left.
 *
 *   npm run backfill:domains            # classify every untagged row
 *   npm run backfill:domains -- --limit 20   # cap the number of rows (cost)
 *   npm run backfill:domains -- --dry-run     # count only, no calls, no writes
 *
 * Requires DATABASE_URL and a Fireworks key; without them it logs and exits,
 * exactly like the worker — the deterministic keyword fallback already covers
 * these rows at read time, so a missing key is a no-op, not a failure.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import * as z from 'zod/v4';
import { DOMAINS, DOMAIN_LABELS, isDomain, type Domain } from '../../shared/domains.js';
import { createDatabase, type Database } from '../db.js';
import {
  getLlmClient,
  hasLiveCredentials,
  ingestModel,
  structuredCompletion,
} from './llmClient.js';

/** How many rows to classify concurrently. Small — this is a background chore. */
const CONCURRENCY = 4;

const DomainClassificationSchema = z.object({
  domains: z.array(z.enum(DOMAINS)),
});

const CLASSIFY_SYSTEM =
  'You classify a factor into its CAUSAL DOMAINS for a reality tracker that links ' +
  'each factor to the tipping points it moves. Given a factor name and description, ' +
  'return every domain it acts in — as a pressure, a counter-force, or a threshold ' +
  '— chosen ONLY from: ' +
  DOMAINS.map((d) => `${d} (${DOMAIN_LABELS[d]})`).join(', ') +
  '. Examples: an emissions or clean-energy factor is [climate]; an AMOC or coral ' +
  'factor is [ocean]; deforestation is [forest]; a PFAS or pandemic factor is ' +
  '[health]. Return an empty array ONLY when none genuinely apply.';

interface Row {
  id: string;
  name: string;
  description: string;
}

async function classify(
  client: ReturnType<typeof getLlmClient>,
  model: string,
  row: Row,
): Promise<Domain[]> {
  const result = await structuredCompletion({
    client,
    model,
    system: CLASSIFY_SYSTEM,
    user: `NAME: ${row.name}\n\nDESCRIPTION: ${row.description}`,
    schema: DomainClassificationSchema,
    schemaName: 'DomainClassification',
    // No maxTokens override: the ingest model is a reasoning model whose thinking
    // tokens count against the budget, so a small cap starves the output and
    // returns empty. Use the module default (same as the extraction turn).
  });
  if (!result) return []; // model failed to parse — leave empty, fallback still covers it
  return [...new Set(result.domains.filter(isDomain))];
}

async function untaggedRows(db: Database): Promise<Row[]> {
  const { rows } = await sql<Row>`
    SELECT id, name, description FROM factors WHERE domains = '{}'
    ORDER BY created_at ASC
  `.execute(db);
  return rows;
}

async function writeDomains(db: Database, id: string, domains: Domain[]): Promise<void> {
  await sql`
    UPDATE factors SET domains = ${sql.val([...domains])}::text[] WHERE id = ${id}::uuid
  `.execute(db);
}

export async function backfillDomains(
  logger: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    logger.warn('[backfill] no DATABASE_URL — nothing to backfill, exiting.');
    return;
  }
  if (!hasLiveCredentials()) {
    logger.warn(
      '[backfill] no FIREWORKS_API_KEY — the keyword fallback already covers these ' +
        'rows at read time. Set the key to store model-quality domains. Exiting.',
    );
    return;
  }

  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitArg = args.indexOf('--limit');
  const limit = limitArg >= 0 ? Number.parseInt(args[limitArg + 1] ?? '', 10) : NaN;

  const { db, pool } = createDatabase(databaseUrl);
  try {
    let rows = await untaggedRows(db);
    if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit);

    logger.info(`[backfill] ${rows.length} untagged factor(s) to classify.`);
    if (dryRun || rows.length === 0) {
      logger.info(dryRun ? '[backfill] dry run — no calls made.' : '[backfill] nothing to do.');
      return;
    }

    const client = getLlmClient();
    const model = ingestModel();
    let done = 0;
    let tagged = 0;

    // Bounded concurrency: a sliding window of CONCURRENCY workers over the queue.
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < rows.length) {
        const row = rows[cursor++]!;
        try {
          const domains = await classify(client, model, row);
          await writeDomains(db, row.id, domains);
          if (domains.length > 0) tagged += 1;
          logger.info(
            `[backfill] ${(++done).toString().padStart(3)}/${rows.length}  ` +
              `[${domains.join(', ') || '—'}]  ${row.name.slice(0, 48)}`,
          );
        } catch (err) {
          done += 1;
          logger.error(`[backfill] failed for ${row.id}: ${(err as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    logger.info(
      `[backfill] done — ${done} processed, ${tagged} got at least one domain, ` +
        `${done - tagged} genuinely systemic.`,
    );
  } finally {
    await pool.end();
  }
}

// Run when invoked directly (npm run backfill:domains), not when imported.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  backfillDomains().catch((err: unknown) => {
    console.error('[backfill] fatal:', err);
    process.exit(1);
  });
}
