# Architecture Decisions

Adopted decisions that **supersede** the literal text of `spec.md` (v3.2) and `spec-comprehensive.md` where they conflict. Each entry states what the spec said, what we do instead, and why.

Implementation code that departs from spec text must carry a `SPEC DEVIATION:` comment referencing the relevant ADR number below.

---

## Rendering

### ADR-1 — Bake the chromatic field to a texture (supersedes per-fragment accumulation)

**Spec:** the fragment shader loops over every active factor per fragment, accumulating `C(p) = Σ Eᵢ·Sᵢ / max(d, ε)^k`.

**Decision:** compute the accumulation field **once per data change** into an equirectangular `DataTexture` (RGBA32F / half-float), and sample it in the globe fragment shader.

**Why:** the spec's approach is O(N) per pixel per frame, requires a compile-time `MAX_FACTORS` cap, and forces a shader recompile whenever the factor count changes. Baking makes the fragment shader O(1), removes the cap entirely, and moves cost to ingest time — the field is static between data updates, so recomputing it at 60Hz is pure waste.

**Notes:** bake resolution 2048×1024. Store normalized signed charge in one channel and accumulated coverage weight in another (see ADR-3). Keep `src/globe/field.ts` as the CPU reference implementation — it is both the baker and the unit-test target.

### ADR-2 — Angular distance via dot product (supersedes Euclidean chord distance)

**Spec:** `d(p, xᵢ)` is the Euclidean chord distance.

**Decision:** define falloff over **angular** distance, computed as `dot(p, xᵢ)` on unit vectors.

**Why:** chord distance distorts falloff at range — antipodal points are `2R` by chord but `πR` by geodesic. The dot product *is* the angular measure, costs a single instruction, and avoids `acos`/`length()` entirely. Cheaper and geometrically correct.

### ADR-3 — Two-field, three-state color model (supersedes single-scalar C(p); resolves the purple ambiguity)

> Revised after the audit (confirmed defect: "Purple encodes both contested equilibrium and no-data"). This ADR replaces the earlier coverage-modulation sketch and the separate normalization ADR-4 with one coherent model. **Do not ship any part of this without all of it** — normalization alone is strictly *worse* than the spec, because with a single cached pin the normalized polarity equals that pin's effect everywhere, flooding the globe.

**Spec:** purple denotes both "equilibrium — high-trust networks actively buffering degradation" (prose) and "default wireframe baseline" (v3.2 §3 diagram). An unnormalized inverse-distance *sum* `C(p)` decays to ~0 far from all factors, so empty ocean renders identically to genuinely contested regions — and the fixed `±0.5` ramp thresholds are meaningless against an unbounded sum.

**Decision:** compute **two** fields with a compact-support kernel, and gate color on evidence:

```
w_i(p) = S_i / max(d(p,x_i), eps)^k        for d <= d_max, else 0     (k = 2.0, from v3.2)
W(p)   = Σ_i w_i(p)                        evidence density  (>= 0, unbounded)
P(p)   = Σ_i E_i·w_i(p) / W(p)            net polarity  (bounded to [minE, maxE]; undefined where W=0)
```

- `d_max` is a chord distance from an angular cutoff: `d_max = 2R·sin(θ_max/2)`, default **θ_max = 15°**, exposed as a uniform. Without the cutoff `W` has a nonzero floor and the grey state is never reachable.
- `eps` cancels between numerator and denominator, so `P → E_i` as `p → x_i` — peak color no longer depends on the arbitrary epsilon.

**Three states, not two:**

```
W < W_min           → INERT GREY   (unlit wireframe baseline ~#3A3A42, deliberately OFF the R–P–B ramp)
W >= W_min          → hue = ramp(P):  crimson(P=-1) — purple(P=0) — electric blue(P=+1)
                       sat/opacity = smoothstep(W_min, W_full, W)
```

Ship `W_min = 0.05`, `W_full = 1.0` as tunable uniforms (units of `ΣS/d²`; re-tune if the effect/significance domains change). Genuine contested equilibrium (many strong opposing pins, high W, P≈0) renders **vivid saturated purple**; no coverage renders **inert grey**. They are distinguishable at a glance — the entire point.

**Acceptance test (one factor at (0,0), effect −1, significance 1):** correct = small red patch within θ_max, inert grey elsewhere, zero purple. Spec behavior = red hemisphere fading to purple. Normalization-only = whole globe red. All three distinguishable in one screenshot.

