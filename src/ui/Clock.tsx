/**
 * The Clock — main display.
 *
 * Renders {@link deriveClock} over the current factor set. Design mandates:
 *
 *   1. Anchored to the polycrisis's TIPPING POINTS, not an invented window. The
 *      headline is the modeled target YEAR (a physical baseline of dated
 *      thresholds, shifted by net direction) with a live D:HH:MM:SS countdown to
 *      it. Baseline, shift, and evidence are shown inline so the ticking never
 *      masquerades as certainty.
 *   2. No fabricated precision. With no tipping-point factors the Clock is
 *      `indeterminate` — the countdown is suppressed rather than counting toward
 *      an invented instant.
 *
 * It also owns the ambient tick lifecycle: created lazily on a user gesture, and
 * halted while the explainer modal is open.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  deriveClock,
  targetDeadlineMs,
  DEFAULT_CLOCK_HORIZON,
  type ClockConfidence,
  type ClockFactorInput,
  type ClockHorizonConfig,
} from './clockModel.js';
import { ExplainerModal } from './ExplainerModal.js';
import { createTickEngine, type TickEngine } from '../audio/tick.js';
import './clock.css';

export interface ClockProps {
  /**
   * The factor set the Clock aggregates. `Factor[]` from the shared contract
   * satisfies this structurally. Pending factors are excluded in the model.
   */
  factors: readonly ClockFactorInput[];
  /**
   * How far net direction may shift the tipping-point baseline, in years. An
   * operator-set estimate — defaults to the env-configured value (see
   * {@link resolveHorizon}), never a hardcoded seed data figure.
   */
  horizon?: ClockHorizonConfig;
  /** Optional extra class on the root container. */
  className?: string;
}

const CONFIDENCE_LABEL: Record<ClockConfidence, string> = {
  indeterminate: 'INDETERMINATE',
  low: 'LOW',
  moderate: 'MODERATE',
  substantial: 'SUBSTANTIAL',
};

/**
 * Operator-configurable shift bound, read from the Vite env at build time.
 * `VITE_CLOCK_MAX_SHIFT_YEARS` overrides the default; anything non-numeric falls
 * back to {@link DEFAULT_CLOCK_HORIZON}. The window is never hardcoded here.
 */
