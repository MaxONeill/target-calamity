/**
 * END-TO-END OFFLINE integration test for the Reconciliation Loop (§3 Phase A→D).
 *
 * Runs a full cycle — research → embed → dedupe → reputability gate → resolve →
 * persist — against the in-memory repository, with NO credentials and NO network.
 * The reputability gate is the real offline heuristic (via the worker's
 * `buildReputabilityGate`), embeddings are the deterministic stub, and Phase D is
 * the deterministic stub resolver. This proves the wiring end-to-end offline:
 * candidates are researched, deduped, scored, and correctly gated to
 * verified/pending by the threshold, the tippingPoint is carried through, and a
 * second run is idempotent (no duplicate persists).
 *
 * No live call is ever made — every seam is the offline stub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createPipeline,
  createResearchExtractor,
  createStubResolver,
  type InboundIntelItem,
  type ResearchFn,
} from './pipeline.js';
import { createStubEmbeddingClient } from './embeddings.js';
import { createMemoryIngestionRepository } from './memoryRepository.js';
import { buildReputabilityGate } from './worker.js';
import { REPUTABILITY_VERIFY_THRESHOLD } from './reputability.js';
import type { CandidateFactor } from './websearch.js';

const silent = { warn: () => {}, error: () => {}, info: () => {}, log: () => {} };

/** A deterministic research engine returning two controlled candidates per topic. */
const research: ResearchFn = async (topic): Promise<CandidateFactor[]> => [
  {
    name: `Reputable threshold — ${topic}`,
    description: 'Backed by a reputable primary source; carries a dated threshold.',
    effect: -0.6,
    significance: 0.7,
    lat: 78,
    lon: -42,
    spatialPath: 'global',
    tippingPoint: { centralYear: 2045, label: 'test threshold' },
    sources: [
      {
        url: 'https://www.nature.com/articles/test-1',
        publisher: 'Nature',
        quoteSnippet: 'A reputable primary source backs this claim.',
        verbatim: true,
      },
    ],
  },
  {
    name: `Weak claim — ${topic}`,
    description: 'Backed only by a self-published placeholder source.',
    effect: 0.3,
    significance: 0.4,
    lat: 10,
    lon: 20,
    spatialPath: 'global',
    sources: [
      {
        url: 'https://example.org/blog/test-2',
        publisher: 'Some Blog',
        quoteSnippet: 'A weak placeholder source.',
        verbatim: false,
      },
    ],
  },
];

function buildPipeline(repo: ReturnType<typeof createMemoryIngestionRepository>) {
  const gate = buildReputabilityGate(silent, { logger: silent });
  return createPipeline({
    repository: repo,
    embeddings: createStubEmbeddingClient(),
    extractor: createResearchExtractor(research, gate),
    resolver: createStubResolver(),
    logger: silent,
  });
}

const items: InboundIntelItem[] = [
  {
    externalId: 'topic:test',
    rawText: 'a test topic',
    sourceUrl: null,
    publisher: 'live-research',
    retrievedAt: new Date(),
  },
];

