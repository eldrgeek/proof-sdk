/**
 * Accord round 2, stage D — threads live in the document, not the chat (pure code, shared by the
 * browser and the server).
 *
 * Mike, 2026-09-22: "Discussion is carried out inline in the document and not in the chat. A user
 * has two ways to foster a discussion: one is to edit inline with a proposal. The other is to start
 * a discussion thread. Maybe the hotkey T is used to start a thread. The subject of a thread is a
 * range of the document, or if a range is not selected, it is the line currently in focus." And:
 * "once agreement is reached the discussion should be visible only on request."
 *
 * ONE OBJECT. A thread is an anchored discussion with an optional proposal attached:
 *   - a thread that carries a diff is a PROPOSAL; it resolves by accept or reject;
 *   - a thread with no diff is a DISCUSSION; it resolves by agreement, or by someone attaching a
 *     wording — which makes it a proposal, and then it resolves by accept or reject;
 *   - the `?` clarify gesture (src/shared/clarify.ts) and the E key produce the same object, with
 *     `asks: 'clarify'`. It is still never an Issue for the asker and still never marks the line.
 *
 * NOTHING IS ORPHANED. Comments and suggestions already on Mike's live documents are read as
 * threads by `threadsFrom` — an adapter, not a migration. A comment with no stored thread row is a
 * thread that asks `comment` ("just a comment"); a suggestion with no row is a thread that asks
 * `accept-reject`. No stored data changes, and nothing has to be rewritten for this stage to ship.
 *
 * ANCHORING. A thread is anchored to one or more lines, by the same anchors line marks use
 * (src/shared/line-marks.ts) and the same re-find that keeps an objection on its lines
 * (src/shared/objections.ts refindLine). The rule this stage adds:
 *   - the anchored text is edited but survives  → the thread follows it;
 *   - the anchored text is deleted entirely     → the thread SURVIVES. It detaches to the nearest
 *     surviving line and says so at its head, quoting the original.
 * Deleting text never deletes an unresolved disagreement about it. A detached thread with an open
 * question is still an Issue for the people it was waiting on.
 *
 * Authorship: Mike Wolf (rulings), built by Claude Opus 5 (worker accord-threads), 2026-09-22.
 */
import {
  actorKey,
  anchorForLine,
  anchorText,
  isAiActor,
  type DocLine,
  type LineAnchor,
} from './line-marks.js';
import { refindLine, slotOf } from './objections.js';

// ============================================================================
// What a thread is
// ============================================================================

/** A thread with a diff is a proposal; one without is a discussion. */
export type ThreadKind = 'discussion' | 'proposal';

/**
 * What would close this thread. Every thread carries one and shows it at its head. A thread that
 * cannot say what would close it is a comment, not a disagreement — so `comment` is an explicit
 * choice, never an empty state.
 *
 * `clarify` is not offered when a person starts a thread: it is what the `?` gesture and the E key
 * produce (a question for the document's AIs).
 */
export type ThreadAsks = 'wording' | 'yes-no' | 'answer' | 'accept-reject' | 'comment' | 'clarify';

export const THREAD_ASKS: readonly ThreadAsks[] = ['wording', 'yes-no', 'answer', 'accept-reject', 'comment', 'clarify'];

/** The choices offered when a person starts a thread, in the order they are shown. */
export const THREAD_ASK_CHOICES: readonly ThreadAsks[] = ['accept-reject', 'wording', 'yes-no', 'answer', 'comment'];

/** The closing condition in the words shown at the thread's head. */
export const THREAD_ASK_LABEL: Record<ThreadAsks, string> = {
  wording: 'pick one wording',
  'yes-no': 'yes or no',
  answer: 'someone answers',
  'accept-reject': 'accept or reject',
  comment: 'just a comment',
  clarify: 'an AI answers this',
};

/** One line of help under each choice, so the chooser knows what they are promising. */
export const THREAD_ASK_HELP: Record<ThreadAsks, string> = {
  wording: 'Closes when the people here settle on one wording.',
  'yes-no': 'Closes when everyone it names has said yes or no.',
  answer: 'Closes when anyone answers it.',
  'accept-reject': 'Closes when the change is accepted or rejected.',
  comment: 'Nothing has to happen. It is not a disagreement and it is nobody’s Issue.',
  clarify: 'Closes when one of the document’s AIs answers.',
};

export type ThreadStatus = 'open' | 'resolved' | 'accepted' | 'rejected' | 'withdrawn';

/** Where the object came from. Everything but `thread` is read through the adapter. */
export type ThreadSource = 'thread' | 'comment' | 'suggestion' | 'explain' | 'chat';

export interface ThreadReply {
  by: string;
  text: string;
  at: string;
}

