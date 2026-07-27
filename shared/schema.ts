/**
 * Shared zod contract — the single source of truth for client and server
 *. TypeScript types are derived from these schemas via `z.infer` in
 * `shared/types.ts`; never hand-write a type that duplicates a schema here.
 *
 * Runtime validation happens at the API boundary on both sides: the server
 * validates request payloads and re-validates its own responses; the client
 * validates responses before trusting them. A schema change is therefore a
 * contract change visible to both halves at compile time.
 *
 * Numeric domains mirror the enforced database CHECK constraints ( /
 * ): effect ∈ [-1, 1], significance ∈ [0, 1], lat ∈ [-90, 90],
 * lon ∈ [-180, 180]. Keeping them here means a poisoned row that somehow
 * bypasses the DB is still rejected before it reaches the shader or the feed.
 */
import { z } from 'zod';
import { DOMAINS } from './domains.js';

/**
 * Causal domain tag (see `shared/domains.ts`). Server-derived from a factor's
 * text and carried on the lean field set so the Clock can link forces to the
 * tipping points they act on without shipping the full description.
 */
export const DomainSchema = z.enum(DOMAINS);

/* -------------------------------------------------------------------------- */
/* Enumerations                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Spatial tier. Phase 1 is strictly bounded to Global and National
 * <= 2`). Derived from `spatial_path`
 * on the server, so it is read-only from the client's perspective.
 */
export const ZoneLevelSchema = z.enum(['global', 'national']);

/**
 * Feed sort mode. `recent` keys on insertion recency; `magnitude` keys on
 * absolute impact index |effect|. The cursor is
 * mode-tagged so a cursor minted under one mode can never be replayed
 * against the other.
 */
export const SortModeSchema = z.enum(['recent', 'magnitude']);

/**
 * Verification lifecycle. LLM-ingested factors land as `pending`,
 * visibly marked in the UI and excluded from the field bake, until reviewed and
 * promoted to `verified`.
 */
export const VerificationStateSchema = z.enum(['verified', 'pending']);

/* -------------------------------------------------------------------------- */
/* Core entities                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A dated, (near-)irreversible threshold a factor represents. Most
 * factors have none — they are pressures or counter-forces, not dated thresholds
 * — so it is `.optional()` on both {@link FactorSchema} and {@link FieldPinSchema}.
 *
 * This shape MUST match the `TippingPoint` interface in `src/ui/clockModel.ts`
 * field-for-field (centralYear required; earliest/latest/label optional) so a
 * `Factor`/`FieldPin` is structurally assignable to the Clock's
 * `ClockFactorInput` and the countdown can anchor to it. `.optional()` (not
 * `.nullable()`) keeps it clean under exactOptionalPropertyTypes.
 */
/**
 * A threshold expressed against a measurable quantity rather than a date.
 *
 * This exists because the tipping-point literature almost never publishes
 * years. It publishes "the Greenland ice sheet destabilises at ~1.5 °C" or
 * "Amazon dieback beyond 20–25% deforested". Requiring a year excluded exactly
 * the anchors this product is about: AMOC, Greenland, West Antarctic and
 * permafrost were all already in the factor set carrying no threshold at all,
 * because the honest answer to "what year?" was null.
 *
 * The year is recovered by reading a published {@link ProjectionSchema} for the
 * same quantity and finding when it reaches `value`. Nobody estimates a date;
 * it is a lookup across two cited sources.
 *
 * `quantity` is deliberately free text. A fixed vocabulary would cap coverage at
 * whatever was anticipated, and identity ("global temperature" vs "GMST anomaly")
 * is the problem this codebase already solves for factors with embeddings plus a
 * resolver.
 */