function resolveHorizon(): ClockHorizonConfig {
  const raw = import.meta.env?.VITE_CLOCK_MAX_SHIFT_YEARS;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? { maxShiftYears: parsed }
    : DEFAULT_CLOCK_HORIZON;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

interface CountdownParts {
  years: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

/** Seconds in a Julian year (matches MS_PER_YEAR's 365.25-day convention). */
const SECONDS_PER_YEAR = 365.25 * 86_400;

/**
 * Split a remaining duration into years-inclusive parts. Years use the same
 * 365.25-day Julian convention the model's deadline math uses, so the leading
 * `Yy` segment stays consistent with the target-year projection. Remaining days
 * are whatever is left after whole years (0–365).
 */
function splitDuration(ms: number): CountdownParts {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const years = Math.floor(totalSeconds / SECONDS_PER_YEAR);
  let rem = totalSeconds - Math.floor(years * SECONDS_PER_YEAR);
  const days = Math.floor(rem / 86_400);
  rem -= days * 86_400;
  const hours = Math.floor(rem / 3_600);
  rem -= hours * 3_600;
  const minutes = Math.floor(rem / 60);
  const seconds = rem - minutes * 60;
  return { years, days, hours, minutes, seconds };
}

/** Format a decimal year for display: whole years as "2050", fractional as "2048.3". */
function fmtYear(year: number): string {
  return Number.isInteger(year) ? String(year) : year.toFixed(1);
}

export function Clock({ factors, horizon, className }: ClockProps): JSX.Element {
  const activeHorizon = useMemo(
    () => horizon ?? resolveHorizon(),
    [horizon],
  );
  const model = useMemo(
    () => deriveClock(factors, activeHorizon),
    [factors, activeHorizon],
  );

  /* ----------------------------- live countdown ---------------------------- */
  // The target is an absolute instant (null when there is no tipping-point
  // baseline). Capture it when the model changes; count `now` toward it.
  const deadlineMs = useMemo(() => targetDeadlineMs(model), [model.targetYear]);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (deadlineMs === null) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [deadlineMs]);

  const remainingMs = deadlineMs === null ? 0 : deadlineMs - nowMs;
  const overdue = deadlineMs !== null && remainingMs <= 0;
  const remaining = splitDuration(remainingMs);

  /* ------------------------------ ambient tick ----------------------------- */
  const engineRef = useRef<TickEngine | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  /* ------------------------ expand/collapse (self-owned) ------------------- */
  // The Clock owns its own disclosure state (spec: App just renders <Clock/>).
  // Collapsed by default — the compact widget is the top-left anchor; clicking
  // it slides out the full modeled-projection derivation.
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    // Dispose the audio graph on unmount — the page sits open for hours.
    return () => {
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  const toggleSound = useCallback(() => {
    setSoundEnabled((wasEnabled) => {
      const nextEnabled = !wasEnabled;
      if (nextEnabled) {
        // This click is the user gesture the autoplay policy requires.
        const engine = (engineRef.current ??= createTickEngine());
        if (!modalOpen) engine.start();
      } else {
        engineRef.current?.stop();
      }
      return nextEnabled;
    });
  }, [modalOpen]);

  const handleModalOpenChange = useCallback(
    (open: boolean) => {
      setModalOpen(open);
      const engine = engineRef.current;
      if (!engine) return;
      if (open) engine.stop();
      else if (soundEnabled) engine.start();
    },
    [soundEnabled],
  );

  /* -------------------------------- derived -------------------------------- */
  const { hasEvidence, hasBaseline, netPolarity } = model;
  const polarityPercent = ((netPolarity + 1) / 2) * 100;

  const rootClassName = className ? `tc-clock ${className}` : 'tc-clock';

  return (
    <section
      className={rootClassName}
      aria-label="The Clock — modeled projection"
      data-expanded={expanded}
    >
      {/* Compact top-left widget: just the years-inclusive live countdown. The
          target year and full derivation live in the expander, slid out on click. */}
      <button
        type="button"
        className="tc-clock-compact"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={
          expanded
            ? 'Collapse the modeled-projection detail'
            : 'Expand the modeled-projection detail'
        }
      >
        <span className="tc-clock-compact-count" aria-live="off">
          {hasBaseline ? (
            overdue ? (
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
            )
          ) : (
            <span className="tc-clock-compact-indet">INDETERMINATE</span>
          )}
        </span>
        <span className="tc-clock-caret" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {/* Expanded derivation — the full modeled projection, slid out on click. */}
      <div className="tc-clock-expander" role="group" aria-hidden={!expanded}>
      <ExplainerModal onOpenChange={handleModalOpenChange} />

      <div className="tc-clock-statusline">
        <span className="tc-clock-tag">MODELED PROJECTION</span>
        <span className="tc-clock-sep">·</span>
        <span className="tc-clock-tag tc-clock-tag-muted">ESTIMATE, NOT A MEASUREMENT</span>
      </div>

      <div className="tc-clock-primary">
        <div className="tc-clock-horizon">
          <span className="tc-clock-horizon-approx" aria-hidden="true">
            ≈
          </span>
          <span className="tc-clock-horizon-value">
            {hasBaseline && model.targetYear !== null ? fmtYear(model.targetYear) : '—'}
          </span>
          <span className="tc-clock-horizon-unit">TARGET</span>
        </div>
        <div className="tc-clock-window">
          {hasBaseline && model.baselineTargetYear !== null ? (
            <>
              tipping-point baseline {fmtYear(model.baselineTargetYear)}
              {model.shiftYears !== 0 ? (
                <>
                  {' '}· shifted{' '}
                  <span
                    data-sign={model.shiftYears < 0 ? 'calamity' : 'humanity'}
                  >
                    {model.shiftYears < 0 ? '−' : '+'}
                    {Math.abs(model.shiftYears).toFixed(1)} yr
                  </span>{' '}
                  by net {netPolarity < 0 ? 'Calamity' : 'Humanity'}
                </>
              ) : (
                ' · unshifted (balanced)'
              )}
            </>
          ) : (
            'no dated tipping points in view — baseline indeterminate'
          )}
        </div>
      </div>

      {/* No countdown here: the compact widget above already shows the live
          D/H/M/S. The expander is the DERIVATION, not a second clock. */}
      {!hasBaseline ? (
        <div className="tc-clock-indeterminate" role="status">
          AWAITING A DATED TIPPING POINT — the countdown anchors to the
          polycrisis's own thresholds; none are in view yet, so no target is shown.
        </div>
      ) : null}

      <dl className="tc-clock-derivation" aria-label="Derivation inputs">
        <div className="tc-clock-metric tc-clock-metric-wide">
          <dt>NET POLARITY</dt>
          <dd>
            <div className="tc-clock-balancebar" aria-hidden="true">
              <div className="tc-clock-balancebar-mid" />
              <div
                className="tc-clock-balancebar-marker"
                style={{ left: `${polarityPercent}%` }}
                data-sign={netPolarity < 0 ? 'calamity' : netPolarity > 0 ? 'humanity' : 'balanced'}
              />
            </div>
            <span className="tc-clock-metric-value">
              {hasEvidence ? netPolarity.toFixed(3) : 'n/a'}
            </span>
          </dd>
        </div>

        <div className="tc-clock-metric">
          <dt>CALAMITY LOAD</dt>
          <dd className="tc-clock-metric-value tc-clock-calamity">
            {model.calamityLoad.toFixed(2)}
          </dd>
        </div>
        <div className="tc-clock-metric">
          <dt>HUMANITY BUFFER</dt>
          <dd className="tc-clock-metric-value tc-clock-humanity">
            {model.humanityBuffer.toFixed(2)}
          </dd>
        </div>

        <div className="tc-clock-metric">
          <dt>FACTORS</dt>
          <dd className="tc-clock-metric-value">{model.contributingCount}</dd>
        </div>
        <div className="tc-clock-metric">
          <dt>TIPPING POINTS</dt>
          <dd className="tc-clock-metric-value">{model.tippingPointCount}</dd>
        </div>
        <div className="tc-clock-metric">
          <dt>CONFIDENCE</dt>
          <dd className="tc-clock-metric-value">
            {CONFIDENCE_LABEL[model.confidence]}
          </dd>
        </div>

        {model.pendingCount > 0 ? (
          <div className="tc-clock-metric">
            <dt>PENDING (EXCLUDED)</dt>
            <dd className="tc-clock-metric-value tc-clock-muted">
              {model.pendingCount}
            </dd>
          </div>
        ) : null}
        {model.rejectedCount > 0 ? (
          <div className="tc-clock-metric">
            <dt>REJECTED (NON-FINITE)</dt>
            <dd className="tc-clock-metric-value tc-clock-muted">
              {model.rejectedCount}
            </dd>
          </div>
        ) : null}
      </dl>

      <footer className="tc-clock-footer">
        <p className="tc-clock-note">
          Countdown anchored to the significance-weighted baseline of the
          polycrisis's dated tipping points, shifted by the net Calamity/Humanity
          balance. A model, not a measurement — see&nbsp;
          <span className="tc-clock-note-glyph">[ i ]</span>.
        </p>
        <button
          type="button"
          className="tc-clock-sound"
          onClick={toggleSound}
          aria-pressed={soundEnabled}
        >
          SOUND: {soundEnabled ? 'ON' : 'OFF'}
        </button>
      </footer>
      </div>
    </section>
  );
}

export default Clock;
