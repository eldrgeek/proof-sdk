/**
 * Proof Documents — Step B4e: review bundles (pure code, shared by the browser and the server).
 *
 * Authorship: idea from OpenAI Astra (research round 1, idea 2; round 2's "build first" pick);
 * brief by the COS (Claude), 2026-09-19; built by Claude Opus 5 (worker proof-bundles),
 * 2026-09-19. Every rule marked POLICY is Claude's decision where the brief is silent, kept in one
 * named constant so a ruling from Mike is a one-line change.
 *
 * A bundle groups several suggestions that make one coherent change ("Move launch to October")
 * under a title and a one-line why. The rail shows it as one card. "Accept bundle" applies every
 * pending member in one step, after checking that each member's line still has the text it had
 * when it was bundled (its target hash). If any member is stale, the bundle refuses and the reader
 * reviews the members one by one (the stale ones are marked). Accepting a bundle accepts edits; it
 * is NOT agreement with the resulting lines, which still need their own marks.
 * Bundles are stored beside the document (document_bundles), never in its text.
 */
import type { DocLine } from './line-marks.js';

export const BUNDLE_POLICY = {
  /** Most suggestions in one bundle. */
  maxMembers: 50,
  maxTitle: 120,
  maxWhy: 300,
  /** A bundle id the author chooses (so several suggest calls can name the same bundle). */
  idPattern: /^[A-Za-z0-9_.:-]{1,64}$/,
  /** A new bundle needs a title (the why is optional, but shown when given). */
  titleRequired: true,
  /** A suggestion belongs to at most one open bundle (409 IN_ANOTHER_BUNDLE otherwise). */
  onePerSuggestion: true,
  /**
   * Adding a member re-records every member's target hash. Two members on one line change each
   * other's line text (pending text is part of the line), so hashes taken earlier would go stale
   * at once. Someone else's later suggestion on a bundled line does make that member stale.
   */
  refreshTargetsOnAdd: true,
  /** One stale member refuses the whole bundle (the reader falls back to individual review). */
  staleRefusesAll: true,
  /** A member rejected on its own makes the bundle "split": it can no longer be accepted whole. */
  rejectedMemberSplits: true,
  /** Accepting a bundle is an edit acceptance, not agreement with the resulting lines (brief). */
  acceptIsAgreement: false,
  // The Accord rules (2026-09-24) retire accept-is-not-agreement: accepting a change agrees to it.
  acceptNote: 'Accepting agrees to these changes.',
  /** The reading walk steps a bundle's passages as one unit when the focus reaches the first. */
  walkStepsAsUnit: true,
  /** Accept and reject need edit access (like accepting one suggestion); grouping needs comment access. */
  acceptRoles: ['editor', 'owner_bot'] as readonly string[],
} as const;

export type BundleStatus = 'open' | 'accepted' | 'rejected' | 'split' | 'closed';

export interface BundleMember {
  markId: string;
  /** Hash of the line that held the suggestion when it was bundled (null: not known yet). */
  lineHash: string | null;
  /** The suggestion's quote (for people and AIs reading the raw data). */
  quote: string;
  kind: string;
}

export interface ProofBundle {
  id: string;
  by: string;
  title: string;
  why: string | null;
  members: BundleMember[];
  createdAt: string;
  status: BundleStatus;
  closedAt: string | null;
  closedBy: string | null;
}

export type MemberState = 'pending' | 'accepted' | 'rejected' | 'missing';

export interface BundleMemberView {
  markId: string;
  state: MemberState;
  /** The line the suggestion sits on now (null when it is gone). */
  lineIndex: number | null;
  /** Its line's text changed since it was bundled, or the suggestion is gone or was rejected. */
  stale: boolean;
  staleReason: 'changed' | 'missing' | 'rejected' | null;
}

export interface BundleView {
  bundle: ProofBundle;
  members: BundleMemberView[];
  /** Members still pending (the ones Accept bundle would apply). */
  pending: string[];
  /** Members that stop the bundle being accepted whole. */
  stale: string[];
  /** Status from the members now (a recorded accept or reject wins). */
  status: BundleStatus;
  /** True when Accept bundle would go through now. */
  acceptable: boolean;
}

export function cleanBundleText(value: unknown, max: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function isBundleId(value: unknown): value is string {
  return typeof value === 'string' && BUNDLE_POLICY.idPattern.test(value);
}

/**
 * Evaluates a bundle against the document now. `suggestion(markId)` says where each member is and
 * whether it is still pending (the page reads its editor; the server reads the stored marks).
 */
export function evaluateBundle(bundle: ProofBundle, lines: DocLine[], suggestion: (markId: string) => { state: MemberState; lineIndex: number | null }): BundleView {
  const members: BundleMemberView[] = bundle.members.map(member => {
    const found = suggestion(member.markId);
    let staleReason: BundleMemberView['staleReason'] = null;
    if (found.state === 'missing') staleReason = 'missing';
    else if (found.state === 'rejected' && BUNDLE_POLICY.rejectedMemberSplits) staleReason = 'rejected';
    else if (found.state === 'pending' && member.lineHash) {
      const line = found.lineIndex === null ? null : lines[found.lineIndex];
      if (!line || line.hash !== member.lineHash) staleReason = 'changed';
    }
    return { markId: member.markId, state: found.state, lineIndex: found.lineIndex, stale: staleReason !== null, staleReason };
  });
  const pending = members.filter(m => m.state === 'pending').map(m => m.markId);
  const stale = members.filter(m => m.stale).map(m => m.markId);
  let status: BundleStatus = bundle.status;
  if (status === 'open') {
    if (members.length > 0 && members.every(m => m.state === 'accepted' || m.state === 'missing') && members.some(m => m.state === 'accepted')) status = 'accepted';
    else if (members.length > 0 && members.every(m => m.state === 'rejected' || m.state === 'missing') && members.some(m => m.state === 'rejected')) status = 'rejected';
    else if (members.some(m => m.state === 'rejected') && members.some(m => m.state !== 'rejected')) status = 'split';
    else if (pending.length === 0) status = 'closed';
  }
  const acceptable = status === 'open' && pending.length > 0 && (!BUNDLE_POLICY.staleRefusesAll || stale.length === 0);
  return { bundle, members, pending, stale, status, acceptable };
}

/** Plain-language status for the rail and for AIs. */
export function describeBundle(view: BundleView): string {
  const n = view.bundle.members.length;
  switch (view.status) {
    case 'accepted': return `Accepted (${n} ${n === 1 ? 'change' : 'changes'})`;
    case 'rejected': return `Rejected (${n} ${n === 1 ? 'change' : 'changes'})`;
    case 'split': return 'Split: some changes were decided one by one';
    case 'closed': return 'Closed: no change is pending';
    default: break;
  }
  if (view.stale.length > 0) return `${view.stale.length} of ${n} changed since bundled: review them one by one`;
  return `${view.pending.length} ${view.pending.length === 1 ? 'change' : 'changes'} pending`;
}

/** Suggestion id -> bundle id, for open bundles (the rail and the Issue list). */
export function bundleIndex(bundles: ProofBundle[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const bundle of bundles) {
    if (bundle.status !== 'open') continue;
    for (const member of bundle.members) if (!out.has(member.markId)) out.set(member.markId, bundle.id);
  }
  return out;
}
