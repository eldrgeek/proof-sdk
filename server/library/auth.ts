import { createHash, randomBytes, randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { getClientIp } from '../client-address.js';
import { getCookie } from '../cookies.js';
import { getDb } from '../db.js';
import { getPublicOrigin, isSecureRequest } from '../public-origin.js';

export const LIBRARY_SESSION_COOKIE = 'proof_library_session';
const SESSION_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
const SESSION_TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;

export type LibrarySigninPurpose = 'invite' | 'device' | 'operator';

export interface LibraryMember {
  id: string;
  name: string;
  email: string | null;
  isOwner: boolean;
  invitedBy: string | null;
  createdAt: string;
  removedAt: string | null;
}

type LibraryMemberRow = {
  id: string;
  name: string;
  email: string | null;
  is_owner: number;
  invited_by: string | null;
  created_at: string;
  removed_at: string | null;
};

type LibrarySessionRow = {
  session_hash: string;
  member_id: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  user_agent: string | null;
  soma_verified_at: string | null;
  soma_admin: number;
};

const signinAttemptBuckets = new Map<string, { count: number; resetAt: number }>();

function hashOpaqueValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function randomOpaqueValue(): string {
  return randomBytes(32).toString('base64url');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function mapMember(row: LibraryMemberRow): LibraryMember {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    isOwner: row.is_owner === 1,
    invitedBy: row.invited_by,
    createdAt: row.created_at,
    removedAt: row.removed_at,
  };
}

export function isLibraryEnabled(): boolean {
  return process.env.PROOF_LIBRARY_ENABLED === '1';
}

export function createLibraryMember(input: {
  name: string;
  email: string;
  isOwner?: boolean;
  invitedBy?: string | null;
}): LibraryMember {
  const name = input.name.replace(/\s+/g, ' ').trim();
  const email = normalizeEmail(input.email);
  if (!name) throw new Error('Name is required');
  if (!email || !email.includes('@')) throw new Error('A valid email is required');

  const now = new Date().toISOString();
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO library_members (id, name, email, is_owner, invited_by, created_at, removed_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run(id, name, email, input.isOwner ? 1 : 0, input.invitedBy ?? null, now);
  return getLibraryMemberById(id) as LibraryMember;
}

export function getLibraryMemberById(id: string): LibraryMember | null {
  const row = getDb().prepare(`
    SELECT * FROM library_members WHERE id = ? LIMIT 1
  `).get(id) as LibraryMemberRow | undefined;
  return row ? mapMember(row) : null;
}

export function getLibraryMemberByEmail(email: string): LibraryMember | null {
  const row = getDb().prepare(`
    SELECT * FROM library_members WHERE email = ? LIMIT 1
  `).get(normalizeEmail(email)) as LibraryMemberRow | undefined;
  return row ? mapMember(row) : null;
}

export function listLibraryMembers(): LibraryMember[] {
  const rows = getDb().prepare(`
    SELECT * FROM library_members ORDER BY removed_at IS NOT NULL, name COLLATE NOCASE, created_at
  `).all() as LibraryMemberRow[];
  return rows.map(mapMember);
}

export function listLibraryPeople(): Array<LibraryMember & {
  invitedByName: string | null;
  lastActiveAt: string | null;
}> {
  const rows = getDb().prepare(`
    SELECT
      member.*,
      inviter.name AS invited_by_name,
      MAX(sessions.last_seen_at) AS last_active_at
    FROM library_members member
    LEFT JOIN library_members inviter ON inviter.id = member.invited_by
    LEFT JOIN library_sessions sessions
      ON sessions.member_id = member.id AND sessions.revoked_at IS NULL
    WHERE member.removed_at IS NULL
    GROUP BY member.id
    ORDER BY member.name COLLATE NOCASE, member.created_at
  `).all() as Array<LibraryMemberRow & {
    invited_by_name: string | null;
    last_active_at: string | null;
  }>;
  return rows.map((row) => ({
    ...mapMember(row),
    ...(isSomaAuthEnabled() ? { isOwner: Boolean(getDb().prepare(`
      SELECT 1 FROM library_sessions WHERE member_id = ? AND soma_admin = 1
        AND revoked_at IS NULL AND expires_at > ? AND soma_verified_at > ? LIMIT 1
    `).get(row.id, new Date().toISOString(), new Date(Date.now() - SESSION_TOUCH_AFTER_MS).toISOString())) } : {}),
    invitedByName: row.invited_by_name,
    lastActiveAt: row.last_active_at,
  }));
}

export function removeLibraryMember(memberId: string): boolean {
  const now = new Date().toISOString();
  const db = getDb();
  return db.transaction(() => {
    const result = db.prepare(`
      UPDATE library_members SET removed_at = ?
      WHERE id = ? AND removed_at IS NULL
    `).run(now, memberId);
    if (result.changes === 0) return false;
    db.prepare(`
      UPDATE library_sessions SET revoked_at = ?
      WHERE member_id = ? AND revoked_at IS NULL
    `).run(now, memberId);
    db.prepare(`
      UPDATE library_signin_links SET used_at = ?
      WHERE member_id = ? AND used_at IS NULL
    `).run(now, memberId);
    return true;
  })();
}

function purposeLifetimeMs(purpose: LibrarySigninPurpose, hours?: number): number {
  if (purpose === 'invite') return 7 * 24 * 60 * 60 * 1000;
  if (purpose === 'device') return 30 * 60 * 1000;
  return Math.max(1, hours ?? 24) * 60 * 60 * 1000;
}

export function createLibrarySigninLink(input: {
  memberId: string;
  purpose: LibrarySigninPurpose;
  createdBy?: string | null;
  origin: string;
  hours?: number;
}): { link: string; expiresAt: string } {
  const member = getLibraryMemberById(input.memberId);
  if (!member || member.removedAt) throw new Error('Member not found');

  const token = randomOpaqueValue();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + purposeLifetimeMs(input.purpose, input.hours)).toISOString();
  getDb().prepare(`
    INSERT INTO library_signin_links (
      token_hash, member_id, purpose, created_by, created_at, expires_at, used_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run(
    hashOpaqueValue(token),
    input.memberId,
    input.purpose,
    input.createdBy ?? null,
    now.toISOString(),
    expiresAt,
  );
  const origin = input.origin.replace(/\/+$/, '');
  return { link: `${origin}/library/signin#t=${token}`, expiresAt };
}

export function consumeLibrarySigninToken(
  token: string,
  userAgent: string | null,
): { member: LibraryMember; sessionId: string; expiresAt: string } | null {
  if (!token || token.length > 256) return null;
  const tokenHash = hashOpaqueValue(token);
  const now = new Date();
  const nowIso = now.toISOString();
  const sessionId = randomOpaqueValue();
  const sessionHash = hashOpaqueValue(sessionId);
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  const db = getDb();

  return db.transaction(() => {
    const link = db.prepare(`
      SELECT member_id
      FROM library_signin_links
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
      LIMIT 1
    `).get(tokenHash, nowIso) as { member_id: string } | undefined;
    if (!link) return null;

    const member = getLibraryMemberById(link.member_id);
    if (!member || member.removedAt) return null;

    const used = db.prepare(`
      UPDATE library_signin_links SET used_at = ?
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
    `).run(nowIso, tokenHash, nowIso);
    if (used.changes !== 1) return null;

    db.prepare(`
      INSERT INTO library_sessions (
        session_hash, member_id, created_at, expires_at, last_seen_at, revoked_at, user_agent
      ) VALUES (?, ?, ?, ?, ?, NULL, ?)
    `).run(sessionHash, member.id, nowIso, expiresAt, nowIso, userAgent);
    return { member, sessionId, expiresAt };
  })();
}

function appendLibraryCookie(req: Request, res: Response, value: string, maxAge: number): void {
  const parts = [
    `${LIBRARY_SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAge}`,
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function setLibrarySessionCookie(req: Request, res: Response, sessionId: string): void {
  appendLibraryCookie(req, res, sessionId, SESSION_MAX_AGE_SECONDS);
}

export function clearLibrarySessionCookie(req: Request, res: Response): void {
  appendLibraryCookie(req, res, '', 0);
}

export function getLibrarySession(
  req: Request,
  res?: Response,
): { member: LibraryMember; sessionHash: string } | null {
  const sessionId = getCookie(req, LIBRARY_SESSION_COOKIE);
  if (!sessionId) return null;
  const sessionHash = hashOpaqueValue(sessionId);
  const now = new Date();
  const nowIso = now.toISOString();
  const row = getDb().prepare(`
    SELECT s.*
    FROM library_sessions s
    JOIN library_members m ON m.id = s.member_id
    WHERE s.session_hash = ?
      AND s.revoked_at IS NULL
      AND s.expires_at > ?
      AND m.removed_at IS NULL
    LIMIT 1
  `).get(sessionHash, nowIso) as LibrarySessionRow | undefined;
  if (!row || (isSomaAuthEnabled() && !row.soma_verified_at)) return null;
  const member = getLibraryMemberById(row.member_id);
  if (!member) return null;

  if (isSomaAuthEnabled()) {
    // No stored upstream token: an expired admin lease fails closed until the
    // browser supplies a fresh token to the session endpoint for the daily check.
    member.isOwner = row.soma_admin === 1 && Date.parse(row.soma_verified_at || "") + SESSION_TOUCH_AFTER_MS > now.getTime();
    return { member, sessionHash };
  }

  const lastSeen = Date.parse(row.last_seen_at);
  if (!Number.isFinite(lastSeen) || now.getTime() - lastSeen > SESSION_TOUCH_AFTER_MS) {
    const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
    getDb().prepare(`
      UPDATE library_sessions SET last_seen_at = ?, expires_at = ?
      WHERE session_hash = ?
    `).run(nowIso, expiresAt, sessionHash);
    if (res) setLibrarySessionCookie(req, res, sessionId);
  }
  return { member, sessionHash };
}

export function revokeLibrarySession(req: Request): void {
  const sessionId = getCookie(req, LIBRARY_SESSION_COOKIE);
  if (!sessionId) return;
  getDb().prepare(`
    UPDATE library_sessions SET revoked_at = ?
    WHERE session_hash = ? AND revoked_at IS NULL
  `).run(new Date().toISOString(), hashOpaqueValue(sessionId));
}

export function requireLibrarySession(req: Request, res: Response, next: NextFunction): void {
  const session = getLibrarySession(req, res);
  if (!session) {
    res.status(401).json({ code: 'SIGNED_OUT' });
    return;
  }
  res.locals.librarySession = session;
  next();
}

export function requireLibraryJsonOrigin(req: Request, res: Response, next: NextFunction): void {
  if (!req.is('application/json') || req.header('origin') !== getPublicOrigin(req)) {
    res.status(403).json({ code: 'FORBIDDEN' });
    return;
  }
  next();
}

export function allowLibrarySigninAttempt(req: Request): boolean {
  const now = Date.now();
  const ip = getClientIp(req);
  for (const [key, bucket] of signinAttemptBuckets) {
    if (bucket.resetAt <= now) signinAttemptBuckets.delete(key);
  }
  const current = signinAttemptBuckets.get(ip);
  if (!current || current.resetAt <= now) {
    signinAttemptBuckets.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 });
    return true;
  }
  if (current.count >= 10) return false;
  current.count += 1;
  return true;
}

export function publicLibraryOrigin(req: Request): string {
  return getPublicOrigin(req);
}

export function isSomaAuthEnabled(): boolean {
  return process.env.PROOF_SOMA_AUTH_ENABLED === '1';
}

// Verify identity remotely. Neither email nor privilege ever comes from req.body.
export async function exchangeSomaSession(req: Request): Promise<{
  sessionId?: string; email?: string; isAdmin?: boolean; refreshAfterMs?: number; status: number; message?: string;
}> {
  const token = req.body?.accessToken;
  if (typeof token !== 'string' || !token || token.length > 16384) {
    return { status: 401, message: 'Your sign-in has expired. Please sign in again.' };
  }
  const base = process.env.SOMA_AUTH_URL?.replace(/\/+$/, '');
  const apikey = process.env.SOMA_AUTH_ANON_KEY;
  if (!base || !apikey) return { status: 503, message: 'Sign-in is unavailable. Please try again later.' };
  const headers = { apikey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  try {
    const verified = await fetch(`${base}/auth/v1/user`, { headers, signal: AbortSignal.timeout(10000) });
    if (!verified.ok) return { status: verified.status >= 500 ? 503 : 401, message: 'Please sign in again.' };
    const user = await verified.json() as {
      email?: string; email_confirmed_at?: string | null; confirmed_at?: string | null;
      user_metadata?: { full_name?: string; name?: string };
    };
    if (typeof user.email !== 'string' || !user.email.includes('@')) return { status: 401, message: 'A verified email is required.' };
    // Membership is granted by email, so only an email Supabase has confirmed may claim it.
    // The shared project requires confirmation today; this keeps Proof+ safe if that setting changes.
    if (!user.email_confirmed_at) return { status: 401, message: 'Please confirm your email address, then sign in again.' };
    const email = normalizeEmail(user.email);
    let member = getLibraryMemberByEmail(email);
    const existing = getLibrarySession(req);
    const previous = existing && existing.member.email === email
      ? getDb().prepare('SELECT * FROM library_sessions WHERE session_hash = ?').get(existing.sessionHash) as LibrarySessionRow
      : null;
    const now = new Date();
    if (previous && Date.parse(previous.soma_verified_at || '') + SESSION_TOUCH_AFTER_MS > now.getTime()) {
      return { status: 200, isAdmin: previous.soma_admin === 1, refreshAfterMs: Date.parse(previous.soma_verified_at!) + SESSION_TOUCH_AFTER_MS - now.getTime(), sessionId: getCookie(req, LIBRARY_SESSION_COOKIE) || undefined };
    }
    const role = await fetch(`${base}/rest/v1/rpc/is_app_admin`, {
      method: 'POST', headers, body: JSON.stringify({ target_app: 'proof-plus' }), signal: AbortSignal.timeout(10000),
    });
    if (!role.ok) return { status: 503, message: 'Could not check access. Please try again later.' };
    const isAdmin = await role.json() === true;
    if (!isAdmin && (!member || member.removedAt)) {
      return { status: 403, email, message: `You're signed in as ${email}, but this Proof+ isn't shared with that address. Ask Mike or Eric to add you.` };
    }
    if (!member) {
      const metadataName = user.user_metadata?.full_name || user.user_metadata?.name;
      member = createLibraryMember({ name: typeof metadataName === 'string' ? metadataName : email, email });
    } else if (member.removedAt && isAdmin) {
      getDb().prepare('UPDATE library_members SET removed_at = NULL WHERE id = ?').run(member.id);
    }
    const sessionId = previous ? getCookie(req, LIBRARY_SESSION_COOKIE)! : randomOpaqueValue();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
    getDb().prepare(`
      INSERT INTO library_sessions (session_hash, member_id, created_at, expires_at, last_seen_at, user_agent, soma_verified_at, soma_admin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_hash) DO UPDATE SET expires_at=excluded.expires_at,
        last_seen_at=excluded.last_seen_at, soma_verified_at=excluded.soma_verified_at, soma_admin=excluded.soma_admin
    `).run(hashOpaqueValue(sessionId), member.id, nowIso, expiresAt, nowIso, req.header('user-agent')?.slice(0, 500) || null, nowIso, isAdmin ? 1 : 0);
    return { status: 200, sessionId, isAdmin, refreshAfterMs: SESSION_TOUCH_AFTER_MS };
  } catch {
    return { status: 503, message: 'Sign-in is unavailable. Please try again later.' };
  }
}
