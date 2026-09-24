/**
 * One definition of Open for the Review list, its count and the margin dots.
 * The document stays whole; only reader-chosen section folds hide text.
 * Completion never changes the view or removes controls.
 * Mike, 2026-09-23 (usability brief).
 */
import {
  actorKey,
  countsAsSeen,
  type LineState,
  type ProofIssue,
} from './line-marks.js';
import {
  participantStatus,
  statusHeader,
  type DocumentStatus,
  type HeaderClause,
  type StatusObjection,
} from './participant-status.js';
// NOTE: layout-status imports this module back (needsYouLines delegates to openView). Only
// `issueNeedsViewer` is used, and only at call time — a hoisted function declaration, so the
// import cycle is safe in either load order. Never reference a `const` from layout-status here.
import { issueNeedsViewer } from './layout-status.js';
import { threadOpenFor, type ThreadOpenness, type ThreadView } from './threads.js';

// ============================================================================
// POLICY
// ============================================================================

export const OPEN_VIEW_POLICY = {
  /**
   * ★ THE ONE PLACE Mike's words and an earlier ruling disagree, kept as one flag.
   *
   * Mike's words for this stage say Open is "new text or text or decisions about which there is
   * not yet agreement", and the brief spells out "a line the viewer has not read or marked (new to
   * them)". But the Accord layout stage 1 ruling (NEEDS_YOU_POLICY.lineReasons, 2026-09-21) says
   * the opposite for the margin: "An unseen line is not amber (scrolling reads it)". Both cannot
   * hold while the pill, the dots and the list count one set.
   *
   * Shipped OFF, which keeps the ruled margin behaviour and changes no count anywhere. Turning it
   * ON puts every unread line in all three at once — the test proves the invariant holds either
   * way, so this is a one-line change for Mike, not a rebuild.
   */
  unreadLinesAreOpen: false,
  /**
   * A comment someone else left, with no stored thread row, is open for the viewer
   * (NEEDS_YOU_POLICY.comment, which has shipped since step 1). `threadOpenFor` would call it
   * "just a comment — nothing has to happen" (THREAD_POLICY.commentIsIssue = false), because for a
   * thread a person deliberately opened as a comment that is right. For a legacy comment mark
   * nobody chose a closing condition for, the older reading is the true one. So the ProofIssue
   * wins for a comment mark and `threadOpenFor` wins for everything else.
   */
  legacyCommentIsOpen: true,
} as const;

// ============================================================================
// What an open item is
// ============================================================================

/** Why a line is open. In the order the Open list names them when a line has several. */
export type OpenKind =
  | 'ask' | 'do' | 'objection' | 'suggestion' | 'comment'
  | 'alternative' | 'uncertain' | 'ttl'
  /** The viewer agreed, and then the meaning changed: the agreement lapsed (brief 5). */
  | 'lapsed'
  /** The line changed since the viewer marked it (they had not agreed, or the lapse has no earlier text). */
  | 'changed'
  /** A thread or proposal open for the viewer that is not already one of the kinds above. */
  | 'thread'
  /** Nobody has marked this line (OPEN_VIEW_POLICY.unreadLinesAreOpen). */
  | 'unread';

export const OPEN_KIND_ORDER: readonly OpenKind[] = [
  'ask', 'do', 'objection', 'suggestion', 'comment', 'alternative', 'uncertain', 'ttl',
  'lapsed', 'changed', 'thread', 'unread',
];

export interface OpenItem {
  /** Stable across renders, so a row can keep its place and its settled state. */
  key: string;
  /** The line the item sits on. Every item has one: a detached thread sits where it detached to. */
  line: number;
  /** Every reason this line is open for the viewer, in OPEN_KIND_ORDER. */
  kinds: OpenKind[];
  /** Who raised the first reason (null: nobody in particular — the viewer's own lapsed mark). */
  by: string | null;
  /** How many separate open things sit on this line. */
  count: number;
  /**
   * One sentence for a person, saying why this is open. A thread's own `because` is preferred
   * over anything invented here.
   */
  because: string;
  /** The text this was about is gone (a detached thread): the row says so. */
  detached: boolean;
  /** For a lapsed agreement: the wording the viewer agreed to. */
  agreedTo?: string;
  /** The thread ids on this line that are open for the viewer. */
  threadIds: string[];
}

export interface OpenView {
  /** One row per line that is open for the viewer, in document order. */
  items: OpenItem[];
  /** The lines that get an amber dot. Derived from `items`: they cannot disagree. */
  lines: number[];
  /** The Issues pill. Derived from `items`: it cannot disagree. */
  count: number;
}

