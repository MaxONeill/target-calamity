import { useEffect, useRef, type MutableRefObject, type RefObject } from 'react';
import { createScene } from '../scene/createScene.js';
import type { SceneHandle } from '../scene/types.js';
import type { FieldPin, GlobalFactor } from '../../shared/types.js';

export interface UseSceneOptions {
  mountRef: RefObject<HTMLDivElement>;
  /**
   * Populated with the live scene handle. Owned by the caller so imperative
   * callers (camera alignment) can be defined before this hook runs.
   */
  sceneRef: MutableRefObject<SceneHandle | null>;
  fieldPins: readonly FieldPin[];
  /** First field fetch has settled — gates the reveal and the ambient rotation. */
  fieldReady: boolean;
  globalFactors: readonly GlobalFactor[];
  /** The selected factor id, emphasized in the scene. Null when none. */
  selectedId: string | null;
  landVisible: boolean;
  onPickFactor: (id: string) => void;
  /** The hovered factor changed (null when the pointer is over nothing). */
  onHoverFactor: (id: string | null) => void;
  /** Every pin under/near the pointer, nearest first, plus the cursor position. */
  onHoverPins: (ids: readonly string[], clientX: number, clientY: number) => void;
  onInterrupt: () => void;
}

/**
 * Owns the three.js scene lifecycle and keeps it in sync with React state.
 *
 * The scene is created once. Callbacks reach current React state through refs
 * rather than by rebuilding the scene, because tearing down a WebGL context on
 * every handler change would be ruinous.
 */
export function useScene({
  mountRef,
  sceneRef,
  fieldPins,
  fieldReady,
  globalFactors,
  selectedId,
  landVisible,
  onPickFactor,
  onHoverFactor,
  onHoverPins,
  onInterrupt,
}: UseSceneOptions): void {
  const pickRef = useRef(onPickFactor);
  const hoverRef = useRef(onHoverFactor);
  const hoverPinsRef = useRef(onHoverPins);
  const interruptRef = useRef(onInterrupt);
  useEffect(() => {
    pickRef.current = onPickFactor;
    hoverRef.current = onHoverFactor;
    hoverPinsRef.current = onHoverPins;
    interruptRef.current = onInterrupt;
  }, [onPickFactor, onHoverFactor, onHoverPins, onInterrupt]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const handle = createScene(mount, {
      onPickFactor: (id) => pickRef.current(id),
      onHoverFactor: (id) => hoverRef.current(id),
      onHoverPins: (ids, x, y) => hoverPinsRef.current(ids, x, y),
      onInterrupt: () => interruptRef.current(),
    });
    sceneRef.current = handle;

    return () => {
      handle.dispose();
      sceneRef.current = null;
    };
  }, [mountRef, sceneRef]);

  useEffect(() => {
    sceneRef.current?.setFieldPins(fieldPins);
  }, [fieldPins, sceneRef]);

  useEffect(() => {
    sceneRef.current?.setGlobalFactors(globalFactors);
  }, [globalFactors, sceneRef]);

  // AFTER the pin/global effects above, so the shader has been written before
  // the globe is revealed. Effects run in declaration order, which is what
  // makes "ready" mean the field is actually on screen rather than merely
  // fetched.
  useEffect(() => {
    sceneRef.current?.setFieldReady(fieldReady);
  }, [fieldReady, sceneRef]);

  useEffect(() => {
    sceneRef.current?.setSelected(selectedId);
  }, [selectedId, sceneRef]);

  useEffect(() => {
    sceneRef.current?.setLandVisible(landVisible);
  }, [landVisible, sceneRef]);
}
