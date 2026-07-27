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
      {/* Past the target the clock keeps counting, negative and in red, rather
          than stopping at "MODELED TARGET PASSED". A halted clock reads as a
          terminal state — the run is over, nothing left to do — and the model
          says the opposite: a crossed threshold is a debt that grows, and the
          overshoot is the size of the correction now owed. Watching it climb is
          the honest version of what the number means. */}
      <span
        className="tc-clock-compact-count"
        aria-live="off"
        data-overdue={hasBaseline && overdue}
      >
        {!hasBaseline ? (
          <span className="tc-clock-compact-indet">INDETERMINATE</span>
        ) : (
          <>
            {overdue ? (
              <>
                {/* The sign carries the entire meaning of the number, so it is
                    spelled out for assistive tech rather than left as a glyph:
                    a screen reader announcing "5y 2d" for an overshoot would
                    say the opposite of what the clock shows. */}
                <span className="tc-visually-hidden">Past target by </span>
                {/* Its own element rather than folded into the years segment, so
                    it survives `years === 0` — where the sign is the only thing
                    distinguishing owed time from remaining time. */}
                <span className="tc-clock-compact-sign" aria-hidden="true">
                  −
                </span>
              </>
            ) : null}
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
