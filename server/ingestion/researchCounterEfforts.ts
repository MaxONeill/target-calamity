/**
 * Go and find who is actually working on it — for every open requirement, and
 * for every factor in the set.
 *
 * Two shapes, one pipeline, because the question differs by which side a factor
 * is on:
 *
 *   Calamity factor (effect < 0)  -> who is WORKING AGAINST this
 *   Humanity factor (effect > 0)  -> who is WORKING TO AMPLIFY this
 *   Open requirement              -> who is working on this missing capability
 *
 * The asymmetry matters. Asking "who opposes coral bleaching" and asking "who is
 * scaling up this reforestation programme" are different questions, and a single
 * prompt for both returns the generic answer to neither. A Humanity factor is
 * already good news; the useful thing is who is making it bigger.
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
 *   npm run research:efforts                  # requirements, then factors
 *   SCOPE=requirements npm run research:efforts   # only the contingency trees
 *   SCOPE=factors npm run research:efforts        # only the factor set
 *   DRY_RUN=1 npm run research:efforts        # list targets, no calls, no writes
 *   LIMIT=3 npm run research:efforts          # cap targets researched (cost)
 *   FORCE=1 npm run research:efforts          # re-research ones already done
 *
 * COST: one search + one turn PER TARGET. Bounded by the target count, unlike
 * contingency expansion which branches — but the factor set is ~100 rows, so
 * a full uncapped run is two orders of magnitude more retrieval than the
 * requirement pass. LIMIT exists for that reason and running in batches is the
 * expected use.
 *
 * Requirements are scoped to the ones still OPEN (`absent`, `partial`,
 * `unknown`): something that already `exists` at the scale needed has nobody
 * waiting on it. Factors are scoped to `verified`, since researching who
 * opposes a claim that has not cleared the gate spends retrieval on something
 * that may never be shown.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import * as z from 'zod/v4';
import { createDatabase, type Database } from '../db.js';
import { notifyFieldChanged } from './notifyFieldChanged.js';
import { createEmbeddingClient } from './embeddings.js';
import {
  retrieveDocuments,
  hasRetrievalCredentials,
  publisherFromUrl,
  type RetrievedDocument,
} from './retrieval.js';
import {
  getLlmClient,
  hasLiveCredentials,
  ingestModel,
  structuredCompletion,
} from './llmClient.js';
import { scoreSource, admitsEffort } from './reputability.js';
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

/**
 * What we are asking about the target — which decides both the search wording
 * and the framing of the extraction.
 *
 * `amplify` exists because a Humanity factor is already good news: asking who
 * "works against" clean-energy growth returns its opponents, which is the exact
 * opposite of a routing surface. The useful question there is who is scaling it.
 */
type Stance = 'counter' | 'amplify' | 'requirement';

const STANCE_BRIEF: Record<Stance, string> = {
  counter:
    'The subject is a HARMFUL trend. Identify who is working to STOP, SLOW, ' +
    'REVERSE OR REPAIR it. Not who studies it and not who causes it.',
  amplify:
    'The subject is a BENEFICIAL trend already underway. Identify who is ' +
    'working to EXPAND, ACCELERATE, FUND OR REPLICATE it. Not its opponents, ' +
    'and not people merely reporting that it is happening.',
  requirement:
    'The subject is a capability that is missing or not yet at scale. ' +
    'Identify who is working to BUILD OR PROVIDE it.',
};

