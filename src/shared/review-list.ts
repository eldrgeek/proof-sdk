/**
 * One Review list beside the full document. Scope, counts and rows use openView.
 * Rows follow document order; completion stays in place until Next, Clear completed or close.
 * Insertions preserve the selected row's screen position and never move keyboard focus.
 * Mike, 2026-09-23 (usability brief).
 */
import { participantStatus } from './participant-status';
import { actorKey, type IssueSummary } from './line-marks';
import { openView, OPEN_KIND_ORDER, type OpenViewInput, type OpenItem, type OpenView } from './open-view';

export type ReviewScope = 'needs-you' | 'all-open';
export const REVIEW_LIST_POLICY = {
  scopes: [{ id: 'needs-you', label: 'Needs you' }, { id: 'all-open', label: 'All open' }],
  defaultScope: 'needs-you' as ReviewScope,
  order: 'document',
  clearCompletedOn: ['next', 'clear', 'close'],
  includeUnassignedOpenItems: true,
} as const;
export function reviewCountLabel(scope: ReviewScope, count: number): string {
  return scope === 'needs-you' ? `${count} need you` : `${count} open`;
}

/** All open is the union of the team's Open sets, never the broader raw Issue count. */
export function reviewViews(input: OpenViewInput): Record<ReviewScope, OpenView> {
  const mine = openView(input);
  const byLine = new Map(mine.items.map(item => [item.line, { ...item }]));
  // Unaddressed proposals/discussions still wait for a reader when their author
  // is the only known participant. The empty viewer adds those to All open only.
  for (const viewer of [...(REVIEW_LIST_POLICY.includeUnassignedOpenItems ? [''] : []), ...(input.team ?? [])]) {
    if ([input.viewer, ...(input.aliases ?? [])].some(actor => actorKey(actor) === actorKey(viewer))) continue;
    for (const item of openView({ ...input, viewer, aliases: [] }).items) {
      const prev = byLine.get(item.line);
      byLine.set(item.line, prev ? {
        ...prev,
        kinds: OPEN_KIND_ORDER.filter(kind => prev.kinds.includes(kind) || item.kinds.includes(kind)),
        threadIds: [...new Set([...prev.threadIds, ...item.threadIds])],
        markIds: [...new Set([...(prev.markIds ?? []), ...(item.markIds ?? [])])],
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
  // Row keys are unique within a session: the list reuses one DOM row per key, and rows that
  // shared a passage key (several proposals on one line over time) leaked a row on every render.
  const usedKeys = new Set<string>();
  const uniqueKey = (key: string): string => {
    let next = key;
    for (let n = 2; usedKeys.has(next); n += 1) next = `${key}#${n}`;
    usedKeys.add(next);
    return next;
  };
  const rows = open.items.flatMap(item => {
    const passage = passages[item.line];
    if (!passage) return [];
    // Marks before text: typing into a proposal changes its passage on every keystroke, and
    // matching by text alone left one "Done · passage removed" row per character in every
    // reader's list (live since step 3; found in the step 4 review, 2026-09-25, at 690 rows).
    const old = [...unused].find(row => row.threadIds.some(id => item.threadIds.includes(id)))
      ?? [...unused].find(row => (row.markIds ?? []).some(id => (item.markIds ?? []).includes(id)))
      ?? [...unused].find(row => row.hash === passage.hash && row.occurrence === passage.occurrence);
    if (old) unused.delete(old);
    const base = old?.key ?? (item.markIds?.[0] ? `mark:${item.markIds[0]}` : `passage:${passage.hash}:${passage.occurrence}`);
    return [{ ...item, ...passage, key: uniqueKey(base),
      done: false, fresh: old ? old.fresh : session.initialized }];
  });
  for (const old of unused) {
    const line = passages.findIndex(p => p.hash === old.hash && p.occurrence === old.occurrence);
    rows.push({ ...old, line, done: true, key: uniqueKey(old.key) });
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

/** A single read of the visible facts for status, header, Review rows, count and dots. */
export function reviewSurface(input: OpenViewInput) {
  const status = participantStatus({ states: input.states ?? [], team: input.team ?? [],
    objections: input.issues.flatMap(issue => issue.type === 'objection'
      ? [{ by: issue.by, reason: issue.reason, condition: issue.condition, lineIndices: issue.lineIndices }] : []) });
  return { status, views: reviewViews({ ...input, status }) };
}

/** /state keeps its public count fields, but counts the same passages as All open.
 * A passage with several reasons is assigned to its first kind (OPEN_KIND_ORDER),
 * so the category counts add to total. Snapshot confirmation is a separate rule.
 */
export function reviewAlignment(input: OpenViewInput): { aligned: boolean; counts: IssueSummary['counts'] } {
  const open = reviewSurface(input).views['all-open'];
  const counts: IssueSummary['counts'] = { lines: input.lineCount ?? 0, lineIssues: 0, reviewMarkIssues: 0,
    askIssues: 0, uncertainIssues: 0, objectionIssues: 0, alternativeIssues: 0, ttlIssues: 0,
    doIssues: 0, nominationIssues: 0, total: open.count };
  const field = { ask: 'askIssues', do: 'doIssues', objection: 'objectionIssues', suggestion: 'reviewMarkIssues',
    comment: 'reviewMarkIssues', thread: 'reviewMarkIssues', uncertain: 'uncertainIssues',
    alternative: 'alternativeIssues', ttl: 'ttlIssues', changed: 'lineIssues', lapsed: 'lineIssues', unread: 'lineIssues' } as const;
  for (const item of open.items) counts[field[item.kinds[0]]]++;
  return { aligned: open.count === 0, counts };
}
