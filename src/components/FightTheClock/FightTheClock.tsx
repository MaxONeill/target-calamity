import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import './FightTheClock.css';

/**
 * The link people share and rally around.
 * TODO: point at the canonical public URL once the domain is live.
 */
const SHARE_URL = 'https://targetcalamity.com';
const SHARE_TITLE = 'Fight the Clock';
/** The copyable one-liner shown in the share field. */
const SHARE_TEXT = `${SHARE_TITLE}: ${SHARE_URL}`;

/**
 * Invite to the community server.
 * TODO: replace with the real Discord invite.
 */
const DISCORD_URL = 'https://discord.gg/REPLACE_ME';

/**
 * Share targets, each a platform share-intent URL. Chosen for a grassroots
 * organizing audience: activism (X, Bluesky, Reddit), messaging (WhatsApp,
 * Telegram), professional (LinkedIn), broad reach (Facebook), and email as the
 * universal fallback. The native Web Share API is offered on top when available.
 */
const SHARE_TARGETS: ReadonlyArray<{ name: string; color: string; href: string }> = (() => {
  const url = encodeURIComponent(SHARE_URL);
  const title = encodeURIComponent(SHARE_TITLE);
  const textUrl = encodeURIComponent(`${SHARE_TITLE} ${SHARE_URL}`);
  return [
    { name: 'X', color: '#000000', href: `https://twitter.com/intent/tweet?url=${url}&text=${title}` },
    { name: 'Facebook', color: '#1877F2', href: `https://www.facebook.com/sharer/sharer.php?u=${url}` },
    { name: 'LinkedIn', color: '#0A66C2', href: `https://www.linkedin.com/sharing/share-offsite/?url=${url}` },
    { name: 'Reddit', color: '#FF4500', href: `https://www.reddit.com/submit?url=${url}&title=${title}` },
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
 * A call-to-action that opens a share + join dialog: copy the link, push it to a
 * social platform, or jump into the Discord.
 *
 * It collects nothing, so there is no data-handling surface — the trigger is
 * positioned by its parent slot; the dialog is portalled to the body.
 */
export function FightTheClock(): JSX.Element {
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

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="tc-fight__trigger"
        onClick={openShare}
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

              <div className="tc-fight__body">
                <p className="tc-fight__intro">
                  Something has to be done, and it&apos;ll take out-of-the-box thinking.
                  We may not know what exactly to do, but we know it&apos;ll be easier
                  together. Spread the word and let&apos;s see who steps up.
                </p>

                <div className="tc-fight__share-field">
                  <input
                    ref={urlRef}
                    className="tc-fight__url"
                    type="text"
                    readOnly
                    value={SHARE_TEXT}
                    aria-label="Shareable link"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <button type="button" className="tc-fight__copy" onClick={onCopy}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>

                <ul className="tc-fight__targets">
                  {canNativeShare ? (
                    <li>
                      <button
                        type="button"
                        className="tc-fight__target tc-fight__target--native"
                        onClick={onNativeShare}
                      >
                        Share…
                      </button>
                    </li>
                  ) : null}
                  {SHARE_TARGETS.map((target) => (
                    <li key={target.name}>
                      <a
                        className="tc-fight__target"
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

                <div className="tc-fight__join">
                  <h3 className="tc-fight__join-title">Join the Conversation</h3>
                  <a
                    className="tc-fight__discord"
                    href={DISCORD_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Join our Discord
                  </a>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

export default FightTheClock;
