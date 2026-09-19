// Proof Documents Step 1b: the reading walk state machine and the gesture gate.
// Authorship: Claude Opus 5 (worker reading-walk), 2026-09-18.
import assert from 'node:assert/strict';
import { GestureGate, READING_WALK, ReadingWalk, type WalkLine, type WalkEvent } from '../shared/reading-walk';

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

test('a fling marks nothing: skipped lines and briefly focused lines stay unread', () => {
  const walk = new ReadingWalk(lines([[], [], [], [], [], []]), 0);
  walk.moveTo(1, 10, 'scroll', [30, 30, 30, 30, 30, 30]); // 30 px in 10 ms = 3000 px/s
  walk.moveTo(5, 20, 'scroll', [30, 30, 30, 30, 30, 30]);
  assert.deepEqual(seen(walk.drain()), []);
});

test('reading speed: a short line passed slowly enough counts even under the dwell', () => {
  const walk = new ReadingWalk(lines([[], [], []]), 0);
  // 24 px in 100 ms = 240 px/s <= READING_SPEED_PX_PER_S
  walk.moveTo(1, 100, 'scroll', [24, 24, 24]);
  // 24 px in 20 ms = 1200 px/s: too fast
  walk.moveTo(2, 120, 'scroll', [24, 24, 24]);
  assert.deepEqual(seen(walk.drain()), [0]);
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
