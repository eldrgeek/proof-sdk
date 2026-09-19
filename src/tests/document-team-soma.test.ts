// Invite person (2026-09-19) with SOMA Auth on, as on the live server: the invitation email is a
// SOMA magic link (or a Resend email when configured) that returns to /invite/<id>; only the
// invited address can sign in; an invited person may sign in only while they have an invite.
// Authorship: Claude Opus 5 (worker proof-invite), 2026-09-19. Every external call is stubbed.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-team-soma-'));
process.env.DATABASE_PATH = path.join(temp, 'test.db');
process.env.SNAPSHOT_DIR = path.join(temp, 'snapshots');
Object.assign(process.env, {
  PROOF_ENV: 'test', PROOF_DB_ENV_INIT: 'test', PROOF_LIBRARY_ENABLED: '1', PROOF_SOMA_AUTH_ENABLED: '1',
  PROOF_TRUST_PROXY_HEADERS: '1', SOMA_AUTH_URL: 'https://soma.test', SOMA_AUTH_ANON_KEY: 'public-anon',
});
for (const key of ['PROOF_INVITE_MAIL_TRANSPORT', 'RESEND_API_KEY', 'PROOF_GUEST_ACCESS_DEFAULT', 'PROOF_PUBLIC_ORIGIN']) delete process.env[key];

const db = await import('../../server/db');
const auth = await import('../../server/library/auth');
const team = await import('../../server/document-team');
const { libraryRoutes } = await import('../../server/library/routes');
const { documentTeamRoutes } = await import('../../server/document-team-routes');

const nativeFetch = globalThis.fetch;
const calls: Array<{ url: string; body: any; headers: any }> = [];
const users: Record<string, string> = { 'Bearer admin-token': 'mw@mike-wolf.com', 'Bearer eric-token': 'eric@example.test', 'Bearer other-token': 'other@example.test' };
globalThis.fetch = async (input, init) => {
  const url = String(input);
  calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null, headers: init?.headers });
  assert(url.startsWith('https://soma.test/'), `all external requests must be stubbed: ${url}`);
  const token = (init?.headers as any)?.Authorization;
  if (url.endsWith('/auth/v1/user')) {
    const email = users[token];
    return email ? Response.json({ email, email_confirmed_at: '2026-09-01T00:00:00.000Z', user_metadata: { full_name: email === 'eric@example.test' ? 'Eric Hart' : 'Someone' } }) : Response.json({}, { status: 401 });
  }
  if (url.endsWith('/rest/v1/rpc/is_app_admin')) return Response.json(token === 'Bearer admin-token');
  if (url.includes('/auth/v1/otp')) return Response.json({});
  if (url.endsWith('/resend')) return Response.json({ id: 'email-1' });
  throw new Error(`unexpected ${url}`);
};

