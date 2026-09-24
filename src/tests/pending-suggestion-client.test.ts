import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, Plugin } from '@milkdown/kit/prose/state';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode, ySyncPluginKey } from 'y-prosemirror';
import { ReviewDecisionHistory } from '../editor/review-decision-history';
import { setCurrentActor } from '../editor/actor';
import { marksPlugin, marksPluginKey, applyRemoteMarks, getMarkMetadataWithQuotes, getMarks,
  accept, reject, mergePendingServerMarks, clearResolvedMarkTombstones, createDecorations } from '../editor/plugins/marks';
import { getPendingSuggestions, type StoredMark } from '../formats/marks';
import { threadsFrom } from '../shared/threads';

(globalThis as any).document = { createElement: () => ({}), head: { appendChild() {} } };
(globalThis as any).window = { location: new URL('http://localhost/d/p0-client'), __PROOF_CONFIG__: {} };
const { CollabClient } = await import('../bridge/collab-client');
const ctx = { wait: async () => {}, update() {} } as any;
await marksPlugin(ctx)();
const schema = new Schema({ nodes: { doc: { content: 'block+' }, paragraph: { content: 'text*', group: 'block' }, text: { group: 'inline' } }, marks: {
  proofSuggestion: { attrs: { id: { default: null }, kind: { default: 'replace' }, by: { default: 'ai:test' }, content: { default: null }, createdAt: { default: null }, status: { default: null } }, inclusive: false },
} });
setCurrentActor('human:reviewer');
for (const action of ['accept', 'reject'] as const) {
  for (const kind of ['insert', 'delete', 'replace'] as const) {
    const id = `${action}-${kind}`;
    clearResolvedMarkTombstones([id]);
    const pending: StoredMark = { kind, by: 'ai:test', createdAt: '2026-01-01T00:00:00Z', quote: 'Original', content: kind === 'insert' ? 'Original' : 'Changed', status: 'pending' };
    const doc = new Y.Doc(); const map = doc.getMap('marks'); map.set(id, pending);
    const client = new CollabClient();
    Object.assign(client, { ydoc: doc, marksMap: map, sessionRole: 'editor' });
    client.setMarksMetadata({});
    assert.deepEqual(map.get(id), pending, 'Passive empty snapshot cannot delete pending suggestions');
    client.setMarksMetadata({ unrelated: { kind: 'comment', text: 'Keep too' } });
    assert.deepEqual(map.get(id), pending, 'Partial snapshot cannot delete pending suggestions');
    assert.deepEqual(mergePendingServerMarks({}, { [id]: pending })[id], pending, 'Unhydrated editor retains server suggestion');
    const initial = schema.node('doc', null, [schema.node('paragraph', null, schema.text('Original', [schema.marks.proofSuggestion.create({ id, kind })]))]);
    const fragment = doc.getXmlFragment('prosemirror');
    updateYFragment(doc, fragment, initial, { mapping: new Map(), isOMark: new Map() });
    const syncState = () => new Plugin({ key: ySyncPluginKey, state: { init: () => ({ type: fragment }), apply: (_tr, value) => value } });
    const view: any = { state: EditorState.create({ schema, doc: initial, plugins: [marksPlugin.plugin(), syncState()] }), dispatch(tr: any) {
      view.state = view.state.apply(tr);
      if (tr.docChanged && !tr.getMeta(ySyncPluginKey)?.isChangeOrigin) updateYFragment(doc, fragment, view.state.doc, { mapping: new Map(), isOMark: new Map() });
    } };
    view.dispatch(view.state.tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata: { [id]: pending } }));
    applyRemoteMarks(view, {}, { authoritativeSnapshot: true });
    assert.equal(getMarks(view.state).some(mark => mark.id === id), false);
    applyRemoteMarks(view, { [id]: pending }, { authoritativeSnapshot: true });
    assert.equal(getPendingSuggestions(getMarks(view.state)).length, 1, 'Guard restore after a transient wire deletion re-anchors immediately');
    assert.equal(view.state.doc.textContent, 'Original');
    const history = new ReviewDecisionHistory(doc);
    history.decide(() => {
      assert.equal(action === 'accept' ? accept(view, id) : reject(view, id), true);
      client.setMarksMetadata(getMarkMetadataWithQuotes(view.state));
    });
    const resolved = map.get(id) as StoredMark;
    assert.equal(resolved.status, action === 'accept' ? 'accepted' : 'rejected');
    assert.equal(resolved.resolvedBy, 'human:reviewer');
    assert.ok(Number.isFinite(Date.parse(resolved.resolvedAt!)));
    const expectedText = action === 'accept' ? (kind === 'delete' ? '' : kind === 'replace' ? 'Changed' : 'Original') : (kind === 'insert' ? '' : 'Original');
    assert.equal(view.state.doc.textContent, expectedText);
    assert.equal(getPendingSuggestions(getMarks(view.state)).length, 0);
    assert.equal(getMarks(view.state).some(m => m.id === id), false, 'Resolved entries are not editor review items');
    assert.equal(createDecorations(view.state, getMarks(view.state), null, null).find().length, 0);
    assert.equal(threadsFrom({ lines: [], marks: [{ ...resolved, id, kind, status: resolved.status }] }).some(t => t.status === 'open'), false);
    assert.equal(mergePendingServerMarks({ [id]: resolved }, { [id]: pending })[id].status, resolved.status, 'Stale snapshot cannot reopen own decision');
    applyRemoteMarks(view, { [id]: resolved });
    assert.equal(getMarks(view.state).some(m => m.id === id), false);
    assert.equal(getMarkMetadataWithQuotes(view.state)[id].status, resolved.status, 'Remote status remains durable metadata');
    assert.equal(history.undo(), true);
    assert.deepEqual(map.get(id), pending, 'Undo restores exact pending record and attribution');
    assert.equal(yXmlFragmentToProseMirrorRootNode(fragment, schema).textContent, 'Original');
    const restored = yXmlFragmentToProseMirrorRootNode(fragment, schema);
    view.state = EditorState.create({ schema, doc: restored, plugins: [marksPlugin.plugin(), syncState()] });
    applyRemoteMarks(view, { [id]: pending }, { authoritativeSnapshot: true });
    assert.equal(getPendingSuggestions(getMarks(view.state)).length, 1, 'Undo is open again');
    assert.equal(history.redo(), true);
    assert.equal((map.get(id) as StoredMark).status, resolved.status);
    assert.equal(yXmlFragmentToProseMirrorRootNode(fragment, schema).textContent, expectedText);
    history.destroy(); doc.destroy();
  }
}
console.log('✓ passive snapshots, merge, accept/reject/Undo for all suggestion kinds, text, attribution, decoration and thread readers');
