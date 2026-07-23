/**
 * Offline tests for the submission decision core + the request contract (ADR-45).
 *
 * The load-bearing assertions here are:
 *   1. `.strict()` rejects every system-assigned field (the anti-manipulation
 *      rule) — if this regresses, anyone can steer the Clock by hand.
 *   2. A shadow-banned submitter's response is INDISTINGUISHABLE from a genuine
 *      acceptance — if this regresses, the ban becomes a free evasion oracle.
 * Nothing here touches the network or Postgres: the store is in-memory and the
 * classifier is injected.
 */
import { describe, expect, it } from 'vitest';
import { FactorSubmissionSchema } from '../../shared/schema.js';
import type { NoiseAssessment } from '../ingestion/noiseFilter.js';
import { createMemorySubmissionStore } from '../submissions/store.js';
import type { SubmitterIdentity } from '../submissions/store.js';
import { SUBMISSION_WINDOW_MS } from '../submissions/identity.js';
import {
  decideSubmission,
  DUPLICATE_RESPONSE,
  RECEIVED_RESPONSE,
  REJECTED_RESPONSE,
  type SubmissionDeps,
} from './submit.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const DEVICE_ID = '7f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b';

const VALID_BODY = {
  claim: 'Arctic sea ice extent reached a record September minimum this year.',
  sourceUrl: 'https://nsidc.org/arcticseaicenews',
  deviceId: DEVICE_ID,
};

const IDENTITY: SubmitterIdentity = { ipHash: 'ip-hash-a', deviceHash: 'device-hash-a' };
const OTHER_IDENTITY: SubmitterIdentity = { ipHash: 'ip-hash-b', deviceHash: 'device-hash-b' };

function assessment(
  verdict: NoiseAssessment['verdict'],
  confidence = 0.9,
): NoiseAssessment {
  return { verdict, confidence, reason: 'test', provenance: 'offline-stub' };
}

function makeDeps(
  overrides: Partial<SubmissionDeps> & { verdict?: NoiseAssessment } = {},
): SubmissionDeps & { accepted: { claim: string }[]; store: ReturnType<typeof createMemorySubmissionStore> } {
  // The store stamps `created_at` itself, so it must share the decision core's
  // clock — otherwise the injected fake clock and the row timestamps disagree
  // and the window arithmetic is tested against noise.
  const store = overrides.store
    ? (overrides.store as ReturnType<typeof createMemorySubmissionStore>)
    : createMemorySubmissionStore(overrides.now);
  const accepted: { claim: string }[] = [];
  return {
    store,
    accepted,
    classify: overrides.classify ?? (async () => overrides.verdict ?? assessment('plausible', 0.5)),
    onAccepted: overrides.onAccepted ?? ((s) => accepted.push({ claim: s.claim })),
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.windowMs !== undefined ? { windowMs: overrides.windowMs } : {}),
  };
}

const request = (identity: SubmitterIdentity = IDENTITY, claim = VALID_BODY.claim) => ({
  claim,
  sourceUrl: VALID_BODY.sourceUrl,
  identity,
});

/* -------------------------------------------------------------------------- */
/* 1. Schema contract                                                         */
/* -------------------------------------------------------------------------- */

