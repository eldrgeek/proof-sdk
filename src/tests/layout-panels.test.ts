import type { ThreadView } from '../shared/threads';
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
  ACCORDS_LIST_POLICY, BOTTOM_CHAT_POLICY, OPEN_ITEMS_POLICY, GUTTER_POLICY, REVIEW_KEYS_POLICY, reviewListKey, reviewItemHint, passageMarkers, stableReviewOrder, resolveSettledIndex, MARGIN_POLICY, MARKED_BY_POLICY, NAVIGATOR_POLICY, PHONE_STRIP_POLICY,
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

test('layout v2 retires the Line tab and moves the three Review tabs right', () => {
  assert.equal(MARGIN_POLICY.renderLineTab, false);
  assert.equal(NAVIGATOR_POLICY.side, 'right');
  assert.deepEqual(NAVIGATOR_POLICY.tabs.map(t => t.label), ['Review', 'Outline', 'Since you']);
  assert.equal(NAVIGATOR_POLICY.widthPx, 340);
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

test('a settled row resolves by the identity captured when it settled, not by its old index', () => {
  const settled = { hash: 'charlie', occurrence: 1 };
  const before = [
    { hash: 'alpha', occurrence: 1, index: 0 },
    { hash: 'bravo', occurrence: 1, index: 1 },
    { hash: 'charlie', occurrence: 1, index: 2 },
  ];
  assert.equal(resolveSettledIndex(settled, before), 2);
  const inserted = [
    { hash: 'new', occurrence: 1, index: 0 },
    { hash: 'alpha', occurrence: 1, index: 1 },
    { hash: 'bravo', occurrence: 1, index: 2 },
    { hash: 'charlie', occurrence: 1, index: 3 },
  ];
  assert.equal(resolveSettledIndex(settled, inserted), 3, 'an insert above must not point the settled row at another line');
  assert.equal(resolveSettledIndex({ hash: 'charlie', occurrence: 2 }, inserted), null);
  assert.equal(resolveSettledIndex(settled, inserted.filter(line => line.hash !== 'charlie')), null, 'a removed passage stays unresolved');
});


test('margin counts remain for resolved history, deduplicate threads and cover each anchored passage', () => {
  const thread = (id: string, kind: 'discussion' | 'proposal', lines: number[], replies = 0) => ({
    thread: { id, kind, replies: Array.from({ length: replies }, () => ({})), status: 'resolved' },
    lineIndices: lines, lineIndex: lines[0] ?? 4, open: false,
  }) as ThreadView;
  const discussion = thread('c', 'discussion', [1, 2], 1);
  const markers = passageMarkers([discussion, discussion, thread('p', 'proposal', [2]), thread('gone', 'discussion', [])]);
  assert.deepEqual(markers.get(1), { text: '2 comments', ids: ['c'] });
  assert.deepEqual(markers.get(2), { text: '2 comments · 1 proposal', ids: ['c', 'p'] });
  assert.equal(markers.get(4)?.text, '1 comment');
});
test('layout v2 policies: independent panels, permanent composer, proposals only', () => {
  assert.deepEqual(ACCORDS_LIST_POLICY, { side: 'left', widthPx: 240, closedBelowPx: 1100,
    phonePresentation: 'drawer', showNew: true, showAll: true, allHref: '/' });
  assert.deepEqual(OPEN_ITEMS_POLICY, { side: 'right', defaultOpen: true, phonePresentation: 'sheet',
    clickKeepsListFocus: true, enterFocusesDocument: true });
  assert.deepEqual(BOTTOM_CHAT_POLICY, { position: 'centre-bottom', composerAlwaysVisible: true,
    collapsedMessages: 1, initiallyExpanded: false, expandedHeightShare: 0.6, compactHeightPx: 230,
    explicitOpenExpands: true, badge: 'mentions' });
  assert.deepEqual(GUTTER_POLICY, { showLineMarks: false, showOpenDots: true, dotOpensReview: true });
  assert.equal(REVIEW_KEYS_POLICY.proposalsOnly, true);
  assert.equal(REVIEW_KEYS_POLICY.bundlesAsUnit, true);
  assert.equal(REVIEW_KEYS_POLICY.lineMarkKeys, false);
  assert.equal(REVIEW_KEYS_POLICY.wrapNavigation, false);
  assert.equal(PHONE_STRIP_POLICY.opens, 'review');
  assert.equal(PHONE_STRIP_POLICY.showLineMarks, false);
  assert.deepEqual(parseRailState('{"left":true,"right":false,"reviewTab":"since"}'),
    { left: true, right: false, reviewTab: 'since' });
});

test('list keys: A, Delete, Backspace, J, K and Enter; no line-mark R', () => {
  const route = (key: string, extra = {}) => reviewListKey({ key, listFocused: true, typing: false, ...extra });
  for (const [key, action] of [['a', 'accept'], ['A', 'accept'], ['Delete', 'reject'], ['Backspace', 'reject'],
    ['j', 'next'], ['J', 'next'], ['k', 'previous'], ['K', 'previous'], ['Enter', 'document']]) {
    assert.equal(route(key), action);
    assert.equal(route(key, { typing: true }), null, key + ' while typing');
    assert.equal(route(key, { listFocused: false }), null, key + ' outside list');
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'isComposing']) assert.equal(route(key, { [modifier]: true }), null);
  }
  for (const key of ['a', 'j', 'k']) assert.equal(route(key, { letterShortcuts: false }), null);
  for (const key of ['r', 'R', 'Process', 'Unidentified', 'Tab']) assert.equal(route(key), null);
});

test('non-proposals explain how to answer instead of accepting or rejecting', () => {
  assert.equal(reviewItemHint('suggestion'), null);
  assert.match(reviewItemHint('ask')!, /Yes, Not yet or No under its question/);
  for (const kind of ['do', 'objection', 'comment', 'thread', 'alternative', 'uncertain', 'ttl', 'lapsed', 'changed', 'unread'] as const)
    assert.ok(reviewItemHint(kind), kind);
  assert.ok(reviewItemHint(undefined));
});
console.log(`\n${passed} layout-panels tests passed`);
