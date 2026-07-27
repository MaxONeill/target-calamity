/**
 * Go and find who is actually working on each open requirement.
 *
 * This is the router half of the product. The Clock detects; the contingency
 * tree says what reversal would take; this says who is already doing it. A
 * reader who reaches "sustained gigatonne-scale carbon removal [absent]" and
 * finds nothing underneath has been handed a problem and abandoned at it.
 *
 * WHY THIS EXISTS RATHER THAN `resolveEfforts`. The first attempt matched
 * requirements to Humanity factors already ingested, by embedding proximity. It
 * matched NOTHING — eight requirements, zero hits — and that result is the
 * argument for this file. The factor set is a record of what is happening TO the
 * world, not a directory of who is working on what; the organisations doing this
 * work were never in it to be found. So we retrieve them, the same way every
 * other claim in the system is retrieved.
 *
 * THE RULE, unchanged from contingency expansion and for a stronger reason here:
 * an effort exists only where a retrieved source describes it. "Name some
 * organisations working on X" is the single easiest prompt in this system to
 * answer fluently and wrongly — real-sounding names, plausible missions,
 * confident stage assessments, no such programme. And unlike a bad dependency
 * link, a reader may ACT on this: follow it, donate to it, apply to it. So every
 * row carries its own URL, its own verbatim sentence, and its own pass through
 * the reputability gate, and a row missing any of those is dropped.
 *
 * We deliberately do NOT score, rank or endorse. Listing who is working on
 * something is reporting; ranking them is an opinion this system has no basis
 * for and no business publishing.
 *
 *   npm run research:efforts             # research requirements with none yet
 *   DRY_RUN=1 npm run research:efforts   # list targets, no calls, no writes
 *   LIMIT=3 npm run research:efforts     # cap requirements researched (cost)
 *   FORCE=1 npm run research:efforts     # re-research ones already done
 *
 * COST: one search + one turn PER REQUIREMENT. Bounded by the requirement count,
 * unlike contingency expansion which branches. Scoped by default to requirements
 * that are still OPEN — `absent`, `partial` or `unknown`. Something that already
 * `exists` at the scale needed does not need anyone routed to it, and spending
 * retrieval on it is spending it on the one branch nobody is waiting for.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import * as z from 'zod/v4';
import { createDatabase, type Database } from '../db.js';
import { notifyFieldChanged } from './notifyFieldChanged.js';
import { createEmbeddingClient } from './embeddings.js';
import {
  firecrawlSearch,
  hasRetrievalCredentials,
  publisherFromUrl,
} from './firecrawlClient.js';
import {
  getLlmClient,
  hasLiveCredentials,
  ingestModel,
  structuredCompletion,
} from './llmClient.js';
import { scoreSource, REPUTABILITY_VERIFY_THRESHOLD } from './reputability.js';
import { renderSourceBlocks } from './websearch.js';

/**
 * Efforts kept per requirement. A route is a handful of places to start, not a
 * directory — past a few entries a reader stops reading and the section becomes
 * decoration.
 */
const MAX_EFFORTS = 4;

/** Statuses worth researching: the branches still open. */
const OPEN_STATUSES = ['absent', 'partial', 'unknown'] as const;

const EffortsSchema = z.object({
  /**
   * False when the sources name nobody. Common and correct — plenty of
   * requirements have no organised effort behind them, and that emptiness is
   * one of the more valuable things this tracker can report.
   */
  found: z.boolean(),
  efforts: z.array(
    z.object({
      /** The organisation, programme, project or research group, as named. */
      name: z.string(),
      /** What they are doing about this requirement, in the source's terms. */
      description: z.string(),
      /**
       * How far along, in the source's words: research, pilot, deploying,
       * operating. Free text rather than an enum — maturity vocabulary differs
       * between a policy campaign and a hardware programme, and forcing one
       * ladder onto both would mean inventing the rungs.
       */
      stage: z.string(),
      /** The sentence this was read from, verbatim. */
      quote: z.string(),
      sourceIndex: z.number(),
    }),
  ),
});

