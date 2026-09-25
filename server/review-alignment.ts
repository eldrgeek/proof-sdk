/** Read-only Accord alignment. The legacy report still owns snapshot freezing. */
import { reviewAlignment, reviewSurface } from '../src/shared/review-list.js';
import { computeStep1Team, buildLineStates, normalizeLineText } from '../src/shared/line-marks.js';
import { evaluateThreads, type ThreadSourceMark } from '../src/shared/threads.js';
import { parseStoredMarks, type IssueReport } from './line-marks.js';
import { threadRows } from './threads.js';
import { buildDirectory } from './identity.js';
import { resolveTargetActor } from '../src/shared/identity.js';

export function documentReviewAlignment(slug: string, report: IssueReport, rawMarks: unknown) {
  const lines = report.docLines ?? [];
  const stored = Object.entries(parseStoredMarks(rawMarks)).filter(([, mark]) => mark && typeof mark === 'object');
  const marks: ThreadSourceMark[] = stored.map(([id, mark]) => ({ ...mark, id } as ThreadSourceMark));
  const meta = threadRows(slug);
  const directory = buildDirectory(slug);
  const team = computeStep1Team({ extra: [...report.team,
    ...stored.flatMap(([, mark]) => typeof mark.resolvedBy === 'string' ? [mark.resolvedBy] : []),
    ...meta.flatMap(thread => [thread.by, ...thread.waitingOn, ...(thread.replies ?? []).map(reply => reply.by)])],
    identity: { target: actor => resolveTargetActor(actor, directory) } });
  const lineAtPos = (pos: number) => lines.find(line => pos >= line.pos && pos < line.pos + line.nodeSize)?.index ?? -1;
  const lineOf = (mark: ThreadSourceMark): number | null => {
    // The server parses the current markdown. Stored PM positions can belong to an
    // earlier revision, so prefer the quote when it identifies exactly one item.
    const quote = normalizeLineText(mark.quote ?? '');
    const matches = quote ? lines.filter(line => line.text.includes(quote)) : [];
    if (matches.length === 1) return matches[0].index;
    const pos = mark.range?.from ?? mark.pos;
    return typeof pos === 'number' ? lineAtPos(pos) : null;
  };
  // getMarks on the page excludes unanchored legacy marks. Stored thread rows,
  // in contrast, deliberately survive a missing mark and keep their discussion.
  const visibleMarks = marks.filter(mark => meta.some(row => row.markId === mark.id) || (lineOf(mark) ?? -1) >= 0);
  const threads = evaluateThreads({ marks: visibleMarks, meta, lines, lineOf,
    explains: report.explains as unknown as Parameters<typeof evaluateThreads>[0]['explains'] });
  const byId = new Map(marks.map(mark => [mark.id, mark]));
  const issues = report.issues.map(issue => {
    if (!('markId' in issue)) return issue;
    const mark = byId.get(issue.markId);
    const line = mark && lineOf(mark);
    return typeof line === 'number' && line >= 0 ? { ...issue, pos: lines[line].pos } : issue;
  });
  const input = { issues, threads, team, viewer: team[0] ?? '', lineAtPos,
    states: buildLineStates(lines, report.lineMarks), lineCount: lines.length };
  const alignment = reviewAlignment(input);
  // Preserve the optional tier subrecords. Their descriptive fields still describe
  // the document; only their issue fields change to the shared open-item count.
  const openLines = new Set(reviewSurface(input).views['all-open'].lines);
  const context = new Set(report.tierEvaluation?.views.filter(view => view.actsAsContext).map(view => view.lineIndex));
  const contextIssues = [...openLines].filter(line => context.has(line)).length;
  if (report.counts.context) alignment.counts.context = { ...report.counts.context, issues: contextIssues };
  if (report.counts.decision) alignment.counts.decision = { ...report.counts.decision, issues: openLines.size - contextIssues };
  return { ...alignment, team };
}
