/**
 * POST /api/factors/submit — anonymous Phase-1 factor submission (ADR-45).
 *
 * No accounts, one submission per identity per 24 hours, shadow-banning for
 * bad-faith submitters, and a cheap noise filter in front of the expensive
 * vetting pipeline.
 *
 * ORDER OF OPERATIONS IS THE DESIGN — cheapest check first, so an attacker can
 * never make us spend money by being rejected:
 *
 *   1. Schema/structural validation   free   `.strict()` zod; rejects any attempt
 *                                            to supply effect/significance/
 *                                            verificationState/lat/lon/tippingPoint
 *   2. Ban check                      free   one indexed lookup → SHADOW BAN
 *   3. Rate limit                     free   one indexed lookup → 429
 *   4. Duplicate check                free   one indexed lookup → 200 duplicate
 *   5. Noise classifier               cheap  ONE small constrained model call
 *   6. Vetting pipeline               costly retrieval + extraction + embeddings
 *
 * SHADOW-BAN SEMANTICS. A banned submitter's request is persisted as
 * `quarantined` and answered with the BYTE-IDENTICAL payload and status code a
 * genuine acceptance receives. There is no distinguishing header, no timing
 * branch that skips a step the accepted path takes late, and no different
 * message. If the two responses ever diverge, the ban stops being a shadow ban
 * and becomes a free oracle for evasion — `submit.test.ts` asserts they do not.
 *
 * WHAT A SUBMITTER MAY NEVER SUPPLY: `effect`, `significance`,
 * `verificationState`, `lat`, `lon`, `tippingPoint`. Those are system-assigned by
 * the vetting pipeline. `FactorSubmissionSchema` is `.strict()`, so supplying one
 * is a hard 400 rather than a silently-dropped field.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  FactorSubmissionSchema,
  SubmissionResponseSchema,
} from '../../shared/schema.js';
import type { SubmissionResponse } from '../../shared/types.js';
import type { AppContext } from '../db.js';
import {
  classifySubmission,
  isNoise,
  shouldAutoBan,
  type NoiseAssessment,
  type NoiseFilterOptions,
} from '../ingestion/noiseFilter.js';
import {
  hashIdentity,
  normalizeSubmission,
  resolveClientIp,
  retryAfterSeconds,
  SUBMISSION_WINDOW_MS,
  windowStart,
} from '../submissions/identity.js';
import {
  createMemorySubmissionStore,
  createPgSubmissionStore,
  type SubmissionStore,
  type SubmitterIdentity,
} from '../submissions/store.js';
import { vetSubmission, type Logger as VetLogger } from '../submissions/vetting.js';

/* -------------------------------------------------------------------------- */
/* The responses                                                              */
/* -------------------------------------------------------------------------- */

/**
 * THE indistinguishable success payload. Returned — identically, with HTTP 200 —
 * for a genuine acceptance, for a shadow-banned submitter, and for a submission
 * the noise filter confidently called spam/abuse. Exported so the test can
 * assert the three paths are byte-identical.
 *
 * It is also honest to the genuine submitter: it promises review, not
 * publication, because most submissions will not clear the reputability gate.
 */
export const RECEIVED_RESPONSE: Readonly<SubmissionResponse> = Object.freeze({
  outcome: 'received' as const,
  message:
    'Submission received. It will be checked against its source before it can ' +
    'appear; most submissions do not clear that check.',
});

/** Content we already have. Safe to disclose — it reveals nothing about bans. */
export const DUPLICATE_RESPONSE: Readonly<SubmissionResponse> = Object.freeze({
  outcome: 'duplicate' as const,
  message: 'That claim and source have already been submitted.',
});

/**
 * Soft reject for a LOW-confidence noise verdict (`nonsense`, or an unconfident
 * spam/abuse call). Deliberately vague about why: a precise explanation is a
 * tuning oracle for anyone probing the filter.
 */
export const REJECTED_RESPONSE: Readonly<SubmissionResponse> = Object.freeze({
  outcome: 'rejected' as const,
  message:
    'That did not look like a checkable claim about a source. Try a single ' +
    'factual statement plus the page that supports it.',
});

/** Friendly 429 body, carrying the wait. */
export function rateLimitedResponse(retrySeconds: number): SubmissionResponse {
  const hours = Math.ceil(retrySeconds / 3600);
  return {
    outcome: 'rate_limited',
    message: `One submission per day. Try again in about ${hours} hour${hours === 1 ? '' : 's'}.`,
    retryAfterSeconds: retrySeconds,
  };
}

