/**
 * Shapes flowing through the reconciliation loop: what arrives, and what
 * extraction turns it into.
 */
import { z } from 'zod';
import type { TippingPoint, VerificationState } from '../../shared/types.js';
import { TippingPointSchema, VerificationStateSchema } from '../../shared/schema.js';

/**
 * One raw item off the inbound intel stream. `rawText`
 * is UNTRUSTED third-party content — the extractor prompt must treat it as data,
 * never as instructions (finding 27, prompt-injection boundary).
 */
export interface InboundIntelItem {
  /** Optional upstream identifier, for logging only. */
  externalId?: string | undefined;
  /** Untrusted source text to extract factors from. */
  rawText: string;
  sourceUrl: string | null;
  publisher: string;
  retrievedAt: Date;
}

/**
 * A structured factor as returned by the Phase A extractor, before value
 * validation. `zone_level` is intentionally absent — it is a generated column
 * derived from `spatial_path`, so the pipeline never sets it.
 */
export interface ExtractedFactorDraft {
  name: string;
  description: string;
  effect: number;
  significance: number;
  /** WGS84 degrees, or null when the factor is genuinely placeless. */
  lat: number | null;
  lon: number | null;
  spatialPath: string;
  /**
   * The verification state Phase A already resolved for this draft: the
   * live path sets `verified`/`pending` from the reputability gate; the offline
   * stubs omit it and it defaults to `pending`. Escalations never change an
   * existing parent's state — this only seeds a NEW factor's insert.
   */
  verificationState?: VerificationState;
  /**
   * A dated tipping-point threshold, present only when Phase A extracted
   * a concrete dated/near-dated one. Persisted to `factors.tipping_point` on insert
   * so the Clock countdown baseline can anchor to it. Escalations never touch it.
   * Explicit `| undefined` (not a bare optional) so a zod-parsed draft and the
   * conditionally-built extractor output assign cleanly under exactOptionalPropertyTypes.
   */
  tippingPoint?: TippingPoint | undefined;
  /**
   * The reputability gate's audit trail: the DECIDING (max-scoring)
   * source's credibility score `∈ [0, 1]` and its reasoning, carried onto the
   * persisted factor so the verified/pending decision is auditable. The live gate
   * sets both; the offline stubs omit them. Explicit `| undefined` for clean
   * assignment under exactOptionalPropertyTypes. Escalations never touch them —
   * they only seed a NEW factor's insert, alongside `verificationState`.
   */
  reputabilityScore?: number | undefined;
  reputabilityReasoning?: string | undefined;
  citation: {
    publisher: string;
    sourceUrl: string | null;
    quoteSnippet: string;
  };
}

/**
 * Value-level validation of a Phase A draft (finding 27: JSON-schema constrains
 * SHAPE, not VALUES). Ranges mirror the DB CHECK constraints and
 * the shared contract; `spatialPath` is enforced rooted-at-`global` with depth
 * ≤ 2 (: `<@ 'global'` and `nlevel <= 2`). `.finite()` on the numbers
 * rejects `NaN`/`±Infinity` before they can poison the field or the feed.
 */
export const ExtractedFactorSchema = z.object({
  name: z.string().min(1).max(500),
  description: z.string().min(1).max(20_000),
  effect: z.number().finite().gte(-1).lte(1),
  significance: z.number().finite().gte(0).lte(1),
  // Nullable: a placeless factor has no centre. Both or neither, enforced below.
  lat: z.number().finite().gte(-90).lte(90).nullable(),
  lon: z.number().finite().gte(-180).lte(180).nullable(),
  // 'global' or 'global.<segment>' — one root, at most one child (Phase 1).
  spatialPath: z.string().regex(/^global(\.[a-z0-9_]+)?$/, {
    message: "spatialPath must be 'global' or 'global.<code>' (depth <= 2)",
  }),
  // Defaults to 'pending' so any draft of unknown provenance stays off the
  // Clock aggregate until the reputability gate says otherwise.
  verificationState: VerificationStateSchema.default('pending'),
  // Optional dated threshold; most drafts have none. `.optional()` (not
  // `.nullable()`) mirrors the shared contract and satisfies exactOptionalPropertyTypes.
  tippingPoint: TippingPointSchema.optional(),
  // Reputability audit trail: deciding source's score + reasoning.
  // Optional — present only when the live gate ran; the offline stubs omit it.
  reputabilityScore: z.number().finite().gte(0).lte(1).optional(),
  reputabilityReasoning: z.string().optional(),
  citation: z.object({
    publisher: z.string().min(1).max(500),
    sourceUrl: z.string().url().nullable(),
    quoteSnippet: z.string().min(1).max(5_000),
  }),
});
