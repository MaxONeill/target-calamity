import type { FieldPin } from '../../shared/types.js';

export interface SceneHandle {
  /**
   * Rewrites the shader's field input. The only entry point that does so —
   * never call it from a camera, scroll, sort or selection path, or the globe
   * stops being a function of the data alone.
   */
  setFieldPins(pins: readonly FieldPin[]): void;
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
