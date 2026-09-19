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
 */

export const EDITING_GUARD_POLICY = {
  /** How long after the last keystroke, input or click in the text the view stays put. */
  graceMs: 4000,
} as const;

let lastActivity = Number.NEGATIVE_INFINITY;
let installed = false;
const listeners = new Set<() => void>();

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

/** Records editing activity now (keystroke, input, click-to-edit). */
export function noteEditingActivity(at = now()): void {
  lastActivity = at;
  for (const listener of listeners) {
    try { listener(); } catch { /* a listener failing must not stop typing */ }
  }
}

/** True while the person is editing: the caret is in the text and they acted within the grace. */
export function isEditing(at = now()): boolean {
  return editorHasFocus() && at - lastActivity < EDITING_GUARD_POLICY.graceMs;
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
  const onEvent = (event: Event): void => {
    if (!inEditor(event.target)) return;
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
}

/** Test hook. */
export function resetEditingGuardForTests(): void {
  lastActivity = Number.NEGATIVE_INFINITY;
}

