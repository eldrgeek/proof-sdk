import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import express from 'express';

process.env.DATABASE_PATH = `${tmpdir()}/proof-soma-${process.pid}-${Date.now()}.db`;
process.env.SNAPSHOT_DIR = `${tmpdir()}/proof-soma-snapshots-${process.pid}`;
Object.assign(process.env, { PROOF_ENV: 'test', PROOF_DB_ENV_INIT: 'test', PROOF_LIBRARY_ENABLED: '1', PROOF_SOMA_AUTH_ENABLED: '1', PROOF_TRUST_PROXY_HEADERS: '1', SOMA_AUTH_URL: 'https://soma.test', SOMA_AUTH_ANON_KEY: 'public-anon' });
const root = '../../server';
const auth = await import(`${root}/library/auth.js`);
const { libraryRoutes } = await import(`${root}/library/routes.js`);
const { renderLibraryHome } = await import(`${root}/library/page.js`);
const { shareWebRoutes } = await import(`${root}/share-web-routes.js`);
const { getDb, createDocument } = await import(`${root}/db.js`);
const { getClientIp } = await import(`${root}/client-address.js`);
const nativeFetch = globalThis.fetch;
const calls: Array<{ url: string; body: any; headers: any }> = [];
let admin = true;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null, headers: init?.headers });
  assert(url.startsWith('https://soma.test/'), 'all external requests must be stubbed');
  const token = (init?.headers as any).Authorization;
  if (url.endsWith('/auth/v1/user')) {
    if (token === 'Bearer invalid' || token === 'Bearer expired') return Response.json({ message: 'invalid' }, { status: 401 });
    return Response.json({ email: token === 'Bearer admin-token' ? 'ADMIN@example.test' : token === 'Bearer member-token' ? 'member@example.test' : 'stranger@example.test', user_metadata: { full_name: 'SOMA Admin' } });
  }
  assert.deepEqual(JSON.parse(String(init?.body)), { target_app: 'proof-plus' });
  return Response.json(token === 'Bearer admin-token' && admin);
};
const app = express();
app.use(express.json(), libraryRoutes);
app.get('/', renderLibraryHome);
app.use(shareWebRoutes);
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
let ip = 1;
async function request(method: string, route: string, body?: any, cookie = '', headers: Record<string, string> = {}) {
  const response = await nativeFetch(origin + route, { method, headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, 'X-Forwarded-For': `192.0.2.${ip++}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json: any; try { json = JSON.parse(text); } catch {}
  return { status: response.status, text, json, cookie: response.headers.get('set-cookie') || '' };
}
try {
  const member = auth.createLibraryMember({ name: 'Library Member', email: 'member@example.test', isOwner: true });
  for (const Origin of ['', 'https://foreign.test']) assert.equal((await request('POST', '/library/api/session', { accessToken: 'admin-token' }, '', { Origin })).status, 403);
  for (const accessToken of ['invalid', 'expired']) assert.equal((await request('POST', '/library/api/session', { accessToken })).status, 401);
  const stranger = await request('POST', '/library/api/session', { accessToken: 'stranger', email: 'admin@example.test', isOwner: true });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.json.message, "You're signed in as stranger@example.test, but this Proof+ isn't shared with that address. Ask Mike or Eric to add you.");
  const signedIn = await request('POST', '/library/api/session', { accessToken: 'admin-token' });
  assert.equal(signedIn.status, 200);
  const adminCookie = signedIn.cookie.split(';')[0];
  for (const flag of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=15552000']) assert(signedIn.cookie.includes(flag));
  assert.equal((await request('GET', '/library/api/me', undefined, adminCookie)).json.isOwner, true);
  const secure = await request('POST', '/library/api/session', { accessToken: 'admin-token' }, '', { Origin: origin.replace('http:', 'https:'), 'X-Forwarded-Proto': 'https' });
  assert(secure.cookie.includes('Secure'));
  const memberSignIn = await request('POST', '/library/api/session', { accessToken: 'member-token', isOwner: true });
  assert.equal(memberSignIn.status, 200);
  const memberCookie = memberSignIn.cookie.split(';')[0];
  assert.equal((await request('GET', '/library/api/me', undefined, memberCookie)).json.isOwner, false, 'local owner field cannot grant SOMA admin');
  assert.equal((await request('POST', '/library/api/people', { name: 'No', email: 'no@test.dev' }, memberCookie)).status, 403);
  const added = await request('POST', '/library/api/people', { name: 'New', email: 'new@test.dev' }, adminCookie);
  assert.equal(added.status, 201); assert(!('link' in added.json));
  assert.equal((await request('GET', '/library/api/people', undefined, memberCookie)).status, 200);
  assert.equal((await request('GET', '/library/signin')).status, 404);
  assert.equal((await request('POST', '/library/api/device-link', {}, adminCookie)).status, 404);
  assert.equal((await request('POST', '/library/api/signin', {}, adminCookie)).status, 404);
  assert(!readFileSync(new URL('../../server/library/cli.ts', import.meta.url), 'utf8').includes('signin-link'));
  const home = await request('GET', '/', undefined, adminCookie);
  assert(home.text.includes('soma-auth.js')); assert(!home.text.includes('Sign in on another device'));
  for (const table of getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]) {
    const data = JSON.stringify(getDb().prepare(`SELECT * FROM "${table.name}"`).all());
    for (const secret of ['admin-token', 'member-token', adminCookie.split('=')[1]]) assert(!data.includes(secret), 'database contains no tokens or raw sessions');
  }
  const roleCalls = calls.filter(call => call.url.includes('/rpc/')).length;
  await request('POST', '/library/api/session', { accessToken: 'admin-token' }, adminCookie);
  assert.equal(calls.filter(call => call.url.includes('/rpc/')).length, roleCalls, 'checks role at most daily when sliding');
  getDb().prepare("UPDATE library_sessions SET soma_verified_at='2000-01-01T00:00:00.000Z'").run();
  assert.equal((await request('GET', '/library/api/me', undefined, adminCookie)).json.isOwner, false, 'stale admin lease fails closed');
  admin = false;
  assert.equal((await request('POST', '/library/api/session', { accessToken: 'admin-token' }, adminCookie)).status, 200);
  assert.equal(calls.filter(call => call.url.includes('/rpc/')).length, roleCalls + 1);
  assert.equal((await request('GET', '/library/api/me', undefined, adminCookie)).json.isOwner, false);
  assert.equal((await request('POST', '/library/api/people', { name: 'No', email: 'another@test.dev' }, adminCookie)).status, 403, 'removed admin loses privilege');
  const forwarded = { header: () => '198.51.100.1, 127.0.0.1', ip: '127.0.0.1', socket: {} };
  assert.equal(getClientIp(forwarded), '198.51.100.1');
  process.env.PROOF_TRUST_PROXY_HEADERS = '0'; assert.equal(getClientIp(forwarded), '127.0.0.1');
  process.env.PROOF_TRUST_PROXY_HEADERS = '1';
  for (let i = 0; i < 10; i++) assert.equal((await request('POST', '/library/api/session', { accessToken: 'invalid' }, '', { 'X-Forwarded-For': '203.0.113.1' })).status, 401);
  assert.equal((await request('POST', '/library/api/session', { accessToken: 'invalid' }, '', { 'X-Forwarded-For': '203.0.113.1' })).status, 429);
  assert.equal((await request('POST', '/library/api/session', { accessToken: 'invalid' }, '', { 'X-Forwarded-For': '203.0.113.2' })).status, 401);
  createDocument('visit-test', '# Visit', {}, 'Visit');
  await request('GET', '/d/visit-test', undefined, memberCookie, { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0' });
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM library_visits').get().n, 0, 'GET never records visits');
  assert.equal((await request('POST', '/library/api/visits/visit-test', { event: 'open' }, memberCookie, { Origin: '' })).status, 403);
  assert.equal((await request('POST', '/library/api/visits/visit-test', { event: 'open' }, memberCookie)).status, 200);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM library_visits').get().n, 1);
  auth.removeLibraryMember(member.id);
  assert.equal((await request('GET', '/library/api/me', undefined, memberCookie)).status, 401);
  process.env.PROOF_SOMA_AUTH_ENABLED = '0';
  assert.equal((await request('POST', '/library/api/session', {})).status, 404);
  assert.equal((await request('GET', '/library/signin')).status, 200);
  console.log('SOMA auth and L1 regression tests passed');
} finally {
  globalThis.fetch = nativeFetch;
  await new Promise<void>(resolve => server.close(() => resolve()));
}
