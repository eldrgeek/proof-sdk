/**
 * Invite person (2026-09-19): the document's team routes and the invite landing page.
 * Policy and storage live in server/document-team.ts.
 *
 *   GET    /api/documents/:slug/team                       Owner: invites + the guest setting
 *   POST   /api/documents/:slug/team/invites               Owner: { email, name?, send? }
 *   POST   /api/documents/:slug/team/invites/:id/resend    Owner: email the invite again
 *   POST   /api/documents/:slug/team/invites/:id/remove    Owner: remove the person (immediate)
 *   PUT    /api/documents/:slug/team/guest-access          Owner: { mode: private|comment|edit }
 *   GET    /invite/:id                                     the invited person's landing page
 *
 * An Owner is the document's creator, a Documents admin (signed in, same origin, JSON body) or
 * the document's owner credential (scripts: x-bridge-token / x-share-token / Bearer).
 *
 * Authorship: Claude Opus 5 (worker proof-invite), 2026-09-19.
 */
import { Router, type Request, type Response } from 'express';
import { canMutateByOwnerIdentity, getDocumentBySlug, resolveDocumentAccess, setAgentKeyDirectInvite } from './db.js';
import {
  activeAttestations,
  confirmNomination,
  displayName as crossDisplayName,
  documentProvenance,
  getNomination,
  listAgentKeyViews,
  listNominations,
  revokeAttestation,
  settleNomination,
} from './cross-invitation.js';
import { getClientIp } from './client-address.js';
import { getPublicOrigin } from './public-origin.js';
import { getLibraryMemberById, getLibrarySession, isLibraryEnabled, isSomaAuthEnabled } from './library/auth.js';
import { somaAuthHead } from './library/soma-page.js';
import { isLibraryDocumentCreator } from './line-marks.js';
import { IDENTITY_POLICY } from '../src/shared/identity.js';
import {
  GUEST_ACCESS_POLICY,
  INVITE_POLICY,
  allowInvite,
  createDocumentInvite,
  documentSession,
  getActiveInvite,
  getGuestAccessMode,
  inviteLandingUrl,
  inviteMailTransport,
  listDocumentInvites,
  removeDocumentInvite,
  sendInviteEmail,
  setGuestAccessMode,
  touchInvite,
  type DocumentInvite,
} from './document-team.js';

export const documentTeamRoutes = Router();

type OwnerDecision =
  | { ok: true; actor: string; memberId: string | null; inviterName: string; viaSession: boolean }
  | { ok: false; status: number; body: Record<string, unknown> };

