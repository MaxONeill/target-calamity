# Ingestion — the Reconciliation Loop + Live Research Engine

Implements the original brief (Phase A → D) under ** through **
and the adopted decisions (plus /-13 and audit findings 27–31). Phase A is now
a **live research engine**: on a schedule it pulls information from the web,
verifies each source, assigns a signed direction + magnitude, and lands
deduplicated, cited rows in `factors` — `verified` (in the Clock aggregate) or
`pending` (in the feed, off the aggregate).

## Live research engine

```
INGEST_TOPICS (or a built-in Calamity+Humanity set)
   │  scheduled worker, every INGEST_INTERVAL_HOURS (default 6), bounded batch
   ▼
Phase A  researchFactors(topic) ................... /-44 (search+fetch+Fireworks)
         · Stage 1 RETRIEVAL  — search for ranked hits, then fetch + extract to markdown
         · Stage 2 EXTRACTION — typed candidates via one JSON-schema-constrained
                                Fireworks (DeepSeek V4 Flash) turn, validated by zod
   ▼
reputability gate: scoreSource per source .........
         · verified if max source score >= REPUTABILITY_VERIFY_THRESHOLD (0.7)
         · else pending (stays in feed, off the aggregate)
         · deciding score + reasoning PERSISTED on the factor (, mig 004)
   ▼
Phase B/C/D  embed → dedupe → resolve → write ..... unchanged
         · idempotency is PER-FINDING (source URL), so re-running a topic each
           cycle ingests only genuinely new sources
   ▼
pg_notify('factor_updates', …) → SSE → browsers ...  (pgRepository)
```

**Live ingestion CANNOT run without BOTH provider keys + network.** With
`FIREWORKS_API_KEY` or a search key missing (or no `DATABASE_URL`) the
scheduled worker logs and NO-OPS — it never fabricates findings. The
offline stubs (`researchFactorsOffline`, `scoreSourceOffline`) exist only for
tests / offline development and are clearly labelled; their placeholder sources
stay `pending`.

**Required env:** `FIREWORKS_API_KEY` (LLM turns **and** Phase B embeddings),
`SERPER_API_KEY` or `BRAVE_API_KEY` (retrieval), `DATABASE_URL` (target DB). **Optional:**
`INGEST_MODEL` (default `accounts/fireworks/models/deepseek-v4-flash`),
`EMBEDDING_MODEL` (default `nomic-ai/nomic-embed-text-v1.5`),
`EMBEDDING_DIMENSIONS` (512 — must match the `halfvec(512)` column),
`RETRIEVAL_MAX_RESULTS` (5), `RETRIEVAL_MAX_CONTENT_CHARS` (10000),
`INGEST_INTERVAL_HOURS` (default 6), `INGEST_TOPICS` (comma/newline separated),
`INGEST_BATCH_TOPICS`, `INGEST_MAX_CANDIDATES`.

**Run:** `npm run ingest` starts the scheduler (immediate first cycle, then every
N hours); `npm run ingest -- --once` (or **`npm run ingest:once`**) runs exactly
one cycle and exits. With both provider keys **and** `DATABASE_URL` present that
one cycle runs LIVE against Postgres; **without** either it runs a fully-OFFLINE
stub cycle against an in-memory repository, printing the resulting factors + gate
decisions and exiting 0 (never hanging, never erroring on missing creds).

> **The live API path is code-complete but must be run by the operator with
> keys.** It is NOT exercised by the test suite — `npm test` is fully offline
> (deterministic stubs only) and never makes a live provider call. Set
> `FIREWORKS_API_KEY` + a search key (+ optionally `DATABASE_URL`) and run
> `npm run ingest:once` to exercise the live retrieve → extract → gate → resolve
> → persist path.

---

## The Reconciliation Loop (Phase B–D)

```
InboundIntelItem[]
   │  content-hash / URL idempotency gate .........    (before any API call)
   ▼
Phase A  extract → validate VALUES → quarantine ... finding 27
   ▼
Phase B  ONE batched embedding call, 512-dim ......  /
   ▼
Phase C  top-k nearest as CANDIDATES ..............  /
   ▼
Phase D  resolver classifies → server recalculates
         → single-target write (insert | escalate)   / finding 29
         under a per-bucket advisory lock .......... finding 29
```

## Files

