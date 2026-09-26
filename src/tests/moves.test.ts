import assert from 'node:assert/strict';
import { pair, schema } from './review-history-fixture';
import { MOVE_POLICY, movingUnit, dropTargets, isValidDrop, createMove, moveBundles } from '../shared/moves';
import { extractLines } from '../shared/line-marks';
import { applyMoveProposal, prepareSuggestionBatch, getMarkMetadata } from '../editor/plugins/marks';
import { wrapTransactionForSuggestions } from '../editor/plugins/suggestions';
import { EditorState } from '@milkdown/kit/prose/state';

assert.equal(MOVE_POLICY.outlinePersists, false);
const p = (text: string) => schema.node('paragraph', null, schema.text(text));
const doc = schema.node('doc', null, [p('Alpha'), p('Beta'), p('Gamma')]);
const lines = extractLines(doc), unit = movingUnit(doc, lines[0])!;
assert.deepEqual(dropTargets(doc, unit), [13, 20]);
assert.equal(isValidDrop(doc, unit, unit.to), false);
const listDoc = schema.node('doc', null, [schema.node('bullet_list', null, [schema.node('list_item', null, [p('One'), schema.node('bullet_list', null, [schema.node('list_item', null, p('Nested'))])]), schema.node('list_item', null, p('Two'))]), p('Outside')]);
const listLines = extractLines(listDoc), entry = movingUnit(listDoc, listLines[0])!;
assert.equal(entry.kind, 'list_item');
assert.ok(listDoc.textBetween(entry.from, entry.to).includes('Nested'));
assert.equal(isValidDrop(listDoc, entry, listDoc.content.size), false);
const tableDoc = schema.node('doc', null, [schema.node('table', null, ['Header', 'Row one', 'Row two'].map((text, i) => schema.node('table_row', null, schema.node(i ? 'table_cell' : 'table_header', null, p(text)))))]);
const tableLines = extractLines(tableDoc);
assert.equal(isValidDrop(tableDoc, movingUnit(tableDoc, tableLines[1])!, 1), false);
assert.equal(isValidDrop(tableDoc, movingUnit(tableDoc, tableLines[0])!, tableDoc.content.size - 1), false);

