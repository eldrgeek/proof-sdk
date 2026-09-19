/**
 * Proof Documents — Step B3: `{ask}` decision lines (pure code, shared by the browser and server).
 *
 * Authorship: direction by Mike Wolf (18 Sept 2026: action marks "incorporate the ideas in Pulse
 * Zero"); the COS recommended {ask} first and set the brief; built by Claude Opus 5 (worker
 * proof-ask), 2026-09-18. Rules marked POLICY are Claude's decisions where the brief is silent.
 *
 * An ask turns one line of the document into a decision for named people. It is an attribute
 * of the line, stored beside the document like a line mark (never in the text), anchored by the
 * same hash / occurrence / ordinal scheme. It carries the Pulse Zero card standard:
 *   - one decision per ask (one line);
 *   - the question line carries its own context (it is a line of the document);
 *   - a recommendation, not a menu (Completed Staff Work): `recommend` is required;
 *   - an optional one-line `ifYes` previews the consequence before anyone agrees;
 *   - the answer is a real control (Yes / Not yet / No), recorded with the person's exact words.
 */
import { actorKey, actorLabel, isAiActor, resolveLineAnchor, type DocLine, type LineAnchor } from './line-marks.js';
import { IDENTITY_POLICY, isGuestActor } from './identity.js';

export type AskChoice = 'yes' | 'not_yet' | 'no';
export const ASK_CHOICES: readonly AskChoice[] = ['yes', 'not_yet', 'no'];

export const ASK_CHOICE_LABEL: Record<AskChoice, string> = { yes: 'Yes', not_yet: 'Not yet', no: 'No' };

export interface AskAnswer {
  id: string;
  by: string;
  choice: AskChoice;
  /** The person's own words, exactly as typed (trimmed). Empty when they gave none. */
  words: string;
  at: string;
  /** Hash of the question line's text when the answer was given. */
  lineHash: string;
  /**
   * Step B4f blind marking: someone else's answer the viewer may not see yet. `choice` is only a
   * placeholder (yes = a closing answer, not_yet = still open) and `words` is empty.
   */
  hidden?: boolean;
}

export interface ProofAsk {
  id: string;
  /** Who asked. */
  by: string;
  /** Who is asked (TM identities). Empty means any human other than the asker. */
  to: string[];
  /** The asker's recommendation, one line. */
  recommend: string;
  /** Optional one-line preview of what happens on Yes. */
  ifYes: string | null;
  anchor: LineAnchor;
  createdAt: string;
  /** Last time the ask was (re-)asked. Answers before this no longer count. */
  askedAt: string;
  /** Every answer ever given, oldest first (the audit trail). */
  answers: AskAnswer[];
}

// ============================================================================
// POLICY (Claude's decisions where the brief is silent; each is a one-line change)
// ============================================================================

export const ASK_POLICY = {
  /** "No" and "Not yet" ask for a reason line; "Yes" does not (brief). */
  reasonRequired: { yes: false, not_yet: true, no: true } as Record<AskChoice, boolean>,
  /** Yes and No close the ask for the person who answered; Not yet keeps it open (brief). */
  closes: { yes: true, not_yet: false, no: true } as Record<AskChoice, boolean>,
  /**
   * "Not yet" snoozes the ask for that person until the question line's text changes or the
   * asker re-asks. A snoozed ask is not an Issue for that person (decision).
   */
  notYetSnoozesUntil: 'line-change-or-reask' as const,
  /**
   * Any answer (Yes and No too) stops counting when the question line's text changes: the
   * person answered a different question. Same rule as line marks (decision).
   */
  answerStaleWhenLineChanges: true,
  /** A re-ask reopens the ask for everyone: answers before it no longer count (decision). */
  reaskReopensAll: true,
  /**
   * An answer from someone not in `to` is recorded and shown, but does not settle the ask for
   * the people it was asked of (decision). Since Step B6 answers carry the verified identity
   * (human:<email>), an agent key's AI, or a guest's typed name (src/shared/identity.ts).
   */
  outsideAnswersSettle: false,
  /** When `to` is empty, the first Yes or No from a human who is not the asker closes it. */
  emptyToMeans: 'any-human' as const,
  /** Answering also sets the answerer's line mark to Seen when they had none (never lowers one). */
  answerMarksLineSeen: true,
  /** Answering is the TM's explicit action for the reading walk (commits scroll-accepts above). */
  answerIsExplicitReadingAction: true,
  /** One ask per line: asking again on the same line returns 409 ASK_EXISTS (use re-ask). */
  oneAskPerLine: true,
  /** An ask whose line was deleted is "orphaned": listed, but not an Issue. */
  orphanedIsIssue: false,
  /** Reading-walk keys (A / R / J / K / E are taken). */
  keys: { yes: 'y', no: 'n', not_yet: 't' } as Record<AskChoice, string>,
  maxRecommend: 300,
  maxIfYes: 300,
  maxWords: 1000,
  maxTo: 20,
} as const;

