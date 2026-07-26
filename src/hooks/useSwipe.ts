import { useEffect, type RefObject } from 'react';

export type SwipeDirection = 'left' | 'right' | 'up' | 'down';

export interface SwipeGesture {
  direction: SwipeDirection;
  /** Where the gesture began, in client coordinates. */
  startX: number;
  startY: number;
  /** The element the gesture began on, for zone/ownership checks. */
  target: EventTarget | null;
}

export interface UseSwipeOptions {
  /** Fired once per completed swipe. Must be stable (wrap in useCallback). */
  onSwipe: (gesture: SwipeGesture) => void;
  /** Minimum travel along the dominant axis, px. */
  threshold?: number;
  /**
   * Maximum cross-axis travel as a fraction of dominant travel. Keeps a
   * diagonal drag — or a vertical scroll that wanders — from firing.
   */
  crossAxisRatio?: number;
  /** Gestures slower than this are drags, not swipes. */
  maxDurationMs?: number;
}

const DEFAULT_THRESHOLD_PX = 48;
const DEFAULT_CROSS_AXIS_RATIO = 0.7;
const DEFAULT_MAX_DURATION_MS = 700;

/**
 * Directional swipe detection on an element.
 *
 * Touch pointers only, deliberately. The globe orbits on pointer drag, so
 * reacting to mouse gestures would make every horizontal drag on a desktop also
 * open or close the panel. Multi-touch is excluded for the same reason in
 * reverse: two fingers mean a pinch, which OrbitRig owns.
 *
 * `pointerup`/`pointercancel` are bound to the window rather than the element,
 * because a swipe usually ends outside the element it began on. Pointer capture
 * would fix that too, but it retargets events away from child controls and
 * would break taps on anything inside.
 */
export function useSwipe(
  ref: RefObject<HTMLElement | null>,
  {
    onSwipe,
    threshold = DEFAULT_THRESHOLD_PX,
    crossAxisRatio = DEFAULT_CROSS_AXIS_RATIO,
    maxDurationMs = DEFAULT_MAX_DURATION_MS,
  }: UseSwipeOptions,
): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    let start: { x: number; y: number; time: number; target: EventTarget | null } | null = null;
    let livePointers = 0;

    const onPointerDown = (event: PointerEvent): void => {
      if (event.pointerType !== 'touch') return;
      livePointers += 1;
      if (livePointers > 1) {
        start = null; // a second finger: this is a pinch
        return;
      }
      start = {
        x: event.clientX,
        y: event.clientY,
        time: event.timeStamp,
        target: event.target,
      };
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (event.pointerType !== 'touch') return;
      livePointers = Math.max(0, livePointers - 1);

      const from = start;
      start = null;
      if (!from) return;
      if (event.timeStamp - from.time > maxDurationMs) return;

      const dx = event.clientX - from.x;
      const dy = event.clientY - from.y;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);

      const horizontal = absX >= absY;
      const dominant = horizontal ? absX : absY;
      const cross = horizontal ? absY : absX;
      if (dominant < threshold) return;
      if (cross > dominant * crossAxisRatio) return;

      const direction: SwipeDirection = horizontal
        ? dx < 0
          ? 'left'
          : 'right'
        : dy < 0
          ? 'up'
          : 'down';

      onSwipe({ direction, startX: from.x, startY: from.y, target: from.target });
    };

    const onPointerCancel = (event: PointerEvent): void => {
      if (event.pointerType !== 'touch') return;
      livePointers = Math.max(0, livePointers - 1);
      start = null;
    };

    element.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);

    return () => {
      element.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
    };
  }, [ref, onSwipe, threshold, crossAxisRatio, maxDurationMs]);
}
