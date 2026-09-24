/**
 * The selected passage owns the Margin and keyboard actions. Hover changes nothing.
 * Panels open and switch only by a reader action.
 * Mike, 2026-09-23 (usability brief).
 */
import { actorKey, type ProofIssue } from './line-marks';
import { openView, type OpenKind } from './open-view';

/** The Margin (decision 6): two tabs only, the line and the room. */
export type MarginTab = 'line' | 'room';
export const MARGIN_POLICY = {
  tabs: ['line', 'room'] as readonly MarginTab[],
  /** The tab a first visit opens on. The tab never switches itself (proposal: "The tab does not switch itself"). */
  defaultTab: 'line' as MarginTab,
  /** Opening the chat from an explicit act (a speech bubble, the ⋯ menu's Room, a chat link) selects the Room tab. */
  explicitChatOpensRoom: true,
  /** The Room tab's badge counts unread @mentions of the viewer. */
  roomBadge: 'mentions' as const,
  /** Width on desktop (px), per the mockup. */
  widthPx: 340,
  /**
   * Decision 8: Agree and Reject are the two primary mark buttons; everything else a line can take
   * is under ⋯ More (in this order). "Seen" stays for a person who wants it explicit: scrolling
   * marks Seen on its own.
   */
  primaryMarks: ['agreed', 'rejected'] as readonly string[],
  moreItems: ['approved', 'seen', 'clear', 'uncertain', 'alternative', 'explain', 'ttl', 'tier'] as readonly string[],
  /** The Familiar's note on the line folds to its headline ("Familiar says (1)"). */
  familiarFolds: true,
  /** "Reply on this line…": a reply to the line's newest open comment, else a new comment on the whole line. */
  replyToNewestComment: true,
} as const;

/**
 * Polish pass (COS, 2026-09-21): everyone's marks on a line fold, in the Margin's Line tab, into
 * one row "Marked by N"; expanding it shows who marked what. The row is open by default only when
 * the line has a Reject or an open objection, because those are the marks a reader must see. A
 * person who opens or closes it keeps that choice for the line (explicit beats automatic).
 */
export const MARKED_BY_POLICY = {
  /** Fold the list in the Line tab (the popover and the phone's dot sheet keep the flat list). */
  foldInLineTab: true,
  /** What opens the fold by default. */
  openWhen: { reject: true, openObjection: true },
  /**
   * Who N counts: everyone whose mark on the line is there, current or out of date, including a
   * mark blind marking hides. People who have not marked the line are listed only when expanded.
   */
  countsUnseen: false,
} as const;

export interface MarkedByFold {
  /** How many people have a mark on the line. */
  count: number;
  /** The team's size (everyone the list names). */
  total: number;
  /** Open by default (a Reject or an open objection). */
  open: boolean;
  /** "Marked by 3", or "Not marked yet". */
  label: string;
  /** The statuses in words, most serious first: "1 Rejected · 2 Agreed". */
  detail: string;
}

const MARKED_BY_ORDER = ['rejected', 'changed', 'approved', 'agreed', 'seen', 'skimmed', 'stale', 'hidden'] as const;
const MARKED_BY_WORD: Record<string, string> = {
  rejected: 'Rejected', changed: 'Changed since marked', approved: 'Approved', agreed: 'Agreed',
  seen: 'Seen', skimmed: 'Skimmed', stale: 'Stale', hidden: 'Hidden',
};

/**
 * The "Marked by N" row for one line. `statuses` has one entry per team member, as the page shows
 * it: 'unseen' (no mark), 'changed' (marked before the line changed), 'hidden' (blind), 'stale',
 * or a stored status. A Reject counts only while it is current (a 'changed' Reject is not one).
 */
export function markedByFold(statuses: readonly string[], hasOpenObjection: boolean): MarkedByFold {
  const marked = statuses.filter(status => MARKED_BY_POLICY.countsUnseen || status !== 'unseen');
  const count = marked.length;
  const tally = new Map<string, number>();
  for (const status of marked) tally.set(status, (tally.get(status) ?? 0) + 1);
  const detail = MARKED_BY_ORDER.filter(status => tally.has(status)).map(status => `${tally.get(status)} ${MARKED_BY_WORD[status]}`).join(' · ');
  const open = (MARKED_BY_POLICY.openWhen.reject && tally.has('rejected'))
    || (MARKED_BY_POLICY.openWhen.openObjection && hasOpenObjection);
  return { count, total: statuses.length, open, label: count === 0 ? 'Not marked yet' : `Marked by ${count}`, detail };
}

/** The Navigator (decision 7): three tabs, lists of the whole document. */
export type NavigatorTab = 'outline' | 'issues' | 'since';
export const NAVIGATOR_POLICY = {
  tabs: [
    { id: 'outline', label: 'Outline' },
    { id: 'issues', label: 'Issues' },
    { id: 'since', label: 'Since you' },
  ] as ReadonlyArray<{ id: NavigatorTab; label: string }>,
  /** The mockup opens on Issues. */
  defaultTab: 'issues' as NavigatorTab,
  /** Width on desktop (px), per the mockup. */
  widthPx: 240,
  /** Closed by default under this width (proposal: "It closes by default under 1100 px"). */
  closedBelowPx: 1100,
  /** Outline rows indent this much per heading level below the top one (px). */
  indentPx: 12,
  /** An Issue's title is the line's text, cut to this many characters. */
  titleChars: 80,
} as const;

