import { REVIEW_SURFACE_POLICY, viewerLabel, sectionPendingChanges } from '../shared/review-surface';
/** Review scopes, completion, ordering and anchoring. Mike, 2026-09-23 (usability brief). */
import assert from 'node:assert/strict';
import { openView, type OpenView, type OpenViewInput } from '../shared/open-view';
import { reviewViews, reviewCountLabel, reconcileReview, emptyReviewSession, clearCompleted, nextReviewRow, anchoredReviewScroll, reviewStorageKey } from '../shared/review-list';
import type { ProofIssue } from '../shared/line-marks';
let passed = 0;
function test(name: string, fn: () => void): void { fn(); passed++; console.log(`✓ ${name}`); }
const me = 'human:Ada';
const other = 'human:Bo';
const ask = (line: number, openFor = [me]): ProofIssue => ({ type: 'ask', askId: `a${line}`, lineIndex: line, pos: line * 10, kind: 'paragraph', excerpt: '', by: other, recommend: '', openFor, snoozedFor: [] });
const input = (issues: ProofIssue[]): OpenViewInput => ({ issues, viewer: me, team: [me, other], lineAtPos: pos => Math.floor(pos / 10), lineCount: 10 });
const passages = ['alpha', 'beta', 'gamma', 'delta'].map(text => ({ hash: text, text, occurrence: 1 }));
const view = (...indices: number[]): OpenView => openView(input(indices.map(line => ask(line))));
test('Needs you is exactly openView; All open includes work assigned to another participant', () => {
  const source = input([ask(3), ask(1, [other])]);
  const scopes = reviewViews(source);
  assert.deepEqual(scopes['needs-you'], openView(source));
  assert.deepEqual(scopes['all-open'].lines, [1, 3]);
  assert.equal(scopes['all-open'].count, 2);
});
test('scopes count passages once even when multiple participants need the same passage', () => {
  const scopes = reviewViews(input([ask(2, [me, other]), ask(2, [other])]));
  assert.equal(scopes['all-open'].count, 1);
  assert.deepEqual(scopes['all-open'].lines, scopes['all-open'].items.map(item => item.line));
});
test('scope labels always name their scope, including zero and one', () => {
  for (const count of [0, 1, 12]) {
    assert.equal(reviewCountLabel('needs-you', count), `${count} need you`);
    assert.equal(reviewCountLabel('all-open', count), `${count} open`);
  }
});
test('unread lines never enter either scope', () => {
  const scopes = reviewViews(input([]));
  assert.equal(scopes['needs-you'].count, 0);
  assert.equal(scopes['all-open'].count, 0);
});
test('first load is in document order with no new labels', () => {
  const state = reconcileReview(emptyReviewSession(), view(3, 1), passages);
  assert.deepEqual(state.rows.map(row => row.line), [1, 3]);
  assert.ok(state.rows.every(row => !row.fresh && !row.done));
});
test('incoming items insert in document order and alone receive New', () => {
  const state = reconcileReview(reconcileReview(emptyReviewSession(), view(3), passages), view(3, 0, 2), passages);
  assert.deepEqual(state.rows.map(row => row.line), [0, 2, 3]);
  assert.deepEqual(state.rows.map(row => row.fresh), [true, true, false]);
});
test('completion stays in place, including the final row', () => {
  const start = reconcileReview(emptyReviewSession(), view(1, 3), passages);
  const one = reconcileReview(start, view(3), passages);
  assert.deepEqual(one.rows.map(row => [row.line, row.done]), [[1, true], [3, false]]);
  const none = reconcileReview(one, view(), passages);
  assert.deepEqual(none.rows.map(row => [row.line, row.done]), [[1, true], [3, true]]);
  assert.equal(clearCompleted(none).rows.length, 0);
});
test('Next follows document order, skips done rows and wraps', () => {
  const state = reconcileReview(reconcileReview(emptyReviewSession(), view(0, 1, 3), passages), view(0, 3), passages);
  assert.equal(nextReviewRow(state, 0)?.line, 3);
  assert.equal(nextReviewRow(state, 3)?.line, 0);
  assert.deepEqual(clearCompleted(state).rows.map(row => row.line), [0, 3]);
  assert.equal(nextReviewRow(emptyReviewSession(), 0), null);
});
test('clear does not bring completed rows back on the next update', () => {
  const state = reconcileReview(reconcileReview(emptyReviewSession(), view(1, 3), passages), view(3), passages);
  assert.deepEqual(reconcileReview(clearCompleted(state), view(3), passages).rows.map(row => row.line), [3]);
});
test('a fresh session starts without completion or New labels', () => {
  const state = reconcileReview(emptyReviewSession(), view(2), passages);
  assert.deepEqual(state.rows.map(row => [row.line, row.done, row.fresh]), [[2, false, false]]);
});
test('closing clears completion while retaining New on incoming work', () => {
  const first = reconcileReview(emptyReviewSession(), view(1), passages);
  const updated = reconcileReview(first, view(2), passages);
  const closed = clearCompleted(updated);
  assert.deepEqual(closed.rows.map(row => [row.line, row.fresh]), [[2, true]]);
  const incoming = clearCompleted(reconcileReview(closed, view(0, 2), passages));
  assert.deepEqual(incoming.rows.map(row => [row.line, row.fresh]), [[0, true], [2, true]]);
});

