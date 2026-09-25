import * as Y from 'yjs';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState } from '@milkdown/kit/prose/state';
import { ySyncPlugin, yUndoPlugin, ySyncPluginKey, yUndoPluginKey, updateYFragment, undo, redo } from 'y-prosemirror';
import { marksPlugin, marksPluginKey } from '../editor/plugins/marks';
import { marksSyncPlugin } from '../editor/plugins/marks-sync';

const production = false;
const historyModule = production ? null : await import('../editor/review-decision-history');
const History = historyModule?.ReviewDecisionHistory;
const keepUndoGroupOpen = historyModule?.keepUndoGroupOpen;
/** A test may switch the editor-dispatch behaviour off to show what it prevents. */
export const fixtureOptions = { keepUndoGroupOpen: true };
(globalThis as any).document = { createElement: () => ({}), head: { appendChild() {} } };
const ctx = { wait: async () => {}, update() {} } as any;
await marksPlugin(ctx)();
export const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, paragraph: { content: 'text*', group: 'block' },
  blockquote: { content: 'block+', group: 'block' },
  bullet_list: { content: 'list_item+', group: 'block' }, ordered_list: { content: 'list_item+', group: 'block' },
  list_item: { content: 'paragraph block*' }, table: { content: 'table_row+', group: 'block' },
  table_row: { content: '(table_cell | table_header)+' }, table_cell: { content: 'block+' }, table_header: { content: 'block+' },
  heading: { content: 'text*', group: 'block' }, code_block: { content: 'text*', group: 'block', code: true }, text: { group: 'inline' },
}, marks: { strong: {}, proofComment: { attrs: { id: { default: null }, by: { default: 'human:Alice' } } }, proofSuggestion: { attrs: { id: { default: null }, kind: { default: 'insert' }, by: { default: 'human:Alice' }, content: { default: null }, createdAt: { default: null }, status: { default: null } }, inclusive: false } } });
export async function pair(nativeOnly = false, connected = true) {
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
      // As the editor's dispatch does (src/editor/index.ts): a no-text update keeps the undo step open.
      if (keepUndoGroupOpen && fixtureOptions.keepUndoGroupOpen) keepUndoGroupOpen(tr);
      if (!production && tr.getMeta(ySyncPluginKey)?.isChangeOrigin) tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata: map.toJSON() });
      view.state = view.state.apply(tr); for (const pv of updates) pv.update?.(view);
    },
    // EditorView.someProp over the state's plugins, first truthy result wins (as ProseMirror does).
    someProp(name: string, f: (prop: any) => unknown) {
      for (const plugin of view.state.plugins) {
        const prop = plugin.props?.[name];
        if (prop == null) continue;
        const result = f(prop.bind ? prop.bind(plugin) : prop);
        if (result) return result;
      }
      return undefined;
    } };
    for (const plugin of plugins) if (plugin.spec.view) updates.push(plugin.spec.view(view));
    map.observe(() => view.dispatch(view.state.tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata: map.toJSON() }).setMeta('addToHistory', false)));
    const native = yUndoPluginKey.getState(view.state)!.undoManager;
    native.clear(); native.stopCapturing();
    // The second argument is ignored by R1a2; R1a3 extends the installed manager.
    const history = History && !nativeOnly ? new (History as any)(doc, native, view) : null;
    let style = nativeOnly ? 'proof' : 'playmaker';
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
  if (connected) a.on('update', (u, o) => { if (o !== 'remote') Y.applyUpdate(b, u, 'remote'); });
  if (connected) b.on('update', (u, o) => { if (o !== 'remote') Y.applyUpdate(a, u, 'remote'); });
  return { alice, bob, close() { alice.close(); bob.close(); } };
}
