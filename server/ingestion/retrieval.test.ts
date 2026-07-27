/**
 * Retrieval contract tests — offline, no network.
 *
 * Replaces the deleted firecrawlClient suite. The parsing and filtering halves
 * are pure by construction precisely so this can hold them to account without a
 * credential or a live call.
 */
import { describe, expect, it, vi } from 'vitest';
import { normalizeBraveResults, hasBraveCredentials } from './braveSearch.js';
import { normalizeSerperResults, hasSerperCredentials } from './serperSearch.js';
import { activeProvider } from './search.js';
import {
  extractText,
  markdownTableRows,
  tidyText,
  truncateContent,
  truncatePreservingTables,
} from './extract.js';
import {
  filterByDomain,
  hasRetrievalCredentials,
  publisherFromUrl,
  retrieveDocuments,
} from './retrieval.js';
import { resolveSourceDoc } from './researchCounterEfforts.js';

/** A Brave body with the given results. */
function braveBody(results: unknown[]): unknown {
  return { web: { results } };
}

/** Enough prose to clear the extractor's usefulness floor. */
const LONG = 'The projection shows a sustained decline through 2040. '.repeat(20);

describe('normalizeBraveResults', () => {
  it('pulls url, title and description out of the web results', () => {
    const hits = normalizeBraveResults(
      braveBody([{ url: 'https://nature.com/a', title: 'A study', description: 'Findings.' }]),
    );
    expect(hits).toEqual([
      { url: 'https://nature.com/a', title: 'A study', description: 'Findings.' },
    ]);
  });

  it('strips the <strong> highlight markup Brave wraps matched terms in', () => {
    const hits = normalizeBraveResults(
      braveBody([
        {
          url: 'https://x.com/a',
          title: '<strong>Coral</strong> loss',
          description: 'Most <strong>reefs</strong> decline.',
        },
      ]),
    );
    expect(hits[0]?.title).toBe('Coral loss');
    expect(hits[0]?.description).toBe('Most reefs decline.');
  });

  it('drops results with no usable URL — they cannot be fetched or cited', () => {
    const hits = normalizeBraveResults(
      braveBody([{ title: 'no url' }, { url: '   ' }, { url: 'https://ok.org/a' }]),
    );
    expect(hits.map((h) => h.url)).toEqual(['https://ok.org/a']);
  });

  it('honours maxResults', () => {
    const body = braveBody(Array.from({ length: 10 }, (_, i) => ({ url: `https://x.org/${i}` })));
    expect(normalizeBraveResults(body, 3)).toHaveLength(3);
  });

  it('returns [] for an error envelope or junk rather than throwing', () => {
    // Callers treat "no sources" as a real outcome; a rate-limit body must land
    // there rather than aborting a whole ingestion run.
    expect(normalizeBraveResults({ error: 'rate limited' })).toEqual([]);
    expect(normalizeBraveResults(null)).toEqual([]);
    expect(normalizeBraveResults('nope')).toEqual([]);
    expect(normalizeBraveResults({ web: { results: 'not-an-array' } })).toEqual([]);
  });
});