const EFFORTS_SYSTEM =
  'You identify ORGANISATIONS, PROGRAMMES AND PROJECTS that the retrieved ' +
  'sources describe as working on a stated subject. ' +
  'Every one you return must be NAMED IN A SOURCE below as working on this. ' +
  'Do not name organisations from your own knowledge. You know many real ones, ' +
  'and that is exactly the hazard: a name you supply unprompted is ' +
  'indistinguishable from one you invented, and a reader may follow it, fund it ' +
  'or apply to it. If the sources in front of you name nobody, return ' +
  'found=false. That is a correct and frequent answer. ' +
  'Return at most four, each a distinct effort rather than four descriptions of ' +
  'one. Prefer the specific over the general: a named programme beats the ' +
  'institution hosting it. ' +
  'description is what THIS effort is doing about THIS subject, in one or ' +
  'two plain sentences a non-expert can follow, taken from the source rather ' +
  'than from what you assume the organisation does. ' +
  'stage is how far along the source says they are — research, pilot, ' +
  'deploying, operating — or "unclear" if it does not say. Do not upgrade a ' +
  'pilot to a deployment. ' +
  'Do not rank them, do not say which is most promising, and do not assess ' +
  'whether their work is sufficient. Report who is working on it. ' +
  'quote is the sentence naming them, copied verbatim, and sourceIndex is its ' +
  'SOURCE block.';

/**
 * The claim the reputability gate scores the quote against.
 *
 * Phrased per stance, because the gate's support axis judges whether the quote
 * backs THIS SENTENCE. A factor's name is a headline, not a predicate —
 * "Coral Reef Stewardship Fund is working on Warm-water coral reef tipping point
 * crossed" is barely grammatical, and the model correctly scored quotes as not
 * supporting it, flooring real organisations to 0.00 on the support axis.
 */
function effortClaim(name: string, subject: string, stance: Stance): string {
  if (stance === 'amplify') return `${name} works to expand or support: ${subject}`;
  if (stance === 'counter') return `${name} works to address or reduce: ${subject}`;
  return `${name} works to provide: ${subject}`;
}