| File                  | Responsibility                                                        |
| --------------------- | --------------------------------------------------------------------- |
| `llmClient.ts`        | Shared Fireworks (OpenAI-protocol) client + `hasLiveCredentials()` + `INGEST_MODEL` + `structuredCompletion()`. |
| `llmClient.test.ts`   | Offline tests: provider pinning, credential gate, model selection, zod→JSON-Schema derivation. |
| `retrieval.ts`  | The retrieval seam: search + page fetch/extract, `hasRetrievalCredentials()`, publisher derivation, caps. |
| `search.ts`     | Provider selection (`SEARCH_PROVIDER`, else whichever key is set, Serper first). |
| `serperSearch.ts` / `braveSearch.ts` | One file per engine, both returning `SearchHit[]`. |
| `extract.ts`    | Fetch a page and convert it to markdown (Readability + node-html-markdown). Tables survive. |
| `retrieval.test.ts` | Offline tests (injected `fetch`): request body contract, response normalisation, provenance, caps. |
| `websearch.ts`        | Phase A live research (`researchFactors`): retrieval + typed extraction turn. Deterministic offline stub. |
| `reputability.ts`     | Source-credibility gate (`scoreSource`) + `REPUTABILITY_VERIFY_THRESHOLD`. LLM judge + offline heuristic. |
| `noiseFilter.ts`      | Cheap triage in FRONT of the loop for anonymous submissions (`classifySubmission`, ): one constrained call → `plausible`/`spam`/`abuse`/`nonsense`. Injection-hardened; deterministic offline stub. |
| `noiseFilter.test.ts` | Offline-stub tests: verdicts, injection markers, `shouldAutoBan` thresholds, no live call. |
| `embeddings.ts`       | Phase B client. Fireworks embeddings (OpenAI-compatible) + deterministic offline stub. |
| `dedupe.ts`           | Pure Phase C query contract + Phase D decision/escalation math.        |
| `dedupe.test.ts`      | Unit tests for the pure math (`recalculateOnEscalation`, `compareCandidates`, `resolveOutcome`, …). |
| `resolver.ts`         | Phase D LIVE LLM entity resolver (`createLlmResolver`) — proposes relation + metrics; deterministic layer clamps/validates. |
| `resolver.test.ts`    | Offline tests: `verdictFromProposal`, clamping/directionality, deterministic stub fallback (no live call). |
| `memoryRepository.ts` | In-memory `IngestionRepository`/`IngestionTx` — the offline counterpart to `pgRepository.ts` (offline `--once` cycle + `pipeline.test.ts`). |
| `pipeline.test.ts`    | End-to-end OFFLINE integration test: research → embed → dedupe → gate → resolve → persist, plus idempotency + collision→escalation. |
| `websearch.test.ts`   | Offline-stub tests: deterministic candidates, in-domain values, no-cred fallback. |
| `reputability.test.ts`| Offline-stub tests: domain heuristic, `[0,1]` bound, verified/pending threshold gating. |
| `pipeline.ts`         | Impure A→D orchestration: idempotency, batching, quarantine, tx locks. Phase A wired to `researchFactors` via `createResearchExtractor`. |
| `pgRepository.ts`     | The CONCRETE Kysely/Postgres adapter for the ports (write-path contract + `pg_notify`). |
| `worker.ts`           | Scheduled worker (`npm run ingest`): cadence, bounded batch, reputability gate wiring, `runIngestOnce()`. |

Everything the loop touches outside itself is an **injected port**. The port
_interfaces_ (`IngestionRepository` / `IngestionTx`) live in `pipeline.ts`; the
concrete Postgres implementation is `createPgIngestionRepository` in
`pgRepository.ts`, wired by `worker.ts`. The offline stubs (`createStubExtractor`,
`createStubResolver`, the stub embedding client, and an in-memory repository)
keep the whole loop runnable with no network and no Postgres.

## Scope of what is built (Phase 1)

Built and wired to a live database:

- **Concrete repository** (`pgRepository.ts`) implementing both ports against the
  `001_init.sql` + `002_ingestion.sql` schema, following the write-path contract
  (genesis-revision trigger, append-only escalation, `content_hash` idempotency,
  `ingestion_quarantine`). Both write paths emit `pg_notify('factor_updates', …)`
  inside the transaction, so the SSE route (`server/routes/stream.ts`) fans deltas
  to browsers — this module is the emitter that route documents.
- **Worker entrypoint** (`worker.ts`, `npm run ingest`) running `processBatch`.
- **Idempotency, batching, value-validation, quarantine, the  dedup query
  shape, the  escalation math, and advisory-lock concurrency** — all
  production paths, covered by `dedupe.test.ts` for the pure half.