export interface OpenViewInput {
  issues: readonly ProofIssue[];
  /** The viewer's own actor string. Open is never anyone else's. */
  viewer: string;
  /** The viewer's other actor strings (the editor writes a guest's comments under another name). */
  aliases?: readonly string[];
  /** The line an Issue that carries only a position sits on (-1 when it is nowhere). */
  lineAtPos: (pos: number) => number;
  /** Every thread on the document (src/shared/threads.ts evaluateThreads). Optional: the server
   *  and the older callers have none, and then only the ProofIssues count. */
  threads?: readonly ThreadView[];
  /** The document's team, for a thread that names nobody (threadOpenFor's `options.team`). */
  team?: readonly string[];
  /** The line states (src/shared/line-marks.ts buildLineStates), for lapsed marks and unread lines. */
  states?: readonly LineState[];
  /** How many lines the document has, so an item can never point off the end. */
  lineCount?: number;
}

const kindOfIssue = (issue: ProofIssue): OpenKind | null => {
  switch (issue.type) {
    case 'ask': case 'suggestion': case 'comment': case 'objection':
    case 'uncertain': case 'alternative': case 'ttl': case 'do':
      return issue.type;
    case 'line':
      return 'changed';
    default:
      return null;
  }
};

const ISSUE_WORDS: Record<OpenKind, string> = {
  ask: 'An ask on this line waits for your answer.',
  do: 'An action on this line waits for you to approve it.',
  objection: 'Someone objected to this line.',
  suggestion: 'A proposed change waits on you: accept it or reject it.',
  comment: 'A comment on this line you have not answered.',
  alternative: 'Competing wordings, and you have not picked one.',
  uncertain: 'Someone flagged this line uncertain.',
  ttl: 'This line is due a re-check.',
  lapsed: 'You agreed to an earlier version of this line.',
  changed: 'This line changed since you marked it.',
  thread: 'An open discussion on this line waits on you.',
  unread: 'Nobody has marked this line.',
};

interface Bucket {
  line: number;
  entries: Array<{ kind: OpenKind; by: string | null; because: string }>;
  detached: boolean;
  agreedTo?: string;
  threadIds: string[];
  /** Mark ids already counted, so a thread does not count its own comment or suggestion twice. */
  markIds: Set<string>;
}

/**
 * THE definition of Open. Everything the product calls unsettled comes out of this one call.
 *
 * It never re-derives whether a thread is open: `threadOpenFor` answers that, and its `because` is
 * the sentence a row shows. It never re-derives whether a line Issue needs the viewer:
 * `issueNeedsViewer` (NEEDS_YOU_POLICY) answers that.
 */
