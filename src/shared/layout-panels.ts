/**
 * Accord layout, stage 3 (Ren's proposal, Mike ruled 2026-09-21: "build the layout that you
 * proposed"; decisions 4, 6, 7, 8 and 11): one cursor, the Margin with two tabs (Line N and Room),
 * the Navigator with three tabs (Outline, Issues, Since you), and the phone's bottom strip. Pure:
 * src/ui/reading-walk.ts, src/ui/navigator.ts and src/ui/line-marks.ts render what these decide.
 *
 * Authorship: Mike Wolf (rulings), Ren (SOMA UI, the proposal), built by Claude Opus 5 (worker
 * accord-layout3), 2026-09-21.
 */
import { actorKey, type ProofIssue } from './line-marks';
import { issueNeedsViewer } from './layout-status';

/**
 * One cursor (decision 4): the reading focus and the focus line are one line. Scrolling moves it
 * (scrolling reads), a click sets it (the caret's line, a margin dot, a list item), J / K move it,
 * and the keys, the Margin and the status bar all act on or name that one line.
 *
 * Hover (Mike, 2026-09-19: "having to click is extra work"; the proposal: "hover shows a small
 * margin preview only, the text never changes") is a PREVIEW: resting the mouse on another line
 * shows that line in the Margin's Line tab (its tab says "preview"), and puts a ring on its margin
 * dot. The blue bar, the status bar and the reading position stay on the cursor. The first explicit
 * act on the preview commits it: a click inside the Margin, or a reading key (A, R, Y / N / T, E,
 * D, 1-9), moves the cursor to the previewed line (a jump: no scroll, nothing read on the way) and
 * then acts there. So the line A and R hit is always the line the Margin shows.
 */
export const CURSOR_POLICY = {
  /** Hover previews the Margin (off: hover does nothing). */
  hoverPreviews: true,
  /** A reading key pressed during a preview commits the preview first, then acts on that line. */
  keyCommitsPreview: true,
  /** A click in the Margin during a preview commits the preview first. */
  marginClickCommitsPreview: true,
  /** The previewed line's margin dot gets a ring (the "small margin preview"). */
  ringPreviewDot: true,
  /**
   * The preview ends when the pointer goes over the chrome (menu bar, toolbar) or the Navigator.
   * Over the page's empty space or the Margin it stays, so the mouse can travel to the Margin.
   */
  endPreviewOver: ['#accord-menubar', '#share-banner', '.prw-left'] as readonly string[],
} as const;

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

/** The kinds of Issue a line can need the viewer for, in the order the Navigator names them. */
export type NeedsYouKind = 'ask' | 'suggestion' | 'comment' | 'objection' | 'uncertain' | 'alternative' | 'ttl' | 'do' | 'changed';
const KIND_ORDER: readonly NeedsYouKind[] = ['ask', 'do', 'objection', 'suggestion', 'comment', 'alternative', 'uncertain', 'ttl', 'changed'];

export interface NeedsYouItem {
  line: number;
  /** Every kind on the line, in KIND_ORDER. */
  kinds: NeedsYouKind[];
  /** Who raised the first kind (null: nobody in particular, e.g. the viewer's own changed mark). */
  by: string | null;
  /** How many Issues on the line need the viewer. */
  count: number;
}

function kindOf(issue: ProofIssue): NeedsYouKind | null {
  switch (issue.type) {
    case 'ask': case 'suggestion': case 'comment': case 'objection': case 'uncertain': case 'alternative': case 'ttl': case 'do':
      return issue.type;
    case 'line':
      return 'changed';
    default:
      return null;
  }
}

/**
 * The Issues tab's list: one row per line that needs the viewer, in document order. It uses the
 * same test as the amber dots (issueNeedsViewer), so the list, the dots and the pill always agree.
 */
export function needsYouItems(issues: readonly ProofIssue[], viewer: string, lineAtPos: (pos: number) => number, aliases: readonly string[] = []): NeedsYouItem[] {
  const byLine = new Map<number, Array<{ kind: NeedsYouKind; by: string | null }>>();
  for (const issue of issues) {
    if (!issueNeedsViewer(issue, viewer, aliases)) continue;
    const kind = kindOf(issue);
    if (!kind) continue;
    let index: number | null = 'lineIndex' in issue && typeof issue.lineIndex === 'number' ? issue.lineIndex : null;
    if (index === null && typeof issue.pos === 'number') {
      const at = lineAtPos(issue.pos);
      index = at >= 0 ? at : null;
    }
    if (index === null) continue;
    const by = 'by' in issue && typeof issue.by === 'string' ? issue.by : null;
    const list = byLine.get(index) ?? [];
    list.push({ kind, by });
    byLine.set(index, list);
  }
  return [...byLine.entries()].sort((a, b) => a[0] - b[0]).map(([line, list]) => {
    const sorted = [...list].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
    const kinds = [...new Set(sorted.map(entry => entry.kind))];
    return { line, kinds, by: sorted[0]?.by ?? null, count: list.length };
  });
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
