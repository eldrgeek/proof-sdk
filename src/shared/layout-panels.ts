/**
 * The selected passage owns the Margin and keyboard actions. Hover changes nothing.
 * Panels open and switch only by a reader action.
 * Mike, 2026-09-23 (usability brief).
 */
import { actorKey, type ProofIssue } from './line-marks';
import type { ThreadView } from './threads';
import { openView, type OpenKind } from './open-view';

/** Mike, 2026-09-24, “The Accord editor” (yfbqrau4), step 1: layout only; writes stay unchanged. */
export const ACCORDS_LIST_POLICY = {
  side: 'left', widthPx: 240, closedBelowPx: 1100, phonePresentation: 'drawer',
  showNew: true, showAll: true, allHref: '/',
} as const;

/** Mike, 2026-09-24, yfbqrau4: Review holds only open items; folded text supplies the outline. */
export const OPEN_ITEMS_POLICY = {
  side: 'right', defaultOpen: true, phonePresentation: 'sheet',
  clickKeepsListFocus: true, enterFocusesDocument: true,
} as const;

/** Mike, 2026-09-24, yfbqrau4: the same chat, with a permanent composer and an upward expansion. */
export const BOTTOM_CHAT_POLICY = {
  position: 'centre-bottom', composerAlwaysVisible: true, collapsedMessages: 1,
  initiallyExpanded: false, expandedHeightShare: 0.6, compactHeightPx: 230,
  explicitOpenExpands: true, badge: 'mentions',
} as const;

/** Mike, 2026-09-24, yfbqrau4: stored marks survive; mark circles and line-mark shortcuts retire. */
export const GUTTER_POLICY = { showLineMarks: false, showOpenDots: true, dotOpensReview: true } as const;

/** Mike, 2026-09-24, yfbqrau4: commands belong to the focused list, never a typing surface. */
export const REVIEW_KEYS_POLICY = {
  accept: 'a', reject: ['Delete', 'Backspace'], next: 'j', previous: 'k', enter: 'Enter',
  proposalsOnly: true, bundlesAsUnit: true, lineMarkKeys: false, wrapNavigation: false,
} as const;

export type ReviewListAction = 'accept' | 'reject' | 'next' | 'previous' | 'document';
export function reviewListKey(input: {
  key: string; listFocused: boolean; typing: boolean; isComposing?: boolean;
  ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; letterShortcuts?: boolean;
}): ReviewListAction | null {
  if (!input.listFocused || input.typing || input.isComposing || input.ctrlKey || input.metaKey || input.altKey) return null;
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  if (input.letterShortcuts === false && /^[a-z]$/.test(key)) return null;
  if (key === REVIEW_KEYS_POLICY.accept) return 'accept';
  if ((REVIEW_KEYS_POLICY.reject as readonly string[]).includes(key)) return 'reject';
  if (key === REVIEW_KEYS_POLICY.next) return 'next';
  if (key === REVIEW_KEYS_POLICY.previous) return 'previous';
  return key === REVIEW_KEYS_POLICY.enter ? 'document' : null;
}

/** Passage rows retain their existing kinds. Never accept a proposal behind an ask or objection. */
export function reviewItemHint(kind: OpenKind | undefined): string | null {
  if (kind === 'suggestion') return null;
  const hints: Record<OpenKind, string> = {
    ask: 'Ask: answer Yes, Not yet or No under its question in the document.',
    comment: 'Comment: reply or resolve it in the discussion below.',
    thread: 'Discussion: reply or resolve it in the discussion below.',
    objection: 'Objection: discuss a change with its author in the conversation.',
    do: 'Action to approve: use its controls under the action in the document.',
    alternative: 'Competing wordings: choose a wording under the passage in the document.',
    uncertain: 'Uncertain passage: discuss it with its author in the conversation.',
    ttl: 'Claim needing a re-check: ask its author to check it in the conversation.',
    lapsed: 'Earlier agreement: propose a change with S or discuss it in the conversation.',
    unread: 'Unread passage: read it; there is no proposal to accept or reject.',
    changed: 'Changed passage: propose a change with S or discuss it in the conversation.',
    suggestion: '',
  };
  return kind ? hints[kind] : 'No open proposal is selected.';
}

