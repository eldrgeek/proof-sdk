import { Router, type RequestHandler } from 'express';
import { createDocumentAccessToken, getDocumentBySlug, listDocumentAgentKeys, revokeDocumentAgentKey } from './db.js';
import { getClientIp } from './client-address.js';
import { createRateLimiter } from './rate-limiter.js';
import { requireLibraryJsonOrigin } from './library/auth.js';
import { getPublicOrigin } from './public-origin.js';
import { resolveSharePageAccess } from './share-page-access.js';

// Run before general CORS (including preflight) on both public route aliases.
export const requireAgentKeyOrigin: RequestHandler = (req, res, next) => {
  if (!/^\/(?:api\/)?documents\/[^/]+\/agent-keys(?:\/|$)/i.test(req.path)) return next();
  const origin = req.header('origin');
  if (origin !== undefined && origin !== getPublicOrigin(req)) {
    res.status(403).json({ code: 'FORBIDDEN' });
    return;
  }
  if (req.method === 'POST' || req.method === 'DELETE') {
    requireLibraryJsonOrigin(req, res, next);
    return;
  }
  next();
};

export const agentKeyRoutes = Router();
agentKeyRoutes.use(requireAgentKeyOrigin);
// Independent budgets: changing addresses cannot evade the document budget, and
// changing documents cannot evade the address budget. Each server process enforces these.
const documentLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 10,
  keyFn: req => String(req.params.slug) });
const addressLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 30,
  keyFn: getClientIp });

const authorize: RequestHandler = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const slug = String(req.params.slug);
  const access = resolveSharePageAccess(req, res, slug, getDocumentBySlug(slug) ?? null, 'key-management');
  if (access.invalidCredential) {
    res.status(401).json({ error: 'Invalid document credential' });
    return;
  }
  if (!access.capabilities.canEdit) {
    res.status(403).json({ error: 'Document editing access required' });
    return;
  }
  res.locals.agentKeyRequester = access.librarySession
    ? `library:${access.librarySession.member.id}`
    : access.tokenId ? `access:${access.tokenId}`
      : access.role === 'owner_bot' ? 'document-owner' : 'anonymous-page-editor';
  next();
};

agentKeyRoutes.route('/documents/:slug/agent-keys')
  .get(authorize, (req, res) => {
    res.json({ keys: listDocumentAgentKeys(String(req.params.slug)) });
  })
  .post(authorize, (req, res, next) => {
    // Owner editing on a paused page does not authorize issuing new agent keys.
    if (getDocumentBySlug(String(req.params.slug))?.share_state !== 'ACTIVE') {
      res.status(403).json({ error: 'Sharing must be active to create agent keys' });
      return;
    }
    next();
  }, documentLimit, addressLimit, (req, res) => {
    const label = req.body?.label ?? 'AI assistant';
    if (typeof label !== 'string' || !label.trim() || label.trim().length > 80 || /[\x00-\x1f\x7f]/.test(label)) {
      res.status(400).json({ error: 'Agent name must be 1–80 characters without control characters' });
      return;
    }
    const created = createDocumentAccessToken(String(req.params.slug), 'editor', undefined, {
      label: label.trim(), requestedBy: res.locals.agentKeyRequester, requestedFrom: getClientIp(req),
    });
    // This is the only response that contains the secret. Never return a tokenized URL.
    res.status(201).json({ tokenId: created.tokenId, token: created.secret, label: label.trim(),
      createdAt: created.createdAt, lastUsedAt: null, revokedAt: null });
  });

agentKeyRoutes.delete('/documents/:slug/agent-keys/:tokenId', authorize, (req, res) => {
  if (!revokeDocumentAgentKey(String(req.params.slug), String(req.params.tokenId))) {
    res.status(404).json({ error: 'Agent key not found' });
    return;
  }
  res.json({ success: true });
});
