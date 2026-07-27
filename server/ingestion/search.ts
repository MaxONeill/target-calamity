/**
 * Which search provider to use, and the one call that runs it.
 *
 * Exists because the provider has already changed twice — Firecrawl, then
 * Brave, then Serper — and each swap risks touching the eight scripts above it.
 * Behind this seam a provider is one file implementing `SearchHit[]`, and
 * changing it is an env var.
 *
 * SELECTION, in order:
 *   1. `SEARCH_PROVIDER` — explicit, wins outright. Use it when both keys are
 *      present and you mean a particular one.
 *   2. Whichever key IS set, Serper first.
 *
 * Serper leads the fallback because it proxies Google, and this project's
 * queries are for published thresholds, projection curves and named programmes —
 * where a bigger index is a correctness property, not a preference. A retrieval
 * miss reads downstream as "the sources do not say", which is a wrong finding
 * rather than a visible failure.
 */
import { BRAVE_CREDENTIAL_ENV_VAR, braveSearch, hasBraveCredentials } from './braveSearch.js';
import { SERPER_CREDENTIAL_ENV_VAR, serperSearch, hasSerperCredentials } from './serperSearch.js';
import type { SearchHit, SearchOptions } from './searchTypes.js';

export type SearchProvider = 'serper' | 'brave';

/** The provider selection env var. */
export const PROVIDER_ENV_VAR = 'SEARCH_PROVIDER';

/**
 * The provider that will actually be used, or null when no key is configured.
 * Exported so a script can name it in its logs — an operator reading "0 sources"
 * should be able to see which engine returned nothing.
 */
export function activeProvider(env: NodeJS.ProcessEnv = process.env): SearchProvider | null {
  const explicit = env[PROVIDER_ENV_VAR]?.trim().toLowerCase();
  if (explicit === 'serper' || explicit === 'brave') return explicit;
  if (explicit !== undefined && explicit !== '') {
    // A typo here would otherwise fall through to whichever key happens to be
    // set, and silently run the provider the operator did not ask for.
    throw new Error(
      `${PROVIDER_ENV_VAR}="${explicit}" is not a known provider (serper | brave).`,
    );
  }
  if (hasSerperCredentials(env)) return 'serper';
  if (hasBraveCredentials(env)) return 'brave';
  return null;
}

/** True iff some provider is configured and usable. */
export function hasSearchCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  const provider = activeProvider(env);
  if (provider === 'serper') return hasSerperCredentials(env);
  if (provider === 'brave') return hasBraveCredentials(env);
  return false;
}

/**
 * The credential for whichever provider is active, from an injected env.
 *
 * For callers that take `env` as a parameter rather than reading `process.env`:
 * passing a specific provider's key would silently break the moment the active
 * provider is the other one, and it would break as "no sources found" rather
 * than as an error.
 */
export function apiKeyFor(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const provider = activeProvider(env);
  if (provider === 'serper') return env[SERPER_CREDENTIAL_ENV_VAR];
  if (provider === 'brave') return env[BRAVE_CREDENTIAL_ENV_VAR];
  return undefined;
}

/** Run one search against the configured provider. */
export async function search(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
  const provider = opts.provider ?? activeProvider();
  if (provider === null) {
    throw new Error(
      'No search provider configured — set SERPER_API_KEY or BRAVE_API_KEY. ' +
        'Callers must gate on hasRetrievalCredentials().',
    );
  }
  return provider === 'serper' ? serperSearch(query, opts) : braveSearch(query, opts);
}

export type { SearchHit, SearchOptions };
