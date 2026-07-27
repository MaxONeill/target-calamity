/**
 * Find what a tracked organisation has MEASURABLY ACHIEVED, and make that a
 * factor.
 *
 * This is how counter-efforts reach the Clock, and the distinction it rests on
 * is the whole design:
 *
 *   An organisation EXISTING does not move the countdown. If it did, the
 *   countdown would be a function of how hard we searched — research more
 *   bodies, gain more years, with nothing changed in the world. It would also
 *   double-count, because the Clock already carries this work once through
 *   outcome factors like "Climate finance goal exceeded", and because no source
 *   publishes how many years NOAA's reef programme shifts the reef threshold, an
 *   effect for the organisation itself could only be invented.
 *
 *   An organisation's RESULT does move it. "Restored 1,400 hectares of reef by
 *   2024" is a measurable, dated claim about the world — the same kind of thing
 *   every other factor is — so it earns an effect and a significance from
 *   published evidence and passes the same reputability gate. The link back to
 *   the organisation records who is behind it.
 *
 * So the Clock responds to counter-efforts, and cannot be inflated by an
 * organisation that exists and achieves nothing.
 *
 * FOUND=FALSE IS THE COMMON ANSWER and a correct one. Most organisations
 * publish activity, not outcomes — "we work to protect reefs" is a mission, not
 * a result. The extraction is told to refuse those, because a mission statement
 * scored as an achievement would put an unearned positive force into the
 * countdown, which is the exact failure this file exists to prevent.
 *
 *   npm run research:outcomes             # organisations with no outcome yet
 *   DRY_RUN=1 npm run research:outcomes   # list targets, no calls, no writes
 *   LIMIT=5 npm run research:outcomes     # cap targets (cost)
 *   FORCE=1 npm run research:outcomes     # re-check ones already done
 *
 * COST: one search + one turn per organisation, and there are ~150 of them.
 * Run it in batches.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import * as z from 'zod/v4';
import { createDatabase, type Database } from '../db.js';
import { notifyFieldChanged } from './notifyFieldChanged.js';
import { createEmbeddingClient } from './embeddings.js';
import { retrieveDocuments, hasRetrievalCredentials, publisherFromUrl } from './retrieval.js';
import {
  getLlmClient,
  hasLiveCredentials,
  ingestModel,
  structuredCompletion,
} from './llmClient.js';
import { scoreSource, REPUTABILITY_VERIFY_THRESHOLD } from './reputability.js';
import { renderSourceBlocks } from './websearch.js';
import { resolveSourceDoc } from './researchCounterEfforts.js';
import { classifyDomains } from '../../shared/domains.js';

const OutcomeSchema = z.object({
  /**
   * False unless the sources state a MEASURED, DATED result. Missions,
   * ambitions, pledges and funding announcements are not outcomes.
   */
  found: z.boolean(),
  /** The achievement as a short factor name, e.g. "Reef restoration at scale in the Florida Keys". */
  name: z.string(),
  /** What was achieved, with the number and the date, in the source's terms. */
  description: z.string(),
  /**
   * Signed impact in [-1, 1]. Positive: this outcome improves humanity's
   * position. An outcome pass should almost always be positive — a negative
   * value means the sources describe the effort failing or backfiring, which is
   * a real and reportable finding.
   */
  effect: z.number(),
  /** Weight of the evidence and systemic reach in [0, 1]. */
  significance: z.number(),
  /** The year the result was measured. */
  year: z.number().nullable(),
  /** The sentence stating the measured result, verbatim. */
  quote: z.string(),
  sourceIndex: z.number(),
});

