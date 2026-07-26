# Architecture

Why this codebase is shaped the way it is. Each entry records a decision whose
rationale is not recoverable from the code alone — the ones where the obvious
implementation is wrong, and reverting to it would break something subtle.

---

## The governing constraint

The product claims its readings are empirical, verifiable and reproducible. Most
decisions below are that claim expressed in a particular layer. When a choice
looks unusually strict, it is usually protecting one of these:

- **The rendered planet is a function of the data alone.** Never of camera,
  scroll position, sort order, or selection.
- **Absence of evidence is displayed as absence**, never as a reading.
- **Nothing is fabricated to fill a gap** — not a countdown target, not a
  citation, not a live research result.
- **Whoever supplies a claim cannot set its weight.**

---

## Rendering

### The field is baked, not accumulated per fragment

The obvious implementation loops over every active factor in the fragment
shader, summing `C(p) = Σ Eᵢ·Sᵢ / max(d, ε)^k`. That is O(N) per pixel per
frame, needs a compile-time `MAX_FACTORS` cap, and recompiles the shader
whenever the factor count changes.

Instead the accumulation runs once per data change on the CPU (`globe/field.ts`)
and bakes into a 2048×1024 equirectangular texture (`globe/bakeField.ts`) that
the shader samples in O(1). The field is static between data updates, so
recomputing it at 60Hz is pure waste.

`globe/field.ts` is the single reference kernel and the unit-test target. The
GLSL never accumulates.

### Two fields, three states — grey is not purple

A single scalar `C(p)` conflates two completely different situations: "no data
here" and "strong opposing forces that cancel". Both land at ≈ 0 and would
render identically. For a product whose premise is verifiability, rendering
absence-of-data in the same color as documented contested equilibrium is a
correctness bug, not a cosmetic one.

So two fields are computed with a compact-support kernel, and color is gated on
evidence:

```
w_i(p) = S_i / max(d(p,x_i), eps)^k      for d <= d_max, else 0
W(p)   = Σ_i w_i(p)                       evidence density
P(p)   = Σ_i E_i·w_i(p) / W(p)            net polarity, undefined where W = 0
```

Below `W_min` the surface shows plain geography. At or above it, hue ramps
crimson → purple → blue over `P`, with saturation rising over `W`. Genuine
contested equilibrium is vivid purple; absence of coverage never is.

**Do not ship the normalization without the evidence gate.** Normalizing alone
is strictly worse than not normalizing: with a single pin, `P` equals that pin's
effect everywhere, flooding the globe.

`eps` cancels between numerator and denominator, so `P → Eᵢ` as `p → xᵢ`
regardless of its value.

### Angular distance via dot product

Distance is angular separation computed as `dot()` on unit vectors, not a
Euclidean chord. Chord distance distorts falloff at range — antipodal points are
`2R` by chord but `πR` by geodesic. The cutoff is a single `dot >= cos(θ_max)`,
and the falloff uses the chord `sqrt(2 − 2·dot)`, which is monotone in the angle.
No `acos`, no `length()`.

### One sanctioned coordinate conversion

`src/lib/geo.ts` is the only place geography becomes geometry. Latitude and
longitude are stored in **degrees**; JS and GLSL trigonometry take **radians**.
Passing degrees in produces wrong coordinates that still satisfy `|v| = R`, so
the bug is invisible to inspection and to any magnitude assertion.

Every call site routes through it: pin instance matrices, the camera target, and
the field baker's texel→direction map. The baker derives its mapping by *calling*
the helper, which guarantees the baked field is the exact inverse of pin
placement — otherwise the heatmap can end up rotated or mirrored relative to the
pins it is supposed to explain.

The regression test that catches this asserts the great-circle angle between
London and Tokyo is 85.6°. A `|v| = R` test passes *under* the bug.

### Render on demand

There is no unconditional `requestAnimationFrame` loop. A coalesced
`requestRender()` repaints once per frame and is called only on actual change.
This page is meant to sit open for hours without holding a core at 100%.

### Alignment interpolates position, not orientation

Slerping between two look-at *quaternions* injects roll: the horizon tilts
mid-flight and rights itself at the end, so the artifact is invisible in any
start/end screenshot. Instead the camera's *position* is animated on a
fixed-radius orbit sphere and `lookAt` re-levels every frame, so the pole axis
stays vertical by construction.

The test samples roll **mid-flight**. At t=0 and t=1 it is always zero.

### Geographic base under the field

The globe renders ocean/land from a rasterized land mask, with terrain displaced
from a baked elevation grid and shaded green → brown → white by height. The
field blends on top, capped, so where there is no evidence you read geography
and where factors exist the signal tints through.

Land shading keys off the *displaced vertex radius* rather than a second
texture, so color and silhouette cannot disagree. **The four `ELEV_*` thresholds
are calibrated to `DEFAULT_EXAGGERATION`** — changing the exaggeration without
rescaling all four turns the planet uniformly white or flat green.

---

## Data model

### PostGIS for viewport queries

