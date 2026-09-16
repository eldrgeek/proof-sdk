import type { Transaction } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';

// UI callers of the public mark API opt in explicitly. The scope lasts only
// for the synchronous action; asynchronous agent/API delivery cannot inherit it.
let humanAction = false;
// A click that applies another author's proposal (Verso's) names that author
// explicitly. The allowance lasts only for that synchronous click.
let allowedAuthors: ReadonlySet<string> | null = null;
export function withHumanReviewWrite<T>(action: () => T, options?: { allowAuthors?: readonly string[] }): T {
  const previous = humanAction;
  const previousAuthors = allowedAuthors;
  humanAction = true;
  allowedAuthors = options?.allowAuthors ? new Set(options.allowAuthors) : null;
  try { return action(); } finally { humanAction = previous; allowedAuthors = previousAuthors; }
}

/** Public mark methods default to API provenance, even with a human author. */
export function markApiView(view: EditorView): EditorView {
  const source = humanAction ? 'human' : 'api';
  return new Proxy(view, {
    get(target, key) {
      if (key === 'dispatch') return (tr: Transaction) => {
        tr.setMeta('proofMarkSource', source);
        if (source === 'api') tr.setMeta('addToHistory', false);
        target.dispatch(tr);
      };
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
    if ((!previous || previous.by !== record.by) && record.by && record.by !== actor
      && !allowedAuthors?.has(record.by)) return false;
    for (const field of ['replies', 'thread']) {
      const oldReplies = Array.isArray(previous?.[field]) ? previous[field] : [];
      for (const reply of Array.isArray(record[field]) ? record[field] : []) {
        if (!oldReplies.some((old: any) => JSON.stringify(old) === JSON.stringify(reply)) && reply.by !== actor
          && !allowedAuthors?.has(reply.by)) return false;
      }
    }
  }
  return true;
}
