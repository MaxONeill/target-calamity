/**
 * Privacy-preserving submitter identity.
 *
 * Phase-1 submissions are ANONYMOUS — there is no account to attribute them to.
 * Rate limiting and shadow-banning still need a stable-ish handle on "the same
 * submitter", and the cheapest two available are the client IP and a
 * client-generated device id. Both are PII-adjacent, so **neither is ever stored
 * raw**: this module reduces each to a salted SHA-256 digest and that digest is
 * the only thing that reaches the database.
 *
 *     ip_hash     = sha256(SUBMISSION_SALT || ip)
 *     device_hash = sha256(SUBMISSION_SALT || deviceId)
 *
 * WHY THE SALT IS LOAD-BEARING: the IPv4 space is ~4.3e9 values, which an
 * attacker with a database dump can exhaustively hash in minutes. An unsalted
 * `sha256(ip)` is therefore a reversible encoding of the IP, not a protection.
 * A secret salt held only in the environment breaks that: the dump alone is
 * useless. Rotating the salt invalidates every existing hash (bans and the rate
 * limit window reset) — that is the documented cost of rotation.
 *
 * Everything here is pure and offline-testable; nothing in this file touches the
 * network, the database, or `process.env` except through an explicitly passed
 * environment object.
 */
import { createHash } from 'node:crypto';

/** The environment variable carrying the hashing salt. */
export const SUBMISSION_SALT_ENV = 'SUBMISSION_SALT';

/**
 * One submission per identity per 24 hours. A sliding window, not a
 * calendar day: a calendar-day bucket lets a submitter post twice in two minutes
 * across midnight, which is precisely the burst the limit exists to stop.
 */
export const SUBMISSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Salt                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Read the hashing salt, or throw. Callers in DB mode MUST call this at startup
 * so a misconfigured deployment fails loudly at boot rather than silently
 * hashing with an empty salt (which would be equivalent to no salt at all).
 */
export function readSubmissionSalt(env: NodeJS.ProcessEnv = process.env): string {
  const salt = env[SUBMISSION_SALT_ENV]?.trim();
  if (!salt) {
    throw new Error(
      `${SUBMISSION_SALT_ENV} is not set. Anonymous submissions hash the client IP ` +
        'and device id with this salt; without it the digests are trivially ' +
        'reversible for the whole IPv4 space. Set it to a long random secret ' +
        '(see .env.example) or run without a DATABASE_URL to disable submissions.',
    );
  }
  return salt;
}

/* -------------------------------------------------------------------------- */
/* Hashing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `sha256(salt || value)` as lowercase hex. Deterministic for a fixed salt (so
 * the same submitter maps to the same row every time) and salt-dependent (so two
 * deployments — or the same deployment after a salt rotation — share no hashes).
 *
 * The value is trimmed and lowercased first: IPv6 literals and hex UUIDs both
 * have case-insensitive canonical forms, and without normalization `::1` and
 * `::0001`-style casing differences would split one submitter into several.
 */
export function hashIdentity(salt: string, value: string): string {
  return createHash('sha256').update(`${salt}${value.trim().toLowerCase()}`).digest('hex');
}

/**
 * A validated device id, or null. The client generates a UUID and persists it in
 * localStorage; it is UNTRUSTED input, so the shape is checked before it is
 * hashed (an unbounded string would otherwise let a submitter blow up the row
 * size, and a rotating garbage value would make the device half of the limit
 * meaningless anyway — a bad shape is a bad-faith signal, so it is a 400).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidDeviceId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

/* -------------------------------------------------------------------------- */
/* Client IP resolution behind a proxy                                        */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the client IP from the request.
 *
 * DECISION (documented deliberately, because getting this wrong breaks the rate
 * limit in one of two opposite ways): we take the **FIRST hop** of
 * `X-Forwarded-For` when `trustProxy` is enabled, and the raw socket address
 * otherwise. `X-Forwarded-For` is `client, proxy1, proxy2 …`, so the first entry
 * is the originating client as reported by the nearest trusted proxy.
 *
 *   - Trusting the header when the server is NOT behind a proxy is a forgery
 *     hole: any submitter can set `X-Forwarded-For` themselves and mint a fresh
 *     identity per request, defeating the limit entirely.
 *   - Ignoring it when the server IS behind a proxy collapses every client onto
 *     the proxy's address, so the first submission of the day locks out the
 *     whole internet.
 *
 * Neither default is safe for both deployments, so the behaviour is an explicit
 * `trustProxy` flag (`TRUST_PROXY=1`), not a guess. Default: **do not trust**,
 * which fails toward the harmless direction (a proxied deployment over-limits a
 * shared address rather than being trivially evaded).
 */
