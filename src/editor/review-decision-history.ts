import * as Y from 'yjs';
import { defaultDeleteFilter, defaultProtectedNodes } from 'y-prosemirror';
import { changedRange, rangeMatches, snapshotText, type DecisionRange } from './review-decision-range';

/** One origin, one capture per decision. Native typing and remote edits are excluded. */
export class ReviewDecisionHistory {
  private readonly origin = {};
  private readonly manager: Y.UndoManager;
  private readonly rangeKey = Symbol('review decision text');
  private readonly orderKey = Symbol('review operation order');
  private sequence = 0;
  private readonly editOrigin = {};
  private readonly edits: Y.UndoManager;
  private readonly stamp = ({ stackItem }: { stackItem: Y.UndoManager['undoStack'][number] }) => {
    stackItem.meta.set(this.orderKey, ++this.sequence);
  };
  constructor(readonly doc: Y.Doc) {
    this.manager = new Y.UndoManager([doc.getXmlFragment('prosemirror'), doc.getMap('marks')], {
      trackedOrigins: new Set([this.origin]), captureTimeout: 0,
      deleteFilter: item => defaultDeleteFilter(item, defaultProtectedNodes),
    });
    this.manager.on('stack-item-added', this.stamp);
    this.edits = new Y.UndoManager([doc.getXmlFragment('prosemirror'), doc.getMap('marks')], {
      trackedOrigins: new Set([this.editOrigin]), captureTimeout: 500,
      deleteFilter: item => defaultDeleteFilter(item, defaultProtectedNodes),
    });
    this.edits.on('stack-item-added', this.stamp);
    this.edits.on('stack-item-updated', this.stamp);
  }
  /** Ordinary edits have their own manager and capture window. They never enter
   * the decision stack, but both stacks share one chronological keyboard order. */
  edit(action: () => void): void {
    this.doc.transact(action, this.editOrigin);
    this.manager.clear(false, true);
  }
  decide(action: () => void): void {
    const fragment = this.doc.getXmlFragment('prosemirror');
    const before = snapshotText(fragment);
    this.edits.stopCapturing();
    this.manager.stopCapturing();
    const count = this.manager.undoStack.length;
    this.doc.transact(action, this.origin);
    this.manager.stopCapturing();
    if (this.manager.undoStack.length > count) {
      this.edits.clear(false, true);
      this.manager.undoStack[this.manager.undoStack.length - 1].meta.set(
        this.rangeKey, changedRange(before, snapshotText(fragment), fragment),
      );
    }
    this.edits.stopCapturing();
  }
  private restore(redo: boolean): boolean {
    const decision = this.preview(this.manager, redo);
    const edit = this.preview(this.edits, redo);
    const restoreEdit = edit && (!decision || edit.meta.get(this.orderKey) > decision.meta.get(this.orderKey));
    const manager = restoreEdit ? this.edits : this.manager;
    const candidate = restoreEdit ? edit : decision;
    if (!candidate) return false;
    if (!restoreEdit && !rangeMatches(this.doc, candidate.meta.get(this.rangeKey) as DecisionRange | null)) {
      throw new Error(`Can't ${redo ? 'redo' : 'undo'}: someone has changed this text since.`);
    }
    const fragment = this.doc.getXmlFragment('prosemirror');
    const before = snapshotText(fragment);
    this.edits.stopCapturing();
    const item = redo ? manager.redo() : manager.undo();
    if (!item) return false;
    // Yjs may skip superseded map writes. Use the item it actually popped,
    // and put the inverse range on the newly created inverse stack item.
    const inverse = redo ? manager.undoStack : manager.redoStack;
    if (!restoreEdit) inverse[inverse.length - 1].meta.set(this.rangeKey, changedRange(before, snapshotText(fragment), fragment));
    return true;
  }
  /** Preview on an isolated copy: find the effective entry before touching live state.
   * Yjs owns the rules for skipping entries superseded by remote map writes.
   * The original stack items identify the result; only the copy's structs change.
   */
  private preview(source: Y.UndoManager, redo: boolean) {
    const stack = redo ? source.redoStack : source.undoStack;
    if (!stack.length) return null;
    const copy = new Y.Doc({ gc: false });
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(this.doc));
    const manager = new Y.UndoManager([copy.getXmlFragment('prosemirror'), copy.getMap('marks')], {
      trackedOrigins: new Set(), captureTimeout: 0,
      deleteFilter: item => defaultDeleteFilter(item, defaultProtectedNodes),
    });
    manager.undoStack = [...source.undoStack];
    manager.redoStack = [...source.redoStack];
    try { return redo ? manager.redo() : manager.undo(); }
    finally { manager.destroy(); copy.destroy(); }
  }
  undo(): boolean { return this.restore(false); }
  redo(): boolean { return this.restore(true); }
  destroy(): void {
    this.manager.destroy(); this.edits.destroy();
  }
}
