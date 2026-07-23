/**
 * Offline tests for the submitter-identity helpers (ADR-45). No network, no DB.
 *
 * These cover the parts whose failure modes are silent: a hash that is not
 * deterministic makes bans and rate limits useless; a window boundary that is
 * off by one lets a submitter post twice; an IP resolver that trusts a header it
 * should not hands out a free identity per request.
 */
import { describe, expect, it } from 'vitest';
import {
  hashIdentity,
  isValidDeviceId,
  isWithinWindow,
  normalizeSubmission,
  readSubmissionSalt,
  resolveClientIp,
  retryAfterSeconds,
  SUBMISSION_WINDOW_MS,
  submissionContentHash,
  windowStart,
} from './identity.js';

describe('hashIdentity', () => {
  it('is deterministic for the same salt and value', () => {
    expect(hashIdentity('pepper', '203.0.113.5')).toBe(hashIdentity('pepper', '203.0.113.5'));
  });

  it('produces a different digest under a different salt (rotation invalidates)', () => {
    expect(hashIdentity('pepper', '203.0.113.5')).not.toBe(
      hashIdentity('other', '203.0.113.5'),
    );
  });

  it('produces a different digest for a different value', () => {
    expect(hashIdentity('pepper', '203.0.113.5')).not.toBe(hashIdentity('pepper', '203.0.113.6'));
  });

  it('normalizes case and surrounding whitespace so one client is one identity', () => {
    const canonical = hashIdentity('pepper', '2001:db8::a');
    expect(hashIdentity('pepper', '  2001:DB8::A ')).toBe(canonical);
  });

  it('never emits the raw value — the output is 64 hex chars', () => {
    const digest = hashIdentity('pepper', '203.0.113.5');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain('203.0.113.5');
  });
});

describe('readSubmissionSalt', () => {
  it('returns the configured salt', () => {
    expect(readSubmissionSalt({ SUBMISSION_SALT: 'a-long-secret' })).toBe('a-long-secret');
  });

  it('throws loudly when unset or blank (a silent empty salt is no salt)', () => {
    expect(() => readSubmissionSalt({})).toThrow(/SUBMISSION_SALT/);
    expect(() => readSubmissionSalt({ SUBMISSION_SALT: '   ' })).toThrow(/SUBMISSION_SALT/);
  });
});

describe('isValidDeviceId', () => {
  it('accepts a UUID in either case', () => {
    expect(isValidDeviceId('7f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b')).toBe(true);
    expect(isValidDeviceId('7F1A2B3C-4D5E-4F60-8A9B-0C1D2E3F4A5B')).toBe(true);
  });

  it('rejects non-UUID shapes and non-strings', () => {
    expect(isValidDeviceId('not-a-uuid')).toBe(false);
    expect(isValidDeviceId('')).toBe(false);
    expect(isValidDeviceId(42)).toBe(false);
    expect(isValidDeviceId(null)).toBe(false);
  });
});

describe('resolveClientIp', () => {
  it('IGNORES X-Forwarded-For when the proxy is not trusted (forgery hole)', () => {
    expect(
      resolveClientIp({
        forwardedFor: '1.2.3.4',
        socketAddress: '203.0.113.5',
        trustProxy: false,
      }),
    ).toBe('203.0.113.5');
  });

  it('takes the FIRST hop of X-Forwarded-For when the proxy is trusted', () => {
    expect(
      resolveClientIp({
        forwardedFor: '203.0.113.5, 70.41.3.18, 150.172.238.178',
        socketAddress: '10.0.0.1',
        trustProxy: true,
      }),
    ).toBe('203.0.113.5');
  });

  it('falls back to the socket address when the trusted header is absent', () => {
    expect(resolveClientIp({ socketAddress: '203.0.113.9', trustProxy: true })).toBe(
      '203.0.113.9',
    );
  });

  it('collapses the IPv4-mapped IPv6 form onto the plain literal', () => {
    expect(
      resolveClientIp({ socketAddress: '::ffff:203.0.113.5', trustProxy: false }),
    ).toBe('203.0.113.5');
  });

  it('uses a single shared bucket when there is no resolvable address', () => {
    expect(resolveClientIp({ trustProxy: false })).toBe('unknown');
  });
});

describe('rate-limit window', () => {
  const now = new Date('2026-07-22T12:00:00.000Z');

  it('windowStart is exactly one window before now', () => {
    expect(windowStart(now).getTime()).toBe(now.getTime() - SUBMISSION_WINDOW_MS);
  });

  it('a submission one minute ago is inside the window', () => {
    expect(isWithinWindow(new Date(now.getTime() - 60_000), now)).toBe(true);
  });

  it('a submission exactly one window old has expired (exclusive far edge)', () => {
    expect(isWithinWindow(new Date(now.getTime() - SUBMISSION_WINDOW_MS), now)).toBe(false);
  });

  it('a submission one ms inside the window still blocks', () => {
    expect(isWithinWindow(new Date(now.getTime() - SUBMISSION_WINDOW_MS + 1), now)).toBe(true);
  });

  it('treats a future-dated previous submission as blocking (clock skew is safe-side)', () => {
    expect(isWithinWindow(new Date(now.getTime() + 5_000), now)).toBe(true);
  });

  it('retryAfterSeconds counts down and is never 0 while blocked', () => {
    expect(retryAfterSeconds(new Date(now.getTime() - 60_000), now)).toBe(
      SUBMISSION_WINDOW_MS / 1000 - 60,
    );
    // 1ms of window left must still round up to a full second, not 0.
    expect(retryAfterSeconds(new Date(now.getTime() - SUBMISSION_WINDOW_MS + 1), now)).toBe(1);
  });

  it('retryAfterSeconds is 0 once the window has passed', () => {
    expect(retryAfterSeconds(new Date(now.getTime() - SUBMISSION_WINDOW_MS), now)).toBe(0);
  });

  it('honours a custom window (so the test suite need not wait a day)', () => {
    const win = 1000;
    expect(isWithinWindow(new Date(now.getTime() - 500), now, win)).toBe(true);
    expect(isWithinWindow(new Date(now.getTime() - 1500), now, win)).toBe(false);
  });
});

describe('normalizeSubmission / submissionContentHash', () => {
  it('collapses whitespace and case so a re-paste is the same content', () => {
    const a = normalizeSubmission('  Arctic   sea ice  HIT a record low ', 'https://NSIDC.org/x/');
    const b = normalizeSubmission('arctic sea ice hit a record low', 'https://nsidc.org/x');
    expect(a).toEqual(b);
    expect(submissionContentHash(a)).toBe(submissionContentHash(b));
  });

  it('distinguishes genuinely different claims', () => {
    const a = normalizeSubmission('claim one', 'https://example.org/a');
    const b = normalizeSubmission('claim two', 'https://example.org/a');
    expect(submissionContentHash(a)).not.toBe(submissionContentHash(b));
  });
});
