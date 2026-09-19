/**
 * Invite person (Mike Wolf, 2026-09-19: "Yes, build Invite person with that default").
 *
 * Two things live here:
 *   1. Who may open a document without a share token: library members (everything, as before),
 *      people invited to this document (a per-document membership), and everyone else (a guest),
 *      whose access is the document's guest setting: "private", "comment" (read, comment and
 *      chat; the default wherever sign-in exists) or "edit" (the behaviour before this change).
 *   2. Invites: an Owner adds a person by email to one document; the person signs in with SOMA
 *      Auth (or, without SOMA Auth, a one-time sign-in link) and sees only their documents.
 *
 * Share tokens (x-share-token, agent keys, the owner credential) are untouched: they decide
 * access exactly as before, and this module is consulted only when a request carries none.
 *
 * Authorship: brief by the COS (Mike Wolf's approval 2026-09-19); built by Claude Opus 5
 * (worker proof-invite), 2026-09-19.
 */
import { randomBytes } from 'crypto';
import { appendFileSync } from 'fs';
import type { Request, Response } from 'express';
import { getDb, registerCollabTokenCheck } from './db.js';
import { documentAccessEvents } from './document-access-events.js';
import {
  createLibraryMember,
  createLibrarySigninLink,
  getLibraryMemberByEmail,
  getLibrarySession,
  isLibraryEnabled,
  isSomaAuthEnabled,
  type LibraryMember,
} from './library/auth.js';
import type { ShareRole } from './share-types.js';

// ============================================================================
// Policy (Mike's later rulings should be one-line changes here)
// ============================================================================

export type GuestAccessMode = 'private' | 'comment' | 'edit';

export const GUEST_ACCESS_POLICY = {
  modes: ['private', 'comment', 'edit'] as readonly GuestAccessMode[],
  /** Mike, 2026-09-19: people who are not signed in can read and comment by default. */
  defaultWhenSignInExists: 'comment' as GuestAccessMode,
  /** A bare SDK server has no sign-in, so nobody could ever edit: keep the old behaviour. */
  defaultWithoutSignIn: 'edit' as GuestAccessMode,
  /** Operators (and the browser checks written before this change) may pick another default. */
  defaultEnv: 'PROOF_GUEST_ACCESS_DEFAULT',
  /** The share role a guest gets in each mode (null: cannot open the document). */
  guestRole: { private: null, comment: 'commenter', edit: 'editor' } as Record<GuestAccessMode, ShareRole | null>,
  /**
   * Modes in which a guest's line marks, ask answers, picks, approvals, flags and objections
   * count (recorded as guest:<name>). In the other modes they are refused with
   * 403 SIGN_IN_TO_MARK, not recorded as unverified suggestions: a refusal is visible and cannot
   * be mistaken for a counted mark later.
   */
  guestMarksCountIn: ['edit'] as readonly GuestAccessMode[],
  /** Tightening the setting closes guests' open editor connections at once (they reconnect with
   *  the new role); members' and invited people's connections are untouched. */
  closeGuestSessionsOnChange: true,
  /** Human labels for the dialog. */
  labels: {
    private: 'Only invited people and team members can open it',
    comment: 'Anyone with the link can read, comment and chat',
    edit: 'Anyone with the link can edit',
  } as Record<GuestAccessMode, string>,
} as const;

export const INVITE_POLICY = {
  /** Invites per document per hour, per inviter per hour and per address per hour. */
  perDocumentPerHour: 20,
  perInviterPerHour: 30,
  perAddressPerHour: 60,
  /** A resend of the same invite waits this long (SOMA Auth also limits one email a minute). */
  resendCooldownMs: 60_000,
  /** Invite ids are random and never grant access alone: the invited email must sign in. */
  idBytes: 18,
  /** Non-SOMA servers only: the emailed one-time sign-in link lives this long. */
  signinLinkHours: 7 * 24,
  maxNameLength: 80,
} as const;

export type InviteMailTransport = 'resend' | 'soma-otp' | 'capture' | 'none';

export const INVITE_MAIL_POLICY = {
  transportEnv: 'PROOF_INVITE_MAIL_TRANSPORT',
  captureFileEnv: 'PROOF_INVITE_MAIL_CAPTURE',
  fromEnv: 'PROOF_INVITE_MAIL_FROM',
  defaultFrom: 'Proof+ <proof@mike-wolf.com>',
  resendApiUrlEnv: 'PROOF_RESEND_API_URL',
  resendApiUrl: 'https://api.resend.com/emails',
  timeoutMs: 10_000,
} as const;

