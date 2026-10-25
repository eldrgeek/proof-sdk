/**
 * Accord — multi-party dispositions (pure code, shared by the browser and the server).
 *
 * Mike, 2026-10-24 (Claude project "Accords", thread "Design the per-participant accord model";
 * written up as the Claude Doc "Accord per-participant state model"): the multi-party rule that
 * "The Accord rules" (gfmd0z5p) left "still to come".
 *
 *   - The draft is what has been proposed and not disposed of from a participant's point of view.
 *     A participant disposes of a proposal by promoting it to their accord or sending it to their
 *     cutting room. Every participant has their own three piles: draft, accord, cutting room.
 *   - "When there is full Accord, everyone has the same Accord and the same cutting room and the
 *     draft is empty."
 *   - "AIs are equal participants to humans." An observer can comment (argue) but their agreement
 *     is not required.
 *   - A modification is a new proposal. It shows as a proposal in the modifier's accord and in
 *     everyone else's draft, and it stays a proposal "until common accord".
 *   - "By default, consensus. Owner can overrule as a special act but the disagreement is noted."
 *   - Changing your mind is allowed at any time (a disposition can go back to draft).
 *
 * A proposal here is a suggestion mark (insert, delete, replace). Its proposer promotes it by
 * proposing it. It becomes common (the suggestion is accepted into the shared text) when every
 * participant has promoted it, and commonly cut (the suggestion is rejected) when every participant
 * has cut it, the proposer included. Anything else is open; promoted-by-some and cut-by-others is a
 * disagreement, which is exactly the remaining work ("where we differ").
 *
 * With two participants, an accept by the other party completes unanimity, so accepting behaves as
 * it does today. A reject differs: it no longer closes the proposal on its own. The original text
 * still stands (nothing is applied), and the proposal stays open as a disagreement until the
 * proposer cuts it too or proposes again. That is the 2026-09-24 rule "rejecting a proposal leaves
 * the original standing until the proposer accepts it or proposes again".
 *
 * Dispositions are stored beside the document, append-only (the latest per participant counts), so
 * the path to accord can be replayed.
 */
import { actorKey, isAiActor } from './line-marks.js';
import type { Argument } from './arguments.js';

export const DISPOSITION_POLICY = {
  /** Off by default: a document opts in, and every live Accord keeps today's behaviour until then. */
  multiPartyDefault: false,
  /** Proposing a change promotes it to the proposer's own accord. */
  proposerPromotesOwn: true,
  /** Every participant (people and AIs alike) must dispose the same way. Observers do not count. */
  unanimity: 'participants' as const,
  /**
   * Inherited from ALT_POLICY.unanimityNeedsHuman: a roster of AIs alone never changes the shared
   * text. AIs still count exactly as people do when people are present.
   */
  unanimityNeedsHuman: true,
  /** Observers argue and see every pile; they have no dispositions. */
  observersDispose: false,
  /** The Owner can overrule as a special act; the dissent is recorded with the outcome. */
  ownerMayOverrule: true,
  overruleRecordsDissent: true,
  /** Unanimity is judged on the roster as it is now (a newly added participant's voice counts). */
  rosterAt: 'now' as const,
  /** A late joiner inherits the common accord and sees only open proposals in their draft. */
  lateJoinerInheritsCommon: true,
} as const;

export type Disposition = 'promote' | 'cut' | 'draft';
export type Pile = 'draft' | 'accord' | 'cutting-room';
export type RosterRole = 'participant' | 'owner' | 'observer';
export type CommonStatus = 'open' | 'common' | 'commonly-cut';

export interface RosterEntry {
  actor: string;
  role: RosterRole;
}

export interface DispositionRecord {
  markId: string;
  by: string;
  disposition: Disposition;
  at: string;
}

export interface ProposalRef {
  markId: string;
  /** The proposer (the suggestion mark's `by`). */
  by: string;
}

export interface ProposalView {
  markId: string;
  proposer: string;
  /** Each voter's pile, keyed by actorKey. */
  piles: Map<string, Pile>;
  status: CommonStatus;
  /** Voters who still have this proposal in their draft. */
  openFor: string[];
  promotedBy: string[];
  cutBy: string[];
  /** Promoted by someone and cut by someone else. */
  disagree: boolean;
}

