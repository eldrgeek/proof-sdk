// Proof Documents Step 1b: the reading walk state machine (Seen only).
// Authorship: Claude Opus 5 (worker reading-walk), 2026-09-18.
import assert from 'node:assert/strict';
import { READING_WALK, ReadingWalk, countWords, dwellMsFor, type WalkLine, type WalkEvent } from '../shared/reading-walk';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const S = (id: string) => ({ id, kind: 'suggestion' as const });
const C = (id: string) => ({ id, kind: 'comment' as const });
function lines(spec: Array<Array<ReturnType<typeof S> | ReturnType<typeof C>>>): WalkLine[] {
  return spec.map((marks, index) => ({ key: `k${index}`, marks }));
}
const seen = (events: WalkEvent[]) => events.filter(e => e.type === 'seen').map(e => (e as { line: number }).line);

test('the first line is the focus line on open', () => {
  const walk = new ReadingWalk(lines([[], [], []]), 0);
  assert.equal(walk.focus, 0);
  assert.deepEqual(walk.marksOn(0), []);
});

test('dwell: the focus line is read after DWELL_MS, not before', () => {
  const walk = new ReadingWalk(lines([[], [], []]), 1000);
  walk.tick(1000 + READING_WALK.DWELL_MS - 1);
  assert.deepEqual(seen(walk.drain()), []);
  assert.equal(walk.msUntilRead(1000 + READING_WALK.DWELL_MS - 1), 1);
  walk.tick(1000 + READING_WALK.DWELL_MS);
  assert.deepEqual(seen(walk.drain()), [0]);
  walk.tick(5000);
  assert.deepEqual(seen(walk.drain()), [], 'a line is reported read once');
  assert.equal(walk.msUntilRead(5000), 0);
});

test('a line changed by someone else while it is the focus is not read until the reader returns', () => {
  const walk = new ReadingWalk(lines([[], []]), 0);
  walk.setLines([{ key: 'k0-changed', marks: [] }, { key: 'k1', marks: [] }], 100);
  walk.tick(1000);
  assert.deepEqual(seen(walk.drain()), []);
  assert.equal(walk.msUntilRead(1000), 0, 'no timer for a line that changed under the reader');
  walk.moveTo(1, 1100, 'scroll');
  walk.moveTo(0, 1200, 'scroll');
  walk.tick(1200 + READING_WALK.DWELL_MS);
  assert.deepEqual(seen(walk.drain()), [0], 'coming back to it reads the new text');
});

test('scrolling down line by line at reading pace marks each line read', () => {
  const walk = new ReadingWalk(lines([[], [], [], []]), 0);
  walk.moveTo(1, 300, 'scroll');
  walk.moveTo(2, 600, 'scroll');
  walk.moveTo(3, 900, 'scroll');
  assert.deepEqual(seen(walk.drain()), [0, 1, 2]);
});

test('a fling marks nothing Seen: skipped lines and briefly focused lines stay unread', () => {
  const walk = new ReadingWalk(lines([[], [], [], [], [], []]), 0);
  walk.moveTo(1, 10, 'scroll', [30, 30, 30, 30, 30, 30]); // 30 px in 10 ms = 3000 px/s
  walk.moveTo(5, 20, 'scroll', [30, 30, 30, 30, 30, 30]);
  assert.deepEqual(seen(walk.drain()), []);
});

test('Step B3b: the dwell scales with the line\'s words (8 words/s, min 250 ms, cap 6 s)', () => {
  assert.equal(dwellMsFor(undefined), READING_WALK.MIN_DWELL_MS, 'no word count: the shortest dwell');
  assert.equal(dwellMsFor(1), READING_WALK.MIN_DWELL_MS, 'a one-word line still needs the minimum');
  assert.equal(dwellMsFor(8), 1000, '8 words at 8 words/s');
  assert.equal(dwellMsFor(200), READING_WALK.MAX_DWELL_MS, 'long paragraphs are capped');
  assert.equal(dwellMsFor(8, 8), 1000, 'a faster reader: 8 words at 8 words/s');
  assert.equal(dwellMsFor(40, 0), READING_WALK.MIN_DWELL_MS, 'rate 0 = no length rule');
  assert.equal(countWords('The quick brown fox — jumps, over 2 lazy dogs.'), 9);
  assert.equal(countWords("Don't split e.g. or 3.5 or co-op"), 7);
  const walk = new ReadingWalk([{ key: 'long', words: 20, marks: [] }, { key: 'b', words: 2, marks: [] }], 0);
  walk.setRate(4); // these cases were written at 4 words/s; the default is now 8
  walk.tick(4999);
  assert.deepEqual(seen(walk.drain()), [], '20 words need 5 s');
  assert.equal(walk.msUntilRead(4999), 1);
  walk.tick(5000);
  assert.deepEqual(seen(walk.drain()), [0]);
});

