/**
 * TypeScript types for the shared contract, DERIVED from the zod schemas in
 * `shared/schema.ts` via `z.infer`. Do not hand-write or edit these to
 * diverge from the schemas — change the schema and the type follows. Importing
 * from here keeps callers off the zod runtime when they only need the types.
 */
import type { z } from 'zod';
import type {
  ZoneLevelSchema,
  SortModeSchema,
  VerificationStateSchema,
  TippingPointSchema,
  CitationSchema,
  FactorSchema,
  FieldPinSchema,
  FieldResponseSchema,
  ViewportSchema,
  CursorSchema,
  FeedRequestSchema,
  FeedResponseSchema,
  FactorSubmissionSchema,
  SubmissionOutcomeSchema,
  SubmissionResponseSchema,
} from './schema.js';

export type ZoneLevel = z.infer<typeof ZoneLevelSchema>;
export type SortMode = z.infer<typeof SortModeSchema>;
export type VerificationState = z.infer<typeof VerificationStateSchema>;

export type TippingPoint = z.infer<typeof TippingPointSchema>;

export type Citation = z.infer<typeof CitationSchema>;
export type Factor = z.infer<typeof FactorSchema>;

export type FieldPin = z.infer<typeof FieldPinSchema>;
export type FieldResponse = z.infer<typeof FieldResponseSchema>;

export type Viewport = z.infer<typeof ViewportSchema>;

/**
 * Decoded cursor payload. Carries its own sort mode, so a value of this
 * type is self-describing: the `mode` discriminant tells you which keyset tuple
 * is present.
 */
export type Cursor = z.infer<typeof CursorSchema>;

export type FeedRequest = z.infer<typeof FeedRequestSchema>;
export type FeedResponse = z.infer<typeof FeedResponseSchema>;

/**
 * The ONLY fields an anonymous submitter may send. Note what is absent:
 * effect, significance, verificationState, lat, lon, tippingPoint — all
 * system-assigned. The schema is `.strict()`, so supplying one is a hard error.
 */
export type FactorSubmission = z.infer<typeof FactorSubmissionSchema>;
export type SubmissionOutcome = z.infer<typeof SubmissionOutcomeSchema>;
export type SubmissionResponse = z.infer<typeof SubmissionResponseSchema>;
