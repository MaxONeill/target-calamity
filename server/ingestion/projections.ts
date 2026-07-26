/**
 * Phase A' — retrieval and extraction of PROJECTIONS.
 *
 * A threshold may be published against a quantity rather than a year ("the
 * Greenland ice sheet destabilises at ~1.5 degC"). Turning that into a date
 * needs a second published source: a trajectory for the same quantity. This
 * module fetches and extracts those, using the same retrieval + constrained
 * decode + reputability machinery as factor research, because a projection is
 * the same kind of artifact — a claim that has to earn its place by citation.
 *
 * It differs from factor research in one respect that matters: BLAST RADIUS. A
 * bad factor nudges an aggregate. A bad projection mis-dates EVERY threshold
 * pinned to its quantity, silently and confidently. So the extraction is
 * deliberately more willing to return nothing:
 *
 *   - a curve needs >= 2 points, else it cannot be interpolated
 *   - the baseline is copied or left null, NEVER guessed: "1.5 degC above
 *     pre-industrial" and "1.5 degC above 1986-2005" are ~0.6 degC apart, and
 *     the model refuses to match a threshold whose baseline it cannot confirm
 *   - the scenario label is copied verbatim, because it decides whether the
 *     Clock's forces may bend the curve at all
 *
 * Credential-gated like every other network dependency: with no keys this
 * returns null and logs, rather than fabricating a trajectory.
 */
import * as z from 'zod/v4';
import type { Projection } from '../../shared/types.js';
import {
  firecrawlSearch,
  hasRetrievalCredentials,
  type RetrievedDocument,
} from './firecrawlClient.js';
import {
  getLlmClient,
  hasLiveCredentials,
  ingestModel,
  structuredCompletion,
} from './llmClient.js';
import { renderSourceBlocks } from './websearch.js';

/** A quantity we need a trajectory for, as stated on a threshold. */
export interface QuantityRequest {
  quantity: string;
  unit: string;
  /** The threshold's own baseline. The projection must match it or be dropped. */
  baseline?: string | undefined;
}

/** An extracted projection, before persistence. No id yet. */
export type ProjectionCandidate = Omit<Projection, 'id'>;

const ExtractionProjectionSchema = z.object({
  /**
   * Whether the retrieved sources actually contain a usable trajectory. The
   * model is told to say so explicitly rather than emit a thin curve, because a
   * fabricated projection is the highest-consequence error in the system.
   */
  found: z.boolean(),
  quantity: z.string(),
  unit: z.string(),
  baseline: z.string().nullable(),
  scenario: z.string().nullable(),
  assumesFutureAction: z.boolean(),
  points: z.array(z.object({ year: z.number(), value: z.number() })),
  /** 1-based index into the SOURCE blocks. Resolved to a real URL by us. */
  sourceIndex: z.number(),
});

const EXTRACT_SYSTEM =
  'You extract a PUBLISHED PROJECTION: how a measurable quantity is projected to ' +
  'change over time. You are given retrieved sources and the quantity wanted. ' +
  'Return the trajectory the sources actually publish — a list of {year, value} ' +
  'points in the requested unit, at whatever years the sources give (milestone ' +
  'years such as 2030/2050/2100 are typical). At least TWO points, ascending by ' +
  'year, or set found=false. ' +
  'An OBSERVED present-day or recent value counts as a point, and is often what ' +
  'makes a curve usable: a source giving today\'s level and a projected level for ' +
  'one future year has given you two points. Take every year the source states. ' +
  'Use ONE source block for the whole curve — the block whose numbers are most ' +
  'complete. Do NOT stitch points from different sources together: two ' +
  'publishers can use different baselines or scenarios, and silently mixing them ' +
  'produces a curve neither of them published. ' +
  'NEVER interpolate, extrapolate, or invent a point the sources do not state: a ' +
  'wrong curve silently mis-dates every threshold that depends on it. ' +
  'baseline is the reference the values are measured against, e.g. ' +
  '"pre-industrial (1850-1900)". Copy it from the source; use null if the source ' +
  'does not state one. NEVER guess a baseline — the same quantity on two ' +
  'baselines can differ enough to move a date by decades. ' +
  'scenario is the pathway name as the source writes it: "current policies", ' +
  '"SSP2-4.5", "business as usual", "net zero by 2050". Copy verbatim, null if ' +
  'unstated. ' +
  'assumesFutureAction is TRUE when that scenario assumes action BEYOND what is ' +
  'already implemented — a mitigation or pledge pathway. It is FALSE only for a ' +
  'no-further-action baseline: current/implemented policy continuing with nothing ' +
  'new. If you cannot tell, answer TRUE. ' +
  'sourceIndex is the number of the SOURCE block the curve came from. ' +
  'Set found=false whenever the sources do not give a real trajectory for the ' +
  'requested quantity. Returning nothing is correct and expected.';