**Legend/diagram (both specs):** delete the "(Default Wireframe Baseline)" annotation from the purple node — that annotation *is* the bug in writing. Add a grey entry: "Insufficient coverage — no verified factors within θ_max. An absence of data, not a finding." Reword purple as conditional on evidence: "Contested equilibrium — comparable opposing forces both documented here." Purple must never be reachable without underlying citations (v3.2 §4's promise).

**Depends on ADR-11a:** `effect` must be bounded to `[-1,1]` for `P` and the `±0.5` thresholds to have meaning.

### ADR-4 — (folded into ADR-3)

The separate `tanh` normalization is withdrawn. Normalization is now the `/W` division in ADR-3, which is only safe behind the `W` evidence gate. See ADR-3.

### ADR-5 — Icosphere geometry (supersedes UV sphere)

**Decision:** `IcosahedronGeometry(R, detail)` rather than `SphereGeometry`.

**Why:** UV spheres crowd vertices severely at the poles — uneven wireframe density and non-uniform field sampling. Icosphere distributes near-uniformly.

### ADR-6 — WebGL2 / GLSL ES 3.0 target

**Decision:** target WebGL2 explicitly.

**Why:** GLSL ES 1.0's constant-loop-bound restriction is the *reason* a `MAX_FACTORS` cap was needed. ES 3.0 allows dynamic bounds and offers UBOs. (WebGPU/TSL deferred — still maturing.)

### ADR-7 — Instanced pins, GPU picking, render-on-demand

**Decision:** one `InstancedMesh` for all pins; hit-testing by rendering IDs to an offscreen target; render only on change rather than an unconditional rAF loop.

**Why:** one draw call instead of N, picking that doesn't scale with factor count, and a page meant to sit open for hours that doesn't hold a core at 100%.

---

## Data model

### ADR-8 — PostGIS for spatial queries (supersedes lat/lon bounding box)

**Spec:** `lat BETWEEN :min_lat AND :max_lat AND lon BETWEEN :min_lon AND :max_lon`.

**Decision:** add PostGIS; store `geog geography(Point,4326)` alongside lat/lon and query with `ST_DWithin` / `ST_Intersects`.

**Why:** the spec's filter breaks outright across the antimeridian, and the visible region of a sphere is never a lat/lon rectangle — the box degenerates near the poles and is meaningless at hemisphere zoom. PostGIS makes these failure modes not exist rather than working around them.

### ADR-9 — Float types (supersedes unbounded `NUMERIC`)

**Decision:** `effect` and `significance` become `REAL`; `lat`/`lon` become `DOUBLE PRECISION`.

**Why:** unbounded `NUMERIC` is arbitrary-precision and slow, and these values reach the shader as float32 regardless. `NUMERIC(8,6)` encodes ~11cm precision for factors whose real granularity is national.

### ADR-10 — `zone_level` as a generated column

**Decision:** derive from `nlevel(spatial_path)` as a stored generated column (fall back to a trigger + CHECK if the expression is not immutable in the installed ltree version).

**Why:** the spec documents `zone_level` as restricted to values derivable from `spatial_path`, but enforces nothing — the two can drift. Deriving it removes the class of bug structurally.

### ADR-11 — Constraints the spec documents but does not enforce

**Decision:** `CHECK (significance BETWEEN 0 AND 1)`, `CHECK (nlevel(spatial_path) <= 2)`, `CHECK (spatial_path <@ 'global'::ltree)` (reject rootless paths), index on `citations(factor_id, retrieved_at DESC)`, and an `updated_at` trigger. Every timestamp on the cursor path (`created_at`, `updated_at`) is `NOT NULL` (a NULL sort key makes a row permanently unreachable via keyset pagination). `citations.factor_id` is `NOT NULL` (the header says "one-to-many strict"). All range CHECKs use `BETWEEN`, which also rejects `NaN`/`±Infinity` — do **not** use the float `x = x` idiom, since for `numeric` `NaN = NaN` is TRUE and lets poison through.

**ADR-11a — `effect` bounded:** `CHECK (effect BETWEEN -1 AND 1)`. This is load-bearing for ADR-3: the normalized polarity `P` inherits `effect`'s units, so the `±0.5` ramp thresholds only mean anything if `effect` is bounded. The Phase D escalation path (ADR-19) must clamp to this domain too — it is the most likely place to push `effect` out of range.

**Why:** `updated_at` in particular is load-bearing — both the pagination cursor and the ingestion resolution logic depend on it being accurate and non-null, and nothing currently maintains it. Note the interaction with **ADR-15a**: since Phase D mutates `updated_at`, it cannot also be the stable pagination key; see ADR-15a.

### ADR-12 — Hybrid retrieval, `halfvec`, Matryoshka truncation

**Decision:** `tsvector` + GIN alongside the HNSW vector index; store embeddings as `halfvec`; truncate to 512 dimensions via the embedding API's `dimensions` parameter.

**Why:** this corpus is dense with entities and figures ("14.33 million square kilometers") — precisely where pure vector search underperforms keyword. `halfvec` roughly halves storage at negligible HNSW recall cost; 512-dim Matryoshka truncation cuts index size ~3× at minimal quality loss.

### ADR-13 — Actual event sourcing

**Spec:** §2 describes the database as "event-sourced," but the schema is a single mutable table and Phase D overwrites `effect`/`significance` in place — the opposite of event sourcing.

**Decision:** append-only `factor_revisions` table; `factors` becomes the current-state projection.

**Why:** makes the spec's own claim true, provides an audit trail for *why* a factor's weight changed (important for a product whose premise is verifiability), and yields the Clock's history over time — otherwise unrecoverable.

### ADR-14 — Correct extension name

**Spec:** `CREATE EXTENSION IF NOT EXISTS pgvector;`

**Decision:** `CREATE EXTENSION IF NOT EXISTS vector;`

**Why:** the extension is named `vector`. The spec's statement fails outright — the migration dies at line 2.

---

## API

### ADR-15 — Sort-mode-aware cursors

**Spec:** cursor `(updated_at, id)` with a "Sorting Override" toggling to `|effect|` ordering.

**Decision:** encode sort mode into an opaque base64 cursor; use the matching keyset predicate per mode; reject a cursor whose mode disagrees with the request. Add an index supporting `abs(effect)` ordering.

**Why:** an `(updated_at, id)` cursor cannot paginate an `|effect|` ordering. Toggling sort mid-scroll silently duplicates and skips rows. Opaque cursors also stop clients hand-constructing invalid ones.

### ADR-16 — Citations inline via `json_agg`

**Decision:** return citations with their factors in one round trip using `json_agg` / `LATERAL`.

**Why:** the spec's `SELECT` omits citations entirely while the UI requires them — a naive fix is an N+1 per 50-row page.

### ADR-17 — SSE for live updates

**Decision:** Postgres `LISTEN`/`NOTIFY` → Server-Sent Events.

**Why:** the spec describes a continuous feed but no delivery mechanism; polling is the wrong shape for it.

---

## Ingestion

### ADR-18 — Similarity threshold as candidate filter, not decision boundary

**Spec:** cosine distance `< 0.15` decides collision.

**Decision:** retrieve top-k within a looser bound as *candidates*; the entity-resolution prompt makes the actual determination. `0.15` becomes a named, documented constant.

**Why:** the spec conflates retrieval with decision. A single hard global boundary on 1536-dim cosine distance misfires in both directions.

### ADR-19 — Explicit escalation recalculation

**Decision:** define and document the formula recalculating `effect`/`significance` on escalation.

**Why:** §3 Phase D says these are "dynamically recalculated" but never says how — an implementer must invent it, so it should be inventoried and inspectable rather than buried.

### ADR-20 — Verification state on ingested factors

**Decision:** LLM-ingested factors land in a `pending` state, visibly marked in the UI, distinct from verified entries.

**Why:** §3 is an unbounded LLM write path. The explainer copy now reads "aims to represent an empirical, verifiable fact" (user revision), so this is no longer a correction of an overclaim — but marking machine-extracted content as unreviewed remains correct, and costs nothing.

### ADR-21 — Idempotency, batching, structured extraction

**Decision:** content-hash/URL dedupe *before* embedding; batch embedding calls; JSON-schema-constrained extraction for Phase A.

**Why:** re-ingesting an article shouldn't cost an API call, the embeddings endpoint takes arrays, and free-text parsing is the wrong tool for structured extraction.

---

## Tooling

### ADR-22 — `docker-compose.yml` with `pgvector/pgvector:pg17` (+ PostGIS)

One command to a working database.

### ADR-23 — `zod` as the shared contract

Schemas shared client/server with TypeScript types derived from them: one source of truth, plus runtime validation at the API boundary.

### ADR-24 — Kysely for typed SQL

**Why:** keyset pagination is the code most likely to break silently. Type-safe query construction is worth the dependency precisely there.

---

## Post-audit ADRs (25–27)

These were confirmed by the adversarial spec audit and supersede the corresponding module instructions where they conflict.

### ADR-25 — Explicit angular units; one sanctioned lat/lon → vector conversion

**Spec:** §5 Step One / v3.2 §1 write `cos(lat)` etc. with no units. lat/lon are stored in **degrees**; JS/GLSL trig takes **radians**. Passing degrees in silently produces wrong coordinates that pass a `|v| = R` check — undetectable by inspection.

**Decision:** exactly one place converts geography to geometry: `src/lib/geo.ts` (the shared module already owned by scaffold — `coords.ts` in the audit text folds into it). It exports `latLonToVector3(latDeg, lonDeg, R)` and `vector3ToLatLon(v)`, degree-in/out, matching the spec's sign convention (`x = R·cosφ·cosλ, y = R·sinφ, z = −R·cosφ·sinλ`, `φ=lat·π/180, λ=lon·π/180`). **Every** call site routes through it — pin instance matrices (ADR-7), the camera target (ADR-27), and the field baker's `x_i` set. Raw `Math.cos`/`Math.sin` on any `lat`/`lon` identifier outside `geo.ts` is banned; GLSL never sees lat/lon (ADR-1/-2 feed it only unit vectors and the baked texture), so GLSL's `radians()` should never appear in a shader.

**Regression test that actually catches the bug:** assert the great-circle angle between London (51.5, −0.13) and Tokyo (35.68, 139.69) is 85.6° ± 0.1°. A `|v| = R` test passes *under* the bug — it is not coverage. The equirectangular baker's texel→direction map (ADR-1) must be the exact inverse of `latLonToVector3`; derive it by calling the helper, and test that a single injected factor's argmax texel decodes back to its lat/lon (otherwise the heatmap is rotated/mirrored relative to the pins).

### ADR-26 — The shader field set is data-defined and camera-invariant (separate from the feed)

**Spec:** v3.2 §3 feeds the shader from "the client's current viewport cache" — i.e. the paginated, viewport-clipped feed of comprehensive §4. That makes the heatmap a function of scroll position and camera angle, so two users (or one user mid-scroll) see different fields for the same planet, and screenshots aren't reproducible. This defeats the "empirical/verifiable" premise.

**Decision:** two independent data paths.
- The cursor-paginated, viewport-clipped, recency/magnitude-ordered query (ADR-15/-16) drives the **sidebar feed and nothing else**. It must never touch shader uniforms.
- A separate **`GET /api/field`** endpoint, with **no camera and no cursor parameters**, returns the field set in one response, ranked by actual field influence and capped by a rendering budget:
  ```sql
  SELECT id, effect, significance, lat, lon
  FROM factors
  WHERE verification_state = 'verified' AND ABS(effect * significance) >= :weight_floor
  ORDER BY ABS(effect * significance) DESC, id ASC
  LIMIT :field_capacity;            -- field_capacity = 2048, a spec constant
  ```
  `, id ASC` is mandatory (Postgres has no stable order for ties; without it the determinism bug returns). Back it with `CREATE INDEX idx_factors_field_rank ON factors ((ABS(effect*significance)) DESC, id ASC)`.
- The field baker (ADR-1) consumes **only** this response. Its input is rewritten **only** on receipt of a new `/api/field` response — never in the OrbitControls change handler, never in the render loop, never in the pagination reducer. That negative rule is what actually kills the flicker/scroll-drift.
- `/api/field` returns a `field_epoch` (`MAX(updated_at)` over the set); two clients with the same epoch are provably rendering the same field.

**Note:** whether the shader loops over pins-in-a-data-texture (`texelFetch`, `uFieldCount` uniform int as the loop bound) or samples the baked equirect texture (ADR-1) is an implementation choice; either removes the uniform-array cap. A `vec4[]` uniform array **cannot** carry 2048 pins (WebGL2 guarantees only 224 fragment uniform vectors) — pins, if passed directly, go in an RGBA32F data texture.

### ADR-27 — Orbital alignment interpolates position, not orientation (supersedes "slerp the camera quaternion")

**Spec:** §5 Step Three / v3.2 §1.3 say to slerp the camera **quaternion**. Slerping between two look-at orientations injects **roll** — the horizon tilts mid-flight and rights itself at the end, so the artifact is invisible in any start/end screenshot. Step Three also never applies Step Two's position, so as written the pin never actually comes to face the camera.

**Decision:** animate **position on the fixed-radius orbit sphere**, orientation falls out for free.
- **Step One** units per ADR-25. **Step Two:** the framing direction is the pin's outward normal `n = normalize(pinPos)`; target orbit distance `D = clamp(camera.position.length(), MIN_ZOOM, MAX_ZOOM)` sampled at selection time (preserves the user's current zoom). `MIN_ZOOM = 1.15·R` with `camera.near ≤ 0.05·R` so the near plane can't enter the mesh; wire `MIN_ZOOM/MAX_ZOOM` to the orbit rig's min/max distance so manual and automated framing share one range. The orbit pivot stays `(0,0,0)` and is never reassigned.
- **Step Three:** over the 750ms cubic ease-in-out, geodesically slerp the *direction* (`dir0 = normalize(p0) → dir1 = n`) and separately ease the *radius* (`D0 → D`); each frame recompose `camera.position = dir(t)·radius(t)`, set `camera.up = (0,1,0)`, and `camera.lookAt(0,0,0)`. This keeps the pole axis vertical every frame — no roll by construction. Easing only reshapes timing; it does **not** remove roll from a quaternion slerp.
- **Poles:** three.js already guards NaN (`makeSafe`, `lookAt` up⊥forward perturbation) — no extra clamp. The one thing the library can't decide: when `|lat|` is within ~1e-4 of ±90 the destination azimuth is degenerate, so hold the camera's pre-animation azimuth rather than deriving one from the destination.
- **Step Four** interrupt (ADR: race-safe generation counter) unchanged.

