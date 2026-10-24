/**
 * Cross invitation (Mike Wolf, 2026-09-19): an invited human may add their AI, and an invited AI
 * may bring a human in — by nomination (a human confirms) or by attestation (presence only).
 *
 * Storage and rules; the policy constants live in src/shared/cross-invitation.ts so that a later
 * ruling of Mike's is a one-line change there. The routes are in server/agent-key-routes.ts
 * (sponsored keys), server/document-team-routes.ts (the Owner's side) and server/agent-routes.ts
 * (the AI's side).
 *
 * Prompt-injection guard: nothing here can be triggered by text inside a document. A nomination or
 * an attestation is always the AI's own API call with its own key; both are rate-limited, both are
 * visible in the people dialog, and both carry the AI's own words ("why" / "basis") for the human
 * who confirms. An AI that acts on instructions it read in a document is exactly the risk the
 * confirm step exists for.
 *
 * Authorship: brief by the COS from Mike Wolf's ruling of 2026-09-19; built by Claude Opus 5
 * (worker proof-crossinvite), 2026-09-19.
 */
import { randomBytes } from 'crypto';
import {
  getDb,
  listDocumentAgentKeys,
  registerAgentKeySuspensionCheck,
  revokeDocumentAgentKey,
  setAgentKeySponsor,
  type DocumentAgentKey,
} from './db.js';
import { getLibraryMemberByEmail, getLibraryMemberById, isLibraryEnabled, type LibraryMember } from './library/auth.js';
import { createLibraryMember } from './library/auth.js';
import {
  activeInviteFor,
  createDocumentInvite,
  getGuestAccessMode,
  listDocumentInvites,
  registerAttestedAccessCheck,
  sendInviteEmail,
} from './document-team.js';
// The document's owner is read with its own query rather than imported from server/line-marks.ts:
// that module asks this one for nomination Issues, and neither should depend on the other's order.
import { actorKey, agentKeyActor, actorLabel } from '../src/shared/line-marks.js';
import { isEmailAddress, verifiedHumanActor } from '../src/shared/identity.js';
import {
  CROSS_INVITE_POLICY,
  isAttestationConfidence,
  provenanceLabel,
  type AttestationConfidence,
  type NominationStatus,
  type Provenance,
} from '../src/shared/cross-invitation.js';

export { CROSS_INVITE_POLICY };

// ============================================================================
// Small helpers
// ============================================================================

function nowIso(): string { return new Date().toISOString(); }

/** The document's creator, as an actor (the same rule as server/line-marks.ts documentOwnerActors). */
export function documentOwnerActors(slug: string): string[] {
  try {
    const row = getDb().prepare(`
      SELECT m.name AS name, m.email AS email FROM library_document_meta meta
      JOIN library_members m ON m.id = meta.created_by_member_id
      WHERE meta.slug = ?
    `).get(slug) as { name?: string; email?: string | null } | undefined;
    if (row?.email && isEmailAddress(row.email)) return [verifiedHumanActor(row.email)];
    if (row?.name && row.name.trim()) return [`human:${row.name.trim()}`];
  } catch {
    // Library tables are optional in bare SDK deployments.
  }
  return [];
}
function newId(prefix: string): string { return `${prefix}_${randomBytes(9).toString('base64url')}`; }

export function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isPlausibleEmail(email: string): boolean {
  return email.length > 0 && email.length <= 254 && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(email);
}

/** One line of the AI's own words: no control characters, no angle brackets, length-capped. */
export function oneLineText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The runtime a sponsor declared: free text, stored and displayed exactly as typed. */
export function normalizeRuntime(value: unknown): string {
  return oneLineText(value, CROSS_INVITE_POLICY.maxRuntimeLength);
}

// ============================================================================
// Rate limits (per process, like the invite and agent-key limits)
// ============================================================================

const buckets = new Map<string, { count: number; resetAt: number }>();

/** Returns false when any key is over its hourly budget; counts only when every key passes. */
export function allowCrossInvite(keys: Array<[string, number]>): boolean {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
  for (const [key, limit] of keys) {
    const bucket = buckets.get(key);
    if (bucket && bucket.count >= limit) return false;
  }
  for (const [key] of keys) {
    const bucket = buckets.get(key);
    if (bucket) bucket.count += 1;
    else buckets.set(key, { count: 1, resetAt: now + 60 * 60 * 1000 });
  }
  return true;
}

