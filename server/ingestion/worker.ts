/**
 * Scheduled live-research ingestion worker — `npm run ingest`.
 *
 * On a cadence (`INGEST_INTERVAL_HOURS`, default 6) it runs one bounded cycle:
 *
 *   for each topic in the batch:
 *     researchFactors(topic)                       ← Phase A, Firecrawl
 *       → for each candidate: score its sources    ← reputability gate
 *         → verified if max score ≥ threshold, else pending
 *     → pipeline.processBatch(...)                 ← Phase B/C/D + write (unchanged)
 *       → pg_notify('factor_updates', …)           ← SSE fan-out (pgRepository)
 *
 * The pipeline's Phase A is wired to `researchFactors` via `createResearchExtractor`
 *; Phase B (embed), C (similarity), D (resolve/escalate) and the
 * recalculation are untouched. Idempotency is per-finding (source URL), so
 * re-running the same topics each cycle only ingests genuinely new findings.
 *
 * SEED-MODE / NO-CREDS GUARD: the scheduler will NOT run unattended
 * without BOTH live ingestion credentials (`FIREWORKS_API_KEY` for the LLM +
 * embeddings, `FIRECRAWL_API_KEY` for retrieval) AND a `DATABASE_URL`. Missing any, it
 * logs clearly and no-ops (it never fabricates live findings, and there is nothing
 * to ingest into in seed mode). `runIngestOnce()` is exported for a manual/testable
 * single cycle and applies the same guard.
 *
 * Usage:
 *   npm run ingest            → start the scheduler (immediate first run, then every N h)
 *   npm run ingest -- --once  → run exactly one cycle and exit
 *
 * Required env: FIREWORKS_API_KEY (LLM turns + meaningful Phase B embeddings),
 * FIRECRAWL_API_KEY (retrieval), DATABASE_URL (target DB). Optional: INGEST_MODEL,
 * EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, INGEST_INTERVAL_HOURS, INGEST_TOPICS,
 * INGEST_BATCH_TOPICS, INGEST_MAX_CANDIDATES, FIRECRAWL_MAX_RESULTS,
 * FIRECRAWL_MAX_CONTENT_CHARS.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../db.js';
import {
  createPipelineFromEnv,
  createStubResolver,
  createResearchExtractor,
  type BatchResult,
  type GateResult,
  type InboundIntelItem,
  type ResearchFn,
  type SourceGate,
} from './pipeline.js';
import { createPgIngestionRepository } from './pgRepository.js';
import { createMemoryIngestionRepository } from './memoryRepository.js';
import { researchFactors, type CandidateFactor } from './websearch.js';
import {
  scoreSource,
  REPUTABILITY_VERIFY_THRESHOLD,
  type ReputabilityOptions,
} from './reputability.js';
import { hasLiveCredentials } from './llmClient.js';
import { hasRetrievalCredentials } from './firecrawlClient.js';

/**
 * Live ingestion needs BOTH providers: Fireworks (reasoning + embeddings) and
 * Firecrawl (retrieval). With either missing there is no honest live cycle to
 * run, so the worker no-ops rather than half-running on stubs.
 */
function hasIngestionCredentials(env: NodeJS.ProcessEnv): boolean {
  return hasLiveCredentials(env) && hasRetrievalCredentials(env);
}
import { createLlmResolver } from './resolver.js';

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Default research topics, spanning BOTH poles of the axis so the aggregate is
 * not structurally biased toward Calamity. Overridable via `INGEST_TOPICS`
 * (newline- or comma-separated). Kept broad; the model narrows them per cycle.
 */
/**
 * The built-in research net, used when `INGEST_TOPICS` is unset. A wide, current
 * sweep across the ecological, economic, social, and technological forces on the
 * Calamity↔Humanity axis.
 *
 * Calamity (C, extractive/decay) and Humanity (H, connective/resilience) topics
 * are INTERLEAVED, not grouped, for two reasons. The aggregate must not be
 * structurally biased toward either pole; and the batch window rotates through
 * the list a few topics at a time, so any contiguous window has to stay roughly
 * balanced — grouping would make an early window (and every non-rotating
 * `ingest:once`, which always starts at index 0) pull one pole only.
 *
 * Phrased as recency-biased search queries; no hard-coded year, so they do not
 * go stale. Each domain pairs a decay query with its counter-force so both poles
 * of the same arena are probed.
 */