describe('FactorSubmissionSchema — what a submitter may send', () => {
  it('accepts a minimal valid submission', () => {
    expect(FactorSubmissionSchema.safeParse(VALID_BODY).success).toBe(true);
  });

  it('accepts an optional note', () => {
    expect(
      FactorSubmissionSchema.safeParse({ ...VALID_BODY, note: 'from the 2026 update' }).success,
    ).toBe(true);
  });

  // The anti-manipulation rule, one field per case so a regression names itself.
  it.each([
    ['effect', -1],
    ['significance', 0.9],
    ['verificationState', 'verified'],
    ['lat', 12.5],
    ['lon', -40],
    ['tippingPoint', { centralYear: 2050 }],
  ])('REJECTS a submitter-supplied %s (system-assigned)', (key, value) => {
    const parsed = FactorSubmissionSchema.safeParse({ ...VALID_BODY, [key]: value });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain('unrecognized_keys');
    }
  });

  it('rejects any other unknown key too (strict, not a denylist)', () => {
    expect(
      FactorSubmissionSchema.safeParse({ ...VALID_BODY, spatialPath: 'global' }).success,
    ).toBe(false);
  });

  it('rejects a non-http(s) source URL', () => {
    for (const sourceUrl of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
      expect(FactorSubmissionSchema.safeParse({ ...VALID_BODY, sourceUrl }).success).toBe(false);
    }
  });

  it('rejects an unparseable source URL', () => {
    expect(FactorSubmissionSchema.safeParse({ ...VALID_BODY, sourceUrl: 'nsidc' }).success).toBe(
      false,
    );
  });

  it('rejects a claim outside the length bounds', () => {
    expect(FactorSubmissionSchema.safeParse({ ...VALID_BODY, claim: 'too short' }).success).toBe(
      false,
    );
    expect(
      FactorSubmissionSchema.safeParse({ ...VALID_BODY, claim: 'x'.repeat(5000) }).success,
    ).toBe(false);
  });

  it('rejects a malformed deviceId', () => {
    expect(FactorSubmissionSchema.safeParse({ ...VALID_BODY, deviceId: 'nope' }).success).toBe(
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Decision core                                                           */
/* -------------------------------------------------------------------------- */

describe('decideSubmission — happy path', () => {
  it('accepts a plausible first submission and hands it to the pipeline', async () => {
    const deps = makeDeps();
    const decision = await decideSubmission(request(), deps);

    expect(decision.statusCode).toBe(200);
    expect(decision.body).toEqual(RECEIVED_RESPONSE);
    expect(deps.accepted).toHaveLength(1);
    expect(deps.store.submissions()[0]?.status).toBe('accepted');
  });
});

describe('decideSubmission — shadow ban', () => {
  it('answers a banned submitter with the EXACT accepted-path payload', async () => {
    const store = createMemorySubmissionStore();
    await store.ban({ identity: IDENTITY, reason: 'prior abuse' });

    const bannedDeps = makeDeps({ store });
    const banned = await decideSubmission(request(IDENTITY), bannedDeps);
    const genuine = await decideSubmission(request(OTHER_IDENTITY), makeDeps());

    // Indistinguishable: same status code, same payload, key-for-key.
    expect(banned.statusCode).toBe(genuine.statusCode);
    expect(banned.body).toEqual(genuine.body);
    expect(JSON.stringify(banned.body)).toBe(JSON.stringify(genuine.body));
    expect(Object.keys(banned.body)).toEqual(Object.keys(genuine.body));
    expect(banned.body.retryAfterSeconds).toBeUndefined();

    // …but the row is quarantined and the pipeline never ran.
    expect(bannedDeps.store.submissions()[0]?.status).toBe('quarantined');
    expect(bannedDeps.accepted).toHaveLength(0);
  });

  it('matches a ban on the DEVICE half alone (new IP, same localStorage)', async () => {
    const store = createMemorySubmissionStore();
    await store.ban({ identity: IDENTITY, reason: 'prior abuse' });
    const deps = makeDeps({ store });

    const roaming = { ipHash: 'a-brand-new-ip', deviceHash: IDENTITY.deviceHash };
    const decision = await decideSubmission(request(roaming), deps);
    expect(decision.body).toEqual(RECEIVED_RESPONSE);
    expect(deps.store.submissions().at(-1)?.status).toBe('quarantined');
  });

  it('a banned submitter is not rate-limited into a distinguishable 429', async () => {
    const store = createMemorySubmissionStore();
    await store.ban({ identity: IDENTITY, reason: 'prior abuse' });
    const deps = makeDeps({ store });

    const first = await decideSubmission(request(), deps);
    const second = await decideSubmission(request(IDENTITY, 'A different claim entirely here.'), deps);
    expect(second.statusCode).toBe(first.statusCode);
    expect(second.body).toEqual(first.body);
  });
});

describe('decideSubmission — rate limit', () => {
  it('429s a second submission inside the window, with a retry hint', async () => {
    let clock = new Date('2026-07-22T12:00:00.000Z');
    const deps = makeDeps({ now: () => clock });

    await decideSubmission(request(), deps);
    clock = new Date(clock.getTime() + 60_000);
    const second = await decideSubmission(request(IDENTITY, 'Another claim, still today.'), deps);

    expect(second.statusCode).toBe(429);
    expect(second.body.outcome).toBe('rate_limited');
    expect(second.body.retryAfterSeconds).toBe(SUBMISSION_WINDOW_MS / 1000 - 60);
    expect(deps.store.submissions().at(-1)?.status).toBe('rate_limited');
  });

  it('allows the next submission once the window has passed', async () => {
    let clock = new Date('2026-07-22T12:00:00.000Z');
    const deps = makeDeps({ now: () => clock });

    await decideSubmission(request(), deps);
    clock = new Date(clock.getTime() + SUBMISSION_WINDOW_MS + 1);
    const second = await decideSubmission(request(IDENTITY, 'A claim on the following day.'), deps);

    expect(second.statusCode).toBe(200);
    expect(second.body).toEqual(RECEIVED_RESPONSE);
  });

  it('limits per identity — a different submitter is unaffected', async () => {
    const deps = makeDeps();
    await decideSubmission(request(IDENTITY), deps);
    const other = await decideSubmission(request(OTHER_IDENTITY), deps);
    expect(other.statusCode).toBe(200);
  });
});

describe('decideSubmission — duplicate', () => {
  it('reports a re-submission of the same claim + source as a duplicate', async () => {
    const deps = makeDeps();
    await decideSubmission(request(IDENTITY), deps);
    // A different submitter (so the rate limit does not mask the duplicate check)
    // pasting the same content, re-cased and re-spaced.
    const dupe = await decideSubmission(
      { ...request(OTHER_IDENTITY), claim: `  ${VALID_BODY.claim.toUpperCase()}  ` },
      deps,
    );
    expect(dupe.body).toEqual(DUPLICATE_RESPONSE);
    expect(deps.store.submissions().at(-1)?.status).toBe('duplicate');
  });
});

describe('decideSubmission — noise filter', () => {
  it('soft-rejects nonsense WITHOUT banning', async () => {
    const deps = makeDeps({ verdict: assessment('nonsense', 0.6) });
    const decision = await decideSubmission(request(), deps);

    expect(decision.statusCode).toBe(200);
    expect(decision.body).toEqual(REJECTED_RESPONSE);
    expect(deps.store.submissions()[0]?.status).toBe('rejected_noise');
    expect(deps.store.bans()).toHaveLength(0);
    expect(deps.accepted).toHaveLength(0);
  });

  it('auto shadow-bans confident spam and returns the SUCCESS payload', async () => {
    const deps = makeDeps({ verdict: assessment('spam', 0.95) });
    const decision = await decideSubmission(request(), deps);

    // The abuser is told nothing: same payload a genuine submitter receives.
    expect(decision.statusCode).toBe(200);
    expect(decision.body).toEqual(RECEIVED_RESPONSE);
    expect(deps.store.submissions()[0]?.status).toBe('rejected_noise');
    expect(deps.store.bans()).toHaveLength(1);
    expect(deps.accepted).toHaveLength(0);
  });

  it('auto shadow-bans confident abuse', async () => {
    const deps = makeDeps({ verdict: assessment('abuse', 0.95) });
    const decision = await decideSubmission(request(), deps);
    expect(decision.body).toEqual(RECEIVED_RESPONSE);
    expect(deps.store.bans()).toHaveLength(1);
  });

  it('does not ban on a low-confidence spam call', async () => {
    const deps = makeDeps({ verdict: assessment('spam', 0.4) });
    const decision = await decideSubmission(request(), deps);
    expect(decision.body).toEqual(REJECTED_RESPONSE);
    expect(deps.store.bans()).toHaveLength(0);
  });

  it('never runs the classifier for a banned submitter (no free spend)', async () => {
    const store = createMemorySubmissionStore();
    await store.ban({ identity: IDENTITY, reason: 'prior abuse' });
    let calls = 0;
    const deps = makeDeps({
      store,
      classify: async () => {
        calls++;
        return assessment('plausible');
      },
    });
    await decideSubmission(request(), deps);
    expect(calls).toBe(0);
  });

  it('never runs the classifier for a rate-limited submission', async () => {
    let calls = 0;
    const deps = makeDeps({
      classify: async () => {
        calls++;
        return assessment('plausible');
      },
    });
    await decideSubmission(request(), deps);
    await decideSubmission(request(IDENTITY, 'A second claim inside the same window.'), deps);
    expect(calls).toBe(1);
  });
});
