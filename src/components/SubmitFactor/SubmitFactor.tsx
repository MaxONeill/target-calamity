import type React from 'react';
/**
 * SubmitFactor — the anonymous Phase-1 submission form.
 *
 * Compact, keyboard-accessible, and deliberately minimal: a claim, the source
 * that backs it, and an optional note. It does NOT offer effect, significance,
 * verification state, or coordinates — those are assigned by the vetting
 * pipeline, and the server's `.strict()` schema rejects them outright. The form
 * says so in plain language rather than leaving the omission unexplained.
 *
 * The device id is a UUID generated once and persisted in localStorage. It is
 * one half of the (hashed) rate-limit identity; it is not an account, it proves
 * nothing, and the copy does not pretend otherwise.
 *
 * Response handling is deliberately incurious: the component shows the server's
 * message for whatever outcome comes back and never tries to infer more. A
 * shadow-banned submitter receives the identical `received` payload a genuine
 * one does, so there is nothing here that could distinguish them even by
 * accident.
 */
import { useCallback, useId, useState } from 'react';
import {
  FactorSubmissionSchema,
  SubmissionResponseSchema,
  SUBMISSION_CLAIM_MAX,
  SUBMISSION_CLAIM_MIN,
  SUBMISSION_NOTE_MAX,
} from '../../../shared/schema.js';
import type { SubmissionResponse } from '../../../shared/types.js';
import './SubmitFactor.css';

/** localStorage key holding the persistent device id. */
const DEVICE_ID_KEY = 'tc.deviceId';

/**
 * Read (or mint) the device id. Wrapped in try/catch because localStorage throws
 * in private-mode/blocked-storage contexts; a per-session id is then the honest
 * degradation — the submitter is limited by IP alone rather than being blocked.
 */
export function getDeviceId(): string {
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const minted = crypto.randomUUID();
    window.localStorage.setItem(DEVICE_ID_KEY, minted);
    return minted;
  } catch {
    return crypto.randomUUID();
  }
}

type FormState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'done'; response: SubmissionResponse }
  | { kind: 'error'; message: string };

export interface SubmitFactorProps {
  /** Called when the submitter dismisses the form. */
  onClose: () => void;
}

