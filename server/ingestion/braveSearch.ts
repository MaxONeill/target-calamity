/**
 * Brave Web Search — the SEARCH half of retrieval.
 *
 * Replaces Firecrawl, which bundled search and page-scraping into one billed
 * call. That bundling is where the cost was: every query paid to scrape five
 * pages whether or not the extraction was any good. Brave charges for the query
 * and returns URLs; fetching the pages is ours to do (see `extract.ts`).
 *
 * Brave returns a `description` per result — a keyword-highlighted snippet, not
 * page text. It is kept as the SNIPPET and never used as page content: it is
 * truncated, it contains `<strong>` highlight markup, and a model asked for a
 * verbatim quote would happily quote from it. Every quote in this system has to
 * come from text actually fetched from the source.
 *
 *   GET https://api.search.brave.com/res/v1/web/search?q=…&count=…
 *   headers: { X-Subscription-Token, Accept: application/json }
 *
 * This module is search only and does no fetching, which keeps the parsing
 * contract unit-testable offline.
 */

import type { SearchHit } from './searchTypes.js';

/** Brave's web-search endpoint. */
export const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

/** The credential this module reads. */
export const BRAVE_CREDENTIAL_ENV_VAR = 'BRAVE_API_KEY';

/**
 * Brave's free tier is rate-limited to roughly one query per second, and it
 * answers a burst with 429 rather than queueing. Retrieval here is sequential
 * per target anyway, so a small fixed spacing costs almost nothing and removes
 * a whole class of intermittent failure.
 */
export const BRAVE_MIN_REQUEST_SPACING_MS = 1_100;

/** Hard ceiling Brave enforces on `count`. */
const BRAVE_MAX_COUNT = 20;

export interface BraveSearchOptions {
  maxResults?: number;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  endpoint?: string;
  apiKey?: string;
}

export function hasBraveCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[BRAVE_CREDENTIAL_ENV_VAR]?.trim());
}

/** Strip the `<strong>` highlight markup Brave wraps matched terms in. */
function stripHighlights(text: string): string {
  return text.replace(/<\/?strong>/gi, '').trim();
}

/**
 * Normalise a Brave response body into hits. Pure, so the parsing contract is
 * testable without a network call.
 *
 * Tolerant of shape: results live at `web.results`, and a body missing that key
 * (an error envelope, a rate-limit page) yields an empty list rather than
 * throwing — the callers all treat "no sources" as a real, expected outcome.
 */
export function normalizeBraveResults(body: unknown, maxResults = 5): SearchHit[] {
  if (typeof body !== 'object' || body === null) return [];
  const web = (body as { web?: unknown }).web;
  if (typeof web !== 'object' || web === null) return [];
  const results = (web as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];

  const out: SearchHit[] = [];
  for (const raw of results) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as { url?: unknown; title?: unknown; description?: unknown };
    const url = typeof r.url === 'string' ? r.url.trim() : '';
    // A hit with no URL cannot be fetched or cited, so it is not a hit.
    if (url.length === 0) continue;
    out.push({
      url,
      title: typeof r.title === 'string' ? stripHighlights(r.title) : '',
      description: typeof r.description === 'string' ? stripHighlights(r.description) : '',
    });
    if (out.length >= maxResults) break;
  }
  return out;
}

/** Timestamp of the last request, for the spacing guard. */
let lastRequestAt = 0;

/**
 * Serialises the spacing guard. Read-then-write on a shared timestamp is a real
 * race under concurrency: two searches starting together both read the same
 * `lastRequestAt`, both compute no wait, and both fire — which is precisely the
 * burst Brave answers with a 429. Chaining makes each waiter observe the
 * previous one's write.
 */
let throttleChain: Promise<void> = Promise.resolve();

/** Space requests out to respect Brave's per-second limit. */
function throttle(): Promise<void> {
  const next = throttleChain.then(async () => {
    const wait = lastRequestAt + BRAVE_MIN_REQUEST_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    // require-atomic-updates flags the read-await-write on `lastRequestAt`, and
    // it is right about the shape — that race is exactly why this callback runs
    // inside the chain above. Only one of these bodies is in flight at a time,
    // so each observes the previous one's write. The rule cannot see that.
    // eslint-disable-next-line require-atomic-updates
    lastRequestAt = Date.now();
  });
  // The chain must survive a rejection, or one failure stalls every later
  // search behind a permanently-rejected promise.
  throttleChain = next.catch(() => undefined);
  return next;
}

/**
 * Run one Brave web search.
 *
 * Throws on transport failure and on a non-OK status, matching the previous
 * client's contract — every call site already wraps retrieval in a try/catch and
 * treats a failure as "no sources for this target" rather than aborting a run.
 */
export async function braveSearch(
  query: string,
  opts: BraveSearchOptions = {},
): Promise<SearchHit[]> {
  const apiKey = (opts.apiKey ?? process.env[BRAVE_CREDENTIAL_ENV_VAR] ?? '').trim();
  if (apiKey === '') {
    throw new Error(
      `${BRAVE_CREDENTIAL_ENV_VAR} is not set — refusing to search. ` +
        'Callers must gate on hasRetrievalCredentials().',
    );
  }

  const maxResults = Math.min(Math.max(opts.maxResults ?? 5, 1), BRAVE_MAX_COUNT);
  const doFetch = opts.fetchImpl ?? fetch;
  const endpoint = opts.endpoint ?? BRAVE_SEARCH_URL;
  const url = `${endpoint}?q=${encodeURIComponent(query)}&count=${maxResults}`;

  // The spacing exists for Brave's per-second limit, so it applies only to the
  // real API. An injected fetch is a test double with no rate limit, and making
  // the suite sleep a second per search would buy nothing but a slow suite.
  if (opts.fetchImpl === undefined) await throttle();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await doFetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Brave search failed: ${res.status} ${detail.slice(0, 200)}`);
    }
    return normalizeBraveResults(await res.json(), maxResults);
  } finally {
    clearTimeout(timer);
  }
}