/**
 * ASSESSMENT sweep — the same domains, aimed at a different GENRE of document.
 *
 * The news sweep below is phrased "latest / recent / newest", which retrieves
 * news. Thresholds are not published in news; they are published in assessments
 * and reviews. The evidence was one-sided: of 99 ingested factors, exactly ONE
 * cited IPCC, Nature, Science, PNAS or Copernicus, and every dated threshold in
 * the set traced back to the single topic that happened to mention ice sheets,
 * AMOC and permafrost by name.
 *
 * These name no element on purpose. Listing "Greenland, Barents, boreal forest"
 * would cap discovery at whatever the author thought of and bake their priors
 * into the data — the same mistake as a fixed vocabulary for `quantity`. Naming
 * the genre instead retrieves documents that ENUMERATE thresholds, and one such
 * review surfaces a dozen elements nobody had to anticipate.
 *
 * Run with a higher candidate cap than the news sweep: a review paper naming
 * sixteen tipping elements is worth sixteen factors, and the default cap of six
 * would silently discard the rest — the discovery bottleneck sits downstream of
 * retrieval, not in it.
 */
export const ASSESSMENT_TOPICS: readonly string[] = [
  'peer-reviewed assessments of irreversible thresholds and points of no return in the climate system and cryosphere',
  'scientific reviews identifying critical thresholds and regime shifts in ocean and marine systems',
  'assessment literature on ecosystem collapse thresholds in forests, biodiversity, and land systems',
  'published critical thresholds for freshwater, aquifer depletion, and food-system failure',
  'research identifying thresholds beyond which public-health or antimicrobial-resistance harm becomes irreversible',
  'scholarship on thresholds of institutional, economic, or societal breakdown from which recovery is not observed',
];

const DEFAULT_TOPICS: readonly string[] = [
  // Climate system & energy
  'latest climate tipping point and cryosphere findings: ice sheets, AMOC, permafrost', // C
  'recent breakthroughs in clean energy deployment, storage, and grid electrification', // H
  'newest data on greenhouse-gas and methane emission trends and remaining carbon budget', // C
  'recent progress in climate policy, climate finance commitments, and emissions cuts', // H
  // Biosphere & land
  'newest data on biodiversity loss, deforestation, and ecosystem collapse', // C
  'recent progress in reforestation, rewilding, and habitat protection', // H
  'recent findings on soil degradation, desertification, and food-system fragility', // C
  'recent progress in regenerative agriculture and global food security', // H
  // Oceans & freshwater
  'recent findings on ocean warming, acidification, coral bleaching, and fisheries decline', // C
  'recent gains in marine protected areas and ocean conservation', // H
  'latest findings on freshwater depletion, drought, and aquifer stress', // C
  'recent progress in water access, sanitation, and drought resilience', // H
  // Economy & inequality
  'latest data on economic inequality and wealth concentration', // C
  'recent progress on global poverty reduction and access to education', // H
  'recent findings on pollution harms: plastics, PFAS, and air quality', // C
  'recent progress in pollution cleanup, circular economy, and materials innovation', // H
  // Health
  'newest data on antimicrobial resistance and emerging pandemic risk', // C
  'recent public-health advances: disease control, vaccination, and mortality gains', // H
  // Society, governance & conflict
  'recent developments in democratic backsliding, authoritarianism, and armed conflict', // C
  'recent conflict-resolution, peace processes, and human-rights progress', // H
  'recent findings on forced displacement and climate migration', // C
  'recent gains in climate adaptation and community resilience', // H
  // Technology & institutions
  'current AI-driven labour disruption, misinformation, and institutional risk', // C
  'recent advances using AI and technology for scientific and medical breakthroughs', // H
  'latest reporting on critical-infrastructure fragility and cyber threats', // C
  'recent milestones in energy efficiency and industrial decarbonization', // H
];

const DEFAULT_INTERVAL_HOURS = 6;
const DEFAULT_BATCH_TOPICS = 3;
const DEFAULT_MAX_CANDIDATES = 6;

/**
 * Candidate cap for the assessment sweep. Higher than the news default because
 * the documents are different: a news item carries one finding, a review carries
 * a table of them. Capping both at six throws away most of what makes the
 * assessment genre worth retrieving.
 */
const DEFAULT_ASSESSMENT_MAX_CANDIDATES = 20;

/**
 * A topic plus how many candidates it may yield. Genres differ in density, so
 * the cap travels with the query rather than being one global number.
 */
export interface Sweep {
  topic: string;
  maxCandidates: number;
}

/** Parse `INGEST_TOPICS` (comma/newline separated) or fall back to the defaults. */
function topicsFromEnv(env: NodeJS.ProcessEnv): string[] {
  const raw = env.INGEST_TOPICS?.trim();
  if (!raw) return [...DEFAULT_TOPICS];
  const parsed = raw
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return parsed.length > 0 ? parsed : [...DEFAULT_TOPICS];
}

