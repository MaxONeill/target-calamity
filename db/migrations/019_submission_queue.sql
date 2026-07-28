-- Submissions QUEUE. Nothing paid happens inside the request.
--
-- Until now a submission did two expensive things while the submitter waited:
-- one LLM call to classify it as noise-or-not, and then — fire-and-forget — the
-- whole ingestion pipeline (retrieval, extraction, embeddings, the write). Both
-- ran unobserved, and both were reachable by an anonymous HTTP request. The only
-- brake was the rate limiter, so cost scaled with the number of distinct IPs
-- willing to send one request a day.
--
-- Both are now deferred. What remains in the request path is free: schema
-- validation, the ban lookup, the rate-limit lookup, the duplicate lookup, and
-- the DETERMINISTIC noise heuristic (pure string matching, no network, no
-- credentials — `classifySubmissionOffline`). That heuristic is kept at submit
-- time on purpose: it is what still auto-shadow-bans blatant spam and still
-- tells a confused human their text was not a checkable claim, and it costs
-- nothing to run. The LLM classification moves to the drain alongside the
-- pipeline.
--
-- THE STATUS MACHINE. `queued` is new, and it is deliberately NOT called
-- `accepted`: nothing has accepted the claim at that point. It cleared the free
-- checks and the cheap heuristic, which is a much weaker statement.
--
--   queued          cleared every free check; awaiting LLM classification + vetting
--     ├─ drain says noise      → rejected_noise
--     └─ drain says plausible  → accepted, once the pipeline has run
--   rejected_noise  the heuristic (at submit) or the model (at drain) called it
--   quarantined     shadow-banned submitter; response identical to the queued one
--   rate_limited    an earlier non-quarantined submission inside the 24h window
--   duplicate       same normalized claim + source URL already submitted
--
-- `accepted` therefore keeps its old meaning — cleared the noise filter and was
-- handed to the pipeline — but is now reached only by the drain, never by the
-- request handler.
--
-- vetted_at records that the DRAIN HAS FINISHED with a row, whatever it decided.
-- It is stamped on the rejected-at-drain path too, so a row the model threw out
-- is not picked up again on the next pass. Without it the queue is a log: you
-- can see what arrived, never what you have already spent money on, and a run
-- that died halfway is indistinguishable from one that completed.
--
--   vetted_at IS NULL      the drain has never finished this row
--   vetted_at IS NOT NULL  the drain has, successfully or by rejecting it
--
-- The submitter-facing response is unchanged. It always promised review rather
-- than publication ("most submissions do not clear that check"), which is now
-- more literally true than when it was written.

ALTER TABLE submissions
    ADD COLUMN IF NOT EXISTS vetted_at TIMESTAMPTZ;

-- `queued` has to join the allowed set before anything can write it.
ALTER TABLE submissions
    DROP CONSTRAINT IF EXISTS submissions_status_check;
ALTER TABLE submissions
    ADD CONSTRAINT submissions_status_check CHECK (
        status IN ('queued', 'accepted', 'rejected_noise', 'quarantined',
                   'rate_limited', 'duplicate')
    );

-- The drain query is "oldest queued first": status = 'queued' AND vetted_at IS
-- NULL. Partial, because the queue is by design a small minority of the table —
-- every rate-limited, duplicate, noise-rejected and quarantined row lives here
-- too and none of them is ever a candidate.
CREATE INDEX IF NOT EXISTS idx_submissions_queued
    ON submissions (created_at)
    WHERE status = 'queued' AND vetted_at IS NULL;