test('reopened work removes Done and keeps its stable key', () => {
  const start = reconcileReview(emptyReviewSession(), view(1), passages);
  const done = reconcileReview(start, view(), passages);
  const again = reconcileReview(done, view(1), passages);
  assert.equal(again.rows.length, 1);
  assert.equal(again.rows[0].done, false);
  assert.equal(again.rows[0].key, start.rows[0].key);
});
test('completed rows follow text identity after an insert above', () => {
  const start = reconcileReview(emptyReviewSession(), view(1), passages);
  const moved = reconcileReview(start, view(), [{ hash: 'new', text: 'new', occurrence: 1 }, ...passages]);
  assert.equal(moved.rows[0].line, 2);
  assert.equal(moved.rows[0].text, 'beta');
});
test('a removed passage stays explicitly removed instead of using its old index', () => {
  const start = reconcileReview(emptyReviewSession(), view(1), passages);
  const removed = reconcileReview(start, view(), passages.filter(p => p.hash !== 'beta'));
  assert.equal(removed.rows[0].line, -1);
  assert.equal(removed.rows[0].text, 'beta');
});
test('an edited passage keeps its row key when its thread survives', () => {
  const open = view(1); open.items[0].threadIds = ['thread-one'];
  const start = reconcileReview(emptyReviewSession(), open, passages);
  const edited = passages.map((p, i) => i === 1 ? { ...p, hash: 'edited', text: 'edited' } : p);
  const after = reconcileReview(start, open, edited);
  assert.equal(after.rows.length, 1);
  assert.equal(after.rows[0].key, start.rows[0].key);
  assert.equal(after.rows[0].text, 'edited');
});
test('anchoring compensates inserts above, including when the list was at the top', () => {
  assert.equal(anchoredReviewScroll(80, 120, 180), 140);
  assert.equal(anchoredReviewScroll(0, 120, 180), 60);
  assert.equal(anchoredReviewScroll(80, 120, 100), 60);
  assert.equal(anchoredReviewScroll(0, 120, 100), 0);
});
test('panel storage is isolated by document and reader', () => {
  assert.notEqual(reviewStorageKey('a', me), reviewStorageKey('a', other));
  assert.notEqual(reviewStorageKey('a', me), reviewStorageKey('b', me));
});
test('many documents keep the count, item lines and Open computation consistent', () => {
  for (let mask = 0; mask < 256; mask++) {
    const source = input(Array.from({ length: 8 }, (_, i) => ask(i, [i % 2 ? me : other])).filter((_, i) => mask & (1 << i)));
    const scopes = reviewViews(source);
    assert.deepEqual(scopes['needs-you'].lines, openView(source).lines);
    for (const result of Object.values(scopes)) {
      assert.equal(result.count, result.items.length);
      assert.deepEqual(result.lines, [...new Set(result.lines)].sort((a,b) => a-b));
    }
  }
});
console.log(`\n${passed} review-list tests passed`);

assert.equal(viewerLabel({ actor: 'human:mike@example.test', name: 'Mike Wolf', trust: 'verified', signInUrl: null }), 'Signed in as Mike Wolf (verified)');
assert.equal(viewerLabel({ actor: 'guest:Mike Wolf', name: 'Mike Wolf', trust: 'guest', signInUrl: '/' }), 'Mike Wolf — guest, unverified');
assert.equal(REVIEW_SURFACE_POLICY.seenByDwell, false);
assert.equal(REVIEW_SURFACE_POLICY.alternativeStacks, false);
assert.deepEqual(REVIEW_SURFACE_POLICY.identityHomes, ['toolbar', 'people']);

assert.equal(sectionPendingChanges(2, 6, [0, 2, 4, 4, 6]), 3);
assert.equal(sectionPendingChanges(7, 9, [0, 2, 4, 4, 6]), 0);