/**
 * Interleave one assessment sweep into each news batch.
 *
 * Not appended to the same list: with 22 news topics rotating 3 at a time, an
 * assessment topic would surface about every seventh cycle, and the threshold
 * intake would stay as starved as it already was. One per batch guarantees the
 * genre is probed every cycle regardless of where the news window sits.
 *
 * An explicit `INGEST_TOPICS` suppresses this — an operator who names topics
 * gets exactly those, with no silent additions.
 */
function sweepsForCycle(env: NodeJS.ProcessEnv, newsBatch: string[]): Sweep[] {
  const maxCandidates = positiveIntEnv(env.INGEST_MAX_CANDIDATES, DEFAULT_MAX_CANDIDATES);
  const news: Sweep[] = newsBatch.map((topic) => ({ topic, maxCandidates }));

  if (env.INGEST_TOPICS?.trim()) return news;

  const assessmentMax = positiveIntEnv(
    env.INGEST_ASSESSMENT_MAX_CANDIDATES,
    DEFAULT_ASSESSMENT_MAX_CANDIDATES,
  );
  const pick = ASSESSMENT_TOPICS[assessmentCursor % ASSESSMENT_TOPICS.length]!;
  assessmentCursor++;
  return [...news, { topic: pick, maxCandidates: assessmentMax }];
}

/** Rotates the assessment sweep independently of the news window. */
let assessmentCursor = 0;