// ============================================================================
// Guest access setting
// ============================================================================

function isGuestAccessMode(value: unknown): value is GuestAccessMode {
  return typeof value === 'string' && (GUEST_ACCESS_POLICY.modes as readonly string[]).includes(value);
}

export function defaultGuestAccessMode(): GuestAccessMode {
  const configured = process.env[GUEST_ACCESS_POLICY.defaultEnv]?.trim().toLowerCase();
  if (isGuestAccessMode(configured)) return configured;
  return isLibraryEnabled() ? GUEST_ACCESS_POLICY.defaultWhenSignInExists : GUEST_ACCESS_POLICY.defaultWithoutSignIn;
}

export function getGuestAccessMode(slug: string): GuestAccessMode {
  try {
    const row = getDb().prepare('SELECT mode FROM document_guest_access WHERE slug = ?').get(slug) as { mode?: string } | undefined;
    if (isGuestAccessMode(row?.mode)) return row.mode;
  } catch {
    // Older databases without the table: the default applies.
  }
  return defaultGuestAccessMode();
}

export function setGuestAccessMode(slug: string, mode: unknown, by: string | null): { ok: true; mode: GuestAccessMode; changed: boolean } | { ok: false; error: string } {
  if (!isGuestAccessMode(mode)) return { ok: false, error: `mode must be one of ${GUEST_ACCESS_POLICY.modes.join(', ')}` };
  const before = getGuestAccessMode(slug);
  getDb().prepare(`
    INSERT INTO document_guest_access (slug, mode, updated_at, updated_by) VALUES (?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `).run(slug, mode, new Date().toISOString(), by);
  const changed = before !== mode;
  if (changed && GUEST_ACCESS_POLICY.closeGuestSessionsOnChange) {
    if (mode !== 'edit') documentAccessEvents.emit('revoked', slug, `${GUEST_COLLAB_TOKEN_PREFIX}edit`);
    if (mode === 'private') documentAccessEvents.emit('revoked', slug, `${GUEST_COLLAB_TOKEN_PREFIX}comment`);
  }
  return { ok: true, mode, changed };
}

export const INVITE_COLLAB_TOKEN_PREFIX = 'invite:';
export const GUEST_COLLAB_TOKEN_PREFIX = 'guest:';

registerCollabTokenCheck(INVITE_COLLAB_TOKEN_PREFIX, (slug, id) => {
  try {
    return Boolean(getDb().prepare(`SELECT 1 FROM document_invites WHERE slug = ? AND id = ? AND removed_at IS NULL`).get(slug, id));
  } catch {
    return false;
  }
});
// A guest's session stays good while the setting still grants what it was issued for.
registerCollabTokenCheck(GUEST_COLLAB_TOKEN_PREFIX, (slug, issuedFor) => {
  const mode = getGuestAccessMode(slug);
  if (issuedFor === 'edit') return mode === 'edit';
  if (issuedFor === 'comment') return mode !== 'private';
  return false;
});

export function guestMarksCount(slug: string): boolean {
  return GUEST_ACCESS_POLICY.guestMarksCountIn.includes(getGuestAccessMode(slug));
}

// ============================================================================
// Invites (storage)
// ============================================================================

export interface DocumentInvite {
  id: string;
  slug: string;
  memberId: string;
  email: string;
  name: string;
  invitedBy: string | null;
  invitedByMemberId: string | null;
  createdAt: string;
  joinedAt: string | null;
  lastSeenAt: string | null;
  lastSentAt: string | null;
  sendCount: number;
  status: 'invited' | 'joined';
}

type InviteRow = {
  id: string; slug: string; member_id: string; email: string; name: string | null;
  invited_by_member_id: string | null; invited_by_actor: string | null; created_at: string;
  removed_at: string | null; joined_at: string | null; last_seen_at: string | null;
  last_sent_at: string | null; send_count: number; member_name?: string | null;
};

function mapInvite(row: InviteRow): DocumentInvite {
  return {
    id: row.id,
    slug: row.slug,
    memberId: row.member_id,
    email: row.email,
    name: row.member_name || row.name || row.email,
    invitedBy: row.invited_by_actor,
    invitedByMemberId: row.invited_by_member_id,
    createdAt: row.created_at,
    joinedAt: row.joined_at,
    lastSeenAt: row.last_seen_at,
    lastSentAt: row.last_sent_at,
    sendCount: row.send_count,
    status: row.joined_at ? 'joined' : 'invited',
  };
}

