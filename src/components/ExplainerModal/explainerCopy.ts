/**
 * Explainer copy for the Clock modal.
 *
 * This is the product owner's wording, reproduced character for character —
 * including the "aims to" in "How It Matters", which is deliberate. Treat it as
 * transcription, not authored content: do not reword, hedge, or tighten it.
 */

export interface ExplainerSection {
  /** Section heading, e.g. "What It Is". */
  readonly heading: string;
  /** Section body, transcribed verbatim. */
  readonly body: string;
}

export interface ExplainerCopy {
  /** Panel title. */
  readonly title: string;
  readonly sections: readonly ExplainerSection[];
}

export const EXPLAINER_COPY: ExplainerCopy = {
  title: 'System Overview: The Clock Mechanics',
  sections: [
    {
      heading: 'What It Is',
      body:
        'This interface is an empirical, non-linear reality tracker designed to ' +
        'measure structural stability against acute informational and ecological ' +
        'disintegration.',
    },
    {
      heading: 'Why It Is',
      body:
        'Modern institutional architectures fail to map hyper-complex, cascading ' +
        'tipping points effectively. By decoupling signals from standard ' +
        'administrative filters, this platform surfaces reality vectors directly, ' +
        'measuring both the compounding vectors of systemic decay and the resilient ' +
        'networks acting to counterbalance them.',
    },
    {
      heading: 'How It Matters',
      body:
        'Every entry in this system aims to represent an empirical, verifiable fact ' +
        'backed by rigid citation lines. The shifting colors and ticking countdown ' +
        "values represent a data-driven model tracking humanity's window of " +
        'viable course-correction. It moves the conversation away from abstract ' +
        'panic into high-fidelity, actionable tracking.',
    },
  ],
} as const;