function positiveIntEnv(value: string | undefined, fallback: number): number {
  const n = value ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function intervalHours(env: NodeJS.ProcessEnv): number {
  return positiveIntEnv(env.INGEST_INTERVAL_HOURS, DEFAULT_INTERVAL_HOURS);
}

/**
 * Rotate the topic window across cycles so a bounded batch still covers the whole
 * topic list over time. Deterministic per-cycle from a monotonic counter.
 */
let cycleCounter = 0;
function boundedBatch(topics: string[], size: number): string[] {
  if (topics.length <= size) return topics;
  const start = (cycleCounter * size) % topics.length;
  const batch: string[] = [];
  for (let i = 0; i < size; i++) {
    batch.push(topics[(start + i) % topics.length]!);
  }
  return batch;
}

/* -------------------------------------------------------------------------- */
/* Reputability gate                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build the source gate the research extractor calls per candidate. It scores
 * EVERY source, keeps the MAX, and gates on the threshold. The winning source
 * becomes the primary citation; the score + reasoning are logged for
 * auditability (: the gate is never a black box).
 *
 * The DECIDING (max-scoring) source's score + reasoning are BOTH returned on the
 * `GateResult` so the pipeline persists them to `factors.reputability_score` /
 * `reputability_reasoning` (migration 004) — the gate is now auditable
 * end-to-end, not merely logged. The reasoning is still logged too, per source.
 */
export function buildReputabilityGate(
  logger: Pick<Console, 'warn' | 'error' | 'info'>,
  scoreOpts: ReputabilityOptions,
): SourceGate {
  return async (candidate: CandidateFactor): Promise<GateResult> => {
    const claim = `${candidate.name}: ${candidate.description}`;
    let best: CandidateFactor['sources'][number] | null = null;
    let bestScore = -1;
    let bestReasoning = '';

    for (const source of candidate.sources) {
      const result = await scoreSource(
        {
          url: source.url,
          publisher: source.publisher,
          quoteSnippet: source.quoteSnippet,
          claim,
        },
        scoreOpts,
      );
      logger.info?.(
        `[ingest] reputability ${result.score.toFixed(2)} (${result.provenance}) ` +
          `for ${source.publisher} <${source.url}> — ${result.reasoning}`,
      );
      if (result.score > bestScore) {
        bestScore = result.score;
        best = source;
        bestReasoning = result.reasoning;
      }
    }

    const verificationState =
      bestScore >= REPUTABILITY_VERIFY_THRESHOLD ? 'verified' : 'pending';

    if (best) {
      return {
        verificationState,
        citation: {
          publisher: best.publisher,
          sourceUrl: best.url,
          quoteSnippet: best.quoteSnippet,
        },
        // Persist the deciding source's audit trail.
        reputabilityScore: bestScore,
        reputabilityReasoning: bestReasoning,
      };
    }
    // No sources at all → cannot verify; keep pending with a placeholder citation.
    // No source was scored, so there is no audit trail to persist.
    return {
      verificationState: 'pending',
      citation: {
        publisher: 'live-research',
        sourceUrl: null,
        quoteSnippet: candidate.description.slice(0, 280) || candidate.name,
      },
    };
  };
}

/* -------------------------------------------------------------------------- */
/* One cycle                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Run exactly one ingest cycle. Returns the batch result, or `null` when guarded
 * off (no DB / no credentials). Manual and testable; the scheduler calls it too.
 */
export async function runIngestOnce(
  logger: Pick<Console, 'warn' | 'error' | 'info' | 'log'> = console,
): Promise<BatchResult | null> {
  const env = process.env;

  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) {
    logger.warn(
      '[ingest] DATABASE_URL is not set — nothing to ingest into (seed mode). ' +
        'Scheduled ingestion is a no-op. See .env.example.',
    );
    return null;
  }
  if (!hasIngestionCredentials(env)) {
    logger.warn(
      '[ingest] missing FIREWORKS_API_KEY and/or FIRECRAWL_API_KEY — refusing to ' +
        'run live research unattended. This cycle is a no-op. Set BOTH keys to ' +
        'enable it.',
    );
    return null;
  }

  const batchSize = positiveIntEnv(env.INGEST_BATCH_TOPICS, DEFAULT_BATCH_TOPICS);
  const sweeps = sweepsForCycle(env, boundedBatch(topicsFromEnv(env), batchSize));
  const topics = sweeps.map((s) => s.topic);
  cycleCounter++;

  // The cap travels with the topic: an assessment review is worth many more
  // candidates than a news item, and one global number starves whichever genre
  // it was not tuned for.
  const capFor = new Map(sweeps.map((s) => [s.topic, s.maxCandidates]));
  const research: ResearchFn = (topic) =>
    researchFactors(topic, {
      maxCandidates: capFor.get(topic) ?? DEFAULT_MAX_CANDIDATES,
      logger,
    });
  const gate = buildReputabilityGate(logger, { logger });

  const { db, pool } = createDatabase(connectionString);
  const pipeline = createPipelineFromEnv(env, {
    repository: createPgIngestionRepository(db),
    extractor: createResearchExtractor(research, gate),
    // Phase D entity-resolution: the LLM resolver when live, else the
    // deterministic stub. Either way the escalation MATH stays deterministic — the
    // resolver only classifies; `resolveOutcome`/`recalculateOnEscalation` compute
    // the stored numbers (finding 28 / ). This branch is reached only with
    // live credentials (the guard above), so the LLM resolver is the live default.
    resolver: hasIngestionCredentials(env) ? createLlmResolver() : createStubResolver(),
    logger,
  });

  logger.log(
    `[ingest] cycle start — ${topics.length} topic(s), embeddings=${pipeline.embeddings.model}` +
      `${pipeline.embeddings.isStub ? ' (STUB — non-semantic; dedup is unreliable)' : ''}, ` +
      `verify-threshold=${REPUTABILITY_VERIFY_THRESHOLD}`,
  );

  try {
    // One InboundIntelItem per topic: rawText carries the (trusted) topic string,
    // which createResearchExtractor feeds to researchFactors as Phase A.
    const items: InboundIntelItem[] = topics.map((topic) => ({
      externalId: `topic:${topic}`,
      rawText: topic,
      sourceUrl: null,
      publisher: 'live-research',
      retrievedAt: new Date(),
    }));

    const result = await pipeline.processBatch(items);
    logger.log('[ingest] cycle result:', JSON.stringify(result));
    return result;
  } catch (err) {
    logger.error('[ingest] cycle failed:', err);
    return null;
  } finally {
    await db.destroy();
    await pool.end().catch(() => undefined);
  }
}

/* -------------------------------------------------------------------------- */
/* Offline cycle (no creds / no DB) — proves the wiring, fabricates nothing     */
/* -------------------------------------------------------------------------- */

/**
 * Run ONE fully-offline cycle against an in-memory repository. This never touches
 * the network or Postgres: Phase A is the deterministic `researchFactorsOffline`
 * (placeholder sources that stay `pending`), the gate is the offline reputability
 * heuristic, embeddings are the stub, and Phase D is `createStubResolver`. It
 * exists so `tsx worker.ts --once` (and `npm run ingest:once`) is runnable with
 * NO credentials — it prints the resulting factors + gate decisions and exits
 * cleanly, proving the full A→D wiring without ever fabricating a live finding.
 */
