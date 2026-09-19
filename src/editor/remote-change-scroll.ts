/**
 * Caret stability (Mike, 2026-09-19: "it started to make changes but moved the view away from
 * where I was typing"). y-prosemirror scrolls the local caret into view on EVERY remote Yjs change
 * while the caret is on screen (ProsemirrorBinding._typeChanged calls tr.scrollIntoView() when
 * _isLocalCursorInView() is true). A remote change is never the person's act, so it must not move
 * the view: only their own typing, clicks and keys may scroll. `_isLocalCursorInView` has no other
 * caller, so answering false turns off exactly that scroll and nothing else.
 *
 * Authorship: Claude Opus 5 (worker proof-caret), 2026-09-19.
 */
import { ProsemirrorBinding } from 'y-prosemirror';

export const REMOTE_CHANGE_POLICY = {
  /** Whether a remote (other client's or server's) change may scroll the local caret into view. */
  scrollToCaret: false,
} as const;

type BindingPrototype = { _isLocalCursorInView?: (this: unknown) => boolean; __proofNoRemoteScroll?: boolean };

/** Installs the policy on y-prosemirror's binding class (idempotent; affects every binding). */
export function installRemoteChangeScrollPolicy(): void {
  const proto = (ProsemirrorBinding as unknown as { prototype: BindingPrototype }).prototype;
  if (!proto || proto.__proofNoRemoteScroll || typeof proto._isLocalCursorInView !== 'function') return;
  const original = proto._isLocalCursorInView;
  proto._isLocalCursorInView = function isLocalCursorInView(this: unknown): boolean {
    return REMOTE_CHANGE_POLICY.scrollToCaret ? original.call(this) : false;
  };
  proto.__proofNoRemoteScroll = true;
}