export function resetCrossInviteRateLimitsForTests(): void { buckets.clear(); }

// ============================================================================
// 1. Sponsors: every agent key is bound to the verified human who created it
// ============================================================================

/** Whether a key on this document needs a sponsor (see sponsorNotRequiredInGuestModes). */
export function sponsorRequiredFor(slug: string): boolean {
  if (!CROSS_INVITE_POLICY.sponsorRequired) return false;
  return !CROSS_INVITE_POLICY.sponsorNotRequiredInGuestModes.includes(getGuestAccessMode(slug));
}

/**
 * Keys made before this step get the document's owner as their sponsor, once, on first read.
 * A document with no library owner (a bare SDK share) keeps `null`: there is no human to name.
 */
export function backfillAgentKeySponsors(slug: string, keys: DocumentAgentKey[]): DocumentAgentKey[] {
  if (!CROSS_INVITE_POLICY.legacySponsorIsDocumentOwner) return keys;
  const missing = keys.filter(key => !key.sponsorActor);
  if (missing.length === 0) return keys;
  const owner = documentOwnerActors(slug)[0] ?? null;
  if (!owner) return keys;
  const ownerMemberId = memberIdForActor(owner);
  for (const key of missing) {
    try { setAgentKeySponsor(key.tokenId, owner, ownerMemberId); } catch { /* read-only replica */ }
    key.sponsorActor = owner;
    key.sponsorMemberId = key.sponsorMemberId ?? ownerMemberId;
  }
  return keys;
}

function memberIdForActor(actor: string): string | null {
  if (!isLibraryEnabled() || !/^human:/i.test(actor)) return null;
  const email = actor.slice(6).trim().toLowerCase();
  if (!isEmailAddress(email)) return null;
  try { return getLibraryMemberByEmail(email)?.id ?? null; } catch { return null; }
}

export interface AgentKeyView extends DocumentAgentKey {
  /** The AI's actor string, as its marks name it. */
  actor: string;
  sponsorName: string | null;
  /** False when the sponsor no longer has access: the AI is suspended with them. */
  sponsorActive: boolean;
  suspended: boolean;
  /** "Izzy — added by Eric". */
  provenanceLabel: string;
}

/** Every agent key on a document, with its sponsor resolved (and legacy keys backfilled). */
export function listAgentKeyViews(slug: string): AgentKeyView[] {
  let keys: DocumentAgentKey[] = [];
  try { keys = listDocumentAgentKeys(slug); } catch { return []; }
  keys = backfillAgentKeySponsors(slug, keys);
  return keys.map(key => {
    const sponsorName = key.sponsorActor ? displayName(key.sponsorActor) : null;
    const sponsorActive = !key.sponsorActor || sponsorHasAccess(slug, key.sponsorActor);
    return {
      ...key,
      actor: agentKeyActor(key.label),
      sponsorName,
      sponsorActive,
      suspended: Boolean(key.revokedAt) || (CROSS_INVITE_POLICY.suspendAgentsWithSponsor && !sponsorActive),
      provenanceLabel: key.sponsorActor
        ? provenanceLabel({ kind: 'sponsored', name: key.label, byName: sponsorName })
        : provenanceLabel({ kind: 'admin', name: key.label }),
    };
  });
}

export function agentKeyViewForLabel(slug: string, label: string): AgentKeyView | null {
  const wanted = actorKey(agentKeyActor(label));
  return listAgentKeyViews(slug).find(key => actorKey(key.actor) === wanted && !key.revokedAt) ?? null;
}

export function agentKeyViewForToken(slug: string, tokenId: string | null): AgentKeyView | null {
  if (!tokenId) return null;
  return listAgentKeyViews(slug).find(key => key.tokenId === tokenId) ?? null;
}

/** A sponsor still has access when they are a library member or still invited to this document. */
export function sponsorHasAccess(slug: string, sponsorActor: string): boolean {
  if (!isLibraryEnabled()) return true;
  const memberId = memberIdForActor(sponsorActor);
  if (!memberId) return true; // A non-library owner (a bare share): nothing to suspend with.
  let member: LibraryMember | null = null;
  try { member = getLibraryMemberById(memberId); } catch { member = null; }
  if (!member || member.removedAt) return false;
  if (member.scope !== 'invited') return true;
  return Boolean(activeInviteFor(slug, member.id));
}