describe('normalizeSerperResults', () => {
  const serperBody = (organic: unknown[]): unknown => ({ organic });

  it('maps link/title/snippet onto the shared hit shape', () => {
    const hits = normalizeSerperResults(
      serperBody([{ link: 'https://nature.com/a', title: 'A study', snippet: 'Findings.' }]),
    );
    expect(hits).toEqual([
      { url: 'https://nature.com/a', title: 'A study', description: 'Findings.' },
    ]);
  });

  it('ignores answerBox and knowledgeGraph — those are Google, not a source', () => {
    // Quoting Google's own summary would attribute its paraphrase to the site it
    // was drawn from, which is the provenance failure the citation rules exist
    // to prevent.
    const hits = normalizeSerperResults({
      answerBox: { snippet: 'Coral reefs will decline 70-90% at 1.5C.' },
      knowledgeGraph: { description: 'Coral bleaching is…' },
      organic: [{ link: 'https://ipcc.ch/a', title: 'AR6', snippet: 'Real source.' }],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.url).toBe('https://ipcc.ch/a');
  });

  it('drops entries with no link and honours maxResults', () => {
    const body = serperBody([
      { title: 'no link' },
      ...Array.from({ length: 8 }, (_, i) => ({ link: `https://x.org/${i}` })),
    ]);
    expect(normalizeSerperResults(body, 3)).toHaveLength(3);
  });

  it('returns [] for an error envelope rather than throwing', () => {
    expect(normalizeSerperResults({ message: 'Unauthorized' })).toEqual([]);
    expect(normalizeSerperResults(null)).toEqual([]);
  });
});

describe('provider selection', () => {
  const env = (o: Record<string, string>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;

  it('prefers Serper when both keys are set — the bigger index is the default', () => {
    expect(activeProvider(env({ SERPER_API_KEY: 'a', BRAVE_API_KEY: 'b' }))).toBe('serper');
  });

  it('falls back to whichever key is present', () => {
    expect(activeProvider(env({ BRAVE_API_KEY: 'b' }))).toBe('brave');
    expect(activeProvider(env({ SERPER_API_KEY: 'a' }))).toBe('serper');
    expect(activeProvider(env({}))).toBeNull();
  });

  it('SEARCH_PROVIDER wins outright', () => {
    expect(activeProvider(env({ SEARCH_PROVIDER: 'brave', SERPER_API_KEY: 'a' }))).toBe('brave');
  });

  it('throws on an unknown SEARCH_PROVIDER instead of silently falling back', () => {
    // A typo would otherwise run whichever engine happened to have a key, which
    // is the provider the operator did not ask for.
    expect(() => activeProvider(env({ SEARCH_PROVIDER: 'gogle', BRAVE_API_KEY: 'b' }))).toThrow(
      /not a known provider/,
    );
  });

  it('hasSerperCredentials/hasBraveCredentials ignore whitespace-only keys', () => {
    expect(hasSerperCredentials(env({ SERPER_API_KEY: '  ' }))).toBe(false);
    expect(hasBraveCredentials(env({ BRAVE_API_KEY: '  ' }))).toBe(false);
  });
});

describe('extractText', () => {
  it('pulls the article body and drops script and style content', () => {
    const { text } = extractText(
      `<html><head><title>T</title><style>.a{color:red}</style></head>
       <body><script>var secret=1</script><article><p>${LONG}</p></article></body></html>`,
      'https://x.org/a',
    );
    expect(text).toContain('sustained decline through 2040');
    expect(text).not.toContain('var secret');
    expect(text).not.toContain('color:red');
  });

  it('falls back to whole-document text when there is no article to find', () => {
    // Index and data pages are still perfectly good sources; Readability
    // returning null must not mean "no source".
    const { text } = extractText(`<html><body><div>${LONG}</div></body></html>`, 'https://x.org/a');
    expect(text).toContain('sustained decline');
  });

  it('preserves TABLE structure as markdown — the reason this is not plain text', () => {
    // Projections and quantity thresholds are published in tables far more often
    // than in prose. textContent flattens a grid into loose numbers with no
    // column context, which invites reading a row as a series.
    const rows = Array.from(
      { length: 12 },
      (_, i) => `<tr><td>${2020 + i}</td><td>${1.1 + i * 0.1}</td></tr>`,
    ).join('');
    const { text } = extractText(
      `<html><body><article><p>${LONG}</p>
        <table><thead><tr><th>Year</th><th>degC</th></tr></thead>
        <tbody>${rows}</tbody></table></article></body></html>`,
      'https://x.org/a',
    );
    expect(text).toContain('| Year |');
    expect(text).toContain('| 2020 |');
    // Year and value stay on the same line, which is what makes the pair readable.
    expect(text).toMatch(/\|\s*2025\s*\|\s*1\.6/);
  });

  it('converts a table even when Readability declines the page', () => {
    // Data and index pages are exactly the ones carrying the tables worth
    // reading, and they are also the ones Readability most often rejects.
    const rows = Array.from(
      { length: 30 },
      (_, i) => `<tr><td>${2000 + i}</td><td>value ${i} of the published series</td></tr>`,
    ).join('');
    const { text } = extractText(
      `<html><body><table><thead><tr><th>Year</th><th>Note</th></tr></thead>
        <tbody>${rows}</tbody></table></body></html>`,
      'https://x.org/data',
    );
    expect(text).toContain('| Year |');
    expect(text).toContain('| 2001 |');
  });

  it('reads the title', () => {
    const { title } = extractText(
      `<html><head><title>Reef outlook</title></head><body><p>${LONG}</p></body></html>`,
      'https://x.org/a',
    );
    expect(title).toContain('Reef outlook');
  });
});

describe('tidyText', () => {
  it('collapses the layout whitespace that would otherwise eat the budget', () => {
    expect(tidyText('a   b\n\n\n\n   c  ')).toBe('a b\n\nc');
  });
});

describe('truncateContent', () => {
  it('marks a clip so a reader can tell the source was cut, not ended', () => {
    const out = truncateContent('x'.repeat(100), 50);
    expect(out.endsWith('…[truncated]')).toBe(true);
    expect(out.length).toBeLessThan(100);
  });

  it('leaves text within budget untouched', () => {
    expect(truncateContent('short', 50)).toBe('short');
  });
});

describe('truncatePreservingTables', () => {
  /** Prose, then a table far past any sane budget — the Wikipedia shape. */
  function proseThenTable(proseChars: number, rows: number): string {
    const prose = 'Background on the published series. '.repeat(Math.ceil(proseChars / 36));
    const table = [
      '| Year | Value |',
      '| --- | --- |',
      ...Array.from({ length: rows }, (_, i) => `| ${2000 + i} | ${i * 1.5} |`),
    ].join('\n');
    return `${prose}\n\n${table}`;
  }

  it('keeps the table even when it starts far past the budget', () => {
    // The defect this exists for: on a real page the data table began 195,000
    // characters in, so head-truncation handed the model a lead section and
    // navigation while the numbers never arrived.
    const out = truncatePreservingTables(proseThenTable(50_000, 40), 4_000);
    expect(out).toContain('| Year | Value |');
    expect(out).toContain('| 2039 |');
    expect(out.length).toBeLessThanOrEqual(4_000);
  });

  it('marks the join so the extract is not mistaken for contiguous page text', () => {
    const out = truncatePreservingTables(proseThenTable(50_000, 20), 4_000);
    expect(out).toContain('[non-table content omitted]');
  });

  it('keeps some leading prose, where units and baseline are usually stated', () => {
    const out = truncatePreservingTables(proseThenTable(50_000, 20), 4_000);
    expect(out).toContain('Background on the published series');
  });

  it('falls back to plain truncation when the page has no table', () => {
    const out = truncatePreservingTables('word '.repeat(5_000), 1_000);
    expect(out).not.toContain('[non-table content omitted]');
    expect(out.endsWith('…[truncated]')).toBe(true);
  });

  it('ignores a two-row notice box rather than distorting the extract for it', () => {
    const text = `| Notice | x |\n| --- | --- |\n\n${'filler text. '.repeat(2_000)}`;
    const out = truncatePreservingTables(text, 1_000);
    expect(out).not.toContain('[non-table content omitted]');
  });

  it('leaves text within budget untouched', () => {
    expect(truncatePreservingTables('| a |\n| - |\n| 1 |', 5_000)).toBe('| a |\n| - |\n| 1 |');
  });

  it('never exceeds the budget — callers size their token spend against it', () => {
    for (const max of [500, 1_000, 4_000, 9_999]) {
      expect(truncatePreservingTables(proseThenTable(50_000, 200), max).length).toBeLessThanOrEqual(
        max,
      );
    }
  });
});

describe('resolveSourceDoc', () => {
  const doc = (url: string, markdown: string) => ({
    url,
    title: '',
    publisher: new URL(url).hostname,
    description: '',
    markdown,
  });
  const docs = [
    doc('https://a.org/1', 'Nothing relevant on this page at all.'),
    doc('https://b.org/2', 'The Global Fund for Coral Reefs invests in reef resilience.'),
    doc('https://c.org/3', 'Some other unrelated content entirely here.'),
  ];
  const QUOTE = 'The Global Fund for Coral Reefs invests in reef resilience.';

  it('accepts the cited index when that page really contains the quote', () => {
    expect(resolveSourceDoc(docs, 2, QUOTE)).toEqual({ doc: docs[1], how: 'index' });
  });

  it('recovers a 0-based sourceIndex by locating the quote instead of guessing', () => {
    // A live run returned sourceIndex 0 against 1-based blocks. The old code
    // dropped those silently — indistinguishable from "the sources named
    // nobody" — and assuming 0 means 1 would attribute the quote to the wrong
    // publisher, which is the provenance failure the citation rules exist for.
    expect(resolveSourceDoc(docs, 0, QUOTE)).toEqual({ doc: docs[1], how: 'quote' });
  });

  it('resolves an out-of-range index by quote', () => {
    expect(resolveSourceDoc(docs, 99, QUOTE)?.doc.url).toBe('https://b.org/2');
  });

  it('matches through markdown emphasis the converter inserted', () => {
    const withMarkup = [
      doc('https://d.org/1', 'The **Global Fund** for _Coral Reefs_ invests here.'),
    ];
    expect(
      resolveSourceDoc(withMarkup, 0, 'The Global Fund for Coral Reefs invests here.')?.how,
    ).toBe('quote');
  });

  it('refuses to resolve when the quote appears in more than one page', () => {
    // An ambiguous match is no evidence of provenance at all.
    const dupes = [doc('https://a.org/1', QUOTE), doc('https://b.org/2', QUOTE)];
    expect(resolveSourceDoc(dupes, 0, QUOTE)).toBeNull();
  });

  it('returns null when the index is invalid and the quote is nowhere', () => {
    expect(resolveSourceDoc(docs, 0, 'A sentence that appears on none of these pages.')).toBeNull();
  });

  it('keeps the named block when the quote does not match — conversion rewrites text', () => {
    // Markdown conversion can break an otherwise-genuine quote, and refusing
    // every unmatched quote would throw away most of a run.
    expect(resolveSourceDoc(docs, 1, 'wording that does not appear anywhere here')?.doc.url).toBe(
      'https://a.org/1',
    );
  });
});

describe('markdownTableRows', () => {
  it('counts pipe-leading lines and ignores prose', () => {
    expect(markdownTableRows('intro\n| a | b |\n| - | - |\n| 1 | 2 |\noutro')).toBe(3);
    expect(markdownTableRows('no tables here')).toBe(0);
  });
});

describe('publisherFromUrl', () => {
  it('uses the hostname without www.', () => {
    expect(publisherFromUrl('https://www.nature.com/articles/x')).toBe('nature.com');
  });

  it('falls back to the title, then to a placeholder — never empty', () => {
    expect(publisherFromUrl('not a url', 'Some Journal')).toBe('Some Journal');
    expect(publisherFromUrl('not a url')).toBe('Unknown publisher');
  });
});

describe('filterByDomain', () => {
  const hits = [
    { url: 'https://nature.com/a', title: '', description: '' },
    { url: 'https://blog.example.com/b', title: '', description: '' },
    { url: 'https://www.nasa.gov/c', title: '', description: '' },
  ];

  it('includeDomains keeps only those domains, subdomains included', () => {
    expect(filterByDomain(hits, { includeDomains: ['nature.com'] }).map((h) => h.url)).toEqual([
      'https://nature.com/a',
    ]);
    expect(filterByDomain(hits, { includeDomains: ['example.com'] })).toHaveLength(1);
  });

  it('excludeDomains removes them, and www is normalised on both sides', () => {
    const kept = filterByDomain(hits, { excludeDomains: ['nasa.gov'] }).map((h) => h.url);
    expect(kept).not.toContain('https://www.nasa.gov/c');
    expect(kept).toHaveLength(2);
  });

  it('include wins over exclude, matching the documented precedence', () => {
    const kept = filterByDomain(hits, {
      includeDomains: ['nasa.gov'],
      excludeDomains: ['nasa.gov'],
    });
    expect(kept).toHaveLength(1);
  });

  it('is a no-op when neither filter is given', () => {
    expect(filterByDomain(hits, {})).toHaveLength(3);
  });
});

describe('credential gate', () => {
  it('is false without a key, true with one', () => {
    expect(hasRetrievalCredentials({} as NodeJS.ProcessEnv)).toBe(false);
    expect(hasRetrievalCredentials({ BRAVE_API_KEY: '  ' } as NodeJS.ProcessEnv)).toBe(false);
    expect(hasRetrievalCredentials({ BRAVE_API_KEY: 'k' } as NodeJS.ProcessEnv)).toBe(true);
    expect(hasBraveCredentials({ BRAVE_API_KEY: 'k' } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe('retrieveDocuments', () => {
  /** A fetch stub: the search URL returns hits, page URLs return HTML. */
  function stubFetch(pages: Record<string, string | number>) {
    return vi.fn(async (input: string | URL | Request) => {
      // A Request does not stringify to its URL — it gives "[object Request]".
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('api.search.brave.com')) {
        return new Response(
          JSON.stringify(braveBody(Object.keys(pages).map((u) => ({ url: u, title: u })))),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      const body = pages[url];
      if (typeof body === 'number') return new Response('nope', { status: body });
      return new Response(body ?? '', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }) as unknown as typeof fetch;
  }

  const page = (body: string) => `<html><body><article><p>${body}</p></article></body></html>`;

  it('returns documents whose text came from the fetched page, not the snippet', async () => {
    const docs = await retrieveDocuments('coral', {
      apiKey: 'k',
      provider: 'brave',
      maxResults: 2,
      fetchImpl: stubFetch({
        'https://a.org/1': page(LONG),
        'https://b.org/2': page(LONG),
      }),
    });
    expect(docs).toHaveLength(2);
    expect(docs[0]?.markdown).toContain('sustained decline through 2040');
    expect(docs[0]?.publisher).toBe('a.org');
  });

  it('drops pages that fail to fetch and still fills the quota from later hits', async () => {
    // The whole point of over-fetching: a dead result must not thin the set,
    // because thin retrieval reads downstream as "the sources do not say".
    const docs = await retrieveDocuments('coral', {
      apiKey: 'k',
      provider: 'brave',
      maxResults: 2,
      fetchImpl: stubFetch({
        'https://dead.org/1': 404,
        'https://paywall.org/2': 403,
        'https://good.org/3': page(LONG),
        'https://good.org/4': page(LONG),
      }),
    });
    expect(docs.map((d) => d.url)).toEqual(['https://good.org/3', 'https://good.org/4']);
  });

  it('drops a page too thin to be evidence (cookie wall, bot challenge)', async () => {
    const docs = await retrieveDocuments('coral', {
      apiKey: 'k',
      provider: 'brave',
      maxResults: 2,
      fetchImpl: stubFetch({
        'https://wall.org/1': page('Please accept cookies.'),
        'https://good.org/2': page(LONG),
      }),
    });
    expect(docs.map((d) => d.url)).toEqual(['https://good.org/2']);
  });

  it('returns [] when every page fails rather than throwing', async () => {
    const docs = await retrieveDocuments('coral', {
      apiKey: 'k',
      provider: 'brave',
      fetchImpl: stubFetch({ 'https://dead.org/1': 500, 'https://dead.org/2': 500 }),
    });
    expect(docs).toEqual([]);
  });

  it('throws when the SEARCH leg fails — callers catch and treat it as no sources', async () => {
    const failing = vi.fn(
      async () => new Response('quota', { status: 429 }),
    ) as unknown as typeof fetch;
    await expect(
      retrieveDocuments('coral', { apiKey: 'k', provider: 'brave', fetchImpl: failing }),
    ).rejects.toThrow(/429/);
  });

  it('refuses to search without a credential instead of returning nothing', async () => {
    // Silently returning [] here would look exactly like "nothing was found",
    // which is the failure mode this whole module is built to avoid.
    await expect(
      retrieveDocuments('coral', { apiKey: '', provider: 'brave', fetchImpl: stubFetch({}) }),
    ).rejects.toThrow(/BRAVE_API_KEY/);
  });
});
