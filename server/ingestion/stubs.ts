/**
 * Deterministic offline implementations of the extractor and resolver ports.
 *
 * They exist so the loop runs with no network, and are deliberately obvious
 * about being stubs — nothing here should ever be mistaken for live research.
 */
import type { ResolverVerdict } from './dedupe.js';
import type { EntityResolver, FactorExtractor, ResolutionRequest } from './ports.js';
import type { ExtractedFactorDraft, InboundIntelItem } from './types.js';

/**
 * A trivial deterministic extractor: one factor per item, coordinates and
 * metrics carried on the item via a JSON `rawText` payload when present, else a
 * neutral default. Real Phase A is an LLM with a JSON-schema-constrained,
 * untrusted-text-delimited prompt ( / finding 27); this stub only exists
 * so the loop runs offline.
 */
export function createStubExtractor(): FactorExtractor {
  return {
    async extract(item: InboundIntelItem): Promise<ExtractedFactorDraft[]> {
      let payload: Partial<ExtractedFactorDraft> = {};
      try {
        const parsed: unknown = JSON.parse(item.rawText);
        if (parsed && typeof parsed === 'object') {
          payload = parsed as Partial<ExtractedFactorDraft>;
        }
      } catch {
        // rawText was not JSON — fall through to defaults.
      }
      return [
        {
          name: payload.name ?? 'Unclassified factor',
          description: payload.description ?? item.rawText.slice(0, 500),
          effect: payload.effect ?? -0.5,
          significance: payload.significance ?? 0.5,
          lat: payload.lat ?? 0,
          lon: payload.lon ?? 0,
          spatialPath: payload.spatialPath ?? 'global',
          // Pass a dated threshold through when the JSON payload carried one; else undefined.
          tippingPoint: payload.tippingPoint,
          citation: {
            publisher: item.publisher,
            sourceUrl: item.sourceUrl,
            quoteSnippet: payload.citation?.quoteSnippet ?? item.rawText.slice(0, 280),
          },
        },
      ];
    },
  };
}

/**
 * A deterministic resolver: escalates the nearest candidate when it is within
 * the hard collision threshold and classifies it `corroborating`, otherwise
 * declares the inbound independent. This mirrors the spec's original `< 0.15`
 * rule but as one specific *policy* over the candidate set — real Phase D is an
 * LLM. Useful as a baseline and for offline tests.
 */
export function createStubResolver(threshold = 0.15): EntityResolver {
  return {
    async resolve(request: ResolutionRequest): Promise<ResolverVerdict> {
      const nearest = request.candidates[0];
      if (nearest && nearest.distance <= threshold) {
        return {
          kind: 'escalation',
          parentId: nearest.id,
          directionality: 'corroborating',
        };
      }
      return { kind: 'independent' };
    },
  };
}
