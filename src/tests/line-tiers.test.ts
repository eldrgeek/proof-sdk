// Proof Documents — line tiers: decision lines and context lines. Pure rules (a covered context
// line is not an Issue for people; rejections and open items keep it one; a Familiar's
// rejected-suggested keeps it for its person; AI proposals; newest tag wins; cosmetic carry and
// meaning reset; untagged documents unchanged; J / K stops) and the HTTP routes (agent and page
// tagging, /state tiers and alignment counts, history, access, author exemption, events).
// Authorship: Claude Opus 5 (worker proof-tiers), 2026-09-19.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-tiers-'));
process.env.DATABASE_PATH = path.join(temp, 'test.db');
Object.assign(process.env, { PROOF_ENV: 'test', PROOF_DB_ENV_INIT: 'test', PROOF_LIBRARY_ENABLED: '1' });
delete process.env.PROOF_SOMA_AUTH_ENABLED;
delete process.env.PROOF_PUBLIC_ORIGIN;

const shared = await import('../shared/line-marks');
const tiers = await import('../shared/line-tiers');
const walkMod = await import('../shared/reading-walk');
const db = await import('../../server/db');
const auth = await import('../../server/library/auth');
const serverLines = await import('../../server/line-marks');
const { apiRoutes } = await import('../../server/routes');
const { agentRoutes } = await import('../../server/agent-routes');

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const doc = `# Launch plan

This plan explains how the team works together this year.

We launch in the second quarter.

The budget is fixed at ten thousand.

Background: the team is five people in two cities.

Last line of the plan.`;

