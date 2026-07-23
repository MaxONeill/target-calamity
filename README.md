# Target: Calamity

An empirical, non-linear reality tracker rendered on a 3D WebGL globe. It tracks
cascading ecological and systemic tipping points and models humanity's window of
viable course-correction as a single headline "Clock."

The Clock's countdown is **anchored to the corpus's own dated tipping points**
(ADR-34): the baseline target is the significance-weighted mean of the central
tipping years across the factors that carry one, and the net polarity then shifts
that baseline sooner (Calamity) or later (Humanity), bounded by an
**operator-set** `maxShiftYears` estimate. With **no** tipping-point factors there
is no baseline and the countdown is **suppressed**, not invented. The shift bound
is a configured estimate, never a corpus quotation.

Every point on the globe is shaded by a two-field accumulation of nearby
**factors**: signed *effect* (Calamity ↔ Humanity) weighted by *significance*.
Every factor is backed by hard citations. The product's credibility rests on it
being **empirical, verifiable, and reproducible** — not on theatre — so the field
is a function of the data alone (never of where your camera is pointing), and the
Clock is labelled a *modeled projection, not a measurement*.

---

## What you are looking at

- **The globe** — a displaced icosphere carrying a **geographic base** (ADR-41):
  deep-blue ocean, green land rising through brown uplands to white peaks
  (ADR-43), with real terrain relief baked from the Open-Meteo elevation grid
  (ADR-42) and glowing coastline vector lines on the surface (ADR-39, toggled by
  the `LAND` button). The chromatic field is **blended on top** of that base, so
  where there is no evidence you see plain geography and where factors exist the
  signal tints through. The field itself is the baked two-field / three-state
  model (ADR-3):
  - **Crimson** — Calamity dominates locally (net polarity → −1).
  - **Electric blue** — Humanity/resilience dominates (net polarity → +1).
  - **Deep purple** — *contested equilibrium*: strong opposing forces, both
    documented, roughly cancel (high evidence density, polarity ≈ 0).
  - **Untinted geography** — *insufficient coverage*: no verified factors within
    the support radius, so the surface shows the plain geographic base. This is an
    **absence of data, deliberately distinct from purple** — the original spec
    conflated the two, which was a confirmed blocker. (Before ADR-41 added the
    geographic base this state rendered as inert grey; the *distinction* it exists
    to preserve is unchanged.)
- **Pins** — one instanced marker per field factor: a long thin inverted pyramid
  standing on the surface, length keyed to significance and hued by the same ramp,
  so a pin and the region it charges read as one color (ADR-42).
- **The Clock** (top-left) — a compact widget showing the target year and a
  years-inclusive live countdown (`Yy Dd HH:MM:SS`); clicking it expands the full
  derivation — baseline, signed shift, net polarity, calamity load, humanity
  buffer, tipping points, confidence, and the sound toggle (ADR-40). It is
  self-describing as a model: it is tagged a **modeled projection, not a
  measurement**, and with no tipping-point evidence the countdown is suppressed
  rather than inventing an instant. The `[ i ]` glyph opens the explainer.
- **The right slideout** — closed by default; the `FEED` tab opens it. It hosts
  **either** the factor feed (sortable by recency or absolute magnitude,
  cursor-paginated, with inline citation lines) **or** the selected factor's
  detail view (full description, tipping point, reputability verdict, and every
  source) **or** the submission form — never more than one (ADR-40).

### Interaction

