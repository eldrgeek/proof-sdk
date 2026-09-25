import { isPendingSuggestion, suggestionWithStatus } from '../shared/suggestion-status';
import type { StoredMark } from '../formats/marks';
import { getCurrentActor } from './actor';
import { historyCandidate } from './review-history-candidate';
import * as Y from 'yjs';
import type { EditorView } from '@milkdown/kit/prose/view';
import { defaultDeleteFilter, defaultProtectedNodes, ySyncPluginKey, getRelativeSelection } from 'y-prosemirror';
import { changedRange, rangeMatches, snapshotText, type DecisionRange } from './review-decision-range';

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
/** A decision's records before and after it (JSON), keyed by mark id (ac-x31). */
type DecidedRecords = Map<string, { before: string; after: string }>;

/** The parts of y-prosemirror's ProsemirrorBinding this file relies on. */
interface SyncBinding {
  type: Y.XmlFragment;
  prosemirrorView: EditorView | null;
  _observeFunction: (events: Array<Y.YEvent<any>>, transaction: Y.Transaction) => void;
}

/**
 * Caret stability (Mike, 2026-09-19: typing "moved the view away from where I was typing" and
 * landed as scattered fragments). y-prosemirror writes each local ProseMirror change to Yjs inside
 * its own mutex, so its fragment observer ignores the echo. When we wrap that write in an outer
 * Yjs transaction (edit/decide below, to group text and mark records in one undo entry), the
 * observers only run when the OUTER transaction ends, after the mutex is released. The binding
 * then took its own keystroke for a remote change: it replaced the whole document, restored the
 * caret from a relative position captured before the keystroke (which could resolve to the end
 * of the document) and called scrollIntoView. This runs `action` with the binding's observer
 * detached, which is exactly what the mutex does for an unwrapped local change.
 */
/**
 * A transaction that changes no text must not end the typing run's undo step. y-prosemirror's
 * sync plugin calls UndoManager.stopCapturing() after every update whose addToHistory meta is
 * false, and the view-only plugins (fold, ask, do, extras and the rest) redraw their decorations
 * with that meta after each keystroke. So a typed sentence became one undo step per character or
 * two (found 2026-09-24, Accord step 3 review). Without steps the meta means nothing to either
 * history, so clear it. Remote updates (isChangeOrigin) are left alone: y-prosemirror skips them.
 */
export function keepUndoGroupOpen<T extends { docChanged: boolean; getMeta(key: string): unknown; setMeta(key: string, value: unknown): T }>(tr: T): T {
  if (tr.docChanged || tr.getMeta('addToHistory') !== false) return tr;
  return tr.setMeta('addToHistory', true);
}

/**
 * A mark record's meaning: its fields in a stable order, without the anchors pages re-derive
 * (range, quote, startRel, endRel). Two writes with the same meaning are the same record.
 */
export function semanticMarkRecord(value: unknown): string {
  const stable = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(stable);
    if (!input || typeof input !== 'object') return input;
    const record = input as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort()
      .filter(key => !['range', 'quote', 'startRel', 'endRel'].includes(key))
      .map(key => [key, stable(record[key])]));
  };
  return JSON.stringify(stable(value)) ?? 'undefined';
}

export function withoutOwnEcho<T>(binding: SyncBinding | null | undefined, action: () => T): T {
  const type = binding?.type;
  const observer = binding?._observeFunction;
  if (!binding || !type || !observer || !binding.prosemirrorView) return action();
  type.unobserveDeep(observer);
  try {
    return action();
  } finally {
    // Re-attach only if the binding still owns this view (a destroy during `action` detached it).
    if (binding.prosemirrorView) type.observeDeep(observer);
  }
}

