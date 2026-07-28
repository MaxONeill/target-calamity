/**
 * Persistence port for anonymous submissions.
 *
 * The route depends on this interface, not on Kysely, so the whole submission
 * flow — including the shadow-ban and rate-limit branches — runs offline against
 * the in-memory implementation. That mirrors how `server/ingestion` splits
 * `pgRepository.ts` from `memoryRepository.ts`.
 *
 * Seed mode (no `DATABASE_URL`) uses the in-memory store, so the endpoint still
 * works end-to-end for a demo; it is explicitly NOT durable — a restart forgets
 * every ban and every rate-limit window. That is stated in the README rather
 * than papered over.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Database } from '../db.js';
import type { NormalizedSubmission } from './identity.js';
import { submissionContentHash } from './identity.js';

/**
 * Persisted outcome of one attempt. Strictly finer-grained than what the client
 * is told (`SubmissionOutcome` in the shared contract): `quarantined` and
 * `accepted` are different rows but the SAME response payload, which is what
 * makes the ban a shadow ban.
 */
export type SubmissionStatus =
  'queued' | 'accepted' | 'rejected_noise' | 'quarantined' | 'rate_limited' | 'duplicate';

/**
 * The statuses that make a claim "already submitted" for duplicate purposes.
 * `queued` MUST be here: it is what the request handler now writes, so omitting
 * it would let the same claim be re-submitted without limit until someone
 * drained the queue — the duplicate check would be looking only at rows the
 * drain had already promoted to `accepted`.
 */
const DUPLICATE_BLOCKING: readonly SubmissionStatus[] = ['queued', 'accepted', 'duplicate'];

/**
 * The statuses that CONSUME the daily allowance.
 *
 * `rate_limited` is deliberately absent, and its absence is the whole point. The
 * window used to be measured from the most recent non-quarantined row, and a
 * rejected attempt is itself recorded as a row — so every retry moved the window
 * forward by the length of the window. Observed directly: with one hour left,
 * one retry reset the wait to a full 24 hours. A submitter who kept trying could
 * never submit again, and the form's own "Submit another" button invited exactly
 * that. A rejection must not extend the sentence it is reporting.
 *
 * `quarantined` IS here, and used not to be. The original reasoning was that
 * counting a shadow-banned submitter's rows would reveal the ban, but it is
 * exactly backwards: an ordinary submitter's second attempt of the day is a 429,
 * so a banned submitter whose rows do not count sails past the limiter and gets
 * a success payload where everyone else gets refused. That divergence WAS the
 * oracle — two submissions in one day told a banned user what the response
 * payload was designed never to tell them. Counting quarantined rows is what
 * makes the two identical.
 *
 * Listed explicitly rather than as an exclusion so that adding a status forces a
 * decision about whether it spends the submitter's day.
 */
const WINDOW_CONSUMING: readonly SubmissionStatus[] = [
  'queued',
  'accepted',
  'rejected_noise',
  'duplicate',
  'quarantined',
];

/** The salted identity pair. Never carries a raw IP or device id. */
export interface SubmitterIdentity {
  ipHash: string;
  deviceHash: string;
}

/** A row to append to `submissions`. */
export interface SubmissionWrite {
  identity: SubmitterIdentity;
  claim: string;
  sourceUrl: string;
  note?: string | undefined;
  status: SubmissionStatus;
  /** Operator-facing explanation. Never echoed to the submitter. */
  reason?: string | undefined;
}

/** A row to append to `banned_submitters`. Bans both halves of the identity. */
export interface BanWrite {
  identity: SubmitterIdentity;
  reason: string;
}

/**
 * One queued row, as the drain needs it. Carries the submitter's identity so a
 * verdict reached at drain time can still shadow-ban — the ban targets hashes,
 * and the raw IP is long gone by then, which is the whole point.
 */
export interface QueuedSubmission {
  id: string;
  claim: string;
  sourceUrl: string;
  note?: string | undefined;
  identity: SubmitterIdentity;
  createdAt: Date;
}

/** What the drain decided about a row. `vetted_at` is stamped either way. */
export type DrainOutcome = 'accepted' | 'rejected_noise';

