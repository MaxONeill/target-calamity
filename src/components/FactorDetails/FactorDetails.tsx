/**
 * FactorDetails — the selection detail panel.
 *
 * When a factor is selected (from a sidebar card OR a GPU-picked globe pin), this
 * panel surfaces the FULL record the compact card cannot: the complete
 * description, the verification + reputability audit trail, the dated
 * tipping-point threshold (if any), and — the point of the view — the
 * SOURCES.
 *
 * Sources render as a PLAIN LIST: publisher + the URL as a real, clickable link.
 * No quote snippets, no analyst notes. Showing the bare link is the honest
 * minimum — the reader goes to the source itself rather than trusting an excerpt
 * we chose, which removes the verbatim-vs-paraphrase ambiguity entirely. A factor
 * with ZERO citations says so loudly rather than rendering a reassuring gap.
 *
 * Two inputs, in priority order:
 *   - `factor` (a full {@link Factor} from the feed) → the complete view.
 *   - else `pin` (a {@link FieldPin}, when the selection is a globe pin whose card
 *     has not paged into the feed) → a MINIMAL view with a note that the full
 *     sources are still loading / unavailable. Never crashes on the pin-only case.
 * With neither, the panel renders nothing.
 *
 * Accessibility: a labelled `role="region"`, Escape closes, and focus moves to the
 * panel on open (restoring nothing — the sidebar/globe keep their own focus model).
 */
import { useEffect, useRef } from 'react';
import type { Factor, FieldPin, TippingPoint } from '../../../shared/types.js';
import './FactorDetails.css';

export interface FactorDetailsProps {
  /** The fully-loaded factor (carries citations). Takes priority over `pin`. */
  factor: Factor | null;
  /**
   * Fallback when a globe pin is selected before its card is in the feed: a lean
   * field pin, rendered as a minimal view with a "sources loading" note. Optional.
   */
  pin?: FieldPin | null;
  onClose: () => void;
}

/** Polarity bucket for colour/labelling (mirrors FactorCard). */
function polarityOf(effect: number): 'calamity' | 'humanity' | 'neutral' {
  if (effect < 0) return 'calamity';
  if (effect > 0) return 'humanity';
  return 'neutral';
}

/** Signed, fixed-precision effect string, e.g. "−0.82" / "+0.44" / "±0.00". */
function formatEffect(effect: number): string {
  const sign = effect > 0 ? '+' : effect < 0 ? '−' : '±';
  return `${sign}${Math.abs(effect).toFixed(2)}`;
}

/** Human hostname for a link label, without protocol noise. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Years render to the nearest whole year: 2048.3 → "2048". */
function fmtYear(year: number): string {
  return String(Math.round(year));
}

/** The tipping-point range as "2027–2035", "≤ 2060", "≥ 2025", or "" when unbounded. */
function rangeLabel(tp: TippingPoint): string {
  const { earliestYear, latestYear } = tp;
  if (earliestYear !== undefined && latestYear !== undefined) {
    return `${fmtYear(earliestYear)}–${fmtYear(latestYear)}`;
  }
  if (latestYear !== undefined) return `≤ ${fmtYear(latestYear)}`;
  if (earliestYear !== undefined) return `≥ ${fmtYear(earliestYear)}`;
  return '';
}