const EFFORTS_SYSTEM =
  'You identify ORGANISATIONS, PROGRAMMES AND PROJECTS that the retrieved ' +
  'sources describe as working on a stated requirement. ' +
  'Every one you return must be NAMED IN A SOURCE below as working on this. ' +
  'Do not name organisations from your own knowledge. You know many real ones, ' +
  'and that is exactly the hazard: a name you supply unprompted is ' +
  'indistinguishable from one you invented, and a reader may follow it, fund it ' +
  'or apply to it. If the sources in front of you name nobody, return ' +
  'found=false. That is a correct and frequent answer. ' +
  'Return at most four, each a distinct effort rather than four descriptions of ' +
  'one. Prefer the specific over the general: a named programme beats the ' +
  'institution hosting it. ' +
  'description is what THIS effort is doing about THIS requirement, in one or ' +
  'two plain sentences a non-expert can follow, taken from the source rather ' +
  'than from what you assume the organisation does. ' +
  'stage is how far along the source says they are — research, pilot, ' +
  'deploying, operating — or "unclear" if it does not say. Do not upgrade a ' +
  'pilot to a deployment. ' +
  'Do not rank them, do not say which is most promising, and do not assess ' +
  'whether their work is sufficient. Report who is working on it. ' +
  'quote is the sentence naming them, copied verbatim, and sourceIndex is its ' +
  'SOURCE block.';

/** Aimed at who is doing the work, not at the problem itself. */
function effortQuery(statement: string): string {
  return `organizations projects working on ${statement} initiative program funding research`;
}

interface TargetRow {
  id: string;
  statement: string;
  status: string;
  factor_name: string;
}

/**
 * Open requirements with no researched efforts yet, shallowest first.
 *
 * Depth order matters: the shallow nodes are the broad asks ("net-negative
 * emissions") where the well-known efforts live, and the deep ones are the
 * specific gaps. When LIMIT cuts the run short, the reader gets the branches
 * most likely to have someone behind them.
 */
async function targets(db: Database, force: boolean): Promise<TargetRow[]> {
  const { rows } = await sql<TargetRow>`
    SELECT r.id, r.statement, r.status, f.name AS factor_name
      FROM requirements r
      JOIN factors f ON f.id = r.factor_id
     WHERE r.status = ANY(${sql.val(OPEN_STATUSES as unknown as string[])}::text[])
       AND (${force} OR NOT EXISTS (
         SELECT 1 FROM counter_efforts c WHERE c.requirement_id = r.id
       ))
     ORDER BY r.depth, r.id
  `.execute(db);
  return rows;
}

async function insertEffort(
  db: Database,
  requirementId: string,
  effort: {
    name: string;
    description: string;
    stage: string;
    sourceUrl: string;
    publisher: string;
    quote: string;
    embedding: number[] | null;
  },
): Promise<boolean> {
  const vec = effort.embedding ? `[${effort.embedding.join(',')}]` : null;
  const { rows } = await sql<{ id: string }>`
    INSERT INTO counter_efforts
      (requirement_id, name, description, stage, source_url, publisher, quote, embedding)
    VALUES (${requirementId}::uuid, ${effort.name}, ${effort.description}, ${effort.stage},
            ${effort.sourceUrl}, ${effort.publisher}, ${effort.quote}, ${vec}::halfvec)
    ON CONFLICT DO NOTHING
    RETURNING id
  `.execute(db);
  return rows.length > 0;
}

