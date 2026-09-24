/**
 * One Review list beside the full document. Scope, counts and rows use openView.
 * Rows follow document order; completion stays in place until Next, Clear completed or close.
 * Insertions preserve the selected row's screen position and never move keyboard focus.
 * Mike, 2026-09-23 (usability brief).
 */
import { actorKey } from './line-marks';
import { openView, OPEN_KIND_ORDER, type OpenViewInput, type OpenItem, type OpenView } from './open-view';

export type ReviewScope = 'needs-you' | 'all-open';
export const REVIEW_LIST_POLICY = {
  scopes: [{ id: 'needs-you', label: 'Needs you' }, { id: 'all-open', label: 'All open' }],
  defaultScope: 'needs-you' as ReviewScope,
  order: 'document',
  clearCompletedOn: ['next', 'clear', 'close'],
} as const;
export function reviewCountLabel(scope: ReviewScope, count: number): string {
  return scope === 'needs-you' ? `${count} need you` : `${count} open`;
}

/** All open is the union of the team's Open sets, never the broader raw Issue count. */
export function reviewViews(input: OpenViewInput): Record<ReviewScope, OpenView> {
  const mine = openView(input);
  const byLine = new Map(mine.items.map(item => [item.line, { ...item }]));
  for (const viewer of input.team ?? []) {
    if ([input.viewer, ...(input.aliases ?? [])].some(actor => actorKey(actor) === actorKey(viewer))) continue;
    for (const item of openView({ ...input, viewer, aliases: [] }).items) {
      const prev = byLine.get(item.line);
      byLine.set(item.line, prev ? {
        ...prev,
        kinds: OPEN_KIND_ORDER.filter(kind => prev.kinds.includes(kind) || item.kinds.includes(kind)),
        threadIds: [...new Set([...prev.threadIds, ...item.threadIds])],
        count: Math.max(prev.count, item.count),
      } : item);
    }
  }
  const items = [...byLine.values()].sort((a, b) => a.line - b.line);
  return { 'needs-you': mine, 'all-open': { items, lines: items.map(item => item.line), count: items.length } };
}
export interface ReviewPassage { hash: string; occurrence: number; text: string }
export interface ReviewRow extends OpenItem {
  hash: string;
  occurrence: number;
  text: string;
  done: boolean;
  fresh: boolean;
}
export interface ReviewSession { rows: ReviewRow[]; initialized: boolean }
export const emptyReviewSession = (): ReviewSession => ({ rows: [], initialized: false });

/** Match threads first, then text identity. Never attach a completed row to a reused index. */
export function reconcileReview(session: ReviewSession, open: OpenView, passages: readonly ReviewPassage[]): ReviewSession {
  const unused = new Set(session.rows);
  const rows = open.items.flatMap(item => {
    const passage = passages[item.line];
    if (!passage) return [];
    const old = [...unused].find(row => row.threadIds.some(id => item.threadIds.includes(id)))
      ?? [...unused].find(row => row.hash === passage.hash && row.occurrence === passage.occurrence);
    if (old) unused.delete(old);
    return [{ ...item, ...passage, key: old?.key ?? `passage:${passage.hash}:${passage.occurrence}`,
      done: false, fresh: old ? old.fresh : session.initialized }];
  });
  for (const old of unused) {
    const line = passages.findIndex(p => p.hash === old.hash && p.occurrence === old.occurrence);
    rows.push({ ...old, line, done: true });
  }
  rows.sort((a, b) => (a.line < 0 ? Infinity : a.line) - (b.line < 0 ? Infinity : b.line));
  return { rows, initialized: true };
}
export function clearCompleted(session: ReviewSession): ReviewSession {
  return { ...session, rows: session.rows.filter(row => !row.done) };
}
export function nextReviewRow(session: ReviewSession, currentLine: number): ReviewRow | null {
  const open = session.rows.filter(row => !row.done && row.line >= 0);
  return open.find(row => row.line > currentLine) ?? open[0] ?? null;
}
/** Apply after DOM reconciliation, with native overflow anchoring disabled on the list scroller. */
export function anchoredReviewScroll(scrollTop: number, beforeTop: number, afterTop: number): number {
  return Math.max(0, scrollTop + afterTop - beforeTop);
}
export function reviewStorageKey(document: string, reader: string): string {
  return `proof:review-panel:${encodeURIComponent(document)}:${encodeURIComponent(actorKey(reader))}`;
}
