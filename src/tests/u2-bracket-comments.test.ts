import assert from 'node:assert/strict';
import { extractBracketComments, scanBrackets } from '../formats/bracket-comments';
const source = 'First sentence. Second [[Explain why.]] sentence. Third sentence.';
for (const mode of ['typing', 'pasting', 'API']) {
  const by = mode === 'API' ? 'ai:Test' : 'human:Reader';
  const result = extractBracketComments(source, by);
  assert.equal(result.markdown, 'First sentence. Second  sentence. Third sentence.');
  assert.equal(result.comments.length, 1); assert.equal(result.comments[0].text, 'Explain why.');
  assert.equal(result.comments[0].quote, 'Second  sentence.'); assert.equal(result.comments[0].by, by);
}
const above = extractBracketComments('The paragraph above.\n\n[[A separate note]]', 'human:Reader');
assert.equal(above.comments[0].quote, 'The paragraph above.');
const escaped = String.raw`Literal \[[words\]] and [[real \]] comment]].`;
const result = extractBracketComments(escaped, 'ai:Test');
assert.equal(result.comments.length, 1); assert.equal(result.comments[0].text, 'real ]] comment');
assert.equal(result.markdown, String.raw`Literal \[[words\]] and .`);
assert.equal(extractBracketComments(result.markdown, 'ai:Test').comments.length, 0, 'reload cannot convert escapes');
assert.equal(scanBrackets('[[incomplete').length, 0);
assert.equal(extractBracketComments('`[[code]]`\n\n```\n[[also code]]\n```', 'ai:Test').comments.length, 0);
assert.equal(extractBracketComments('[[alone]]', 'human:Reader').markdown, '[[alone]]', 'No anchor means no discarded text');
console.log('✓ bracket conversion, sentence/paragraph anchors, escapes, reload and code literals');

const { getHeadlessMilkdownParser, serializeMarkdown } = await import('../../server/milkdown-headless');
const engine = await getHeadlessMilkdownParser();
const literalSource = String.raw`Before \[[literal\]] after.`;
const parsed = engine.parseMarkdown(literalSource);
assert.equal(parsed.textContent, 'Before [[literal]] after.');
const stored = await serializeMarkdown(parsed);
assert(stored.includes(String.raw`\[[`)); assert(stored.includes(String.raw`\]]`));
assert.equal(engine.parseMarkdown(stored).textContent, parsed.textContent);
const { EditorState } = await import('@milkdown/kit/prose/state');
const { history, undo } = await import('@milkdown/kit/prose/history');
const { bracketCommentTransaction } = await import('../editor/plugins/bracket-comments');
const { marksPlugin, getMarks } = await import('../editor/plugins/marks');
(globalThis as any).document = { createElement: () => ({}), head: { appendChild() {} } };
await marksPlugin({ wait: async () => {}, update() {} } as any)();
for (const mode of ['typing', 'pasting']) {
  let state = EditorState.create({ schema: engine.schema, doc: engine.parseMarkdown(source), plugins: [marksPlugin.plugin(), history()] });
  const tr = bracketCommentTransaction(state, 'human:Reader'); assert(tr); state = state.apply(tr);
  assert.equal(getMarks(state).filter(m => m.kind === 'comment').length, 1);
  assert(!state.doc.textContent.includes('[['));
  assert(undo(state, undoTr => { state = state.apply(undoTr); }));
  assert(state.doc.textContent.includes('[[Explain why.]]'), `${mode}: one undo restores full bracket text`);
  assert.equal(getMarks(state).filter(m => m.kind === 'comment').length, 0);
}
console.log('✓ editor transaction conversion/undo and escaped Markdown schema roundtrip');
