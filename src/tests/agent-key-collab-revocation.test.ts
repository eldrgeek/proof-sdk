import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import express from 'express';
import type { CollabSessionInfo } from '../../server/collab.js';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-key-collab-'));
process.env.DATABASE_PATH = path.join(temp, 'test.db');
process.env.COLLAB_EMBEDDED_WS = '1';
(globalThis as any).WebSocket = WebSocket;
const db = await import('../../server/db.js');
const collab = await import('../../server/collab.js');
const { setupWebSocket } = await import('../../server/ws.js');
const { apiRoutes } = await import('../../server/routes.js');
const app = express();
app.use('/api', apiRoutes);
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
setupWebSocket(wss);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
const providers: HocuspocusProvider[] = [];
const docs: Y.Doc[] = [];
async function waitFor(predicate: () => boolean, message: string) {
  const until = Date.now() + 5000;
  while (!predicate() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(predicate(), message);
}
try {
  await collab.startCollabRuntimeEmbedded(port);
  const slug = 'key-collab-revocation';
  db.createDocument(slug, '# Key revocation\n\nOriginal content.', {});
  const key = db.createDocumentAccessToken(slug, 'editor', undefined,
    { label: 'Revoked agent', requestedBy: 'test', requestedFrom: '127.0.0.1' });
  const other = db.createDocumentAccessToken(slug, 'editor');
  async function openSession(secret: string): Promise<CollabSessionInfo> {
    const response = await fetch(`http://127.0.0.1:${port}/api/documents/${slug}/collab-session`, {
      headers: { 'x-share-token': secret },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { success: boolean; session: CollabSessionInfo };
    assert.equal(body.success, true);
    return body.session;
  }
  const session = await openSession(key.secret);
  const otherSession = await openSession(other.secret);
  assert.equal((await collab.__unsafeAuthenticateCollabSessionForTests(slug, session.token)).canWrite, true);
  for (const ticket of [session, otherSession]) {
    const document = new Y.Doc();
    docs.push(document);
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${port}/ws`, name: slug, document,
      token: ticket.token, parameters: { token: ticket.token, role: ticket.role },
      preserveConnection: false, broadcast: false,
    });
    providers.push(provider);
    await waitFor(() => provider.synced, 'Client must sync before revocation');
  }
  docs[0].getMap('revocation-test').set('allowed', 'before');
  await waitFor(() => docs[1].getMap('revocation-test').get('allowed') === 'before', 'Key can write before revocation');
  const epoch = db.getDocumentBySlug(slug)!.access_epoch;
  let closed = false;
  providers[0].on('close', () => { closed = true; });
  db.revokeDocumentAgentKey(slug, key.tokenId);
  docs[0].getMap('revocation-test').set('forbidden', 'after');
  await waitFor(() => closed, 'Revocation must close the existing connection');
  assert.equal(docs[1].getMap('revocation-test').has('forbidden'), false, 'Revoked writes must never reach the live document');
  await assert.rejects(collab.__unsafeAuthenticateCollabSessionForTests(slug, session.token), /revoked/);
  assert.equal(db.getDocumentBySlug(slug)!.access_epoch, epoch, 'Other clients must not be forced to reconnect');
  assert.equal((await collab.__unsafeAuthenticateCollabSessionForTests(slug, otherSession.token)).canWrite, true);
  const live = (collab.__unsafeGetHocuspocusInstanceForTests() as any).documents.get(slug) as Y.Doc;
  docs[1].getMap('revocation-test').set('survivor', 'still writes');
  await waitFor(() => live.getMap('revocation-test').has('survivor'), 'Unrelated connection must still write');
  assert.equal(live.getMap('revocation-test').has('forbidden'), false);
  // Simulate revocation by another server process: no process-local notification.
  let remoteClosed = false;
  providers[1].on('close', () => { remoteClosed = true; });
  db.getDb().prepare('UPDATE document_access SET revoked_at = ? WHERE token_id = ?')
    .run(new Date().toISOString(), other.tokenId);
  docs[1].getMap('revocation-test').set('remote-forbidden', 'after');
  await waitFor(() => remoteClosed, 'Message guard must reject a key revoked by another process');
  assert.equal(live.getMap('revocation-test').has('remote-forbidden'), false);
  console.log('✓ revoked key loses its open connection and ticket; unrelated key keeps writing');
} finally {
  for (const provider of providers) { provider.destroy(); provider.configuration.websocketProvider.destroy(); }
  for (const doc of docs) doc.destroy();
  for (const client of wss.clients) client.terminate();
  await collab.stopCollabRuntime();
  await new Promise<void>(resolve => wss.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.getDb().close();
  rmSync(temp, { recursive: true, force: true });
}
