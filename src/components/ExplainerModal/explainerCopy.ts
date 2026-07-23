/**
 * Explainer copy for the Clock meta-system modal (spec.md  / comprehensive
 * §7). The prose below is transcribed VERBATIM from docs/spec.md §4 — character
 * for character, including the "aims to" in "How It Matters", which is the
 * product owner's deliberate, final wording. Do not edit, hedge, or restore any
 * earlier phrasing: this file is a transcription, not authored content.
 *
 * v3.2 governs the copy (it gives it verbatim); the comprehensive spec only
 * paraphrases §7, so there is no conflict to resolve here.
 */

export interface ExplainerSection {
  /** Section heading exactly as written in the spec ("What It Is", etc.). */
  readonly heading: string;
  /** Section body, transcribed verbatim. */
  readonly body: string;
}

export interface ExplainerCopy {
  /** Panel title, from the spec's "System Overview: The Clock Mechanics". */
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
