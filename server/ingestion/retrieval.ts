/**
 * Retrieval: search, then fetch — the single seam the whole ingestion module
 * reaches the web through.
 *
 * Replaces the Firecrawl client, which bought search and page-scraping as one
 * billed call. That bundle was the cost: every query paid to scrape five pages
 * regardless of whether the extraction was usable. This splits the two —
 * `search.ts` picks the query provider (Serper or Brave), `extract.ts` fetches
 * and converts the pages — so only the query is metered and the fetching is ours.
 *
 * The contract is deliberately unchanged from `firecrawlSearch`: callers get
 * {@link RetrievedDocument}[] and treat an empty array as "no sources", which is
 * a real and frequent outcome rather than an error. That kept the swap to the
 * provider modules instead of the eight scripts above them.
 *
 * WHAT IS DIFFERENT, and it matters for tuning: Firecrawl returned N results
 * already scraped. Here, N search hits are fetched and some fail — paywalls, bot
 * blocks, PDFs, JS-only pages. So a request for 5 sources may yield 3. Rather
 * than quietly returning less, this over-fetches (see {@link OVERFETCH}) and
 * takes the first N that produced usable text.
 *
 * Pages are fetched CONCURRENTLY, unlike the search. The fetches go to unrelated
 * hosts and are the slow part of a run — one at a time would make every ingestion
 * cycle several times longer for no benefit to anyone.
 */
import { hasSearchCredentials, search, type SearchHit } from './search.js';
import {
  DEFAULT_MAX_CONTENT_CHARS,
  fetchPage,
  truncateContent,
  type FetchedPage,
} from './extract.js';

export { DEFAULT_MAX_CONTENT_CHARS, truncateContent };

/** Default number of usable sources per query. Keep small — each is a fetch. */
export const DEFAULT_MAX_RESULTS = 5;

/**
 * How many extra search hits to request beyond the number of sources wanted.
 *
 * A meaningful fraction of any result set cannot be read: paywalls, bot walls,
 * PDFs, JS-rendered pages. Asking for exactly N and accepting the survivors
 * would silently thin every retrieval, and thin retrieval reads downstream as
 * "the sources do not say" — a wrong finding rather than a visible failure.
 * Both providers bill per QUERY, not per result, so the extra hits are free.
 */
export const OVERFETCH = 5;

/** Request timeout for the search leg. */
export const DEFAULT_TIMEOUT_MS = 20_000;

/** One retrieved source. `url` is the search engine's, never the model's. */
export interface RetrievedDocument {
  url: string;
  title: string;
  /** Publisher derived from the URL's domain (or the title as a fallback). */
  publisher: string;
  /** Search-result snippet. Context only — never a quote source. */
  description: string;
  /**
   * Readable page text, truncated to the content budget.
   *
   * Genuinely markdown: tables survive as GFM grids, which is what makes a
   * published year/value series readable rather than a run of loose numbers.
   * See `extract.ts` for the verbatim-quote caveat that comes with it.
   */
  markdown: string;
}

export interface RetrievalOptions {
  maxResults?: number;
  maxContentChars?: number;
  timeoutMs?: number;
  /** Restrict search to these domains. */
  includeDomains?: string[];
  /** Exclude these domains (applied when `includeDomains` is not given). */
  excludeDomains?: string[];
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  endpoint?: string;
  apiKey?: string;
  /** Force a search provider, overriding env selection. Mainly for tests. */
  provider?: 'serper' | 'brave';
}

/**
 * True iff a retrieval credential is present. Phase A needs BOTH this and the
 * Fireworks credential to run live; missing either, it serves the deterministic
 * offline stub rather than fabricating findings.
 */
export function hasRetrievalCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasSearchCredentials(env);
}

/**
 * Human-readable publisher for a URL: the hostname with a leading `www.`
 * removed. Falls back to a trimmed title, then to `'Unknown publisher'`, so a
 * source is never persisted with an empty attribution.
 */
export function publisherFromUrl(url: string, title = ''): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (host.length > 0) return host;
  } catch {
    /* fall through to the title */
  }
  return title.trim() || 'Unknown publisher';
}

/** Hostname for domain filtering, or null when the URL will not parse. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Apply include/exclude domain filters.
 *
 * Done HERE rather than as a search-operator in the query string. `site:` works
 * for one domain but a multi-domain OR degrades the result set badly on every
 * engine. Filtering after the fact costs nothing (search is billed per query) and
 * behaves identically for one domain or ten, on whichever provider is active.
 */
export function filterByDomain(
  hits: readonly SearchHit[],
  opts: Pick<RetrievalOptions, 'includeDomains' | 'excludeDomains'>,
): SearchHit[] {
  const include = opts.includeDomains?.filter((d) => d.trim() !== '') ?? [];
  if (include.length > 0) {
    const wanted = include.map((d) => d.toLowerCase().replace(/^www\./, ''));
    return hits.filter((h) => {
      const host = hostOf(h.url);
      return host !== null && wanted.some((d) => host === d || host.endsWith(`.${d}`));
    });
  }
  const exclude = opts.excludeDomains?.filter((d) => d.trim() !== '') ?? [];
  if (exclude.length === 0) return [...hits];
  const banned = exclude.map((d) => d.toLowerCase().replace(/^www\./, ''));
  return hits.filter((h) => {
    const host = hostOf(h.url);
    return host === null || !banned.some((d) => host === d || host.endsWith(`.${d}`));
  });
}

/** Merge a search hit with its fetched page into the caller-facing shape. */
function toDocument(hit: SearchHit, page: FetchedPage, maxChars: number): RetrievedDocument {
  const url = page.url || hit.url;
  const title = page.title.trim() || hit.title;
  return {
    url,
    title,
    publisher: publisherFromUrl(url, title),
    description: hit.description,
    markdown: truncateContent(page.text, maxChars),
  };
}

/**
 * Search, then fetch and extract the results.
 *
 * Throws only if the SEARCH leg fails (transport error, bad credential, rate
 * limit) — the same contract the previous client had, and every call site
 * already treats a throw as "no sources for this target". Individual page
 * failures are not errors: they are dropped, and if all of them fail the result
 * is an empty array.
 */
export async function retrieveDocuments(
  query: string,
  opts: RetrievalOptions = {},
): Promise<RetrievedDocument[]> {
  const maxResults = Math.max(opts.maxResults ?? DEFAULT_MAX_RESULTS, 1);
  const maxChars = opts.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;

  const hits = await search(query, {
    maxResults: maxResults + OVERFETCH,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.endpoint !== undefined ? { endpoint: opts.endpoint } : {}),
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
  });

  const candidates = filterByDomain(hits, opts).slice(0, maxResults + OVERFETCH);
  if (candidates.length === 0) return [];

  const pages = await Promise.all(
    candidates.map((hit) =>
      fetchPage(hit.url, {
        maxContentChars: maxChars,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      }),
    ),
  );

  const out: RetrievedDocument[] = [];
  for (const [i, page] of pages.entries()) {
    if (page === null) continue;
    const hit = candidates[i];
    if (hit === undefined) continue;
    out.push(toDocument(hit, page, maxChars));
    // Search rank order is preserved: the loop walks candidates in the order
    // Brave returned them, so the best-ranked readable pages are the ones kept.
    if (out.length >= maxResults) break;
  }
  return out;
}