export async function researchCounterEfforts(
  logger: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    logger.warn('[counter] no DATABASE_URL — nothing to do, exiting.');
    return;
  }
  if (!hasLiveCredentials() || !hasRetrievalCredentials()) {
    logger.warn(
      '[counter] needs BOTH FIREWORKS_API_KEY and FIRECRAWL_API_KEY. Every effort ' +
        'must be READ from a source — a plausible invented organisation is one a ' +
        'reader may follow, fund or apply to. Exiting.',
    );
    return;
  }

  const args = process.argv.slice(2);
  const dryRun =
    args.includes('--plan') || args.includes('--dry-run') || process.env.DRY_RUN === '1';
  const force = args.includes('--force') || process.env.FORCE === '1';
  const limit = Number.parseInt(process.env.LIMIT ?? '', 10);

  const { db, pool } = createDatabase(databaseUrl);
  try {
    let rows = await targets(db, force);
    if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit);

    logger.info(
      `[counter] ${rows.length} open requirement(s) to research` +
        `${force ? ' (--force)' : ''}. One search + one turn each.`,
    );
    for (const r of rows) {
      logger.info(`[counter]   [${r.status}] ${r.statement.slice(0, 80)}`);
    }
    if (dryRun || rows.length === 0) {
      logger.info(dryRun ? '[counter] dry run — no calls, no writes.' : '[counter] nothing to do.');
      return;
    }

    const client = getLlmClient();
    const model = ingestModel();
    const embeddings = createEmbeddingClient(process.env);
    let written = 0;
    let empty = 0;

    for (const r of rows) {
      try {
        const docs = await firecrawlSearch(
          effortQuery(r.statement),
          process.env.FIRECRAWL_API_KEY as string,
          {},
        );
        if (docs.length === 0) {
          empty += 1;
          logger.warn(`[counter] no sources for "${r.statement.slice(0, 60)}"`);
          continue;
        }

        const out = await structuredCompletion({
          client,
          model,
          system: EFFORTS_SYSTEM,
          user:
            `REQUIREMENT: ${r.statement}\n` +
            `CONTEXT: this is needed in order to reverse "${r.factor_name}".\n\n` +
            renderSourceBlocks(docs),
          schema: EffortsSchema,
          schemaName: 'CounterEfforts',
        });

        if (!out || !out.found || out.efforts.length === 0) {
          empty += 1;
          // Worth reporting rather than passing over. A requirement with no
          // organised effort behind it is one of the more actionable things
          // this tracker can surface, and the UI says so rather than rendering
          // a blank space.
          logger.warn(`[counter] nobody found for "${r.statement.slice(0, 60)}"`);
          continue;
        }

        if (force) {
          await sql`DELETE FROM counter_efforts WHERE requirement_id = ${r.id}::uuid`.execute(db);
        }

        for (const e of out.efforts.slice(0, MAX_EFFORTS)) {
          const doc = docs[e.sourceIndex - 1];
          if (!doc || e.name.trim() === '' || e.quote.trim() === '') continue;

          const publisher = publisherFromUrl(doc.url, doc.title);
          const score = await scoreSource({
            url: doc.url,
            publisher,
            claim: `${e.name} is working on ${r.statement}`,
            quoteSnippet: e.quote,
          });
          if (score.score < REPUTABILITY_VERIFY_THRESHOLD) {
            logger.warn(
              `[counter] rejected ${publisher} (${score.score.toFixed(2)}) for "${e.name.slice(0, 40)}"`,
            );
            continue;
          }

          // Embedded for cross-requirement dedupe later — the same organisation
          // legitimately addresses several branches, and knowing that is useful.
          // A failed embedding is not a reason to drop a sourced effort.
          const [vector] = await embeddings.embed([`${e.name}: ${e.description}`]);

          const ok = await insertEffort(db, r.id, {
            name: e.name.trim().slice(0, 200),
            description: e.description.trim().slice(0, 1000),
            stage: e.stage.trim().slice(0, 60),
            sourceUrl: doc.url,
            publisher,
            quote: e.quote.trim().slice(0, 2000),
            embedding: vector ?? null,
          });
          if (!ok) continue;
          written += 1;
          logger.info(
            `[counter] ${r.statement.slice(0, 40)} → ${e.name.slice(0, 40)} ` +
              `[${e.stage.slice(0, 14)}] · ${publisher}`,
          );
        }
      } catch (err) {
        logger.error(`[counter] "${r.statement.slice(0, 40)}" failed: ${(err as Error).message}`);
      }
    }

    logger.info(
      `[counter] done — ${written} effort(s) across ${rows.length} requirement(s); ` +
        `${empty} with nobody found.`,
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
  researchCounterEfforts().catch((err: unknown) => {
    console.error('[counter] fatal:', err);
    process.exitCode = 1;
  });
}
