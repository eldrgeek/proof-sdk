/**
 * Proof Documents — what a second decision on an already-settled mark does.
 *
 * Mike, 2026-09-19: "Once I have accepted something, reject does not seem to work." It did nothing
 * at all: the review panel returned silently when the mark was no longer open, so the click was
 * swallowed. This names the semantics instead (see src/ui/playmaker-review.ts).
 */
/**
 * What a second decision on a mark that is already settled does (Mike, 2026-09-19: "Once I have
 * accepted something, reject does not seem to work"). Before this, `perform` returned silently and
 * the click did nothing at all.
 *
 * `refuse-with-undo` (the choice): an accepted change's text is already merged into the document,
 * and other people may have typed on top of it, so rejecting it afterwards would rewrite text
 * behind their backs — the clobbering the one Undo forbids. So Reject after Accept is refused in
 * one sentence that says the change is already in the text, with an Undo button beside it that
 * reverses the accept properly (the editor's decision history, which itself refuses when the text
 * moved). `silent` restores the old do-nothing behaviour; `revert` would reject straight over the
 * merged text.
 */
export const SETTLED_DECISION_POLICY = {
  onSecondDecision: 'refuse-with-undo' as 'refuse-with-undo' | 'silent' | 'revert',
  /** What the person reads, per decision they already made. */
  words: {
    accepted: 'You already accepted this change, so its text is in the document now. Undo the accept to take it back, or edit the new text.',
    rejected: 'You already rejected this change, so it is no longer in the document. Undo the reject to bring it back.',
    resolved: 'This comment is already resolved. Undo to reopen it.',
    gone: 'This change is no longer in the document: someone decided it or edited it away.',
  },
} as const;

