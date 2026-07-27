/**
 * Fetch a page and pull its readable text out — the SCRAPE half of retrieval,
 * previously bought from Firecrawl per result.
 *
 * Readability (Firefox's reader mode) does the extraction, over linkedom rather
 * than jsdom: it parses the same HTML an order of magnitude faster and without
 * pulling a browser's worth of DOM emulation into an ingestion script.
 *
 * MARKDOWN, not plain text, and TABLES are the reason. This project's most
 * valuable extractions are numeric series — a projection's year/value pairs, a
 * threshold's quantity — and those live in HTML tables far more often than in
 * prose. `textContent` flattens a table into a run of loose numbers with no
 * indication of which column they came from, which is worse than useless: it
 * invites a confident misreading of a row as a series. Markdown keeps the grid.
 * Headings and lists survive too, which helps the model cite the right section.
 *
 * The cost is real and worth stating: markdown conversion inserts characters the
 * page did not have — `**` around emphasis, `[text](url)` for links — so a
 * VERBATIM quote lifted from converted markdown may not be a byte-for-byte match
 * for the rendered page. Prose is mostly untouched (the markers appear only
 * where the source had inline formatting), and `verbatim` was already the
 * model's unchecked self-report rather than a machine-verified property. But it
 * is a known gap, and it is documented rather than papered over.
 *
 * Failure is EXPECTED and returns null rather than throwing. Paywalls, bot
 * blocks, PDFs and JS-only pages are a normal fraction of any result set; a
 * target whose sources all fail simply has no sources, which every caller
 * already handles as a real outcome.
 */
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { NodeHtmlMarkdown } from 'node-html-markdown';

/** Default per-source text budget in characters (~2.5k tokens). */
export const DEFAULT_MAX_CONTENT_CHARS = 10_000;

/** Pages slower than this are not worth a run's wall-clock. */
export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

/**
 * Refuse a body larger than this before parsing it. A 50 MB HTML page is a
 * malformed or hostile response, and parsing it would stall the run.
 */
const MAX_BODY_BYTES = 5_000_000;

/**
 * Below this, extraction did not really succeed — a cookie wall, a bot
 * challenge, or a nav-only shell. Passing that to the model invites it to answer
 * from prior knowledge while appearing to cite a source, so it is treated as a
 * failed fetch instead.
 */
const MIN_USEFUL_CHARS = 400;

/**
 * A real browser UA. Not evasion: many publishers return a bare challenge page
 * to an unrecognised agent, and this is a research crawler reading pages a
 * person could read. Requests stay low-volume and sequential, and robots-
 * disallowed paths are skipped by the caller's `robots.ts` check where one runs.
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Content types worth parsing. Anything else (PDF, image, JSON) is skipped. */
function isHtml(contentType: string | null): boolean {
  if (contentType === null) return true; // absent header: try it
  return /text\/html|application\/xhtml/i.test(contentType);
}

/**
 * Collapse the whitespace Readability leaves behind. Its `textContent` keeps the
 * source's indentation, which can be a third of the character budget on a
 * deeply-nested page — budget spent on layout rather than on evidence.
 */
