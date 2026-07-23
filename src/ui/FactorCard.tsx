/**
 * FactorCard — one row of the linear factor feed.
 *
 * DELIBERATELY MINIMAL: the card is a scannable index entry, not a dossier. It
 * renders only the name, the description, a diverging effect indicator (crimson
 * for negative / Calamity, electric blue for positive / Humanity — mirroring the
 * globe ramp, v3.2 §3 / ADR-3) and a significance bar. Everything else — the
 * sources, the verification/reputability audit trail, the tipping point, the
 * Gestalt hand-off — lives in the FactorDetails panel, one click away. Keeping
 * the honesty layer in ONE place (the detail view) stops the feed becoming a wall
 * of quotes nobody reads.
 *
 * Rendered as `role="option"` inside the Sidebar's `role="listbox"`. It is not
 * a native focusable control; the Sidebar owns roving tabindex + keyboard nav
 * and passes the current `tabIndex` in. Selection commits via `onSelect`.
 */
import { forwardRef } from 'react';
import type { Factor } from '../../shared/types.js';

export interface FactorCardProps {
  factor: Factor;
  selected: boolean;
  /** Roving tabindex: 0 for the active card, -1 for the rest (owned by Sidebar). */
  tabIndex: number;
  onSelect: (id: string) => void;
}

/** Polarity bucket for colour/labelling. */
function polarityOf(effect: number): 'calamity' | 'humanity' | 'neutral' {
  if (effect < 0) return 'calamity';
  if (effect > 0) return 'humanity';
  return 'neutral';
}

/** Signed, fixed-precision effect string, e.g. "-0.82" / "+0.44" / "0.00". */
function formatEffect(effect: number): string {
  const sign = effect > 0 ? '+' : effect < 0 ? '−' : '±';
  return `${sign}${Math.abs(effect).toFixed(2)}`;
}

export const FactorCard = forwardRef<HTMLDivElement, FactorCardProps>(
  ({ factor, selected, tabIndex, onSelect }, ref) => {
    const polarity = polarityOf(factor.effect);
    const effectMagnitudePct = Math.min(Math.abs(factor.effect), 1) * 50;
    const significancePct = Math.min(Math.max(factor.significance, 0), 1) * 100;

    return (
      <div
        ref={ref}
        role="option"
        id={`tc-factor-${factor.id}`}
        aria-selected={selected}
        tabIndex={tabIndex}
        className={[
          'tc-card',
          `tc-card--${polarity}`,
          selected ? 'tc-card--selected' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={() => onSelect(factor.id)}
      >
        <div className="tc-card__head">
          <h3 className="tc-card__name">{factor.name}</h3>
        </div>

        {factor.description ? (
          <p className="tc-card__desc">{factor.description}</p>
        ) : null}

        {/* Metrics */}
        <div className="tc-metrics">
          <div className="tc-metric">
            <span className="tc-metric__label">EFF</span>
            <div className="tc-effectbar" aria-hidden="true">
              <span className="tc-effectbar__center" />
              {polarity === 'calamity' ? (
                <span
                  className="tc-effectbar__fill tc-effectbar__fill--neg"
                  style={{ width: `${effectMagnitudePct}%` }}
                />
              ) : polarity === 'humanity' ? (
                <span
                  className="tc-effectbar__fill tc-effectbar__fill--pos"
                  style={{ width: `${effectMagnitudePct}%` }}
                />
              ) : null}
            </div>
            <span
              className={[
                'tc-metric__value',
                polarity === 'calamity' ? 'tc-metric__value--calamity' : '',
                polarity === 'humanity' ? 'tc-metric__value--humanity' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              title={
                polarity === 'calamity'
                  ? 'Calamity — systemic decay vector'
                  : polarity === 'humanity'
                    ? 'Humanity — resilient counter-measure'
                    : 'Neutral'
              }
            >
              {formatEffect(factor.effect)}
            </span>
          </div>

          <div className="tc-metric">
            <span className="tc-metric__label">SIG</span>
            <div className="tc-sigbar" aria-hidden="true">
              <span
                className="tc-sigbar__fill"
                style={{ width: `${significancePct}%` }}
              />
            </div>
            <span className="tc-metric__value">
              {factor.significance.toFixed(2)}
            </span>
          </div>
        </div>
      </div>
    );
  },
);

FactorCard.displayName = 'FactorCard';

export default FactorCard;
