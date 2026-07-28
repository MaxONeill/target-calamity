/**
 * `orbitBy` — the mutator the ambient rotation drives the globe through.
 *
 * It is the only way to move the camera that is not a user gesture, so it is
 * also the only one that can fight something else for control. These pin the
 * two properties that keep it well-behaved: it moves the azimuth and nothing
 * else, and it respects `enabled`.
 */
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OrbitRig } from './OrbitRig';

type Listener = (event: unknown) => void;

/** Captures the rig's listeners so a synthetic event can be delivered. */
function stubElement(): { el: HTMLElement; fire: (type: string, event: unknown) => void } {
  const listeners = new Map<string, Listener>();
  const el = {
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    removeEventListener: () => undefined,
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
    style: {},
  } as unknown as HTMLElement;
  return { el, fire: (type, event) => listeners.get(type)?.(event) };
}

let originalWindow: unknown;

beforeEach(() => {
  originalWindow = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).window = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

afterEach(() => {
  (globalThis as Record<string, unknown>).window = originalWindow;
});

function makeRig(): OrbitRig {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  return new OrbitRig(camera, {
    domElement: stubElement().el,
    initial: { theta: 0, phi: Math.PI / 2, distance: 3 },
  });
}

describe('OrbitRig.orbitBy', () => {
  it('advances the azimuth by exactly the delta given', () => {
    const rig = makeRig();
    rig.orbitBy(0.25);
    expect(rig.state.theta).toBeCloseTo(0.25, 6);
    rig.orbitBy(0.25);
    expect(rig.state.theta).toBeCloseTo(0.5, 6);
    rig.dispose();
  });

  it('leaves polar angle and distance untouched', () => {
    // Ambient rotation must not drift the camera toward a pole or change zoom;
    // a reader who framed a region should find it framed the same way.
    const rig = makeRig();
    const before = rig.state;
    rig.orbitBy(1.5);
    expect(rig.state.phi).toBeCloseTo(before.phi, 6);
    expect(rig.state.distance).toBeCloseTo(before.distance, 6);
    rig.dispose();
  });

  it('does nothing when the rig is disabled', () => {
    const rig = makeRig();
    rig.enabled = false;
    rig.orbitBy(0.4);
    expect(rig.state.theta).toBeCloseTo(0, 6);
    rig.dispose();
  });

  it('does nothing for a zero delta, so an idle frame is free', () => {
    const rig = makeRig();
    let renders = 0;
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    const counted = new OrbitRig(camera, {
      domElement: stubElement().el,
      initial: { theta: 0, phi: Math.PI / 2, distance: 3 },
      onChange: () => renders++,
    });
    counted.orbitBy(0);
    expect(renders).toBe(0);
    counted.orbitBy(0.1);
    expect(renders).toBe(1);
    counted.dispose();
    rig.dispose();
  });
});

describe('onUserInput reports what KIND of manipulation began', () => {
  it('calls a drag a drag and a wheel a wheel', () => {
    // The ambient rotation pauses on 'drag' only. Collapsing these back into
    // one undifferentiated signal is what made the globe stop dead on every
    // scroll — a pause with no visible cause, since zoom does not move the
    // axis the drift turns on.
    const { el, fire } = stubElement();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    const sources: string[] = [];
    const rig = new OrbitRig(camera, {
      domElement: el,
      initial: { theta: 0, phi: Math.PI / 2, distance: 3 },
      onUserInput: (source) => sources.push(source),
    });

    fire('wheel', { deltaY: 100, preventDefault: () => undefined });
    expect(sources).toEqual(['wheel']);

    fire('pointerdown', {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
      pointerType: 'mouse',
      preventDefault: () => undefined,
    });
    expect(sources).toEqual(['wheel', 'drag']);

    rig.dispose();
  });
});
