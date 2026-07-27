# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run dev            # Vite client on :5173, proxies /api → :3001 (no CORS surface)
npm run server         # Fastify API on :3001 (tsx watch)
npm run typecheck      # tsc --noEmit — the strict gate, run before claiming done
npm run lint           # eslint . — hazards tsc cannot see; run with typecheck
npm run lint:fix       # eslint . --fix
npm run build          # typecheck + vite production build
npm test               # vitest run (fully offline; never makes a live provider call)
npx vitest run src/lib/geo.test.ts          # a single suite
npx vitest run -t "escalation"              # a single test by name
npm run db:up          # docker compose: Postgres 17 + pgvector + ltree + PostGIS
npm run db:migrate     # apply db/migrations/*.sql via the schema_migrations ledger
npm run ingest:once    # one bounded ingestion cycle, then exit
```

There is no vitest config file — vitest picks up `**/*.test.ts` and
`tsconfig.json` supplies `vitest/globals`.

ESLint is scoped to what `tsc` cannot see, and carries NO formatting rules
(no Prettier): reformatting the tree would bury real history in whitespace.
Its rules encode incidents this repo actually had — object-literal assertions
that silently drop fields under `exactOptionalPropertyTypes`, and floating
promises in ingestion scripts, where an unawaited write looks exactly like
"the model found nothing" after the retrieval was already paid for. Where a
rule is knowingly violated the line carries a disable comment WITH the reason;
add the reason, never just the disable.

`npm run ingest:once` with no credentials runs a fully offline cycle against an
in-memory repository and exits 0, which makes it a good end-to-end smoke test
for server changes.

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
and a search key — `SERPER_API_KEY` or `BRAVE_API_KEY` (retrieval). Missing
either → the worker logs and no-ops;
it never fabricates findings. Every network dependency has a credential-gated,
loudly-labelled offline stub.

## Architecture

`docs/ARCHITECTURE.md` records why the non-obvious decisions are what they are.
Read the relevant section before changing behaviour in that area, and update it
when the reasoning changes. The rules below are the ones most easily broken by a
plausible-looking edit.

### Layout

- `src/components/<Name>/` — one folder per component, with structure, logic and
  styling in their own files plus a barrel `index.ts`. Follow this when adding a
  component; merge structure and logic only when the component is trivial.
- `src/hooks/` — one hook per stateful concern.
- `src/scene/` — the imperative three.js layer, kept out of React.
- `src/lib/` — domain logic with no React or DOM dependency.
- `server/ingestion/` — `types.ts` and `ports.ts` define the shapes and the
  injected interfaces; `pipeline.ts` orchestrates; `dedupe.ts` holds the pure
  decision math. Ports have both a Postgres and an in-memory implementation.

### The two data paths — load-bearing

1. **Feed** — `GET /api/factors`, cursor-paginated. Drives the sidebar and
   **nothing on the GPU**.
2. **Field** — `GET /api/field`, fetched once and again _only_ when SSE signals a
   change. Never re-fetched on camera move, scroll, sort or selection.

Keeping these separate is what makes two clients on the same `fieldEpoch` render
the same planet. Do not merge the call sites, and never write shader input from a
camera or pagination path.

### Invariants worth knowing before you edit

- `src/lib/geo.ts` is the **only** place lat/lon becomes a vector. Hand-written
  trig on a coordinate is how the heatmap ends up mirrored relative to the pins,
  and it passes a `|v| = R` check.
- Render-on-demand: no unconditional rAF. `requestRender()` is called on actual
  change only.
- Grey/untinted geography means _no data_ and must stay distinguishable from
  purple, which means _documented opposing forces_.
- Ingested factors land `pending` and stay out of the field bake and the Clock
  aggregate until the reputability gate promotes them.
- The submission schema is `.strict()` on purpose: `effect`, `significance`,
  `verificationState`, `lat`, `lon` and `tippingPoint` are system-assigned, and
  accepting them would let anyone steer the Clock.
- Shadow-banned submitters must receive the byte-identical success response. Any
  later divergence — including a rate-limit error a normal user would get —
  reveals the ban.
- Pagination keys on the immutable `seq`, never on a column ingestion mutates.

### Honesty constraints

These are product requirements, not preferences:

- **Never fabricate to fill a gap.** No tipping-point factors means
  `hasBaseline: false` and a suppressed countdown, not a default target.
- The Clock's shift is interpolation _inside_ each threshold's published
  earliest/latest band — it never moves the band. Do not reintroduce an operator
  knob that lets the countdown travel past what a source actually published.
- Paraphrased citations must never render as quotes; `verbatim` defaults to
  `false` so unknown provenance is treated as paraphrase.
- Known gaps are documented rather than papered over — `verbatim` is the model's
  self-report and is not machine-checked against the source text, and anonymous
  submissions raise the cost of abuse without eliminating it. Keep such
  limitations stated.

### TypeScript

Strict, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. The
latter makes zod's `.optional()` (`T | undefined`) nominally distinct from
`?: T` — rebuild the object explicitly rather than casting (see
`src/lib/clock/toClockFactor.ts`). Read paths strip SQL `null` before
re-validating, because the schemas are `.optional()` and never `.nullable()`.