/** The proposal a thread carries. `kind` matches the suggestion marks already in the document. */
export interface ThreadDiff {
  kind: 'replace' | 'insert' | 'delete';
  /** The text the proposal is about (what a `replace` or `delete` would remove). */
  quote: string;
  /** The proposed wording (null for a delete). */
  content: string | null;
  /** The review mark this diff is, when it is one (a suggestion already in the document). */
  markId?: string | null;
  /** When the proposal is a move (step 6): its title, 'Moves "X" to after "Y"'. One thread stands for
   * the move's two records; its markId is the remove record, which decides the whole move. */
  move?: string;
}

/** One anchored line: what it was, where it was last found, and its neighbours (its slot). */
export interface ThreadAnchorLine {
  /** The line as it was when the thread was started. */
  original: LineAnchor;
  /** Where the line was last found (re-anchored when the server or the page re-reads). */
  current: LineAnchor;
  before?: string | null;
  after?: string | null;
  /** Set the first time the line is found gone. */
  deletedAt?: string | null;
}

export interface Thread {
  id: string;
  by: string;
  /** Derived from `diff`, but stored so a reader of the raw data does not have to derive it. */
  kind: ThreadKind;
  asks: ThreadAsks;
  /** The opening message. */
  text: string;
  /** The lines the thread is about, in document order. */
  anchor: ThreadAnchorLine[];
  /** Exactly what was selected, when a range inside one line was the subject. */
  selection: string | null;
  diff: ThreadDiff | null;
  replies: ThreadReply[];
  status: ThreadStatus;
  /** Who the thread waits on. Empty means everyone but the author. */
  waitingOn: string[];
  createdAt: string;
  closedAt: string | null;
  closedBy: string | null;
  source: ThreadSource;
  /** The review mark this thread is (a comment or a suggestion), when it is one. */
  markId: string | null;
  /** The chat message this thread was read from, when the Room is where it was said. */
  chatMessageId?: number | null;
}

// ============================================================================
// POLICY (decisions where Mike's words are silent; each is a one-line change)
// ============================================================================

export const THREAD_POLICY = {
  /** `T` starts a thread on the selection, or on the cursor line when nothing is selected. */
  key: 't',
  /**
   * T is already a reading command: it answers "Not yet" to an ask on the focus line
   * (ASK_POLICY.keys.not_yet), and it only ever did anything when the line carried an ask. That
   * meaning is KEPT: on a line with an ask, T still answers Not yet. Everywhere else — which is
   * every line that has no ask, i.e. almost all of them — T now starts a thread.
   */
  askAnswerWins: true,
  /** A thread must say what would close it: the composer refuses an empty choice. */
  closingConditionRequired: true,
  /** What a thread defaults to when it is started with a diff attached. */
  defaultForProposal: 'accept-reject' as ThreadAsks,
  /** ...and with no diff. */
  defaultForDiscussion: 'answer' as ThreadAsks,
  /** A comment already on a document, with no stored closing condition, reads as this. */
  legacyCommentAsks: 'comment' as ThreadAsks,
  /** A suggestion already on a document reads as this. */
  legacySuggestionAsks: 'accept-reject' as ThreadAsks,
  /** Guests may comment, so a guest may start a discussion — but not one that edits text. */
  guestsMayDiscuss: true,
  guestsMayPropose: false,
  /** A `comment` thread is never an Issue for anybody (it is not a disagreement). */
  commentIsIssue: false,
  /** A `clarify` thread is never an Issue for the asker, and never marks the line (EXPLAIN_POLICY). */
  clarifyIsIssueForAsker: false,
  clarifyMarksLine: false,
  /** A resolved thread folds away and leaves a mark on its line that reopens the history. */
  resolvedFolds: true,
  /** The head of a detached thread. */
  detachedNotice: 'the text this was about has changed',
  /** Longest opening message and reply. */
  maxText: 4000,
  /** Most lines one thread may be anchored to. */
  maxLines: 50,
  /** Characters of the original quoted at a detached thread's head. */
  maxQuote: 300,
} as const;

// ============================================================================
// Reading what is already there (the adapter — NOT a migration)
// ============================================================================

/** A comment or suggestion mark, in the shape both the page and the server already have one. */
export interface ThreadSourceMark {
  id: string;
  kind: string;
  by?: string | null;
  at?: string | null;
  quote?: string | null;
  range?: { from: number; to: number } | null;
  pos?: number | null;
  text?: string | null;
  content?: string | null;
  replies?: Array<{ by?: string | null; text?: string | null; at?: string | null }>;
  resolved?: boolean;
  status?: string | null;
  orphaned?: boolean;
  /** Set on the two records of a move (src/shared/moves.ts); only the title is read here. */
  move?: { role: 'remove' | 'insert'; spec?: { title?: string } } | null;
}

