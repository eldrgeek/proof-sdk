/**
 * Caret stability (Mike, 2026-09-19: typing "moved the view away from where I was typing" and
 * landed as scattered fragments). Unit and integration checks for the three causes found with
 * scripts/caret-stability-check.mjs:
 *  1. server: an agent's marks-only write replaced the whole live Yjs fragment, so every client's
 *     caret (a Yjs relative position) lost its paragraph and fell to the end of the document;
 *  2. client: the review history's outer Yjs transaction made y-prosemirror re-apply each of the
 *     person's own keystrokes as a whole-document remote replace;
 *  3. client: y-prosemirror scrolled the caret into view on every remote change.
 *
 * And for its client-side cousin (2026-09-23, worker accord-yjs): a Yjs transaction that ends
 * outside the mutex — because it was created during another transaction's cleanup — made the
 * binding re-render the whole document from its OWN write. See src/editor/local-write-resync.ts.
 *
 * Authorship: Claude Opus 5 (worker proof-caret), 2026-09-19.
 */
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { ProsemirrorBinding, ySyncPluginKey } from 'y-prosemirror';

const CLIENT_HEADERS = { 'X-Proof-Client-Version': '0.34.0', 'X-Proof-Client-Build': 'tests', 'X-Proof-Client-Protocol': '3' };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function mustJson<T>(response: Response, label: string): Promise<T> {
  const text = await response.text().catch(() => '');
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

/** 1. A marks-only agent write keeps the live fragment's Yjs nodes, so carets elsewhere survive. */
async function serverKeepsRelativePositions(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `proof-caret-stability-${Date.now()}-${randomUUID()}.db`);
  const previous = { db: process.env.DATABASE_PATH, ws: process.env.COLLAB_EMBEDDED_WS, debounce: process.env.COLLAB_PERSIST_DEBOUNCE_MS };
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';
  process.env.COLLAB_PERSIST_DEBOUNCE_MS = '60000';
  const [{ apiRoutes }, { agentRoutes }, { setupWebSocket }, collab, canonical] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/agent-routes.js'),
    import('../../server/ws.js'),
    import('../../server/collab.js'),
    import('../../server/canonical-document.js'),
  ]);
  assert(canonical.CANONICAL_FRAGMENT_POLICY.incrementalByDefault === true, 'canonical writes must be incremental by default');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRoutes);
  app.use('/api/agent', agentRoutes);
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const httpBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await collab.startCollabRuntimeEmbedded((server.address() as AddressInfo).port);
  let provider: HocuspocusProvider | null = null;
  const doc = new Y.Doc();
  try {
    const markdown = ['# Caret', 'First paragraph gets the agent comment.', 'Second paragraph holds the caret here.', 'Third paragraph.'].join('\n\n');
    const created = await mustJson<{ slug: string; ownerSecret: string }>(await fetch(`${httpBase}/api/documents`, {
      method: 'POST', headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'caret', markdown, marks: {} }),
    }), 'create');
    const session = await mustJson<{ session: { collabWsUrl: string; slug: string; token: string; role: string } }>(
      await fetch(`${httpBase}/api/documents/${created.slug}/collab-session`, { headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret } }),
      'collab session');
    let synced = false;
    provider = new HocuspocusProvider({
      url: session.session.collabWsUrl.replace(/\?slug=.*$/, '').replace('ws://localhost:', 'ws://127.0.0.1:'),
      name: session.session.slug, document: doc,
      parameters: { token: session.session.token, role: session.session.role }, token: session.session.token,
      preserveConnection: false, broadcast: false,
    });
    provider.on('synced', (event: { state?: boolean }) => { if (event.state !== false) synced = true; });
    await waitFor(() => synced && doc.getXmlFragment('prosemirror').length >= 4, 10_000, 'client synced');

    // The caret: 7 characters into the second paragraph, as a Yjs relative position.
    const fragment = doc.getXmlFragment('prosemirror');
    const paragraph = fragment.get(2) as Y.XmlElement;
    const text = paragraph.get(0) as Y.XmlText;
    assert(text.toString().startsWith('Second'), `unexpected paragraph: ${text.toString()}`);
    const caret = Y.createRelativePositionFromTypeIndex(text, 7);

    const response = await fetch(`${httpBase}/api/agent/${created.slug}/marks/comment`, {
      method: 'POST', headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json', 'x-share-token': created.ownerSecret },
      body: JSON.stringify({ quote: 'agent comment', text: 'Is this right?', by: 'ai:test' }),
    });
    const body = await mustJson<{ markId: string }>(response, 'comment');
    await waitFor(() => doc.getMap('marks').has(body.markId), 10_000, 'comment reaches the client');

    const resolved = Y.createAbsolutePositionFromRelativePosition(caret, doc);
    assert(resolved !== null, 'the caret no longer resolves');
    assert(resolved.type === text, 'the caret moved to another Yjs node');
    assert(!paragraph._item?.deleted && !text._item?.deleted, 'the agent comment deleted the paragraph holding the caret');
    assert(resolved.index === 7, `the caret moved within its paragraph: ${resolved.index}`);
    console.log('✓ an agent comment keeps the Yjs nodes (and carets) of other paragraphs');
  } finally {
    provider?.destroy();
    doc.destroy();
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await collab.stopCollabRuntime();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous.db === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous.db;
    if (previous.ws === undefined) delete process.env.COLLAB_EMBEDDED_WS; else process.env.COLLAB_EMBEDDED_WS = previous.ws;
    if (previous.debounce === undefined) delete process.env.COLLAB_PERSIST_DEBOUNCE_MS; else process.env.COLLAB_PERSIST_DEBOUNCE_MS = previous.debounce;
    for (const suffix of ['', '-wal', '-shm']) { try { unlinkSync(`${dbPath}${suffix}`); } catch { /* best effort */ } }
  }
}

