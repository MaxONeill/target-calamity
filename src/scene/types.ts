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
  /**
   * Marks the field as applied. Gates both the reveal and the ambient
   * rotation — see the implementation in createScene.
   */
  setFieldReady(ready: boolean): void;
  /** Emphasizes the hovered factor (pin or ring arc), or clears it with null. */
  setHighlighted(id: string | null): void;
  /** Emphasizes the selected factor (pin or ring arc), or clears it with null. */
  setSelected(id: string | null): void;
  alignToLatLon(lat: number, lon: number): void;
  setLandVisible(visible: boolean): void;
  dispose(): void;
}

export interface SceneCallbacks {
  /** A pin or ring arc was picked. Receives the factor id under the pointer. */
  onPickFactor(id: string): void;
  /** The hovered factor changed. Null when the pointer left every target. */
  onHoverFactor(id: string | null): void;
  /**
   * EVERY factor whose pin sits under or beside the pointer, nearest first,
   * with the client-space cursor position to anchor a peek to.
   *
   * Separate from {@link onHoverFactor} because they answer different
   * questions: that one drives the single-pin emphasis in the scene, this one
   * drives a DOM list. Empty array when the pointer is over no pin.
   */
  onHoverPins(ids: readonly string[], clientX: number, clientY: number): void;
  /** Manual camera input dropped an in-flight alignment lock. */
  onInterrupt(): void;
}
