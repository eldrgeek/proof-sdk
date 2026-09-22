/**
 * Accord layout, stage 1 (Ren's proposal, Mike ruled 2026-09-21: "build the layout that you
 * proposed"): the status bar under the page, the "You marked up to here" rule, and two highlight
 * states only. Pure: the reading walk (src/ui/reading-walk.ts) and the margin
 * (src/ui/line-marks.ts) render what these decide.
 *
 * Authorship: Mike Wolf (rulings), Ren (SOMA UI, the proposal), built by Claude Opus 5 (worker
 * accord-layout1), 2026-09-21.
 */
import { actorKey, type LineMark, type LineState, type MarkVia, type ProofIssue } from './line-marks';

/**
 * Two highlight states, plain meanings (proposal, "Two highlight states"): a blue bar and tint for
 * "you are here" (one line only), and an amber margin dot for "needs you". Every other highlight
 * the proposal lists is off; each flag brings one back.
 */
export const HIGHLIGHT_POLICY = {
  /** A separate look for the line under the mouse (off: the one "you are here" look for every source). */
  hoverBand: false,
  /** Context lines drawn dimmer with a faint rule (off: the tier lives in the line's box and the dot's label). */
  contextDimming: false,
  /** A dashed underline on scroll-accepted changes with their old words hidden (off: ordinary insert / delete). */
  provisionalDashed: false,
  /** A ◆ beside decision lines in the margin (off: the tier lives in the line's box and the dot's label). */
  decisionDiamond: false,
} as const;

/**
 * "Amber margin marker = needs you. Lines with an open ask or an unanswered change. The Issues
 * count is the number of amber markers, so the two always agree." Which Issues (src/shared/
 * line-marks.ts computeIssues) put an amber dot on their line for this viewer.
 */
export const NEEDS_YOU_POLICY = {
  /** An ask asked of the viewer that they have not answered. */
  ask: true,
  /** An ask the viewer answered "Not yet" (snoozed) still needs them. Off: it waits quietly. */
  snoozedAsk: false,
  /** An open suggestion by someone else. */
  suggestion: true,
  /** An open comment by someone else. */
  comment: true,
  /** Open objections, uncertain flags, competing wordings, expired claims and {do}s open for the viewer. */
  objection: true,
  uncertain: true,
  alternative: true,
  ttl: true,
  do: true,
  /**
   * Line Issues count only for these reasons, and only for the viewer: `changed` = the viewer's
   * mark is out of date. An unseen line is not amber (scrolling reads it), nor another's
   * rejection (it is the rejecter's thread).
   */
  lineReasons: ['changed'] as readonly string[],
} as const;

/** "You marked up to line K": the viewer's last explicit mark. */
export const MARKED_UP_TO_POLICY = {
  /** Marks the person chose line by line. Passive reads (dwell, section, proxy) and edits are not marks. */
  explicitVias: ['click', 'key', 'ask', 'api'] as readonly MarkVia[],
  /** Older marks without a `via` read as "api" (src/shared/line-marks.ts). */
  missingViaCounts: true,
  /**
   * `latest`: the line of the newest explicit mark (the brief's "last explicit mark").
   * `furthest`: the furthest-down line with an explicit mark.
   */
  basis: 'latest' as 'latest' | 'furthest',
  /** How often the "· 2 min ago" text refreshes. */
  refreshMs: 30_000,
} as const;

/** The status bar under the page. */
export const STATUS_BAR_POLICY = {
  /** Reading / Writing is shown as state, never switched (Suggesting / Editing is the only switch). */
  modeIsSwitch: false,
  /** Height on desktop (px), per the proposal. */
  heightPx: 28,
  /** Scroll-accepted changes not saved yet are listed in the bar with a Save button. */
  listProvisional: true,
} as const;

function sameActor(a: string, b: string): boolean {
  return actorKey(a) === actorKey(b);
}
function includesActor(list: readonly string[] | undefined, viewer: string): boolean {
  return (list ?? []).some(actor => sameActor(actor, viewer));
}

/** Does this Issue need the viewer (NEEDS_YOU_POLICY)? */
export function issueNeedsViewer(issue: ProofIssue, viewer: string): boolean {
  switch (issue.type) {
    case 'ask':
      if (!NEEDS_YOU_POLICY.ask || !includesActor(issue.openFor, viewer)) return false;
      return NEEDS_YOU_POLICY.snoozedAsk || !includesActor(issue.snoozedFor, viewer);
    case 'suggestion':
    case 'comment':
      return NEEDS_YOU_POLICY[issue.type] && !(issue.by && sameActor(issue.by, viewer));
    case 'objection':
      return NEEDS_YOU_POLICY.objection && !sameActor(issue.by, viewer);
    case 'uncertain':
    case 'alternative':
    case 'ttl':
    case 'do':
      return NEEDS_YOU_POLICY[issue.type] && includesActor(issue.openFor, viewer);
    case 'line':
      return issue.reasons.some(reason => NEEDS_YOU_POLICY.lineReasons.includes(reason)
        && (reason !== 'changed' || includesActor(issue.changedFor, viewer)));
    default:
      return false;
  }
}

/**
 * The lines that need the viewer, in document order (one amber dot each). An Issue with no line
 * (a nomination, a review mark whose text is gone) has no dot and is not counted here.
 */
export function needsYouLines(issues: readonly ProofIssue[], viewer: string, lineAtPos: (pos: number) => number): number[] {
  const lines = new Set<number>();
  for (const issue of issues) {
    if (!issueNeedsViewer(issue, viewer)) continue;
    let index: number | null = 'lineIndex' in issue && typeof issue.lineIndex === 'number' ? issue.lineIndex : null;
    if (index === null && typeof issue.pos === 'number') {
      const at = lineAtPos(issue.pos);
      index = at >= 0 ? at : null;
    }
    if (index !== null) lines.add(index);
  }
  return [...lines].sort((a, b) => a - b);
}

export interface MarkedUpTo {
  /** The line (0-based) of the viewer's last explicit mark. */
  line: number;
  /** When that mark was made (ISO). */
  at: string;
  status: string;
}

function isExplicit(mark: LineMark): boolean {
  if (!mark.via) return MARKED_UP_TO_POLICY.missingViaCounts;
  return MARKED_UP_TO_POLICY.explicitVias.includes(mark.via);
}

/** The viewer's last explicit mark on a line of this document (current marks only), or null. */
export function markedUpTo(states: readonly LineState[], viewer: string): MarkedUpTo | null {
  const me = actorKey(viewer);
  let best: MarkedUpTo | null = null;
  for (const state of states) {
    const entry = state.marks.get(me);
    if (!entry || !entry.current || entry.mark.hidden || !isExplicit(entry.mark)) continue;
    const candidate = { line: state.line.index, at: String(entry.mark.at), status: entry.mark.status };
    if (!best) { best = candidate; continue; }
    const better = MARKED_UP_TO_POLICY.basis === 'furthest'
      ? candidate.line > best.line || (candidate.line === best.line && candidate.at > best.at)
      : candidate.at > best.at || (candidate.at === best.at && candidate.line > best.line);
    if (better) best = candidate;
  }
  return best;
}

/** "just now", "2 min ago", "3 h ago", "yesterday", "4 days ago", else a date. */
export function formatAgo(at: string, now: number): string {
  const then = Date.parse(at);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  return new Date(then).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** "12 Issues left" / "1 Issue left" / "Nothing needs you". */
export function issuesLeftText(count: number): string {
  if (count === 0) return 'Nothing needs you';
  return `${count} ${count === 1 ? 'Issue' : 'Issues'} left`;
}