/** 2. An edit grouped by the review history is not re-applied as a remote whole-document replace. */
async function historyEditHasNoEcho(): Promise<void> {
  const { pair } = await import('./review-history-fixture');
  const peers = await pair();
  try {
    const { alice } = peers;
    const view = alice.view;
    const dispatch = view.dispatch.bind(view);
    let echoes = 0;
    view.dispatch = (tr: any) => {
      if (tr.getMeta(ySyncPluginKey)?.isChangeOrigin && tr.docChanged) echoes += 1;
      dispatch(tr);
    };
    for (const ch of 'abc') alice.edit(() => view.dispatch(view.state.tr.insertText(ch, 3)));
    assert(view.state.doc.child(0).textContent.startsWith('Orcbaiginal'), `typed text: ${view.state.doc.child(0).textContent}`);
    assert(echoes === 0, `${echoes} of 3 keystrokes came back as whole-document remote replaces`);
    console.log('✓ review-history edits are not echoed back as remote changes');
  } finally {
    peers.close();
  }
}

/** 3. Remote changes never scroll the local caret into view. */
async function remoteChangesDoNotScroll(): Promise<void> {
  const { installRemoteChangeScrollPolicy, REMOTE_CHANGE_POLICY } = await import('../editor/remote-change-scroll');
  installRemoteChangeScrollPolicy();
  installRemoteChangeScrollPolicy(); // idempotent
  assert(REMOTE_CHANGE_POLICY.scrollToCaret === false, 'policy default');
  const proto = (ProsemirrorBinding as any).prototype;
  const fake = { prosemirrorView: { hasFocus: () => true }, _domSelectionInView: true };
  assert(proto._isLocalCursorInView.call(fake) === false, 'a remote change may not scroll to the caret');
  console.log('✓ remote changes do not scroll the caret into view');
}

/**
 * 4. The binding never re-renders the document from a Yjs transaction carrying its own write.
 *
 * The bug it guards (src/editor/local-write-resync.ts): a local write dispatches a ProseMirror
 * transaction; a plugin view writes the marks map in its own Yjs transaction; Yjs hands that
 * transaction's cleanup to the loop already running, so the binding's fragment transaction is
 * cleaned up after y-prosemirror's mutex has been released; the binding reads its own write as a
 * remote change and replaces the whole document, re-entrantly, from positions that have moved.
 */
