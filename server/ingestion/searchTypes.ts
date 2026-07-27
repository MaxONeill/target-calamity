/**
 * The shape every search provider returns.
 *
 * Its own module so `braveSearch.ts` and `serperSearch.ts` can share it without
 * either importing the other — and so adding a third provider means adding one
 * file rather than editing two.
 */

/** One search hit, before any page has been fetched. */
export interface SearchHit {
  url: string;
  title: string;
  /**
   * The engine's snippet. Display and ranking context ONLY — never a quote
   * source. It is truncated, it is sometimes the engine's own paraphrase, and a
   * model asked for a verbatim sentence would happily take one from here. Every
   * quote in this system has to come from text actually fetched from the page.
   */
  description: string;
}

/** What a provider must implement to be usable by `retrieval.ts`. */
export interface SearchOptions {
  /**
   * Force a provider, overriding env selection. Needed wherever a key is passed
   * explicitly (tests, and any caller with an injected env): a bare apiKey does
   * not say WHICH engine it belongs to.
   */
  provider?: 'serper' | 'brave';
  maxResults?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  apiKey?: string;
}
