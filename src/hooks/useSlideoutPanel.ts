import { useCallback, useEffect, useState } from 'react';

/** What the single right-hand slideout is currently showing. */
export type PanelMode = 'feed' | 'detail' | 'submit';

export interface SlideoutPanel {
  open: boolean;
  mode: PanelMode;
  selectedId: string | null;
  openFeed: () => void;
  openSubmit: () => void;
  closeSubmit: () => void;
  closePanel: () => void;
  /** Selects a factor and reveals its detail, dismissing the submission form. */
  selectFactor: (id: string) => void;
  clearSelection: () => void;
}

/**
 * Drives the one slideout that hosts the feed, a factor's detail, or the
 * submission form — never more than one at a time.
 *
 * Escape unwinds the layers one at a time: submit → detail → closed. Detail is
 * excluded here because FactorDetails owns Escape while it is showing and stops
 * propagation, so handling it here too would skip a layer.
 */
export function useSlideoutPanel(): SlideoutPanel {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);

  const mode: PanelMode = submitOpen ? 'submit' : selectedId !== null ? 'detail' : 'feed';

  const selectFactor = useCallback((id: string) => {
    setSelectedId(id);
    setOpen(true);
    setSubmitOpen(false);
  }, []);

  const openSubmit = useCallback(() => {
    setSubmitOpen(true);
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    if (mode === 'detail') return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (submitOpen) setSubmitOpen(false);
      else setOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, mode, submitOpen]);

  return {
    open,
    mode,
    selectedId,
    openFeed: useCallback(() => setOpen(true), []),
    openSubmit,
    closeSubmit: useCallback(() => setSubmitOpen(false), []),
    closePanel: useCallback(() => setOpen(false), []),
    selectFactor,
    clearSelection: useCallback(() => setSelectedId(null), []),
  };
}
