# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run dev            # Vite client on :5173, proxies /api → :3001 (no CORS surface)
npm run server         # Fastify API on :3001 (tsx watch)
npm run typecheck      # tsc --noEmit — the strict gate, run this before claiming done
npm run build          # typecheck + vite production build
npm test               # vitest run (fully offline; never makes a live provider call)
npx vitest run src/lib/geo.test.ts          # a single suite
npx vitest run -t "escalation"              # a single test by name
npm run db:up          # docker compose: Postgres 17 + pgvector + ltree + PostGIS
npm run db:migrate     # apply db/migrations/*.sql via the schema_migrations ledger
npm run ingest:once    # one bounded ingestion cycle, then exit
```

There is no linter and no vitest config file — vitest picks up `**/*.test.ts` and
`tsconfig.json` supplies `vitest/globals`.

## Two run modes

`server/index.ts` branches on `DATABASE_URL`:

- **Seed mode** (unset) — serves `SEED_FACTORS` from `shared/seed.ts` in memory.
  Every route has an in-memory branch keyed on `appCtx.mode`; feed, field and SSE
  all work, ingestion and live deltas do not. This is the default dev path and it
  must keep working — do not add a route that only has a `db` branch.
- **DB mode** — Kysely over `pg`. `SUBMISSION_SALT` is **fatal if missing** here
  (unsalted IP digests are reversible across IPv4); seed mode falls back to an
  ephemeral per-process salt with a loud warning.

Live ingestion additionally needs `FIREWORKS_API_KEY` (LLM turns + embeddings)
and `FIRECRAWL_API_KEY` (retrieval). Missing either → the worker logs and no-ops;
it never fabricates findings. Offline stubs exist for every network dependency
and are credential-gated and loudly labelled.

## Architecture

### The ADR system — read this before changing behaviour

`docs/ARCHITECTURE.md` is the governing document: ADR-1 … ADR-45 (ADR-4 folded
into ADR-3; ADR-28/29 unassigned). Code that **contradicts explicit text** in
`docs/spec-comprehensive.md` / `docs/spec.md` carries a `SPEC DEVIATION (ADR-n)`
comment at the site; ADRs that only *add* capability carry a plain ADR reference.
Only ADR-1…30 have deviation tags — 31–45 build on ground the specs left blank.
When you change something governed by an ADR, update the ADR — don't silently
diverge.

Later ADRs supersede earlier ones without the earlier text being rewritten. The
live ones to know: **ADR-44** replaced Anthropic + OpenAI with Fireworks +
Firecrawl (so ADR-31's two-turn `web_search` mechanism and ADR-33/38's
`messages.parse` are gone — the *contracts* survive), **ADR-34** replaced the
arbitrary Clock window with tipping-point anchoring, and **ADR-37** superseded
ADR-33's "persistence is follow-up" note. Read the newest ADR touching an area
before trusting an older one.

### Client (`src/`)

- `lib/geo.ts` — the **only** sanctioned lat/lon ⇄ `Vector3` conversion (ADR-25).
  Every call site routes through it; hand-written trig on a lat/lon identifier is
  how the heatmap ends up mirrored relative to the pins.
- `globe/field.ts` — the CPU reference kernel and the unit-test target. The
  accumulation runs **once per data change** on the CPU and is baked to an
  equirectangular texture (`bakeField.ts`) the shader samples in O(1) (ADR-1);
  the GLSL never loops over factors. Two fields (evidence density `W`, net
  polarity `P`) so "no data" (grey) is distinguishable from "contested
  equilibrium" (purple) — conflating them was a confirmed blocker (ADR-3).
- `camera/` — `OrbitRig`, `alignment.ts` (interpolates **position**, not
  orientation, so there is no roll — ADR-27), `interrupt.ts` (capture-phase guard
  that drops the camera lock on any manual input).
- `App.tsx` — composition root. **Render-on-demand** (ADR-7): no unconditional
  rAF; a single coalesced `requestRender()` is called only on actual change.

### The two data paths (ADR-26) — load-bearing

1. **Feed** — `GET /api/factors`, cursor-paginated, sort-toggled. Drives the
   sidebar and badges and **nothing on the GPU**.
2. **Field** — `GET /api/field`, fetched once and again *only* when SSE
   (`GET /api/stream`) signals a factor changed. Never re-fetched on camera move,
   scroll, sort, or selection. This is what makes two clients on the same
   `fieldEpoch` render the same planet.

Keeping these separate is not incidental; do not merge the call sites.

### Contract (`shared/`)

`schema.ts` holds the zod schemas; `types.ts` derives TS types via `z.infer`
(ADR-23). Never hand-write a type that duplicates a schema. Numeric domains
mirror the DB CHECK constraints (`effect ∈ [-1,1]`, `significance ∈ [0,1]`).
Both sides validate at the boundary — the server re-validates its own responses.

### Server (`server/`)

Fastify + Kysely (ADR-24). `routes/{factors,field,stream,submit}.ts`,
`pagination.ts` (mode-tagged cursors — `recent` keysets on immutable `seq`,
`magnitude` is a bounded snapshot; ADR-15/15a), `db.ts`.

`ingestion/` is the Phase A→D reconciliation loop; **read
`server/ingestion/README.md` before touching it.** Shape: retrieve (Firecrawl) →
extract (typed, JSON-schema-constrained Fireworks turn, re-validated by zod) →
reputability gate → embed (batched, 512-dim) → dedupe (`ORDER BY <=> LIMIT k`, so
HNSW is actually used — ADR-30) → resolve → write under a per-bucket advisory
lock. The LLM *classifies*; the server *computes* every stored number
(`recalculateOnEscalation`). Everything outside the loop is an injected port with
both a `pgRepository` and a `memoryRepository` implementation.

`submissions/` — anonymous `POST /api/factors/submit` (ADR-45). The request
schema is `.strict()` on purpose: `effect`, `significance`, `verificationState`,
`lat`, `lon`, `tippingPoint` are system-assigned, and accepting them would let
anyone steer the Clock. Checks run cheapest-first (schema → ban → rate limit →
duplicate → one classifier call → pipeline). Identities are `sha256(salt‖ip)` /
`sha256(salt‖deviceId)`; no raw IP is ever stored. Shadow-banned submitters get
the byte-identical success payload.

### Database (`db/`)

Migrations are numbered and applied through the ledger; `003_future_federation.sql.planned`
is deliberately not a `.sql` file. Event-sourced: `factor_revisions` plus
genesis/projection triggers, so a factor's state is a left-fold over its citation
history (ADR-13). Viewport queries use PostGIS spherical predicates, not
`lat/lon BETWEEN` (antimeridian — ADR-8).

## Project constraints

- **Verifiability is the product.** Every factor is backed by citations; the
  field is a function of the data alone, never of camera state. Ingested factors
  land `pending` and are excluded from the field bake and the Clock aggregate
  until `verified` (ADR-20).
- **Never overclaim provenance.** The Clock (ADR-34) anchors to the corpus's own
  dated tipping points; the amount net polarity may shift that baseline
  (`maxShiftYears`, default 5, via `VITE_CLOCK_MAX_SHIFT_YEARS`) is an **operator
  estimate**, not a corpus figure — do not present it as one. With no
  tipping-point factors, `deriveClock` returns `hasBaseline: false` and the UI
  suppresses the countdown rather than inventing an instant; keep it that way.
  Real sources live in `docs/corpus-bibliography.md`; the specs carry no
  bibliography.
- **TypeScript is strict** with `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. The latter makes zod's `.optional()` (`T | undefined`)
  nominally distinct from `?: T` — rebuild the object explicitly rather than
  casting (see `toClockFactor` in `App.tsx`).
