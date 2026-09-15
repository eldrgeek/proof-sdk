import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState } from '@milkdown/kit/prose/state';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode, ySyncPluginKey } from 'y-prosemirror';
import { ReviewDecisionHistory } from '../editor/review-decision-history';
import { marksPlugin, marksPluginKey, getMarkMetadataWithQuotes, getMarks, accept, reply, clearResolvedMarkTombstones } from '../editor/plugins/marks';
import { marksSyncPlugin } from '../editor/plugins/marks-sync';

(globalThis as any).document = { createElement: () => ({}), head: { appendChild() {} } };
const ctx = { wait: async () => {}, update() {} } as any;
await marksPlugin(ctx)();
const schema = new Schema({ nodes: { doc: { content: 'block+' }, paragraph: { content: 'text*', group: 'block' }, text: { group: 'inline' } }, marks: {
  proofSuggestion: { attrs: { id: { default: null }, kind: { default: 'replace' }, by: { default: 'ai:A' }, content: { default: null }, createdAt: { default: null }, status: { default: null } }, inclusive: false },
  proofComment: { attrs: { id: { default: null }, by: { default: 'human:A' } } },
} });
const record = { kind: 'replace', by: 'ai:A', createdAt: '2026-01-01T00:00:00Z', quote: 'Original', content: 'Changed', status: 'pending', replies: [{ by: 'human:Bob', text: 'Keep this explanation', at: '2026-01-02T00:00:00Z' }] };
async function pair(content = 'Changed', queuedMetadata = false) {
  clearResolvedMarkTombstones(['s', 'c']);
  const a = new Y.Doc(), b = new Y.Doc();
  const initial = schema.node('doc', null, [schema.node('paragraph', null, schema.text('Original', [schema.marks.proofSuggestion.create({ id: 's', content })])), schema.node('paragraph', null, schema.text('Comment', [schema.marks.proofComment.create({ id: 'c' })]))]);
  updateYFragment(a, a.getXmlFragment('prosemirror'), initial, { mapping: new Map(), isOMark: new Map() });
  a.getMap('marks').set('s', { ...record, content });
  a.getMap('marks').set('c', { kind: 'comment', by: 'human:A', createdAt: record.createdAt, quote: 'Comment', text: 'Discuss', replies: [] });
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  async function peer(doc: Y.Doc) {
    const fragment = doc.getXmlFragment('prosemirror'), map = doc.getMap<any>('marks');
    let suppress = false, writing = false;
    const persist = (metadata: Record<string, any>) => {
      for (const id of [...map.keys()]) if (!metadata[id]) map.delete(id);
      for (const [id, value] of Object.entries(metadata)) if (JSON.stringify(map.get(id)) !== JSON.stringify(value)) map.set(id, value);
    };
    const sync = marksSyncPlugin((_marks, _view, metadata) => { if (!suppress) persist(metadata); });
    await sync(ctx)();
    const view: any = { state: EditorState.create({ schema, doc: yXmlFragmentToProseMirrorRootNode(fragment, schema), plugins: [marksPlugin.plugin(), sync.plugin()] }), dispatch(tr: any) {
      view.state = view.state.apply(tr);
      if (!tr.getMeta(ySyncPluginKey)?.isChangeOrigin && tr.docChanged) {
        writing = true;
        updateYFragment(doc, fragment, view.state.doc, { mapping: new Map(), isOMark: new Map() });
        writing = false;
      }
      syncView.update!(view, view.state);
    } };
    const syncView = sync.plugin().spec.view!(view);
    const hydrate = () => view.dispatch(view.state.tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata: map.toJSON() }).setMeta(ySyncPluginKey, { isChangeOrigin: true }));
    suppress = true; hydrate(); suppress = false;
    fragment.observeDeep(() => {
      if (writing) return;
      const next = yXmlFragmentToProseMirrorRootNode(fragment, schema);
      let tr = view.state.tr.replaceWith(0, view.state.doc.content.size, next.content).setMeta(ySyncPluginKey, { isChangeOrigin: true });
      // The initiating page has R1a's restored-record injection; the receiver does not.
      if (suppress) tr = tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata: map.toJSON() });
      view.dispatch(tr);
    });
    map.observe(() => {
      const deliver = () => { const prev = suppress; suppress = true; hydrate(); suppress = prev; };
      if (queuedMetadata) queueMicrotask(deliver); else deliver();
    });
    const history = new ReviewDecisionHistory(doc);
    return { doc, view, map, history, decide(fn: () => void) { suppress = true; try { history.decide(() => { fn(); persist(getMarkMetadataWithQuotes(view.state)); }); } finally { suppress = false; } }, undo() { suppress = true; clearResolvedMarkTombstones(['s','c']); try { return history.undo(); } finally { suppress = false; } }, redo() { suppress = true; try { return history.redo(); } finally { suppress = false; } } };
  }
  const alice = await peer(a), bob = await peer(b);
  a.on('update', (update, origin) => { if (origin !== 'remote') Y.applyUpdate(b, update, 'remote'); });
  b.on('update', (update, origin) => { if (origin !== 'remote') Y.applyUpdate(a, update, 'remote'); });
  return { alice, bob, close() { alice.history.destroy(); bob.history.destroy(); a.destroy(); b.destroy(); } };
}
const tests: Record<string, () => Promise<void>> = {
  '1': async () => {
    const p = await pair('Changed\n\nExtra paragraph');
    try {
      p.alice.decide(() => assert(accept(p.alice.view, 's', (text: string) => schema.node('doc', null, text.split('\n\n').map(t => schema.node('paragraph', null, schema.text(t)))))));
      const paragraph = p.bob.doc.getXmlFragment('prosemirror').get(1) as Y.XmlElement;
      (paragraph.get(0) as Y.XmlText).insert(3, 'BOB');
      let refused = false; try { refused = p.alice.undo() === false; } catch (e) { refused = (e as Error).message === "Can't undo: someone has changed this text since."; }
      assert(refused, 'Undo must refuse a paragraph containing Bob’s new text');
      for (const peer of [p.alice, p.bob]) assert(peer.view.state.doc.textContent.includes('BOB'));
    } finally { p.close(); }
  },
  '2': async () => {
    const p = await pair('Changed', true);
    try {
      const original = structuredClone(p.alice.map.get('s'));
      p.alice.decide(() => assert(accept(p.alice.view, 's')));
      await new Promise(resolve => setImmediate(resolve));
      assert(p.alice.undo());
      await new Promise(resolve => setImmediate(resolve));
      for (const peer of [p.alice, p.bob]) {
        assert.deepEqual(peer.map.get('s'), original, 'Shared record must retain exact replies and createdAt');
        const mark = getMarks(peer.view.state).find(m => m.id === 's')!;
        assert.equal(mark.at, original.createdAt); assert.deepEqual(marksPluginKey.getState(peer.view.state)?.metadata.s.replies, original.replies);
      }
    } finally { p.close(); }
  },
  '3': async () => {
    const p = await pair();
    try {
      p.alice.decide(() => assert(accept(p.alice.view, 's')));
      p.alice.decide(() => assert(reply(p.alice.view, 'c', 'human:Alice', 'Alice')));
      p.bob.map.set('c', { ...p.bob.map.get('c'), replies: [...p.bob.map.get('c').replies, { by: 'human:Bob', text: 'Bob', at: record.createdAt }] });
      assert(p.alice.undo()); assert(p.alice.view.state.doc.textContent.includes('Original'));
      assert(p.alice.redo());
      assert(p.alice.view.state.doc.textContent.includes('Changed'), 'Redo must reaccept the decision actually undone');
      assert.deepEqual(p.alice.map.get('c').replies.map((r: any) => r.text), ['Alice', 'Bob']);
    } finally { p.close(); }
  },
  '4': async () => {
    const p = await pair();
    try {
      p.alice.decide(() => assert(accept(p.alice.view, 's'))); assert(p.alice.undo());
      ((p.bob.doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(4, 'BOB');
      let refused = false; try { refused = p.alice.redo() === false; } catch (e) { refused = (e as Error).message === "Can't redo: someone has changed this text since."; }
      assert(refused, 'Redo must refuse intervening edits');
      for (const peer of [p.alice, p.bob]) assert(peer.view.state.doc.textContent.includes('OrigBOBinal'));
    } finally { p.close(); }
  },
};
let failed = 0;
for (const [id, test] of Object.entries(tests)) {
  if (process.argv[2] && process.argv[2] !== id) continue;
  try { await test(); console.log(`PASS finding ${id}`); } catch (e) { failed++; console.error(`FAIL finding ${id}:`, (e as Error).message); }
}
process.exitCode = failed ? 1 : 0;
