// ac-220: real HTTP, temporary SQLite, no mail or external services.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import { AGENT_JOIN_POLICY as P } from '../shared/agent-join';

const temp = mkdtempSync(path.join(tmpdir(), 'accord-join-'));
Object.assign(process.env, {
  DATABASE_PATH: path.join(temp, 'test.db'), SNAPSHOT_DIR: path.join(temp, 'snapshots'),
  PROOF_ENV: 'test', PROOF_DB_ENV_INIT: 'test', PROOF_LIBRARY_ENABLED: '1', PROOF_TRUST_PROXY_HEADERS: '1',
});
for (const key of ['PROOF_SOMA_AUTH_ENABLED', 'PROOF_PUBLIC_ORIGIN', 'PROOF_GUEST_ACCESS_DEFAULT']) delete process.env[key];
const db = await import('../../server/db');
const auth = await import('../../server/library/auth');
const { agentJoinRoutes, requireAgentJoinOrigin } = await import('../../server/agent-join-routes');
const { apiRoutes } = await import('../../server/routes');
const { agentRoutes } = await import('../../server/agent-routes');
const { shareWebRoutes } = await import('../../server/share-web-routes');
const { discoveryRoutes } = await import('../../server/discovery-routes');
const cross = await import('../../server/cross-invitation');
const team = await import('../../server/document-team');
const app = express();
app.use(requireAgentJoinOrigin);
app.use(express.json());
app.use(agentJoinRoutes);
app.use('/api', apiRoutes);
app.use('/api/agent', agentRoutes);
app.use(discoveryRoutes);
app.use(shareWebRoutes);
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
let address = 0;
const call = async (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(base + url, { method, headers: {
    'Content-Type': 'application/json', Origin: base, 'X-Real-IP': `198.51.${Math.floor(address / 250)}.${++address % 250}`,
    'X-Proof-Client-Version': '0.34.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3', ...headers,
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = {}; try { json = JSON.parse(text); } catch { /* HTML/markdown */ }
  return { status: res.status, body: json, text, headers: res.headers };
};
const mike = auth.createLibraryMember({ name: 'Mike', email: 'mike@example.test', isOwner: true });
function cookie(memberId: string) {
  const link = auth.createLibrarySigninLink({ memberId, purpose: 'operator', origin: base });
  const session = auth.consumeLibrarySigninToken(new URL(link.link).hash.slice(3), null)!;
  return `${auth.LIBRARY_SESSION_COOKIE}=${encodeURIComponent(session.sessionId)}`;
}
const MIKE = { Cookie: cookie(mike.id) };
function doc(slug: string, mode = 'comment') {
  db.createDocument(slug, '# Join test\n\nA line to discuss.', {}, 'Join test', 'owner', `owner-${slug}`);
  db.getDb().prepare('INSERT INTO library_document_meta (slug, created_by_member_id) VALUES (?, ?)').run(slug, mike.id);
  assert.equal(team.setGuestAccessMode(slug, mode, 'human:mike@example.test').ok, true);
  return slug;
}
const ask = (slug: string, headers = {}) => call(`/api/agent/${slug}/join`, 'POST', { name: 'Drew', runtime: 'OpenAI GPT-6' }, headers);
const poll = (slug: string, request: any, headers = {}) => call(`/api/agent/${slug}/join/${request.requestId}`, 'GET', undefined, { 'x-join-token': request.pollToken, ...headers });
const decide = (slug: string, request: any, action = 'admit', headers: Record<string, string> = MIKE) => call(`/api/documents/${slug}/agent-joins/${request.requestId}/${action}`, 'POST', {}, headers);
let count = 0;
async function test(name: string, fn: () => Promise<void> | void) { await fn(); console.log(`✓ ${name}`); count++; }
const streams: AbortController[] = [];
try {
  const slug = doc('join-main');
  let request: any;
  let key = '';
  let tokenId = '';
  await test('URL JSON, markdown, agent HTML, discovery and docs explain joining', async () => {
    for (const accept of ['application/json', 'text/markdown', 'text/html']) {
      const result = await call(`/d/${slug}`, 'GET', undefined, { Accept: accept, 'User-Agent': 'AgentFetch' });
      assert.equal(result.status, 200, result.text);
      assert.ok(result.text.includes(`/api/agent/${slug}/join`));
      assert.ok(!result.text.includes('Ask for a tokenized link'));
    }
    const discovery = await call('/.well-known/agent.json');
    assert.equal(discovery.body.join.autoAdmit, false);
    assert.match((await call('/agent-docs')).text, /Joining an Accord from its URL/);
  });
  await test('request gets one poll token, a matching readable code, and a 15-minute deadline', async () => {
    const result = await ask(slug); request = result.body;
    assert.equal(result.status, 202, result.text);
    assert.match(request.code, /^[A-Z]+-\d{4}$/);
    assert.ok(Date.parse(request.expiresAt) > Date.now() + P.expiresInMs - 5000);
    assert.equal(request.pollUrl, `/api/agent/${slug}/join/${request.requestId}`);
    assert.ok(!request.pollUrl.includes(request.pollToken));
    assert.equal(result.headers.get('cache-control'), 'no-store');
    const listed = await call(`/api/documents/${slug}/agent-joins`, 'GET', undefined, MIKE);
    assert.equal(listed.body.requests[0].code, request.code);
    assert.equal(listed.text.includes(request.pollToken), false);
    assert.deepEqual((await poll(slug, request)).body, { status: 'pending' });
    const stored = db.getDb().prepare('SELECT * FROM agent_join_requests WHERE requestId = ?').get(request.requestId);
    assert.ok(!JSON.stringify(stored).includes(request.pollToken));
  });
  await test('poll tokens are required in the header and scoped to their request and document', async () => {
    assert.equal((await poll(slug, request, { 'x-join-token': 'wrong' })).status, 401);
    assert.equal((await call(`${request.pollUrl}?token=${request.pollToken}`)).status, 401);
    assert.equal((await poll('another-document', request)).status, 401);
    assert.equal((await poll(slug, { ...request, requestId: 'missing' })).status, 401);
  });
  await test('only authorized people see the request list or stream; same-origin required for decisions', async () => {
    assert.equal((await call(`/api/documents/${slug}/agent-joins`)).status, 403);
    assert.equal((await call(`/api/documents/${slug}/agent-joins/events`)).status, 403);
    assert.equal((await decide(slug, request, 'admit', { ...MIKE, Origin: 'https://elsewhere.test' })).status, 403);
    assert.equal((await call(`/api/documents/${slug}/agent-joins/${request.requestId}/admit`, 'OPTIONS', undefined, { Origin: 'https://elsewhere.test' })).status, 403);
  });
  await test('a person admits; the key is delivered exactly once even with concurrent polls', async () => {
    assert.deepEqual((await decide(slug, request)).body, { status: 'admitted' });
    const results = await Promise.all([poll(slug, request), poll(slug, request)]);
    const delivered = results.filter(result => result.body.token);
    assert.equal(delivered.length, 1);
    key = delivered[0].body.token; tokenId = delivered[0].body.tokenId;
    assert.deepEqual((await poll(slug, request)).body, { status: 'admitted', delivered: true });
    assert.equal((await decide(slug, request)).status, 409);
    const listed = await call(`/api/documents/${slug}/agent-keys`, 'GET', undefined, MIKE);
    const agent = listed.body.keys.find((k: any) => k.tokenId === tokenId);
    assert.equal(agent.sponsor, 'human:mike@example.test');
    assert.equal(agent.runtime, 'OpenAI GPT-6');
    assert.equal(agent.provenance, 'Drew — added by Mike');
    assert.ok(!listed.text.includes(key));
  });
  await test('the ordinary agent key reads state and comments as the named AI with its sponsor', async () => {
    const AI = { 'x-share-token': key };
    assert.equal((await call(`/api/agent/${slug}/state`, 'GET', undefined, AI)).status, 200);
    const comment = await call(`/api/agent/${slug}/ops`, 'POST', { type: 'comment.add', quote: 'A line to discuss.', text: 'Drew joined this Accord.', by: 'ai:drew' }, AI);
    assert.equal(comment.status, 200, comment.text);
    const state = await call(`/api/agent/${slug}/state`, 'GET', undefined, AI);
    const marks = Object.values(state.body.marks) as any[];
    assert.ok(marks.some(mark => mark.by === 'ai:drew' && mark.text === 'Drew joined this Accord.'), state.text);
    const view = await call(`/api/documents/${slug}/line-marks`, 'GET', undefined, MIKE);
    assert.equal(view.body.agentSponsors['ai:drew'].sponsorName, 'Mike');
  });
  await test('agent keys, share tokens and owner credentials cannot admit or refuse, including guest edit', async () => {
    const open = (await ask(slug)).body;
    const link = db.createDocumentAccessToken(slug, 'editor');
    for (const credential of [key, link.secret, `owner-${slug}`]) {
      for (const action of ['admit', 'refuse']) assert.equal((await decide(slug, open, action, { 'x-share-token': credential } as any)).status, 403);
    }
    assert.equal((await decide(slug, open, 'admit', { ...MIKE, 'x-share-token': key })).status, 403);
    const guest = doc('join-guest', 'edit'); const guestOpen = (await ask(guest)).body;
    const guestLink = db.createDocumentAccessToken(guest, 'editor');
    assert.equal((await decide(guest, guestOpen, 'admit', { 'x-share-token': guestLink.secret } as any)).status, 403);
    assert.equal((await decide(guest, guestOpen, 'admit', {} as any)).status, 200);
    assert.ok((await poll(guest, guestOpen)).body.token);
    assert.equal((await decide(slug, open, 'refuse')).status, 200);
    assert.deepEqual((await poll(slug, open)).body, { status: 'refused' });
  });
  await test('private documents answer like their viewer URL and reveal no request', async () => {
    const privateSlug = doc('join-private', 'private');
    const viewer = await call(`/d/${privateSlug}?format=json`);
    const join = await ask(privateSlug);
    assert.equal(join.status, 401);
    assert.deepEqual(join.body, viewer.body);
  });
  await test('refused requests cannot be admitted and no key is made', async () => {
    const target = doc('join-refused'); const open = (await ask(target)).body;
    assert.equal((await decide(target, open, 'refuse')).status, 200);
    assert.deepEqual((await poll(target, open)).body, { status: 'refused' });
    assert.equal((await decide(target, open)).status, 409);
    assert.equal(cross.listAgentKeyViews(target).length, 0);
  });
  await test('expiry closes pending requests and destroys an uncollected key handover', async () => {
    for (const admit of [false, true]) {
      const target = doc(`join-expiry-${admit}`); const open = (await ask(target)).body;
      if (admit) assert.equal((await decide(target, open)).status, 200);
      db.getDb().prepare('UPDATE agent_join_requests SET expiresAt = ? WHERE requestId = ?').run(new Date(Date.now() - 1).toISOString(), open.requestId);
      assert.deepEqual((await poll(target, open)).body, { status: 'expired' });
      assert.equal((await decide(target, open)).status, 409);
      assert.deepEqual((await call(`/api/documents/${target}/agent-joins`, 'GET', undefined, MIKE)).body.requests, []);
    }
  });
  await test('uncollected handover expires without a poll', async () => {
    const target = doc('join-timer'); const open = (await ask(target)).body;
    db.getDb().prepare('UPDATE agent_join_requests SET expiresAt = ? WHERE requestId = ?').run(new Date(Date.now() + 80).toISOString(), open.requestId);
    assert.equal((await decide(target, open)).status, 200);
    await new Promise(resolve => setTimeout(resolve, 150));
    const row = db.getDb().prepare('SELECT status FROM agent_join_requests WHERE requestId = ?').get(open.requestId) as any;
    assert.equal(row.status, 'expired');
    assert.equal((await poll(target, open)).body.token, undefined);
  });
  await test('five open requests per document; refusing one frees its place', async () => {
    const target = doc('join-cap'); let open: any;
    for (let i = 0; i < P.maxOpenPerDocument; i++) { const result = await ask(target); assert.equal(result.status, 202); open = result.body; }
    assert.equal((await ask(target)).body.code, 'JOIN_CAP');
    assert.equal((await decide(target, open, 'refuse')).status, 200);
    assert.equal((await ask(target)).status, 202);
  });
  await test('document and address budgets are independent and shared with Add agent', async () => {
    const target = doc('join-rate');
    // Invalid attempts use the budget without making five pending requests.
    for (let i = 0; i < P.requestsPerDocument; i++) assert.equal((await call(`/api/agent/${target}/join`, 'POST', {})).status, 400);
    const limited = await ask(target); assert.equal(limited.status, 429); assert.equal(limited.body.code, 'RATE_LIMITED');
    assert.equal((await call(`/api/documents/${target}/agent-keys`, 'POST', { label: 'AI', runtime: 'Model' }, MIKE)).status, 429);
    const fixedIp = { 'X-Real-IP': '192.0.2.40' };
    for (let i = 0; i < P.requestsPerAddress; i++) {
      const other = doc(`join-address-${i}`);
      assert.equal((await call(`/api/agent/${other}/join`, 'POST', {}, fixedIp)).status, 400);
    }
    assert.equal((await ask(doc('join-address-last'), fixedIp)).status, 429);
  });
  await test('no other routes echo poll tokens or handover secrets', async () => {
    for (const route of [`/d/${slug}?format=json`, `/d/${slug}?format=markdown`, `/api/documents/${slug}/agent-joins`, `/api/documents/${slug}/agent-keys`, `/api/agent/${slug}/state`, `/api/agent/${slug}/events/pending`, '/.well-known/agent.json']) {
      const result = await call(route, 'GET', undefined, { ...MIKE, 'x-share-token': `owner-${slug}` });
      assert.equal(result.status, 200, `${route}: ${result.text}`);
      assert.ok(!result.text.includes(request.pollToken), route);
      assert.ok(!result.text.includes(key), route);
    }
    const rows = db.getDb().prepare('SELECT * FROM agent_join_requests').all();
    assert.ok(!JSON.stringify(rows).includes(key));
  });
  await test('events deliver matching codes immediately, no secrets, and close when the session is revoked', async () => {
    const target = doc('join-stream');
    const controller = new AbortController(); streams.push(controller);
    const session = { Cookie: cookie(mike.id) };
    const res = await fetch(`${base}/api/documents/${target}/agent-joins/events`, { headers: session, signal: controller.signal });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader(); const decode = new TextDecoder();
    assert.match(decode.decode((await reader.read()).value), /"requests":\[\]/);
    const open = (await ask(target)).body;
    const event = decode.decode((await reader.read()).value);
    assert.ok(event.includes(open.code)); assert.ok(!event.includes(open.pollToken));
    assert.equal((await decide(target, open)).status, 200);
    assert.ok(!decode.decode((await reader.read()).value).includes('token'));
    const token = (await poll(target, open)).body.token; assert.ok(token);
    // Remove only the stream's session; another live session can still admit.
    auth.revokeLibrarySession({ header: (name: string) => name === 'cookie' ? session.Cookie : undefined } as any);
    await ask(target);
    assert.match(decode.decode((await reader.read()).value), /event: denied/);
    assert.equal((await reader.read()).done, true);
    controller.abort();
  });
  await test('ordinary key revocation and sponsor suspension apply to joined agents', async () => {
    db.getDb().prepare('UPDATE library_members SET removed_at = ? WHERE id = ?').run(new Date().toISOString(), mike.id);
    assert.equal((await call(`/api/agent/${slug}/state`, 'GET', undefined, { 'x-share-token': key })).status, 401);
    db.getDb().prepare('UPDATE library_members SET removed_at = NULL WHERE id = ?').run(mike.id);
    assert.equal((await call(`/api/agent/${slug}/state`, 'GET', undefined, { 'x-share-token': key })).status, 200);
    assert.equal((await call(`/api/documents/${slug}/agent-keys/${tokenId}`, 'DELETE', {}, MIKE)).status, 200);
    assert.equal((await call(`/api/agent/${slug}/state`, 'GET', undefined, { 'x-share-token': key })).status, 401);
  });
  console.log(`\n${count} agent-join tests passed`);
} finally {
  for (const controller of streams) controller.abort();
  server.closeAllConnections(); server.close();
  rmSync(temp, { recursive: true, force: true });
}
