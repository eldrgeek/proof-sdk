/**
 * Proof Documents Steps B4c + B4d — evaluating flags, objections and review notes against a
 * document's current lines, on the server (for /state, alignment and "Since you").
 *
 * Authorship: built by Claude Opus 5 (worker proof-aids), 2026-09-19.
 * Imports only the store and shared code, so server/line-marks.ts can use it without a cycle.
 */
import {
  anchorForLine,
  isAiActor,
  normalizeLineText,
  resolveLineAnchor,
  findCarryTarget,
  type DocLine,
  type LineState,
  type ProofIssue,
  type ReviewMarkLike,
} from '../src/shared/line-marks.js';
import {
  ISSUE_PRIORITY,
  evaluateFlags,
  explicitPriorityLookup,
  noteLineIndex,
  rankIssues,
  uncertainIssueInputs,
  type ExplicitPriority,
  type FlagView,
  type RankedIssue,
  type ReviewNote,
  type UncertainFlag,
} from '../src/shared/review-aids.js';
import { describeObjection, evaluateObjections, objectionIssueInputs, type ObjectionView, type ProofObjection } from '../src/shared/objections.js';
import { listFlags, listObjections, listReviewNotes, persistObjectionViews, updateFlagAnchor } from './review-aids-store.js';

/**
 * The pending suggestions on each line, from the stored marks (the server has no editor
 * positions): a suggestion is on a line when its quote is part of the line's text.
 */
export function serverSuggestionsOnLine(lines: DocLine[], reviewMarks: ReviewMarkLike[]): (lineIndex: number) => string[] {
  const pending = reviewMarks.filter(mark => mark.open && mark.kind !== 'comment')
    .map(mark => ({ id: mark.id, quote: normalizeLineText(String(mark.quote ?? '')) }))
    .filter(mark => mark.quote.length > 0);
  return (lineIndex: number) => {
    const line = lines[lineIndex];
    if (!line) return [];
    return pending.filter(mark => line.text.includes(mark.quote)).map(mark => mark.id);
  };
}

export interface AidsEvaluation {
  flags: UncertainFlag[];
  flagViews: FlagView[];
  objections: ProofObjection[];
  objectionViews: ObjectionView[];
  notes: ReviewNote[];
  /** Flaggers and objectors join the team (like askers). */
  teamExtra: string[];
}

/** Reads and evaluates the aids; re-anchors flags and objections that moved (persisted). */
export function evaluateAids(slug: string, lines: DocLine[], reviewMarks: ReviewMarkLike[]): AidsEvaluation {
  const flags = listFlags(slug);
  const flagViews = evaluateFlags(flags, lines);
  for (const view of flagViews) {
    if (view.lineIndex === null) continue;
    const line = lines[view.lineIndex];
    const a = view.flag.anchor;
    if (a.hash === line.hash && a.occurrence === line.occurrence && a.ordinal === line.index) continue;
    try {
      const anchor = anchorForLine(line);
      updateFlagAnchor(slug, view.flag.id, anchor);
      view.flag.anchor = anchor;
    } catch (error) {
      console.warn('[review-aids] flag re-anchor failed', { slug, error: String(error) });
    }
  }
  const objections = listObjections(slug);
  const objectionViews = evaluateObjections(objections, lines, serverSuggestionsOnLine(lines, reviewMarks));
  persistObjectionViews(slug, objectionViews, lines);
  const notes = listReviewNotes(slug);
  return {
    flags,
    flagViews,
    objections,
    objectionViews,
    notes,
    teamExtra: [...flags.map(flag => flag.by), ...objections.map(objection => objection.by)],
  };
}

export function uncertainInputs(evaluation: AidsEvaluation, states: LineState[], team: string[]) {
  return uncertainIssueInputs(evaluation.flagViews, states, team);
}

export function objectionInputs(evaluation: AidsEvaluation) {
  return objectionIssueInputs(evaluation.objectionViews);
}

/** Issues annotated with their team-neutral priority (for /state), in document order. */
export function annotateIssues(issues: ProofIssue[], notes: ReviewNote[], lines: DocLine[]): Array<ProofIssue & { key: string; priority: number; priorityRule: string; explicitPriority: ExplicitPriority | null; urgent: boolean }> {
  const ranked: RankedIssue[] = rankIssues(issues, { viewer: null, explicitFor: explicitPriorityLookup(notes, lines) });
  const byIssue = new Map(ranked.map(r => [r.issue, r]));
  return issues.map(issue => {
    const r = byIssue.get(issue)!;
    return { ...issue, key: r.key, priority: r.priority, priorityRule: r.rule, explicitPriority: r.explicit, urgent: r.priority <= ISSUE_PRIORITY.urgentAtOrBelow };
  });
}

/** JSON for AIs: one objection with where its lines are now. */
export function serializeObjection(view: ObjectionView, lines: DocLine[]): Record<string, unknown> {
  const o = view.objection;
  return {
    id: o.id,
    by: o.by,
    reason: o.reason,
    condition: o.condition,
    status: o.status,
    open: view.open,
    summary: describeObjection(view),
    createdAt: o.createdAt,
    closedAt: o.closedAt,
    closedBy: o.closedBy,
    overrideReason: o.overrideReason,
    keptAt: o.keptAt,
    repairPending: view.repairPending,
    deletedLines: view.deletedLines,
    pendingSuggestions: view.suggestions,
    lines: o.lines.map((covered, i) => {
      const index = view.lineIndices[i];
      const line = index === null ? null : lines[index];
      return {
        lineIndex: index,
        ref: line ? `b${line.block + 1}` : null,
        text: line ? line.text.slice(0, 300) : null,
        deleted: index === null,
        changed: view.changed[i],
        original: covered.original.text ?? covered.original.excerpt,
      };
    }),
  };
}

export function serializeFlag(view: FlagView, lines: DocLine[]): Record<string, unknown> {
  const line = view.lineIndex === null ? null : lines[view.lineIndex];
  return {
    id: view.flag.id,
    by: view.flag.by,
    note: view.flag.note,
    createdAt: view.flag.createdAt,
    lineIndex: view.lineIndex,
    ref: line ? `b${line.block + 1}` : null,
    text: line ? line.text.slice(0, 300) : view.flag.anchor.excerpt,
    orphaned: view.lineIndex === null,
  };
}

export function serializeNote(note: ReviewNote, lines: DocLine[]): Record<string, unknown> {
  const index = noteLineIndex(note, lines);
  return {
    id: note.id,
    by: note.by,
    target: note.target.kind === 'suggestion' ? { markId: note.target.markId } : { lineIndex: index, excerpt: note.target.anchor.excerpt },
    why: note.why,
    rejectHints: note.rejectHints,
    priority: note.priority,
    priorityReason: note.priorityReason,
    at: note.at,
  };
}
