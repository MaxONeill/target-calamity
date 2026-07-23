# Target: Calamity

An empirical, non-linear reality tracker rendered on a 3D WebGL globe. It tracks
cascading ecological and systemic tipping points and models humanity's window of
viable course-correction as a single headline "Clock."

The Clock's countdown is **anchored to the factor set's own dated tipping
points**: the baseline is the significance-weighted mean of the central tipping
years across the factors that carry one, and net polarity then shifts that
baseline sooner (Calamity) or later (Humanity), bounded by an **operator-set**
`maxShiftYears` estimate. With **no** tipping-point factors there is no baseline
and the countdown is **suppressed**, not invented. The shift bound is a
configured estimate, never a figure quoted from a source.

Every point on the globe is shaded by a two-field accumulation of nearby
**factors**: signed *effect* (Calamity ↔ Humanity) weighted by *significance*.
Every factor is backed by hard citations. The product's credibility rests on it
being **empirical, verifiable, and reproducible** — not on theatre — so the field
is a function of the data alone (never of where your camera is pointing), and the
Clock is labelled a *modeled projection, not a measurement*.

---

## What you are looking at

- **The globe** — a displaced icosphere carrying a **geographic base**:
  deep-blue ocean, green land rising through brown uplands to white peaks, with real terrain relief baked from the Open-Meteo elevation grid and glowing coastline vector lines on the surface (, toggled by
  the `LAND` button). The chromatic field is **blended on top** of that base, so
  where there is no evidence you see plain geography and where factors exist the
  signal tints through. The field itself is the baked two-field / three-state
  model:
  - **Crimson** — Calamity dominates locally (net polarity → −1).
  - **Electric blue** — Humanity/resilience dominates (net polarity → +1).
  - **Deep purple** — *contested equilibrium*: strong opposing forces, both
    documented, roughly cancel (high evidence density, polarity ≈ 0).
  - **Untinted geography** — *insufficient coverage*: no verified factors within
    the support radius, so the surface shows the plain geographic base. This is an
    **absence of data, deliberately distinct from purple**; collapsing the two
    would let the globe imply a reading where none exists.
- **Pins** — one instanced marker per field factor: a long thin inverted pyramid
  standing on the surface, length keyed to significance and hued by the same ramp,
  so a pin and the region it charges read as one color.
- **The Clock** (top-left) — a compact widget showing the target year and a
  years-inclusive live countdown (`Yy Dd HH:MM:SS`); clicking it expands the full
  derivation — baseline, signed shift, net polarity, calamity load, humanity
  buffer, tipping points, confidence, and the sound toggle. It is
  self-describing as a model: it is tagged a **modeled projection, not a
  measurement**, and with no tipping-point evidence the countdown is suppressed
  rather than inventing an instant. The `[ i ]` glyph opens the explainer.
- **The right slideout** — closed by default; the `FEED` tab opens it. It hosts
  **either** the factor feed (sortable by recency or absolute magnitude,
  cursor-paginated, with inline citation lines) **or** the selected factor's
  detail view (full description, tipping point, reputability verdict, and every
  source) **or** the submission form — never more than one.

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

With `DATABASE_URL` unset the server serves the curated factors in
`shared/seed.ts` — 22 factors (17 `verified`, 5 held `pending`) with 23
citations. This is the fastest way to see the whole app: the feed, field and SSE
endpoints all work, but ingestion and live deltas do not.

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

See `db/README.md` for version floors and the PostGIS layering note for the base
image.

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
flat ocean) rather than failing.

### Live ingestion — one cycle

```bash
npm run ingest:once           # one bounded ingestion cycle, then exit
```

Live research needs **both** provider keys — **`FIREWORKS_API_KEY`**
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
| Ingestion LLM  | Fireworks AI (DeepSeek V4 Flash) + embeddings; Firecrawl for retrieval |
| Packaging      | Single root `package.json`                                         |

> The `openai` npm package is a dependency, but **no request is ever made to
> `api.openai.com`**. It is used purely as an HTTP client for the OpenAI *wire
> protocol*, pinned to `https://api.fireworks.ai/inference/v1` — `llmClient.test.ts`
> asserts the base URL. See .

### The two data paths

The client keeps two API call sites **strictly separate** — this is load-bearing,
not incidental:

1. **Sidebar feed** — `GET /api/factors` with cursor pagination and a sort
   toggle. Drives the list and the badges, and **nothing on the GPU**.
2. **Shader field** — `GET /api/field` fetched **once**, and again **only** when
   the SSE stream signals a factor changed. Its pins go to the field baker and
   the pin layer. This is never re-uploaded on a camera move, scroll, sort, or
   selection — which is what makes two clients on the same `fieldEpoch` render
   the same planet.

Live updates arrive over `GET /api/stream` (SSE, ); the client patches
cached cards in place and invalidates the field, rather than mutating the
immutable-keyset backfill feed.

### Anonymous submissions

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
they receive no feedback either way.

---

## Repository layout

```
shared/        zod contract (schema.ts), derived types (types.ts), seed factors (seed.ts)
src/
  components/  one folder per component, with structure, logic and styles split
               into their own files: Clock, Sidebar, FactorCard, FactorDetails,
               SubmitFactor, ExplainerModal, StatusBar, Slideout
  hooks/       one per stateful concern: feed pagination, field fetch, SSE
               stream, scene lifecycle, coordinate lookup, slideout state
  scene/       the imperative three.js layer: factory, picking, terrain upgrade
  globe/       field kernel, bake, shaders, GlobeMesh, PinLayer, Coastlines,
               landMask, elevation
  camera/      OrbitRig, alignment (position-slerp), interrupt guard
  lib/         geo.ts (the one sanctioned lat/lon ⇄ vector conversion), clock/
  audio/       tick.ts — the lazily-created ambient WebAudio click
  App.tsx      composition root — wires the scene to the UI and the two data paths
scripts/       fetch-elevation.mjs (npm run fetch:elevation)
public/        elevation-grid.json — the baked Open-Meteo grid
server/        Fastify API (factors, field, stream, submit), pagination, Kysely db layer
  submissions/ identity hashing, store, vetting handoff
  db/migrate.ts  migration runner (npm run db:migrate) over the schema_migrations ledger
  ingestion/   the A→D reconciliation loop, split by responsibility:
               types.ts / ports.ts (shapes + injected interfaces),
               pipeline.ts (orchestration), dedupe.ts (pure decision math),
               contentHash.ts, researchExtractor.ts, stubs.ts,
               pgRepository.ts + memoryRepository.ts (the two port adapters),
               worker.ts (npm run ingest / ingest:once).
               The live Fireworks + Firecrawl path is operator-run; the test
               suite is fully offline.
db/            migrations, seed SQL, Dockerfile, README
docs/          ARCHITECTURE.md — why the non-obvious decisions are what they are
```

## License

Private / unpublished.
