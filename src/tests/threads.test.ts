// Accord round 2, stage D — threads live in the document, not the chat.
// The two things most likely to go wrong are tested first and hardest:
//   1. one object without orphaning anything already on a live document (the adapter);
//   2. anchoring — deleting the anchored text detaches the thread and says so, and NEVER deletes
//      an unresolved disagreement.
// Authorship: Mike Wolf (rulings), built by Claude Opus 5 (worker accord-threads), 2026-09-22.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RoomMessageLike, StartThreadInput, Thread, ThreadAsks, ThreadSource } from '../shared/threads';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-threads-'));
process.env.DATABASE_PATH = path.join(temp, 'test.db');

const T = await import('../shared/threads');
const serverLines = await import('../../server/line-marks');
const store = await import('../../server/proof-extras-store');

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const doc = `# Plan

## Claims

Revenue doubled in the second quarter of this year.

Every customer asked for the export button first.

We will ship the export button in October.

## Notes

The team met on Tuesday to review the plan.`;

const lines = await serverLines.computeServerLines(doc);
const CLAIM = lines.findIndex(l => l.text.startsWith('Revenue doubled'));
const EXPORT = lines.findIndex(l => l.text.startsWith('Every customer'));
const SHIP = lines.findIndex(l => l.text.startsWith('We will ship'));
assert.ok(CLAIM > 0 && EXPORT > 0 && SHIP > 0, 'fixture lines found');

const MIKE = 'human:mw@mike-wolf.com';
const ERIC = 'human:eric@example.com';
const AI = 'ai:claude-cos';

function start(asks: ThreadAsks, at: number[], options: Partial<StartThreadInput> = {}): Thread {
  return T.startThread({
    by: MIKE,
    lines: at.map(i => lines[i]),
    doc: lines,
    asks,
    text: 'Is this still true?',
    at: '2026-09-22T10:00:00.000Z',
    ...options,
  });
}

// ============================================================================
// 1. One object: nothing already on a document is orphaned
// ============================================================================

await test('a comment already on a document reads as a thread that asks "just a comment"', () => {
  const views = T.evaluateThreads({
    lines,
    marks: [{ id: 'm1', kind: 'comment', by: ERIC, at: '2026-09-01T00:00:00Z', quote: lines[CLAIM].text, text: 'Where is this from?', replies: [{ by: MIKE, text: 'The Q2 deck.', at: '2026-09-02T00:00:00Z' }], resolved: false }],
    lineOf: () => CLAIM,
  });
  assert.equal(views.length, 1);
  const view = views[0];
  assert.equal(view.thread.asks, 'comment');
  assert.equal(view.thread.kind, 'discussion');
  assert.equal(view.thread.source, 'comment');
  assert.equal(view.thread.text, 'Where is this from?');
  assert.equal(view.thread.replies.length, 1, 'its replies came with it');
  assert.equal(view.thread.markId, 'm1', 'it is still the same mark');
  assert.equal(view.lineIndex, CLAIM, 'it is on the line it was on');
  assert.equal(view.thread.status, 'open');
});

await test('a suggestion already on a document reads as a proposal that asks "accept or reject"', () => {
  const [view] = T.evaluateThreads({
    lines,
    marks: [{ id: 's1', kind: 'replace', by: ERIC, at: '2026-09-01T00:00:00Z', quote: lines[SHIP].text, content: 'We will ship the export button in November.', status: 'pending' }],
    lineOf: () => SHIP,
  });
  assert.equal(view.thread.kind, 'proposal');
  assert.equal(view.thread.asks, 'accept-reject');
  assert.equal(view.thread.diff?.kind, 'replace');
  assert.equal(view.thread.diff?.content, 'We will ship the export button in November.');
  assert.equal(view.thread.status, 'open');
});

await test('an accepted or rejected suggestion reads as a closed thread, not an open one', () => {
  for (const [status, expected] of [['accepted', 'accepted'], ['rejected', 'rejected']] as const) {
    const [view] = T.evaluateThreads({
      lines,
      marks: [{ id: `s-${status}`, kind: 'replace', by: ERIC, quote: lines[SHIP].text, content: 'x', status }],
      lineOf: () => SHIP,
    });
    assert.equal(view.thread.status, expected);
    assert.equal(view.open, false);
    assert.equal(T.threadOpenFor(view, MIKE).open, false);
  }
});