**Test:** sample camera roll (right-vector angle vs world-up) at a **mid-flight** point of a diagonal alignment (e.g. London→Sydney) and assert ≈0° — not just at t=0 and t=1, where it is always 0.

---

## Ingestion (continued)

### ADR-28, ADR-29 — (unassigned numbers)

Numbers 28 and 29 were never allocated as ADRs, so the registry sequence jumps **27 → 30**. The ingestion-layer hardening that would otherwise sit here (source allowlist / untrusted-text handling, advisory-lock concurrency, cost controls, deterministic multi-collision parent selection) is tracked as **confirmed-defect / finding** numbers (#27–#31) in `server/ingestion/README.md`, not as numbered ADRs. ADR-30 is the only post-27 ADR number cited anywhere in the code, which is why it is the only one defined below. This note exists so the gap is deliberate and documented rather than looking like a missing entry.

### ADR-30 — HNSW k-NN dedup query shape: `ORDER BY <=> LIMIT`, not a distance predicate

**Spec:** comprehensive §3 Phase C reads "queried for cosine distance collisions (< 0.15)" — naturally implemented as a `WHERE embedding <=> :q < 0.15` predicate.

**Decision:** write Phase C similarity retrieval as a top-k order-by-limit —
`SELECT …, embedding <=> :q AS distance FROM factors WHERE embedding IS NOT NULL ORDER BY embedding <=> :q LIMIT :k` — with the raised `hnsw.ef_search` acting as the candidate recall floor and the `0.15` / `0.30` thresholds (ADR-18) applied in an **outer** filter, never in the SQL `WHERE`.

**Why:** pgvector only uses the HNSW index for the `ORDER BY <=> … LIMIT` shape; a bare `<=> < 0.15` predicate falls back to a sequential scan that computes the distance on every row. The order-by form is index-served **and** returns rows in exact distance order (the `<=>` operator computes exact distance; HNSW only affects which rows are *visited*), so `candidates[0]` is the true nearest and the reported `distance` is exact. A neighbour missed because `ef_search` was left at the default 40 is a false "no collision" — i.e. a duplicate factor double-counting its charge in the field — so the repository raises `ef_search` well above the default for this workload. Threshold-as-filter (ADR-18) is what keeps `0.15` a candidate boundary rather than a decision boundary.

**Implemented in:** `server/ingestion/dedupe.ts` (`SIMILARITY_QUERY_SHAPE`, and the total-order parent selection that consumes it), `server/ingestion/pgRepository.ts` (`findNearestFactors`), `server/ingestion/pipeline.ts`.

---

## Live research engine (31–33)

The seeded factors were only examples. The real system is a **live research engine**: on a schedule it pulls information from the internet, verifies each claim against reputable sources, assigns a signed **direction** (`effect`, negative = Calamity, positive = Humanity) and a **magnitude** (`significance` ∈ [0,1]), and the app aggregates all factors into a net direction + magnitude that drives the Clock. These ADRs define how Phase A becomes live and how its output is trusted.

### ADR-31 — Live web-search ingestion via the Anthropic `web_search` server tool

> **Provider superseded by [ADR-44](#adr-44--ingestion-provider-migration-fireworks--firecrawl-replacing-anthropic--openai).** The Phase-A CONTRACT below (topic → typed `CandidateFactor[]` with per-source provenance, offline stub gated on credentials) still holds; the Anthropic `web_search` tool, the two-turn `pause_turn` dance and `messages.parse`/`zodOutputFormat` described here are gone.

**Spec / prior state:** comprehensive §3 Phase A was "an LLM turns an untrusted intel item into structured factor drafts," left as a stub (`createStubExtractor`) with no actual acquisition of information.

**Decision:** Phase A is a live research engine. `researchFactors(topic)` (`server/ingestion/websearch.ts`) runs the model's **built-in `web_search` server tool** (`{ type: "web_search_20260209", name: "web_search" }`, no beta header) — the model chooses its own sources; we verify after (ADR-33). It runs as **two turns**, because structured outputs are incompatible with citations and with message prefill:
- **Turn 1 — RESEARCH** (free-form, tools on): the web_search turn, returning written findings + source URLs. Server-tool turns can stop with `stop_reason: "pause_turn"`; we resume by pushing `{role:"assistant", content: response.content}` and re-calling, capped at 5 resumes. web_search results arrive as `web_search_tool_result` blocks and errors come back HTTP 200 with an error object — both are branched on, not assumed.
- **Turn 2 — EXTRACTION** (no tools, `output_config.format` on): `client.messages.parse({ … output_config: { format: zodOutputFormat(Schema) } })`, reading `response.parsed_output` (guarded for null), into typed candidate factors.

Both turns use `max_tokens: 16000` and `thinking: { type: "adaptive" }`. The model is `INGEST_MODEL` (default `claude-opus-4-8`). The SDK client is constructed zero-arg (`new Anthropic()`), resolving credentials from the environment — no key is ever read or passed in code (`server/ingestion/anthropicClient.ts`).

**Idempotency (interacts with ADR-21):** the live engine RE-researches the same topics every cycle on purpose, so item-level (topic) dedupe would wrongly skip re-research. The idempotency unit is therefore the **finding**: `draftContentHash` keys on the citation's source URL (falling back to publisher + normalized text), checked *after* extraction. Article items that carry a URL keep the cheaper pre-extraction skip. Embedding similarity (Phase C), not this hash, still decides insert vs escalate.

**Why:** the product premise is empirical and verifiable; that requires actually going to primary/reputable sources rather than emitting invented drafts. The built-in server tool lets the model select sources with dynamic filtering; the two-turn split keeps typed extraction clean without losing source URLs.

**Offline:** with no credentials (`hasLiveCredentials()` false), `researchFactors` returns a deterministic, clearly-labelled OFFLINE STUB whose sources are placeholders (so the ADR-33 gate keeps them `pending`). Production never fabricates live findings — it gates on `hasLiveCredentials()`.

**Implemented in:** `server/ingestion/anthropicClient.ts`, `server/ingestion/websearch.ts`, and `createResearchExtractor` in `server/ingestion/pipeline.ts` (wires Phase A to `researchFactors`; Phase B/C/D unchanged).

### ADR-32 — Scheduled worker: cadence, bounded batch, seed-mode no-op

**Spec / prior state:** `worker.ts` was a one-shot entrypoint that read one `InboundIntelItem[]` batch from a file or stdin.

**Decision:** the worker (`server/ingestion/worker.ts`) is a **scheduler**. It runs a **bounded batch** each cycle (`INGEST_BATCH_TOPICS` topics from `INGEST_TOPICS` or a built-in set spanning **both** Calamity and Humanity so the aggregate is not structurally biased, `INGEST_MAX_CANDIDATES` per topic) on a **cadence** (`INGEST_INTERVAL_HOURS`, default 6) via a simple `setInterval` scheduler (no new dependency), with an immediate first run. The topic window rotates across cycles so a bounded batch still covers the full list over time. Every write emits `pg_notify` (via `pgRepository.ts`) for the SSE fan-out. `runIngestOnce()` is exported for manual/testable single cycles (`npm run ingest -- --once`).

**Guard (load-bearing):** the scheduler will **not run unattended without live ingestion credentials AND a `DATABASE_URL`** (ADR-44: `FIREWORKS_API_KEY` **and** `FIRECRAWL_API_KEY`; originally `ANTHROPIC_API_KEY`) — missing either, it logs clearly and no-ops (it arms no timer and runs no cycle). This prevents a seed-mode / no-creds dev box from spinning an idle timer or, worse, fabricating "live" data.

**Why:** a "live" tracker needs a standing cadence, not a manual batch; bounding the batch caps per-cycle cost; the no-op guard makes "no key = nothing happens, loudly" the safe default.

**Implemented in:** `server/ingestion/worker.ts`.

### ADR-33 — LLM reputability score gate → verified / pending

**Spec / prior state:** ADR-20 landed all machine-extracted factors as `pending` unconditionally, with no mechanism to ever promote them.

**Decision:** an **LLM reputability score** decides trust. `scoreSource({url, publisher, quoteSnippet, claim})` (`server/ingestion/reputability.ts`) returns a credibility score in `[0,1]` **and a reasoning string**, via `messages.parse` + `zodOutputFormat` (adaptive thinking, no tools). The worker scores every source of a candidate, takes the **max**, and gates on a named constant `REPUTABILITY_VERIFY_THRESHOLD` (default **0.7**): at or above → the factor is `verified` (enters the Clock aggregate and the field bake, ADR-26); below → `pending` (stays in the feed, off the aggregate). The reasoning is retained for **auditability** — the gate is never a black box.

**Threshold failure modes (why it is a named, tunable constant):** too high → reputable primary sources sit `pending` forever and the Clock under-reacts (aggregate starved); too low → weak blogs drive the Clock and the "verifiable" premise is hollow. 0.7 keeps clearly-reputable sources in and clearly-weak ones out, leaving the ambiguous middle `pending` for review.

**Direction vs magnitude:** `effect` is the signed position on the Humanity↔Calamity axis and `significance` the magnitude; the reputability gate governs only *whether a factor counts*, not its direction/magnitude (those come from Phase A / the ADR-19 recalculation).

**Offline:** no credentials → a deterministic domain heuristic (`scoreSourceOffline`), clearly labelled `provenance: "offline-stub"`, so threshold gating is testable without the network. A single live scoring failure falls back to the heuristic rather than crashing the cycle.

**Persistence note:** the score drives the stored `verification_state`; the reasoning is currently **logged** for audit. Persisting it to a dedicated column is DB-layer follow-up — the `citations`/`factors` write path (`pgRepository.ts`) has no reputability column yet.

**Implemented in:** `server/ingestion/reputability.ts`, the gate wiring in `server/ingestion/worker.ts`, and the `verificationState` plumbing in `server/ingestion/pipeline.ts` (`ExtractedFactorSchema` + the insert branch).

---

## The Clock — tipping-point anchoring (34–36)

The Clock was reworked to anchor its countdown to the polycrisis's own **tipping points**, not to an invented window. These ADRs record that model, the data plumbing that carries a tipping point end-to-end, and the selection detail view that surfaces the evidence behind a factor.

### ADR-34 — Tipping-point Clock baseline (supersedes the arbitrary-window idea)

**Spec / prior state:** neither spec defined what the Clock counts down TO, nor how the factor set produces a time value. An earlier reading invented an arbitrary countdown window — a fabricated deadline with no physical anchor.

**Decision:** the countdown target is derived in two stages (`src/ui/clockModel.ts`, `deriveClock`):
1. **Baseline target** = the **significance-weighted mean of the central tipping years** over the factors that carry a `TippingPoint` (`{ centralYear, earliestYear?, latestYear?, label? }`). Nearer, heavier dated thresholds dominate. With **no** tipping-point factors there is **no baseline**: the Clock is `indeterminate` and suppresses the countdown rather than inventing an instant.
2. **Direction + magnitude modify it:** the net polarity `P ∈ [-1, 1]` (significance-weighted mean of signed effect across all contributing, non-pending factors) shifts the baseline — net Calamity (`P<0`) pulls the target SOONER, net Humanity (`P>0`) pushes it LATER — bounded by an operator-set `maxShiftYears` (`ClockHorizonConfig`). That bound is an operator ESTIMATE, read from `VITE_CLOCK_MAX_SHIFT_YEARS` at build time (fallback `DEFAULT_CLOCK_HORIZON`), never a corpus figure and never hardcoded as the answer.

`deriveClock` is pure and total: any input (empty, all-pending, poison values, no tipping points) yields a well-defined model — `hasBaseline === false` / `targetYear === null` rather than a NaN or throw. The UI surfaces the baseline, the shift, and the evidence, and states plainly the countdown is an ESTIMATE, never a measured deadline.

**Why:** a data-driven tracker must not fabricate a deadline. Anchoring to published dated thresholds makes the countdown a physical, inspectable aggregate; the bounded net-direction shift keeps sentiment from overwhelming the physics.

**Implemented in:** `src/ui/clockModel.ts` (model), `src/ui/Clock.tsx` (view + `resolveHorizon` env read).

### ADR-35 — `tippingPoint` on Factor AND FieldPin; JSONB column (migration 003)

**Decision:** the tipping point is a first-class, optional field on the shared contract. `TippingPointSchema` (`shared/schema.ts`) matches the `TippingPoint` interface in `clockModel.ts` field-for-field, so a `Factor`/`FieldPin` is structurally assignable to the Clock's `ClockFactorInput`. It is added with `.optional()` (not `.nullable()`, which would fight `exactOptionalPropertyTypes`) to **both** `FactorSchema` **and** `FieldPinSchema`.

`FieldPinSchema` carries it because **the Clock reads the FIELD set** (`<Clock factors={fieldPins} />`) — the lean field projection, not the feed — so without it on the pin the countdown would never see a threshold. The DB stores it as a nullable **`factors.tipping_point JSONB`** column (`db/migrations/003_tipping_points.sql`); node-postgres returns it already-parsed, and the feed (`server/routes/factors.ts`) and field (`server/routes/field.ts`) routes map `tipping_point → tippingPoint`, dropping a SQL `null` so the `.optional()` (never-`null`) contract holds, and re-validate through zod (ADR-23). Live ingestion persists it on insert (`server/ingestion/pgRepository.ts`, `pipeline.ts`, `websearch.ts`); seed mode carries the three corpus thresholds (Arctic sea ice, AMOC, Amazon) through `shared/seed.ts` + `db/seed.sql`. **Most** factors carry none — the design is "some have dated thresholds, most don't".

**Why:** the countdown baseline is only correct if the threshold data actually reaches the Clock's input set, in both seed and DB modes and from both curated and live-ingested factors.

**Implemented in:** `shared/schema.ts`, `shared/types.ts`, `shared/seed.ts`, `db/migrations/003_tipping_points.sql`, `db/seed.sql`, `server/routes/factors.ts`, `server/routes/field.ts`, `server/ingestion/{websearch,pipeline,pgRepository}.ts`.

### ADR-36 — Factor detail view on selection (pin or card) showing sources

**Spec / prior state:** selecting a factor (card or GPU-picked pin) only flew the camera (ADR-27) and highlighted the card; there was no place to read the FULL record — the complete description, the dated threshold, and every source.

**Decision:** a `FactorDetails` panel (`src/ui/FactorDetails.tsx`, `factorDetails.css`) renders on selection. It shows the name, the diverging effect indicator (crimson Calamity / blue Humanity) with the numeric effect + significance bar, the spatial-path/zone badge and verification state (`pending` visibly marked, ADR-20), the `tippingPoint` when present (framed explicitly as an estimated threshold, ADR-34), the full description, and — the point of the view — the **SOURCES**: each citation's publisher, its `sourceUrl` as a real link, its `quoteSnippet`, and analyst notes. A factor with **zero** citations says so loudly. **Citation honesty carries over** (corpus rule #2 / review #12): `verbatim` snippets render in quotation marks; paraphrases render WITHOUT quotes behind a muted "summary" affordance, so a restatement can never masquerade as a direct quote. App wiring looks the selected id up in `feedFactors` (where citations live); when the selection is a globe pin not yet paged into the feed, it falls back to the lean field pin with a "sources loading/unavailable" note rather than crashing. Accessible: a labelled region, Escape closes, focus moves to the panel on open; the globe/sidebar/clock stay usable.

**Why:** the product's central claim is that every entry is backed by a verifiable source — selection must lead somewhere that proves it, honestly.

**Implemented in:** `src/ui/FactorDetails.tsx`, `src/ui/factorDetails.css`, wiring in `src/App.tsx`.

---

## Auditable ingestion + live Phase D (37–38)

These complete two ADR-33 / ADR-18 follow-ups: the reputability gate's verdict is now **persisted and surfaced** (not merely logged), and Phase D entity resolution has a real **LLM** implementation with the deterministic stub kept as the offline path.

### ADR-37 — Reputability score + reasoning persisted on the factor (migration 004)

**Spec / prior state:** ADR-33 landed the LLM reputability gate but persisted only its *outcome* — the `verification_state`. The deciding score and the model's reasoning were **logged and discarded**; a viewer could see *that* a factor was verified/pending but not *why*, and the audit trail was not reproducible. ADR-33's own "persistence note" flagged this as DB-layer follow-up.

**Decision:** the gate's audit trail is now a first-class, **optional** part of the factor. `FactorSchema` (`shared/schema.ts`) gains `reputabilityScore` (`z.number().min(0).max(1).optional()`) and `reputabilityReasoning` (`z.string().optional()`) — the DECIDING (max-scoring) source's score and its reasoning. Migration **`004_reputability.sql`** adds the nullable `factors.reputability_score REAL` + `reputability_reasoning TEXT` columns, with a `CHECK` bounding the score to `[0,1]` when present (NULL allowed). The gate (`worker.ts` `buildReputabilityGate`) returns the deciding score + reasoning on its `GateResult`; the pipeline threads them onto the `ExtractedFactorDraft` → `NewFactorInput` and `pgRepository.insertFactor` persists them. The read path (`server/routes/factors.ts`) maps `reputability_score → reputabilityScore` / `reputability_reasoning → reputabilityReasoning`, **stripping a SQL null** so the never-`null` `.optional()` contract re-validates cleanly (same pattern as `tipping_point`). `FactorDetails` surfaces it beside the verification badge: the score, a bar, and the reasoning, framed as the WHY behind verified/pending. It is added to `FactorSchema` only — **not** `FieldPinSchema`; the lean field projection stays minimal (ADR-26). Escalations never touch it; it seeds only a NEW factor's insert. Absent on seed/curated factors and anything ingested before 004.

**Why:** the product's claim is empirical, verifiable factors — a gate that decides trust must itself be auditable, not a black box. Persisting the score + reasoning makes the verified/pending decision inspectable and reproducible.

**Implemented in:** `shared/schema.ts`, `db/migrations/004_reputability.sql`, `server/ingestion/{worker,pipeline,pgRepository}.ts`, `server/routes/factors.ts`, `src/ui/FactorDetails.tsx` + `factorDetails.css`, `db/README.md`.

### ADR-38 — LLM Phase D entity resolver, with the deterministic stub as the offline fallback

**Spec / prior state:** comprehensive §3 Phase D calls for deciding, on an embedding collision, whether an incoming factor is an INDEPENDENT context or an ONGOING ESCALATION of a colliding factor. ADR-18 defined the port and math but the worker only ever wired `createStubResolver` (a deterministic `distance ≤ 0.15` policy) — the ingestion README listed the LLM resolver as out of scope.

**Decision:** `createLlmResolver(client?)` (`server/ingestion/resolver.ts`) is the LIVE implementation of the existing `EntityResolver` port. It presents the incoming factor + the colliding candidate(s) to the model (`messages.parse` + `zodOutputFormat`, adaptive thinking, no tools — the same shape as `websearch.ts`/`reputability.ts`) and returns a proposal `{ relation: 'independent' | 'escalation', updatedEffect?, updatedSignificance?, rationale }`. **The LLM only proposes** (finding 28): the pure `verdictFromProposal` maps it onto a `ResolverVerdict`, and the deterministic layer (`resolveOutcome` → `recalculateOnEscalation`, ADR-19) still computes the stored numbers from the INCOMING report's metrics and bounds/validates them. Parent selection stays deterministic — an escalation attaches to the NEAREST candidate (finding 29), never a hallucinated id; directionality is derived from the proposed significance relative to that parent; every proposed number is clamped to its domain (ADR-11a). The worker selects the LLM resolver when `hasLiveCredentials()`, else the **kept** `createStubResolver` (the offline path is never deleted). Any live failure (throw / null parse) degrades to `independent` — the conservative "do not merge" default, matching `resolveOutcome`'s own fallback.

**Offline:** `resolver.test.ts` exercises the deterministic stub fallback and the pure clamping/directionality/`verdictFromProposal` logic without any live call; `pipeline.test.ts` runs the full A→D loop (including the stub resolver) against the in-memory repository.

**Why:** a fixed scalar on 512-dim cosine distance cannot reliably separate "same ongoing event" from "distinct same-domain event" (ADR-18's failure modes); the LLM makes that call while the server keeps the arithmetic deterministic and replayable.

**Implemented in:** `server/ingestion/resolver.ts`, `resolver.test.ts`, wiring in `server/ingestion/worker.ts`; `pipeline.test.ts` + `server/ingestion/memoryRepository.ts` (offline proof).

---

## Coastline landmass overlay (39)

### ADR-39 — Glowing coastline vector lines from world-atlas 110m TopoJSON

**Spec / prior state:** the globe was a featureless wireframe icosphere plus the chromatic field and pins — nothing told the viewer WHERE on Earth a pin sat. There was no geographic reference on the sphere.

**Decision:** a new `Coastlines` class (`src/globe/Coastlines.ts`, mirroring `GlobeMesh`'s conventions — `object3D` getter, `setVisible`, idempotent `dispose`) renders the world's coastlines as thin glowing great-circle vector lines hugging the globe. Data is the bundled `world-atlas` `land-110m.json` (low-detail TopoJSON, small + fast); `topojson-client`'s `mesh()` collapses it to a single GeoJSON MultiLineString of every coastline arc, packed into ONE `THREE.LineSegments` (one geometry, one draw call). Every `[lon, lat]` vertex is projected through geo.ts's `latLonToVector3` (ADR-25 — no lat/lon trig elsewhere) and lifted to `radius * 1.002` to sit just above the wireframe (no z-fight). Sparse coastline chords spanning more than ~2° of arc are subdivided by **great-circle interpolation** (slerp of the endpoint unit vectors) so lines hug the surface instead of chording through the sphere. Material is a muted glowing cyan (`#5fd0d8`, additive-blended, `depthWrite:false`, `depthTest:true`) that reads as coastline without clashing with the red↔purple↔blue field; `depthTest` + `renderOrder = 1` (drawn after the opaque globe) let the globe occlude far-side coastlines so the back of the Earth stays hidden. The overlay is **static** — built once, never rebaked — so it carries no `onNeedsRender` subscription; the app paints it once. It is **toggle-able** via a `LAND: ON/OFF` status-bar button (default ON) → React state → `SceneHandle.setLandVisible` → `coastlines.setVisible` + `requestRender`, and disposed in the scene teardown block.

**Offline:** the projection + subdivision math is extracted into the pure, deterministic `buildCoastlineSegments(lines, radius, maxSegDeg)`, unit-tested in `Coastlines.test.ts` (no WebGL, no JSON load) — segment counts, on-sphere radius preservation, radius scaling, geo-convention agreement, and degenerate-line handling.

**Why:** a geographic reference frame makes the instrument legible — the field and pins are meaningless without knowing which continent they fall on — while staying true to the dark, technical aesthetic (crisp thin glowing lines, not filled landmasses).

**Implemented in:** `src/globe/Coastlines.ts`, `Coastlines.test.ts`, wiring + toggle in `src/App.tsx`, button style in `src/styles.css`; deps `world-atlas` + `topojson-client` (+ `@types/topojson-client`, `@types/topojson-specification`).

---

## Overlay UX restructure (40)

### ADR-40 — Right-edge slideout hosting feed XOR node-detail; compact years-inclusive countdown expanding the derivation

**Spec / prior state:** the overlay was a CSS grid that permanently reserved a 400px right column for an always-visible `Sidebar`, with `FactorDetails` rendered as its own separately-positioned floating drawer (bottom-left) and the full `Clock` panel occupying the top-left. Three fixed panels competed with the globe for screen space, and the feed and the node-detail could be on screen simultaneously.

**Decision:** the globe becomes the full-bleed hero and the chrome slides over it.

- **One right-anchored slideout** (`.tc-slideout`, `--tc-sidebar-w` = 400px / 320px responsive) hosts EITHER the factor feed (`Sidebar`) OR the node detail (`FactorDetails`) — **never both**. Mutual exclusivity is driven purely by `selectedId`: non-null → `FactorDetails`, null → `Sidebar`. The panel is **closed by default** (translateX(100%), `pointer-events:none`) and slides in over the globe on a ~240ms transform. A vertical **`FEED` tab** (real `<button aria-expanded>`) on the right edge opens it; a collapse handle (`›`) on the panel's outer-left edge closes it back to the tab.
- **Selection semantics:** selecting a globe PIN (`handleSelect` → `selectFactor`) or a feed card sets `selectedId` AND `panelOpen=true`, so a pin pick auto-opens the panel in detail mode and a card switches the open panel to detail in place. `FactorDetails`' close (`onClose → setSelectedId(null)`) returns the panel to feed mode while keeping it open; a small `‹ FEED` back affordance mirrors that. `FactorDetails` is **re-homed** into the slideout body (position static, fills the slot) rather than being its own positioned overlay — its content/behaviour (sources, tipping point, reputability, verbatim/summary honesty) is unchanged.
- **Accessibility:** the slideout is a labelled `role` region with `aria-hidden` tracking open state; the FEED tab carries `aria-expanded`/`aria-controls`. Escape is layered — in DETAIL mode `FactorDetails` owns Escape (stops propagation, returns to feed); in FEED mode an App-level handler closes the panel. So Escape-once → feed, Escape-again → closed. Pointer events stay `none` on the overlay except the interactive tab/panel, preserving globe draggability in the gaps.
- **Compact Clock:** the top-left is now a compact widget (a `<button aria-expanded>`) showing the target year and a **years-inclusive** live countdown — `Yy Dd HH:MM:SS` (years = `floor(totalSeconds / (365.25·86400))`, matching the model's Julian-year deadline convention; the remainder splits into days/hrs/min/sec). Clicking it slides out (`~200ms` transform/opacity/max-height) an expanded panel carrying everything the old Clock body had — MODELED PROJECTION tags, baseline + signed shift, NET POLARITY bar, CALAMITY LOAD, HUMANITY BUFFER, FACTORS, TIPPING POINTS, CONFIDENCE, pending/rejected, footer note, SOUND toggle, and the `[i]` ExplainerModal trigger (now living inside the expanded panel). The Clock **owns its own** `expanded` state; App still just renders `<Clock factors={…} />`. The single 1s countdown interval ticks in both states — the compact widget always shows the live countdown, the expanded panel shows the detail; the ambient-tick halt-on-modal behaviour is unchanged. `clockModel.ts` is untouched — years are derived from the same countdown ms.
- **Motion:** all slide/expand transforms are disabled under `prefers-reduced-motion: reduce`.

**Why:** reclaim the screen for the globe (the instrument's centrepiece), remove the feed-vs-detail ambiguity by making them one mutually-exclusive surface, and lead the countdown with years so the multi-decade projection reads honestly at a glance.

**Implemented in:** `src/App.tsx` (panelOpen state, slideout + FEED tab, Escape layering), `src/styles.css` (full-bleed overlay grid, `.tc-slideout`/`.tc-feed-tab`), `src/ui/Clock.tsx` + `clock.css` (compact widget + expander, years-inclusive split), `src/ui/FactorDetails.tsx` + `factorDetails.css` (re-homed into the slideout, `‹ FEED` back affordance). Model untouched (`clockModel.ts`).

---

## Geographic base coloring + bolder wireframe, blended with the field (41)

### ADR-41 — Ocean-blue / land-green geographic base, field blended on top; wireframe reuses the same color, bolder; pin color attenuated

**Spec / prior state:** the globe faces showed ONLY the chromatic Calamity/Humanity field (crimson↔purple↔blue gated on evidence W, grey where W ≈ 0). With no geographic base, a viewer could not read WHERE a reading sat except via the thin coastline overlay, and the broad inverse-distance field (θ_max 15°, k 2.0) washed color across large regions.

**Decision:** render a GEOGRAPHIC BASE and BLEND the field on top so both read.
- **Land mask** (`src/globe/landMask.ts`): the `world-atlas` 110m LAND polygons (same source as `Coastlines.ts`) are rasterized onto a 2048×1024 equirectangular offscreen canvas (land = white, ocean = black) via `topojson-client` `feature(...)`, wrapped as a `THREE.CanvasTexture` (`wrapS = RepeatWrapping`, linear). Projection `x = (lon+180)/360·W`, `y = (90−lat)/180·H`; three's default `flipY = true` makes texture v = 1 read the canvas top (lat +90), so it lines up with the field's `uv.v = lat/π + 0.5`. It also exposes a CPU `sampleLand(lat, lon)` (reads the raster back) for the ADR-42 relief fallback. DOM-bound, so not unit-tested; built once inside the scene.
- **Shader** (`src/globe/shaders.ts`): a shared GLSL chunk holds the `ramp()`, the geo-base+field blend `geoFieldColor(dir)`, and the `depthCue()`. `geoBase = mix(uOceanColor, uLandColor, landFrac)` (ocean `#123a63` deep desaturated blue — deliberately distinct from the field's Humanity blue `#2e9ef7`; land `#2f6b3a` muted green). `finalColor = mix(geoBase, ramp(P), smoothstep(uWMin, uWFull, W)·uFieldCap)` — where W ≈ 0 the surface is pure geography; where factors exist the signal tints through, capped. Face and wireframe fragment shaders both `#include` the chunk.
- **Bolder wireframe:** the wire `LineSegments` moved from a flat `LineBasicMaterial` (0x8fa4c8, opacity 0.1) to a `ShaderMaterial` reusing the SAME geo+field color (shared uniform objects) multiplied by `uLineBoost` (`LINE_BOOST = 1.45`) and clamped — blue lines over ocean, green over land, field-tinted where covered, a punchier version of the underlying face. `depthWrite:false`, `depthTest:true`, `renderOrder 1` (occludes far side). The pronounced-structure ask (opacity 0.1 → readable) is satisfied by the boosted opaque line color.
- **Pin color attenuation:** to keep the pin color a CONTAINED halo over the geography rather than a broad wash, `DEFAULT_FIELD_PARAMS` tightened (θ_max 15° → 8°, k 2.0 → 2.5) and the blend ceiling `FIELD_STRENGTH_CAP` lowered (0.85 → 0.6). All three are named tunable constants.

**Why:** a green/blue Earth base makes the instrument legible at a glance, while the field still reads as a localized Calamity/Humanity signal where evidence exists; the wireframe carries the same geography so structure and base agree.

**Implemented in:** `src/globe/landMask.ts` (new), `src/globe/shaders.ts` (shared chunk, face + line shaders, geo/cap constants, uniforms), `src/globe/GlobeMesh.ts` (land-mask uniform, wire ShaderMaterial), `src/globe/field.ts` (attenuated defaults), `src/App.tsx` (land mask build + wiring + dispose).

---

## Elevation displacement (Open-Meteo baked grid + land-relief fallback) (42)

### ADR-42 — Real terrain displacement, sea-level floored + cached; inverted-pyramid pins

**Spec / prior state:** the icosphere was a perfect sphere; nothing showed relief, and pins were orientation-free octahedra floating just above the surface.

**Decision:**
- **Baked grid** (`scripts/fetch-elevation.mjs`, `npm run fetch:elevation`): a coarse equirectangular elevation grid (default 240×120, ~288 requests) baked from the **Open-Meteo elevation API** (no key). Batches 100 coords/request, ~150 ms apart, retries with exponential backoff on 429/5xx. Writes `public/elevation-grid.json` as compact `{ width, height, min, max, data }` where `data` is base64 of an Int16Array of meters. **Idempotent / resumable:** an existing same-size grid short-circuits the fetch (the JSON is the durable cache; `--force` re-fetches); partial progress is checkpointed to `scripts/.elevation-progress.json` after every batch so an interrupted run resumes without re-hitting the API from scratch.
- **Runtime** (`src/globe/elevation.ts`): `loadElevationGrid()` fetches `/elevation-grid.json`, returns `null` on 404/parse-error (graceful degrade), decodes the base64 Int16, and memoizes the decoded grid module-side so re-mounts don't re-fetch/-decode (browser HTTP-cache on top). `sampleElevation(grid, lat, lon)` is a pure bilinear sampler; the decode + lat/lon→grid math is unit-tested offline (`elevation.test.ts`).
- **Displacement** (`src/globe/GlobeMesh.ts`): at construction each icosphere vertex is offset outward along its radial by `max(0, meters)/EARTH_RADIUS_M · exaggeration · radius` (`exaggeration = 30`). **Floored at sea level:** ocean/bathymetry (meters ≤ 0) stays FLAT at the base radius — only land rises. The wireframe geometry and vertex normals are rebuilt from the displaced positions. Displacement can be re-applied via `setElevation()` once the real grid loads.
- **Fallback:** offline / before the grid is baked, `App.tsx` seeds GlobeMesh with a LAND-RELIEF sampler (`landMask.sampleLand` → land = 2500 m constant, ocean = 0) so continents still show in relief; the fire-and-forget `loadElevationGrid()` swaps in real terrain when available. Coastlines are lifted to `radius·1.02` so lines don't sink under raised land.
- **Pins** (`src/globe/PinLayer.ts`): each pin is now a long thin **inverted 4-sided pyramid** (`ConeGeometry(1,1,4)`, flipped + translated so the apex is at local origin, base at +Y). Each instance orients local +Y along the outward radial (apex points at the globe centre, base widens outward) and scales thin-in-X/Z, long-in-Y with length keyed to significance. Color still by effect sign via `rampColor`. Still ONE `InstancedMesh` (one draw call); the same geometry backs the GPU pick pass so hit-testing matches. The apex seats on the BASE radius (documented simplification: pins stay independent of the async elevation grid; the long body stands proud even over raised land).

**Operator note:** the elevation displacement shows REAL terrain only AFTER running `npm run fetch:elevation` (needs network, run once). Until then the globe uses the land-relief fallback (continents raised a small constant over flat ocean).

**Implemented in:** `scripts/fetch-elevation.mjs` (new), `src/globe/elevation.ts` (+ `elevation.test.ts`, new), `src/globe/GlobeMesh.ts` (displacement + `setElevation`), `src/globe/PinLayer.ts` (inverted-pyramid pins), `src/globe/Coastlines.ts` (`lift` option), `src/App.tsx` (grid load + fallback wiring), `package.json` (`fetch:elevation` script).

---

## Elevation-driven land ramp + coastlines on the surface (43)

### ADR-43 — Green→brown→white land shading keyed off the displaced vertex radius; coastline lift reduced to a hairline

**Spec / prior state:** ADR-42 gave the globe real relief, but ADR-41's land color stayed a FLAT green (`COLOR_LAND`) modulated only by a latitude-based polar snow blend. Terrain had shape but no tonal read: a Himalayan ridge and a river delta painted the identical green, so the displacement was legible only in silhouette. Separately, ADR-42's coastline overlay sat at `radius · 1.02` — a 2% lift chosen to clear raised terrain, but visibly a floating wire cage detached from the globe at normal zoom.

**Decision:**
- **Elevation as a varying, not a new attribute.** The icosphere's vertices are already CPU-displaced along their radials (ADR-42), so a vertex's RADIAL LENGTH encodes its height. The vertex shader therefore derives the elevation fraction directly — `vElev = (length(position) - uRadius) / uRadius` — and passes it as a varying. A new `uRadius` uniform (in `GlobeUniforms` / `createGlobeUniforms`, set from `GlobeMesh.radius` at construction) supplies the base radius. No extra vertex attribute, no second texture fetch, and because the SAME vertex shader feeds both the face `ShaderMaterial` and the wireframe line material, the etch gets the identical ramp for free.
- **The ramp.** `geoFieldColor(dir, e)` now takes the elevation fraction and builds land as
  `landCol = mix(COLOR_LAND, COLOR_MOUNTAIN, smoothstep(ELEV_BROWN_START, ELEV_BROWN_FULL, e))`, then
  `landCol = mix(landCol, ICE, smoothstep(ELEV_SNOW_START, ELEV_SNOW_FULL, e))` —
  green lowlands → muted brown `COLOR_MOUNTAIN` (#6b5438-ish) uplands → white peaks.
- **Polar snow still wins.** ADR-41's latitude-based snow blend and the equirect pole-cap fix are applied AFTER the elevation ramp, so Antarctica, Greenland and the Arctic fringe read as ice regardless of local height — a low coastal shelf at 78°S must not paint green.
- **Ocean is untouched.** Displacement is floored at sea level (ADR-42), so `e = 0` over water, and the land mask picks the ocean color regardless of the ramp.
- **Calibration is tied to the exaggeration.** `ELEV_BROWN_START = 0.012`, `ELEV_BROWN_FULL = 0.045`, `ELEV_SNOW_START = 0.065`, `ELEV_SNOW_FULL = 0.100`, exported as tunable TS consts interpolated into the GLSL (the same pattern as `HALO_RIM` / `SNOW_START`). With `DEFAULT_EXAGGERATION = 120` and a grid max of ~6379 m the fraction spans ~0 → ~0.12, which these four thresholds bracket. **Changing the exaggeration requires rescaling all four by the same factor**, or the planet goes uniformly white (higher) or stays flat green (lower). This coupling is documented at the constants.
- **Coastline lift `1.02` → `1.001`.** The lift is now a hairline z-fighting offset only. With the ramp giving terrain its own tonal read, the overlay no longer needs to clear raised land visually — and at 1.001 the lines sit ON the surface instead of hovering above it.

**Why:** relief that is shaded reads as terrain; relief that is only displaced reads as noise. Keying the shading off the geometry that is already displaced means the color and the silhouette can never disagree, and costs one varying. The coastline change removes the last cue that the overlay is a separate floating object.

**Implemented in:** `src/globe/shaders.ts` (`uRadius` uniform, `vElev` varying, `COLOR_MOUNTAIN`, the four `ELEV_*` thresholds, `geoFieldColor(dir, e)`, both fragment shaders), `src/globe/GlobeMesh.ts` (`uRadius` set from the mesh radius), `src/App.tsx` (coastline `lift: 1.001`).


---

## Ingestion provider migration (44)

### ADR-44 — Ingestion provider migration: Fireworks + Firecrawl, replacing Anthropic + OpenAI

**Spec / prior state:** the whole ingestion stack was pinned to two providers the project can no longer use. ADR-31/-33/-38 ran every LLM turn on Anthropic (`@anthropic-ai/sdk`, `claude-opus-4-8`, `messages.parse` + `zodOutputFormat`, adaptive thinking) and got retrieval from Anthropic's `web_search` server tool; ADR-12's Phase-B embeddings called OpenAI `text-embedding-3-small` with `EMBEDDING_API_KEY`. The owner cannot pay Anthropic (payment declines) and declines to use OpenAI, so the code was correct and unrunnable — the worst state for a system whose entire value is *live, cited* data.

**Decision:** move reasoning + embeddings to **Fireworks AI** and retrieval to **Firecrawl**, behind the SAME interfaces, so `pipeline.ts` (Phase B/C/D, the ADR-19 recalculation, the ADR-33 gate) is untouched.

- **LLM → Fireworks, `accounts/fireworks/models/deepseek-v4-flash`** (`INGEST_MODEL`). Fireworks speaks the **OpenAI-compatible wire protocol**, so we use the `openai` npm package purely as an HTTP client for that protocol with `baseURL: https://api.fireworks.ai/inference/v1`. This is a protocol, not a vendor: no request is ever made to `api.openai.com`, and `llmClient.test.ts` asserts the pinned base URL. `@anthropic-ai/sdk` is removed from `package.json`.
- **`anthropicClient.ts` → `llmClient.ts`.** Same seam, new provider: `hasLiveCredentials()` (now `FIREWORKS_API_KEY`, and it deliberately returns false for a stale `ANTHROPIC_API_KEY`), `ingestModel()`, `getLlmClient()`. Unlike the Anthropic SDK, the OpenAI-protocol client does not self-resolve this key, so `llmClient.ts` is the ONE place that reads it.
- **Structured output = JSON-schema constrained decoding.** All three call sites (`websearch.ts` extraction, `reputability.ts` `scoreSource`, `resolver.ts` `createLlmResolver`) go through one helper, `structuredCompletion()`, which sends `response_format: { type: 'json_schema', json_schema: { name, schema } }` (Fireworks' documented shape) and also repeats the schema in the system prompt, as Fireworks' docs recommend. **The existing zod schemas remain the source of truth**: the JSON Schema is DERIVED from them via zod v4's built-in `z.toJSONSchema()` (no extra dependency — `zod-to-json-schema` was evaluated and dropped as redundant), and the decode is STILL `safeParse`d with the same zod schema. A non-conforming response returns `null`, which every call site already handles conservatively (no candidates / offline heuristic / `independent`).
- **Embeddings → Fireworks `nomic-ai/nomic-embed-text-v1.5`** over the same OpenAI-compatible `/v1/embeddings` endpoint, authenticated with `FIREWORKS_API_KEY` (the separate `EMBEDDING_API_KEY` is gone — one provider, one key). **`EMBEDDING_DIMENSIONS` stays 512 and `db/migrations/001_init.sql`'s `halfvec(512)` column is UNCHANGED**: nomic-embed-text-v1.5 is Matryoshka-trained (native 768) and supports server-side truncation to 512 via the `dimensions` parameter, exactly as ADR-12 requires. Choosing a Matryoshka-capable model was a deliberate constraint on the migration — a model without it would have forced a new migration and a full re-embed, and a silent width mismatch would have broken dedupe. The runtime length check per vector is retained as the backstop.
- **Retrieval → Firecrawl `POST /v2/search`** (`firecrawlClient.ts`, `FIRECRAWL_API_KEY`). One call does search AND scrape, returning ranked results with full-page markdown (`sources: [{type:'web'}]`, `scrapeOptions.formats: [{type:'markdown'}]`). Phase A therefore collapses from Anthropic's two-turn (research-with-tools, then extract) into **retrieve → one constrained extraction turn**, which is cheaper and removes the `pause_turn` resume loop entirely.
- **Provenance is assembled server-side, and the model cannot forge it.** This is the load-bearing part. The extraction schema no longer lets the model emit a URL: it cites a source by `sourceIndex` (1-based, into the retrieved set), and `normalizeCandidate(raw, docs)` substitutes Firecrawl's real `url` plus a `publisher` derived from that URL's registrable domain. An out-of-range index is DROPPED, never back-filled. So a persisted source is always one that was genuinely retrieved — strictly harder to fake than the previous "the model reports the URL it read" arrangement.
- **Cost control is explicit.** `FIRECRAWL_MAX_RESULTS` (5) bounds Firecrawl credits per topic; `FIRECRAWL_MAX_CONTENT_CHARS` (10000) bounds the scraped markdown fed to the model, which is the dominant input-token cost. Both are env-tunable and clip on a newline boundary with an explicit `…[truncated]` marker so a clipped source is never mistaken for a complete one.
- **Every offline stub and its gating survive unchanged.** `researchFactorsOffline`, `scoreSourceOffline`, `createStubResolver`, `createStubEmbeddingClient` are all kept and still clearly labelled; `researchFactors` now stubs when EITHER key is missing, and says which. The worker requires BOTH keys plus `DATABASE_URL` before it arms a timer (ADR-32's guard, widened). The test suite remains fully offline — no live provider call, ever.

**Why:** cost and provider availability. The previous stack could not be run at all by its owner; DeepSeek V4 Flash on Fireworks plus Firecrawl is runnable and materially cheaper per cycle, and Fireworks' grammar-constrained decoding gives the same typed-output guarantee that `zodOutputFormat` gave, with zod still validating the result.

**What this costs us (stated plainly):** we lose Anthropic's **server-side citation handling** — the model no longer returns provider-verified citation objects tied to the fetched documents. Provenance is now ASSEMBLED by us from Firecrawl's results (real URL + domain-derived publisher + a model-chosen supporting quote). Two honest consequences: (1) `verbatim` is now purely the model's self-report about its own quote — it is not machine-checked against the source text, exactly as before, but there is no longer a provider-side citation to corroborate it; (2) `publisher` is a DOMAIN (e.g. `nsidc.org`), not a curated outlet name. Neither weakens the URL-level claim — the URL is always one Firecrawl actually retrieved — and the ADR-33 reputability gate still decides `verified` vs `pending` from that URL. Verifying `verbatim` by substring-matching the quote against the retrieved markdown is the obvious next step and is NOT implemented here.

**Implemented in:** `server/ingestion/llmClient.ts` (new, replaces `anthropicClient.ts` — deleted), `server/ingestion/firecrawlClient.ts` (new), `server/ingestion/websearch.ts` (retrieval + single extraction turn, `sourceIndex` provenance substitution), `server/ingestion/reputability.ts`, `server/ingestion/resolver.ts`, `server/ingestion/embeddings.ts` (`createRemoteEmbeddingClient`, Fireworks endpoint, `FIREWORKS_API_KEY`), `server/ingestion/worker.ts` (`hasIngestionCredentials` = both keys), `server/ingestion/pipeline.ts` (comment only), `package.json` (`-@anthropic-ai/sdk`, `+openai`), `.env.example`, `README.md`, `server/ingestion/README.md`. Tests: `llmClient.test.ts`, `firecrawlClient.test.ts` (both new, offline), plus provenance cases in `websearch.test.ts`.


---

## Anonymous Phase-1 factor submissions (45)

### ADR-45 — Hashed IP+device identity, 1/day, shadow bans indistinguishable from success, cheapest-first noise filter

**Spec / prior state:** every factor in the system arrived one of two ways — hand-curated seed data, or the scheduled research worker (ADR-31/-44). There was no way for a person to propose anything. Opening that door in Phase 1 means opening it with NO accounts (there is no auth system, and building one is not Phase-1 scope), which is the hard part: an anonymous write endpoint in front of a pipeline that spends money per item is an invitation to both abuse and cost.

**Decision:** `POST /api/factors/submit` accepts anonymous submissions under four constraints.

- **The submitter supplies a claim and a source. Nothing else.** `FactorSubmissionSchema` (in the shared contract, so client and server cannot drift) is `{ claim, sourceUrl, note?, deviceId }` and is **`.strict()`**. `effect`, `significance`, `verificationState`, `lat`, `lon` and `tippingPoint` are SYSTEM-ASSIGNED, and supplying any of them — or any other unknown key — is a hard 400, not a silently ignored field. This is the anti-manipulation rule: if a submitter could set those numbers, anyone could steer the Clock's aggregate by hand and the "empirical" premise would be hollow. `sourceUrl` must parse AND be http(s), so `javascript:` / `data:` / `file:` are rejected before anything renders or fetches the value.
- **Identity is two salted hashes, never a raw value.** `ip_hash = sha256(SUBMISSION_SALT || ip)` and `device_hash = sha256(SUBMISSION_SALT || deviceId)`; no column anywhere holds a raw IP. The salt is load-bearing, not decorative: IPv4 is ~4.3e9 values, so an UNSALTED `sha256(ip)` is a reversible encoding of the address for anyone holding a database dump. The server therefore **refuses to boot in DB mode without `SUBMISSION_SALT`** — writing unsalted digests would bake a privacy failure permanently into the rows before anyone noticed. Seed mode generates an ephemeral per-process salt and logs that it did. Rotating the salt invalidates every existing hash (bans and rate-limit windows reset); that is the documented cost of rotation.
- **Client IP resolution behind a proxy is an explicit flag, not a guess.** `TRUST_PROXY=1` → the first hop of `X-Forwarded-For`; otherwise the socket address. Both defaults are wrong for the other deployment: trusting the header when unproxied lets any submitter mint a fresh identity per request (limit defeated), and ignoring it when proxied collapses every client onto the proxy's address (the first submission of the day locks out the whole internet). The default is **do not trust**, which fails toward over-limiting a shared address rather than toward trivial evasion.
- **Checks run cheapest-first**, so an attacker can never make the system spend money by being rejected: (1) schema — free; (2) ban lookup — free, one index; (3) rate limit — free, one index; (4) duplicate — free, one index; (5) noise classifier — ONE small constrained model call; (6) the existing vetting pipeline — retrieval + extraction + reputability + embeddings, the only expensive step.

**Shadow-ban semantics (the part that must not regress).** A banned submitter's request is persisted as `quarantined` and answered with the **byte-identical payload and status code** a genuine acceptance receives (`RECEIVED_RESPONSE`). No distinguishing header, no different message, and no later check whose absence would reveal itself — in particular a banned submitter's second submission of the day does NOT get the 429 a normal submitter would, because that divergence alone would tell them their first one had been treated differently from what they were shown. `submit.test.ts` asserts the two payloads are key-for-key identical. A confident `spam`/`abuse` verdict is handled the same way: rejected, auto-banned going forward, and told nothing.

**The noise filter (`server/ingestion/noiseFilter.ts`).** One JSON-schema-constrained Fireworks call returning `{ verdict: 'plausible'|'spam'|'abuse'|'nonsense', confidence, reason }`, with the same offline-stub gating as `reputability.ts` / `websearch.ts` — no credential → a deterministic, clearly-labelled heuristic, never a fabricated "live" verdict. It decides only whether a submission is worth the cost of fact-checking; whether the claim is TRUE remains the pipeline's job, and the prompt says so explicitly ("being WRONG is not noise… when genuinely unsure, choose plausible"), because a filter that quietly rejected inconvenient claims would be censorship wearing a cost-control badge. Prompt-injection defence is structural, in three layers: the submission sits inside an explicitly delimited data block that the system prompt declares to be DATA and never instructions — and declares any instruction found inside it to be *evidence of abuse*, turning the attack into a detection signal; the output is schema-constrained at the decoder, so a successful injection cannot change the response shape, only flip a verdict; and the result is re-validated with zod, degrading to the deterministic heuristic (never to "plausible by default") on anything unparseable. `spam`/`abuse` at confidence ≥ `NOISE_BAN_CONFIDENCE` (0.85) also auto shadow-bans; `nonsense` never bans, because its commonest cause is a confused first-time submitter, not an attacker.

**Acceptance hands off to the EXISTING pipeline, unchanged.** `server/submissions/vetting.ts` builds the same `createPipelineFromEnv` the scheduled worker builds, with the claim as the Phase A research topic and the cited URL appended, and feeds it exactly one item. Every stored number comes out of Phase A extraction and the ADR-33 reputability gate precisely as it does for scheduled ingestion; there is no submission-specific scoring path that could diverge. It runs fire-and-forget after the submitter has been answered, which is why the success copy promises REVIEW, not publication.

**Why:** the project's value is live, cited data, and the cheapest source of that is people who notice things. The cost of opening the door is abuse and spend, and both are addressable without accounts — but only if the anti-abuse machinery is invisible.

**The honest limitation, stated plainly:** without auth this raises the COST of abuse; it does not eliminate it. A determined evader who clears localStorage and changes IP gets another attempt, and nothing here can stop that. What the design buys is that each attempt costs them a new network position, that the classifier re-flags the same behaviour and re-bans the new identity, and that they receive no feedback telling them whether any of it worked — so the loop is slow, silent, and unrewarding. Two further gaps, equally plainly: (1) the duplicate check is exact-content only (normalized claim + URL); semantic near-duplicate detection happens later, in the pipeline's Phase C embeddings, because an embedding call in the request path would defeat the cheapest-first ordering that is the whole point; (2) in seed mode the submission store is in-memory, so bans and rate-limit windows reset on restart — the endpoint is demonstrable there, not enforceable.

**Implemented in:** `db/migrations/005_submissions.sql` (new — `submissions`, `banned_submitters`), `shared/schema.ts` + `shared/types.ts` (`FactorSubmissionSchema` strict, `SubmissionResponseSchema`), `server/submissions/identity.ts` (new — salt, hashing, proxy-aware IP resolution, window arithmetic, content normalization), `server/submissions/store.ts` (new — Postgres + in-memory), `server/submissions/vetting.ts` (new — pipeline handoff), `server/ingestion/noiseFilter.ts` (new), `server/routes/submit.ts` (new — decision core + route), `server/db.ts` (table types), `server/index.ts` (salt bootstrap + route registration), `src/ui/SubmitFactor.tsx` + `src/ui/submitFactor.css` (new), `src/App.tsx` (slideout third mode + status-bar trigger), `.env.example`, `db/README.md`, `README.md`, `server/ingestion/README.md`. Tests (all offline): `server/submissions/identity.test.ts`, `server/ingestion/noiseFilter.test.ts`, `server/routes/submit.test.ts`.