/** The row stored beside the document for a thread a person started (server/proof-extras-store). */
export interface ThreadMeta {
  id: string;
  markId: string | null;
  by: string;
  asks: ThreadAsks;
  /**
   * The thread's opening words, kept here as well as on its mark. Deleting the text a thread sits
   * on can take the mark with it; the disagreement, and what it said, must survive that.
   */
  text: string;
  anchor: ThreadAnchorLine[];
  selection: string | null;
  waitingOn: string[];
  status: ThreadStatus;
  createdAt: string;
  closedAt: string | null;
  closedBy: string | null;
  /** The chat message this thread was made from, when it was moved out of the Room. */
  chatMessageId?: number | null;
  /**
   * Accord round 2 stage C: the thread's replies, kept HERE as well as on its mark. Deleting the
   * text a thread sits on takes the mark with it; the thread survives because its words are on
   * this row, and now so does its discussion. Older rows have none and read as an empty list.
   */
  replies?: ThreadReply[];
}

/** An Explain row (src/shared/explain.ts and the `?` gesture): its comment is a clarify thread. */
export interface ThreadExplainRow {
  id: string;
  by: string;
  commentMarkId: string | null;
  question: string;
  createdAt: string;
}

export interface ThreadInput {
  /** Every comment and suggestion mark on the document now. */
  marks?: readonly ThreadSourceMark[];
  /** Stored thread rows, keyed by their mark id (or standing alone when they have none). */
  meta?: readonly ThreadMeta[];
  /** Explain rows: a comment named by one asks `clarify`. */
  explains?: readonly ThreadExplainRow[];
  lines: DocLine[];
  /** The line a mark sits on, when the caller knows positions (the page does; the server matches quotes). */
  lineOf?: (mark: ThreadSourceMark) => number | null;
}

function replyList(mark: ThreadSourceMark): ThreadReply[] {
  return (mark.replies ?? [])
    .filter(reply => reply && typeof reply.text === 'string' && reply.text.length > 0)
    .map(reply => ({ by: String(reply.by ?? ''), text: String(reply.text), at: String(reply.at ?? '') }));
}