await test('a resolved comment reads as a resolved thread', () => {
  const [view] = T.evaluateThreads({
    lines,
    marks: [{ id: 'm2', kind: 'comment', by: ERIC, quote: lines[CLAIM].text, text: 'ok', resolved: true }],
    lineOf: () => CLAIM,
  });
  assert.equal(view.thread.status, 'resolved');
  assert.equal(T.threadOpenFor(view, MIKE).open, false);
});

await test('the `?` clarify gesture produces the SAME object, asking clarify, not a separate explain', () => {
  const [view] = T.evaluateThreads({
    lines,
    marks: [{ id: 'm3', kind: 'comment', by: MIKE, quote: lines[CLAIM].text, text: 'Explain: Please clarify this sentence.' }],
    explains: [{ id: 'e1', by: MIKE, commentMarkId: 'm3', question: 'Please clarify this sentence.', createdAt: '2026-09-22T00:00:00Z' }],
    lineOf: () => CLAIM,
  });
  assert.equal(view.thread.asks, 'clarify');
  assert.equal(view.thread.source, 'explain');
  assert.equal(view.thread.markId, 'm3', 'it is one object: the same comment mark');
  // It must remain not-an-Issue for the asker, and must not mark the line.
  assert.equal(T.threadOpenFor(view, MIKE).open, false, 'never an Issue for the asker');
  assert.equal(T.THREAD_POLICY.clarifyMarksLine, false);
  // ...and it IS the AIs' to answer.
  assert.equal(T.threadOpenFor(view, AI).open, true);
  assert.equal(T.threadOpenFor(view, AI).why, 'clarify');
  // An answer closes it.
  const answered = T.evaluateThread({ ...view.thread, replies: [{ by: AI, text: 'It means…', at: '2026-09-22T01:00:00Z' }] }, lines);
  assert.equal(T.threadOpenFor(answered, AI).open, false);
});

await test('one resolve rule, one fold rule, one Undo kind: every source ends in the same statuses', () => {
  const sources: ThreadSource[] = ['thread', 'comment', 'suggestion', 'explain'];
  for (const source of sources) {
    const thread: Thread = { ...start('answer', [CLAIM]), source, status: 'resolved', closedBy: MIKE };
    const view = T.evaluateThread(thread, lines);
    assert.equal(T.threadFoldsFor(view, MIKE), true, `${source} folds for whoever closed it`);
    assert.equal(T.threadFoldsFor(view, ERIC), false, `${source} does not fold for anyone else`);
    assert.equal(T.threadClosureKind(thread), 'resolved');
  }
});

await test('a thread row whose comment mark is gone still exists and still says what it was about', () => {
  const thread = start('yes-no', [CLAIM], { markId: 'gone-1' });
  const views = T.evaluateThreads({ lines, marks: [], meta: [T.threadMetaOf(thread)] });
  assert.equal(views.length, 1, 'deleting the mark did not delete the disagreement');
  assert.equal(views[0].thread.asks, 'yes-no');
  assert.equal(T.threadOpenFor(views[0], ERIC).open, true);
});

// ============================================================================
// 2. Anchoring: follow an edit, detach from a deletion, never delete
// ============================================================================

await test('the anchored text is edited but survives: the thread follows it', async () => {
  const thread = start('yes-no', [CLAIM]);
  const edited = await serverLines.computeServerLines(doc.replace('Revenue doubled in the second quarter of this year.', 'Revenue roughly doubled in the second quarter of this year.'));
  const view = T.evaluateThread(thread, edited);
  assert.equal(view.detached, false, 'an edited line is not a deleted one');
  assert.equal(view.changed, true, 'and the thread says the line changed');
  assert.equal(edited[view.lineIndex as number].text, 'Revenue roughly doubled in the second quarter of this year.');
  assert.equal(T.threadOpenFor(view, ERIC).open, true, 'it is still open');
  assert.equal(T.threadOpenFor(view, ERIC).why, 'yes-or-no', 'and still says what it needs');
});

await test('the anchored text moves: the thread follows it, unchanged', async () => {
  const thread = start('yes-no', [CLAIM]);
  const moved = await serverLines.computeServerLines(doc.replace('## Notes\n\nThe team met on Tuesday to review the plan.', '## Notes\n\nThe team met on Tuesday to review the plan.\n\nRevenue doubled in the second quarter of this year.').replace('Revenue doubled in the second quarter of this year.\n\nEvery customer', 'Every customer'));
  const view = T.evaluateThread(thread, moved);
  assert.equal(view.detached, false);
  assert.equal(moved[view.lineIndex as number].text, 'Revenue doubled in the second quarter of this year.');
});