/**
 * An AI whose sponsor lost access is suspended: every request with its key is refused. Revoking
 * the key outright is the Owner's act, not ours — a re-invited sponsor brings their AI back.
 */
export function agentKeySuspended(slug: string, tokenId: string | null): AgentKeyView | null {
  if (!CROSS_INVITE_POLICY.suspendAgentsWithSponsor) return null;
  const key = agentKeyViewForToken(slug, tokenId);
  if (!key || key.revokedAt || key.sponsorActive) return null;
  return key;
}

// Every credential check runs through this: a suspended key resolves to nothing at all.
registerAgentKeySuspensionCheck((slug, tokenId) => {
  try { return agentKeySuspended(slug, tokenId) !== null; } catch { return false; }
});

export function displayName(actor: string, slug?: string): string {
  // An AI is shown by the name the person who added it typed ("Izzy"), not its slugged actor.
  if (slug && /^ai:/i.test(actor)) {
    const wanted = actorKey(actor);
    const key = listDocumentAgentKeys(slug).find(row => actorKey(agentKeyActor(row.label)) === wanted);
    if (key) return key.label;
  }
  if (/^human:/i.test(actor)) {
    const email = actor.slice(6).trim();
    if (isLibraryEnabled() && isEmailAddress(email)) {
      try { return getLibraryMemberByEmail(email.toLowerCase())?.name || email; } catch { return email; }
    }
    return email;
  }
  return actorLabel(actor);
}

// ============================================================================
// 3. Nominations: an AI proposes a person; a human owner confirms or declines
// ============================================================================

export interface DocumentNomination {
  id: string;
  slug: string;
  by: string;
  email: string;
  name: string | null;
  why: string;
  status: NominationStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  declineReason: string | null;
  inviteId: string | null;
}

type NominationRow = {
  id: string; slug: string; by_actor: string; email: string; name: string | null; why: string;
  status: string; created_at: string; decided_at: string | null; decided_by: string | null;
  decline_reason: string | null; invite_id: string | null;
};

function mapNomination(row: NominationRow): DocumentNomination {
  return {
    id: row.id, slug: row.slug, by: row.by_actor, email: row.email, name: row.name, why: row.why,
    status: (['pending', 'confirmed', 'declined', 'withdrawn'].includes(row.status) ? row.status : 'pending') as NominationStatus,
    createdAt: row.created_at, decidedAt: row.decided_at, decidedBy: row.decided_by,
    declineReason: row.decline_reason, inviteId: row.invite_id,
  };
}

export function listNominations(slug: string): DocumentNomination[] {
  try {
    return (getDb().prepare(`SELECT * FROM document_nominations WHERE slug = ? ORDER BY created_at`).all(slug) as NominationRow[]).map(mapNomination);
  } catch {
    return [];
  }
}

export function openNominations(slug: string): DocumentNomination[] {
  return listNominations(slug).filter(nomination => nomination.status === 'pending');
}

export function getNomination(slug: string, id: string): DocumentNomination | null {
  try {
    const row = getDb().prepare(`SELECT * FROM document_nominations WHERE slug = ? AND id = ?`).get(slug, id) as NominationRow | undefined;
    return row ? mapNomination(row) : null;
  } catch {
    return null;
  }
}

export type NominationResult =
  | { ok: true; nomination: DocumentNomination; created: boolean }
  | { ok: false; status: number; code: string; error: string };

