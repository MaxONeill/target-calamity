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
import { retrieveDocuments, hasRetrievalCredentials, type RetrievedDocument } from './retrieval.js';
import { apiKeyFor } from './search.js';
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

/**
 * A candidate plus the quote that justifies it.
 *
 * The quote is deliberately NOT part of the stored projection — it exists to be
 * scored by the reputability gate, not to be rendered. Keeping it beside the
 * candidate rather than inside it stops it leaking into the wire type and the
 * table, while making it impossible to gate a curve without one.
 */
export interface ResearchedProjection {
  candidate: ProjectionCandidate;
  quote: string;
}

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
  /**
   * The sentence stating the trajectory, copied verbatim.
   *
   * Needed for the reputability gate, which scores whether THIS quote supports
   * THIS claim. Passing the page title instead — as this module used to — reads
   * as zero support, and since support below a floor zeroes the whole score, it
   * silently rejected every curve regardless of publisher. A Nature-grade source
   * was failing on the strength of its own headline.
   */
  quote: z.string(),
});

const EXTRACT_SYSTEM =
  'You extract a PUBLISHED PROJECTION: how a measurable quantity is projected to ' +
  'change over time. You are given retrieved sources and the quantity wanted. ' +
  'Return the trajectory the sources actually publish — a list of {year, value} ' +
  'points in the requested unit, at whatever years the sources give (milestone ' +
  'years such as 2030/2050/2100 are typical). At least TWO points, ascending by ' +
  'year, or set found=false. ' +
  'ALWAYS include the most recent OBSERVED value the source gives, not only its ' +
  'future projections. This is the single most important instruction here. A ' +
  'curve whose earliest point is years in the future cannot date any threshold ' +
  'already behind us: a warming curve starting at 2030 = 1.5 degC cannot say ' +
  'when 1.2 degC was passed, even though the same curve makes clear it WAS ' +
  "passed. A source giving today's level and one projected level has given you " +
  'two points, which is enough. Take every year the source states. ' +
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
  'sourceIndex is the number of the SOURCE block the curve came from, and quote ' +
  'is the sentence in that block stating the trajectory, copied verbatim — not ' +
  'the page title and not a paraphrase. ' +
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

/**
 * Does this curve begin in the future?
 *
 * A curve whose earliest point is years ahead has no history, so it cannot date
 * any threshold already crossed — `dateFromProjection` refuses to extrapolate
 * backwards, and refusing is right: inventing a year before the data starts is
 * exactly the failure this pipeline exists to avoid. The consequence is that a
 * genuinely-crossed threshold silently reads as "not dateable" rather than
 * "already behind us", which understates the picture.
 *
 * Surfaced rather than rejected. A future-starting curve is still the best
 * available answer for thresholds ahead of us, and dropping it would trade a
 * partial dating for none at all.
 */
export function startsInTheFuture(
  projection: Pick<ProjectionCandidate, 'points'>,
  currentYear: number,
): boolean {
  const earliest = Math.min(...projection.points.map((p) => p.year));
  return Number.isFinite(earliest) && earliest > currentYear;
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
): Promise<ResearchedProjection | null> {
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? console;

  if (!hasLiveCredentials(env) || !hasRetrievalCredentials(env)) {
    logger.warn(
      `[projections] missing FIREWORKS_API_KEY and/or a search key — cannot ` +
        `research "${request.quantity}". No curve is invented; the threshold ` +
        `simply stays undated.`,
    );
    return null;
  }

  // A curve has to come from ONE source, so the odds hinge on at least one
  // retrieved page carrying a full series — more results is the lever. But the
  // operator's ceiling wins over that preference: RETRIEVAL_MAX_RESULTS is the
  // multiplier on every search, and a module hardcoding past it makes the
  // setting a lie. Unset on both → retrieveDocuments's own default.
  const envMax = Number.parseInt(env.RETRIEVAL_MAX_RESULTS ?? '', 10);
  const maxResults =
    opts.maxResults ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : undefined);

  const docs = await retrieveDocuments(projectionQuery(request), {
    // Passed explicitly rather than left to retrieval's process.env fallback:
    // this function takes `env` injected, and reading a different environment
    // than the one it was handed is exactly the drift that makes a test pass
    // while the live path is misconfigured.
    ...(apiKeyFor(env) !== undefined ? { apiKey: apiKeyFor(env) as string } : {}),
    ...(maxResults !== undefined ? { maxResults } : {}),
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

  const candidate = normalizeProjection(raw, docs);
  if (!candidate) return null;
  // A curve with no verbatim quote cannot be gated honestly, so it is dropped
  // rather than gated against its own title.
  const quote = raw.quote.trim();
  if (quote === '') return null;
  return { candidate, quote };
}