await test('DELETING THE ANCHORED TEXT DETACHES THE THREAD AND SAYS SO — it never deletes it', async () => {
  const thread = start('yes-no', [CLAIM]);
  const deleted = await serverLines.computeServerLines(doc.replace('Revenue doubled in the second quarter of this year.\n\n', ''));
  const view = T.evaluateThread(thread, deleted);
  assert.equal(view.detached, true, 'the thread detached');
  assert.equal(view.deletedLines, 1);
  assert.notEqual(view.lineIndex, null, 'it attached to the nearest surviving line');
  assert.ok(deleted[view.lineIndex as number], 'that line exists');
  const notice = T.detachedNotice(view);
  assert.match(notice, /the text this was about has changed/);
  assert.match(notice, /Revenue doubled in the second quarter of this year\./, 'with the original quoted');
});

await test('a detached thread with an open question is still an Issue for the people it was waiting on', async () => {
  const thread = start('yes-no', [CLAIM], { waitingOn: [ERIC] });
  const deleted = await serverLines.computeServerLines(doc.replace('Revenue doubled in the second quarter of this year.\n\n', ''));
  const view = T.evaluateThread(thread, deleted);
  const forEric = T.threadOpenFor(view, ERIC);
  assert.equal(forEric.open, true, 'still an Issue for Eric');
  assert.equal(forEric.why, 'detached');
  assert.equal(forEric.detached, true);
  assert.match(forEric.because, /the text this was about has changed/);
  assert.match(forEric.because, /yes or a no/, 'and it still says what it needs');
  assert.deepEqual(forEric.waitingOn, [ERIC]);
  // ...and not for someone it never named.
  assert.equal(T.threadOpenFor(view, 'human:someone@else.com').open, false);
});

await test('deleting the text of a "just a comment" thread detaches it too, and it is still nobody’s Issue', async () => {
  const thread = start('comment', [CLAIM]);
  const deleted = await serverLines.computeServerLines(doc.replace('Revenue doubled in the second quarter of this year.\n\n', ''));
  const view = T.evaluateThread(thread, deleted);
  assert.equal(view.detached, true, 'it is not deleted');
  assert.equal(T.threadOpenFor(view, ERIC).open, false, 'but it was never a disagreement');
});

await test('a thread over several lines survives losing some of them and stays attached to the rest', async () => {
  const thread = start('wording', [CLAIM, EXPORT]);
  const deleted = await serverLines.computeServerLines(doc.replace('Revenue doubled in the second quarter of this year.\n\n', ''));
  const view = T.evaluateThread(thread, deleted);
  assert.equal(view.detached, false, 'one line survived, so it is not detached');
  assert.equal(view.deletedLines, 1);
  assert.equal(deleted[view.lineIndex as number].text, 'Every customer asked for the export button first.');
});

await test('detaching in an emptied document does not throw and still keeps the thread', async () => {
  const thread = start('answer', [CLAIM]);
  const view = T.evaluateThread(thread, []);
  assert.equal(view.detached, true);
  assert.equal(view.lineIndex, null);
  assert.equal(T.threadOpenFor(view, ERIC).open, true, 'the question is still open');
});

await test('re-anchoring after an edit starts the next read from the current text', async () => {
  const thread = start('yes-no', [CLAIM]);
  const edited = await serverLines.computeServerLines(doc.replace('Revenue doubled in the second quarter of this year.', 'Revenue roughly doubled in the second quarter of this year.'));
  const view = T.evaluateThread(thread, edited);
  const anchor = T.reanchorThread(thread, view, edited, '2026-09-22T12:00:00Z');
  const again = T.evaluateThread({ ...thread, anchor }, edited);
  assert.equal(again.changed, false, 'the re-anchored thread matches its line exactly');
  assert.equal(again.lineIndex, view.lineIndex);
  assert.equal(T.threadQuote({ ...thread, anchor }), 'Revenue doubled in the second quarter of this year.', 'the ORIGINAL is still what it quotes');
});

// ============================================================================
// 3. Every thread states what would close it
// ============================================================================

