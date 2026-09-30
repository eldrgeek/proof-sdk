/** ac-t17: the server uses the page's reviewSurface, while snapshots keep their old gate. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reviewAlignment } from '../shared/review-list';
import { computeStep1Team, anchorForLine, actorKey } from '../shared/line-marks';
import { typedDiscussionId } from '../shared/typed-discussion';
const temp = mkdtempSync(path.join(tmpdir(), 'accord-review-alignment-'));
process.env.DATABASE_PATH = path.join(temp, 'test.db');
process.env.SNAPSHOT_DIR = path.join(temp, 'snapshots');
const db = await import('../../server/db');
const { buildIssueReport } = await import('../../server/line-marks');
const { documentReviewAlignment } = await import('../../server/review-alignment');
const { startThreadRow, undoStartThread, replyOnThread } = await import('../../server/threads');
const { getThreadRow, listThreadRows } = await import('../../server/proof-extras-store');
const { freezeIfAligned } = await import('../../server/alignment');
let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log(`✓ ${name}`); }
const slug = 'alignment-discussions';
const markdown = 'Agreed words stay here.\n\nAnother item.';
const alice = 'human:alice@example.test', bob = 'human:bob@example.test';
db.createDocument(slug, markdown, {}, 'Alignment', alice, 'test-owner-secret');
const reportFor = (marks: unknown) => buildIssueReport(slug, markdown, marks, { teamExtra: [alice, bob] });
try {
  await test('unmarked document with no open items is in accord; snapshot gate is unchanged', async () => {
    const report = await reportFor({});
    assert.equal(report.aligned, false);
    const result = documentReviewAlignment(slug, report, {});
    assert.equal(result.aligned, true); assert.equal(result.counts.total, 0); assert.equal(result.counts.lines, 2);
    assert.equal((await freezeIfAligned(slug, markdown, report)).snapshot, null);
  });
  const pending = { s: { kind: 'replace', by: alice, quote: 'Agreed words stay here.', content: 'Changed words.', status: 'pending' } };
  await test('one pending proposal is one open item', async () => {
    const result = documentReviewAlignment(slug, await reportFor(pending), pending);
    assert.equal(result.aligned, false); assert.equal(result.counts.total, 1); assert.equal(result.counts.reviewMarkIssues, 1);
    assert.equal(result.counts.lineIssues, 0);
  });
  await test('a pending proposal stays open when only its author has joined', () => {
    const result = reviewAlignment({ viewer: alice, team: [alice], lineCount: 1, lineAtPos: () => 0,
      issues: [{ type: 'suggestion', markId: 'only', kind: 'insert', by: alice, pos: 1, excerpt: 'words' }] });
    assert.equal(result.counts.total, 1); assert.equal(result.aligned, false);
  });
  await test('an unanchored legacy mark has no page item; a stored thread can still survive it', async () => {
    const marks = { missing: { kind: 'insert', by: alice, quote: 'Text that is gone', content: 'Lost anchor', status: 'pending' } };
    assert.equal(documentReviewAlignment(slug, await reportFor(marks), marks).counts.total, 0);
  });
  await test('acceptance and rejection close the proposal and both decision-makers join the team', async () => {
    for (const status of ['accepted', 'rejected']) {
      const marks = { s: { ...pending.s, status, resolvedBy: 'human:decision@example.test' } };
      const result = documentReviewAlignment(slug, await reportFor(marks), marks);
      assert.equal(result.aligned, true); assert.equal(result.counts.total, 0);
      assert(result.team.some(actor => actorKey(actor) === actorKey('human:decision@example.test')));
    }
    assert.deepEqual(computeStep1Team({ reviewMarks: [{ by: alice, resolvedBy: bob }] }), [alice, bob]);
  });
  await test('counts deduplicate multiple proposals/asks on one item, as the page does', () => {
    const result = reviewAlignment({ viewer: bob, team: [alice, bob], lineCount: 2, lineAtPos: () => 0, issues: [
      { type: 'suggestion', markId: 's', kind: 'insert', by: alice, pos: 1, excerpt: 'Words' },
      { type: 'ask', askId: 'a', lineIndex: 0, pos: 1, kind: 'paragraph', by: alice, excerpt: 'Question', recommend: 'Yes', openFor: [bob], snoozedFor: [] },
    ] });
    assert.equal(result.counts.total, 1); assert.equal(result.counts.askIssues, 1); assert.equal(result.counts.reviewMarkIssues, 0);
  });
  const report = await reportFor({});
  const anchor = anchorForLine(report.docLines![0]);
  async function start(id: string) {
    const result = await startThreadRow(slug, { by: alice, markdown, source: 'page', body: {
      id, markId: `c-${id}`, asks: 'answer', text: 'Why?', anchor: [anchor], waitingOn: [bob],
    } });
    assert.equal(result.status, 200);
  }
  await test('stored discussion is open without a comment mark and after its answer until author closes', async () => {
    const id = typedDiscussionId('unanswered'); await start(id);
    assert.equal(documentReviewAlignment(slug, report, {}).counts.total, 1);
    replyOnThread(slug, { id, by: bob, text: 'Because.', source: 'page' });
    assert.equal(documentReviewAlignment(slug, report, {}).counts.total, 1);
    assert.equal(undoStartThread(slug, { id, by: alice, marks: {} }).status, 409);
    assert(getThreadRow(slug, id));
  });
  await test('typed thread undo refuses mark-only replies and another author', async () => {
    const id = typedDiscussionId('mark-reply'); await start(id);
    assert.equal(undoStartThread(slug, { id, by: bob }).status, 403);
    assert.equal(undoStartThread(slug, { id, by: alice, marks: { [`c-${id}`]: { replies: [{ by: bob, text: 'Reply' }] } } }).status, 409);
    assert(getThreadRow(slug, id));
  });
  await test('an unanswered typed thread is removed through its existing undo route', async () => {
    const id = typedDiscussionId('remove'); await start(id);
    assert.equal(undoStartThread(slug, { id, by: alice, marks: {} }).status, 200);
    assert(!listThreadRows(slug).some(row => row.id === id));
  });
  console.log(`${passed} review alignment checks passed`);
} finally { rmSync(temp, { recursive: true, force: true }); }