test('fast passes record nothing; returning and dwelling records Seen', () => {
  const walk = new ReadingWalk([{ key: 'a', words: 12, marks: [] }, { key: 'b', words: 12, marks: [] }, { key: 'c', words: 12, marks: [] }], 0);
  walk.setRate(4);
  walk.moveTo(2, 100, 'scroll');
  assert.deepEqual(walk.drain().map(event => event.type), ['focus']);
  walk.moveTo(0, 200, 'jump');
  walk.tick(3200);
  assert.deepEqual(seen(walk.drain()), [0]);
});

test('Step B3b: a per-reader rate changes the reading time', () => {
  const walk = new ReadingWalk([{ key: 'a', words: 24, marks: [] }, { key: 'b', words: 4, marks: [] }], 0);
  walk.setRate(4); // these cases were written at 4 words/s; the default is now 8
  assert.equal(walk.dwellFor(0), 6000);
  walk.setRate(12);
  assert.equal(walk.dwellFor(0), 2000);
  walk.moveTo(1, 2000, 'scroll');
  assert.deepEqual(seen(walk.drain()), [0], 'a fast reader at 12 words/s reads 24 words in 2 s');
  walk.setRate(0);
  assert.equal(walk.dwellFor(0), READING_WALK.MIN_DWELL_MS);
  walk.setRate(-3);
  assert.equal(walk.readingRate, READING_WALK.WORDS_PER_SECOND, 'invalid rates fall back to the default');
});

test('reading and stepping past proposals emits reading events only', () => {
  const walk = new ReadingWalk(lines([[S('a'), C('b')], [S('c')], []]), 0);
  walk.moveTo(2, 1000, 'scroll');
  walk.moveTo(0, 2000, 'scroll');
  assert.ok(walk.drain().every(event => ['seen', 'focus'].includes(event.type)));
  assert.deepEqual(walk.snapshot().provisional, []);
  assert.equal(walk.marksOn(0).length, 2, 'reading leaves proposals pending');
  assert.equal(walk.marksOn(1).length, 1);
});

test('legacy provisional accepts are ignored on reload', () => {
  const walk = new ReadingWalk(lines([[S('a')], []]), 0);
  walk.restore({ focus: 1, passed: [], provisional: [['a', 0]] }, 10);
  assert.deepEqual(walk.snapshot().provisional, []);
  assert.deepEqual(walk.snapshot().passed, []);
  assert.equal(walk.focus, 1);
});

test('a jump reads nothing and a remote insertion keeps the passage by identity', () => {
  const walk = new ReadingWalk(lines([[S('a')], [], []]), 0);
  walk.moveTo(2, 1000, 'jump');
  assert.deepEqual(seen(walk.drain()), []);
  walk.setLines([{ key: 'inserted', marks: [] }, ...lines([[S('a')], [], []])], 1100);
  assert.equal(walk.focus, 3);
  walk.setLines(lines([[]]), 1200);
  assert.equal(walk.focus, 0, 'a removed passage clamps safely');
});

test('visible passages include context lines and skip collapsed bodies', () => {
  const walk = new ReadingWalk([
    { key: 'heading', marks: [] }, { key: 'hidden', marks: [], hidden: true },
    { key: 'context', marks: [], skipStep: true }, { key: 'last', marks: [] },
  ], 0);
  assert.equal(walk.nextStop(1), 2);
  assert.equal(walk.nextVisible(-1, 2), 0);
});

console.log(`\nreading-walk tests: ${passed} passed`);
