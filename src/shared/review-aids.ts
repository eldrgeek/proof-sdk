/**
 * Proof Documents — Step B4c: review aids (pure code, shared by the browser and the server).
 *
 * Authorship: ideas from the overnight research round (Anthropic Fable ideas 7, 9, 10, 15);
 * brief by the COS (Claude), 2026-09-19; built by Claude Opus 5 (worker proof-aids), 2026-09-19.
 * Every rule marked POLICY is Claude's decision where the brief is silent, kept in one named
 * constant so a ruling from Mike is a one-line change.
 *
 * Four aids:
 *   1. `why`: an AI's one-line rationale on a suggestion or a line mark (shown under the focus
 *      line's change card, with "Ask why").
 *   2. Uncertain flags: a writer marks a line `uncertain` (amber margin tick, 2× reading time,
 *      an Issue until each reader takes a position).
 *   3. Issue priority + a sitting budget: Next issue follows stakes, then document order.
 *   4. Reject reason chips: static defaults plus hints an AI author supplied.
 * Like line marks, all of this is stored beside the document, never in its text.
 */
import {
  PASSIVE_VIAS,
  actorKey,
  findCarryTarget,
  isAiActor,
  resolveLineAnchor,
  type DocLine,
  type LineAnchor,
  type LineState,
  type ProofIssue,
  type UncertainIssueInput,
} from './line-marks.js';

// ============================================================================
// 1. Rationale (`why`)
// ============================================================================

export const WHY_POLICY = {
  /** Longest `why` (one line; longer text is cut). */
  max: 300,
  /**
   * When an AI adds a suggestion through the agent API without a `why`:
   *   'all-ai'    - 400 WHY_REQUIRED for every AI-named suggestion (by "ai:…", or an agent key);
   *   'agent-key' - 400 WHY_REQUIRED when the request uses an agent key (a named AI that joined
   *                 through "Add agent"); other AI-named requests (share-token or owner-credential
   *                 scripts) succeed with a warning header and a `warnings` entry;
   *   'warn'      - never refuse; always warn.
   * Decision: 'agent-key'. The brief asked for 400, but ~20 repo regression tests, the COS's own
   * posting script (scratchpad pd/pd.mjs) and the How-To recipe send AI suggestions with a share
   * token and no `why`; none of ~/Projects/_estate/bin posts suggestions. Flip to 'all-ai' once
   * those callers send `why`.
   */
  enforce: 'agent-key' as 'all-ai' | 'agent-key' | 'warn',
  /** Header (and body `warnings[].code`) sent when a `why` was expected and missing. */
  warningHeader: 'X-Proof-Warning',
  warningCode: 'WHY_MISSING',
  /** A line-mark `why` is kept only from AI actors (a person's Reject already has a reason). */
  lineMarkWhyFromHumans: false,
  /** "Ask why" appears on change cards whose author is an AI. */
  askWhyFor: 'ai' as 'ai' | 'everyone',
  /** The reply "Ask why" posts on the suggestion's thread (the chat rail is a later step). */
  askWhyText: 'Why this change?',
} as const;

/** One line of plain text: trimmed, inner whitespace collapsed, cut at `max`. */
export function oneLineText(value: unknown, max: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function cleanWhy(value: unknown): string | null {
  const why = oneLineText(value, WHY_POLICY.max);
  return why || null;
}

/** Is a `why` required (true), only warned about ('warn'), or not expected (false)? */
export function whyExpectation(input: { by: string; viaAgentKey: boolean }): true | 'warn' | false {
  const ai = input.viaAgentKey || isAiActor(input.by);
  if (!ai) return false;
  if (WHY_POLICY.enforce === 'all-ai') return true;
  if (WHY_POLICY.enforce === 'agent-key') return input.viaAgentKey ? true : 'warn';
  return 'warn';
}

// ============================================================================
// Review notes: an AI's why / reject hints / priority on a suggestion or a line
// ============================================================================

export type ReviewNoteTarget = { kind: 'suggestion'; markId: string } | { kind: 'line'; anchor: LineAnchor };

export interface ReviewNote {
  id: string;
  by: string;
  target: ReviewNoteTarget;
  why: string | null;
  rejectHints: string[];
  /** Step B4c: an explicit priority 1 (most urgent) - 5, with its reason. */
  priority: number | null;
  priorityReason: string | null;
  at: string;
}

// ============================================================================
// 4. Reject reason chips
// ============================================================================

export const REJECT_CHIPS = {
  /** At most this many chips under the reason field. */
  max: 3,
  /** Static chips, in order (the first `max` fill the row when no author hints exist). */
  defaults: ['Wrong fact', 'Too strong', 'Not now', 'Unclear'] as readonly string[],
  /** Author hints come before the defaults (decision). */
  authorFirst: true,
  /** Hints are kept only from AI authors (the brief: "when the line has an AI author"). */
  hintsFromAiOnly: true,
  maxHintLength: 40,
  maxHintsPerNote: 5,
  /** A chip replaces the reason field's text (decision); the reader can still type after it. */
  fill: 'replace' as 'replace' | 'append',
} as const;

export function cleanRejectHints(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const hint = oneLineText(raw, REJECT_CHIPS.maxHintLength);
    if (!hint || seen.has(hint.toLowerCase())) continue;
    seen.add(hint.toLowerCase());
    out.push(hint);
    if (out.length >= REJECT_CHIPS.maxHintsPerNote) break;
  }
  return out;
}