for (const action of ['accept', 'reject'] as const) {
  const peers = await pair();
  const { alice, bob } = peers;
  // Exercise exactly the production interceptor used by local editing.
  for (const peer of [alice, bob]) {
    const dispatch = peer.view.dispatch.bind(peer.view);
    peer.view.dispatch = (tr: any) => dispatch(wrapTransactionForSuggestions(tr, peer.view.state, true));
  }
  const before = alice.view.state.doc.toJSON();
  const ls = extractLines(alice.view.state.doc);
  const members = createMove(alice.view.state.doc, ls[0], { line: ls[1], side: 'after' }, false, `move-${action}`, 'human:Alice', {})!;
  alice.history.decide(() => applyMoveProposal(alice.view, members, false, 'human:Alice'));
  assert.equal(moveBundles(bob.map.toJSON()).filter(b => b.status === 'open').length, 1);
  assert.equal(Object.keys(bob.map.toJSON()).length, 2);
  const batch = prepareSuggestionBatch(bob.view, Object.keys(members), action);
  assert.deepEqual(batch.failedIds, []);
  bob.history.decide(batch.apply);
  assert.deepEqual(alice.view.state.doc.toJSON(), action === 'accept'
    ? schema.node('doc', null, [p('Second'), p('Original')]).toJSON() : before);
  assert.ok(Object.values(bob.map.toJSON()).every((m: any) => m.status === `${action}ed`));
  assert.equal(bob.restore(), true);
  assert.deepEqual(alice.view.state.doc.toJSON(), before);
  assert.ok(Object.values(alice.map.toJSON()).every((m: any) => m.status === 'pending'));
  peers.close();
}
{
  const { alice, bob, close } = await pair();
  const ls = extractLines(alice.view.state.doc);
  const members = createMove(alice.view.state.doc, ls[0], { line: ls[1], side: 'after' }, false, 'move-own', 'human:Alice', {})!;
  alice.history.decide(() => applyMoveProposal(alice.view, members, true, 'human:Alice'));
  assert.equal(bob.view.state.doc.firstChild.textContent, 'Second');
  assert.ok(Object.values(bob.map.toJSON()).every((m: any) => m.status === 'accepted' && m.resolvedBy === 'human:Alice'));
  assert.equal(alice.restore(), true);
  assert.equal(bob.view.state.doc.firstChild.textContent, 'Original');
  assert.equal(Object.keys(bob.map.toJSON()).length, 2);
  assert.ok(Object.values(bob.map.toJSON()).every((m: any) => m.status === 'rejected'));
  assert.equal(alice.restore(true), true);
  assert.equal(bob.view.state.doc.firstChild.textContent, 'Second');
  close();
}
{
  const { alice, bob, close } = await pair();
  const ls = extractLines(alice.view.state.doc);
  const members = createMove(alice.view.state.doc, ls[0], { line: ls[1], side: 'after' }, false, 'move-stale', 'human:Alice', {})!;
  alice.history.decide(() => applyMoveProposal(alice.view, members, false, 'human:Alice'));
  bob.edit(() => bob.view.dispatch(wrapTransactionForSuggestions(bob.view.state.tr.insertText(' edited', 9), bob.view.state, true)));
  const batch = prepareSuggestionBatch(alice.view, Object.keys(members), 'accept');
  assert.ok(batch.failedIds.length > 0);
  assert.throws(batch.apply);
  assert.equal(moveBundles(getMarkMetadata(alice.view.state))[0].status, 'open');
  close();
}
{
  const sectionDoc = schema.node('doc', null, [schema.node('heading', null, schema.text('Heading')), p('Body'), schema.node('heading', null, schema.text('Next')), p('Tail')]);
  const ls = extractLines(sectionDoc);
  assert.equal(movingUnit(sectionDoc, ls[0], false)!.to, sectionDoc.firstChild!.nodeSize);
  const folded = movingUnit(sectionDoc, ls[0], true)!;
  assert.equal(sectionDoc.textBetween(folded.from, folded.to), 'HeadingBody');
  const members = createMove(sectionDoc, ls[0], { line: ls[3], side: 'after' }, true, 'section', 'human:Alice', {})!;
  const { decideMove } = await import('../shared/moves');
  const tr = EditorState.create({ doc: sectionDoc }).tr;
  decideMove(tr, members, Object.keys(members)[0], 'accept', 'human:Bob');
  assert.equal(tr.doc.textContent, 'NextTailHeadingBody');
}
console.log('PASS moves: structural rules, two peers, grouped decisions, Undo, immediate moves, stale refusal, folded sections');


