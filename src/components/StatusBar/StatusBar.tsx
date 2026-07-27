import type React from 'react';
import { STREAM_LABEL, type StreamStatus } from '../../hooks/useFactorStream.js';

export interface StatusBarProps {
  streamStatus: StreamStatus;
}

/** The top header: brand and live-stream state. */
export function StatusBar({ streamStatus }: StatusBarProps): React.JSX.Element {
  return (
    <header className="tc-topbar">
      <div className="tc-brand">
        <span className="tc-brand-mark">◎</span>
        <span className="tc-brand-name">TARGET: CALAMITY</span>
        <span className="tc-brand-alpha">(Alpha)</span>
      </div>

      <div className="tc-status">
        <span className={`tc-status-dot tc-status-dot--${streamStatus}`} aria-hidden="true" />
        <span className="tc-status-label">STREAM: {STREAM_LABEL[streamStatus]}</span>
      </div>
    </header>
  );
}
