import { historyCandidate } from './review-history-candidate';
import * as Y from 'yjs';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { EditorState } from '@milkdown/kit/prose/state';
import { defaultDeleteFilter, defaultProtectedNodes, ySyncPluginKey, getRelativeSelection, absolutePositionToRelativePosition } from 'y-prosemirror';
import { changedRange, rangeBetween, rangeMatches, snapshotText, reviewRangeState, type DecisionRange } from './review-decision-range';

/** Where each mark sits in the editor, by id (ProseMirror positions). */
export type MarkRanges = (state: EditorState) => Array<{ id: string; range?: { from: number; to: number } }>;

/** Yjs visits children first: a surviving child must keep every ancestor alive. */
function deleteEmptyContainer(item: Y.Item): boolean {
  return defaultDeleteFilter(item, defaultProtectedNodes)
    && !(item.content instanceof Y.ContentType
      && item.content.type instanceof Y.XmlElement && item.content.type.length > 0);
}

/** PM retains plugin state across cursor-plugin installation, but destroys and
 * recreates plugin views. yUndoPlugin has already replaced its selection hooks;
 * reconnect the retained manager's subscriptions (Yjs listeners are sets). */
export function reconnectNativeUndoManager(manager: Y.UndoManager): void {
  manager.addTrackedOrigin(manager);
  manager.doc.on('afterTransaction', manager.afterTransactionHandler);
  manager.doc.on('destroy', manager.destroy);
}

type StackItem = Y.UndoManager['undoStack'][number];
type SuggestionRecords = Map<string, { value: string | undefined; version: number }>;

