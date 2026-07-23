/**
 * Offline tests for the Firecrawl retrieval client (ADR-44).
 *
 * No network is touched: `firecrawlSearch` is exercised through an injected
 * `fetchImpl`, and the parsing/derivation helpers are pure. What these lock down
 * is the PROVENANCE contract — the real URL and a derived publisher survive
 * normalisation — plus the cost caps.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_MAX_CONTENT_CHARS,
  firecrawlSearch,
  hasRetrievalCredentials,
  normalizeResults,
  publisherFromUrl,
  truncateContent,
} from './firecrawlClient.js';

afterEach(() => vi.unstubAllEnvs());

describe('publisherFromUrl', () => {
  it('derives the registrable host and strips a leading www.', () => {
    expect(publisherFromUrl('https://www.nature.com/articles/x')).toBe('nature.com');
    expect(publisherFromUrl('https://nsidc.org/a/b')).toBe('nsidc.org');
    expect(publisherFromUrl('https://SPECTRUM.IEEE.ORG/x')).toBe('spectrum.ieee.org');
  });

  it('falls back to the title, then to a placeholder, for an unparseable URL', () => {
    expect(publisherFromUrl('not a url', 'Some Outlet')).toBe('Some Outlet');
    expect(publisherFromUrl('not a url')).toBe('Unknown publisher');
  });
});

describe('truncateContent', () => {
  it('leaves short content untouched', () => {
    expect(truncateContent('hello', 100)).toBe('hello');
  });

  it('clips long content and marks it as truncated', () => {
    const out = truncateContent('x'.repeat(500), 100);
    expect(out.length).toBeLessThan(500);
    expect(out.endsWith('…[truncated]')).toBe(true);
  });

  it('prefers a late newline boundary when one exists', () => {
    const text = `${'a'.repeat(80)}\n${'b'.repeat(80)}`;
    expect(truncateContent(text, 100)).toBe(`${'a'.repeat(80)}\n…[truncated]`);
  });

  it('returns empty for a non-positive budget', () => {
    expect(truncateContent('anything', 0)).toBe('');
  });
});

describe('normalizeResults', () => {
  const body = {
    success: true,
    data: {
      web: [
        {
          url: 'https://www.nsidc.org/news/item',
          title: 'Arctic sea ice minimum',
          description: 'A summary.',
          markdown: '# Report\nfull text',
        },
        { url: '   ', title: 'no url', markdown: 'ignored' },
        { url: 'https://example.gov/a', title: 'Gov page' },
      ],
    },
  };

  it('keeps the real URL and derives a publisher', () => {
    const docs = normalizeResults(body);
    expect(docs).toHaveLength(2);
    expect(docs[0]!.url).toBe('https://www.nsidc.org/news/item');
    expect(docs[0]!.publisher).toBe('nsidc.org');
    expect(docs[0]!.markdown).toBe('# Report\nfull text');
    expect(docs[1]!.publisher).toBe('example.gov');
  });

  it('drops results with no usable URL rather than inventing one', () => {
    expect(normalizeResults(body).some((d) => d.url.trim() === '')).toBe(false);
  });

  it('applies the per-source content budget', () => {
    const big = {
      data: { web: [{ url: 'https://a.test/x', markdown: 'y'.repeat(5_000) }] },
    };
    expect(normalizeResults(big, 100)[0]!.markdown.length).toBeLessThan(200);
    expect(normalizeResults(big)[0]!.markdown.length).toBeLessThanOrEqual(
      DEFAULT_MAX_CONTENT_CHARS + 20,
    );
  });

  it('tolerates the flat data-array shape and junk input', () => {
    expect(normalizeResults({ data: [{ url: 'https://a.test/x' }] })).toHaveLength(1);
    expect(normalizeResults(null)).toEqual([]);
    expect(normalizeResults({})).toEqual([]);
    expect(normalizeResults({ data: { web: 'nope' } })).toEqual([]);
  });
});

describe('hasRetrievalCredentials', () => {
  it('is true only for a non-blank FIRECRAWL_API_KEY', () => {
    expect(hasRetrievalCredentials({ FIRECRAWL_API_KEY: 'fc-x' })).toBe(true);
    expect(hasRetrievalCredentials({ FIRECRAWL_API_KEY: '  ' })).toBe(false);
    expect(hasRetrievalCredentials({})).toBe(false);
  });
});

describe('firecrawlSearch — request/response contract (injected fetch)', () => {
  function fakeFetch(payload: unknown, ok = true): typeof fetch {
    return (async () => ({
      ok,
      status: ok ? 200 : 402,
      statusText: ok ? 'OK' : 'Payment Required',
      json: async () => payload,
      text: async () => 'nope',
    })) as unknown as typeof fetch;
  }

  it('sends the documented body and returns normalised docs', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const spyFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          data: { web: [{ url: 'https://noaa.gov/x', title: 'T', markdown: 'M' }] },
        }),
      };
    }) as unknown as typeof fetch;

    const docs = await firecrawlSearch('arctic ice', 'fc-key', {
      fetchImpl: spyFetch,
      maxResults: 3,
    });

    expect(docs).toEqual([
      {
        url: 'https://noaa.gov/x',
        title: 'T',
        publisher: 'noaa.gov',
        description: '',
        markdown: 'M',
      },
    ]);

    const sent = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(sent.query).toBe('arctic ice');
    expect(sent.limit).toBe(3);
    expect(sent.sources).toEqual([{ type: 'web' }]);
    expect(sent.scrapeOptions).toMatchObject({ formats: [{ type: 'markdown' }] });
    expect(
      (calls[0]!.init.headers as Record<string, string>).authorization,
    ).toBe('Bearer fc-key');
  });

  it('caps the returned document count', async () => {
    const many = {
      data: {
        web: Array.from({ length: 10 }, (_, i) => ({ url: `https://a.test/${i}` })),
      },
    };
    const docs = await firecrawlSearch('q', 'k', {
      fetchImpl: fakeFetch(many),
      maxResults: 2,
    });
    expect(docs).toHaveLength(2);
  });

  it('throws on a non-2xx response rather than returning nothing silently', async () => {
    await expect(
      firecrawlSearch('q', 'k', { fetchImpl: fakeFetch({}, false) }),
    ).rejects.toThrow(/Firecrawl search failed: 402/);
  });
});
