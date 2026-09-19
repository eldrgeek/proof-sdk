/**
 * Caret stability (Mike, 2026-09-19: "When I tried to click before that line it started to make
 * changes but moved the view away from where I was typing").
 *
 * While the person is editing (editing-guard.ts), a change they did not make must not move the line
 * they are typing in. Remote Yjs updates and our view-only decoration refreshes (asks, folds,
 * tiers, extras, line marks) can add or remove height ABOVE the caret, for example an ask that
 * appears on a visible line above. The browser's scroll anchoring does not help when the inserted
 * content is on screen (it anchors on the first visible element, which is above the insertion), and
 * iOS Safari has no scroll anchoring at all. So around every such transaction this measures the
 * caret's line on screen before and after, and scrolls by the difference.
 *
 * The person's own transactions (typing changes the document; a click or key sets the selection)
 * are never compensated: their own scrolling, Enter and caret moves behave as before.
 *
 * Authorship: Claude Opus 5 (worker proof-caret), 2026-09-19.
 */
import type { EditorView } from '@milkdown/kit/prose/view';
import type { Transaction } from '@milkdown/kit/prose/state';
import { ySyncPluginKey } from 'y-prosemirror';
import { isEditing } from './editing-guard';

export const CARET_ANCHOR_POLICY = {
  /** Keep the caret's line in place on screen when a change the person did not make shifts it. */
  enabled: true,
  /** Only while the person is editing (EDITING_GUARD_POLICY.graceMs); reading keeps its own rules. */
  onlyWhileEditing: true,
  /** Shifts smaller than this (px) are ignored (sub-pixel layout noise). */
  minShiftPx: 1,
} as const;

function isRemote(tr: Transaction): boolean {
  const meta = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
  return Boolean(meta?.isChangeOrigin);
}

/** A transaction the person did not make: a remote change, or a view-only refresh. */
export function isForeignTransaction(tr: Transaction): boolean {
  if (isRemote(tr)) return true;
  return !tr.docChanged && !tr.selectionSet;
}

/** Viewport top of the top-level block holding the caret, or null. */
function caretLineTop(view: EditorView): number | null {
  try {
    const { head } = view.state.selection;
    const $head = view.state.doc.resolve(head);
    const depth = Math.min(1, $head.depth);
    if (depth < 1) return null;
    const dom = view.nodeDOM($head.before(1));
    if (!(dom instanceof HTMLElement) || !dom.isConnected) return null;
    return dom.getBoundingClientRect().top;
  } catch {
    return null;
  }
}

/**
 * Wraps `dispatch` so a foreign transaction keeps the caret's line where it was on screen.
 * `dispatch` is the view's current dispatch (already intercepted by the editor).
 */
export function anchorCaretAround(view: EditorView, tr: Transaction, dispatch: (tr: Transaction) => void): void {
  if (!CARET_ANCHOR_POLICY.enabled || !isForeignTransaction(tr)
    || (CARET_ANCHOR_POLICY.onlyWhileEditing && !isEditing()) || typeof window === 'undefined') {
    dispatch(tr);
    return;
  }
  const before = caretLineTop(view);
  dispatch(tr);
  if (before === null) return;
  const after = caretLineTop(view);
  if (after === null) return;
  const shift = after - before;
  if (Math.abs(shift) >= CARET_ANCHOR_POLICY.minShiftPx) window.scrollBy(0, shift);
}