export function listDocumentInvites(slug: string): DocumentInvite[] {
  try {
    const rows = getDb().prepare(`
      SELECT i.*, m.name AS member_name FROM document_invites i
      LEFT JOIN library_members m ON m.id = i.member_id
      WHERE i.slug = ? AND i.removed_at IS NULL ORDER BY i.created_at
    `).all(slug) as InviteRow[];
    return rows.map(mapInvite);
  } catch {
    return [];
  }
}

export function getActiveInvite(id: string): DocumentInvite | null {
  if (!id || id.length > 100) return null;
  try {
    const row = getDb().prepare(`
      SELECT i.*, m.name AS member_name FROM document_invites i
      LEFT JOIN library_members m ON m.id = i.member_id
      WHERE i.id = ? AND i.removed_at IS NULL
    `).get(id) as InviteRow | undefined;
    return row ? mapInvite(row) : null;
  } catch {
    return null;
  }
}

export function activeInviteFor(slug: string, memberId: string): DocumentInvite | null {
  try {
    const row = getDb().prepare(`
      SELECT * FROM document_invites WHERE slug = ? AND member_id = ? AND removed_at IS NULL LIMIT 1
    `).get(slug, memberId) as InviteRow | undefined;
    return row ? mapInvite(row) : null;
  } catch {
    return null;
  }
}

/** The documents an invited person may open (their whole left rail / library list). */
export function invitedSlugsFor(memberId: string): string[] {
  try {
    return (getDb().prepare(`SELECT slug FROM document_invites WHERE member_id = ? AND removed_at IS NULL`).all(memberId) as Array<{ slug: string }>).map(r => r.slug);
  } catch {
    return [];
  }
}

/** The most recent invite of an invited person: where they land after signing in. */
export function latestInviteSlugFor(memberId: string): string | null {
  try {
    const row = getDb().prepare(`
      SELECT slug FROM document_invites WHERE member_id = ? AND removed_at IS NULL ORDER BY created_at DESC LIMIT 1
    `).get(memberId) as { slug?: string } | undefined;
    return row?.slug ?? null;
  } catch {
    return null;
  }
}

export function touchInvite(id: string): void {
  const now = new Date().toISOString();
  getDb().prepare(`
    UPDATE document_invites SET joined_at = COALESCE(joined_at, ?), last_seen_at = ? WHERE id = ? AND removed_at IS NULL
  `).run(now, now, id);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isPlausibleEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(email);
}

export type CreateInviteResult =
  | { ok: true; invite: DocumentInvite; member: LibraryMember; created: boolean; alreadyMember: boolean }
  | { ok: false; status: number; code: string; error: string };

