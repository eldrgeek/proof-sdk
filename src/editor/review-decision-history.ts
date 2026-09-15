import * as Y from 'yjs';
import { defaultDeleteFilter, defaultProtectedNodes, ySyncPluginKey } from 'y-prosemirror';
import { changedRange, rangeMatches, snapshotText, type DecisionRange } from './review-decision-range';

/** Yjs visits children first: a surviving child must keep every ancestor alive. */
function deleteEmptyContainer(item: Y.Item): boolean {
  return defaultDeleteFilter(item, defaultProtectedNodes)
    && !(item.content instanceof Y.ContentType
      && item.content.type instanceof Y.XmlElement && item.content.type.length > 0);
}

type StackItem = Y.UndoManager['undoStack'][number];
type SuggestionRecords = Map<string, string | undefined>;

/** Review metadata extends the page's native history, including its selection hooks. */
export class ReviewDecisionHistory {
  private readonly origin = {};
  private readonly editOrigin = {};
  private readonly rangeKey = Symbol('review decision text');
  private readonly suggestionsKey = Symbol('tracked typing records');
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
    this.manager.addTrackedOrigin(this.editOrigin);
  }
  /** Keep derived suggestion records in the same native typing transaction. */
  edit(action: () => void): void {
    const marks = this.doc.getMap('marks');
    const before = marks.toJSON();
    const previous = this.manager.undoStack[this.manager.undoStack.length - 1];
    // A later local edit must not refresh an older entry's stale refusal guard.
    if (previous && !this.suggestionsMatch(previous)) this.manager.stopCapturing();
    this.doc.transact(tr => {
      action();
      // Derived metadata dispatches can set this flag to false inside the same
      // transaction. The caller already excluded loads and remote operations.
      tr.meta.set('addToHistory', true);
    }, this.editOrigin);
    const item = this.manager.undoStack[this.manager.undoStack.length - 1];
    if (!item) return;
    const expected: SuggestionRecords = item.meta.get(this.suggestionsKey) ?? new Map();
    const after = marks.toJSON();
    for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const value = after[id] ?? before[id];
      if (['insert', 'delete', 'replace'].includes(value?.kind)
        && JSON.stringify(before[id]) !== JSON.stringify(after[id])) {
        expected.set(id, JSON.stringify(after[id]));
      }
    }
    if (expected.size) item.meta.set(this.suggestionsKey, expected);
  }
  decide(action: () => void): void {
    const fragment = this.doc.getXmlFragment('prosemirror');
    const before = snapshotText(fragment);
    this.manager.stopCapturing();
    const count = this.manager.undoStack.length;
    this.doc.transact(tr => { action(); tr.meta.set('addToHistory', true); }, this.origin);
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
    // Also inspect entries Yjs would skip, before changing either live stack.
    const stack = redo ? manager.redoStack : manager.undoStack;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (!this.suggestionsMatch(stack[i])) {
        throw new Error(`Can't ${redo ? 'redo' : 'undo'}: someone has replied to this suggestion.`);
      }
      if (stack[i] === candidate) break;
    }
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
    const records = item.meta.get(this.suggestionsKey) as SuggestionRecords | undefined;
    if (records) inverse[inverse.length - 1].meta.set(this.suggestionsKey,
      new Map([...records.keys()].map(id => [id, JSON.stringify(this.doc.getMap('marks').get(id))])));
    return true;
  }
  private suggestionsMatch(item: StackItem): boolean {
    const expected = item.meta.get(this.suggestionsKey) as SuggestionRecords | undefined;
    return !expected || [...expected].every(([id, value]) => JSON.stringify(this.doc.getMap('marks').get(id)) === value);
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
    this.manager.removeTrackedOrigin(this.editOrigin);
    if (this.ownsManager) this.manager.destroy();
  }
}
