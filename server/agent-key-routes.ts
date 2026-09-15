import { Router, type RequestHandler } from 'express';
import { createDocumentAccessToken, getDocumentBySlug, listDocumentAgentKeys, revokeDocumentAgentKey } from './db.js';
import { getClientIp } from './client-address.js';
import { createRateLimiter } from './rate-limiter.js';
import { resolveSharePageAccess } from './share-page-access.js';

export const agentKeyRoutes = Router();
// Independent budgets: changing addresses cannot evade the document budget, and
// changing documents cannot evade the address budget. Each server process enforces these.
const documentLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 10,
  keyFn: req => String(req.params.slug) });
const addressLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 30,
  keyFn: getClientIp });

const authorize: RequestHandler = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const slug = String(req.params.slug);
  const access = resolveSharePageAccess(req, res, slug, getDocumentBySlug(slug) ?? null);
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
  .post(authorize, documentLimit, addressLimit, (req, res) => {
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
