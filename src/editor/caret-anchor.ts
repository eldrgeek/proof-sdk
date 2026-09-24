/**
 * Foreign transactions keep the selected passage (or the writing caret) at its screen position.
 * The person's own navigation and scrolling remain deliberate actions.
 * Mike, 2026-09-23 (usability brief).
 */
import type { EditorView } from '@milkdown/kit/prose/view';
import type { Transaction } from '@milkdown/kit/prose/state';
import { ySyncPluginKey } from 'y-prosemirror';
import { isWriting } from './editing-guard';

export const CARET_ANCHOR_POLICY = {
  /** Keep the caret's line in place on screen when a change the person did not make shifts it. */
  enabled: true,
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

/** The reading UI supplies its explicitly selected passage, independently of the caret. */
let readingAnchor: { position(): number | null; mapped(position: number): void } | null = null;
export function setReadingAnchor(anchor: typeof readingAnchor): void { readingAnchor = anchor; }

function lineTop(view: EditorView, pos: number): number | null {
  try {
    const $pos = view.state.doc.resolve(pos);
    const at = $pos.depth ? $pos.before(1) : pos;
    const dom = view.nodeDOM(at);
    return dom instanceof HTMLElement && dom.isConnected ? dom.getBoundingClientRect().top : null;
  } catch { return null; }
}

/**
 * Wraps `dispatch` so a foreign transaction keeps the caret's line where it was on screen.
 * `dispatch` is the view's current dispatch (already intercepted by the editor).
 */
export function anchorCaretAround(view: EditorView, tr: Transaction, dispatch: (tr: Transaction) => void): void {
  if (!CARET_ANCHOR_POLICY.enabled || !isForeignTransaction(tr)
    || typeof window === 'undefined') {
    dispatch(tr);
    return;
  }
  // Mike, 2026-09-23 (usability brief): also anchor reading after typing has paused.
  const writing = isWriting();
  const position = writing ? view.state.selection.head : readingAnchor?.position();
  const before = typeof position === 'number' ? lineTop(view, position) : null;
  const mapped = typeof position === 'number' ? tr.mapping.map(position, 1) : null;
  dispatch(tr);
  if (before === null) return;
  if (mapped === null) return;
  if (!writing) readingAnchor?.mapped(mapped);
  const after = lineTop(view, writing ? view.state.selection.head : mapped);
  if (after === null) return;
  const shift = after - before;
  if (Math.abs(shift) >= CARET_ANCHOR_POLICY.minShiftPx) window.scrollBy(0, shift);
}
