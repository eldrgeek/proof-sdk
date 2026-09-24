/**
 * Accord layout stage 3 (Ren's proposal, Mike ruled 2026-09-21; decisions 4, 6, 7, 8, 11): the pure
 * parts of one cursor, the Margin's two tabs, the Navigator's Issues and Outline lists, and the
 * remembered rail state.
 * Authorship: Claude Opus 5 (worker accord-layout3), 2026-09-21.
 */
import assert from 'node:assert/strict';
import type { ProofIssue } from '../shared/line-marks';
import { needsYouLines } from '../shared/layout-status';
import {
  stableReviewOrder, MARGIN_POLICY, MARKED_BY_POLICY, NAVIGATOR_POLICY, PHONE_STRIP_POLICY,
  markedByFold, needsYouItems, needsYouLabel, outlineRows, parseRailState,
} from '../shared/layout-panels';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const ME = 'human:Ada';
const lineAtPos = (pos: number) => (pos >= 0 && pos < 200 ? Math.floor(pos / 10) : -1);
const ask = (line: number, openFor: string[], by = 'ai:cos'): ProofIssue => ({
  type: 'ask', askId: `a${line}`, lineIndex: line, pos: line * 10, kind: 'paragraph', excerpt: '', by, recommend: '', openFor, snoozedFor: [],
});
const suggestion = (line: number, by: string | null): ProofIssue => ({ type: 'suggestion', markId: `s${line}`, pos: line * 10 + 2, kind: 'replace', by, excerpt: '' });
const comment = (line: number, by: string | null): ProofIssue => ({ type: 'comment', markId: `c${line}`, pos: line * 10 + 3, kind: 'comment', by, excerpt: '' });

test('policy: two Margin tabs, three Navigator tabs, Agree and Reject primary, selection owns the target', () => {
  assert.deepEqual(MARGIN_POLICY.tabs, ['line', 'room']);
  assert.deepEqual(NAVIGATOR_POLICY.tabs.map(t => t.label), ['Outline', 'Issues', 'Since you']);
  assert.deepEqual(MARGIN_POLICY.primaryMarks, ['agreed', 'rejected']);
  for (const item of ['approved', 'seen', 'clear', 'uncertain', 'alternative', 'explain', 'ttl', 'tier']) assert.ok(MARGIN_POLICY.moreItems.includes(item), item);
  assert.equal(NAVIGATOR_POLICY.widthPx, 240);
  assert.equal(MARGIN_POLICY.widthPx, 340);
  assert.equal(NAVIGATOR_POLICY.closedBelowPx, 1100);
  assert.equal(PHONE_STRIP_POLICY.heightPx, 56);
});

test('Issues list: the same lines as the amber dots, with their kinds, in document order', () => {
  const issues: ProofIssue[] = [
    comment(12, 'ai:dee'), ask(7, [ME]), suggestion(9, 'ai:dee'), suggestion(4, ME), ask(15, ['human:Bo']), ask(12, [ME]),
    { type: 'nomination', nominationId: 'n', lineIndex: null, pos: null, kind: 'nomination', excerpt: '', by: 'ai:x', email: 'e', name: null, why: '', openFor: [ME] },
  ];
  const items = needsYouItems(issues, ME, lineAtPos);
  assert.deepEqual(items.map(i => i.line), needsYouLines(issues, ME, lineAtPos));
  assert.deepEqual(items.map(i => i.line), [7, 9, 12]);
  assert.deepEqual(items[2].kinds, ['ask', 'comment'], 'an ask outranks a comment on the same line');
  assert.equal(items[2].count, 2);
  assert.equal(items[1].by, 'ai:dee');
});

test('a guest\'s own comment (written by the editor as human:<name>) never needs them', () => {
  const issues: ProofIssue[] = [comment(3, 'human:Ada'), comment(5, 'ai:dee')];
  assert.deepEqual(needsYouItems(issues, 'guest:Ada', lineAtPos, ['human:Ada']).map(i => i.line), [5]);
  assert.deepEqual(needsYouLines(issues, 'guest:Ada', lineAtPos, ['human:Ada']), [5]);
  assert.deepEqual(needsYouLines(issues, 'guest:Ada', lineAtPos), [3, 5], 'without the alias the comment counts');
});

