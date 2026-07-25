import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import './FightTheClock.css';

interface PledgeForm {
  name: string;
  email: string;
  canDo: string;
  holdsBack: string;
}

const EMPTY: PledgeForm = { name: '', email: '', canDo: '', holdsBack: '' };

/**
 * Address shown in the privacy notice for data-deletion requests. Must be a real
 * inbox someone monitors — it is the opt-out path people are entitled to.
 * TODO: replace with the project's actual contact address.
 */
const CONTACT_EMAIL = 'contact@example.com';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * A call-to-action that opens a short pledge form: who you are and how you can
 * help push the Clock back.
 *
 * The submission is only logged for now — wiring it to a form-collection service
 * is a later step. The trigger is positioned by its parent slot; the dialog is
 * portalled to the body so it is unaffected by that positioning.
 */
export function FightTheClock(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [form, setForm] = useState<PledgeForm>(EMPTY);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const titleId = useId();

  const close = useCallback(() => setOpen(false), []);

  const openForm = useCallback(() => {
    setForm(EMPTY);
    setSubmitted(false);
    setOpen(true);
  }, []);

  // Move focus into the dialog on open, lock body scroll so the backdrop reads
  // as a true modal layer, and restore focus to the trigger on close.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    firstFieldRef.current?.focus();

    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = 'hidden';

    return () => {
      body.style.overflow = previousOverflow;
      (triggerRef.current ?? previouslyFocused)?.focus();
    };
  }, [open]);

  // Escape closes; Tab is trapped so focus cannot leave the dialog.
  const onDialogKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== 'Tab') return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || active === dialog) {
          event.preventDefault();
          last?.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first?.focus();
      }
    },
    [close],
  );

  const update =
    (field: keyof PledgeForm) =>
    (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
      const { value } = e.target;
      setForm((prev) => ({ ...prev, [field]: value }));
    };

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    // TODO: POST to a form-collection service once one is chosen. For now, log.
    console.log('[fight-the-clock] pledge submitted', { ...form });
    setSubmitted(true);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="tc-fight__trigger"
        onClick={openForm}
        aria-haspopup="dialog"
      >
        Fight the Clock
      </button>

      {open &&
        createPortal(
          <div
            className="tc-fight__backdrop"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) close();
            }}
          >
            <div
              ref={dialogRef}
              className="tc-fight__dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              tabIndex={-1}
              onKeyDown={onDialogKeyDown}
            >
              <div className="tc-fight__head">
                <h2 id={titleId} className="tc-fight__title">
                  Fight the Clock
                </h2>
                <button
                  type="button"
                  className="tc-fight__close"
                  onClick={close}
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>

              {submitted ? (
                <div className="tc-fight__thanks" role="status">
                  <p className="tc-fight__thanks-text">
                    Thank you — your pledge was recorded.
                  </p>
                  <button type="button" className="tc-fight__submit" onClick={close}>
                    Close
                  </button>
                </div>
              ) : (
                <form className="tc-fight__form" onSubmit={onSubmit}>
                  <p className="tc-fight__intro">
                    Something has to be done, and it&apos;ll take out-of-the-box
                    thinking. We may not know what exactly to do, but we know it&apos;ll
                    be easier together. Let&apos;s see who steps up and go from there.
                  </p>

                  <label className="tc-fight__field">
                    <span className="tc-fight__label">Name</span>
                    <input
                      ref={firstFieldRef}
                      className="tc-fight__input"
                      type="text"
                      value={form.name}
                      onChange={update('name')}
                      autoComplete="name"
                    />
                  </label>

                  <label className="tc-fight__field">
                    <span className="tc-fight__label">Email</span>
                    <input
                      className="tc-fight__input"
                      type="email"
                      required
                      value={form.email}
                      onChange={update('email')}
                      autoComplete="email"
                    />
                  </label>

                  <label className="tc-fight__field">
                    <span className="tc-fight__label">What can you do?</span>
                    <textarea
                      className="tc-fight__textarea"
                      rows={3}
                      value={form.canDo}
                      onChange={update('canDo')}
                      placeholder="Skills, time, resources, reach…"
                    />
                  </label>

                  <label className="tc-fight__field">
                    <span className="tc-fight__label">What holds you back?</span>
                    <textarea
                      className="tc-fight__textarea"
                      rows={3}
                      value={form.holdsBack}
                      onChange={update('holdsBack')}
                      placeholder="What stops you from acting today?"
                    />
                  </label>

                  <div className="tc-fight__notice">
                    <span className="tc-fight__notice-line">
                      We&apos;ll only use this to contact you about the project — never
                      sold or shared.
                    </span>
                    <details className="tc-fight__privacy">
                      <summary className="tc-fight__privacy-summary">Privacy</summary>
                      <div className="tc-fight__privacy-body">
                        <p>
                          <strong>What we collect:</strong> your name, email, and the
                          answers above.
                        </p>
                        <p>
                          <strong>Why:</strong> only to reach out about this project and
                          coordinate who&apos;s helping — nothing else. We don&apos;t sell
                          or share it.
                        </p>
                        <p>
                          <strong>Removal:</strong> ask us to delete your details at any
                          time at{' '}
                          <a className="tc-fight__privacy-link" href={`mailto:${CONTACT_EMAIL}`}>
                            {CONTACT_EMAIL}
                          </a>
                          .
                        </p>
                      </div>
                    </details>
                  </div>

                  <div className="tc-fight__actions">
                    <button type="button" className="tc-fight__cancel" onClick={close}>
                      Cancel
                    </button>
                    <button type="submit" className="tc-fight__submit">
                      Send
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

export default FightTheClock;
