/**
 * Firecrawl retrieval client — the replacement for Anthropic's
 * `web_search` server tool.
 *
 * Firecrawl's `/v2/search` endpoint does BOTH jobs in one request: it runs a web
 * search AND scrapes each hit, returning full-page markdown alongside the URL and
 * title. That is exactly what Phase A needs — ranked, readable source text with
 * its provenance attached — so `websearch.ts` can spend its single LLM turn on
 * extraction rather than on tool round-trips.
 *
 * PROVENANCE (the product's core promise): every result carries the REAL `url`
 * from Firecrawl and a `publisher` derived from that URL's registrable domain (or
 * the result title when the domain is uninformative). The LLM is never asked to
 * remember or re-type a URL — it only picks WHICH retrieved source backs a claim,
 * by index. See `websearch.ts`.
 *
 * Request/response shape verified against docs.firecrawl.dev (API reference,
 * `POST https://api.firecrawl.dev/v2/search`):
 *   body: { query, limit, sources: [{ type: 'web' }], scrapeOptions: { formats: [{ type: 'markdown' }] } }
 *   200:  { success, data: { web: [{ url, title, description, markdown, metadata }] }, creditsUsed }
 * A flat `data: [...]` array (the v1 shape) is also tolerated defensively.
 *
 * COST CONTROL: results per topic and characters of markdown per source are both
 * capped, configurable via `FIRECRAWL_MAX_RESULTS` / `FIRECRAWL_MAX_CONTENT_CHARS`.
 * Scraped markdown is the expensive input token line-item, so the cap is real.
 */

/** Firecrawl search endpoint (v2). */
export const FIRECRAWL_SEARCH_URL = 'https://api.firecrawl.dev/v2/search';

/** Default number of scraped results per topic. Keep small — each costs credits. */
export const DEFAULT_MAX_RESULTS = 5;

/** Default per-source markdown budget in characters (~2.5k tokens). */
export const DEFAULT_MAX_CONTENT_CHARS = 10_000;

/** Default request timeout in milliseconds (search + scrape is not instant). */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** One retrieved, scraped source. `url` is Firecrawl's, never the model's. */
export interface RetrievedDocument {
  url: string;
  title: string;
  /** Publisher derived from the URL's domain (or the title as a fallback). */
  publisher: string;
  /** Search-result snippet, when Firecrawl provided one. */
  description: string;
  /** Scraped page markdown, truncated to the configured budget. May be empty. */
  markdown: string;
}

export interface FirecrawlSearchOptions {
  maxResults?: number;
  maxContentChars?: number;
  timeoutMs?: number;
  /** Restrict search to these domains. */
  includeDomains?: string[];
  /** Exclude these domains (applied when `includeDomains` is not given). */
  excludeDomains?: string[];
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Endpoint override. */
  endpoint?: string;
}

/* -------------------------------------------------------------------------- */
/* Credentials                                                                */
/* -------------------------------------------------------------------------- */

const CREDENTIAL_ENV_VAR = 'FIRECRAWL_API_KEY';

/**
 * True iff a Firecrawl credential is present. Phase A needs BOTH this and the
 * Fireworks credential to run live; missing either, it serves the deterministic
 * offline stub rather than fabricating findings.
 */
export function hasRetrievalCredentials(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env[CREDENTIAL_ENV_VAR]?.trim());
}

/* -------------------------------------------------------------------------- */
/* Pure helpers (unit-tested offline)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Human-readable publisher for a URL: the hostname with a leading `www.` (and
 * other single-label CDN-ish prefixes are NOT stripped — only `www.`) removed.
 * Falls back to a trimmed title, then to `'Unknown publisher'`, so a source is
 * never persisted with an empty attribution.
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

/**
 * Truncate `text` to at most `max` characters on a whitespace boundary where one
 * is available near the cut, appending an explicit marker so a downstream reader
 * (human or model) can tell the source was clipped rather than ended.
 */
export function truncateContent(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastBreak = slice.lastIndexOf('\n');
  const cut = lastBreak > max * 0.6 ? slice.slice(0, lastBreak) : slice;
  return `${cut}\n…[truncated]`;
}

/** Shape of one raw Firecrawl web result (fields we consume). */
interface RawResult {
  url?: unknown;
  title?: unknown;
  description?: unknown;
  markdown?: unknown;
}

/** Pull the `web` result array out of either the v2 or the flat response shape. */
function resultsOf(body: unknown): RawResult[] {
  if (typeof body !== 'object' || body === null) return [];
  const data = (body as { data?: unknown }).data;
  if (Array.isArray(data)) return data as RawResult[];
  if (typeof data === 'object' && data !== null) {
    const web = (data as { web?: unknown }).web;
    if (Array.isArray(web)) return web as RawResult[];
  }
  return [];
}

/**
 * Normalise raw Firecrawl results into {@link RetrievedDocument}s: drop entries
 * with no usable URL, derive the publisher from the URL, and clip the markdown to
 * the content budget. Pure — the network-free half of {@link firecrawlSearch}, so
 * the parsing contract is unit-testable offline.
 */
export function normalizeResults(
  body: unknown,
  maxContentChars: number = DEFAULT_MAX_CONTENT_CHARS,
): RetrievedDocument[] {
  const out: RetrievedDocument[] = [];
  for (const raw of resultsOf(body)) {
    const url = typeof raw.url === 'string' ? raw.url.trim() : '';
    if (url.length === 0) continue;
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    const description =
      typeof raw.description === 'string' ? raw.description.trim() : '';
    const markdown = typeof raw.markdown === 'string' ? raw.markdown : '';
    out.push({
      url,
      title,
      publisher: publisherFromUrl(url, title),
      description,
      markdown: truncateContent(markdown, maxContentChars),
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Live search                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Run one Firecrawl search-and-scrape. Throws on a non-2xx response; callers
 * decide whether to degrade (Phase A logs and returns no candidates rather than
 * inventing any).
 */
export async function firecrawlSearch(
  query: string,
  apiKey: string,
  opts: FirecrawlSearchOptions = {},
): Promise<RetrievedDocument[]> {
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
  const maxContentChars = opts.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  const doFetch = opts.fetchImpl ?? fetch;
  const endpoint = opts.endpoint ?? FIRECRAWL_SEARCH_URL;

  const body: Record<string, unknown> = {
    query,
    limit: maxResults,
    sources: [{ type: 'web' }],
    scrapeOptions: { formats: [{ type: 'markdown' }], onlyMainContent: true },
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  if (opts.includeDomains && opts.includeDomains.length > 0) {
    body.includeDomains = opts.includeDomains;
  } else if (opts.excludeDomains && opts.excludeDomains.length > 0) {
    body.excludeDomains = opts.excludeDomains;
  }

  const res = await doFetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `Firecrawl search failed: ${res.status} ${res.statusText}${
        detail ? ` — ${detail.slice(0, 500)}` : ''
      }`,
    );
  }

  return normalizeResults(await res.json(), maxContentChars).slice(0, maxResults);
}
