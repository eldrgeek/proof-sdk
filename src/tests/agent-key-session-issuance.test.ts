import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-key-issuance-'));
process.env.DATABASE_PATH = path.join(temp, 'test.db');
process.env.COLLAB_EMBEDDED_WS = '1';
const db = await import('../../server/db.js');
const collab = await import('../../server/collab.js');
const { apiRoutes } = await import('../../server/routes.js');
const { shareTokenCookieName } = await import('../../server/cookies.js');
const app = express();
app.use(express.json());
app.use('/api', apiRoutes);
app.use(apiRoutes);
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
try {
  await collab.startCollabRuntimeEmbedded(port);
  const slug = 'key-session-issuance';
  db.createDocument(slug, '# Session issuance', {}, undefined, undefined, 'owner-secret');
  const key = db.createDocumentAccessToken(slug, 'editor', undefined,
    { label: 'Key A', requestedBy: 'test', requestedFrom: '127.0.0.1' });
  const valid = db.createDocumentAccessToken(slug, 'editor');
  db.revokeDocumentAgentKey(slug, key.tokenId);
  type Credential = { headers?: Record<string, string>; query?: string };
  const sources = (secret: string): Credential[] => [
    { headers: { 'x-share-token': secret } },
    { headers: { 'x-bridge-token': secret } },
    { headers: { authorization: `Bearer ${secret}` } },
    { query: `?token=${encodeURIComponent(secret)}` },
    { headers: { cookie: `${shareTokenCookieName(slug)}=${encodeURIComponent(secret)}` } },
  ];
  for (const prefix of ['', '/api']) {
    for (const [endpoint, method] of [['collab-session', 'GET'], ['open-context', 'GET'], ['collab-refresh', 'POST']]) {
      const url = `http://127.0.0.1:${port}${prefix}/documents/${slug}/${endpoint}`;
      const request = async (credential: Credential = {}) => {
        const response = await fetch(url + (credential.query ?? ''), { method, headers: credential.headers });
        return { status: response.status, body: await response.json() };
      };
      for (const secret of [key.secret, 'unknown-key', '', 'epsess_invalid']) {
        for (const credential of sources(secret)) {
          const result = await request(credential);
          assert.equal(result.status, 401, `${method} ${prefix}/${endpoint} must reject ${JSON.stringify(credential)}`);
          assert.equal(result.body.session, undefined, 'Invalid credentials must never get a ticket');
        }
      }
      for (const credential of sources(key.secret)) {
        const result = await request({ ...credential, headers: { 'x-share-token': valid.secret, ...credential.headers } });
        assert.equal(result.status, 401, 'A valid credential must not hide a revoked credential');
      }
      for (const query of ['?token=a&token=b']) {
        assert.equal((await request({ query })).status, 401, 'Malformed query credentials must not become anonymous');
      }
      for (const credential of sources(valid.secret)) {
        const result = await request(credential);
        assert.equal(result.status, 200);
        const authenticated = await collab.__unsafeAuthenticateCollabSessionForTests(slug, result.body.session.token);
        assert.equal(authenticated.canWrite, true);
        assert.equal(authenticated.tokenId, valid.tokenId, 'The ticket must retain its issuing key ID');
      }
      const anonymous = await request();
      assert.equal(anonymous.status, 200);
      assert.equal(anonymous.body.capabilities.canEdit, true, 'Tokenless editing is retained until A2');
      assert.equal((await request({ headers: { 'x-share-token': 'owner-secret', 'x-bridge-token': key.secret } })).status, 401);
      console.log(`✓ ${method} ${prefix}/documents/:slug/${endpoint}: all credential sources checked; valid key and anonymous access preserved`);
    }
  }
} finally {
  await collab.stopCollabRuntime();
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.getDb().close();
  rmSync(temp, { recursive: true, force: true });
}