Now **built and live**, superseding the earlier Phase-1 scope note:

- **Phase A is a live research engine.** `researchFactors` (`websearch.ts`) runs
  A web search, then a local fetch/extract per hit, then a typed extraction
  turn on the Fireworks model with JSON-schema constrained decoding. It is
  wired into the pipeline as the `FactorExtractor` via `createResearchExtractor`.
- **A scheduled worker with cadence.** `worker.ts` runs a bounded batch every
  `INGEST_INTERVAL_HOURS`, no longer a one-shot file/stdin batch.
- **The reputability gate** (`reputability.ts`) sets `verified`/`pending` per the
  threshold — machine-extracted factors are no longer unconditionally `pending`.

Now **built** (superseding the earlier out-of-scope notes):

- **Phase D entity resolution has a live LLM implementation**.
  `createLlmResolver` (`resolver.ts`) proposes `relation` + recalculated metrics +
  rationale; the deterministic layer (`resolveOutcome`/`recalculateOnEscalation`,
  ) still computes and bounds the stored numbers. The worker selects it when
  `hasLiveCredentials()`, else keeps `createStubResolver` (offline path, never
  deleted). Failures degrade to `independent`.
- **The reputability score + reasoning are persisted** (, migration 004).
  The gate returns the deciding source's score + reasoning; they land on
  `factors.reputability_score` / `reputability_reasoning`, are read back by the
  feed route, and surface in `FactorDetails`. No longer log-only.

## Key exports

`embeddings.ts`
- `EMBEDDING_DIMENSIONS = 512`, `DEFAULT_EMBEDDING_MODEL`
- `EmbeddingClient` (interface), `createRemoteEmbeddingClient`, `createStubEmbeddingClient`, `stubEmbedding`
- `createEmbeddingClient(env)` — selects real vs stub; **throws in production if no key**

`dedupe.ts`
- `SIMILARITY_QUERY_SHAPE`, `CANDIDATE_TOP_K`, `COLLISION_DISTANCE_THRESHOLD`, `CANDIDATE_DISTANCE_CEILING`
- `FactorCandidate`, `filterCandidates`, `compareCandidates`, `selectParent`
- `escalationLambda`, `recalculateOnEscalation` — the  formula (pure)
- `ResolverVerdict`, `ResolutionOutcome`, `resolveOutcome`

`llmClient.ts`
- `getLlmClient(env)` (OpenAI-protocol client pinned to `FIREWORKS_BASE_URL`), `hasLiveCredentials(env)`, `ingestModel(env)`, `DEFAULT_INGEST_MODEL`, `structuredCompletion(args)`, `jsonSchemaOf(zodSchema)`

`retrieval.ts`
- `retrieveDocuments(query, opts)` → `RetrievedDocument[]`, `hasRetrievalCredentials(env)`
- `normalizeResults`, `publisherFromUrl`, `truncateContent` (pure), `DEFAULT_MAX_RESULTS`, `DEFAULT_MAX_CONTENT_CHARS`

`websearch.ts`
- `researchFactors(topic, opts)` → `CandidateFactor[]` (live retrieval + extraction; offline stub when either key is missing)
- `normalizeCandidate(raw, docs)`, `renderSourceBlocks(docs)` (pure; the provenance-substitution seam)
- `researchFactorsOffline(topic)` — deterministic offline candidates
- types: `CandidateFactor`, `ResearchedSource`, `ResearchOptions`

`reputability.ts`
- `scoreSource(input, opts)` → `{ score, reasoning, provenance }`; `scoreSourceOffline(input)`
- `REPUTABILITY_VERIFY_THRESHOLD` (0.7), types `SourceToScore`, `ReputabilityScore`

`pipeline.ts`
- `createPipeline(deps)` / `createPipelineFromEnv(env, ports)` → `{ processBatch, reconcileOne, embeddings }`
- Ports: `IngestionRepository`, `IngestionTx`, `FactorExtractor`, `EntityResolver`, `SourceAllowlist`
- Write shapes: `NewFactorInput`, `EscalationWriteInput`, `CitationWriteInput`, `RevisionInput`, `QuarantineEntry`
- `ExtractedFactorSchema`, `contentHash`, `draftContentHash`, `bucketKey`
- Live Phase A adapter: `createResearchExtractor(research, gate?)`, types `ResearchFn`, `SourceGate`, `GateResult`
- Offline stubs: `createStubExtractor`, `createStubResolver`

