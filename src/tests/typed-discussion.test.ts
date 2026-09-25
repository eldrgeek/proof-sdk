/** ac-yoc: classifier, actual PM item boundaries, and the real withdrawal/history path. */
import assert from 'node:assert/strict';
import { Schema } from '@milkdown/kit/prose/model';
import { TextSelection } from '@milkdown/kit/prose/state';
import { classifyTypedRun, isRunAtItemEnd, typedItemAt, typedDiscussionId, typedDiscussionInsertId } from '../shared/typed-discussion';
import { pair } from './review-history-fixture';
import { setCurrentActor } from '../editor/actor';
import { getMarks, comment, getMarkMetadataWithQuotes, clearResolvedMarkTombstones } from '../editor/plugins/marks';
import { wrapTransactionForSuggestions, rejectionTransaction } from '../editor/plugins/suggestions';
import { installLocalWriteResyncPolicy } from '../editor/local-write-resync';
import { isPendingSuggestion } from '../shared/suggestion-status';
installLocalWriteResyncPolicy();
let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log(`✓ ${name}`); }
const candidates = [{ actor: 'human:Mike', names: ['Mike Wolf', 'Mike'] }, { actor: 'ai:Ren', names: ['Ren'] }];
for (const text of ['Why?', ' “Why?” ', 'Why?)]', 'Why?   ']) test(`question ${JSON.stringify(text)}`, () => {
  assert.deepEqual(classifyTypedRun(text, candidates), { discussion: true, reason: 'question', waitingOn: [] });
});
for (const text of ['Is it? Yes.', '@Nobody look', 'mike@example.com', '@Mike@example.com', '', '   ', 'Text.']) {
  test(`literal ${JSON.stringify(text)}`, () => assert.deepEqual(classifyTypedRun(text, candidates), { discussion: false }));
}
test('a leading longest known mention waits only on its actor', () => {
  assert.deepEqual(classifyTypedRun(' @MIKE Wolf please look', candidates), { discussion: true, reason: 'mention', waitingOn: ['human:Mike'] });
  assert.deepEqual(classifyTypedRun('@Ren why?', candidates), { discussion: true, reason: 'mention', waitingOn: ['ai:Ren'] });
  assert.deepEqual(classifyTypedRun('@Renegade please look', candidates), { discussion: false });
  assert.deepEqual(classifyTypedRun('@Ren. Please look', candidates), { discussion: true, reason: 'mention', waitingOn: ['ai:Ren'] });
});
test('an ambiguous name stays literal', () => assert.deepEqual(classifyTypedRun('@Mike please look', [...candidates, { actor: 'human:Other', names: ['Mike'] }]), { discussion: false }));
test('thread ID survives a reload without a new record shape', () => assert.equal(typedDiscussionInsertId(typedDiscussionId('insert-1')), 'insert-1'));
const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, text: { group: 'inline' }, paragraph: { group: 'block', content: 'inline*' },
  heading: { group: 'block', content: 'inline*' }, code_block: { group: 'block', content: 'text*' },
  bullet_list: { group: 'block', content: 'list_item+' }, list_item: { content: 'paragraph block*' },
  table: { group: 'block', content: 'table_row+' }, table_row: { content: 'table_cell+' }, table_cell: { content: 'paragraph+' },
} });
const p = (text: string) => schema.node('paragraph', null, schema.text(text));
const itemDoc = schema.node('doc', null, [p('Base Why?   '), p('Middle? suffix'), schema.node('heading', null, schema.text('Heading?')),
  schema.node('bullet_list', null, [schema.node('list_item', null, [p('List question?'), p('Later paragraph')]), schema.node('list_item', null, p('Last entry?'))]),
  schema.node('table', null, schema.node('table_row', null, [schema.node('table_cell', null, p('First cell?')), schema.node('table_cell', null, p('Last cell?'))])),
  schema.node('code_block', null, schema.text('Code?'))]);
const range = (quote: string) => {
  let found: { from: number; to: number } | undefined;
  itemDoc.descendants((node, pos) => { if (node.isText && node.text!.includes(quote)) found = { from: pos + node.text!.indexOf(quote), to: pos + node.text!.indexOf(quote) + quote.length }; });
  assert(found); return found;
};
for (const quote of ['Why?', 'Heading?', 'Last entry?', 'Last cell?']) test(`end of item: ${quote}`, () => assert(isRunAtItemEnd(itemDoc, range(quote))));
for (const quote of ['Middle?', 'List question?', 'First cell?', 'Code?']) test(`not end of an eligible item: ${quote}`, () => assert(!isRunAtItemEnd(itemDoc, range(quote))));
test('table row contains both cells', () => assert.equal(typedItemAt(itemDoc, range('Last cell?').from)?.kind, 'table_row'));