/** Owners and participants dispose; observers do not. One entry per person (actorKey). */
export function voters(roster: RosterEntry[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of roster) {
    if (entry.role === 'observer' && !DISPOSITION_POLICY.observersDispose) continue;
    const key = actorKey(entry.actor);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(entry.actor);
  }
  return out;
}

export function roleOf(roster: RosterEntry[], actor: string): RosterRole | null {
  const key = actorKey(actor);
  let role: RosterRole | null = null;
  for (const entry of roster) {
    if (actorKey(entry.actor) !== key) continue;
    // The strongest role wins when a person is listed twice.
    if (entry.role === 'owner') return 'owner';
    if (entry.role === 'participant' || role === null) role = entry.role;
  }
  return role;
}

function pileFor(disposition: Disposition): Pile {
  if (disposition === 'promote') return 'accord';
  if (disposition === 'cut') return 'cutting-room';
  return 'draft';
}

/** The latest disposition per participant for one proposal (records in any order). */
export function latestDispositions(markId: string, records: DispositionRecord[]): Map<string, DispositionRecord> {
  const latest = new Map<string, DispositionRecord>();
  for (const record of records) {
    if (record.markId !== markId) continue;
    const key = actorKey(record.by);
    const prev = latest.get(key);
    if (!prev || String(record.at) >= String(prev.at)) latest.set(key, record);
  }
  return latest;
}

/** Where this proposal sits for one person. The proposer starts with it promoted. */
export function pileOf(proposal: ProposalRef, actor: string, records: DispositionRecord[]): Pile {
  const own = latestDispositions(proposal.markId, records).get(actorKey(actor));
  if (own) return pileFor(own.disposition);
  if (DISPOSITION_POLICY.proposerPromotesOwn && actorKey(actor) === actorKey(proposal.by)) return 'accord';
  return 'draft';
}

export function evaluateProposal(proposal: ProposalRef, roster: RosterEntry[], records: DispositionRecord[]): ProposalView {
  const team = voters(roster);
  const piles = new Map<string, Pile>();
  const openFor: string[] = [];
  const promotedBy: string[] = [];
  const cutBy: string[] = [];
  for (const member of team) {
    const pile = pileOf(proposal, member, records);
    piles.set(actorKey(member), pile);
    if (pile === 'draft') openFor.push(member);
    else if (pile === 'accord') promotedBy.push(member);
    else cutBy.push(member);
  }
  const humanVoter = team.some(member => !isAiActor(member));
  const quorum = team.length > 0 && (!DISPOSITION_POLICY.unanimityNeedsHuman || humanVoter);
  let status: CommonStatus = 'open';
  if (quorum && promotedBy.length === team.length) status = 'common';
  else if (quorum && cutBy.length === team.length) status = 'commonly-cut';
  return {
    markId: proposal.markId,
    proposer: proposal.by,
    piles,
    status,
    openFor,
    promotedBy,
    cutBy,
    disagree: promotedBy.length > 0 && cutBy.length > 0,
  };
}

export function evaluateProposals(proposals: ProposalRef[], roster: RosterEntry[], records: DispositionRecord[]): ProposalView[] {
  return proposals.map(proposal => evaluateProposal(proposal, roster, records));
}

/** What the server does after recording a disposition: apply, reject, or keep it open. */
export function finalizeAction(view: ProposalView): 'accept' | 'reject' | 'hold' {
  if (view.status === 'common') return 'accept';
  if (view.status === 'commonly-cut') return 'reject';
  return 'hold';
}

/** Open proposals that someone promoted and someone else cut. */
export function whereWeDiffer(views: ProposalView[]): ProposalView[] {
  return views.filter(view => view.status === 'open' && view.disagree);
}

/** Full accord: no open proposal is left, so everyone's draft is empty and every pile matches. */
export function isFullAccord(views: ProposalView[]): boolean {
  return views.every(view => view.status !== 'open');
}

