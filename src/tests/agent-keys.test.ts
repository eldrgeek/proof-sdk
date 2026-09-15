import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-x1-keys-'));
process.env.DATABASE_PATH = path.join(temp, 'test.db');
process.env.PROOF_TRUST_PROXY_HEADERS = 'true';
process.env.PROOF_LIBRARY_ENABLED = '1';
const db = await import('../../server/db');
const { apiRoutes } = await import('../../server/routes');
const { agentRoutes } = await import('../../server/agent-routes');
const { shareWebRoutes } = await import('../../server/share-web-routes');
const app = express();
app.use(express.json());
app.use('/api', apiRoutes);
app.use('/api/agent', agentRoutes);
app.use(apiRoutes);
app.use(shareWebRoutes);
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address() as { port: number };
const base = `http://127.0.0.1:${address.port}`;
const call = async (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base, ...headers },
    body: body === undefined ? (method === 'DELETE' ? '{}' : undefined) : JSON.stringify(body) });
  return { status: response.status, headers: response.headers, body: await response.json() };
};
const mint = (slug: string, ip = '192.0.2.1', headers: Record<string, string> = {}) =>
  call(`/api/documents/${slug}/agent-keys`, 'POST', { label: 'Test assistant' }, { 'x-forwarded-for': ip, ...headers });
