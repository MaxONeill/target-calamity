import { STREAM_LABEL, type StreamStatus } from '../../hooks/useFactorStream.js';

export interface StatusBarProps {
  streamStatus: StreamStatus;
  pinCount: number;
  landVisible: boolean;
  onToggleLand: () => void;
  submitOpen: boolean;
  onOpenSubmit: () => void;
  /** True while the camera is locked onto a selected factor. */
  following: boolean;
}

/** The top header: brand, live-stream state, and the globe/submission controls. */
export function StatusBar({
  streamStatus,
  pinCount,
  landVisible,
  onToggleLand,
  submitOpen,
  onOpenSubmit,
  following,
}: StatusBarProps): JSX.Element {
  return (
    <header className="tc-topbar">
      <div className="tc-brand">
        <span className="tc-brand-mark">◎</span>
        <span className="tc-brand-name">TARGET: CALAMITY</span>
      </div>

      <div className="tc-status">
        <span
          className={`tc-status-dot tc-status-dot--${streamStatus}`}
          aria-hidden="true"
        />
        <span className="tc-status-label">STREAM: {STREAM_LABEL[streamStatus]}</span>

        <span className="tc-status-sep">·</span>
        <span className="tc-status-label">FIELD: {pinCount} PINS</span>

        <span className="tc-status-sep">·</span>
        <button
          type="button"
          className="tc-status-toggle"
          aria-pressed={landVisible}
          onClick={onToggleLand}
          title="Toggle coastline landmass overlay"
        >
          LAND: {landVisible ? 'ON' : 'OFF'}
        </button>

        <span className="tc-status-sep">·</span>
        <button
          type="button"
          className="tc-status-submit"
          aria-expanded={submitOpen}
          aria-controls="tc-slideout"
          onClick={onOpenSubmit}
          title="Propose a factor (one per day, no account needed)"
        >
          Submit
        </button>

        {following ? (
          <>
            <span className="tc-status-sep">·</span>
            <span className="tc-status-label tc-status-label--follow">TRACKING</span>
          </>
        ) : null}
      </div>
    </header>
  );
}
