/**
 * Curated seed corpus for "Target: Calamity" — real, sourced factors drawn from
 * the "Alchemizing Reality" research document.
 *
 * PROVENANCE — read this honestly. The on-disk essay (`Prompt.txt`) carries NO
 * bibliography, so the first pass of these citations was reconstructed from model
 * knowledge. They have since been reconciled against the product owner's
 * referenced bibliography, reproduced as the single source of truth in
 * `docs/corpus-bibliography.md`. Every citation here is traced back to an entry
 * in that file: publisher and `sourceUrl` are re-pointed to match the
 * bibliography, `quoteSnippet`s are typed as verbatim vs paraphrase (see below),
 * and every "correction flag" the bibliography records is carried into the data
 * rather than silently cleaned up to the more dramatic number.
 *
 * Editorial rules applied here (see `docs/corpus-bibliography.md`, "Rules"):
 *   - `quoteSnippet` + `verbatim`: `verbatim: true` ONLY where the snippet is a
 *     genuine contiguous span from the cited source; `verbatim: false` where it
 *     is a paraphrase/summary or a composite no single source sentence contains.
 *     The UI renders the latter WITHOUT quotation marks (never a fake quote).
 *   - Correction flags carried, not dropped: AMOC 95% CI is 2025–2095 (not the
 *     essay's 2065); 2024 US federal lobbying is $4.4B per OpenSecrets (not
 *     $4.5B); the AI-degree "77%" overstatement is corrected to ~two-thirds
 *     master's+ per Lightcast; pollinator value is the $235–577B RANGE, not just
 *     the $577B top.
 *   - `verificationState: 'verified'` requires the citation to trace to the
 *     bibliography (rule #4). A handful of real, well-known sources (IRENA, the
 *     Global Tipping Points Report, REScoop.eu, Global Forest Watch, the PNAS
 *     breadbasket study) are NOT reproduced in the corpus bibliography, so their
 *     factors are held at `'pending'` — they stay in the feed but are kept off
 *     the verified field/Clock until added to the corpus. Their citations are
 *     retained with an analyst note stating exactly why.
 *   - `effect ∈ [-1, 1]`: negative = Calamity (systemic decay), positive =
 *     Humanity (resilient counter-measure), magnitude ~ systemic reach.
 *   - `significance ∈ [0, 1]`: confidence / weight of the evidence.
 *   - `gestaltChannelAddress` is null for all seeds — a Phase 2 concern.
 *
 * The identical data is mirrored in `db/seed.sql`. IDs are stable, valid v4-form
 * UUIDs so the two representations reference the same rows.
 */
import type { Factor } from './types.js';

/** Deterministic ISO-8601 timestamp for the Nth seed (staggered so `recent` sort is defined). */
const ts = (n: number): string => {
  const day = String(n).padStart(2, '0');
  return `2026-06-${day}T12:00:00.000Z`;
};

