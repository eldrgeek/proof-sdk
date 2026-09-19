// Proof Documents — UX consistency pass (Mike, 2026-09-19): the one Undo, "reject after accept",
// "? means clarify", the no-Issue section auto-close, hover peek, and "an unfolded thing does not
// refold". Pure units only (no DOM): the browser behaviour is checked by
// scripts/ux-consistency-check.mjs.
// Authorship: Claude Opus 5 (worker proof-ux2), 2026-09-19, in the style of folding.test.ts.
import assert from 'node:assert/strict';

const { UndoStack, UNDO_POLICY, conflictRefusal, describeLineMark } = await import('../shared/undo');
const { detectClarify, clarifyQuestion, lastSentence, CLARIFY_POLICY } = await import('../shared/clarify');
const {
  SECTION_AUTOCLOSE, planAutoClose, foldToLevelRespectingSticky, foldToLevel, computeSections,
} = await import('../shared/folding');
const { SETTLED_DECISION_POLICY } = await import('../shared/settled-decision');
const serverLines = await import('../../server/line-marks');

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
// Items 4 and 6 — auto-close, and "an unfolded thing does not refold"
// ============================================================================

const markdown = [
  '# Title', 'Intro paragraph that is long enough to read.',
  '## Quiet', 'Quiet body one.', 'Quiet body two.',
  '## Noisy', 'Noisy body one.', 'Noisy body two.',
  '## Tiny', 'One line only.',
].join('\n\n');
const lines = await serverLines.computeServerLines(markdown);
const sections = computeSections(lines);
const byText = (text: string) => sections.find(s => lines[s.headingIndex].text === text)!;
const quiet = byText('Quiet');
const noisy = byText('Noisy');
const tiny = byText('Tiny');

const plan = (over: Partial<Parameters<typeof planAutoClose>[0]> = {}) => planAutoClose({
  sections,
  folded: new Set<string>(),
  sticky: new Set<string>(),
  focusLine: lines.length - 1,
  issueTotal: section => (section.key === noisy.key ? 3 : 0),
  inView: () => false,
  ...over,
});

await test('a section with no Issues closes itself once the reader has left it', () => {
  assert.deepEqual(plan(), [quiet.key], 'only the quiet, big-enough, out-of-view section closed');
});

await test('a section with Issues never closes itself', () => {
  assert.ok(!plan().includes(noisy.key));
  assert.deepEqual(plan({ issueTotal: () => 0 }).includes(noisy.key), true);
});

await test('nothing closes while it is in view or holds the focus (nothing moves under the reader)', () => {
  assert.deepEqual(plan({ inView: () => true }), [], 'closed a section the reader can see');
  assert.deepEqual(plan({ focusLine: quiet.headingIndex + 1 }), [], 'closed the section the focus is in');
});

await test('a one-line section is too small to be worth closing', () => {
  assert.ok(!plan({ issueTotal: () => 0 }).includes(tiny.key));
  assert.ok(tiny.lineEnd - tiny.headingIndex - 1 < SECTION_AUTOCLOSE.minBodyLines);
});

await test('item 6: a section the person unfolded by hand never auto-closes', () => {
  assert.deepEqual(plan({ sticky: new Set([quiet.key]) }), [], 'auto-close refolded a hand-unfolded section');
});

await test('item 6: fold-to-level leaves hand-unfolded sections alone', () => {
  const raw = foldToLevel(sections, 2);
  assert.ok(raw.has(quiet.key), 'fold-to-level 2 normally folds the H2s');
  const kept = foldToLevelRespectingSticky(sections, 2, new Set([quiet.key]));
  assert.ok(!kept.has(quiet.key), 'fold-to-level refolded a hand-unfolded section');
  assert.ok(kept.has(noisy.key), 'it stopped folding the other sections too');
});

await test('the model is switchable in one line where Mike may want it otherwise', () => {
  assert.equal(SECTION_AUTOCLOSE.respectStickyUnfold, true);
  assert.equal(SECTION_AUTOCLOSE.requireOutOfView, true);
  assert.equal(SECTION_AUTOCLOSE.hoverPeek, true);
  assert.ok(SECTION_AUTOCLOSE.idleMs >= 500, 'a fold must never land mid-gesture');
});

console.log(`\nux-consistency tests: ${passed} passed`);
