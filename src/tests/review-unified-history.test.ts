import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';
import { ySyncPlugin, yUndoPlugin, ySyncPluginKey, yUndoPluginKey, updateYFragment, undo, redo } from 'y-prosemirror';
import { marksPlugin, marksPluginKey } from '../editor/plugins/marks';
import { wrapTransactionForSuggestions } from '../editor/plugins/suggestions';
import { marksSyncPlugin } from '../editor/plugins/marks-sync';

const production = process.argv.includes('--production');
const historyModule = production ? null : await import('../editor/review-decision-history');
const History = historyModule?.ReviewDecisionHistory;
(globalThis as any).document = { createElement: () => ({}), head: { appendChild() {} } };
const ctx = { wait: async () => {}, update() {} } as any;
await marksPlugin(ctx)();
const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, paragraph: { content: 'text*', group: 'block' },
  blockquote: { content: 'block+', group: 'block' },
  bullet_list: { content: 'list_item+', group: 'block' }, ordered_list: { content: 'list_item+', group: 'block' },
  list_item: { content: 'paragraph block*' }, table: { content: 'table_row+', group: 'block' },
  table_row: { content: '(table_cell | table_header)+' }, table_cell: { content: 'block+' }, table_header: { content: 'block+' },
  heading: { content: 'text*', group: 'block' }, code_block: { content: 'text*', group: 'block', code: true }, text: { group: 'inline' },
}, marks: { proofSuggestion: { attrs: { id: { default: null }, kind: { default: 'insert' }, by: { default: 'human:Alice' }, content: { default: null }, createdAt: { default: null }, status: { default: null } }, inclusive: false } } });
async function pair() {
  const a = new Y.Doc(), b = new Y.Doc();
  const initial = schema.node('doc', null, ['Original', 'Second'].map(t => schema.node('paragraph', null, schema.text(t))));
  updateYFragment(a, a.getXmlFragment('prosemirror'), initial, { mapping: new Map(), isOMark: new Map() });
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  async function peer(doc: Y.Doc) {
    const map = doc.getMap<any>('marks');
    let restoring = false;
    const ms = marksSyncPlugin((_m, _v, data) => {
      if (restoring) return;
      doc.transact(() => {
        for (const k of [...map.keys()]) if (!data[k]) map.delete(k);
        for (const [k, v] of Object.entries(data)) if (JSON.stringify(map.get(k)) !== JSON.stringify(v)) map.set(k, v);
      }, 'local-marks-sync');
    });
    await ms(ctx)();
    const plugins = [ySyncPlugin(doc.getXmlFragment('prosemirror')), yUndoPlugin(), marksPlugin.plugin(), ms.plugin()];
    const updates: any[] = [];
    const view: any = { hasFocus: () => false, state: EditorState.create({ schema, doc: initial, plugins }), dispatch(tr: any) {
      if (!production && tr.getMeta(ySyncPluginKey)?.isChangeOrigin) tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata: map.toJSON() });
      view.state = view.state.apply(tr); for (const pv of updates) pv.update?.(view);
    } };
    for (const plugin of plugins) if (plugin.spec.view) updates.push(plugin.spec.view(view));
    map.observe(() => view.dispatch(view.state.tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata: map.toJSON() }).setMeta('addToHistory', false)));
    const native = yUndoPluginKey.getState(view.state)!.undoManager;
    native.clear(); native.stopCapturing();
    // The second argument is ignored by R1a2; R1a3 extends the installed manager.
    const history = History ? new (History as any)(doc, native, view) : null;
    let style = production ? 'proof' : 'playmaker';
    return { doc, map, view, native, history, setStyle(s: string) { style = s; },
      edit(fn: () => void) { if (style === 'playmaker') history.edit(fn); else fn(); },
      restore(isRedo = false) { restoring = true; try { return style === 'playmaker' ? (isRedo ? history.redo() : history.undo()) : (isRedo ? redo(view.state) : undo(view.state)); } finally { restoring = false; } },
      recreatePluginViews() {
        for (const pv of updates) pv.destroy?.();
        updates.length = 0;
        for (const plugin of plugins) if (plugin.spec.view) updates.push(plugin.spec.view(view));
        historyModule?.reconnectNativeUndoManager(native);
      },
      close() { history?.destroy(); for (const pv of updates) pv.destroy?.(); doc.destroy(); },
    };
  }
  const alice = await peer(a), bob = await peer(b);
  a.on('update', (u, o) => { if (o !== 'remote') Y.applyUpdate(b, u, 'remote'); });
  b.on('update', (u, o) => { if (o !== 'remote') Y.applyUpdate(a, u, 'remote'); });
  return { alice, bob, close() { alice.close(); bob.close(); } };
}
const tests: Record<string, () => Promise<void>> = {
  '1': async () => {
    for (const structure of ['blockquote', 'bullet_list', 'ordered_list', 'table', 'heading', 'code_block']) {
      const p = await pair();
      try {
        const para = schema.node('paragraph', null, schema.text('ALICE'));
        const node = structure === 'table' ? schema.node('table', null, schema.node('table_row', null, [schema.node('table_cell', null, para), schema.node('table_header', null, para)]))
          : structure.endsWith('_list') ? schema.node(structure, null, schema.node('list_item', null, para))
          : schema.node(structure, null, structure === 'blockquote' ? para : schema.text('ALICE'));
        p.alice.edit(() => p.alice.view.dispatch(p.alice.view.state.tr.insert(10, node)));
        let pos = 0; p.bob.view.state.doc.descendants((n: any, at: number) => { if (!pos && n.isText && n.text === 'ALICE') pos = at + 2; });
        p.bob.edit(() => p.bob.view.dispatch(p.bob.view.state.tr.insertText('BOB', pos)));
        assert(p.alice.restore());
        for (const peer of [p.alice, p.bob]) {
          assert(peer.view.state.doc.textContent.includes('BOB'), `${structure}: Bob survives undo on both peers`);
          assert(!peer.view.state.doc.textContent.includes('AL'), `${structure}: Alice's characters go`);
        }
        assert(p.alice.restore(true));
        assert(p.alice.restore());
        for (const peer of [p.alice, p.bob]) assert(peer.view.state.doc.textContent.includes('BOB'), `${structure}: Bob survives redo and second undo`);
      } finally { p.close(); }
    }
  },
  '2': async () => {
    for (const changed of [true, 'identical', 'own', false]) {
      const p = await pair();
      try {
        p.alice.edit(() => p.alice.view.dispatch(wrapTransactionForSuggestions(p.alice.view.state.tr.insertText('OWN', 9), p.alice.view.state, true)));
        const id = [...p.alice.map.keys()][0]; assert(id);
        if (changed === 'identical') p.bob.map.set(id, structuredClone(p.bob.map.get(id)));
        else if (changed === 'own') {
          p.alice.history.decide(() => p.alice.map.set(id, { ...p.alice.map.get(id), replies: [{ by: 'human:Alice', text: 'Own reply' }] }));
          assert(p.alice.restore(), 'Undo my own reply before undoing typing');
        } else if (changed) p.bob.map.set(id, { ...p.bob.map.get(id), replies: [{ by: 'human:Bob', text: 'Keep it', at: '2026-09-15T00:00:00Z' }] });
        const snapshot = () => JSON.stringify([p.alice.view.state.doc.toJSON(), p.alice.map.toJSON(), p.bob.view.state.doc.toJSON(), p.bob.map.toJSON()]);
        const before = snapshot();
        if (changed && changed !== 'own') {
          if (production) {
            p.alice.restore();
            console.log(`Production orphan: text=${p.alice.view.state.doc.textContent.includes('OWN')}, record=${p.alice.map.has(id)}, reply=${Boolean(p.alice.map.get(id)?.replies?.length)}`);
            assert.equal(snapshot(), before, 'Production must refuse changed tracked typing');
          } else assert.throws(() => p.alice.restore(), { message: "Can't undo: someone has replied to this suggestion." });
          assert.equal(snapshot(), before, 'Refusal changes nothing on either peer');
        } else {
          assert(p.alice.restore());
          for (const peer of [p.alice, p.bob]) { assert(!peer.view.state.doc.textContent.includes('OWN')); assert(!peer.map.has(id)); }
          assert(p.alice.restore(true)); assert.equal(snapshot(), before, 'Redo restores text and exact record on both peers');
        }
      } finally { p.close(); }
    }
  },
  '3': async () => {
    if (production) { console.log('Production has no style switch (R1a absent)'); return; }
    for (const from of ['playmaker', 'proof']) {
      const p = await pair();
      try {
        p.alice.setStyle(from); p.alice.edit(() => p.alice.view.dispatch(p.alice.view.state.tr.insertText('XY', 5)));
        p.alice.setStyle(from === 'proof' ? 'playmaker' : 'proof');
        assert(p.alice.restore(), `${from}: destination style undoes edit`);
        assert.equal(p.alice.view.state.doc.textContent, 'OriginalSecond');
      } finally { p.close(); }
    }
  },
  '4': async () => {
    for (const style of production ? ['proof'] : ['playmaker', 'proof']) {
      const p = await pair();
      try {
        const a = p.alice; a.setStyle(style);
        a.view.dispatch(a.view.state.tr.setSelection(TextSelection.create(a.view.state.doc, 5)));
        a.edit(() => a.view.dispatch(a.view.state.tr.insertText('XY')));
        a.view.dispatch(a.view.state.tr.setSelection(TextSelection.create(a.view.state.doc, 14)));
        assert(a.restore());
        assert(a.restore(true)); assert.equal(a.view.state.selection.from, 7, `${style}: redo cursor`);
        a.edit(() => a.view.dispatch(a.view.state.tr.insertText('Z')));
        assert.equal(a.view.state.doc.textContent, 'OrigXYZinalSecond');
      } finally { p.close(); }
    }
  },
  '5': async () => {
    if (production) return;
    const p = await pair();
    try {
      const a = p.alice;
      assert.equal(a.history.manager, a.native, 'The installed plugin owns the only manager');
      a.recreatePluginViews(); a.recreatePluginViews();
      a.edit(() => a.view.dispatch(a.view.state.tr.insertText('A', 9)));
      a.edit(() => a.view.dispatch(a.view.state.tr.insertText('B', 10)));
      await new Promise(r => setTimeout(r, 550));
      a.edit(() => a.view.dispatch(a.view.state.tr.insertText('C', 11)));
      assert(a.restore()); assert.equal(a.view.state.doc.textContent, 'OriginalABSecond');
      assert(a.restore()); assert.equal(a.view.state.doc.textContent, 'OriginalSecond');
      assert(a.restore(true)); assert(a.restore(true));
      a.history.decide(() => a.map.set('comment', { kind: 'comment', text: 'Decision' }));
      a.edit(() => a.view.dispatch(a.view.state.tr.insertText('D', 12)));
      assert(a.restore()); assert(a.map.has('comment'));
      assert(a.restore()); assert(!a.map.has('comment'));
      assert(a.restore()); assert.equal(a.view.state.doc.textContent, 'OriginalABSecond');
      const count = a.native.undoStack.length;
      for (const origin of ['remote', 'server-ai', 'local-marks-sync']) {
        a.doc.transact(() => a.map.set(origin, { kind: 'comment', text: origin }), origin);
      }
      assert.equal(a.native.undoStack.length, count, 'External origins never enter the shared history');
      a.history.destroy();
      assert(!a.native.trackedOrigins.has((a.history as any).origin));
      assert(!a.native.trackedOrigins.has((a.history as any).editOrigin));
      a.recreatePluginViews();
      a.native.destroy();
      assert(!a.doc._observers.get('afterTransaction')?.has(a.native.afterTransactionHandler), 'Document teardown detaches native subscriptions');
    } finally { p.close(); }
  },
};
let failed = 0;
for (const [id, test] of Object.entries(tests)) {
  if (process.argv[2] && !process.argv[2].startsWith('--') && process.argv[2] !== id) continue;
  try { await test(); console.log(`PASS R1a3 finding ${id}`); } catch (e) { failed++; console.error(`FAIL R1a3 finding ${id}: ${(e as Error).message}`); }
}
process.exitCode = failed ? 1 : 0;
