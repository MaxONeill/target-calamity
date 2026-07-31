/**
 * The markdown → project parser.
 *
 * Worth testing because the content files are hand-edited by a person who is
 * not going to read the parser, so every way a file can be wrong has to fail
 * predictably: invisible when empty, warned-about when half-done, and never
 * rendering a broken link.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseProjectSource } from './relatedProjects.js';

const FILLED = `---
name: Target: Humanity
url: https://example.com/humanity
---

A tracker for the other direction.
`;

describe('parseProjectSource', () => {
  it('parses a filled file', () => {
    expect(parseProjectSource('a.md', FILLED)).toEqual({
      name: 'Target: Humanity',
      url: 'https://example.com/humanity',
      paragraphs: ['A tracker for the other direction.'],
    });
  });

  it('keeps a colon INSIDE a value', () => {
    // The case that matters here: every project in this suite is named
    // "Target: Something", so splitting on the last or on every colon truncates
    // the name to "Target" and nobody notices until it is on screen.
    const parsed = parseProjectSource('a.md', FILLED);
    expect(parsed?.name).toBe('Target: Humanity');
  });

  it('returns null for an untouched template, without complaining', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tpl = `---
name:
url:
---

<!-- instructions only -->
`;
    expect(parseProjectSource('tpl.md', tpl)).toBeNull();
    // Empty is the expected state of a template; warning about it would train
    // the reader to ignore the warnings that matter.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns and drops a HALF-filled file', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const half = `---
name: Gestalt
url:
---

Something someone started writing.
`;
    expect(parseProjectSource('half.md', half)).toBeNull();
    // Distinct from empty: somebody began and stopped, and a silent drop would
    // look exactly like the file not existing.
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('rejects a url that is not http(s)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bad = `---
name: Gestalt
url: javascript:alert(1)
---

Description.
`;
    expect(parseProjectSource('bad.md', bad)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('strips HTML comments so template instructions never become the description', () => {
    const withComment = `---
name: Gestalt
url: https://example.com
---

<!-- fill this in, one line, no sales copy -->

The actual description.
`;
    expect(parseProjectSource('c.md', withComment)?.paragraphs).toEqual([
      'The actual description.',
    ]);
  });

  it('collapses a wrapped description onto one line', () => {
    const wrapped = `---
name: Gestalt
url: https://example.com
---

A description that the author
wrapped across two lines.
`;
    expect(parseProjectSource('w.md', wrapped)?.paragraphs).toEqual([
      'A description that the author wrapped across two lines.',
    ]);
  });

  it('keeps EVERY paragraph, not just the first', () => {
    // The regression that motivated this: an earlier version returned only the
    // opening paragraph, and the first real entry runs to three. Publishing a
    // third of what someone wrote, silently, is the failure mode.
    const long = `---
name: Gestalt
url: https://example.com
---

The one-liner.

A second paragraph the author meant to keep.

And a third.
`;
    expect(parseProjectSource('l.md', long)?.paragraphs).toEqual([
      'The one-liner.',
      'A second paragraph the author meant to keep.',
      'And a third.',
    ]);
  });

  it('survives a file with no frontmatter at all', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseProjectSource('n.md', 'just some prose')).toBeNull();
    warn.mockRestore();
  });
});
