/**
 * Accord participant status — one computation for every surface.
 *
 * Mike, 2026-09-23 (usability brief): one module computes each participant's state per passage
 * and per document. The server's /state, the honest header, and (later) the status bar, the
 * Review count, People and the agreed-copy gate all read this file. They do not each decide.
 *
 * The words are the spec's words. Stored mark values are not renamed.
 *   unseen   — no current mark that counts as Seen (the interface may say "not read yet")
 *   Seen     — the passage was read. Seen is not agreement.
 *   Agreed   — this participant endorses the current wording.
 *   Rejected — unresolved disagreement, with its reason and its resolution condition.
 *              A person with a Rejected mark has read the text.
 *   Approved — the owner's ruling, including that owner's own agreement, not the team's.
 *   lapsed   — "agreed to an earlier version": an Agreed or Approved mark whose line changed
 *              in substance (src/shared/line-marks.ts, lapseSubstantiveEdits).
 *
 * Aligned means every participant has seen every passage and nobody rejects the current text.
 * Agreed means every participant has Agreed or Approved every passage. Aligned is weaker.
 * Approved stays a distinct state and never supplies another participant's agreement.
 * A zero-issue report (`alignment.aligned` on /state) stays that other fact: this module
 * does not replace it.
 */
import { actorKey, type LineMarkEntry, type LineState } from './line-marks.js';

export type ParticipantState = 'unseen' | 'seen' | 'agreed' | 'rejected' | 'approved' | 'lapsed';

export const PARTICIPANT_STATUS_POLICY = {
  /** Interface words. The stored status strings stay seen | agreed | approved | rejected | skimmed. */
  words: {
    unseen: 'unseen',
    seen: 'Seen',
    agreed: 'Agreed',
    rejected: 'Rejected',
    approved: 'Approved',
    lapsed: 'agreed to an earlier version',
  },
  /** The interface may say this where it would otherwise say "unseen". */
  unseenMaySay: 'not read yet',
  /**
   * A personal review is finished when every passage is one of these, current, on the wording
   * as it reads now. Seen is a record of reading, not a finished review.
   */
  decisions: ['agreed', 'rejected', 'approved'] as readonly ParticipantState[],
} as const;

/** An open objection (src/shared/objections.ts). Its resolution condition rides on the rejection. */
export interface StatusObjection {
  by: string;
  reason: string | null;
  condition: string | null;
  /** Passages the objection covers now. Null means that covered line is gone. */
  lineIndices: readonly (number | null)[];
}

export interface PassageStatus {
  lineIndex: number;
  state: ParticipantState;
  /** Set when `state` is rejected. */
  reason?: string | null;
  /** The resolution condition ("I'd agree if…"), when this rejection is an objection. */
  condition?: string | null;
  /** Set when `state` is lapsed: the wording they agreed to. */
  earlierVersion?: string | null;
}

export interface StatusCounts {
  unseen: number;
  seen: number;
  agreed: number;
  rejected: number;
  approved: number;
  lapsed: number;
}

export interface RejectionDetail {
  lineIndex: number;
  reason: string | null;
  condition: string | null;
}

export interface ParticipantStatus {
  actor: string;
  counts: StatusCounts;
  /** First unseen passage, 0-based. Null when no passage is unseen. */
  readingStopsAt: number | null;
  rejections: RejectionDetail[];
  /** Every passage is a current decision (Agreed, Rejected or Approved). */
  finishedOwnReview: boolean;
  /** Every passage is current Agreed or Approved; approval counts as this participant's agreement. */
  agreed: boolean;
  /** Every passage is Approved. This is the owner's ruling, not the team's agreement. */
  approved: boolean;
  passages: PassageStatus[];
}

export interface DocumentStatus {
  /**
   * Every participant has seen every passage, and nobody rejects the current text.
   * A lapsed agreement is not "seen" for the wording as it reads now.
   */
  aligned: boolean;
  /** Every participant has current Agreed or Approved on every passage. */
  agreed: boolean;
  participants: ParticipantStatus[];
}