const peers = await pair();
try {
  setCurrentActor('human:Alice');
  const a = peers.alice, b = peers.bob;
  const initial = a.view.state.doc.textContent;
  a.edit(() => a.view.dispatch(wrapTransactionForSuggestions(a.view.state.tr.setSelection(TextSelection.create(a.view.state.doc, 9)).insertText(' Why?', 9), a.view.state, true)));
  const run = getMarks(a.view.state).find(mark => mark.kind === 'insert')!;
  assert(run?.range);
  assert.equal(b.view.state.doc.textContent, a.view.state.doc.textContent);
  let commentId = '';
  a.history.decide(() => {
    const tr = rejectionTransaction(a.view.state, run.id); assert(tr); a.view.dispatch(tr);
    commentId = comment(a.view, 'Original', 'human:Alice', 'Why?', { from: 1, to: 9 }).id;
  });
  const checkpoint = a.history.checkpoint();
  test('conversion records a withdrawal and leaves no pending run on either peer', () => {
    for (const peer of [a, b]) {
      assert.equal(peer.view.state.doc.textContent, initial);
      assert.equal(peer.map.get(run.id).status, 'rejected');
      assert.equal(peer.map.get(run.id).resolvedBy, 'human:Alice');
      assert(!isPendingSuggestion(peer.map.get(run.id)));
      assert.equal(peer.map.get(commentId).text, 'Why?');
    }
  });
  test('one native Undo restores the exact live run and removes its comment', () => {
    assert(a.history.canRestoreCheckpoint(checkpoint));
    clearResolvedMarkTombstones([run.id]);
    assert(a.restore());
    for (const peer of [a, b]) {
      assert.equal(peer.view.state.doc.textContent, initial.replace('Original', 'Original Why?'));
      assert.equal(peer.map.get(run.id).status, 'pending');
      assert(!getMarkMetadataWithQuotes(peer.view.state)[commentId]);
    }
  });
} finally { peers.close(); }
console.log(`${passed} typed discussion checks passed`);

// Exercise the production event controller with real PM/Yjs state. Only layout and
// event targets are stand-ins; Chromium remains the reviewer gate for actual DOM routing.
const { TypedDiscussionController } = await import('../editor/typed-discussion');
class EventElement extends EventTarget {
  style = { cssText: '', left: '', top: '' }; hidden = false; className = ''; textContent = '';
  setAttribute() {} remove() {} contains(target: unknown) { return target === this; }
}
class EventDocument extends EventTarget {
  hidden = false;
  body = { append() {} };
  head = { appendChild() {} };
  createElement() { return new EventElement(); }
}
async function controllerCase(name: string, fn: (input: {
  view: any; controller: InstanceType<typeof TypedDiscussionController>; doc: EventDocument; dom: EventElement;
  sent: string[]; end: number; key: (key: string, shift?: boolean) => Event;
}) => Promise<void>, local = true) {
  const savedDocument = globalThis.document;
  const savedWindow = globalThis.window;
  const peers = await pair();
  const doc = new EventDocument(), dom = new EventElement(), sent: string[] = [];
  (globalThis as any).document = doc; (globalThis as any).window = { innerWidth: 1440 };
  const view = peers.alice.view;
  view.dom = dom; view.coordsAtPos = () => ({ left: 100, right: 101, top: 200, bottom: 220 });
  let focused = false; view.hasFocus = () => focused;
  const controller = new TypedDiscussionController(view, {
    enabled: () => true, candidates: () => candidates, convert: async run => { sent.push(run.text); }, notice: message => { throw Error(message); },
  });
  try {
    setCurrentActor('human:Alice');
    peers.alice.edit(() => view.dispatch(wrapTransactionForSuggestions(view.state.tr.setSelection(TextSelection.create(view.state.doc, 9)).insertText(' Why?', 9), view.state, true)));
    focused = true;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 14)));
    controller.update(local); await Promise.resolve();
    const key = (key: string, shift = false) => {
      const event = Object.assign(new Event('keydown', { cancelable: true }), { key, shiftKey: shift, isComposing: false });
      dom.dispatchEvent(event); return event;
    };
    await fn({ view, controller, doc, dom, sent, end: 14, key });
    console.log(`✓ ${name}`); passed++;
  } finally { controller.stop(); focused = false; peers.close(); (globalThis as any).document = savedDocument; (globalThis as any).window = savedWindow; }
}
await controllerCase('controller keeps typing live until Enter ends it, and swallows the split', async ({ sent, key }) => {
  await Promise.resolve(); assert.deepEqual(sent, []);
  assert.equal(key('Enter').defaultPrevented, true); assert.deepEqual(sent, [' Why?']);
  key('Enter'); assert.equal(sent.length, 1);
});
await controllerCase('controller ends on focus loss (including editing-guard Escape)', async ({ dom, sent }) => {
  dom.dispatchEvent(Object.assign(new Event('focusout'), { relatedTarget: null })); assert.deepEqual(sent, [' Why?']);
});
await controllerCase('controller ends when the page is hidden', async ({ doc, sent }) => {
  doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange')); assert.deepEqual(sent, [' Why?']);
});
await controllerCase('moving within the item keeps typing; leaving the item sends', async ({ view, controller, sent }) => {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3))); controller.update(); await Promise.resolve();
  assert.deepEqual(sent, []);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 16))); controller.update(); await Promise.resolve();
  assert.deepEqual(sent, [' Why?']);
});
await controllerCase('Shift+Enter retains text even on later blur', async ({ key, dom, sent }) => {
  assert.equal(key('Enter', true).defaultPrevented, false);
  dom.dispatchEvent(Object.assign(new Event('focusout'), { relatedTarget: null })); assert.deepEqual(sent, []);
});
await controllerCase('phone insertParagraph has the same end gesture', async ({ dom, sent }) => {
  const event = Object.assign(new Event('beforeinput', { cancelable: true }), { inputType: 'insertParagraph', isComposing: false });
  dom.dispatchEvent(event); assert(event.defaultPrevented); assert.deepEqual(sent, [' Why?']);
});
await controllerCase('an API insert by the same actor is never an active typing run', async ({ key, sent }) => {
  assert.equal(key('Enter').defaultPrevented, false); assert.deepEqual(sent, []);
}, false);
console.log(`${passed} typed discussion checks passed (including event controller)`);