async function ownWriteIsNotResynced(): Promise<void> {
  const { installLocalWriteResyncPolicy, LOCAL_WRITE_POLICY, localWriteResyncStats } =
    await import('../editor/local-write-resync');
  assert(LOCAL_WRITE_POLICY.resyncOnOwnWrite === false, 'the binding may not re-render its own write');
  assert(LOCAL_WRITE_POLICY.requireAgreement === true, 'the refusal must also prove the render would change nothing');
  installLocalWriteResyncPolicy();
  installLocalWriteResyncPolicy(); // idempotent

  const { pair } = await import('./review-history-fixture');
  const peers = await pair();
  try {
    const { alice, bob } = peers;
    const view = alice.view;
    const before = { refused: localWriteResyncStats.refused, rendered: localWriteResyncStats.rendered };

    // A local write whose Yjs transaction is cleaned up OUTSIDE y-prosemirror's mutex, which is
    // what a plugin view writing the marks map inside the same dispatch produces. Writing the
    // marks map from a marks observer reproduces that nesting: the fragment transaction is
    // created while this one is being cleaned up.
    const marks = alice.doc.getMap<any>('marks');
    let nested = 0;
    const nest = () => {
      if (nested > 0) return;
      nested += 1;
      // The dispatch happens inside the marks transaction's cleanup, so the fragment write it
      // causes joins a cleanup loop already running.
      view.dispatch(view.state.tr.insertText('!', 3));
    };
    marks.observe(nest);
    alice.doc.transact(() => marks.set('probe', { kind: 'comment', text: 'other client' }), 'local-marks-sync');
    marks.unobserve(nest);

    const text = view.state.doc.child(0).textContent;
    assert(text === 'Or!iginal', `the local write landed as "${text}", not "Or!iginal"`);
    // Yjs and ProseMirror say the same thing, and Bob sees it too.
    const yText = alice.doc.getXmlFragment('prosemirror').get(0).toString().replace(/<[^>]+>/g, '');
    assert(yText === text, `Yjs holds "${yText}" and the document holds "${text}"`);
    assert(bob.view.state.doc.child(0).textContent === text,
      `the other client holds "${bob.view.state.doc.child(0).textContent}"`);
    assert(view.state.doc.childCount === 2, `the document grew to ${view.state.doc.childCount} blocks`);
    assert(localWriteResyncStats.refused > before.refused,
      'the binding was never asked to re-render its own write, so this test proved nothing');
    void before.rendered;

    // The invariant the undo stacks rest on: a local write reaches Yjs in a transaction whose
    // origin is ySyncPluginKey, because that is the only origin y-prosemirror's yUndoPlugin and
    // ReviewDecisionHistory track. The guard opens a transaction around the binding's write, and
    // Yjs keeps the origin of whichever call OPENED one, so the guard passes ySyncPluginKey too.
    // On the path below, the sync plugin's own view hook has already opened it with that origin,
    // so this asserts the invariant rather than the guard's own argument; the guard's argument is
    // what carries it on y-prosemirror's snapshot-restore path, where nothing else opens one.
    const origins: unknown[] = [];
    const record = (_events: unknown, tr: { origin: unknown }) => origins.push(tr.origin);
    alice.doc.getXmlFragment('prosemirror').observeDeep(record as any);
    view.dispatch(view.state.tr.insertText('?', 3));
    alice.doc.getXmlFragment('prosemirror').unobserveDeep(record as any);
    assert(origins.length > 0, 'the local write reached no Yjs transaction');
    assert(origins.every(origin => origin === ySyncPluginKey),
      `a local write opened a Yjs transaction with the wrong origin: ${origins.map(o => String(o)).join(', ')}`);
    // And it is still undoable, which is what the origin buys: an untracked origin would leave
    // the undo stack empty. (Yjs groups writes made inside its capture window into one entry, so
    // what is asserted is that undo took the typing back, not how many entries it used.)
    assert(alice.history.undo() === true, 'the local write could not be undone: its origin is not tracked');
    assert(!view.state.doc.child(0).textContent.includes('?'),
      `undo left the typing in place: "${view.state.doc.child(0).textContent}"`);
    console.log(`\u2713 a local write is not re-rendered as a remote change (${localWriteResyncStats.refused - before.refused} refused)`);
  } finally {
    peers.close();
  }
}

async function main(): Promise<void> {
  await serverKeepsRelativePositions();
  await historyEditHasNoEcho();
  await remoteChangesDoNotScroll();
  await ownWriteIsNotResynced();
  const { isForeignTransaction } = await import('../editor/caret-anchor');
  const tr = (meta: Record<string, unknown>, docChanged: boolean, selectionSet: boolean) => ({
    getMeta: (key: unknown) => meta[key === ySyncPluginKey ? 'ysync' : String(key)], docChanged, selectionSet,
  }) as any;
  assert(isForeignTransaction(tr({ ysync: { isChangeOrigin: true } }, true, true)), 'a remote change is foreign');
  assert(isForeignTransaction(tr({}, false, false)), 'a view-only refresh is foreign');
  assert(!isForeignTransaction(tr({}, true, false)), 'typing is the person\'s own');
  assert(!isForeignTransaction(tr({}, false, true)), 'a click or arrow key is the person\'s own');
  console.log('✓ caret anchoring only compensates changes the person did not make');
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
