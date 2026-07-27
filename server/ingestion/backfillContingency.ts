/**
 * Expand the contingency chain for a crossed threshold: what it would actually
 * take to reverse it, and what THAT would take, down to where the answer runs
 * out.
 *
 *   reverse warm-water reef loss
 *     -> requires CO2 below 450-500 ppm
 *        -> requires sustained net-negative emissions
 *           -> requires carbon removal at gigatonne scale   [partial]
 *
 * The chain is the product. A flat "requires CO2 below 450 ppm" is a dead end
 * for a reader; the leaves are where the work actually is, and they are what a
 * detector-and-router points people at.
 *
 * THE RULE THAT MAKES THIS DEFENSIBLE: an edge exists only where a retrieved
 * source states it. Dependency chains are the most fabrication-prone output in
 * this system — a model will produce a fluent, plausible, entirely invented
 * chain faster than anything else, and a wrong link is hard to catch because it
 * reads like engineering rather than like an error. So every node carries its
 * own retrieval, its own verbatim quote, and its own pass through the
 * reputability gate. Nothing is admitted on the model's reasoning alone.
 *
 * A leaf with status `unknown` is a RESULT, not a failure. It marks the point
 * where no source describes what comes next — precisely the thing that needs
 * inventing, and far more useful to surface than a manufactured next step.
 *
 *   npm run backfill:contingency            # expand unexpanded crossed anchors
 *   DRY_RUN=1 npm run backfill:contingency  # list roots, no calls, no writes
 *   LIMIT=1 npm run backfill:contingency    # cap thresholds expanded (cost)
 *   FORCE=1 npm run backfill:contingency    # re-expand ones already done
 *
 * COST: one search + one turn PER NODE, so it multiplies. At depth 3 and
 * breadth 3 a single threshold can reach ~13 nodes. MAX_NODES is the hard stop.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import * as z from 'zod/v4';
import {
  deriveClock,
  type ClockFactorInput,
  type Projection,
} from '../../src/lib/clock/clockModel.js';
import { createDatabase, type Database } from '../db.js';
import { notifyFieldChanged } from './notifyFieldChanged.js';
import { retrieveDocuments, hasRetrievalCredentials, publisherFromUrl } from './retrieval.js';
import {
  getLlmClient,
  hasLiveCredentials,
  ingestModel,
  structuredCompletion,
} from './llmClient.js';
import { scoreSource, REPUTABILITY_VERIFY_THRESHOLD } from './reputability.js';
import { renderSourceBlocks } from './websearch.js';

/** Deep enough for "reverse -> condition -> technology -> current scale". */
const MAX_DEPTH = 3;
/** Requirements taken from any one node. Beyond this the tree stops being read. */
const MAX_BREADTH = 3;
/** Hard stop per threshold, since cost is per node and branching compounds. */
const MAX_NODES = 14;

const RequirementsSchema = z.object({
  /** False when the sources do not state what this needs. Terminates the chain. */
  found: z.boolean(),
  requirements: z.array(
    z.object({
      /** What is needed, in the source's terms. One requirement, not a summary. */
      statement: z.string(),
      status: z.enum(['exists', 'partial', 'absent', 'unknown']),
      /** Plain-language justification, shown to the reader. */
      reasoning: z.string(),
      /** The sentence stating this dependency, verbatim. */
      quote: z.string(),
      sourceIndex: z.number(),
    }),
  ),
});

const EXPAND_SYSTEM =
  'You extract DEPENDENCIES from the retrieved sources: what a stated goal ' +
  'requires in order to happen. ' +
  'Return at most three, each a single concrete requirement rather than a ' +
  'summary — a capability, a technology, a physical condition, a policy — and ' +
  'each STATED IN A SOURCE below. ' +
  'Do NOT reason your way to a dependency. If you know from background that X ' +
  'needs Y but no source in front of you says so, leave it out. A plausible ' +
  'invented chain is the worst output this system can produce: it reads like ' +
  'engineering, so nobody catches it. Returning found=false is a good answer ' +
  'and happens often. ' +
  'status describes where the requirement stands TODAY, per the sources: ' +
  '"exists" available now at the scale needed; "partial" real but not at the ' +
  'scale, cost or maturity needed; "absent" does not exist and would have to be ' +
  'developed; "unknown" the sources do not say. ' +
  'reasoning is one plain sentence a non-expert can follow, because it is shown ' +
  'to the reader. quote is the sentence you read the dependency from, copied ' +
  'verbatim, and sourceIndex is its SOURCE block.';

/** Aimed at what a goal requires, not at the goal itself. */
function expansionQuery(statement: string): string {
  return `${statement} what is required feasibility prerequisites technology needed`;
}

