import * as Y from 'yjs';
import { defaultDeleteFilter, defaultProtectedNodes } from 'y-prosemirror';
import { changedRange, rangeMatches, snapshotText, type DecisionRange } from './review-decision-range';

/** One origin, one capture per decision. Native typing and remote edits are excluded. */
export class ReviewDecisionHistory {
  private readonly origin = {};
  private readonly manager: Y.UndoManager;
  private readonly rangeKey = Symbol('review decision text');
  constructor(readonly doc: Y.Doc) {
    this.manager = new Y.UndoManager([doc.getXmlFragment('prosemirror'), doc.getMap('marks')], {
      trackedOrigins: new Set([this.origin]), captureTimeout: 0,
      deleteFilter: item => defaultDeleteFilter(item, defaultProtectedNodes),
    });
  }
  decide(action: () => void): void {
    const fragment = this.doc.getXmlFragment('prosemirror');
    const before = snapshotText(fragment);
    this.manager.stopCapturing();
    const count = this.manager.undoStack.length;
    this.doc.transact(action, this.origin);
    this.manager.stopCapturing();
    if (this.manager.undoStack.length > count) {
      this.manager.undoStack[this.manager.undoStack.length - 1].meta.set(
        this.rangeKey, changedRange(before, snapshotText(fragment), fragment),
      );
    }
  }
  private restore(redo: boolean): boolean {
    const candidate = this.preview(redo);
    if (!candidate) return false;
    if (!rangeMatches(this.doc, candidate.meta.get(this.rangeKey) as DecisionRange | null)) {
      throw new Error(`Can't ${redo ? 'redo' : 'undo'}: someone has changed this text since.`);
    }
    const fragment = this.doc.getXmlFragment('prosemirror');
    const before = snapshotText(fragment);
    const item = redo ? this.manager.redo() : this.manager.undo();
    if (!item) return false;
    // Yjs may skip superseded map writes. Use the item it actually popped,
    // and put the inverse range on the newly created inverse stack item.
    const inverse = redo ? this.manager.undoStack : this.manager.redoStack;
    inverse[inverse.length - 1].meta.set(this.rangeKey, changedRange(before, snapshotText(fragment), fragment));
    return true;
  }
  /** Preview on an isolated copy: find the effective entry before touching live state.
   * Yjs owns the rules for skipping entries superseded by remote map writes.
   * The original stack items identify the result; only the copy's structs change.
   */
  private preview(redo: boolean) {
    const stack = redo ? this.manager.redoStack : this.manager.undoStack;
    if (!stack.length) return null;
    const copy = new Y.Doc({ gc: false });
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(this.doc));
    const manager = new Y.UndoManager([copy.getXmlFragment('prosemirror'), copy.getMap('marks')], {
      trackedOrigins: new Set(), captureTimeout: 0,
      deleteFilter: item => defaultDeleteFilter(item, defaultProtectedNodes),
    });
    manager.undoStack = [...this.manager.undoStack];
    manager.redoStack = [...this.manager.redoStack];
    try { return redo ? manager.redo() : manager.undo(); }
    finally { manager.destroy(); copy.destroy(); }
  }
  undo(): boolean { return this.restore(false); }
  redo(): boolean { return this.restore(true); }
  destroy(): void { this.manager.destroy(); }
}
