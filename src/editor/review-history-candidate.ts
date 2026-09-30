import * as Y from 'yjs';

type StackItem = Y.UndoManager['undoStack'][number];
type DeleteSet = StackItem['insertions'];

/** Read-only counterpart of Yjs UndoManager.popStackItem / Item.redoItem.
 * Keep these eligibility rules aligned with the installed Yjs version. Unlike
 * iterateDeletedStructs, this traversal never splits live structs or transacts.
 */
export function historyCandidate(manager: Y.UndoManager, redo: boolean): StackItem | null {
  const stack = redo ? manager.redoStack : manager.undoStack;
  const store = manager.doc.store;
  const inScope = (item: Y.Item) => manager.scope.some(type => type === manager.doc || Y.isParentOf(type as Y.AbstractType<any>, item));
  function visit(set: DeleteSet, fn: (item: Y.Item, clock: number) => void) {
    for (const [client, ranges] of set.clients) {
      const structs = store.clients.get(client);
      if (!structs) continue;
      for (const range of ranges) {
        for (let i = Y.findIndexSS(structs, range.clock); i < structs.length; i++) {
          const item = structs[i];
          if (item.id.clock >= range.clock + range.len) break;
          if (item instanceof Y.Item) fn(item, Math.max(range.clock, item.id.clock));
        }
      }
    }
  }
  function follow(item: Y.Item, clock = item.id.clock): Y.Item {
    while (item.redone) {
      const id = Y.createID(item.redone.client, item.redone.clock + clock - item.id.clock);
      item = Y.getItem(store, id); clock = id.clock;
    }
    return item;
  }
  for (let index = stack.length - 1; index >= 0; index--) {
    const candidate = stack[index];
    const toRedo = new Set<Y.Item>();
    let effective = false;
    visit(candidate.insertions, (item, clock) => {
      item = follow(item, clock);
      // Children are deleted first. If a protected ancestor becomes empty,
      // deleting those children already makes this stack item effective.
      if (!item.deleted && inScope(item) && manager.deleteFilter(item)) effective = true;
    });
    if (effective) return candidate;
    visit(candidate.deletions, item => {
      if (inScope(item) && !Y.isDeleted(candidate.insertions, item.id)) toRedo.add(item);
    });
    const deletedByRemainingStack = (id: Y.ID) =>
      manager.undoStack.some((s, i) => (!redo ? i < index : true) && Y.isDeleted(s.deletions, id))
      || manager.redoStack.some((s, i) => (redo ? i < index : true) && Y.isDeleted(s.deletions, id));
    const canRedo = (item: Y.Item): boolean => {
      // Yjs counts an existing redone item as effective, even when deleted.
      if (item.redone) return true;
      const parent = (item.parent as Y.AbstractType<any>)._item;
      if (parent?.deleted && !parent.redone && (!toRedo.has(parent) || !canRedo(parent))) return false;
      if (item.parentSub !== null && item.right && !manager.ignoreRemoteMapChanges) {
        let left: Y.Item = item;
        while (left.right && (left.right.redone || Y.isDeleted(candidate.insertions, left.right.id) || deletedByRemainingStack(left.right.id))) {
          left = follow(left.right);
        }
        if (left.right) return false;
      }
      return true;
    };
    if ([...toRedo].some(canRedo)) return candidate;
  }
  return null;
}