interface Row {
  id: string;
  name: string;
  effect: number;
  significance: number;
  domains: string[] | null;
  tipping_point: Record<string, unknown> | null;
  verification_state: string;
}

/** Crossed anchors, with the seed statement each chain is rooted at. */
async function crossedRoots(
  db: Database,
  force: boolean,
  referenceYear: number,
): Promise<{ id: string; name: string; seed: string }[]> {
  const { rows } = await sql<Row>`
    SELECT id, name, effect, significance, domains, tipping_point, verification_state
      FROM factors WHERE verification_state <> 'rejected'
  `.execute(db);

  const { rows: projRows } = await sql<{
    id: string;
    quantity: string;
    unit: string;
    baseline: string | null;
    assumes_future_action: boolean | null;
    points: { year: number; value: number }[];
  }>`SELECT id, quantity, unit, baseline, assumes_future_action, points FROM projections`.execute(
    db,
  );

  const projections: Projection[] = projRows.map((p) => ({
    id: p.id,
    quantity: p.quantity,
    unit: p.unit,
    points: p.points,
    ...(p.baseline !== null ? { baseline: p.baseline } : {}),
    ...(p.assumes_future_action !== null ? { assumesFutureAction: p.assumes_future_action } : {}),
  }));

  const byLabel = new Map<string, Row>();
  const factors: ClockFactorInput[] = rows.map((r) => {
    const tp = r.tipping_point as ClockFactorInput['tippingPoint'];
    const label =
      (tp?.label as string | undefined) ??
      (tp?.quantityThreshold
        ? `${tp.quantityThreshold.value} ${tp.quantityThreshold.unit} — ${tp.quantityThreshold.quantity}`
        : null);
    if (label) byLabel.set(label, r);
    return {
      effect: Number(r.effect),
      significance: Number(r.significance),
      domains: (r.domains ?? []) as never,
      verificationState: r.verification_state as never,
      ...(tp ? { tippingPoint: tp } : {}),
    };
  });

  const { rows: existing } = await sql<{ factor_id: string }>`
    SELECT DISTINCT factor_id FROM requirements
  `.execute(db);
  const expanded = new Set(existing.map((e) => e.factor_id));

  const model = deriveClock(factors, projections, referenceYear);
  const out: { id: string; name: string; seed: string }[] = [];
  for (const t of model.thresholds) {
    if (!t.anchors || !t.crossed) continue;
    const row = t.label === null ? undefined : byLabel.get(t.label);
    if (!row) continue;
    if (!force && expanded.has(row.id)) continue;

    // The chain is rooted at REVERSING the threshold. Where the recovery pass
    // already established what reversal demands, that becomes the seed — so the
    // tree starts from a cited condition rather than from the factor's title.
    const recovery = (row.tipping_point as { recovery?: { effort?: string } } | null)?.recovery;
    const seed = recovery?.effort
      ? `reversing ${row.name}: ${recovery.effort}`
      : `reversing ${row.name}`;
    out.push({ id: row.id, name: row.name, seed });
  }
  return out;
}

interface NodeToExpand {
  /**
   * This node's OWN row id, which becomes the parent of whatever it turns up.
   * Null for the seed, which has no row — so the requirements it yields are
   * roots, satisfying the schema's `(depth = 0) = (parent_id IS NULL)` check.
   */
  dbId: string | null;
  statement: string;
  /** Depth the CHILDREN of this node will be written at. */
  depth: number;
}

