import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
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
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const titleId = useId();

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const openForm = useCallback(() => {
    setForm(EMPTY);
    setSubmitted(false);
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    firstFieldRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

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
              className="tc-fight__dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
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
