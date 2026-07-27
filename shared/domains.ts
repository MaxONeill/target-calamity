/**
 * Causal domains linking factors to the tipping points they act on.
 *
 * The Clock's countdown (see `src/lib/clock/clockModel.ts`) anchors on dated
 * tipping points and lets the other factors — pressures and counter-forces —
 * warp WHEN those thresholds arrive. A factor should only move a threshold it is
 * causally connected to: deforestation moves the Amazon threshold, not the AMOC
 * one. Domains are that connection.
 *
 * Every factor is tagged with zero or more domains (derived from its text by
 * {@link classifyDomains}); every tipping point inherits its factor's domains. A
 * modifier factor acts on a threshold when their domains overlap — directly, or
 * through the upstream relationship in {@link UPSTREAM} (climate emissions drive
 * the cryosphere/ocean/forest thresholds downstream of them). Factors with no
 * classified domain are treated as SYSTEMIC and act weakly on everything.
 *
 * Pure and dependency-free so both the server (tagging the field set) and the
 * client (deriving the Clock) can share one definition.
 */

export const DOMAINS = [
  'climate',
  'cryosphere',
  'ocean',
  'forest',
  'biosphere',
  'freshwater',
  'food',
  'society',
  'health',
  'economy',
] as const;

export type Domain = (typeof DOMAINS)[number];

const DOMAIN_SET = new Set<string>(DOMAINS);

/** True when `value` is a known domain. */
export function isDomain(value: string): value is Domain {
  return DOMAIN_SET.has(value);
}

/** Human labels for the Why panel. */
export const DOMAIN_LABELS: Record<Domain, string> = {
  climate: 'Climate & emissions',
  cryosphere: 'Ice & permafrost',
  ocean: 'Oceans',
  forest: 'Forests',
  biosphere: 'Biodiversity',
  freshwater: 'Freshwater',
  food: 'Food & land',
  society: 'Society & governance',
  health: 'Public health',
  economy: 'Economy',
};

/**
 * Upstream → downstream drivers. A force in an upstream domain also acts on
 * thresholds in its downstream domains. Only climate is modelled as a driver:
 * emissions and the energy transition move nearly every Earth-system threshold.
 * Deliberately minimal and explicit so the mechanism stays inspectable rather
 * than an opaque Earth-system model.
 */
export const UPSTREAM: Partial<Record<Domain, readonly Domain[]>> = {
  climate: ['cryosphere', 'ocean', 'forest', 'biosphere', 'freshwater', 'food'],
};

/**
 * Keyword → domain map. Substring-matched against a factor's lowercased text.
 * Transparent by design: a reader can see exactly why a factor was tagged, which
 * is the point of a defensible model. An LLM classification at ingestion could
 * refine this later; the deterministic rules are the auditable baseline.
 */
const KEYWORDS: Record<Domain, readonly string[]> = {
  climate: [
    'emission',
    'greenhouse',
    'ghg',
    'carbon',
    'co2',
    'methane',
    'warming',
    'temperature',
    'fossil',
    'clean energy',
    'renewable',
    'solar',
    'wind power',
    'grid',
    'decarbon',
    'net zero',
    'net-zero',
    'coal',
    'oil ',
    'natural gas',
    'climate',
  ],
  cryosphere: [
    'ice',
    'glacier',
    'permafrost',
    'arctic',
    'antarctic',
    'greenland',
    'sea ice',
    'ice sheet',
    'cryosphere',
    'snowpack',
    'frozen',
  ],
  ocean: [
    'ocean',
    'marine',
    'coral',
    'reef',
    'amoc',
    'overturning',
    'acidif',
    'fisher',
    'fish stock',
    'sea level',
    'sea-level',
  ],
  forest: [
    'forest',
    'amazon',
    'rainforest',
    'deforest',
    'boreal',
    'woodland',
    'dieback',
    'tree cover',
    'tree-cover',
    'logging',
  ],
  biosphere: [
    'biodiversity',
    'species',
    'wildlife',
    'extinction',
    'ecosystem',
    'habitat',
    'pollinator',
    'insect',
    'mammal',
    'population decline',
    'rewild',
  ],
  freshwater: [
    'freshwater',
    'aquifer',
    'groundwater',
    'drought',
    'watershed',
    'water scarcity',
    'water stress',
    'water security',
    'river basin',
  ],
  food: [
    'crop',
    'agricultur',
    'harvest',
    'famine',
    'food security',
    'food system',
    'yield',
    'soil',
    'farmland',
    'fertiliz',
    'fertilis',
  ],
  society: [
    'democra',
    'authoritarian',
    'conflict',
    'war',
    'human right',
    'institution',
    'governance',
    'migration',
    'displacement',
    'misinformation',
    'disinformation',
    'polaris',
    'polariz',
    'civil ',
    'rule of law',
  ],
  health: [
    'disease',
    'pandemic',
    'public health',
    'mortality',
    'antimicrobial',
    'vaccine',
    'vaccination',
    'outbreak',
    'epidemic',
  ],
  economy: [
    'wealth',
    'economic',
    'financial',
    'poverty',
    'inequality',
    'investment',
    'market',
    'gdp',
    'debt',
    'labour',
    'labor',
    'unemploy',
  ],
};

/**
 * Classify free text into zero or more domains by keyword. Order-stable
 * (follows {@link DOMAINS}); returns `[]` when nothing matches, which the model
 * treats as systemic.
 */
export function classifyDomains(...parts: (string | null | undefined)[]): Domain[] {
  const text = parts.filter(Boolean).join(' ').toLowerCase();
  if (text.length === 0) return [];
  return DOMAINS.filter((domain) => KEYWORDS[domain].some((kw) => text.includes(kw)));
}

/**
 * The domains whose forces act on a threshold: its own domains plus any upstream
 * driver of them. Empty input yields an empty set (only systemic force applies).
 */
export function drivingDomains(thresholdDomains: readonly Domain[]): Set<Domain> {
  const driving = new Set<Domain>(thresholdDomains);
  for (const domain of Object.keys(UPSTREAM) as Domain[]) {
    const downstream = UPSTREAM[domain];
    if (downstream && thresholdDomains.some((d) => downstream.includes(d))) {
      driving.add(domain);
    }
  }
  return driving;
}