await test('every closing condition has words, and the five offered choices exclude clarify', () => {
  for (const asks of T.THREAD_ASKS) {
    assert.ok(T.THREAD_ASK_LABEL[asks], `${asks} has a label`);
    assert.ok(T.THREAD_ASK_HELP[asks], `${asks} says what it means`);
  }
  assert.equal(T.THREAD_ASK_CHOICES.length, 5, 'five choices, "just a comment" among them');
  assert.ok(T.THREAD_ASK_CHOICES.includes('comment'), '"just a comment" is an explicit choice, not an empty state');
  assert.ok(!T.THREAD_ASK_CHOICES.includes('clarify'), 'clarify is what ? produces, not a choice');
  assert.equal(T.THREAD_POLICY.closingConditionRequired, true);
});

await test('a proposal defaults to accept-or-reject and a discussion to someone-answer-this', () => {
  assert.equal(T.defaultAsksFor('proposal'), 'accept-reject');
  assert.equal(T.defaultAsksFor('discussion'), 'answer');
  assert.equal(T.THREAD_ASK_LABEL[T.defaultAsksFor('proposal')], 'accept or reject');
});

await test('a discussion that gains a wording becomes a proposal and resolves by accept or reject', () => {
  const discussion = start('answer', [SHIP]);
  assert.deepEqual(T.resolutionsFor(discussion).map(r => r.status), ['resolved', 'withdrawn']);
  const proposal: Thread = { ...discussion, kind: 'proposal', asks: 'accept-reject', diff: { kind: 'replace', quote: lines[SHIP].text, content: 'We will ship it in November.' } };
  assert.deepEqual(T.resolutionsFor(proposal).map(r => r.status), ['accepted', 'rejected']);
  const view = T.evaluateThread(proposal, lines);
  assert.equal(T.threadOpenFor(view, ERIC).why, 'accept-or-reject');
});

await test('"someone answers" closes for everyone once anyone answers, and asks its author to close it', () => {
  const asked = T.evaluateThread(start('answer', [CLAIM]), lines);
  assert.equal(T.threadOpenFor(asked, ERIC).why, 'answer-this');
  assert.equal(T.threadOpenFor(asked, MIKE).open, false, 'not open for whoever asked');
  const answered = T.evaluateThread({ ...asked.thread, replies: [{ by: ERIC, text: 'Yes.', at: '2026-09-22T11:00:00Z' }] }, lines);
  assert.equal(T.threadOpenFor(answered, ERIC).open, false);
  assert.equal(T.threadOpenFor(answered, MIKE).why, 'close-yours');
});

await test('"yes or no" stays open per person until that person answers', () => {
  const thread = start('yes-no', [CLAIM], { waitingOn: [ERIC, AI] });
  const view = T.evaluateThread(thread, lines);
  assert.equal(T.threadOpenFor(view, ERIC).open, true);
  assert.equal(T.threadOpenFor(view, AI).open, true);
  const half = T.evaluateThread({ ...thread, replies: [{ by: ERIC, text: 'Yes', at: 'x' }] }, lines);
  assert.equal(T.threadOpenFor(half, ERIC).open, false, 'Eric answered');
  assert.equal(T.threadOpenFor(half, AI).open, true, 'the AI has not');
});

await test('"just a comment" is never an Issue for anyone', () => {
  const view = T.evaluateThread(start('comment', [CLAIM]), lines);
  for (const who of [MIKE, ERIC, AI]) assert.equal(T.threadOpenFor(view, who).open, false, who);
  assert.equal(T.threadOpenFor(view, ERIC).closes, 'just a comment');
});

await test('openThreadsFor returns the viewer’s open threads in document order, each with its reason', () => {
  const views = [
    T.evaluateThread(start('yes-no', [SHIP]), lines),
    T.evaluateThread(start('answer', [CLAIM]), lines),
    T.evaluateThread(start('comment', [EXPORT]), lines),
  ];
  const open = T.openThreadsFor(views, ERIC);
  assert.deepEqual(open.map(o => o.view.lineIndex), [CLAIM, SHIP]);
  assert.deepEqual(open.map(o => o.openness.why), ['answer-this', 'yes-or-no']);
  for (const entry of open) assert.ok(entry.openness.because.length > 0, 'every one says why in a sentence');
});

// ============================================================================
// 4. Guests, resolving, folding
// ============================================================================

await test('a guest may start a discussion but not a proposal that edits text', () => {
  assert.equal(T.guestMayStart('discussion'), true);
  assert.equal(T.guestMayStart('proposal'), false);
});