export const QuantityThresholdSchema = z.object({
  /** What is measured, in the source's own words. Matched semantically. */
  quantity: z.string().min(1),
  /** Where the threshold sits on that quantity. */
  value: z.number(),
  /** Unit as published, e.g. "degC", "ppm", "percent". */
  unit: z.string().min(1),
  /**
   * The reference the value is stated against, e.g. "pre-industrial (1850-1900)".
   *
   * Load-bearing, not decoration: "1.5 degC above pre-industrial" and "1.5 degC
   * above 1986-2005" are the same quantity and unit roughly 0.6 degC apart.
   * Dating a threshold against a projection on a different baseline yields a
   * confidently wrong year, which is the worst failure this product has. A
   * threshold whose baseline is unknown must not be dated at all.
   */
  baseline: z.string().optional(),
  /** Lower/upper bounds of the published threshold range, same unit. */
  lowValue: z.number().optional(),
  highValue: z.number().optional(),
});

/**
 * What it would take to reverse a threshold that has already been crossed.
 *
 * Every field is READ from a source, never derived. In particular
 * `timescaleYears` is a published restoration timescale — reef recovery in
 * decades to centuries, permafrost in centuries, ice sheets in millennia — and
 * is NEVER computed from `effort`. Turning "requires large-scale carbon
 * removal" into a number of years ourselves would reinvent exactly the operator
 * estimate this product removed: a figure with no source that reads as one.
 *
 * A source giving effort but no timescale therefore yields `effort` with
 * `timescaleYears` absent, and the UI must show the gap rather than fill it.
 */
export const RecoverySchema = z.object({
  /** Published restoration timescale in years. Absent when none is stated. */
  timescaleYears: z.number().optional(),
  /** Lower/upper bounds of that timescale where the source gives a range. */
  timescaleLowYears: z.number().optional(),
  timescaleHighYears: z.number().optional(),
  /** What reversal demands, in the source's own framing. */
  effort: z.string().min(1),
  /** Why this is the assessment — shown to the reader, not just logged. */
  reasoning: z.string().min(1),
  /** The sentence the assessment was read from, verbatim. */
  quote: z.string().min(1),
  sourceUrl: z.string().url(),
  publisher: z.string().optional(),
});

/** Where a requirement stands today. `unknown` is also the chain's terminus. */
export const RequirementStatusSchema = z.enum(['exists', 'partial', 'absent', 'unknown']);

/**
 * Someone actually working on an open requirement — the router half of the
 * product. Detecting a problem and leaving a reader at it is only half a job.
 *
 * RESEARCHED, not inferred. The first attempt matched requirements against
 * Humanity factors already ingested and matched nothing at all, because the
 * factor set records what is happening TO the world rather than who is working
 * on what. So these are retrieved on their own terms.
 *
 * `sourceUrl` and `quote` are required, unlike almost everywhere else in this
 * schema, and that asymmetry is deliberate: "name organisations working on X" is
 * the easiest prompt here to answer fluently and wrongly, and a reader may
 * FOLLOW one of these — donate, apply, cite. An unsourced list of plausible
 * names is worse than an empty section.
 *
 * Unranked on purpose. Reporting who is working on something is journalism;
 * ordering them by promise is an opinion this system has no basis for.
 */
export const CounterEffortSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().min(1),
  /**
   * How many other factors and requirements this organisation is linked to.
   *
   * The reason organisations have one identity rather than a row per target: a
   * body working across several thresholds is a stronger signal than one
   * appearing beside a single problem, and the per-target model could not
   * express it.
   */
  linkCount: z.number().int().min(1).default(1),
  /**
   * Measured outcomes attributed to this organisation — the factors it has
   * PRODUCED, as opposed to the problems it addresses.
   *
   * These are ordinary factors with a real effect and significance, so they are
   * the channel by which an effort reaches the Clock. The organisation itself
   * never carries a score: no source publishes how many years a programme shifts
   * a threshold, and if mere existence moved the countdown it would measure how
   * hard we searched rather than the state of the world.
   */
  outcomes: z
    .array(
      z.object({
        factorId: z.string().uuid(),
        name: z.string(),
        effect: z.number(),
        significance: z.number(),
      }),
    )
    .default([]),
  /**
   * How far along, in the source's words — research, pilot, deploying,
   * operating, unclear. Free text rather than an enum: maturity vocabulary
   * differs between a policy campaign and a hardware programme, and one ladder
   * for both would mean inventing the rungs.
   */
  stage: z.string().optional(),
  sourceUrl: z.string().url(),
  publisher: z.string().optional(),
  quote: z.string().min(1),
});

