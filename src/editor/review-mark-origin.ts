import type { Transaction } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';

// UI callers of the public mark API opt in explicitly. The scope lasts only
// for the synchronous action; asynchronous agent/API delivery cannot inherit it.
let humanAction = false;
export function withHumanReviewWrite<T>(action: () => T): T {
  const previous = humanAction;
  humanAction = true;
  try { return action(); } finally { humanAction = previous; }
}

/** Public mark methods default to API provenance, even with a human author. */
export function markApiView(view: EditorView): EditorView {
  const source = humanAction ? 'human' : 'api';
  return new Proxy(view, {
    get(target, key) {
      if (key === 'dispatch') return (tr: Transaction) => target.dispatch(tr.setMeta('proofMarkSource', source));
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** A record's original author is not the person accepting/resolving it. Check
 * authors of newly written marks and replies, not the unchanged thread author. */
export function isOwnHumanMarkChange(
  tr: Transaction,
  before: Record<string, any>,
  after: Record<string, any>,
  actor: string,
): boolean {
  if (!tr.getMeta('proofLocalMarkChange') || tr.getMeta('proofMarkSource') !== 'human'
    || tr.getMeta('server-ai') || tr.getMeta('origin') === 'server-ai'
    || !actor.startsWith('human:')) return false;
  for (const [id, record] of Object.entries(after)) {
    if (!record || typeof record !== 'object') continue;
    // Authored marks record who wrote the text. Accepting someone's suggestion credits
    // the accepted text to them, and that is still the accepter's own decision.
    if (record.kind === 'authored') continue;
    const previous = before[id];
    if ((!previous || previous.by !== record.by) && record.by && record.by !== actor) return false;
    for (const field of ['replies', 'thread']) {
      const oldReplies = Array.isArray(previous?.[field]) ? previous[field] : [];
      for (const reply of Array.isArray(record[field]) ? record[field] : []) {
        if (!oldReplies.some((old: any) => JSON.stringify(old) === JSON.stringify(reply)) && reply.by !== actor) return false;
      }
    }
  }
  return true;
}