{
  const { alice, bob, close } = await pair();
  const ls = extractLines(alice.view.state.doc);
  const members = createMove(alice.view.state.doc, ls[0], { line: ls[1], side: 'after' }, false, 'move-withdraw', 'human:Alice', {})!;
  alice.history.decide(() => applyMoveProposal(alice.view, members, false, 'human:Alice'));
  assert.equal(alice.restore(), true);
  assert.equal(Object.keys(bob.map.toJSON()).length, 2);
  assert.ok(Object.values(bob.map.toJSON()).every((m: any) => m.status === 'rejected'));
  assert.equal(alice.restore(true), true);
  assert.ok(Object.values(bob.map.toJSON()).every((m: any) => m.status === 'pending'));
  close();
}
{
  const { decideMove } = await import('../shared/moves');
  const row = movingUnit(tableDoc, tableLines[1])!;
  const members = createMove(tableDoc, tableLines[1], { line: tableLines[2], side: 'after' }, false, 'row', 'human:Alice', {})!;
  const tr = EditorState.create({ doc: tableDoc }).tr;
  decideMove(tr, members, 'row:remove', 'accept', 'human:Bob');
  assert.equal(tr.doc.firstChild!.childCount, 3);
  assert.equal(tr.doc.firstChild!.child(0).textContent, 'Header');
  assert.equal(tr.doc.firstChild!.child(2).textContent, 'Row one');
  assert.ok(row.to > row.from);
  const entryMove = createMove(listDoc, listLines[0], { line: listLines[2], side: 'after' }, false, 'entry', 'human:Alice', {})!;
  const listTr = EditorState.create({ doc: listDoc }).tr;
  decideMove(listTr, entryMove, 'entry:remove', 'accept', 'human:Bob');
  assert.equal(listTr.doc.firstChild!.firstChild!.textContent, 'Two');
  assert.equal(listTr.doc.firstChild!.lastChild!.textContent, 'OneNested');
  assert.equal(createMove(doc, lines[0], { line: lines[1], side: 'before' }, false, 'noop', 'human:Alice', {}), null);
  const duplicate = schema.node('doc', null, [p('Same'), p('Same'), p('Other')]);
  const dl = extractLines(duplicate);
  assert.throws(() => createMove(duplicate, dl[0], { line: dl[2], side: 'after' }, false, 'duplicate', 'human:Alice', {}), /identical/);
  const original = { existing: { kind: 'replace' as const, by: 'human:Bob', range: { from: 1, to: 6 }, quote: 'Alpha', content: 'Alternate', status: 'pending' as const } };
  const guarded = createMove(doc, lines[0], { line: lines[2], side: 'after' }, false, 'guarded', 'human:Alice', original)!;
  const changed = { ...original, ...guarded, existing: { ...original.existing, content: 'Other meaning' } };
  assert.throws(() => decideMove(EditorState.create({ doc }).tr, changed, 'guarded:remove', 'accept', 'human:Bob'), /changed/);
  const changedDestination = EditorState.create({ doc }).tr.insertText('!', lines[2].pos + 1).doc;
  assert.throws(() => decideMove(EditorState.create({ doc: changedDestination }).tr, { ...original, ...guarded }, 'guarded:remove', 'accept', 'human:Bob'), /changed/);
}
console.log('PASS moves: proposal Undo/Redo, rows preserve headers, nested list content, no-op, duplicate and concurrent-proposal refusals');

{
  const { applyFoldTransaction, emptyFoldState } = await import('../editor/plugins/fold-view');
  const { decideMove } = await import('../shared/moves');
  const members = createMove(doc, lines[0], { line: lines[2], side: 'after' }, false, 'fold-visibility', 'human:Alice', {})!;
  const tr = EditorState.create({ doc }).tr;
  decideMove(tr, members, 'fold-visibility:remove', 'accept', 'human:Bob');
  const fold = applyFoldTransaction(tr, { ...emptyFoldState(), ready: true, shown: new Set([lines[0].pos]) });
  const moved = extractLines(tr.doc).find(l => l.text === 'Alpha')!;
  assert.ok(fold.shown.has(moved.pos), 'moving text lost its explicit visibility');
}

