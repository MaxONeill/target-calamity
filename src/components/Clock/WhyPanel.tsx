import type { ClockModel } from '../../lib/clock/clockModel.js';
import type { Requirement } from '../../../shared/types.js';
import { formatYear } from './format.js';

/** How each requirement status reads, and how urgently. */
const STATUS_LABEL: Record<Requirement['status'], string> = {
  exists: 'exists today',
  partial: 'exists, not at scale',
  absent: 'does not exist yet',
  unknown: 'status unknown',
};

/**
 * One branch of a contingency chain.
 *
 * Recursive rather than flattened, because the nesting IS the argument: "to
 * reverse this you need A, and to get A you need B" only reads as a chain if it
 * looks like one.
 *
 * A branch that ends without children is where no source described what comes
 * next. That is stated rather than left blank â€” an unexplained stop reads as an
 * oversight, when it is actually the most actionable node in the tree.
 */
function RequirementBranch({
  node,
  byParent,
}: {
  node: Requirement;
  byParent: Map<string | null, Requirement[]>;
}): JSX.Element {
  const children = byParent.get(node.id) ?? [];
  return (
    <li className="tc-req" data-status={node.status}>
      <div className="tc-req-head">
        <span className="tc-req-statement">{node.statement}</span>
        <span className="tc-req-status">{STATUS_LABEL[node.status]}</span>
      </div>
      {node.reasoning ? <p className="tc-req-reason">{node.reasoning}</p> : null}
      {node.sourceUrl ? (
        <a
          className="tc-req-source"
          href={node.sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          {node.publisher ?? 'source'}
        </a>
      ) : null}

      {/* The routing surface. These are counter-efforts already tracked whose
          wording is semantically close to this requirement — related work, not
          a claim that any of them satisfies it. Saying "working on this" would
          overstate a similarity score, which is the same failure as an invented
          dependency wearing a friendlier face. */}
      {node.efforts.length > 0 ? (
        <div className="tc-req-efforts">
          <span className="tc-req-efforts-head">Related work being tracked</span>
          <ul className="tc-req-efforts-list">
            {node.efforts.map((e) => (
              <li key={e.factorId}>{e.name}</li>
            ))}
          </ul>
        </div>
      ) : node.status !== 'exists' ? (
        <p className="tc-req-untracked">Nothing in the set addresses this yet.</p>
      ) : null}

      {children.length > 0 ? (
        <ul className="tc-req-children">
          {children.map((c) => (
            <RequirementBranch key={c.id} node={c} byParent={byParent} />
          ))}
        </ul>
      ) : node.status !== 'exists' ? (
        <p className="tc-req-terminal">No source describes what this would take.</p>
      ) : null}
    </li>
  );
}

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
              {f.netForce >= 0 ? '+' : 'âˆ’'}
              {Math.abs(f.netForce).toFixed(2)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Thresholds({
  model,
  requirements,
}: {
  model: ClockModel;
  requirements: readonly Requirement[];
}): JSX.Element | null {
  if (model.thresholds.length === 0) return null;

  // The wire carries requirements flat, keyed by parentId, and the tree is
  // rebuilt here. Flat survives schema evolution better than nested recursion,
  // and the sets are small enough that two passes cost nothing.
  const byParent = new Map<string | null, Requirement[]>();
  const requirementsByFactor = new Map<string, Requirement[]>();
  for (const r of requirements) {
    const siblings = byParent.get(r.parentId) ?? [];
    siblings.push(r);
    byParent.set(r.parentId, siblings);
    if (r.parentId === null) {
      const roots = requirementsByFactor.get(r.factorId) ?? [];
      roots.push(r);
      requirementsByFactor.set(r.factorId, roots);
    }
  }

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
                <span className="tc-why-row-meta"> Â· informs only</span>
              )}
              {t.dating === 'projected' ? (
                <span className="tc-why-row-meta"> Â· dated from a projection</span>
              ) : null}
              {t.anchors && !t.forcesApply ? (
                <span className="tc-why-row-meta"> Â· forces withheld (scenario already assumes action)</span>
              ) : null}
              {t.crossed ? <span className="tc-why-crossed"> Â· already crossed</span> : null}
            </span>

            {/* A crossed threshold is a debt, not an ending. What reversal would
                take is shown in full â€” effort, timescale, reasoning and the
                source â€” because that is the only part of a past-due threshold a
                reader can act on. An absent timescale is stated as absent
                rather than filled in. */}
            {t.crossed && t.recovery ? (
              <div className="tc-why-recovery">
                <div className="tc-why-recovery-head">
                  Reversing this:{' '}
                  {t.recovery.timescaleYears !== undefined ? (
                    <strong>
                      ~{t.recovery.timescaleYears} yr
                      {t.recovery.timescaleLowYears !== undefined &&
                      t.recovery.timescaleHighYears !== undefined
                        ? ` (${t.recovery.timescaleLowYears}â€“${t.recovery.timescaleHighYears})`
                        : ''}
                    </strong>
                  ) : (
                    <em>no timescale published</em>
                  )}
                </div>
                <div className="tc-why-recovery-effort">{t.recovery.effort}</div>
                <p className="tc-why-recovery-reason">{t.recovery.reasoning}</p>
                <a
                  className="tc-why-recovery-source"
                  href={t.recovery.sourceUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {t.recovery.publisher ?? 'source'}
                </a>
              </div>
            ) : t.crossed ? (
              <div className="tc-why-recovery">
                <em className="tc-why-recovery-reason">
                  Reversal not yet assessed.
                </em>
              </div>
            ) : null}

            {/* The contingency chain. Every node is a cited claim, so the tree
                is an argument a reader can follow and check rather than a
                summary they have to trust. */}
            {t.crossed && (requirementsByFactor.get(t.factorId ?? '') ?? []).length > 0 ? (
              <div className="tc-req-tree">
                <div className="tc-req-tree-head">What reversal would require</div>
                <ul className="tc-req-children">
                  {(requirementsByFactor.get(t.factorId ?? '') ?? []).map((r) => (
                    <RequirementBranch key={r.id} node={r} byParent={byParent} />
                  ))}
                </ul>
              </div>
            ) : null}
            <span className="tc-why-threshold-years">
              {formatYear(t.baselineYear)}
              {Math.abs(t.shiftYears) >= 0.05 ? (
                <>
                  {' â†’ '}
                  <span className={signClass(t.shiftYears)}>{formatYear(t.warpedYear)}</span>
                  <span className="tc-why-row-meta">
                    {' '}
                    ({t.shiftYears < 0 ? 'âˆ’' : '+'}
                    {Math.abs(t.shiftYears).toFixed(1)} yr)
                  </span>
                </>
              ) : (
                <span className="tc-why-row-meta"> Â· unmoved</span>
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
export function WhyPanel({
  model,
  requirements = [],
}: {
  model: ClockModel;
  requirements?: readonly Requirement[];
}): JSX.Element | null {
  if (!model.hasBaseline) return null;

  return (
    <details className="tc-why">
      <summary className="tc-why-summary">Why?</summary>
      <div className="tc-why-body">
        <p className="tc-why-intro">
          The countdown anchors on the polycrisis&apos;s dated tipping points, then
          lets the other factors â€” pressures and counter-forces â€” warp WHEN those
          thresholds arrive. It is a modeled projection, not a measured deadline.
        </p>

        <ol className="tc-why-steps">
          <li>
            <strong>Anchor.</strong> Each dated threshold becomes a
            significance-weighted range of when it could be crossed. Combined, they
            form the distribution the countdown reads â€” heavier, nearer thresholds
            dominate.
          </li>
          <li>
            <strong>Warp.</strong> Every other factor acts only on the thresholds it
            is causally linked to, by shared domain. Its force moves those
            thresholds â€” more where there is more runway and more evidence behind
            it, less where a threshold is imminent or the evidence is thin.
          </li>
          <li>
            <strong>Read.</strong> The headline is the median of the warped
            distribution; the range below is its p25â€“p75 spread â€” the honest
            uncertainty, not a single instant.
          </li>
        </ol>

        {model.band ? (
          <div className="tc-why-section">
            <div className="tc-why-heading">The window</div>
            <ul className="tc-why-list">
              <li className="tc-why-row">
                <span className="tc-why-row-label">Likely range (p25â€“p75)</span>
                <span className="tc-why-row-value">
                  {formatYear(model.band.p25)} â€“ {formatYear(model.band.p75)}
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
                  {model.shiftYears < 0 ? 'âˆ’' : '+'}
                  {Math.abs(model.shiftYears).toFixed(1)} yr
                </span>
              </li>
            </ul>
          </div>
        ) : null}

        <DomainForces model={model} />
        <Thresholds model={model} requirements={requirements} />

        <p className="tc-why-assumption">
          No invented dials: the forces only move each estimate <em>within</em> the
          threshold&apos;s own published uncertainty range â€” full net Calamity toward
          the earliest year science allows, full net Humanity toward the latest. A
          date is never claimed outside what was published.
          {model.assumedSpreadYears !== null ? (
            <>
              {' '}
              Thresholds that published only a single year are given an assumed
              Â±{model.assumedSpreadYears.toFixed(0)}-year band, the median of the
              ranges the other thresholds did publish.
            </>
          ) : null}
        </p>
      </div>
    </details>
  );
}