function presentedCredential(req: Request): string | null {
  const auth = req.header('authorization');
  const bearer = auth && /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
  const candidates = [req.header('x-bridge-token'), req.header('x-share-token'), bearer, typeof req.body?.ownerSecret === 'string' ? req.body.ownerSecret : undefined];
  for (const value of candidates) if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

/** Decides whether this request may manage the document's team. */
function teamOwner(req: Request, slug: string, write: boolean): OwnerDecision {
  const doc = getDocumentBySlug(slug);
  if (!doc || doc.share_state === 'DELETED') return { ok: false, status: 404, body: { success: false, error: 'Document not found' } };
  const credential = presentedCredential(req);
  if (credential) {
    // A share token or agent key never manages people; only the owner credential does.
    if (canMutateByOwnerIdentity(doc, credential) || resolveDocumentAccess(slug, credential)?.role === 'owner_bot') {
      return { ok: true, actor: 'owner-credential', memberId: null, inviterName: 'The document owner', viaSession: false };
    }
    return { ok: false, status: 403, body: { success: false, code: 'OWNER_REQUIRED', error: 'Only an Owner of this document can invite people' } };
  }
  if (!isLibraryEnabled()) return { ok: false, status: 404, body: { success: false, error: 'Not available on this server' } };
  const docSession = documentSession(req, slug);
  if (!docSession) {
    return { ok: false, status: 401, body: { success: false, code: 'SIGNED_OUT', error: 'Sign in to manage who can open this document', signInUrl: '/' } };
  }
  const member = docSession.session.member;
  const owner = docSession.via === 'library'
    && ((IDENTITY_POLICY.adminsHaveOwnerRights && member.isOwner) || isLibraryDocumentCreator(slug, member.id));
  if (!owner) return { ok: false, status: 403, body: { success: false, code: 'OWNER_REQUIRED', error: 'Only an Owner of this document (its creator or a Documents admin) can invite people' } };
  if (write && (!req.is('application/json') || req.header('origin') !== getPublicOrigin(req))) {
    return { ok: false, status: 403, body: { success: false, code: 'FORBIDDEN', error: 'This request must come from this site' } };
  }
  return { ok: true, actor: member.email ? `human:${member.email}` : `member:${member.id}`, memberId: member.id, inviterName: member.name, viaSession: true };
}

function slugParam(req: Request): string {
  const raw = req.params.slug;
  return Array.isArray(raw) ? raw[0] ?? '' : raw ?? '';
}

function inviteView(invite: DocumentInvite, origin: string) {
  return {
    id: invite.id,
    name: invite.name,
    email: invite.email,
    status: invite.status,
    invitedBy: invite.invitedBy,
    createdAt: invite.createdAt,
    joinedAt: invite.joinedAt,
    lastSeenAt: invite.lastSeenAt,
    lastSentAt: invite.lastSentAt,
    // Not a credential: the page asks the invited address to sign in.
    link: inviteLandingUrl(origin, invite.id),
  };
}

function teamBody(slug: string, origin: string) {
  return {
    success: true,
    canManage: true,
    guestAccess: getGuestAccessMode(slug),
    guestAccessOptions: GUEST_ACCESS_POLICY.modes.map(mode => ({ mode, label: GUEST_ACCESS_POLICY.labels[mode] })),
    invites: listDocumentInvites(slug).map(invite => inviteView(invite, origin)),
    mail: { transport: inviteMailTransport() },
    // Cross invitation (2026-09-19): the AIs on this document with the human who added each one,
    // the people AIs have nominated (waiting on an owner), what AIs have attested, and the whole
    // provenance chain: how everyone here got in.
    agents: listAgentKeyViews(slug).filter(key => !key.revokedAt).map(key => ({
      tokenId: key.tokenId, actor: key.actor, name: key.label, sponsor: key.sponsorActor,
      sponsorName: key.sponsorName, runtime: key.runtime, suspended: key.suspended,
      allowDirectInvite: key.allowDirectInvite, provenance: key.provenanceLabel, createdAt: key.createdAt,
    })),
    nominations: listNominations(slug).map(nomination => ({
      ...nomination,
      byName: crossDisplayName(nomination.by, slug),
      decidedByName: nomination.decidedBy ? crossDisplayName(nomination.decidedBy, slug) : null,
    })),
    attestations: activeAttestations(slug).map(attestation => ({ ...attestation, byName: crossDisplayName(attestation.by, slug) })),
    provenance: documentProvenance(slug),
  };
}

documentTeamRoutes.use('/api/documents/:slug/team', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

documentTeamRoutes.get('/api/documents/:slug/team', (req: Request, res: Response) => {
  const slug = slugParam(req);
  const owner = teamOwner(req, slug, false);
  if (!owner.ok) { res.status(owner.status).json(owner.body); return; }
  res.json(teamBody(slug, getPublicOrigin(req)));
});

documentTeamRoutes.post('/api/documents/:slug/team/invites', async (req: Request, res: Response) => {
  const slug = slugParam(req);
  const owner = teamOwner(req, slug, true);
  if (!owner.ok) { res.status(owner.status).json(owner.body); return; }
  if (!allowInvite([
    [`doc:${slug}`, INVITE_POLICY.perDocumentPerHour],
    [`inviter:${owner.actor}`, INVITE_POLICY.perInviterPerHour],
    [`ip:${getClientIp(req)}`, INVITE_POLICY.perAddressPerHour],
  ])) {
    res.status(429).json({ success: false, code: 'RATE_LIMITED', error: 'Too many invitations in the last hour. Try again later.' });
    return;
  }
  const created = createDocumentInvite({ slug, email: req.body?.email, name: req.body?.name, invitedByMemberId: owner.memberId, invitedByActor: owner.actor });
  if (!created.ok) { res.status(created.status).json({ success: false, code: created.code, error: created.error }); return; }
  const origin = getPublicOrigin(req);
  const doc = getDocumentBySlug(slug);
  const email = req.body?.send === false
    ? { sent: false, transport: inviteMailTransport() }
    : await sendInviteEmail({ invite: created.invite, origin, inviterName: owner.inviterName, title: doc?.title?.trim() || 'Untitled document' });
  res.status(created.created ? 201 : 200).json({
    success: true,
    invite: inviteView(getActiveInvite(created.invite.id) ?? created.invite, origin),
    created: created.created,
    alreadyMember: created.alreadyMember,
    email,
  });
});

documentTeamRoutes.post('/api/documents/:slug/team/invites/:id/resend', async (req: Request, res: Response) => {
  const slug = slugParam(req);
  const owner = teamOwner(req, slug, true);
  if (!owner.ok) { res.status(owner.status).json(owner.body); return; }
  const invite = getActiveInvite(String(req.params.id ?? ''));
  if (!invite || invite.slug !== slug) { res.status(404).json({ success: false, error: 'Invite not found' }); return; }
  if (invite.lastSentAt && Date.now() - Date.parse(invite.lastSentAt) < INVITE_POLICY.resendCooldownMs) {
    res.status(429).json({ success: false, code: 'RESEND_TOO_SOON', error: 'The invitation was just sent. Wait a minute before sending it again.' });
    return;
  }
  if (!allowInvite([[`doc:${slug}`, INVITE_POLICY.perDocumentPerHour], [`inviter:${owner.actor}`, INVITE_POLICY.perInviterPerHour]])) {
    res.status(429).json({ success: false, code: 'RATE_LIMITED', error: 'Too many invitations in the last hour. Try again later.' });
    return;
  }
  const origin = getPublicOrigin(req);
  const doc = getDocumentBySlug(slug);
  const email = await sendInviteEmail({ invite, origin, inviterName: owner.inviterName, title: doc?.title?.trim() || 'Untitled document' });
  res.json({ success: true, invite: inviteView(getActiveInvite(invite.id) ?? invite, origin), email });
});

documentTeamRoutes.post('/api/documents/:slug/team/invites/:id/remove', (req: Request, res: Response) => {
  const slug = slugParam(req);
  const owner = teamOwner(req, slug, true);
  if (!owner.ok) { res.status(owner.status).json(owner.body); return; }
  if (!removeDocumentInvite(slug, String(req.params.id ?? ''), owner.actor)) {
    res.status(404).json({ success: false, error: 'Invite not found' });
    return;
  }
  res.json(teamBody(slug, getPublicOrigin(req)));
});

/**
 * Cross invitation (2026-09-19): an Owner answers what an AI proposed.
 *
 *   POST /team/nominations/:id/confirm   sends the real invitation, and records who confirmed it
 *   POST /team/nominations/:id/decline   closes it; nothing is ever emailed
 *   POST /team/attestations/:id/revoke   ends the read-and-comment access an AI granted
 *   PUT  /team/agents/:tokenId/direct-invite  { allow }  standing permission for one AI, off by default
 *
 * Confirm is the step that makes a nomination safe: an AI can be talked into proposing someone by
 * text it read in the document, and the person who confirms reads the AI's own "why" first.
 */
documentTeamRoutes.post('/api/documents/:slug/team/nominations/:id/confirm', async (req: Request, res: Response) => {
  const slug = slugParam(req);
  const owner = teamOwner(req, slug, true);
  if (!owner.ok) { res.status(owner.status).json(owner.body); return; }
  const nomination = getNomination(slug, String(req.params.id ?? ''));
  if (!nomination) { res.status(404).json({ success: false, error: 'Nomination not found' }); return; }
  if (nomination.status !== 'pending') {
    res.status(409).json({ success: false, code: 'ALREADY_DECIDED', error: `This nomination was already ${nomination.status}.` });
    return;
  }
  if (!allowInvite([
    [`doc:${slug}`, INVITE_POLICY.perDocumentPerHour],
    [`inviter:${owner.actor}`, INVITE_POLICY.perInviterPerHour],
    [`ip:${getClientIp(req)}`, INVITE_POLICY.perAddressPerHour],
  ])) {
    res.status(429).json({ success: false, code: 'RATE_LIMITED', error: 'Too many invitations in the last hour. Try again later.' });
    return;
  }
  const doc = getDocumentBySlug(slug);
  const result = await confirmNomination({
    slug, nomination, by: owner.actor, byMemberId: owner.memberId,
    origin: getPublicOrigin(req), inviterName: owner.inviterName,
    title: doc?.title?.trim() || 'Untitled document',
  });
  res.status(result.status).json({ ...result.body, team: teamBody(slug, getPublicOrigin(req)) });
});

documentTeamRoutes.post('/api/documents/:slug/team/nominations/:id/decline', (req: Request, res: Response) => {
  const slug = slugParam(req);
  const owner = teamOwner(req, slug, true);
  if (!owner.ok) { res.status(owner.status).json(owner.body); return; }
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.replace(/[\x00-\x1f\x7f<>]/g, ' ').trim().slice(0, 300) : null;
  const settled = settleNomination(slug, String(req.params.id ?? ''), 'declined', owner.actor, { reason });
  if (!settled) { res.status(404).json({ success: false, error: 'No open nomination with that id' }); return; }
  res.json({ ...teamBody(slug, getPublicOrigin(req)), nomination: settled });
});

documentTeamRoutes.post('/api/documents/:slug/team/attestations/:id/revoke', (req: Request, res: Response) => {
  const slug = slugParam(req);
  const owner = teamOwner(req, slug, true);
  if (!owner.ok) { res.status(owner.status).json(owner.body); return; }
  if (!revokeAttestation(slug, String(req.params.id ?? ''), owner.actor)) {
    res.status(404).json({ success: false, error: 'No live attestation with that id' });
    return;
  }
  res.json(teamBody(slug, getPublicOrigin(req)));
});

documentTeamRoutes.put('/api/documents/:slug/team/agents/:tokenId/direct-invite', (req: Request, res: Response) => {
  const slug = slugParam(req);
  const owner = teamOwner(req, slug, true);
  if (!owner.ok) { res.status(owner.status).json(owner.body); return; }
  const allow = req.body?.allow === true;
  if (!setAgentKeyDirectInvite(slug, String(req.params.tokenId ?? ''), allow)) {
    res.status(404).json({ success: false, error: 'Agent key not found' });
    return;
  }
  res.json({ ...teamBody(slug, getPublicOrigin(req)), allowDirectInvite: allow });
});

documentTeamRoutes.put('/api/documents/:slug/team/guest-access', (req: Request, res: Response) => {
  const slug = slugParam(req);
  const owner = teamOwner(req, slug, true);
  if (!owner.ok) { res.status(owner.status).json(owner.body); return; }
  const result = setGuestAccessMode(slug, req.body?.mode, owner.actor);
  if (!result.ok) { res.status(400).json({ success: false, code: 'INVALID_MODE', error: result.error }); return; }
  res.json({ ...teamBody(slug, getPublicOrigin(req)), changed: result.changed });
});

// ============================================================================
// Pages
// ============================================================================

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  return `${local.slice(0, 2)}${'•'.repeat(Math.max(1, Math.min(6, local.length - 2)))}@${domain}`;
}

const PAGE_STYLE = `
  :root{color-scheme:light;--bg:#fff;--text:#111;--muted:#6b6b6b;--line:#e7e7e4;--soft:#f4f4f2}
  @media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#111;--text:#f5f5f5;--muted:#aaa;--line:#303030;--soft:#202020}}
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
  main{width:min(460px,100%)}h1{font-size:26px;letter-spacing:-.5px;line-height:1.2;margin:0 0 12px}p{color:var(--muted);line-height:1.55;margin:0 0 14px}
  .btn{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:0 18px;border-radius:999px;border:1px solid var(--line);background:var(--bg);color:var(--text);font:inherit;font-weight:600;cursor:pointer;text-decoration:none;width:100%;margin:6px 0}
  .btn.primary{background:#111;border-color:#111;color:#fff}.field{display:grid;gap:6px;margin:12px 0}.field label{font-size:13px;font-weight:650}
  .field input{min-height:46px;border:1px solid var(--line);border-radius:12px;padding:0 12px;font:inherit;background:var(--bg);color:var(--text)}
  .doc{font-weight:700;color:var(--text)}[hidden]{display:none!important}`;

function page(title: string, body: string, head = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Proof</title><meta name="robots" content="noindex"><style>${PAGE_STYLE}</style>${head}</head><body><main>${body}</main></body></html>`;
}

/** The /d/<slug> page of a private document for someone who cannot open it. */
export function renderSignInRequiredHtml(req: Request, slug: string): string {
  let signedInAs: string | null = null;
  try { signedInAs = isLibraryEnabled() ? getLibrarySession(req)?.member.name ?? null : null; } catch { signedInAs = null; }
  const back = jsonForScript(`/d/${slug}`);
  if (signedInAs) {
    return page('Not shared with you', `<h1>This document isn’t shared with you</h1>
      <p>You’re signed in as ${escapeHtml(signedInAs)}. Ask the person who sent you the link to invite you.</p>
      <a class="btn" href="/">Your documents</a>`);
  }
  return page('Sign in to open', `<h1>Sign in to open this document</h1>
      <p>This document is private: only invited people and team members can open it.</p>
      ${isLibraryEnabled() ? `<a class="btn primary" id="signin" href="/">Sign in</a>` : ''}
      <script>document.getElementById('signin')?.addEventListener('click',function(){try{localStorage.setItem('proof:return-to',JSON.stringify({path:${back},at:Date.now()}))}catch(e){}});</script>`);
}

/**
 * GET /invite/:id. The link is not a credential: it opens the document only for a person signed
 * in as the invited address (SOMA Auth verifies the address; without SOMA Auth, the one-time
 * sign-in link in the invitation email does).
 */
documentTeamRoutes.get('/invite/:id', (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const invite = isLibraryEnabled() ? getActiveInvite(String(req.params.id ?? '')) : null;
  if (!invite) {
    res.status(404).type('html').send(page('Invitation not active', `<h1>This invitation is no longer active</h1>
      <p>It may have been withdrawn. Ask the person who invited you to send a new one.</p>`));
    return;
  }
  const doc = getDocumentBySlug(invite.slug);
  if (!doc || doc.share_state === 'DELETED') {
    res.status(410).type('html').send(page('Document removed', '<h1>This document was deleted</h1>'));
    return;
  }
  let session: ReturnType<typeof getLibrarySession> = null;
  try { session = getLibrarySession(req, res); } catch { session = null; }
  if (session && (session.member.id === invite.memberId || (session.member.email ?? '').toLowerCase() === invite.email)) {
    touchInvite(invite.id);
    res.redirect(302, `/d/${encodeURIComponent(invite.slug)}`);
    return;
  }
  const title = doc.title?.trim() || 'Untitled document';
  const inviter = invite.invitedByMemberId ? getLibraryMemberById(invite.invitedByMemberId) : null;
  const invitedBy = inviter?.name || 'The document owner';
  if (session) {
    res.type('html').send(page('Invitation', `<h1>This invitation is for someone else</h1>
      <p>You’re signed in as ${escapeHtml(session.member.name)}. This invitation is for ${escapeHtml(maskEmail(invite.email))}.</p>
      <button class="btn primary" id="switch">Sign out and use another account</button>
      <script>document.getElementById('switch').addEventListener('click',async function(){try{if(window.SomaAuth)await window.SomaAuth.signOut()}catch(e){}await fetch('/library/api/signout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).catch(function(){});location.reload();});</script>`,
    isSomaAuthEnabled() ? somaAuthHead() : ''));
    return;
  }
  const back = jsonForScript(`/d/${invite.slug}`);
  const here = jsonForScript(`/invite/${invite.id}`);
  if (!isSomaAuthEnabled()) {
    res.type('html').send(page('Invitation', `<h1>You’re invited to <span class="doc">${escapeHtml(title)}</span></h1>
      <p>${escapeHtml(invitedBy)} invited ${escapeHtml(maskEmail(invite.email))}. Open the sign-in link from your invitation email to continue; it opens this document.</p>`));
    return;
  }
  // SOMA Auth. The inline head script runs before supabase-js loads: an emailed SOMA magic link
  // for this invite returns here with an implicit-grant token in the fragment, which is removed
  // from the address bar and exchanged for a Proof session (the server verifies it with SOMA Auth).
  const capture = `<script>(function(){var h=new URLSearchParams(location.hash.slice(1));var t=h.get('access_token');var e=h.get('error_description');if(t||e){history.replaceState(null,'',location.pathname);}if(t)window.__proofInviteToken=t;if(e)window.__proofInviteError=e;try{localStorage.setItem('proof:return-to',JSON.stringify({path:${back},at:Date.now()}))}catch(_){}})();</script>`;
  res.type('html').send(page('Invitation', `<h1>You’re invited to <span class="doc">${escapeHtml(title)}</span></h1>
    <p>${escapeHtml(invitedBy)} invited ${escapeHtml(maskEmail(invite.email))}. Sign in with that address to open it.</p>
    <section aria-label="Sign in">
      <button class="btn" id="soma-google">Continue with Google</button>
      <form id="soma-email-form"><div class="field"><label for="soma-email">Email</label><input id="soma-email" type="email" required autocomplete="email"></div>
      <button class="btn primary">Email me a sign-in link</button></form>
      <p id="soma-message" role="status" aria-live="polite"></p>
      <button class="btn" id="soma-switch" hidden>Use another account</button>
    </section>
    <script>(async function(){var m=document.getElementById('soma-message');if(window.__proofInviteError){m.textContent=window.__proofInviteError;}var t=window.__proofInviteToken;if(!t)return;m.textContent='Signing you in…';try{var r=await fetch('/library/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accessToken:t})});var j=await r.json().catch(function(){return {};});if(r.ok){location.replace(${here});return;}m.textContent=j.message||'Could not sign you in. Please try again.';}catch(_){m.textContent='Sign-in is unavailable. Please try again later.';}})();</script>`,
  capture + somaAuthHead()));
});