/** One reply twice (once on the mark, once on the row) is one reply. Ordered by time, then text. */
export function mergeReplies(a: readonly ThreadReply[], b: readonly ThreadReply[]): ThreadReply[] {
  const seen = new Set<string>();
  const out: ThreadReply[] = [];
  for (const reply of [...a, ...b]) {
    if (!reply || typeof reply.text !== 'string' || !reply.text) continue;
    const key = `${actorKey(String(reply.by ?? ''))}|${String(reply.text)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ by: String(reply.by ?? ''), text: String(reply.text), at: String(reply.at ?? '') });
  }
  return out.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
}

function diffOf(mark: ThreadSourceMark): ThreadDiff | null {
  if (mark.kind !== 'insert' && mark.kind !== 'delete' && mark.kind !== 'replace') return null;
  if (mark.move) return { kind: 'delete', quote: String(mark.quote ?? ''), content: null, markId: mark.id, move: String(mark.move.spec?.title ?? 'Moves an item') };
  return {
    kind: mark.kind,
    quote: String(mark.quote ?? ''),
    content: mark.kind === 'delete' ? null : String(mark.content ?? ''),
    markId: mark.id,
  };
}

function statusOf(mark: ThreadSourceMark): ThreadStatus {
  if (mark.kind === 'comment') return mark.resolved ? 'resolved' : 'open';
  if (mark.status === 'accepted') return 'accepted';
  if (mark.status === 'rejected') return 'rejected';
  return 'open';
}

/** The anchor a mark implies: the line it sits on now (the only anchor a legacy mark can give). */
function anchorFromMark(mark: ThreadSourceMark, input: ThreadInput): ThreadAnchorLine[] {
  const index = input.lineOf ? input.lineOf(mark) : null;
  const line = index !== null && index >= 0 ? input.lines[index] : undefined;
  if (!line) return [];
  const anchor = anchorForLine(line);
  return [{ original: anchor, current: anchor, ...slotOf(input.lines, line.index) }];
}

/**
 * Every thread on the document: the ones stored as threads, plus every comment and suggestion read
 * as one. Deterministic order: by creation time, then id.
 *
 * Nothing already on a document is left out, and nothing about it is rewritten. A comment with no
 * stored row keeps its text, its replies and its resolved flag and simply reads as a thread that
 * asks `comment`.
 */
export function threadsFrom(input: ThreadInput): Thread[] {
  const metaByMark = new Map<string, ThreadMeta>();
  const standalone: ThreadMeta[] = [];
  for (const row of input.meta ?? []) {
    if (row.markId) metaByMark.set(row.markId, row);
    else standalone.push(row);
  }
  const explainByMark = new Map<string, ThreadExplainRow>();
  for (const row of input.explains ?? []) {
    if (row.commentMarkId) explainByMark.set(row.commentMarkId, row);
  }

  const out: Thread[] = [];
  for (const mark of input.marks ?? []) {
    if (mark.kind !== 'comment' && mark.kind !== 'insert' && mark.kind !== 'delete' && mark.kind !== 'replace') continue;
    // A move is one proposal: its remove record stands for it, so the insert record makes no thread.
    if (mark.move?.role === 'insert') continue;
    const meta = metaByMark.get(mark.id) ?? null;
    const explain = explainByMark.get(mark.id) ?? null;
    const diff = diffOf(mark);
    const asks: ThreadAsks = meta?.asks
      ?? (explain ? 'clarify' : diff ? THREAD_POLICY.legacySuggestionAsks : THREAD_POLICY.legacyCommentAsks);
    const source: ThreadSource = meta ? 'thread' : explain ? 'explain' : diff ? 'suggestion' : 'comment';
    const markStatus = statusOf(mark);
    // The mark is the truth about accept/reject and resolve: a stored row never keeps a thread
    // "open" after its suggestion was accepted.
    const status: ThreadStatus = markStatus !== 'open' ? markStatus : (meta?.status ?? 'open');
    out.push({
      id: meta?.id ?? mark.id,
      by: String(meta?.by ?? mark.by ?? ''),
      kind: diff ? 'proposal' : 'discussion',
      asks,
      text: String(mark.text ?? meta?.text ?? explain?.question ?? ''),
      anchor: meta?.anchor?.length ? meta.anchor : anchorFromMark(mark, input),
      selection: meta?.selection ?? (diff ? diff.quote : null),
      diff,
      // The mark is the live history while it exists; the row's copy is a SHADOW that only
      // surfaces once the mark is gone (see ThreadMeta.replies). Merging the two would double every
      // reply, because the page writes the mark copy under the editor's actor and the row copy
      // under the actor the server resolves for the page-aid route.
      replies: replyList(mark).length ? replyList(mark) : mergeReplies([], meta?.replies ?? []),
      status,
      waitingOn: meta?.waitingOn ?? [],
      createdAt: String(meta?.createdAt ?? mark.at ?? ''),
      closedAt: meta?.closedAt ?? null,
      closedBy: meta?.closedBy ?? null,
      source,
      markId: mark.id,
      chatMessageId: meta?.chatMessageId ?? null,
    });
  }

  // Thread rows whose mark is gone (or that never had one): they still exist, and they still say
  // what they were about. A deleted comment mark must not take an open disagreement with it.
  for (const row of [...standalone, ...metaByMark.values()]) {
    if (row.markId && out.some(thread => thread.markId === row.markId)) continue;
    out.push({
      id: row.id,
      by: row.by,
      kind: 'discussion',
      asks: row.asks,
      text: row.text ?? '',
      anchor: row.anchor ?? [],
      selection: row.selection,
      diff: null,
      // The mark is gone (or never existed); the row's own replies are the whole history.
      replies: mergeReplies([], row.replies ?? []),
      status: row.status,
      waitingOn: row.waitingOn ?? [],
      createdAt: row.createdAt,
      closedAt: row.closedAt,
      closedBy: row.closedBy,
      source: 'thread',
      markId: row.markId,
      chatMessageId: row.chatMessageId ?? null,
    });
  }

  return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ============================================================================
// Anchoring: following an edit, detaching from a deletion
// ============================================================================

export interface ThreadView {
  thread: Thread;
  /** The lines the thread is anchored to now, in document order (empty when every one is gone). */
  lineIndices: number[];
  /**
   * The line the thread shows on: its first surviving anchored line, or — when they are all gone —
   * the nearest surviving line, which is what "detached" means. Null only in an empty document.
   */
  lineIndex: number | null;
  pos: number | null;
  /** Every anchored line was deleted: the thread detached and says so at its head. */
  detached: boolean;
  /** An anchored line survived but its text changed: the thread followed it. */
  changed: boolean;
  /** How many anchored lines are gone. */
  deletedLines: number;
  /** What the thread was about, quoted (the head shows this when detached). */
  originalQuote: string;
  /** The author first, then everyone who replied, de-duplicated by actor key. */
  voices: string[];
  /** status === 'open'. */
  open: boolean;
}

/** The text a thread was started about: its selection, else its anchored lines joined. */
export function threadQuote(thread: Thread): string {
  if (thread.selection) return thread.selection.slice(0, THREAD_POLICY.maxQuote);
  const parts = thread.anchor.map(line => anchorText(line.original) ?? line.original.excerpt ?? '').filter(Boolean);
  return parts.join(' ').slice(0, THREAD_POLICY.maxQuote);
}

/** The surviving line nearest to where the thread used to be (what a detached thread attaches to). */
export function nearestSurvivingLine(lines: DocLine[], ordinal: number): number | null {
  if (lines.length === 0) return null;
  const clamped = Math.max(0, Math.min(lines.length - 1, ordinal));
  return lines[clamped] ? clamped : lines.length - 1;
}

/**
 * Where a thread sits now. Exact matches are claimed first, so a rewritten line cannot take a line
 * another anchored line still is.
 */
export function evaluateThread(thread: Thread, lines: DocLine[]): ThreadView {
  const claimed = new Set<number>();
  const found: Array<number | null> = thread.anchor.map(() => null);
  thread.anchor.forEach((line, i) => {
    const exact = refindLine(lines.filter(l => l.hash === line.current.hash), line.current, claimed);
    if (exact) { found[i] = exact.lineIndex; claimed.add(exact.lineIndex); }
  });
  let changed = false;
  thread.anchor.forEach((line, i) => {
    if (found[i] !== null) return;
    const slot = { before: line.before ?? null, after: line.after ?? null };
    const hit = refindLine(lines, line.current, claimed, slot)
      ?? (line.current.hash !== line.original.hash ? refindLine(lines, line.original, claimed, slot) : null);
    // Found, but not by its exact text: the anchored text was edited and survived. The thread
    // follows it, and says the line changed.
    if (hit) { found[i] = hit.lineIndex; claimed.add(hit.lineIndex); changed = true; }
  });

  const lineIndices = found.filter((index): index is number => index !== null).sort((a, b) => a - b);
  const deletedLines = found.length - lineIndices.length;
  // Every anchored line is gone (or the thread never had an anchor): detach, do not delete.
  const detached = lineIndices.length === 0;
  const ordinal = thread.anchor[0]?.current.ordinal ?? thread.anchor[0]?.original.ordinal ?? 0;
  const lineIndex = detached ? nearestSurvivingLine(lines, ordinal) : lineIndices[0];
  const voices: string[] = [];
  for (const actor of [thread.by, ...thread.replies.map(reply => reply.by)]) {
    if (actor && !voices.some(seen => actorKey(seen) === actorKey(actor))) voices.push(actor);
  }
  return {
    thread,
    lineIndices,
    lineIndex,
    pos: lineIndex !== null ? lines[lineIndex]?.pos ?? null : null,
    detached,
    changed,
    deletedLines,
    originalQuote: threadQuote(thread),
    voices,
    open: thread.status === 'open',
  };
}

export function evaluateThreads(input: ThreadInput): ThreadView[] {
  return threadsFrom(input).map(thread => evaluateThread(thread, input.lines));
}

/** Re-anchors a thread to where it is now, so the next read starts from the current text. */
export function reanchorThread(thread: Thread, view: ThreadView, lines: DocLine[], now: string): ThreadAnchorLine[] {
  let at = 0;
  return thread.anchor.map((anchored) => {
    const index = view.lineIndices[at];
    const line = index === undefined ? undefined : lines[index];
    if (!line) return { ...anchored, deletedAt: anchored.deletedAt ?? now };
    at += 1;
    return { original: anchored.original, current: anchorForLine(line), ...slotOf(lines, line.index), deletedAt: null };
  });
}

/** The sentence a detached thread shows at its head. */
export function detachedNotice(view: ThreadView): string {
  if (!view.detached) return '';
  const quote = view.originalQuote;
  return quote
    ? `${THREAD_POLICY.detachedNotice}: “${quote}”`
    : THREAD_POLICY.detachedNotice;
}

// ============================================================================
// Is this thread open for this viewer, and why
// ============================================================================

export type ThreadOpenReason =
  /** A proposal waiting on this viewer to accept or reject it. */
  | 'accept-or-reject'
  /** A yes-or-no this viewer has not answered. */
  | 'yes-or-no'
  /** Competing wordings this viewer has not picked among. */
  | 'pick-a-wording'
  /** A question nobody has answered yet. */
  | 'answer-this'
  /** It was answered; the person who asked closes it. */
  | 'close-yours'
  /** A clarify question waiting on one of the document's AIs. */
  | 'clarify'
  /** The text it was about is gone and the question is still open. */
  | 'detached';

export interface ThreadOpenness {
  /** Is this thread unsettled FOR THIS VIEWER? */
  open: boolean;
  /** Why, in one word for code. Null when it is not open for them. */
  why: ThreadOpenReason | null;
  /** Why, in one sentence for a person. Always set. */
  because: string;
  /** Who the thread is waiting on now (actors, as stored). */
  waitingOn: string[];
  /** The text it was about is gone (the head says so, and the reason becomes `detached`). */
  detached: boolean;
  /** What would close it, in the words shown at its head. */
  closes: string;
}

function hasSpoken(view: ThreadView, viewer: string): boolean {
  const me = actorKey(viewer);
  return view.thread.replies.some(reply => actorKey(reply.by) === me);
}

function isAuthor(view: ThreadView, viewer: string): boolean {
  return actorKey(view.thread.by) === actorKey(viewer);
}

function answeredBySomeoneElse(view: ThreadView): boolean {
  const author = actorKey(view.thread.by);
  return view.thread.replies.some(reply => actorKey(reply.by) !== author);
}

/**
 * Is this thread open for this viewer, and why.
 *
 * This is the one answer the Open list is built on (stage accord/open-view): call it per thread per
 * viewer and show every `open: true` with its `because`. It is pure and cheap; it reads nothing but
 * the view, the viewer and (optionally) the team.
 *
 * `options.team` is only needed to decide a `yes-no` thread that names nobody: without it, such a
 * thread is open for every viewer who is not its author and has not replied, which is the same
 * answer the team list would give for anyone actually on the team.
 */
export function threadOpenFor(view: ThreadView, viewer: string, options: { team?: readonly string[] } = {}): ThreadOpenness {
  const thread = view.thread;
  const closes = THREAD_ASK_LABEL[thread.asks];
  const named = thread.waitingOn.length ? thread.waitingOn : null;
  const waitingOn = named ?? (options.team ? options.team.filter(actor => actorKey(actor) !== actorKey(thread.by)) : []);
  const shut = (because: string): ThreadOpenness =>
    ({ open: false, why: null, because, waitingOn: [], detached: view.detached, closes });

  if (thread.status !== 'open') {
    const words: Record<Exclude<ThreadStatus, 'open'>, string> = {
      resolved: 'Resolved.',
      accepted: 'The change was accepted.',
      rejected: 'The change was rejected.',
      withdrawn: 'Withdrawn by whoever started it.',
    };
    return shut(words[thread.status as Exclude<ThreadStatus, 'open'>]);
  }

  // "Just a comment" is not a disagreement: it is nobody's Issue, and deleting the text it sits on
  // takes nothing unsettled with it.
  if (thread.asks === 'comment' && !THREAD_POLICY.commentIsIssue) {
    return shut('Just a comment — nothing has to happen.');
  }

  // Clarify: the document's AIs answer it. Never the asker's Issue (EXPLAIN_POLICY agrees).
  if (thread.asks === 'clarify') {
    if (isAuthor(view, viewer) && !THREAD_POLICY.clarifyIsIssueForAsker) return shut('You asked this. Waiting on an AI to answer.');
    if (answeredBySomeoneElse(view)) return shut('An answer is on the thread.');
    if (!isAiActor(viewer)) return shut('Waiting on one of this document’s AIs.');
    return { open: true, why: view.detached ? 'detached' : 'clarify', because: view.detached ? detachedNotice(view) : 'You were asked to explain this.', waitingOn, detached: view.detached, closes };
  }

  const namedAndNotMe = named !== null && !named.some(actor => actorKey(actor) === actorKey(viewer));
  if (namedAndNotMe && !isAuthor(view, viewer)) return shut('This one names other people.');

  let why: ThreadOpenReason | null = null;
  let because = '';
  switch (thread.asks) {
    case 'accept-reject':
      // A proposal waits on everyone but its author until it is accepted or rejected.
      if (isAuthor(view, viewer)) { because = 'Your proposal. Waiting on someone to accept or reject it.'; break; }
      why = 'accept-or-reject';
      because = 'A proposed change waits on you: accept it or reject it.';
      break;
    case 'yes-no':
      if (isAuthor(view, viewer)) { because = 'You asked this. Waiting on a yes or a no.'; break; }
      if (hasSpoken(view, viewer)) { because = 'You answered this.'; break; }
      why = 'yes-or-no';
      because = 'This asks you for a yes or a no.';
      break;
    case 'wording':
      if (hasSpoken(view, viewer)) { because = 'You have said which wording you want.'; break; }
      why = 'pick-a-wording';
      because = 'Competing wordings, and you have not picked one.';
      break;
    case 'answer':
      // One answer closes it — for everyone but the person who asked, who then closes it.
      if (answeredBySomeoneElse(view)) {
        if (!isAuthor(view, viewer)) { because = 'Answered. Waiting on whoever asked to close it.'; break; }
        why = 'close-yours';
        because = 'Your question was answered. Close it, or ask again.';
        break;
      }
      if (isAuthor(view, viewer)) { because = 'You asked this. Waiting on an answer.'; break; }
      why = 'answer-this';
      because = 'A question nobody has answered.';
      break;
    default:
      because = 'Nothing has to happen.';
      break;
  }

  if (!why) return shut(because);
  // Deleting the text never closes a question. A detached thread with an open question stays an
  // Issue for the people it was waiting on, and says why it moved.
  if (view.detached) return { open: true, why: 'detached', because: `${detachedNotice(view)} — ${because}`, waitingOn, detached: true, closes };
  return { open: true, why, because, waitingOn, detached: false, closes };
}

/** Every thread that is open for this viewer, in document order. */
export function openThreadsFor(views: readonly ThreadView[], viewer: string, options: { team?: readonly string[] } = {}): Array<{ view: ThreadView; openness: ThreadOpenness }> {
  return views
    .map(view => ({ view, openness: threadOpenFor(view, viewer, options) }))
    .filter(entry => entry.openness.open)
    .sort((a, b) => (a.view.lineIndex ?? Number.MAX_SAFE_INTEGER) - (b.view.lineIndex ?? Number.MAX_SAFE_INTEGER));
}

// ============================================================================
// Resolving, folding, and who may do what
// ============================================================================

/** The resolutions a thread offers, in the order they are shown. */
export function resolutionsFor(thread: Thread): Array<{ status: ThreadStatus; label: string }> {
  if (thread.diff) {
    return [{ status: 'accepted', label: 'Accept' }, { status: 'rejected', label: 'Reject' }];
  }
  if (thread.asks === 'comment') return [{ status: 'resolved', label: 'Done' }];
  return [{ status: 'resolved', label: 'Agreed' }, { status: 'withdrawn', label: 'Withdraw' }];
}

/**
 * May this viewer close the thread? Whoever started it always may; an Owner may; and for a thread
 * that asks the room ("someone answers", "yes or no", "pick one wording") anyone it waits on
 * may, because agreement is what closes it.
 */
export function canResolveThread(view: ThreadView, viewer: string, options: { isOwner?: boolean; team?: readonly string[] } = {}): boolean {
  if (view.thread.status !== 'open') return false;
  if (options.isOwner) return true;
  if (isAuthor(view, viewer)) return true;
  // "Just a comment" is nobody's disagreement: anyone reading it may mark it done, which is how a
  // comment thread has always closed.
  if (view.thread.asks === 'comment') return true;
  if (view.thread.diff) return true; // accepting or rejecting a proposal is everyone's to do
  return threadOpenFor(view, viewer, { team: options.team }).open;
}

/** A guest (a typed name, not a verified identity) may discuss but may not propose an edit. */
export function guestMayStart(kind: ThreadKind): boolean {
  return kind === 'proposal' ? THREAD_POLICY.guestsMayPropose : THREAD_POLICY.guestsMayDiscuss;
}

/**
 * The fold. A resolved thread folds away for the viewer who closed it and leaves a mark on its
 * line; clicking the mark opens the history. This is the same shape src/shared/closed-fold.ts uses
 * (a closure kind per thread), so the page has one kind of fold, not two.
 */
export function threadClosureKind(thread: Thread): 'accepted' | 'suggestion-rejected' | 'resolved' | null {
  if (thread.status === 'accepted') return 'accepted';
  if (thread.status === 'rejected') return 'suggestion-rejected';
  if (thread.status === 'resolved' || thread.status === 'withdrawn') return 'resolved';
  return null;
}

/** Does this thread fold for this viewer now? (Mike: a thread the viewer closed folds for them.) */
export function threadFoldsFor(view: ThreadView, viewer: string): boolean {
  if (!THREAD_POLICY.resolvedFolds) return false;
  if (view.thread.status === 'open') return false;
  const closedBy = view.thread.closedBy;
  return !closedBy || actorKey(closedBy) === actorKey(viewer);
}

/** The one-line summary the folded mark shows ("✓ agreed — 3 replies"). */
export function foldedThreadSummary(view: ThreadView): string {
  const label = view.thread.status === 'accepted' ? '✓ change accepted'
    : view.thread.status === 'rejected' ? '✗ change rejected'
    : view.thread.status === 'withdrawn' ? '✗ withdrawn'
    : '✓ resolved';
  const n = view.thread.replies.length;
  return n ? `${label} — ${n} ${n === 1 ? 'reply' : 'replies'}` : label;
}

// ============================================================================
// The Room keeps only what is about no line
// ============================================================================

/** The part of a chat message that decides whether it belongs to the Room or to a line. */
export interface RoomMessageLike {
  lines?: unknown[] | null;
  commentMarkId?: string | null;
  suggestion?: unknown | null;
}

/**
 * True when a chat message is about no line, so the Room keeps it: people, invitations, joins and
 * document-level events. A message that points at a line, mirrors a comment thread or carries a
 * suggestion is talk about text — it belongs to the document, as a thread on its line.
 *
 * Nothing is deleted: a message that fails this test is still stored, still returned by GET /chat,
 * and still readable in the Room under "about the text" (folded), as well as on its line.
 */
export function roomKeeps(message: RoomMessageLike): boolean {
  if (Array.isArray(message.lines) && message.lines.length > 0) return false;
  if (message.commentMarkId) return false;
  if (message.suggestion) return false;
  return true;
}

/** The messages the Room shows, and the line talk it folds away. */
export function splitRoom<T extends RoomMessageLike>(messages: readonly T[]): { room: T[]; lineTalk: T[] } {
  const room: T[] = [];
  const lineTalk: T[] = [];
  for (const message of messages) (roomKeeps(message) ? room : lineTalk).push(message);
  return { room, lineTalk };
}

// ============================================================================
// Starting one
// ============================================================================

export interface StartThreadInput {
  by: string;
  /** The lines the selection covers, in document order. One line when nothing is selected. */
  lines: DocLine[];
  /** All the document's lines (for the slots). */
  doc: DocLine[];
  asks: ThreadAsks;
  text: string;
  selection?: string | null;
  diff?: ThreadDiff | null;
  waitingOn?: string[];
  at?: string;
  id?: string;
  markId?: string | null;
}

export function cleanThreadText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, THREAD_POLICY.maxText);
}

export function isThreadAsks(value: unknown): value is ThreadAsks {
  return typeof value === 'string' && (THREAD_ASKS as readonly string[]).includes(value);
}

/** The closing condition a new thread defaults to. */
export function defaultAsksFor(kind: ThreadKind): ThreadAsks {
  return kind === 'proposal' ? THREAD_POLICY.defaultForProposal : THREAD_POLICY.defaultForDiscussion;
}

/** The anchors a thread on these line indices carries (the page builds them from its own lines). */
export function anchorsForThread(lines: DocLine[], indices: readonly number[]): ThreadAnchorLine[] {
  return [...new Set(indices)].sort((a, b) => a - b).slice(0, THREAD_POLICY.maxLines)
    .map(index => lines[index])
    .filter((line): line is DocLine => Boolean(line))
    .map(line => {
      const anchor = anchorForLine(line);
      return { original: anchor, current: anchor, ...slotOf(lines, line.index), deletedAt: null };
    });
}

let threadCounter = 0;

export function newThreadId(): string {
  threadCounter += 1;
  return `th-${Date.now().toString(36)}-${threadCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Builds a thread from what the page knows. Pure: the caller stores it. */
export function startThread(input: StartThreadInput): Thread {
  const at = input.at ?? new Date().toISOString();
  const anchor: ThreadAnchorLine[] = input.lines.slice(0, THREAD_POLICY.maxLines).map(line => {
    const a = anchorForLine(line);
    return { original: a, current: a, ...slotOf(input.doc, line.index), deletedAt: null };
  });
  const diff = input.diff ?? null;
  return {
    id: input.id ?? newThreadId(),
    by: input.by,
    kind: diff ? 'proposal' : 'discussion',
    asks: isThreadAsks(input.asks) ? input.asks : defaultAsksFor(diff ? 'proposal' : 'discussion'),
    text: cleanThreadText(input.text),
    anchor,
    selection: input.selection ?? null,
    diff,
    replies: [],
    status: 'open',
    waitingOn: input.waitingOn ?? [],
    createdAt: at,
    closedAt: null,
    closedBy: null,
    source: 'thread',
    markId: input.markId ?? null,
  };
}

/** The thread meta row to store beside the document (everything the mark cannot carry). */
export function threadMetaOf(thread: Thread): ThreadMeta {
  return {
    id: thread.id,
    markId: thread.markId,
    by: thread.by,
    asks: thread.asks,
    text: thread.text,
    anchor: thread.anchor,
    selection: thread.selection,
    waitingOn: thread.waitingOn,
    status: thread.status,
    createdAt: thread.createdAt,
    closedAt: thread.closedAt,
    closedBy: thread.closedBy,
    chatMessageId: thread.chatMessageId ?? null,
    replies: thread.replies ?? [],
  };
}

/** Threads by the line they sit on now (a detached thread sits on the line it detached to). */
export function threadsByLine(views: readonly ThreadView[]): Map<number, ThreadView[]> {
  const out = new Map<number, ThreadView[]>();
  for (const view of views) {
    if (view.lineIndex === null) continue;
    const list = out.get(view.lineIndex) ?? [];
    list.push(view);
    out.set(view.lineIndex, list);
  }
  return out;
}