/** Adds a person to one document's team. Idempotent for an active invite of the same email. */
export function createDocumentInvite(input: {
  slug: string;
  email: unknown;
  name?: unknown;
  invitedByMemberId: string | null;
  invitedByActor: string;
}): CreateInviteResult {
  const email = typeof input.email === 'string' ? normalizeEmail(input.email) : '';
  if (!isPlausibleEmail(email)) return { ok: false, status: 400, code: 'INVALID_EMAIL', error: 'Enter a valid email address.' };
  const rawName = typeof input.name === 'string' ? input.name.replace(/\s+/g, ' ').trim() : '';
  if (rawName.length > INVITE_POLICY.maxNameLength || /[\x00-\x1f\x7f<>]/.test(rawName)) {
    return { ok: false, status: 400, code: 'INVALID_NAME', error: `A name has at most ${INVITE_POLICY.maxNameLength} characters, without < or >.` };
  }
  const db = getDb();
  return db.transaction((): CreateInviteResult => {
    let member = getLibraryMemberByEmail(email);
    if (member && member.removedAt) {
      // A removed library member comes back as an invited person only (never regains the library).
      db.prepare(`UPDATE library_members SET removed_at = NULL, scope = 'invited' WHERE id = ?`).run(member.id);
      member = getLibraryMemberByEmail(email);
    }
    if (!member) {
      member = createLibraryMember({ name: rawName || email, email, invitedBy: input.invitedByMemberId, scope: 'invited' });
    }
    const existing = activeInviteFor(input.slug, member.id);
    if (existing) return { ok: true, invite: existing, member, created: false, alreadyMember: member.scope === 'library' };
    const id = randomBytes(INVITE_POLICY.idBytes).toString('base64url');
    db.prepare(`
      INSERT INTO document_invites (id, slug, member_id, email, name, invited_by_member_id, invited_by_actor, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.slug, member.id, email, rawName || null, input.invitedByMemberId, input.invitedByActor, new Date().toISOString());
    return { ok: true, invite: getActiveInvite(id)!, member, created: true, alreadyMember: member.scope === 'library' };
  })();
}

/** Removes a person from one document. Their open editor connection closes at once. */
export function removeDocumentInvite(slug: string, id: string, by: string | null): boolean {
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    UPDATE document_invites SET removed_at = ?, removed_by = ? WHERE slug = ? AND id = ? AND removed_at IS NULL
  `).run(now, by, slug, id);
  if (result.changes === 0) return false;
  // Closes this process's collab sockets for "invite:<id>"; every later write re-checks the DB.
  documentAccessEvents.emit('revoked', slug, `${INVITE_COLLAB_TOKEN_PREFIX}${id}`);
  return true;
}

export function recordInviteSent(id: string): void {
  getDb().prepare(`UPDATE document_invites SET last_sent_at = ?, send_count = send_count + 1 WHERE id = ?`).run(new Date().toISOString(), id);
}

// ============================================================================
// Access for requests without a share token
// ============================================================================

export type DocumentSession = {
  session: NonNullable<ReturnType<typeof getLibrarySession>>;
  via: 'library' | 'invite';
  inviteId: string | null;
};

/**
 * The library session, but only when it grants something on this document: a library member
 * (any document) or a person invited to this one. An invited person on another document is a
 * guest there (the document's guest setting applies), never a verified identity.
 */
export function documentSession(req: Request, slug: string, res?: Response): DocumentSession | null {
  if (!isLibraryEnabled()) return null;
  let session: ReturnType<typeof getLibrarySession> = null;
  try { session = getLibrarySession(req, res); } catch { session = null; }
  if (!session) return null;
  if (session.member.scope !== 'invited') return { session, via: 'library', inviteId: null };
  const invite = activeInviteFor(slug, session.member.id);
  return invite ? { session, via: 'invite', inviteId: invite.id } : null;
}

export type TokenlessAccess = {
  role: ShareRole | null;
  via: 'library' | 'invite' | 'guest';
  guestMode: GuestAccessMode;
  /** Collab sessions of invited people carry this so removal revokes them. */
  collabTokenId: string | null;
  documentSession: DocumentSession | null;
};

/** Access for a request that presents no share token. */
export function resolveTokenlessAccess(req: Request, slug: string, res?: Response): TokenlessAccess {
  const guestMode = getGuestAccessMode(slug);
  const docSession = documentSession(req, slug, res);
  if (docSession) {
    return {
      role: 'editor',
      via: docSession.via,
      guestMode,
      collabTokenId: docSession.inviteId ? `${INVITE_COLLAB_TOKEN_PREFIX}${docSession.inviteId}` : null,
      documentSession: docSession,
    };
  }
  const role = GUEST_ACCESS_POLICY.guestRole[guestMode];
  return { role, via: 'guest', guestMode, collabTokenId: role ? `${GUEST_COLLAB_TOKEN_PREFIX}${guestMode}` : null, documentSession: null };
}

// ============================================================================
// Invite email
// ============================================================================

export function inviteMailTransport(): InviteMailTransport {
  const configured = process.env[INVITE_MAIL_POLICY.transportEnv]?.trim().toLowerCase();
  if (configured === 'resend' || configured === 'soma-otp' || configured === 'capture' || configured === 'none') return configured;
  if (process.env.RESEND_API_KEY) return 'resend';
  if (isSomaAuthEnabled() && process.env.SOMA_AUTH_URL && process.env.SOMA_AUTH_ANON_KEY) return 'soma-otp';
  return 'none';
}

export function inviteLandingUrl(origin: string, inviteId: string): string {
  return `${origin.replace(/\/+$/, '')}/invite/${encodeURIComponent(inviteId)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export type InviteMailResult = { sent: boolean; transport: InviteMailTransport; error?: string };

/**
 * Sends the invitation. With SOMA Auth the emailed link is the invite page (resend) or a SOMA
 * magic link that returns to it (soma-otp): either way only the invited address can sign in.
 * Without SOMA Auth the email carries a one-time sign-in link for that person (the library's
 * existing sign-in method), which opens the document after signing in.
 */
export async function sendInviteEmail(input: {
  invite: DocumentInvite;
  origin: string;
  inviterName: string;
  title: string;
}): Promise<InviteMailResult> {
  const transport = inviteMailTransport();
  if (transport === 'none') return { sent: false, transport };
  const landing = inviteLandingUrl(input.origin, input.invite.id);
  const link = isSomaAuthEnabled()
    ? landing
    : createLibrarySigninLink({
      memberId: input.invite.memberId,
      purpose: 'invite',
      createdBy: null,
      origin: input.origin,
      hours: INVITE_POLICY.signinLinkHours,
    }).link + `&next=${encodeURIComponent(`/d/${input.invite.slug}`)}`;
  const subject = `${input.inviterName} invited you to “${input.title}”`;
  const text = [
    `${input.inviterName} invited you to read and mark “${input.title}” in Proof+.`,
    '',
    `Open it: ${link}`,
    '',
    isSomaAuthEnabled()
      ? `You'll sign in as ${input.invite.email} (Google or an emailed sign-in link). The link only works for that address.`
      : 'This sign-in link works once, only for you.',
  ].join('\n');
  const html = `<p>${escapeHtml(input.inviterName)} invited you to read and mark <strong>${escapeHtml(input.title)}</strong> in Proof+.</p>`
    + `<p><a href="${escapeHtml(link)}">Open the document</a></p>`
    + `<p style="color:#666">${escapeHtml(isSomaAuthEnabled() ? `You'll sign in as ${input.invite.email}. The link only works for that address.` : 'This sign-in link works once, only for you.')}</p>`;
  try {
    if (transport === 'capture') {
      const file = process.env[INVITE_MAIL_POLICY.captureFileEnv];
      if (!file) return { sent: false, transport, error: 'No capture file configured' };
      appendFileSync(file, JSON.stringify({ to: input.invite.email, subject, text, link, inviteId: input.invite.id, slug: input.invite.slug, at: new Date().toISOString() }) + '\n');
      recordInviteSent(input.invite.id);
      return { sent: true, transport };
    }
    if (transport === 'resend') {
      const key = process.env.RESEND_API_KEY;
      if (!key) return { sent: false, transport, error: 'Email is not configured' };
      const response = await fetch(process.env[INVITE_MAIL_POLICY.resendApiUrlEnv] || INVITE_MAIL_POLICY.resendApiUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: process.env[INVITE_MAIL_POLICY.fromEnv] || INVITE_MAIL_POLICY.defaultFrom, to: [input.invite.email], subject, text, html }),
        signal: AbortSignal.timeout(INVITE_MAIL_POLICY.timeoutMs),
      });
      if (!response.ok) return { sent: false, transport, error: `The email service answered ${response.status}` };
      recordInviteSent(input.invite.id);
      return { sent: true, transport };
    }
    // soma-otp: SOMA Auth emails its magic link; following it signs in as that address and
    // returns to the invite page, which opens the document. No PKCE verifier exists for a
    // server-started link, so the invite page reads the implicit-grant token itself.
    const base = process.env.SOMA_AUTH_URL!.replace(/\/+$/, '');
    const response = await fetch(`${base}/auth/v1/otp?redirect_to=${encodeURIComponent(landing)}`, {
      method: 'POST',
      headers: { apikey: process.env.SOMA_AUTH_ANON_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: input.invite.email, create_user: true }),
      signal: AbortSignal.timeout(INVITE_MAIL_POLICY.timeoutMs),
    });
    if (response.status === 429) return { sent: false, transport, error: 'SOMA Auth is limiting emails right now; copy the invite link instead, or try again in a minute.' };
    if (!response.ok) return { sent: false, transport, error: `SOMA Auth answered ${response.status}` };
    recordInviteSent(input.invite.id);
    return { sent: true, transport };
  } catch {
    return { sent: false, transport, error: 'The email could not be sent' };
  }
}

// ============================================================================
// Rate limits (per process, like the agent-key limits)
// ============================================================================

const inviteBuckets = new Map<string, { count: number; resetAt: number }>();

/** Returns false when any of the keys is over its hourly budget; counts only when all pass. */
export function allowInvite(keys: Array<[string, number]>): boolean {
  const now = Date.now();
  for (const [key, bucket] of inviteBuckets) if (bucket.resetAt <= now) inviteBuckets.delete(key);
  for (const [key, limit] of keys) {
    const bucket = inviteBuckets.get(key);
    if (bucket && bucket.count >= limit) return false;
  }
  for (const [key] of keys) {
    const bucket = inviteBuckets.get(key);
    if (bucket) bucket.count += 1;
    else inviteBuckets.set(key, { count: 1, resetAt: now + 60 * 60 * 1000 });
  }
  return true;
}

export function resetInviteRateLimitsForTests(): void {
  inviteBuckets.clear();
}
