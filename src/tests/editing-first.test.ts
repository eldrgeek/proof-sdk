/**
 * Editing first (Mike, 2026-09-19): statement policy (scroll-read of another's statement gives
 * Agreed via dwell), the review lock, the click policies, and the editing guard.
 * Authorship: Claude Opus 5 (worker proof-editfix), 2026-09-19.
 */
import assert from 'node:assert/strict';
import {
  MARK_VIAS, PASSIVE_VIAS, STATEMENT_POLICY, dwellMarkFor, isOthersStatement, type LineMark,
} from '../shared/line-marks';
import { classifyLineChange } from '../shared/line-change';
import { EDITING_GUARD_POLICY, isEditing, noteEditingActivity, resetEditingGuardForTests } from '../editor/editing-guard';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

function mark(by: string, status: LineMark['status'] = 'seen'): LineMark {
  return { id: `m-${by}`, by, status, at: '2026-09-19T10:00:00Z', anchor: { hash: 'h', occurrence: 0, ordinal: 0, kind: 'paragraph', excerpt: 'x' } };
}

test('policy: scrolling past another\'s statement gives Agreed; one\'s own gives Seen', () => {
  assert.equal(STATEMENT_POLICY.dwellOnOthersStatement, 'agreed');
  assert.equal(STATEMENT_POLICY.dwellOnOwnStatement, 'seen');
  assert.equal(STATEMENT_POLICY.editorMarkOnEdit, 'agreed');
  assert.ok(PASSIVE_VIAS.has('dwell'), 'a dwell Agreed stays a passive mark (the ringer list watches it)');
});

test('isOthersStatement: another author, or another person\'s current mark', () => {
  const me = ['human:mike@example.com', 'human:Mike'];
  assert.equal(isOthersStatement({ me, authors: ['ai:claude'] }), true, 'written by Claude');
  assert.equal(isOthersStatement({ me, authors: ['human:Mike'] }), false, 'written by me (editor actor)');
  assert.equal(isOthersStatement({ me }), false, 'nobody else touched it');
  const agreed = new Map([['ai:claude', { mark: { ...mark('ai:claude', 'agreed'), via: 'api' as const }, current: true }]]);
  assert.equal(isOthersStatement({ me, state: { marks: agreed } }), true, 'Claude agreed with it (a claim)');
  const read = new Map([['guest:bob', { mark: { ...mark('guest:Bob', 'agreed'), via: 'dwell' as const }, current: true }]]);
  assert.equal(isOthersStatement({ me, state: { marks: read } }), false, 'reading: a passive mark never makes a line someone\'s statement (no cascade)');
  assert.equal(isOthersStatement({ me, state: { marks: read }, purpose: 'edit' }), true, 'editing: a line others have marked');
  const seen = new Map([['ai:claude', { mark: { ...mark('ai:claude', 'seen'), via: 'click' as const }, current: true }]]);
  assert.equal(isOthersStatement({ me, state: { marks: seen } }), false, 'a Seen is not a claim');
  const marks = seen;
  const stale = new Map([['ai:claude', { mark: mark('ai:claude'), current: false }]]);
  assert.equal(isOthersStatement({ me, state: { marks: stale }, purpose: 'edit' }), false, 'a stale mark is not a claim on the current text');
  const mine = new Map([['human:mike@example.com', { mark: mark('human:mike@example.com'), current: true }]]);
  assert.equal(isOthersStatement({ me, state: { marks: mine } }), false, 'only my own mark');
});

test('dwellMarkFor: never downgrades; raises a dwell Seen on another\'s statement to Agreed', () => {
  assert.equal(dwellMarkFor(true, null), 'agreed');
  assert.equal(dwellMarkFor(false, null), 'seen');
  assert.equal(dwellMarkFor(true, { status: 'unseen' }), 'agreed');
  assert.equal(dwellMarkFor(true, { status: 'skimmed', via: 'dwell' }), 'agreed');
  assert.equal(dwellMarkFor(true, { status: 'changed' }), 'agreed');
  assert.equal(dwellMarkFor(true, { status: 'seen', via: 'dwell' }), 'agreed', 'upgrade a scroll Seen');
  assert.equal(dwellMarkFor(true, { status: 'seen', via: 'click' }), null, 'an explicit Seen is the reader\'s choice');
  assert.equal(dwellMarkFor(true, { status: 'rejected', via: 'click' }), null, 'never overwrite a Reject');
  assert.equal(dwellMarkFor(true, { status: 'agreed', via: 'dwell' }), null);
  assert.equal(dwellMarkFor(false, { status: 'seen', via: 'dwell' }), null);
});

test('edit vias: "edit" (meaning changed) and "correct" (meaning unchanged) are deliberate marks', () => {
  assert.ok(MARK_VIAS.includes('edit') && MARK_VIAS.includes('correct'));
  assert.ok(!PASSIVE_VIAS.has('edit') && !PASSIVE_VIAS.has('correct'));
  // The classifier decides which one an edit of another's statement gets.
  assert.equal(classifyLineChange('for use in the open Source Editor Proof', 'for use in the open source Editor Proof').kind, 'cosmetic');
  assert.equal(classifyLineChange('for use in the open Source Editor Proof', 'for use in the SOMA Marked Document Editor, derived from Proof').kind, 'substantive');
});

test('editing guard: editing = caret in the text and activity within the grace period', () => {
  const editable = { isContentEditable: true, closest: (sel: string) => (sel === '.ProseMirror' ? {} : null) };
  const g = globalThis as unknown as { document?: unknown };
  const previous = g.document;
  g.document = { activeElement: editable };
  try {
    resetEditingGuardForTests();
    assert.equal(isEditing(1000), false, 'no activity yet');
    noteEditingActivity(1000);
    assert.equal(isEditing(1000 + EDITING_GUARD_POLICY.graceMs - 1), true);
    assert.equal(isEditing(1000 + EDITING_GUARD_POLICY.graceMs), false, 'the grace period ended');
    g.document = { activeElement: { isContentEditable: false, closest: () => null } };
    noteEditingActivity(5000);
    assert.equal(isEditing(5001), false, 'the caret left the document');
  } finally {
    g.document = previous;
  }
});

console.log(`\nediting-first tests: ${passed} passed`);
