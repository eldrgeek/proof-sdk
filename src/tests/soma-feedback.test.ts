import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import express from 'express';

process.env.DATABASE_PATH = `${tmpdir()}/proof-feedback-${process.pid}-${Date.now()}.db`;
process.env.SNAPSHOT_DIR = `${tmpdir()}/proof-feedback-snapshots-${process.pid}`;
Object.assign(process.env, { PROOF_ENV: 'test', PROOF_DB_ENV_INIT: 'test', PROOF_LIBRARY_ENABLED: '1', PROOF_SOMA_AUTH_ENABLED: '0', PROOF_FEEDBACK_ENABLED: '1', SOMA_ADMIN_TOKEN: 'server-secret' });
const root = '../../server';
const auth = await import(`${root}/library/auth.js`);
const { somaFeedbackRoutes } = await import(`${root}/soma-feedback.js`);
const { injectSomaFeedback } = await import(`${root}/soma-page.js`);
const { libraryRoutes } = await import(`${root}/library/routes.js`);
const { renderLibraryHome } = await import(`${root}/library/page.js`);
const { shareWebRoutes } = await import(`${root}/share-web-routes.js`);
const { createDocument } = await import(`${root}/db.js`);
const nativeFetch = globalThis.fetch;
let upstream: any = { status: 'accepted', filedAt: 'now', build: false };
let status = 200;
let down = false;
const bodies: any[] = [];
globalThis.fetch = async (input, init) => {
  assert.equal(String(input), 'http://127.0.0.1:4252/feedback');
  assert.deepEqual(init?.headers, { 'Content-Type': 'application/json' }, 'never forwards authorization headers');
  bodies.push(JSON.parse(String(init?.body)));
  if (down) throw new Error('connection refused');
  return Response.json(upstream, { status });
};
const app = express();
app.use(express.json(), somaFeedbackRoutes, libraryRoutes);
app.get('/', renderLibraryHome);
app.use(shareWebRoutes);
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
async function request(method: string, route: string, body?: any, cookie = '', extra = {}) {
  const response = await nativeFetch(origin + route, { method, headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, 'User-Agent': 'Mozilla/5.0', Accept: 'text/html', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json: any; try { json = JSON.parse(text); } catch {}
  return { status: response.status, text, json };
}
function session(isOwner: boolean) {
  const member = auth.createLibraryMember({ name: isOwner ? 'Admin $&' : 'Member', email: `${isOwner}@example.test`, isOwner });
  const token = auth.createLibrarySigninLink({ memberId: member.id, purpose: 'operator', origin }).link.split('#t=')[1];
  const result = auth.consumeLibrarySigninToken(token, null);
  return { member, cookie: `proof_library_session=${result.sessionId}` };
}
function checkChip(html: string, area: string) {
  for (const value of ['/vendor/soma-feedback/soma-feedback.js', '/vendor/soma-feedback/soma-feedback.css', 'data-site="proof-plus"', 'data-endpoint="/api/soma-feedback"', 'data-no-google', `data-area="${area}"`]) assert(html.includes(value), `missing ${value}`);
}
try {
  const admin = session(true), member = session(false);
  const body = { text: 'Please improve this', site: 'proof-plus', conversation: [{ role: 'user', content: 'More detail' }], adminToken: 'fake', googleIdToken: 'fake-google', name: 'Name', area: 'library' };
  for (const cookie of ['', 'proof_library_session=fake', member.cookie, admin.cookie]) {
    const response = await request('POST', '/api/soma-feedback', body, cookie, { Authorization: 'Bearer fake' });
    assert.deepEqual(response.json, upstream);
    const sent = bodies.at(-1);
    assert.equal(sent.adminToken, cookie === admin.cookie ? 'server-secret' : undefined);
    assert.equal(sent.googleIdToken, undefined);
    const { adminToken: _, googleIdToken: __, ...rest } = body;
    const { adminToken: ___, ...actual } = sent;
    assert.deepEqual(actual, rest);
  }
  const sharePage = origin + '/d/shared-slug?token=SECRET#private';
  const shareFeedback = {
    ...body, url: sharePage,
    text: 'Please fix ' + sharePage + ' and /d/other?view=edit&token=SECRET and /d/third#token=SECRET',
    page: 'My document ' + sharePage,
    elementHint: 'selected text: \"/d/shared-slug#tokenSECRET\"',
  };
  assert.equal((await request('POST', '/api/soma-feedback', shareFeedback)).status, 200);
  const shareSent = bodies.at(-1);
  assert.equal(shareSent.url, origin + '/d/shared-slug');
  assert(!JSON.stringify(shareSent).includes('SECRET'), 'share credentials never reach feedback');
  assert(shareSent.text.includes('Please fix'));
  assert(shareSent.page.includes('My document'));
  upstream = { status: 'clarify', question: 'Which button?', nested: { untouched: true } };
  assert.deepEqual((await request('POST', '/api/soma-feedback', body)).json, upstream);
  assert.equal((await request('POST', '/api/soma-feedback', body, admin.cookie, { Origin: 'https://foreign.test' })).status, 403);
  status = 400; upstream = { error: 'text is required' };
  const health = await request('GET', '/api/soma-feedback?health=1');
  assert.equal(health.status, 200); assert.equal(health.json.upstream_status, 400); assert.deepEqual(bodies.at(-1), {});
  status = 500;
  assert.equal((await request('GET', '/api/soma-feedback?health=1')).status, 503);
  down = true;
  const failed = await request('POST', '/api/soma-feedback', body);
  assert.equal(failed.status, 502); assert.equal(typeof failed.json.error, 'string');
  assert.equal((await request('GET', '/api/soma-feedback?health=1')).status, 503);
  checkChip((await request('GET', '/')).text, 'sign-in');
  checkChip((await request('GET', '/?signedout=1')).text, 'sign-in');
  checkChip((await request('GET', '/library/signin')).text, 'sign-in');
  const home = (await request('GET', '/', undefined, member.cookie)).text;
  checkChip(home, 'library'); assert(home.includes('"email":"false@example.test"'));
  checkChip(injectSomaFeedback('<html><head></head><body></body></html>', 'editor', admin.member), 'editor');
  createDocument('chip-test', '# Chip', {}, 'Chip');
  const editor = await request('GET', '/d/chip-test');
  assert.equal(editor.status, 200); checkChip(editor.text, 'editor');
  process.env.PROOF_SOMA_AUTH_ENABLED = '1';
  checkChip((await request('GET', '/')).text, 'sign-in');
  process.env.PROOF_FEEDBACK_ENABLED = '0';
  assert.equal((await request('POST', '/api/soma-feedback', body)).status, 404);
  assert.equal((await request('GET', '/api/soma-feedback?health=1')).status, 404);
  assert(!(await request('GET', '/')).text.includes('soma-feedback.js'));
  const script = readFileSync(new URL('../../public/vendor/soma-feedback/soma-feedback.js', import.meta.url), 'utf8');
  assert(script.includes('v4.1'));
  console.log('SOMA feedback tests passed');
} finally {
  globalThis.fetch = nativeFetch;
  await new Promise<void>(resolve => server.close(() => resolve()));
}