/* -------------------------------------------------------------------------- */
/* Decision core (Fastify-free, so it is directly testable)                    */
/* -------------------------------------------------------------------------- */

/** What the decision core needs. All injectable so tests run fully offline. */
export interface SubmissionDeps {
  store: SubmissionStore;
  /** The noise classifier. Injected so tests can pin a verdict. */
  classify: (input: {
    claim: string;
    sourceUrl: string;
    note?: string | undefined;
  }) => Promise<NoiseAssessment>;
  /** Called (fire-and-forget) after an acceptance is recorded. */
  onAccepted: (submission: {
    claim: string;
    sourceUrl: string;
    note?: string | undefined;
  }) => void;
  now?: () => Date;
  windowMs?: number;
}

/** The already-validated submission plus its hashed identity. */
export interface SubmissionRequest {
  claim: string;
  sourceUrl: string;
  note?: string | undefined;
  identity: SubmitterIdentity;
}

export interface SubmissionDecision {
  statusCode: number;
  body: SubmissionResponse;
}

/**
 * Run the checks in cost order and produce both the persisted status and the
 * client-visible answer. Pure of Fastify and of any provider; every side effect
 * goes through {@link SubmissionDeps}.
 */
export async function decideSubmission(
  req: SubmissionRequest,
  deps: SubmissionDeps,
): Promise<SubmissionDecision> {
  const now = deps.now ?? ((): Date => new Date());
  const windowMs = deps.windowMs ?? SUBMISSION_WINDOW_MS;
  const at = now();

  const base = {
    identity: req.identity,
    claim: req.claim,
    sourceUrl: req.sourceUrl,
    note: req.note,
  };

  // --- 2. Ban check (free) → SHADOW BAN -----------------------------------
  // Recorded as `quarantined` and answered with the SAME success payload an
  // accepted submission gets. The submitter is never told, and no later check
  // runs — a banned submitter must not be able to probe the duplicate table or
  // the classifier either.
  if (await deps.store.isBanned(req.identity)) {
    await deps.store.record({ ...base, status: 'quarantined', reason: 'shadow-banned submitter' });
    return { statusCode: 200, body: { ...RECEIVED_RESPONSE } };
  }

  // --- 3. Rate limit (free) ------------------------------------------------
  const previous = await deps.store.lastSubmissionAt(req.identity, windowStart(at, windowMs));
  if (previous !== null) {
    const retry = retryAfterSeconds(previous, at, windowMs);
    if (retry > 0) {
      await deps.store.record({ ...base, status: 'rate_limited', reason: 'within 24h window' });
      return { statusCode: 429, body: rateLimitedResponse(retry) };
    }
  }

  // --- 4. Duplicate (free) -------------------------------------------------
  const normalized = normalizeSubmission(req.claim, req.sourceUrl);
  if (await deps.store.isDuplicate(normalized)) {
    await deps.store.record({ ...base, status: 'duplicate', reason: 'same normalized claim + source' });
    return { statusCode: 200, body: { ...DUPLICATE_RESPONSE } };
  }

  // --- 5. Noise classifier (one cheap model call) --------------------------
  const assessment = await deps.classify({
    claim: req.claim,
    sourceUrl: req.sourceUrl,
    ...(req.note !== undefined ? { note: req.note } : {}),
  });

  if (isNoise(assessment)) {
    const reason = `${assessment.verdict} (${assessment.confidence.toFixed(2)}, ${assessment.provenance}): ${assessment.reason}`;
    await deps.store.record({ ...base, status: 'rejected_noise', reason });

    if (shouldAutoBan(assessment)) {
      // Auto shadow-ban: from now on this identity gets the success payload and
      // nothing else. They are NOT told — telling them converts a silent cost
      // into a free evasion signal.
      await deps.store.ban({ identity: req.identity, reason });
      return { statusCode: 200, body: { ...RECEIVED_RESPONSE } };
    }
    return { statusCode: 200, body: { ...REJECTED_RESPONSE } };
  }

  // --- 6. Accepted → the existing vetting pipeline -------------------------
  await deps.store.record({
    ...base,
    status: 'accepted',
    reason: `noise filter: plausible (${assessment.provenance})`,
  });
  deps.onAccepted({
    claim: req.claim,
    sourceUrl: req.sourceUrl,
    ...(req.note !== undefined ? { note: req.note } : {}),
  });
  return { statusCode: 200, body: { ...RECEIVED_RESPONSE } };
}

