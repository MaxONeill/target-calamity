/**
 * fetch-elevation.mjs — bake a coarse equirectangular ELEVATION grid (ADR-42).
 *
 * NO API KEY REQUIRED. Uses a FAILOVER POOL of three independent, keyless
 * elevation APIs, all normalized to METRES (each source has a `unitToMeters`):
 *   - OpenTopoData (etopo1)   api.opentopodata.org   ~1 req/s, 1000/day
 *   - Open-Elevation          api.open-elevation.com  independent quota
 *   - Open-Meteo              api.open-meteo.com       independent quota
 * When one source hits its burst/daily quota (429) the pool fails over to the
 * next, so the bake finishes without manual intervention. Ocean values differ by
 * source (0 vs bathymetry) but all get floored to sea level at displacement time
 * (ADR-42), so mixing sources is safe.
 *
 * Samples a W×H grid (default 240×120), lon −180..180 → x, lat 90..−90 → y (row 0
 * = north pole), row-major, matching src/globe/elevation.ts exactly. Batches 100
 * locations/request (~288 requests at the default resolution). RUN ONCE.
 *
 * Writes public/elevation-grid.json as compact { width, height, min, max, data }
 * where `data` is base64 of an Int16Array of meters (clamped to int16).
 *
 * CACHING / RESUMABLE (idempotent):
 *   - If public/elevation-grid.json already exists at the SAME width/height, the
 *     script SKIPS the network entirely (the baked JSON is the durable cache).
 *     Pass --force to re-fetch.
 *   - Partial progress is checkpointed to scripts/.elevation-progress.json after
 *     every batch, so an interrupted run RESUMES without re-hitting the API from
 *     the start.
 *
 * Usage:
 *   npm run fetch:elevation                 # default 240×120, ~288 requests
 *   ELEV_WIDTH=360 ELEV_HEIGHT=180 npm run fetch:elevation
 *   npm run fetch:elevation -- --force      # ignore the cached grid, re-fetch
 *   npm run fetch:elevation -- --width=480 --height=240
 *   npm run fetch:elevation -- --sources=openelevation,opentopodata   # custom pool/order
 *   npm run fetch:elevation -- --source=opentopodata                  # pin one source
 *   npm run fetch:elevation -- --delay=1500                           # steady delay (ms)
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_FILE = join(ROOT, 'public', 'elevation-grid.json');
const PROGRESS_FILE = join(__dirname, '.elevation-progress.json');

const BATCH = 100; // locations per request (both sources accept up to 100)
const MAX_RETRIES = 5; // for network / 5xx errors (short exponential backoff)
const RATE_LIMIT_RETRIES = 15; // for 429 — keep trying (limits reset per second/minute)
const RATE_LIMIT_MAX_WAIT_MS = 65_000; // cap a single 429 wait at ~1 minute window

/* ---- args / config ------------------------------------------------------- */
function argVal(name, fallback) {
  const pref = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  if (hit) return hit.slice(pref.length);
  return fallback;
}
const FORCE = process.argv.includes('--force');
const WIDTH = Number(argVal('width', process.env.ELEV_WIDTH ?? 240));
const HEIGHT = Number(argVal('height', process.env.ELEV_HEIGHT ?? 120));

if (!Number.isFinite(WIDTH) || !Number.isFinite(HEIGHT) || WIDTH < 2 || HEIGHT < 2) {
  console.error(`Invalid grid size ${WIDTH}×${HEIGHT}`);
  process.exit(1);
}

/* ---- elevation sources (all keyless; all normalized to METERS) ------------ */
// Each source: label, a URL builder, a parser → number[] of raw elevations (per
// input coord, in order), and `unitToMeters` so every source lands in the SAME
// unit (all three below are already metres, factor 1 — the factor makes that
// explicit and lets a future feet/other source drop in safely). All accept up to
// 100 locations per request and require no API key. Three INDEPENDENT hosts, so
// the pool can fail over between them when one hits its daily/burst quota.
const SOURCES = {
  // OpenTopoData (ETOPO1): global incl. bathymetry (negatives). ~1 req/s, 1000/day.
  opentopodata: {
    label: 'OpenTopoData(etopo1)',
    unitToMeters: 1,
    url: (lats, lons) =>
      `https://api.opentopodata.org/v1/etopo1?locations=${lats
        .map((la, i) => `${la},${lons[i]}`)
        .join('|')}`,
    parse: (json) =>
      Array.isArray(json.results) ? json.results.map((r) => r?.elevation) : null,
  },
  // Open-Elevation: global (SRTM/ocean=0). Independent host/quota.
  openelevation: {
    label: 'Open-Elevation',
    unitToMeters: 1,
    url: (lats, lons) =>
      `https://api.open-elevation.com/api/v1/lookup?locations=${lats
        .map((la, i) => `${la},${lons[i]}`)
        .join('|')}`,
    parse: (json) =>
      Array.isArray(json.results) ? json.results.map((r) => r?.elevation) : null,
  },
  // Open-Meteo: ocean=0; emits bare `nan` for no-data cells (sanitized upstream).
  openmeteo: {
    label: 'Open-Meteo',
    unitToMeters: 1,
    url: (lats, lons) =>
      `https://api.open-meteo.com/v1/elevation?latitude=${lats.join(',')}&longitude=${lons.join(',')}`,
    parse: (json) => (Array.isArray(json.elevation) ? json.elevation : null),
  },
};

