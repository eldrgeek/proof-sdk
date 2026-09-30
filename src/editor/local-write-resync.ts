/**
 * A local write to a line a remote writer is touching updates that line and nothing else.
 * Ported from b8a7c97 for draft submission: Mike, 2026-09-23 (usability brief).
 * This port does not enable direct-edit conversion.
 *
 * Mike's stage A measurement (2026-09-22) found that turning a direct edit into a proposal on the
 * way out — which writes the document twice — duplicated the paragraph about two runs in five
 * while a second person wrote to the same document, and that one of the typist's own edits came
 * back as a whole-document Yjs replace. It was not the size of the write, not stale line data, not
 * the suggestion mark and not dispatching inside the closing event; each was tested and each
 * failed the same way. This module is the cause, and it is one step below all of those.
 *
 * WHAT HAPPENS. y-prosemirror suppresses the echo of its own writes with a mutex: the binding
 * writes the ProseMirror document into Yjs inside `binding.mux(...)`, the Yjs transaction ends
 * inside that mutex, its observer fires inside that mutex, and the mutex makes the observer do
 * nothing. That holds only while the transaction ends where it began. It does not here:
 *
 *   1. A local write dispatches a ProseMirror transaction.
 *   2. Applying it runs the plugin views, and the marks-sync plugin view writes the marks map in
 *      a Yjs transaction of its own (src/bridge/collab-client.ts setMarksMetadata).
 *   3. A Yjs transaction created while an earlier one is being cleaned up does not run its own
 *      cleanup — Yjs appends it to the cleanup list the outer loop is already walking
 *      (`transact` only cleans up when its transaction is the first in `_transactionCleanups`).
 *   4. So the binding's fragment transaction is cleaned up by that outer loop, AFTER the mutex has
 *      been released. The observer runs unguarded, the binding reads its own write as a REMOTE
 *      change, and re-renders: `_typeChanged` replaces the WHOLE document from the Yjs fragment.
 *   5. That replace is dispatched re-entrantly, while ProseMirror is still applying the
 *      transaction that caused it. Its positions were taken from a document that has since moved,
 *      so it appends instead of replacing, and the paragraph is written twice.
 *
 * This is the client-side cousin of commit f7cac99's second cause, and the same shape as its
 * fix (src/editor/review-decision-history.ts withoutOwnEcho). withoutOwnEcho detaches the
 * observer around a write whose CALL STACK we control. That cannot cover this one: the nesting is
 * made by a Yjs cleanup loop, after every one of our stack frames has returned.
 *
 * WHAT THIS DOES. It makes the echo suppression follow the WRITE rather than the call stack. The
 * binding records every Yjs transaction its own `_prosemirrorChanged` wrote into, and refuses to
 * re-render the document from one of them — whenever the observer happens to run.
 *
 * The refusal is fail-safe, not merely authorised: it also requires that the document and the
 * fragment already agree, by the identity test the binding uses itself (y-prosemirror's
 * `mappedIdentity`: every top-level Yjs child maps to the live ProseMirror node at that index).
 * After `updateYFragment` has written the document into Yjs, that invariant holds by construction,
 * so the re-render is provably a no-op and skipping it can lose nothing. If it does not hold —
 * anything unexpected in the transaction — the render happens as before. A remote change never
 * satisfies either half: it is not our transaction, and its changed children no longer map to the
 * live document.
 *
 * Nothing machine-visible changes: no API path, field name, event, cookie or token. What changes
 * is that a redundant whole-document ProseMirror replace is no longer dispatched.
 *
 * Check: scripts/local-write-resync-check.mjs (fails on deploy/vps at 27bd48e: 8 of 8 local writes
 * to a contended line come back as whole-document replaces). Unit: src/tests/caret-stability.test.ts.
 *
 * Authorship: Mike Wolf (rulings), built by Claude Opus 5 (worker accord-yjs), 2026-09-23.
 */
import { ProsemirrorBinding, ySyncPluginKey } from 'y-prosemirror';

