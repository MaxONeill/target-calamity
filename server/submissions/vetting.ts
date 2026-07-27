/**
 * Handing an ACCEPTED submission to the EXISTING vetting pipeline.
 *
 * This module deliberately contains no vetting logic of its own. Everything a
 * submitted claim must go through — retrieve the cited source, extract a typed
 * candidate, score the source's reputability, gate verified-vs-pending, embed,
 * find near-duplicates, resolve insert-vs-escalate, write — already exists in
 * `server/ingestion/pipeline.ts` and is exercised by the scheduled worker. All
 * this does is construct the same pipeline and feed it ONE item.
 *
 * The submitted claim becomes the Phase A research TOPIC and the submitted URL is
 * appended to it, so retrieval is pointed at the cited source. That is the only
 * concession to the submission path.
 *
 * WHAT THE SUBMITTER DOES NOT GET TO DECIDE (the anti-manipulation rule): every
 * stored number — `effect`, `significance`, `lat`, `lon`, `verificationState`,
 * `tippingPoint` — is produced downstream by Phase A extraction and the
 * reputability gate. The submission contributes a claim and a URL and nothing
 * else, which is why the request schema is `.strict()`.
 *
 * Offline / seed mode: the pipeline is built over the in-memory ingestion
 * repository with the stub research + stub resolver, so the handoff is provably
 * wired without a database or a network. Nothing is fabricated as live — the
 * offline stubs label themselves and land factors as `pending`.
 */
import type { AppContext } from '../db.js';
import {
  createPipelineFromEnv,
  createResearchExtractor,
  createStubResolver,
  type BatchResult,
  type InboundIntelItem,
  type ResearchFn,
} from '../ingestion/pipeline.js';
import { createPgIngestionRepository } from '../ingestion/pgRepository.js';
import { createMemoryIngestionRepository } from '../ingestion/memoryRepository.js';
import { researchFactors } from '../ingestion/websearch.js';
import { buildReputabilityGate } from '../ingestion/worker.js';
import { createLlmResolver } from '../ingestion/resolver.js';
import { hasLiveCredentials } from '../ingestion/llmClient.js';
import { hasRetrievalCredentials } from '../ingestion/retrieval.js';

/** The accepted submission, as handed to the pipeline. */
export interface AcceptedSubmission {
  claim: string;
  sourceUrl: string;
  note?: string | undefined;
}

export type Logger = Pick<Console, 'warn' | 'error' | 'info' | 'log'>;

/**
 * Run ONE accepted submission through the full ingestion pipeline. Returns the
 * batch result, or `null` if the run failed (logged, never thrown at the caller
 * — the submitter has already been answered by the time this runs).
 */
export async function vetSubmission(
  ctx: AppContext,
  submission: AcceptedSubmission,
  logger: Logger = console,
): Promise<BatchResult | null> {
  const env = process.env;
  const live = hasLiveCredentials(env) && hasRetrievalCredentials(env);

  // Phase A: the claim IS the research topic, with the cited URL appended so the
  // retrieval step is pointed at the source the submitter actually offered.
  const research: ResearchFn = (topic) => researchFactors(topic, { maxCandidates: 1, logger });
  const gate = buildReputabilityGate(logger, { logger });

  const repository =
    ctx.mode === 'db' ? createPgIngestionRepository(ctx.db) : createMemoryIngestionRepository();

  const pipeline = createPipelineFromEnv(
    // Force the stub embedding client when we are not live, so an offline
    // submission never tries to reach a real embeddings provider.
    live ? env : { NODE_ENV: 'development' },
    {
      repository,
      extractor: createResearchExtractor(research, gate),
      resolver: live ? createLlmResolver() : createStubResolver(),
      logger,
    },
  );

  const item: InboundIntelItem = {
    externalId: 'submission',
    // Trusted-as-a-TOPIC only: `researchFactors` treats this as a search string,
    // and the extraction turn that consumes the retrieved documents already
    // treats their content as untrusted data (/finding 27). The claim has
    // additionally cleared the noise filter before reaching here.
    rawText: `${submission.claim} (source: ${submission.sourceUrl})`,
    sourceUrl: null,
    publisher: 'anonymous-submission',
    retrievedAt: new Date(),
  };

  try {
    const result = await pipeline.processBatch([item]);
    logger.log('[submissions] vetting result:', JSON.stringify(result));
    return result;
  } catch (err) {
    logger.error('[submissions] vetting failed:', err);
    return null;
  }
}