/** The AI's own call. Nothing is emailed and the person gets no access (nominationSendsNothing). */
export function createNomination(input: { slug: string; by: string; email: unknown; name?: unknown; why: unknown }): NominationResult {
  const email = normalizeEmail(input.email);
  if (!isPlausibleEmail(email)) return { ok: false, status: 400, code: 'INVALID_EMAIL', error: 'Pass "email": the address of the person you are nominating.' };
  const why = oneLineText(input.why, CROSS_INVITE_POLICY.maxWhyLength);
  if (CROSS_INVITE_POLICY.whyRequired && !why) {
    return { ok: false, status: 400, code: 'WHY_REQUIRED', error: 'Pass "why": one line the person who confirms this will read. Say who they are and why they belong on this document.' };
  }
  const name = oneLineText(input.name, 80) || null;
  const existing = listNominations(input.slug).find(n => n.status === 'pending' && n.email === email && actorKey(n.by) === actorKey(input.by));
  if (existing) return { ok: true, nomination: existing, created: false };
  const id = newId('nom');
  getDb().prepare(`
    INSERT INTO document_nominations (id, slug, by_actor, email, name, why, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, input.slug, input.by, email, name, why, nowIso());
  return { ok: true, nomination: getNomination(input.slug, id)!, created: true };
}

export function settleNomination(slug: string, id: string, status: Exclude<NominationStatus, 'pending'>, by: string, extra: { inviteId?: string | null; reason?: string | null } = {}): DocumentNomination | null {
  const changed = getDb().prepare(`
    UPDATE document_nominations SET status = ?, decided_at = ?, decided_by = ?, invite_id = ?, decline_reason = ?
    WHERE slug = ? AND id = ? AND status = 'pending'
  `).run(status, nowIso(), by, extra.inviteId ?? null, extra.reason ?? null, slug, id).changes > 0;
  return changed ? getNomination(slug, id) : null;
}

/**
 * Confirming a nomination is what actually invites the person: the invitation is created and
 * emailed exactly as if a person had typed the address, and the nomination records who confirmed
 * it. This is the one path from an AI's proposal to real access, and a human is always on it —
 * except where an Owner granted that AI standing permission (allowDirectInvite) on this document.
 */
export async function confirmNomination(input: {
  slug: string;
  nomination: DocumentNomination;
  by: string;
  byMemberId: string | null;
  origin: string;
  inviterName: string;
  title: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const created = createDocumentInvite({
    slug: input.slug,
    email: input.nomination.email,
    name: input.nomination.name ?? undefined,
    invitedByMemberId: input.byMemberId,
    invitedByActor: input.by,
  });
  if (!created.ok) return { status: created.status, body: { success: false, code: created.code, error: created.error } };
  const email = await sendInviteEmail({ invite: created.invite, origin: input.origin, inviterName: input.inviterName, title: input.title });
  const settled = settleNomination(input.slug, input.nomination.id, 'confirmed', input.by, { inviteId: created.invite.id })
    ?? getNomination(input.slug, input.nomination.id);
  return {
    status: 200,
    body: {
      success: true,
      nomination: settled,
      invite: { id: created.invite.id, email: created.invite.email, name: created.invite.name, status: created.invite.status },
      invited: true,
      emailed: email.sent,
      email,
    },
  };
}

/** Nomination Issues for the Issue report: open for the document's human owners. */
export function nominationIssueInputs(slug: string, owners: string[]): Array<{ id: string; by: string; email: string; name: string | null; why: string; at: string; openFor: string[] }> {
  if (!CROSS_INVITE_POLICY.nominationIsIssue) return [];
  const humanOwners = owners.filter(owner => /^human:/i.test(owner));
  return openNominations(slug).map(nomination => ({
    id: nomination.id, by: nomination.by, email: nomination.email, name: nomination.name,
    why: nomination.why, at: nomination.createdAt, openFor: humanOwners,
  }));
}

// ============================================================================
// 4. Attestations: an AI states who someone is — presence, never authority
// ============================================================================

export interface DocumentAttestation {
  id: string;
  slug: string;
  by: string;
  email: string;
  memberId: string | null;
  basis: string;
  confidence: AttestationConfidence;
  createdAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
}

type AttestationRow = {
  id: string; slug: string; by_actor: string; email: string; member_id: string | null; basis: string;
  confidence: string; created_at: string; revoked_at: string | null; revoked_by: string | null;
};

function mapAttestation(row: AttestationRow): DocumentAttestation {
  return {
    id: row.id, slug: row.slug, by: row.by_actor, email: row.email, memberId: row.member_id,
    basis: row.basis, confidence: isAttestationConfidence(row.confidence) ? row.confidence : 'low',
    createdAt: row.created_at, revokedAt: row.revoked_at, revokedBy: row.revoked_by,
  };
}

export function listAttestations(slug: string): DocumentAttestation[] {
  try {
    return (getDb().prepare(`SELECT * FROM document_attestations WHERE slug = ? ORDER BY created_at`).all(slug) as AttestationRow[]).map(mapAttestation);
  } catch {
    return [];
  }
}

export function activeAttestations(slug: string): DocumentAttestation[] {
  return listAttestations(slug).filter(a => !a.revokedAt);
}

export type AttestationResult =
  | { ok: true; attestation: DocumentAttestation; created: boolean; member: LibraryMember | null }
  | { ok: false; status: number; code: string; error: string };

/**
 * Records what the AI states, and grants that email read-and-comment on this document once it
 * signs in with that address. It never makes a mark count: attestedMarksCount is false and
 * countableAccessFor() is what decides that.
 */
export function createAttestation(input: { slug: string; by: string; email: unknown; basis: unknown; confidence: unknown }): AttestationResult {
  const email = normalizeEmail(input.email);
  if (!isPlausibleEmail(email)) return { ok: false, status: 400, code: 'INVALID_EMAIL', error: 'Pass "email": the address of the person you are attesting to.' };
  const basis = oneLineText(input.basis, CROSS_INVITE_POLICY.maxBasisLength);
  if (CROSS_INVITE_POLICY.basisRequired && !basis) {
    return { ok: false, status: 400, code: 'BASIS_REQUIRED', error: 'Pass "basis": how you know this is that person. It is shown with your attestation and a human reads it.' };
  }
  if (!isAttestationConfidence(input.confidence)) {
    return { ok: false, status: 400, code: 'INVALID_CONFIDENCE', error: `Pass "confidence": one of ${CROSS_INVITE_POLICY.confidences.join(', ')}.` };
  }
  const existing = activeAttestations(input.slug).find(a => a.email === email && actorKey(a.by) === actorKey(input.by));
  let member: LibraryMember | null = null;
  if (isLibraryEnabled()) {
    try {
      member = getLibraryMemberByEmail(email) ?? null;
      // An attested person needs somewhere to sign in to; they stay scope "invited", which shows
      // them only the documents they were let into, and this one grants comment access only.
      if (!member) member = createLibraryMember({ name: email, email, scope: 'invited' });
    } catch { member = null; }
  }
  if (existing) return { ok: true, attestation: existing, created: false, member };
  const id = newId('att');
  getDb().prepare(`
    INSERT INTO document_attestations (id, slug, by_actor, email, member_id, basis, confidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.slug, input.by, email, member?.id ?? null, basis, input.confidence, nowIso());
  const attestation = listAttestations(input.slug).find(a => a.id === id)!;
  return { ok: true, attestation, created: true, member };
}

export function revokeAttestation(slug: string, id: string, by: string): boolean {
  return getDb().prepare(`
    UPDATE document_attestations SET revoked_at = ?, revoked_by = ? WHERE slug = ? AND id = ? AND revoked_at IS NULL
  `).run(nowIso(), by, slug, id).changes > 0;
}

/**
 * The attestation that lets this email open the document, or null. An attestation by an AI whose
 * sponsor has lost access grants nothing (attestationNeedsLiveSponsor).
 */
export function attestationFor(slug: string, email: string | null | undefined): DocumentAttestation | null {
  const wanted = normalizeEmail(email);
  if (!wanted) return null;
  const keys = listAgentKeyViews(slug);
  for (const attestation of activeAttestations(slug)) {
    if (attestation.email !== wanted) continue;
    if (!CROSS_INVITE_POLICY.attestationNeedsLiveSponsor) return attestation;
    const key = keys.find(k => actorKey(k.actor) === actorKey(attestation.by));
    // An attestation from an AI with no key row left (revoked) or a suspended one grants nothing.
    if (key && !key.suspended) return attestation;
  }
  return null;
}

// The access layer asks here whether a signed-in email is attested on this document.
registerAttestedAccessCheck((slug, email) => {
  try {
    const attestation = attestationFor(slug, email);
    return attestation ? { actor: attestation.by, basis: attestation.basis, at: attestation.createdAt, id: attestation.id } : null;
  } catch {
    return null;
  }
});

/** The slugs an attested person may open (their Documents list, alongside their invitations). */
export function attestedSlugsFor(email: string | null | undefined): string[] {
  const wanted = normalizeEmail(email);
  if (!wanted) return [];
  try {
    const rows = getDb().prepare(`SELECT DISTINCT slug FROM document_attestations WHERE email = ? AND revoked_at IS NULL`).all(wanted) as Array<{ slug: string }>;
    return rows.map(row => row.slug).filter(slug => attestationFor(slug, wanted) !== null);
  } catch {
    return [];
  }
}

// ============================================================================
// 5. Provenance: how everyone on this document got in
// ============================================================================

/**
 * Every member row with its authority and evidence, in the shape an audit system wants:
 * actor, authority (kind + by), basis (the AI's words), evidence (runtime / confidence), time.
 */
export function documentProvenance(slug: string): Provenance[] {
  const out: Provenance[] = [];
  for (const owner of documentOwnerActors(slug)) {
    out.push({ actor: owner, kind: 'owner', by: null, at: '', counts: true, label: provenanceLabel({ kind: 'owner', name: displayName(owner) }) });
  }
  const nominations = listNominations(slug);
  for (const invite of listDocumentInvites(slug)) {
    const actor = verifiedHumanActor(invite.email);
    const nomination = nominations.find(n => n.status === 'confirmed' && n.inviteId === invite.id);
    if (nomination) {
      out.push({
        actor, kind: 'nominated', by: nomination.by, confirmedBy: nomination.decidedBy, basis: nomination.why,
        at: invite.createdAt, counts: true,
        label: provenanceLabel({ kind: 'nominated', name: invite.name, byName: displayName(nomination.by, slug), confirmedByName: nomination.decidedBy ? displayName(nomination.decidedBy, slug) : null }),
      });
    } else {
      out.push({
        actor, kind: 'invited', by: invite.invitedBy, at: invite.createdAt, counts: true,
        label: provenanceLabel({ kind: 'invited', name: invite.name, byName: invite.invitedBy ? displayName(invite.invitedBy, slug) : 'an owner' }),
      });
    }
  }
  const invitedEmails = new Set(listDocumentInvites(slug).map(invite => invite.email));
  for (const attestation of activeAttestations(slug)) {
    if (invitedEmails.has(attestation.email)) continue; // A real invitation outranks an attestation.
    out.push({
      actor: verifiedHumanActor(attestation.email), kind: 'attested', by: attestation.by,
      basis: attestation.basis, confidence: attestation.confidence, at: attestation.createdAt,
      counts: CROSS_INVITE_POLICY.attestedMarksCount,
      label: provenanceLabel({ kind: 'attested', name: attestation.email, byName: displayName(attestation.by, slug) }),
    });
  }
  for (const key of listAgentKeyViews(slug)) {
    if (key.revokedAt) continue;
    out.push({
      actor: key.actor, kind: key.sponsorActor ? 'sponsored' : 'admin', by: key.sponsorActor,
      runtime: key.runtime, at: key.createdAt, counts: !key.suspended, label: key.provenanceLabel,
    });
  }
  return out;
}

/** The sponsor map the page needs to show "Izzy — added by Eric" next to an AI's marks. */
export function agentProvenanceMap(slug: string): Record<string, { label: string; sponsor: string | null; sponsorName: string | null; runtime: string | null; suspended: boolean }> {
  const out: Record<string, { label: string; sponsor: string | null; sponsorName: string | null; runtime: string | null; suspended: boolean }> = {};
  for (const key of listAgentKeyViews(slug)) {
    if (key.revokedAt) continue;
    out[key.actor] = { label: key.provenanceLabel, sponsor: key.sponsorActor, sponsorName: key.sponsorName, runtime: key.runtime, suspended: key.suspended };
  }
  return out;
}

/** Removing a person: revoke nothing, but their AIs go quiet with them (suspension is computed). */
export function revokeAgentKeysOfSponsor(slug: string, sponsorActor: string): number {
  let count = 0;
  for (const key of listAgentKeyViews(slug)) {
    if (key.revokedAt || !key.sponsorActor || actorKey(key.sponsorActor) !== actorKey(sponsorActor)) continue;
    if (revokeDocumentAgentKey(slug, key.tokenId)) count += 1;
  }
  return count;
}