export async function runIngestOnceOffline(
  logger: Pick<Console, 'warn' | 'error' | 'info' | 'log'> = console,
): Promise<BatchResult> {
  const env = process.env;
  const batchSize = positiveIntEnv(env.INGEST_BATCH_TOPICS, DEFAULT_BATCH_TOPICS);
  const maxCandidates = positiveIntEnv(env.INGEST_MAX_CANDIDATES, DEFAULT_MAX_CANDIDATES);
  const topics = boundedBatch(topicsFromEnv(env), batchSize);
  cycleCounter++;

  const research: ResearchFn = (topic) =>
    researchFactors(topic, { maxCandidates, logger });
  const gate = buildReputabilityGate(logger, { logger });
  const repository = createMemoryIngestionRepository();

  // Force the STUB embedding client regardless of ambient env (no key, non-prod),
  // so an offline cycle never tries to reach a real embeddings provider.
  const pipeline = createPipelineFromEnv(
    { NODE_ENV: 'development' },
    {
      repository,
      extractor: createResearchExtractor(research, gate),
      resolver: createStubResolver(),
      logger,
    },
  );

  logger.log(
    `[ingest] OFFLINE cycle (no credentials) — ${topics.length} topic(s), ` +
      `embeddings=${pipeline.embeddings.model} (STUB), in-memory repository. ` +
      'Sources are placeholders and stay pending; nothing is fabricated as live.',
  );

  const items: InboundIntelItem[] = topics.map((topic) => ({
    externalId: `topic:${topic}`,
    rawText: topic,
    sourceUrl: null,
    publisher: 'live-research',
    retrievedAt: new Date(),
  }));

  const result = await pipeline.processBatch(items);

  const factors = repository.factors();
  logger.log(`[ingest] OFFLINE cycle persisted ${factors.length} factor(s):`);
  for (const f of factors) {
    const rep =
      f.reputabilityScore !== undefined
        ? `rep=${f.reputabilityScore.toFixed(2)} — ${f.reputabilityReasoning ?? ''}`
        : 'rep=n/a';
    logger.log(
      `  · [${f.verificationState}] ${f.name} ` +
        `(effect=${f.effect.toFixed(3)}, sig=${f.significance.toFixed(3)}) ${rep}`,
    );
  }
  logger.log('[ingest] OFFLINE cycle result:', JSON.stringify(result));
  return result;
}

/* -------------------------------------------------------------------------- */
/* Scheduler                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Start the cadence. Guarded: with no DATABASE_URL or no credentials it logs and
 * does NOT arm an interval (so a seed-mode dev box never spins an idle timer or
 * fabricates data). Otherwise it runs immediately and then every N hours.
 */
function startScheduler(): void {
  const env = process.env;
  const canRun = Boolean(env.DATABASE_URL?.trim()) && hasIngestionCredentials(env);
  if (!canRun) {
    console.warn(
      '[ingest] scheduled ingestion DISABLED — requires DATABASE_URL, ' +
        'FIREWORKS_API_KEY and FIRECRAWL_API_KEY. Running neither a first cycle ' +
        'nor a timer. ' +
        '(This is the correct seed-mode / no-creds behavior.)',
    );
    return;
  }

  const hours = intervalHours(env);
  console.log(
    `[ingest] scheduler armed — immediate cycle now, then every ${hours}h.`,
  );
  void runIngestOnce();
  const timer = setInterval(
    () => {
      void runIngestOnce();
    },
    hours * 60 * 60 * 1000,
  );
  // Do not keep the event loop alive solely for the timer if nothing else is
  // running; a supervisor (pm2/systemd/container) is expected to keep the process
  // up. `unref` makes the timer non-blocking without cancelling it.
  timer.unref();
}

/* -------------------------------------------------------------------------- */
/* Entrypoint                                                                 */
/* -------------------------------------------------------------------------- */

/** True when this module was invoked directly (`node`/`tsx worker.ts`). */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  if (process.argv.includes('--once')) {
    // Live when both DATABASE_URL and a credential are present; otherwise fall
    // back to the fully-offline in-memory cycle so `--once` ALWAYS runs cleanly
    // (never hangs, never errors on missing creds) and proves the wiring.
    const canRunLive =
      Boolean(process.env.DATABASE_URL?.trim()) && hasIngestionCredentials(process.env);
    const run = canRunLive
      ? runIngestOnce().then((result) => {
          process.exitCode = result === null ? 1 : 0;
        })
      : runIngestOnceOffline().then(() => {
          process.exitCode = 0;
        });
    run.catch((err: unknown) => {
      console.error('[ingest] worker crashed:', err);
      process.exit(1);
    });
  } else {
    startScheduler();
  }
}