// Ordered failover pool. `--sources=a,b,c` (or ELEV_SOURCES) overrides; `--source=x`
// pins a single one; default rotates through all three.
const poolArg = argVal('sources', process.env.ELEV_SOURCES ?? argVal('source', process.env.ELEV_SOURCE));
const POOL_NAMES = poolArg
  ? String(poolArg).split(',').map((s) => s.trim()).filter(Boolean)
  : ['opentopodata', 'openelevation', 'openmeteo'];
const POOL = POOL_NAMES.map((n) => {
  const s = SOURCES[n];
  if (!s) {
    console.error(`Unknown source "${n}". Use: ${Object.keys(SOURCES).join(' | ')}`);
    process.exit(1);
  }
  return { name: n, ...s };
});

// Steady delay between requests (OpenTopoData needs ≥1 s). Override --delay=<ms>.
const DELAY_MS = Number(argVal('delay', process.env.ELEV_DELAY_MS ?? 1100));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Grid index → [lat, lon] (degrees). Matches src/globe/elevation.ts layout. */
function indexToLatLon(idx) {
  const x = idx % WIDTH;
  const y = Math.floor(idx / WIDTH);
  const lon = -180 + (x / (WIDTH - 1)) * 360;
  const lat = 90 - (y / (HEIGHT - 1)) * 180;
  return [lat, lon];
}

function clampInt16(v) {
  const r = Math.round(v);
  return r > 32767 ? 32767 : r < -32768 ? -32768 : r;
}

/** Parse a `Retry-After` header (seconds or HTTP-date) into ms, or null. */
function retryAfterMs(res) {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(h);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

/**
 * Fetch one batch from ONE source. Light retry (429/5xx/network) with short
 * escalating backoff, then throws so the pool fails over to the next source
 * rather than waiting minutes on a depleted quota. Returns elevations in METERS
 * (raw · unitToMeters), non-finite → 0 (sea level; ADR-42 floors anyway).
 */
async function fetchFromSource(src, lats, lons) {
  const url = src.url(lats, lons);
  const factor = src.unitToMeters ?? 1;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      await sleep(600 * 2 ** attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt === MAX_RETRIES) throw new Error(`HTTP ${res.status}`);
      const wait = Math.min(RATE_LIMIT_MAX_WAIT_MS, retryAfterMs(res) ?? 800 * 2 ** attempt);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Open-Meteo emits bare `nan`/`inf` (invalid JSON) for no-data cells; sanitize.
    const text = await res.text();
    const json = JSON.parse(text.replace(/-?\b(nan|inf(inity)?)\b/gi, 'null'));
    const raw = src.parse(json);
    if (raw === null) throw new Error('missing elevation data in response');
    return raw.map((v) => (Number.isFinite(v) ? v * factor : 0));
  }
  throw new Error('unreachable');
}

/** Sticky index of the source that last worked, so we don't re-hit a dead one first. */
let currentSource = 0;

/**
 * Fetch a batch with FAILOVER across the source pool: try the current source,
 * then rotate through the rest; if the whole pool fails, wait and retry the pool
 * a few times before giving up (progress is checkpointed either way).
 */