export function tidyText(raw: string): string {
  return (
    raw
      .replace(/\r\n?/g, '\n')
      // Non-breaking (U+00A0) and zero-width (U+200B) spaces are written as
      // ESCAPES, never as the literal characters. An invisible glyph inside a
      // character class is unreviewable, and a stray one is indistinguishable
      // from a typo — the linter caught exactly that in this function. HTML is
      // full of both, and an NBSP left in place breaks a verbatim quote against
      // the text a reader would copy off the page.
      .replace(/[ \t\u00a0\u200b]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * Truncate to at most `max` characters on a line boundary where one is near the
 * cut, with an explicit marker so a reader (human or model) can tell the source
 * was clipped rather than ended.
 */
export function truncateContent(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastBreak = slice.lastIndexOf('\n');
  const cut = lastBreak > max * 0.6 ? slice.slice(0, lastBreak) : slice;
  return `${cut}\n…[truncated]`;
}

/** Share of the budget reserved for tables when the page has them. */
const TABLE_BUDGET_SHARE = 0.6;

/** A run of consecutive markdown table lines. */
interface TableBlock {
  start: number;
  lines: string[];
  chars: number;
}

/** Group consecutive pipe-leading lines into blocks. */
function tableBlocks(lines: readonly string[]): TableBlock[] {
  const blocks: TableBlock[] = [];
  let current: TableBlock | null = null;
  for (const [i, line] of lines.entries()) {
    if (line.trimStart().startsWith('|')) {
      if (current === null) current = { start: i, lines: [], chars: 0 };
      current.lines.push(line);
      current.chars += line.length + 1;
    } else if (current !== null) {
      blocks.push(current);
      current = null;
    }
  }
  if (current !== null) blocks.push(current);
  return blocks;
}

/**
 * Truncate to `max` characters while KEEPING the tables.
 *
 * Plain head-truncation is wrong for this project's most valuable pages. On a
 * Wikipedia emissions page the data table begins 195,000 characters in; a 10,000
 * character budget cuts it off entirely, and the model is handed a lead section
 * and navigation while the numbers the page exists to publish never arrive. The
 * result reads as "the sources do not say" — a wrong finding, not a visible
 * failure.
 *
 * So when a page has tables, most of the budget goes to them and the rest to the
 * opening prose, which is where the units, baseline and scenario are usually
 * stated. Both elisions are marked, because a reader (human or model) must be
 * able to tell that material was dropped rather than absent.
 *
 * Pages with no tables fall through to ordinary truncation.
 */
export function truncatePreservingTables(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;

  const lines = text.split('\n');
  const blocks = tableBlocks(lines);
  // A stray row or two is a notice box, not data — not worth distorting the
  // extract to keep.
  const dataBlocks = blocks.filter((b) => b.lines.length >= 3);
  if (dataBlocks.length === 0) return truncateContent(text, max);

  // Largest first: on a page with several tables the biggest is the series.
  const ranked = [...dataBlocks].sort((a, b) => b.chars - a.chars);
  const tableBudget = Math.floor(max * TABLE_BUDGET_SHARE);
  const kept: TableBlock[] = [];
  let used = 0;
  for (const block of ranked) {
    if (used + block.chars > tableBudget) continue;
    kept.push(block);
    used += block.chars;
  }
  // Nothing fits whole — keep the head of the largest rather than no table at
  // all, since even a partial series is readable and its header carries units.
  if (kept.length === 0 && ranked[0]) {
    const head = ranked[0].lines.join('\n').slice(0, tableBudget);
    kept.push({
      start: ranked[0].start,
      lines: [`${head}\n…[table truncated]`],
      chars: head.length,
    });
    used = head.length;
  }

  // Restore document order so the tables read as they appeared on the page.
  kept.sort((a, b) => a.start - b.start);

  const SEPARATOR = '\n\n…[non-table content omitted]\n\n';
  const TAIL = '\n…[truncated]';
  const tableParts = kept.map((b) => b.lines.join('\n'));

  // Budget the markers explicitly. Leaving them out overran `max` by the width
  // of the separators — small, but `max` is a promise the caller sizes its token
  // spend against, so it has to hold exactly.
  const overhead = SEPARATOR.length * tableParts.length + TAIL.length;
  const proseBudget = max - used - overhead;

  const firstTableAt = Math.min(...kept.map((b) => b.start));
  const prose = lines.slice(0, firstTableAt).join('\n');
  const head =
    proseBudget <= 0
      ? ''
      : prose.length > proseBudget
        ? truncateContent(prose, proseBudget - TAIL.length)
        : prose;

  // Say plainly that this is an extract assembled around the tables, so neither
  // a reader nor the model mistakes the join for contiguous page text.
  const parts = head === '' ? tableParts : [head, ...tableParts];
  const out = `${parts.join(SEPARATOR)}${TAIL}`;
  // Belt and braces: a pathological block could still overshoot, and silently
  // blowing a token budget is worse than a blunt cut.
  return out.length <= max ? out : `${out.slice(0, max - TAIL.length)}${TAIL}`;
}

/**
 * Extract readable text from an HTML string. Pure — no network — so the
 * extraction contract is unit-testable offline.
 *
 * Falls back to the whole document's text when Readability declines (it returns
 * null on pages it cannot identify an article in, which includes many index and
 * data pages that are still perfectly good sources).
 */
/**
 * Shared converter. `keepDataImages: false` drops base64 blobs, which are pure
 * budget with nothing to read in them.
 */
const toMarkdown = new NodeHtmlMarkdown({ keepDataImages: false });

/** Remove the elements whose text is markup, not content. */
function stripNoise(doc: {
  querySelectorAll: (s: string) => Iterable<{ remove: () => void }>;
}): void {
  for (const el of doc.querySelectorAll('script, style, noscript, template, svg')) {
    el.remove();
  }
}

/**
 * Rows across the source's tables. Three or more means a real series rather
 * than a one-row layout table.
 */
function sourceTableRows(doc: { querySelectorAll: (s: string) => ArrayLike<unknown> }): number {
  return doc.querySelectorAll('table tr').length;
}

/** GFM table rows in converted markdown. A row starts with a pipe. */
export function markdownTableRows(md: string): number {
  let n = 0;
  for (const line of md.split('\n')) if (line.trimStart().startsWith('|')) n += 1;
  return n;
}

/**
 * Fraction of the source's table rows an extract must keep to count as having
 * preserved the tables.
 *
 * Presence is NOT enough, which an earlier version of this got wrong: a
 * Wikipedia emissions page has 688 source rows, and Readability's extract kept
 * 2 — both from a "this article needs updating" notice box. A presence check saw
 * a table, declared success, and threw away the data the page exists to publish.
 * Comparing counts catches that; the threshold is loose because conversion
 * legitimately drops layout tables and merges header rows.
 */
const TABLE_RETENTION_MIN = 0.5;

export function extractText(html: string, url: string): { title: string; text: string } {
  const { document } = parseHTML(html);
  stripNoise(document);
  const title = (document.title ?? '').trim();

  try {
    // Readability MUTATES the document it is handed, so the fallback below works
    // from a separate parse rather than the remains of this one.
    const { document: forParse } = parseHTML(html);
    stripNoise(forParse);
    const article = new Readability(forParse as unknown as Document, {
      charThreshold: MIN_USEFUL_CHARS,
    }).parse();

    // Gate on textContent length but CONVERT article.content: the length check
    // wants prose volume, while the value is in the markup (tables, headings).
    if (article?.content && (article.textContent ?? '').trim().length >= MIN_USEFUL_CHARS) {
      const md = tidyText(toMarkdown.translate(article.content));
      // Readability discards tables it judges to be layout, and it misjudges
      // data tables — including the ones a page exists to publish. When the
      // source had real rows and the extract kept few of them, extraction
      // dropped the most valuable thing on the page, so fall through to the
      // whole-body conversion rather than accept the loss.
      const srcRows = sourceTableRows(document);
      const lostTables = srcRows >= 3 && markdownTableRows(md) < srcRows * TABLE_RETENTION_MIN;
      if (md.length >= MIN_USEFUL_CHARS && !lostTables) {
        return { title: (article.title ?? title).trim() || title, text: md };
      }
    }
  } catch {
    // Readability throws on malformed markup often enough to be routine; the
    // whole-document fallback below is the answer, not a crash.
    void url;
  }

  // Readability declines on index and data pages — often exactly the pages
  // carrying a table worth reading — so the fallback converts the whole body
  // rather than giving up on the source.
  const body = document.body?.innerHTML ?? '';
  return { title, text: tidyText(toMarkdown.translate(body)) };
}

export interface FetchPageOptions {
  maxContentChars?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
}

/**
 * Fetch one URL and extract its readable text. Returns null when the page cannot
 * be used — non-OK status, non-HTML body, oversized response, or too little text
 * to be evidence. Never throws.
 */
export async function fetchPage(
  url: string,
  opts: FetchPageOptions = {},
): Promise<FetchedPage | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    if (!isHtml(res.headers.get('content-type'))) return null;

    const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;

    const html = await res.text();
    if (html.length > MAX_BODY_BYTES) return null;

    const { title, text } = extractText(html, url);
    if (text.length < MIN_USEFUL_CHARS) return null;

    return {
      // The RESOLVED url after redirects, so a citation points at where the text
      // actually came from rather than at a shortener or a tracking wrapper.
      url: res.url || url,
      title,
      text: truncatePreservingTables(text, opts.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
