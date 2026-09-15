import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-key-cookies-'));
process.env.DATABASE_PATH = path.join(temp, 'test.db');
process.env.SNAPSHOT_DIR = path.join(temp, 'snapshots');
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
  const slug = 'key-duplicate-cookies';
  db.createDocument(slug, '# Duplicate cookies', {});
  const valid = db.createDocumentAccessToken(slug, 'editor');
  const revoked = db.createDocumentAccessToken(slug, 'editor', undefined,
    { label: 'Revoked key', requestedBy: 'test', requestedFrom: '127.0.0.1' });
  assert.ok(db.revokeDocumentAgentKey(slug, revoked.tokenId), 'The second key must actually be revoked');
  const cookie = (secret: string) => `${shareTokenCookieName(slug)}=${encodeURIComponent(secret)}`;
  const failures: string[] = [];
  for (const prefix of ['', '/api']) {
    for (const [endpoint, method] of [['collab-session', 'GET'], ['open-context', 'GET'], ['collab-refresh', 'POST']]) {
      const label = `${method} ${prefix}/documents/:slug/${endpoint}`;
      const request = async (second: string) => {
        const response = await fetch(`http://127.0.0.1:${port}${prefix}/documents/${slug}/${endpoint}`, {
          method, headers: { cookie: `${cookie(valid.secret)}; ${cookie(second)}` },
        });
        return { status: response.status, body: await response.json() };
      };
      for (const [kind, secret] of [['revoked', revoked.secret], ['empty', ''], ['unknown', 'unknown-key']]) {
        const result = await request(secret);
        // Report only status and ticket presence, never credentials or response bodies.
        const passed = result.status === 401 && result.body.session === undefined;
        console.log(`${passed ? 'PASS' : 'FAIL'} ${label}: valid then ${kind}; status=${result.status}, session=${result.body.session !== undefined}`);
        if (!passed) failures.push(`${label}: valid then ${kind} must return 401 without a session`);
      }
      const accepted = await request(valid.secret);
      assert.equal(accepted.status, 200, `${label}: valid duplicates remain accepted`);
      const authenticated = await collab.__unsafeAuthenticateCollabSessionForTests(slug, accepted.body.session.token);
      assert.equal(authenticated.canWrite, true);
      assert.ok(authenticated.tokenId === valid.tokenId, 'The ticket retains its issuing key ID');
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
} finally {
  await collab.stopCollabRuntime();
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.getDb().close();
  rmSync(temp, { recursive: true, force: true });
}
