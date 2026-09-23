/**
 * Accord round 2, stage A — an edit has a visible state, and one gesture that ends it by posting.
 *
 * Mike, 2026-09-22: "When option clicking to edit, the cursor changes, but there should be some
 * better indication that we are in editing mode. Not clear how to get out of editing mode."
 *
 * The one rule, as the person sees it:
 *   Leaving an edit ALWAYS posts what you typed as a proposal other people can see. Nothing is
 *   ever discarded by leaving. Undo is the only way to remove a posted proposal.
 *
 * The rule has three doors, and they are the same action:
 *   - Cmd+Enter (Ctrl+Enter off a Mac) — the advertised gesture.
 *   - A click outside the edited line — what people do by accident, so the accident is correct.
 *   - Esc — not advertised, but bound, so nobody who presses it is trapped or loses text.
 * Two more paths leave an edit without the person meaning to (resting the pointer on another line,
 * scrolling the caret out of view). They are doors too: they post, they do not drop text.
 *
 * "Posts" means the typed line becomes an ordinary open suggestion (src/editor/plugins/
 * suggestions.ts) attributed to the editor, with the original text still readable underneath. It
 * is a proposal, not an edit to the document, until someone accepts it.
 *
 * Pure: this module decides. src/editor/editing-guard.ts holds the session and routes the doors;
 * src/editor/index.ts posts the proposal; src/ui/reading-walk.ts and src/ui/line-marks.ts show the
 * state.
 *
 * Authorship: Mike Wolf (rulings), built by Claude Opus 5 (worker accord-edit), 2026-09-22.
 */

/** Every way an edit ends. The first three are the doors a person uses on purpose. */
export type EditDoor =
  /** Cmd+Enter / Ctrl+Enter: the advertised gesture. */
  | 'cmd-enter'
  /** A press anywhere outside the line being edited (including the phone's Done control). */
  | 'click-outside'
  /** Esc. Replaces the old "drop out of writing" behaviour: it posts first. */
  | 'escape'
  /** The pointer rested on another line after typing paused (READING_MODE_POLICY.hoverEndsWriting). */
  | 'hover'
  /** The caret's line scrolled out of view (READING_MODE_POLICY.caretOutOfViewEndsWriting). */
  | 'scrolled-away'
  /** Focus left the text for something else on the page (a field, a dialog). */
  | 'blur';

export const EDIT_SESSION_POLICY = {
  /** Every door, in the order the module header lists them. */
  doors: ['cmd-enter', 'click-outside', 'escape', 'hover', 'scrolled-away', 'blur'] as readonly EditDoor[],
  /** The doors a person opens deliberately; the other three happen to them. All three post. */
  deliberateDoors: ['cmd-enter', 'click-outside', 'escape'] as readonly EditDoor[],
  /** The one door the product teaches (the status bar and the margin pencil name it). */
  advertisedDoor: 'cmd-enter' as EditDoor,
  /** Leaving an edit posts what was typed. There is no door that discards it. */
  leavingPosts: true,
  /** Nothing typed, nothing posted, nothing said. */
  silentWhenUnchanged: true,
  /** A posted proposal is removed by Undo and by nothing else. */
  undoIsTheOnlyRemoval: true,
  /**
   * ON since 2026-09-23 (Claude Opus 5, worker accord-yjs). In Suggesting mode — the mode a share
   * opens in — the typing is already a proposal and the leave posts it. In direct Editing mode the
   * typed words are the document's text, so converting them to a proposal means writing the
   * document twice on the way out: the original back in, then the proposal over it. This flag
   * turns those two writes on.
   *
   * They were gated off on 2026-09-22 because they were not safe. Measured on
   * scripts/caret-stability-check.mjs, which types into a line while a second person writes to the
   * same document: with them on, 2 runs in 5 failed with the paragraph written twice and one of
   * the typist's own edits coming back as a whole-document Yjs replace. It was not the size of the
   * write, not stale line data, not the suggestion mark and not dispatching inside the closing
   * event — each was tested and each failed the same way. The cause was one layer below all of
   * them, in the Yjs binding: a Yjs transaction created during another transaction's cleanup ends
   * OUTSIDE y-prosemirror's mutex, so the binding read the page's own write as a remote change and
   * replaced the whole document re-entrantly, from positions that had already moved.
   *
   * src/editor/local-write-resync.ts is that fix, and it holds the explanation.
   * scripts/local-write-resync-check.mjs is the regression check for the cause itself: it fails on
   * deploy/vps at 27bd48e with 8 local writes in 8 coming back as whole-document replaces, and
   * passes here, in all four style/device combinations.
   *
   * The gate written here was scripts/caret-stability-check.mjs green over FIVE CONSECUTIVE runs,
   * and that literal condition was NOT met on 2026-09-23: four runs of five were 48/48 and one was
   * 47/48. What failed is worth reading before anyone treats this flag as unproven. The failure is
   * caret-proof-suggesting-phone-390x844, it is scattered typing ("whilee others writ here"), and
   * it happened with NO proposal posted, in Suggesting mode — the mode where this flag changes
   * nothing, because the typing is already a proposal and the leave writes nothing. The same
   * failure reproduces on deploy/vps with this flag off and none of this fix present: measured
   * 2026-09-23 on that one configuration, base failed 1 run in 6 and this branch failed 0 in 6.
   * So it is an older caret defect that the gate's wording happens to depend on, not evidence
   * about the conversion. It is open, and it is the next thing to chase here.
   */
  convertDirectEditsToProposals: true,
  /** Exactly one Undo entry per posted proposal (src/shared/undo.ts). */
  undoEntriesPerPost: 1,
  /** How long "Proposed — Undo" stays in the status bar. Not a modal; it never takes focus. */
  noticeMs: 6000,
  /** A phone has no Cmd+Enter, so it shows a Done control while editing (it is 'click-outside'). */
  phoneDoneControl: true,
  /** The Done control's words on a phone. */
  phoneDoneLabel: 'Done',
} as const;