export interface IpResolutionInput {
  /** `X-Forwarded-For` header value(s), exactly as received. */
  forwardedFor?: string | string[] | undefined;
  /** The TCP peer address (`request.socket.remoteAddress`). */
  socketAddress?: string | undefined;
  /** Whether the deployment sits behind a proxy we control. */
  trustProxy: boolean;
}

export function resolveClientIp(input: IpResolutionInput): string {
  if (input.trustProxy) {
    const raw = Array.isArray(input.forwardedFor)
      ? input.forwardedFor[0]
      : input.forwardedFor;
    const first = raw?.split(',')[0]?.trim();
    if (first) return normalizeIp(first);
  }
  const socket = input.socketAddress?.trim();
  // No resolvable address at all (unix socket, exotic transport): a single
  // shared bucket is the conservative choice — it over-limits rather than
  // handing every such request its own fresh identity.
  return socket ? normalizeIp(socket) : 'unknown';
}

/**
 * Collapse the IPv4-mapped IPv6 form (`::ffff:203.0.113.5`) onto the plain IPv4
 * literal, so the same client is one identity whether the socket is v4 or a
 * dual-stack v6 listener, and strip a `[v6]:port` wrapper.
 */
function normalizeIp(ip: string): string {
  let out = ip.trim();
  if (out.startsWith('[')) {
    const close = out.indexOf(']');
    if (close > 0) out = out.slice(1, close);
  }
  if (out.toLowerCase().startsWith('::ffff:')) out = out.slice(7);
  return out.toLowerCase();
}

/* -------------------------------------------------------------------------- */
/* Rate-limit window arithmetic                                               */
/* -------------------------------------------------------------------------- */

/**
 * The instant at or after which submissions still count against the window. The
 * caller passes this as the lower bound of its "any submission since?" query, so
 * the window logic lives HERE (pure, tested) rather than inside SQL.
 */
export function windowStart(now: Date, windowMs: number = SUBMISSION_WINDOW_MS): Date {
  return new Date(now.getTime() - windowMs);
}

/**
 * Is a previous submission still inside the window? Exclusive at the far edge:
 * a submission exactly `windowMs` old has expired and no longer blocks.
 */
export function isWithinWindow(
  previous: Date,
  now: Date,
  windowMs: number = SUBMISSION_WINDOW_MS,
): boolean {
  const age = now.getTime() - previous.getTime();
  // A future-dated `previous` (clock skew between app servers) is treated as
  // inside the window — the safe direction; the alternative lets skew unlock a
  // second submission.
  if (age < 0) return true;
  return age < windowMs;
}

/**
 * Whole seconds until the blocking submission ages out, for the `Retry-After`
 * header and the UI copy. Always ≥ 1 while blocked, so the client is never told
 * to retry "in 0 seconds" and immediately fails again; 0 once unblocked.
 */
export function retryAfterSeconds(
  previous: Date,
  now: Date,
  windowMs: number = SUBMISSION_WINDOW_MS,
): number {
  if (!isWithinWindow(previous, now, windowMs)) return 0;
  const remainingMs = previous.getTime() + windowMs - now.getTime();
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

/* -------------------------------------------------------------------------- */
/* Content identity (duplicate detection)                                     */
/* -------------------------------------------------------------------------- */

/** A submission's content reduced to its comparable form. */
export interface NormalizedSubmission {
  claim: string;
  sourceUrl: string;
}

/**
 * Normalize claim + URL for duplicate detection: collapse whitespace, lowercase,
 * and drop a trailing slash from the URL. Deliberately conservative — it catches
 * "the same thing pasted twice" (including trivial re-casing/re-spacing), not
 * semantic near-duplicates. Semantic dedupe against the FACTOR seed data is the
 * ingestion pipeline's job (Phase C embeddings), and it happens after
 * acceptance rather than here, where an embedding call would defeat the whole
 * point of a cheapest-checks-first ordering.
 */
export function normalizeSubmission(claim: string, sourceUrl: string): NormalizedSubmission {
  return {
    claim: claim.replace(/\s+/g, ' ').trim().toLowerCase(),
    sourceUrl: sourceUrl.trim().toLowerCase().replace(/\/+$/, ''),
  };
}

/** Stable content key for a normalized submission (used by the in-memory store). */
export function submissionContentHash(normalized: NormalizedSubmission): string {
  return createHash('sha256')
    .update(`${normalized.claim} ${normalized.sourceUrl}`)
    .digest('hex');
}