- **Drag** or **WASDQE** to orbit; **wheel** / **Q**/**E** to zoom.
- **Click a pin** or **click a card** to fly the camera to face that factor over
  750ms and select it. Any manual camera input **drops the lock instantly**.
- The globe repaints **on demand only** — there is no free-running render loop.

---

## Running it

### Prerequisites

- Node 20+ and npm.
- (Full mode only) Docker, for the PostgreSQL 17 + pgvector + ltree + PostGIS
  database.

### Install

```bash
npm install
```

### Seed mode — no database required

The server runs against the curated `shared/seed.ts` corpus (22 factors — 17
`verified` and traceable to `docs/corpus-bibliography.md`, plus 5 held `pending`
because their real sources are not yet reproduced in that corpus — with 23
citations) when `DATABASE_URL` is unset. This is the fastest way to see the whole
app; the feed, field, and SSE endpoints all work, but ingestion and live deltas
do not.

```bash
# Terminal 1 — API on :3001 (seed mode; logs "SEED MODE" loudly)
npm run server

# Terminal 2 — Vite dev server on :5173 (proxies /api → :3001)
npm run dev
```

Open http://localhost:5173.

### Full mode — with the database

```bash
cp .env.example .env          # DATABASE_URL points at the docker service
npm run db:up                 # start Postgres (pgvector/pgvector:pg17 + PostGIS)
npm run db:migrate            # apply db/migrations/001_init.sql
npm run server                # now boots in DB mode
npm run dev
```

See `db/README.md` for version floors, the PostGIS layering note for the base
image, and the full migration deviation list.

### Real terrain (already baked; re-run only to change resolution)

A grid ships in the repo at `public/elevation-grid.json`, so terrain works out of
the box. To re-bake it (needs network, no API key):

```bash
npm run fetch:elevation           # default 240×120, ~288 requests
npm run fetch:elevation -- --force   # re-fetch over an existing same-size grid
```

Idempotent and resumable — an existing same-size grid short-circuits, and partial
progress is checkpointed between batches. If the file is missing the client
degrades gracefully to a land-relief fallback (continents raised a constant over
flat ocean) rather than failing (ADR-42).

### Live ingestion — one cycle

```bash
npm run ingest:once           # one bounded ingestion cycle, then exit
```

Live research needs **both** provider keys (ADR-44) — **`FIREWORKS_API_KEY`**
(Fireworks AI: DeepSeek V4 Flash for the typed turns, plus the embeddings) and
**`FIRECRAWL_API_KEY`** (Firecrawl `/v2/search` for retrieval) — plus optionally
**`DATABASE_URL`** to persist (else the cycle runs in-memory and logs). With all
present, `ingest:once` runs the full live path — retrieve → extract →
reputability gate → dedupe/resolve → persist. With the keys missing it runs a
fully-offline stub cycle against an in-memory repository, prints the resulting
factors + gate decisions, and exits 0.

> The **live provider path is code-complete but must be run by the operator with
> keys** — it is deliberately **not exercised by the test suite**, which is fully
> offline (deterministic stubs, no live calls). See
> `server/ingestion/README.md`.

### Verify

```bash
npx tsc --noEmit    # strict typecheck (exact-optional, no-unchecked-index, …)
npm run build       # tsc + vite production build
npm test            # vitest: geo, clock model, and field kernel suites
```

## Stack

| Layer          | Choice                                                              |
| -------------- | ------------------------------------------------------------------ |
| Client         | Vite + React 18 + TypeScript (strict) + three.js (direct, WebGL2)  |
| Server         | Node + TypeScript, Fastify, Kysely over `pg`, run via `tsx`        |
| Contract       | `zod` schemas in `shared/`, TS types via `z.infer` (one source)    |
| Database       | PostgreSQL 17 — `vector`, `ltree`, `postgis` — via docker-compose  |
| Geo data       | `world-atlas` 110m TopoJSON (coastlines + land mask), Open-Meteo elevation |
| Ingestion LLM  | Fireworks AI (DeepSeek V4 Flash) + embeddings; Firecrawl for retrieval (ADR-44) |
| Packaging      | Single root `package.json`                                         |

> The `openai` npm package is a dependency, but **no request is ever made to
> `api.openai.com`**. It is used purely as an HTTP client for the OpenAI *wire
> protocol*, pinned to `https://api.fireworks.ai/inference/v1` — `llmClient.test.ts`
> asserts the base URL. See ADR-44.

### The two data paths (ADR-26)

The client keeps two API call sites **strictly separate** — this is load-bearing,
not incidental:

1. **Sidebar feed** — `GET /api/factors` with cursor pagination and a sort
   toggle. Drives the list and the badges, and **nothing on the GPU**.
2. **Shader field** — `GET /api/field` fetched **once**, and again **only** when
   the SSE stream signals a factor changed. Its pins go to the field baker and
   the pin layer. This is never re-uploaded on a camera move, scroll, sort, or
   selection — which is what makes two clients on the same `fieldEpoch` render
   the same planet.

Live updates arrive over `GET /api/stream` (SSE, ADR-17); the client patches
cached cards in place and invalidates the field, rather than mutating the
immutable-keyset backfill feed.

### Anonymous submissions (ADR-45)

`POST /api/factors/submit` lets anyone propose a factor with **no account**, at
**one submission per identity per 24 hours**.

```jsonc
// request — and this is the WHOLE contract; the schema is .strict()
{
  "claim": "…one factual statement…",
  "sourceUrl": "https://…",          // must parse and be http(s)
  "note": "optional, for a reviewer",
  "deviceId": "…uuid from localStorage…"
}
```

`effect`, `significance`, `verificationState`, `lat`, `lon` and `tippingPoint`
are **system-assigned** by the vetting pipeline. Sending any of them is a hard
400, not a silently dropped field — if a submitter could set them, anyone could
steer the Clock's aggregate by hand.

Checks run **cheapest-first** so a rejected submission never costs money: schema
→ ban lookup → rate limit → duplicate → one small noise-classifier call → the
existing ingestion pipeline. A shadow-banned submitter receives the byte-identical
success payload a genuine one does and is never told otherwise.

Environment:

| Variable | Required | What it does |
| --- | --- | --- |
| `SUBMISSION_SALT` | **yes, in DB mode** | Salt for `sha256(salt‖ip)` / `sha256(salt‖deviceId)`. **No raw IP is ever stored.** The server refuses to boot in DB mode without it — unsalted digests are reversible across the whole IPv4 space. Rotating it resets every ban and rate-limit window. |
| `TRUST_PROXY` | no (default off) | Set to `1` only when behind a reverse proxy you control; then the first hop of `X-Forwarded-For` is the client. Trusting it unproxied lets anyone mint a fresh identity per request. |

**Honest limitation:** without auth this raises the cost of abuse rather than
eliminating it. Someone who clears localStorage and changes IP gets another
attempt; the classifier re-flags the behaviour and re-bans the new identity, and
they receive no feedback either way. See ADR-45.

---

## Deviations from spec

This implementation departs from the literal text of `docs/spec-comprehensive.md`
and `docs/spec.md` wherever an **Architecture Decision Record** in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) supersedes it, or a confirmed spec
defect required a fix. Code that **contradicts explicit spec text** carries a
`SPEC DEVIATION (ADR-n)` comment at its site; ADRs that *add* capability the spec
left unspecified carry an ordinary ADR-referencing comment instead. The table
below maps each adopted ADR to where it lives; read `docs/ARCHITECTURE.md` for the
full rationale of each.

### ADR coverage

`docs/ARCHITECTURE.md` defines **ADR-1 … ADR-45**, with **ADR-4 folded into
ADR-3**, refinements **ADR-11a** and **ADR-15a**, and **ADR-28 / ADR-29
deliberately unassigned** (the registry jumps 27 → 30; the ingestion hardening
that would sit at 28/29 is tracked as confirmed-defect numbers #27–#31 in
`server/ingestion/README.md` instead). Every ADR is implemented; none was silently
omitted.

Broadly, **ADR-1 … ADR-30** are the original spec-reconciliation set, and
**ADR-31 … ADR-45** are the later capability work — the live research engine,
the tipping-point Clock, the geographic globe, the provider migration, and
anonymous submissions.

**Which ADRs carry a `SPEC DEVIATION` tag (and which don't):** not all of them, and
it would be dishonest to claim otherwise. The ones that *replace* spec behaviour
carry the tag — **1, 2, 3, 5, 7, 8, 9, 10, 11/11a, 12, 13, 14, 15/15a, 19, 20, 25,
26, 27, 30**. The ones that *add* capability the spec left unspecified or
reinterpret an unspecified constant — **6** (WebGL2 target), **16** (`json_agg`
citations), **17** (SSE), **18** (0.15 threshold-as-filter), **21**
(idempotency/batching), **22** (docker-compose), **23** (zod), **24** (Kysely) —
fill a gap rather than contradict spec text, so they carry ordinary
ADR-referencing comments, not a `SPEC DEVIATION` tag. **ADR-4** has no site at all
(its content lives inside ADR-3).

**None of ADR-31 … ADR-45 carries a `SPEC DEVIATION` tag**, and that is correct
rather than an oversight: every one of them builds on ground the specs left blank
(there is no spec text describing a scheduled research engine, a geographic base
layer, terrain displacement, an anonymous submission endpoint, or which provider
to call), so they carry plain ADR-referencing comments. `grep -r "SPEC DEVIATION"`
returns tags only for the numbers listed in the previous paragraph.

| ADR | Decision (supersedes spec) | Where the `SPEC DEVIATION` lives |
| --- | --- | --- |
| **1** | Bake the chromatic field to a texture; no per-fragment factor loop | `src/globe/field.ts`, `src/globe/bakeField.ts`, `src/globe/shaders.ts`, `src/globe/GlobeMesh.ts` |
| **2** | Angular distance via dot product, not Euclidean chord + `acos` | `src/globe/field.ts` |
| **3** | Two-field, three-state color model; resolves the purple = no-data blocker | `src/globe/field.ts`, `src/globe/shaders.ts`, `src/globe/bakeField.ts`, `src/globe/PinLayer.ts` |
| **4** | *(folded into ADR-3 — no separate site)* | — |
| **5** | Icosphere geometry, not a UV sphere | `src/globe/GlobeMesh.ts` |
| **6** | WebGL2 / GLSL ES 3.0 target | `src/globe/shaders.ts`, `src/globe/GlobeMesh.ts` |
| **7** | Instanced pins, GPU picking, render-on-demand (no unconditional rAF) | `src/globe/PinLayer.ts`, `src/globe/GlobeMesh.ts`, `src/App.tsx` |
| **8** | PostGIS spherical viewport, not `lat/lon BETWEEN` (fixes antimeridian) | `db/migrations/001_init.sql`, `server/db.ts`, `server/routes/factors.ts` |
| **9** | `REAL` / `DOUBLE PRECISION`, not unbounded `NUMERIC` | `db/migrations/001_init.sql`, `server/db.ts` |
| **10** | `zone_level` as a generated column derived from `spatial_path` | `db/migrations/001_init.sql`, `server/db.ts` |
| **11 / 11a** | The CHECK constraints the spec documented but never enforced; `effect ∈ [-1,1]`, NOT NULL timestamps, `factor_id NOT NULL` | `db/migrations/001_init.sql`, `server/db.ts`, `shared/schema.ts` |
| **12** | `halfvec(512)` Matryoshka embedding + HNSW + tsvector hybrid retrieval | `db/migrations/001_init.sql`, `server/db.ts`, `server/ingestion/embeddings.ts` |
| **13** | Actual event sourcing (`factor_revisions` + genesis/projection triggers) | `db/migrations/001_init.sql`, `server/db.ts` |
| **14** | Correct extension name — `CREATE EXTENSION vector`, not `pgvector` | `db/migrations/001_init.sql` |
| **15 / 15a** | Sort-mode-tagged cursors; recent keysets on immutable `seq`, magnitude is a bounded snapshot | `server/pagination.ts`, `server/db.ts`, `db/migrations/001_init.sql`, `server/routes/factors.ts`, `src/App.tsx` |
| **16** | Citations inline via `json_agg` LATERAL, one round trip | `server/routes/factors.ts` |
| **17** | SSE for live updates | `server/routes/stream.ts`, `src/App.tsx` |
| **18** | 0.15 similarity as a candidate *filter*, not a decision boundary | `server/ingestion/dedupe.ts` |
| **19** | Explicit, replayable escalation recalculation (clamped convex blend) | `server/ingestion/dedupe.ts`, `db/migrations/001_init.sql` |
| **20** | Ingested factors land `pending`; the field bake takes only `verified` | `db/migrations/001_init.sql`, `server/db.ts`, `server/ingestion/pipeline.ts`, `src/ui/FactorCard.tsx` |
| **21** | Idempotency (content hash / URL), batching, structured extraction | `server/ingestion/pipeline.ts` |
| **22** | `docker-compose` on `pgvector/pgvector:pg17` (+ PostGIS) | `docker-compose.yml`, `db/Dockerfile` |
| **23** | `zod` as the single shared contract | `shared/schema.ts`, `shared/types.ts` |
| **24** | Kysely for typed SQL | `server/db.ts`, `server/routes/*` |
| **25** | Explicit angular units; one sanctioned lat/lon → vector helper | `src/lib/geo.ts` (and every call site routes through it) |
| **26** | The shader field set is data-defined and camera-invariant (feed ≠ field) | `server/routes/field.ts`, `src/globe/GlobeMesh.ts`, `src/globe/bakeField.ts`, `src/App.tsx` |
| **27** | Orbital alignment interpolates **position, not orientation** (no roll) | `src/camera/alignment.ts` |
| **28 / 29** | *(unassigned — registry jumps 27 → 30; ingestion fixes tracked as defect numbers)* | — |
| **30** | HNSW k-NN dedup query shape: `ORDER BY <=> LIMIT`, not a `<=> < 0.15` predicate | `server/ingestion/dedupe.ts`, `server/ingestion/pgRepository.ts`, `server/ingestion/pipeline.ts` |

### ADR-31 … ADR-45 — capability the specs left unspecified

These fill gaps rather than contradict spec text, so they carry ordinary
ADR-referencing comments (no `SPEC DEVIATION` tag). Column three is where each
lives, not where a deviation is tagged.

| ADR | Decision | Where it lives |
| --- | --- | --- |
| **31** | Phase A becomes a live research engine: topic → typed `CandidateFactor[]` with per-source provenance. **Provider superseded by ADR-44** — the contract holds, the Anthropic `web_search` two-turn mechanism is gone | `server/ingestion/websearch.ts`, `createResearchExtractor` in `pipeline.ts` |
| **32** | Scheduled worker: cadence, bounded rotating batch, and the load-bearing **no-creds ⇒ no-op** guard (never fabricates findings) | `server/ingestion/worker.ts` |
| **33** | LLM reputability score gates `verified` / `pending` at `REPUTABILITY_VERIFY_THRESHOLD` (0.7) | `server/ingestion/reputability.ts`, `worker.ts`, `pipeline.ts` |
| **34** | **Tipping-point Clock baseline** — supersedes the arbitrary-window idea. Weighted mean of central tipping years, shifted by net polarity within an operator-set bound; no tipping points ⇒ no countdown | `src/ui/clockModel.ts`, `src/ui/Clock.tsx` |
| **35** | `tippingPoint` is first-class on **both** `Factor` and `FieldPin` (the Clock reads the *field* set), stored as JSONB (migration 003) | `shared/schema.ts`, `db/migrations/003_tipping_points.sql`, `server/routes/{factors,field}.ts`, `server/ingestion/*` |
| **36** | Factor detail view on selection, showing every source. Verbatim quotes are quoted; paraphrases are not — a restatement can never masquerade as a quote | `src/ui/FactorDetails.tsx` |
| **37** | Reputability score **+ reasoning persisted** on the factor and surfaced in the UI (migration 004) — the gate is auditable, not a black box | `db/migrations/004_reputability.sql`, `server/ingestion/{worker,pipeline,pgRepository}.ts`, `server/routes/factors.ts`, `src/ui/FactorDetails.tsx` |
| **38** | Live LLM Phase D entity resolver; the LLM only *proposes*, the deterministic ADR-19 layer still computes and clamps every stored number. Stub kept as the offline path | `server/ingestion/resolver.ts`, `worker.ts` |
| **39** | Glowing coastline vector lines from `world-atlas` 110m TopoJSON, one draw call, great-circle subdivided | `src/globe/Coastlines.ts` |
| **40** | Overlay restructure: one right slideout hosting feed **XOR** detail **XOR** submission; compact years-inclusive Clock that expands its derivation | `src/App.tsx`, `src/styles.css`, `src/ui/Clock.tsx`, `src/ui/FactorDetails.tsx` |
| **41** | Ocean-blue / land-green geographic base with the field **blended on top**; wireframe reuses the same color; pin halo attenuated | `src/globe/landMask.ts`, `src/globe/shaders.ts`, `src/globe/GlobeMesh.ts`, `src/globe/field.ts` |
| **42** | Real terrain displacement from a baked Open-Meteo grid, floored at sea level, with a land-relief fallback; inverted-pyramid pins | `scripts/fetch-elevation.mjs`, `src/globe/elevation.ts`, `src/globe/GlobeMesh.ts`, `src/globe/PinLayer.ts` |
| **43** | Green → brown → white land ramp keyed off the displaced vertex radius; coastline lift reduced to a hairline | `src/globe/shaders.ts`, `src/globe/GlobeMesh.ts` |
| **44** | **Provider migration** — Fireworks (reasoning + embeddings) and Firecrawl (retrieval) replace Anthropic + OpenAI, behind the same interfaces. Provenance is assembled server-side from `sourceIndex`, so the model cannot forge a URL | `server/ingestion/llmClient.ts`, `firecrawlClient.ts`, `websearch.ts`, `reputability.ts`, `resolver.ts`, `embeddings.ts`, `worker.ts` |
| **45** | Anonymous submissions: hashed IP+device identity, 1/day, shadow bans byte-identical to success, cheapest-first checks | `server/routes/submit.ts`, `server/submissions/*`, `server/ingestion/noiseFilter.ts`, `db/migrations/005_submissions.sql`, `src/ui/SubmitFactor.tsx` |

### Deviations without a governing ADR

Three departures are grounded in the corpus / spec text rather than a numbered
ADR; each carries a `SPEC DEVIATION` comment stating so:

- **Clock target** (`src/ui/clockModel.ts`) — neither spec defines what the Clock
  counts down *to*, so the file carries a "no governing ADR; confirmed spec
  defect" tag. **What it does now is ADR-34**, which superseded the earlier
  arbitrary-window reading: the baseline is the significance-weighted mean of the
  factors' central tipping years, and net polarity shifts it within
  `maxShiftYears` (default 5, overridable at build time via
  `VITE_CLOCK_MAX_SHIFT_YEARS`). That bound is an **operator estimate**, not a
  corpus figure. With no tipping-point factors the model reports
  `hasBaseline === false` and the countdown is suppressed. `deriveClock` is pure
  and total — empty, all-pending, or poisoned input yields a defined model rather
  than a `NaN` or a throw.
- **Tick audio** (`src/audio/tick.ts`) — the spec references a background ambient
  tick but gives no synthesis detail; it is realized as a quiet, band-limited
  WebAudio click created lazily on a user gesture (autoplay policy) and halted
  while the explainer modal is open.
- **Gestalt button** (`src/ui/GestaltButton.tsx`) — comprehensive §8 is Phase-2
  Roadmap; the button is rendered permanently disabled with a `PHASE 2` tag rather
  than pretending to deep-link into a trust graph that does not yet exist.

### Ingestion-layer decisions beyond the numbered set

The reconciliation pipeline additionally implements the fixes for confirmed
defects #27–#31 (source allowlist / untrusted-text handling, cost controls,
deterministic multi-collision parent selection, advisory-lock concurrency, and
the `ORDER BY embedding <=> :q LIMIT :k` query shape so the HNSW index is actually
used). The dedupe module labels the query-shape fix `SPEC DEVIATION (ADR-30)`,
which is now defined in the registry (see `docs/ARCHITECTURE.md`); see
`server/ingestion/README.md` for the full contract.

---

## Repository layout

```
shared/        zod contract (schema.ts), derived types (types.ts), seed corpus (seed.ts)
src/
  lib/geo.ts   the one sanctioned lat/lon ⇄ vector conversion (ADR-25)
  globe/       field kernel, bake, shaders, GlobeMesh, PinLayer, Coastlines,
               landMask (ADR-41), elevation (ADR-42/43)
  camera/      OrbitRig, alignment (position-slerp), interrupt guard
  ui/          Sidebar, FactorCard, Clock, FactorDetails, SubmitFactor,
               ExplainerModal, GestaltButton, clock model
  audio/       tick.ts — the lazily-created ambient WebAudio click
  App.tsx      composition root — wires the scene to the UI and the two data paths
scripts/       fetch-elevation.mjs (npm run fetch:elevation, ADR-42)
public/        elevation-grid.json — the baked Open-Meteo grid (ADR-42)
server/        Fastify API (factors, field, stream, submit), pagination, Kysely db layer
  submissions/ identity hashing, store, vetting handoff (ADR-45)
  db/migrate.ts  migration runner (npm run db:migrate) over the schema_migrations ledger
  ingestion/   Phase A→D reconciliation loop: pure math (+ tests), Postgres adapter
               (pgRepository.ts) + in-memory adapter (memoryRepository.ts), worker.ts
               (npm run ingest / ingest:once). Phase A live research (websearch.ts),
               reputability gate (reputability.ts), and Phase D LLM resolver
               (resolver.ts) are code-complete with offline stubs — the live
               Fireworks + Firecrawl path (llmClient.ts / firecrawlClient.ts) is
               operator-run, not in the (offline) test suite.
db/            migrations, seed SQL, Dockerfile, README
docs/          spec-comprehensive.md, spec.md, ARCHITECTURE.md (ADR-1 … ADR-45),
               corpus-bibliography.md (the real sources behind the seed corpus)
```

## License

Private / unpublished.