// ============================================================================
// Evaluation
// ============================================================================

export type AskPersonState = 'open' | 'snoozed' | 'answered';

export interface AskPerson {
  actor: string;
  state: AskPersonState;
  /** The answer that counts for this person now (null when open). */
  answer: AskAnswer | null;
}

export interface AskView {
  ask: ProofAsk;
  /** The question line now, or null when the line is gone (orphaned). */
  lineIndex: number | null;
  lineHash: string | null;
  /** True when the question line still has the text it had when asked (or last re-anchored). */
  current: boolean;
  /** One row per person in `to` (or one "anyone" row when `to` is empty). */
  people: AskPerson[];
  openFor: string[];
  snoozedFor: string[];
  /** Answers that count now, latest per person, including people outside `to`. */
  answers: AskAnswer[];
  /** No one it was asked of still owes an answer (Yes or No from each, or snoozed). */
  closed: boolean;
  /** Settled: everyone it was asked of answered Yes or No. */
  settled: boolean;
  /** Summary for humans and AIs: yes / no / mixed / open / snoozed. */
  outcome: 'open' | 'snoozed' | 'yes' | 'no' | 'mixed';
}

export const ANYONE = 'anyone';

/** Normalizes a `to` entry: a bare name is a human ("Mike" -> "human:Mike"). */
export function normalizeAskActor(value: string): string {
  const trimmed = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  if (/^(human|ai):/i.test(trimmed)) return trimmed;
  return `human:${trimmed}`;
}

/** Does this answer still count? (Line unchanged since it was given, and given after the last re-ask.) */
export function answerCounts(ask: ProofAsk, answer: AskAnswer, lineHash: string | null): boolean {
  if (ASK_POLICY.reaskReopensAll && String(answer.at) < String(ask.askedAt)) return false;
  if (ASK_POLICY.answerStaleWhenLineChanges && (lineHash === null || answer.lineHash !== lineHash)) return false;
  return true;
}

/** Latest counting answer per person (actorKey), in answer order. */
export function countingAnswers(ask: ProofAsk, lineHash: string | null): AskAnswer[] {
  const latest = new Map<string, AskAnswer>();
  const sorted = [...ask.answers].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  for (const answer of sorted) {
    if (!answerCounts(ask, answer, lineHash)) continue;
    latest.set(actorKey(answer.by), answer);
  }
  return [...latest.values()];
}

function personState(answer: AskAnswer | null): AskPersonState {
  if (!answer) return 'open';
  return ASK_POLICY.closes[answer.choice] ? 'answered' : 'snoozed';
}

export function evaluateAsk(ask: ProofAsk, lines: DocLine[]): AskView {
  const resolved = resolveLineAnchor(lines, ask.anchor);
  const line = resolved ? lines[resolved.lineIndex] : null;
  const lineHash = line ? line.hash : null;
  const answers = countingAnswers(ask, lineHash);
  const byKey = new Map(answers.map(answer => [actorKey(answer.by), answer]));
  const people: AskPerson[] = [];
  if (ask.to.length > 0) {
    for (const actor of ask.to) {
      const answer = byKey.get(actorKey(actor)) ?? null;
      people.push({ actor, state: personState(answer), answer });
    }
  } else {
    // Any human other than the asker. A Yes / No from one of them closes it; otherwise the
    // latest Not yet from one of them snoozes it.
    const eligible = answers.filter(answer => !isAiActor(answer.by)
      && (IDENTITY_POLICY.emptyToCountsGuests || !isGuestActor(answer.by))
      && actorKey(answer.by) !== actorKey(ask.by));
    const closing = [...eligible].reverse().find(answer => ASK_POLICY.closes[answer.choice]) ?? null;
    const snoozing = closing ? null : ([...eligible].reverse().find(answer => !ASK_POLICY.closes[answer.choice]) ?? null);
    const answer = closing ?? snoozing;
    people.push({ actor: ANYONE, state: personState(answer), answer });
  }
  const openFor = people.filter(p => p.state === 'open').map(p => p.actor);
  const snoozedFor = people.filter(p => p.state === 'snoozed').map(p => p.actor);
  const decided = people.filter(p => p.state === 'answered');
  const settled = decided.length === people.length;
  let outcome: AskView['outcome'] = 'open';
  if (settled) {
    const choices = new Set(decided.map(p => p.answer!.choice));
    outcome = choices.size === 1 ? (choices.has('yes') ? 'yes' : 'no') : 'mixed';
  } else if (openFor.length === 0) {
    outcome = 'snoozed';
  }
  return {
    ask,
    lineIndex: line ? line.index : null,
    lineHash,
    current: Boolean(resolved?.current),
    people,
    openFor,
    snoozedFor,
    answers,
    closed: openFor.length === 0,
    settled,
    outcome,
  };
}

