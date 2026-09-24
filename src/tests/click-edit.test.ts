/** ac-8ae: real PM + Yjs transactions, exact text/records, and native Undo. */
import assert from 'node:assert/strict';
import { Slice, Fragment } from '@milkdown/kit/prose/model';
import { routeKey } from '../shared/reading-keys';
import { TextSelection } from '@milkdown/kit/prose/state';
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import { pair, schema } from './review-history-fixture';
import { setCurrentActor } from '../editor/actor';
import { getMarks, clearResolvedMarkTombstones, modifySuggestionContent, marksPluginKey, accept } from '../editor/plugins/marks';
import { wrapTransactionForSuggestions, clickEditDecisionsMeta, rejectionTransaction } from '../editor/plugins/suggestions';
import { installLocalWriteResyncPolicy } from '../editor/local-write-resync';
import { isPendingSuggestion } from '../shared/suggestion-status';
import { commitLiveTextInput } from '../editor/live-suggestion-input';
import { EDIT_SESSION_POLICY } from '../shared/edit-session';
installLocalWriteResyncPolicy();
let passed = 0;
async function test(name: string, fn: (peers: Awaited<ReturnType<typeof pair>>) => void) {
  const peers = await pair();
  try { fn(peers); console.log(`✓ ${name}`); passed++; } finally { peers.close(); }
}
function edit(peer: any, actor: string, from: number, to: number, text: string) {
  setCurrentActor(actor);
  const tr = peer.view.state.tr.setSelection(TextSelection.create(peer.view.state.doc, from, to)).insertText(text, from, to);
  const wrapped = wrapTransactionForSuggestions(tr, peer.view.state, true);
  if (wrapped.getMeta(clickEditDecisionsMeta)?.length) peer.history.decide(() => peer.view.dispatch(wrapped));
  else peer.edit(() => peer.view.dispatch(wrapped));
  return wrapped;
}
const pending = (peer: any) => getMarks(peer.view.state).filter(m => isPendingSuggestion(peer.map.get(m.id)));
const text = (peer: any) => peer.view.state.doc.textContent;
const converge = (peers: Awaited<ReturnType<typeof pair>>) => {
  assert.equal(text(peers.alice), text(peers.bob));
  for (const peer of [peers.alice, peers.bob]) assert.equal(text(peer), yXmlFragmentToProseMirrorRootNode(peer.doc.getXmlFragment('prosemirror'), schema).textContent);
};
await test('live typing is one attributed insert; each character and every anchor converges', peers => {
  let pos = 9;
  for (const char of ' words A') edit(peers.alice, 'human:Alice', pos, pos++, char);
  assert.equal(text(peers.alice), 'Original words ASecond');
  assert.equal(pending(peers.alice).length, 1);
  assert.equal(pending(peers.alice)[0].by, 'human:Alice');
  assert.equal(peers.alice.map.get(pending(peers.alice)[0].id).content, ' words A');
  converge(peers);
});
await test('beforeinput keeps every letter ordered across interleaved remote writes', peers => {
  const view = peers.alice.view;
  view.editable = true;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 9)));
  const dispatch = view.dispatch;
  view.dispatch = (tr: any) => peers.alice.edit(() => dispatch(wrapTransactionForSuggestions(tr, view.state, true)));
  const phrase = 'caret stays put while others write';
  let published = '';
  for (const char of phrase) {
    setCurrentActor('human:Alice');
    let prevented = false;
    assert.equal(commitLiveTextInput(view, {
      inputType: 'insertText', data: char, cancelable: true, isComposing: false,
      preventDefault() { prevented = true; }, target: null,
    } as unknown as InputEvent, true), true);
    assert.equal(prevented, true);
    published += char;
    assert.equal(view.state.doc.firstChild.textContent, `Original${published}`);
    const end = peers.bob.view.state.doc.content.size - 1;
    edit(peers.bob, 'human:Bob', end, end, '!');
    assert.equal(view.state.doc.firstChild.textContent, `Original${published}`);
    assert.equal(view.state.selection.head, 9 + published.length);
    converge(peers);
  }
  assert.equal(peers.alice.map.get(pending(peers.alice).find(m => m.by === 'human:Alice')!.id).content, phrase);
});
await test('native input keeps IME, replacement islands and readonly views on their own paths', peers => {
  const view = peers.alice.view;
  const input = { inputType: 'insertText', data: 'x', cancelable: true, isComposing: false,
    target: null, preventDefault() { throw new Error('must leave native handling alone'); } };
  view.editable = true;
  for (const patch of [{ defaultPrevented: true }, { isComposing: true }, { cancelable: false }, { inputType: 'deleteContentBackward' },
    { data: null }, { target: { closest: () => ({}) } }]) {
    assert.equal(commitLiveTextInput(view, { ...input, ...patch } as unknown as InputEvent, true), false);
  }
  assert.equal(commitLiveTextInput(view, input as unknown as InputEvent, false), false);
  view.composing = true;
  assert.equal(commitLiveTextInput(view, input as unknown as InputEvent, true), false);
  view.composing = false; view.editable = false;
  assert.equal(commitLiveTextInput(view, input as unknown as InputEvent, true), false);
  assert.equal(text(peers.alice), 'OriginalSecond');
});
await test('five author withdrawals never delete a pending map entry', peers => {
  const deletions: string[] = [];
  peers.alice.map.observe(event => { for (const [id, change] of event.changes.keys) if (change.action === 'delete' && isPendingSuggestion(change.oldValue)) deletions.push(id); });
  for (let i = 0; i < 5; i++) {
    edit(peers.alice, 'human:Alice', 9, 9, 'xyz');
    const id = pending(peers.alice)[0].id;
    edit(peers.alice, 'human:Alice', 11, 12, '');
    assert.equal(peers.alice.map.get(id).content, 'xy');
    edit(peers.alice, 'human:Alice', 10, 11, '');
    edit(peers.alice, 'human:Alice', 9, 10, '');
    assert.equal(peers.alice.map.get(id).status, 'rejected');
    assert.equal(peers.alice.map.get(id).resolvedBy, 'human:Alice');
    assert.ok(peers.alice.map.get(id).resolvedAt);
    assert.equal(text(peers.alice), 'OriginalSecond');
  }
  assert.deepEqual(deletions, []); converge(peers);
});
await test('other person deletes a whole insert through Reject; Undo and Redo restore text and status', peers => {
  edit(peers.alice, 'human:Alice', 9, 9, 'abc');
  const id = pending(peers.alice)[0].id;
  const tr = edit(peers.bob, 'human:Bob', 9, 12, '');
  assert.deepEqual(tr.getMeta(clickEditDecisionsMeta), [id]);
  assert.equal(peers.bob.map.get(id).status, 'rejected');
  assert.equal(peers.bob.map.get(id).resolvedBy, 'human:Bob');
  assert.equal(text(peers.bob), 'OriginalSecond');
  clearResolvedMarkTombstones([id]);
  assert.ok(peers.bob.restore());
  assert.equal(text(peers.bob), 'OriginalabcSecond');
  assert.equal(peers.bob.map.get(id).status, 'pending');
  assert.ok(peers.bob.restore(true));
  assert.equal(peers.bob.map.get(id).status, 'rejected');
  converge(peers);
});
await test('Undo of typing withdraws instead of deleting its pending record; Redo brings it back', peers => {
  edit(peers.alice, 'human:Alice', 9, 9, 'abc');
  const id = pending(peers.alice)[0].id;
  const deletions: string[] = [];
  peers.alice.map.observe(event => { for (const [key, change] of event.changes.keys) if (change.action === 'delete' && isPendingSuggestion(change.oldValue)) deletions.push(key); });
  assert.ok(peers.alice.restore());
  assert.equal(peers.alice.map.get(id)?.status, 'rejected');
  assert.equal(text(peers.alice), 'OriginalSecond');
  assert.deepEqual(deletions, []);
  assert.ok(peers.alice.restore(true));
  assert.equal(peers.alice.map.get(id)?.status, 'pending');
  assert.equal(text(peers.alice), 'OriginalabcSecond');
  converge(peers);
});
await test('agreed deletion remains in text as one pending strike; replacement is one proposal', peers => {
  edit(peers.alice, 'human:Alice', 1, 4, '');
  assert.equal(text(peers.alice), 'OriginalSecond');
  assert.equal(pending(peers.alice)[0].kind, 'delete');
  edit(peers.bob, 'human:Bob', 11, 17, 'New');
  const replacement = pending(peers.bob).find(m => m.kind === 'replace')!;
  assert.equal(peers.bob.map.get(replacement.id).content, 'New');
  assert.equal(text(peers.bob), 'OriginalSecond');
  converge(peers);
});
await test('mixed agreed and inserted selection rejects only the insert and proposes deletion of agreed words', peers => {
  edit(peers.alice, 'human:Alice', 9, 9, 'abc');
  const id = pending(peers.alice)[0].id;
  edit(peers.bob, 'human:Bob', 5, 12, '');
  assert.equal(text(peers.bob), 'OriginalSecond');
  assert.equal(peers.bob.map.get(id).status, 'rejected');
  assert.equal(pending(peers.bob).length, 1);
  assert.equal(pending(peers.bob)[0].quote, 'inal');
  assert.equal(pending(peers.bob)[0].kind, 'delete');
  converge(peers);
});
await test('editing inside own insertion retains its id, author and exact new content', peers => {
  edit(peers.alice, 'human:Alice', 9, 9, 'abcd');
  const id = pending(peers.alice)[0].id;
  edit(peers.alice, 'human:Alice', 10, 12, 'XY');
  assert.equal(peers.alice.map.get(id).content, 'aXYd');
  assert.equal(pending(peers.alice).length, 1);
  converge(peers);
});
await test('fallback competing edit retains remaining original insert and attributes new words to editor', peers => {
  assert.equal(EDIT_SESSION_POLICY.editOtherProposalsInPlace, false);
  edit(peers.alice, 'human:Alice', 9, 9, 'abcd');
  const id = pending(peers.alice)[0].id;
  edit(peers.bob, 'human:Bob', 10, 12, 'XY');
  assert.equal(peers.bob.map.get(id).content, 'ad');
  assert.equal(pending(peers.bob).length, 2);
  assert.ok(pending(peers.bob).some(m => m.by === 'human:Bob'));
  converge(peers);
});
await test('multiple input steps map through retained original words without doubling offsets', peers => {
  setCurrentActor('human:Alice');
  const tr = peers.alice.view.state.tr.insertText('x', 9).insertText('y', 10);
  peers.alice.edit(() => peers.alice.view.dispatch(wrapTransactionForSuggestions(tr, peers.alice.view.state, true)));
  assert.equal(text(peers.alice), 'OriginalxySecond');
  converge(peers);
});
await test('replacement content edits and deletion use the original id and Reject history', peers => {
  edit(peers.alice, 'human:Alice', 1, 9, 'Changed');
  const id = pending(peers.alice)[0].id;
  peers.alice.edit(() => assert.ok(modifySuggestionContent(peers.alice.view, id, 'Changed again')));
  assert.equal(pending(peers.alice).length, 1);
  assert.equal(peers.bob.map.get(id).content, 'Changed again');
  setCurrentActor('human:Bob');
  const rejected = rejectionTransaction(peers.bob.view.state, id)!;
  peers.bob.history.decide(() => peers.bob.view.dispatch(rejected));
  assert.equal(peers.bob.map.get(id).status, 'rejected');
  assert.equal(peers.bob.map.get(id).resolvedBy, 'human:Bob');
  assert.equal(text(peers.bob), 'OriginalSecond');
  clearResolvedMarkTombstones([id]);
  assert.ok(peers.bob.restore());
  assert.equal(peers.bob.map.get(id).status, 'pending');
  assert.equal(peers.bob.map.get(id).content, 'Changed again');
  converge(peers);
});
await test('block paste over agreed words preserves the original as one replacement', peers => {
  setCurrentActor('human:Alice');
  const slice = new Slice(Fragment.fromArray(['First', 'Next'].map(t => schema.node('paragraph', null, schema.text(t)))), 1, 1);
  const tr = peers.alice.view.state.tr.replace(1, 9, slice);
  peers.alice.edit(() => peers.alice.view.dispatch(wrapTransactionForSuggestions(tr, peers.alice.view.state, true)));
  assert.equal(text(peers.alice), 'OriginalSecond');
  assert.equal(pending(peers.alice).length, 1);
  const proposal = pending(peers.alice)[0];
  assert.equal(proposal.kind, 'replace');
  assert.equal(peers.alice.map.get(proposal.id).content, 'First\nNext');
  converge(peers);
});
await test('typing elsewhere never resolves an unanchored pending proposal', peers => {
  peers.alice.map.set('unanchored', { kind: 'insert', by: 'human:Bob', status: 'pending', content: 'Lost anchor', quote: 'Absent passage' });
  peers.alice.view.dispatch(peers.alice.view.state.tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata: peers.alice.map.toJSON() }));
  edit(peers.alice, 'human:Alice', 9, 9, 'local');
  assert.equal(peers.alice.map.get('unanchored').status, 'pending');
  converge(peers);
});
await test('successive forward Deletes reach new agreed characters', peers => {
  setCurrentActor('human:Alice');
  peers.alice.view.dispatch(peers.alice.view.state.tr.setSelection(TextSelection.create(peers.alice.view.state.doc, 1)));
  for (let i = 1; i <= 3; i++) {
    const tr = peers.alice.view.state.tr.delete(i, i + 1);
    peers.alice.edit(() => peers.alice.view.dispatch(wrapTransactionForSuggestions(tr, peers.alice.view.state, true)));
    assert.equal(peers.alice.view.state.selection.head, i + 1);
  }
  assert.equal(text(peers.alice), 'OriginalSecond');
  assert.equal(pending(peers.alice).map(m => m.quote).join(''), 'Ori');
  converge(peers);
});
await test('deleting a split insertion remaps the agreed text between its pieces', peers => {
  edit(peers.alice, 'human:Alice', 9, 9, 'abcd');
  const id = pending(peers.alice)[0].id;
  // Fixture: an accepted remote word between two spans of the same proposal.
  peers.bob.edit(() => {
    const tr = peers.bob.view.state.tr.insertText('agreed', 11);
    tr.removeMark(11, 17, schema.marks.proofSuggestion);
    peers.bob.view.dispatch(tr);
  });
  edit(peers.bob, 'human:Bob', 9, 19, '');
  assert.equal(text(peers.bob), 'OriginalagreedSecond');
  assert.equal(peers.bob.map.get(id).status, 'rejected');
  assert.equal(pending(peers.bob).filter(m => m.kind === 'delete')[0].quote, 'agreed');
  converge(peers);
});
await test('accepting split inserted text never inserts the whole proposal beside each piece', peers => {
  edit(peers.alice, 'human:Alice', 9, 9, 'abcd');
  const id = pending(peers.alice)[0].id;
  edit(peers.bob, 'human:Bob', 10, 12, 'XY');
  peers.bob.history.decide(() => assert.ok(accept(peers.bob.view, id)));
  assert.equal(text(peers.bob), 'OriginalaXYdSecond');
  assert.equal(peers.bob.map.get(id).status, 'accepted');
  converge(peers);
});
await test('block insertion retains its line break and can be rejected without duplicating text', peers => {
  setCurrentActor('human:Alice');
  const slice = new Slice(Fragment.fromArray(['First', 'Next'].map(t => schema.node('paragraph', null, schema.text(t)))), 1, 1);
  const tr = peers.alice.view.state.tr.replace(9, 9, slice);
  peers.alice.edit(() => peers.alice.view.dispatch(wrapTransactionForSuggestions(tr, peers.alice.view.state, true)));
  const proposal = pending(peers.alice)[0];
  assert.equal(peers.alice.map.get(proposal.id).content, 'First\nNext');
  setCurrentActor('human:Bob');
  const rejected = rejectionTransaction(peers.bob.view.state, proposal.id);
  assert.ok(rejected);
  peers.bob.history.decide(() => peers.bob.view.dispatch(rejected));
  assert.equal(text(peers.bob), 'OriginalSecond');
  assert.equal(peers.bob.view.state.doc.childCount, 2);
  converge(peers);
});
for (const key of ['A', 'a', 'J', 'j', 'K', 'k', 'Delete', 'Backspace']) {
  assert.equal(routeKey({ key, target: 'editor', writing: true }), 'type', `${key} must edit text`);
  assert.equal(routeKey({ key, target: 'field', writing: false }), 'type', `${key} must edit fields`);
}
console.log(`${passed} click-edit tests passed; letter/Delete key routes passed`);
