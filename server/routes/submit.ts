/**
 * POST /api/factors/submit — anonymous Phase-1 factor submission.
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
 *   5. Noise heuristic                free   deterministic string matching only
 *   6. Queue                          free   one row; nothing downstream runs
 *
 * NOTHING IN THIS HANDLER COSTS MONEY (migration 019). Every step above is a
 * schema check or an indexed lookup, except step 5, which is
 * `classifySubmissionOffline` — pure string matching with no network and no
 * credentials. A submission ends as a row with `vetted_at IS NULL` and nothing
 * else happens.
 *
 * This route used to do two paid things while the submitter waited: ONE LLM call
 * to classify, then `vetSubmission` fire-and-forget, which is the entire
 * ingestion pipeline (retrieval, extraction, embeddings, the write). Both were
 * reachable by an anonymous HTTP request with only the rate limiter as a brake,
 * so spend scaled with the number of distinct addresses willing to send one
 * request a day. Both now belong to whoever drains the queue.
 *
 * WHY THE HEURISTIC STAYS. It is free, and it is what still auto-shadow-bans
 * blatant spam and still tells a confused human their text was not a checkable
 * claim. Deferring it too would mean an abusive submitter kept earning a queued
 * row every day until someone drained, and would replace a useful reply with
 * silence. It is a triage, NOT a judgement — the model's verdict at drain time
 * can still reject what the heuristic let through.
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
import { FactorSubmissionSchema, SubmissionResponseSchema } from '../../shared/schema.js';
import type { SubmissionResponse } from '../../shared/types.js';
import type { AppContext } from '../db.js';
import {
  classifySubmissionOffline,
  isNoise,
  shouldAutoBan,
  type NoiseAssessment,
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
// NOTE: `vetSubmission` is deliberately NOT imported here any more. Step 6 queues
// (migration 019); the queue drainer owns that call.

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
    'That did not look like a checkable claim about a source. Tomorrow, try a ' +
    'single factual statement plus the page that supports it.',
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
  /**
   * Called after an acceptance is recorded. Since migration 019 this signals
   * that a row was QUEUED, and must not itself run the vetting pipeline — the
   * decision core stays free of paid work. Kept as a dep so tests can observe
   * which submissions reached the queue.
   */
  onAccepted: (submission: { claim: string; sourceUrl: string; note?: string | undefined }) => void;
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
  //
  // THE BAN CHANGES WHAT IS STORED. IT NEVER CHANGES WHAT IS RETURNED, NOR
  // WHICH CHECKS RUN. This used to return here, and that early return was itself
  // the tell: every later check was skipped, so a banned submitter never met the
  // rate limiter. An ordinary submitter's second attempt of the day is a 429; a
  // banned submitter's was another 200. Submitting twice therefore answered the
  // one question the shadow ban exists to leave unanswered, and no amount of
  // byte-identical payload could hide it, because the difference was in WHICH
  // payload arrived.
  //
  // So the flag is now carried, not acted on, and every branch below reaches the
  // same response for a banned and an unbanned submitter given the same inputs.
  // The only divergence is the row written at step 6, which the submitter cannot
  // see.
  const banned = await deps.store.isBanned(req.identity);

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
  if (await deps.store.isDuplicate(normalized, req.identity)) {
    await deps.store.record({
      ...base,
      status: 'duplicate',
      reason: 'same normalized claim + source',
    });
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
      // Auto shadow-ban: from now on this identity's submissions are quarantined.
      // They are NOT told — telling them converts a silent cost into a free
      // evasion signal. Skipped when already banned, so the ban list does not
      // accumulate a row per attempt; the response is identical either way.
      if (!banned) await deps.store.ban({ identity: req.identity, reason });
      return { statusCode: 200, body: { ...RECEIVED_RESPONSE } };
    }
    return { statusCode: 200, body: { ...REJECTED_RESPONSE } };
  }

  // --- 6. QUEUED for classification + vetting (migration 019) --------------
  // The row lands with `vetted_at IS NULL`. Nothing paid runs here: the model
  // classification and the pipeline both belong to whoever drains the queue.
  // NOT `accepted` — it cleared the free checks and a string heuristic, which
  // is a far weaker claim than the word `accepted` would make.
  //
  // THE ONLY PLACE THE BAN SHOWS. A banned submitter's row is `quarantined`
  // instead of `queued`, so it never reaches the drain and never becomes a
  // factor — but it still consumes their daily allowance (see WINDOW_CONSUMING)
  // and still blocks their own duplicates, so from the outside their day looks
  // exactly like anyone else's. The response below is the same object either way.
  if (banned) {
    await deps.store.record({ ...base, status: 'quarantined', reason: 'shadow-banned submitter' });
    return { statusCode: 200, body: { ...RECEIVED_RESPONSE } };
  }

  await deps.store.record({
    ...base,
    status: 'queued',
    reason: `heuristic: plausible (${assessment.provenance})`,
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

export interface SubmitRouteOptions {
  /** The salt read at bootstrap (`readSubmissionSalt`). */
  salt: string;
  /** Override the store (tests / seed mode). Defaults from `fastify.appCtx`. */
  store?: SubmissionStore;
  // NOTE: there is no `noiseOptions` any more. It existed to inject an LLM
  // client/model into the request-path classifier; the request path no longer
  // calls a model, so the option had nothing left to configure. Whatever drains
  // the queue owns the model configuration instead.
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
        'Rate limits, shadow bans AND the vetting queue all reset on every ' +
        'restart, so a queued submission does not survive to be drained.',
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
          // The DETERMINISTIC heuristic, not `classifySubmission`. That entry
          // point makes an LLM call whenever credentials exist, which is exactly
          // the paid work this route must not do. `classifySubmissionOffline` is
          // pure string matching: no network, no key, no spend. The model gets
          // its say later, at drain time, where someone is watching.
          classify: (input) => Promise.resolve(classifySubmissionOffline(input)),
          onAccepted: (accepted) => {
            // QUEUED, not vetted (migration 019). The pipeline is run later by an
            // operator draining `status = 'accepted' AND vetted_at IS NULL`, so
            // the paid work happens under observation instead of inside a request
            // nobody is watching. The submitter's answer is unchanged and was
            // always a promise of REVIEW rather than publication.
            fastify.log.info(`[submissions] queued for vetting: ${accepted.sourceUrl}`);
          },
        },
      );

      if (decision.body.retryAfterSeconds !== undefined) {
        reply.header('Retry-After', String(decision.body.retryAfterSeconds));
      }
      reply.code(decision.statusCode);
      // Re-validate our own response against the shared contract.
      return SubmissionResponseSchema.parse(decision.body);
    },
  );
}
