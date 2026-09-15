import type { Request, Response } from 'express';
import { resolveDocumentAccess, type DocumentRow } from './db.js';
import { getCookie, shareTokenCookieName } from './cookies.js';
import { getLibrarySession, isLibraryEnabled } from './library/auth.js';
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
  const librarySession = isLibraryEnabled() ? getLibrarySession(req, res) : null;
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
  // Omitting a credential still yields editor rights until A2 requires sign-in.
  const role = resolved?.role ?? 'editor';
  const capabilities = deriveShareCapabilities(role, doc?.share_state ?? 'MISSING');
  return { librarySession, token, tokenSource, invalidCredential, role, roleFromToken: resolved?.role ?? null,
    tokenId: resolved?.tokenId ?? null, capabilities };
}
