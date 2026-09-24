/**
 * Mike, 2026-09-24, Accord yfbqrau4: a caret in the text means Writing.
 * Letter keys belong to that text; Escape returns to the Review list.
 * Hover and scroll never move focus. Retained draft fields own their keys too.
 */
import { EDIT_SESSION_POLICY } from '../shared/edit-session';
import { routeKey, type KeyTarget } from '../shared/reading-keys';
export const EDITING_GUARD_POLICY = { graceMs: 4000 } as const;

const LETTER_SHORTCUTS_KEY = 'proof:letter-shortcuts';
export function letterShortcutsEnabled(): boolean {
  try { return localStorage.getItem(LETTER_SHORTCUTS_KEY) !== 'off'; } catch { return true; }
}
export function setLetterShortcutsEnabled(on: boolean): void {
  try { localStorage.setItem(LETTER_SHORTCUTS_KEY, on ? 'on' : 'off'); } catch { /* optional */ }
}
let composing = false;
export function isInputComposing(): boolean { return composing; }

let directEditing = false;
let installed = false;
let lastActivity = Number.NEGATIVE_INFINITY;
const listeners = new Set<() => void>();
const modeListeners = new Set<(writing: boolean) => void>();
const readingOwned = new WeakSet<Event>();
const routeLog: Array<{ key: string; route: string; target: KeyTarget; writing: boolean }> = [];
function now(): number { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }
function editorHasFocus(): boolean {
  return typeof document !== 'undefined' && Boolean((document.activeElement as HTMLElement | null)?.isContentEditable && (document.activeElement as HTMLElement)?.closest?.('.ProseMirror'));
}
function draftHasFocus(): boolean {
  return typeof document !== 'undefined' && Boolean((document.activeElement as HTMLElement | null)?.closest?.('.accord-draft textarea'));
}
export function isWriting(): boolean { return EDIT_SESSION_POLICY.caretDefinesWriting ? editorHasFocus() : directEditing; }
export function isEditing(at = now()): boolean {
  return draftHasFocus() || (isWriting() && editorHasFocus() && at - lastActivity < EDITING_GUARD_POLICY.graceMs);
}
export function noteEditingActivity(at = now()): void {
  if (!isWriting() && !draftHasFocus()) return;
  lastActivity = at;
  for (const listener of listeners) { try { listener(); } catch { /* keep typing */ } }
}
export function setDirectEditing(enabled: boolean): void {
  directEditing = enabled;
  if (typeof document !== 'undefined') {
    document.body?.classList?.toggle('pw-writing', enabled);
    document.body?.classList?.toggle('pw-reading', !enabled);
  }
  for (const listener of modeListeners) { try { listener(enabled); } catch { /* keep typing */ } }
}
export function onWritingChange(listener: (writing: boolean) => void): () => void {
  modeListeners.add(listener); return () => { modeListeners.delete(listener); };
}
export function onEditingActivity(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function editingRemainingMs(at = now()): number {
  return isEditing(at) ? Math.max(0, EDITING_GUARD_POLICY.graceMs - (at - lastActivity)) : 0;
}
export function isReadingOwned(event: Event): boolean { return readingOwned.has(event); }
export function keyTargetOf(target: EventTarget | null): KeyTarget {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return 'other';
  if (el.closest('.accord-draft') || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return 'field';
  if (!el.isContentEditable && el.closest('button, a[href], summary, [role="button"], [role="menuitem"], [role="option"], [role="tab"]')) return 'control';
  if (el.closest('.ProseMirror')) return 'editor';
  if (el.isContentEditable) return 'field';
  return 'other';
}
export function editingGuardDebug() {
  return { writing: isWriting(), editorFocused: editorHasFocus(), routes: routeLog.slice(-20) };
}
export function installEditingGuard(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('compositionstart', () => { composing = true; }, true);
  document.addEventListener('compositionend', () => { composing = false; }, true);
  const refreshMode = () => setDirectEditing(editorHasFocus());
  if (EDIT_SESSION_POLICY.caretDefinesWriting) {
    document.addEventListener('focusin', refreshMode, true);
    document.addEventListener('focusout', () => queueMicrotask(refreshMode), true);
  }
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    const target = keyTargetOf(event.target);
    if (target === 'editor' && event.key === 'Escape' && !event.isComposing && EDIT_SESSION_POLICY.escapeReturnsToReview) {
      event.preventDefault(); event.stopPropagation();
      (document.activeElement as HTMLElement | null)?.blur();
      const list = document.querySelector<HTMLElement>('.anv-issues');
      list?.focus({ preventScroll: true });
      refreshMode();
      return;
    }
    const route = routeKey({
      key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey,
      isComposing: composing || event.isComposing || event.keyCode === 229,
      target, writing: isWriting(), letterShortcuts: letterShortcutsEnabled(),
    });
    routeLog.push({ key: event.key, route, target, writing: directEditing });
    if (routeLog.length > 40) routeLog.shift();
    if (target === 'editor') {
      if (route === 'command') { readingOwned.add(event); event.preventDefault(); }
      else if (route === 'swallow') event.preventDefault();
    }
  }, true);
  // Also stop paste, drop, phone input and dictation in the review document.
  for (const type of ['beforeinput', 'paste', 'cut', 'drop']) document.addEventListener(type, event => {
    if (keyTargetOf(event.target) === 'editor' && !isWriting()) event.preventDefault();
  }, true);
  for (const type of ['keydown', 'beforeinput', 'input', 'pointerdown', 'compositionstart']) document.addEventListener(type, event => {
    if (keyTargetOf(event.target) === 'editor' || draftHasFocus()) noteEditingActivity();
  }, true);
  setDirectEditing(directEditing);
}
export function resetEditingGuardForTests(): void {
  directEditing = false;
  composing = false;
  lastActivity = Number.NEGATIVE_INFINITY;
  routeLog.length = 0;
}
