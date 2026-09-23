/**
 * Accord round 2, stage A — the document side of the one rule: leaving an edit posts it.
 *
 * src/editor/editing-guard.ts holds the session and routes the doors. This module is the host it
 * calls: it reads the edited line out of the document, and when the person leaves it turns what
 * they typed into an ordinary open suggestion (src/editor/plugins/marks.ts suggestReplace), with
 * the original text still readable underneath. One Undo entry per posted proposal, and Undo is the
 * only way to remove one.
 *
 * Two cases, one rule:
 *   - Suggesting mode: the typing already became suggestion marks, so nothing is written here. The
 *     leave still records the Undo entry and tells the person, because that is when they finished.
 *   - Editing mode (direct): the typed words are in the document. The leave puts the line back to
 *     the words it had and posts the typed words as a proposal, so a change nobody has seen yet
 *     cannot stand as the document's text. The typed characters are never lost: they are the
 *     proposal, and Undo brings the whole thing back.
 *
 * Authorship: Mike Wolf (rulings), built by Claude Opus 5 (worker accord-edit), 2026-09-22.
 */
import type { EditorView } from '@milkdown/kit/prose/view';
import { setEditSessionHost, type EditSessionHost } from '../editor/editing-guard';
import { describeEditProposal, type EditLeave, type EditSession } from '../shared/edit-session';
import { extractLines, type DocLine, type LineSourceNode } from '../shared/line-marks';
import type { UndoOutcome, UndoStack } from '../shared/undo';

export interface EditGestureHost {
  view(): EditorView | null;
  /** Suggesting (true) or Editing (false). */
  isSuggesting(): boolean;
  /** The actor string the person's marks are written with. */
  actor(): string;
  /** Meta key that tells the suggestions plugin "this is a direct edit, not a suggestion". */
  directEditMeta(): string;
  /** Posts a replace suggestion; returns its mark id, or null when the document refused it. */
  suggestReplace(view: EditorView, quote: string, by: string, content: string, range: { from: number; to: number }): string | null;
  /** Open suggestion marks by this person that sit on a line. */
  myPendingOnLine(lineIndex: number): string[];
  /** Accepts or rejects suggestion marks (the editor's ordinary review route). */
  decide(ids: string[], action: 'accept' | 'reject'): void;
  /** The one Undo (src/shared/undo.ts). */
  undoStack(): UndoStack | null;
  /** Tells the person a proposal posted on this line. Not a modal; it never takes focus. */
  proposed(lineIndex: number): void;
  /** Tells the person something else, in the same place. */
  notice(text: string): void;
}

/**
 * The smallest text replacement that turns `before` into `after`: their common prefix and suffix
 * are left alone. Null when they are already the same. Offsets are relative to `before`.
 */
export function smallestEdit(before: string, after: string): { from: number; to: number; text: string } | null {
  if (before === after) return null;
  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before[start] === after[start]) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  return { from: start, to: endBefore, text: after.slice(start, endAfter) };
}

export class EditGestureUI {
  private started = false;
  /** The document's line count when the open session began (a split or a merge changes it). */
  private lineCountAtStart = 0;
  /** The top-level block the open session's line sits in, for the cheap "still here?" question. */
  private blockAtStart = -1;
  /** Test hook: every proposal this page posted, newest last. */
  readonly posted: Array<{ line: number; door: string; original: string; proposed: string; markId: string | null; tracked: boolean }> = [];

