import assert from 'node:assert/strict';
// @ts-ignore: plain .mjs shared with scripts/local-write-resync-check.mjs
import { adjacentInsertRuns } from '../../scripts/adjacent-inserts.mjs';

const TYPED = 'typed by the person ';

// The proposals the check saw on 2026-10-24 when a loaded machine paused the typing for 1.2 s:
// "t" and "yped by the person " were two proposals, back to back.
const split = [
  { content: '..........', range: { from: 1424, to: 1434 } },
  { content: 't', range: { from: 1767, to: 1768 } },
  { content: 'yped by the person ', range: { from: 1768, to: 1787 } },
];
assert.ok(adjacentInsertRuns(split).some((run: string) => run.includes(TYPED)), 'a split phrase reads as the typed words');
// The old assertion (one proposal holds all the words) fails on that sample, which is the flake.
assert.ok(!split.some(m => m.content.includes(TYPED)), 'the old single-proposal rule rejects the split phrase');

// Out of order input still joins.
assert.deepEqual(adjacentInsertRuns([split[2], split[1]]), ['typed by the person ']);

// Proposals with a gap between them do not join: words typed elsewhere are not the typed phrase.
assert.deepEqual(adjacentInsertRuns([
  { content: 'typed by ', range: { from: 10, to: 19 } },
  { content: 'the person ', range: { from: 40, to: 51 } },
]), ['typed by ', 'the person ']);
assert.ok(!adjacentInsertRuns([
  { content: 'typed by ', range: { from: 10, to: 19 } },
  { content: 'the person ', range: { from: 40, to: 51 } },
]).some((run: string) => run.includes(TYPED)));

// Nothing typed, or malformed marks, gives no runs and no crash.
assert.deepEqual(adjacentInsertRuns([]), []);
assert.deepEqual(adjacentInsertRuns(undefined as any), []);
assert.deepEqual(adjacentInsertRuns([{ content: null, range: null } as any]), []);

console.log('adjacent-inserts: 7 assertions passed');