export interface HeaderClause {
  kind: 'agreed' | 'approved' | 'participant' | 'none';
  /** The participant this clause is about. Null for the "Agreed by" and "Approved by" lines. */
  actor: string | null;
  text: string;
  /** 0-based passages this clause points at. The header links these; this module does not render. */
  lines: number[];
}

export interface StatusReader {
  actor: string;
  /** Every passage is current Agreed or Approved. */
  agreed: boolean;
  /** Every passage is Approved. */
  approved: boolean;
  /**
   * First passage that is not a current Agreed or Approved mark, 0-based.
   * Null when every passage is Agreed or Approved. This is the agreement gap, not the
   * reading stop: a Seen passage and a Rejected passage both count.
   */
  fromLine: number | null;
  /** First unseen passage. Null when they have a current mark on every passage. */
  readingStopsAt: number | null;
  /** No passage is Seen, Agreed, Rejected, Approved or lapsed. */
  nothing: boolean;
  rejectedLines: number[];
  lapsedLines: number[];
}

export interface StatusHeader {
  text: string;
  settled: boolean;
  agreedActors: string[];
  approvedActors: string[];
  clauses: HeaderClause[];
  readers: StatusReader[];
}

const EMPTY_COUNTS = (): StatusCounts => ({ unseen: 0, seen: 0, agreed: 0, rejected: 0, approved: 0, lapsed: 0 });

function objectionIndex(objections: readonly StatusObjection[]): Map<string, Map<number, StatusObjection>> {
  const byActor = new Map<string, Map<number, StatusObjection>>();
  for (const objection of objections) {
    const key = actorKey(objection.by);
    let lines = byActor.get(key);
    if (!lines) { lines = new Map(); byActor.set(key, lines); }
    for (const index of objection.lineIndices) {
      if (index === null || lines.has(index)) continue;
      lines.set(index, objection);
    }
  }
  return byActor;
}

function markState(entry: LineMarkEntry | undefined): ParticipantState {
  if (!entry || entry.mark.hidden) return 'unseen';
  if (entry.lapsed && (entry.mark.status === 'agreed' || entry.mark.status === 'approved')) return 'lapsed';
  if (!entry.current) return 'unseen';
  // A decayed Agreed or Approved mark still counts as Seen. It is not still agreement
  // (src/shared/ttl.ts: the mark shows as stale).
  if (entry.decayed && (entry.mark.status === 'agreed' || entry.mark.status === 'approved')) return 'seen';
  switch (entry.mark.status) {
    case 'agreed': return 'agreed';
    case 'approved': return 'approved';
    case 'rejected': return 'rejected';
    case 'seen': return 'seen';
    default: return 'unseen';
  }
}

function passageFor(state: LineState, key: string, objections: Map<number, StatusObjection> | undefined): PassageStatus {
  const entry = state.marks.get(key);
  const objection = objections?.get(state.line.index);
  // An open objection is a Rejected mark even when the stored line mark was set to Seen
  // (OBJECTION_POLICY.objectorMarksSeen). The condition is the resolution condition.
  if (objection) {
    const reason = entry?.current && entry.mark.status === 'rejected' && entry.mark.reason
      ? entry.mark.reason
      : (objection.reason ?? entry?.mark.reason ?? null);
    return {
      lineIndex: state.line.index,
      state: 'rejected',
      reason: reason ?? null,
      condition: objection.condition ?? null,
    };
  }
  const kind = markState(entry);
  const passage: PassageStatus = { lineIndex: state.line.index, state: kind };
  if (kind === 'rejected') {
    passage.reason = entry?.mark.reason ?? null;
    passage.condition = null;
  } else if (kind === 'lapsed') {
    passage.earlierVersion = entry?.lapsedFrom ?? null;
  }
  return passage;
}

/**
 * Per participant, per passage, per document. `states` are the line states
 * (src/shared/line-marks.ts buildLineStates), after decay has been applied when the caller
 * has times-to-live. `team` is the document's team, in its order.
 */