A `lat/lon BETWEEN` box breaks outright across the antimeridian and degenerates
near the poles, and the visible region of a sphere is never a lat/lon rectangle
anyway. Viewport queries use `ST_Intersects` against a geometry envelope, split
into two envelopes when the viewport crosses the date line.

### Append-only revisions; `factors` is a projection

Overwriting `effect`/`significance` in place destroys the audit trail for a
product whose premise is verifiability. `factor_revisions` is the append-only
log and `factors` is the current-state projection maintained by trigger, so a
factor's state is a fold over its citation history and can be recomputed if the
escalation formula changes.

### Pagination keys on `seq`, never a mutated column

Ingestion rewrites `updated_at = NOW()` when a factor escalates. Keysetting on
it means a row below the live cursor that escalates jumps above it and is
skipped for the rest of the scroll session — silently, and biased toward the
most active factors. `seq` is an insert-only identity, never bumped, and being
an integer it also survives a JSON round trip without the microsecond truncation
a timestamp suffers.

`abs(effect)` is mutated by the same path, so magnitude mode is not
deep-paginated at all: it is a single bounded top-N snapshot with no cursor.

Cursors are opaque and mode-tagged. A cursor minted under one sort mode is
rejected against the other, because an `updated_at` cursor cannot paginate an
`|effect|` ordering — toggling sort mid-scroll would silently duplicate and skip
rows.

### Constraints are enforced, not documented

`effect ∈ [-1, 1]` is load-bearing: normalized polarity inherits its units, so
the ramp thresholds only mean anything if it is bounded. The escalation path
clamps to the same domain — it is the most likely place to push out of range.

Range checks use `BETWEEN`, which also rejects `NaN`/`±Infinity`. Do **not** use
the float `x = x` idiom: for `numeric`, `NaN = NaN` is TRUE and lets poison
through.

### Embeddings are 512-dim by server-side truncation

`halfvec(512)` roughly halves storage at negligible recall cost. The 512 prefix
is only valid because the model is Matryoshka-trained and truncates server-side
via the `dimensions` parameter — never slice a longer vector yourself. A silent
width mismatch breaks dedupe rather than erroring.

---

## The two data paths

This separation is the single most load-bearing thing in the client.

1. **Feed** — `GET /api/factors`, cursor-paginated and viewport-clipped. Drives
   the sidebar and **nothing on the GPU**.
2. **Field** — `GET /api/field`, no camera and no cursor parameters, ranked by
   actual field influence and capped by a rendering budget. Fetched once, and
   again only when the live stream signals a change.

Feeding the shader from the paginated viewport cache would make the heatmap a
function of scroll position and camera angle: two users, or one user mid-scroll,
would see different fields for the same planet and screenshots would not be
reproducible. `/api/field` returns a `fieldEpoch`, so two clients holding the
same epoch are provably rendering the same field.

The negative rule is what actually holds: field input is rewritten **only** on
receipt of a new field response. Never in a camera handler, never in the render
loop, never in the pagination reducer.

Ordering ties must break on `id` — Postgres has no stable order otherwise, and
the nondeterminism reappears immediately.

---

## Ingestion

### Similarity threshold is a filter, not a decision

Retrieval and decision are different problems. Phase C retrieves the top-k
nearest as *candidates*; the resolver decides escalate vs independent over that
set. A single hard scalar on high-dimensional cosine distance misfires in both
directions — too tight duplicates ongoing events, too loose merges distinct ones.

### The k-NN query shape is mandatory

`ORDER BY embedding <=> :q LIMIT :k`, with thresholds applied in an **outer**
filter. pgvector only uses the HNSW index for this shape; a bare
`WHERE embedding <=> :q < 0.15` predicate falls back to a sequential scan
computing the distance on every row.

The order-by form is also *exact*: `<=>` computes true distance and HNSW only
affects which rows are visited, so `candidates[0]` is the true nearest. Raise
`hnsw.ef_search` well above the default for this workload — a neighbour missed
because it was left at 40 is a false "no collision", which means a duplicate
factor double-counting its charge in the field.

### The model classifies; the server computes

The resolver proposes a relation only. Every stored number comes from the
deterministic path:

```
λ            = 1 / (parent.citationCount + 1)
effect'      = clamp((1-λ)·effect_parent + λ·effect_new, -1, 1)
significance = clamp((1-λ)·sig_parent    + λ·sig_new,     0, 1)
```

Clamped convex inputs stay in domain and saturate under repeated escalation.
`significance` may only fall under a de-escalating verdict; `effect` may move
either way, since its sign is the finding. A hallucinated parent id falls back
to the deterministic nearest candidate.

### Concurrency: one bucket lock

Phase C read → D decide → write runs inside `pg_advisory_xact_lock` keyed on
`spatial_path : ⌊lat⌋ : ⌊lon⌋`, so two sources reporting the same event
serialize. This closes a check-then-insert race that content-hash dedupe cannot,
because different sources produce different hashes for the same event.

The resolver call happens *inside* the lock, so it is held across a network round
trip. That is an accepted trade: latency is not critical here and a miss is
expensive. SERIALIZABLE alone is not relied on — predicate locking over an
approximate index scan is unreliable and needs retry logic.

