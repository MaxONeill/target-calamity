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
  'accepted' | 'rejected_noise' | 'quarantined' | 'rate_limited' | 'duplicate';

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

export interface SubmissionStore {
  /** Is EITHER half of this identity shadow-banned? */
  isBanned(identity: SubmitterIdentity): Promise<boolean>;
  /**
   * Timestamp of the most recent NON-quarantined submission by either half of
   * this identity since `since`, or null. Quarantined rows are excluded on
   * purpose: a shadow-banned submitter must keep receiving the ordinary success
   * response, and a 429 on their second attempt of the day would tell them their
   * first one was counted differently from what they were shown.
   */
  lastSubmissionAt(identity: SubmitterIdentity, since: Date): Promise<Date | null>;
  /** Has this exact normalized claim+URL been submitted before? */
  isDuplicate(normalized: NormalizedSubmission): Promise<boolean>;
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
          AND status <> 'quarantined'
          AND created_at >= ${since}
        ORDER BY created_at DESC
        LIMIT 1
      `.execute(db);
      const first = rows[0];
      return first ? new Date(first.created_at) : null;
    },

    async isDuplicate(normalized): Promise<boolean> {
      // Matches `normalizeSubmission` (whitespace-collapsed, lowercased, trailing
      // slash dropped) in SQL so the two halves cannot drift apart silently.
      const { rows } = await sql<{ hit: number }>`
        SELECT 1 AS hit FROM submissions
        WHERE lower(regexp_replace(btrim(claim), '\\s+', ' ', 'g')) = ${normalized.claim}
          AND regexp_replace(lower(btrim(source_url)), '/+$', '') = ${normalized.sourceUrl}
          AND status IN ('accepted', 'duplicate')
        LIMIT 1
      `.execute(db);
      return rows.length > 0;
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

  return {
    async isBanned(identity): Promise<boolean> {
      return bannedIps.has(identity.ipHash) || bannedDevices.has(identity.deviceHash);
    },

    async lastSubmissionAt(identity, since): Promise<Date | null> {
      let latest: Date | null = null;
      for (const row of rows) {
        if (row.status === 'quarantined') continue;
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

    async isDuplicate(normalized): Promise<boolean> {
      return contentHashes.has(submissionContentHash(normalized));
    },

    async record(entry): Promise<void> {
      rows.push({ ...entry, id: randomUUID(), createdAt: now() });
      if (entry.status === 'accepted' || entry.status === 'duplicate') {
        contentHashes.add(
          submissionContentHash({
            claim: entry.claim.replace(/\s+/g, ' ').trim().toLowerCase(),
            sourceUrl: entry.sourceUrl.trim().toLowerCase().replace(/\/+$/, ''),
          }),
        );
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
