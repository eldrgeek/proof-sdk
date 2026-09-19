// Proof Documents Step B3: {ask} decision lines — evaluation, Issues, and the HTTP routes.
// Authorship: Claude Opus 5 (worker proof-ask), 2026-09-18.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-asks-'));
process.env.DATABASE_PATH = path.join(temp, 'test.db');
const shared = await import('../shared/line-marks');
const asks = await import('../shared/asks');
const folding = await import('../shared/folding');
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

const doc = `# Waiting on Mike

## Decisions for you

Ship the ask control to Proof tonight?

Move the Waiting on Mike page to the new asks?

## Just so you know

Folding is live.`;

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

const T0 = '2026-09-18T10:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

try {
  const lines = await serverLines.computeServerLines(doc);
  const Q1 = 2; // "Ship the ask control ..."
  const Q2 = 3;
  const mkAsk = (over: Partial<import('../shared/asks').ProofAsk> = {}): import('../shared/asks').ProofAsk => ({
    id: 'a1', by: 'ai:cos', to: ['human:Mike'], recommend: 'Yes: it is tested', ifYes: null,
    anchor: shared.anchorForLine(lines[Q1]), createdAt: T0, askedAt: T0, answers: [], ...over,
  });
  const ans = (by: string, choice: import('../shared/asks').AskChoice, minutes: number, lineHash = lines[Q1].hash, words = '') =>
    ({ id: `x${minutes}${by}`, by, choice, words, at: at(minutes), lineHash });

  await test('evaluate: an unanswered ask is open for everyone in "to"', () => {
    const view = asks.evaluateAsk(mkAsk({ to: ['human:Mike', 'human:Eric'] }), lines);
    assert.equal(view.lineIndex, Q1);
    assert.deepEqual(view.openFor, ['human:Mike', 'human:Eric']);
    assert.equal(view.outcome, 'open');
    assert.equal(view.closed, false);
  });

  await test('evaluate: Yes closes it for that person; No for the other settles it as mixed', () => {
    const view = asks.evaluateAsk(mkAsk({ to: ['human:Mike', 'human:Eric'], answers: [ans('human:mike', 'yes', 1), ans('human:Eric', 'no', 2, undefined, 'Too early')] }), lines);
    assert.deepEqual(view.openFor, []);
    assert.equal(view.settled, true);
    assert.equal(view.outcome, 'mixed');
    assert.equal(view.people[1].answer?.words, 'Too early');
  });

  await test('evaluate: Not yet snoozes for that person; a re-ask or a changed line reopens it', async () => {
    const snoozed = mkAsk({ answers: [ans('human:Mike', 'not_yet', 1, undefined, 'after the demo')] });
    let view = asks.evaluateAsk(snoozed, lines);
    assert.deepEqual(view.openFor, []);
    assert.deepEqual(view.snoozedFor, ['human:Mike']);
    assert.equal(view.outcome, 'snoozed');
    assert.equal(asks.askIssueInputs([view]).length, 0, 'a snoozed ask is not an Issue');
    view = asks.evaluateAsk({ ...snoozed, askedAt: at(5) }, lines);
    assert.deepEqual(view.openFor, ['human:Mike'], 're-ask reopens');
    const edited = await serverLines.computeServerLines(doc.replace('tonight?', 'tomorrow?'));
    view = asks.evaluateAsk(snoozed, edited);
    assert.equal(view.lineIndex, Q1, 'the ask follows its line through an edit');
    assert.equal(view.current, false, JSON.stringify([edited.map(l => l.text), snoozed.anchor]));
    assert.deepEqual(view.openFor, ['human:Mike'], 'a changed question reopens it');
  });

  await test('evaluate: the latest answer counts; outside answers are shown but do not settle', () => {
    const view = asks.evaluateAsk(mkAsk({ answers: [ans('human:Mike', 'no', 1, undefined, 'no'), ans('human:Mike', 'yes', 2), ans('human:Dana', 'yes', 3)] }), lines);
    assert.equal(view.people[0].answer?.choice, 'yes');
    assert.equal(view.outcome, 'yes');
    assert.equal(view.answers.length, 2);
    const outsider = asks.evaluateAsk(mkAsk({ answers: [ans('human:Dana', 'yes', 3)] }), lines);
    assert.deepEqual(outsider.openFor, ['human:Mike']);
  });

  await test('evaluate: empty "to" = any human but the asker; AIs and the asker do not close it', () => {
    let view = asks.evaluateAsk(mkAsk({ to: [], by: 'human:Eric', answers: [ans('ai:claude', 'yes', 1), ans('human:Eric', 'yes', 2)] }), lines);
    assert.deepEqual(view.openFor, [asks.ANYONE]);
    view = asks.evaluateAsk(mkAsk({ to: [], by: 'human:Eric', answers: [ans('human:Mike', 'yes', 3)] }), lines);
    assert.equal(view.closed, true);
    assert.equal(asks.askStateFor(view, 'human:Dana')?.state, 'answered');
    assert.equal(asks.isAskedOf(view.ask, 'ai:claude'), false);
  });

  await test('evaluate: a deleted question line orphans the ask (listed, not an Issue)', async () => {
    const gone = await serverLines.computeServerLines('# Waiting on Mike\n\nOnly this.');
    const view = asks.evaluateAsk(mkAsk({ anchor: { ...shared.anchorForLine(lines[Q1]), ordinal: 9 } }), gone);
    assert.equal(view.lineIndex, null);
    assert.equal(asks.askIssueInputs([view]).length, 0);
  });

  await test('issues: an open ask is an Issue (before the line\'s own Issue) and counts in its section', () => {
    const views = asks.evaluateAsks([mkAsk(), mkAsk({ id: 'a2', anchor: shared.anchorForLine(lines[Q2]), answers: [{ ...ans('human:Mike', 'yes', 1), lineHash: lines[Q2].hash }] })], lines);
    const summary = shared.computeIssues({ lines, lineMarks: [], team: ['human:Mike'], asks: asks.askIssueInputs(views) });
    assert.equal(summary.counts.askIssues, 1);
    const atQ1 = summary.issues.filter(issue => issue.pos === lines[Q1].pos).map(issue => issue.type);
    assert.deepEqual(atQ1, ['ask', 'line']);
    const section = folding.sectionByHeading(folding.computeSections(lines), 1)!;
    const count = folding.sectionIssueCount(section, lines, summary);
    assert.equal(count.asks, 1);
    assert.equal(count.total, count.lines + count.asks);
  });

  await test('choices: people and AIs can spell them several ways', () => {
    assert.equal(asks.parseAskChoice('Not yet'), 'not_yet');
    assert.equal(asks.parseAskChoice('not-yet'), 'not_yet');
    assert.equal(asks.parseAskChoice('YES'), 'yes');
    assert.equal(asks.parseAskChoice('maybe'), null);
    assert.equal(asks.normalizeAskActor('Mike Wolf'), 'human:Mike Wolf');
  });

  // ---------------- HTTP routes ----------------
  const slug = 'ask-test';
  db.createDocument(slug, doc, {}, 'Asks test', 'owner-1', 'owner-secret-123');
  const editor = db.createDocumentAccessToken(slug, 'editor', undefined, { label: 'Claude (COS)', requestedBy: 'test', requestedFrom: '127.0.0.1' });
  const commenter = db.createDocumentAccessToken(slug, 'commenter', undefined, { label: 'Critic', requestedBy: 'test', requestedFrom: '127.0.0.1' });
  const H = { 'x-share-token': editor.secret };
  let askId = '';

  await test('agent: create an ask on a line by quote; recommend is required; one ask per line', async () => {
    const missing = await call(`/api/agent/${slug}/asks`, 'POST', { quote: 'Ship the ask control', to: ['Mike'] }, H);
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'RECOMMEND_REQUIRED');
    const created = await call(`/api/agent/${slug}/asks`, 'POST', {
      quote: 'Ship the ask control', to: ['Mike'], recommend: 'Yes: every check passes', ifYes: 'The COS deploys at 06:00',
    }, H);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    askId = created.body.ask.id;
    assert.equal(created.body.ask.by, 'ai:claude-cos', '"by" defaults to the key\'s AI');
    assert.deepEqual(created.body.ask.to, ['human:Mike']);
    assert.equal(created.body.ask.lineIndex, Q1);
    assert.deepEqual(created.body.ask.openFor, ['human:Mike']);
    const again = await call(`/api/agent/${slug}/asks`, 'POST', { lineIndex: Q1, to: ['Mike'], recommend: 'x' }, H);
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'ASK_EXISTS');
  });

  await test('page: the line-marks poll carries the asks; a No needs a reason; the answer is recorded in the person\'s words', async () => {
    const list = await call(`/api/documents/${slug}/line-marks`);
    assert.equal(list.body.asks.length, 1);
    assert.equal(list.body.asks[0].recommend, 'Yes: every check passes');
    const anchor = shared.anchorForLine(lines[Q1]);
    const noReason = await call(`/api/documents/${slug}/asks/${askId}/answer`, 'POST', { by: 'human:Mike', choice: 'no', anchor });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.code, 'REASON_REQUIRED');
    const notYet = await call(`/api/documents/${slug}/asks/${askId}/answer`, 'POST', { by: 'human:Mike', choice: 'not_yet', words: '  Wait for Eric\'s read.  ', anchor });
    assert.equal(notYet.status, 200, JSON.stringify(notYet.body));
    assert.equal(notYet.body.answer.words, 'Wait for Eric\'s read.', 'exact words, trimmed only');
    assert.equal(notYet.body.lineMarked, true, 'answering marks the line Seen for the answerer');
    const marks = await call(`/api/documents/${slug}/line-marks`);
    assert.ok(marks.body.lineMarks.some((m: any) => m.by === 'human:Mike' && m.status === 'seen' && m.anchor.hash === anchor.hash));
  });

  await test('/state: asks with answers; a snoozed ask is not an Issue; ask.answered events carry the words', async () => {
    let state = await call(`/api/agent/${slug}/state`, 'GET', undefined, H);
    assert.equal(state.status, 200);
    const ask = state.body.asks.find((a: any) => a.id === askId);
    assert.equal(ask.status, 'snoozed');
    assert.deepEqual(ask.snoozedFor, ['human:Mike']);
    assert.equal(ask.answers[0].words, 'Wait for Eric\'s read.');
    assert.equal(state.body.alignment.counts.askIssues, 0);
    assert.ok(state.body.alignment.team.includes('human:Mike'), 'the person asked joins the team');
    assert.equal(state.body._links.asks.href, `/api/agent/${slug}/asks`);
    const events = await call(`/api/agent/${slug}/events/pending?after=0`, 'GET', undefined, H);
    const answered = events.body.events.filter((e: any) => e.type === 'ask.answered');
    assert.equal(answered.length, 1);
    assert.equal(answered[0].data.choice, 'not_yet');
    assert.equal(answered[0].data.words, 'Wait for Eric\'s read.');
    assert.equal(answered[0].actor, 'human:Mike');
    // The asker re-asks: open again, an Issue again.
    const reask = await call(`/api/agent/${slug}/asks/${askId}/reask`, 'POST', {}, H);
    assert.equal(reask.status, 200, JSON.stringify(reask.body));
    state = await call(`/api/agent/${slug}/state`, 'GET', undefined, H);
    assert.equal(state.body.alignment.counts.askIssues, 1);
    const issue = state.body.issues.find((i: any) => i.type === 'ask');
    assert.deepEqual(issue.openFor, ['human:Mike']);
    assert.equal(issue.recommend, 'Yes: every check passes');
  });

  await test('re-ask and withdraw: only the asker (or the owner)', async () => {
    const other = await call(`/api/agent/${slug}/asks/${askId}/reask`, 'POST', {}, { 'x-share-token': commenter.secret });
    assert.equal(other.status, 403);
    assert.equal(other.body.code, 'ASKER_REQUIRED');
  });

  await test('agent: an AI answers with "Yes" (no words needed); the ask settles for the page', async () => {
    const aiAsk = await call(`/api/agent/${slug}/asks`, 'POST', { quote: 'Move the Waiting', to: ['ai:critic'], recommend: 'Yes' }, H);
    assert.equal(aiAsk.status, 200, JSON.stringify(aiAsk.body));
    const human = await call(`/api/agent/${slug}/asks/${aiAsk.body.ask.id}/answer`, 'POST', { choice: 'yes', by: 'human:Mike' }, { 'x-share-token': commenter.secret });
    assert.equal(human.status, 403, 'an agent key cannot answer as a human');
    const yes = await call(`/api/agent/${slug}/asks/${aiAsk.body.ask.id}/answer`, 'POST', { choice: 'Yes' }, { 'x-share-token': commenter.secret });
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
    assert.equal(yes.body.answer.by, 'ai:critic');
    assert.equal(yes.body.askedOf, true);
    const list = await call(`/api/agent/${slug}/asks`, 'GET', undefined, H);
    const row = list.body.asks.find((a: any) => a.id === aiAsk.body.ask.id);
    assert.equal(row.status, 'yes');
    assert.equal(row.settled, true);
    const gone = await call(`/api/agent/${slug}/asks/${aiAsk.body.ask.id}`, 'DELETE', { }, H);
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    const after = await call(`/api/agent/${slug}/asks`, 'GET', undefined, H);
    assert.equal(after.body.asks.some((a: any) => a.id === aiAsk.body.ask.id), false);
  });

  await test('agent: insertAfter + text adds a new line and makes it an ask in one call (edit access only)', async () => {
    const denied = await call(`/api/agent/${slug}/asks`, 'POST', { insertAfter: { quote: 'Folding is live' }, text: 'Can we retire PM /review?', recommend: 'Yes' }, { 'x-share-token': commenter.secret });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'EDIT_REQUIRED');
    const created = await call(`/api/agent/${slug}/asks`, 'POST', {
      insertAfter: { quote: 'Move the Waiting' }, text: 'Can we retire PM /review this week?', to: ['Mike'], recommend: 'Yes: Proof covers it',
    }, H);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.inserted.text, 'Can we retire PM /review this week?');
    assert.equal(created.body.ask.lineIndex, Q2 + 1);
    assert.equal(created.body.ask.question, 'Can we retire PM /review this week?');
    const state = await call(`/api/agent/${slug}/state`, 'GET', undefined, H);
    assert.match(state.body.markdown, /Move the Waiting on Mike page to the new asks\?\n\nCan we retire PM \/review this week\?/);
    const issue = state.body.issues.find((i: any) => i.type === 'ask' && i.askId === created.body.ask.id);
    assert.ok(issue, 'the new ask is an Issue');
  });

  console.log(`\nasks tests: ${passed} passed`);
} finally {
  server.close();
  rmSync(temp, { recursive: true, force: true });
}
