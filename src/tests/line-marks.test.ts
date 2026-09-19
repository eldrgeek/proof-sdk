// Proof Documents Step 1: line marks — issue computation, hash reset, team, and the HTTP routes.
// Authorship: Claude Opus 5 (worker proof-line-marks), 2026-09-18.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-line-marks-'));
process.env.DATABASE_PATH = path.join(temp, 'test.db');
const shared = await import('../shared/line-marks');
const serverLines = await import('../../server/line-marks');
const db = await import('../../server/db');
const { apiRoutes } = await import('../../server/routes');
const { agentRoutes } = await import('../../server/agent-routes');

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const doc = `# Title

First paragraph about alignment.

- A list item
- Another item

| Name | Role |
| --- | --- |
| Mike | Owner |
| Claude | AI |

Last paragraph.`;

const app = express();
app.use(express.json());
app.use('/api', apiRoutes);
app.use('/api/agent', agentRoutes);
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const clientHeaders = { 'X-Proof-Client-Version': '0.31.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
const call = async (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...clientHeaders, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
};

try {
  const lines = await serverLines.computeServerLines(doc);

  await test('lines: headings, paragraphs, list items and table rows (header row included)', () => {
    assert.deepEqual(lines.map(line => line.kind), [
      'heading', 'paragraph', 'list_item', 'list_item', 'table_row', 'table_row', 'table_row', 'paragraph',
    ]);
    assert.equal(lines[5].text, 'Mike | Owner');
    assert.equal(lines[4].block, lines[6].block, 'table rows share one top-level block');
  });

  await test('lines: proof span tags do not change hashes', async () => {
    const withSpan = doc.replace('about alignment', '<span data-proof="comment" data-id="c1" data-by="ai:x">about alignment</span>');
    const spanLines = await serverLines.computeServerLines(withSpan);
    assert.equal(spanLines[1].hash, lines[1].hash);
  });

  await test('lines: duplicate lines get distinct occurrences', async () => {
    const dup = await serverLines.computeServerLines('Same line.\n\nOther.\n\nSame line.');
    assert.equal(dup[0].hash, dup[2].hash);
    assert.deepEqual([dup[0].occurrence, dup[2].occurrence], [0, 1]);
    const mark = { id: 'm', by: 'human:A', status: 'seen' as const, at: 't', anchor: shared.anchorForLine(dup[2]) };
    assert.deepEqual(shared.resolveLineAnchor(dup, mark.anchor), { lineIndex: 2, current: true });
  });

  const mk = (by: string, line: typeof lines[number], status: 'seen' | 'agreed' | 'approved' | 'rejected', reason?: string) => ({
    id: `${by}-${line.index}-${status}`, by, status, reason: reason ?? null, at: new Date().toISOString(), anchor: shared.anchorForLine(line),
  });

  await test('issues: every line is an issue until every team member has marked it', () => {
    const team = ['human:Mike', 'ai:claude'];
    const none = shared.computeIssues({ lines, lineMarks: [], team });
    assert.equal(none.counts.total, lines.length);
    assert.equal(none.aligned, false);
    const all = lines.flatMap(line => [mk('human:Mike', line, 'seen'), mk('AI:Claude', line, 'agreed')]);
    const done = shared.computeIssues({ lines, lineMarks: all, team });
    assert.equal(done.counts.total, 0, 'actor names compare case-insensitively');
    assert.equal(done.aligned, true);
  });

  await test('issues: a rejection is an issue even when everyone has marked the line', () => {
    const team = ['human:Mike', 'ai:claude'];
    const all = lines.flatMap(line => [mk('human:Mike', line, line.index === 1 ? 'rejected' : 'seen', line.index === 1 ? 'too vague' : undefined), mk('ai:claude', line, 'seen')]);
    const result = shared.computeIssues({ lines, lineMarks: all, team });
    assert.equal(result.counts.total, 1);
    const issue = result.issues[0];
    assert.equal(issue.type, 'line');
    if (issue.type === 'line') {
      assert.deepEqual(issue.reasons, ['rejected']);
      assert.deepEqual(issue.rejectedBy, [{ by: 'human:Mike', reason: 'too vague' }]);
    }
  });

  await test('issues: open comments and pending suggestions are issues; resolved and accepted are not', () => {
    const all = lines.map(line => mk('human:Mike', line, 'seen'));
    const result = shared.computeIssues({
      lines, lineMarks: all, team: ['human:Mike'],
      reviewMarks: [
        { id: 'c1', kind: 'comment', by: 'ai:claude', open: true, pos: 5 },
        { id: 'c2', kind: 'comment', by: 'ai:claude', open: false, pos: 9 },
        { id: 's1', kind: 'replace', by: 'ai:claude', open: true, pos: 50 },
        { id: 's2', kind: 'insert', by: 'ai:claude', open: false, pos: 60 },
      ],
    });
    assert.deepEqual(result.issues.map(issue => issue.type === 'line' ? 'line' : issue.markId), ['c1', 's1']);
  });

  await test('hash reset: editing a line makes every mark on it unseen (stale, shown as changed)', async () => {
    const edited = await serverLines.computeServerLines(doc.replace('First paragraph about alignment.', 'First paragraph about alignment, revised.'));
    const marks = [mk('human:Mike', lines[1], 'agreed'), mk('ai:claude', lines[1], 'seen'), mk('human:Mike', lines[2], 'seen')];
    const states = shared.buildLineStates(edited, marks);
    assert.equal(states[1].marks.get('human:mike')?.current, false, 'edited line: stale');
    assert.equal(states[1].marks.get('ai:claude')?.current, false);
    assert.equal(states[2].marks.get('human:mike')?.current, true, 'untouched line keeps its mark');
    const result = shared.computeIssues({ lines: edited, lineMarks: marks, team: ['human:Mike', 'ai:claude'] });
    const issue = result.issues.find(i => i.type === 'line' && i.lineIndex === 1);
    assert.ok(issue && issue.type === 'line' && issue.reasons.includes('changed') && issue.unseenBy.length === 2);
    // Restoring the text brings the marks back (the hash matches again).
    const restored = shared.buildLineStates(lines, marks);
    assert.equal(restored[1].marks.get('human:mike')?.current, true);
  });

  await test('hash reset: inserting a line above does not reset marks below', async () => {
    const shifted = await serverLines.computeServerLines(doc.replace('# Title\n', '# Title\n\nA new opening line.\n'));
    const marks = [mk('human:Mike', lines[7], 'agreed')];
    const states = shared.buildLineStates(shifted, marks);
    assert.equal(states[8].marks.get('human:mike')?.current, true);
  });

  await test('team: owner + markers + commenters + repliers + agent keys, de-duplicated', () => {
    const team = shared.computeStep1Team({
      owners: ['human:Mike Wolf'],
      lineMarks: [{ by: 'human:mike wolf' }, { by: 'human:Eric' }],
      reviewMarks: [{ by: 'ai:claude', replies: [{ by: 'human:Eric' }, { by: 'human:Dana' }] }],
      agentKeyActors: [shared.agentKeyActor('Claude (COS)')],
      extra: ['human:user'],
    });
    assert.deepEqual(team, ['human:Mike Wolf', 'human:Eric', 'ai:claude', 'human:Dana', 'ai:claude-cos', 'human:user']);
  });

  await test('agent target: lineIndex, hash, ref and quote; ambiguous quotes are refused', () => {
    assert.equal((serverLines.resolveAgentLineTarget(lines, { lineIndex: 2 }) as any).line.index, 2);
    assert.equal((serverLines.resolveAgentLineTarget(lines, { hash: lines[3].hash }) as any).line.index, 3);
    assert.equal((serverLines.resolveAgentLineTarget(lines, { ref: 'b1' }) as any).line.index, 0);
    assert.equal((serverLines.resolveAgentLineTarget(lines, { quote: 'Another item' }) as any).line.index, 3);
    assert.equal((serverLines.resolveAgentLineTarget(lines, { ref: 'b4', quote: 'Claude' }) as any).line.index, 6);
    const ambiguous = serverLines.resolveAgentLineTarget(lines, { quote: 'item' });
    assert.equal(ambiguous.ok, false);
    assert.equal((ambiguous as any).code, 'AMBIGUOUS_LINE');
    assert.equal((serverLines.resolveAgentLineTarget(lines, { hash: 'nope' }) as any).code, 'LINE_CHANGED');
  });

  // ---------------- HTTP routes ----------------
  const slug = 'lm-test';
  db.createDocument(slug, doc, {}, 'Line marks test', 'owner-1', 'owner-secret-123');
  const editor = db.createDocumentAccessToken(slug, 'editor', undefined, { label: 'Claude (COS)', requestedBy: 'test', requestedFrom: '127.0.0.1' });
  const viewer = db.createDocumentAccessToken(slug, 'viewer');

  await test('page route: a person marks a line; the mark is listed; others see it', async () => {
    const anchor = shared.anchorForLine(lines[1]);
    const set = await call(`/api/documents/${slug}/line-marks`, 'POST', { by: 'human:Eric', status: 'agreed', anchor });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const list = await call(`/api/documents/${slug}/line-marks`);
    assert.equal(list.status, 200);
    assert.equal(list.body.lineMarks.length, 1);
    assert.equal(list.body.lineMarks[0].status, 'agreed');
    assert.deepEqual(list.body.agentKeyActors, ['ai:claude-cos']);
    assert.equal(list.body.viewer.canApprove, false);
  });

  await test('page route: re-marking replaces the actor\'s mark; unseen clears it', async () => {
    const anchor = shared.anchorForLine(lines[1]);
    await call(`/api/documents/${slug}/line-marks`, 'POST', { by: 'human:Eric', status: 'seen', anchor });
    let list = await call(`/api/documents/${slug}/line-marks`);
    assert.equal(list.body.lineMarks.length, 1);
    assert.equal(list.body.lineMarks[0].status, 'seen');
    await call(`/api/documents/${slug}/line-marks`, 'POST', { by: 'human:Eric', status: 'unseen', anchor });
    list = await call(`/api/documents/${slug}/line-marks`);
    assert.equal(list.body.lineMarks.length, 0);
  });

  await test('page route: reject needs a reason; approve needs an owner; a viewer cannot mark', async () => {
    const anchor = shared.anchorForLine(lines[2]);
    const noReason = await call(`/api/documents/${slug}/line-marks`, 'POST', { by: 'human:Eric', status: 'rejected', anchor });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.code, 'REASON_REQUIRED');
    const notOwner = await call(`/api/documents/${slug}/line-marks`, 'POST', { by: 'human:Eric', status: 'approved', anchor });
    assert.equal(notOwner.status, 403);
    const owner = await call(`/api/documents/${slug}/line-marks`, 'POST', { by: 'human:Mike', status: 'approved', anchor }, { 'x-share-token': 'owner-secret-123' });
    assert.equal(owner.status, 200, JSON.stringify(owner.body));
    const ownerList = await call(`/api/documents/${slug}/line-marks`, 'GET', undefined, { 'x-share-token': 'owner-secret-123' });
    assert.equal(ownerList.body.viewer.canApprove, true);
    const asViewer = await call(`/api/documents/${slug}/line-marks`, 'POST', { by: 'human:V', status: 'seen', anchor }, { 'x-share-token': viewer.secret });
    assert.equal(asViewer.status, 403);
  });

  await test('agent route: an AI key marks by quote, defaults "by" to its key, cannot pose as a human or approve', async () => {
    const headers = { 'x-share-token': editor.secret };
    const set = await call(`/api/agent/${slug}/marks/line`, 'POST', { quote: 'Last paragraph', status: 'seen' }, headers);
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.lineMark.by, 'ai:claude-cos');
    assert.equal(set.body.line.lineIndex, 7);
    const human = await call(`/api/agent/${slug}/marks/line`, 'POST', { quote: 'Last paragraph', status: 'seen', by: 'human:Mike' }, headers);
    assert.equal(human.status, 403);
    const approve = await call(`/api/agent/${slug}/marks/line`, 'POST', { quote: 'Last paragraph', status: 'approved', by: 'ai:claude' }, headers);
    assert.equal(approve.status, 403);
    const reject = await call(`/api/agent/${slug}/marks/line`, 'POST', { lineIndex: 0, status: 'rejected', reason: 'Title is vague', by: 'ai:claude' }, headers);
    assert.equal(reject.status, 200, JSON.stringify(reject.body));
  });

  await test('/state returns line marks, lines, the team and the computed issue list', async () => {
    const state = await call(`/api/agent/${slug}/state`, 'GET', undefined, { 'x-share-token': editor.secret });
    assert.equal(state.status, 200);
    assert.ok(Array.isArray(state.body.lineMarks) && state.body.lineMarks.length === 3, `lineMarks ${JSON.stringify(state.body.lineMarks)}`);
    assert.equal(state.body.lines.length, lines.length);
    assert.equal(state.body.lines[5].ref, 'b4');
    const team: string[] = state.body.alignment.team;
    assert.ok(team.includes('ai:claude-cos') && team.includes('ai:claude') && team.includes('human:Mike'), team.join(','));
    assert.equal(state.body.alignment.aligned, false);
    const rejected = state.body.issues.find((issue: any) => issue.type === 'line' && issue.lineIndex === 0);
    assert.deepEqual(rejected.rejectedBy, [{ by: 'ai:claude', reason: 'Title is vague' }]);
    assert.equal(state.body._links.lineMark.href, `/api/agent/${slug}/marks/line`);
  });

  console.log(`\nline-marks tests: ${passed} passed`);
} finally {
  server.close();
  rmSync(temp, { recursive: true, force: true });
}
