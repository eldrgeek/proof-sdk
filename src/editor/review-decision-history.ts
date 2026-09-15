import * as Y from 'yjs';
import { defaultDeleteFilter, defaultProtectedNodes } from 'y-prosemirror';
import { changedRange, rangeMatches, snapshotText, type DecisionRange } from './review-decision-range';

/** One origin, one capture per decision. Native typing and remote edits are excluded. */
export class ReviewDecisionHistory {
  private readonly origin = {};
  private readonly manager: Y.UndoManager;
  private actions: Array<DecisionRange | null> = [];
  private undone: Array<DecisionRange | null> = [];
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
      this.actions.push(changedRange(before, snapshotText(fragment), fragment));
      this.undone = [];
    }
  }
  private restore(redo: boolean): boolean {
    const source = redo ? this.undone : this.actions;
    if (!source.length) return false;
    if (!rangeMatches(this.doc, source[source.length - 1])) {
      throw new Error(`Can't ${redo ? 'redo' : 'undo'}: someone has changed this text since.`);
    }
    const fragment = this.doc.getXmlFragment('prosemirror');
    const before = snapshotText(fragment);
    const item = redo ? this.manager.redo() : this.manager.undo();
    if (!item) return false;
    source.pop();
    (redo ? this.actions : this.undone).push(changedRange(before, snapshotText(fragment), fragment));
    return true;
  }
  undo(): boolean { return this.restore(false); }
  redo(): boolean { return this.restore(true); }
  destroy(): void { this.manager.destroy(); }
}
