import { pad2 } from './format.js';
import type { CountdownParts } from './format.js';

export interface ClockCompactProps {
  remaining: CountdownParts;
  hasBaseline: boolean;
  overdue: boolean;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * The always-visible top-left widget: the live countdown and a disclosure caret.
 * The target year and full derivation live in the expander.
 */
export function ClockCompact({
  remaining,
  hasBaseline,
  overdue,
  expanded,
  onToggle,
}: ClockCompactProps): JSX.Element {
  return (
    <button
      type="button"
      className="tc-clock-compact"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={
        expanded
          ? 'Collapse the modeled-projection detail'
          : 'Expand the modeled-projection detail'
      }
    >
      <span className="tc-clock-compact-count" aria-live="off">
        {!hasBaseline ? (
          <span className="tc-clock-compact-indet">INDETERMINATE</span>
        ) : overdue ? (
          <span className="tc-clock-compact-passed">MODELED TARGET PASSED</span>
        ) : (
          <>
            <span className="tc-clock-compact-seg">{remaining.years}y</span>{' '}
            <span className="tc-clock-compact-seg">{remaining.days}d</span>{' '}
            <span className="tc-clock-compact-seg">
              {pad2(remaining.hours)}:{pad2(remaining.minutes)}:
              {pad2(remaining.seconds)}
            </span>
          </>
        )}
      </span>
      <span className="tc-clock-caret" aria-hidden="true">
        {expanded ? '▾' : '▸'}
      </span>
    </button>
  );
}