await test('whoever started a thread may close it; so may anyone it is open for; a bystander may not', () => {
  const view = T.evaluateThread(start('yes-no', [CLAIM], { waitingOn: [ERIC] }), lines);
  assert.equal(T.canResolveThread(view, MIKE), true, 'the author');
  assert.equal(T.canResolveThread(view, ERIC), true, 'the person it waits on');
  assert.equal(T.canResolveThread(view, 'human:nobody@example.com'), false, 'a bystander');
  assert.equal(T.canResolveThread(view, 'human:nobody@example.com', { isOwner: true }), true, 'an Owner');
  const closed = T.evaluateThread({ ...view.thread, status: 'resolved' }, lines);
  assert.equal(T.canResolveThread(closed, MIKE), false, 'a closed thread is not closed again');
});

await test('a resolved thread folds for the viewer who closed it and leaves a summary that names it', () => {
  const thread: Thread = { ...start('answer', [CLAIM]), status: 'resolved', closedBy: ERIC, replies: [{ by: ERIC, text: 'Yes.', at: 'x' }] };
  const view = T.evaluateThread(thread, lines);
  assert.equal(T.threadFoldsFor(view, ERIC), true);
  assert.equal(T.threadFoldsFor(view, MIKE), false, 'it stays visible for everyone else');
  assert.equal(T.foldedThreadSummary(view), '✓ resolved — 1 reply');
  assert.equal(T.foldedThreadSummary(T.evaluateThread({ ...thread, status: 'accepted', replies: [] }, lines)), '✓ change accepted');
});

// ============================================================================
// 5. The Room keeps only what is about no line
// ============================================================================

await test('the Room keeps a message about no line and hands line talk to the document', () => {
  assert.equal(T.roomKeeps({ lines: [], commentMarkId: null, suggestion: null }), true);
  assert.equal(T.roomKeeps({ lines: [{}], commentMarkId: null, suggestion: null }), false, 'a line pointer is line talk');
  assert.equal(T.roomKeeps({ lines: [], commentMarkId: 'm1', suggestion: null }), false, 'a mirrored comment thread is line talk');
  assert.equal(T.roomKeeps({ lines: [], commentMarkId: null, suggestion: { markId: 'x' } }), false, 'a suggestion is line talk');
  const split = T.splitRoom([
    { id: 1, lines: [], commentMarkId: null, suggestion: null },
    { id: 2, lines: [{ lineIndex: 3 }], commentMarkId: null, suggestion: null },
    { id: 3, lines: [], commentMarkId: null, suggestion: null },
  ] as Array<{ id: number } & RoomMessageLike>);
  assert.deepEqual(split.room.map(m => m.id), [1, 3]);
  assert.deepEqual(split.lineTalk.map(m => m.id), [2], 'nothing is dropped: line talk is returned, not deleted');
});

// ============================================================================
// 6. Storage: the thread row round-trips, and nothing is migrated
// ============================================================================

await test('a thread row stores and reads back, and reading a document with no rows is empty', () => {
  assert.deepEqual(store.listThreadRows('no-such-doc'), [], 'a document that never had a thread has none');
  const thread = start('yes-no', [CLAIM], { markId: 'mark-1', waitingOn: [ERIC] });
  store.insertThreadRow('doc-1', T.threadMetaOf(thread));
  const rows = store.listThreadRows('doc-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].asks, 'yes-no');
  assert.equal(rows[0].markId, 'mark-1');
  assert.deepEqual(rows[0].waitingOn, [ERIC]);
  assert.equal(rows[0].anchor.length, 1);
  assert.equal(rows[0].anchor[0].original.hash, thread.anchor[0].original.hash);
  // Closing it is one UPDATE, and it refuses to close twice.
  assert.equal(store.closeThreadRow('doc-1', thread.id, 'resolved', MIKE, '2026-09-22T12:00:00Z'), true);
  assert.equal(store.closeThreadRow('doc-1', thread.id, 'resolved', MIKE, '2026-09-22T12:00:00Z'), false);
  assert.equal(store.listThreadRows('doc-1')[0].status, 'resolved');
  // Reopening (the Undo) puts it back.
  assert.equal(store.reopenThreadRow('doc-1', thread.id), true);
  assert.equal(store.listThreadRows('doc-1')[0].status, 'open');
  assert.equal(store.listThreadRows('doc-1')[0].closedBy, null);
});

console.log(`\n${passed} thread checks passed`);
rmSync(temp, { recursive: true, force: true });
