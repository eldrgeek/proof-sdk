/** ac-12r: hidden-line Set is built once per fold state, not per isHidden call. */
import assert from 'node:assert/strict';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, Plugin } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { extractLines } from '../shared/line-marks';
import { initialShown } from '../shared/folded-view';
import {
  FoldHiddenLineCache,
  hiddenLineSetBuildCount,
  resetHiddenLineSetBuildCountForTests,
} from '../shared/folding-hidden-lines';
import { applyFoldTransaction, emptyFoldState, foldViewKey } from '../editor/plugins/fold-view';

const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, text: { group: 'inline' },
  paragraph: { group: 'block', content: 'inline*' },
  heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 } } },
} });
const p = (text = '') => schema.node('paragraph', null, text ? schema.text(text) : undefined);
const h = (level: number, text: string) => schema.node('heading', { level }, schema.text(text));
const doc = schema.node('doc', null, Array.from({ length: 40 }, (_, i) => (i % 5 === 0 ? h(2, `Section ${i}`) : p(`Line ${i}`))));

const lines = extractLines(doc);
const openIndices = new Set([lines[1].index, lines[7].index, lines[13].index]);
const shown = initialShown(doc, openIndices);

const foldPlugin = new Plugin({
  key: foldViewKey,
  state: {
    init: (_, edState) => applyFoldTransaction(
      edState.tr.setMeta(foldViewKey, {
        ready: true,
        whole: false,
        shown,
        expanded: new Set<number>(),
        context: new Set<number>(),
        open: new Set([...openIndices].map(i => lines[i].pos)),
      }),
      emptyFoldState(),
    ),
    apply: (tr, value) => applyFoldTransaction(tr, value),
  },
});

const editorState = EditorState.create({ doc, plugins: [foldPlugin] });
const view = {
  state: editorState,
  dispatch(tr: typeof editorState.tr) {
    this.state = this.state.apply(tr);
  },
} as unknown as EditorView;

const fold = foldViewKey.getState(view.state)!;
const foldHidden = { whole: fold.whole, clean: fold.clean, visible: fold.visible };
const cache = new FoldHiddenLineCache();

resetHiddenLineSetBuildCountForTests();
const n = lines.length;
for (let i = 0; i < n; i += 1) cache.isHidden(lines, foldHidden, i);
assert.equal(hiddenLineSetBuildCount, 1, `expected one hidden-line Set build for ${n} isHidden calls, got ${hiddenLineSetBuildCount}`);

cache.invalidate();
resetHiddenLineSetBuildCountForTests();
for (let i = 0; i < n; i += 1) {
  if (cache.isHidden(lines, foldHidden, i)) cache.isHidden(lines, foldHidden, Math.max(0, i - 1));
}
assert.equal(hiddenLineSetBuildCount, 1, `repeated isHidden over ${n} lines should rebuild the Set once, got ${hiddenLineSetBuildCount}`);

cache.invalidate();
resetHiddenLineSetBuildCountForTests();
cache.isHidden(lines, foldHidden, 0);
cache.isHidden(lines, foldHidden, 1);
assert.equal(hiddenLineSetBuildCount, 1, 'second isHidden after one build should not rebuild');

console.log('✓ isHidden over many lines builds the hidden-line Set once');
console.log('✓ invalidation rebuilds on the next lookup only');