test('Issues labels: "Ask · line N", "Change from Dee · line N", "… and 1 more"', () => {
  const name = (actor: string) => actor.replace(/^\w+:/, '').replace(/^./, c => c.toUpperCase());
  const items = needsYouItems([ask(6, [ME]), suggestion(8, 'ai:dee'), comment(11, 'ai:dee'), ask(11, [ME])], ME, lineAtPos);
  assert.deepEqual(items.map(i => needsYouLabel(i, name, ME)), ['Ask · line 7', 'Change from Dee · line 9', 'Ask and 1 more · line 12']);
  const changed = needsYouItems([{ type: 'line', lineIndex: 3, pos: 30, kind: 'paragraph', excerpt: '', hash: 'h', reasons: ['changed'], unseenBy: [], changedFor: [ME], rejectedBy: [], skimmedBy: [] }], ME, lineAtPos);
  assert.equal(needsYouLabel(changed[0], name, ME), 'Changed since you marked it · line 4');
});

test('Outline rows: depth from the shallowest heading; folded parents hide their children', () => {
  const sections = [
    { headingIndex: 0, level: 1, parent: null },
    { headingIndex: 5, level: 2, parent: 0 },
    { headingIndex: 9, level: 3, parent: 5 },
    { headingIndex: 14, level: 2, parent: 0 },
  ];
  const folded = new Set([5]);
  const rows = outlineRows(sections, i => `H${i}`, i => folded.has(i), i => (i === 5 ? 2 : 0));
  assert.deepEqual(rows.map(r => r.depth), [0, 1, 2, 1]);
  assert.deepEqual(rows.map(r => r.hidden), [false, false, true, false]);
  assert.equal(rows[1].folded, true);
  assert.equal(rows[1].issues, 2);
  assert.equal(rows[0].text, 'H0');
});

test('rail state: open / closed and each rail\'s tab are remembered; junk is dropped', () => {
  assert.deepEqual(parseRailState('{"left":true,"right":false,"leftTab":"outline","rightTab":"room"}'), { left: true, right: false, leftTab: 'outline', rightTab: 'room' });
  assert.deepEqual(parseRailState('{"leftTab":"documents","rightTab":"third","left":"yes"}'), {});
  assert.deepEqual(parseRailState('not json'), {});
  assert.deepEqual(parseRailState(null), {});
});

test('markedByFold: "Marked by N" folds; open only for a current Reject or an open objection', () => {
  assert.equal(MARKED_BY_POLICY.foldInLineTab, true);
  const quiet = markedByFold(['agreed', 'seen', 'unseen', 'agreed'], false);
  assert.deepEqual(quiet, { count: 3, total: 4, open: false, label: 'Marked by 3', detail: '2 Agreed · 1 Seen' });
  const reject = markedByFold(['agreed', 'rejected', 'unseen'], false);
  assert.equal(reject.open, true);
  assert.equal(reject.detail, '1 Rejected · 1 Agreed');
  // A Reject made before the line changed is not a current Reject.
  assert.equal(markedByFold(['changed', 'agreed'], false).open, false);
  assert.equal(markedByFold(['agreed'], true).open, true, 'an open objection opens it');
  assert.equal(markedByFold(['unseen', 'unseen'], false).label, 'Not marked yet');
  assert.equal(markedByFold(['hidden', 'seen'], false).count, 2, 'a blind mark still counts as a mark');
});

test('incoming review rows append without moving the existing rows', () => {
  assert.deepEqual(stableReviewOrder(['later', 'last'], ['new-first', 'later', 'last']), ['later', 'last', 'new-first']);
  assert.deepEqual(stableReviewOrder(['gone', 'last'], ['last', 'new']), ['last', 'new']);
});

console.log(`\n${passed} layout-panels tests passed`);