const MIKE = 'human:mw@mike-wolf.com';
const ERIC = 'human:eric@example.test';
const CLAUDE = 'ai:claude';
const CRITIC = 'ai:critic';

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
  const L = (text: string) => lines.find(l => l.text.includes(text))!;
  const A = (text: string) => shared.anchorForLine(L(text));
  const at = (n: number) => `2026-09-19T10:00:${String(n).padStart(2, '0')}Z`;
  const tag = (id: string, text: string, tier: 'decision' | 'context', by: string, n: number, extra: Record<string, unknown> = {}) =>
    ({ id, tier, by, at: at(n), anchor: A(text), ...extra });
  const aiSeen = (by: string, text: string, evidence: string | null = 'Read the line and checked it against the plan') =>
    ({ id: `${by}-${text}`, by, status: 'seen' as const, at: at(1), anchor: A(text), via: 'api' as const, ...(evidence ? { evidence } : {}) });
  const team = [MIKE, ERIC, CLAUDE];
  const run = (input: { records?: any[]; marks?: any[]; flags?: any[]; reads?: any[]; extra?: Record<string, unknown> }) => {
    const marks = input.marks ?? [];
    const evaluation = tiers.evaluateTiers({ lines, records: input.records ?? [], reads: [...tiers.aiReadsFromMarks(marks), ...(input.reads ?? [])], flags: input.flags ?? [] });
    const summary = shared.computeIssues({ lines, lineMarks: marks, team, tiers: tiers.tierIssueInput(evaluation), ...(input.extra ?? {}) });
    const lineIssue = (text: string) => summary.issues.find(i => i.type === 'line' && i.lineIndex === L(text).index) as any;
    return { evaluation, summary, lineIssue };
  };

  // ------------------------------------------------------------------ pure
  await test('untagged documents: every line is a decision line and the Issues are exactly as before', () => {
    const marks = [aiSeen(CLAUDE, 'explains how')];
    const before = shared.computeIssues({ lines, lineMarks: marks, team });
    const { summary, evaluation } = run({ marks });
    assert.equal(evaluation.anyTagged, false);
    assert.deepEqual(summary.issues, before.issues);
    assert.equal(summary.counts.total, before.counts.total);
    assert.deepEqual(summary.counts.decision, { lines: lines.length, issues: before.counts.lineIssues });
    assert.deepEqual(summary.counts.context, { lines: 0, issues: 0, readForPeople: 0, proposed: 0 });
    assert.equal(tiers.TIER_POLICY.defaultTier, 'decision');
  });

  await test('a context line an AI read (with evidence) is not an Issue for people; an AI that has not read it still has it', () => {
    const records = [tag('t1', 'explains how', 'context', MIKE, 1)];
    const { summary, lineIssue, evaluation } = run({ records, marks: [aiSeen(CLAUDE, 'explains how')] });
    assert.equal(evaluation.views[L('explains how').index].tier, 'context');
    assert.deepEqual(evaluation.views[L('explains how').index].readBy, [CLAUDE]);
    assert.equal(lineIssue('explains how'), undefined, 'Claude read it and Mike and Eric are excused');
    assert.equal(summary.counts.context!.readForPeople, 1);
    assert.equal(summary.counts.context!.lines, 1);
    assert.equal(summary.counts.decision!.lines, lines.length - 1);
    // With a second AI on the team that has not read it, the line is that AI's Issue only.
    const both = shared.computeIssues({ lines, lineMarks: [aiSeen(CLAUDE, 'explains how')], team: [...team, CRITIC], tiers: tiers.tierIssueInput(evaluation) });
    const issue = both.issues.find(i => i.type === 'line' && i.lineIndex === L('explains how').index) as any;
    assert.deepEqual(issue.unseenBy, [CRITIC]);
    assert.deepEqual(issue.coveredFor, [MIKE, ERIC]);
    assert.equal(issue.tier, 'context');
    // Unread by any AI: a context line needs people like a decision line.
    const unread = run({ records }).lineIssue('explains how');
    assert.deepEqual(unread.unseenBy, team);
    assert.equal(unread.tier, 'context');
    assert.equal(tiers.describeContext(evaluation.views[L('explains how').index], a => a.replace('ai:', '').toUpperCase()), 'context — read for you by CLAUDE');
  });

  await test('an AI read without evidence ("claimed") does not cover a context line', () => {
    const { lineIssue } = run({ records: [tag('t1', 'explains how', 'context', MIKE, 1)], marks: [aiSeen(CLAUDE, 'explains how', null)] });
    assert.deepEqual(lineIssue('explains how').unseenBy, [MIKE, ERIC]);
    assert.equal(tiers.TIER_POLICY.aiReadRequiresEvidence, true);
  });

  await test('a rejection, an open ask, a pending suggestion, an open comment, a flag, an objection keep a context line an Issue for people', () => {
    const records = [tag('t1', 'explains how', 'context', MIKE, 1)];
    const marks = [aiSeen(CLAUDE, 'explains how')];
    const index = L('explains how').index;
    const rejected = run({ records, marks: [...marks, { id: 'r', by: ERIC, status: 'rejected', reason: 'Not true', at: at(3), anchor: A('explains how'), via: 'click' }] });
    assert.deepEqual(rejected.lineIssue('explains how').unseenBy, [MIKE], 'Mike must see a line someone rejected');
    const cases: Array<[string, Record<string, unknown>]> = [
      ['ask', { asks: [{ id: 'a', lineIndex: index, by: CLAUDE, recommend: 'Yes', openFor: [MIKE], snoozedFor: [] }] }],
      ['suggestion (placed by its quote)', { reviewMarks: [{ id: 's', kind: 'replace', by: CLAUDE, quote: 'works together', open: true }] }],
      ['comment (placed by its position)', { reviewMarks: [{ id: 'c', kind: 'comment', by: ERIC, quote: 'x', pos: L('explains how').pos + 3, open: true }] }],
      ['uncertain flag', { uncertain: [{ id: 'f', lineIndex: index, by: CLAUDE, note: null, openFor: [MIKE] }] }],
      ['objection', { objections: [{ id: 'o', lineIndices: [index], by: ERIC, reason: 'r', condition: null, deletedLines: 0, repairPending: false }] }],
    ];
    for (const [name, extra] of cases) {
      const issue = run({ records, marks, extra }).lineIssue('explains how');
      assert.ok(issue && issue.unseenBy.includes(MIKE), `${name} keeps the line an Issue for Mike`);
    }
    // A resolved comment does not.
    assert.equal(run({ records, marks, extra: { reviewMarks: [{ id: 'c', kind: 'comment', by: ERIC, quote: 'works together', open: false }] } }).lineIssue('explains how'), undefined);
    assert.equal(lineIssueOrNull(run({ records, marks }).lineIssue('explains how')), null);
  });

  await test('a Familiar\'s proxy read covers a context line; its rejected-suggested keeps the line for its person only', () => {
    const records = [tag('t1', 'Background', 'context', ERIC, 1)];
    const signals = tiers.tierSignalsFromProxies([
      { familiar: CLAUDE, for: MIKE, status: 'agreed', evidence: 'Team size matches the org chart', anchor: A('Background') },
      { familiar: CRITIC, for: ERIC, status: 'rejected-suggested', evidence: 'The team is six people, not five', anchor: A('Background') },
      { familiar: CLAUDE, for: MIKE, status: 'seen', evidence: '', anchor: A('Last line') },
    ]);
    assert.equal(signals.reads.length, 1, 'a proxy read without evidence does not count');
    const { lineIssue, evaluation } = run({ records, reads: signals.reads, flags: signals.flags });
    assert.deepEqual(evaluation.views[L('Background').index].flaggedFor, [ERIC]);
    const issue = lineIssue('Background');
    assert.deepEqual(issue.unseenBy.filter((m: string) => !m.startsWith('ai:')), [ERIC], 'Eric\'s Familiar recommends rejecting it; Mike is excused');
  });

  await test('AI proposals: shown as proposed and count as context; the AI author needs no confirmation; a person confirms; newest tag wins', () => {
    const marks = [aiSeen(CLAUDE, 'Background')];
    const proposed = run({ records: [tag('t1', 'Background', 'context', CLAUDE, 1)], marks });
    const view = proposed.evaluation.views[L('Background').index];
    assert.equal(view.proposed, true);
    assert.equal(view.actsAsContext, tiers.TIER_POLICY.aiProposalActsAsContext);
    assert.equal(proposed.lineIssue('Background'), undefined, 'the proposal counts as context meanwhile');
    assert.equal(proposed.summary.counts.context!.proposed, 1);
    const authored = run({ records: [tag('t1', 'Background', 'context', CLAUDE, 1, { byAuthor: true })], marks });
    assert.equal(authored.evaluation.views[L('Background').index].proposed, false);
    const confirmed = run({ records: [tag('t1', 'Background', 'context', CLAUDE, 1), tag('t2', 'Background', 'context', MIKE, 2)], marks });
    assert.equal(confirmed.evaluation.views[L('Background').index].proposed, false);
    assert.equal(confirmed.evaluation.views[L('Background').index].record!.by, MIKE);
    const flipped = run({ records: [tag('t1', 'Background', 'context', CLAUDE, 1), tag('t2', 'Background', 'decision', ERIC, 2)], marks });
    assert.equal(flipped.evaluation.views[L('Background').index].tier, 'decision');
    assert.ok(flipped.lineIssue('Background').unseenBy.includes(MIKE), 'a decision line needs Mike again');
    assert.equal(tiers.flippedTier('context'), 'decision');
    assert.equal(tiers.flippedTier('decision'), 'context');
  });

  await test('a tag follows its line over a cosmetic edit; a meaning change drops it (the default tier returns)', async () => {
    const records = [tag('t1', 'Background', 'context', MIKE, 1), tag('t2', 'second quarter', 'context', MIKE, 2)];
    const edited = await serverLines.computeServerLines(doc.replace('five people in two cities', 'five people in two cities!').replace('second quarter', 'fourth quarter'));
    const evaluation = tiers.evaluateTiers({ lines: edited, records });
    const bg = edited.find(l => l.text.includes('Background'))!;
    const launch = edited.find(l => l.text.includes('fourth quarter'))!;
    assert.equal(evaluation.views[bg.index].tier, 'context');
    assert.equal(evaluation.views[bg.index].carried, true);
    assert.equal(evaluation.views[launch.index].tier, 'decision');
    assert.equal(evaluation.views[launch.index].tagged, false);
  });

  await test('reading walk: J / K visit all visible passages, including covered context', () => {
    const walk = new walkMod.ReadingWalk([
      { key: 'a', marks: [] }, { key: 'b', marks: [], skipStep: true }, { key: 'c', marks: [], skipStep: true }, { key: 'd', marks: [] }, { key: 'e', marks: [], skipStep: true },
    ], 0);
    assert.equal(walk.nextStop(1), 1);
    walk.moveTo(3, 1000, 'jump');
    assert.equal(walk.nextStop(-1), 2);
    assert.equal(walk.nextStop(1), 4, 'visible context passages remain reachable');
    assert.equal(walk.nextVisible(1), 4);
  });

  // ------------------------------------------------------------------ HTTP
  const mike = auth.createLibraryMember({ name: 'Mike Wolf', email: 'mw@mike-wolf.com' });
  const sessionCookie = (memberId: string) => {
    const link = auth.createLibrarySigninLink({ memberId, purpose: 'operator', origin: base });
    const signedIn = auth.consumeLibrarySigninToken(new URL(link.link).hash.slice(3), null)!;
    return `${auth.LIBRARY_SESSION_COOKIE}=${encodeURIComponent(signedIn.sessionId)}`;
  };
  const slug = 'tiers-test';
  const authored = `${doc}\n\n<span data-proof="authored" data-by="ai:claude">Claude wrote this closing summary line.</span>`;
  db.createDocument(slug, authored, {}, 'Tiers test', 'owner-1', 'owner-secret-tiers');
  db.getDb().prepare(`INSERT INTO library_document_meta (slug, created_by_member_id) VALUES (?, ?)`).run(slug, mike.id);
  const commenter = db.createDocumentAccessToken(slug, 'commenter');
  const viewer = db.createDocumentAccessToken(slug, 'viewer');
  const claudeKey = db.createDocumentAccessToken(slug, 'editor', undefined, { label: 'Claude', requestedBy: 'test', requestedFrom: '127.0.0.1' });
  const MIKE_H = { Cookie: sessionCookie(mike.id), 'x-share-token': commenter.secret };
  const GUEST = { 'x-share-token': commenter.secret };
  const VIEWER = { 'x-share-token': viewer.secret };
  const CLAUDE_H = { 'x-share-token': claudeKey.secret };
  const OWNER = { 'x-share-token': 'owner-secret-tiers' };
  const state = async () => (await call(`/api/agent/${slug}/state`, 'GET', undefined, OWNER)).body;
  const mikeHas = (s: Record<string, any>, text: string) => (s.issues as any[]).some(i => i.type === 'line' && String(i.excerpt).includes(text) && i.unseenBy.includes(MIKE));

  await test('agent API: an AI tags lines context (a proposal), with a reason; /state shows tiers and decision / context counts; event tier.set', async () => {
    const read = await call(`/api/agent/${slug}/marks/line`, 'POST', { status: 'seen', lines: [{ quote: 'explains how' }, { quote: 'Background' }, { quote: 'closing summary' }], evidence: 'Read each line; no claims to check' }, CLAUDE_H);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    // Mike is on the team (the owner); before tagging, the setup lines are his Issues.
    let s = await state();
    assert.ok(mikeHas(s, 'explains how'));
    assert.equal(s.alignment.counts.context.lines, 0);
    const r = await call(`/api/agent/${slug}/tiers`, 'POST', { tier: 'context', reason: 'Setup, not a claim', lines: [{ quote: 'explains how' }, { quote: 'Background' }] }, CLAUDE_H);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.count, 2);
    assert.deepEqual(r.body.tiers.map((t: any) => t.proposed), [true, true]);
    assert.deepEqual(r.body.tiers.map((t: any) => t.previous), ['decision', 'decision']);
    s = await state();
    assert.equal(mikeHas(s, 'explains how'), false, 'Claude read it: not Mike\'s Issue');
    assert.equal(mikeHas(s, 'Background'), false);
    assert.equal(s.alignment.counts.context.lines, 2);
    assert.equal(s.alignment.counts.context.readForPeople, 2);
    assert.equal(s.alignment.counts.context.proposed, 2);
    assert.equal(s.alignment.counts.decision.lines, s.alignment.counts.lines - 2);
    const t = (s.tiers as any[]).find(x => String(x.text).includes('Background'));
    assert.deepEqual([t.tier, t.proposed, t.by, t.reason, t.readBy], ['context', true, CLAUDE, 'Setup, not a claim', [CLAUDE]]);
    assert.equal(s.tierPolicy.defaultTier, 'decision');
    assert.equal(s._links.setTiers.href, `/api/agent/${slug}/tiers`);
    const events = db.getDb().prepare(`SELECT * FROM document_events WHERE document_slug = ? AND event_type = 'tier.set'`).all(slug) as any[];
    assert.equal(events.length, 1);
    assert.equal(JSON.parse(events[0].event_data).proposed, 2);
    const bad = await call(`/api/agent/${slug}/tiers`, 'POST', { tier: 'maybe', quote: 'Background' }, CLAUDE_H);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'INVALID_TIER');
    const missing = await call(`/api/agent/${slug}/tiers`, 'POST', { tier: 'context', quote: 'no such words anywhere' }, CLAUDE_H);
    assert.equal(missing.status, 409);
  });

  await test('an AI\'s context tag on a line that AI wrote needs no confirmation', async () => {
    const r = await call(`/api/agent/${slug}/tiers`, 'POST', { tier: 'context', quote: 'closing summary' }, CLAUDE_H);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.tiers[0].byAuthor, true);
    assert.equal(r.body.tiers[0].proposed, false);
  });

  await test('page: Mike confirms a proposal and flips a line back to decision; every flip is in the history with who and when', async () => {
    const page = await call(`/api/documents/${slug}/line-marks`, 'GET', undefined, MIKE_H);
    assert.equal(page.status, 200);
    assert.equal(page.body.tiers.length, 3);
    assert.ok(page.body.tierSignals.reads.some((r: any) => r.by === CLAUDE), 'the page gets the AI reads');
    const confirm = await call(`/api/documents/${slug}/tiers`, 'POST', { tier: 'context', anchor: A('explains how') }, MIKE_H);
    assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
    assert.equal(confirm.body.actor, MIKE);
    assert.equal(confirm.body.tiers[0].proposed, false);
    const flip = await call(`/api/documents/${slug}/tiers`, 'POST', { tier: 'decision', anchors: [A('Background')] }, MIKE_H);
    assert.equal(flip.status, 200);
    const s = await state();
    assert.equal(mikeHas(s, 'Background'), true, 'a decision line is Mike\'s Issue again');
    assert.equal((s.tiers as any[]).find(x => String(x.text).includes('explains how')).proposed, false);
    const history = await call(`/api/agent/${slug}/tiers`, 'GET', undefined, OWNER);
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.history.map((h: any) => [h.tier, h.by]), [['context', CLAUDE], ['context', CLAUDE], ['context', CLAUDE], ['context', MIKE], ['decision', MIKE]]);
    assert.ok(history.body.history.every((h: any) => typeof h.at === 'string' && h.at.length > 10));
  });

  await test('access: anyone with comment access may tag (a guest too); a viewer may not; a changed line is refused', async () => {
    const guest = await call(`/api/documents/${slug}/tiers`, 'POST', { by: 'Ann', tier: 'context', anchor: A('Last line') }, GUEST);
    assert.equal(guest.status, 200, JSON.stringify(guest.body));
    assert.equal(guest.body.actor, 'guest:Ann');
    const view = await call(`/api/documents/${slug}/tiers`, 'POST', { by: 'Vic', tier: 'context', anchor: A('Last line') }, VIEWER);
    assert.equal(view.status, 403);
    const stale = await call(`/api/documents/${slug}/tiers`, 'POST', { tier: 'context', anchor: { ...A('Last line'), hash: 'zzz', ordinal: 99 } }, MIKE_H);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'LINE_CHANGED');
  });

  console.log(`\n${passed} line-tier tests passed`);
} finally {
  server.close();
}
process.exit(0);

function lineIssueOrNull(value: unknown) { return value ?? null; }
