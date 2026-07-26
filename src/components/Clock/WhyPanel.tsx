import type { ClockModel } from '../../lib/clock/clockModel.js';
import { formatYear } from './format.js';

function signClass(value: number): string {
  return value < 0 ? 'tc-why-neg' : value > 0 ? 'tc-why-pos' : 'tc-why-zero';
}

function DomainForces({ model }: { model: ClockModel }): JSX.Element | null {
  if (model.domainForces.length === 0) return null;
  return (
    <div className="tc-why-section">
      <div className="tc-why-heading">Forces by domain</div>
      <p className="tc-why-note">
        Each factor pushes only the thresholds it is causally linked to. Negative =
        Calamity (pulls sooner), positive = Humanity (pushes later).
      </p>
      <ul className="tc-why-list">
        {model.domainForces.map((f) => (
          <li key={f.domain} className="tc-why-row">
            <span className="tc-why-row-label">{f.label}</span>
            <span className="tc-why-row-meta">
              {f.factorCount} factor{f.factorCount === 1 ? '' : 's'}
            </span>
            <span className={`tc-why-row-value ${signClass(f.netForce)}`}>
              {f.netForce >= 0 ? '+' : '−'}
              {Math.abs(f.netForce).toFixed(2)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Thresholds({ model }: { model: ClockModel }): JSX.Element | null {
  if (model.thresholds.length === 0) return null;
  return (
    <div className="tc-why-section">
      <div className="tc-why-heading">Dated thresholds</div>
      <p className="tc-why-note">
        Only thresholds whose crossing ends the possibility of correction anchor
        the countdown. The rest are real dated evidence, but they are not what
        the window is measured against.
      </p>
      <ul className="tc-why-list">
        {model.thresholds.map((t, i) => (
          <li key={t.label ?? i} className="tc-why-threshold" data-anchors={t.anchors}>
            <span className="tc-why-row-label">
              {t.label ?? 'Unlabelled threshold'}
              {/* The derivation, stated rather than implied: whether this drives
                  the countdown, where its year came from, and whether forces
                  were withheld to avoid double-counting a scenario. */}
              {t.anchors ? null : (
                <span className="tc-why-row-meta"> · informs only</span>
              )}
              {t.dating === 'projected' ? (
                <span className="tc-why-row-meta"> · dated from a projection</span>
              ) : null}
              {t.anchors && !t.forcesApply ? (
                <span className="tc-why-row-meta"> · forces withheld (scenario already assumes action)</span>
              ) : null}
            </span>
            <span className="tc-why-threshold-years">
              {formatYear(t.baselineYear)}
              {Math.abs(t.shiftYears) >= 0.05 ? (
                <>
                  {' → '}
                  <span className={signClass(t.shiftYears)}>{formatYear(t.warpedYear)}</span>
                  <span className="tc-why-row-meta">
                    {' '}
                    ({t.shiftYears < 0 ? '−' : '+'}
                    {Math.abs(t.shiftYears).toFixed(1)} yr)
                  </span>
                </>
              ) : (
                <span className="tc-why-row-meta"> · unmoved</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The collapsible "Why?" area under the projection year. Explains the model in
 * detail: how thresholds anchor the countdown, how domain-linked forces warp
 * them, the resulting range, and the one assumption behind it.
 */
export function WhyPanel({ model }: { model: ClockModel }): JSX.Element | null {
  if (!model.hasBaseline) return null;

  return (
    <details className="tc-why">
      <summary className="tc-why-summary">Why?</summary>
      <div className="tc-why-body">
        <p className="tc-why-intro">
          The countdown anchors on the polycrisis&apos;s dated tipping points, then
          lets the other factors — pressures and counter-forces — warp WHEN those
          thresholds arrive. It is a modeled projection, not a measured deadline.
        </p>

        <ol className="tc-why-steps">
          <li>
            <strong>Anchor.</strong> Each dated threshold becomes a
            significance-weighted range of when it could be crossed. Combined, they
            form the distribution the countdown reads — heavier, nearer thresholds
            dominate.
          </li>
          <li>
            <strong>Warp.</strong> Every other factor acts only on the thresholds it
            is causally linked to, by shared domain. Its force moves those
            thresholds — more where there is more runway and more evidence behind
            it, less where a threshold is imminent or the evidence is thin.
          </li>
          <li>
            <strong>Read.</strong> The headline is the median of the warped
            distribution; the range below is its p25–p75 spread — the honest
            uncertainty, not a single instant.
          </li>
        </ol>

        {model.band ? (
          <div className="tc-why-section">
            <div className="tc-why-heading">The window</div>
            <ul className="tc-why-list">
              <li className="tc-why-row">
                <span className="tc-why-row-label">Likely range (p25–p75)</span>
                <span className="tc-why-row-value">
                  {formatYear(model.band.p25)} – {formatYear(model.band.p75)}
                </span>
              </li>
              {model.baselineTargetYear !== null ? (
                <li className="tc-why-row">
                  <span className="tc-why-row-label">Unwarped anchor</span>
                  <span className="tc-why-row-value">
                    {formatYear(model.baselineTargetYear)}
                  </span>
                </li>
              ) : null}
              <li className="tc-why-row">
                <span className="tc-why-row-label">Net shift by forces</span>
                <span className={`tc-why-row-value ${signClass(model.shiftYears)}`}>
                  {model.shiftYears < 0 ? '−' : '+'}
                  {Math.abs(model.shiftYears).toFixed(1)} yr
                </span>
              </li>
            </ul>
          </div>
        ) : null}

        <DomainForces model={model} />
        <Thresholds model={model} />

        <p className="tc-why-assumption">
          No invented dials: the forces only move each estimate <em>within</em> the
          threshold&apos;s own published uncertainty range — full net Calamity toward
          the earliest year science allows, full net Humanity toward the latest. A
          date is never claimed outside what was published.
          {model.assumedSpreadYears !== null ? (
            <>
              {' '}
              Thresholds that published only a single year are given an assumed
              ±{model.assumedSpreadYears.toFixed(0)}-year band, the median of the
              ranges the other thresholds did publish.
            </>
          ) : null}
        </p>
      </div>
    </details>
  );
}