export interface RejectChip { label: string; source: 'author' | 'default'; by?: string }

/** The chips to show: author hints (de-duplicated), then the defaults, at most REJECT_CHIPS.max. */
export function rejectChipsFor(hints: Array<{ hint: string; by: string }>): RejectChip[] {
  const out: RejectChip[] = [];
  const seen = new Set<string>();
  const add = (chip: RejectChip) => {
    const key = chip.label.toLowerCase();
    if (seen.has(key) || out.length >= REJECT_CHIPS.max) return;
    seen.add(key);
    out.push(chip);
  };
  const authored = hints.filter(h => !REJECT_CHIPS.hintsFromAiOnly || isAiActor(h.by));
  const author = () => { for (const h of authored) add({ label: h.hint, source: 'author', by: h.by }); };
  const defaults = () => { for (const label of REJECT_CHIPS.defaults) add({ label, source: 'default' }); };
  if (REJECT_CHIPS.authorFirst) { author(); defaults(); } else { defaults(); author(); }
  return out;
}

// ============================================================================
// 2. Uncertain flags
// ============================================================================

export const UNCERTAIN_POLICY = {
  /** The reading walk's dwell on a flagged line is multiplied by this (brief: 2×). */
  dwellFactor: 2,
  /** Anyone who may comment may flag a line (the writer is whoever edits; decision). */
  whoMayFlag: 'commenter' as const,
  /** Only the flagger or an Owner can clear a flag (decision). */
  clearBy: 'flagger-or-owner' as const,
  /** One open flag per person per line: flagging again updates the note. */
  onePerPersonPerLine: true,
  /**
   * The flag is an Issue for every team member other than the flagger until they take a
   * position on the line after the flag: one of these statuses, earned deliberately (not by
   * scrolling or with a section). Seen alone does not settle it (decision: uncertainty asks for
   * a judgement, not a glance).
   */
  settledBy: ['agreed', 'approved', 'rejected'] as readonly string[],
  /** A flag follows its line through edits (like an ask); the flagger clears it (decision). */
  followsEdits: true,
  maxNote: 300,
} as const;

export interface UncertainFlag {
  id: string;
  by: string;
  note: string | null;
  anchor: LineAnchor;
  createdAt: string;
}

export interface FlagView {
  flag: UncertainFlag;
  /** The flagged line now, or null when it is gone. */
  lineIndex: number | null;
}

/** Where each flag sits now: its exact line, a cosmetic edit of it, or the line at its place. */
export function evaluateFlags(flags: UncertainFlag[], lines: DocLine[]): FlagView[] {
  const cache = new Map<string, boolean>();
  return flags.map(flag => {
    const resolved = resolveLineAnchor(lines, flag.anchor);
    if (resolved?.current) return { flag, lineIndex: resolved.lineIndex };
    const carried = findCarryTarget(lines, flag.anchor, cache);
    if (carried) return { flag, lineIndex: carried.index };
    if (UNCERTAIN_POLICY.followsEdits && resolved) return { flag, lineIndex: resolved.lineIndex };
    return { flag, lineIndex: null };
  });
}

/** Has `member` taken a position on this line since `since` (UNCERTAIN_POLICY.settledBy)? */
export function tookPosition(state: LineState | undefined, member: string, since: string): boolean {
  const entry = state?.marks.get(actorKey(member));
  if (!entry || !entry.current) return false;
  if (!UNCERTAIN_POLICY.settledBy.includes(entry.mark.status)) return false;
  if (entry.mark.via && PASSIVE_VIAS.has(entry.mark.via)) return false;
  return String(entry.mark.at) >= String(since);
}

