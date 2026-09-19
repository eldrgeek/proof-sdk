// Invite person (Mike Wolf, 2026-09-19): invite a person to one document, the guest setting
// (default: read and comment), and what an invited person can and cannot open.
// Authorship: Claude Opus 5 (worker proof-invite), 2026-09-19. Library on, SOMA Auth off (the
// one-time sign-in link path); the SOMA Auth path is covered by document-team-soma.test.ts.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-team-'));
const captureFile = path.join(temp, 'mail.jsonl');
process.env.DATABASE_PATH = path.join(temp, 'test.db');
process.env.SNAPSHOT_DIR = path.join(temp, 'snapshots');
Object.assign(process.env, {
  PROOF_ENV: 'test', PROOF_DB_ENV_INIT: 'test', PROOF_LIBRARY_ENABLED: '1',
  PROOF_INVITE_MAIL_TRANSPORT: 'capture', PROOF_INVITE_MAIL_CAPTURE: captureFile, PROOF_TRUST_PROXY_HEADERS: '1',
});
delete process.env.PROOF_SOMA_AUTH_ENABLED;
delete process.env.PROOF_PUBLIC_ORIGIN;
delete process.env.PROOF_GUEST_ACCESS_DEFAULT;
delete process.env.RESEND_API_KEY;

