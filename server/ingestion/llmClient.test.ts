/**
 * Offline tests for the Fireworks LLM client seam (ADR-44).
 *
 * No network and no client construction with a real key: these cover the pure
 * credential gate, model selection, and the zod → JSON-Schema derivation that
 * feeds Fireworks' constrained decoding.
 */
import { describe, it, expect } from 'vitest';
import * as z from 'zod/v4';
import {
  DEFAULT_INGEST_MODEL,
  FIREWORKS_BASE_URL,
  hasLiveCredentials,
  ingestModel,
  jsonSchemaOf,
} from './llmClient.js';

describe('provider pinning', () => {
  it('targets Fireworks, never api.openai.com', () => {
    expect(FIREWORKS_BASE_URL).toBe('https://api.fireworks.ai/inference/v1');
    expect(FIREWORKS_BASE_URL).not.toContain('openai.com');
  });

  it('defaults to DeepSeek V4 Flash', () => {
    expect(DEFAULT_INGEST_MODEL).toBe('accounts/fireworks/models/deepseek-v4-flash');
  });
});

describe('hasLiveCredentials', () => {
  it('is true only for a non-blank FIREWORKS_API_KEY', () => {
    expect(hasLiveCredentials({ FIREWORKS_API_KEY: 'fw-x' })).toBe(true);
    expect(hasLiveCredentials({ FIREWORKS_API_KEY: '   ' })).toBe(false);
    expect(hasLiveCredentials({})).toBe(false);
  });

  it('ignores a stale Anthropic credential', () => {
    expect(hasLiveCredentials({ ANTHROPIC_API_KEY: 'sk-ant-x' })).toBe(false);
  });
});

describe('ingestModel', () => {
  it('honours INGEST_MODEL and falls back on a blank value', () => {
    expect(ingestModel({ INGEST_MODEL: 'accounts/fireworks/models/other' })).toBe(
      'accounts/fireworks/models/other',
    );
    expect(ingestModel({ INGEST_MODEL: '  ' })).toBe(DEFAULT_INGEST_MODEL);
    expect(ingestModel({})).toBe(DEFAULT_INGEST_MODEL);
  });
});

describe('jsonSchemaOf', () => {
  const schema = z.object({
    relation: z.enum(['independent', 'escalation']),
    updatedSignificance: z.number().optional(),
    rationale: z.string(),
  });

  it('derives an object schema from the zod source of truth', () => {
    const json = jsonSchemaOf(schema) as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(json.type).toBe('object');
    expect(Object.keys(json.properties).sort()).toEqual([
      'rationale',
      'relation',
      'updatedSignificance',
    ]);
    expect(json.required.sort()).toEqual(['rationale', 'relation']);
  });

  it('strips $schema (Fireworks wants a bare schema document)', () => {
    expect(jsonSchemaOf(schema)).not.toHaveProperty('$schema');
  });
});