/** Flags that are Issues, with the members they are open for. */
export function uncertainIssueInputs(views: FlagView[], states: LineState[], team: string[]): UncertainIssueInput[] {
  const out: UncertainIssueInput[] = [];
  for (const view of views) {
    if (view.lineIndex === null) continue;
    const state = states[view.lineIndex];
    const flagger = actorKey(view.flag.by);
    const openFor = team.filter(member => actorKey(member) !== flagger && !tookPosition(state, member, view.flag.createdAt));
    if (openFor.length === 0) continue;
    out.push({ id: view.flag.id, lineIndex: view.lineIndex, by: view.flag.by, note: view.flag.note, openFor });
  }
  return out;
}

/** Line indices that carry an open flag (the reading walk slows on them; the margin shows a tick). */
export function flaggedLines(views: FlagView[]): Map<number, UncertainFlag[]> {
  const out = new Map<number, UncertainFlag[]>();
  for (const view of views) {
    if (view.lineIndex === null) continue;
    const list = out.get(view.lineIndex) ?? [];
    list.push(view.flag);
    out.set(view.lineIndex, list);
  }
  return out;
}

// ============================================================================
// 3. Issue priority and the sitting budget
// ============================================================================

export type PriorityRule =
  | 'disagreement'
  | 'rejected-by-others'
  | 'objection'
  | 'open-ask'
  | 'repair-proposed'
  | 'changed-since-you-marked'
  | 'uncertain'
  | 'pending-suggestion'
  | 'open-comment'
  | 'unseen'
  | 'open-alternative'
  | 'ttl-not-true'
  | 'ttl-check'
  | 'do-failed'
  | 'do-approve'
  | 'do-finger'
  | 'waiting-on-others';

export const ISSUE_PRIORITY = {
  /**
   * Priority by rule: 1 is the most urgent. Brief order: rejections by others > open asks >
   * substantive changes to lines you had marked > uncertain-flagged lines > pending suggestions
   * > unseen lines. Decisions: an objection by someone else ranks with rejections; a repair
   * proposed to your own objection ranks with asks (it waits on you); open comments rank with
   * suggestions; an Issue that waits only on other people ranks last.
   */
  byRule: {
    // Step B4f: a line whose revealed marks (blind marking) or picks disagree.
    disagreement: 1,
    'rejected-by-others': 1,
    objection: 1,
    'open-ask': 2,
    'repair-proposed': 2,
    'changed-since-you-marked': 3,
    uncertain: 4,
    'pending-suggestion': 5,
    'open-comment': 5,
    unseen: 6,
    // Step B4f: open competing wordings wait on your pick (like a changed line).
    'open-alternative': 3,
    // Step B4f: an AI said a perishable line is no longer true (people re-check it).
    'ttl-not-true': 3,
    // Step B4f: an expired line waits on the AI collaborators' re-check (low, per the brief).
    'ttl-check': 6,
    // {do} action lines: a failed or stalled run (result unknown) comes first for its proposer and
    // approvers; approving, or the Mac click a run waits for, ranks with an open ask; a {do} that
    // waits only on the machine (or on execution being enabled) waits on others.
    'do-failed': 1,
    'do-approve': 2,
    'do-finger': 2,
    'waiting-on-others': 7,
  } as Record<PriorityRule, number>,
  /** "Urgent" in "7 more, none urgent": priority at or below this (decision: rejections and asks). */
  urgentAtOrBelow: 2,
  /** An AI may set an explicit priority in this range through the agent API, with a reason. */
  explicitMin: 1,
  explicitMax: 5,
  /**
   * An explicit priority can only raise urgency (min of rule and explicit), so an AI cannot bury
   * someone's rejection (decision). Several AIs: the most urgent wins.
   */
  explicitMayLower: false,
  maxReason: 200,
} as const;