/**
 * One link in the chain of what it would take to reverse a crossed threshold.
 *
 * Flat at the wire — `parentId` reconstructs the tree client-side — because the
 * set per threshold is small and a flat array survives schema evolution better
 * than nested recursion.
 *
 * Every node is a CITED claim. Dependency chains are the most fabrication-prone
 * output in this system: a model produces a fluent, plausible, invented chain
 * faster than anything else, and a wrong link reads like engineering rather than
 * like an error. So an edge exists only where a source states it.
 *
 * A leaf with `status: 'unknown'` is a feature, not a gap. It marks where no
 * source describes what comes next — the thing that actually needs inventing,
 * which is more useful than a manufactured next step.
 */
export const RequirementSchema = z.object({
  id: z.string().uuid(),
  /** The threshold whose reversal this chain describes. */
  factorId: z.string().uuid(),
  /** Null at the root, which states what reversing the threshold itself needs. */
  parentId: z.string().uuid().nullable(),
  statement: z.string().min(1),
  status: RequirementStatusSchema,
  depth: z.number().int().min(0),
  sourceUrl: z.string().url().optional(),
  publisher: z.string().optional(),
  quote: z.string().optional(),
  reasoning: z.string().optional(),
  /**
   * Counter-efforts already tracked that relate to this requirement.
   *
   * A SEMANTIC match between the requirement's wording and the factor's — not a
   * claim the factor satisfies it. `distance` travels so the closeness is
   * visible, and the UI says "related work" rather than "solution". Overstating
   * that link would be the same failure as an invented dependency, dressed as
   * helpfulness.
   *
   * An empty array is meaningful: nothing in the set addresses this. That is a
   * gap in what the tracker knows about, and worth showing as one.
   */
  efforts: z
    .array(
      z.object({
        factorId: z.string().uuid(),
        name: z.string(),
        distance: z.number(),
      }),
    )
    .default([]),
  /**
   * Researched counter-efforts: who is working on this, each with the source
   * that says so. Distinct from `efforts` above, which is only a semantic
   * neighbour among already-tracked factors — these were gone and found.
   *
   * An empty array on an open requirement is a real finding, not a rendering
   * gap: nobody the retrieval could reach is working on this.
   */
  counterEfforts: z.array(CounterEffortSchema).default([]),
});

export const TippingPointSchema = z
  .object({
    /**
     * Best-estimate calendar year the threshold is crossed (e.g. 2050). Optional
     * since migration 010: a threshold may instead be pinned to a quantity and
     * dated from a projection. Exactly one of the two must be present — see the
     * refinement below.
     */
    centralYear: z.number().optional(),
    /** Optional earliest credible year (lower bound of the published range). */
    earliestYear: z.number().optional(),
    /** Optional latest credible year (upper bound of the published range). */
    latestYear: z.number().optional(),
    /** Threshold stated against a measurable quantity instead of a date. */
    quantityThreshold: QuantityThresholdSchema.optional(),
    /** Short provenance label, e.g. "AMOC collapse (Ditlevsen & Ditlevsen 2023)". */
    label: z.string().optional(),
    /**
     * Does crossing this threshold close the course-correction window — i.e. does
     * human action stop being able to restore the prior state once it is passed?
     *
     * Only thresholds where this is TRUE anchor the Clock. A dated threshold that
     * is merely severe (a coral-reef loss projection, a demographic milestone) is
     * still real evidence and still displayed, but the timeline the product claims
     * to give is about when correction stops being sufficient, so it must rest on
     * thresholds that answer that question.
     *
     * `.optional()` because rows predating the field carry no judgement. Absent is
     * treated as FALSE — a threshold no one has assessed must not silently drive
     * the headline. `server/ingestion/backfillWindowClosers.ts` fills them in.
     */
    closesWindow: z.boolean().optional(),
    /**
     * What reversing this would take, once it has already been crossed.
     *
     * A crossed threshold is a DEBT, not a terminal state. Reversing warm-water
     * reef loss is not impossible — it is centuries of recovery conditional on
     * sustained cooling. Ice-sheet collapse is harder again. Collapsing that
     * gradient into "the window is shut" throws away the only information a
     * reader can act on.
     *
     * Populated only for thresholds dated in the PAST, by
     * `server/ingestion/backfillRecovery.ts`. It does not move the countdown —
     * the countdown is a function of the threshold dates alone and must not lurch
     * when a date it already predicted arrives. This explains the state; it does
     * not adjust it.
     */
    recovery: RecoverySchema.optional(),
  })
  .refine((tp) => tp.centralYear !== undefined || tp.quantityThreshold !== undefined, {
    message:
      'a tipping point must be dated either directly (centralYear) or by a ' +
      'quantity threshold resolved against a projection',
  });