export const LOCAL_WRITE_POLICY = {
  /**
   * Whether the binding may re-render the whole document from a Yjs transaction that carries its
   * own write. It may not: the document already holds that change, so the re-render can only
   * repeat it. Off is the fix; on restores y-prosemirror's stock behaviour for a bisect.
   */
  resyncOnOwnWrite: false,
  /**
   * The refusal also requires the document and the fragment to agree, so it can only ever skip a
   * re-render that would change nothing. Turning this off would make the refusal trust
   * authorship alone; it is here to be read, not to be turned off.
   */
  requireAgreement: true,
} as const;

/** How many re-renders of the binding's own write were refused. Read by the checks. */
export const localWriteResyncStats = { refused: 0, rendered: 0 };

interface Binding {
  type: { toArray(): unknown[] };
  doc: { _transaction: unknown | null; transact(f: () => void, origin?: unknown): void };
  mapping: Map<unknown, unknown>;
  prosemirrorView: { state: { doc: { childCount: number; maybeChild(i: number): unknown } } } | null;
  __proofOwnTransactions?: WeakSet<object>;
}

type BindingPrototype = {
  _prosemirrorChanged?: (this: Binding, doc: unknown) => void;
  _typeChanged?: (this: Binding, events: unknown[], transaction: unknown) => void;
  __proofNoOwnWriteResync?: boolean;
};

function ownTransactions(binding: Binding): WeakSet<object> {
  return (binding.__proofOwnTransactions ??= new WeakSet<object>());
}

/**
 * y-prosemirror's own identity test, at the top level: after the binding has written the document
 * into Yjs, every top-level Yjs child is mapped to the live ProseMirror node at that index. When
 * that holds, the fragment and the document say the same thing.
 */
export function documentMatchesFragment(binding: Binding): boolean {
  const view = binding.prosemirrorView;
  if (!view) return false;
  const children = binding.type.toArray();
  if (children.length !== view.state.doc.childCount) return false;
  return children.every((child, index) => binding.mapping.get(child) === view.state.doc.maybeChild(index));
}

/** Installs the policy on y-prosemirror's binding class (idempotent; affects every binding). */
export function installLocalWriteResyncPolicy(): void {
  const proto = (ProsemirrorBinding as unknown as { prototype: BindingPrototype }).prototype;
  if (!proto || proto.__proofNoOwnWriteResync) return;
  const changed = proto._prosemirrorChanged;
  const typeChanged = proto._typeChanged;
  if (typeof changed !== 'function' || typeof typeChanged !== 'function') return;

  // Record the Yjs transaction each of our own fragment writes goes into. Opening a transaction
  // around the original call does not add one: Yjs joins an already-open transaction, and the
  // original's own `transact` then joins this one. Either way `doc._transaction` is the
  // transaction that will carry the write.
  //
  // The origin must be ySyncPluginKey, the one the original passes. When this wrapper is the call
  // that OPENS the transaction, its origin is the one the transaction keeps — Yjs ignores the
  // origin of a `transact` that joins an open one — and both undo managers track exactly that
  // origin (y-prosemirror's yUndoPlugin, and ReviewDecisionHistory's trackedOrigins). Opening it
  // with any other origin would leave the page's own typing out of its undo history.
  proto._prosemirrorChanged = function proofProsemirrorChanged(this: Binding, doc: unknown): void {
    this.doc.transact(() => {
      const transaction = this.doc._transaction;
      if (transaction && typeof transaction === 'object') ownTransactions(this).add(transaction as object);
      changed.call(this, doc);
    }, ySyncPluginKey);
  };

  proto._typeChanged = function proofTypeChanged(this: Binding, events: unknown[], transaction: unknown): void {
    const own = !!transaction && typeof transaction === 'object' && ownTransactions(this).has(transaction as object);
    if (!LOCAL_WRITE_POLICY.resyncOnOwnWrite && own
      && (!LOCAL_WRITE_POLICY.requireAgreement || documentMatchesFragment(this))) {
      localWriteResyncStats.refused += 1;
      return;
    }
    localWriteResyncStats.rendered += 1;
    typeChanged.call(this, events, transaction);
  };

  proto.__proofNoOwnWriteResync = true;
}
