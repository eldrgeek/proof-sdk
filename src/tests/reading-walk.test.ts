// Proof Documents Step 1b: the reading walk state machine and the gesture gate.
// Authorship: Claude Opus 5 (worker reading-walk), 2026-09-18.
import assert from 'node:assert/strict';
import { GestureGate, READING_WALK, ReadingWalk, countWords, dwellMsFor, type WalkLine, type WalkEvent } from '../shared/reading-walk';

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
const of = (events: WalkEvent[], type: WalkEvent['type']) => events.filter(e => e.type === type).map(e => (e as { id?: string }).id);

test('the first line is the focus line on open', () => {
  const walk = new ReadingWalk(lines([[], [], []]), 0);
  assert.equal(walk.focus, 0);
  assert.equal(walk.currentMark(), null);
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

test('a fling marks nothing Seen: skipped lines and briefly focused lines stay unread (Step B3b: skimmed)', () => {
  const walk = new ReadingWalk(lines([[], [], [], [], [], []]), 0);
  walk.moveTo(1, 10, 'scroll', [30, 30, 30, 30, 30, 30]); // 30 px in 10 ms = 3000 px/s
  walk.moveTo(5, 20, 'scroll', [30, 30, 30, 30, 30, 30]);
  assert.deepEqual(seen(walk.drain()), []);
});

test('Step B3b: the dwell scales with the line\'s words (4 words/s, min 250 ms, cap 6 s)', () => {
  assert.equal(dwellMsFor(undefined), READING_WALK.MIN_DWELL_MS, 'no word count: the shortest dwell');
  assert.equal(dwellMsFor(1), READING_WALK.MIN_DWELL_MS, 'a one-word line still needs the minimum');
  assert.equal(dwellMsFor(8), 2000, '8 words at 4 words/s');
  assert.equal(dwellMsFor(200), READING_WALK.MAX_DWELL_MS, 'long paragraphs are capped');
  assert.equal(dwellMsFor(8, 8), 1000, 'a faster reader: 8 words at 8 words/s');
  assert.equal(dwellMsFor(40, 0), READING_WALK.MIN_DWELL_MS, 'rate 0 = no length rule');
  assert.equal(countWords('The quick brown fox — jumps, over 2 lazy dogs.'), 9);
  assert.equal(countWords("Don't split e.g. or 3.5 or co-op"), 7);
  const walk = new ReadingWalk([{ key: 'long', words: 20, marks: [] }, { key: 'b', words: 2, marks: [] }], 0);
  walk.tick(4999);
  assert.deepEqual(seen(walk.drain()), [], '20 words need 5 s');
  assert.equal(walk.msUntilRead(4999), 1);
  walk.tick(5000);
  assert.deepEqual(seen(walk.drain()), [0]);
});

test('Step B3b: a line scrolled past faster than its reading time is skimmed (once), not seen', () => {
  const walk = new ReadingWalk([{ key: 'a', words: 12, marks: [] }, { key: 'b', words: 12, marks: [] }, { key: 'c', words: 12, marks: [] }, { key: 'd', words: 12, marks: [] }], 0);
  walk.moveTo(1, 1000, 'scroll'); // 12 words need 3 s: 1 s is a skim
  walk.moveTo(3, 1100, 'scroll'); // line 2 is jumped over: skimmed too
  let events = walk.drain();
  assert.deepEqual(seen(events), []);
  assert.deepEqual(events.filter(e => e.type === 'skimmed').map(e => (e as { line: number }).line), [0, 1, 2]);
  assert.ok(walk.hasSkimmed('a'));
  walk.moveTo(0, 1200, 'scroll');
  walk.moveTo(1, 1300, 'scroll');
  assert.deepEqual(walk.drain().filter(e => e.type === 'skimmed'), [], 'a skim is reported once per line text');
  walk.tick(1300 + 3000);
  events = walk.drain();
  assert.deepEqual(seen(events), [1], 'reading it properly later makes it seen');
  assert.equal(walk.hasSkimmed('b'), false);
  const jump = new ReadingWalk([{ key: 'x', words: 12, marks: [] }, { key: 'y', words: 12, marks: [] }, { key: 'z', words: 12, marks: [] }], 0);
  jump.moveTo(2, 10, 'jump');
  assert.deepEqual(jump.drain().filter(e => e.type === 'skimmed'), [], 'a jump (Next issue) neither reads nor skims');
});

test('Step B3b: a per-reader rate changes the reading time', () => {
  const walk = new ReadingWalk([{ key: 'a', words: 24, marks: [] }, { key: 'b', words: 4, marks: [] }], 0);
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

test('a line with pending marks holds the focus; each step passes one mark', () => {
  const walk = new ReadingWalk(lines([[], [S('a'), C('b'), S('c')], []]), 0);
  assert.equal(walk.barrier(), 1, 'the marked line is the barrier');
  walk.moveTo(1, 300, 'scroll');
  assert.equal(walk.currentMark()?.id, 'a');
  assert.equal(walk.barrier(), 1, 'still held by the focus line');
  assert.ok(walk.stepForward());
  assert.equal(walk.currentMark()?.id, 'b');
  assert.ok(walk.stepForward());
  assert.equal(walk.currentMark()?.id, 'c');
  assert.ok(walk.stepForward());
  assert.equal(walk.currentMark(), null);
  assert.equal(walk.stepForward(), false, 'nothing left to step');
  assert.equal(walk.barrier(), null, 'the line releases the focus');
  const events = walk.drain();
  assert.deepEqual(of(events, 'provisional'), ['a', 'c'], 'suggestions are accepted provisionally; comments are just passed');
  assert.deepEqual(walk.provisionalIds().sort(), ['a', 'c']);
});

test('stepping back reverts one provisional accept at a time', () => {
  const walk = new ReadingWalk(lines([[S('a'), S('b'), S('c')]]), 0);
  walk.stepForward(); walk.stepForward(); walk.stepForward();
  walk.drain();
  assert.ok(walk.stepBack());
  assert.deepEqual(of(walk.drain(), 'revert'), ['c']);
  assert.equal(walk.currentMark()?.id, 'c');
  assert.ok(walk.stepBack());
  assert.ok(walk.stepBack());
  assert.equal(walk.stepBack(), false);
  assert.equal(walk.provisionalCount, 0);
});

test('scrolling past a change accepts it provisionally; scrolling back above it reverts it', () => {
  const walk = new ReadingWalk(lines([[], [S('a')], [], [S('b')], []]), 0);
  walk.moveTo(4, 1000, 'scroll'); // e.g. a scrollbar drag past both lines
  assert.deepEqual(walk.provisionalIds().sort(), ['a', 'b']);
  walk.drain();
  walk.moveTo(2, 2000, 'scroll');
  assert.deepEqual(of(walk.drain(), 'revert'), ['b']);
  assert.deepEqual(walk.provisionalIds(), ['a']);
  walk.moveTo(0, 3000, 'scroll');
  assert.deepEqual(of(walk.drain(), 'revert'), ['a']);
  assert.equal(walk.provisionalCount, 0);
  assert.equal(walk.barrier(), 1, 'reverted marks hold the focus again on the way down');
});

test('arriving from below, the next upward steps walk back through the line', () => {
  const walk = new ReadingWalk(lines([[], [S('a'), S('b')], []]), 0);
  walk.moveTo(1, 300, 'scroll');
  walk.stepForward(); walk.stepForward();
  walk.moveTo(2, 600, 'scroll');
  walk.moveTo(1, 900, 'scroll');
  assert.equal(walk.provisionalCount, 2, 'line 1 is not above the focus yet');
  assert.ok(walk.canStepBack());
  walk.stepBack();
  assert.deepEqual(walk.provisionalIds(), ['a']);
});

test('an explicit action on a later line commits the provisional accepts at or above it', () => {
  const walk = new ReadingWalk(lines([[S('a')], [], [S('b')], [], []]), 0);
  walk.stepForward();
  walk.moveTo(2, 300, 'scroll');
  walk.stepForward();
  walk.moveTo(3, 600, 'scroll');
  assert.deepEqual(walk.provisionalIds().sort(), ['a', 'b']);
  assert.deepEqual(walk.explicitAction(1), ['a'], 'only those at or above the action line');
  assert.deepEqual(walk.provisionalIds(), ['b']);
  assert.deepEqual(walk.explicitAction(3), ['b']);
  assert.equal(walk.provisionalCount, 0);
  walk.drain();
  walk.moveTo(0, 900, 'scroll');
  assert.deepEqual(of(walk.drain(), 'revert'), [], 'committed accepts are never reverted by scrolling');
});

test('Commit all returns every provisional accept; a failed commit can be restored', () => {
  const walk = new ReadingWalk(lines([[S('a')], [S('b')], []]), 0);
  walk.moveTo(2, 1000, 'scroll');
  const ids = walk.commitAll().sort();
  assert.deepEqual(ids, ['a', 'b']);
  assert.equal(walk.provisionalCount, 0);
  walk.restoreProvisional(ids);
  assert.equal(walk.provisionalCount, 2);
});

test('an explicit decision removes the mark from the provisional set', () => {
  const walk = new ReadingWalk(lines([[S('a'), S('b')], []]), 0);
  walk.stepForward();
  walk.decided('a');
  walk.decided('b');
  assert.equal(walk.provisionalCount, 0);
  walk.drain();
  walk.moveTo(1, 500, 'scroll');
  assert.deepEqual(of(walk.drain(), 'provisional'), []);
});

test('a jump down reads and accepts nothing; a jump up still reverts what is below', () => {
  const walk = new ReadingWalk(lines([[], [S('a')], [], [S('b')], []]), 0);
  walk.moveTo(4, 5000, 'jump');
  const events = walk.drain();
  assert.deepEqual(seen(events), []);
  assert.equal(walk.provisionalCount, 0);
  const again = new ReadingWalk(lines([[], [S('a')], [], []]), 0);
  again.moveTo(3, 1000, 'scroll');
  again.moveTo(0, 2000, 'jump');
  assert.equal(again.provisionalCount, 0);
});

test('setLines: accepted-elsewhere marks leave the provisional set; the focus is clamped', () => {
  const walk = new ReadingWalk(lines([[S('a')], [S('b')], [], []]), 0);
  walk.moveTo(3, 1000, 'scroll');
  walk.setLines(lines([[], [S('b')]]), 1100);
  assert.deepEqual(walk.provisionalIds(), ['b']);
  assert.equal(walk.focus, 1);
});

test('snapshot and restore keep provisional accepts that are still pending', () => {
  const walk = new ReadingWalk(lines([[S('a')], [S('b')], []]), 0);
  walk.moveTo(2, 1000, 'scroll');
  const snap = JSON.parse(JSON.stringify(walk.snapshot()));
  const fresh = new ReadingWalk(lines([[S('a')], [], []]), 0);
  fresh.restore(snap, 0);
  assert.equal(fresh.focus, 2);
  assert.deepEqual(fresh.provisionalIds(), ['a']);
});

test('gesture gate: one step per gesture, however many events (trackpad inertia)', () => {
  const gate = new GestureGate(180, 24);
  let steps = 0;
  let prevented = 0;
  // 40 events 16 ms apart with decaying deltas: one gesture.
  for (let i = 0; i < 40; i += 1) {
    const result = gate.feed(Math.max(1, 60 - i * 1.5), i * 16, () => 'step');
    steps += Math.abs(result.step);
    if (result.prevent) prevented += 1;
  }
  assert.equal(steps, 1);
  assert.equal(prevented, 40, 'the whole gesture is held');
  // A pause longer than the gap starts a new gesture: one more step.
  const next = gate.feed(40, 40 * 16 + 400, () => 'step');
  assert.equal(next.started, true);
  assert.equal(next.step, 1);
});

test('gesture gate: small deltas accumulate to the threshold; native gestures never step', () => {
  const gate = new GestureGate(180, 24);
  assert.equal(gate.feed(10, 0, () => 'step').step, 0);
  assert.equal(gate.feed(10, 10, () => 'step').step, 0);
  assert.equal(gate.feed(10, 20, () => 'step').step, 1);
  const native = new GestureGate(180, 24);
  const r = native.feed(500, 0, () => 'native');
  assert.equal(r.prevent, false);
  assert.equal(r.step, 0);
});

test('gesture gate: a direction change starts a new gesture; block() holds the rest', () => {
  const gate = new GestureGate(180, 24);
  gate.feed(50, 0, () => 'native');
  gate.block();
  assert.equal(gate.feed(50, 16, () => 'native').prevent, true, 'blocked for the inertia tail');
  const reversed = gate.feed(-50, 32, dir => (dir === -1 ? 'step' : 'native'));
  assert.equal(reversed.started, true);
  assert.equal(reversed.step, -1);
});

console.log(`\nreading-walk tests: ${passed} passed`);
