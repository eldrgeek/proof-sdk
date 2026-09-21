/**
 * Editing first (Mike, 2026-09-19): "When I tried to click before that line it started to make
 * changes but moved the view away from where I was typing."
 *
 * While the person is editing, nothing may move the view: the reading walk's scroll-driven
 * focus, stepping, barrier snaps and scroll-accepts, and any scrollIntoView from plugins reacting
 * to remote updates (agent cursors, marks) all stand down. "Editing" = the caret is in the
 * document and the last keystroke, input, or click-to-edit in it was less than
 * EDITING_GUARD_POLICY.graceMs ago.
 *
 * Authorship: Claude Opus 5 (worker proof-editfix), 2026-09-19, from Mike's report that morning.
 *
 * Writing mode (2026-09-21, src/shared/reading-keys.ts): "editing" now also needs the person to
 * be writing — the caret is in the text because they pressed the text (or Enter), not because a
 * dialog handed focus back. While the editor holds the keyboard without writing, the reading keys
 * are commands and every other text-changing key is swallowed: a key never both types and acts.
 */
import { READING_MODE_POLICY, routeKey, type KeyTarget } from '../shared/reading-keys';

export const EDITING_GUARD_POLICY = {
  /** How long after the last keystroke, input or click in the text the view stays put. */
  graceMs: 4000,
} as const;

let lastActivity = Number.NEGATIVE_INFINITY;
let installed = false;
const listeners = new Set<() => void>();
/** The person put the caret in the text (a press on it, typing, or Enter from reading). */
let writing = false;
/**
 * A press on the text is under way until its click (a touch focuses the text only after the
 * finger lifts): a focus arriving before then is that press. Code focusing the text later is not.
 */
let pressUntil = Number.NEGATIVE_INFINITY;
const modeListeners = new Set<(writing: boolean) => void>();
/** Key events the guard routed as reading commands (the reading walk runs them even though default is prevented). */
const readingOwned = new WeakSet<Event>();
/** Open things that Esc closes first: while one is open, Esc is theirs, not the end of writing. */
const ESCAPE_OWNERS = '.mark-popover:not([hidden]), .plm-menu, [role="dialog"]:not([hidden]):not(.prw-strip), [role="menu"]:not([hidden]), .proof-share-overflow-menu:not([hidden])';
function escapeOwnerOpen(): boolean {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(ESCAPE_OWNERS))) {
    if (el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden') return true;
  }
  return false;
}
/** Test hook: how each routed key went. */
const routeLog: Array<{ key: string; route: string; target: KeyTarget; writing: boolean }> = [];

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function editorHasFocus(): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement as HTMLElement | null;
  return Boolean(active?.isContentEditable && active.closest?.('.ProseMirror'));
}

function inEditor(target: EventTarget | null): boolean {
  const node = target as Element | null;
  if (!node || typeof (node as Element).closest !== 'function') {
    const parent = (target as Node | null)?.parentElement;
    return Boolean(parent?.closest?.('.ProseMirror'));
  }
  return Boolean(node.closest('.ProseMirror'));
}

/** Records editing activity now (keystroke, input, click-to-edit). Activity in the text is writing. */
export function noteEditingActivity(at = now()): void {
  lastActivity = at;
  setWriting(true);
  for (const listener of listeners) {
    try { listener(); } catch { /* a listener failing must not stop typing */ }
  }
}

/** True while the person is editing: they are writing and acted within the grace. */
export function isEditing(at = now()): boolean {
  return isWriting() && at - lastActivity < EDITING_GUARD_POLICY.graceMs;
}

/** True while the person is writing: the caret is in the text and they put it there. */
export function isWriting(): boolean {
  return writing && editorHasFocus();
}

function setWriting(next: boolean): void {
  if (writing === next) return;
  writing = next;
  applyModeClass();
  for (const listener of modeListeners) {
    try { listener(isWriting()); } catch { /* a listener failing must not stop typing */ }
  }
}

function applyModeClass(): void {
  if (typeof document === 'undefined' || !document.body?.classList) return;
  const on = isWriting();
  document.body.classList.toggle('pw-writing', on);
  document.body.classList.toggle('pw-reading', !on);
}

/** The person chose to write (Enter from reading, the mode chip): call after placing the caret. */
export function startWriting(): void {
  setWriting(true);
  applyModeClass();
}

/** Back to reading: the caret leaves the text (Esc, hover on another line, scrolled away). */
export function endWriting(): void {
  const wasWriting = writing;
  writing = false;
  if (typeof document !== 'undefined' && editorHasFocus()) (document.activeElement as HTMLElement | null)?.blur?.();
  applyModeClass();
  if (wasWriting) for (const listener of modeListeners) {
    try { listener(false); } catch { /* ignore */ }
  }
}

/** Called when writing starts or ends. */
export function onWritingChange(listener: (writing: boolean) => void): () => void {
  modeListeners.add(listener);
  return () => { modeListeners.delete(listener); };
}

/** A key the guard routed as a reading command: run it even though its default was prevented. */
export function isReadingOwned(event: Event): boolean {
  return readingOwned.has(event);
}

/** Where a key event is aimed (see KeyTarget). */
export function keyTargetOf(target: EventTarget | null): KeyTarget {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return 'other';
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return 'field';
  // A control inside the text (an ask's Yes button) is a control, not the text around it.
  if (!el.isContentEditable && el.closest('button, a[href], summary, [role="button"], [role="menuitem"], [role="option"], [role="tab"]')) return 'control';
  if (el.isContentEditable) return el.closest('.ProseMirror') ? 'editor' : 'field';
  return 'other';
}