export const PRIORITY_LABEL: Record<PriorityRule, string> = {
  disagreement: 'The team disagrees here',
  'rejected-by-others': 'Rejected by someone else',
  objection: 'Objection',
  'open-ask': 'An ask waiting on you',
  'repair-proposed': 'A repair was proposed to your objection',
  'changed-since-you-marked': 'Changed since you marked it',
  uncertain: 'The writer is unsure of this line',
  'pending-suggestion': 'Pending suggestion',
  'open-comment': 'Open comment',
  unseen: 'Not seen yet',
  'open-alternative': 'Competing wordings: pick one',
  'ttl-not-true': 'An AI says this may no longer be true',
  'ttl-check': 'Time to re-check this line',
  'do-failed': 'An action failed or stalled',
  'do-approve': 'An action waiting for your approval',
  'do-finger': 'An action waiting for your click on the Mac',
  'waiting-on-others': 'Waiting on someone else',
};

export interface ExplicitPriority { priority: number; reason: string | null; by: string }

export interface RankedIssue {
  issue: ProofIssue;
  key: string;
  priority: number;
  rule: PriorityRule;
  explicit: ExplicitPriority | null;
  urgent: boolean;
}

export function issueKey(issue: ProofIssue): string {
  switch (issue.type) {
    case 'line': return `line:${issue.hash}:${issue.lineIndex}`;
    case 'ask': return `ask:${issue.askId}`;
    case 'uncertain': return `flag:${issue.flagId}`;
    case 'objection': return `objection:${issue.objectionId}`;
    case 'alternative': return `alt:${issue.lineIndex}`;
    case 'ttl': return `ttl:${issue.ttlId}`;
    case 'do': return `do:${issue.doId}`;
    default: return `mark:${issue.markId}`;
  }
}

function includesActor(list: string[], viewer: string): boolean {
  const key = actorKey(viewer);
  return list.some(actor => actor === 'anyone' || actorKey(actor) === key);
}

/**
 * The rule that sets an Issue's priority for `viewer` (null = no viewer: the team-neutral view an
 * AI reads in /state, where "others" means anyone and "you" means any member).
 */
export function priorityRule(issue: ProofIssue, viewer: string | null): PriorityRule {
  const me = viewer ? actorKey(viewer) : null;
  switch (issue.type) {
    case 'line': {
      if (issue.disagreement) return 'disagreement';
      if (issue.rejectedBy.some(r => me === null || actorKey(r.by) !== me)) return 'rejected-by-others';
      if (me === null ? issue.changedFor.length > 0 : includesActor(issue.changedFor, viewer!)) return 'changed-since-you-marked';
      if (me === null ? issue.unseenBy.length > 0 : includesActor(issue.unseenBy, viewer!)) return 'unseen';
      return 'waiting-on-others';
    }
    case 'ask':
      return me === null || includesActor(issue.openFor, viewer!) ? 'open-ask' : 'waiting-on-others';
    case 'objection':
      if (me === null || actorKey(issue.by) !== me) return 'objection';
      return issue.repairPending ? 'repair-proposed' : 'waiting-on-others';
    case 'uncertain':
      return me === null || includesActor(issue.openFor, viewer!) ? 'uncertain' : 'waiting-on-others';
    case 'alternative':
      if (issue.disagreement) return 'disagreement';
      return me === null || includesActor(issue.openFor, viewer!) ? 'open-alternative' : 'waiting-on-others';
    case 'ttl':
      if (me !== null && !includesActor(issue.openFor, viewer!)) return 'waiting-on-others';
      return issue.reason === 'expired' ? 'ttl-check' : 'ttl-not-true';
    case 'do': {
      if (me !== null && !includesActor(issue.openFor, viewer!)) return 'waiting-on-others';
      if (issue.openFor.length === 0) return 'waiting-on-others';
      if (issue.state === 'failed' || issue.state === 'stalled') return 'do-failed';
      if (issue.state === 'needs-finger') return 'do-finger';
      if (issue.state === 'proposed') return 'do-approve';
      return 'waiting-on-others';
    }
    case 'suggestion':
      return 'pending-suggestion';
    default:
      return 'open-comment';
  }
}

export function clampPriority(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  if (n < ISSUE_PRIORITY.explicitMin || n > ISSUE_PRIORITY.explicitMax) return null;
  return n;
}

/**
 * Ranks Issues: priority (rule, raised by an explicit AI priority), then document order.
 * `explicitFor` returns the explicit priorities that apply to an Issue (by its mark or its line).
 */
