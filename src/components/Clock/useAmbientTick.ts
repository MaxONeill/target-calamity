import { useCallback, useEffect, useRef, useState } from 'react';
import { createTickEngine, type TickEngine } from '../../audio/tick.js';

export interface AmbientTick {
  soundEnabled: boolean;
  toggleSound: () => void;
  /** Notifies the tick that a modal opened or closed, so it can pause. */
  setModalOpen: (open: boolean) => void;
}

/**
 * Owns the ambient tick lifecycle.
 *
 * The audio graph is created lazily on the enabling click, because autoplay
 * policy requires a user gesture, and is disposed on unmount since the page is
 * expected to sit open for hours. The tick halts while a modal is open and
 * resumes only if the user had it enabled.
 */
export function useAmbientTick(): AmbientTick {
  const engineRef = useRef<TickEngine | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    return () => {
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  const toggleSound = useCallback(() => {
    setSoundEnabled((wasEnabled) => {
      const nextEnabled = !wasEnabled;
      if (nextEnabled) {
        const engine = (engineRef.current ??= createTickEngine());
        if (!modalOpen) engine.start();
      } else {
        engineRef.current?.stop();
      }
      return nextEnabled;
    });
  }, [modalOpen]);

  const handleModalOpenChange = useCallback(
    (open: boolean) => {
      setModalOpen(open);
      const engine = engineRef.current;
      if (!engine) return;
      if (open) engine.stop();
      else if (soundEnabled) engine.start();
    },
    [soundEnabled],
  );

  return { soundEnabled, toggleSound, setModalOpen: handleModalOpenChange };
}
