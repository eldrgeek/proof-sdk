/**
 * Reading keys and writing mode (Mike, 2026-09-21: "Typing A to accept sometimes inserts an A in
 * the text.").
 *
 * The rule, as the person sees it:
 *   - Writing: you clicked (or tapped) the text, or pressed Enter on the focus line. The caret
 *     blinks and every key types. The rail head says "Writing · Esc to read".
 *   - Reading: everything else. The reading keys (A R Y N T D E J K 1-9, ↑ ↓) are commands and
 *     never type; other letters do nothing to the text. No caret blinks in the text.
 *   - You leave writing with Esc, by clicking anywhere outside the text (the rail, a margin dot, a
 *     button), by resting the pointer on another line once you have stopped typing
 *     (EDITING_GUARD_POLICY.graceMs), or by scrolling the caret's line out of view.
 *
 * Why a mode and not "is the caret in the text": the editor can hold the keyboard without the
 * person having put it there (a dialog or popover hands focus back to the text when it closes;
 * a click on a link used to place a caret). Before this, such a caret silently turned the next
 * A into a typed "A" while the rail showed a different focus line. Now focus the person did not
 * give to the text is reading, and a key is either a command or typing, never both.
 *
 * Pure: routeKey decides; src/editor/editing-guard.ts holds the state and applies it.
 * Authorship: Claude Opus 5 (worker proof-bugs6), 2026-09-21, from Mike's report that day.
 */

export const READING_MODE_POLICY = {
  /** A press on the text (not on a link, a widget or a folded line) starts writing. */
  textPressStartsWriting: true,
  /** Enter while reading puts the caret at the end of the focus line and starts writing. */
  enterStartsWriting: true,
  /** Esc while writing returns to reading (the caret leaves the text). */
  escapeEndsWriting: true,
  /**
   * Resting the pointer on another line, once typing has paused for the editing grace period,
   * returns to reading: the line under the pointer becomes the focus line the keys act on.
   */
  hoverEndsWriting: true,
  /** Scrolling the caret's line out of view returns to reading (you cannot type where you cannot see). */
  caretOutOfViewEndsWriting: true,
  /** At most this long after a press on the text (until its click), a focus arriving in the text is that press. */
  pressFocusWindowMs: 800,
  /** No caret blinks in the text while reading. */
  hideCaretWhileReading: true,
  /** The rail head shows "Reading" / "Writing · Esc to read". */
  showModeChip: true,
} as const;

/** The single-letter and digit keys that are commands while reading (lower case). */
export const READING_COMMAND_KEYS: ReadonlySet<string> = new Set([
  'a', 'r', 'y', 'n', 't', 'd', 'e', 'j', 'k',
  '1', '2', '3', '4', '5', '6', '7', '8', '9',
]);

/** Named keys that are commands while reading. */
export const READING_COMMAND_NAMED: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'Enter']);

/** Keys that change text when the editor holds the keyboard. */
const TEXT_CHANGING_NAMED: ReadonlySet<string> = new Set(['Backspace', 'Delete', 'Enter', 'Tab']);

export type KeyTarget =
  /** An input, textarea, select, or a contenteditable other than the document (chat, title). */
  | 'field'
  /** The document text (ProseMirror). */
  | 'editor'
  /** A button, link or other control that acts on Enter or Space itself. */
  | 'control'
  /** Anything else: the page body, a rail, the margin. */
  | 'other';

export interface KeyRouteInput {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  target: KeyTarget;
  /** The person is writing (see the module header). */
  writing: boolean;
}

/**
 * - `type`: the key goes to the text or field it is typed into; no command runs.
 * - `command`: a reading command; the key never reaches the text (preventDefault).
 * - `swallow`: the editor holds the keyboard but the person is reading: the key would change
 *   the text, so it is stopped and does nothing.
 * - `pass`: not ours (shortcuts, Esc, Tab between controls, arrows sideways, Enter on a button).
 */
export type KeyRoute = 'type' | 'command' | 'swallow' | 'pass';

export function isReadingCommandKey(key: string): boolean {
  return READING_COMMAND_KEYS.has(key.length === 1 ? key.toLowerCase() : key) || READING_COMMAND_NAMED.has(key);
}

/** Would this key change the text if the editor received it? */
export function isTextChangingKey(key: string): boolean {
  return key.length === 1 || TEXT_CHANGING_NAMED.has(key);
}

export function routeKey(input: KeyRouteInput): KeyRoute {
  const { key, target } = input;
  // Shortcuts (Cmd/Ctrl/Alt) and IME composition are never reading commands.
  if (input.ctrlKey || input.metaKey || input.isComposing || key === 'Process' || key === 'Unidentified') {
    return target === 'field' || (target === 'editor' && input.writing) ? 'type' : 'pass';
  }
  // Option/Alt+letter types a character on a Mac (Option+A is "å"): never a command, and never
  // typed into the text while reading.
  if (input.altKey) {
    if (target === 'field' || (target === 'editor' && input.writing)) return 'type';
    return target === 'editor' && isTextChangingKey(key) ? 'swallow' : 'pass';
  }
  if (target === 'field') return 'type';
  if (target === 'editor') {
    if (input.writing) return 'type';
    if (isReadingCommandKey(key)) return 'command';
    if (key === 'Tab') return 'pass'; // Tab moves between controls while reading
    if (isTextChangingKey(key)) return 'swallow';
    return 'pass';
  }
  if (target === 'control') {
    // Enter and Space belong to the control; letters are still reading commands.
    if (key === 'Enter' || key === ' ') return 'pass';
    return isReadingCommandKey(key) ? 'command' : 'pass';
  }
  return isReadingCommandKey(key) ? 'command' : 'pass';
}