export function openView(input: OpenViewInput): OpenView {
  const aliases = input.aliases ?? [];
  const lineCount = input.lineCount ?? Number.MAX_SAFE_INTEGER;
  const buckets = new Map<number, Bucket>();
  const bucket = (line: number): Bucket | null => {
    if (!Number.isInteger(line) || line < 0 || line >= lineCount) return null;
    let found = buckets.get(line);
    if (!found) {
      found = { line, entries: [], detached: false, threadIds: [], markIds: new Set() };
      buckets.set(line, found);
    }
    return found;
  };

  // ---- 1. The Issues that need the viewer (NEEDS_YOU_POLICY, unchanged). -------------------
  for (const issue of input.issues) {
    if (!issueNeedsViewer(issue, input.viewer, aliases)) continue;
    const kind = kindOfIssue(issue);
    if (!kind) continue;
    let line: number | null = 'lineIndex' in issue && typeof issue.lineIndex === 'number' ? issue.lineIndex : null;
    if (line === null && typeof issue.pos === 'number') {
      const at = input.lineAtPos(issue.pos);
      line = at >= 0 ? at : null;
    }
    if (line === null) continue;
    const at = bucket(line);
    if (!at) continue;
    const by = 'by' in issue && typeof issue.by === 'string' ? issue.by : null;
    at.entries.push({ kind, by, because: ISSUE_WORDS[kind] });
    if ('markId' in issue && typeof issue.markId === 'string') at.markIds.add(issue.markId);
  }

  // ---- 2. The lapse: the viewer agreed, then the meaning changed (brief 5). ------------------
  // A line Issue is already on the line (reason `changed`); this only gives it the truer word and
  // the wording the viewer agreed to, so the row can show both.
  const me = actorKey(input.viewer);
  const myKeys = new Set([me, ...aliases.map(actorKey)]);
  for (const state of input.states ?? []) {
    const at = buckets.get(state.line.index);
    if (!at) continue;
    for (const [key, entry] of state.marks) {
      if (!myKeys.has(key) || !entry.lapsed) continue;
      for (const row of at.entries) if (row.kind === 'changed') row.kind = 'lapsed';
      at.agreedTo = entry.lapsedFrom ?? at.agreedTo;
    }
  }

  // ---- 3. The threads that are open FOR THIS VIEWER (threadOpenFor decides, not this file). --
  for (const view of input.threads ?? []) {
    if (view.lineIndex === null) continue;
    const openness: ThreadOpenness = threadOpenFor(view, input.viewer, { team: input.team });
    if (!openness.open) continue;
    const at = bucket(view.lineIndex);
    if (!at) continue;
    at.threadIds.push(view.thread.id);
    if (openness.detached) at.detached = true;
    // A thread read from a comment or a suggestion mark is the SAME unsettled thing the ProofIssue
    // already counted; so is a detached thread, which src/ui/line-marks.ts feeds to computeIssues
    // as a review mark under the THREAD's id. One line, one row, one reason: merge, never
    // double-count.
    const markId = view.thread.markId;
    if (at.markIds.has(view.thread.id) || (markId && at.markIds.has(markId))) continue;
    at.markIds.add(view.thread.id);
    if (markId) at.markIds.add(markId);
    const kind: OpenKind = view.thread.diff ? 'suggestion' : 'thread';
    at.entries.push({ kind, by: view.thread.by || null, because: openness.because });
  }

  // ---- 4. Lines nobody has marked (OPEN_VIEW_POLICY.unreadLinesAreOpen; see there). ---------
  if (OPEN_VIEW_POLICY.unreadLinesAreOpen) {
    for (const state of input.states ?? []) {
      let read = false;
      for (const entry of state.marks.values()) {
        if (entry.current && countsAsSeen(entry.mark.status) && !entry.mark.hidden) { read = true; break; }
      }
      if (read) continue;
      const at = bucket(state.line.index);
      if (at && at.entries.length === 0) at.entries.push({ kind: 'unread', by: null, because: ISSUE_WORDS.unread });
    }
  }

  const items: OpenItem[] = [];
  for (const at of [...buckets.values()].sort((a, b) => a.line - b.line)) {
    if (at.entries.length === 0) continue;
    const sorted = [...at.entries].sort((a, b) => OPEN_KIND_ORDER.indexOf(a.kind) - OPEN_KIND_ORDER.indexOf(b.kind));
    const kinds = [...new Set(sorted.map(entry => entry.kind))];
    items.push({
      key: `open:${at.line}`,
      line: at.line,
      kinds,
      by: sorted[0].by,
      count: at.entries.length,
      because: sorted[0].because,
      detached: at.detached,
      ...(at.agreedTo ? { agreedTo: at.agreedTo } : {}),
      threadIds: at.threadIds,
    });
  }

  // `lines` and `count` are derived here and nowhere else. This is what makes the amber dots, the
  // Issues pill and the Open list unable to disagree.
  return { items, lines: items.map(item => item.line), count: items.length };
}

// ============================================================================
// The Accord view's honest header
// ============================================================================

export interface AccordReader {
  actor: string;
  /** They have current Agreed or Approved on every line of the document. */
  agreed: boolean;
  /** Every passage is Approved: the owner's ruling, named apart from agreement. */
  approved: boolean;
  /**
   * The first passage that is not a current Agreed or Approved mark (0-based). Null when every
   * passage is one of those two. This is the agreement gap. Where their reading stops is
   * `readingStopsAt`.
   */
  fromLine: number | null;
  /** The first unseen passage (0-based). Null when no passage is unseen. */
  readingStopsAt: number | null;
  /** No passage is Seen, Agreed, Rejected, Approved or lapsed. */
  nothing: boolean;
  /** Passages they rejected (0-based). The header links these. Empty when they rejected none. */
  rejectedLines: number[];
  /** Passages where they agreed to an earlier version (0-based). */
  lapsedLines: number[];
}