/** What was true when the edit began. `original` is the line's text before the person typed. */
export interface EditSession {
  lineIndex: number;
  original: string;
  /** performance.now() when the caret entered the line. */
  startedAt: number;
  /** The document was in Suggesting mode, so the typing already became suggestion marks. */
  suggesting: boolean;
}

/** A proposal to post: the line, the words it had, and the words the person typed. */
export interface EditProposal {
  lineIndex: number;
  /** The text the line had when the edit began; it stays readable under the proposal. */
  original: string;
  /** Exactly what the person left in the line. Never trimmed, never shortened. */
  proposed: string;
}

export type EditLeave =
  | {
    posted: false;
    /** The person changed nothing: leaving is silent (EDIT_SESSION_POLICY.silentWhenUnchanged). */
    reason: 'unchanged';
    door: EditDoor;
    session: EditSession;
  }
  | {
    posted: true;
    door: EditDoor;
    session: EditSession;
    proposal: EditProposal;
    /**
     * The typing was already tracked (Suggesting mode), so the proposal exists in the document
     * and the poster must not write a second one. The notice and the Undo entry still belong to
     * the leave, because that is when the person finished the change.
     */
    alreadyTracked: boolean;
    /** What the Undo entry says: "proposed a change to line 14". */
    undoDescription: string;
  };

/** Starts a session. `original` must be the line's text exactly as it stands. */
export function beginEditSession(input: { lineIndex: number; original: string; suggesting: boolean; now?: number }): EditSession {
  return {
    lineIndex: input.lineIndex,
    original: input.original,
    startedAt: input.now ?? 0,
    suggesting: input.suggesting,
  };
}

/**
 * Ends a session through one door. The whole rule is here, and it is the same for every door:
 * text that changed is posted, character for character; text that did not change is silent.
 */
export function endEditSession(session: EditSession, currentText: string, door: EditDoor): EditLeave {
  if (currentText === session.original) {
    return { posted: false, reason: 'unchanged', door, session };
  }
  return {
    posted: true,
    door,
    session,
    proposal: { lineIndex: session.lineIndex, original: session.original, proposed: currentText },
    alreadyTracked: session.suggesting,
    undoDescription: describeEditProposal(session.lineIndex),
  };
}

/** The status bar and the toolbar while an edit is open: "Editing line 14". */
export function editingStatusText(lineIndex: number): string {
  return `Editing line ${lineIndex + 1}`;
}

/** The word the status bar leads with when a proposal posts. */
export const POSTED_NOTICE_TEXT = 'Proposed';

/** The word it leads with when a direct edit ends and stays in the text as itself. */
export const KEPT_NOTICE_TEXT = 'Edited';

/**
 * What the status bar says when a direct edit ends while
 * EDIT_SESSION_POLICY.convertDirectEditsToProposals is off: the change is in the text, and it is
 * the text, not a proposal. Still true to the rule that matters most — nothing was discarded.
 */
export function keptNoticeText(lineIndex: number, phone: boolean): string {
  return phone
    ? `${KEPT_NOTICE_TEXT} line ${lineIndex + 1}`
    : `${KEPT_NOTICE_TEXT} line ${lineIndex + 1} — your change is in the text.`;
}

/**
 * What the status bar says when a proposal posts. The bar is one 28 px line and a phone's is
 * narrower still, so the phone gets the short form; the Undo affordance the product already has
 * (the toolbar's Undo) is what takes it back, on both.
 */
export function postedNoticeText(lineIndex: number, phone: boolean): string {
  return phone
    ? `${POSTED_NOTICE_TEXT} line ${lineIndex + 1}`
    : `${POSTED_NOTICE_TEXT} line ${lineIndex + 1} — Undo takes it back.`;
}

/** The Undo entry's description: "proposed a change to line 14". */
export function describeEditProposal(lineIndex: number): string {
  return `proposed a change to line ${lineIndex + 1}`;
}

/** The sentence that teaches the way out, shown on the editing state. */
export function editingHelpText(phone: boolean): string {
  return phone
    ? `Editing: everything you type stays. ${EDIT_SESSION_POLICY.phoneDoneLabel}, or a tap outside this line, posts it as a proposal.`
    : 'Editing: everything you type stays. Cmd+Enter, a click outside this line, or Esc posts it as a proposal others can see.';
}
