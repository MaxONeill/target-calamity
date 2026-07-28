/**
 * Regression guard: THE GLOBE HAS NO KEYBOARD CONTROLS.
 *
 * WASDQE used to orbit and zoom the camera, and the listeners were bound to
 * `window` because the canvas is not focusable. The consequence was that typing
 * a claim into the submission form flew the globe around underneath the form —
 * every "a" and "s" and "d" in the prose was also a camera command.
 *
 * The fix was removal, not a guard clause. Filtering on `event.target` being an
 * input is a denylist, and denylists lose: the next textarea, contenteditable,
 * or focused dialog reintroduces the bug. So the assertion here is the strong
 * one — the rig and the interrupt guard must register NO key listener anywhere,
 * on any target. A `keydown` listener existing at all is the defect.
 *
 * These tests assert on LISTENER REGISTRATION rather than on camera state after
 * a synthetic keypress. That is deliberate: a state assertion passes vacuously
 * if the listener exists but the fake event fails to reach it, which is exactly
 * the failure mode a regression test must not have.
 */
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OrbitRig } from './OrbitRig';
import { attachInterrupt } from './interrupt';
import type { OrbitAlignment } from './alignment';

/** Records every listener type registered against it. */
function recorder(): { types: string[]; el: HTMLElement } {
  const types: string[] = [];
  const el = {
    addEventListener: (type: string) => types.push(type),
    removeEventListener: () => undefined,
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
    style: {},
  };
  return { types, el: el as unknown as HTMLElement };
}

const KEY_EVENTS = ['keydown', 'keyup', 'keypress'];

let windowTypes: string[];
let originalWindow: unknown;

beforeEach(() => {
  windowTypes = [];
  originalWindow = (globalThis as Record<string, unknown>).window;
  // The node test environment has no `window`; the rig and the interrupt guard
  // both reach for it, and `window` is precisely where the offending listener
  // used to live, so it must be observable here.
  (globalThis as Record<string, unknown>).window = {
    addEventListener: (type: string) => windowTypes.push(type),
    removeEventListener: () => undefined,
  };
});

afterEach(() => {
  (globalThis as Record<string, unknown>).window = originalWindow;
});

describe('OrbitRig — no keyboard control', () => {
  it('registers no key listener on the canvas or on window', () => {
    const { types, el } = recorder();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);

    const rig = new OrbitRig(camera, { domElement: el });

    for (const key of KEY_EVENTS) {
      expect(types).not.toContain(key);
      expect(windowTypes).not.toContain(key);
    }
    // Sanity: the rig DID wire itself up, so the assertion above is about the
    // absence of key listeners and not about a constructor that did nothing.
    expect(types).toContain('pointerdown');
    expect(types).toContain('wheel');

    rig.dispose();
  });

  it('exposes no keyboard tuning options', () => {
    // The old surface carried `keyOrbitSpeed` / `keyZoomSpeed`. If either comes
    // back, the movement they configure has come back with them.
    const { el } = recorder();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    const rig = new OrbitRig(camera, { domElement: el });

    expect(Object.keys(rig)).not.toContain('keyOrbitSpeed');
    expect(Object.keys(rig)).not.toContain('keyZoomSpeed');

    rig.dispose();
  });
});

describe('attachInterrupt — no keyboard interrupt', () => {
  it('does not drop an alignment lock on a keypress', () => {
    // Keys no longer manipulate the camera, so a keypress is no longer manual
    // manipulation. Cancelling an in-flight alignment because someone typed "a"
    // into a text field is the same bug in a different place.
    const { types, el } = recorder();
    const alignment = {
      isAnimating: false,
      cancel: () => undefined,
    } as unknown as OrbitAlignment;

    const guard = attachInterrupt(alignment, { target: el });

    for (const key of KEY_EVENTS) {
      expect(types).not.toContain(key);
      expect(windowTypes).not.toContain(key);
    }
    expect(types).toContain('pointerdown');

    guard.dispose();
  });
});