export function participantStatus(input: {
  states: readonly LineState[];
  team: readonly string[];
  objections?: readonly StatusObjection[];
}): DocumentStatus {
  const objections = objectionIndex(input.objections ?? []);
  const participants: ParticipantStatus[] = input.team.map(actor => {
    const key = actorKey(actor);
    const passages = input.states.map(state => passageFor(state, key, objections.get(key)));
    const counts = EMPTY_COUNTS();
    const rejections: RejectionDetail[] = [];
    let readingStopsAt: number | null = null;
    for (const passage of passages) {
      counts[passage.state] += 1;
      if (passage.state === 'unseen' && readingStopsAt === null) readingStopsAt = passage.lineIndex;
      if (passage.state === 'rejected') {
        rejections.push({
          lineIndex: passage.lineIndex,
          reason: passage.reason ?? null,
          condition: passage.condition ?? null,
        });
      }
    }
    const hasLines = passages.length > 0;
    const decided = (state: ParticipantState) => PARTICIPANT_STATUS_POLICY.decisions.includes(state);
    return {
      actor,
      counts,
      readingStopsAt,
      rejections,
      finishedOwnReview: hasLines && passages.every(passage => decided(passage.state)),
      agreed: hasLines && passages.every(passage => passage.state === 'agreed' || passage.state === 'approved'),
      approved: hasLines && passages.every(passage => passage.state === 'approved'),
      passages,
    };
  });
  const hasLines = input.states.length > 0;
  const hasTeam = participants.length > 0;
  const aligned = hasLines && hasTeam && participants.every(person =>
    person.counts.unseen === 0 && person.counts.rejected === 0 && person.counts.lapsed === 0);
  const agreed = hasLines && hasTeam && participants.every(person => person.agreed);
  return { aligned, agreed, participants };
}

/**
 * Open objections as /state already serializes them (`body.objections`), so a caller that
 * only has the response can feed the same computation the server ran.
 */
export function objectionsFromState(raw: unknown): StatusObjection[] {
  if (!Array.isArray(raw)) return [];
  const out: StatusObjection[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (row.open !== true) continue;
    const lines = Array.isArray(row.lines) ? row.lines : [];
    out.push({
      by: typeof row.by === 'string' ? row.by : '',
      reason: typeof row.reason === 'string' ? row.reason : null,
      condition: typeof row.condition === 'string' ? row.condition : null,
      lineIndices: lines.map(line => {
        if (!line || typeof line !== 'object') return null;
        const index = (line as { lineIndex?: unknown }).lineIndex;
        return typeof index === 'number' ? index : null;
      }),
    });
  }
  return out;
}

function viewerFirst(actors: readonly string[], viewerKey: string): string[] {
  return [...actors].sort((a, b) => (actorKey(a) === viewerKey ? -1 : actorKey(b) === viewerKey ? 1 : 0));
}

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function sentenceCase(word: string): string {
  return word === 'you' ? 'You' : word;
}

function readerFor(person: ParticipantStatus): StatusReader {
  const gap = person.passages.find(passage => passage.state !== 'agreed' && passage.state !== 'approved');
  const read = person.counts.seen + person.counts.agreed + person.counts.rejected + person.counts.approved + person.counts.lapsed;
  return {
    actor: person.actor,
    agreed: person.agreed,
    approved: person.approved,
    fromLine: gap ? gap.lineIndex : null,
    readingStopsAt: person.readingStopsAt,
    nothing: read === 0,
    rejectedLines: person.rejections.map(rejection => rejection.lineIndex),
    lapsedLines: person.passages.filter(passage => passage.state === 'lapsed').map(passage => passage.lineIndex),
  };
}