/** Review metadata extends the page's native history, including its selection hooks. */
export class ReviewDecisionHistory {
  private destroyed = false;
  private readonly origin = {};
  private readonly editOrigin = {};
  private readonly rangeKey = Symbol('review decision text');
  private readonly suggestionsKey = Symbol('tracked typing records');
  private readonly rangeChangesKey = Symbol('review ranges before remote transaction');
  private readonly rangeInvalidatedKey = Symbol('collaborator changed a mark in this range');
  private readonly beforeTransaction = (transaction: Y.Transaction): void => {
    if (transaction.local) return;
    const entries = [...this.manager.undoStack, ...this.manager.redoStack]
      .filter(item => item.meta.get(this.rangeKey) && !item.meta.get(this.rangeInvalidatedKey));
    if (!entries.length) return;
    const snapshot = snapshotText(this.doc.getXmlFragment('prosemirror'));
    transaction.meta.set(this.rangeChangesKey, new Map(entries.map(item => [item,
      reviewRangeState(this.doc, item.meta.get(this.rangeKey), snapshot),
    ])));
  };
  private readonly afterTransaction = (transaction: Y.Transaction): void => {
    const before = transaction.meta.get(this.rangeChangesKey) as Map<StackItem, ReturnType<typeof reviewRangeState>> | undefined;
    if (transaction.local || !before) return;
    const snapshot = snapshotText(this.doc.getXmlFragment('prosemirror'));
    const changed = transaction.changed.get(this.doc.getMap('marks'));
    for (const [item, previous] of before) {
      const current = reviewRangeState(this.doc, item.meta.get(this.rangeKey), snapshot);
      if (current.signature !== previous.signature
        || [...(changed ?? [])].some(id => id !== null && (previous.ids.has(id) || current.ids.has(id))
          && previous.records.get(id) !== current.records.get(id))) {
        item.meta.set(this.rangeInvalidatedKey, true);
      }
    }
  };
  private readonly afterSelectionKey = Symbol('native selection after operation');
  private readonly markVersions = new Map<string, number>();
  private readonly externalMarkVersions = new Map<string, number>();
  private readonly marksChanged = (event: Y.YMapEvent<unknown>, transaction: Y.Transaction): void => {
    const external = !transaction.local;
    for (const id of event.keysChanged) {
      this.markVersions.set(id, (this.markVersions.get(id) ?? 0) + 1);
      // Origin labels describe workflows, not which client wrote the record.
      if (external) this.externalMarkVersions.set(id, (this.externalMarkVersions.get(id) ?? 0) + 1);
      else if (!this.manager.undoing && !this.manager.redoing) this.includeOwnProjection(id);
    }
  };
  private readonly documentDestroyed = (): void => this.destroy();
  readonly manager: Y.UndoManager;
  private readonly ownsManager: boolean;
  private readonly previousDeleteFilter: Y.UndoManager['deleteFilter'];
  constructor(readonly doc: Y.Doc, manager?: Y.UndoManager, private readonly view?: EditorView, private readonly markRanges?: MarkRanges) {
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
    doc.getMap('marks').observe(this.marksChanged);
    doc.on('destroy', this.documentDestroyed);
    doc.on('beforeTransaction', this.beforeTransaction);
    doc.on('afterTransaction', this.afterTransaction);
  }
  /** Keep derived suggestion records in the same native typing transaction. */
  edit(action: () => void): void {
    const marks = this.doc.getMap('marks');
    const before = marks.toJSON();
    const beforeVersions = new Map(this.markVersions);
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
    this.rememberSelection(item);
    const expected: SuggestionRecords = item.meta.get(this.suggestionsKey) ?? new Map();
    const after = marks.toJSON();
    for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const value = after[id] ?? before[id];
      if (['insert', 'delete', 'replace'].includes(value?.kind)
        && (beforeVersions.get(id) ?? 0) !== (this.markVersions.get(id) ?? 0)) {
        expected.set(id, this.suggestionRecord(id));
      }
    }
    if (expected.size) item.meta.set(this.suggestionsKey, expected);
  }
  decide(action: () => void): void {
    const fragment = this.doc.getXmlFragment('prosemirror');
    const before = snapshotText(fragment);
    const marksBefore = this.doc.getMap('marks').toJSON();
    const stateBefore = this.view?.state;
    this.manager.stopCapturing();
    const count = this.manager.undoStack.length;
    this.doc.transact(tr => { action(); tr.meta.set('addToHistory', true); }, this.origin);
    this.manager.stopCapturing();
    if (this.manager.undoStack.length > count) {
      this.rememberSelection(this.manager.undoStack[this.manager.undoStack.length - 1]);
      this.manager.undoStack[this.manager.undoStack.length - 1].meta.set(
        this.rangeKey, this.decisionRange(before, marksBefore, stateBefore),
      );
    }
  }
  /** The text a decision changed. When only mark records changed, the text those
   * marks cover, so a collaborator's later change inside it still refuses. */
  private decisionRange(before: ReturnType<typeof snapshotText>, marksBefore: Record<string, unknown>, stateBefore?: EditorState, restored?: DecisionRange | null): DecisionRange | null {
    const fragment = this.doc.getXmlFragment('prosemirror');
    const after = snapshotText(fragment);
    const range = changedRange(before, after, fragment);
    if (range) return range;
    // Undo or redo of a records-only decision covers the same, unchanged text. The
    // editor's own records may not show the restored mark yet, so reuse that range.
    if (restored) return rangeBetween(this.doc, restored.start, restored.end, after);
    const binding = this.view && ySyncPluginKey.getState(this.view.state)?.binding;
    if (!binding || !this.markRanges) return null;
    const marksAfter = this.doc.getMap('marks').toJSON();
    const changed = new Set([...Object.keys(marksBefore), ...Object.keys(marksAfter)]
      .filter(id => JSON.stringify(marksBefore[id]) !== JSON.stringify(marksAfter[id])));
    // The text is unchanged, so positions from either state name the same text.
    const ranges = [this.view!.state, stateBefore].flatMap(state => state ? this.markRanges!(state) : [])
      .filter(mark => changed.has(mark.id) && mark.range && mark.range.to > mark.range.from)
      .map(mark => mark.range!);
    if (!ranges.length) return null;
    const from = Math.min(...ranges.map(r => r.from)), to = Math.max(...ranges.map(r => r.to));
    return rangeBetween(this.doc,
      absolutePositionToRelativePosition(from, fragment, binding.mapping),
      absolutePositionToRelativePosition(to, fragment, binding.mapping), after);
  }
  private restore(redo: boolean): boolean {
    const manager = this.manager;
    const candidate = historyCandidate(manager, redo);
    // Also inspect entries Yjs would skip, before changing either live stack.
    const stack = redo ? manager.redoStack : manager.undoStack;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (!this.suggestionsMatch(stack[i])) {
        throw new Error(`Can't ${redo ? 'redo' : 'undo'}: someone has replied to this suggestion.`);
      }
      if (stack[i] === candidate) break;
    }
    if (!candidate) {
      // Native history consumes ineffective entries even when no edit remains.
      return (redo ? manager.redo() : manager.undo()) !== null;
    }
    if (candidate.meta.get(this.rangeInvalidatedKey)
      || (candidate.meta.has(this.rangeKey) && !rangeMatches(this.doc, candidate.meta.get(this.rangeKey) as DecisionRange | null))) {
      throw new Error(`Can't ${redo ? 'redo' : 'undo'}: someone has changed this text since.`);
    }
    const fragment = this.doc.getXmlFragment('prosemirror');
    const before = snapshotText(fragment);
    const marksBefore = this.doc.getMap('marks').toJSON();
    const stateBefore = this.view?.state;
    const binding = this.view && ySyncPluginKey.getState(this.view.state)?.binding;
    const beforeSelection = binding && candidate.meta.get(binding);
    const afterSelection = candidate.meta.get(this.afterSelectionKey);
    // Use y-prosemirror's own relative selection and restoration machinery.
    // A metadata-only dispatch may have cleared its transient selection field.
    if (binding && beforeSelection) binding.beforeTransactionSelection = beforeSelection;
    const inverse = redo ? manager.undoStack : manager.redoStack;
    const inverseDepth = inverse.length;
    const item = redo ? manager.redo() : manager.undo();
    if (!item) return false;
    // Editor plugins can write while Yjs is still restoring (for example, marks
    // re-applied to restored text). Yjs records each of those writes as its own
    // inverse entry. They are one step for the person, so merge them.
    if (inverse.length > inverseDepth + 1) {
      const [first, ...rest] = inverse.splice(inverseDepth);
      first.insertions = Y.mergeDeleteSets([first.insertions, ...rest.map(entry => entry.insertions)]);
      first.deletions = Y.mergeDeleteSets([first.deletions, ...rest.map(entry => entry.deletions)]);
      for (const entry of rest) entry.meta.forEach((value, key) => { if (!first.meta.has(key)) first.meta.set(key, value); });
      inverse.push(first);
    }
    // Yjs may skip superseded map writes. Use the item it actually popped,
    // and put the inverse range on the newly created inverse stack item.
    if (binding && afterSelection) {
      inverse[inverse.length - 1].meta.set(binding, afterSelection);
      inverse[inverse.length - 1].meta.set(this.afterSelectionKey, beforeSelection);
    }
    if (item.meta.has(this.rangeKey)) inverse[inverse.length - 1].meta.set(this.rangeKey,
      this.decisionRange(before, marksBefore, stateBefore, item.meta.get(this.rangeKey) as DecisionRange | null));
    const records = item.meta.get(this.suggestionsKey) as SuggestionRecords | undefined;
    if (records) inverse[inverse.length - 1].meta.set(this.suggestionsKey,
      new Map([...records.keys()].map(id => [id, this.suggestionRecord(id)])));
    return true;
  }
  /** A page may publish derived anchors after the typing transaction ends.
   * Extend that typing entry to include the replacement map item, so undo still
   * removes the text and its record together. Never absorb a reply/content edit
   * (including a local AI/API write), or reset an already stale remote version. */
  private includeOwnProjection(id: string): void {
    const current = this.suggestionRecord(id);
    const semantic = (value: string | undefined) => {
      if (!value) return value;
      const record = JSON.parse(value);
      for (const key of ['range', 'quote', 'startRel', 'endRel']) delete record[key];
      return JSON.stringify(record);
    };
    for (let i = this.manager.undoStack.length - 1; i >= 0; i--) {
      const item = this.manager.undoStack[i];
      const expected = (item.meta.get(this.suggestionsKey) as SuggestionRecords | undefined)?.get(id);
      if (!expected) continue;
      if (current.version !== expected.version || semantic(current.value) !== semantic(expected.value)) return;
      const replacement = this.doc.getMap('marks')._map.get(id);
      if (!replacement || replacement.deleted || replacement.id.client !== this.doc.clientID) return;
      const insertion = Y.createDeleteSet();
      insertion.clients.set(replacement.id.client, [{ clock: replacement.id.clock, len: replacement.length }]);
      item.insertions = Y.mergeDeleteSets([item.insertions, insertion]);
      expected.value = current.value;
      return;
    }
  }
  private rememberSelection(item: StackItem): void {
    const binding = this.view && ySyncPluginKey.getState(this.view.state)?.binding;
    if (binding && this.view) item.meta.set(this.afterSelectionKey, getRelativeSelection(binding, this.view.state));
  }
  private suggestionRecord(id: string) {
    return { value: JSON.stringify(this.doc.getMap('marks').get(id)), version: this.externalMarkVersions.get(id) ?? 0 };
  }
  private suggestionsMatch(item: StackItem): boolean {
    const expected = item.meta.get(this.suggestionsKey) as SuggestionRecords | undefined;
    return !expected || [...expected].every(([id, record]) => {
      const current = this.suggestionRecord(id);
      return current.version === record.version;
    });
  }
  undo(): boolean { return this.restore(false); }
  redo(): boolean { return this.restore(true); }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.doc.getMap('marks').unobserve(this.marksChanged);
    this.doc.off('destroy', this.documentDestroyed);
    this.doc.off('beforeTransaction', this.beforeTransaction);
    this.doc.off('afterTransaction', this.afterTransaction);
    this.manager.deleteFilter = this.previousDeleteFilter;
    this.manager.removeTrackedOrigin(this.origin);
    this.manager.removeTrackedOrigin(this.editOrigin);
    if (this.ownsManager) this.manager.destroy();
  }
}
