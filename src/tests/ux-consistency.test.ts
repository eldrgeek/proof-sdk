// Proof Documents — UX consistency pass (Mike, 2026-09-19): the one Undo, "reject after accept",
// "? means clarify", the no-Issue section auto-close, hover peek, and "an unfolded thing does not
// refold". Pure units only (no DOM): the browser behaviour is checked by
// scripts/ux-consistency-check.mjs.
// Authorship: Claude Opus 5 (worker proof-ux2), 2026-09-19, in the style of folding.test.ts.
import assert from 'node:assert/strict';

const { UndoStack, UNDO_POLICY, conflictRefusal, describeLineMark } = await import('../shared/undo');
const { detectClarify, clarifyQuestion, lastSentence, CLARIFY_POLICY } = await import('../shared/clarify');
const { SETTLED_DECISION_POLICY } = await import('../shared/settled-decision');

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const ok = () => ({ ok: true } as const);

// ============================================================================
// Item 1 — the one Undo stack
// ============================================================================

await test('the stack reverses the newest action and names it', async () => {
  const stack = new UndoStack();
  const done: string[] = [];
  stack.pushSimple('line-mark', 'agreed line 12', () => { done.push('undo-12'); return ok(); });
  stack.pushSimple('line-mark', 'rejected line 3', () => { done.push('undo-3'); return ok(); });
  assert.equal(stack.depth(), 2);
  assert.equal(stack.next()?.description, 'rejected line 3');
  const first = await stack.undo();
  assert.equal(first.ok, true);
  assert.equal(first.message, 'Undid: rejected line 3');
  const second = await stack.undo();
  assert.equal(second.message, 'Undid: agreed line 12');
  assert.deepEqual(done, ['undo-3', 'undo-12']);
  assert.equal((await stack.undo()).message, 'There is nothing to undo.');
});

await test('an undo that refuses keeps its entry and says why (no clobbering)', async () => {
  const stack = new UndoStack();
  stack.pushSimple('ask-answer', 'answered “Yes” on line 4', () => conflictRefusal('your answer', 'Eric'));
  const result = await stack.undo();
  assert.equal(result.ok, false);
  assert.match(result.message, /Eric changed your answer after you did\. Nothing was overwritten\./);
  assert.equal(stack.depth(), 1, 'the refused entry was dropped');
});

await test('an inverse that throws becomes a refusal, not a crash', async () => {
  const stack = new UndoStack();
  stack.pushSimple('suggestion', 'accepted a change', () => { throw new Error('The editor is still loading.'); });
  const result = await stack.undo();
  assert.equal(result.ok, false);
  assert.equal(result.message, 'The editor is still loading.');
  assert.equal(stack.depth(), 1);
});

await test('redo repeats the action, and a new action clears the redo stack', async () => {
  const stack = new UndoStack();
  const log: string[] = [];
  stack.pushSimple('fold', 'folded “Goals”', () => { log.push('undo'); return ok(); }, () => { log.push('redo'); return ok(); });
  await stack.undo();
  assert.equal(stack.redoDepth(), 1);
  const redone = await stack.redo();
  assert.equal(redone.message, 'Redid: folded “Goals”');
  assert.deepEqual(log, ['undo', 'redo']);
  await stack.undo();
  assert.equal(stack.redoDepth(), 1);
  stack.pushSimple('line-mark', 'agreed line 1', ok);
  assert.equal(stack.redoDepth(), 0, 'a new action did not clear the redo stack');
});

await test('an entry with no redo is not offered for redo', async () => {
  const stack = new UndoStack();
  stack.pushSimple('ratify', 'ratified 9 lines', ok);
  await stack.undo();
  assert.equal(stack.nextRedo(), null);
  assert.equal((await stack.redo()).message, 'There is nothing to redo.');
});

