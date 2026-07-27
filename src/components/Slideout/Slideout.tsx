import type React from 'react';
import type { ReactNode } from 'react';
import type { PanelMode } from '../../hooks/useSlideoutPanel.js';

const PANEL_LABEL: Record<PanelMode, string> = {
  submit: 'Submit a factor',
  detail: 'Factor detail',
  feed: 'Factor feed',
};

export interface SlideoutProps {
  open: boolean;
  mode: PanelMode;
  onOpen: () => void;
  onCollapse: () => void;
  children: ReactNode;
}

/**
 * The right-anchored panel that slides over the globe, plus the tab that opens
 * it. Closed by default so the globe stays the full-bleed hero.
 */
export function Slideout({
  open,
  mode,
  onOpen,
  onCollapse,
  children,
}: SlideoutProps): React.JSX.Element {
  return (
    <>
      <button
        type="button"
        className="tc-feed-tab"
        aria-expanded={open}
        aria-controls="tc-slideout"
        hidden={open}
        onClick={onOpen}
      >
        <span className="tc-feed-tab__label">FEED</span>
      </button>

      <section
        id="tc-slideout"
        className={`tc-slideout${open ? ' tc-slideout--open' : ''}`}
        aria-label={PANEL_LABEL[mode]}
        aria-hidden={!open}
      >
        <button
          type="button"
          className="tc-slideout__collapse"
          onClick={onCollapse}
          aria-label="Collapse panel"
          tabIndex={open ? 0 : -1}
        >
          ›
        </button>

        <div className="tc-slideout__body">{children}</div>
      </section>
    </>
  );
}
