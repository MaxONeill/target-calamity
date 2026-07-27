/**
 * Phase A — LIVE research + extraction (, provider-migrated by ), the
 * front of the research engine.
 *
 * `researchFactors(topic)` turns a research TOPIC into structured candidate
 * factors, each carrying its own real-world source list. Two stages:
 *
 *   Stage 1 — RETRIEVAL (`retrieval.retrieveDocuments`). The retrieval seam
 *             `/v2/search` runs the web search AND scrapes each hit, returning
 *             ranked results with full-page markdown in ONE call. Results and
 *             per-source content length are capped for cost.
 *   Stage 2 — EXTRACTION (one Fireworks/DeepSeek turn, JSON-schema-constrained).
 *             The retrieved markdown is coerced into the typed `CandidateFactor[]`
 *             shape via `structuredCompletion`, which derives the grammar from the
 *             zod schema below and re-validates the decode with that same schema.
 *
 * CITATION CONTRACT: the model NEVER emits a URL. It cites a retrieved source by
 * its `sourceIndex`, and this module substitutes retrieval's real `url` and the
 * domain-derived `publisher`. A hallucinated index is dropped, so a persisted
 * source is always one that was genuinely retrieved. (Anthropic's server-side
 * citation handling is what we gave up here.)
 *
 * Direction vs magnitude: `effect` is the SIGNED position on the
 * Humanity↔Calamity axis (negative = Calamity, positive = Humanity) and
 * `significance ∈ [0,1]` is the magnitude. The app aggregates these into the
 * Clock's net direction; this module only produces the per-factor estimates.
 *
 * VERIFICATION happens downstream: this module does NOT decide verified/pending.
 * It surfaces the sources; `reputability.ts` scores them and the worker sets the
 * state. A candidate here is a CLAIM plus its sources, nothing more.
 *
 * OFFLINE: with EITHER credential missing ({@link hasLiveCredentials} for
 * Fireworks, {@link hasRetrievalCredentials} for Brave) we return a
 * clearly-labelled DETERMINISTIC STUB (`researchFactorsOffline`). It never touches
 * the network and must never be mistaken for live research — its sources point at
 * `example.org`, so the reputability gate leaves everything `pending` (off the
 * aggregate). Production must gate on both before trusting a result as live; this
 * module refuses to fabricate live findings silently.
 */
import * as z from 'zod/v4';
import type { TippingPoint } from '../../shared/types.js';
import {
  DOMAINS,
  DOMAIN_LABELS,
  classifyDomains,
  isDomain,
  type Domain,
} from '../../shared/domains.js';
import {
  type LlmClient,
  getLlmClient,
  hasLiveCredentials,
  ingestModel,
  structuredCompletion,
} from './llmClient.js';
import {
  DEFAULT_MAX_CONTENT_CHARS,
  DEFAULT_MAX_RESULTS,
  retrieveDocuments,
  hasRetrievalCredentials,
  type RetrievedDocument,
} from './retrieval.js';

/* -------------------------------------------------------------------------- */
/* Public shapes                                                              */
/* -------------------------------------------------------------------------- */

/** One real-world source backing a candidate factor's claim. */
export interface ResearchedSource {
  /** Canonical source URL the model cited. */
  url: string;
  /** Human-readable publisher / outlet. */
  publisher: string;
  /** The span of the source that supports the claim. */
  quoteSnippet: string;
  /**
   * True only when `quoteSnippet` is a genuine contiguous verbatim span from the
   * source; false for a paraphrase/summary. Mirrors `CitationSchema.verbatim`
   * (seed data rule #2): a paraphrase must never be rendered as a direct quote.
   */
  verbatim: boolean;
}

/**
 * A candidate factor as produced by Phase A. A signed direction + magnitude on
 * the Humanity↔Calamity axis, positioned on the globe, backed by sources. It is
 * NOT yet verified — that is the reputability gate's job downstream.
 */