/**
 * The search query for a quantity's trajectory.
 *
 * Aimed at pages that carry the NUMBERS, not the narrative. A first attempt used
 * "<quantity> projection scenario to 2100" and returned explainer articles that
 * state one endpoint — "current policies lead to 2.7 degC" — which is a single
 * point and cannot be interpolated. Naming the milestone years and asking for a
 * table biases retrieval toward scenario tables and data pages that publish a
 * series.
 */
export function projectionQuery(request: QuantityRequest): string {
  return [
    request.quantity,
    request.unit,
    'projected values table 2030 2050 2100 scenario pathway data',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Coerce a raw extraction into a candidate, or null.
 *
 * Every rejection here is a case where dating a threshold would be worse than
 * leaving it undated. Exported for unit tests, which is where all of this is
 * exercised — the live path needs both provider keys.
 */
export function normalizeProjection(
  raw: z.infer<typeof ExtractionProjectionSchema>,
  docs: readonly RetrievedDocument[],
): ProjectionCandidate | null {
  if (!raw.found) return null;

  const quantity = raw.quantity.trim();
  const unit = raw.unit.trim();
  if (quantity === '' || unit === '') return null;

  // A citation whose index names no retrieved source is dropped outright rather
  // than persisted with an invented URL — the same rule factor citations follow.
  const doc = docs[raw.sourceIndex - 1];
  if (!doc) return null;

  const points = raw.points
    .filter((p) => Number.isFinite(p.year) && Number.isFinite(p.value))
    .sort((a, b) => a.year - b.year);
  // Deduplicate repeated years: two values for one year make interpolation
  // ambiguous, and the first stated wins rather than an averaged invention.
  const unique: { year: number; value: number }[] = [];
  for (const p of points) {
    if (unique.length === 0 || unique[unique.length - 1]!.year !== p.year) unique.push(p);
  }
  if (unique.length < 2) return null;

  const baseline = raw.baseline?.trim();
  const scenario = raw.scenario?.trim();

  return {
    quantity: quantity.slice(0, 300),
    unit: unit.slice(0, 60),
    points: unique,
    sourceUrl: doc.url,
    // Absent scenario → assumes action, matching the model's own default. An
    // unlabelled pathway cannot be shown to be assumption-free.
    assumesFutureAction: raw.assumesFutureAction !== false,
    ...(baseline ? { baseline: baseline.slice(0, 300) } : {}),
    ...(scenario ? { scenario: scenario.slice(0, 200) } : {}),
    ...(doc.title.trim() ? { sourceTitle: doc.title.trim().slice(0, 500) } : {}),
  };
}

export interface ResearchProjectionOptions {
  maxResults?: number;
  maxContentChars?: number;
  client?: ReturnType<typeof getLlmClient>;
  model?: string;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
  env?: NodeJS.ProcessEnv;
}

/**
 * Retrieve and extract a projection for one quantity. Null when no credentials,
 * no sources, or no usable trajectory — never a fabricated curve.
 */
export async function researchProjection(
  request: QuantityRequest,
  opts: ResearchProjectionOptions = {},
): Promise<ProjectionCandidate | null> {
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? console;

  if (!hasLiveCredentials(env) || !hasRetrievalCredentials(env)) {
    logger.warn(
      `[projections] missing FIREWORKS_API_KEY and/or FIRECRAWL_API_KEY — cannot ` +
        `research "${request.quantity}". No curve is invented; the threshold ` +
        `simply stays undated.`,
    );
    return null;
  }

  const apiKey = env.FIRECRAWL_API_KEY as string;
  const docs = await firecrawlSearch(projectionQuery(request), apiKey, {
    // Wider than factor research by default. A curve has to come from ONE
    // source, so the odds hinge on at least one retrieved page carrying a full
    // series — more candidates is the lever, and this runs once per quantity
    // rather than once per factor, so the cost stays bounded.
    maxResults: opts.maxResults ?? 8,
    ...(opts.maxResults !== undefined ? { maxResults: opts.maxResults } : {}),
    ...(opts.maxContentChars !== undefined ? { maxContentChars: opts.maxContentChars } : {}),
  });
  if (docs.length === 0) return null;

  const wanted =
    `QUANTITY: ${request.quantity}\nUNIT: ${request.unit}` +
    (request.baseline ? `\nBASELINE WANTED: ${request.baseline}` : '');

  const raw = await structuredCompletion({
    client: opts.client ?? getLlmClient(env),
    model: opts.model ?? ingestModel(env),
    system: EXTRACT_SYSTEM,
    user: `${wanted}\n\n${renderSourceBlocks(docs)}`,
    schema: ExtractionProjectionSchema,
    schemaName: 'ProjectionExtraction',
  });
  if (!raw) return null;

  return normalizeProjection(raw, docs);
}
