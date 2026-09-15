import * as Y from 'yjs';

/** One origin, one capture per decision. Native typing and remote edits are excluded.
 * Both the rich text and mark records belong to the same atomic Yjs transaction.
 */
export class ReviewDecisionHistory {
  private readonly origin = {};
  private readonly manager: Y.UndoManager;
  private actions: Array<() => void> = [];
  private undone: Array<() => void> = [];
  constructor(readonly doc: Y.Doc) {
    this.manager = new Y.UndoManager([doc.getXmlFragment('prosemirror'), doc.getMap('marks')], {
      trackedOrigins: new Set([this.origin]), captureTimeout: 0,
    });
  }
  decide(action: () => void): void {
    this.manager.stopCapturing();
    const count = this.manager.undoStack.length;
    this.doc.transact(action, this.origin);
    this.manager.stopCapturing();
    if (this.manager.undoStack.length > count) {
      this.actions.push(action);
      this.undone = [];
    }
  }
  undo(): boolean {
    if (!this.actions.length || this.manager.undo() === null) return false;
    this.undone.push(this.actions.pop()!);
    return true;
  }
  redo(): boolean {
    const action = this.undone.pop();
    if (!action) return false;
    const remaining = [...this.undone];
    // Authoritative hydration may restamp restored suggestion anchors. Reapply
    // the decision to today's anchors instead of replaying obsolete Yjs items.
    this.decide(action);
    this.undone = remaining;
    return true;
  }
  destroy(): void { this.manager.destroy(); }
}
