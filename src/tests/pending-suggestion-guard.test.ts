import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { Connection, Document, IncomingMessage, MessageReceiver, Debugger } from '@hocuspocus/server';
import { createDecoder, readVarString, readVarUint, readVarUint8Array } from 'lib0/decoding';
import { createEncoder, writeVarUint, writeVarUint8Array, toUint8Array } from 'lib0/encoding';
import { SUGGESTION_STATUS_POLICY, suggestionWithStatus } from '../shared/suggestion-status';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-p0-guard-'));
Object.assign(process.env, { DATABASE_PATH: path.join(temp, 'test.db'), PROOF_ENV: 'test', PROOF_DB_ENV_INIT: 'test' });
const db = await import('../../server/db');
const { observeClientMarks, isClientMarksTransaction } = await import('../../server/collab-marks-guard');
const collab = await import('../../server/collab');
const logger = new Debugger();
const pending = { kind: 'replace' as const, status: 'pending' as const, by: 'ai:test', quote: 'Original', content: 'Changed' };

try {
  for (const messageType of [1, 2]) { // Actual Hocuspocus SyncStep2 and Update decoding paths.
    const slug = `guard-${messageType}`;
    const legacyInsert = { kind: 'insert', by: 'ai:legacy', quote: 'Original', content: 'Additional' };
    db.createDocument(slug, 'Original\n', { suggestion: pending, legacyInsert }, 'Guard', 'owner', 'owner-secret');
    db.getDb().exec(`CREATE TEMP TRIGGER pending_guard BEFORE UPDATE OF marks ON documents
      WHEN NEW.slug = '${slug}' AND (json_extract(NEW.marks, '$.suggestion.status') IS NOT 'pending' OR json_extract(NEW.marks, '$.legacyInsert.kind') IS NOT 'insert')
      BEGIN SELECT RAISE(ABORT, 'a revision lost the pending suggestion'); END`);
    const doc = new Document(slug, logger);
    const marks = doc.getMap<any>('marks');
    marks.set('suggestion', pending);
    marks.set('legacyInsert', legacyInsert);
    doc.getText('markdown').insert(0, 'Original\n');
    const p = new Y.XmlElement('paragraph'); const t = new Y.XmlText(); t.insert(0, 'Original'); p.insert(0, [t]); doc.getXmlFragment('prosemirror').insert(0, [p]);
    collab.__unsafePrimeLoadedDocForTests(slug, doc);
    observeClientMarks(slug, doc);
    observeClientMarks(slug, doc); // idempotent attachment
    const client = new Y.Doc(); const peer = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(doc)); Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    // Exercise Hocuspocus's own broadcast path, decoding the outgoing wire message
    // at a second connection rather than copying the server's in-memory map.
    const peerConnection = Object.assign(Object.create(Connection.prototype), {
      webSocket: {},
      send(message: Uint8Array) {
        const decoder = createDecoder(message);
        assert.equal(readVarString(decoder), slug);
        assert.equal(readVarUint(decoder), 0);
        assert.equal(readVarUint(decoder), 2);
        Y.applyUpdate(peer, readVarUint8Array(decoder));
      },
    });
    doc.addConnection(peerConnection);
    const connection = Object.assign(Object.create(Connection.prototype), { readOnly: false, send() {}, document: doc });
    const seen: Array<{ local: boolean; origin: unknown; client: boolean }> = [];
    const persisted: Promise<void>[] = [];
    let checkPending = true;
    doc.on('afterTransaction', (tr: Y.Transaction) => {
      seen.push({ local: tr.local, origin: tr.origin, client: isClientMarksTransaction(tr) });
      if (checkPending) {
        assert.deepEqual(marks.get('suggestion'), pending, 'Restored before any persistence listener');
        assert.deepEqual(marks.get('legacyInsert'), legacyInsert, 'Every deletion restored before persistence');
      }
    });
    doc.on('update', () => {
      if (checkPending) persisted.push(collab.__unsafePersistDocAwaitForTests(slug, doc, 'collab'));
    });
    const send = (action: () => void) => {
      Y.applyUpdate(client, Y.encodeStateAsUpdate(doc));
      const before = Y.encodeStateVector(client);
      action();
      const encoder = createEncoder(); writeVarUint(encoder, 0); writeVarUint(encoder, messageType);
      writeVarUint8Array(encoder, Y.encodeStateAsUpdate(client, before));
      new MessageReceiver(new IncomingMessage(toUint8Array(encoder)), logger).apply(doc, connection);
    };
    send(() => { client.getMap('marks').delete('suggestion'); client.getMap('marks').delete('legacyInsert'); });
    assert.ok(seen.some(tr => !tr.local && tr.origin === connection && tr.client));
    assert.ok(seen.some(tr => tr.local && tr.origin === SUGGESTION_STATUS_POLICY.restoreOrigin && !tr.client));
    assert.deepEqual(peer.getMap('marks').get('suggestion'), pending, 'Other connected replicas receive restore');
    assert.deepEqual(peer.getMap('marks').get('legacyInsert'), legacyInsert, 'Missing status is pending too');
    await Promise.all(persisted);
    assert.deepEqual(JSON.parse(db.getDocumentBySlug(slug)!.marks).suggestion, pending);
    assert.deepEqual(JSON.parse(db.getDocumentProjectionBySlug(slug)!.marks_json).suggestion, pending);
    const events = () => db.listDocumentEvents(slug, 0);
    assert.equal(events().length, 2);
    assert.equal(events()[0].event_type, 'suggestion.deletion_restored');
    assert.deepEqual(JSON.parse(events()[0].event_data), { markId: 'suggestion', kind: 'replace', by: 'ai:test' });
    db.getDb().exec('DROP TRIGGER pending_guard');
    checkPending = false;
    send(() => client.getMap('marks').set('suggestion', suggestionWithStatus(pending, 'accepted', 'human:reviewer')));
    assert.equal(marks.get('suggestion').status, 'accepted');
    send(() => client.getMap('marks').set('suggestion', pending));
    send(() => client.getMap('marks').set('suggestion', suggestionWithStatus(pending, 'rejected', 'human:reviewer')));
    send(() => client.getMap('marks').delete('suggestion'));
    assert.equal(marks.has('suggestion'), false);
    assert.deepEqual(events().map(e => e.event_type), ['suggestion.deletion_restored', 'suggestion.deletion_restored', 'suggestion.accepted', 'suggestion.reopened', 'suggestion.rejected']);
    doc.transact(() => marks.set('suggestion', pending), 'agent-api');
    doc.transact(() => marks.delete('suggestion'), 'document-engine');
    assert.equal(marks.has('suggestion'), false);
    assert.equal(events().length, 5, 'Server/REST decisions are not double recorded');
    doc.transact(() => marks.set('suggestion', pending), 'repair');
    Y.applyUpdate(client, Y.encodeStateAsUpdate(doc)); const before = Y.encodeStateVector(client);
    client.getMap('marks').delete('suggestion');
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(client, before), 'server-replay');
    assert.equal(marks.has('suggestion'), false, 'Remote Yjs transaction alone does not imply a client');
    doc.removeConnection(peerConnection);
    doc.destroy(); client.destroy(); peer.destroy();
  }
  console.log('✓ Hocuspocus client origin, immediate restore, persisted projection, replica delivery and decision events');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
