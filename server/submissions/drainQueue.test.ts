/**
 * Drain behaviour, fully offline. `classify` and `vet` are injected, so no test
 * here reaches a provider — which is also the guarantee the drain's own design
 * rests on: the expensive halves are ports, not hard-wired calls.
 */
import { describe, expect, it, vi } from 'vitest';
import { drainQueue, parseDrainArgs, DEFAULT_DRAIN_LIMIT } from './drainQueue.js';
import { createMemorySubmissionStore, type SubmitterIdentity } from './store.js';
import type { NoiseAssessment } from '../ingestion/noiseFilter.js';

const IDENTITY: SubmitterIdentity = { ipHash: 'ip-a', deviceHash: 'device-a' };

const silent = { info: () => {}, warn: () => {}, error: () => {}, log: () => {} };

function assessment(
  verdict: NoiseAssessment['verdict'],
  confidence = 0.9,
  provenance: NoiseAssessment['provenance'] = 'live',
): NoiseAssessment {
  return { verdict, confidence, reason: 'test', provenance };
}

/** A store holding `count` queued rows, oldest first. */
async function storeWithQueue(
  count: number,
): Promise<ReturnType<typeof createMemorySubmissionStore>> {
  let tick = 0;
  const store = createMemorySubmissionStore(() => new Date(1_700_000_000_000 + tick++ * 1000));
  for (let i = 0; i < count; i++) {
    await store.record({
      identity: IDENTITY,
      claim: `Queued claim number ${String(i)} about something measurable.`,
      sourceUrl: `https://example.org/${String(i)}`,
      status: 'queued',
      reason: 'heuristic: plausible (offline-stub)',
    });
  }
  return store;
}

describe('drainQueue — the plausible path', () => {
  it('vets a queued row and stamps it accepted', async () => {
    const store = await storeWithQueue(1);
    const vet = vi.fn(async () => ({ ok: true }));

    const report = await drainQueue({
      store,
      classify: async () => assessment('plausible', 0.5),
      vet,
      logger: silent,
    });

    expect(report).toMatchObject({ examined: 1, accepted: 1, rejected: 0, failed: 0 });
    expect(vet).toHaveBeenCalledOnce();
    const row = store.submissions()[0];
    expect(row?.status).toBe('accepted');
    expect(row?.vettedAt).toBeInstanceOf(Date);
  });

  it('takes a vetted row out of the queue so a second run is a no-op', async () => {
    const store = await storeWithQueue(1);
    const deps = {
      store,
      classify: async () => assessment('plausible', 0.5),
      vet: vi.fn(async () => ({ ok: true })),
      logger: silent,
    };

    await drainQueue(deps);
    const second = await drainQueue(deps);

    expect(second.examined).toBe(0);
    expect(deps.vet).toHaveBeenCalledOnce();
  });
});

describe('drainQueue — the noise path', () => {
  it('rejects without ever running the pipeline (no wasted spend)', async () => {
    const store = await storeWithQueue(1);
    const vet = vi.fn(async () => ({ ok: true }));

    const report = await drainQueue({
      store,
      classify: async () => assessment('nonsense', 0.6),
      vet,
      logger: silent,
    });

    expect(report).toMatchObject({ rejected: 1, accepted: 0, banned: 0 });
    expect(vet).not.toHaveBeenCalled();
    expect(store.submissions()[0]?.status).toBe('rejected_noise');
  });

  it('stamps a rejected row so it is never re-classified and re-paid for', async () => {
    const store = await storeWithQueue(1);
    const classify = vi.fn(async () => assessment('nonsense', 0.6));
    const deps = { store, classify, vet: async () => ({}), logger: silent };

    await drainQueue(deps);
    await drainQueue(deps);

    expect(classify).toHaveBeenCalledOnce();
    expect(store.submissions()[0]?.vettedAt).toBeInstanceOf(Date);
  });

  it('shadow-bans a confident spam verdict at drain time', async () => {
    const store = await storeWithQueue(1);

    const report = await drainQueue({
      store,
      classify: async () => assessment('spam', 0.95),
      vet: async () => ({}),
      logger: silent,
    });

    expect(report.banned).toBe(1);
    expect(store.bans()).toHaveLength(1);
    expect(await store.isBanned(IDENTITY)).toBe(true);
  });

  it('does NOT ban on a low-confidence call', async () => {
    const store = await storeWithQueue(1);

    const report = await drainQueue({
      store,
      classify: async () => assessment('spam', 0.5),
      vet: async () => ({}),
      logger: silent,
    });

    expect(report.rejected).toBe(1);
    expect(report.banned).toBe(0);
    expect(store.bans()).toHaveLength(0);
  });
});

