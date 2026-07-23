import type { FieldPin, GlobalFactor } from '../../shared/types.js';

export interface SceneHandle {
  /**
   * Rewrites the shader's field input. The only entry point that does so —
   * never call it from a camera, scroll, sort or selection path, or the globe
   * stops being a function of the data alone.
   */
  setFieldPins(pins: readonly FieldPin[]): void;
  /**
   * Sets the placeless factors: the ring arcs, and the uniform global wash.
   * Same rule as {@link setFieldPins} — data-driven only.
   */
  setGlobalFactors(factors: readonly GlobalFactor[]): void;
  alignToLatLon(lat: number, lon: number): void;
  setLandVisible(visible: boolean): void;
  dispose(): void;
}

export interface SceneCallbacks {
  /** A pin was picked. Receives the factor id under the pointer. */
  onPickFactor(id: string): void;
  /** Manual camera input dropped an in-flight alignment lock. */
  onInterrupt(): void;
}
