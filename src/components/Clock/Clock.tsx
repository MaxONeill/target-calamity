import { useCallback, useMemo, useRef, useState } from 'react';
import { useSwipe, type SwipeGesture } from '../../hooks/useSwipe.js';
import { deriveClock, type ClockFactorInput } from '../../lib/clock/clockModel.js';
import { ExplainerModal } from '../ExplainerModal/index.js';
import { ClockCompact } from './ClockCompact.js';
import { ClockDerivation } from './ClockDerivation.js';
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
  const model = useMemo(() => deriveClock(factors), [factors]);

  const { remaining, overdue } = useCountdown(model);
  const { soundEnabled, toggleSound, setModalOpen } = useAmbientTick();
  const [expanded, setExpanded] = useState(false);

  const rootRef = useRef<HTMLElement>(null);
  // Swipe down discloses the derivation, swipe up hides it. Gestures that begin
  // inside the expander are left alone: it scrolls vertically, and stealing
  // those would make the derivation unreadable on a phone.
  const onSwipe = useCallback(({ direction, target }: SwipeGesture) => {
    const node = target instanceof Element ? target : null;
    if (node?.closest('.tc-clock-expander')) return;
    if (direction === 'down') setExpanded(true);
    else if (direction === 'up') setExpanded(false);
  }, []);
  useSwipe(rootRef, { onSwipe });

  return (
    <section
      ref={rootRef}
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
