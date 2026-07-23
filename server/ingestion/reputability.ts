/**
 * The source-reputability gate — the verified/pending decision input.
 *
 * `scoreSource(...)` rates one source's credibility as it backs a specific claim,
 * returning a score in [0, 1] AND a reasoning string. The worker scores every
 * source of a candidate, takes the MAX, and gates on
 * {@link REPUTABILITY_VERIFY_THRESHOLD}: at or above → the factor is `verified`
 * (enters the Clock aggregate); below → `pending` (stays in the feed, off the
 * aggregate). The reasoning is retained for auditability — the owner's rule is
 * that the gate is never a black box.
 *
 * LIVE: an LLM judges credibility (one JSON-schema-constrained Fireworks turn,
 * ). OFFLINE (no credentials): a deterministic, clearly-labelled heuristic
 * over the source's domain — enough to exercise threshold gating in tests without
 * a network call, and honest about being a heuristic, not a verdict.
 */
import * as z from 'zod/v4';
import {
  type LlmClient,
  getLlmClient,
  hasLiveCredentials,
  ingestModel,
  structuredCompletion,
} from './llmClient.js';

/**
 * Verification threshold. A factor whose best source scores at or above this is
 * `verified`; otherwise `pending`.
 *
 * Failure modes of moving it, in both directions (why it is a named, tunable
 * constant rather than a magic literal):
 *   - Too HIGH (→ 1.0): reputable primary sources get scored just under the bar,
 *     so genuine findings sit `pending` forever and the Clock under-reacts —
 *     the aggregate is starved and biased toward whatever little clears the bar.
 *   - Too LOW (→ 0.0): weak blogs and content farms clear the bar, so unvetted
 *     claims drive the Clock and the "empirical/verifiable" premise is hollow.
 * 0.7 keeps clearly-reputable sources in and clearly-weak ones out, leaving the
 * genuinely ambiguous middle `pending` for human review.
 */
export const REPUTABILITY_VERIFY_THRESHOLD = 0.7;

/** What the gate is shown about one source + the claim it is meant to support. */
export interface SourceToScore {
  /** Source URL, or null when a claim arrived with no locatable source. */
  url: string | null;
  publisher: string;
  quoteSnippet: string;
  /** The claim this source is being asked to support (the factor's thesis). */
  claim: string;
}

/** Where a score came from — so a stub score is never mistaken for a judgement. */
export type ScoreProvenance = 'live' | 'offline-stub';

export interface ReputabilityScore {
  /** Credibility in [0, 1]. */
  score: number;
  /** Human-readable justification — stored/logged for auditability. */
  reasoning: string;
  provenance: ScoreProvenance;
}

export interface ReputabilityOptions {
  client?: LlmClient;
  model?: string;
  logger?: Pick<Console, 'warn' | 'error' | 'info'>;
}

/* -------------------------------------------------------------------------- */
/* Live scoring                                                               */
/* -------------------------------------------------------------------------- */

/** Live output contract (zod v4 — source of truth for grammar AND validation). */
const ScoreSchema = z.object({
  score: z.number(),
  reasoning: z.string(),
});

const SCORING_SYSTEM =
  'You are a source-credibility rater for a fact-tracking system. Given a source ' +
  '(URL, publisher, supporting quote) and the claim it is cited for, rate how much ' +
  'a careful analyst should trust that this source establishes that claim. Return ' +
  'score in [0,1]: ~0.9+ for primary/peer-reviewed/official-statistics sources; ' +
  '~0.7-0.85 for established mainstream outlets; ~0.4-0.6 for weaker secondary or ' +
  'aggregator sources; <0.4 for anonymous blogs, social posts, or sources that do ' +
  'not actually support the claim. Consider primacy, editorial standards, and ' +
  'whether the quote genuinely backs the claim. Explain briefly in reasoning.';