/** Review metadata extends the page's native history, including its selection hooks. */
export class ReviewDecisionHistory {
  private destroyed = false;
  private readonly withdrawnByUndo = new Map<string, { pending: StoredMark; resolved: StoredMark }>();
  private readonly origin = {};
  private readonly editOrigin = {};
  private readonly rangeKey = Symbol('review decision text');
  private readonly suggestionsKey = Symbol('tracked typing records');
  private readonly afterSelectionKey = Symbol('native selection after operation');
  /** The suggestion records a history entry created (not merely changed). */
  private readonly createdKey = Symbol('suggestion records created');
  /** The mark records a decision changed, before and after it. */
  private readonly decidedKey = Symbol('mark records a decision changed');
  private readonly markVersions = new Map<string, number>();
  private readonly externalMarkVersions = new Map<string, number>();
  private readonly marksChanged = (event: Y.YMapEvent<unknown>, transaction: Y.Transaction): void => {
    const external = !transaction.local;
    for (const id of event.keysChanged) {
      this.markVersions.set(id, (this.markVersions.get(id) ?? 0) + 1);
      // Origin labels describe workflows, not which client wrote the record.
      if (external) {
        // Only a change of meaning is someone else's edit. The server re-sets other records with
        // identical content whenever any mark changes; counting those made Undo refuse the
        // person's own typing ("someone has replied") after anyone added a comment (ac-ug8,
        // live since step 3). A re-set record is no longer this client's map item, so undoing
        // the typing that created it withdraws it explicitly (see restore).
        const change = event.changes.keys.get(id);
        const resent = change?.action === 'update'
          && semanticMarkRecord(change.oldValue) === semanticMarkRecord(this.doc.getMap('marks').get(id));
        if (!resent) this.externalMarkVersions.set(id, (this.externalMarkVersions.get(id) ?? 0) + 1);
      } else if (!this.manager.undoing && !this.manager.redoing) this.includeOwnProjection(id);
    }
  };
  private readonly documentDestroyed = (): void => this.destroy();
  readonly manager: Y.UndoManager;
  private readonly ownsManager: boolean;
  private readonly previousDeleteFilter: Y.UndoManager['deleteFilter'];
  constructor(readonly doc: Y.Doc, manager?: Y.UndoManager, private readonly view?: EditorView) {
    this.ownsManager = !manager;
    this.manager = manager ?? new Y.UndoManager(doc.getXmlFragment('prosemirror'), {
      trackedOrigins: new Set([ySyncPluginKey]),
      deleteFilter: item => defaultDeleteFilter(item, defaultProtectedNodes),
      captureTransaction: tr => tr.meta.get('addToHistory') !== false,
    });
    this.previousDeleteFilter = this.manager.deleteFilter;
    this.manager.deleteFilter = item => {
      if (!this.previousDeleteFilter(item) || !deleteEmptyContainer(item)) return false;
      const marks = doc.getMap('marks');
      const id = item.parentSub;
      // Undo of newly typed text is a withdrawal too. Set the decision inside the
      // undo transaction, before its update can reach the server's marks guard.
      if (item.parent === marks && id && marks._map.get(id) === item) {
        const current = marks.get(id);
        if (this.manager.undoing && isPendingSuggestion(current)) {
          const resolved = suggestionWithStatus(current, 'rejected', getCurrentActor());
          this.withdrawnByUndo.set(id, { pending: current, resolved });
          marks.set(id, resolved);
          return false;
        }
      }
      return true;
    };
    this.manager.addToScope(doc.getMap('marks'));
    this.manager.addTrackedOrigin(this.origin);
    this.manager.addTrackedOrigin(this.editOrigin);
    doc.getMap('marks').observe(this.marksChanged);
    doc.on('destroy', this.documentDestroyed);
  }
  /** Keep derived suggestion records in the same native typing transaction. */
  edit(action: () => void): void {
    const marks = this.doc.getMap('marks');
    const before = marks.toJSON();
    const beforeVersions = new Map(this.markVersions);
    const previous = this.manager.undoStack[this.manager.undoStack.length - 1];
    // A later local edit must not refresh an older entry's stale refusal guard.
    if (previous && !this.suggestionsMatch(previous)) this.manager.stopCapturing();
    withoutOwnEcho(this.binding(), () => this.doc.transact(tr => {
      action();
      // Derived metadata dispatches can set this flag to false inside the same
      // transaction. The caller already excluded loads and remote operations.
      tr.meta.set('addToHistory', true);
    }, this.editOrigin));
    const item = this.manager.undoStack[this.manager.undoStack.length - 1];
    if (!item) return;
    this.rememberSelection(item);
    const expected: SuggestionRecords = item.meta.get(this.suggestionsKey) ?? new Map();
    const created: Set<string> = item.meta.get(this.createdKey) ?? new Set();
    const after = marks.toJSON();
    for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const value = after[id] ?? before[id];
      if (['insert', 'delete', 'replace'].includes(value?.kind)
        && (beforeVersions.get(id) ?? 0) !== (this.markVersions.get(id) ?? 0)) {
        expected.set(id, this.suggestionRecord(id));
        if (!(id in before) && id in after) created.add(id);
      }
    }
    if (expected.size) item.meta.set(this.suggestionsKey, expected);
    if (created.size) item.meta.set(this.createdKey, created);
  }
  decide(action: () => void): void {
    const fragment = this.doc.getXmlFragment('prosemirror');
    const before = snapshotText(fragment);
    const marks = this.doc.getMap('marks');
    const recordsBefore = marks.toJSON() as Record<string, unknown>;
    this.manager.stopCapturing();
    const count = this.manager.undoStack.length;
    withoutOwnEcho(this.binding(), () => this.doc.transact(tr => { action(); tr.meta.set('addToHistory', true); }, this.origin));
    this.manager.stopCapturing();
    if (this.manager.undoStack.length > count) {
      const item = this.manager.undoStack[this.manager.undoStack.length - 1];
      this.rememberSelection(item);
      item.meta.set(this.rangeKey, changedRange(before, snapshotText(fragment), fragment));
      // Keep what the decision did to each proposal it accepted or rejected, so Undo can put the
      // record back even after someone else re-sets it (ac-x31; see restore).
      const recordsAfter = marks.toJSON() as Record<string, unknown>;
      const decided: DecidedRecords = new Map();
      for (const id of Object.keys(recordsAfter)) {
        if (!(id in recordsBefore)) continue;
        // Only a proposal the decision accepted or rejected: its words come and go with the record.
        // Records the same write merely re-derives or normalizes (anchors, default fields) are not
        // the decision's, and a later reply on them is no conflict (review-decision-collab finding 3).
        const was = recordsBefore[id] as { kind?: string; status?: string } | undefined;
        const is = recordsAfter[id] as { kind?: string; status?: string } | undefined;
        if (!['insert', 'delete', 'replace'].includes(String(is?.kind))) continue;
        if ((was?.status ?? 'pending') === (is?.status ?? 'pending')) continue;
        decided.set(id, { before: JSON.stringify(was), after: JSON.stringify(is) });
      }
      if (decided.size) item.meta.set(this.decidedKey, decided);
    }
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
    // A decision's records must still mean what the decision left them meaning (ac-x31). An
    // identical re-set is fine (the server does it after every API write); a reply, or another
    // person's decision, is not, and Undo would otherwise overwrite it.
    const decided = candidate.meta.get(this.decidedKey) as DecidedRecords | undefined;
    const marksMap = this.doc.getMap('marks');
    for (const [id, change] of decided ?? []) {
      const current = marksMap.get(id);
      if (current === undefined || semanticMarkRecord(current) !== semanticMarkRecord(JSON.parse(redo ? change.before : change.after))) {
        throw new Error(`Can't ${redo ? 'redo' : 'undo'}: someone has changed this proposal since.`);
      }
    }
    if (candidate.meta.has(this.rangeKey) && !rangeMatches(this.doc, candidate.meta.get(this.rangeKey) as DecisionRange | null)) {
      throw new Error(`Can't ${redo ? 'redo' : 'undo'}: someone has changed this text since.`);
    }
    const fragment = this.doc.getXmlFragment('prosemirror');
    const before = snapshotText(fragment);
    const binding = this.view && ySyncPluginKey.getState(this.view.state)?.binding;
    const beforeSelection = binding && candidate.meta.get(binding);
    const afterSelection = candidate.meta.get(this.afterSelectionKey);
    // Use y-prosemirror's own relative selection and restoration machinery.
    // A metadata-only dispatch may have cleared its transient selection field.
    if (binding && beforeSelection) binding.beforeTransactionSelection = beforeSelection;
    // Redo can restore the text while Yjs declines to resurrect a map item we replaced
    // with a withdrawal. Reopen only that exact locally withdrawn record, inside the
    // native redo transaction, so neither wire updates nor Undo see a missing record.
    const reopenWithdrawals = (transaction: Y.Transaction) => {
      if (!redo || transaction.origin !== manager) return;
      const records = candidate.meta.get(this.suggestionsKey) as SuggestionRecords | undefined;
      const marks = this.doc.getMap('marks');
      for (const id of records?.keys() ?? []) {
        const withdrawal = this.withdrawnByUndo.get(id);
        if (withdrawal && JSON.stringify(marks.get(id)) === JSON.stringify(withdrawal.resolved)) marks.set(id, withdrawal.pending);
      }
    };
    // Undo of typing whose record someone else has since re-set with the same meaning (ac-ug8):
    // the record is their map item now, so Yjs removes the words but not the record, and the
    // deleteFilter's withdrawal (which needs this client's own item) never runs. Withdraw it
    // here, inside the native undo transaction, so no one ever sees a pending proposal that has
    // lost its words, and a later Redo reopens it (withdrawnByUndo).
    const withdrawResent = (transaction: Y.Transaction) => {
      if (redo || transaction.origin !== manager) return;
      const created = candidate.meta.get(this.createdKey) as Set<string> | undefined;
      const records = candidate.meta.get(this.suggestionsKey) as SuggestionRecords | undefined;
      const marks = this.doc.getMap('marks');
      for (const id of created ?? []) {
        const current = marks.get(id);
        const entry = marks._map.get(id);
        const expected = records?.get(id)?.value;
        if (!entry || entry.id.client === this.doc.clientID || !isPendingSuggestion(current) || expected === undefined) continue;
        if (semanticMarkRecord(current) !== semanticMarkRecord(JSON.parse(expected))) continue;
        const resolved = suggestionWithStatus(current, 'rejected', getCurrentActor());
        this.withdrawnByUndo.set(id, { pending: current, resolved });
        marks.set(id, resolved);
      }
    };
    // Undo (or Redo) of a decision whose record someone else has since re-set with the same
    // meaning (ac-x31): the record is their map item now, so Yjs restores the text but not the
    // record. A rejected proposal's words then came back as plain text that nobody accepted.
    // Write the record the other side of the decision holds, inside the native transaction.
    const restoreDecided = (transaction: Y.Transaction) => {
      if (transaction.origin !== manager) return;
      const marks = this.doc.getMap('marks');
      for (const [id, change] of decided ?? []) {
        const entry = marks._map.get(id);
        if (!entry || entry.id.client === this.doc.clientID) continue;
        marks.set(id, JSON.parse(redo ? change.after : change.before));
      }
    };
    this.doc.on('beforeTransaction', reopenWithdrawals);
    this.doc.on('beforeTransaction', withdrawResent);
    this.doc.on('beforeTransaction', restoreDecided);
    let item: StackItem | null;
    try { item = redo ? manager.redo() : manager.undo(); }
    finally {
      this.doc.off('beforeTransaction', reopenWithdrawals);
      this.doc.off('beforeTransaction', withdrawResent);
      this.doc.off('beforeTransaction', restoreDecided);
    }
    if (!item) return false;
    // Yjs may skip superseded map writes. Use the item it actually popped,
    // and put the inverse range on the newly created inverse stack item.
    const inverse = redo ? manager.undoStack : manager.redoStack;
    if (binding && afterSelection) {
      inverse[inverse.length - 1].meta.set(binding, afterSelection);
      inverse[inverse.length - 1].meta.set(this.afterSelectionKey, beforeSelection);
    }
    if (item.meta.has(this.rangeKey)) inverse[inverse.length - 1].meta.set(this.rangeKey, changedRange(before, snapshotText(fragment), fragment));
    const decidedByItem = item.meta.get(this.decidedKey) as DecidedRecords | undefined;
    if (decidedByItem) inverse[inverse.length - 1].meta.set(this.decidedKey, decidedByItem);
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
  private binding(): SyncBinding | null {
    return (this.view && (ySyncPluginKey.getState(this.view.state)?.binding as SyncBinding | undefined)) ?? null;
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
  checkpoint(): StackItem | undefined { return this.manager.undoStack.at(-1); }
  /** A side effect already owned by a higher-level Undo must not create a second native step. */
  withoutRecording(action: () => void): void {
    this.manager.stopCapturing();
    withoutOwnEcho(this.binding(), () => this.doc.transact(tr => {
      action(); tr.meta.set('addToHistory', false);
    }, 'typed-discussion-inverse'));
    this.manager.stopCapturing();
  }
  canRestoreCheckpoint(item: StackItem | undefined): boolean {
    return Boolean(item && this.manager.undoStack.at(-1) === item && this.suggestionsMatch(item)
      && (!item.meta.has(this.rangeKey) || rangeMatches(this.doc, item.meta.get(this.rangeKey) as DecisionRange | null)));
  }
  /** A later explicit inverse supersedes just this operation, never intervening edits. */
  forgetCheckpoint(item: StackItem | undefined): void {
    if (!item) return;
    this.manager.undoStack = this.manager.undoStack.filter(entry => entry !== item);
    this.manager.redoStack = this.manager.redoStack.filter(entry => entry !== item);
  }
  redo(): boolean { return this.restore(true); }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.doc.getMap('marks').unobserve(this.marksChanged);
    this.doc.off('destroy', this.documentDestroyed);
    this.manager.deleteFilter = this.previousDeleteFilter;
    this.manager.removeTrackedOrigin(this.origin);
    this.manager.removeTrackedOrigin(this.editOrigin);
    if (this.ownsManager) this.manager.destroy();
  }
}