/**
 * A published trajectory for a measurable quantity over time. Dating a
 * quantity-expressed threshold means reading one of these.
 *
 * A projection is ingested and gated exactly like a factor, but its blast radius
 * is larger: a wrong factor nudges an aggregate, a wrong projection mis-dates
 * EVERY threshold pinned to its quantity. It should clear a higher bar, not the
 * same one.
 */
export const ProjectionSchema = z.object({
  id: z.string().uuid(),
  /** What is projected, in the source's own words. Matched semantically. */
  quantity: z.string().min(1),
  unit: z.string().min(1),
  /** Reference the values are stated against. Must agree with the threshold's. */
  baseline: z.string().optional(),
  /**
   * The scenario the source names — "current policies", "SSP2-4.5",
   * "business as usual". Copied verbatim, never inferred.
   *
   * This decides whether the Clock's forces may bend the curve. A mitigation
   * pathway already assumes future clean-energy expansion, so letting a
   * clean-energy factor push it further counts the same action twice. A
   * current-policies pathway assumes nothing new, so a factor describing new
   * action is genuinely new information. See `assumesFutureAction`.
   */
  scenario: z.string().optional(),
  /**
   * True when the scenario bakes in action beyond what is already implemented.
   * Forces do NOT bend such a curve — the overlap would be unquantifiable.
   * Absent → treated as true, because an unlabelled projection cannot be shown
   * to be assumption-free and guessing in the permissive direction is what
   * produces a Clock that reads later than any source supports.
   */
  assumesFutureAction: z.boolean().optional(),
  /** The curve, ascending by year. At least two points to interpolate between. */
  points: z.array(z.object({ year: z.number(), value: z.number() })).min(2),
  sourceUrl: z.string().url(),
  sourceTitle: z.string().optional(),
});

/**
 * A single piece of evidence attached to a factor. One-to-many strict: every
 * citation belongs to exactly one factor (`factor_id NOT NULL`).
 * Timestamps cross the wire as ISO 8601 strings.
 */
export const CitationSchema = z.object({
  id: z.string().uuid(),
  factorId: z.string().uuid(),
  sourceUrl: z.string().url().nullable(),
  publisher: z.string(),
  quoteSnippet: z.string(),
  /**
   * True only when `quoteSnippet` is a genuine contiguous span lifted verbatim
   * from the cited source; false when it is a paraphrase/summary or a composite
   * that no single source sentence contains (seed data rule #2 / review finding #12).
   * The UI MUST render a verbatim:false snippet WITHOUT quotation marks and with
   * a "summary" affordance so a paraphrase can never masquerade as a direct quote.
   * Defaults to `false` so anything of unknown provenance (e.g. machine-ingested
   * citations that never set it) is treated as a paraphrase, never a quote.
   */
  verbatim: z.boolean().default(false),
  analystNotes: z.string().nullable(),
  retrievedAt: z.string().datetime({ offset: true }),
});

/**
 * A tracked vector of systemic decay (Calamity, negative effect) or resilient
 * counter-measure (Humanity, positive effect). This is the feed/detail shape:
 * it carries its citations inline (, returned via `json_agg`) but never
 * the `embedding` — that column stays server-side and never crosses the wire.
 */