const OUTCOME_SYSTEM =
  'You extract a MEASURED OUTCOME of a named organisation from the retrieved ' +
  'sources: something it has actually achieved, with a number and a date. ' +
  'Examples of an outcome: "restored 1,400 hectares of reef by 2024", ' +
  '"financed 3.2 GW of solar in 2023", "cut member-city emissions 12% since 2015". ' +
  'NOT outcomes, and you must return found=false for all of them: a mission ' +
  'statement, an ambition, a target, a pledge, a launch announcement, an amount ' +
  'of money raised, a partnership signed, or a PRIZE, AWARD OR RECOGNITION the ' +
  'organisation received. Money committed is an input, not a result, and an ' +
  "award is somebody else's opinion of the work rather than a measurement of " +
  'it. A report merely being published is not an outcome either — the numbers ' +
  'inside it might be. ' +
  'This matters more than usual. What you return becomes a factor that moves a ' +
  'public countdown, so an ambition scored as an achievement puts an unearned ' +
  'positive force into it. found=false is the common and correct answer — most ' +
  'organisations publish activity rather than results. ' +
  'name is a short factual title for the achievement itself, not the ' +
  "organisation's name. description states the number and the date in the " +
  "source's terms. " +
  "effect is signed impact in [-1, 1]: positive if this improves humanity's " +
  'position, and sized by how much. Reserve magnitudes above 0.6 for outcomes of ' +
  'genuine global consequence; a regional restoration project is small on a ' +
  'planetary scale however good it is. Use a NEGATIVE value if the sources show ' +
  'the effort failed or backfired — that is a real finding, not an error. ' +
  'significance is [0, 1] for the weight of the evidence and the systemic reach. ' +
  'year is when the result was measured, or null. ' +
  'quote is the sentence stating the measured result, copied verbatim, and ' +
  'sourceIndex is its SOURCE block.';

/**
 * Aimed at results, not at the organisation's own description of itself.
 *
 * NO QUOTED PHRASES. Serper's free tier rejects exact-match syntax outright —
 * `Query pattern not allowed for free accounts` — and a 400 here reads as "this
 * organisation has published nothing", which is the wrong finding rather than a
 * visible failure. Keep the query plain so it works on every plan.
 */
function outcomeQuery(name: string): string {
  return `${name} impact report results achieved hectares restored tonnes reduced evaluation`;
}

interface OrgRow {
  id: string;
  name: string;
  description: string;
}

/** Organisations with no `produced` link yet, most-linked first. */
async function targets(db: Database, force: boolean): Promise<OrgRow[]> {
  const { rows } = await sql<OrgRow>`
    SELECT o.id, o.name, o.description
      FROM organisations o
     WHERE ${force} OR NOT EXISTS (
       SELECT 1 FROM organisation_links l
        WHERE l.organisation_id = o.id AND l.relation = 'produced'
     )
     ORDER BY (
       SELECT count(*) FROM organisation_links l2 WHERE l2.organisation_id = o.id
     ) DESC, o.name
  `.execute(db);
  return rows;
}