/** Normalise for substring matching: markdown markers and spacing differ. */
function forMatching(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*_`[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Which retrieved document does this quote actually come from?
 *
 * The model reports a `sourceIndex`, and it is not reliable: a live run returned
 * index 0 against 1-based blocks, and the previous code dropped those efforts
 * silently — indistinguishable from "the sources named nobody". Guessing that 0
 * means 1 would be worse than dropping, because attributing a quote to the wrong
 * publisher is the exact provenance failure the citation rules exist to prevent.
 *
 * So the quote is LOCATED instead. Verifying beats trusting: the index is
 * accepted only when the document it names actually contains the quote, and
 * otherwise the quote decides — but only when exactly one document contains it,
 * since an ambiguous match is no evidence at all.
 *
 * Returns null when provenance cannot be established, which is a real outcome
 * and gets logged rather than passed over.
 */
export function resolveSourceDoc(
  docs: readonly RetrievedDocument[],
  sourceIndex: number,
  quote: string,
): { doc: RetrievedDocument; how: 'index' | 'quote' } | null {
  const needle = forMatching(quote);
  const named = docs[sourceIndex - 1];
  if (named && needle.length >= 24 && forMatching(named.markdown).includes(needle)) {
    return { doc: named, how: 'index' };
  }
  if (needle.length >= 24) {
    const found = docs.filter((d) => forMatching(d.markdown).includes(needle));
    if (found.length === 1 && found[0]) return { doc: found[0], how: 'quote' };
  }
  // Fall back to the named block when it exists. The quote check above is
  // best-effort — markdown conversion rewrites some characters, so a genuine
  // quote can fail to match — and refusing every unmatched quote would throw
  // away most of a run.
  return named ? { doc: named, how: 'index' } : null;
}

/** Aimed at who is doing the work, not at the subject itself. */
function effortQuery(subject: string, stance: Stance): string {
  if (stance === 'amplify') {
    return `organizations scaling up expanding funding ${subject} initiative program investment`;
  }
  if (stance === 'counter') {
    return `organizations working to stop reverse ${subject} initiative program conservation funding`;
  }
  return `organizations projects working on ${subject} initiative program funding research`;
}

interface Target {
  /** Which column the resulting rows hang off. Exactly one is set. */
  kind: 'requirement' | 'factor';
  id: string;
  /** What we research: the requirement statement, or the factor's name. */
  subject: string;
  stance: Stance;
  /** Extra framing for the prompt — why this subject is being asked about. */
  context: string;
  /** For logging only. */
  label: string;
}

/**
 * Open requirements with no researched efforts yet, shallowest first.
 *
 * Depth order matters: the shallow nodes are the broad asks ("net-negative
 * emissions") where the well-known efforts live, and the deep ones are the
 * specific gaps. When LIMIT cuts the run short, the reader gets the branches
 * most likely to have someone behind them.
 */
async function requirementTargets(db: Database, force: boolean): Promise<Target[]> {
  const { rows } = await sql<{
    id: string;
    statement: string;
    status: string;
    factor_name: string;
  }>`
    SELECT r.id, r.statement, r.status, f.name AS factor_name
      FROM requirements r
      JOIN factors f ON f.id = r.factor_id
     WHERE r.status = ANY(${sql.val(OPEN_STATUSES as unknown as string[])}::text[])
       AND (${force} OR NOT EXISTS (
         SELECT 1 FROM counter_efforts c WHERE c.requirement_id = r.id
       ))
     ORDER BY r.depth, r.id
  `.execute(db);

  return rows.map((r) => ({
    kind: 'requirement' as const,
    id: r.id,
    subject: r.statement,
    stance: 'requirement' as const,
    context: `This is needed in order to reverse "${r.factor_name}".`,
    label: `[${r.status}] ${r.statement}`,
  }));
}

/**
 * Verified factors with no researched efforts yet, heaviest first.
 *
 * Ordered by field influence — the same `ABS(effect * significance)` the field
 * ranks on — so a LIMIT-capped run covers what a reader is most likely to click
 * before it covers the long tail.
 *
 * The stance is taken from the sign of `effect`, which is the whole reason this
 * generalises cleanly: the data already knows whether a factor is something to
 * fight or something to grow.
 */
async function factorTargets(db: Database, force: boolean): Promise<Target[]> {
  const { rows } = await sql<{
    id: string;
    name: string;
    description: string;
    effect: number;
  }>`
    SELECT f.id, f.name, f.description, f.effect
      FROM factors f
     WHERE f.verification_state = 'verified'
       AND f.effect <> 0
       AND (${force} OR NOT EXISTS (
         SELECT 1 FROM counter_efforts c WHERE c.factor_id = f.id
       ))
     ORDER BY ABS(f.effect * f.significance) DESC, f.id
  `.execute(db);

  return rows.map((r) => {
    const harmful = Number(r.effect) < 0;
    return {
      kind: 'factor' as const,
      id: r.id,
      subject: r.name,
      stance: harmful ? ('counter' as const) : ('amplify' as const),
      // The description travels because a factor NAME is often too terse to
      // search well on its own — "Secondary displacement risk" means nothing
      // without it, and a vague subject returns a vague set of organisations.
      context: r.description.slice(0, 400),
      label: `[${harmful ? 'counter' : 'amplify'}] ${r.name}`,
    };
  });
}

async function insertEffort(
  db: Database,
  target: Target,
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
  // Exactly one of the two scope columns is set, per the table's CHECK.
  const requirementId = target.kind === 'requirement' ? target.id : null;
  const factorId = target.kind === 'factor' ? target.id : null;
  const { rows } = await sql<{ id: string }>`
    INSERT INTO counter_efforts
      (requirement_id, factor_id, name, description, stage, source_url, publisher, quote, embedding)
    VALUES (${requirementId}::uuid, ${factorId}::uuid,
            ${effort.name}, ${effort.description}, ${effort.stage},
            ${effort.sourceUrl}, ${effort.publisher}, ${effort.quote}, ${vec}::halfvec)
    ON CONFLICT DO NOTHING
    RETURNING id
  `.execute(db);
  return rows.length > 0;
}

/**
 * Persist a candidate and its two axes, whether or not it was admitted.
 *
 * Best-effort: a bookkeeping failure must never cost an effort that passed the
 * gate, so this logs and returns rather than propagating.
 */
async function recordCandidate(
  db: Database,
  target: Target,
  c: {
    name: string;
    description: string;
    stage: string;
    sourceUrl: string;
    publisher: string;
    quote: string;
    credibility: number;
    support: number;
    admitted: boolean;
  },
  logger: Pick<Console, 'warn'> = console,
): Promise<void> {
  const requirementId = target.kind === 'requirement' ? target.id : null;
  const factorId = target.kind === 'factor' ? target.id : null;
  try {
    await sql`
    INSERT INTO counter_effort_candidates
      (requirement_id, factor_id, name, description, stage, source_url, publisher,
       quote, credibility, support, admitted)
    VALUES (${requirementId}::uuid, ${factorId}::uuid, ${c.name}, ${c.description},
            ${c.stage}, ${c.sourceUrl}, ${c.publisher}, ${c.quote},
            ${c.credibility}, ${c.support}, ${c.admitted})
    ON CONFLICT (COALESCE(requirement_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 COALESCE(factor_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 lower(name))
    DO UPDATE SET credibility = EXCLUDED.credibility,
                  support     = EXCLUDED.support,
                  admitted    = EXCLUDED.admitted,
                  seen_at     = NOW()
  `.execute(db);
  } catch (err) {
    logger.warn(`[counter] candidate bookkeeping failed: ${(err as Error).message}`);
  }
}

async function clearEfforts(db: Database, target: Target): Promise<void> {
  if (target.kind === 'requirement') {
    await sql`DELETE FROM counter_efforts WHERE requirement_id = ${target.id}::uuid`.execute(db);
  } else {
    await sql`DELETE FROM counter_efforts WHERE factor_id = ${target.id}::uuid`.execute(db);
  }
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
      '[counter] needs BOTH FIREWORKS_API_KEY and a search key (SERPER_API_KEY or BRAVE_API_KEY). Every effort ' +
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

  const scope = (process.env.SCOPE ?? 'all').toLowerCase();
  if (!['all', 'requirements', 'factors'].includes(scope)) {
    logger.error(`[counter] SCOPE must be all | requirements | factors, got "${scope}".`);
    return;
  }

  const { db, pool } = createDatabase(databaseUrl);
  try {
    // Requirements first: they are the deep end of the product and there are a
    // handful of them, where the factor set is ~100 rows. A LIMIT-capped run
    // should finish the small, high-value set before starting the long one.
    let rows: Target[] = [
      ...(scope === 'factors' ? [] : await requirementTargets(db, force)),
      ...(scope === 'requirements' ? [] : await factorTargets(db, force)),
    ];
    const total = rows.length;
    if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit);

    logger.info(
      `[counter] ${rows.length} of ${total} target(s) to research` +
        `${force ? ' (--force)' : ''}${scope === 'all' ? '' : ` (scope=${scope})`}. ` +
        'One search + one turn each.',
    );
    for (const r of rows) logger.info(`[counter]   ${r.label.slice(0, 90)}`);
    if (rows.length < total) {
      // Never let a cap read as full coverage.
      logger.info(`[counter] ${total - rows.length} target(s) left for a later run (LIMIT).`);
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
        const docs = await retrieveDocuments(effortQuery(r.subject, r.stance));
        if (docs.length === 0) {
          empty += 1;
          logger.warn(`[counter] no sources for "${r.subject.slice(0, 60)}"`);
          continue;
        }

        const out = await structuredCompletion({
          client,
          model,
          system: `${EFFORTS_SYSTEM} ${STANCE_BRIEF[r.stance]}`,
          user: `SUBJECT: ${r.subject}\n` + `CONTEXT: ${r.context}\n\n` + renderSourceBlocks(docs),
          schema: EffortsSchema,
          schemaName: 'CounterEfforts',
        });

        if (!out || !out.found || out.efforts.length === 0) {
          empty += 1;
          // Worth reporting rather than passing over. A subject with no
          // organised effort behind it is one of the more actionable things
          // this tracker can surface, and the UI says so rather than rendering
          // a blank space.
          logger.warn(`[counter] nobody found for "${r.subject.slice(0, 60)}"`);
          continue;
        }

        // NOT cleared yet. An earlier version deleted here, before knowing
        // whether anything would replace what it removed — and a --force re-run
        // whose model output was worse than last time destroyed four sourced
        // efforts and admitted none. Deletion now happens only once a
        // replacement has actually cleared the gate.
        let cleared = false;

        for (const e of out.efforts.slice(0, MAX_EFFORTS)) {
          if (e.name.trim() === '' || e.quote.trim() === '') {
            logger.warn(`[counter] dropped an effort with no name or no quote.`);
            continue;
          }
          // Logged, never silent. A bare `continue` here made a bad sourceIndex
          // look identical to "the sources named nobody" — the run reported
          // success while dropping every effort it had actually found.
          const resolved = resolveSourceDoc(docs, e.sourceIndex, e.quote);
          if (!resolved) {
            logger.warn(
              `[counter] "${e.name.slice(0, 40)}" cited source ${e.sourceIndex} of ` +
                `${docs.length}, and its quote matches no retrieved page — dropped.`,
            );
            continue;
          }
          const doc = resolved.doc;
          if (resolved.how === 'quote') {
            logger.info(
              `[counter] "${e.name.slice(0, 34)}" cited source ${e.sourceIndex}; ` +
                `resolved by quote to ${publisherFromUrl(doc.url, doc.title)}.`,
            );
          }

          const publisher = publisherFromUrl(doc.url, doc.title);
          const score = await scoreSource({
            url: doc.url,
            publisher,
            claim: effortClaim(e.name, r.subject, r.stance),
            quoteSnippet: e.quote,
          });
          const admitted = admitsEffort(score);

          // Every candidate is persisted, admitted or not, WITH its two axes.
          // Re-crawling to revisit a threshold decision is the expensive part of
          // this pipeline, and a log line cannot be replayed — it carries no URL,
          // no quote and a truncated name, so rebuilding a row from one would
          // mean inventing the very fields that make an effort citable. Storing
          // the candidate makes a future threshold change a SQL update.
          await recordCandidate(db, r, {
            name: e.name.trim().slice(0, 200),
            description: e.description.trim().slice(0, 1000),
            stage: e.stage.trim().slice(0, 60),
            sourceUrl: doc.url,
            publisher,
            quote: e.quote.trim().slice(0, 2000),
            credibility: score.credibility,
            support: score.support,
            admitted,
          });

          if (!admitted) {
            logger.warn(
              `[counter] rejected ${publisher} (cred ${score.credibility.toFixed(2)} · ` +
                `sup ${score.support.toFixed(2)}) for "${e.name.slice(0, 40)}"`,
            );
            continue;
          }

          // Replace only now that something has earned its place. On --force
          // this is the first write of the run for this target, so a worse run
          // can no longer leave it emptier than it found it.
          if (force && !cleared) {
            await clearEfforts(db, r);
            cleared = true;
          }

          // Embedded for cross-subject dedupe later — the same organisation
          // legitimately addresses several factors and branches, and knowing
          // that is useful. A failed embedding is not a reason to drop a
          // sourced effort.
          const [vector] = await embeddings.embed([`${e.name}: ${e.description}`]);

          const ok = await insertEffort(db, r, {
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
            `[counter] ${r.subject.slice(0, 40)} → ${e.name.slice(0, 40)} ` +
              `[${e.stage.slice(0, 14)}] · ${publisher}`,
          );
        }
      } catch (err) {
        logger.error(`[counter] "${r.subject.slice(0, 40)}" failed: ${(err as Error).message}`);
      }
    }

    logger.info(
      `[counter] done — ${written} effort(s) across ${rows.length} target(s); ` +
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