export interface SubmissionStore {
  /** Is EITHER half of this identity shadow-banned? */
  isBanned(identity: SubmitterIdentity): Promise<boolean>;
  /**
   * Oldest-first page of the queue: `status = 'queued' AND vetted_at IS NULL`.
   * Oldest first so a backlog drains in submission order and no row can be
   * starved by newer arrivals.
   */
  queued(limit: number): Promise<QueuedSubmission[]>;
  /**
   * Record what the drain decided, and stamp `vetted_at` so the row is never
   * picked up again — including when the decision was to reject it. A drain that
   * left rejected rows unstamped would re-classify them, and re-pay, on every
   * subsequent run.
   */
  markVetted(id: string, outcome: DrainOutcome, reason: string): Promise<void>;
  /**
   * Timestamp of the most recent allowance-consuming submission by either half
   * of this identity since `since`, or null. See {@link WINDOW_CONSUMING} — in
   * particular quarantined rows DO count, so a shadow-banned submitter meets the
   * same 429 on their second attempt of the day that everyone else does.
   */
  lastSubmissionAt(identity: SubmitterIdentity, since: Date): Promise<Date | null>;
  /**
   * Has this exact normalized claim+URL been submitted before?
   *
   * `identity` is required because a quarantined row must count as a duplicate
   * FOR ITS OWN SUBMITTER and for nobody else. Both halves of that matter:
   *
   *   - counted for its own submitter, or a banned user re-submitting their own
   *     claim tomorrow would be told `received` where an ordinary user is told
   *     `duplicate` — the same oracle in a slower form;
   *   - counted for NOBODY else, or a banned submitter could quietly reserve any
   *     claim they liked, and every genuine submitter who tried it would be told
   *     it was already submitted and lose their day to a row that never entered
   *     the queue.
   */
  isDuplicate(normalized: NormalizedSubmission, identity: SubmitterIdentity): Promise<boolean>;
  /** Append a submission row. */
  record(entry: SubmissionWrite): Promise<void>;
  /** Append a shadow-ban row. */
  ban(entry: BanWrite): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Postgres                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The live store, over migration 005. Every query is parameterized through
 * Kysely's `sql` template; the identity values are already digests, so nothing
 * user-controlled reaches the database in raw form except the claim/URL/note the
 * submitter is explicitly asked for.
 */
export function createPgSubmissionStore(db: Database): SubmissionStore {
  return {
    async isBanned(identity): Promise<boolean> {
      const { rows } = await sql<{ hit: number }>`
        SELECT 1 AS hit FROM banned_submitters
        WHERE ip_hash = ${identity.ipHash} OR device_hash = ${identity.deviceHash}
        LIMIT 1
      `.execute(db);
      return rows.length > 0;
    },

    async lastSubmissionAt(identity, since): Promise<Date | null> {
      const { rows } = await sql<{ created_at: Date }>`
        SELECT created_at FROM submissions
        WHERE (ip_hash = ${identity.ipHash} OR device_hash = ${identity.deviceHash})
          AND status IN (${sql.join(WINDOW_CONSUMING.map((s) => sql.lit(s)))})
          AND created_at >= ${since}
        ORDER BY created_at DESC
        LIMIT 1
      `.execute(db);
      const first = rows[0];
      return first ? new Date(first.created_at) : null;
    },

    async isDuplicate(normalized, identity): Promise<boolean> {
      // Matches `normalizeSubmission` (whitespace-collapsed, lowercased, trailing
      // slash dropped) in SQL so the two halves cannot drift apart silently.
      const { rows } = await sql<{ hit: number }>`
        SELECT 1 AS hit FROM submissions
        WHERE lower(regexp_replace(btrim(claim), '\\s+', ' ', 'g')) = ${normalized.claim}
          AND regexp_replace(lower(btrim(source_url)), '/+$', '') = ${normalized.sourceUrl}
          AND (
            status IN (${sql.join(DUPLICATE_BLOCKING.map((s) => sql.lit(s)))})
            OR (
              status = 'quarantined'
              AND (ip_hash = ${identity.ipHash} OR device_hash = ${identity.deviceHash})
            )
          )
        LIMIT 1
      `.execute(db);
      return rows.length > 0;
    },

    async queued(limit): Promise<QueuedSubmission[]> {
      // Matches idx_submissions_queued exactly (migration 019).
      const { rows } = await sql<{
        id: string;
        claim: string;
        source_url: string;
        note: string | null;
        ip_hash: string;
        device_hash: string;
        created_at: Date;
      }>`
        SELECT id, claim, source_url, note, ip_hash, device_hash, created_at
        FROM submissions
        WHERE status = 'queued' AND vetted_at IS NULL
        ORDER BY created_at
        LIMIT ${limit}
      `.execute(db);
      return rows.map((r) => ({
        id: r.id,
        claim: r.claim,
        sourceUrl: r.source_url,
        // The column is nullable; the domain type is `?: string`, never `| null`.
        ...(r.note === null ? {} : { note: r.note }),
        identity: { ipHash: r.ip_hash, deviceHash: r.device_hash },
        createdAt: new Date(r.created_at),
      }));
    },

    async markVetted(id, outcome, reason): Promise<void> {
      // Guarded on `vetted_at IS NULL` so two concurrent drains cannot both
      // claim the same row and double-spend on it.
      await sql`
        UPDATE submissions
           SET status = ${outcome}, reason = ${reason}, vetted_at = NOW()
         WHERE id = ${id}::uuid AND vetted_at IS NULL
      `.execute(db);
    },

    async record(entry): Promise<void> {
      await sql`
        INSERT INTO submissions (ip_hash, device_hash, claim, source_url, note, status, reason)
        VALUES (
          ${entry.identity.ipHash}, ${entry.identity.deviceHash},
          ${entry.claim}, ${entry.sourceUrl}, ${entry.note ?? null},
          ${entry.status}, ${entry.reason ?? null}
        )
      `.execute(db);
    },

    async ban(entry): Promise<void> {
      await sql`
        INSERT INTO banned_submitters (ip_hash, device_hash, reason)
        VALUES (${entry.identity.ipHash}, ${entry.identity.deviceHash}, ${entry.reason})
      `.execute(db);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* In-memory (seed mode + tests)                                              */
/* -------------------------------------------------------------------------- */

/** A stored row, as the in-memory store holds it. */
export interface StoredSubmission extends SubmissionWrite {
  id: string;
  createdAt: Date;
  /** Mirrors the nullable `vetted_at` column; `undefined` means still queued. */
  vettedAt?: Date | undefined;
}

export interface MemorySubmissionStore extends SubmissionStore {
  /** Every recorded row, insertion order. */
  submissions(): StoredSubmission[];
  /** Every ban, insertion order. */
  bans(): (BanWrite & { createdAt: Date })[];
}

/**
 * Non-durable store for seed mode and offline tests. `now` is injectable so the
 * 24h window can be exercised without waiting a day.
 */
export function createMemorySubmissionStore(
  now: () => Date = () => new Date(),
): MemorySubmissionStore {
  const rows: StoredSubmission[] = [];
  const bans: (BanWrite & { createdAt: Date })[] = [];
  const bannedIps = new Set<string>();
  const bannedDevices = new Set<string>();
  const contentHashes = new Set<string>();
  /** Quarantined content, kept with its submitter so it blocks only them. */
  const quarantinedHashes: { hash: string; identity: SubmitterIdentity }[] = [];

  return {
    async isBanned(identity): Promise<boolean> {
      return bannedIps.has(identity.ipHash) || bannedDevices.has(identity.deviceHash);
    },

    async lastSubmissionAt(identity, since): Promise<Date | null> {
      let latest: Date | null = null;
      for (const row of rows) {
        if (!WINDOW_CONSUMING.includes(row.status)) continue;
        if (
          row.identity.ipHash !== identity.ipHash &&
          row.identity.deviceHash !== identity.deviceHash
        ) {
          continue;
        }
        if (row.createdAt.getTime() < since.getTime()) continue;
        if (latest === null || row.createdAt.getTime() > latest.getTime()) {
          latest = row.createdAt;
        }
      }
      return latest;
    },

    async isDuplicate(normalized, identity): Promise<boolean> {
      const hash = submissionContentHash(normalized);
      if (contentHashes.has(hash)) return true;
      // A quarantined row blocks its OWN submitter only — mirrors the SQL store.
      return quarantinedHashes.some(
        (q) =>
          q.hash === hash &&
          (q.identity.ipHash === identity.ipHash || q.identity.deviceHash === identity.deviceHash),
      );
    },

    async queued(limit): Promise<QueuedSubmission[]> {
      return rows
        .filter((r) => r.status === 'queued' && r.vettedAt === undefined)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          claim: r.claim,
          sourceUrl: r.sourceUrl,
          ...(r.note === undefined ? {} : { note: r.note }),
          identity: r.identity,
          createdAt: r.createdAt,
        }));
    },

    async markVetted(id, outcome, reason): Promise<void> {
      const row = rows.find((r) => r.id === id);
      if (!row || row.vettedAt !== undefined) return;
      row.status = outcome;
      row.reason = reason;
      row.vettedAt = now();
    },

    async record(entry): Promise<void> {
      rows.push({ ...entry, id: randomUUID(), createdAt: now() });
      const hash = submissionContentHash({
        claim: entry.claim.replace(/\s+/g, ' ').trim().toLowerCase(),
        sourceUrl: entry.sourceUrl.trim().toLowerCase().replace(/\/+$/, ''),
      });
      if (DUPLICATE_BLOCKING.includes(entry.status)) {
        contentHashes.add(hash);
      } else if (entry.status === 'quarantined') {
        quarantinedHashes.push({ hash, identity: entry.identity });
      }
    },

    async ban(entry): Promise<void> {
      bannedIps.add(entry.identity.ipHash);
      bannedDevices.add(entry.identity.deviceHash);
      bans.push({ ...entry, createdAt: now() });
    },

    submissions(): StoredSubmission[] {
      return [...rows];
    },
    bans(): (BanWrite & { createdAt: Date })[] {
      return [...bans];
    },
  };
}