/**
 * Is this press one that puts the caret in the text? Not a link (it opens), a widget the editor
 * does not own (fold chips, buttons, the margin), or a folded closed line (a click opens it).
 */
export function pressStartsWriting(target: EventTarget | null, altKey = false): boolean {
  if (!READING_MODE_POLICY.textPressStartsWriting) return false;
  const node = target as Element | null;
  const el = (node && typeof node.closest === 'function') ? node : (target as Node | null)?.parentElement ?? null;
  if (!el?.closest?.('.ProseMirror')) return false;
  if (el.closest('a[href]') && !altKey) return false;
  // Controls inside the text (fold chips, ask buttons, a folded closed line) act; suggested words shown as widgets are text.
  if (el.closest('button, input, select, textarea, .pclose-folded, [role="button"]')) return false;
  return true;
}

/** Test hook. */
export function editingGuardDebug(): { writing: boolean; editorFocused: boolean; routes: typeof routeLog; escapeOwners: string[] } {
  const escapeOwners = typeof document === 'undefined' ? [] : Array.from(document.querySelectorAll<HTMLElement>(ESCAPE_OWNERS))
    .filter(el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')
    .map(el => `${el.tagName.toLowerCase()}.${String(el.className).split(' ').join('.')}`);
  return { writing: isWriting(), editorFocused: editorHasFocus(), routes: routeLog.slice(-20), escapeOwners };
}

/** Milliseconds until the grace period ends (0 when not editing). */
export function editingRemainingMs(at = now()): number {
  return isEditing(at) ? Math.max(0, EDITING_GUARD_POLICY.graceMs - (at - lastActivity)) : 0;
}

/** Called on every editing activity (the reading walk moves its focus line to the caret). */
export function onEditingActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Installs document listeners once (idempotent). */
export function installEditingGuard(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  // 1. Route every key first (capture, before the editor and every other listener): a key is a
  //    reading command or it types, never both.
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    const target = keyTargetOf(event.target);
    const route = routeKey({
      key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey,
      isComposing: event.isComposing, target, writing: isWriting(),
    });
    routeLog.push({ key: event.key, route, target, writing: isWriting() });
    if (routeLog.length > 40) routeLog.shift();
    if (target !== 'editor') return;
    if (route === 'command') { readingOwned.add(event); event.preventDefault(); }
    else if (route === 'swallow') event.preventDefault();
  }, true);
  // Text arriving without a key (phone keyboards, paste, drop, dictation) while reading: stopped.
  document.addEventListener('beforeinput', (event) => {
    // Only the text itself: a field inside it (an ask's words, a reply box) always takes typing.
    if (keyTargetOf(event.target) !== 'editor' || isWriting()) return;
    if (!event.isTrusted) return;
    event.preventDefault();
  }, true);
  // 2. Writing starts with a press on the text; focus handed to the text by code is reading.
  document.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    if (pressStartsWriting(event.target, event.altKey)) {
      pressUntil = now() + READING_MODE_POLICY.pressFocusWindowMs;
      writing = true; // becomes visible once the caret is in the text (focusin / next frame)
      requestAnimationFrame(() => applyModeClass());
    } else if (!inEditor(event.target) && !(event.target as Element | null)?.closest?.('[data-keeps-writing]')) {
      // A press outside the text (rail, margin, bar): reading.
      if (writing) { writing = false; applyModeClass(); for (const l of modeListeners) { try { l(false); } catch { /* ignore */ } } }
    }
  }, true);
  document.addEventListener('focusin', (event) => {
    if (!inEditor(event.target)) { applyModeClass(); return; }
    if (now() < pressUntil) setWriting(true);
    applyModeClass();
  }, true);
  // Leaving the window (another app, another tab) keeps writing: the window's blur follows the
  // editor's focusout, so the check waits a turn.
  let windowBlurred = false;
  window.addEventListener('blur', () => { windowBlurred = true; });
  window.addEventListener('focus', () => { windowBlurred = false; });
  // The press ends with its click: after that, focus arriving in the text is code, not the person.
  document.addEventListener('click', () => { setTimeout(() => { pressUntil = Number.NEGATIVE_INFINITY; }, 0); }, true);
  document.addEventListener('focusout', (event) => {
    if (!inEditor(event.target)) return;
    // Wait for the focus to land; moving to anything else on the page is reading.
    setTimeout(() => {
      if (editorHasFocus()) return;
      if (windowBlurred) { applyModeClass(); return; }
      setWriting(false);
      applyModeClass();
    }, 0);
  }, true);
  // Esc returns to reading, unless it is closing something open over the text (a popover, a menu).
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !READING_MODE_POLICY.escapeEndsWriting || !isWriting()) return;
    if (escapeOwnerOpen()) return;
    endWriting();
  }, true);
  // 3. Editing activity (the view freeze and the caret anchor) counts only while writing.
  const onEvent = (event: Event): void => {
    if (!inEditor(event.target)) return;
    if (event.type === 'pointerdown') {
      if (!pressStartsWriting(event.target, (event as PointerEvent).altKey)) return;
      noteEditingActivity();
      return;
    }
    if (!isWriting()) return;
    if (event.type === 'keydown') {
      const key = (event as KeyboardEvent).key;
      // Modifier-only presses are not editing.
      if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') return;
    }
    noteEditingActivity();
  };
  for (const type of ['keydown', 'beforeinput', 'input', 'pointerdown', 'compositionstart', 'paste', 'cut', 'drop']) {
    document.addEventListener(type, onEvent, true);
  }
  applyModeClass();
}

/** Test hook. */
export function resetEditingGuardForTests(): void {
  lastActivity = Number.NEGATIVE_INFINITY;
  writing = false;
  pressUntil = Number.NEGATIVE_INFINITY;
}

