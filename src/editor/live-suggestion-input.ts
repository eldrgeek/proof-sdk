/** Editable replacement words without changing the stored original/content representation.
 * Mike, 2026-09-24, yfbqrau4 P2/P3. Each input publishes synchronously; no draft is saved.
 */
import type { EditorView } from '@milkdown/kit/prose/view';
import type { StoredMark } from '../formats/marks';
import { EDIT_SESSION_POLICY } from '../shared/edit-session';

export const liveSuggestionInputEvent = 'proof:live-suggestion-input';
export interface LiveSuggestionInput {
  id: string;
  before: string;
  content: string;
  handled: boolean;
  nextId?: string;
}
function offsetIn(span: HTMLElement): number | null {
  const selection = window.getSelection();
  if (!selection?.focusNode || !span.contains(selection.focusNode)) return null;
  const range = document.createRange(); range.selectNodeContents(span);
  range.setEnd(selection.focusNode, selection.focusOffset);
  return range.toString().length;
}
export function focusLiveSuggestion(view: EditorView, id: string, offset?: number): void {
  const span = [...view.dom.querySelectorAll<HTMLElement>('[data-live-suggestion]')].find(el => el.dataset.markId === id);
  if (!span || !view.editable) { view.focus(); return; }
  span.focus({ preventScroll: true });
  const range = document.createRange(); range.selectNodeContents(span);
  if (span.firstChild?.nodeType === Node.TEXT_NODE) range.setStart(span.firstChild, Math.min(offset ?? span.textContent!.length, span.firstChild.textContent!.length));
  range.collapse(offset !== undefined ? true : false);
  const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
}
export function makeLiveSuggestionInput(span: HTMLElement, view: EditorView, id: string, content: string): void {
  if (!EDIT_SESSION_POLICY.liveProposals) return;
  span.dataset.liveSuggestion = '';
  span.dataset.liveContent = content;
  span.contentEditable = String(view.editable);
  span.setAttribute('role', 'textbox');
  span.setAttribute('aria-label', 'Proposed words');
  span.tabIndex = 0;
  span.style.whiteSpace = 'pre-wrap';
  // This nested editing surface is owned by the replacement's metadata. ProseMirror
  // must never parse the browser's temporary DOM text into the original document.
  span.addEventListener('input', event => {
    const before = span.dataset.liveContent ?? '';
    const content = span.textContent ?? '';
    if (content === before) return;
    const offset = offsetIn(span) ?? content.length;
    const detail: LiveSuggestionInput = { id, before, content, handled: false };
    span.dispatchEvent(new CustomEvent(liveSuggestionInputEvent, { bubbles: true, detail }));
    if (!detail.handled) span.textContent = before;
    else if (detail.nextId) {
      // A competing proposal keeps the first author's words; continue in the new one.
      span.textContent = before;
      focusLiveSuggestion(view, detail.nextId, offset);
    } else {
      span.dataset.liveContent = content;
      // Publishing can redraw the widget (the proposal's record is stamped on the text), which
      // replaces this span. Keep typing in the proposal: focus the span now drawn for this id.
      if (!span.isConnected || !(event as InputEvent).isComposing) focusLiveSuggestion(view, id, offset);
    }
  });
  const insertPlainText = (text: string) => {
    const selection = window.getSelection();
    if (!view.editable || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!span.contains(range.startContainer) || !span.contains(range.endContainer)) return;
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node); range.setStartAfter(node); range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range);
    span.dispatchEvent(new Event('input', { bubbles: true }));
  };
  span.addEventListener('keydown', event => {
    // Select All inside the proposal's words selects those words. Chromium otherwise selects
    // the whole outer document, because this box sits in a non-editable island inside it.
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'a') {
      event.preventDefault(); event.stopPropagation();
      const range = document.createRange(); range.selectNodeContents(span);
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      return;
    }
    // Keep history and Escape available to the document's capture listeners.
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); insertPlainText('\n'); }
    event.stopPropagation();
  });
  span.addEventListener('paste', event => {
    event.preventDefault();
    insertPlainText(event.clipboardData?.getData('text/plain') ?? '');
  });
  span.addEventListener('drop', event => event.preventDefault());
  // Focus that arrives without a caret inside (Tab, or focus() from code) would leave the
  // browser's selection in the outer document, where ProseMirror keeps it. Put the caret in
  // the proposal's words, as typing does.
  span.addEventListener('focus', () => {
    const selection = window.getSelection();
    if (selection?.focusNode && span.contains(selection.focusNode)) return;
    focusLiveSuggestion(view, id);
  });
}
export function syncLiveSuggestionInputs(view: EditorView, metadata: Record<string, StoredMark>): void {
  if (!EDIT_SESSION_POLICY.liveProposals || !view.dom?.querySelectorAll) return;
  for (const span of view.dom.querySelectorAll<HTMLElement>('[data-live-suggestion]')) {
    span.contentEditable = String(view.editable);
    const mark = metadata[span.dataset.markId ?? ''];
    if (!mark || mark.status === 'accepted' || mark.status === 'rejected') continue;
    const content = mark.content ?? '';
    if (span.dataset.liveContent === content) continue;
    const offset = offsetIn(span);
    span.dataset.liveContent = content;
    if (span.textContent !== content) {
      span.textContent = content;
      if (offset !== null) focusLiveSuggestion(view, span.dataset.markId!, offset);
    }
  }
}
