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

/** The live page and agent-key management must use this same access decision.
 * SOMA currently identifies visitors; it does not gate page access. Keep any future
 * sign-in requirement here so key management follows the page's editing rights.
 */
export function resolveSharePageAccess(req: Request, res: Response, slug: string, doc: DocumentRow | null) {
  const librarySession = isLibraryEnabled() ? getLibrarySession(req, res) : null;
  const query = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  const cookie = getCookie(req, shareTokenCookieName(slug)) ?? '';
  const header = (req.header('x-share-token') || req.header('x-bridge-token')
    || req.header('authorization')?.replace(/^Bearer\s+/i, '') || '').trim();
  let token: string | null = null;
  let tokenSource: 'query:token' | 'cookie' | 'header' | 'none' = 'none';
  let resolved: ReturnType<typeof resolveDocumentAccess> = null;
  // The editor forwards its URL credential in a header. Otherwise preserve the
  // page's valid-query, then valid-cookie precedence (including stale links).
  for (const [secret, source] of [[header, 'header'], [query, 'query:token'], [cookie, 'cookie']] as const) {
    const access = secret ? resolveDocumentAccess(slug, secret) : null;
    if (access) {
      token = secret;
      tokenSource = source;
      resolved = access;
      break;
    }
  }
  // Product decision: tokenless shares are editable; the slug is the secret.
  const role = resolved?.role ?? 'editor';
  const capabilities = deriveShareCapabilities(role, doc?.share_state ?? 'MISSING');
  return { librarySession, token, tokenSource, role, roleFromToken: resolved?.role ?? null,
    tokenId: resolved?.tokenId ?? null, capabilities };
}
