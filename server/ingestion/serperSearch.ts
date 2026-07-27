/**
 * Serper — Google results, as a search provider.
 *
 * Same `SearchHit[]` contract as `braveSearch.ts`, so the two are
 * interchangeable behind `search.ts`. Serper proxies Google's SERP, which
 * matters more here than the price does: this project queries for published
 * thresholds, projection curves and named research programmes, and Google
 * indexes journal and agency pages that a smaller index misses. A retrieval
 * miss reads downstream as "the sources do not say" — a wrong finding rather
 * than a visible failure — so result quality is a correctness property, not a
 * preference.
 *
 *   POST https://google.serper.dev/search
 *   headers: { X-API-KEY, Content-Type: application/json }
 *   body:    { q, num }
 *
 * Search only. Pages are fetched and converted by `extract.ts`.
 */
import type { SearchHit } from './searchTypes.js';

export const SERPER_SEARCH_URL = 'https://google.serper.dev/search';

export const SERPER_CREDENTIAL_ENV_VAR = 'SERPER_API_KEY';

export interface SerperSearchOptions {
  maxResults?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  apiKey?: string;
}

export function hasSerperCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[SERPER_CREDENTIAL_ENV_VAR]?.trim());
}

/**
 * Normalise a Serper response body into hits. Pure, so the parsing contract is
 * testable without a network call.
 *
 * Reads `organic` only. Serper also returns `answerBox` and `knowledgePanel`,
 * which are Google's own summaries rather than a source — quoting one would
 * attribute Google's paraphrase to the site it was drawn from, which is exactly
 * the provenance failure the citation rules exist to prevent.
 */
export function normalizeSerperResults(body: unknown, maxResults = 5): SearchHit[] {
  if (typeof body !== 'object' || body === null) return [];
  const organic = (body as { organic?: unknown }).organic;
  if (!Array.isArray(organic)) return [];

  const out: SearchHit[] = [];
  for (const raw of organic) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as { link?: unknown; title?: unknown; snippet?: unknown };
    const url = typeof r.link === 'string' ? r.link.trim() : '';
    // A hit with no URL cannot be fetched or cited, so it is not a hit.
    if (url.length === 0) continue;
    out.push({
      url,
      title: typeof r.title === 'string' ? r.title.trim() : '',
      description: typeof r.snippet === 'string' ? r.snippet.trim() : '',
    });
    if (out.length >= maxResults) break;
  }
  return out;
}

/**
 * Run one Serper search.
 *
 * Throws on transport failure and on a non-OK status — every call site already
 * treats a throw as "no sources for this target" rather than aborting a run.
 *
 * No client-side throttle, unlike Brave: Serper's limits are per-plan
 * concurrency rather than a hard one-per-second, and retrieval here is
 * sequential per target anyway.
 */
export async function serperSearch(
  query: string,
  opts: SerperSearchOptions = {},
): Promise<SearchHit[]> {
  const apiKey = (opts.apiKey ?? process.env[SERPER_CREDENTIAL_ENV_VAR] ?? '').trim();
  if (apiKey === '') {
    throw new Error(
      `${SERPER_CREDENTIAL_ENV_VAR} is not set — refusing to search. ` +
        'Callers must gate on hasRetrievalCredentials().',
    );
  }

  const maxResults = Math.min(Math.max(opts.maxResults ?? 5, 1), 100);
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await doFetch(opts.endpoint ?? SERPER_SEARCH_URL, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: maxResults }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Serper search failed: ${res.status} ${detail.slice(0, 200)}`);
    }
    return normalizeSerperResults(await res.json(), maxResults);
  } finally {
    clearTimeout(timer);
  }
}
