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
  globalFactors: readonly GlobalFactor[];
  landVisible: boolean;
  onPickFactor: (id: string) => void;
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
  globalFactors,
  landVisible,
  onPickFactor,
  onInterrupt,
}: UseSceneOptions): void {
  const pickRef = useRef(onPickFactor);
  const interruptRef = useRef(onInterrupt);
  useEffect(() => {
    pickRef.current = onPickFactor;
    interruptRef.current = onInterrupt;
  }, [onPickFactor, onInterrupt]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const handle = createScene(mount, {
      onPickFactor: (id) => pickRef.current(id),
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

  useEffect(() => {
    sceneRef.current?.setLandVisible(landVisible);
  }, [landVisible, sceneRef]);
}