export function rankIssues(issues: ProofIssue[], options: {
  viewer: string | null;
  explicitFor?: (issue: ProofIssue) => ExplicitPriority[];
}): RankedIssue[] {
  const ranked = issues.map((issue, order) => {
    const rule = priorityRule(issue, options.viewer);
    let priority = ISSUE_PRIORITY.byRule[rule];
    let explicit: ExplicitPriority | null = null;
    for (const candidate of options.explicitFor?.(issue) ?? []) {
      if (!explicit || candidate.priority < explicit.priority) explicit = candidate;
    }
    if (explicit) priority = ISSUE_PRIORITY.explicitMayLower ? explicit.priority : Math.min(priority, explicit.priority);
    return { issue, key: issueKey(issue), priority, rule, explicit, urgent: priority <= ISSUE_PRIORITY.urgentAtOrBelow, order };
  });
  // computeIssues already sorted the Issues in document order; keep it within one priority.
  ranked.sort((a, b) => (a.priority - b.priority) || (a.order - b.order));
  return ranked.map(({ order: _order, ...rest }) => rest);
}

/**
 * The Issue after `lastKey` in ranked order. When `lastKey` is no longer an Issue, the next is
 * the first ranked Issue after where it was (`lastPlace`: its priority and position).
 */
export function nextRankedIssue(ranked: RankedIssue[], lastKey: string | null, lastPlace: { priority: number; pos: number } | null): RankedIssue | null {
  if (ranked.length === 0) return null;
  if (lastKey) {
    const at = ranked.findIndex(r => r.key === lastKey);
    if (at >= 0) return ranked[(at + 1) % ranked.length];
  }
  if (lastPlace) {
    const after = ranked.find(r => r.priority > lastPlace.priority
      || (r.priority === lastPlace.priority && (r.issue.pos ?? Number.MAX_SAFE_INTEGER) > lastPlace.pos));
    if (after) return after;
  }
  return ranked[0];
}

export const SITTING_BUDGET = {
  /** "This sitting: N issues" choices in the rail; 0 = off (the default, per the brief). */
  choices: [0, 5, 10, 20] as readonly number[],
  defaultBudget: 0,
  /** A sitting counts the distinct Issues the reader visited with Next issue (decision). */
  counts: 'visited' as const,
} as const;

export interface SittingSummary {
  budget: number;
  visited: number;
  reached: boolean;
  remaining: number;
  urgentRemaining: number;
  /** "7 more, none urgent" / "7 more, 2 urgent" / "Nothing left". */
  text: string;
}

export function sittingSummary(ranked: RankedIssue[], visited: ReadonlySet<string>, budget: number): SittingSummary {
  const left = ranked.filter(r => !visited.has(r.key));
  const urgent = left.filter(r => r.urgent).length;
  const text = left.length === 0 ? 'Nothing left'
    : `${left.length} more, ${urgent === 0 ? 'none urgent' : `${urgent} urgent`}`;
  return {
    budget,
    visited: visited.size,
    reached: budget > 0 && visited.size >= budget,
    remaining: left.length,
    urgentRemaining: urgent,
    text,
  };
}

// ============================================================================
// Notes against the current lines (browser and server)
// ============================================================================

/** Where a line note sits now (its exact line, or a cosmetic edit of it). */
export function noteLineIndex(note: ReviewNote, lines: DocLine[]): number | null {
  if (note.target.kind !== 'line') return null;
  const resolved = resolveLineAnchor(lines, note.target.anchor);
  if (resolved?.current) return resolved.lineIndex;
  const carried = findCarryTarget(lines, note.target.anchor);
  return carried ? carried.index : null;
}

/** Explicit priorities (AI notes) that apply to an Issue: its suggestion's, or its line's. */
export function explicitPriorityLookup(notes: ReviewNote[], lines: DocLine[]): (issue: ProofIssue) => ExplicitPriority[] {
  const byMark = new Map<string, ExplicitPriority[]>();
  const byLine = new Map<number, ExplicitPriority[]>();
  for (const note of notes) {
    if (note.priority === null || !isAiActor(note.by)) continue;
    const entry: ExplicitPriority = { priority: note.priority, reason: note.priorityReason, by: note.by };
    if (note.target.kind === 'suggestion') {
      byMark.set(note.target.markId, [...(byMark.get(note.target.markId) ?? []), entry]);
    } else {
      const index = noteLineIndex(note, lines);
      if (index !== null) byLine.set(index, [...(byLine.get(index) ?? []), entry]);
    }
  }
  return (issue: ProofIssue) => {
    if (issue.type === 'comment' || issue.type === 'suggestion') return byMark.get(issue.markId) ?? [];
    const index: number | null = 'lineIndex' in issue ? issue.lineIndex : null;
    return index === null ? [] : (byLine.get(index) ?? []);
  };
}

