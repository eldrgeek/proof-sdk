/**
 * Accord layout stage 1 (Ren's proposal, Mike ruled 2026-09-21): the pure parts of the status bar,
 * the "You marked up to here" rule and the amber "needs you" dots.
 * Authorship: Claude Opus 5 (worker accord-layout1), 2026-09-21.
 */
import assert from 'node:assert/strict';
import { buildLineStates, type DocLine, type LineMark, type ProofIssue } from '../shared/line-marks';
import {
  HIGHLIGHT_POLICY, MARKED_UP_TO_POLICY, NEEDS_YOU_POLICY, STATUS_BAR_POLICY,
  formatAgo, issueNeedsViewer, issuesLeftText, markedUpTo, needsYouLines,
} from '../shared/layout-status';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const ME = 'human:Ada';
const lines: DocLine[] = Array.from({ length: 6 }, (_, index) => ({
  index, kind: 'paragraph', text: `Line ${index}`, hash: `h${index}`, occurrence: 0, pos: index * 10, nodeSize: 10, block: index,
}));
const lineAtPos = (pos: number) => (pos >= 0 && pos < 60 ? Math.floor(pos / 10) : -1);
const mark = (line: number, at: string, via: LineMark['via'], by = ME, status: LineMark['status'] = 'agreed'): LineMark => ({
  id: `m-${line}-${at}-${by}`, by, status, at, via,
  anchor: { hash: `h${line}`, occurrence: 0, ordinal: line, kind: 'paragraph', excerpt: `Line ${line}` },
});

test('policy: two highlight states only, and Reading / Writing is not a switch', () => {
  assert.deepEqual(HIGHLIGHT_POLICY, { contextDimming: false, decisionDiamond: false });
  assert.equal(STATUS_BAR_POLICY.modeIsSwitch, false);
  assert.equal(STATUS_BAR_POLICY.heightPx, 28);
  assert.equal(MARKED_UP_TO_POLICY.basis, 'latest');
  assert.ok(!MARKED_UP_TO_POLICY.explicitVias.includes('dwell'));
  assert.ok(!MARKED_UP_TO_POLICY.explicitVias.includes('section'));
  assert.ok(!MARKED_UP_TO_POLICY.explicitVias.includes('edit'));
});

test('needs you: an ask asked of me, a change by someone else; not my own change, not an unseen line', () => {
  const issues: ProofIssue[] = [
    { type: 'ask', askId: 'a1', lineIndex: 1, pos: 10, kind: 'paragraph', excerpt: '', by: 'ai:cos', recommend: '', openFor: ['human:ada'], snoozedFor: [] },
    { type: 'ask', askId: 'a2', lineIndex: 2, pos: 20, kind: 'paragraph', excerpt: '', by: 'ai:cos', recommend: '', openFor: ['human:Pat'], snoozedFor: [] },
    { type: 'suggestion', markId: 's1', pos: 33, kind: 'replace', by: 'ai:dee', excerpt: '' },
    { type: 'suggestion', markId: 's2', pos: 43, kind: 'replace', by: ME, excerpt: '' },
    { type: 'comment', markId: 'c1', pos: 55, kind: 'comment', by: 'ai:dee', excerpt: '' },
    { type: 'line', lineIndex: 0, pos: 0, kind: 'paragraph', excerpt: '', hash: 'h0', reasons: ['unseen'], unseenBy: [ME], changedFor: [], rejectedBy: [], skimmedBy: [] },
    { type: 'nomination', nominationId: 'n', lineIndex: null, pos: null, kind: 'nomination', excerpt: '', by: 'ai:x', email: 'e@x', name: null, why: '', openFor: [ME] },
  ];
  assert.deepEqual(needsYouLines(issues, ME, lineAtPos), [1, 3, 5]);
});

test('needs you: a snoozed ask waits quietly; my out-of-date mark needs me; one dot per line', () => {
  const snoozed: ProofIssue = { type: 'ask', askId: 'a', lineIndex: 1, pos: 10, kind: 'p', excerpt: '', by: 'ai:cos', recommend: '', openFor: [ME], snoozedFor: [ME] };
  assert.equal(issueNeedsViewer(snoozed, ME), NEEDS_YOU_POLICY.snoozedAsk);
  const changed: ProofIssue = { type: 'line', lineIndex: 4, pos: 40, kind: 'p', excerpt: '', hash: 'h4', reasons: ['unseen', 'changed'], unseenBy: [ME], changedFor: [ME], rejectedBy: [], skimmedBy: [] };
  assert.equal(issueNeedsViewer(changed, ME), true);
  assert.equal(issueNeedsViewer({ ...changed, changedFor: ['human:Pat'] } as ProofIssue, ME), false);
  const two: ProofIssue[] = [
    { type: 'suggestion', markId: 'x', pos: 41, kind: 'replace', by: 'ai:dee', excerpt: '' },
    { type: 'comment', markId: 'y', pos: 42, kind: 'comment', by: 'ai:dee', excerpt: '' },
  ];
  assert.deepEqual(needsYouLines(two, ME, lineAtPos), [4], 'two Issues on one line are one amber dot');
});

test('marked up to: the newest explicit mark; dwell, section and edit marks do not count', () => {
  const marks = [
    mark(1, '2026-09-21T10:00:00Z', 'key'),
    mark(3, '2026-09-21T10:05:00Z', 'click'),
    mark(4, '2026-09-21T10:09:00Z', 'dwell', ME, 'seen'),
    mark(5, '2026-09-21T10:10:00Z', 'edit'),
    mark(2, '2026-09-21T10:11:00Z', 'key', 'human:Pat'),
  ];
  const states = buildLineStates(lines, marks);
  assert.deepEqual(markedUpTo(states, ME), { line: 3, at: '2026-09-21T10:05:00Z', status: 'agreed' });
  assert.equal(markedUpTo(buildLineStates(lines, [mark(4, '2026-09-21T10:09:00Z', 'dwell', ME, 'seen')]), ME), null);
  // An older mark without a via reads as "api" (a deliberate mark).
  assert.equal(markedUpTo(buildLineStates(lines, [mark(2, '2026-09-20T10:00:00Z', null)]), ME)?.line, 2);
});

test('formatAgo and issuesLeftText read plainly', () => {
  const now = Date.parse('2026-09-21T12:00:00Z');
  assert.equal(formatAgo('2026-09-21T11:59:30Z', now), 'just now');
  assert.equal(formatAgo('2026-09-21T11:58:00Z', now), '2 min ago');
  assert.equal(formatAgo('2026-09-21T09:00:00Z', now), '3 h ago');
  assert.equal(formatAgo('2026-09-20T11:00:00Z', now), 'yesterday');
  assert.equal(formatAgo('not a date', now), '');
  assert.equal(issuesLeftText(0), 'Nothing needs you');
  assert.equal(issuesLeftText(1), '1 Issue left');
  assert.equal(issuesLeftText(12), '12 Issues left');
});

console.log(`\n${passed} layout-status tests passed`);
