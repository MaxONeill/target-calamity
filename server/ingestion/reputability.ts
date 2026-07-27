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
  /**
   * The two axes behind {@link score}, exposed so a caller can gate on them
   * SEPARATELY rather than re-deriving them by parsing `reasoning`.
   *
   * Needed because the axes mean different things to different callers. Factor
   * ingestion asks "is this claim about the world true?", where publisher
   * primacy is decisive. The counter-efforts pass asks "does this organisation
   * exist and do this work?", where the organisation's own site is a PRIMARY
   * source and the credibility axis penalises it for being self-published. The
   * support axis — does the quote actually name them — remains the guard that
   * matters there, and must not be relaxed with it.
   */
  credibility: number;
  support: number;
}

/**
 * Gate for the counter-efforts pass, deliberately not {@link REPUTABILITY_VERIFY_THRESHOLD}.
 *
 * Support is held HIGHER than the combined gate's floor, not lower: it is the
 * anti-fabrication guard, and an invented organisation is the worst output this
 * system can produce because a reader may act on it. What is relaxed is only the
 * expectation of publisher primacy, which is measuring the wrong thing here —
 * `globalfundcoralreefs.org` scored 0.68 on a real federal body (the U.S. Coral
 * Reef Task Force) and lost it by 0.02, while the same organisations sit happily
 * on neighbouring factors that happened to draw luckier URLs.
 *
 * A domain that fails BOTH axes is still refused: facebook.com at 0.15 stays out.
 */
export const EFFORT_SUPPORT_MIN = 0.55;
export const EFFORT_CREDIBILITY_MIN = 0.45;

/** Does this score admit an effort? Both axes, judged on their own terms. */
export function admitsEffort(score: ReputabilityScore): boolean {
  return score.support >= EFFORT_SUPPORT_MIN && score.credibility >= EFFORT_CREDIBILITY_MIN;
}

export interface ReputabilityOptions {
  client?: LlmClient;
  model?: string;
  logger?: Pick<Console, 'warn' | 'error' | 'info'>;
}

/* -------------------------------------------------------------------------- */
/* Live scoring                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Live output contract (zod v4 — source of truth for grammar AND validation).
 *
 * TWO axes, not one. The original schema asked for a single number rating "how
 * much a careful analyst should trust that this source establishes that claim",
 * which silently multiplies credibility by quote-fit — and that biases the whole
 * corpus toward news.
 *
 * A news article states its entire claim in its lead sentence, so the extracted
 * quote fits perfectly and the score stays high. A paper states a threshold in a
 * table, a figure caption, or across a results section, so ANY single quote
 * supports the claim only partially and the score collapses. The observed
 * result: a Nature article scored 0.15 and was rejected while researchgate.net —
 * a repost aggregator — passed, and just 1 of 99 ingested factors cited primary
 * literature at all.
 *
 * Separating the axes lets a strong publisher with a partial quote survive,
 * while stopping a perfect quote from carrying an aggregator over the bar.
 */
const ScoreSchema = z.object({
  /** Primacy and editorial standards of the publisher, independent of the quote. */
  sourceCredibility: z.number(),
  /** How completely this particular quote backs this particular claim. */
  claimSupport: z.number(),
  reasoning: z.string(),
});

/**
 * Credibility dominates because it is the axis we can observe reliably.
 *
 * Claim support is measured from ONE extracted sentence, which under-represents
 * a primary source almost by construction — the number usually lives in a table
 * the extractor never quoted. Credibility, by contrast, is a property of the
 * publisher and is judged well from the URL alone. Weighting them equally would
 * reproduce the bias this split exists to remove.
 *
 * The weights are a stated policy, not a tuned constant: they are here, in the
 * open, testable, rather than buried in a prompt's wording.
 */
const CREDIBILITY_WEIGHT = 0.7;
const SUPPORT_WEIGHT = 0.3;

/**
 * Support below this means the quote does not back the claim at all — a mis-cite
 * or a hallucinated quote. No publisher's reputation should rescue that, so the
 * combined score is floored to zero rather than blended.
 */
const SUPPORT_FLOOR = 0.15;

/** Combine the two axes into the single score callers gate on. */
export function combineScores(sourceCredibility: number, claimSupport: number): number {
  if (claimSupport < SUPPORT_FLOOR) return 0;
  return CREDIBILITY_WEIGHT * sourceCredibility + SUPPORT_WEIGHT * claimSupport;
}

const SCORING_SYSTEM =
  'You rate sources for a fact-tracking system. Given a source (URL, publisher, ' +
  'supporting quote) and the claim it is cited for, return TWO INDEPENDENT ' +
  'scores in [0,1]. Do not let one influence the other. ' +
  'sourceCredibility rates the PUBLISHER alone, ignoring the quote entirely: ' +
  '~0.9+ for peer-reviewed journals, official statistics agencies, and primary ' +
  'scientific assessments (Nature, Science, PNAS, IPCC, Copernicus/EGU journals, ' +
  'NOAA, NASA, WMO, national statistics offices); ~0.7-0.85 for established ' +
  'mainstream outlets and reputable NGO or institutional reports; ~0.4-0.6 for ' +
  'REPOST AGGREGATORS that host other people\'s papers without editorial ' +
  'responsibility (ResearchGate, Academia.edu, Scribd, content farms) even when ' +
  'the hosted paper is genuine — cite the publisher, not the mirror; <0.4 for ' +
  'anonymous blogs, social posts, and SEO content. ' +
  'claimSupport rates ONLY whether this quote backs this claim: 1.0 if it states ' +
  'it outright, ~0.5-0.8 if it supports part of it or supports it in context, ' +
  'and <0.15 ONLY if the quote is irrelevant to the claim or contradicts it. ' +
  'PARTIAL SUPPORT IS NORMAL AND EXPECTED for primary literature: a paper states ' +
  'its threshold in a table or figure, so an extracted sentence often gestures at ' +
  'the finding rather than containing the number. Do not mark that down as though ' +
  'the source were unreliable — that is a property of quoting a paper, not a ' +
  'defect in the paper. Explain both scores briefly in reasoning.';

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
    // The heuristic judges the DOMAIN only; it never reads the quote. Reporting
    // the same number on both axes would let an effort clear the support gate on
    // evidence the stub never looked at, so support is reported as 0 — the stub
    // cannot admit an effort, which is the honest behaviour for a scorer that
    // has not read anything.
    credibility: clamp01(score),
    support: 0,
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
    const credibility = clamp01(out.sourceCredibility);
    const support = clamp01(out.claimSupport);
    return {
      score: clamp01(combineScores(credibility, support)),
      credibility,
      support,
      // Both axes go into the persisted audit trail: "0.62" is not reviewable,
      // "credible publisher, weak quote" is — and it names which half to fix.
      reasoning:
        `[credibility ${credibility.toFixed(2)} · support ${support.toFixed(2)}] ` +
        (out.reasoning.trim() || '(model gave no reasoning)'),
      provenance: 'live',
    };
  } catch (err) {
    logger.error?.(
      `[ingestion] reputability scoring failed (${String(err)}); falling back to heuristic.`,
    );
    return scoreSourceOffline(input);
  }
}
