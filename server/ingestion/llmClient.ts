/**
 * Shared LLM client factory for the live research engine.
 *
 * The whole ingestion module reaches the model through THIS file so credential
 * handling, model selection and the structured-output convention live in one
 * place. As of  the provider is **Fireworks AI** (DeepSeek V4 Flash), not
 * Anthropic:
 *
 *   - Fireworks exposes an **OpenAI-COMPATIBLE wire protocol**. We therefore use
 *     the `openai` npm package purely as an HTTP client for that protocol,
 *     pointed at `https://api.fireworks.ai/inference/v1`. No request ever goes to
 *     `api.openai.com` — the base URL is always set explicitly.
 *   - `hasLiveCredentials()` is the single gate the offline stubs branch on. When
 *     it returns false, `websearch.ts` / `reputability.ts` serve their clearly
 *     labelled deterministic stubs and the scheduled worker no-ops —
 *     production code never silently fabricates "live" findings.
 *   - `ingestModel()` reads `INGEST_MODEL` (default
 *     `accounts/fireworks/models/deepseek-v4-flash`), so the research + scoring
 *     model is configurable without a code change.
 *   - `structuredCompletion()` is the ONE structured-output call site. Fireworks
 *     supports JSON-schema-constrained decoding via
 *     `response_format: { type: 'json_schema', json_schema: { name, schema } }`
 *     (verified against docs.fireworks.ai/structured-responses). The zod schema
 *     stays the source of truth: we derive the JSON Schema from it with zod v4's
 *     built-in `z.toJSONSchema()` and STILL parse the response with zod, so a
 *     non-conforming decode is caught rather than trusted.
 *
 * Anthropic-specific machinery (`messages.parse`, `zodOutputFormat`, adaptive
 * thinking, `pause_turn` resumes, server-side citations) is gone — see  for
 * what that costs us.
 */
import OpenAI from 'openai';
import * as z from 'zod/v4';

/**
 * Fireworks' OpenAI-compatible inference base URL (docs.fireworks.ai). The `/v1`
 * suffix is required — the SDK appends `/chat/completions` and `/embeddings`.
 */
export const FIREWORKS_BASE_URL = 'https://api.fireworks.ai/inference/v1';

/**
 * Default research/scoring model. Overridable via `INGEST_MODEL`.
 * DeepSeek V4 Flash is the cost-effective member of the V4 family and supports
 * constrained/structured decoding on Fireworks.
 */
export const DEFAULT_INGEST_MODEL = 'accounts/fireworks/models/deepseek-v4-flash';

/** Shared non-streaming token budget for the ingestion turns. */
export const INGEST_MAX_TOKENS = 16_000;

/**
 * The model id the ingestion turns run against. `INGEST_MODEL` wins when set;
 * otherwise {@link DEFAULT_INGEST_MODEL}. A blank/whitespace value falls back to
 * the default rather than sending an empty model id.
 */
export function ingestModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.INGEST_MODEL?.trim() || DEFAULT_INGEST_MODEL;
}

/**
 * The environment variable carrying the Fireworks credential. Unlike the old
 * Anthropic SDK, the OpenAI-protocol client does NOT resolve a Fireworks key from
 * the environment on its own, so this module reads it — and only here.
 */
const CREDENTIAL_ENV_VAR = 'FIREWORKS_API_KEY';

/**
 * True iff the environment carries a Fireworks credential. This is the seam the
 * offline stubs and the scheduled worker gate on: no credential → deterministic
 * stub / no-op, never a fabricated live result. Side-effect free (we read env
 * rather than constructing a client and catching).
 */
export function hasLiveCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[CREDENTIAL_ENV_VAR]?.trim());
}

/** Lazily-constructed singleton — one client per process is plenty. */
let cached: OpenAI | null = null;

/**
 * The shared OpenAI-protocol client, pinned to the Fireworks base URL. Callers
 * MUST have checked {@link hasLiveCredentials} first; constructing without a
 * credential throws, which is the correct fail-fast for a code path that expected
 * to be live.
 */
export function getLlmClient(env: NodeJS.ProcessEnv = process.env): OpenAI {
  if (cached === null) {
    const apiKey = env[CREDENTIAL_ENV_VAR]?.trim();
    if (!apiKey) {
      throw new Error(
        `${CREDENTIAL_ENV_VAR} is not set — refusing to construct a live LLM client. ` +
          'Callers must gate on hasLiveCredentials().',
      );
    }
    cached = new OpenAI({ apiKey, baseURL: FIREWORKS_BASE_URL });
  }
  return cached;
}

/** Test seam: drop the cached singleton (e.g. after changing env). */
export function resetLlmClient(): void {
  cached = null;
}

/** The client type callers annotate with — an OpenAI-protocol client, not OpenAI. */
export type LlmClient = OpenAI;

/* -------------------------------------------------------------------------- */
/* Structured output                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Derive a Fireworks-acceptable JSON Schema from a zod v4 schema. `$schema` is
 * stripped because the constrained-decoding engine wants a bare schema document,
 * and `io: 'input'` keeps optional fields optional (rather than emitting the
 * output-side shape).
 */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  const { $schema: _dropped, ...rest } = raw;
  return rest;
}

/** Arguments to {@link structuredCompletion}. */
export interface StructuredCompletionArgs<T> {
  client: LlmClient;
  model: string;
  /** System instruction for the turn. */
  system: string;
  /** The user turn. */
  user: string;
  /** Zod schema — the source of truth for BOTH the grammar and the validation. */
  schema: z.ZodType<T>;
  /** Schema name sent to Fireworks (required by the json_schema response format). */
  schemaName: string;
  maxTokens?: number;
}

/**
 * Run one JSON-schema-constrained turn and validate the result with zod.
 *
 * Returns `null` (never throws for a bad model response) when the model returns
 * no content, non-JSON, or JSON that fails zod validation — every call site
 * already has a conservative fallback for that case. Transport errors DO throw;
 * callers decide whether to degrade or propagate.
 *
 * Per Fireworks' guidance the schema is repeated in the system prompt as well as
 * in `response_format`, which materially improves compliance.
 */
export async function structuredCompletion<T>(
  args: StructuredCompletionArgs<T>,
): Promise<T | null> {
  const schema = jsonSchemaOf(args.schema);
  const response = await args.client.chat.completions.create({
    model: args.model,
    max_tokens: args.maxTokens ?? INGEST_MAX_TOKENS,
    messages: [
      {
        role: 'system',
        content:
          `${args.system}\n\nRespond with JSON matching this schema:\n` +
          JSON.stringify(schema),
      },
      { role: 'user', content: args.user },
    ],
    response_format: {
      // Fireworks' JSON-schema constrained decoding (docs.fireworks.ai).
      type: 'json_schema',
      json_schema: { name: args.schemaName, schema },
      // The OpenAI SDK's types describe OpenAI's narrower variant of this field;
      // Fireworks accepts the same envelope with a plain schema object.
    } as never,
  });

  const content = response.choices[0]?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) return null;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch {
    return null;
  }
  const result = args.schema.safeParse(parsedJson);
  return result.success ? result.data : null;
}