function clauseFor(person: ParticipantStatus, reader: StatusReader, viewerKey: string, name: (actor: string) => string): HeaderClause {
  const who = actorKey(person.actor) === viewerKey ? 'you' : name(person.actor);
  const Who = sentenceCase(who);
  const has = who === 'you' ? 'have' : 'has';
  const rejected = person.counts.rejected;
  const lapsed = person.counts.lapsed;
  const unseen = person.counts.unseen;
  if (rejected > 0) {
    // Never "has not read". A Rejected mark is evidence they read the text.
    return {
      kind: 'participant',
      actor: person.actor,
      text: `${Who} rejected ${rejected} ${rejected === 1 ? 'line' : 'lines'}.`,
      lines: reader.rejectedLines,
    };
  }
  if (lapsed > 0) {
    const text = lapsed === 1
      ? `${Who} agreed to an earlier version of line ${reader.lapsedLines[0]! + 1}.`
      : `${Who} agreed to an earlier version of ${lapsed} lines.`;
    const unread = unseen > 0 ? ` ${Who} ${has} not read ${unseen} ${unseen === 1 ? 'line' : 'lines'}.` : '';
    return { kind: 'participant', actor: person.actor, text: `${text}${unread}`, lines: reader.lapsedLines };
  }
  if (reader.nothing) {
    return { kind: 'participant', actor: person.actor, text: `${Who} ${has} not read it.`, lines: [] };
  }
  if (person.readingStopsAt === null) {
    return { kind: 'participant', actor: person.actor, text: `${Who} ${has} seen it and ${has} not agreed.`, lines: [] };
  }
  return {
    kind: 'participant',
    actor: person.actor,
    text: `${Who} ${has} not read from line ${person.readingStopsAt + 1} on.`,
    lines: [person.readingStopsAt],
  };
}

/**
 * The honest header, from `participantStatus` and from nothing else.
 * Settled means everyone has Agreed or Approved every passage. An owner who Approved every
 * passage is named only under "Approved by" while the header waits for other participants.
 * A participant with a rejection is never described as not having read the text.
 */
export function statusHeader(status: DocumentStatus, viewer: string, name: (actor: string) => string): StatusHeader {
  const viewerKey = actorKey(viewer);
  const readers = status.participants.map(readerFor);
  const agreedActors = viewerFirst(status.participants.filter(person => person.agreed && !person.approved).map(person => person.actor), viewerKey);
  const approvedActors = viewerFirst(status.participants.filter(person => person.approved).map(person => person.actor), viewerKey);
  if (status.agreed) {
    return { text: '', settled: true, agreedActors, approvedActors, clauses: [], readers };
  }
  const label = (actor: string) => (actorKey(actor) === viewerKey ? 'you' : name(actor));
  const clauses: HeaderClause[] = [];
  if (agreedActors.length) clauses.push({ kind: 'agreed', actor: null, text: `Agreed by ${joinWords(agreedActors.map(label))}.`, lines: [] });
  if (approvedActors.length) clauses.push({ kind: 'approved', actor: null, text: `Approved by ${joinWords(approvedActors.map(label))}.`, lines: [] });
  status.participants.forEach((person, index) => {
    const reader = readers[index]!;
    if (reader.agreed || reader.approved) return;
    clauses.push(clauseFor(person, reader, viewerKey, name));
  });
  const text = clauses.length ? clauses.map(clause => clause.text).join(' ') : 'Nobody has agreed to this yet.';
  if (!clauses.length) clauses.push({ kind: 'none', actor: null, text, lines: [] });
  return { text, settled: false, agreedActors, approvedActors, clauses, readers };
}

/**
 * The status-bar sentence for a finished personal review. It never says the team has agreed,
 * and it does not name a view to switch to. Null when the viewer has not finished.
 * "Waiting for A and B" names the other participants who have not finished, in team order.
 */
export function personalCompletionText(input: {
  status: DocumentStatus;
  viewer: string;
  name: (actor: string) => string;
}): string | null {
  const viewerKey = actorKey(input.viewer);
  const mine = input.status.participants.find(person => actorKey(person.actor) === viewerKey);
  if (!mine?.finishedOwnReview) return null;
  const waiting = input.status.participants.filter(person => actorKey(person.actor) !== viewerKey && !person.finishedOwnReview);
  if (waiting.length === 0) return 'You have finished reviewing.';
  return `You have finished reviewing. Waiting for ${joinWords(waiting.map(person => input.name(person.actor)))}.`;
}