  constructor(private readonly host: EditGestureHost) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    setEditSessionHost(this.asSessionHost());
  }

  stop(): void {
    this.started = false;
    setEditSessionHost(null);
  }

  private asSessionHost(): EditSessionHost {
    return {
      caretStillInSession: () => this.caretStillInSession(),
      caretLine: () => this.caretLine(),
      currentText: session => this.currentText(session),
      isSuggesting: () => this.host.isSuggesting(),
      post: leave => this.post(leave),
    };
  }

  /**
   * The document's lines as they stand RIGHT NOW. The margin's cached list (LineMarksUI.lineList)
   * lags a keystroke, and one stale `nodeSize` made the leave replace the wrong range: the original
   * was inserted instead of put back, so the line read twice. scripts/caret-stability-check.mjs
   * caught it (2026-09-22). The text and the range must come from ONE read of the live document,
   * or they can disagree.
   */
  private liveLines(view: EditorView): DocLine[] {
    return extractLines(view.state.doc as unknown as LineSourceNode);
  }

  /**
   * The caret's top-level block, in O(1). A session that began in this block is still the one the
   * person is in, so nothing has to be re-read.
   */
  private caretBlock(): number {
    const view = this.host.view();
    if (!view) return -1;
    try { return view.state.selection.$head.index(0); } catch { return -1; }
  }

  private caretStillInSession(): boolean {
    return this.blockAtStart >= 0 && this.caretBlock() === this.blockAtStart;
  }

  /** The line the caret sits in, and its exact text. */
  private caretLine(): { index: number; text: string } | null {
    const view = this.host.view();
    if (!view) return null;
    const lines = this.liveLines(view);
    if (lines.length === 0) return null;
    const head = view.state.selection.head;
    let found: DocLine | null = null;
    for (const line of lines) {
      if (head >= line.pos && head <= line.pos + line.nodeSize) found = line;
      else if (found) break;
    }
    if (!found) return null;
    this.lineCountAtStart = lines.length;
    this.blockAtStart = this.caretBlock();
    return { index: found.index, text: found.text };
  }

  /**
   * The text now standing where the session's line began. Pressing Enter splits one line into
   * two, so the span grows: everything the person typed in that span is the proposal, which is
   * why a split can never lose the half below the caret.
   */
  private currentText(session: EditSession): string | null {
    const view = this.host.view();
    if (!view) return null;
    return this.span(view, session.lineIndex)?.text ?? null;
  }

  /**
   * The span the session's line now occupies: its text and its ProseMirror range, read together
   * from the live document. Pressing Enter splits one line into two, so the span grows; everything
   * typed in it is the proposal, which is why a split can never lose the half below the caret.
   */
  private span(view: EditorView, lineIndex: number): { text: string; from: number; to: number } | null {
    const lines = this.liveLines(view);
    if (lineIndex >= lines.length) return null;
    const grew = Math.max(0, lines.length - this.lineCountAtStart);
    const lastIndex = Math.min(lines.length - 1, lineIndex + grew);
    const first = lines[lineIndex];
    const last = lines[lastIndex];
    const from = first.pos + 1;
    const to = last.pos + last.nodeSize - 1;
    if (to <= from || to > view.state.doc.content.size) return null;
    const text = lines.slice(lineIndex, lastIndex + 1).map(line => line.text).join('\n');
    return { text, from, to };
  }

  /** The one rule, applied. */
  private post(leave: EditLeave): void {
    this.blockAtStart = -1;
    if (!leave.posted) return;
    const { lineIndex, original, proposed } = leave.proposal;
    if (leave.alreadyTracked) {
      // Suggesting mode already wrote the proposal. Record the Undo entry and say so.
      const ids = this.host.myPendingOnLine(lineIndex);
      this.record({ line: lineIndex, door: leave.door, original, proposed, markId: ids[0] ?? null, tracked: true });
      if (ids.length) this.pushUndo(lineIndex, ids);
      this.host.proposed(lineIndex);
      return;
    }
    const view = this.host.view();
    const range = view ? this.span(view, lineIndex) : null;
    if (!view || !range) {
      // The line is gone from under us. Say so rather than pretending the change posted; the
      // typed words are still in the document, because nothing was reverted.
      this.record({ line: lineIndex, door: leave.door, original, proposed, markId: null, tracked: false });
      this.host.notice('Your change stayed in the text: the line moved before it could be posted as a proposal.');
      return;
    }
    // 1. Put the line back to the words it had, changing only the characters that differ.
    //    Replacing a whole block comes back through Yjs as a whole-document replace, which is the
    //    caret-jump scripts/caret-stability-check.mjs guards against; the smallest edit avoids it.
    //    A direct edit, so it never becomes a suggestion of its own (the plugin reads this meta).
    const back = smallestEdit(range.text, original);
    if (back) {
      const tr = view.state.tr.insertText(back.text, range.from + back.from, range.from + back.to);
      tr.setMeta(this.host.directEditMeta(), { editLeave: true });
      view.dispatch(tr);
    }
    // 2. Post what the person typed as an ordinary open suggestion over those words.
    const markId = this.host.suggestReplace(view, original, this.host.actor(), proposed, { from: range.from, to: range.from + original.length });
    this.record({ line: lineIndex, door: leave.door, original, proposed, markId, tracked: false });
    if (!markId) {
      // The document refused the replace (a table cell boundary, an unresolvable quote). Put the
      // typed words back rather than dropping them: never lose text.
      const restore = view.state.tr.insertText(proposed, range.from, range.from + original.length);
      restore.setMeta(this.host.directEditMeta(), { editLeave: true });
      view.dispatch(restore);
      this.host.notice('Your change stayed in the text: it could not be posted as a proposal here.');
      return;
    }
    this.pushUndo(lineIndex, [markId]);
    this.host.proposed(lineIndex);
  }

  /** One Undo entry per posted proposal: undoing it rejects the proposal and nothing else. */
  private pushUndo(lineIndex: number, ids: string[]): void {
    const stack = this.host.undoStack();
    if (!stack) return;
    stack.pushSimple('suggestion', describeEditProposal(lineIndex), (): UndoOutcome => {
      try {
        this.host.decide(ids, 'reject');
        return { ok: true, description: describeEditProposal(lineIndex) };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : 'Could not take that proposal back.' };
      }
    });
  }

  private record(entry: EditGestureUI['posted'][number]): void {
    this.posted.push(entry);
    if (this.posted.length > 20) this.posted.shift();
  }

  /** Test hook. */
  debugState(): Record<string, unknown> {
    return { started: this.started, posted: [...this.posted], lineCountAtStart: this.lineCountAtStart, blockAtStart: this.blockAtStart };
  }
}