export function evaluateAsks(asks: ProofAsk[], lines: DocLine[]): AskView[] {
  return asks.map(ask => evaluateAsk(ask, lines));
}

/** Is `actor` one of the people this ask is for? (Empty `to`: any human who is not the asker.) */
export function isAskedOf(ask: ProofAsk, actor: string): boolean {
  if (ask.to.length === 0) {
    return !isAiActor(actor) && (IDENTITY_POLICY.emptyToCountsGuests || !isGuestActor(actor)) && actorKey(actor) !== actorKey(ask.by);
  }
  return ask.to.some(member => actorKey(member) === actorKey(actor));
}

/** The viewer's own state on an ask (null when it is not asked of them). */
export function askStateFor(view: AskView, actor: string): AskPerson | null {
  if (!isAskedOf(view.ask, actor)) return null;
  if (view.ask.to.length === 0) {
    const own = view.answers.find(answer => actorKey(answer.by) === actorKey(actor)) ?? null;
    // With an empty `to`, someone else's Yes / No closes it for everyone.
    const anyone = view.people[0];
    if (anyone.state === 'answered' && (!own || !ASK_POLICY.closes[own.choice])) return { actor, state: 'answered', answer: anyone.answer };
    return { actor, state: personState(own), answer: own };
  }
  return view.people.find(p => actorKey(p.actor) === actorKey(actor)) ?? null;
}

/** Input for computeIssues (src/shared/line-marks.ts): one entry per ask that is an Issue. */
export function askIssueInputs(views: AskView[]): Array<{ id: string; lineIndex: number; by: string; recommend: string; openFor: string[]; snoozedFor: string[] }> {
  const out: Array<{ id: string; lineIndex: number; by: string; recommend: string; openFor: string[]; snoozedFor: string[] }> = [];
  for (const view of views) {
    if (view.lineIndex === null) continue; // orphaned (ASK_POLICY.orphanedIsIssue is false)
    if (view.openFor.length === 0) continue;
    out.push({ id: view.ask.id, lineIndex: view.lineIndex, by: view.ask.by, recommend: view.ask.recommend, openFor: view.openFor, snoozedFor: view.snoozedFor });
  }
  return out;
}

/** Plain-language status line, for the control and for AIs reading /state. */
export function describeAsk(view: AskView): string {
  const who = (actor: string) => (actor === ANYONE ? 'anyone' : actorLabel(actor));
  const said = (answer: AskAnswer | null) => (answer?.hidden ? 'answered (hidden)' : ASK_CHOICE_LABEL[answer!.choice]);
  if (view.lineIndex === null) return 'The question line was deleted';
  if (view.settled) {
    return view.people.map(p => `${who(p.actor)}: ${said(p.answer)}`).join(' · ');
  }
  const parts: string[] = [];
  if (view.openFor.length) parts.push(`Waiting on ${view.openFor.map(who).join(', ')}`);
  if (view.snoozedFor.length) parts.push(`Not yet: ${view.snoozedFor.map(who).join(', ')}`);
  const done = view.people.filter(p => p.state === 'answered');
  if (done.length) parts.push(done.map(p => `${who(p.actor)}: ${said(p.answer)}`).join(', '));
  return parts.join(' · ');
}

// ============================================================================
// Validation
// ============================================================================

export function isAskChoice(value: unknown): value is AskChoice {
  return typeof value === 'string' && (ASK_CHOICES as readonly string[]).includes(value);
}

/** Accepts "yes" / "not_yet" / "no" and the spellings people and AIs use ("Not yet", "not-yet"). */
export function parseAskChoice(value: unknown): AskChoice | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (v === 'yes' || v === 'y') return 'yes';
  if (v === 'no' || v === 'n') return 'no';
  if (v === 'not_yet' || v === 'notyet' || v === 't') return 'not_yet';
  return null;
}

/** One line of plain text: trimmed, inner whitespace collapsed, no line breaks. */
export function oneLine(value: unknown, max: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Step B3 team rule: askers and the people asked join the Step 1 team. */
export function askTeamActors(asks: ProofAsk[]): string[] {
  const out: string[] = [];
  for (const ask of asks) {
    out.push(ask.by);
    for (const actor of ask.to) out.push(actor);
  }
  return out;
}