export const FactorSchema = z.object({
  id: z.string().uuid(),
  spatialPath: z.string(),
  name: z.string(),
  description: z.string(),
  /** Signed impact. Negative = Calamity, Positive = Humanity. Bounded. */
  effect: z.number().gte(-1).lte(1),
  /** Weight coefficient mapping to physical vertex weight. */
  significance: z.number().gte(0).lte(1),
  /**
   * WGS84 degrees. `null` on a PLACELESS factor — one with no meaningful
   * centroid, such as global income concentration. Placeless factors render on
   * the global ring instead of as pins, stay out of the field bake, and still
   * count toward the Clock. `lat` and `lon` are null together or not at all.
   */
  lat: z.number().gte(-90).lte(90).nullable(),
  lon: z.number().gte(-180).lte(180).nullable(),
  zoneLevel: ZoneLevelSchema,
  verificationState: VerificationStateSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  citations: z.array(CitationSchema),
  /**
   * Dated tipping-point threshold, if this factor represents one.
   * Absent on most factors. Feeds the Clock's significance-weighted baseline.
   */
  tippingPoint: TippingPointSchema.optional(),
  /**
   * The reputability gate's audit trail. When a machine-ingested
   * factor cleared (or failed) the source-credibility gate, this carries the
   * DECIDING source's score `∈ [0, 1]` and the model/heuristic's reasoning, so a
   * viewer can see WHY it is `verified` or `pending` — the gate is auditable, not
   * a black box. Absent on seed/hand-curated factors and on any factor ingested
   * before migration 004. `.optional()` (not `.nullable()`) keeps it clean under
   * exactOptionalPropertyTypes; the read path strips a SQL null before re-validating.
   */
  reputabilityScore: z.number().min(0).max(1).optional(),
  reputabilityReasoning: z.string().optional(),
  /**
   * Researched efforts acting on this factor, each with the source naming them.
   *
   * The sign of `effect` decides what was asked: for a Calamity factor these are
   * counter-efforts — who is working to stop or reverse it — and for a Humanity
   * factor they are amplification efforts, who is working to expand or fund it.
   * Asking "who opposes this" of a beneficial trend would return its opponents,
   * which is the opposite of a routing surface, so the two are researched with
   * different questions and stored in the same shape.
   *
   * Rides on the FEED, not the field: the field stays lean and camera-invariant
   * (charge and position only), and this is sidebar detail like citations.
   *
   * Empty is meaningful and common — it means retrieval found nobody, not that
   * the lookup has yet to run.
   */
  efforts: z.array(CounterEffortSchema).default([]),
});

/* -------------------------------------------------------------------------- */
/* Field endpoint — data-defined, camera-invariant shader input      */
/* -------------------------------------------------------------------------- */

/**
 * Deliberately leaner than {@link FactorSchema}: the field bake needs only the
 * charge (effect × significance) and a position. No description, no citations,
 * no cursor — the field set is a function of the data alone, never of camera or
 * scroll, so screenshots of the same `fieldEpoch` are reproducible.
 */
export const FieldPinSchema = z.object({
  id: z.string().uuid(),
  effect: z.number().gte(-1).lte(1),
  significance: z.number().gte(0).lte(1),
  lat: z.number().gte(-90).lte(90),
  lon: z.number().gte(-180).lte(180),
  /**
   * Dated tipping-point threshold, if any. The Clock aggregates the field
   * response, so a pin must carry its tipping point for the countdown baseline
   * to include it. Absent on most pins.
   */
  tippingPoint: TippingPointSchema.optional(),
  /** Causal domains this factor acts in, server-derived. Drives the Clock warp. */
  domains: z.array(DomainSchema),
});

/**
 * A factor with no location: same charge, no position.
 *
 * Carries `name` because the ring is directly clickable and needs a label,
 * where a pin gets its identity from the feed on selection.
 */
export const GlobalFactorSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  effect: z.number().gte(-1).lte(1),
  significance: z.number().gte(0).lte(1),
  tippingPoint: TippingPointSchema.optional(),
  /** Causal domains this factor acts in, server-derived. Drives the Clock warp. */
  domains: z.array(DomainSchema),
});

/**
 * Response of `GET /api/field`. `fieldEpoch` is `MAX(updated_at)` over the
 * returned set (ISO 8601): two clients holding the same epoch are provably
 * rendering the same field.
 */
