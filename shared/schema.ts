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
export const TippingPointSchema = z.object({
  /** Best-estimate calendar year the threshold is crossed (e.g. 2050). */
  centralYear: z.number(),
  /** Optional earliest credible year (lower bound of the published range). */
  earliestYear: z.number().optional(),
  /** Optional latest credible year (upper bound of the published range). */
  latestYear: z.number().optional(),
  /** Short provenance label, e.g. "AMOC collapse (Ditlevsen & Ditlevsen 2023)". */
  label: z.string().optional(),
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
