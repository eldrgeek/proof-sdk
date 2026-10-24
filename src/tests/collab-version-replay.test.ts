import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import express from 'express';
import { COLLAB_VERSION_POLICY, CURRENT_COLLAB_CLIENT } from '../shared/collab-version';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-p0-version-'));
Object.assign(process.env, { DATABASE_PATH: path.join(temp, 'test.db'), COLLAB_EMBEDDED_WS: '1', PROOF_COLLAB_SIGNING_SECRET: 'test-p0-version-secret' });
(globalThis as any).WebSocket = WebSocket;
const db = await import('../../server/db');
const collab = await import('../../server/collab');
const { setupWebSocket } = await import('../../server/ws');
const { apiRoutes } = await import('../../server/routes');
const app = express(); app.use(express.json()); app.use('/api', apiRoutes);
const server = createServer(app); const wss = new WebSocketServer({ server, path: '/ws' }); setupWebSocket(wss);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as any).port; const base = `http://127.0.0.1:${port}`;
const providers: HocuspocusProvider[] = []; const docs: Y.Doc[] = [];
const headers = { 'X-Proof-Client-Version': CURRENT_COLLAB_CLIENT.version, 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': CURRENT_COLLAB_CLIENT.protocol };
async function waitFor(predicate: () => boolean, message: string) {
  const until = Date.now() + 10_000;
  while (!predicate() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(predicate(), message);
}
function provider(token: string, doc = new Y.Doc(), query = true) {
  docs.push(doc);
  const result = new HocuspocusProvider({ url: `ws://127.0.0.1:${port}/ws`, name: 'version-replay', document: doc, token,
    parameters: query ? { token, role: 'editor' } : { role: 'editor' }, preserveConnection: false, broadcast: false });
  providers.push(result); return result;
}
function sign(claims: any) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${createHmac('sha256', process.env.PROOF_COLLAB_SIGNING_SECRET!).update(payload).digest('base64url')}`;
}
try {
  await collab.startCollabRuntimeEmbedded(port);
  const slug = 'version-replay';
  const pending = { kind: 'replace', status: 'pending', by: 'ai:test', quote: 'Original', content: 'Changed' };
  db.createDocument(slug, 'Original\n', { suggestion: pending });
  for (const [route, method] of [['collab-session', 'GET'], ['collab-refresh', 'POST'], ['open-context', 'GET']]) {
    for (const client of [{}, { ...headers, 'X-Proof-Client-Version': '0.32.0' }, { ...headers, 'X-Proof-Client-Build': '' }, { ...headers, 'X-Proof-Client-Protocol': '2' }]) {
      const response = await fetch(`${base}/api/documents/${slug}/${route}`, { method, headers: client });
      assert.equal(response.status, 426); const body = await response.json();
      assert.equal(body.code, 'CLIENT_UPGRADE_REQUIRED'); assert.equal(body.session, undefined);
    }
  }
  assert.equal(collab.buildCollabSession(slug, 'editor'), null, 'No unversioned sessions may be issued');
  const response = await fetch(`${base}/api/documents/${slug}/collab-session`, { headers });
  assert.equal(response.status, 200); const { session } = await response.json();
  const claims = JSON.parse(Buffer.from(session.token.split('.')[0], 'base64url').toString());
  assert.deepEqual(claims.client, { ...CURRENT_COLLAB_CLIENT, build: 'test' });
  const legacy = { ...claims }; delete legacy.client;
  for (const query of [true, false]) {
    const old = provider(sign(legacy), undefined, query); let refused = false;
    old.on('close', ({ event }: any) => { if (event.code === 4401) refused = true; });
    old.on('authenticationFailed', ({ reason }: any) => { assert.equal(reason, COLLAB_VERSION_POLICY.reloadReason); refused = true; });
    await waitFor(() => refused, 'Old signed token must be refused on both query and auth-message paths');
    assert.equal(old.configuration.websocketProvider.shouldConnect, false, '0913728 provider stops socket retries');
    assert.equal(old.synced, false);
  }
  console.log('✓ HTTP 426, signed client versions, old query/auth tokens refused with terminal provider behavior');

  const current = provider(session.token); await waitFor(() => current.synced, 'Current version syncs');
  const room = (collab.__unsafeGetHocuspocusInstanceForTests() as any).documents.get(slug) as Y.Doc;
  const baseline = Y.encodeStateAsUpdate(room);
  // A real old-page deletion and text update, encoded exactly as the durable queue.
  const oldPage = new Y.Doc(); Y.applyUpdate(oldPage, baseline);
  const vector = Y.encodeStateVector(oldPage);
  oldPage.transact(() => {
    oldPage.getMap('marks').delete('suggestion');
    const paragraph = oldPage.getXmlFragment('prosemirror').get(0) as Y.XmlElement;
    (paragraph.get(0) as Y.XmlText).insert(0, 'Typed before deploy ');
  });
  const update = Y.encodeStateAsUpdate(oldPage, vector);
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) };
  (globalThis as any).sessionStorage = storage;
  storage.setItem('proof:collab:durable-client-id', 'same-tab');
  (globalThis as any).window = { localStorage: storage, location: new URL(`${base}/d/${slug}`), __PROOF_CONFIG__: {}, btoa, atob };
  (globalThis as any).document = { createElement: () => ({}), head: { appendChild() {} } };
  const { CollabClient, encodeBase64 } = await import('../bridge/collab-client');
  const key = `proof:collab:pending-updates:${slug}:same-tab`;
  storage.setItem(key, JSON.stringify({ updates: [encodeBase64(update)], since: Date.now() }));
  const nextPage = new CollabClient();
  // Use production queue loading/replay; the network provider then transmits it
  // under a current signed session, just as connect() does in the browser.
  Object.assign(nextPage, { durableUpdatesEnabled: true });
  (nextPage as any).loadDurableBuffer(slug);
  const replayDoc = new Y.Doc(); Y.applyUpdate(replayDoc, baseline);
  (nextPage as any).replayDurableUpdates(replayDoc);
  assert.equal(replayDoc.getMap('marks').has('suggestion'), false);
  assert.ok(replayDoc.getXmlFragment('prosemirror').toString().includes('Typed before deploy Original'));
  nextPage.requireReload();
  assert.ok(storage.getItem(key), 'Reload refusal preserves the durable queue');
  const replay = provider(session.token, replayDoc);
  await waitFor(() => replay.synced && replayDoc.getMap('marks').has('suggestion'), 'Queued deletion restored over current connection');
  assert.deepEqual(room.getMap('marks').get('suggestion'), pending);
  assert.ok(room.getXmlFragment('prosemirror').toString().includes('Typed before deploy Original'), 'Replay preserves actual editor text');
  assert.equal(db.listDocumentEvents(slug, 0).filter(e => e.event_type === 'suggestion.deletion_restored').length, 1);
  await collab.__unsafePersistDocAwaitForTests(slug, room, 'collab');
  assert.ok(db.getDocumentBySlug(slug)!.markdown.includes('Typed before deploy Original'), 'Replayed text is persisted');
  room.transact(() => {
    room.getMap('marks').set('expired', { ...pending, status: 'accepted', resolvedAt: new Date(Date.now() - 86_400_001).toISOString() });
    room.getMap('marks').set('undoable', { ...pending, status: 'rejected', resolvedAt: new Date().toISOString() });
  }, 'server-prune-fixture');
  await waitFor(() => current.document.getMap('marks').has('expired'), 'Peer receives the record before pruning');
  await collab.__unsafePersistDocAwaitForTests(slug, room, 'collab');
  assert.equal(room.getMap('marks').has('expired'), false);
  const persistedMarks = JSON.parse(db.getDocumentBySlug(slug)!.marks);
  assert.equal(persistedMarks.expired, undefined, 'Persist-time prune is written to the row');
  assert.equal(persistedMarks.undoable.status, 'rejected');
  assert.equal(JSON.parse(db.getDocumentProjectionBySlug(slug)!.marks_json).expired, undefined, 'Projection is pruned too');
  await waitFor(() => !current.document.getMap('marks').has('expired'), 'Prune propagates to other clients');
  oldPage.destroy();
  console.log('✓ Same-tab durable replay restores old deletion through a fixed connection and retains typed text');

  let closed = false; replay.on('close', ({ event }: any) => { if (event.reason === COLLAB_VERSION_POLICY.reloadReason) closed = true; });
  for (let i = 0; i < 2; i++) {
    replayDoc.getMap('marks').delete('suggestion');
    await waitFor(() => replayDoc.getMap('marks').has('suggestion'), 'Each repeated deletion restored');
  }
  await waitFor(() => closed, 'Third restore closes the real Hocuspocus connection');
  assert.equal(replay.configuration.websocketProvider.shouldConnect, false);
  assert.equal(db.listDocumentEvents(slug, 0).filter(e => e.event_type === 'collab.reload_required').length, 1);
  console.log('✓ Real Hocuspocus connection closes after its third restore without retry');
} finally {
  for (const p of providers) { p.destroy(); p.configuration.websocketProvider.destroy(); }
  for (const doc of docs) doc.destroy();
  for (const socket of wss.clients) socket.terminate();
  await collab.stopCollabRuntime();
  await new Promise<void>(resolve => wss.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.getDb().close(); rmSync(temp, { recursive: true, force: true });
}
