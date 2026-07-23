/**
 * Clock explainer meta-system (comprehensive §7 / v3.2 §4).
 *
 * Self-contained: renders BOTH the `[ i ]` trigger glyph (absolute top-right of
 * its positioned container — the Clock places it) AND the modal it opens. The
 * modal is a full-height, scannable panel over a blurred backdrop; it is
 * `aria-modal`, focus-trapped, and closes on Escape or backdrop click, restoring
 * focus to the trigger. Copy is transcribed verbatim in `explainerCopy.ts`.
 *
 * `onOpenChange` lets the parent halt the ambient tick while the modal is open
 * (spec: "halts the background ambient clock ticking sound").
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { EXPLAINER_COPY } from './explainerCopy.js';

export interface ExplainerModalProps {
  /** Notified whenever the modal opens (`true`) or closes (`false`). */
  onOpenChange?: (open: boolean) => void;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function ExplainerModal({ onOpenChange }: ExplainerModalProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const setOpenState = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  const openModal = useCallback(() => setOpenState(true), [setOpenState]);
  const closeModal = useCallback(() => setOpenState(false), [setOpenState]);

  // Move focus into the panel on open; restore it to the trigger on close. Also
  // lock body scroll so the backdrop reads as a true modal layer.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.focus();

    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = 'hidden';

    return () => {
      body.style.overflow = previousOverflow;
      // Prefer the trigger; fall back to whatever had focus before opening.
      (triggerRef.current ?? previouslyFocused)?.focus();
    };
  }, [open]);

  // Escape to close + a focus trap that keeps Tab within the panel.
  const onPanelKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeModal();
        return;
      }
      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || active === panel) {
          event.preventDefault();
          last?.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first?.focus();
      }
    },
    [closeModal],
  );

  const modal = open ? (
    <div
      className="tc-explainer-backdrop"
      onMouseDown={(event) => {
        // Backdrop click closes; clicks that originate inside the panel do not.
        if (event.target === event.currentTarget) closeModal();
      }}
    >
      <div
        ref={panelRef}
        className="tc-explainer-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onPanelKeyDown}
      >
        <header className="tc-explainer-header">
          <h2 id={titleId} className="tc-explainer-title">
            {EXPLAINER_COPY.title}
          </h2>
          <button
            type="button"
            className="tc-explainer-close"
            onClick={closeModal}
            aria-label="Close explainer"
          >
            [ x ]
          </button>
        </header>

        <div className="tc-explainer-body">
          {EXPLAINER_COPY.sections.map((section) => (
            <section key={section.heading} className="tc-explainer-section">
              <h3 className="tc-explainer-section-heading">{section.heading}</h3>
              <p className="tc-explainer-section-body">{section.body}</p>
            </section>
          ))}
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="tc-explainer-trigger"
        onClick={openModal}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="About the Clock model"
        title="About the Clock model"
      >
        [ i ]
      </button>
      {modal ? createPortal(modal, document.body) : null}
    </>
  );
}

export default ExplainerModal;