export interface AccordHeader {
  /** "Agreed by you and Izzy. Eric has not read from line 40 on." Empty when `settled`. */
  text: string;
  /** The "Agreed by" label, viewer first. Those who Approved every passage use "Approved by". */
  agreed: string[];
  /** Everyone who has Approved every passage, viewer first. Not the same list as `agreed`. */
  approved: string[];
  /** Everyone who has not agreed, with where they stop and what they rejected. */
  behind: AccordReader[];
  /**
   * Everyone has Agreed or Approved every line. The header goes away
   * and what is left is a clean document (brief 3 and 7: "when it is zero for EVERYONE, the
   * header goes too").
   */
  settled: boolean;
  /** Per person, for a caller that wants to draw its own thing. */
  readers: AccordReader[];
  /** The viewer's own row, so the zero moment can ask whether THEY have agreed. */
  viewerRow: AccordReader | null;
  /** The one computation this header was drawn from (src/shared/participant-status.ts). */
  status: DocumentStatus;
  /**
   * The sentences in `text`, split so a surface can link `lines`. A participant clause with a
   * rejection never says "has not read".
   */
  clauses: HeaderClause[];
}

/** An empty header, for a page that has not loaded a document yet. */
export function emptyAccordHeader(): AccordHeader {
  return {
    text: '',
    agreed: [],
    approved: [],
    behind: [],
    settled: false,
    readers: [],
    viewerRow: null,
    status: { aligned: false, agreed: false, participants: [] },
    clauses: [],
  };
}

/**
 * The honest header. It reads `participantStatus` (src/shared/participant-status.ts) and does not
 * decide a state of its own.
 *
 * Mike, 2026-09-23 (usability brief): the header never says someone "has not read it" when they
 * have a Rejected mark. It says how many lines they rejected. `clauses[].lines` and
 * `rejectedLines` are the passages a link points at. Seen is never listed under "Agreed by".
 * Approved is "Approved by" and counts as the owner's own agreement, not the team's.
 *
 * A line counts as agreed when that person's mark on it is current Agreed or Approved — a mark carried
 * over a cosmetic edit counts, a lapsed one does not (that is the point of the lapse rule).
 */
export function accordHeader(input: {
  states: readonly LineState[];
  team: readonly string[];
  viewer: string;
  /** How to name an actor to a person. The viewer is always "you". */
  name: (actor: string) => string;
  /** Open objections, so a Rejected mark that was stored as Seen still counts as Rejected. */
  objections?: readonly StatusObjection[];
}): AccordHeader {
  const status = participantStatus({ states: input.states, team: input.team, objections: input.objections });
  const header = statusHeader(status, input.viewer, input.name);
  const me = actorKey(input.viewer);
  const readers: AccordReader[] = header.readers.map(reader => ({
    actor: reader.actor,
    agreed: reader.agreed,
    approved: reader.approved,
    fromLine: reader.fromLine,
    readingStopsAt: reader.readingStopsAt,
    nothing: reader.nothing,
    rejectedLines: reader.rejectedLines,
    lapsedLines: reader.lapsedLines,
  }));
  return {
    text: header.text,
    agreed: header.agreedActors,
    approved: header.approvedActors,
    behind: readers.filter(reader => !reader.agreed),
    settled: header.settled,
    readers,
    viewerRow: readers.find(reader => actorKey(reader.actor) === me) ?? null,
    status,
    clauses: header.clauses,
  };
}

// ============================================================================
// The zero moment
// ============================================================================

export type AccordView = 'open' | 'accord';

export const ZERO_POLICY = {
  /** The words when the viewer is at zero but others are not. */
  forYou: 'You have finished reviewing.',
  /** The words when the document is settled for everyone. */
  forEveryone: 'Everyone has agreed.',
  /** Completion preserves controls; only explicitly choosing the agreed copy hides them. */
  zeroNeverStripsChrome: true,
  /** How long the band stays before it fades to the plain header (0: it stays). */
  bandMs: 0,
} as const;

export interface ZeroMoment {
  /** The viewer has agreed to every passage and has nothing open. */
  forViewer: boolean;
  /** Everyone has agreed to every line. The header goes too. */
  forEveryone: boolean;
  /** The one line the band says. Empty when there is no zero moment. */
  text: string;
  /** The view the document should be in. */
  view: AccordView;
  /**
   * Strip the chrome and read clean only when the reader explicitly chooses the agreed copy.
   * Explicit beats automatic: a view that removes controls is never entered on the page's say-so.
   */
  clean: boolean;
}

/** Completion reports status. The reader's chosen view is always preserved. */
export function zeroMoment(open: OpenView, header: AccordHeader, wanted: AccordView, chosen = false): ZeroMoment {
  const forViewer = open.count === 0 && Boolean(header.viewerRow?.agreed);
  const forEveryone = forViewer && header.settled;
  const view = wanted;
  return {
    forViewer,
    forEveryone,
    text: forEveryone ? ZERO_POLICY.forEveryone : forViewer ? ZERO_POLICY.forYou : '',
    view,
    clean: chosen && view === 'accord' && wanted === 'accord',
  };
}