async function fetchBatch(lats, lons) {
  let lastErr;
  for (let poolPass = 0; poolPass < RATE_LIMIT_RETRIES; poolPass++) {
    for (let step = 0; step < POOL.length; step++) {
      const idx = (currentSource + step) % POOL.length;
      const src = POOL[idx];
      try {
        const meters = await fetchFromSource(src, lats, lons);
        if (idx !== currentSource) {
          console.warn(`  → failed over to ${src.label}`);
          currentSource = idx;
        }
        return meters;
      } catch (err) {
        lastErr = err;
        if (POOL.length > 1) console.warn(`  ${src.label} failed (${err.message}); next source…`);
      }
    }
    // Entire pool failed this batch — pause before retrying it (quotas may clear).
    const wait = Math.min(RATE_LIMIT_MAX_WAIT_MS, 15_000 * (poolPass + 1));
    console.warn(
      `  all ${POOL.length} source(s) failed; waiting ${Math.round(wait / 1000)}s then retrying the pool…`,
    );
    await sleep(wait);
  }
  throw lastErr ?? new Error('all elevation sources exhausted (progress saved; re-run to resume)');
}

function encodeBase64(int16) {
  return Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength).toString('base64');
}

async function loadProgress(total) {
  if (FORCE || !existsSync(PROGRESS_FILE)) return { data: new Int16Array(total), done: 0 };
  try {
    const p = JSON.parse(await readFile(PROGRESS_FILE, 'utf8'));
    if (p.width === WIDTH && p.height === HEIGHT && typeof p.data === 'string') {
      const buf = Buffer.from(p.data, 'base64');
      const arr = new Int16Array(total);
      arr.set(new Int16Array(buf.buffer, buf.byteOffset, Math.min(total, buf.byteLength >> 1)));
      const done = Math.min(total, Math.max(0, p.done | 0));
      console.log(`Resuming from checkpoint: ${done}/${total} samples already fetched.`);
      return { data: arr, done };
    }
  } catch {
    /* fall through to a fresh grid */
  }
  return { data: new Int16Array(total), done: 0 };
}

async function saveProgress(data, done) {
  await writeFile(
    PROGRESS_FILE,
    JSON.stringify({ width: WIDTH, height: HEIGHT, done, data: encodeBase64(data) }),
  );
}

async function main() {
  const total = WIDTH * HEIGHT;

  // Idempotent skip: an existing same-size baked grid is the durable cache.
  if (!FORCE && existsSync(OUT_FILE)) {
    try {
      const existing = JSON.parse(await readFile(OUT_FILE, 'utf8'));
      if (existing.width === WIDTH && existing.height === HEIGHT) {
        console.log(
          `public/elevation-grid.json already baked at ${WIDTH}×${HEIGHT}; skipping fetch. Use --force to re-fetch.`,
        );
        return;
      }
      console.log(`Existing grid is ${existing.width}×${existing.height}; re-baking at ${WIDTH}×${HEIGHT}.`);
    } catch {
      /* corrupt output — re-bake */
    }
  }

  const { data, done: startDone } = await loadProgress(total);
  const requests = Math.ceil((total - startDone) / BATCH);
  console.log(
    `Baking ${WIDTH}×${HEIGHT} = ${total} samples (no key) via ${POOL.map((s) => s.label).join(' → ')}. ` +
      `${requests} requests remaining, batch ${BATCH}, ~${DELAY_MS}ms apart.`,
  );

  let done = startDone;
  let reqNo = 0;
  while (done < total) {
    const end = Math.min(done + BATCH, total);
    const lats = [];
    const lons = [];
    for (let idx = done; idx < end; idx++) {
      const [lat, lon] = indexToLatLon(idx);
      lats.push(Number(lat.toFixed(5)));
      lons.push(Number(lon.toFixed(5)));
    }
    const elevations = await fetchBatch(lats, lons);
    for (let j = 0; j < elevations.length && done + j < total; j++) {
      data[done + j] = clampInt16(elevations[j] ?? 0);
    }
    done = end;
    reqNo++;
    await saveProgress(data, done);
    const pct = ((done / total) * 100).toFixed(1);
    console.log(`  [${reqNo}/${requests}] ${done}/${total} (${pct}%)`);
    if (done < total) await sleep(DELAY_MS);
  }

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < total; i++) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }

  await mkdir(join(ROOT, 'public'), { recursive: true });
  await writeFile(
    OUT_FILE,
    JSON.stringify({ width: WIDTH, height: HEIGHT, min, max, data: encodeBase64(data) }),
  );
  console.log(`Wrote ${OUT_FILE} (min ${min} m, max ${max} m).`);

  // Success: drop the checkpoint so the next run's idempotent skip is clean.
  try {
    if (existsSync(PROGRESS_FILE)) await writeFile(PROGRESS_FILE, JSON.stringify({ complete: true }));
  } catch {
    /* non-fatal */
  }
}

main().catch((err) => {
  console.error('fetch-elevation failed:', err);
  console.error('Partial progress is checkpointed; re-run to resume.');
  process.exit(1);
});
