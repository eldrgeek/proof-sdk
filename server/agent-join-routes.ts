import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response, type RequestHandler } from 'express';
import { AGENT_JOIN_POLICY as P, agentJoinPath, validAgentJoinName, type AgentJoinRequest } from '../src/shared/agent-join.js';
import { verifiedHumanActor } from '../src/shared/identity.js';
import { createDocumentAccessToken, getDb, getDocumentBySlug, resolveDocumentAccess } from './db.js';
import { getCookie, shareTokenCookieName } from './cookies.js';
import { getClientIp } from './client-address.js';
import { resolveSharePageAccess, deriveShareCapabilities } from './share-page-access.js';
import { resolveTokenlessAccess } from './document-team.js';
import { CROSS_INVITE_POLICY, agentKeyViewForToken, allowCrossInvite, normalizeRuntime, sponsorRequiredFor } from './cross-invitation.js';
import { requireLibraryJsonOrigin } from './library/auth.js';
import { getPublicOrigin } from './public-origin.js';
import { documentLimit, addressLimit } from './agent-key-routes.js';

type JoinRow = AgentJoinRequest & {
  slug: string; pollHash: string; status: 'pending' | 'refused' | 'expired' | 'admitted';
  delivered: number; tokenId: string | null;
};
// Only hashes and public request metadata reach SQLite. The handover secret is
// process-local, with an actual expiry timer even if nobody polls again.
const secrets = new Map<string, { token: string; timer: ReturnType<typeof setTimeout> }>();
const listeners = new Map<string, Set<() => void>>();
let initialized = false;
function database() {
  const db = getDb();
  if (!initialized) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_join_requests (
      requestId TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, runtime TEXT NOT NULL,
      code TEXT NOT NULL, expiresAt TEXT NOT NULL, pollHash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', delivered INTEGER NOT NULL DEFAULT 0, tokenId TEXT
    ); CREATE INDEX IF NOT EXISTS agent_join_document ON agent_join_requests(slug, status, expiresAt);`);
    // A restart cannot recover a handover secret. Never claim it can be delivered.
    db.prepare("UPDATE agent_join_requests SET status = 'expired' WHERE status = 'admitted' AND delivered = 0").run();
    initialized = true;
  }
  return db;
}
function forget(id: string) {
  const secret = secrets.get(id);
  if (secret) clearTimeout(secret.timer);
  secrets.delete(id);
}
function expire() {
  const now = new Date().toISOString();
  database().prepare("UPDATE agent_join_requests SET status = 'expired' WHERE expiresAt <= ? AND (status = 'pending' OR (status = 'admitted' AND delivered = 0))").run(now);
  for (const id of secrets.keys()) {
    const row = database().prepare('SELECT status FROM agent_join_requests WHERE requestId = ?').get(id) as JoinRow | undefined;
    if (row?.status !== 'admitted') forget(id);
  }
}
function pending(slug: string): AgentJoinRequest[] {
  expire();
  return database().prepare("SELECT requestId, name, runtime, code, expiresAt FROM agent_join_requests WHERE slug = ? AND status = 'pending' ORDER BY expiresAt, requestId").all(slug) as AgentJoinRequest[];
}
function notify(slug: string) { for (const send of listeners.get(slug) ?? []) send(); }
const hash = (value: string) => createHash('sha256').update(value).digest();

/** Management routes run before CORS, just like Add agent. Public join/poll are HTTP APIs. */
export const requireAgentJoinOrigin: RequestHandler = (req, res, next) => {
  if (!/^\/(?:api\/)?documents\/[^/]+\/agent-joins(?:\/|$)/i.test(req.path)) return next();
  if (req.header('origin') !== undefined && req.header('origin') !== getPublicOrigin(req)) {
    res.status(403).json({ code: 'FORBIDDEN' }); return;
  }
  if (req.method === 'POST') return requireLibraryJsonOrigin(req, res, next);
  next();
};

type JoinMember = NonNullable<ReturnType<typeof resolveSharePageAccess>['librarySession']>['member'];
function admissionAccess(req: Request, res: Response, slug: string): { error: string; status: number } | { member: JoinMember | null } {
  const doc = getDocumentBySlug(slug) ?? null;
  const access = resolveSharePageAccess(req, res.headersSent ? undefined : res, slug, doc, 'key-management');
  if (access.invalidCredential) return { error: 'Invalid document credential', status: 401 } as const;
  const credentials = [req.header('x-share-token'), req.header('x-bridge-token'),
    req.header('authorization')?.replace(/^Bearer\s+/i, ''),
    typeof req.query.token === 'string' ? req.query.token : undefined, getCookie(req, shareTokenCookieName(slug))];
  if (credentials.some(secret => secret && agentKeyViewForToken(slug, resolveDocumentAccess(slug, secret.trim())?.tokenId ?? null))) {
    return { error: 'An AI cannot admit another AI.', status: 403 } as const;
  }
  // Authority must come from this person's session, never from a link credential.
  const tokenless = resolveTokenlessAccess(req, slug, res.headersSent ? undefined : res);
  if (!access.capabilities.canEdit || !tokenless.role || !deriveShareCapabilities(tokenless.role, doc?.share_state ?? 'MISSING').canEdit || doc?.share_state !== 'ACTIVE') {
    return { error: 'Document editing access required', status: 403 } as const;
  }
  const member = access.librarySession?.member ?? null;
  if (!member && (sponsorRequiredFor(slug) || credentials.some(value => value !== undefined && value !== null))) {
    return { error: 'Adding an AI needs a signed-in person.', status: 403 } as const;
  }
  return { member };
}
const authorize: RequestHandler = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const access = admissionAccess(req, res, String(req.params.slug));
  if ('error' in access) { res.status(access.status).json({ error: access.error }); return; }
  res.locals.joinMember = access.member;
  next();
};

export const agentJoinRoutes = Router();
agentJoinRoutes.use(requireAgentJoinOrigin);
agentJoinRoutes.post('/api/agent/:slug/join', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const slug = String(req.params.slug);
  const doc = getDocumentBySlug(slug) ?? null;
  const access = resolveSharePageAccess(req, res, slug, doc);
  if (doc && access.signInRequired) {
    res.status(401).json({ success: false, slug, code: 'SIGN_IN_REQUIRED', error: 'Sign in to open this document' }); return;
  }
  if (!doc || !access.capabilities.canRead || doc.share_state !== 'ACTIVE') {
    res.status(doc?.share_state === 'DELETED' ? 410 : 404).json({ error: 'Document unavailable' }); return;
  }
  next();
}, documentLimit, addressLimit, (req, res) => {
  const slug = String(req.params.slug);
  const name = req.body?.name;
  const runtime = normalizeRuntime(req.body?.runtime);
  if (!validAgentJoinName(name) || !runtime) {
    res.status(400).json({ error: 'An AI name and runtime are required.' }); return;
  }
  // Synchronous check/insert: no competing request can slip through the cap.
  const open = pending(slug);
  if (open.length >= P.maxOpenPerDocument) {
    res.status(429).json({ code: 'JOIN_CAP', error: 'This document already has five open join requests.' }); return;
  }
  const requestId = randomUUID();
  const pollToken = randomBytes(P.secretBytes).toString('hex');
  let code: string;
  do { code = `${P.codeWords[randomInt(P.codeWords.length)]}-${randomInt(P.codeMin, P.codeMax)}`; }
  while (open.some(row => row.code === code));
  const expiresAt = new Date(Date.now() + P.expiresInMs).toISOString();
  database().prepare('INSERT INTO agent_join_requests (requestId, slug, name, runtime, code, expiresAt, pollHash) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(requestId, slug, name.trim(), runtime, code, expiresAt, hash(pollToken).toString('hex'));
  notify(slug);
  res.status(202).json({ requestId, code, pollToken, expiresAt, pollUrl: `${agentJoinPath(slug)}/${requestId}` });
});

agentJoinRoutes.get('/api/agent/:slug/join/:requestId', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  expire();
  const row = database().prepare('SELECT * FROM agent_join_requests WHERE slug = ? AND requestId = ?')
    .get(String(req.params.slug), String(req.params.requestId)) as JoinRow | undefined;
  const token = req.header('x-join-token');
  if (!row || !token || !timingSafeEqual(hash(token), Buffer.from(row.pollHash, 'hex'))) {
    res.status(401).json({ error: 'Invalid join credential' }); return;
  }
  if (row.status === 'admitted' && !row.delivered) {
    const secret = secrets.get(row.requestId);
    // Revoked or suspended keys must not be delivered, even before expiry.
    if (!secret || !resolveDocumentAccess(row.slug, secret.token)) {
      forget(row.requestId);
      database().prepare("UPDATE agent_join_requests SET status = 'expired' WHERE requestId = ?").run(row.requestId);
      res.json({ status: 'expired' }); return;
    }
    database().prepare('UPDATE agent_join_requests SET delivered = 1 WHERE requestId = ?').run(row.requestId);
    forget(row.requestId);
    res.json({ status: 'admitted', token: secret.token, tokenId: row.tokenId }); return;
  }
  res.json({ status: row.status, ...(row.delivered ? { delivered: true } : {}) });
});

agentJoinRoutes.get('/api/documents/:slug/agent-joins', authorize, (req, res) => {
  res.json({ requests: pending(String(req.params.slug)) });
});
agentJoinRoutes.get('/api/documents/:slug/agent-joins/events', authorize, (req, res) => {
  const slug = String(req.params.slug);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  let last = '';
  const send = () => {
    // Session revocation / changed guest access ends visibility as well as admission.
    // Do not refresh cookies after the stream headers have been sent.
    const access = admissionAccess(req, res, slug);
    if ('error' in access) { res.write('event: denied\ndata: {}\n\n'); res.end(); return; }
    const data = JSON.stringify({ requests: pending(slug) });
    if (last !== data) { res.write(`data: ${data}\n\n`); last = data; }
    else res.write(': heartbeat\n\n');
  };
  const set = listeners.get(slug) ?? new Set();
  set.add(send); listeners.set(slug, set);
  const heartbeat = setInterval(send, P.streamHeartbeatMs);
  res.on('close', () => { clearInterval(heartbeat); set.delete(send); if (!set.size) listeners.delete(slug); });
  send();
});
agentJoinRoutes.post('/api/documents/:slug/agent-joins/:requestId/:decision', authorize, (req, res, next) => {
  if (!['admit', 'refuse'].includes(String(req.params.decision))) { res.sendStatus(404); return; }
  next();
}, (req, res, next) => req.params.decision === 'admit' ? documentLimit(req, res, next) : next(),
(req, res, next) => req.params.decision === 'admit' ? addressLimit(req, res, next) : next(), (req, res) => {
  expire();
  const slug = String(req.params.slug);
  const id = String(req.params.requestId);
  const row = database().prepare('SELECT * FROM agent_join_requests WHERE slug = ? AND requestId = ?').get(slug, id) as JoinRow | undefined;
  if (!row) { res.sendStatus(404); return; }
  if (row.status !== 'pending') { res.status(409).json({ status: row.status, error: 'This request is already closed.' }); return; }
  if (req.params.decision === 'refuse') {
    database().prepare("UPDATE agent_join_requests SET status = 'refused' WHERE requestId = ?").run(id);
    notify(slug); res.json({ status: 'refused' }); return;
  }
  const member = res.locals.joinMember;
  const sponsorActor = member?.email ? verifiedHumanActor(member.email) : null;
  if (sponsorRequiredFor(slug) && !allowCrossInvite([
    [`keys:doc:${slug}`, CROSS_INVITE_POLICY.keysPerDocumentPerHour],
    [`keys:sponsor:${slug}:${sponsorActor}`, CROSS_INVITE_POLICY.keysPerSponsorPerHour],
  ])) { res.status(429).json({ code: 'RATE_LIMITED', error: 'Too many AIs added in the last hour.' }); return; }
  const created = database().transaction(() => {
    const key = createDocumentAccessToken(slug, 'editor', undefined, {
      label: row.name, runtime: row.runtime, sponsorActor, sponsorMemberId: member?.id ?? null,
      requestedBy: member ? `library:${member.id}` : 'anonymous-page-editor', requestedFrom: getClientIp(req),
    });
    database().prepare("UPDATE agent_join_requests SET status = 'admitted', tokenId = ? WHERE requestId = ?").run(key.tokenId, id);
    return key;
  })();
  const deadline = Date.parse(row.expiresAt);
  const onExpiry = () => {
    const secret = secrets.get(id);
    if (!secret) return;
    // Node timers can wake just before the wall-clock deadline. Keep the timer
    // alive until that deadline, rather than dropping the secret but leaving an
    // admitted row behind indefinitely when nobody polls.
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      secret.timer = setTimeout(onExpiry, remaining);
      secret.timer.unref();
      return;
    }
    forget(id); expire(); notify(slug);
  };
  const timer = setTimeout(onExpiry, Math.max(0, deadline - Date.now()));
  timer.unref();
  secrets.set(id, { token: created.secret, timer });
  notify(slug);
  // The page never sees the key, even in the admission response.
  res.json({ status: 'admitted' });
});