const db = await import('../../server/db');
const auth = await import('../../server/library/auth');
const team = await import('../../server/document-team');
const shared = await import('../shared/line-marks');
const serverLines = await import('../../server/line-marks');
const { documentAccessEvents } = await import('../../server/document-access-events');
const { libraryRoutes } = await import('../../server/library/routes');
const { documentTeamRoutes } = await import('../../server/document-team-routes');
const { apiRoutes } = await import('../../server/routes');
const { agentRoutes } = await import('../../server/agent-routes');
const { shareWebRoutes } = await import('../../server/share-web-routes');

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const app = express();
app.use(express.json());
app.use(libraryRoutes);
app.use(documentTeamRoutes);
app.use('/api', apiRoutes);
app.use('/api/agent', agentRoutes);
app.use(shareWebRoutes);
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const clientHeaders = { 'X-Proof-Client-Version': '0.31.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
let ip = 1;
const call = async (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(base + url, {
    method,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', Origin: base, 'X-Forwarded-For': `198.51.100.${ip++ % 250}`, ...clientHeaders, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: response.status, body: json, text, headers: response.headers };
};

const doc = `# Team

First line to read.

Second line to read.`;

try {
  const mike = auth.createLibraryMember({ name: 'Mike Wolf', email: 'mw@mike-wolf.com', isOwner: true });
  const member = auth.createLibraryMember({ name: 'Library Member', email: 'member@example.test' });
  const sessionCookie = (memberId: string) => {
    const link = auth.createLibrarySigninLink({ memberId, purpose: 'operator', origin: base });
    const signedIn = auth.consumeLibrarySigninToken(new URL(link.link).hash.slice(3), null)!;
    return `${auth.LIBRARY_SESSION_COOKIE}=${encodeURIComponent(signedIn.sessionId)}`;
  };
  const MIKE = { Cookie: sessionCookie(mike.id) };
  const MEMBER = { Cookie: sessionCookie(member.id) };
  const slug = 'team-doc';
  const other = 'other-doc';
  db.createDocument(slug, doc, {}, 'Team doc', 'owner-1', 'owner-secret-team');
  db.getDb().prepare(`INSERT INTO library_document_meta (slug, created_by_member_id) VALUES (?, ?)`).run(slug, mike.id);
  db.createDocument(other, doc, {}, 'Other doc', 'owner-2', 'owner-secret-other');
  const lines = await serverLines.computeServerLines(doc);
  const anchor = (i: number) => shared.anchorForLine(lines[i]);
  const mark = (s: string, headers: Record<string, string> = {}, by = 'Visitor') =>
    call(`/api/documents/${s}/line-marks`, 'POST', { by, status: 'agreed', anchor: anchor(1) }, headers);

  await test('default guest setting: read and comment where sign-in exists; edit on a bare SDK', () => {
    assert.equal(team.getGuestAccessMode(slug), 'comment');
    process.env.PROOF_LIBRARY_ENABLED = '0';
    assert.equal(team.defaultGuestAccessMode(), 'edit');
    process.env.PROOF_LIBRARY_ENABLED = '1';
    process.env.PROOF_GUEST_ACCESS_DEFAULT = 'private';
    assert.equal(team.defaultGuestAccessMode(), 'private');
    delete process.env.PROOF_GUEST_ACCESS_DEFAULT;
  });

  await test('guest (no sign-in): reads, comments and chats; cannot edit; marks are refused with SIGN_IN_TO_MARK', async () => {
    const page = await call(`/d/${slug}?format=json`);
    assert.equal(page.status, 200);
    assert.equal(page.body.role, 'commenter');
    assert.deepEqual(page.body.capabilities, { canRead: true, canComment: true, canEdit: false });
    const context = await call(`/api/documents/${slug}/open-context`);
    assert.equal(context.status, 200, context.text);
    assert.equal(context.body.capabilities.canEdit, false);
    const view = await call(`/api/documents/${slug}/line-marks`);
    assert.equal(view.body.viewer.canMark, false);
    assert.equal(view.body.viewer.canComment, true);
    assert.equal(view.body.identity.me.markNeedsSignIn, true);
    assert.equal(view.body.team.canManage, false);
    const refused = await mark(slug);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'SIGN_IN_TO_MARK');
    assert.equal(serverLines.listLineMarks(slug).length, 0, 'nothing recorded');
    const comment = await call(`/api/documents/${slug}/ops`, 'POST', { type: 'comment.add', quote: 'First line', text: 'A guest comment', by: 'guest:Visitor' });
    assert.equal(comment.status, 200, comment.text);
    const chat = await call(`/api/documents/${slug}/chat`, 'POST', { by: 'Visitor', text: 'Hello from a guest', lines: [anchor(1)] });
    assert.equal(chat.status, 200, chat.text);
    const edit = await call(`/api/documents/${slug}`, 'PUT', { markdown: '# Hacked' });
    assert.equal(edit.status, 403, 'a guest cannot rewrite the text');
    const accept = await call(`/api/documents/${slug}/ops`, 'POST', { type: 'suggestion.accept', markId: 'x' });
    assert.equal(accept.status, 403);
    const tier = await call(`/api/documents/${slug}/flags`, 'POST', { by: 'Visitor', anchor: anchor(2) });
    assert.equal(tier.body.code, 'SIGN_IN_TO_MARK', 'a flag counts, so a guest must sign in');
    const keyMint = await call(`/api/documents/${slug}/agent-keys`, 'POST', { label: 'Guest AI' });
    assert.equal(keyMint.status, 403, 'a guest cannot create agent keys any more');
  });

  await test('share tokens and agent keys keep working exactly as before (ask-mike)', async () => {
    const key = db.createDocumentAccessToken(slug, 'editor', undefined, { label: 'Claude (COS)', requestedBy: 'test', requestedFrom: '127.0.0.1' });
    const state = await call(`/api/agent/${slug}/state`, 'GET', undefined, { 'x-share-token': key.secret });
    assert.equal(state.status, 200);
    const agentMark = await call(`/api/agent/${slug}/marks/line`, 'POST', { status: 'seen', lineIndex: 2 }, { 'x-share-token': key.secret });
    assert.equal(agentMark.status, 200, agentMark.text);
    const plain = db.createDocumentAccessToken(slug, 'editor');
    const edit = await call(`/api/documents/${slug}/ops`, 'POST', { type: 'comment.add', quote: 'Second line', text: 'script comment', by: 'ai:script' }, { 'x-share-token': plain.secret });
    assert.equal(edit.status, 200, edit.text);
    const pageWithToken = await call(`/d/${slug}?format=json&token=${encodeURIComponent(plain.secret)}`);
    assert.equal(pageWithToken.body.capabilities.canEdit, true, 'a tokenized editor link still edits');
    const owner = await call(`/api/documents/${slug}/line-marks`, 'POST', { by: 'human:mw@mike-wolf.com', status: 'seen', anchor: anchor(2) }, { 'x-bridge-token': 'owner-secret-team' });
    assert.equal(owner.status, 200, 'the owner credential (scripts) still acts as the "by" it names');
  });

  await test('library member: edits and marks as a verified person (unchanged)', async () => {
    const page = await call(`/d/${slug}?format=json`, 'GET', undefined, MEMBER);
    assert.equal(page.body.capabilities.canEdit, true);
    const set = await mark(slug, MEMBER);
    assert.equal(set.status, 200, set.text);
    assert.equal(set.body.lineMark.by, 'human:member@example.test');
  });

  let inviteId = '';
  let ericCookie = '';
  await test('only an Owner invites: the creator/admin yes; another member, a guest, a share token no; CSRF refused', async () => {
    assert.equal((await call(`/api/documents/${slug}/team`)).status, 401);
    assert.equal((await call(`/api/documents/${slug}/team`, 'GET', undefined, MEMBER)).body.code, 'OWNER_REQUIRED');
    const key = db.createDocumentAccessToken(slug, 'editor', undefined, { label: 'Some AI', requestedBy: 'test', requestedFrom: '127.0.0.1' });
    assert.equal((await call(`/api/documents/${slug}/team/invites`, 'POST', { email: 'x@example.test' }, { 'x-share-token': key.secret })).body.code, 'OWNER_REQUIRED');
    assert.equal((await call(`/api/documents/${slug}/team/invites`, 'POST', { email: 'x@example.test' }, { ...MIKE, Origin: 'https://evil.test' })).status, 403);
    assert.equal((await call(`/api/documents/${slug}/team/invites`, 'POST', { email: 'x@example.test' }, { ...MIKE, 'Content-Type': 'text/plain' })).status, 403);
    assert.equal((await call(`/api/documents/${slug}/team/invites`, 'POST', { email: 'not an email' }, MIKE)).body.code, 'INVALID_EMAIL');
    const listed = await call(`/api/documents/${slug}/team`, 'GET', undefined, MIKE);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.guestAccess, 'comment');
    const view = await call(`/api/documents/${slug}/line-marks`, 'GET', undefined, MIKE);
    assert.equal(view.body.team.canManage, true);
  });

  await test('Owner invites Eric: he is added to this document only and gets an email with a sign-in link', async () => {
    const invited = await call(`/api/documents/${slug}/team/invites`, 'POST', { email: 'Eric@Example.test', name: 'Eric' }, MIKE);
    assert.equal(invited.status, 201, invited.text);
    assert.equal(invited.body.invite.email, 'eric@example.test');
    assert.equal(invited.body.invite.status, 'invited');
    assert.equal(invited.body.email.sent, true);
    assert.equal(invited.body.email.transport, 'capture');
    inviteId = invited.body.invite.id;
    assert.equal(invited.body.invite.link, `${base}/invite/${inviteId}`);
    const again = await call(`/api/documents/${slug}/team/invites`, 'POST', { email: 'eric@example.test' }, MIKE);
    assert.equal(again.status, 200, 'inviting again is idempotent');
    assert.equal(again.body.invite.id, inviteId);
    const mails = readFileSync(captureFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(mails.length, 2);
    assert.equal(mails[0].to, 'eric@example.test');
    assert.match(mails[0].subject, /Mike Wolf invited you to “Team doc”/);
    const eric = auth.getLibraryMemberByEmail('eric@example.test')!;
    assert.equal(eric.scope, 'invited');
    // The copied invite link is not a credential: without signing in it opens nothing.
    const landing = await call(`/invite/${inviteId}`);
    assert.equal(landing.status, 200);
    assert.ok(!landing.text.includes('eric@example.test'), 'the landing page masks the address');
    assert.ok(landing.text.includes('er'), 'masked address shown');
    const stillGuest = await call(`/d/${slug}?format=json`);
    assert.equal(stillGuest.body.capabilities.canEdit, false);
    // The emailed link signs Eric in and returns him to the document.
    const link = new URL(mails[0].link);
    const params = new URLSearchParams(link.hash.slice(1));
    assert.equal(params.get('next'), `/d/${slug}`);
    const signedIn = await fetch(`${base}/library/api/signin`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ token: params.get('t') }) });
    assert.equal(signedIn.status, 200);
    ericCookie = (signedIn.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(ericCookie.startsWith(auth.LIBRARY_SESSION_COOKIE));
    const reuse = await fetch(`${base}/library/api/signin`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ token: params.get('t') }) });
    assert.equal(reuse.status, 400, 'the emailed sign-in link works once');
  });

  await test('Eric, signed in: opens the document as a verified person and his marks count', async () => {
    const ERIC = { Cookie: ericCookie };
    const page = await call(`/d/${slug}?format=json`, 'GET', undefined, ERIC);
    assert.equal(page.body.capabilities.canEdit, true);
    const set = await mark(slug, ERIC, 'Someone Else');
    assert.equal(set.status, 200, set.text);
    assert.equal(set.body.lineMark.by, 'human:eric@example.test');
    assert.equal(set.body.trust, 'verified');
    const view = await call(`/api/documents/${slug}/line-marks`, 'GET', undefined, ERIC);
    assert.equal(view.body.identity.me.trust, 'verified');
    assert.equal(view.body.team.canManage, false, 'an invited person does not manage the team');
    assert.equal((await call(`/api/documents/${slug}/team`, 'GET', undefined, ERIC)).body.code, 'OWNER_REQUIRED');
    const landing = await call(`/invite/${inviteId}`, 'GET', undefined, ERIC);
    assert.equal(landing.status, 302);
    assert.equal(landing.headers.get('location'), `/d/${slug}`);
    const listed = await call(`/api/documents/${slug}/team`, 'GET', undefined, MIKE);
    assert.equal(listed.body.invites[0].status, 'joined');
    assert.ok(listed.body.invites[0].lastSeenAt);
  });

  await test('Eric sees only his documents; cannot create, rename, list people or open another document as himself', async () => {
    const ERIC = { Cookie: ericCookie };
    const me = await call('/library/api/me', 'GET', undefined, ERIC);
    assert.equal(me.body.scope, 'invited');
    const list = await call('/library/api/documents', 'GET', undefined, ERIC);
    assert.deepEqual(list.body.documents.map((d: { slug: string }) => d.slug), [slug]);
    assert.equal(list.body.documents[0].guestAccess, 'comment');
    const all = await call('/library/api/documents', 'GET', undefined, MIKE);
    assert.ok(all.body.documents.length >= 2, 'a library member still sees everything');
    assert.equal((await call('/library/api/documents', 'POST', { title: 'Mine' }, ERIC)).status, 403);
    assert.equal((await call(`/library/api/documents/${slug}`, 'PATCH', { title: 'Renamed' }, ERIC)).status, 403);
    assert.equal((await call('/library/api/people', 'GET', undefined, ERIC)).status, 403);
    const people = await call('/library/api/people', 'GET', undefined, MIKE);
    assert.ok(!people.body.people.some((p: { email: string }) => p.email === 'eric@example.test'), 'invited people are not library members');
    // Another document: Eric is a guest there (the guest setting applies), never verified.
    const otherView = await call(`/api/documents/${other}/line-marks`, 'GET', undefined, ERIC);
    assert.equal(otherView.body.identity.me.trust, 'guest');
    assert.equal((await mark(other, ERIC)).body.code, 'SIGN_IN_TO_MARK');
    const otherPage = await call(`/d/${other}?format=json`, 'GET', undefined, ERIC);
    assert.equal(otherPage.body.capabilities.canEdit, false);
  });

  await test('private setting: guests and Eric (not invited) cannot open; nothing of the text leaks', async () => {
    const ERIC = { Cookie: ericCookie };
    const set = await call(`/api/documents/${other}/team/guest-access`, 'PUT', { mode: 'private' }, { 'x-bridge-token': 'owner-secret-other' });
    assert.equal(set.status, 200, set.text);
    assert.equal(set.body.guestAccess, 'private');
    for (const headers of [{}, ERIC]) {
      const html = await call(`/d/${other}`, 'GET', undefined, { ...headers, Accept: 'text/html' });
      assert.equal(html.status, 401);
      assert.ok(!html.text.includes('First line to read'), 'no document text in the sign-in page');
      assert.equal((await call(`/d/${other}?format=json`, 'GET', undefined, headers)).status, 401);
      assert.equal((await call(`/api/documents/${other}`, 'GET', undefined, headers)).status, 401);
      assert.equal((await call(`/api/documents/${other}/open-context`, 'GET', undefined, headers)).status, 401);
      assert.equal((await call(`/api/documents/${other}/collab-session`, 'GET', undefined, headers)).status, 401);
      assert.equal((await call(`/api/documents/${other}/line-marks`, 'GET', undefined, headers)).status, 403);
      assert.equal((await call(`/api/documents/${other}/info`, 'GET', undefined, headers)).body.title, null);
    }
    const signIn = await call(`/d/${other}`, 'GET', undefined, { Accept: 'text/html' });
    assert.match(signIn.text, /Sign in to open this document/);
    const memberView = await call(`/d/${other}?format=json`, 'GET', undefined, MEMBER);
    assert.equal(memberView.body.capabilities.canEdit, true, 'library members keep today\'s access');
  });

  await test('guests can edit: the old behaviour, guest marks recorded as guest:<name>', async () => {
    const set = await call(`/api/documents/${other}/team/guest-access`, 'PUT', { mode: 'edit' }, { 'x-bridge-token': 'owner-secret-other' });
    assert.equal(set.body.guestAccess, 'edit');
    const page = await call(`/d/${other}?format=json`);
    assert.equal(page.body.capabilities.canEdit, true);
    const guest = await mark(other, {}, 'Visitor');
    assert.equal(guest.status, 200);
    assert.equal(guest.body.lineMark.by, 'guest:Visitor');
    assert.equal((await call(`/api/documents/${other}/team/guest-access`, 'PUT', { mode: 'everyone' }, { 'x-bridge-token': 'owner-secret-other' })).status, 400);
    // A guest's open editor connection carries "guest:edit"; tightening the setting closes it.
    assert.equal(db.isDocumentAccessTokenActive(other, 'guest:edit'), true);
    const closed: string[] = [];
    const listener = (s: string, tokenId: string) => { if (s === other) closed.push(tokenId); };
    documentAccessEvents.on('revoked', listener);
    await call(`/api/documents/${other}/team/guest-access`, 'PUT', { mode: 'comment' }, { 'x-bridge-token': 'owner-secret-other' });
    documentAccessEvents.off('revoked', listener);
    assert.deepEqual(closed, ['guest:edit']);
    assert.equal(db.isDocumentAccessTokenActive(other, 'guest:edit'), false);
    assert.equal(db.isDocumentAccessTokenActive(other, 'guest:comment'), true);
  });

  await test('removing Eric revokes his access at once (page, marks, collab token)', async () => {
    const ERIC = { Cookie: ericCookie };
    const revoked: string[] = [];
    const listener = (s: string, tokenId: string) => { if (s === slug) revoked.push(tokenId); };
    documentAccessEvents.on('revoked', listener);
    assert.equal(db.isDocumentAccessTokenActive(slug, `invite:${inviteId}`), true);
    const removed = await call(`/api/documents/${slug}/team/invites/${inviteId}/remove`, 'POST', {}, MIKE);
    assert.equal(removed.status, 200, removed.text);
    assert.equal(removed.body.invites.length, 0);
    documentAccessEvents.off('revoked', listener);
    assert.deepEqual(revoked, [`invite:${inviteId}`], 'open collab sockets are closed');
    assert.equal(db.isDocumentAccessTokenActive(slug, `invite:${inviteId}`), false);
    assert.equal((await mark(slug, ERIC)).body.code, 'SIGN_IN_TO_MARK');
    assert.equal((await call(`/d/${slug}?format=json`, 'GET', undefined, ERIC)).body.capabilities.canEdit, false);
    const list = await call('/library/api/documents', 'GET', undefined, ERIC);
    assert.deepEqual(list.body.documents, []);
    assert.equal((await call(`/invite/${inviteId}`)).status, 404, 'the old invite link is dead');
    assert.equal((await call(`/api/documents/${slug}/team/invites/${inviteId}/remove`, 'POST', {}, MIKE)).status, 404);
  });

  await test('an admin adding an invited person to the library makes them a member', async () => {
    const reinvite = await call(`/api/documents/${slug}/team/invites`, 'POST', { email: 'eric@example.test' }, MIKE);
    assert.equal(reinvite.status, 201);
    assert.notEqual(reinvite.body.invite.id, inviteId, 'a new invite gets a new id');
    const promoted = await call('/library/api/people', 'POST', { name: 'Eric', email: 'eric@example.test' }, MIKE);
    assert.equal(promoted.status, 201);
    assert.equal(auth.getLibraryMemberByEmail('eric@example.test')!.scope, 'library');
    const list = await call('/library/api/documents', 'GET', undefined, { Cookie: ericCookie });
    assert.ok(list.body.documents.length >= 2);
  });

  await test('rate limit: at most 20 invites per document per hour', async () => {
    team.resetInviteRateLimitsForTests();
    let last = 0;
    for (let i = 0; i < 21; i += 1) {
      last = (await call(`/api/documents/${slug}/team/invites`, 'POST', { email: `p${i}@example.test`, send: false }, MIKE)).status;
    }
    assert.equal(last, 429);
  });

  console.log(`\n${passed} invite tests passed`);
} finally {
  server.close();
  if (existsSync(temp)) rmSync(temp, { recursive: true, force: true });
}
process.exit(0);
