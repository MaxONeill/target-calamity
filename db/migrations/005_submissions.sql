-- =============================================================================
-- Target: Calamity — 005_submissions.sql
-- Anonymous Phase-1 factor submissions (ADR-45).
--
-- Phase 1 has NO accounts. Anyone may propose ONE factor per day, and the system
-- must still be able to (a) rate-limit, (b) shadow-ban an abusive submitter, and
-- (c) keep an audit trail of what was proposed and why it was rejected — WITHOUT
-- ever storing a raw IP address or any other directly-identifying value.
--
--   submissions        — every attempt, whatever its outcome, with the identity
--                        reduced to two salted SHA-256 digests.
--   banned_submitters  — the shadow-ban list. A row here means the matching
--                        ip_hash/device_hash still gets a 200 success response
--                        while its submissions land as `quarantined` and never
--                        reach the vetting pipeline. The ban is NEVER disclosed.
--
-- IDENTITY IS HASHED, NOT STORED (ADR-45):
--   ip_hash     = sha256(SUBMISSION_SALT || client_ip)
--   device_hash = sha256(SUBMISSION_SALT || client_deviceId)
-- The salt lives only in the environment (`SUBMISSION_SALT`), so a database dump
-- alone cannot be brute-forced back to the (small, enumerable) IPv4 space. The
-- server refuses to start in DB mode without it. Both columns are plain TEXT
-- holding lowercase hex; there is no raw-value column to leak.
--
-- STATUS is the whole decision trail, cheapest check first:
--   rate_limited   — an earlier non-quarantined submission inside the 24h window
--   quarantined    — submitter is shadow-banned (response is indistinguishable
--                    from `accepted`; the row exists only for operators)
--   duplicate      — same normalized claim + source URL already submitted
--   rejected_noise — the cheap noise classifier called it spam/abuse/nonsense
--   accepted       — handed off to the existing vetting pipeline
--
-- INDEXES: the daily-window lookup is `WHERE ip_hash = $1 AND created_at > $2`
-- (and the same on device_hash), so each gets a (hash, created_at DESC) index.
-- The (status, created_at DESC) index serves operator review of the reject piles.
--
-- Applied after 004 by both bootstrap paths (docker initdb runs *.sql in order;
-- `npm run db:migrate` applies files not yet in schema_migrations). Idempotent
-- guards (IF NOT EXISTS) so a re-run is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS submissions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Salted SHA-256 hex digests. NEVER a raw IP or a raw device id (ADR-45).
    ip_hash     TEXT        NOT NULL,
    device_hash TEXT        NOT NULL,

    -- What the submitter actually supplied. NOTE the absence of effect,
    -- significance, verification_state, lat, lon and tipping_point: those are
    -- SYSTEM-ASSIGNED by the vetting pipeline and a submitter may never set them
    -- (ADR-45, the anti-manipulation rule). The request schema is `.strict()`, so
    -- an attempt to supply one is a hard 400 before it ever reaches this table.
    claim       TEXT        NOT NULL,
    source_url  TEXT        NOT NULL,
    note        TEXT,

    status      TEXT        NOT NULL,
    -- Operator-facing explanation (classifier verdict, duplicate-of, …). Never
    -- returned to the submitter verbatim — that would leak the shadow-ban.
    reason      TEXT,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT submissions_status_check CHECK (
        status IN ('accepted', 'rejected_noise', 'quarantined', 'rate_limited', 'duplicate')
    )
);

-- Daily-window lookups (one per identity half; the check is an OR of the two).
CREATE INDEX IF NOT EXISTS idx_submissions_ip_recent
    ON submissions (ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_device_recent
    ON submissions (device_hash, created_at DESC);
-- Operator review of a given outcome pile, newest first.
CREATE INDEX IF NOT EXISTS idx_submissions_status_recent
    ON submissions (status, created_at DESC);

CREATE TABLE IF NOT EXISTS banned_submitters (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Either half may be null: a ban can target an IP, a device, or both. At
    -- least one MUST be present or the row bans nobody (or, worse, everybody).
    ip_hash     TEXT,
    device_hash TEXT,

    reason      TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT banned_submitters_identity_check CHECK (
        ip_hash IS NOT NULL OR device_hash IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_banned_submitters_ip
    ON banned_submitters (ip_hash);
CREATE INDEX IF NOT EXISTS idx_banned_submitters_device
    ON banned_submitters (device_hash);

-- Self-register in the migration ledger (see 001_init.sql / server/db/migrate.ts).
INSERT INTO schema_migrations (filename) VALUES ('005_submissions.sql')
    ON CONFLICT DO NOTHING;