// Exercise canonical persistence and the mounted HTTP routes on a local-only server.
{
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const temp = mkdtempSync(path.join(tmpdir(), 'accord-moves-'));
  process.env.DATABASE_PATH = path.join(temp, 'test.db');
  process.env.SNAPSHOT_DIR = path.join(temp, 'snapshots');
  const db = await import('../../server/db');
  const { moveDocumentAsync, executeDocumentOperationAsync } = await import('../../server/document-engine');
  const { setImmediateMoveActors, immediateMoveActors } = await import('../../server/moves');
  const { buildIssueReport } = await import('../../server/line-marks');
  const { documentReviewAlignment } = await import('../../server/review-alignment');
  const { default: express } = await import('express');
  const { createServer } = await import('node:http');
  const { agentRoutes } = await import('../../server/agent-routes');
  const app = express(); app.use(express.json()); app.use('/api/agent', agentRoutes);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const slug = 'moves-unit-api';
  const alice = 'human:alice@example.test', bob = 'human:bob@example.test';
  const call = async (route: string, body?: unknown, token = 'test-owner') => {
    const response = await fetch(`${base}/api/agent/${slug}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'x-share-token': token,
        'X-Proof-Client-Version': '0.34.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' },
      ...(body === undefined ? {} : { body: JSON.stringify({ by: alice, ...body as object }) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    db.createDocument(slug, 'Original\n\nSecond', {}, 'Moves', alice, 'test-owner');
    const proposal = await moveDocumentAsync(slug, alice, { unit: { lineIndex: 0 }, place: { target: { lineIndex: 1 }, side: 'after' } });
    assert.equal(proposal.status, 200, JSON.stringify(proposal.body));
    const bundle = proposal.body.proposal as any;
    assert.equal(bundle.kind, 'move'); assert.equal(bundle.members.length, 2);
    let current = db.getDocumentBySlug(slug)!;
    const report = await buildIssueReport(slug, current.markdown, current.marks);
    assert.equal(report.bundles.filter((b: any) => b.kind === 'move' || b.bundle?.kind === 'move').length, 1);
    assert.equal(documentReviewAlignment(slug, report, current.marks).counts.total, 1);
    const decision = await executeDocumentOperationAsync(slug, 'POST', '/marks/accept', { markId: `${bundle.id}:insert`, by: bob });
    assert.equal(decision.status, 200, JSON.stringify(decision.body));
    current = db.getDocumentBySlug(slug)!;
    assert.equal(current.markdown.trim(), 'Second\n\nOriginal');
    assert.equal(setImmediateMoveActors(slug, [alice], bob, false).status, 403);
    assert.deepEqual(immediateMoveActors(slug), []);
    assert.equal(setImmediateMoveActors(slug, [alice], alice, true).status, 200);
    const immediate = await moveDocumentAsync(slug, alice, { unit: { quote: 'Original' }, place: { target: { quote: 'Second' }, side: 'before' } });
    assert.equal(immediate.status, 200, JSON.stringify(immediate.body));
    assert.equal((immediate.body.proposal as any).status, 'accepted');
    assert.equal((immediate.body.proposal as any).closedBy, alice);
    assert.equal(db.getDocumentBySlug(slug)!.markdown.trim(), 'Original\n\nSecond');
    const editor = db.createDocumentAccessToken(slug, 'editor');
    assert.equal((await call('/move-settings', { immediateMoveActors: [] }, editor.secret)).status, 401);
    assert.equal((await call('/move-settings', { immediateMoveActors: [] })).status, 200);
    const posted = await call('/moves', { unit: { lineIndex: 0 }, place: { target: { quote: 'Second' }, side: 'after' } });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    assert.equal(posted.body.proposal.kind, 'move');
    const read = await call('/state');
    assert.equal(read.status, 200);
    assert.equal(Object.values(read.body.marks).filter((m: any) => m.move && m.status === 'pending').length, 2);
    assert.equal((await call(`/moves/${posted.body.proposal.id}/reject`, {})).status, 200);
    assert.equal(db.getDocumentBySlug(slug)!.markdown.trim(), 'Original\n\nSecond');
    const again = await call('/moves', { unit: { quote: 'Original' }, place: { target: { lineIndex: 1 }, side: 'after' } });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal((await call(`/bundles/${again.body.proposal.id}/accept`, {})).status, 200);
    assert.equal(db.getDocumentBySlug(slug)!.markdown.trim(), 'Second\n\nOriginal');
    const back = await call('/moves', { unit: { quote: 'Original' }, place: { target: { quote: 'Second' }, side: 'before' } });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal((await call(`/moves/${back.body.proposal.id}/accept`, {})).status, 200);
    assert.equal(db.getDocumentBySlug(slug)!.markdown.trim(), 'Original\n\nSecond');
    console.log('PASS moves: canonical persistence, mounted HTTP proposal/decision routes, one /state open item, owner settings, recorded immediate decision');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(temp, { recursive: true, force: true });
  }
}
