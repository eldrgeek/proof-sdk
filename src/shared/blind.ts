/**
 * Proof Documents — Step B4f: blind marking (pure code, shared by the browser and the server).
 *
 * Authorship: idea from Anthropic Fable (research round 2, idea 6); brief by the COS (Claude),
 * 2026-09-19; built by Claude Opus 5 (worker proof-bundles), 2026-09-19. POLICY rules are
 * Claude's decisions where the brief is silent.
 *
 * While a document is blind, a team member does not see how others marked a line, answered its
 * ask, or picked among its wordings until they have taken a position on that line themselves.
 * They do see that someone marked it ("marked, hidden until you mark this line"). Then the line is
 * revealed. A revealed line where the marks disagree (an Agree or Approve against a Reject, or
 * different picks) is highlighted and becomes a priority Issue. AIs get the same blindness through
 * the API: their /state hides others' positions per line until they have marked it.
 *
 * Redaction happens on the server before anything leaves it (the page and the agent API receive
 * placeholders), so hidden positions are not in the browser's data either.
 */
import {
  actorKey,
  findCarryTarget,
  resolveLineAnchor,
  type DocLine,
  type LineMark,
  type LineState,
} from './line-marks.js';

export const BLIND_POLICY = {
  /** New documents are not blind; an Owner turns it on (per document). */
  defaultOn: false,
  /** Only an Owner (the page's document creator or a Documents admin; the owner credential) toggles it. */
  whoToggles: 'owner' as const,
  /**
   * What reveals a line to a viewer: their own current mark on it (a skim is not a position),
   * their answer to its ask, or their pick among its wordings.
   */
  revealBy: ['mark', 'answer', 'pick'] as readonly string[],
  /** A hidden mark still shows who marked (not how): the Issue count stays honest. */
  showWhoMarked: true,
  /**
   * Revealed disagreement becomes the priority rule 'disagreement' (priority 1):
   * 'while-blind' (the brief), 'always', or 'never'.
   */
  disagreementPriority: 'while-blind' as 'while-blind' | 'always' | 'never',
  /** The owner credential with no `by` reads everything (the administrator's view). */
  ownerCredentialSeesAll: true,
  /** While blind, line-mark events leave out the status, reason and why (the event log is readable by AIs). */
  eventsOmitPositions: true,
  /** Skimmed marks are not positions, so they are never hidden. */
  hideSkims: false,
} as const;

/** Is the 'disagreement' priority on for this document now? */
export function disagreementCounts(blind: boolean): boolean {
  return BLIND_POLICY.disagreementPriority === 'always' || (BLIND_POLICY.disagreementPriority === 'while-blind' && blind);
}

/** The line a mark sits on now (exact, carried over a cosmetic edit, or its old place), or null. */
export function markLineIndex(mark: LineMark, lines: DocLine[], cache?: Map<string, boolean>): number | null {
  const resolved = resolveLineAnchor(lines, mark.anchor);
  if (resolved?.current) return resolved.lineIndex;
  const carried = findCarryTarget(lines, mark.anchor, cache);
  if (carried) return carried.index;
  return resolved ? resolved.lineIndex : null;
}

/**
 * Lines revealed to `viewer`: lines where they have a current mark that is a position (not a
 * skim), plus `extra` (lines whose ask they answered, or whose wordings they picked among).
 */
export function revealedLines(lines: DocLine[], lineMarks: LineMark[], viewer: string, extra: Iterable<number> = []): Set<number> {
  const me = actorKey(viewer);
  const out = new Set<number>(extra);
  const cache = new Map<string, boolean>();
  for (const mark of lineMarks) {
    if (actorKey(mark.by) !== me || mark.status === 'skimmed') continue;
    const resolved = resolveLineAnchor(lines, mark.anchor);
    if (resolved?.current) { out.add(resolved.lineIndex); continue; }
    const carried = findCarryTarget(lines, mark.anchor, cache);
    if (carried) out.add(carried.index);
  }
  return out;
}

/** Someone else's mark as the viewer may see it before the line is revealed. */
export function hiddenMark(mark: LineMark): LineMark {
  return { ...mark, status: 'seen', reason: null, why: null, hidden: true };
}

/**
 * Replaces other members' positions on lines not revealed to `viewer` with placeholders. The
 * viewer's own marks, skims, and marks on revealed lines pass unchanged. A mark that cannot be
 * placed on any line is hidden too (it could be on a line the viewer has not marked).
 */
export function redactLineMarks(lines: DocLine[], lineMarks: LineMark[], viewer: string, revealed: ReadonlySet<number>): { marks: LineMark[]; hidden: number } {
  const me = actorKey(viewer);
  const cache = new Map<string, boolean>();
  let hidden = 0;
  const marks = lineMarks.map(mark => {
    if (actorKey(mark.by) === me) return mark;
    if (mark.status === 'skimmed' && !BLIND_POLICY.hideSkims) return mark;
    const index = markLineIndex(mark, lines, cache);
    if (index !== null && revealed.has(index)) return mark;
    hidden += 1;
    return hiddenMark(mark);
  });
  return { marks, hidden };
}

/**
 * Lines whose visible current marks disagree: someone Agreed or Approved and someone else
 * Rejected. Hidden placeholders and skims never count.
 */
export function disagreementLines(states: LineState[]): Set<number> {
  const out = new Set<number>();
  for (const state of states) {
    let yes = false;
    let no = false;
    for (const entry of state.marks.values()) {
      if (!entry.current || entry.mark.hidden) continue;
      if (entry.mark.status === 'agreed' || entry.mark.status === 'approved') yes = true;
      if (entry.mark.status === 'rejected') no = true;
    }
    if (yes && no) out.add(state.line.index);
  }
  return out;
}