### Provenance cannot be forged by the model

The extraction schema does not let the model emit a URL. It cites a source by
`sourceIndex` into the retrieved set, and the server substitutes the real URL
plus a domain-derived publisher. An out-of-range index is dropped, never
back-filled. A persisted source is therefore always one that was genuinely
retrieved.

**Stated plainly:** `verbatim` is the model's self-report about its own quote and
is *not* machine-checked against the source text. Substring-matching the quote
against the retrieved page is the obvious next step and is not implemented.

### No credentials means no output

Missing provider keys make the scheduled worker log and no-op. It never arms a
timer and never fabricates findings. Every network dependency has a
deterministic offline stub that is clearly labelled as such, and stub-sourced
factors stay `pending`.

### Ingested factors land pending

Machine-extracted content is excluded from the field bake and the Clock
aggregate until a reputability gate promotes it. The gate's deciding score *and
its reasoning* are persisted on the factor and surfaced in the UI — a gate that
decides trust must itself be auditable.

The threshold is a named constant because both failure modes are real: too high
and reputable sources sit pending forever while the Clock under-reacts; too low
and weak sources drive it, hollowing out the premise.

---

## The Clock

### Anchored to dated thresholds, never an invented window

The countdown target is derived in two stages:

1. **Baseline** — the significance-weighted mean of central tipping years across
   factors that carry one. Nearer, heavier dated thresholds dominate.
2. **Shift** — net force moves each threshold's central estimate *within* its own
   published earliest/latest band: sooner (Calamity) or later (Humanity), damped
   by evidence mass.

The bound is therefore the published band itself, not a configured number. At
full force and full evidence the estimate reaches `earliest` or `latest` and
stops; the band never moves. This is why there is no operator-set shift knob —
the countdown cannot travel past a year some source actually published.

With **no** tipping-point factors there is no baseline: the model reports
`hasBaseline: false` and the UI suppresses the countdown rather than counting
toward a fabricated instant. `deriveClock` is pure and total — empty,
all-pending or poisoned input yields a defined model, never `NaN` and never a
throw.

**Known soft spot:** averaging tipping years across non-commensurable thresholds
produces a number whose physical meaning is not obvious, and summing `effect`
across factors assumes a common scale no source establishes. The UI labels the
output a modeled projection; the aggregation step deserves the same scrutiny the
countdown target already gets.

### Citation honesty in the UI

`verbatim: true` snippets render in quotation marks. Paraphrases render without
them, behind a muted "summary" affordance, so a restatement can never masquerade
as a direct quote. `verbatim` defaults to `false`, so anything of unknown
provenance is treated as a paraphrase.

---

## Anonymous submissions

### The submitter supplies a claim and a source. Nothing else.

The request schema is `.strict()`, and `effect`, `significance`,
`verificationState`, `lat`, `lon` and `tippingPoint` are system-assigned.
Supplying any of them is a hard 400, not a silently dropped field. If a submitter
could set those numbers, anyone could steer the Clock by hand and "empirical"
would be hollow.

Accepted submissions hand off to the *same* pipeline the scheduled worker uses,
so there is no submission-specific scoring path that could diverge.

### Identity is two salted hashes

No raw IP is stored anywhere. IPv4 is only ~4.3e9 values, so an unsalted
`sha256(ip)` is a reversible encoding of the address for anyone holding a dump —
which is why the server **refuses to boot in DB mode without `SUBMISSION_SALT`**
rather than writing digests that bake in a privacy failure before anyone
notices. Rotating the salt resets every ban and rate-limit window.

`TRUST_PROXY` is explicit because both defaults are wrong for the other
deployment: trusting `X-Forwarded-For` unproxied lets anyone mint a fresh
identity per request; ignoring it when proxied collapses every client onto the
proxy's address. The default is to not trust, failing toward over-limiting a
shared address rather than trivial evasion.

### Checks run cheapest-first

Schema → ban lookup → rate limit → duplicate → one small classifier call → the
full pipeline. An attacker must never be able to make the system spend money by
being rejected.

### Shadow bans must stay indistinguishable

A banned submitter gets the byte-identical payload and status a genuine one
gets. No distinguishing header, no different message, and **no later check whose
absence would reveal itself** — in particular a banned submitter's second
submission of the day does not get the 429 a normal submitter would, because
that divergence alone would tell them the first was treated differently from
what they were shown.

The noise filter decides only whether a claim is worth the cost of checking, not
whether it is true — its prompt says so explicitly, because a filter that
quietly dropped inconvenient claims would be censorship wearing a cost-control
badge. Injection defence is structural: the submission sits in a delimited data
block declared to be data, an instruction found inside it is treated as evidence
of abuse, the decoder constrains the output shape, and an unparseable result
degrades to the deterministic heuristic rather than to "plausible".

**Honest limitation:** without accounts this raises the cost of abuse; it does
not eliminate it. Someone who clears local storage and changes IP gets another
attempt. What the design buys is that each attempt costs a new network position,
the classifier re-flags the behaviour, and they receive no feedback either way.
