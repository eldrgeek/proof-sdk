// Closed Issues fold for the person who closed them (src/shared/closed-fold.ts): pure rules.
// A closure folds its line after the settle; an accept that rewrites the line is followed by index;
// an edit or anything new on the line reopens it; a line still carrying something open does not
// fold; expand / Unfold closed / Fold closed; headings do not fold; storage round trip.
// Authorship: Claude Opus 5 (worker proof-hover), 2026-09-19.
import assert from 'node:assert/strict';
import { CLOSED_FOLD_POLICY, ClosedFoldState, summaryFor, type ClosedLineInput } from '../shared/closed-fold';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const L = (index: number, key: string, text = `Line ${index} has some words in it for the summary to show`, open: string[] = [], kind = 'paragraph'): ClosedLineInput =>
  ({ index, key, kind, text, open });
const lines = (): ClosedLineInput[] => [L(0, 'h:0', 'Heading', [], 'heading'), L(1, 'a:0'), L(2, 'b:0'), L(3, 'c:0')];
const SETTLE = CLOSED_FOLD_POLICY.settleMs;

test('a closure folds its line only after the settle', () => {
  const s = new ClosedFoldState();
  s.note(2, 'b:0', 'agreed', 1000);
  s.sync(lines(), 1000 + 10);
  assert.deepEqual(s.folded(lines()), []);
  s.sync(lines(), 1000 + SETTLE);
  const folded = s.folded(lines());
  assert.equal(folded.length, 1);
  assert.equal(folded[0].index, 2);
  assert.match(folded[0].summary, /^✓ agreed — Line 2 has some words in it for…$/);
});

test('an accepted change rewrites the line during the settle: the record follows it by index', () => {
  const s = new ClosedFoldState();
  s.note(1, 'a:0', 'accepted', 0);
  const after = lines(); after[1] = L(1, 'a2:0', 'Line 1 after the accept');
  s.sync(after, 50);
  s.sync(after, SETTLE);
  assert.deepEqual(s.folded(after).map(f => f.index), [1]);
});

test('an edit after the settle reopens the line (the record stays dormant)', () => {
  const s = new ClosedFoldState();
  s.note(3, 'c:0', 'rejected', 0);
  s.sync(lines(), SETTLE);
  assert.equal(s.folded(lines()).length, 1);
  const edited = lines(); edited[3] = L(3, 'c-edited:0');
  s.sync(edited, SETTLE + 1000);
  assert.deepEqual(s.folded(edited), []);
  // Dormant, not lost: a page still loading its text does not wipe the viewer's folds.
  assert.equal(s.list().length, 1);
  s.sync(lines(), SETTLE + 2000);
  assert.deepEqual(s.folded(lines()).map(f => f.index), [3]);
});

test('a new suggestion, reply or ask on a folded line reopens it', () => {
  for (const item of ['s:new:0', 'c:m1:1', 'a:ask1', 'o:obj1']) {
    const s = new ClosedFoldState();
    s.note(2, 'b:0', 'resolved', 0);
    s.sync(lines(), SETTLE);
    const now = lines(); now[2] = L(2, 'b:0', undefined, [item]);
    s.sync(now, SETTLE + 10);
    assert.deepEqual(s.folded(now), [], item);
  }
});

test('a closure on a line that still carries something open for me does not fold', () => {
  const s = new ClosedFoldState();
  const open = lines(); open[1] = L(1, 'a:0', undefined, ['s:other:0']);
  s.note(1, 'a:0', 'agreed', 0);
  s.sync(open, SETTLE);
  assert.deepEqual(s.folded(open), []);
  assert.equal(s.list().length, 0);
});

test('headings and other kinds outside foldableKinds never fold', () => {
  const s = new ClosedFoldState();
  s.note(0, 'h:0', 'agreed', 0);
  s.sync(lines(), SETTLE);
  assert.deepEqual(s.folded(lines()), []);
});

test('expand opens one line; Unfold closed opens all; Fold closed restores every fold', () => {
  const s = new ClosedFoldState();
  s.note(1, 'a:0', 'agreed', 0);
  s.note(2, 'b:0', 'approved', 0);
  s.sync(lines(), SETTLE);
  assert.equal(s.folded(lines()).length, 2);
  assert.equal(s.expand('a:0'), true);
  assert.deepEqual(s.folded(lines()).map(f => f.index), [2]);
  assert.equal(s.expandedCount(), 1);
  s.unfoldAll();
  assert.deepEqual(s.folded(lines()), []);
  assert.equal(s.expandedCount(), 2);
  s.foldAll();
  assert.deepEqual(s.folded(lines()).map(f => f.index), [1, 2]);
});

test('closing the same line again replaces its record; storage round trip keeps state', () => {
  const s = new ClosedFoldState();
  s.note(1, 'a:0', 'agreed', 0);
  s.note(1, 'a:0', 'rejected', 5);
  assert.equal(s.list().length, 1);
  s.sync(lines(), SETTLE + 5);
  s.expand('a:0');
  const back = ClosedFoldState.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
  assert.equal(back.list().length, 1);
  assert.equal(back.list()[0].kind, 'rejected');
  assert.equal(back.list()[0].expanded, true);
  assert.equal(ClosedFoldState.fromJSON('garbage').list().length, 0);
});

test('nextSettleIn counts down to the earliest unsettled closure', () => {
  const s = new ClosedFoldState();
  assert.equal(s.nextSettleIn(0), null);
  s.note(1, 'a:0', 'agreed', 100);
  assert.equal(s.nextSettleIn(100), SETTLE);
  assert.equal(s.nextSettleIn(100 + SETTLE + 50), 0);
});

test('summaries: label per kind, short lines have no ellipsis, passive reads do not fold by default', () => {
  assert.equal(summaryFor('answered', 'Ship it?'), '✓ answered — Ship it?');
  assert.equal(summaryFor('suggestion-rejected', ''), '✗ change rejected');
  assert.equal(CLOSED_FOLD_POLICY.passiveReadsFold, false);
});

console.log(`\n${passed} closed-fold tests passed`);
