import type React from 'react';
import { STREAM_LABEL, type StreamStatus } from '../../hooks/useFactorStream.js';
import { Share } from '../Share/index.js';

export interface StatusBarProps {
  streamStatus: StreamStatus;
}

/** Where the source lives. Replaces the old right-hand status readout. */
const REPO_URL = 'https://github.com/MaxONeill/target-calamity';

/**
 * The top header: brand-as-status on the left, source link on the right.
 *
 * The stream state used to be a labelled dot in the right corner, spending a
 * whole corner of the header on a value that reads "LIVE" almost always. It now
 * colours the brand mark itself — the same information, in a glyph that was
 * already there and already drawing the eye.
 *
 * The words are kept, not dropped: `title` for a pointer and a visually-hidden
 * live region for assistive tech. Colour alone is not an accessible signal, and
 * it was never the only signal before this change.
 */
export function StatusBar({ streamStatus }: StatusBarProps): React.JSX.Element {
  const label = `Stream: ${STREAM_LABEL[streamStatus]}`;
  return (
    <header className="tc-topbar">
      <div className="tc-brand">
        <span
          className={`tc-brand-mark tc-brand-mark--${streamStatus}`}
          title={label}
          aria-hidden="true"
        >
          ◎
        </span>
        <span className="tc-visually-hidden" role="status">
          {label}
        </span>
        <span className="tc-brand-name">TARGET: CALAMITY</span>
        <span className="tc-brand-alpha">(Alpha)</span>
      </div>

      {/* Share sits beside SOURCE rather than in a bottom-centre CTA slot. The
          slot cost the globe's visible centre — and had to shift with it when
          the panel opened — for a control nobody needs while reading. Both are
          secondary actions of the same weight, so they share a corner. */}
      <div className="tc-topbar-links">
        <Share />
        <a className="tc-source-link" href={REPO_URL} target="_blank" rel="noreferrer noopener">
          SOURCE
          <span aria-hidden="true"> ↗</span>
        </a>
      </div>
    </header>
  );
}
