/**
 * Idempotency keys, computed before any paid API call so re-ingesting the same
 * source costs nothing.
 */
import { createHash } from 'node:crypto';
import type { ExtractedFactorDraft, InboundIntelItem } from './types.js';

/**
 * Idempotency key for an inbound item, computed BEFORE embedding so a re-ingest
 * of the same article never costs an API call. Prefers the canonical
 * source URL; falls back to a hash of publisher + normalized text when the item
 * has no URL.
 */
export function contentHash(item: InboundIntelItem): string {
  const basis = item.sourceUrl
    ? `url:${item.sourceUrl.trim().toLowerCase()}`
    : `text:${item.publisher.trim().toLowerCase()}::${normalizeText(item.rawText)}`;
  return createHash('sha256').update(basis).digest('hex');
}

function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Idempotency key for one EXTRACTED factor. The live research engine
 * re-researches topics every cycle, so the meaningful dedupe unit is the finding,
 * not the topic: key on the citation's canonical source URL, falling back to
 * publisher + normalized name/description when a finding has no URL. Re-surfacing
 * the same source next cycle hits `existsBySourceUrl`/`existsByContentHash` and is
 * skipped; a genuinely new source flows on to Phase C, where embedding similarity
 * (not this hash) decides insert vs escalate.
 */
export function draftContentHash(draft: ExtractedFactorDraft): string {
  const url = draft.citation.sourceUrl;
  const basis = url
    ? `url:${url.trim().toLowerCase()}`
    : `factor:${draft.citation.publisher.trim().toLowerCase()}::${normalizeText(
        draft.name,
      )}::${normalizeText(draft.description)}`;
  return createHash('sha256').update(basis).digest('hex');
}

/**
 * The serialization bucket for the Phase C→D critical section:
 * spatial path + a coarse 1° geographic cell. Two inbound reports of the same
 * event fall in the same bucket and therefore serialize, closing the
 * check-then-insert race that content-hash dedupe (different sources, different
 * hashes) cannot.
 */
export function bucketKey(draft: ExtractedFactorDraft): string {
  // Placeless factors have no cell, so they serialize on their spatial path
  // alone. There are few of them and they collide with each other far more
  // often than with anything located.
  if (draft.lat === null || draft.lon === null) {
    return `${draft.spatialPath}:global`;
  }
  return `${draft.spatialPath}:${Math.floor(draft.lat)}:${Math.floor(draft.lon)}`;
}