function scoringPrompt(input: SourceToScore): string {
  return (
    `Claim: ${input.claim}\n\n` +
    `Source publisher: ${input.publisher}\n` +
    `Source URL: ${input.url ?? '(none provided)'}\n` +
    `Supporting quote: ${input.quoteSnippet}\n\n` +
    'Rate this source for this claim.'
  );
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/* -------------------------------------------------------------------------- */
/* Offline heuristic                                                          */
/* -------------------------------------------------------------------------- */

/** Extract a lowercased hostname from a URL, or null if unparseable. */
function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Domains the seed data bibliography treats as reputable (primary journals, official
 * agencies, established outlets). Not exhaustive — a curated allow-ish set so the
 * OFFLINE heuristic is deterministic and defensible, not a real credibility model.
 */
const REPUTABLE_DOMAINS = new Set<string>([
  'nature.com',
  'science.org',
  'nasa.gov',
  'nsidc.org',
  'noaa.gov',
  'ipcc.ch',
  'iea.org',
  'wmo.int',
  'who.int',
  'un.org',
  'ipbes.net',
  'sec.gov',
  'epa.gov',
  'opensecrets.org',
  'oxfam.org',
  'weforum.org',
  'reuters.com',
  'npr.org',
  'cnbc.com',
  'bloomberg.com',
  'jamanetwork.com',
  'goldmansachs.com',
  'pwc.com',
  'earth.org',
  'copernicus.org',
]);

/** Domains that should never clear the bar on their own. */
const LOW_TRUST_DOMAINS = new Set<string>([
  'example.org',
  'example.com',
  'medium.com',
  'blogspot.com',
  'wordpress.com',
  'substack.com',
  'reddit.com',
  'x.com',
  'twitter.com',
  'facebook.com',
]);

/** High-trust top-level suffixes (government / education / intergovernmental). */
const HIGH_TRUST_TLDS = ['.gov', '.edu', '.int'];

/**
 * Deterministic offline credibility estimate from a source's domain. Clearly
 * NOT a real judgement — it exists so threshold gating is testable offline. A
 * genuine reputable domain lands above the threshold; a placeholder/blog lands
 * below it; unknown domains sit in the ambiguous middle (`pending`).
 */
export function scoreSourceOffline(input: SourceToScore): ReputabilityScore {
  const host = hostOf(input.url);
  let score: number;
  let why: string;

  if (host === null) {
    score = 0.2;
    why = 'No parseable source URL; a claim without a locatable source is weak.';
  } else if (LOW_TRUST_DOMAINS.has(host) || host.endsWith('.example.org')) {
    score = 0.2;
    why = `Domain ${host} is a placeholder/self-published host — not independently reputable.`;
  } else if (HIGH_TRUST_TLDS.some((tld) => host.endsWith(tld))) {
    score = 0.9;
    why = `Domain ${host} is a government/education/intergovernmental source (high trust).`;
  } else if (REPUTABLE_DOMAINS.has(host) || bareDomain(host)) {
    score = 0.8;
    why = `Domain ${host} is on the curated reputable-source list.`;
  } else {
    score = 0.5;
    why = `Domain ${host} is unrecognised; treated as ambiguous pending review.`;
  }

  // Small penalty for non-HTTPS transport (deterministic, bounded).
  if (input.url && input.url.startsWith('http://')) {
    score = clamp01(score - 0.1);
    why += ' Served over plain HTTP (minor penalty).';
  }

  return {
    score: clamp01(score),
    reasoning: `[offline heuristic] ${why}`,
    provenance: 'offline-stub',
  };
}

/** True if `host` is a subdomain of any curated reputable domain (e.g. `spectrum.ieee.org`). */
function bareDomain(host: string): boolean {
  for (const d of REPUTABLE_DOMAINS) {
    if (host === d || host.endsWith(`.${d}`)) return true;
  }
  // Also honour well-known reputable registrable domains not enumerated above.
  return host.endsWith('.ieee.org') || host.endsWith('.gov.uk') || host.endsWith('.ac.uk');
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Score one source's credibility for a claim. LIVE via the LLM when credentials
 * exist; otherwise the deterministic {@link scoreSourceOffline} heuristic. Never
 * throws for a bad live response — it falls back to the offline heuristic and
 * logs, so a single scoring failure degrades to `pending` rather than crashing a
 * whole ingest cycle.
 */
export async function scoreSource(
  input: SourceToScore,
  opts: ReputabilityOptions = {},
): Promise<ReputabilityScore> {
  const logger = opts.logger ?? console;

  if (!hasLiveCredentials()) {
    return scoreSourceOffline(input);
  }

  const client = opts.client ?? getLlmClient();
  const model = opts.model ?? ingestModel();

  try {
    const out = await structuredCompletion({
      client,
      model,
      system: SCORING_SYSTEM,
      user: scoringPrompt(input),
      schema: ScoreSchema,
      schemaName: 'ReputabilityScore',
    });
    if (out === null) {
      logger.warn?.(
        '[ingestion] reputability scoring returned no parseable output; falling back to heuristic.',
      );
      return scoreSourceOffline(input);
    }
    return {
      score: clamp01(out.score),
      reasoning: out.reasoning.trim() || '(model gave no reasoning)',
      provenance: 'live',
    };
  } catch (err) {
    logger.error?.(
      `[ingestion] reputability scoring failed (${String(err)}); falling back to heuristic.`,
    );
    return scoreSourceOffline(input);
  }
}