/* -------------------------------------------------------------------------- */
/* Route                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `TRUST_PROXY=1` when (and only when) the deployment sits behind a reverse
 * proxy we control. See `resolveClientIp` for why this is explicit rather than
 * inferred: trusting `X-Forwarded-For` unproxied is a free identity generator.
 */
function trustProxy(env: NodeJS.ProcessEnv): boolean {
  const raw = env.TRUST_PROXY?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/**
 * Adapt Fastify's pino logger to the `Pick<Console, …>` shape the ingestion
 * modules take. Pino has no `log`, so it maps onto `info`; the signature
 * differences are absorbed here rather than by casting the logger away.
 */
function routeLogger(fastify: FastifyInstance): VetLogger {
  return {
    log: (...args: unknown[]) => fastify.log.info(args.map(String).join(' ')),
    info: (...args: unknown[]) => fastify.log.info(args.map(String).join(' ')),
    warn: (...args: unknown[]) => fastify.log.warn(args.map(String).join(' ')),
    error: (...args: unknown[]) => fastify.log.error(args.map(String).join(' ')),
  };
}

export interface SubmitRouteOptions {
  /** The salt read at bootstrap (`readSubmissionSalt`). */
  salt: string;
  /** Override the store (tests / seed mode). Defaults from `fastify.appCtx`. */
  store?: SubmissionStore;
  /** Override the classifier (tests). Defaults to the real filter. */
  noiseOptions?: NoiseFilterOptions;
}

export default async function submitRoutes(
  fastify: FastifyInstance,
  options: SubmitRouteOptions,
): Promise<void> {
  const ctx: AppContext = fastify.appCtx;
  const store =
    options.store ??
    (ctx.mode === 'db' ? createPgSubmissionStore(ctx.db) : createMemorySubmissionStore());
  const proxied = trustProxy(process.env);

  if (ctx.mode !== 'db') {
    fastify.log.warn(
      'SEED MODE — /api/factors/submit uses an IN-MEMORY submission store. ' +
        'Rate limits and shadow bans reset on every restart, and accepted ' +
        'submissions are vetted into an in-memory repository, not Postgres.',
    );
  }

  fastify.post(
    '/api/factors/submit',
    async (req: FastifyRequest, reply: FastifyReply): Promise<SubmissionResponse | undefined> => {
      // --- 1. Schema/structural validation (free) --------------------------
      // `.strict()`: supplying effect/significance/verificationState/lat/lon/
      // tippingPoint — or any other unknown key — fails HERE. The error is
      // returned verbatim so a well-meaning client learns the contract; there is
      // nothing secret about which fields are system-assigned.
      const parsed = FactorSubmissionSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({
          error: 'invalid submission',
          detail: parsed.error.flatten(),
          note:
            'effect, significance, verificationState, lat, lon and tippingPoint are ' +
            'assigned by the vetting pipeline and cannot be supplied.',
        });
        return undefined;
      }
      const submission = parsed.data;

      const ip = resolveClientIp({
        forwardedFor: req.headers['x-forwarded-for'],
        socketAddress: req.socket.remoteAddress,
        trustProxy: proxied,
      });
      const identity: SubmitterIdentity = {
        ipHash: hashIdentity(options.salt, ip),
        deviceHash: hashIdentity(options.salt, submission.deviceId),
      };

      const decision = await decideSubmission(
        {
          claim: submission.claim,
          sourceUrl: submission.sourceUrl,
          ...(submission.note !== undefined ? { note: submission.note } : {}),
          identity,
        },
        {
          store,
          classify: (input) => classifySubmission(input, options.noiseOptions ?? {}),
          onAccepted: (accepted) => {
            // Fire-and-forget: the submitter is answered immediately, and the
            // (slow, paid) retrieval + extraction runs after. A failure in there
            // is logged by `vetSubmission` and never surfaces to the client —
            // which also means an accepted submission is a promise of REVIEW,
            // not of publication, exactly as the response says.
            void vetSubmission(ctx, accepted, routeLogger(fastify));
          },
        },
      );

      if (decision.body.retryAfterSeconds !== undefined) {
        reply.header('Retry-After', String(decision.body.retryAfterSeconds));
      }
      reply.code(decision.statusCode);
      // Re-validate our own response against the shared contract (ADR-23).
      return SubmissionResponseSchema.parse(decision.body);
    },
  );
}
