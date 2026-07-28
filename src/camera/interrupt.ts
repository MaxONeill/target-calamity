/**
 * interrupt.ts — the "drop lock" handler ( Step Four).
 *
 *  Step Four / : "During manual user manipulation
 * (WASDQE/Pointer Drag), all active automated camera animations must immediately
 * drop lock via an explicit interrupt handler to prevent viewport fighting."
 *
 * This binds capture-phase pointer and wheel listeners that cancel an in-flight
 * {@link OrbitAlignment} the instant the user touches the controls.
 *
 * NO KEY LISTENER, though the requirement above names WASDQE. Keyboard camera
 * control was removed from `OrbitRig` because a window-level key handler moved
 * the globe while the user typed into the submission form. Keys no longer
 * manipulate the camera, so a keypress is no longer manual manipulation and must
 * NOT drop an alignment's lock — cancelling a flight because someone typed "a"
 * in a text field is the same bug wearing different clothes.
 *
 * Race-safety — token counter, NOT a boolean:
 *   A naive `if (animating) stop()` boolean flag has a window: an animation
 *   frame can already be scheduled (queued in the browser) when the interrupt
 *   fires, and it will still run afterward, writing the camera one more time and
 *   fighting the user's input. OrbitAlignment instead carries a monotonic
 *   GENERATION token. `cancel()` increments it; every scheduled frame captured
 *   its own generation and no-ops when the two disagree. So a frame queued before
 *   the interrupt is neutralized even though it still executes. This handler's
 *   only job is to call `cancel()` promptly (in the capture phase, before the
 *   rig's own bubble-phase handlers apply motion); the token machinery in
 *   alignment.ts provides the actual race guarantee.
 */
import type { OrbitAlignment } from './alignment';

export interface InterruptGuardOptions {
  /** Element that receives the pointer/wheel listeners (typically the canvas). */
  target: HTMLElement;
  /**
   * Also drop lock on wheel zoom. Default true — a wheel zoom is manual
   * manipulation just like a drag.
   */
  interruptOnWheel?: boolean;
  /**
   * Optional hook fired whenever an interrupt is dispatched (after cancel()).
   * Useful for UI state (e.g. clearing a "following" indicator).
   */
  onInterrupt?: () => void;
}

/** Handle returned by {@link attachInterrupt}; call `dispose()` to unbind. */
export interface InterruptGuard {
  dispose(): void;
}

/**
 * Wire manual-input interrupts to an {@link OrbitAlignment}. Any primary pointer
 * press or wheel zoom cancels the in-flight flight immediately.
 *
 * Listeners are registered in the CAPTURE phase so they run before the OrbitRig's
 * own handlers apply motion — the alignment is torn down and the rig re-synced to
 * the live camera pose before manual control reads it. cancel() is idempotent and
 * safe to call when no flight is running.
 */
export function attachInterrupt(
  alignment: OrbitAlignment,
  options: InterruptGuardOptions,
): InterruptGuard {
  const { target } = options;
  const interruptOnWheel = options.interruptOnWheel ?? true;
  const onInterrupt = options.onInterrupt;

  const fire = (): void => {
    // Only pay the cost (and the onInterrupt notification) if a flight is
    // actually in progress. cancel() itself is a no-op when idle, but we gate
    // the hook so it doesn't fire on every idle click.
    if (!alignment.isAnimating) return;
    alignment.cancel();
    onInterrupt?.();
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return; // primary button only, matches the rig
    fire();
  };

  const onWheel = (): void => {
    fire();
  };

  target.addEventListener('pointerdown', onPointerDown, { capture: true });
  if (interruptOnWheel) {
    target.addEventListener('wheel', onWheel, { capture: true, passive: true });
  }
  return {
    dispose(): void {
      target.removeEventListener('pointerdown', onPointerDown, { capture: true });
      if (interruptOnWheel) {
        target.removeEventListener('wheel', onWheel, { capture: true });
      }
    },
  };
}