/** The phone (decision 11): one column, a bottom strip, the Margin as a sheet. */
export const PHONE_STRIP_POLICY = {
  /** The strip's height (px), per the proposal. */
  heightPx: 56,
  /** The status bar folds into the strip: it shows only while the strip steps aside (the caret in the text). */
  statusFoldsIntoStrip: true,
  /** A swipe up on the strip this far (px) opens the Margin sheet; down closes it. */
  swipePx: 28,
  /** The sheet's height, as a share of the window. */
  sheetHeightShare: 0.6,
} as const;

/**
 * The kinds of Issue a line can need the viewer for, in the order the Navigator names them.
 * Accord round 2 stage C: this is OpenKind (src/shared/open-view.ts) under its older name, so the
 * Navigator's rows and the Open list name the same things.
 */
export type NeedsYouKind = OpenKind;

export interface NeedsYouItem {
  line: number;
  /** Every kind on the line, in OPEN_KIND_ORDER. */
  kinds: NeedsYouKind[];
  /** Who raised the first kind (null: nobody in particular, e.g. the viewer's own changed mark). */
  by: string | null;
  /** How many Issues on the line need the viewer. */
  count: number;
}

/**
 * The Issues tab's list: one row per line that needs the viewer, in document order.
 *
 * Accord round 2 stage C: this no longer decides anything either. It returns the items of the ONE
 * definition of Open (src/shared/open-view.ts openView), which is also where the amber dots and the
 * Issues pill come from. A caller that has the document's threads should call `openView` directly
 * and pass them, so a thread with no review mark is counted too.
 */
export function needsYouItems(issues: readonly ProofIssue[], viewer: string, lineAtPos: (pos: number) => number, aliases: readonly string[] = []): NeedsYouItem[] {
  return openView({ issues, viewer, lineAtPos, aliases }).items
    .map(({ line, kinds, by, count }) => ({ line, kinds, by, count }));
}

/** "Ask · line 41", "Change from Dee · line 80", "Comment from Dee and 1 more · line 12". */
export function needsYouLabel(item: NeedsYouItem, name: (actor: string) => string, viewer?: string): string {
  const first = item.kinds[0];
  const from = item.by && (!viewer || actorKey(item.by) !== actorKey(viewer)) ? ` from ${name(item.by)}` : '';
  const head = first === 'ask' ? 'Ask'
    : first === 'do' ? 'Action to approve'
    : first === 'objection' ? `Objection${from}`
    : first === 'suggestion' ? `Change${from}`
    : first === 'comment' ? `Comment${from}`
    : first === 'alternative' ? 'Competing wordings'
    : first === 'uncertain' ? `Flagged uncertain${from}`
    : first === 'ttl' ? 'Needs a re-check'
    // Accord round 2 stage C: a lapsed agreement says so in the words of the rule, and an open
    // thread with no review mark gets its own row rather than borrowing "changed".
    : first === 'lapsed' ? 'You agreed to an earlier version'
    : first === 'thread' ? `Discussion${from}`
    : first === 'unread' ? 'Nobody has marked this'
    : 'Changed since you marked it';
  const more = item.count > 1 ? ` and ${item.count - 1} more` : '';
  return `${head}${more} · line ${item.line + 1}`;
}

/** An outline row: a heading, its fold state and its Issue count. */
export interface OutlineRow {
  headingIndex: number;
  level: number;
  /** Indent steps below the shallowest heading. */
  depth: number;
  text: string;
  folded: boolean;
  /** Hidden because an enclosing section is folded. */
  hidden: boolean;
  issues: number;
}

/** The Outline tab's rows, from the folding sections (src/shared/folding.ts). */
export function outlineRows(
  sections: ReadonlyArray<{ headingIndex: number; level: number; parent: number | null }>,
  text: (headingIndex: number) => string,
  isFolded: (headingIndex: number) => boolean,
  issues: (headingIndex: number) => number,
): OutlineRow[] {
  const top = sections.reduce((min, s) => Math.min(min, s.level), Infinity);
  const byHeading = new Map(sections.map(s => [s.headingIndex, s]));
  const foldedAbove = (s: { parent: number | null }): boolean => {
    let parent = s.parent;
    while (parent !== null) {
      if (isFolded(parent)) return true;
      parent = byHeading.get(parent)?.parent ?? null;
    }
    return false;
  };
  return sections.map(s => ({
    headingIndex: s.headingIndex,
    level: s.level,
    depth: Number.isFinite(top) ? Math.max(0, s.level - top) : 0,
    text: text(s.headingIndex),
    folded: isFolded(s.headingIndex),
    hidden: foldedAbove(s),
    issues: issues(s.headingIndex),
  }));
}

/** The remembered rail state: open or closed, and the tab each rail shows. */
export interface RailState { left?: boolean; right?: boolean; leftTab?: NavigatorTab; rightTab?: MarginTab }

export function parseRailState(raw: string | null): RailState {
  try {
    const value = JSON.parse(raw || '{}') as Record<string, unknown>;
    const out: RailState = {};
    if (typeof value.left === 'boolean') out.left = value.left;
    if (typeof value.right === 'boolean') out.right = value.right;
    if (NAVIGATOR_POLICY.tabs.some(t => t.id === value.leftTab)) out.leftTab = value.leftTab as NavigatorTab;
    if (MARGIN_POLICY.tabs.includes(value.rightTab as MarginTab)) out.rightTab = value.rightTab as MarginTab;
    return out;
  } catch {
    return {};
  }
}

/** Existing review rows keep their order; incoming rows append until the reader leaves the list. */
export function stableReviewOrder(previous: readonly string[], incoming: readonly string[]): string[] {
  const present = new Set(incoming);
  const kept = previous.filter(key => present.has(key));
  const known = new Set(kept);
  return [...kept, ...incoming.filter(key => !known.has(key))];
}