await test('the stack keeps at most UNDO_POLICY.maxEntries, oldest dropped first', () => {
  const stack = new UndoStack();
  for (let i = 0; i < UNDO_POLICY.maxEntries + 12; i += 1) stack.pushSimple('line-mark', `agreed line ${i}`, ok);
  assert.equal(stack.depth(), UNDO_POLICY.maxEntries);
  assert.equal(stack.next()?.description, `agreed line ${UNDO_POLICY.maxEntries + 11}`);
  assert.equal(stack.list()[0].description, `agreed line ${12}`);
});

await test('an action older than the age limit is no longer offered', () => {
  let now = 1_000_000;
  const stack = new UndoStack(() => now);
  stack.pushSimple('line-mark', 'agreed line 1', ok);
  now += UNDO_POLICY.maxAgeMs + 1;
  assert.equal(stack.next(), null);
  assert.equal(stack.depth(), 0);
});

await test('every kind of person action has a description a reader understands', () => {
  assert.equal(describeLineMark('agreed', 11), 'agreed line 12');
  assert.equal(describeLineMark('rejected', 0), 'rejected line 1');
  assert.equal(describeLineMark('unseen', 4), 'cleared your mark on line 5');
  assert.equal(describeLineMark('seen', 2), 'marked line 3 Seen');
});

// ============================================================================
// Item 2 — reject after accept
// ============================================================================

await test('a second decision on a settled mark is refused in words, never silently', () => {
  assert.equal(SETTLED_DECISION_POLICY.onSecondDecision, 'refuse-with-undo');
  assert.match(SETTLED_DECISION_POLICY.words.accepted, /already accepted/);
  assert.match(SETTLED_DECISION_POLICY.words.accepted, /Undo the accept/);
  assert.match(SETTLED_DECISION_POLICY.words.rejected, /Undo the reject/);
  assert.match(SETTLED_DECISION_POLICY.words.resolved, /Undo to reopen/);
});

// ============================================================================
// Item 3 — "?" means clarify
// ============================================================================

await test('a lone ? after a sentence is a clarify request', () => {
  const found = detectClarify('The estate is a place; the team is the mind ?');
  assert.ok(found);
  assert.equal(found!.text, 'The estate is a place; the team is the mind');
  assert.equal(found!.sentence, 'The estate is a place; the team is the mind');
  assert.equal(found!.from, 'The estate is a place; the team is the mind'.length);
  assert.match(clarifyQuestion(found!), /^Please clarify this sentence\. “The estate/);
});

await test('a real question mark in prose is not eaten', () => {
  assert.equal(detectClarify('Is this right?'), null);
  assert.equal(detectClarify('Is this right? '), null);
  assert.equal(detectClarify('Why now??'), null, 'two question marks are prose');
  assert.equal(detectClarify('?'), null, 'a line with only ? asks nothing');
  assert.equal(detectClarify('a ?'), null, 'too little text before it');
  assert.equal(detectClarify('This is fine ? and then more'), null, 'something after it');
  assert.equal(detectClarify(''), null);
});

await test('trailing whitespace after the ? is not "something after it"', () => {
  const found = detectClarify('We ship on Friday ?   ');
  assert.ok(found);
  assert.equal(found!.text, 'We ship on Friday');
  assert.equal(found!.to, 'We ship on Friday ?'.length);
});

await test('the question quotes the sentence the ? followed, not the whole line', () => {
  const found = detectClarify('We agreed in June. The budget doubles in Q4 ?');
  assert.ok(found);
  assert.equal(found!.sentence, 'The budget doubles in Q4');
  assert.equal(lastSentence('One. Two! Three'), 'Three');
});

await test('asking never marks the line and is never an Issue for the asker', () => {
  assert.equal(CLARIFY_POLICY.marksLine, false);
  assert.equal(CLARIFY_POLICY.isIssueForAsker, false);
  assert.equal(CLARIFY_POLICY.inSuggestMode, true, 'the same conversion runs in Suggesting mode');
  assert.deepEqual([...CLARIFY_POLICY.commitOn], ['enter', 'blur']);
});

// ============================================================================
// Folding regressions now live in folding.test.ts and usability-s1-check.mjs.
console.log(`\nux-consistency tests: ${passed} passed`);
