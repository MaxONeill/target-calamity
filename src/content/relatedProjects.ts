/**
 * Sibling projects, loaded from `src/content/projects/*.md`.
 *
 * ADDING ONE IS ADDING A FILE. Drop a new `.md` in that folder and it appears;
 * delete it and it is gone. No import to update, no array to edit, nothing in
 * this file to touch. `import.meta.glob` resolves the folder at BUILD time, so
 * the files are bundled as ordinary strings — there is no runtime fetch, no
 * directory listing shipped to the client, and a missing file is a build error
 * rather than a blank space at 3am.
 *
 * FILE FORMAT — frontmatter for the fields, body for the description:
 *
 *     ---
 *     name: Target: Humanity
 *     url: https://example.com
 *     ---
 *
 *     One line saying what it is.
 *
 * ORDER follows filename, so a numeric prefix controls it: `01-…md`, `02-…md`.
 *
 * An entry missing a `url` or a description is DROPPED, and the whole section
 * disappears when none survive — same rule the Clock follows with no dated
 * threshold. A template file sitting unfilled is therefore invisible rather
 * than broken, which is what stops a half-written entry reaching production the
 * way the old `REPLACE_ME` Discord link did.
 */

export interface RelatedProject {
  name: string;
  /** One line. What it is, not why it is good. */
  description: string;
  /** Absolute URL. */
  url: string;
}

/** Everything between the leading `---` fences, plus whatever follows them. */
function splitFrontmatter(source: string): { fields: Map<string, string>; body: string } {
  const fields = new Map<string, string>();
  const text = source.replace(/^\uFEFF/, '').trimStart();
  if (!text.startsWith('---')) return { fields, body: text };

  const end = text.indexOf('\n---', 3);
  if (end === -1) return { fields, body: text };

  for (const line of text.slice(3, end).split('\n')) {
    // Split on the FIRST colon only. "name: Target: Humanity" is a real value
    // in this project and a naive split would truncate it at the second colon.
    const at = line.indexOf(':');
    if (at === -1) continue;
    const key = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (key !== '') fields.set(key, value);
  }

  const after = text.slice(end + 4);
  return { fields, body: after };
}

/**
 * First non-empty paragraph, with HTML comments removed so a template can carry
 * its own instructions without them becoming the description.
 */
function firstParagraph(body: string): string {
  const withoutComments = body.replace(/<!--[\s\S]*?-->/g, '');
  const paragraph = withoutComments
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p !== '');
  return (paragraph ?? '').replace(/\s+/g, ' ').trim();
}

/** Exported for test — every way a hand-edited file can be wrong lives here. */
export function parseProjectSource(path: string, source: string): RelatedProject | null {
  const { fields, body } = splitFrontmatter(source);
  const name = fields.get('name') ?? '';
  const url = fields.get('url') ?? '';
  const description = firstParagraph(body);

  // Unfilled template: silent by design, that is the whole point of it.
  if (name === '' && url === '' && description === '') return null;

  if (name === '' || url === '' || description === '') {
    // PARTIALLY filled is different from empty — somebody started and stopped,
    // and a silent drop would look identical to the file not existing.
    console.warn(
      `[content] ${path} is incomplete and will not be shown — needs name, url and a description.`,
    );
    return null;
  }

  if (!/^https?:\/\//i.test(url)) {
    console.warn(`[content] ${path} has a url that is not http(s): ${url}`);
    return null;
  }

  return { name, description, url };
}

const MODULES = import.meta.glob<string>('./projects/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Parsed entries, ordered by filename. */
export const RELATED_PROJECTS: readonly RelatedProject[] = Object.keys(MODULES)
  .sort()
  .map((path) => parseProjectSource(path, MODULES[path] ?? ''))
  .filter((p): p is RelatedProject => p !== null);