beforeEach(() => {
  // Force the offline reputability heuristic (no live credentials).
  vi.stubEnv('FIREWORKS_API_KEY', '');
  vi.stubEnv('FIRECRAWL_API_KEY', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('full offline A→D cycle', () => {
  it('researches, scores, gates, and persists both candidates', async () => {
    const repo = createMemoryIngestionRepository();
    const pipeline = buildPipeline(repo);

    const result = await pipeline.processBatch(items);

    expect(result.processedFactors).toBe(2);
    expect(result.inserted).toBe(2);
    expect(result.escalated).toBe(0);

    const factors = repo.factors();
    expect(factors).toHaveLength(2);

    const reputable = factors.find((f) => f.name.startsWith('Reputable'));
    const weak = factors.find((f) => f.name.startsWith('Weak'));
    expect(reputable).toBeDefined();
    expect(weak).toBeDefined();

    // Gating: the reputable (Nature) source clears the threshold → verified; the
    // placeholder (example.org) source does not → pending.
    expect(reputable!.verificationState).toBe('verified');
    expect(reputable!.reputabilityScore).toBeGreaterThanOrEqual(REPUTABILITY_VERIFY_THRESHOLD);
    expect(reputable!.reputabilityReasoning).toBeTruthy();

    expect(weak!.verificationState).toBe('pending');
    expect(weak!.reputabilityScore).toBeLessThan(REPUTABILITY_VERIFY_THRESHOLD);

    // tippingPoint carried through when present.
    expect(reputable!.tippingPoint).toEqual({ centralYear: 2045, label: 'test threshold' });
    expect(weak!.tippingPoint).toBeUndefined();
  });

  it('is idempotent on a second run (no duplicate persists)', async () => {
    const repo = createMemoryIngestionRepository();
    const pipeline = buildPipeline(repo);

    await pipeline.processBatch(items);
    expect(repo.factors()).toHaveLength(2);

    const second = await pipeline.processBatch(items);
    // Both findings' source URLs were already ingested → skipped per-finding.
    expect(second.skippedDuplicateFactors).toBe(2);
    expect(second.inserted).toBe(0);
    expect(second.escalated).toBe(0);
    expect(repo.factors()).toHaveLength(2);
  });

  it('deduplicates a genuine collision into an escalation, not a duplicate insert', async () => {
    const repo = createMemoryIngestionRepository();
    const gate = buildReputabilityGate(silent, { logger: silent });

    // Same name/description (→ identical stub embedding) but a DISTINCT source URL
    // each cycle, so per-finding idempotency does not pre-skip it and Phase C/D see
    // a real embedding collision.
    let n = 0;
    const collidingResearch: ResearchFn = async (): Promise<CandidateFactor[]> => {
      n += 1;
      return [
        {
          name: 'Same ongoing event',
          description: 'Identical text across reports.',
          effect: -0.5,
          significance: 0.5,
          lat: 0,
          lon: 0,
          spatialPath: 'global',
          sources: [
            {
              url: `https://example.org/report-${n}`,
              publisher: 'Outlet',
              quoteSnippet: 'evidence',
              verbatim: false,
            },
          ],
        },
      ];
    };
    const pipeline = createPipeline({
      repository: repo,
      embeddings: createStubEmbeddingClient(),
      extractor: createResearchExtractor(collidingResearch, gate),
      resolver: createStubResolver(),
      logger: silent,
    });

    const first = await pipeline.processBatch(items);
    expect(first.inserted).toBe(1);
    const second = await pipeline.processBatch(items);
    expect(second.inserted).toBe(0);
    expect(second.escalated).toBe(1);
    // Still exactly one factor — the collision escalated the parent, not duplicated it.
    expect(repo.factors()).toHaveLength(1);
    expect(repo.factors()[0]!.citationCount).toBe(2);
  });

  it('merges new data on escalation: backfills the tipping point and promotes to verified', async () => {
    const repo = createMemoryIngestionRepository();
    const gate = buildReputabilityGate(silent, { logger: silent });

    // Cycle 1: a weak, placeless source with NO tipping point → pending, no threshold.
    // Cycle 2: the SAME event (identical text → collision) from a reputable source
    // that DOES carry a dated threshold → would be verified on its own. The distinct
    // source URLs keep per-finding idempotency from pre-skipping cycle 2.
    let cycle = 0;
    const evolvingResearch: ResearchFn = async (): Promise<CandidateFactor[]> => {
      cycle += 1;
      const reputable = cycle === 2;
      return [
        {
          name: 'AMOC weakening',
          description: 'Identical text across both reports so the embeddings collide.',
          effect: -0.7,
          significance: 0.6,
          lat: 59,
          lon: -30,
          spatialPath: 'global',
          ...(reputable ? { tippingPoint: { centralYear: 2057, label: 'AMOC collapse' } } : {}),
          sources: [
            reputable
              ? {
                  url: 'https://www.nature.com/articles/amoc',
                  publisher: 'Nature',
                  quoteSnippet: 'A reputable primary source with a dated threshold.',
                  verbatim: true,
                }
              : {
                  url: 'https://example.org/blog/amoc',
                  publisher: 'Some Blog',
                  quoteSnippet: 'A weak placeholder source.',
                  verbatim: false,
                },
          ],
        },
      ];
    };
    const pipeline = createPipeline({
      repository: repo,
      embeddings: createStubEmbeddingClient(),
      extractor: createResearchExtractor(evolvingResearch, gate),
      resolver: createStubResolver(),
      logger: silent,
    });

    await pipeline.processBatch(items);
    const afterFirst = repo.factors()[0]!;
    expect(afterFirst.verificationState).toBe('pending');
    expect(afterFirst.tippingPoint).toBeUndefined();

    const second = await pipeline.processBatch(items);
    expect(second.escalated).toBe(1);

    const merged = repo.factors()[0]!;
    expect(repo.factors()).toHaveLength(1);
    expect(merged.citationCount).toBe(2); // both sources captured
    expect(merged.tippingPoint).toEqual({ centralYear: 2057, label: 'AMOC collapse' }); // backfilled
    expect(merged.verificationState).toBe('verified'); // promoted by the reputable source
  });
});