/** The Margin (decision 6): two tabs only, the line and the room. */
export type MarginTab = 'line' | 'room';
export const MARGIN_POLICY = {
  /** Mike, 2026-09-24, yfbqrau4: the entire Line tab is retired on every screen size. */
  renderLineTab: false,
  tabs: ['line', 'room'] as readonly MarginTab[],
  /** The tab a first visit opens on. The tab never switches itself (proposal: "The tab does not switch itself"). */
  defaultTab: 'line' as MarginTab,
  /** Opening the chat from an explicit act (a speech bubble, the ⋯ menu's Room, a chat link) selects the Room tab. */
  explicitChatOpensRoom: true,
  /** The Room tab's badge counts unread @mentions of the viewer. */
  roomBadge: 'mentions' as const,
  /** Width on desktop (px), per the mockup. */
  widthPx: 340,
  /** One answer group in the desktop margin or phone sheet. Other capabilities live in More. */
  primaryActions: ['Agree', 'Suggest change', 'Discuss', 'Reject'] as const,
  primaryMarks: ['agreed', 'rejected'] as readonly string[],
  moreItems: ['approved', 'seen', 'clear', 'uncertain', 'alternative', 'explain', 'ttl', 'tier'] as readonly string[],
  /** The Familiar's note on the line folds to its headline ("Familiar says (1)"). */
  familiarFolds: true,
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

/** Only Review. Mike, 2026-09-24, yfbqrau4 accepted Other ideas. The issues id stays compatible. */
export type NavigatorTab = 'issues';
export const NAVIGATOR_POLICY = {
  /** Mike, 2026-09-24, yfbqrau4: this panel now occupies the former Margin. */
  side: OPEN_ITEMS_POLICY.side,
  tabs: [
    { id: 'issues', label: 'Review' },
    // Mike accepted: the folded view replaces Outline and Since you (yfbqrau4, 2026-09-24).
  ] as ReadonlyArray<{ id: NavigatorTab; label: string }>,
  /** The panel opens on Review. */
  defaultTab: 'issues' as NavigatorTab,
  /** Width on desktop (px), per the mockup. */
  widthPx: 340,
  /** Closed by default under this width (proposal: "It closes by default under 1100 px"). */
  closedBelowPx: 1100,
  /** An Issue's title is the line's text, cut to this many characters. */
  titleChars: 80,
} as const;

/** The phone (decision 11): one column, a bottom strip, the Margin as a sheet. */
export const PHONE_STRIP_POLICY = {
  /** Mike, 2026-09-24, yfbqrau4: a count opens Review; the left list has a top-left toggle. */
  opens: 'review',
  showLineMarks: false,
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

/** The remembered rail state: open or closed, and the tab each rail shows. */
export interface RailState { left?: boolean; right?: boolean; leftTab?: NavigatorTab; rightTab?: MarginTab; reviewTab?: NavigatorTab }

export function parseRailState(raw: string | null): RailState {
  try {
    const value = JSON.parse(raw || '{}') as Record<string, unknown>;
    const out: RailState = {};
    if (typeof value.left === 'boolean') out.left = value.left;
    if (typeof value.right === 'boolean') out.right = value.right;
    if (NAVIGATOR_POLICY.tabs.some(t => t.id === value.leftTab)) out.leftTab = value.leftTab as NavigatorTab;
    if (MARGIN_POLICY.tabs.includes(value.rightTab as MarginTab)) out.rightTab = value.rightTab as MarginTab;
    // Old leftTab is read for compatibility, but new selections belong to Review on the right.
    if (NAVIGATOR_POLICY.tabs.some(t => t.id === value.reviewTab)) out.reviewTab = value.reviewTab as NavigatorTab;
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

/** Text identity of a passage, captured when a review row settles. Mike, 2026-09-23 (usability brief). */
export interface SettledIdentity {
  hash: string;
  occurrence: number;
}

/**
 * The line a settled row names now. A remote insert above the row changes indices.
 * The hash and occurrence captured at settle time do not, so the row stays on its passage.
 * Returns null when that passage has left the document.
 */
export function resolveSettledIndex(
  item: SettledIdentity,
  lines: ReadonlyArray<{ hash: string; occurrence: number; index?: number }>,
): number | null {
  const at = lines.findIndex(line => line.hash === item.hash && line.occurrence === item.occurrence);
  if (at < 0) return null;
  const index = lines[at].index;
  return typeof index === 'number' ? index : at;
}

/** Persistent, keyboard reachable margin markers include resolved history and count each object once. */
export function passageMarkers(threads: readonly ThreadView[]): Map<number, { text: string; ids: string[] }> {
  const byLine = new Map<number, Map<string, ThreadView>>();
  for (const view of threads) {
    const lines = view.lineIndices.length ? view.lineIndices : view.lineIndex === null ? [] : [view.lineIndex];
    for (const line of lines) {
      if (!byLine.has(line)) byLine.set(line, new Map());
      byLine.get(line)!.set(view.thread.id, view);
    }
  }
  return new Map([...byLine].map(([line, entries]) => {
    const values = [...entries.values()];
    const proposals = values.filter(v => v.thread.kind === 'proposal').length;
    const comments = values.filter(v => v.thread.kind === 'discussion').reduce((n, v) => n + 1 + v.thread.replies.length, 0);
    const text = [comments ? `${comments} ${comments === 1 ? 'comment' : 'comments'}` : '',
      proposals ? `${proposals} ${proposals === 1 ? 'proposal' : 'proposals'}` : ''].filter(Boolean).join(' · ');
    return [line, { text, ids: [...entries.keys()] }];
  }));
}