export const FieldResponseSchema = z.object({
  pins: z.array(FieldPinSchema),
  /**
   * Placeless factors. Excluded from the spatial bake, but the Clock aggregates
   * them alongside `pins` — they are often the heaviest factors in the set, so
   * dropping them here would silently distort the countdown.
   */
  globalFactors: z.array(GlobalFactorSchema),
  /**
   * Published trajectories referenced by the returned thresholds.
   *
   * Sent with the field rather than resolved server-side into a bare year, so
   * the client can show HOW a threshold was dated. The product's claim is
   * auditability; a computed year with its derivation stripped out is exactly
   * the black box this is supposed to avoid. Empty when no threshold in view is
   * quantity-stated.
   */
  projections: z.array(ProjectionSchema).default([]),
  /**
   * Contingency chains for the thresholds in view, flat and keyed by `factorId`.
   *
   * Rides with the field for the same reason projections do: both are refetched
   * by the same stream invalidation, so a chain can never be shown against a
   * threshold set it was not derived from. Empty until the expansion pass runs.
   */
  requirements: z.array(RequirementSchema).default([]),
  fieldEpoch: z.string().datetime({ offset: true }),
});

/* -------------------------------------------------------------------------- */
/* Feed endpoint — cursor pagination                        */
/* -------------------------------------------------------------------------- */

/**
 * The lat/lon window of the active WebGL viewport. `minLon > maxLon` is the
 * explicit, legal signal that the viewport crosses the antimeridian (the query
 * layer must branch on it rather than clamping — a Math.min/max swap yields the
 * complement of the viewport). Latitude never wraps, so `minLat <= maxLat`
 * always holds.
 */
export const ViewportSchema = z.object({
  minLat: z.number().gte(-90).lte(90),
  maxLat: z.number().gte(-90).lte(90),
  minLon: z.number().gte(-180).lte(180),
  maxLon: z.number().gte(-180).lte(180),
});

/**
 * Decoded pagination cursor — the exact payload `server/pagination.ts` encodes
 * and decodes (that module imports THIS schema so the two can never drift). A
 * cursor is only valid for the sort mode AND the viewport that produced it
 *; both are embedded so the server can 400 a mismatched cursor instead
 * of silently returning an incoherent page. The discriminant is `mode`, which
 * also selects the keyset tuple. The wire form is an opaque base64url string.
 *
 * Recent mode keysets on the immutable insert-only `seq` — a BIGINT identity
 * transmitted as a lossless decimal string — not on `updated_at`. Ingestion
 * rewrites `updated_at = NOW()` when a factor escalates, so an `updated_at` key
 * would silently skip escalating rows for the rest of a scroll session, and it
 * truncates microseconds across a JSON round trip. `seq` has neither flaw.
 *
 * Magnitude mode is a bounded top-N snapshot, not deep pagination (`abs(effect)`
 * is likewise Phase-D-mutated and unsafe as a stable key), so the server never
 * actually mints a magnitude cursor — but the branch is defined for completeness
 * and so a hand-forged one still validates structurally before being rejected.
 */
export const CursorSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('recent'),
    /** Keyset boundary: the last row's immutable `seq` (BIGINT as a decimal string). */
    seq: z.string().regex(/^\d+$/),
    id: z.string().uuid(),
    viewport: ViewportSchema,
  }),
  z.object({
    mode: z.literal('magnitude'),
    /** Keyset boundary: the last row's |effect| (bounded snapshot only). */
    absEffect: z.number().gte(0).lte(1),
    id: z.string().uuid(),
    viewport: ViewportSchema,
  }),
]);

/**
 * `GET /api/feed` request. First page omits `cursor` (null); subsequent pages
 * pass the opaque token returned as `nextCursor`. `sortMode` and `viewport` are
 * always sent — on a sort toggle or viewport change the client discards its
 * cursor and restarts from page one.
 */
export const FeedRequestSchema = z.object({
  sortMode: SortModeSchema.default('recent'),
  viewport: ViewportSchema,
  /** Opaque base64url cursor token, or null for the first page. */
  cursor: z.string().nullable().default(null),
});

