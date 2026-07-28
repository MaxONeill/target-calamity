import type React from 'react';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import './Share.css';

/**
 * The link people share.
 * TODO: point at the canonical public URL once the domain is live.
 */
const SHARE_URL = 'https://targetcalamity.com';

/**
 * What a shared link says about itself.
 *
 * Was "Fight the Clock" — a rallying cry, which is the one thing this share
 * text should not be. A link posted to a stranger's feed is the project's first
 * impression, and a slogan asks them to join something before it has told them
 * what it is. The site's own <meta name="description"> already says what it is,
 * so this echoes it: the name, then the claim it actually makes.
 */
const SHARE_TITLE = 'Target: Calamity';
const SHARE_BLURB =
  "an empirical tracker of humanity's window of viable course-correction against cascading systemic tipping points";
/** The copyable one-liner shown in the share field. */
const SHARE_TEXT = `${SHARE_TITLE} — ${SHARE_BLURB}. ${SHARE_URL}`;

/**
 * Share targets, each a platform share-intent URL. Chosen for a grassroots
 * organizing audience: activism (X, Bluesky, Reddit), messaging (WhatsApp,
 * Telegram), professional (LinkedIn), broad reach (Facebook), and email as the
 * universal fallback. The native Web Share API is offered on top when available.
 */
const SHARE_TARGETS: ReadonlyArray<{ name: string; color: string; href: string }> = (() => {
  const url = encodeURIComponent(SHARE_URL);
  // Platforms that render their own link preview (X, Facebook, LinkedIn) get the
  // bare title, since the blurb would duplicate the description they unfurl.
  // Plain-text targets get the full line, where nothing unfurls it for them.
  const title = encodeURIComponent(SHARE_TITLE);
  const textUrl = encodeURIComponent(`${SHARE_TITLE} — ${SHARE_BLURB}. ${SHARE_URL}`);
  return [
    {
      name: 'X',
      color: '#000000',
      href: `https://twitter.com/intent/tweet?url=${url}&text=${title}`,
    },
    {
      name: 'Facebook',
      color: '#1877F2',
      href: `https://www.facebook.com/sharer/sharer.php?u=${url}`,
    },
    {
      name: 'LinkedIn',
      color: '#0A66C2',
      href: `https://www.linkedin.com/sharing/share-offsite/?url=${url}`,
    },
    {
      name: 'Reddit',
      color: '#FF4500',
      href: `https://www.reddit.com/submit?url=${url}&title=${title}`,
    },
    { name: 'WhatsApp', color: '#25D366', href: `https://api.whatsapp.com/send?text=${textUrl}` },
    { name: 'Telegram', color: '#26A5E4', href: `https://t.me/share/url?url=${url}&text=${title}` },
    { name: 'Bluesky', color: '#1185FE', href: `https://bsky.app/intent/compose?text=${textUrl}` },
    { name: 'Email', color: '#6b7280', href: `mailto:?subject=${title}&body=${textUrl}` },
  ];
})();

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * A share dialog: copy the link or push it to a social platform.
 *
 * It collects nothing, so there is no data-handling surface. The trigger is a
 * topbar link beside SOURCE; the dialog is portalled to the body.
 */
export function Share(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [canNativeShare, setCanNativeShare] = useState(false);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const titleId = useId();

  useEffect(() => {
    setCanNativeShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  }, []);

  const close = useCallback(() => setOpen(false), []);
  const openShare = useCallback(() => {
    setCopied(false);
    setOpen(true);
  }, []);

  // Focus into the dialog on open, lock body scroll, restore focus on close.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    urlRef.current?.focus();
    urlRef.current?.select();

    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = 'hidden';

    return () => {
      body.style.overflow = previousOverflow;
      // Read at CLEANUP time on purpose — focus should return to the trigger as
      // it exists when the panel closes, not to the node captured on open.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      (triggerRef.current ?? previouslyFocused)?.focus();
    };
  }, [open]);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(SHARE_TEXT);
      setCopied(true);
    } catch {
      // Clipboard blocked — the field is selectable as a manual fallback.
      urlRef.current?.select();
    }
  }, []);

  const onNativeShare = useCallback(() => {
    void navigator.share?.({ title: SHARE_TITLE, url: SHARE_URL }).catch(() => {});
  }, []);

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
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
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

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="tc-share__trigger"
        onClick={openShare}
        aria-haspopup="dialog"
      >
        SHARE
      </button>

      {open &&
        createPortal(
          <div
            className="tc-share__backdrop"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) close();
            }}
          >
            <div
              ref={dialogRef}
              className="tc-share__dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              tabIndex={-1}
              onKeyDown={onDialogKeyDown}
            >
              <div className="tc-share__head">
                <h2 id={titleId} className="tc-share__title">
                  Share
                </h2>
                <button
                  type="button"
                  className="tc-share__close"
                  onClick={close}
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>

              <div className="tc-share__body">
                {/* The old copy ended "the first step is showing up", which
                    pointed at the Discord invite below it. With that gone the
                    line had nowhere to send anyone, so it says what sharing
                    actually does instead of implying a destination. */}
                <p className="tc-share__intro">
                  Something has to be done, and it&apos;ll take out-of-the-box thinking. We may not
                  know exactly what to do, but we know it&apos;ll be easier together.{' '}
                  <b>Passing this on is a start</b>.
                </p>

                <div className="tc-share__share-field">
                  <input
                    ref={urlRef}
                    className="tc-share__url"
                    type="text"
                    readOnly
                    value={SHARE_TEXT}
                    aria-label="Shareable link"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  {/* `void`: onCopy handles its own failure (it falls back to
                      selecting the field), so the promise is intentionally not
                      awaited here. Same pattern as onNativeShare. */}
                  <button type="button" className="tc-share__copy" onClick={() => void onCopy()}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>

                {/* The "Join the Conversation" heading and Discord invite that
                    sat below this are gone. Nothing replaces them: a community
                    link is a promise to run a community, and there is no reason
                    for the share dialog to make one. */}
                <ul className="tc-share__targets">
                  {canNativeShare ? (
                    <li>
                      <button
                        type="button"
                        className="tc-share__target tc-share__target--native"
                        onClick={onNativeShare}
                      >
                        Share…
                      </button>
                    </li>
                  ) : null}
                  {SHARE_TARGETS.map((target) => (
                    <li key={target.name}>
                      <a
                        className="tc-share__target"
                        style={{ backgroundColor: target.color }}
                        href={target.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Share on ${target.name}`}
                      >
                        {target.name}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

export default Share;