export async function researchOutcomes(
  logger: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    logger.warn('[outcomes] no DATABASE_URL — nothing to do, exiting.');
    return;
  }
  if (!hasLiveCredentials() || !hasRetrievalCredentials()) {
    logger.warn(
      '[outcomes] needs BOTH FIREWORKS_API_KEY and a search key. An outcome ' +
        'becomes a factor that moves the countdown, so it is never inferred. Exiting.',
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
    const total = rows.length;
    if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit);

    logger.info(
      `[outcomes] ${rows.length} of ${total} organisation(s) to check${force ? ' (--force)' : ''}. ` +
        'One search + one turn each.',
    );
    for (const r of rows) logger.info(`[outcomes]   ${r.name.slice(0, 80)}`);
    if (rows.length < total) {
      logger.info(`[outcomes] ${total - rows.length} left for a later run (LIMIT).`);
    }
    if (dryRun || rows.length === 0) {
      logger.info(
        dryRun ? '[outcomes] dry run — no calls, no writes.' : '[outcomes] nothing to do.',
      );
      return;
    }

    const client = getLlmClient();
    const model = ingestModel();
    const embeddings = createEmbeddingClient(process.env);
    let created = 0;
    let none = 0;

    for (const org of rows) {
      try {
        const docs = await retrieveDocuments(outcomeQuery(org.name), {});
        if (docs.length === 0) {
          none += 1;
          // Logged, not silent. "Nothing retrieved" and "nothing measured
          // published" are different findings, and counting them the same way
          // hides a retrieval problem behind a plausible result.
          logger.warn(`[outcomes] no sources retrieved for ${org.name.slice(0, 50)}`);
          continue;
        }

        const out = await structuredCompletion({
          client,
          model,
          system: OUTCOME_SYSTEM,
          user: `ORGANISATION: ${org.name}\nWHAT THEY DO: ${org.description}\n\n${renderSourceBlocks(docs)}`,
          schema: OutcomeSchema,
          schemaName: 'Outcome',
        });

        if (!out?.found || out.name.trim() === '' || out.quote.trim() === '') {
          none += 1;
          logger.info(`[outcomes] no measured outcome published for ${org.name.slice(0, 50)}`);
          continue;
        }

        // Resolved by quote, not by the index alone: the model returns 0-based
        // indices often enough that trusting the number silently loses real
        // findings, and guessing which page it meant would misattribute a quote.
        const resolved = resolveSourceDoc(docs, out.sourceIndex, out.quote);
        if (!resolved) {
          logger.warn(
            `[outcomes] ${org.name.slice(0, 40)} cited source ${out.sourceIndex} of ` +
              `${docs.length}, and its quote matches no retrieved page — dropped.`,
          );
          continue;
        }
        const doc = resolved.doc;

        const publisher = publisherFromUrl(doc.url, doc.title);
        const score = await scoreSource({
          url: doc.url,
          publisher,
          claim: `${org.name}: ${out.description}`,
          quoteSnippet: out.quote,
        });
        // The FULL gate here, not the relaxed effort gate. This row becomes a
        // factor and moves a public countdown, so it is held to the same bar as
        // every other claim that does.
        if (score.score < REPUTABILITY_VERIFY_THRESHOLD) {
          logger.warn(
            `[outcomes] rejected ${publisher} (${score.score.toFixed(2)}) for "${out.name.slice(0, 44)}"`,
          );
          continue;
        }

        const effect = Math.max(-1, Math.min(1, out.effect));
        const significance = Math.max(0, Math.min(1, out.significance));
        const domains = classifyDomains(out.name, out.description, 'global');
        const [vector] = await embeddings.embed([`${out.name}: ${out.description}`]);

        // ONE TRANSACTION. The factor, its citation and its link are a single
        // fact and must land together. An earlier version wrote them in sequence
        // and a failure on the citation left two factors in the feed with no
        // source at all — rendering as "Unsourced", which is precisely what this
        // system must never publish.
        await db.transaction().execute(async (trx) => {
          // Placeless: an organisation's outcome rarely has one honest centroid,
          // and inventing a lat/lon would put a pin where no source placed it.
          const { rows: inserted } = await sql<{ id: string }>`
            INSERT INTO factors
              (spatial_path, name, description, effect, significance, lat, lon,
               verification_state, domains, embedding, reputability_score, reputability_reasoning)
            VALUES ('global', ${out.name.trim().slice(0, 300)},
                    ${out.description.trim().slice(0, 2000)},
                    ${effect}, ${significance}, NULL, NULL,
                    'verified', ${domains}::text[],
                    ${vector ? `[${vector.join(',')}]` : null}::halfvec,
                    ${score.score}, ${score.reasoning})
            RETURNING id
          `.execute(trx);
          const factorId = inserted[0]?.id;
          if (factorId === undefined) throw new Error('factor insert returned no id');

          await sql`
            INSERT INTO citations (factor_id, source_url, publisher, quote_snippet, analyst_notes)
            VALUES (${factorId}::uuid, ${doc.url}, ${publisher},
                    ${out.quote.trim().slice(0, 2000)},
                    ${`Measured outcome attributed to ${org.name}.`})
          `.execute(trx);

          await sql`
            INSERT INTO organisation_links
              (organisation_id, factor_id, relation, source_url, publisher, quote)
            VALUES (${org.id}::uuid, ${factorId}::uuid, 'produced', ${doc.url}, ${publisher},
                    ${out.quote.trim().slice(0, 2000)})
            ON CONFLICT DO NOTHING
          `.execute(trx);
        });

        created += 1;
        logger.info(
          `[outcomes] ${org.name.slice(0, 34)} → "${out.name.slice(0, 40)}" ` +
            `eff ${effect.toFixed(2)} sig ${significance.toFixed(2)} · ${publisher}`,
        );
      } catch (err) {
        logger.error(`[outcomes] ${org.name.slice(0, 40)} failed: ${(err as Error).message}`);
      }
    }

    logger.info(
      `[outcomes] done — ${created} outcome factor(s) from ${rows.length} organisation(s); ` +
        `${none} with nothing measured published.`,
    );
    if (created > 0) await notifyFieldChanged(db);
  } finally {
    await pool.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  researchOutcomes().catch((err: unknown) => {
    console.error('[outcomes] fatal:', err);
    process.exitCode = 1;
  });
}
