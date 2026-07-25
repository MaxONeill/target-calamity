import { useMemo, useState } from 'react';
import { deriveClock, type ClockFactorInput } from '../../lib/clock/clockModel.js';
import { ExplainerModal } from '../ExplainerModal/index.js';
import { ClockCompact } from './ClockCompact.js';
import { ClockDerivation } from './ClockDerivation.js';
import { currentYearFraction, resolveElasticity } from './horizon.js';
import { useAmbientTick } from './useAmbientTick.js';
import { useCountdown } from './useCountdown.js';
import './Clock.css';

export interface ClockProps {
  /**
   * The factor set to aggregate. `FieldPin`/`GlobalFactor` satisfy this
   * structurally. Pending factors are excluded inside the model.
   */
  factors: readonly ClockFactorInput[];
  className?: string;
}

/**
 * The headline Clock.
 *
 * The countdown is anchored to dated tipping points drawn from the factor set,
 * never to an invented window: with no tipping-point factors the model reports
 * no baseline and the countdown is suppressed rather than counting toward a
 * fabricated instant. The compact widget carries the live time; clicking it
 * discloses how that time was derived.
 */
export function Clock({ factors, className }: ClockProps): JSX.Element {
  const elasticity = useMemo(() => resolveElasticity(), []);
  // The reference year updates only on remount; the runway warp does not need
  // sub-year precision, and the live countdown ticks off the target separately.
  const nowYear = useMemo(() => currentYearFraction(), []);
  const model = useMemo(
    () => deriveClock(factors, { nowYear, elasticity }),
    [factors, nowYear, elasticity],
  );

  const { remaining, overdue } = useCountdown(model);
  const { soundEnabled, toggleSound, setModalOpen } = useAmbientTick();
  const [expanded, setExpanded] = useState(false);

  return (
    <section
      className={className ? `tc-clock ${className}` : 'tc-clock'}
      aria-label="The Clock — modeled projection"
      data-expanded={expanded}
    >
      <div className="tc-clock-window-group">
        <span className="tc-clock-window-label">Course-correction window:</span>
        <ClockCompact
          remaining={remaining}
          hasBaseline={model.hasBaseline}
          overdue={overdue}
          expanded={expanded}
          onToggle={() => setExpanded((open) => !open)}
        />
      </div>

      <div className="tc-clock-expander" role="group" aria-hidden={!expanded}>
        <ClockDerivation
          model={model}
          soundEnabled={soundEnabled}
          onToggleSound={toggleSound}
        >
          <ExplainerModal onOpenChange={setModalOpen} />
        </ClockDerivation>
      </div>
    </section>
  );
}