/** Name + zone/verification badges. The top of the stack. */
function DetailHeader({
  name,
  spatialPath,
  zoneLevel,
  verificationState,
}: {
  name: string;
  spatialPath: string;
  zoneLevel: string | null;
  verificationState: 'verified' | 'pending' | null;
}): JSX.Element {
  return (
    <div className="tc-details__head">
      <h2 className="tc-details__name" id="tc-details-title">
        {name}
      </h2>
      <div className="tc-details__badges">
        <span className="tc-badge tc-badge--zone" title={spatialPath}>
          {zoneLevel ?? spatialPath}
        </span>
        {verificationState === 'pending' ? (
          <span className="tc-badge tc-badge--pending" title="Machine-extracted; awaiting review.">
            Pending
          </span>
        ) : verificationState === 'verified' ? (
          <span className="tc-badge tc-badge--verified" title="Reviewed and verified.">
            Verified
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** The EFF (ratio) and SIG bars. */
function DetailMetrics({
  effect,
  significance,
}: {
  effect: number;
  significance: number;
}): JSX.Element {
  const polarity = polarityOf(effect);
  const effectMagnitudePct = Math.min(Math.abs(effect), 1) * 50;
  const significancePct = Math.min(Math.max(significance, 0), 1) * 100;
  return (
    <div className="tc-details__metrics">
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
          {formatEffect(effect)}
        </span>
      </div>

      <div className="tc-metric">
        <span className="tc-metric__label">SIG</span>
        <div className="tc-sigbar" aria-hidden="true">
          <span className="tc-sigbar__fill" style={{ width: `${significancePct}%` }} />
        </div>
        <span className="tc-metric__value">{significance.toFixed(2)}</span>
      </div>
    </div>
  );
}

/** The dated tipping-point threshold block, framed explicitly as an ESTIMATE. */
function TippingPointBlock({ tp }: { tp: TippingPoint }): JSX.Element {
  const range = rangeLabel(tp);
  return (
    <section className="tc-details__tipping" aria-label="Estimated tipping-point threshold">
      <div className="tc-details__section-head">Estimated tipping point</div>
      <div className="tc-details__tipping-year">
        <span className="tc-details__tipping-approx" aria-hidden="true">
          ≈
        </span>
        <span className="tc-details__tipping-value">{fmtYear(tp.centralYear)}</span>
        {range ? <span className="tc-details__tipping-range">({range})</span> : null}
      </div>
      {tp.label ? <p className="tc-details__tipping-label">{tp.label}</p> : null}
      <p className="tc-details__tipping-note">
        A published, uncertain threshold estimate — not a measured deadline. It
        informs the Clock's countdown baseline.
      </p>
    </section>
  );
}

/**
 * The reputability audit trail: the deciding source's credibility
 * score + reasoning behind the verified/pending state. Rendered only when the
 * factor carries one (machine-ingested via the gate) — seed/curated factors have
 * none. Framed as the WHY behind the verification badge, so the gate is auditable
 * rather than a black box.
 */
function ReputabilityBlock({
  score,
  reasoning,
  state,
}: {
  score: number;
  reasoning: string | undefined;
  state: 'verified' | 'pending' | null;
}): JSX.Element {
  const pct = Math.round(Math.min(Math.max(score, 0), 1) * 100);
  const tone = state === 'verified' ? 'verified' : 'pending';
  return (
    <section
      className={`tc-details__rep tc-details__rep--${tone}`}
      aria-label="Source reputability"
    >
      <div className="tc-details__section-head">
        Source reputability
        <span className="tc-details__rep-score">{score.toFixed(2)}</span>
      </div>
      <div className="tc-details__rep-bar" aria-hidden="true">
        <span className={`tc-details__rep-fill tc-details__rep-fill--${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="tc-details__rep-why">
        {state === 'verified'
          ? 'Cleared the reputability gate — the deciding source scored at or above the verification threshold.'
          : 'Below the reputability gate threshold — kept pending, off the Clock aggregate.'}
      </p>
      {reasoning ? <p className="tc-details__rep-reasoning">{reasoning}</p> : null}
    </section>
  );
}

export function FactorDetails({ factor, pin, onClose }: FactorDetailsProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);

  const open = factor !== null || (pin !== null && pin !== undefined);

  // Escape closes; focus the panel on open so keyboard users land inside it.
  useEffect(() => {
    if (!open) return;
    // preventScroll is load-bearing, not a nicety. Selecting a pin mounts this
    // panel while the slideout is still parked at translateX(100%), i.e. fully
    // off-screen. A plain focus() makes the browser scroll the element into
    // view, and it does that by scrolling the nearest scrollable ancestor —
    // .tc-app, whose `overflow: hidden` suppresses the scrollbar but still
    // permits programmatic scrolling. The whole app container slid sideways,
    // carrying the top bar with it, then snapped back when the panel finished
    // its transition and the scroll offset was clamped to 0.
    panelRef.current?.focus({ preventScroll: true });
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose, factor, pin]);

  if (!open) return null;

  return (
    <div
      className="tc-details"
      role="region"
      aria-labelledby="tc-details-title"
      tabIndex={-1}
      ref={panelRef}
    >
      <div className="tc-details__bar">
        <button
          type="button"
          className="tc-details__back"
          onClick={onClose}
          aria-label="Back to factor feed"
        >
          ‹ FEED
        </button>
        <span className="tc-details__tag">FACTOR DETAIL</span>
        <button
          type="button"
          className="tc-details__close"
          onClick={onClose}
          aria-label="Back to factor feed"
        >
          ✕
        </button>
      </div>

      {factor !== null ? (
        <div className="tc-details__body">
          <DetailHeader
            name={factor.name}
            spatialPath={factor.spatialPath}
            zoneLevel={factor.zoneLevel}
            verificationState={factor.verificationState}
          />

          {factor.tippingPoint ? <TippingPointBlock tp={factor.tippingPoint} /> : null}

          {factor.description ? (
            <section className="tc-details__desc-wrap" aria-label="Description">
              <div className="tc-details__section-head">Description</div>
              <p className="tc-details__desc">{factor.description}</p>
            </section>
          ) : null}

          <DetailMetrics effect={factor.effect} significance={factor.significance} />

          {/* SOURCES — a plain list: publisher + the link itself, nothing else. */}
          {factor.citations.length > 0 ? (
            <section className="tc-details__sources" aria-label="Sources">
              <div className="tc-details__section-head">
                Sources <span className="tc-details__count">[{factor.citations.length}]</span>
              </div>
              <ul className="tc-details__source-list">
                {factor.citations.map((cite) => (
                  <li key={cite.id} className="tc-details__source">
                    <span className="tc-details__source-publisher">
                      {cite.publisher ||
                        (cite.sourceUrl !== null ? hostOf(cite.sourceUrl) : 'Unattributed')}
                    </span>
                    {cite.sourceUrl !== null ? (
                      <a
                        className="tc-cite__link"
                        href={cite.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={cite.sourceUrl}
                      >
                        {cite.sourceUrl}
                        <span className="tc-cite__link-glyph"> {'↗'}</span>
                      </a>
                    ) : (
                      <span className="tc-cite__nourl">no link</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <div className="tc-details__no-sources">
              <span aria-hidden="true">⚠</span>
              <span>Unsourced — no citations attached to this factor.</span>
            </div>
          )}

          {factor.reputabilityScore !== undefined ? (
            <ReputabilityBlock
              score={factor.reputabilityScore}
              reasoning={factor.reputabilityReasoning}
              state={factor.verificationState}
            />
          ) : null}
        </div>
      ) : pin ? (
        <div className="tc-details__body">
          <DetailHeader
            name="Selected pin"
            spatialPath={`${pin.lat.toFixed(2)}, ${pin.lon.toFixed(2)}`}
            zoneLevel={null}
            verificationState={null}
          />
          {pin.tippingPoint ? <TippingPointBlock tp={pin.tippingPoint} /> : null}
          <DetailMetrics effect={pin.effect} significance={pin.significance} />
          <div className="tc-details__loading">
            Full record and sources are loading or unavailable — this factor's card
            has not yet reached the feed. Its metrics are shown from the field set.
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default FactorDetails;
