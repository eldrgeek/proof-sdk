/**
 * A click puts the caret in the DOM at once, but ProseMirror reads it only when the browser's
 * selectionchange event arrives, a task later. Two things can write ProseMirror's old selection
 * back into the DOM inside that window, and then the click is lost and typing lands where the
 * caret was before:
 *   - any update in between (a remote cursor, a decoration refresh), because a view update that
 *     redraws calls selectionToDOM with the state's selection;
 *   - ProseMirror's own focus handler, which 20 ms after the editor gains focus writes the state's
 *     selection back when the DOM selection differs from the last one it read.
 * Found 2026-09-24 in the Accord step 2 review: caret-stability-check typed into the title after
 * its click, once another reader's cursor moved at the moment of the click.
 * The fix: read the pending selection as soon as the click ends (a microtask after mouseup or
 * click), which is what the selectionchange event would do, only sooner.
 */
import type { EditorView } from '@milkdown/kit/prose/view';

interface DomObserverLike {
  flush(): void;
  currentSelection?: { eq(sel: unknown): boolean };
}

export function readPointerSelectionSoon(view: EditorView): void {
  queueMicrotask(() => {
    const observer = (view as unknown as { domObserver?: DomObserverLike }).domObserver;
    if (!observer?.flush || (view as unknown as { isDestroyed?: boolean }).isDestroyed || view.composing || !view.hasFocus()) return;
    try {
      const range = (view as unknown as { domSelectionRange?: () => unknown }).domSelectionRange?.();
      if (range && observer.currentSelection?.eq(range)) return;
      observer.flush();
    } catch (error) {
      console.warn('[caret] could not read the click selection', error);
    }
  });
}