try {
  db.createDocument('x1-csrf', 'CSRF test', {});
  for (const prefix of ['', '/api']) {
    const endpoint = `${prefix}/documents/x1-csrf/agent-keys`;
    const form = await fetch(base + endpoint, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base }, body: 'label=Attack' });
    assert.equal(form.status, 403, 'Form POST must be forbidden');
    for (const origin of ['https://attacker.test', 'null']) {
      for (const method of ['GET', 'POST', 'DELETE', 'OPTIONS']) {
        const suffix = method === 'DELETE' ? '/any-key' : '';
        const result = await call(endpoint + suffix, method,
          method === 'POST' ? { label: 'Attack' } : undefined, { Origin: origin });
        assert.equal(result.status, 403, `${method} from ${origin} must be forbidden`);
        assert.equal(result.headers.get('access-control-allow-origin'), null);
      }
    }
    for (const method of ['POST', 'DELETE']) {
      assert.equal((await call(endpoint, method, {}, { Origin: '' })).status, 403);
      assert.equal((await call(endpoint, method, {}, { 'Content-Type': 'text/plain' })).status, 403);
    }
  }
  db.createDocument('x1-editor', '# Hello\n\nHello world', {}, 'X1 test');
  const page = await call('/d/x1-editor?format=json');
  assert.equal(page.body.capabilities.canEdit, true);
  const created = await mint('x1-editor');
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const { token, tokenId } = created.body;
  assert.ok(typeof token === 'string' && token.length > 20, 'Expected a real key');
  assert.ok(!JSON.stringify(created.body).includes('?token='), 'Mint must not return tokenized URLs');
  const row = db.getDb().prepare('SELECT * FROM document_access WHERE token_id = ?').get(tokenId) as Record<string, unknown>;
  assert.equal(row.role, 'editor');
  assert.equal(row.requested_by, 'anonymous-page-editor');
  assert.equal(row.requested_from, '192.0.2.1');
  assert.ok(row.secret_hash !== token, 'Only a hash may be stored');
  assert.equal(row.last_used_at, null);
  const auth = { 'x-share-token': token };
  const state = await call('/api/agent/x1-editor/state', 'GET', undefined, auth);
  assert.equal(state.status, 200);
  const operation = { type: 'comment.add', payload: { quote: 'Hello world', text: 'From an invited agent', by: 'ai:x1' } };
  const op = await call('/api/agent/x1-editor/ops', 'POST', operation, auth);
  assert.equal(op.status, 200, 'Minted editor key must execute an operation');
  assert.ok(Object.values(JSON.parse(db.getDocumentBySlug('x1-editor')!.marks)).some((mark: any) => mark.text === 'From an invited agent'));
  const listed = await call('/api/documents/x1-editor/agent-keys');
  assert.ok(!JSON.stringify(listed.body).includes(token), 'Listing must never return the secret');
  assert.equal(listed.body.keys[0].label, 'Test assistant');
  assert.ok(listed.body.keys[0].lastUsedAt);
  const other = db.createDocumentAccessToken('x1-editor', 'editor');
  assert.equal((await call(`/api/documents/x1-editor/agent-keys/${other.tokenId}`, 'DELETE')).status, 404);
  db.createDocument('x1-other', 'Other document', {});
  assert.equal((await call(`/api/documents/x1-other/agent-keys/${tokenId}`, 'DELETE')).status, 404);
  assert.equal((await call(`/api/documents/x1-editor/agent-keys/${tokenId}`, 'DELETE')).status, 200);
  assert.equal((await call('/api/agent/x1-editor/state', 'GET', undefined, auth)).status, 401);
  assert.equal((await call('/api/agent/x1-editor/ops', 'POST', operation, auth)).status, 401);
  assert.equal((await call('/api/agent/x1-editor/state', 'GET', undefined, { 'x-share-token': other.secret })).status, 200);
  // Presented invalid credentials must never regain the anonymous editor fallback.
  for (const headers of [
    { 'x-share-token': token }, { 'x-bridge-token': token }, { authorization: `Bearer ${token}` },
    { 'x-share-token': 'unknown-key' }, { 'x-share-token': '' },
    { 'x-share-token': other.secret, 'x-bridge-token': token },
    { cookie: `proof_share_token_x1-editor=${token}` },
  ] as Record<string, string>[]) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const suffix = method === 'DELETE' ? `/${other.tokenId}` : '';
      const result = await call(`/api/documents/x1-editor/agent-keys${suffix}`, method,
        method === 'POST' ? { label: 'Must not mint' } : undefined, headers);
      assert.equal(result.status, 401, `Invalid credential must deny ${method}`);
    }
  }
  assert.equal((await call(`/api/documents/x1-editor/agent-keys?token=${token}`)).status, 401);
  for (const role of ['viewer', 'commenter'] as const) {
    const access = db.createDocumentAccessToken('x1-editor', role);
    const headers = { 'x-share-token': access.secret };
    assert.equal((await call('/d/x1-editor?format=json', 'GET', undefined, headers)).body.capabilities.canEdit, false);
    assert.equal((await mint('x1-editor', '192.0.2.2', headers)).status, 403);
    assert.equal((await call('/api/documents/x1-editor/agent-keys', 'GET', undefined, headers)).status, 403);
    assert.equal((await call(`/api/documents/x1-editor/agent-keys/${tokenId}`, 'DELETE', undefined, headers)).status, 403);
  }
  for (const state of ['REVOKED', 'DELETED', 'PAUSED']) {
    const slug = `x1-${state.toLowerCase()}`;
    db.createDocument(slug, 'Unavailable', {});
    db.getDb().prepare('UPDATE documents SET share_state = ? WHERE slug = ?').run(state, slug);
    assert.equal((await mint(slug)).status, 403);
    assert.equal((await call(`/d/${slug}?format=json`)).body.capabilities.canEdit, false);
  }
  assert.equal((await mint('x1-missing')).status, 403);
  // Signed-in request attribution uses the verified local library session identity.
  const { createLibraryMember } = await import('../../server/library/auth');
  const { createHash } = await import('node:crypto');
  const member = createLibraryMember({ name: 'X1 member', email: 'x1@example.test' });
  const cookie = 'local-x1-session';
  db.getDb().prepare(`INSERT INTO library_sessions (session_hash, member_id, created_at, expires_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)`).run(createHash('sha256').update(cookie).digest('hex'), member.id,
    new Date().toISOString(), new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());
  const signedIn = await mint('x1-other', '192.0.2.5', { cookie: `proof_library_session=${cookie}` });
  assert.equal(signedIn.status, 201);
  const requester = db.getDb().prepare('SELECT requested_by FROM document_access WHERE token_id = ?').get(signedIn.body.tokenId) as any;
  assert.equal(requester.requested_by, `library:${member.id}`);
  // Document budget is shared across addresses.
  db.createDocument('x1-document-limit', 'Limit', {});
  for (let i = 0; i < 10; i++) assert.equal((await mint('x1-document-limit', `198.51.100.${i}`)).status, 201);
  const limited = await mint('x1-document-limit', '198.51.100.99');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  // Client budget is shared across documents.
  for (let i = 0; i < 31; i++) {
    const slug = `x1-address-limit-${i}`;
    db.createDocument(slug, 'Limit', {});
    assert.equal((await mint(slug, '203.0.113.1')).status, i < 30 ? 201 : 429);
  }
  // Leading forwarded addresses are attacker-controlled. Proxy identity wins.
  db.createDocument('x1-proxy-attribution', 'Proxy attribution', {});
  const proxyKey = await mint('x1-proxy-attribution', 'spoofed, 198.51.100.200', { 'x-real-ip': '192.0.2.200' });
  assert.equal(proxyKey.status, 201);
  const proxyRow = db.getDb().prepare('SELECT requested_from FROM document_access WHERE token_id = ?')
    .get(proxyKey.body.tokenId) as { requested_from: string };
  assert.equal(proxyRow.requested_from, '192.0.2.200', 'X-Real-IP must take precedence');
  const { getClientIp } = await import('../../server/client-address.js');
  const request = (headers: Record<string, string>) => ({ header: (name: string) => headers[name],
    ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } }) as import('express').Request;
  assert.equal(getClientIp(request({ 'x-forwarded-for': 'spoofed, 198.51.100.200' })), '198.51.100.200');
  assert.equal(getClientIp(request({ 'x-real-ip': ' 192.0.2.200 ', 'x-forwarded-for': 'spoofed' })), '192.0.2.200');
  assert.equal(getClientIp(request({ 'x-forwarded-for': 'spoofed,  ' })), '127.0.0.1');
  for (let i = 0; i < 31; i++) {
    const slug = `x1-proxy-limit-${i}`;
    db.createDocument(slug, 'Limit', {});
    assert.equal((await mint(slug, `forged-${i}, 203.0.113.200`)).status, i < 30 ? 201 : 429);
  }
  // Forwarded addresses are ignored unless the trusted-proxy switch is enabled.
  process.env.PROOF_TRUST_PROXY_HEADERS = 'false';
  assert.equal(getClientIp(request({ 'x-real-ip': 'forged', 'x-forwarded-for': 'also-forged' })), '127.0.0.1');
  for (let i = 0; i < 31; i++) {
    const slug = `x1-untrusted-${i}`;
    db.createDocument(slug, 'Limit', {});
    assert.equal((await mint(slug, `203.0.113.${i + 10}`)).status, i < 30 ? 201 : 429);
  }
  console.log('✓ agent keys: page authorization, attribution, state/ops, immediate revocation, hygiene, independent rate limits and proxy trust');
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.getDb().close();
  rmSync(temp, { recursive: true, force: true });
}