/**
 * `GET /api/feed` response. `nextCursor` is null when the page is the last one.
 */
export const FeedResponseSchema = z.object({
  factors: z.array(FactorSchema),
  nextCursor: z.string().nullable(),
});

/**
 * Response of `GET /api/factors/:id` — one fully-loaded factor with its
 * citations. Lets the detail view resolve a selected pin or ring arc whose card
 * has not been paged into the feed, instead of falling back to lean field data.
 */
export const FactorByIdResponseSchema = z.object({
  factor: FactorSchema,
});

/* -------------------------------------------------------------------------- */
/* Anonymous submission — POST /api/factors/submit                   */
/* -------------------------------------------------------------------------- */

/** Bounds on the free-text fields. Enforced here AND by the route, not just in the UI. */
export const SUBMISSION_CLAIM_MIN = 20;
export const SUBMISSION_CLAIM_MAX = 500;
export const SUBMISSION_NOTE_MAX = 500;

/** A URL's protocol, or `''` when the value does not parse as a URL at all. */
function protocolOf(value: string): string {
  try {
    return new URL(value).protocol;
  } catch {
    return '';
  }
}

/**
 * What an ANONYMOUS submitter is allowed to send. Deliberately tiny:
 * a claim, the source that backs it, an optional note for a human reviewer, and
 * an opaque client-generated device id.
 *
 * **`.strict()` is the anti-manipulation rule, not a style choice.** `effect`,
 * `significance`, `verificationState`, `lat`, `lon` and `tippingPoint` are
 * SYSTEM-ASSIGNED by the vetting pipeline. If a submitter could set
 * them, anyone could steer the Clock's aggregate by hand and the "empirical"
 * premise would be hollow. `.strict()` turns any attempt to supply one — or any
 * other unknown key — into a hard validation failure rather than a silently
 * ignored field, so the rejection is visible and testable.
 *
 * `deviceId` is UNTRUSTED: it is a UUID the client generates and persists in
 * localStorage, so it proves nothing about who is submitting. The server only
 * ever validates its shape and hashes it; it is one of two cheap identity
 * signals (the other is the resolved client IP), never an identity.
 */
export const FactorSubmissionSchema = z
  .object({
    /** The proposed claim, in the submitter's own words. */
    claim: z.string().trim().min(SUBMISSION_CLAIM_MIN).max(SUBMISSION_CLAIM_MAX),
    /**
     * The source that backs the claim. Must PARSE as a URL and be http(s) —
     * `javascript:`, `data:` and `file:` are rejected here, before anything
     * renders the value or hands it to a fetcher.
     */
    sourceUrl: z
      .string()
      .url()
      // The refinement runs even when `.url()` already failed (zod v3 effects are
      // not short-circuited), so an unparseable value must not throw out of it.
      .refine((u) => /^https?:$/.test(protocolOf(u)), {
        message: 'sourceUrl must be an http(s) URL',
      }),
    /** Optional short note for a human reviewer. */
    note: z.string().trim().max(SUBMISSION_NOTE_MAX).optional(),
    /** Client-generated, localStorage-persisted UUID. Untrusted; hashed, never stored raw. */
    deviceId: z.string().uuid(),
  })
  .strict();

/**
 * Outcome the CLIENT is told about. Deliberately coarser than the persisted
 * `submissions.status`: a shadow-banned submitter and a genuinely accepted one
 * both receive the byte-identical `received` payload, and so does a submission
 * the noise classifier confidently called spam/abuse. The client must never be
 * able to distinguish those cases — that is what makes the ban a SHADOW ban
 *.
 */
export const SubmissionOutcomeSchema = z.enum([
  'received',
  'duplicate',
  'rejected',
  'rate_limited',
]);

/** `POST /api/factors/submit` response. */
export const SubmissionResponseSchema = z.object({
  outcome: SubmissionOutcomeSchema,
  /** Human-readable, generic by design. Never explains a ban. */
  message: z.string(),
  /** Present only on `rate_limited`: whole seconds until the next attempt is allowed. */
  retryAfterSeconds: z.number().int().nonnegative().optional(),
});