export interface CandidateFactor {
  name: string;
  description: string;
  /** Signed impact. Negative = Calamity, Positive = Humanity. Clamped to [-1, 1]. */
  effect: number;
  /** Magnitude / weight. Clamped to [0, 1]. */
  significance: number;
  /** WGS84 degrees, [-90, 90]. */
  lat: number | null;
  /** WGS84 degrees, [-180, 180]. */
  lon: number | null;
  /** `global` or `global.<code>` (depth ≤ 2). */
  spatialPath: string;
  /**
   * A dated, (near-)irreversible threshold this factor represents, when
   * — and ONLY when — the sources give a concrete dated/near-dated one (e.g. an
   * AMOC-collapse or ice-free-Arctic year). Absent for the majority of factors,
   * which are pressures/counter-forces, not dated thresholds. Feeds the Clock
   * countdown baseline once persisted.
   */
  tippingPoint?: TippingPoint;
  /** Causal domains, LLM-assigned. Links the factor to the thresholds it moves. */
  domains: Domain[];
  /** The sources the model cited. May be empty; the gate treats that as pending. */
  sources: ResearchedSource[];
}

/** Tuning + injection points for one research call. */
export interface ResearchOptions {
  /** Cap on candidate factors returned from one topic (bounded batch). */
  maxCandidates?: number;
  /** Cap on retrieved+scraped sources per topic (cost control). */
  maxResults?: number;
  /** Cap on markdown characters kept per source (cost control). */
  maxContentChars?: number;
  /** Restrict search to these domains (mutually exclusive with `blockedDomains`). */
  allowedDomains?: string[];
  /** Exclude these domains (mutually exclusive with `allowedDomains`). */
  blockedDomains?: string[];
  /** Injectable LLM client (tests); defaults to the shared singleton. */
  client?: LlmClient;
  /** Injectable retrieval function (tests); defaults to the live retrieval call. */
  search?: (topic: string) => Promise<RetrievedDocument[]>;
  /** Model override; defaults to `INGEST_MODEL`. */
  model?: string;
  logger?: Pick<Console, 'warn' | 'error' | 'info'>;
}

const DEFAULT_MAX_CANDIDATES = 8;

/* -------------------------------------------------------------------------- */
/* Typed extraction schema (zod v4)                                            */
/* -------------------------------------------------------------------------- */

/**
 * The EXTRACTION-turn output contract. Authored with `zod/v4` so `z.toJSONSchema`
 * can derive the constrained-decoding grammar from it; the SAME schema
 * then validates the decode. Ranges are permissive here —
 * {@link normalizeCandidate} clamps, and `pipeline.ExtractedFactorSchema`
 * re-validates strictly and quarantines anything still out of domain (defence in
 * depth).
 *
 * `sourceIndex` — not a URL — is what the model emits: the 1-based index of the
 * retrieved source in the prompt. The real URL/publisher are substituted from the
 * retrieved document, so provenance cannot be hallucinated.
 */
const ExtractionSourceSchema = z.object({
  sourceIndex: z.number(),
  quoteSnippet: z.string(),
  verbatim: z.boolean(),
});

/**
 * Optional dated tipping-point threshold. Shape mirrors the shared
 * `TippingPointSchema`. The extraction prompt is instructed to emit this ONLY
 * when the sources give a concrete dated/near-dated threshold, else omit it.
 */
/**
 * A threshold stated against a measurable quantity instead of a year. Nullable
 * (not optional) for the same reason as `tippingPoint` itself: an optional field
 * is absent from the grammar's `required` set, so the constrained decoder would
 * never emit one and the whole quantity path would be dead on arrival.
 */
const ExtractionQuantityThresholdSchema = z.object({
  quantity: z.string(),
  value: z.number(),
  unit: z.string(),
  baseline: z.string().nullable(),
  lowValue: z.number().nullable(),
  highValue: z.number().nullable(),
});

