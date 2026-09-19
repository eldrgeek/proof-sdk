import type { Request, Response } from 'express';
import { resolveDocumentAccess, type DocumentRow } from './db.js';
import { getCookie, shareTokenCookieName } from './cookies.js';
import { resolveTokenlessAccess } from './document-team.js';
import type { ShareRole } from './share-types.js';

export function deriveShareCapabilities(role: ShareRole, shareState: string) {
  const isOwner = role === 'owner_bot';
  return {
    canRead: shareState === 'ACTIVE' || (isOwner && shareState !== 'DELETED'),
    canEdit: isOwner
      ? shareState === 'ACTIVE' || shareState === 'PAUSED'
      : role === 'editor' && shareState === 'ACTIVE',
    canComment: shareState === 'ACTIVE' && (role === 'commenter' || role === 'editor' || isOwner),
  };
}

/** Preserve page credential precedence; key management explicitly opts into headers
 * and rejects unresolved credentials instead of falling back to anonymous access.
 */
export function resolveSharePageAccess(req: Request, res: Response, slug: string, doc: DocumentRow | null, mode: 'page' | 'key-management' = 'page') {
  // Invite person: the session counts here only for a library member or someone invited to this
  // document; without a token everyone else gets the document's guest setting.
  const tokenless = resolveTokenlessAccess(req, slug, res);
  const librarySession = tokenless.documentSession?.session ?? null;
  // Cross invitation: an attested person is signed in but is not a member here. The page shows
  // their name (so it never asks a signed-in person to type one); nothing else may use this.
  const attestedSession = tokenless.attestedSession ?? null;
  const query = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  const cookie = getCookie(req, shareTokenCookieName(slug)) ?? '';
  const header = (req.header('x-share-token') || req.header('x-bridge-token')
    || req.header('authorization')?.replace(/^Bearer\s+/i, '') || '').trim();
  const presentedCredentials = [
    req.header('x-share-token'), req.header('x-bridge-token'),
    req.header('authorization')?.replace(/^Bearer\s+/i, ''),
    req.query.token === undefined ? undefined : query,
    getCookie(req, shareTokenCookieName(slug)),
  ];
  const invalidCredential = mode === 'key-management' && presentedCredentials.some(
    secret => secret !== undefined && secret !== null && !resolveDocumentAccess(slug, secret.trim()),
  );
  let token: string | null = null;
  let tokenSource: 'query:token' | 'cookie' | 'header' | 'none' = 'none';
  let resolved: ReturnType<typeof resolveDocumentAccess> = null;
  // Pages prefer a valid query, then a valid cookie, and ignore auth headers.
  // Key management receives the editor's URL credential through a header.
  const candidates = mode === 'key-management'
    ? [[header, 'header'], [query, 'query:token'], [cookie, 'cookie']] as const
    : [[query, 'query:token'], [cookie, 'cookie']] as const;
  for (const [secret, source] of candidates) {
    const access = secret ? resolveDocumentAccess(slug, secret) : null;
    if (access) {
      token = secret;
      tokenSource = source;
      resolved = access;
      break;
    }
  }
  const role: ShareRole | null = resolved ? resolved.role : tokenless.role;
  const capabilities = role
    ? deriveShareCapabilities(role, doc?.share_state ?? 'MISSING')
    : { canRead: false, canEdit: false, canComment: false };
  return { librarySession, attestedSession, token, tokenSource, invalidCredential, role, roleFromToken: resolved?.role ?? null,
    tokenId: resolved?.tokenId ?? null, capabilities,
    /** True when the page is closed only because the document is private and nobody signed in. */
    signInRequired: !resolved && !role && doc?.share_state === 'ACTIVE',
    inviteId: resolved ? null : tokenless.documentSession?.inviteId ?? null,
    guestMode: tokenless.guestMode };
}