`worker.ts`
- `runIngestOnce(logger?)` — one guarded LIVE cycle (no-op without DB + creds)
- `runIngestOnceOffline(logger?)` — one fully-offline cycle vs an in-memory repo (the `--once` fallback with no creds)
- `buildReputabilityGate(logger, opts)` — the source gate (deciding score + reasoning → `GateResult`, )

`resolver.ts`
- `createLlmResolver(client?)` — live Phase D resolver; `verdictFromProposal`, `deriveDirectionality`, `clampTo` (pure, tested)

`memoryRepository.ts`
- `createMemoryIngestionRepository()` — offline `IngestionRepository` with `.factors()` / `.quarantined()` inspection

## Decisions

### idempotency, batching, structured extraction
- **Idempotency runs first.** `contentHash(item)` (SHA-256 of the canonical URL,
  or publisher + normalized text when there is no URL) is checked against the
  repository **before** extraction or embedding, so re-ingesting the same article
  never spends an API call. `existsBySourceUrl` is the second gate.
- **One batched embedding call per page.** `processBatch` extracts and validates
  the whole page, then calls `embeddings.embed(texts[])` once. The endpoint takes
  arrays; we never embed one factor at a time.
- **Structured extraction, not free-text.** `FactorExtractor` returns typed
  drafts (a JSON-schema-constrained LLM in production). Shape is not enough —
  see finding 27.

### 512-dim Matryoshka embeddings
`createOpenAIEmbeddingClient` requests `dimensions: 512` from the API so the
provider truncates server-side (the prefix is Matryoshka-valid only when the
model emits it — we never slice a 1536-vector ourselves). Matches the
`halfvec(512)` column.

### Similarity threshold is a candidate filter, not a decision
Phase C retrieves `CANDIDATE_TOP_K` (20) nearest within `CANDIDATE_DISTANCE_CEILING`
(0.30). `0.15` survives as `COLLISION_DISTANCE_THRESHOLD`, documented
with its failure modes in both directions (too tight → duplicate events; too
loose → merged distinct events). The **entity-resolution prompt** makes the
escalate/independent call over the candidate set; a fixed scalar on cosine
distance cannot.

### The k-NN query shape
`SIMILARITY_QUERY_SHAPE` is `ORDER BY embedding <=> :q LIMIT :k`, **not** a
`WHERE embedding <=> :q < 0.15` predicate, which would force a sequential scan
(pgvector only uses HNSW for the order-by-limit shape). The order-by form is index-served and returns rows in
*exact* distance order, so `candidates[0]` is the true nearest and `distance` is
exact. The repository is expected to raise `hnsw.ef_search` above the default 40
for this dedup workload (a miss = a false "no collision" = a duplicate insert).

### Explicit escalation recalculation
`recalculateOnEscalation` pins the recalculation to a citation-count-weighted
convex blend:

```
λ            = 1 / (parent.citationCount + 1)
effect'      = clamp((1-λ)·effect_parent + λ·effect_new, -1, 1)
significance = clamp((1-λ)·sig_parent    + λ·sig_new,     0,  1)
```

- **Bounded + saturating.** Clamped, convex inputs mean outputs stay in domain
  and repeated escalation saturates — no runaway counter needed.
- **Monotonicity is explicit.** `significance` may only fall under a
  `de-escalating` verdict; `corroborating`/`intensifying` are non-decreasing
  (`max(parent, blend)`). `effect` may move either way — its sign is the finding.
- **The LLM classifies, the server computes** (finding 28). The resolver emits
  only a directionality label; it never produces the stored numbers. `effect_new`
  / `sig_new` are the incoming report's own Phase-A estimates.
- **Replayable**: each escalation writes a `factor_revisions` row with
  the classified inbound `(effect, significance, directionality)`, so a factor's
  current state is a pure left-fold over its citation history and can be
  recomputed if the formula changes.

### verification state
New factors are inserted with `verificationState: 'pending'`. Machine-extracted
content is marked unreviewed and (per /finding 27) excluded from the field
bake and headline visuals until promoted to `verified`.

### finding 29 — multi-collision + concurrency
- **Deterministic parent selection.** `compareCandidates` is a total order:
  exact cosine distance → oldest `created_at` → smallest `id`. Never HNSW visit
  order. `resolveOutcome` falls back to this nearest parent if the resolver names
  an id that is not in the candidate set (guards against a hallucinated id).
- **One-target write contract.** Exactly one escalation target and one new
  citation per inbound item, even if several candidates look like the same entity.