describe('drainQueue — failure and bounds', () => {
  it('leaves a row QUEUED when the pipeline throws, so it retries', async () => {
    const store = await storeWithQueue(1);

    const report = await drainQueue({
      store,
      classify: async () => assessment('plausible', 0.5),
      vet: async () => {
        throw new Error('retrieval exploded');
      },
      logger: silent,
    });

    expect(report).toMatchObject({ failed: 1, accepted: 0 });
    const row = store.submissions()[0];
    expect(row?.status).toBe('queued');
    expect(row?.vettedAt).toBeUndefined();
    // Still visible to the next run — the whole point of not stamping it.
    expect(await store.queued(10)).toHaveLength(1);
  });

  it('treats a null pipeline result as failure, NOT as success', async () => {
    // Regression guard for a real incident. `vetSubmission` catches its own
    // errors and returns null instead of throwing, so a try/catch alone misses
    // the failure: a constraint violation in the factor insert once reported
    // "1 vetted, 0 failed" while writing nothing, and stamped the row accepted.
    const store = await storeWithQueue(1);

    const report = await drainQueue({
      store,
      classify: async () => assessment('plausible', 0.5),
      vet: async () => null,
      logger: silent,
    });

    expect(report).toMatchObject({ failed: 1, accepted: 0 });
    const row = store.submissions()[0];
    expect(row?.status).toBe('queued');
    expect(row?.vettedAt).toBeUndefined();
    expect(await store.queued(10)).toHaveLength(1);
  });

  it('honours --limit and drains oldest first', async () => {
    const store = await storeWithQueue(5);
    const seen: string[] = [];

    const report = await drainQueue(
      {
        store,
        classify: async (input) => {
          seen.push(input.claim);
          return assessment('plausible', 0.5);
        },
        vet: async () => ({}),
        logger: silent,
      },
      { limit: 2 },
    );

    expect(report.examined).toBe(2);
    expect(seen[0]).toContain('number 0');
    expect(seen[1]).toContain('number 1');
  });

  it('dry run changes nothing and never runs the pipeline', async () => {
    const store = await storeWithQueue(1);
    const vet = vi.fn(async () => ({}));

    await drainQueue(
      { store, classify: async () => assessment('plausible', 0.5), vet, logger: silent },
      { dryRun: true },
    );

    expect(vet).not.toHaveBeenCalled();
    expect(store.submissions()[0]?.status).toBe('queued');
    expect(store.submissions()[0]?.vettedAt).toBeUndefined();
  });

  it('reports an empty queue without calling anything', async () => {
    const store = await storeWithQueue(0);
    const classify = vi.fn(async () => assessment('plausible'));

    const report = await drainQueue({ store, classify, vet: async () => ({}), logger: silent });

    expect(report.examined).toBe(0);
    expect(classify).not.toHaveBeenCalled();
  });
});

describe('parseDrainArgs', () => {
  it('defaults to a small bounded run', () => {
    expect(parseDrainArgs([])).toEqual({
      limit: DEFAULT_DRAIN_LIMIT,
      dryRun: false,
      list: false,
      allowOffline: false,
      help: false,
    });
  });

  it('reads the flags', () => {
    const args = parseDrainArgs(['--limit', '3', '--dry-run', '--allow-offline']);
    expect(args).toMatchObject({ limit: 3, dryRun: true, allowOffline: true });
  });

  it('falls back to the default on a nonsense limit rather than draining everything', () => {
    expect(parseDrainArgs(['--limit', 'banana']).limit).toBe(DEFAULT_DRAIN_LIMIT);
    expect(parseDrainArgs(['--limit', '-5']).limit).toBe(DEFAULT_DRAIN_LIMIT);
  });
});