async function insertRequirement(
  db: Database,
  factorId: string,
  parentId: string | null,
  depth: number,
  node: {
    statement: string;
    status: string;
    reasoning: string;
    quote: string;
    sourceUrl: string;
    publisher: string;
  },
): Promise<string | null> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO requirements
      (factor_id, parent_id, statement, status, depth, source_url, publisher, quote, reasoning)
    VALUES (${factorId}::uuid, ${parentId}::uuid, ${node.statement}, ${node.status},
            ${depth}, ${node.sourceUrl}, ${node.publisher}, ${node.quote}, ${node.reasoning})
    ON CONFLICT DO NOTHING
    RETURNING id
  `.execute(db);
  return rows[0]?.id ?? null;
}

export async function backfillContingency(
  logger: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    logger.warn('[contingency] no DATABASE_URL — nothing to do, exiting.');
    return;
  }
  if (!hasLiveCredentials() || !hasRetrievalCredentials()) {
    logger.warn(
      '[contingency] needs BOTH FIREWORKS_API_KEY and a search key (SERPER_API_KEY or BRAVE_API_KEY). Every link ' +
        'must be READ from a source — an unsourced dependency chain reads like ' +
        'engineering and nobody catches it. Exiting.',
    );
    return;
  }

  const args = process.argv.slice(2);
  const dryRun =
    args.includes('--plan') || args.includes('--dry-run') || process.env.DRY_RUN === '1';
  const force = args.includes('--force') || process.env.FORCE === '1';
  const limit = Number.parseInt(process.env.LIMIT ?? '', 10);
  const referenceYear = new Date().getUTCFullYear();

  const { db, pool } = createDatabase(databaseUrl);
  try {
    let roots = await crossedRoots(db, force, referenceYear);
    if (Number.isFinite(limit) && limit > 0) roots = roots.slice(0, limit);

    logger.info(
      `[contingency] ${roots.length} crossed anchor(s) to expand` +
        `${force ? ' (--force)' : ''}. Up to ${MAX_NODES} nodes each, one search + one turn per node.`,
    );
    for (const r of roots) logger.info(`[contingency]   root: ${r.seed.slice(0, 90)}`);
    if (dryRun || roots.length === 0) {
      logger.info(
        dryRun ? '[contingency] dry run — no calls, no writes.' : '[contingency] nothing to do.',
      );
      return;
    }

    const client = getLlmClient();
    const model = ingestModel();
    let totalNodes = 0;

    for (const root of roots) {
      if (force) {
        await sql`DELETE FROM requirements WHERE factor_id = ${root.id}::uuid`.execute(db);
      }

      // Breadth-first, so a shallow complete tree beats a deep narrow one when
      // the node budget runs out.
      const queue: NodeToExpand[] = [{ dbId: null, statement: root.seed, depth: 0 }];
      // Statements already expanded in THIS tree. Chains converge — several
      // paths reach "carbon removal at scale" — and without this the same
      // subtree is researched repeatedly at full cost.
      const seen = new Set<string>();
      let nodes = 0;

      while (queue.length > 0 && nodes < MAX_NODES) {
        const current = queue.shift()!;
        if (current.depth >= MAX_DEPTH) continue;
        const key = current.statement.trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        try {
          const docs = await retrieveDocuments(expansionQuery(current.statement));
          if (docs.length === 0) continue;

          const out = await structuredCompletion({
            client,
            model,
            system: EXPAND_SYSTEM,
            user: `GOAL: ${current.statement}\n\n${renderSourceBlocks(docs)}`,
            schema: RequirementsSchema,
            schemaName: 'Requirements',
          });
          // No sourced dependency is the chain's honest terminus. The parent
          // stays a leaf and the UI marks it as having no described pathway.
          if (!out || !out.found || out.requirements.length === 0) continue;

          for (const req of out.requirements.slice(0, MAX_BREADTH)) {
            if (nodes >= MAX_NODES) break;
            const doc = docs[req.sourceIndex - 1];
            if (!doc || req.statement.trim() === '' || req.quote.trim() === '') continue;

            const publisher = publisherFromUrl(doc.url, doc.title);
            const score = await scoreSource({
              url: doc.url,
              publisher,
              claim: `${current.statement} requires ${req.statement}`,
              quoteSnippet: req.quote,
            });
            if (score.score < REPUTABILITY_VERIFY_THRESHOLD) {
              logger.warn(
                `[contingency] rejected ${publisher} (${score.score.toFixed(2)}) for ` +
                  `"${req.statement.slice(0, 50)}"`,
              );
              continue;
            }

            const id = await insertRequirement(db, root.id, current.dbId, current.depth, {
              statement: req.statement.trim().slice(0, 500),
              status: req.status,
              reasoning: req.reasoning.trim().slice(0, 1000),
              quote: req.quote.trim().slice(0, 2000),
              sourceUrl: doc.url,
              publisher,
            });
            if (!id) continue;
            nodes += 1;
            totalNodes += 1;
            logger.info(
              `[contingency] ${'  '.repeat(current.depth)}[${req.status}] ` +
                `${req.statement.slice(0, 70)} · ${publisher}`,
            );

            // An `exists` requirement is already met, so what it would in turn
            // need is not a question anyone is waiting on. Stopping there keeps
            // the budget on the branches that are actually open.
            if (req.status !== 'exists') {
              queue.push({ dbId: id, statement: req.statement, depth: current.depth + 1 });
            }
          }
        } catch (err) {
          logger.error(`[contingency] node failed: ${(err as Error).message}`);
        }
      }

      logger.info(`[contingency] ${root.name.slice(0, 50)} — ${nodes} node(s).`);
    }

    logger.info(
      `[contingency] done — ${totalNodes} requirement(s) across ${roots.length} chain(s).`,
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
  backfillContingency().catch((err: unknown) => {
    console.error('[contingency] fatal:', err);
    process.exitCode = 1;
  });
}
