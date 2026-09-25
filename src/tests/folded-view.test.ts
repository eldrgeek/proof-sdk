/** ac-2a8: real ProseMirror positions, structural items, and view-only transactions. */
import assert from 'node:assert/strict';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';
import { extractLines } from '../shared/line-marks';
import { FOLDED_VIEW_POLICY, foldedStructure, initialShown, hiddenRuns, hiddenRunLabel, foldedCountText, structuralPaths, withPaths, mapShown } from '../shared/folded-view';
import { applyFoldTransaction, emptyFoldState, foldViewKey, FOLD_USER_EDIT, transactionTouchesHidden } from '../editor/plugins/fold-view';
const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, text: { group: 'inline' },
  paragraph: { group: 'block', content: 'inline*' },
  heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 } } },
  ordered_list: { group: 'block', content: 'list_item+', attrs: { order: { default: 1 } } },
  bullet_list: { group: 'block', content: 'list_item+' }, list_item: { content: 'paragraph block*' },
  table: { group: 'block', content: 'table_row+' }, table_row: { content: 'table_cell+' }, table_cell: { content: 'paragraph+' },
} });
const p = (text = '') => schema.node('paragraph', null, text ? schema.text(text) : undefined);
const h = (level: number, text: string) => schema.node('heading', { level }, schema.text(text));
const li = (text: string, nested?: ReturnType<typeof p>) => schema.node('list_item', null, nested ? [p(text), nested] : p(text));
const doc = schema.node('doc', null, [h(1, 'Title'), p('Opening'), h(2, 'List'), schema.node('ordered_list', null, [1,2,3,4,5,6].map(n => li(`Entry ${n}`))), h(2, 'Nested'), h(3, 'Path'), p('Open nested'), p('Hidden nested'), h(2, 'Quiet'), p('Quiet body')]);
const lines = extractLines(doc);
const idx = (text: string) => lines.find(l => l.text === text)!.index;
const opens = new Set([idx('Entry 3'), idx('Entry 5'), idx('Open nested')]);
const initial = initialShown(doc, opens);
const texts = (positions: ReadonlySet<number>, ls = lines) => ls.filter(l => positions.has(l.pos)).map(l => l.text);
let passed = 0;
function test(name: string, run: () => void) { run(); console.log(`✓ ${name}`); passed++; }
function foldingState() {
  return applyFoldTransaction(EditorState.create({ doc }).tr.setMeta(foldViewKey, { ready: true, shown: initial, open: new Set([...opens].map(i => lines[i].pos)) }), emptyFoldState());
}
test('P5 switches and agreed view choices are explicit', () => {
  assert.equal(FOLDED_VIEW_POLICY.startsFoldedEachVisit, true); assert.equal(FOLDED_VIEW_POLICY.holdsStillWhileReading, true);
  assert.equal(FOLDED_VIEW_POLICY.countLine, true); assert.equal(FOLDED_VIEW_POLICY.loadTimeoutMs, 5000);
});
test('a sole highest first heading is a title; opening and top sections are separate', () => {
  const s = foldedStructure(lines); assert.equal(s.title, 0); assert.deepEqual(s.opening, [1]);
  assert.deepEqual(s.top.map(s => lines[s.headingIndex].text), ['List', 'Nested', 'Quiet']);
});
test('peer headings are sections, not a title; headings after prose cannot be titles', () => {
  const peers = extractLines(schema.node('doc', null, [h(1,'A'),p('a'),h(1,'B'),p('b')]));
  assert.equal(foldedStructure(peers).title, null); assert.equal(foldedStructure(peers).top.length, 2);
  assert.equal(foldedStructure(extractLines(schema.node('doc', null, [p('opening'),h(2,'A')]))).title, null);
});
test('a document without headings has only an opening; open lines still show', () => {
  const plain = schema.node('doc', null, [p('a'),p('b'),p('c')]);
  assert.deepEqual(foldedStructure(extractLines(plain)).opening, [0,1,2]);
  assert.deepEqual(texts(initialShown(plain,new Set([1])),extractLines(plain)), ['b']);
});
test('arrival shows title, top headings, all open lines and their heading paths', () => {
  assert.deepEqual(texts(initial), ['Title','List','Entry 3','Entry 5','Nested','Path','Open nested','Quiet']);
});
test('nested list entries bring every parent entry and no siblings', () => {
  const nested = schema.node('doc', null, [h(1,'Title'),schema.node('bullet_list',null,[li('parent',schema.node('ordered_list',null,[li('child',schema.node('bullet_list',null,[li('open'),li('sibling')])),li('cousin')])),li('uncle')])]);
  const ls = extractLines(nested);
  assert.deepEqual(texts(initialShown(nested,new Set([ls.find(l => l.text === 'open')!.index])),ls), ['Title','parent','child','open']);
});
test('table rows are atomic and bring their header, without other rows', () => {
  const row = (a: string,b: string) => schema.node('table_row',null,[schema.node('table_cell',null,p(a)),schema.node('table_cell',null,p(b))]);
  const table = schema.node('doc',null,[h(1,'Title'),schema.node('table',null,[row('Header','Value'),row('hidden','a'),row('open','b')])]);
  const ls = extractLines(table), shown = initialShown(table,new Set([3]));
  assert.deepEqual(texts(shown,ls), ['Title','Header | Value','open | b']);
  const state = applyFoldTransaction(EditorState.create({doc:table}).tr.setMeta(foldViewKey,{ready:true,shown}),emptyFoldState());
  assert.equal(state.hidden.length,1); assert.equal(table.nodeAt(state.hidden[0].from)!.type.name,'table_row');
});
test('hidden runs count items, not containers, and labels update without showing new issues', () => {
  const runs = hiddenRuns(lines,initial,opens);
  assert.deepEqual(runs.map(r=>r.label), ['1 item in accord','2 items in accord','1 item in accord','1 item in accord','1 item in accord','1 item in accord']);
  const incoming = new Set([...opens,idx('Entry 2')]);
  assert.equal(hiddenRuns(lines,initial,incoming)[1].label,'2 items, 1 open');
  assert.deepEqual(texts(initial), texts(initialShown(doc,opens)));
  assert.equal(hiddenRunLabel(4,0),'4 items in accord'); assert.equal(hiddenRunLabel(4,1),'4 items, 1 open');
});
test('counts name open for you, waiting on others, and in accord, omitting zero middle', () => {
  assert.equal(foldedCountText(58,6,8),'6 open for you · 2 waiting on others · 50 in accord');
  assert.equal(foldedCountText(58,0,0),'In accord: all 58 items');
  assert.equal(foldedCountText(58,6,6),'6 open for you · 52 in accord');
  assert.equal(foldedCountText(1,0,1),'0 open for you · 1 waiting on others · 0 in accord');
});
test('actual node decorations hide list entries and retain original numbering', () => {
  const state = foldingState();
  assert.equal(state.hidden.filter(r => doc.nodeAt(r.from)!.type.name === 'list_item').length,4);
  const values = state.decorations.find().map(d => (d as any).type.attrs?.value).filter(Boolean);
  assert.deepEqual(values,['1','2','3','4','5','6']);
});
test('editing shown words and inserting above them preserves shown positions, not hashes', () => {
  const selected = lines[idx('Entry 3')];
  const tr = EditorState.create({doc}).tr.insertText('changed ',selected.pos+1);
  const next = applyFoldTransaction(tr,foldingState());
  assert.ok(texts(next.visible,extractLines(tr.doc)).includes('changed Entry 3'));
  const insert = EditorState.create({doc}).tr.insert(0,p('remote insertion'));
  const moved = mapShown(initial,lines,extractLines(insert.doc),insert.mapping);
  assert.deepEqual(texts(moved,extractLines(insert.doc)),texts(initial));
});
test('a shown node survives a change of kind; deleting it does not expose its neighbour', () => {
  const tr = EditorState.create({doc}).tr.setNodeMarkup(0,schema.nodes.paragraph);
  assert.ok(texts(applyFoldTransaction(tr,foldingState()).visible,extractLines(tr.doc)).includes('Title'));
  const line = lines[idx('Entry 3')];
  const remove = EditorState.create({doc}).tr.delete(line.pos - 1,line.pos + line.nodeSize + 1);
  const next = applyFoldTransaction(remove,foldingState());
  assert.ok(!texts(next.visible,extractLines(remove.doc)).includes('Entry 4'));
});
test('Enter creates a visible empty item, and the first typed letter stays visible', () => {
  const line = lines[idx('Entry 5')], at = line.pos+line.nodeSize-1;
  const tr = EditorState.create({doc}).tr.split(at,2).setMeta(FOLD_USER_EDIT,true);
  const blank = at+4;
  tr.setSelection(TextSelection.create(tr.doc,blank));
  const state = applyFoldTransaction(tr,foldingState());
  assert.ok(!state.hidden.some(r => blank>=r.from && blank<r.to));
  const typed = EditorState.create({doc:tr.doc}).tr.insertText('new',blank).setMeta(FOLD_USER_EDIT,true);
  assert.ok(texts(applyFoldTransaction(typed,state).visible,extractLines(typed.doc)).includes('new'));
});
test('remote edits inside hidden lines stay hidden; accepting open lines keeps them shown', () => {
  const line = lines[idx('Entry 2')];
  const tr = EditorState.create({doc}).tr.insertText('remote ',line.pos+1);
  const next = applyFoldTransaction(tr,foldingState());
  assert.ok(!texts(next.visible,extractLines(tr.doc)).includes('remote Entry 2'));
  const accepted = applyFoldTransaction(EditorState.create({doc}).tr.setMeta(foldViewKey,{open:new Set()}),foldingState());
  assert.deepEqual(texts(accepted.visible),texts(initial));
});
test('a jump exposes only its item and context; a rule exposes exactly its run', () => {
  const target = lines[idx('Hidden nested')];
  const jumped = withPaths(lines,new Set([...initial,target.pos]),structuralPaths(doc,lines));
  assert.deepEqual(texts(jumped).filter(t=>!texts(initial).includes(t)),['Hidden nested']);
  const run=hiddenRuns(lines,initial,opens)[1], shown=new Set(initial);
  for(const line of lines.slice(run.from,run.to)) shown.add(line.pos);
  assert.deepEqual(texts(withPaths(lines,shown,structuralPaths(doc,lines))).filter(t=>!texts(initial).includes(t)),['Entry 1','Entry 2']);
});
test('typing, paste and deletion across hidden text are refused; visible input is allowed', () => {
  const state = foldingState(), a=lines[idx('Entry 3')], b=lines[idx('Entry 5')];
  assert.equal(transactionTouchesHidden(EditorState.create({doc}).tr.insertText('x',a.pos+2,b.pos+2),state.hidden),true);
  assert.equal(transactionTouchesHidden(EditorState.create({doc}).tr.delete(a.pos+2,b.pos+2),state.hidden),true);
  assert.equal(transactionTouchesHidden(EditorState.create({doc}).tr.insertText('x',a.pos+2),state.hidden),false);
  // The actual join step used by Backspace at the next paragraph boundary.
  const plain=schema.node('doc',null,[p('visible'),p('hidden'),p('next')]);
  const ls=extractLines(plain), hidden=[{from:ls[1].pos,to:ls[1].pos+ls[1].nodeSize}];
  assert.equal(transactionTouchesHidden(EditorState.create({doc:plain}).tr.join(ls[2].pos),hidden),true);
  assert.equal(transactionTouchesHidden(EditorState.create({doc:plain}).tr.join(ls[1].pos),hidden),true);
});
test('remote, decision and history transactions remain applicable even across hidden items', () => {
  const a=lines[idx('Entry 3')], b=lines[idx('Entry 5')];
  for(const meta of ['remote','proofMarkAction','history$']) {
    const tr=EditorState.create({doc}).tr.delete(a.pos+2,b.pos+2).setMeta(meta,true);
    assert.doesNotThrow(()=>applyFoldTransaction(tr,foldingState()));
  }
});
test('whole and agreed copy have no hidden decorations; returning preserves the visit', () => {
  for(const flag of ['whole','clean']) {
    const state=applyFoldTransaction(EditorState.create({doc}).tr.setMeta(foldViewKey,{[flag]:true}),foldingState());
    assert.equal(state.decorations.find().length,0);
    const restored=applyFoldTransaction(EditorState.create({doc}).tr.setMeta(foldViewKey,{[flag]:false}),state);
    assert.deepEqual(texts(restored.visible),texts(initial));
  }
});
console.log(`\nfolded-view tests: ${passed} passed`);
