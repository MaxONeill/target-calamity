import type { ClockConfidence, ClockModel } from '../../lib/clock/clockModel.js';
import type { Requirement } from '../../../shared/types.js';
import { formatYear } from './format.js';
import { WhyPanel } from './WhyPanel.js';

const CONFIDENCE_LABEL: Record<ClockConfidence, string> = {
  indeterminate: 'INDETERMINATE',
  low: 'LOW',
  moderate: 'MODERATE',
  substantial: 'SUBSTANTIAL',
};

function Metric({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string | number;
  valueClassName?: string;
}): JSX.Element {
  const className = valueClassName
    ? `tc-clock-metric-value ${valueClassName}`
    : 'tc-clock-metric-value';
  return (
    <div className="tc-clock-metric">
      <dt>{label}</dt>
      <dd className={className}>{value}</dd>
    </div>
  );
}

function polaritySign(netPolarity: number): 'calamity' | 'humanity' | 'balanced' {
  if (netPolarity < 0) return 'calamity';
  if (netPolarity > 0) return 'humanity';
  return 'balanced';
}

function TargetHeadline({ model }: { model: ClockModel }): JSX.Element {
  const { hasBaseline, targetYear, baselineTargetYear, shiftYears, netPolarity } = model;

  return (
    <div className="tc-clock-primary">
      <div className="tc-clock-horizon">
        <span className="tc-clock-horizon-approx" aria-hidden="true">
          â‰ˆ
        </span>
        <span className="tc-clock-horizon-value">
          {hasBaseline && targetYear !== null ? formatYear(targetYear) : 'â€”'}
        </span>
        <span className="tc-clock-horizon-unit">TARGET</span>
      </div>

      {hasBaseline && model.band ? (
        <div className="tc-clock-range">
          likely {formatYear(model.band.p25)} â€“ {formatYear(model.band.p75)}
        </div>
      ) : null}

      <div className="tc-clock-window">
        {!hasBaseline || baselineTargetYear === null ? (
          'no dated tipping points in view â€” baseline indeterminate'
        ) : (
          <>
            tipping-point anchor {formatYear(baselineTargetYear)}
            {Math.abs(shiftYears) < 0.05 ? (
              ' Â· unshifted (balanced)'
            ) : (
              <>
                {' '}
                Â· shifted{' '}
                <span data-sign={shiftYears < 0 ? 'calamity' : 'humanity'}>
                  {shiftYears < 0 ? 'âˆ’' : '+'}
                  {Math.abs(shiftYears).toFixed(1)} yr
                </span>{' '}
                by net {netPolarity < 0 ? 'Calamity' : 'Humanity'}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function PolarityBar({
  netPolarity,
  hasEvidence,
}: {
  netPolarity: number;
  hasEvidence: boolean;
}): JSX.Element {
  return (
    <div className="tc-clock-metric tc-clock-metric-wide">
      <dt>NET POLARITY</dt>
      <dd>
        <div className="tc-clock-balancebar" aria-hidden="true">
          <div className="tc-clock-balancebar-mid" />
          <div
            className="tc-clock-balancebar-marker"
            style={{ left: `${((netPolarity + 1) / 2) * 100}%` }}
            data-sign={polaritySign(netPolarity)}
          />
        </div>
        <span className="tc-clock-metric-value">
          {hasEvidence ? netPolarity.toFixed(3) : 'n/a'}
        </span>
      </dd>
    </div>
  );
}

export interface ClockDerivationProps {
  model: ClockModel;
  /** Contingency chains for crossed thresholds, flat and keyed by factorId. */
  requirements?: readonly Requirement[];
  soundEnabled: boolean;
  onToggleSound: () => void;
  children?: React.ReactNode;
}

/**
 * The expanded panel: how the target was derived, and from what evidence.
 *
 * This is the derivation, not a second clock â€” the live countdown stays in the
 * compact widget so the two can never disagree.
 */
export function ClockDerivation({
  model,
  requirements = [],
  soundEnabled,
  onToggleSound,
  children,
}: ClockDerivationProps): JSX.Element {
  return (
    <>
      {children}

      <div className="tc-clock-statusline">
        <span className="tc-clock-tag">MODELED PROJECTION</span>
      </div>

      <TargetHeadline model={model} />

      <WhyPanel model={model} requirements={requirements} />

      {!model.hasBaseline ? (
        <div className="tc-clock-indeterminate" role="status">
          AWAITING A DATED TIPPING POINT â€” the countdown anchors to the
          polycrisis's own thresholds; none are in view yet, so no target is shown.
        </div>
      ) : null}

      <dl className="tc-clock-derivation" aria-label="Derivation inputs">
        <PolarityBar netPolarity={model.netPolarity} hasEvidence={model.hasEvidence} />

        <Metric
          label="CALAMITY LOAD"
          value={model.calamityLoad.toFixed(2)}
          valueClassName="tc-clock-calamity"
        />
        <Metric
          label="HUMANITY BUFFER"
          value={model.humanityBuffer.toFixed(2)}
          valueClassName="tc-clock-humanity"
        />
        <Metric label="FACTORS" value={model.contributingCount} />
        <Metric label="TIPPING POINTS" value={model.tippingPointCount} />
        <Metric label="CONFIDENCE" value={CONFIDENCE_LABEL[model.confidence]} />

        {model.pendingCount > 0 ? (
          <Metric
            label="PENDING (EXCLUDED)"
            value={model.pendingCount}
            valueClassName="tc-clock-muted"
          />
        ) : null}
        {model.rejectedCount > 0 ? (
          <Metric
            label="REJECTED (NON-FINITE)"
            value={model.rejectedCount}
            valueClassName="tc-clock-muted"
          />
        ) : null}
      </dl>

      <footer className="tc-clock-footer">
        {/* Kept in step with the model. This previously described a
            significance-weighted baseline shifted by net polarity, which was
            the aggregation the Clock used before it moved to first-crossing â€”
            a footnote describing the wrong model is worse than none. */}
        <p className="tc-clock-note">
          Counting down to the earliest published change that cannot be undone.
          A model, not a measurement â€” see&nbsp;
          <span className="tc-clock-note-glyph">[i]</span>.
        </p>
        <button
          type="button"
          className="tc-clock-sound"
          onClick={onToggleSound}
          aria-pressed={soundEnabled}
        >
          SOUND: {soundEnabled ? 'ON' : 'OFF'}
        </button>
      </footer>
    </>
  );
}