const ExtractionTippingPointSchema = z.object({
  centralYear: z.number().nullable(),
  quantityThreshold: ExtractionQuantityThresholdSchema.nullable(),
  earliestYear: z.number().optional(),
  latestYear: z.number().optional(),
  label: z.string().optional(),
  /**
   * Required, not optional: an optional field is absent from the grammar's
   * `required` set, so the constrained decoder would skip it and every threshold
   * would arrive unjudged — which the Clock treats as "does not anchor",
   * silently suppressing the countdown. Forcing the decision is the point.
   */
  closesWindow: z.boolean(),
});

const ExtractionCandidateSchema = z.object({
  name: z.string(),
  description: z.string(),
  effect: z.number(),
  significance: z.number(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  spatialPath: z.string(),
  // Nullable, NOT optional: an optional field is absent from the grammar's
  // `required` set, so the constrained decoder skips it and the model never
  // emits a tipping point (lat/lon, which are nullable, were always emitted).
  // Nullable forces the model to make an explicit null-or-object decision per
  // factor, so a real dated threshold is actually captured.
  tippingPoint: ExtractionTippingPointSchema.nullable(),
  // Required array (empty when none): a required field is in the grammar's
  // `required` set, so the constrained decoder always emits it. This is the
  // authoritative domain classification — the keyword classifier in
  // shared/domains.ts is only a fallback for untagged rows.
  domains: z.array(z.enum(DOMAINS)),
  sources: z.array(ExtractionSourceSchema),
});

const ExtractionSchema = z.object({
  factors: z.array(ExtractionCandidateSchema),
});

/* -------------------------------------------------------------------------- */
/* Live research                                                              */
/* -------------------------------------------------------------------------- */

const EXTRACTION_SYSTEM =
  'You are a research analyst for a live "reality tracker" plotting forces on a ' +
  'Humanity↔Calamity axis. You are given the full text of several retrieved web ' +
  'sources about a topic. Convert them into structured factors. Use ONLY information ' +
  'present in the notes — do not invent sources or figures. effect is a SIGNED ' +
  'number in [-1, 1]: negative = Calamity (systemic decay), positive = Humanity ' +
  '(resilient counter-measure); its MAGNITUDE reflects how decisive the force is. ' +
  'significance is in [0, 1] and measures HOW MUCH OF THE SYSTEM THIS MOVES — ' +
  'not how newsworthy it is, and NOT how confident you are (source confidence is ' +
  'scored separately). Anchor it to the scale of the system affected: ' +
  '0.90-1.00 planetary, altering an Earth-system subsystem — global climate, ' +
  'ocean circulation, a major biome, the global food or energy supply; ' +
  '0.70-0.85 continental or multi-national, or a globally dominant sector; ' +
  '0.40-0.65 one country, one sector, or one biome region; ' +
  '0.15-0.35 sub-national, a single species, or a single ecosystem; ' +
  'below 0.15 a single site or one organisation. ' +
  'Worked contrast, because this is the error to avoid: global coral-reef ' +
  'collapse is 0.9+ (a planetary biome), while a national single-species ' +
  'recovery such as the Iberian lynx is ~0.25 — a real and welcome success, but ' +
  'it moves one species in one country. They must NOT score alike. ' +
  'A finding about one country scores in the national band UNLESS that country ' +
  'demonstrably moves a global system (e.g. Chinese or US emissions), in which ' +
  'case say so in the description. ' +
  'Use the WHOLE range. Most findings are not planetary; scores below 0.5 are ' +
  'normal and expected, and a corpus where everything scores 0.7-0.9 is a ' +
  'corpus that has stopped discriminating. lat/lon are WGS84 degrees. ' +
  'PREFER a real, defensible location: the centre of the affected region, the ' +
  'basin, biome, ice sheet, or country the sources actually discuss (e.g. an ' +
  'AMOC finding belongs in the North Atlantic, an ice-sheet finding in ' +
  'Greenland or Antarctica, a reef finding in the tropical reef belt). ' +
  'Set lat AND lon to null ONLY when the factor is genuinely placeless — an ' +
  'aggregate with no meaningful centre, such as global income concentration. ' +
  'NEVER use 0,0 to mean "global": that is a real location in the Gulf of ' +
  'Guinea and would place the factor there. spatialPath ' +
  "is 'global' for worldwide factors or 'global.<iso-ish-code>' for one country. " +
  'tippingPoint is REQUIRED on every factor: emit an object when the sources give ' +
  'a THIS-factor (near-)irreversible threshold, else emit null. A threshold may be ' +
  'stated EITHER as a year OR against a measurable quantity, and BOTH count. ' +
  'Set centralYear when the sources give a year (e.g. a projected AMOC-collapse or ' +
  'ice-free-Arctic year), else null. Set quantityThreshold when the sources instead ' +
  'state the threshold against something measurable — this is how the literature ' +
  'usually publishes it, e.g. "the Greenland ice sheet destabilises at about ' +
  '1.5 degC of warming" or "Amazon dieback beyond 20-25% deforested" — else null. ' +
  'For quantityThreshold: quantity is WHAT IS MEASURED in the source\'s own words, ' +
  'value/unit is where the threshold sits, lowValue/highValue the published range ' +
  '(null if none), and baseline is the reference the value is stated against ' +
  '(e.g. "pre-industrial (1850-1900)"). Give baseline whenever the source states ' +
  'one and null otherwise — NEVER guess it: "1.5 degC above pre-industrial" and ' +
  '"1.5 degC above 1986-2005" differ by about 0.6 degC, and a wrong baseline dates ' +
  'the threshold to a confidently wrong year. Emit at most ONE of centralYear or ' +
  'quantityThreshold; prefer quantityThreshold when the source gives both, since a ' +
  'stated quantity is what the science actually measured. centralYear is the ' +
  'best-estimate year; a CONTESTED or RANGED ' +
  'estimate STILL counts — use the midpoint as centralYear and the bounds as ' +
  'earliestYear/latestYear, with a short label naming the source. A threshold ' +
  'ALREADY CROSSED counts too: use the year it was crossed, even if it is in the ' +
  'past. Use null ONLY ' +
  'when the sources genuinely give no projected year — most factors are ongoing ' +
  'pressures, not dated thresholds. NEVER invent or guess a year to avoid null. ' +
  'closesWindow is REQUIRED inside tippingPoint and decides whether this ' +
  'threshold anchors the countdown. Set it TRUE only if crossing this threshold ' +
  'means human action can NO LONGER restore the prior state — the change becomes ' +
  'self-sustaining or irreversible on a policy timescale (e.g. an ice-sheet or ' +
  'AMOC collapse, rainforest dieback past the point of self-recovery). Set it ' +
  'FALSE for a dated event that is severe but still correctable, reversible, or ' +
  'merely a projection of accumulating damage (e.g. a species-loss or ' +
  'pollution-tonnage milestone, an economic or demographic threshold). If the ' +
  'sources do not support the stronger claim, answer FALSE. ' +
  'domains is REQUIRED (an array, possibly empty): the causal domains this factor ' +
  'acts in, chosen ONLY from ' +
  DOMAINS.map((d) => `${d} (${DOMAIN_LABELS[d]})`).join(', ') +
  '. Tag every domain the factor is a pressure or counter-force in, or a threshold ' +
  'of — e.g. an emissions or clean-energy factor is [climate]; an AMOC or coral ' +
  'factor is [ocean]; deforestation is [forest]. Use [] only when none genuinely ' +
  'apply. These links decide which tipping points the factor moves. ' +
  'Cite sources by sourceIndex — the number of the SOURCE block the evidence came ' +
  'from. NEVER write a URL; the system attaches the real URL itself. Give a ' +
  'supporting quote per source, and verbatim = true ONLY if that quote is copied ' +
  'contiguously from the source text. Cover both harmful (Calamity) and beneficial ' +
  '(Humanity) developments where the sources support them, and prefer primary or ' +
  'reputable secondary evidence. Report only what the sources actually say; flag ' +
  'uncertainty rather than inflating figures.';

/**
 * Render the retrieved documents as numbered SOURCE blocks. The 1-based number is
 * the `sourceIndex` the model cites, and the URL is shown only so the model can
 * judge provenance — it is instructed never to reproduce it.
 */
export function renderSourceBlocks(docs: readonly RetrievedDocument[]): string {
  return docs
    .map((d, i) => {
      const body = d.markdown.trim() || d.description.trim();
      return (
        `SOURCE ${i + 1}\n` +
        `title: ${d.title || '(untitled)'}\n` +
        `publisher: ${d.publisher}\n` +
        `url: ${d.url}\n` +
        `content:\n${body}`
      );
    })
    .join('\n\n---\n\n');
}

function extractionUserPrompt(
  topic: string,
  docs: readonly RetrievedDocument[],
): string {
  return (
    `Topic: ${topic}\n\n` +
    `${docs.length} retrieved source(s) follow. Extract the distinct, verifiable ` +
    'developments they establish.\n\n' +
    renderSourceBlocks(docs)
  );
}

/**
 * Run the typed EXTRACTION turn over the retrieved sources. Returns raw
 * candidates, or `[]` when the model produced nothing schema-conformant (the
 * conservative default — Phase A would rather emit no factor than a malformed one).
 */
async function runExtractionTurn(
  client: LlmClient,
  model: string,
  topic: string,
  docs: readonly RetrievedDocument[],
): Promise<z.infer<typeof ExtractionSchema>['factors']> {
  const parsed = await structuredCompletion({
    client,
    model,
    system: EXTRACTION_SYSTEM,
    user: extractionUserPrompt(topic, docs),
    schema: ExtractionSchema,
    schemaName: 'CandidateFactors',
  });
  return parsed?.factors ?? [];
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                              */
/* -------------------------------------------------------------------------- */

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

/** `global` or `global.<segment>`; anything else collapses to `global`. */
function normalizeSpatialPath(path: string): string {
  return /^global(\.[a-z0-9_]+)?$/.test(path) ? path : 'global';
}

/**
 * Keep a tipping point only when it carries a finite `centralYear` (the one
 * required field). Optional bounds/label are passed through when finite/non-empty.
 * Returns null so a degenerate one is simply omitted rather than poisoning the
 * Clock baseline (which itself ignores non-finite central years, defence in depth).
 */
function normalizeTippingPoint(
  raw: z.infer<typeof ExtractionTippingPointSchema> | null | undefined,
): TippingPoint | null {
  if (!raw) return null;

  const hasYear = raw.centralYear !== null && Number.isFinite(raw.centralYear);
  const q = raw.quantityThreshold;
  const hasQuantity =
    q !== null &&
    Number.isFinite(q.value) &&
    q.quantity.trim().length > 0 &&
    q.unit.trim().length > 0;

  // Neither form present → not a dated threshold, which is the common case.
  if (!hasYear && !hasQuantity) return null;

  const tp: TippingPoint = {};
  if (hasYear) tp.centralYear = raw.centralYear as number;
  if (hasQuantity) {
    const qt: NonNullable<TippingPoint['quantityThreshold']> = {
      quantity: q.quantity.trim().slice(0, 300),
      value: q.value,
      unit: q.unit.trim().slice(0, 60),
    };
    const baseline = q.baseline?.trim();
    if (baseline) qt.baseline = baseline.slice(0, 300);
    if (q.lowValue !== null && Number.isFinite(q.lowValue)) qt.lowValue = q.lowValue;
    if (q.highValue !== null && Number.isFinite(q.highValue)) qt.highValue = q.highValue;
    tp.quantityThreshold = qt;
  }
  if (raw.earliestYear !== undefined && Number.isFinite(raw.earliestYear)) {
    tp.earliestYear = raw.earliestYear;
  }
  if (raw.latestYear !== undefined && Number.isFinite(raw.latestYear)) {
    tp.latestYear = raw.latestYear;
  }
  const label = raw.label?.trim();
  if (label) tp.label = label.slice(0, 500);
  // Persist only the affirmative judgement. Writing `false` explicitly would be
  // indistinguishable downstream from `absent`, and absent already means "does
  // not anchor" — so storing it buys nothing and grows every row.
  if (raw.closesWindow === true) tp.closesWindow = true;
  return tp;
}

/**
 * Coerce one raw extracted candidate into range so a slightly-off-domain but
 * otherwise good factor is not needlessly quarantined by the strict re-validation
 * in the pipeline. Returns null for a candidate too degenerate to keep.
 */
export function normalizeCandidate(
  raw: z.infer<typeof ExtractionCandidateSchema>,
  docs: readonly RetrievedDocument[],
): CandidateFactor | null {
  const name = raw.name.trim();
  if (name.length === 0) return null;
  const tippingPoint = normalizeTippingPoint(raw.tippingPoint);
  return {
    name: name.slice(0, 500),
    description: raw.description.trim().slice(0, 20_000) || name,
    effect: clamp(raw.effect, -1, 1),
    significance: clamp(raw.significance, 0, 1),
    // Both or neither: a half-located factor is not a meaningful state.
    lat: raw.lat === null || raw.lon === null ? null : clamp(raw.lat, -90, 90),
    lon: raw.lat === null || raw.lon === null ? null : clamp(raw.lon, -180, 180),
    spatialPath: normalizeSpatialPath(raw.spatialPath.trim()),
    // Dedupe and keep only known domains (the enum already constrains the decode).
    domains: [...new Set(raw.domains.filter(isDomain))],
    // Present only when a concrete dated threshold survived normalization.
    ...(tippingPoint ? { tippingPoint } : {}),
    // Provenance is resolved from the RETRIEVED documents, never from model text:
    // a citation whose 1-based index does not name a real retrieved source is
    // dropped outright rather than persisted with an invented URL.
    sources: raw.sources.flatMap((s) => {
      const doc = docs[Math.round(s.sourceIndex) - 1];
      const quote = s.quoteSnippet.trim();
      if (!doc || quote.length === 0) return [];
      return [
        {
          url: doc.url,
          publisher: doc.publisher || 'Unknown publisher',
          quoteSnippet: quote.slice(0, 5_000),
          verbatim: s.verbatim === true,
        },
      ];
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/** Read a positive integer from the environment, else the supplied default. */
function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Research one topic into candidate factors. LIVE when BOTH credentials are
 * present (retrieval + one constrained Fireworks extraction turn);
 * otherwise the deterministic OFFLINE STUB. The result is capped at
 * `maxCandidates`.
 */
export async function researchFactors(
  topic: string,
  opts: ResearchOptions = {},
): Promise<CandidateFactor[]> {
  const logger = opts.logger ?? console;
  const maxCandidates = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const env = process.env;

  // A caller-injected `search` (tests) still needs an LLM; a missing EITHER key
  // means we cannot do live research, so we say so and stub — never fabricate.
  if (!hasLiveCredentials(env) || (!opts.search && !hasRetrievalCredentials(env))) {
    logger.warn?.(
      '[ingestion] missing FIREWORKS_API_KEY and/or a search key — ' +
        'researchFactors is returning the DETERMINISTIC OFFLINE STUB (NOT live; ' +
        'sources are placeholders and stay pending). Set BOTH keys for live research.',
    );
    return researchFactorsOffline(topic).slice(0, maxCandidates);
  }

  const client = opts.client ?? getLlmClient(env);
  const model = opts.model ?? ingestModel(env);
  const maxResults =
    opts.maxResults ?? positiveIntEnv(env.RETRIEVAL_MAX_RESULTS, DEFAULT_MAX_RESULTS);
  const maxContentChars =
    opts.maxContentChars ??
    positiveIntEnv(env.RETRIEVAL_MAX_CONTENT_CHARS, DEFAULT_MAX_CONTENT_CHARS);

  let docs: RetrievedDocument[];
  try {
    docs = opts.search
      ? await opts.search(topic)
      : await retrieveDocuments(topic, {
          maxResults,
          maxContentChars,
          ...(opts.allowedDomains && opts.allowedDomains.length > 0
            ? { includeDomains: opts.allowedDomains }
            : opts.blockedDomains && opts.blockedDomains.length > 0
              ? { excludeDomains: opts.blockedDomains }
              : {}),
        });
  } catch (err) {
    // Retrieval failure yields NO candidates — never a stub dressed up as live.
    logger.error?.(`[ingestion] retrieval failed for "${topic}": ${String(err)}`);
    return [];
  }

  const usable = docs.filter(
    (d) => d.markdown.trim().length > 0 || d.description.trim().length > 0,
  );
  if (usable.length === 0) {
    logger.warn?.(`[ingestion] retrieval returned no usable content for "${topic}".`);
    return [];
  }

  const raw = await runExtractionTurn(client, model, topic, usable);
  const candidates: CandidateFactor[] = [];
  for (const r of raw) {
    const c = normalizeCandidate(r, usable);
    if (c !== null) candidates.push(c);
    if (candidates.length >= maxCandidates) break;
  }
  return candidates;
}

/* -------------------------------------------------------------------------- */
/* Offline deterministic stub                                                 */
/* -------------------------------------------------------------------------- */

/** FNV-1a → 32-bit seed (dependency-free, stable across processes). */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG — deterministic, tiny. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic offline candidate set for a topic. Seeded by the topic string so
 * the same topic always yields the same factors (reproducible tests / offline
 * demos). Values are guaranteed in-domain. Its sources are DELIBERATELY
 * placeholders (`example.org`) so the reputability gate keeps them `pending` —
 * the offline path never fabricates a "verified" finding.
 */
export function researchFactorsOffline(topic: string): CandidateFactor[] {
  const seed = fnv1a(`offline::${topic}`);
  const rand = mulberry32(seed);
  const count = 1 + (seed % 2); // 1 or 2 candidates, deterministically.

  const out: CandidateFactor[] = [];
  for (let i = 0; i < count; i++) {
    const effect = Number((rand() * 2 - 1).toFixed(4)); // [-1, 1]
    const significance = Number((0.1 + rand() * 0.8).toFixed(4)); // [0.1, 0.9]
    const lat = Number((rand() * 180 - 90).toFixed(4));
    const lon = Number((rand() * 360 - 180).toFixed(4));
    const polarity = effect < 0 ? 'Calamity' : 'Humanity';
    // The FIRST stub factor carries a deterministic dated threshold so the offline
    // path exercises the tipping-point plumbing end-to-end. A near-future
    // year derived from the seed; later stubs stay threshold-less (the common case).
    const tippingPoint: TippingPoint | undefined =
      i === 0
        ? {
            centralYear: 2030 + (seed % 40),
            earliestYear: 2028 + (seed % 5),
            latestYear: 2075 + (seed % 20),
            label: `[offline] projected threshold for "${topic}" (stub, unverified)`,
          }
        : undefined;
    out.push({
      name: `[offline] ${topic} signal ${i + 1}`,
      description:
        `Deterministic offline stub factor for "${topic}" (${polarity} direction). ` +
        'Not live research — placeholder pending verification.',
      effect,
      significance,
      lat,
      lon,
      spatialPath: 'global',
      // Offline stub: derive domains from the topic text via the fallback
      // classifier (there is no live model to assign them).
      domains: classifyDomains(topic),
      ...(tippingPoint ? { tippingPoint } : {}),
      sources: [
        {
          url: `https://example.org/offline/${seed.toString(16)}/${i}`,
          publisher: 'Offline Stub Registry',
          quoteSnippet: `Placeholder evidence for "${topic}" (offline stub, unverified).`,
          verbatim: false,
        },
      ],
    });
  }
  return out;
}