- **No transitive merging.** `0.15` is not transitive; resolution is
  inbound-vs-existing only and never merges pre-existing rows with each other.
- **Concurrency.** Phase C read → D decide → write runs inside
  `withBucketLock(bucketKey(draft), …)` — a READ COMMITTED transaction holding
  `pg_advisory_xact_lock(hashtext(bucketKey))`. `bucketKey` is
  `spatial_path : ⌊lat⌋ : ⌊lon⌋`, so two sources reporting the same event
  serialize through the critical section. This closes the check-then-insert race
  that content-hash dedupe (different sources, different hashes) cannot.
  - **Tradeoff:** the resolver LLM call happens inside the lock+transaction, so
    the lock is held across a network round-trip. This is acceptable for a dedup
    workload (latency is not critical; a miss is expensive) and contention is
    localized to one spatial bucket. A single ordered consumer partitioned by
    spatial bucket is the equivalent alternative if lock-hold time becomes a
    problem. We deliberately do **not** rely on SERIALIZABLE alone: SSI predicate
    locking over an approximate HNSW scan is unreliable and needs retry logic.

### finding 27 — untrusted write path (partial; the parts this module owns)
- **Value validation.** `ExtractedFactorSchema` re-checks every extracted VALUE
  (JSON-schema constrains shape, not range): `effect ∈ [-1,1]`,
  `significance ∈ [0,1]`, `lat/lon` bounds, `spatialPath` rooted at `global` with
  depth ≤ 2, `.finite()` rejecting `NaN`/`±Infinity`. Failures are **quarantined**
  with a reason, never inserted.
- **Provenance gate (hook).** An optional `SourceAllowlist` quarantines citations
  whose publisher/URL is off-allowlist. Left undefined it is a no-op — provenance
  policy is a deployment decision.
- **Prompt-injection boundary.** `InboundIntelItem.rawText` is documented as
  untrusted; the production Phase-A prompt must delimit and label it as data, not
  instructions.
- Out of this module's scope (tracked to other ADRs / DB layer): global cost
  ceilings and kill-switch, a full reviewer-identity lifecycle, and the schema
  CHECK constraints themselves.

## Offline / testability

Every network dependency has a deterministic, clearly-labelled offline stub gated
on credentials, so nothing fakes live data silently:

- **Embeddings** — `FIREWORKS_API_KEY` unset (non-production) → stub vectors with
  a loud warning; `NODE_ENV=production` with no key throws.
- **Research** — `FIREWORKS_API_KEY` or a search key missing →
  `researchFactorsOffline` (placeholder sources that stay `pending`). Tested in
  `websearch.test.ts`.
- **Reputability** — no `FIREWORKS_API_KEY` → `scoreSourceOffline` domain
  heuristic. Tested in `reputability.test.ts` (threshold gating verified vs
  pending).
- **Noise filter** — no `FIREWORKS_API_KEY` → `classifySubmissionOffline`
  heuristic. Tested in `noiseFilter.test.ts`.
- **Scheduled worker** — no `DATABASE_URL` **or** either provider key missing →
  logs and no-ops; it never arms a timer or fabricates findings.

## The submission entry point

`POST /api/factors/submit` (`server/routes/submit.ts`) is a SECOND producer for
this loop, alongside the scheduled worker. It does **not** re-implement any of
the vetting: `server/submissions/vetting.ts` builds the same
`createPipelineFromEnv` the worker builds, with the submitted claim as the Phase A
research topic and the cited URL appended, and feeds it exactly one item. Effect,
significance, lat/lon and the verified/pending decision therefore come from the
same Phase A extraction and the same  gate — a submitter supplies only a
claim and a source (the request schema is `.strict()` precisely so that stays
true).

`noiseFilter.ts` sits in FRONT of all of it: one small constrained call answering
"is this worth the cost of fact-checking at all?", which runs only after the free
checks (ban, rate limit, duplicate) have passed. It is not a fact-checker, and its
prompt says so — verifying the claim is this pipeline's job. Required env for the
endpoint: `SUBMISSION_SALT` (identity hashing; fatal if missing in DB mode),
optional `TRUST_PROXY`.

The decision math (`recalculateOnEscalation`, `compareCandidates`, `selectParent`,
`resolveOutcome`) is pure and unit-tested in `dedupe.test.ts` (`npm test`).

Against a live database with credentials, `npm run ingest` runs the full live loop
through `pgRepository.ts`; `npm run ingest -- --once` runs a single cycle.