export function SubmitFactor({ onClose }: SubmitFactorProps): React.JSX.Element {
  const claimId = useId();
  const urlId = useId();
  const noteId = useId();

  const [claim, setClaim] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [note, setNote] = useState('');
  const [state, setState] = useState<FormState>({ kind: 'idle' });

  const submitting = state.kind === 'submitting';

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      if (submitting) return;

      // Validate against the SAME schema the server uses so the
      // submitter gets immediate feedback and we never spend a round trip on a
      // request we already know is invalid.
      const payload = {
        claim: claim.trim(),
        sourceUrl: sourceUrl.trim(),
        ...(note.trim() ? { note: note.trim() } : {}),
        deviceId: getDeviceId(),
      };
      const parsed = FactorSubmissionSchema.safeParse(payload);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        setState({
          kind: 'error',
          message: first
            ? `${String(first.path[0] ?? 'input')}: ${first.message}`
            : 'Invalid input.',
        });
        return;
      }

      setState({ kind: 'submitting' });

      // THREE DISTINCT FAILURES, THREE DISTINCT MESSAGES. A single try/catch
      // around the whole exchange used to report all of them as "Could not reach
      // the server", which was actively misleading: `res.json()` throws on ANY
      // non-JSON body, so an API that was reached and answered — a dev-proxy 502,
      // a gateway error page, an empty body — was reported as unreachable, and
      // the one diagnosis the message offered was the one thing that had not
      // happened. Whether the request left the machine is exactly the fact a
      // submitter needs to know, so it is now determined separately.
      let res: Response;
      try {
        res = await fetch('/api/factors/submit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(parsed.data),
        });
      } catch {
        // Genuinely never got an answer: offline, DNS, connection refused.
        setState({
          kind: 'error',
          message: 'Could not reach the server. Check your connection and try again.',
        });
        return;
      }

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        // Something answered, but not with JSON. Carrying the status is what
        // makes this diagnosable at all — a 502 here means the API behind the
        // proxy is down, which looks identical to every other failure without it.
        setState({
          kind: 'error',
          message: `The server returned an unreadable response (HTTP ${String(res.status)}). It may be restarting.`,
        });
        return;
      }

      // Parsed BEFORE any `res.ok` check, on purpose: a 429 rate-limit is a
      // legitimate, contract-shaped answer that the submitter should see in full,
      // and treating every non-2xx as an error would replace its "try again in
      // about N hours" with something vaguer.
      const body = SubmissionResponseSchema.safeParse(json);
      if (body.success) {
        setState({ kind: 'done', response: body.data });
        return;
      }

      // JSON, but not the contract. A 400 means this form and the server disagree
      // about the schema, which a reload usually fixes; anything else is a fault
      // on their side that retrying might not.
      setState({
        kind: 'error',
        message:
          res.status === 400
            ? 'The server rejected this submission as malformed. Reload the page — this build may be out of date.'
            : `The server sent an unexpected response (HTTP ${String(res.status)}).`,
      });
    },
    [claim, sourceUrl, note, submitting],
  );

  if (state.kind === 'done') {
    const { outcome, message } = state.response;
    return (
      <div className="tc-submit">
        <header className="tc-submit__header">
          <h2 className="tc-submit__title">Submit a factor</h2>
          <button type="button" className="tc-submit__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div
          className={`tc-submit__result tc-submit__result--${outcome}`}
          role="status"
          aria-live="polite"
        >
          <p className="tc-submit__result-msg">{message}</p>
          {/*
            NO "Submit another" BUTTON. It used to sit here unconditionally, and
            it could never do what it said: every outcome that reaches this screen
            has already spent the day's allowance — `queued`, `duplicate` and
            `rejected` all count toward the 24h window, and `rate_limited` means
            it was already spent. So the button returned to a form whose next
            submission was guaranteed to be refused. Worse, until the
            accompanying store fix, that refusal RESET the 24h clock, so taking
            the invitation locked the submitter out for another full day.
            The honest affordance is to close.
          */}
          {outcome !== 'rate_limited' && (
            <p className="tc-submit__result-note">
              That is your submission for today — one per day, so the queue stays reviewable by
              hand.
            </p>
          )}
          <button type="button" className="tc-submit__btn tc-submit__btn--ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="tc-submit">
      <header className="tc-submit__header">
        <h2 className="tc-submit__title">Submit a factor</h2>
        <button type="button" className="tc-submit__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      <p className="tc-submit__intro">
        One claim per day, no account needed. You supply the claim and the source; the system
        assigns everything else — direction, weight, location, and whether it is verified — after
        checking the claim against that source.
      </p>

      <form className="tc-submit__form" onSubmit={(e) => void handleSubmit(e)}>
        <label className="tc-submit__label" htmlFor={claimId}>
          Claim
        </label>
        <textarea
          id={claimId}
          className="tc-submit__textarea"
          value={claim}
          onChange={(e) => setClaim(e.target.value)}
          rows={4}
          maxLength={SUBMISSION_CLAIM_MAX}
          minLength={SUBMISSION_CLAIM_MIN}
          required
          disabled={submitting}
          placeholder="One factual statement about the state of the world."
        />
        <div className="tc-submit__counter" aria-hidden="true">
          {claim.trim().length}/{SUBMISSION_CLAIM_MAX}
        </div>

        <label className="tc-submit__label" htmlFor={urlId}>
          Source URL
        </label>
        <input
          id={urlId}
          className="tc-submit__input"
          type="url"
          inputMode="url"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          required
          disabled={submitting}
          placeholder="https://"
        />

        <label className="tc-submit__label" htmlFor={noteId}>
          Note <span className="tc-submit__optional">(optional)</span>
        </label>
        <input
          id={noteId}
          className="tc-submit__input"
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={SUBMISSION_NOTE_MAX}
          disabled={submitting}
          placeholder="Anything a reviewer should know."
        />

        {state.kind === 'error' ? (
          <p className="tc-submit__error" role="alert">
            {state.message}
          </p>
        ) : null}

        <button type="submit" className="tc-submit__btn" disabled={submitting}>
          {submitting ? 'Sending…' : 'Submit'}
        </button>
      </form>

      <p className="tc-submit__note">
        Submitting stores a one-way hash of your address and a random id kept in this browser —
        never the address itself. It is used only to enforce the daily limit.
      </p>
    </div>
  );
}

export default SubmitFactor;