/** One person's three piles over the open proposals (their draft, accord and cutting room). */
export function personalPiles(views: ProposalView[], actor: string): Record<Pile, string[]> {
  const key = actorKey(actor);
  const out: Record<Pile, string[]> = { draft: [], accord: [], 'cutting-room': [] };
  for (const view of views) {
    if (view.status !== 'open') continue;
    const pile = view.piles.get(key);
    if (pile) out[pile].push(view.markId);
  }
  return out;
}

export function parseDisposition(value: unknown): Disposition | null {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (text === 'promote' || text === 'accept' || text === 'accepted') return 'promote';
  if (text === 'cut' || text === 'reject' || text === 'rejected') return 'cut';
  if (text === 'draft' || text === 'undo' || text === 'reopen') return 'draft';
  return null;
}

/** Null when this person may record this disposition; otherwise the reason they may not. */
export function dispositionRefusal(roster: RosterEntry[], actor: string): { code: string; error: string } | null {
  const role = roleOf(roster, actor);
  if (role === null) return { code: 'NOT_A_PARTICIPANT', error: 'Only participants of this Accord can promote or cut its proposals.' };
  if (role === 'observer' && !DISPOSITION_POLICY.observersDispose) {
    return { code: 'OBSERVER_CANNOT_DISPOSE', error: 'Observers can argue for or against a change, but they do not promote or cut it.' };
  }
  return null;
}

export interface Overrule {
  markId: string;
  by: string;
  outcome: 'common' | 'commonly-cut';
  /** Voters whose pile differed from the outcome when the Owner overruled (recorded, not hidden). */
  dissent: Array<{ actor: string; pile: Pile }>;
  at: string;
}

/** The Owner's special act: decide an open proposal without unanimity, keeping the dissent. */
export function overrule(view: ProposalView, roster: RosterEntry[], by: string, outcome: 'common' | 'commonly-cut', at: string): Overrule | { code: string; error: string } {
  if (!DISPOSITION_POLICY.ownerMayOverrule || roleOf(roster, by) !== 'owner') {
    return { code: 'OWNER_ONLY', error: 'Only an Owner can overrule, and the disagreement is recorded when they do.' };
  }
  if (view.status !== 'open') return { code: 'NOT_OPEN', error: 'This proposal is already settled.' };
  const wanted: Pile = outcome === 'common' ? 'accord' : 'cutting-room';
  const dissent: Array<{ actor: string; pile: Pile }> = [];
  for (const member of voters(roster)) {
    // The Owner overruling is deciding, not dissenting.
    if (actorKey(member) === actorKey(by)) continue;
    const pile = view.piles.get(actorKey(member)) ?? 'draft';
    if (pile !== wanted) dissent.push({ actor: member, pile });
  }
  return { markId: view.markId, by, outcome, dissent: DISPOSITION_POLICY.overruleRecordsDissent ? dissent : [], at };
}

/** A view after the Owner's overrule: settled as the Owner decided, with who disagreed. */
export function withOverrule(view: ProposalView, ov: Overrule | undefined): ProposalView & { overrule?: Overrule } {
  if (!ov || ov.markId !== view.markId) return view;
  return { ...view, status: ov.outcome, openFor: [], overrule: ov };
}

/** What GET /dispositions reports, as the page reads it. */
export interface DispositionsReportView {
  multiParty: boolean;
  /** The reader may overrule (the Owner's special act). */
  viewerIsOwner?: boolean;
  roster?: RosterEntry[];
  proposals: Array<{ markId: string; proposer?: string; status?: string; openFor?: string[]; promotedBy?: string[]; cutBy?: string[] }>;
  whereWeDiffer: string[];
  fullAccord: boolean;
  /** Arguments on open proposals (src/shared/arguments.ts). */
  arguments?: Argument[];
}

export interface DispositionSummary {
  /** Open proposals still in this person's draft. */
  draft: number;
  /** Open proposals someone promoted and someone else cut. */
  differ: number;
  /** All open proposals. */
  open: number;
  observer: boolean;
  fullAccord: boolean;
}

export type PileFilter = 'draft' | 'accord' | 'cutting-room' | 'differ';

