import * as Y from 'yjs';
import { defaultDeleteFilter, defaultProtectedNodes, ySyncPluginKey } from 'y-prosemirror';
import { changedRange, rangeMatches, snapshotText, type DecisionRange } from './review-decision-range';

/** Yjs visits children first: a surviving child must keep every ancestor alive. */
function deleteEmptyContainer(item: Y.Item): boolean {
  return defaultDeleteFilter(item, defaultProtectedNodes)
    && !(item.content instanceof Y.ContentType
      && item.content.type instanceof Y.XmlElement && item.content.type.length > 0);
}

/** Review metadata extends the page's native history, including its selection hooks. */
export class ReviewDecisionHistory {
  private readonly origin = {};
  private readonly rangeKey = Symbol('review decision text');
  readonly manager: Y.UndoManager;
  private readonly ownsManager: boolean;
  private readonly previousDeleteFilter: Y.UndoManager['deleteFilter'];
  constructor(readonly doc: Y.Doc, manager?: Y.UndoManager) {
    this.ownsManager = !manager;
    this.manager = manager ?? new Y.UndoManager(doc.getXmlFragment('prosemirror'), {
      trackedOrigins: new Set([ySyncPluginKey]),
      deleteFilter: item => defaultDeleteFilter(item, defaultProtectedNodes),
      captureTransaction: tr => tr.meta.get('addToHistory') !== false,
    });
    this.previousDeleteFilter = this.manager.deleteFilter;
    this.manager.deleteFilter = item => this.previousDeleteFilter(item) && deleteEmptyContainer(item);
    this.manager.addToScope(doc.getMap('marks'));
    this.manager.addTrackedOrigin(this.origin);
  }
  /** Keep derived suggestion records in the same native typing transaction. */
  edit(action: () => void): void {
    this.doc.transact(action, ySyncPluginKey);
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
    const manager = this.manager;
    const candidate = this.preview(manager, redo);
    if (!candidate) return false;
    if (candidate.meta.has(this.rangeKey) && !rangeMatches(this.doc, candidate.meta.get(this.rangeKey) as DecisionRange | null)) {
      throw new Error(`Can't ${redo ? 'redo' : 'undo'}: someone has changed this text since.`);
    }
    const fragment = this.doc.getXmlFragment('prosemirror');
    const before = snapshotText(fragment);
    const item = redo ? manager.redo() : manager.undo();
    if (!item) return false;
    // Yjs may skip superseded map writes. Use the item it actually popped,
    // and put the inverse range on the newly created inverse stack item.
    const inverse = redo ? manager.undoStack : manager.redoStack;
    if (item.meta.has(this.rangeKey)) inverse[inverse.length - 1].meta.set(this.rangeKey, changedRange(before, snapshotText(fragment), fragment));
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
      deleteFilter: source.deleteFilter,
    });
    manager.undoStack = [...source.undoStack];
    manager.redoStack = [...source.redoStack];
    try { return redo ? manager.redo() : manager.undo(); }
    finally { manager.destroy(); copy.destroy(); }
  }
  undo(): boolean { return this.restore(false); }
  redo(): boolean { return this.restore(true); }
  destroy(): void {
    this.manager.deleteFilter = this.previousDeleteFilter;
    this.manager.removeTrackedOrigin(this.origin);
    if (this.ownsManager) this.manager.destroy();
  }
}
