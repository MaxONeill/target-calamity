# See-also entries

One file per project. The `See also` panel, bottom-left of the globe, is built
from this folder at build time — **adding a project is adding a file here, and
removing one is deleting it.** Nothing else needs editing.

Files beginning with `_` are ignored, which is why this one is not an entry.

## Format

```markdown
---
name: Target: Humanity
url: https://TargetHumanity.org
---

The description. As many paragraphs as it needs — all of them are shown, and
the panel scrolls if it gets long.
```

- `name` — the title, exactly as it should read. A colon in the value is fine;
  only the first one separates the key.
- `url` — absolute, `http(s)` only. Anything else is refused.
- body — everything after the closing `---`. Hard-wrapped lines reflow; a blank
  line starts a new paragraph.

## Order

Filename, hence the numeric prefixes. Renaming reorders.

## If an entry does not appear

An entry is only shown when it has a name, a url, and a body.

- A file with **none** of them is silent — that is a blank template.
- A file with **some** of them logs a warning in the browser console naming the
  file, because a half-filled entry looks identical to a missing one otherwise.

HTML comments are stripped before the body is read. That is deliberate, but it
is also how the first three descriptions ended up invisible: they were written
_inside_ the `<!-- -->` block the old template used for its instructions. Hence
this file — guidance lives beside the content, never inside it.
