import type React from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FieldPin } from '../../../shared/types.js';
import './PinPeek.css';

/** Signed, fixed-precision effect string, matching the feed cards. */
function formatEffect(effect: number): string {
  const sign = effect > 0 ? '+' : effect < 0 ? '−' : '±';
  return `${sign}${Math.abs(effect).toFixed(2)}`;
}

function polarityOf(effect: number): 'calamity' | 'humanity' | 'neutral' {
  if (effect < 0) return 'calamity';
  if (effect > 0) return 'humanity';
  return 'neutral';
}

/** How far from the cursor the panel sits, px. */
const CURSOR_OFFSET = 14;

/** Keep this clear of the viewport edge, px. */
const VIEWPORT_MARGIN = 8;

/**
 * How far the cursor may stray from the panel's edges before it closes, px.
 *
 * This is the whole dismissal rule, and it is measured from the EDGES rather
 * than from the anchor point: the panel has to survive the trip from the pin
 * that opened it to the row being reached for, and that trip is a function of
 * how big the panel is, not how far the cursor has come. Generous enough to
 * cross the gap without a steady hand; tight enough that it does not linger
 * over unrelated parts of the globe.
 */
const DISMISS_MARGIN = 56;

/**
 * Beyond this many rows the rest are summarised.
 *
 * Sized against the real field: at the 8° halo support a hover covers 4 factors
 * at the median and 13 at the worst cluster, so 12 lists almost every real case
 * in full. The panel scrolls past that rather than clipping, since it is
 * pointer-interactive and an unreachable row is the bug this feature exists to
 * fix.
 */
const MAX_ROWS = 12;

export interface PinPeekProps {
  /** Pins under the cursor, nearest first. Empty hides the peek. */
  pins: readonly FieldPin[];
  /** Cursor position in client coordinates. */
  x: number;
  y: number;
  onSelect: (id: string) => void;
  /** The cursor has left the panel's neighbourhood. */
  onDismiss: () => void;
}

/**
 * The hover peek: every pin under the cursor, not just the frontmost.
 *
 * Pins cluster, and a single-pixel hit test resolves whichever one happens to be
 * in front — so an overlapping group was effectively unreachable, and worse, a
 * reader had no way to know the others were there at all. This lists them.
 *
 * IT LISTS BY FOOTPRINT, NOT BY MARKER. A pin's claim on the globe is the area
 * of surface its field tints, not the few pixels of its spike, so the list is
 * every factor whose marker OR halo covers the cursor. Two pins can be far
 * enough apart that no pixel of their markers touches while their halos overlap
 * heavily — and that blended patch is what the reader is looking at.
 *
 * IT IS A LIST, NOT A TOOLTIP, and that distinction drives the rest: it is
 * pointer-interactive so a row can be clicked to select the pin behind it, which
 * is the only route to a pin that is fully occluded. A tooltip that vanished on
 * approach would show the reader what they cannot have.
 *
 * IT DOES NOT FOLLOW THE CURSOR. It anchors where the group was first found and
 * stays there for as long as it is open, because a panel that tracks the pointer
 * moves away from every row you reach for — the first row is then the only one
 * selectable. Two earlier versions failed at this: one re-anchored on every
 * pointer frame, and one re-anchored whenever the pin SET changed, which in a
 * dense area is nearly as often.
 *
 * The list underneath may keep changing while the cursor travels. That is fine;
 * the position must not. Dismissal is by DISTANCE FROM THE PANEL EDGES, so the
 * trip from pin to row is always completable however the contents churn.
 *
 * Deliberately NOT keyboard-reachable and marked aria-hidden. It mirrors what
 * the sidebar feed already exposes as an ordinary focusable list; duplicating
 * those rows into the tab order would make every factor reachable twice and put
 * a transient hover artefact in the middle of it. The feed is the accessible
 * path to the same data.
 */
export function PinPeek({
  pins,
  x,
  y,
  onSelect,
  onDismiss,
}: PinPeekProps): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const open = pins.length > 0;

  /*
   * MEASURE, THEN CLAMP. The earlier version guessed a side from the cursor's
   * position in the viewport, which is wrong whenever the panel is taller or
   * wider than the guess assumed — it drew partly offscreen and the last rows
   * were unreachable. Reading the rendered box is exact: prefer the side with
   * room, then clamp both axes so no edge can leave the viewport.
   *
   * Runs in a layout effect so the corrected position is committed before paint
   * and the panel never appears in the wrong place for a frame.
   */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !open) return;
    const box = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = x + CURSOR_OFFSET;
    if (left + box.width > vw - VIEWPORT_MARGIN) left = x - CURSOR_OFFSET - box.width;
    left = Math.min(
      Math.max(left, VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, vw - VIEWPORT_MARGIN - box.width),
    );

    let top = y + CURSOR_OFFSET;
    if (top + box.height > vh - VIEWPORT_MARGIN) top = y - CURSOR_OFFSET - box.height;
    top = Math.min(
      Math.max(top, VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, vh - VIEWPORT_MARGIN - box.height),
    );

    setPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
  }, [x, y, open, pins.length]);

  /*
   * Dismissal by distance from the panel's own edges, on a window listener so it
   * fires whether the cursor is over the canvas, the panel, or anything else.
   * The scene deliberately never closes the peek — if it did, the list would
   * vanish the moment the cursor left the pin that opened it, which is the
   * failure this rule exists to prevent.
   */
  useEffect(() => {
    if (!open) return;
    const onMove = (event: PointerEvent): void => {
      const el = ref.current;
      if (!el) return;
      const b = el.getBoundingClientRect();
      const dx = Math.max(b.left - event.clientX, 0, event.clientX - b.right);
      const dy = Math.max(b.top - event.clientY, 0, event.clientY - b.bottom);
      if (Math.hypot(dx, dy) > DISMISS_MARGIN) onDismiss();
    };
    // Leaving the window entirely produces no further moves, so close outright.
    const onLeave = (): void => onDismiss();
    window.addEventListener('pointermove', onMove);
    document.addEventListener('pointerleave', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerleave', onLeave);
    };
  }, [open, onDismiss]);

  if (!open) return null;

  const shown = pins.slice(0, MAX_ROWS);
  const hidden = pins.length - shown.length;

  const style: React.CSSProperties = pos
    ? { left: pos.left, top: pos.top }
    : // First paint, before the box can be measured. Off-viewport rather than at
      // the cursor, so a mis-placed frame is never visible.
      { left: -9999, top: -9999 };

  return (
    <div ref={ref} className="tc-peek" style={style} aria-hidden="true">
      {pins.length > 1 ? <div className="tc-peek__head">{pins.length} factors here</div> : null}
      <ul className="tc-peek__list">
        {shown.map((pin) => (
          <li key={pin.id}>
            <button
              type="button"
              className="tc-peek__row"
              tabIndex={-1}
              onClick={() => onSelect(pin.id)}
            >
              <span
                className={`tc-peek__dot tc-peek__dot--${polarityOf(pin.effect)}`}
                aria-hidden="true"
              />
              <span className="tc-peek__name">{pin.name}</span>
              <span className={`tc-peek__effect tc-peek__effect--${polarityOf(pin.effect)}`}>
                {formatEffect(pin.effect)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {hidden > 0 ? <div className="tc-peek__more">+{hidden} more</div> : null}
    </div>
  );
}

export default PinPeek;