const app = express();
app.use(express.json(), libraryRoutes, documentTeamRoutes);
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
let ip = 1;
async function request(method: string, route: string, body?: unknown, cookie = '') {
  const response = await nativeFetch(origin + route, {
    method, redirect: 'manual',
    headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, 'X-Forwarded-For': `192.0.2.${ip++}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = {}; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: response.status, text, json, cookie: (response.headers.get('set-cookie') || '').split(';')[0], location: response.headers.get('location') };
}

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) { await fn(); passed += 1; console.log(`✓ ${name}`); }

try {
  const admin = await request('POST', '/library/api/session', { accessToken: 'admin-token' });
  assert.equal(admin.status, 200, admin.text);
  const ADMIN = admin.cookie;
  db.createDocument('soma-doc', '# Soma doc\n\nA line.', {}, 'Soma doc');
  let inviteId = '';

  await test('before an invite, Eric cannot sign in (the library is not shared with him)', async () => {
    const denied = await request('POST', '/library/api/session', { accessToken: 'eric-token' });
    assert.equal(denied.status, 403);
    assert.equal(denied.cookie, '');
  });

  await test('an admin invites Eric: SOMA Auth emails a magic link that returns to the invite page', async () => {
    assert.equal(team.inviteMailTransport(), 'soma-otp');
    calls.length = 0;
    const invited = await request('POST', '/api/documents/soma-doc/team/invites', { email: 'eric@example.test', name: 'Eric' }, ADMIN);
    assert.equal(invited.status, 201, invited.text);
    inviteId = invited.json.invite.id;
    assert.deepEqual(invited.json.email, { sent: true, transport: 'soma-otp' });
    const otp = calls.find(c => c.url.includes('/auth/v1/otp'))!;
    assert.ok(otp, 'SOMA Auth was asked to send the email');
    assert.equal(new URL(otp.url).searchParams.get('redirect_to'), `${origin}/invite/${inviteId}`);
    assert.deepEqual(otp.body, { email: 'eric@example.test', create_user: true });
    assert.equal(otp.headers.apikey, 'public-anon');
    assert.equal(invited.json.invite.link, `${origin}/invite/${inviteId}`, 'the copied link is the invite page, not a credential');
  });

  await test('the invite page, signed out: sign-in controls, a masked address, no credential', async () => {
    const landing = await request('GET', `/invite/${inviteId}`);
    assert.equal(landing.status, 200);
    assert.match(landing.text, /Continue with Google/);
    assert.match(landing.text, /Mike|invited/);
    assert.ok(!landing.text.includes('eric@example.test'));
    assert.ok(landing.text.includes('access_token'), 'the page reads a magic-link token from its fragment');
    const stranger = await request('POST', '/library/api/session', { accessToken: 'other-token' });
    assert.equal(stranger.status, 403, 'someone else following the link is not let in');
  });

  let ERIC = '';
  await test('Eric signs in with SOMA Auth: session, the invite page sends him to the document', async () => {
    const signedIn = await request('POST', '/library/api/session', { accessToken: 'eric-token' });
    assert.equal(signedIn.status, 200, signedIn.text);
    ERIC = signedIn.cookie;
    const me = await request('GET', '/library/api/me', undefined, ERIC);
    assert.equal(me.json.scope, 'invited');
    assert.equal(me.json.isOwner, false);
    const landing = await request('GET', `/invite/${inviteId}`, undefined, ERIC);
    assert.equal(landing.status, 302);
    assert.equal(landing.location, '/d/soma-doc');
    const home = await request('GET', '/library/api/documents', undefined, ERIC);
    assert.deepEqual(home.json.documents.map((d: any) => d.slug), ['soma-doc']);
    const wrong = await request('GET', `/invite/${inviteId}`, undefined, ADMIN);
    assert.match(wrong.text, /This invitation is for someone else/);
  });

  await test('Resend transport when configured: a branded email with the invite page link', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.PROOF_RESEND_API_URL = 'https://soma.test/resend';
    try {
      calls.length = 0;
      const invited = await request('POST', '/api/documents/soma-doc/team/invites', { email: 'ada@example.test' }, ADMIN);
      assert.deepEqual(invited.json.email, { sent: true, transport: 'resend' });
      const sent = calls.find(c => c.url.endsWith('/resend'))!;
      assert.deepEqual(sent.body.to, ['ada@example.test']);
      assert.match(sent.body.text, new RegExp(`${origin}/invite/${invited.json.invite.id}`));
      assert.equal(sent.headers.Authorization, 'Bearer re_test');
      const soon = await request('POST', `/api/documents/soma-doc/team/invites/${invited.json.invite.id}/resend`, {}, ADMIN);
      assert.equal(soon.status, 429, 'a resend waits a minute');
    } finally {
      delete process.env.RESEND_API_KEY;
      delete process.env.PROOF_RESEND_API_URL;
    }
  });

  await test('removing Eric\'s last invite: he can no longer sign in afresh', async () => {
    const removed = await request('POST', `/api/documents/soma-doc/team/invites/${inviteId}/remove`, {}, ADMIN);
    assert.equal(removed.status, 200);
    const again = await request('POST', '/library/api/session', { accessToken: 'eric-token' });
    assert.equal(again.status, 403);
    const home = await request('GET', '/library/api/documents', undefined, ERIC);
    assert.deepEqual(home.json.documents, []);
  });

  await test('an admin whose email was invited becomes a library member on sign-in', async () => {
    const invited = await request('POST', '/api/documents/soma-doc/team/invites', { email: 'admin2@example.test' }, ADMIN);
    assert.equal(invited.status, 201);
    users['Bearer admin2-token'] = 'admin2@example.test';
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith('/rest/v1/rpc/is_app_admin') && (init?.headers as any)?.Authorization === 'Bearer admin2-token') return Response.json(true);
      return original(input, init);
    };
    const signedIn = await request('POST', '/library/api/session', { accessToken: 'admin2-token' });
    globalThis.fetch = original;
    assert.equal(signedIn.status, 200);
    assert.equal(auth.getLibraryMemberByEmail('admin2@example.test')!.scope, 'library');
  });

  console.log(`\n${passed} SOMA invite tests passed`);
} finally {
  server.close();
  rmSync(temp, { recursive: true, force: true });
}
process.exit(0);
