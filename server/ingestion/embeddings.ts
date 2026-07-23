/**
 * Phase B — Vectorization.
 *
 * The embedding client for the Reconciliation Loop. Two implementations behind
 * one interface:
 *
 *   1. `createRemoteEmbeddingClient` — the real provider. As of  this is
 *      **Fireworks AI** (`nomic-ai/nomic-embed-text-v1.5`) over its
 *      OpenAI-COMPATIBLE `/v1/embeddings` endpoint — a wire protocol, not OpenAI
 *      the company; no request goes to `api.openai.com`. Batched (: the
 *      endpoint takes arrays) and Matryoshka-truncated to 512 dimensions via the
 *      `dimensions` parameter (: matches the `halfvec(512)` column, so NO
 *      migration was needed — nomic-embed-text-v1.5 is Matryoshka-trained with a
 *      native width of 768 and officially supports truncation to 512/256/128).
 *
 *   2. `createStubEmbeddingClient` — a deterministic, offline, clearly-labelled
 *      fake so the pipeline is testable with no network and no key. It is NOT
 *      semantic — identical text yields identical vectors and distinct text
 *      yields distant vectors, which is all the dedupe/resolution tests need.
 *
 * `createEmbeddingClient` selects between them from the environment and, per the
 * module contract, REFUSES to silently fake real embeddings in production: with
 * no key set and `NODE_ENV === 'production'` it throws rather than returning the
 * stub.
 *
 * the specs store `embedding VECTOR(1536)`. We request
 * 512 dims via the API's `dimensions` parameter (Matryoshka truncation) to match
 * the `halfvec(512)` column  adopts. Every vector this module emits has
 * length `EMBEDDING_DIMENSIONS`, and the provider swap in  deliberately
 * chose a model that supports that width so the DB column is unchanged.
 */
import { FIREWORKS_BASE_URL } from './llmClient.js';

/** The single sanctioned embedding width. Every vector is this long. */
export const EMBEDDING_DIMENSIONS = 512;

/**
 * Default provider model. Matryoshka-capable, so `dimensions: 512`
 * yields a valid prefix rather than a naive slice. Overridable via
 * `EMBEDDING_MODEL` — but a replacement MUST support 512 dims or the
 * `halfvec(512)` column and dedupe break.
 */
export const DEFAULT_EMBEDDING_MODEL = 'nomic-ai/nomic-embed-text-v1.5';

/** Fireworks' OpenAI-compatible embeddings endpoint. */
const EMBEDDINGS_URL = `${FIREWORKS_BASE_URL}/embeddings`;

/**
 * The provider-agnostic contract the rest of the pipeline depends on. Always
 * batched: callers hand it every text at once so a page of extracted factors
 * costs a single request, never one call per factor.
 */
export interface EmbeddingClient {
  /**
   * Embed a batch of texts. The returned array is positionally aligned with the
   * input (`out[i]` embeds `texts[i]`) and every vector has length
   * {@link EMBEDDING_DIMENSIONS}. An empty input returns an empty array without
   * touching the network.
   */
  embed(texts: string[]): Promise<number[][]>;
  /**
   * `true` for the offline deterministic stub, `false` for a real provider.
   * The pipeline surfaces this so a run can be labelled as non-production and so
   * stub vectors are never mistaken for semantic ones.
   */
  readonly isStub: boolean;
  /** Human-readable identifier for logs (the model id / `stub`). */
  readonly model: string;
}

/** Environment inputs this module reads. A plain object so it is easy to test. */
export interface EmbeddingEnv {
  FIREWORKS_API_KEY?: string | undefined;
  EMBEDDING_MODEL?: string | undefined;
  EMBEDDING_DIMENSIONS?: string | undefined;
  NODE_ENV?: string | undefined;
}

/* -------------------------------------------------------------------------- */
/* Real provider                                                              */
/* -------------------------------------------------------------------------- */

interface RemoteEmbeddingResponse {
  data: Array<{ index: number; embedding: number[] }>;
}

export interface RemoteEmbeddingConfig {
  apiKey: string;
  model?: string;
  dimensions?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Endpoint override (any OpenAI-compatible embeddings gateway). */
  endpoint?: string;
}

/**
 * The real, network-backed client. Requests `dimensions` explicitly so the
 * provider truncates server-side rather than us slicing a full-width vector
 * — the truncated prefix is the Matryoshka-valid one only when the model
 * produces it. Preserves input order by sorting the response on `index`, which
 * the API does not guarantee to return sorted.
 */