/** The switch above the Review list on a multi-party Accord (plan step 1, 2026-10-24). */
export const PILE_FILTER_POLICY = {
  filters: [
    { id: 'draft', label: 'Draft' },
    { id: 'accord', label: 'My accord' },
    { id: 'cutting-room', label: 'Cutting room' },
    { id: 'differ', label: 'Where we differ' },
  ] as Array<{ id: PileFilter; label: string }>,
  /** Nothing is filtered until the reader picks a pile ("nothing moves unless the reader does it"). */
  defaultFilter: null as PileFilter | null,
} as const;

/**
 * One person's piles over the open proposals, as mark ids. Someone who has not decided anything yet
 * is not on the server's roster, but "initially all views are the same: just the draft", so every
 * open proposal they did not make is in their draft, and the ones they made are in their accord.
 * An observer has no piles of their own; they still see where we differ.
 */
export function viewerPiles(report: DispositionsReportView, me: string): Record<PileFilter, string[]> {
  const key = actorKey(me);
  const has = (list: string[] | undefined) => (list ?? []).some(actor => actorKey(actor) === key);
  const out: Record<PileFilter, string[]> = { draft: [], accord: [], 'cutting-room': [], differ: [...report.whereWeDiffer] };
  if (report.roster && roleOf(report.roster, me) === 'observer') return out;
  for (const p of report.proposals) {
    if ((p.status ?? 'open') !== 'open') continue;
    if (has(p.openFor)) out.draft.push(p.markId);
    else if (has(p.promotedBy)) out.accord.push(p.markId);
    else if (has(p.cutBy)) out['cutting-room'].push(p.markId);
    else if (actorKey(p.proposer ?? '') === key) out.accord.push(p.markId);
    else out.draft.push(p.markId);
  }
  return out;
}

/** One person's counts for the line under the Accord's title. */
export function summarizeForViewer(report: DispositionsReportView, me: string): DispositionSummary {
  const open = report.proposals.filter(p => (p.status ?? 'open') === 'open');
  const observer = Boolean(report.roster && roleOf(report.roster, me) === 'observer');
  return { draft: viewerPiles(report, me).draft.length, differ: report.whereWeDiffer.length, open: open.length, observer, fullAccord: report.fullAccord };
}

/** The count line under the Accord's title: "3 in your draft · 2 where we differ", or "Full accord". */
export function dispositionStatusText(summary: DispositionSummary): string {
  if (summary.fullAccord) return 'Full accord';
  const parts: string[] = [];
  if (summary.observer) parts.push(`Observing · ${summary.open} open`);
  else parts.push(summary.draft === 0 ? 'Nothing left in your draft' : `${summary.draft} in your draft`);
  if (summary.differ > 0) parts.push(`${summary.differ} where we differ`);
  else if (!summary.observer && summary.draft === 0) parts.push('waiting on others');
  return parts.join(' · ');
}

/**
 * Stance on a change, for the Review row: who has it in their accord and who cut it, in names.
 * Everyone else still has it in their draft. Null when nobody has decided anything beyond proposing.
 */
export function stanceText(report: DispositionsReportView, markIds: readonly string[], name: (actor: string) => string = a => a): string | null {
  const wanted = new Set(markIds);
  const promoted = new Map<string, string>();
  const cut = new Map<string, string>();
  const open = report.proposals.filter(p => wanted.has(p.markId) && (p.status ?? 'open') === 'open');
  // A line with several changes has a stance per change, shown with each change, not merged here.
  if (open.length !== 1) return null;
  for (const p of open) {
    for (const a of p.promotedBy ?? []) promoted.set(actorKey(a), a);
    for (const a of p.cutBy ?? []) cut.set(actorKey(a), a);
  }
  if (promoted.size === 0 && cut.size === 0) return null;
  const list = (m: Map<string, string>) => [...m.values()].map(name).join(', ');
  const parts: string[] = [];
  if (promoted.size) parts.push(`In accord: ${list(promoted)}`);
  if (cut.size) parts.push(`Cut: ${list(cut)}`);
  return parts.join(' · ');
}
