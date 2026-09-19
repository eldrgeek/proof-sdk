import { Router, type RequestHandler } from 'express';
import { createDocumentAccessToken, getDocumentBySlug, revokeDocumentAgentKey } from './db.js';
import { getClientIp } from './client-address.js';
import { createRateLimiter } from './rate-limiter.js';
import { requireLibraryJsonOrigin } from './library/auth.js';
import { getPublicOrigin } from './public-origin.js';
import { resolveSharePageAccess } from './share-page-access.js';
import {
  CROSS_INVITE_POLICY,
  agentKeyViewForToken,
  allowCrossInvite,
  listAgentKeyViews,
  normalizeRuntime,
  sponsorRequiredFor,
} from './cross-invitation.js';
import { verifiedHumanActor } from '../src/shared/identity.js';

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
  res.locals.agentKeyAccess = access;
  res.locals.agentKeyRequester = access.librarySession
    ? `library:${access.librarySession.member.id}`
    : access.tokenId ? `access:${access.tokenId}`
      : access.role === 'owner_bot' ? 'document-owner' : 'anonymous-page-editor';
  next();
};

agentKeyRoutes.route('/documents/:slug/agent-keys')
  .get(authorize, (req, res) => {
    // Cross invitation: the list carries each AI's sponsor and runtime ("Izzy — added by Eric").
    res.json({
      keys: listAgentKeyViews(String(req.params.slug)).map(key => ({
        tokenId: key.tokenId, label: key.label, createdAt: key.createdAt, lastUsedAt: key.lastUsedAt,
        revokedAt: key.revokedAt, sponsor: key.sponsorActor, sponsorName: key.sponsorName,
        runtime: key.runtime, suspended: key.suspended, allowDirectInvite: key.allowDirectInvite,
        provenance: key.provenanceLabel,
      })),
      runtimeRequired: CROSS_INVITE_POLICY.runtimeRequired && sponsorRequiredFor(String(req.params.slug)),
      runtimeSuggestions: CROSS_INVITE_POLICY.runtimeSuggestions,
    });
  })
  .post(authorize, (req, res, next) => {
    // Owner editing on a paused page does not authorize issuing new agent keys.
    if (getDocumentBySlug(String(req.params.slug))?.share_state !== 'ACTIVE') {
      res.status(403).json({ error: 'Sharing must be active to create agent keys' });
      return;
    }
    next();
  }, documentLimit, addressLimit, (req, res) => {
    const slug = String(req.params.slug);
    const access = res.locals.agentKeyAccess as ReturnType<typeof resolveSharePageAccess>;
    const label = req.body?.label ?? 'AI assistant';
    if (typeof label !== 'string' || !label.trim() || label.trim().length > 80 || /[\x00-\x1f\x7f]/.test(label)) {
      res.status(400).json({ error: 'Agent name must be 1–80 characters without control characters' });
      return;
    }

    // Cross invitation, the depth cap (Mike, 2026-09-19): only humans admit AIs.
    if (!CROSS_INVITE_POLICY.aiMayAdmitAi && agentKeyViewForToken(slug, access.tokenId)) {
      res.status(403).json({
        code: 'AI_CANNOT_ADMIT_AI',
        error: 'An AI cannot add another AI. Ask the person who added you to add it, so that every AI has a human sponsor.',
      });
      return;
    }

    // Stricter admission for an AI: the sponsor's live session, never a share token.
    const sponsorNeeded = sponsorRequiredFor(slug);
    const member = access.librarySession?.member ?? null;
    const sponsorActor = member?.email ? verifiedHumanActor(member.email) : null;
    if (sponsorNeeded && access.role !== 'owner_bot' && !sponsorActor) {
      res.status(403).json({
        code: 'SPONSOR_SESSION_REQUIRED',
        error: 'Adding an AI needs a signed-in person: every AI is bound to the human who added it. Sign in, then add it.',
        signInUrl: '/',
      });
      return;
    }

    // The sponsor says what is running it. Free text, stored and shown exactly as typed.
    const runtime = normalizeRuntime(req.body?.runtime);
    if (sponsorNeeded && CROSS_INVITE_POLICY.runtimeRequired && !runtime) {
      res.status(400).json({
        code: 'RUNTIME_REQUIRED',
        error: 'Say what is running this AI (its model or operator, for example "Claude Opus 5 (Anthropic)"). It is shown next to everything the AI does.',
        suggestions: CROSS_INVITE_POLICY.runtimeSuggestions,
      });
      return;
    }

    if (sponsorNeeded && !allowCrossInvite([
      [`keys:doc:${slug}`, CROSS_INVITE_POLICY.keysPerDocumentPerHour],
      [`keys:sponsor:${slug}:${sponsorActor ?? 'owner-credential'}`, CROSS_INVITE_POLICY.keysPerSponsorPerHour],
    ])) {
      res.status(429).json({ code: 'RATE_LIMITED', error: 'Too many AIs added in the last hour. Try again later.' });
      return;
    }

    const created = createDocumentAccessToken(slug, 'editor', undefined, {
      label: label.trim(), requestedBy: res.locals.agentKeyRequester, requestedFrom: getClientIp(req),
      sponsorActor, sponsorMemberId: member?.id ?? null, runtime: runtime || null,
    });
    // This is the only response that contains the secret. Never return a tokenized URL.
    res.status(201).json({ tokenId: created.tokenId, token: created.secret, label: label.trim(),
      createdAt: created.createdAt, lastUsedAt: null, revokedAt: null,
      sponsor: sponsorActor, sponsorName: member?.name ?? null, runtime: runtime || null });
  });

agentKeyRoutes.delete('/documents/:slug/agent-keys/:tokenId', authorize, (req, res) => {
  if (!revokeDocumentAgentKey(String(req.params.slug), String(req.params.tokenId))) {
    res.status(404).json({ error: 'Agent key not found' });
    return;
  }
  res.json({ success: true });
});