export function createRemoteEmbeddingClient(
  config: RemoteEmbeddingConfig,
): EmbeddingClient {
  const model = config.model ?? DEFAULT_EMBEDDING_MODEL;
  const dimensions = config.dimensions ?? EMBEDDING_DIMENSIONS;
  const endpoint = config.endpoint ?? EMBEDDINGS_URL;
  const doFetch = config.fetchImpl ?? fetch;

  return {
    isStub: false,
    model,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];

      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: texts,
          dimensions,
          encoding_format: 'float',
        }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(
          `Embedding request failed: ${res.status} ${res.statusText}${
            detail ? ` — ${detail.slice(0, 500)}` : ''
          }`,
        );
      }

      const body = (await res.json()) as RemoteEmbeddingResponse;
      if (!body.data || body.data.length !== texts.length) {
        throw new Error(
          `Embedding response shape mismatch: expected ${texts.length} vectors, got ${
            body.data?.length ?? 0
          }`,
        );
      }

      const ordered = [...body.data].sort((a, b) => a.index - b.index);
      return ordered.map((row, i) => {
        if (row.embedding.length !== dimensions) {
          throw new Error(
            `Embedding ${i} has ${row.embedding.length} dims, expected ${dimensions}`,
          );
        }
        return row.embedding;
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Offline deterministic stub                                                 */
/* -------------------------------------------------------------------------- */

/**
 * FNV-1a over a string → 32-bit unsigned seed. Small, dependency-free, and
 * stable across processes so the stub is reproducible.
 */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in uint32 via Math.imul.
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG — deterministic, decent distribution, tiny. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic, L2-normalised pseudo-embedding of `text`. Seeded by the full
 * text, so identical inputs collide exactly (cosine distance 0) and unrelated
 * inputs sit far apart — enough to exercise Phase C/D branching offline. This is
 * NOT a semantic embedding and must never be persisted as if it were.
 */
export function stubEmbedding(
  text: string,
  dimensions = EMBEDDING_DIMENSIONS,
): number[] {
  const rand = mulberry32(fnv1a(text));
  // Build via push + map so no index-read trips `noUncheckedIndexedAccess`.
  const raw: number[] = [];
  let norm = 0;
  for (let i = 0; i < dimensions; i++) {
    // Box–Muller for a roughly-Gaussian spread → uniform direction on the sphere.
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    raw.push(g);
    norm += g * g;
  }
  const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0;
  return raw.map((g) => g * inv);
}

/**
 * The offline client. Loudly labelled (`isStub: true`, `model: 'stub'`) so no
 * caller can mistake its output for real vectors.
 */
export function createStubEmbeddingClient(
  dimensions = EMBEDDING_DIMENSIONS,
): EmbeddingClient {
  return {
    isStub: true,
    model: 'stub',
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => stubEmbedding(t, dimensions));
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Choose a client from the environment.
 *
 * - Key present → the real provider (model/dimensions from env, defaulting to
 *   `nomic-ai/nomic-embed-text-v1.5` / 512).
 * - Key absent, non-production → the deterministic stub, with a loud warning.
 * - Key absent, `NODE_ENV === 'production'` → throws. Production must never run
 *   on faked embeddings (dedup would be meaningless), so this fails fast rather
 *   than silently degrading.
 */
export function createEmbeddingClient(
  env: EmbeddingEnv,
  logger: Pick<Console, 'warn'> = console,
): EmbeddingClient {
  const key = env.FIREWORKS_API_KEY?.trim();
  const dimensions = env.EMBEDDING_DIMENSIONS
    ? Number.parseInt(env.EMBEDDING_DIMENSIONS, 10)
    : EMBEDDING_DIMENSIONS;

  if (key) {
    return createRemoteEmbeddingClient({
      apiKey: key,
      model: env.EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL,
      dimensions: Number.isFinite(dimensions) ? dimensions : EMBEDDING_DIMENSIONS,
    });
  }

  if (env.NODE_ENV === 'production') {
    throw new Error(
      'FIREWORKS_API_KEY is not set and NODE_ENV=production. Refusing to run the ' +
        'ingestion pipeline on stub embeddings in production — set a real key or ' +
        'disable the ingestion worker.',
    );
  }

  logger.warn(
    '[ingestion] FIREWORKS_API_KEY not set — using the DETERMINISTIC STUB embedding ' +
      'client. Vectors are non-semantic and for offline development only.',
  );
  return createStubEmbeddingClient(
    Number.isFinite(dimensions) ? dimensions : EMBEDDING_DIMENSIONS,
  );
}