export const SEED_FACTORS: Factor[] = [
  /* ───────────────────────── CALAMITY (negative effect) ───────────────────── */
  {
    id: 'f0000000-0000-4000-8000-000000000001',
    spatialPath: 'global',
    name: 'Arctic sea ice — record-low winter maximum',
    description:
      'The 2025 Arctic sea-ice winter maximum was the lowest in the 47-year satellite record at 14.33 million km², about 1.31 million km² below the 1981–2010 average. Loss of reflective ice weakens the planetary albedo shield, a self-reinforcing warming feedback.',
    effect: -0.85,
    significance: 0.9,
    lat: 85.0,
    lon: 0.0,
    zoneLevel: 'global',
    verificationState: 'verified',
    gestaltChannelAddress: null,
    createdAt: ts(1),
    updatedAt: ts(1),
    tippingPoint: {
      centralYear: 2030,
      earliestYear: 2027,
      latestYear: 2035,
      label: "Ice-free Arctic 'Blue Ocean Event' (NSIDC projections)",
    },
    citations: [
      {
        id: 'c0000000-0000-4000-8000-000000000001',
        factorId: 'f0000000-0000-4000-8000-000000000001',
        sourceUrl: 'https://nsidc.org/sea-ice-today/analyses/arctic-sea-ice-sets-record-low-maximum-2025',
        publisher: 'National Snow and Ice Data Center (NSIDC)',
        quoteSnippet:
          'On March 22, Arctic sea ice likely reached its maximum extent for the year, at 14.33 million square kilometers, the lowest in the 47-year satellite record.',
        verbatim: true,
        analystNotes: null,
        retrievedAt: ts(1),
      },
    ],
  },
  {
    id: 'f0000000-0000-4000-8000-000000000002',
    spatialPath: 'global',
    name: 'Permafrost carbon feedback',
    description:
      'Northern permafrost soils hold roughly 1,460–1,600 gigatons of organic carbon, about twice the amount currently in the atmosphere. Thaw converts this store into CO₂ and methane in an accelerating feedback that is poorly represented in most climate models.',
    effect: -0.9,
    significance: 0.85,
    lat: 67.5,
    lon: 100.0,
    zoneLevel: 'global',
    verificationState: 'verified',
    gestaltChannelAddress: null,
    createdAt: ts(2),
    updatedAt: ts(2),
    citations: [
      {
        id: 'c0000000-0000-4000-8000-000000000002',
        factorId: 'f0000000-0000-4000-8000-000000000002',
        sourceUrl: 'https://www.nature.com/articles/nature14338',
        publisher: 'Nature (Schuur et al., 2015, "Climate change and the permafrost carbon feedback")',
        quoteSnippet:
          'Northern permafrost soils hold on the order of 1,460–1,600 gigatons of organic carbon — roughly twice the carbon currently in the atmosphere.',
        verbatim: false,
        analystNotes:
          'Re-pointed to Schuur et al. (2015), the corpus bibliography entry for the permafrost carbon stock; NOAA Arctic Report Card figures corroborate the ~1,460–1,600 GtC range (the corpus’s 1,400–1,700 Gt band additionally includes deep deposits). Abrupt-thaw acceleration and its poor representation in most Earth-system models are documented separately (Turetsky et al., 2020).',
        retrievedAt: ts(2),
      },
    ],
  },
  {
    id: 'f0000000-0000-4000-8000-000000000003',
    spatialPath: 'global.br',
    name: 'Amazon forest — critical transition risk',
    description:
      'By 2050 an estimated 10–47% of the Amazon could face compounding stressors (warming, drought, fire, deforestation) capable of triggering large-scale dieback from rainforest to savanna. The southeastern Amazon is already a net carbon source.',
    effect: -0.8,
    significance: 0.85,
    lat: -3.47,
    lon: -62.2,
    zoneLevel: 'national',
    verificationState: 'verified',
    gestaltChannelAddress: null,
    createdAt: ts(3),
    updatedAt: ts(3),
    tippingPoint: {
      centralYear: 2050,
      latestYear: 2060,
      label: 'Amazon large-scale collapse exposure by 2050 (Flores et al. 2024)',
    },
    citations: [
      {
        id: 'c0000000-0000-4000-8000-000000000003',
        factorId: 'f0000000-0000-4000-8000-000000000003',
        sourceUrl: 'https://www.nature.com/articles/s41586-023-06970-0',
        publisher: 'Nature (Flores et al., 2024, "Critical transitions in the Amazon forest system")',
        quoteSnippet:
          'By 2050, 10% to 47% of Amazonian forests will be exposed to compounding disturbances that may trigger unexpected ecosystem transitions.',
        verbatim: true,
        analystNotes:
          'The often-quoted 20–25% deforestation tipping threshold (vs. ~17% cleared today) is from Lovejoy & Nobre (2018, Science Advances); it is carried in the description but attributed separately as it is a distinct estimate.',
        retrievedAt: ts(3),
      },
    ],
  },
  {
    id: 'f0000000-0000-4000-8000-000000000004',
    spatialPath: 'global',
    name: 'AMOC — weakening and possible collapse',
    description:
      'Freshwater input from Greenland and Arctic melt is weakening the Atlantic Meridional Overturning Circulation. A collapse would disrupt monsoons billions depend on and could cool parts of Europe. Timing is scientifically contested.',
    effect: -0.78,
    significance: 0.75,
    lat: 59.0,
    lon: -30.0,
    zoneLevel: 'global',
    verificationState: 'verified',
    gestaltChannelAddress: null,
    createdAt: ts(4),
    updatedAt: ts(4),
    tippingPoint: {
      centralYear: 2050,
      earliestYear: 2025,
      latestYear: 2095,
      label: 'AMOC collapse (Ditlevsen & Ditlevsen 2023)',
    },
    citations: [
      {
        id: 'c0000000-0000-4000-8000-000000000004',
        factorId: 'f0000000-0000-4000-8000-000000000004',
        sourceUrl: 'https://www.nature.com/articles/s41467-023-39810-w',
        publisher: 'Nature Communications (Ditlevsen & Ditlevsen, 2023)',
        quoteSnippet:
          'The Atlantic Meridional Overturning Circulation is warned to be on course to collapse around mid-century, with a 95% confidence range of 2025–2095.',
        verbatim: false,
        analystNotes:
          'Correction (corpus bibliography): the essay’s “95% CI at 2065, bounds 2037–2109” does NOT match the paper. Ditlevsen & Ditlevsen give a 95% confidence range of 2025–2095, central estimate around mid-century. The result remains contested across the field, so significance is held below the harder-observed climate factors.',
        retrievedAt: ts(4),
      },
    ],
  },
  {
    id: 'f0000000-0000-4000-8000-000000000005',
    spatialPath: 'global',
    name: 'Global pollinator decline',
    description:
      'The 2016 IPBES assessment (>3,000 studies) found over 40% of invertebrate pollinator species — chiefly bees and butterflies — face extinction. Over 75% of food crop types depend on animal pollination, valued at US$235–577 billion annually.',
    effect: -0.7,
    significance: 0.8,
    lat: 20.0,
    lon: 0.0,
    zoneLevel: 'global',
    verificationState: 'verified',
    gestaltChannelAddress: null,
    createdAt: ts(5),
    updatedAt: ts(5),
    citations: [
      {
        id: 'c0000000-0000-4000-8000-000000000005',
        factorId: 'f0000000-0000-4000-8000-000000000005',
        sourceUrl: 'https://www.ipbes.net/assessment-reports/pollinators',
        publisher: 'IPBES (Assessment Report on Pollinators, Pollination and Food Production, 2016)',
        quoteSnippet:
          'Over 40% of invertebrate pollinator species — particularly bees and butterflies — face extinction; US$235–577 billion of annual global food production relies on pollinators.',
        verbatim: false,
        analystNotes:
          'Correction (bibliography flag): pollination services are valued as a $235–577 billion/yr RANGE; the corpus’s “up to $577B” top-of-range figure is carried as the full range, not just the maximum.',
        retrievedAt: ts(5),
      },
    ],
  },
  {
    id: 'f0000000-0000-4000-8000-000000000006',
    spatialPath: 'global',
    name: 'Coral reef collapse at 2°C',
    description:
      'The IPCC projects coral reefs decline 70–90% at 1.5°C of warming and by more than 99% at 2°C. With 1.5°C breached for a full calendar year in 2024, this is a present-day trajectory rather than a distant projection.',
    effect: -0.72,
    significance: 0.75,
    lat: -18.28,
    lon: 147.7,
    zoneLevel: 'global',
    verificationState: 'verified',
    gestaltChannelAddress: null,
    createdAt: ts(6),
    updatedAt: ts(6),
    citations: [
      {
        id: 'c0000000-0000-4000-8000-000000000006',
        factorId: 'f0000000-0000-4000-8000-000000000006',
        sourceUrl: 'https://www.ipcc.ch/sr15/',
        publisher: 'IPCC Special Report on Global Warming of 1.5°C (2018)',
        quoteSnippet:
          'Coral reefs are projected to decline by a further 70–90% at 1.5°C (high confidence) with larger losses (>99%) at 2°C (very high confidence).',
        verbatim: true,
        analystNotes:
          'Pin placed at the Great Barrier Reef as a representative point; the phenomenon is global (all tropical reef systems).',
        retrievedAt: ts(6),
      },
    ],
  },
  {
    id: 'f0000000-0000-4000-8000-000000000007',
    spatialPath: 'global',
    name: '2024 — warmest year on record',
    description:
      '2024 was the warmest year in the 175-year observational record at 1.55°C ± 0.13°C above the 1850–1900 average — the first full calendar year above 1.5°C. The ten warmest years on record are all within the last decade.',
    effect: -0.9,
    significance: 0.95,
    lat: 0.0,
    lon: 0.0,
    zoneLevel: 'global',
    verificationState: 'verified',
    gestaltChannelAddress: null,
    createdAt: ts(7),
    updatedAt: ts(7),
    citations: [
      {
        id: 'c0000000-0000-4000-8000-000000000007',
        factorId: 'f0000000-0000-4000-8000-000000000007',
        sourceUrl:
          'https://wmo.int/news/media-centre/wmo-confirms-2024-warmest-year-record-about-155degc-above-pre-industrial-level',
        publisher: 'World Meteorological Organization (WMO)',
        quoteSnippet:
          'The global average surface temperature in 2024 was 1.55 °C (± 0.13 °C) above the 1850–1900 average, making it the warmest year in the 175-year observational record.',
        verbatim: false,
        analystNotes:
          'A single year above 1.5°C does not by itself breach the Paris long-term goal, which is defined over decades; this is noted to avoid overstating the claim.',
        retrievedAt: ts(7),
      },
    ],
  },
  {
    id: 'f0000000-0000-4000-8000-000000000008',
    spatialPath: 'global.us',
    name: 'Regulatory capture via lobbying',
    description:
      'US federal lobbying reached a record ~$4.4 billion in 2024, with pharmaceuticals, electronics and energy among the heaviest spenders — a direct mechanism by which incumbents blunt regulation of Clock-accelerating industries.',
    effect: -0.55,
    significance: 0.6,
    lat: 38.8977,
    lon: -77.0365,
    zoneLevel: 'national',
    verificationState: 'verified',
    gestaltChannelAddress: null,
    createdAt: ts(8),
    updatedAt: ts(8),
    citations: [
      {
        id: 'c0000000-0000-4000-8000-000000000008',
        factorId: 'f0000000-0000-4000-8000-000000000008',
        sourceUrl: 'https://www.opensecrets.org/news/2025/02/federal-lobbying-set-new-record-in-2024/',
        publisher: 'OpenSecrets',
        quoteSnippet: 'In 2024, lobbying spending reached a record-breaking $4.4 billion.',
        verbatim: true,
        analystNotes:
          'Correction (bibliography flag): the corpus/essay states $4.5 billion (a Bloomberg Government tally). OpenSecrets, the standard registry-based source, reports $4.4 billion for 2024; the corrected $4.4B figure is used.',
        retrievedAt: ts(8),
      },
    ],
  },
  {
    id: 'f0000000-0000-4000-8000-000000000009',
    spatialPath: 'global.us',
    name: 'Cloud infrastructure concentration',
    description:
      'As of Q4 2024 three firms — Amazon (AWS, 30%), Microsoft (Azure, 21%) and Google (12%) — controlled a combined 63% of the global cloud infrastructure market, giving a handful of actors structural control over the compute layer of the modern economy.',
    effect: -0.45,
    significance: 0.55,
    lat: 47.6062,
    lon: -122.3321,
    zoneLevel: 'national',
    verificationState: 'verified',
    gestaltChannelAddress: null,
    createdAt: ts(9),
    updatedAt: ts(9),
    citations: [
      {
        id: 'c0000000-0000-4000-8000-000000000009',
        factorId: 'f0000000-0000-4000-8000-000000000009',
        sourceUrl:
          'https://www.srgresearch.com/articles/cloud-market-jumped-to-330-billion-in-2024-genai-is-now-driving-half-of-the-growth',
        publisher: 'Synergy Research Group',
        quoteSnippet:
          'The Big Three — AWS at 30%, Microsoft at 21% and Google at 12% — together hold 63% of the worldwide cloud infrastructure market.',
        verbatim: false,
        analystNotes:
          'Placed at Seattle (AWS/Azure region hub) as a representative US point; the market is global but the controlling firms are US-domiciled.',
        retrievedAt: ts(9),
      },
    ],
  },
  {
    id: 'f0000000-0000-4000-8000-000000000010',
    spatialPath: 'global',
    name: 'Wealth concentration',
    description:
      'Oxfam’s 2025 "Takers Not Makers" report projects the world could mint its first trillionaires within a decade and finds roughly 60% of billionaire wealth is inherited or derived from monopoly power and cronyism — a structural concentration of economic power.',
    effect: -0.6,
    significance: 0.7,
    lat: 46.8,
    lon: 9.83,
    zoneLevel: 'global',
    verificationState: 'verified',
    gestaltChannelAddress: null,
    createdAt: ts(10),
    updatedAt: ts(10),
    citations: [
      {
        id: 'c0000000-0000-4000-8000-000000000010',
        factorId: 'f0000000-0000-4000-8000-000000000010',
        sourceUrl: 'https://policy-practice.oxfam.org/resources/takers-not-makers-621668/',
        publisher: 'Oxfam ("Takers Not Makers", 2025)',
        quoteSnippet:
          'Oxfam projects the world’s first trillionaires within a decade, and finds around 60% of billionaire wealth comes from inheritance, monopoly power or cronyism.',
        verbatim: false,
        analystNotes:
          'Source re-pointed from a secondary news aggregator to Oxfam’s own "Takers Not Makers" (2025), the bibliography entry. The separate "top 1% own 43% of global financial assets" figure belongs to Oxfam’s Sept-2024 report and is not carried here, to keep one claim per source. Pin placed near Davos as a representative point; the phenomenon is global.',
        retrievedAt: ts(10),
      },
    ],
  },
  {
    id: 'f0000000-0000-4000-8000-000000000011',
    spatialPath: 'global',
    name: 'AI-driven labour displacement',
    description:
      'Goldman Sachs estimates generative AI could expose the equivalent of 300 million full-time jobs to automation globally, concentrated in office, administrative and legal work — reallocating labour toward a smaller high-skill cohort.',
    effect: -0.5,
    significance: 0.6,
    lat: 37.7749,
    lon: -122.4194,
    zoneLevel: 'global',
    verificationState: 'verified',
    gestaltChannelAddress: null,
    createdAt: ts(11),
    updatedAt: ts(11),
    citations: [
      {
        id: 'c0000000-0000-4000-8000-000000000011',
        factorId: 'f0000000-0000-4000-8000-000000000011',
        sourceUrl: 'https://www.goldmansachs.com/insights/articles/generative-ai-could-raise-global-gdp-by-7-percent',
        publisher: 'Goldman Sachs Global Investment Research (2023)',
        quoteSnippet:
          'Generative AI could expose the equivalent of 300 million full-time jobs to automation worldwide.',
        verbatim: true,
        analystNotes:
          'Counter-evidence carried deliberately: firm-level studies (PwC, Brookings) find AI adoption correlates with higher employment and wage premiums for AI-skilled workers — the effect is reallocation, not simple destruction. Correction (bibliography flag): the corpus’s "77% of new AI jobs require a master’s" is an overstatement; Lightcast data indicate roughly two-thirds of AI-engineering postings require a master’s or higher (~43% master’s + ~23% PhD/professional), and PwC’s 2025 Barometer finds degree requirements for AI-exposed jobs falling.',
        retrievedAt: ts(11),
      },
    ],
  },
  {
    id: 'f0000000-0000-4000-8000-000000000012',
    spatialPath: 'global',
    name: 'Active conflicts at a post-WWII high',
    description:
      'The 2024 Global Peace Index records 56 active conflicts — the most since World War II — with 92 countries involved in conflicts beyond their borders. Climate stress acts as a "threat multiplier" over scarce resources.',
    effect: -0.68,
    significance: 0.72,
    lat: 15.0,
    lon: 30.0,
    zoneLevel: 'global',
    verificationState: 'verified',
    gestaltChannelAddress: null,
    createdAt: ts(12),
    updatedAt: ts(12),
    citations: [
      {
        id: 'c0000000-0000-4000-8000-000000000012',
        factorId: 'f0000000-0000-4000-8000-000000000012',
        sourceUrl: 'https://www.economicsandpeace.org/wp-content/uploads/2024/06/GPI-2024-web.pdf',
        publisher: 'Institute for Economics & Peace — Global Peace Index 2024',
        quoteSnippet:
          'There are currently 56 conflicts, the most since World War II, and 92 countries are involved in conflicts outside their borders — the most since the GPI’s inception.',
        verbatim: false,
        analystNotes: null,
        retrievedAt: ts(12),
      },
    ],
  },
  {
    id: 'f0000000-0000-4000-8000-000000000013',
    spatialPath: 'global',
    name: 'Textile waste — the fast-fashion linear model',
    description:
      'The fast-fashion model generates enormous textile waste. US EPA data show 17 million tons of textiles generated in 2018 with only a 14.7% recycling rate — a verifiable snapshot of a globally replicated take-make-discard system.',
    effect: -0.4,
    significance: 0.45,
    lat: 23.8103,
    lon: 90.4125,
    zoneLevel: 'global',
    verificationState: 'verified',
    gestaltChannelAddress: null,
    createdAt: ts(13),
    updatedAt: ts(13),
    citations: [
      {
        id: 'c0000000-0000-4000-8000-000000000013',
        factorId: 'f0000000-0000-4000-8000-000000000013',
        sourceUrl:
          'https://www.epa.gov/facts-and-figures-about-materials-waste-and-recycling/textiles-material-specific-data',
        publisher: 'US Environmental Protection Agency',
        quoteSnippet:
          'EPA estimated that the generation of textiles in 2018 was 17 million tons, and the recycling rate for all textiles was 14.7 percent.',
        verbatim: false,
        analystNotes:
          'The corpus’s "92 million tonnes/year" global figure is an industry estimate (aggregating UNEP / Ellen MacArthur); the EPA numbers are used as the directly verifiable US subset. Pin placed at Dhaka as a representative garment-production hub.',
        retrievedAt: ts(13),
      },
    ],
  },
  {
    id: 'f0000000-0000-4000-8000-000000000014',
    spatialPath: 'global.us',
    name: 'Planned obsolescence',
    description:
      'The deliberate shortening of product lifespans is a documented corporate strategy. Apple’s "Batterygate" — throttling older iPhones via software — settled US class actions for up to $500 million, echoing the 1920s–30s Phoebus lightbulb cartel’s enforced 1,000-hour bulb standard.',
    effect: -0.35,
    significance: 0.45,
    lat: 37.3349,
    lon: -122.009,
    zoneLevel: 'national',
    verificationState: 'verified',
    gestaltChannelAddress: null,
    createdAt: ts(14),
    updatedAt: ts(14),
    citations: [
      {
        id: 'c0000000-0000-4000-8000-000000000014',
        factorId: 'f0000000-0000-4000-8000-000000000014',
        sourceUrl:
          'https://www.npr.org/2020/11/18/936268845/apple-agrees-to-pay-113-million-to-settle-batterygate-case-over-iphone-slowdowns',
        publisher: 'NPR',
        quoteSnippet:
          'Apple agreed to pay $113 million to 34 states to settle claims over the "batterygate" slowdown of older iPhones — on top of a separate class-action settlement of up to $500 million.',
        verbatim: false,
        analystNotes:
          'The bibliography source (NPR) covers both the $113M 34-state AG settlement and the separate $500M class-action settlement; the description’s $500M refers to the latter.',
        retrievedAt: ts(14),
      },
      {
        id: 'c0000000-0000-4000-8000-000000000015',
        factorId: 'f0000000-0000-4000-8000-000000000014',
        sourceUrl: 'https://spectrum.ieee.org/the-great-lightbulb-conspiracy',
        publisher: 'IEEE Spectrum (Krajewski, "The Great Lightbulb Conspiracy", 2014)',
        quoteSnippet:
          'The Phoebus cartel standardised incandescent bulb life down to about 1,000 hours (from ~2,500), fining members whose bulbs lasted longer.',
        verbatim: false,
        analystNotes:
          'Re-pointed to the IEEE Spectrum history of the Phoebus cartel (the bibliography entry); the prior null sourceUrl is replaced with the canonical article.',
        retrievedAt: ts(14),
      },
    ],
  },
  {
    id: 'f0000000-0000-4000-8000-000000000016',
    spatialPath: 'global',
    name: 'Synchronised breadbasket failure risk',
    description:
      'Destabilised jet-stream patterns raise the risk of simultaneous crop failures across major exporters. A PNAS study finds the probability that the top four maize exporters (US, Brazil, Argentina, Ukraine) all lose >10% in one year rises from ~0% today to 86% under 4°C warming.',
    effect: -0.6,
    significance: 0.6,
    lat: 41.5,
    lon: -93.6,
    zoneLevel: 'global',
    // Held at 'pending': the cited PNAS study is real and well-known but is NOT
    // reproduced in docs/corpus-bibliography.md, so it cannot ship as 'verified'
    // (corpus rule #4). It stays in the feed but is kept off the field/Clock.
    verificationState: 'pending',
    gestaltChannelAddress: null,
    createdAt: ts(16),
    updatedAt: ts(16),
    citations: [
      {
        id: 'c0000000-0000-4000-8000-000000000016',
        factorId: 'f0000000-0000-4000-8000-000000000016',
        sourceUrl: 'https://www.pnas.org/doi/abs/10.1073/pnas.1718031115',
        publisher: 'PNAS (Tigchelaar et al., 2018)',
        quoteSnippet:
          'The probability of simultaneous maize production losses greater than 10% across the top exporters increases to 7% under 2 °C warming and 86% under 4 °C warming.',
        verbatim: false,
        analystNotes:
          'Source not in docs/corpus-bibliography.md: Tigchelaar et al. (2018, PNAS) is a real, well-known primary source but is not reproduced in the corpus, so this factor is held at "pending" (kept off the verified field/Clock) until it is added. Pin placed in the US Corn Belt as a representative production region; the risk is joint across all four exporters.',
        retrievedAt: ts(16),
      },
    ],
  },
  {
    id: 'f0000000-0000-4000-8000-000000000017',
    spatialPath: 'global',
    name: 'AI-amplified misinformation',
    description:
      'The World Economic Forum’s 2024 Global Risks Report ranks misinformation and disinformation — supercharged by generative AI — as the most severe short-term (two-year) global risk, ahead of extreme weather and armed conflict, by eroding the shared reality required for collective action.',
    effect: -0.55,
    significance: 0.6,
    lat: 20.0,
    lon: 0.0,
    zoneLevel: 'global',
    verificationState: 'verified',
    gestaltChannelAddress: null,
    createdAt: ts(17),
    updatedAt: ts(17),
    citations: [
      {
        id: 'c0000000-0000-4000-8000-000000000017',
        factorId: 'f0000000-0000-4000-8000-000000000017',
        sourceUrl: 'https://www.weforum.org/publications/global-risks-report-2024/',
        publisher: 'World Economic Forum — Global Risks Report 2024',
        quoteSnippet:
          'Misinformation and disinformation is ranked the most severe short-term (two-year) global risk.',
        verbatim: false,
        analystNotes: null,
        retrievedAt: ts(17),
      },
    ],
  },

  /* ───────────────────────── HUMANITY (positive effect) ───────────────────── */
  {
    id: 'f0000000-0000-4000-8000-000000000018',
    spatialPath: 'global',
    name: 'Clean energy investment overtakes fossil fuels',
    description:
      'The IEA projects ~$2.2 trillion of clean-energy investment in 2025 — roughly double the $1.1 trillion going to oil, gas and coal. A decade ago fossil-supply investment led electricity investment by 30%; today the positions are reversed.',
    effect: 0.72,
    significance: 0.75,
    lat: 0.0,
    lon: 0.0,
    zoneLevel: 'global',
    verificationState: 'verified',
    gestaltChannelAddress: null,
    createdAt: ts(18),
    updatedAt: ts(18),
    citations: [
      {
        id: 'c0000000-0000-4000-8000-000000000018',
        factorId: 'f0000000-0000-4000-8000-000000000018',
        sourceUrl: 'https://www.iea.org/reports/world-energy-investment-2025',
        publisher: 'International Energy Agency — World Energy Investment 2025',
        quoteSnippet:
          'Around USD 2.2 trillion is going collectively to clean energy in 2025, twice as much as the USD 1.1 trillion going to oil, natural gas and coal.',
        verbatim: false,
        analystNotes:
          'Solar (~$450B) is the single largest line item in the report; clean-energy investment now leads fossil-fuel supply investment two-to-one.',
        retrievedAt: ts(18),
      },
    ],
  },
  {
    id: 'f0000000-0000-4000-8000-000000000019',
    spatialPath: 'global',
    name: 'Solar and wind are the cheapest new power',
    description:
      'IRENA finds new onshore wind (~US$0.034/kWh) and utility-scale solar PV (~US$0.043/kWh) are now the cheapest sources of new electricity in most of the world; 81% of renewable capacity added in 2023 produced cheaper power than the cheapest fossil alternative.',
    effect: 0.68,
    significance: 0.7,
    lat: 10.0,
    lon: 0.0,
    zoneLevel: 'global',
    // Held at 'pending': IRENA is a real source but is NOT in the corpus
    // bibliography (rule #4). Stays in the feed, off the verified field/Clock.
    verificationState: 'pending',
    gestaltChannelAddress: null,
    createdAt: ts(19),
    updatedAt: ts(19),
    citations: [
      {
        id: 'c0000000-0000-4000-8000-000000000019',
        factorId: 'f0000000-0000-4000-8000-000000000019',
        sourceUrl:
          'https://www.irena.org/-/media/Files/IRENA/Agency/Publication/2024/Sep/IRENA_Renewable_power_generation_costs_in_2023_executive_summary.pdf',
        publisher: 'IRENA — Renewable Power Generation Costs in 2023',
        quoteSnippet:
          'New onshore wind (USD 0.034/kWh) and solar PV (USD 0.043/kWh) are the cheapest sources of new electricity; 81% of 2023 renewable additions were cheaper than the cheapest fossil option.',
        verbatim: false,
        analystNotes:
          'Source not in docs/corpus-bibliography.md: IRENA’s cost report is real and authoritative but is not reproduced in the corpus, so this factor is held at "pending" (kept off the verified field/Clock) until it is added.',
        retrievedAt: ts(19),
      },
    ],
  },
  {
    id: 'f0000000-0000-4000-8000-000000000020',
    spatialPath: 'global',
    name: 'Renewable energy — a positive tipping point',
    description:
      'The 2023 Global Tipping Points Report (200+ researchers, University of Exeter) finds positive tipping points already crossed in solar and wind adoption: solar PV capacity is doubling every 2–3 years as cost-reduction and deployment reinforce each other.',
    effect: 0.6,
    significance: 0.62,
    lat: 5.0,
    lon: 0.0,
    zoneLevel: 'global',
    // Held at 'pending': the Global Tipping Points Report is real but is NOT in
    // the corpus bibliography (rule #4). Stays in the feed, off the field/Clock.
    verificationState: 'pending',
    gestaltChannelAddress: null,
    createdAt: ts(20),
    updatedAt: ts(20),
    citations: [
      {
        id: 'c0000000-0000-4000-8000-000000000020',
        factorId: 'f0000000-0000-4000-8000-000000000020',
        sourceUrl: 'https://report-2023.global-tipping-points.org/',
        publisher: 'Global Tipping Points Report 2023 (University of Exeter, Global Systems Institute)',
        quoteSnippet:
          'Positive tipping points have already been crossed in the adoption of solar PV and wind power globally, with solar PV capacity doubling every 2–3 years.',
        verbatim: false,
        analystNotes:
          'Source not in docs/corpus-bibliography.md: the Global Tipping Points Report is real and well-cited but is not reproduced in the corpus, so this factor is held at "pending" (kept off the verified field/Clock) until it is added.',
        retrievedAt: ts(20),
      },
    ],
  },
  {
    id: 'f0000000-0000-4000-8000-000000000021',
    spatialPath: 'global.de',
    name: 'Community energy cooperatives',
    description:
      'Citizen-owned renewable projects are scaling a decentralised alternative to fossil incumbency. REScoop.eu represents over 2,250 European energy cooperatives and ~1.5 million citizens; Germany alone hosts more than 1,000 cooperatives.',
    effect: 0.42,
    significance: 0.45,
    lat: 51.1657,
    lon: 10.4515,
    zoneLevel: 'national',
    // Held at 'pending': REScoop.eu is a real source but is NOT in the corpus
    // bibliography (rule #4). Stays in the feed, off the verified field/Clock.
    verificationState: 'pending',
    gestaltChannelAddress: null,
    createdAt: ts(21),
    updatedAt: ts(21),
    citations: [
      {
        id: 'c0000000-0000-4000-8000-000000000021',
        factorId: 'f0000000-0000-4000-8000-000000000021',
        sourceUrl: 'https://www.rescoop.eu/uploads/rescoop/downloads/REScoop-Annual-Report-2023_digital.pdf',
        publisher: 'REScoop.eu — European federation of citizen energy cooperatives',
        quoteSnippet: 'REScoop.eu represents over 2,250 energy cooperatives and 1,500,000 European citizens.',
        verbatim: false,
        analystNotes:
          'Source not in docs/corpus-bibliography.md: REScoop.eu’s report is real but not reproduced in the corpus, so this factor is held at "pending" (kept off the verified field/Clock) until it is added. Pin placed in Germany, which hosts the largest number of energy cooperatives; the movement is pan-European.',
        retrievedAt: ts(21),
      },
    ],
  },
  {
    id: 'f0000000-0000-4000-8000-000000000022',
    spatialPath: 'global',
    name: 'Open-source environmental monitoring',
    description:
      'Global Forest Watch (World Resources Institute, with NASA/ESA/UMD data) delivers free, open, near-real-time forest-change alerts to anyone — a transparency counter-force to the information asymmetry that hides degradation. Weekly GLAD alerts at 30m; RADD alerts at 10m in the tropics.',
    effect: 0.4,
    significance: 0.4,
    lat: 38.8895,
    lon: -77.0353,
    zoneLevel: 'global',
    // Held at 'pending': Global Forest Watch is a real source but is NOT in the
    // corpus bibliography (rule #4). Stays in the feed, off the field/Clock.
    verificationState: 'pending',
    gestaltChannelAddress: null,
    createdAt: ts(22),
    updatedAt: ts(22),
    citations: [
      {
        id: 'c0000000-0000-4000-8000-000000000022',
        factorId: 'f0000000-0000-4000-8000-000000000022',
        sourceUrl: 'https://www.globalforestwatch.org/about/',
        publisher: 'Global Forest Watch (World Resources Institute)',
        quoteSnippet:
          'All data, maps, and analysis tools on GFW are free and open access, providing near-real-time information on forest change.',
        verbatim: false,
        analystNotes:
          'Source not in docs/corpus-bibliography.md: Global Forest Watch is a real, well-known platform but is not reproduced in the corpus, so this factor is held at "pending" (kept off the verified field/Clock) until it is added.',
        retrievedAt: ts(22),
      },
    ],
  },
  {
    id: 'f0000000-0000-4000-8000-000000000023',
    spatialPath: 'global.us',
    name: 'Decentralised coordination — the GameStop episode',
    description:
      'In January 2021 retail investors coordinating openly on Reddit’s r/wallstreetbets drove a short squeeze that lifted GameStop from a $17.25 close to over $500 intraday, inflicting billions in losses on short-selling hedge funds — a demonstration that distributed actors can rapidly out-coordinate concentrated capital.',
    effect: 0.35,
    significance: 0.4,
    lat: 40.706,
    lon: -74.009,
    zoneLevel: 'national',
    verificationState: 'verified',
    gestaltChannelAddress: null,
    createdAt: ts(23),
    updatedAt: ts(23),
    citations: [
      {
        id: 'c0000000-0000-4000-8000-000000000023',
        factorId: 'f0000000-0000-4000-8000-000000000023',
        sourceUrl: 'https://www.sec.gov/files/staff-report-equity-options-market-struction-conditions-early-2021.pdf',
        publisher: 'U.S. Securities and Exchange Commission (Staff Report, 2021)',
        quoteSnippet:
          'GameStop’s share price rose from a January 4 close of $17.25 to over $500 in pre-market trading on January 28, 2021, driven by retail investors coordinating on social media.',
        verbatim: false,
        analystNotes:
          'Source re-pointed to the SEC staff report (the bibliography entry) for the price move; Melvin Capital’s ~53% / $6.8B January loss (CNBC) and the $2.75B Citadel/Point72 injection (Bloomberg) are the corroborating figures. Cited as an example of rapid decentralised coordination, not an investment endorsement; brokerage trading restrictions (e.g. Robinhood) followed.',
        retrievedAt: ts(23),
      },
    ],
  },
];
