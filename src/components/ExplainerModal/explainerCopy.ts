/**
 * Explainer copy for the Clock modal.
 *
 * Written for someone who has never seen this before and has no background in
 * climate science, statistics, or systems modelling. Short sentences, concrete
 * nouns, no jargon. If a phrase would make a reader feel they were missing a
 * definition, it does not belong here.
 *
 * The earlier draft was transcribed verbatim from the product owner and this
 * file said not to reword it. That instruction is superseded: the rewrite to
 * plain language was requested directly. Wording is now editable — but the
 * CLAIMS are not decoration. "A model, not a measurement", that the judgements
 * are made by a language model that gets things wrong, and the alpha warning
 * are honesty constraints the product commits to elsewhere (see the honesty
 * section of CLAUDE.md). Rephrase them freely; do not soften what they say.
 *
 * Note what was REMOVED and why, so it is not helpfully restored: an earlier
 * draft claimed "we do not add our own opinion about how bad something is".
 * That was false. Significance, irreversibility and source credibility are all
 * LLM judgements — an imperfect stand-in for opinionated data, not an absence
 * of opinion. It also described grey as meaning "no data", which the current
 * field does not show.
 */

export interface ExplainerSection {
  /** Section heading, e.g. "What this is". */
  readonly heading: string;
  /** Section body. */
  readonly body: string;
}

export interface ExplainerCopy {
  /** Panel title. */
  readonly title: string;
  readonly sections: readonly ExplainerSection[];
}

export const EXPLAINER_COPY: ExplainerCopy = {
  title: 'How the Clock works',
  sections: [
    {
      heading: 'What this is',
      body:
        'A map of the forces pushing the world toward crisis, and the ones ' +
        'pushing back. Every part of the globe is tinted by what is happening ' +
        'there: red where the evidence points toward damage, blue where it ' +
        'points toward repair, purple where strong forces pull both ways.',
    },
    {
      heading: 'What the countdown is counting',
      body:
        'Some changes cannot be undone once they start. An ice sheet that will ' +
        'not reform. A rainforest that will not grow back. Scientists publish ' +
        'estimates of when those points are reached, and the Clock counts down ' +
        'to the earliest one we know about. It is not a countdown to the end of ' +
        'the world. It is an estimate of how long we still have to change the ' +
        'outcome — because after that point, some of the damage continues no ' +
        'matter what anyone does.',
    },
    {
      heading: 'Where the numbers come from',
      body:
        'Everything here is taken from published sources, and every entry keeps ' +
        'its citations so you can open them and judge for yourself. Each ' +
        'finding is weighed by how much of the world it affects, so the loss of ' +
        'a global ecosystem counts for more than one country recovering one ' +
        'species. Where the science gives a range of dates rather than a single ' +
        'year, we keep the range instead of picking a number.',
    },
    {
      heading: 'What it cannot tell you',
      body:
        'This is a model, not a measurement. It only knows what it has found ' +
        'and read, and a gap in what it has found looks exactly like good news ' +
        'even though it is not. The sources are real, but the judgements about ' +
        'them — how much a finding matters, whether a threshold is one we ' +
        'cannot come back from — are made by a language model reading those ' +
        'sources, and it gets things wrong. The countdown rests on a small ' +
        'number of dated thresholds, so finding one new study can move it by ' +
        'years. Treat the date as a considered estimate worth arguing with, ' +
        'not as a prediction and not as a deadline anyone has verified.',
    },
    {
      heading: 'This is an alpha',
      body:
        'This is an early proof of concept, and it should not be treated as ' +
        'more than that. The data is incomplete, the way findings are weighed ' +
        'is still being calibrated, and the numbers can change substantially ' +
        'from one day to the next as the method improves — not because the ' +
        'world changed, but because the model did. Please do not cite it, plan ' +
        'around it, or repeat any figure from it as fact. It exists to show ' +
        'that the approach can work, not yet to tell you what will happen.',
    },
  ],
} as const;
