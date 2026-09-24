/** The Accord rules, 2026-09-24; ac-8ae round 2. Client presentation only.
 * Stored marks and server permissions remain authoritative and unchanged.
 */
import type { ViewerIdentity } from './identity';
export const REVIEW_SURFACE_POLICY = {
  identityHomes: ['toolbar', 'people'] as const,
  proposalDetails: 'review' as const,
  sectionBadge: 'pending-changes' as const,
  guestEditNotice: 'You can comment as a guest. Sign in to edit.',
  /** How long the guest's one-line notice stays up after an attempt to edit. */
  guestEditNoticeMs: 8000,
  lineMarkControls: false,
  lineTierControls: false,
  alternativeStacks: false,
  seenByDwell: false,
} as const;
export function viewerLabel(me: ViewerIdentity): string {
  if (me.attestedBy) return `${me.name} — vouched for by ${me.attestedBy.name}`;
  return me.trust === 'verified' ? `Signed in as ${me.name} (verified)`
    : me.trust === 'ai' ? `AI: ${me.name}` : `${me.name || 'Anonymous'} — guest, unverified`;
}

/** Count pending proposals inside a section, including its heading. */
export function sectionPendingChanges(from: number, to: number, changeLines: readonly number[]): number {
  return changeLines.filter(line => line >= from && line < to).length;
}
