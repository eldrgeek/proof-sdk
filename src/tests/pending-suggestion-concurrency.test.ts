import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { Connection, Document, IncomingMessage, MessageReceiver, Debugger } from '@hocuspocus/server';
import { createEncoder, writeVarUint, writeVarUint8Array, toUint8Array } from 'lib0/encoding';
import { COLLAB_VERSION_POLICY } from '../shared/collab-version';
import { SUGGESTION_STATUS_POLICY, suggestionWithStatus } from '../shared/suggestion-status';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-p0-concurrency-'));
Object.assign(process.env, { DATABASE_PATH: path.join(temp, 'test.db'), PROOF_ENV: 'test', PROOF_DB_ENV_INIT: 'test' });
const db = await import('../../server/db');
const { observeClientMarks, recordSuggestionRestore, pruneResolvedSuggestions } = await import('../../server/collab-marks-guard');
const pending = { kind: 'replace' as const, status: 'pending' as const, by: 'ai:test', quote: 'Original', content: 'Changed' };
const logger = new Debugger();
function receive(doc: Document, connection: Connection, update: Uint8Array) {
  const encoder = createEncoder(); writeVarUint(encoder, 0); writeVarUint(encoder, 2); writeVarUint8Array(encoder, update);
  new MessageReceiver(new IncomingMessage(toUint8Array(encoder)), logger).apply(doc, connection);
}
try {
  for (const observerOrder of ['before', 'during', 'after'] as const) {
    const slug = `concurrent-${observerOrder}`;
    db.createDocument(slug, 'Original', { suggestion: pending });
    const doc = new Document(slug, logger); const marks = doc.getMap('marks'); marks.set('suggestion', pending);
    const client = new Y.Doc(); Y.applyUpdate(client, Y.encodeStateAsUpdate(doc));
    const accepted = suggestionWithStatus(pending, 'accepted', 'human:reviewer');
    const newerWrite = () => { if (!marks.has('suggestion') || (marks.get('suggestion') as any).status === 'pending') marks.set('suggestion', accepted); };
    if (observerOrder === 'before') marks.observe(newerWrite);
    observeClientMarks(slug, doc);
    if (observerOrder === 'after') marks.observe(newerWrite);
    if (observerOrder === 'during') doc.on('beforeTransaction', (tr: Y.Transaction) => {
      if (tr.origin === SUGGESTION_STATUS_POLICY.restoreOrigin) newerWrite();
    });
    const connection = Object.assign(Object.create(Connection.prototype), { readOnly: false, send() {}, document: doc });
    const vector = Y.encodeStateVector(client); client.getMap('marks').delete('suggestion');
    receive(doc, connection, Y.encodeStateAsUpdate(client, vector));
    assert.deepEqual(marks.get('suggestion'), accepted, `Newer decision survives ${observerOrder} restore`);
    if (observerOrder !== 'after') assert.equal(db.listDocumentEvents(slug, 0).filter(e => e.event_type === 'suggestion.deletion_restored').length, 0, 'A skipped restore has no event');
    doc.destroy(); client.destroy();
  }
  console.log('✓ Synchronous Hocuspocus restore respects writes before, during and after the observer');

  const slug = 'restore-limit'; db.createDocument(slug, 'Original', { suggestion: pending });
  const doc = new Document(slug, logger); const marks = doc.getMap('marks'); marks.set('suggestion', pending);
  observeClientMarks(slug, doc);
  const client = new Y.Doc(); let closed: unknown; let delivered = false;
  const connection = Object.assign(Object.create(Connection.prototype), {
    readOnly: false, send() {}, document: doc,
    close(event: unknown) { assert.ok(delivered, 'Restore update broadcasts before close'); closed = event; },
  });
  doc.on('update', () => { delivered = marks.has('suggestion'); });
  for (let i = 1; i <= 3; i++) {
    Y.applyUpdate(client, Y.encodeStateAsUpdate(doc)); const vector = Y.encodeStateVector(client);
    client.getMap('marks').delete('suggestion'); receive(doc, connection, Y.encodeStateAsUpdate(client, vector));
    assert.deepEqual(marks.get('suggestion'), pending);
    assert.equal(connection.readOnly, i === 3);
    await Promise.resolve();
    assert.equal(Boolean(closed), i === 3);
  }
  assert.deepEqual(closed, { code: COLLAB_VERSION_POLICY.reloadCode, reason: COLLAB_VERSION_POLICY.reloadReason });
  assert.equal(db.listDocumentEvents(slug, 0).filter(e => e.event_type === 'suggestion.deletion_restored').length, 3);
  assert.equal(db.listDocumentEvents(slug, 0).filter(e => e.event_type === 'collab.reload_required').length, 1);
  let expiredClosed = false;
  const separate = Object.assign(Object.create(Connection.prototype), { readOnly: false, close() { expiredClosed = true; } });
  recordSuggestionRestore(slug, separate, 0); recordSuggestionRestore(slug, separate, 1);
  recordSuggestionRestore(slug, separate, SUGGESTION_STATUS_POLICY.restoreWindowMs + 1);
  await Promise.resolve(); assert.equal(expiredClosed, false, 'Expired restores and other connections do not count');
  doc.destroy(); client.destroy();
  console.log('✓ Three restores within five minutes stop the connection after broadcast and log once');

  const pruning = new Y.Doc(); const map = pruning.getMap('marks'); const now = Date.now();
  for (const status of ['accepted', 'rejected'] as const) {
    map.set(`${status}-old`, suggestionWithStatus(pending, status, 'human:test', new Date(now - 86_400_001).toISOString()));
    map.set(`${status}-window`, suggestionWithStatus(pending, status, 'human:test', new Date(now - 86_400_000).toISOString()));
    map.set(`${status}-unknown`, { ...pending, status });
    map.set(`${status}-future`, suggestionWithStatus(pending, status, 'human:test', new Date(now + 1).toISOString()));
  }
  map.set('pending', { ...pending, resolvedAt: new Date(0).toISOString() });
  let origin: unknown; pruning.on('update', (_: unknown, value: unknown) => { origin = value; });
  pruneResolvedSuggestions(pruning, now);
  assert.equal(origin, SUGGESTION_STATUS_POLICY.pruneOrigin);
  assert.equal(map.size, 7);
  assert.ok(!map.has('accepted-old') && !map.has('rejected-old'));
  assert.ok(map.has('pending') && map.has('accepted-window') && map.has('rejected-window'));
  pruning.destroy();
  console.log('✓ Pruning preserves the full Undo window, pending marks and unknown dates');
} finally { db.getDb().close(); rmSync(temp, { recursive: true, force: true }); }
