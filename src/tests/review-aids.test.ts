// Proof Documents Steps B4c + B4d: review aids (why, uncertain flags, priority + sitting budget,
// reject chips) and objections with a resolution condition — pure rules and the HTTP routes.
// Authorship: Claude Opus 5 (worker proof-aids), 2026-09-19, in the style of asks.test.ts.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-aids-'));
process.env.DATABASE_PATH = path.join(temp, 'test.db');
const shared = await import('../shared/line-marks');
const aids = await import('../shared/review-aids');
const obj = await import('../shared/objections');
const walkMod = await import('../shared/reading-walk');
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

const doc = `# Plan

## Claims

Revenue doubled in the second quarter of this year.

Every customer asked for the export button first.

We will ship the export button in October.

## Notes

The team met on Tuesday to review the plan.`;

const app = express();
app.use(express.json());
app.use('/api', apiRoutes);
app.use('/api/agent', agentRoutes);
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const clientHeaders = { 'X-Proof-Client-Version': '0.33.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
const call = async (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...clientHeaders, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, body: await response.json() as Record<string, any> };
};

const T0 = '2026-09-19T10:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

try {
  const lines = await serverLines.computeServerLines(doc);
  const REV = 2; const CUST = 3; const SHIP = 4; const MET = 6;
  assert.match(lines[REV].text, /^Revenue/);
  assert.match(lines[MET].text, /^The team met/);
  const mk = (by: string, line: import('../shared/line-marks').DocLine, status: import('../shared/line-marks').LineMarkStatus, minutes = 0, via: import('../shared/line-marks').MarkVia = 'click'): import('../shared/line-marks').LineMark =>
    ({ id: `${by}-${line.index}-${status}`, by, status, at: at(minutes), anchor: shared.anchorForLine(line), via, reason: status === 'rejected' ? 'no' : null });

  // ---------------- 4. reject chips ----------------
  await test('chips: three defaults when no AI author gave hints; author hints first, AI only, de-duplicated', () => {
    assert.deepEqual(aids.rejectChipsFor([]).map(c => c.label), ['Wrong fact', 'Too strong', 'Not now']);
    const chips = aids.rejectChipsFor([
      { hint: 'Numbers are Q1, not Q2', by: 'ai:claude' },
      { hint: 'too strong', by: 'ai:claude' },
      { hint: 'From a person', by: 'human:a@b.co' },
    ]);
    assert.deepEqual(chips.map(c => [c.label, c.source]), [['Numbers are Q1, not Q2', 'author'], ['too strong', 'author'], ['Wrong fact', 'default']]);
    assert.equal(aids.cleanRejectHints(['  a  ', 'A', 'x'.repeat(80), 1 as unknown as string]).length, 3);
    assert.equal(aids.REJECT_CHIPS.max, 3);
  });

  // ---------------- 1. why ----------------
  await test('why: required for an agent key\'s AI, a warning for other AI-named requests, not asked of people', () => {
    assert.equal(aids.whyExpectation({ by: 'ai:claude', viaAgentKey: true }), aids.WHY_POLICY.enforce === 'warn' ? 'warn' : true);
    assert.equal(aids.whyExpectation({ by: 'ai:script', viaAgentKey: false }), aids.WHY_POLICY.enforce === 'all-ai' ? true : 'warn');
    assert.equal(aids.whyExpectation({ by: 'human:mw@mike-wolf.com', viaAgentKey: false }), false);
    assert.equal(aids.cleanWhy('  The   source\nsays Q1. '), 'The source says Q1.');
    assert.equal(aids.cleanWhy('   '), null);
  });

  // ---------------- 2. uncertain flags ----------------
  const flag = (by: string, line: import('../shared/line-marks').DocLine, minutes = 0): import('../shared/review-aids').UncertainFlag =>
    ({ id: `f-${by}-${line.index}`, by, note: 'Check the number', anchor: shared.anchorForLine(line), createdAt: at(minutes) });

  await test('flags: an Issue for every member but the flagger until they take a deliberate position after the flag', () => {
    const team = ['human:w@x.co', 'human:r@x.co', 'ai:claude'];
    const f = flag('human:w@x.co', lines[REV], 5);
    const views = aids.evaluateFlags([f], lines);
    assert.equal(views[0].lineIndex, REV);
    const states = (marks: import('../shared/line-marks').LineMark[]) => shared.buildLineStates(lines, marks);
    let inputs = aids.uncertainIssueInputs(views, states([]), team);
    assert.deepEqual(inputs[0].openFor, ['human:r@x.co', 'ai:claude']);
    // Seen does not settle it; an Agree before the flag does not either; scrolling never does.
    inputs = aids.uncertainIssueInputs(views, states([
      mk('human:r@x.co', lines[REV], 'seen', 6), mk('ai:claude', lines[REV], 'agreed', 1),
    ]), team);
    assert.deepEqual(inputs[0].openFor, ['human:r@x.co', 'ai:claude']);
    inputs = aids.uncertainIssueInputs(views, states([
      mk('human:r@x.co', lines[REV], 'rejected', 6), mk('ai:claude', lines[REV], 'agreed', 7, 'section'),
    ]), team);
    assert.deepEqual(inputs[0].openFor, ['ai:claude']);
    inputs = aids.uncertainIssueInputs(views, states([
      mk('human:r@x.co', lines[REV], 'rejected', 6), mk('ai:claude', lines[REV], 'agreed', 7, 'api'),
    ]), team);
    assert.equal(inputs.length, 0, 'everyone took a position: no longer an Issue (the flag stays visible)');
    const summary = shared.computeIssues({ lines, lineMarks: [], team, uncertain: aids.uncertainIssueInputs(views, states([]), team) });
    assert.equal(summary.counts.uncertainIssues, 1);
    const atRev = summary.issues.filter(i => i.pos === lines[REV].pos).map(i => i.type);
    assert.deepEqual(atRev, ['uncertain', 'line']);
    const section = folding.sectionByHeading(folding.computeSections(lines), 1)!;
    assert.equal(folding.sectionIssueCount(section, lines, summary).aids, 1);
  });

  await test('flags: the flag follows a cosmetic edit of its line; the reading walk doubles its dwell', async () => {
    const edited = await serverLines.computeServerLines(doc.replace('Revenue doubled in', 'Revenue  doubled, in'));
    const views = aids.evaluateFlags([flag('human:w@x.co', lines[REV])], edited);
    assert.equal(views[0].lineIndex, REV);
    const w = new walkMod.ReadingWalk([
      { key: 'a', words: 16, marks: [] },
      { key: 'b', words: 16, marks: [], dwellFactor: aids.UNCERTAIN_POLICY.dwellFactor },
    ], 0);
    w.setRate(8);
    assert.equal(w.dwellFor(0), 2000);
    assert.equal(w.dwellFor(1), 4000);
  });

  // ---------------- 3. priority ----------------
  await test('priority: rejections by others > asks > changed > uncertain > suggestions > unseen > waiting on others', () => {
    const me = 'human:me@x.co';
    const other = 'human:o@x.co';
    const team = [me, other];
    const edited = lines.map(l => l); // same lines; "changed" comes from a stale mark below
    const staleMine = { ...mk(me, lines[SHIP], 'agreed'), anchor: { ...shared.anchorForLine(lines[SHIP]), hash: 'old', text: 'We will ship the export button in September.' } };
    const marks = [
      mk(other, lines[REV], 'rejected'),
      mk(me, lines[CUST], 'seen'), mk(other, lines[CUST], 'seen'),
      staleMine,
      mk(me, lines[MET], 'seen'),
      ...[0, 1].flatMap(i => [mk(me, lines[i], 'seen'), mk(other, lines[i], 'seen')]), mk(other, lines[5], 'seen'),
    ];
    const summary = shared.computeIssues({
      lines: edited, lineMarks: marks, team,
      reviewMarks: [{ id: 's1', kind: 'replace', by: 'ai:claude', open: true, pos: lines[CUST].pos + 2 }],
      asks: [{ id: 'k1', lineIndex: CUST, by: 'ai:cos', recommend: 'Yes', openFor: [me], snoozedFor: [] }],
      uncertain: [{ id: 'f1', lineIndex: CUST, by: other, note: null, openFor: [me] }],
    });
    const ranked = aids.rankIssues(summary.issues, { viewer: me });
    const rules = ranked.map(r => r.rule);
    assert.deepEqual(rules, [
      'rejected-by-others', 'open-ask', 'changed-since-you-marked', 'uncertain', 'pending-suggestion', 'unseen', 'waiting-on-others',
    ], JSON.stringify(ranked.map(r => [r.rule, r.issue.type, 'lineIndex' in r.issue ? r.issue.lineIndex : null])));
    assert.equal(ranked[0].urgent, true);
    assert.equal(ranked[2].urgent, false);
    // An AI's explicit priority raises urgency (never lowers it).
    const raised = aids.rankIssues(summary.issues, {
      viewer: me,
      explicitFor: issue => (issue.type === 'suggestion' ? [{ priority: 1, reason: 'Legal must see it', by: 'ai:claude' }] : issue.type === 'line' && issue.rejectedBy.length ? [{ priority: 5, reason: 'meh', by: 'ai:x' }] : []),
    });
    assert.equal(raised[0].issue.type === 'line' || raised[0].issue.type === 'suggestion', true);
    const sug = raised.find(r => r.issue.type === 'suggestion')!;
    assert.equal(sug.priority, 1);
    assert.equal(sug.explicit?.reason, 'Legal must see it');
    assert.equal(raised.find(r => r.rule === 'rejected-by-others')!.priority, 1, 'an explicit 5 did not bury a rejection');
    // Next issue: priority order, cycling; a resolved issue continues from where it was.
    const first = aids.nextRankedIssue(ranked, null, null)!;
    assert.equal(first.rule, 'rejected-by-others');
    assert.equal(aids.nextRankedIssue(ranked, first.key, null)!.rule, 'open-ask');
    assert.equal(aids.nextRankedIssue(ranked, 'gone', { priority: 3, pos: 0 })!.rule, 'changed-since-you-marked');
    assert.equal(aids.nextRankedIssue(ranked, ranked[ranked.length - 1].key, null)!.key, ranked[0].key);
  });

  await test('sitting budget: "N more, none urgent" once the budget is used', () => {
    const issues: import('../shared/line-marks').ProofIssue[] = lines.map(line => ({
      type: 'line', lineIndex: line.index, pos: line.pos, kind: line.kind, excerpt: line.text, hash: line.hash,
      reasons: ['unseen'], unseenBy: ['human:me@x.co'], changedFor: [], rejectedBy: [], skimmedBy: [],
    }));
    const ranked = aids.rankIssues(issues, { viewer: 'human:me@x.co' });
    const visited = new Set(ranked.slice(0, 5).map(r => r.key));
    const s = aids.sittingSummary(ranked, visited, 5);
    assert.equal(s.reached, true);
    assert.equal(s.text, `${ranked.length - 5} more, none urgent`);
    assert.equal(aids.sittingSummary(ranked, visited, 0).reached, false, 'off by default');
    assert.equal(aids.SITTING_BUDGET.defaultBudget, 0);
    const withUrgent = aids.rankIssues([{ ...issues[0], rejectedBy: [{ by: 'human:o@x.co', reason: 'no' }] } as import('../shared/line-marks').ProofIssue, ...issues.slice(1)], { viewer: 'human:me@x.co' });
    assert.equal(aids.sittingSummary(withUrgent, new Set(), 5).text, `${withUrgent.length} more, 1 urgent`);
  });

  // ---------------- 5. objections ----------------
  const objection = (over: Partial<import('../shared/objections').ProofObjection> = {}): import('../shared/objections').ProofObjection => {
    const anchors = [shared.anchorForLine(lines[REV]), shared.anchorForLine(lines[CUST])];
    return {
      id: 'o1', by: 'human:r@x.co', reason: 'Unsupported', condition: 'the Q2 report is cited', createdAt: T0, status: 'open',
      closedAt: null, closedBy: null, overrideReason: null, keptAt: null,
      lines: anchors.map(a => ({ original: a, current: a, deletedAt: null })),
      ack: { hashes: anchors.map(a => a.hash), suggestions: [] },
      ...over,
    };
  };

  await test('objections: survive a move and a substantive edit (re-found by similarity); a repair is pending', async () => {
    const moved = await serverLines.computeServerLines(doc
      .replace('Revenue doubled in the second quarter of this year.\n\n', '')
      .replace('We will ship the export button in October.', 'We will ship the export button in October.\n\nRevenue doubled in the second quarter of this year, per the Q2 report.'));
    const view = obj.evaluateObjection(objection(), moved);
    const revNow = moved.findIndex(l => l.text.startsWith('Revenue'));
    assert.deepEqual(view.lineIndices, [revNow, moved.findIndex(l => l.text.startsWith('Every customer'))]);
    assert.deepEqual(view.changed, [true, false]);
    assert.equal(view.repairPending, true);
    assert.equal(view.deletedLines, 0);
    // Keep: the ack records what the objector saw; no longer pending.
    const kept = obj.evaluateObjection(objection({ ack: obj.ackFor(view) }), moved);
    assert.equal(kept.repairPending, false);
    // A new suggestion on a covered line is a repair too.
    const withSug = obj.evaluateObjection(objection({ ack: obj.ackFor(view) }), moved, i => (i === revNow ? ['s9'] : []));
    assert.equal(withSug.repairPending, true);
  });

  await test('objections: a line rewritten in place (few shared words) is re-found by its slot, not lost', async () => {
    const rewritten = await serverLines.computeServerLines(doc.replace('Every customer asked for the export button first.', 'Twelve of twelve interviewed buyers wanted exports.'));
    const withSlots = objection({ lines: objection().lines.map((covered, i) => ({ ...covered, ...obj.slotOf(lines, [REV, CUST][i]) })) });
    assert.ok(obj.similarity('Every customer asked for the export button first.', 'Twelve of twelve interviewed buyers wanted exports.') < 0.2);
    const view = obj.evaluateObjection(withSlots, rewritten);
    assert.deepEqual(view.lineIndices, [REV, CUST]);
    assert.deepEqual(view.changed, [false, true]);
    const noSlots = obj.evaluateObjection(objection(), rewritten);
    assert.equal(noSlots.lineIndices[1], null, 'without its slot a full rewrite reads as a deletion');
  });

  await test('objections: a deleted covered line keeps the objection open and says so; it is an Issue for everyone', async () => {
    const gone = await serverLines.computeServerLines(doc.replace('Every customer asked for the export button first.\n\n', ''));
    const view = obj.evaluateObjection(objection(), gone);
    assert.equal(view.deletedLines, 1);
    assert.equal(view.lineIndices[1], null);
    assert.equal(view.open, true);
    assert.match(obj.describeObjection(view), /1 of them deleted/);
    const summary = shared.computeIssues({ lines: gone, lineMarks: [], team: ['human:a@x.co'], objections: obj.objectionIssueInputs([view]) });
    assert.equal(summary.counts.objectionIssues, 1);
    const issue = summary.issues.find(i => i.type === 'objection')!;
    assert.equal(issue.type === 'objection' && issue.condition, 'the Q2 report is cited');
    assert.equal(aids.priorityRule(issue, 'human:a@x.co'), 'objection');
    assert.equal(aids.priorityRule(issue, 'human:r@x.co'), 'repair-proposed', 'the objector sees the deletion as a proposed repair');
    const closed = obj.evaluateObjection(objection({ status: 'cleared' }), gone);
    assert.equal(obj.objectionIssueInputs([closed]).length, 0);
    assert.ok(obj.similarity('Revenue doubled in Q2', 'Revenue doubled in Q2, per the report') > obj.OBJECTION_POLICY.refindMinSimilarity);
  });

  // ---------------- HTTP routes ----------------
  const slug = 'aids-test';
  db.createDocument(slug, doc, {}, 'Aids test', 'owner-1', 'owner-secret-123');
  const key = db.createDocumentAccessToken(slug, 'editor', undefined, { label: 'Claude', requestedBy: 'test', requestedFrom: '127.0.0.1' });
  const critic = db.createDocumentAccessToken(slug, 'commenter', undefined, { label: 'Critic', requestedBy: 'test', requestedFrom: '127.0.0.1' });
  const share = db.createDocumentAccessToken(slug, 'editor');
  const K = { 'x-share-token': key.secret };
  const C = { 'x-share-token': critic.secret };
  const S = { 'x-share-token': share.secret };
  const OWNER = { 'x-share-token': 'owner-secret-123' };
  let suggestionId = '';
  /** Edits one block through the agent API (so /state sees it), as an editor. */
  const editBlock = async (ref: string, markdown: string | null) => {
    const snap = await call(`/api/agent/${slug}/snapshot`, 'GET', undefined, K);
    const revision = snap.body.revision;
    const op = markdown === null ? { op: 'delete_block', ref } : { op: 'replace_block', ref, block: { markdown } };
    const r = await call(`/api/agent/${slug}/edit/v2`, 'POST', { by: 'ai:claude', baseRevision: revision, operations: [op] }, K);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };

  await test('agent: a key\'s AI suggestion without "why" is 400 WHY_REQUIRED; with it, the note is stored', async () => {
    const missing = await call(`/api/agent/${slug}/marks/suggest-replace`, 'POST', { quote: 'second quarter', content: 'first quarter' }, K);
    assert.equal(missing.status, 400, JSON.stringify(missing.body));
    assert.equal(missing.body.code, 'WHY_REQUIRED');
    const ok = await call(`/api/agent/${slug}/marks/suggest-replace`, 'POST', {
      quote: 'second quarter', content: 'first quarter', by: 'ai:claude',
      why: 'The finance sheet dates the doubling to Q1.', rejectHints: ['Q2 is right', 'Cite it first'], priority: 2, priorityReason: 'A wrong number goes to the board',
    }, K);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    suggestionId = ok.body.markId;
    assert.equal(ok.body.note.why, 'The finance sheet dates the doubling to Q1.');
    const bad = await call(`/api/agent/${slug}/marks/suggest-replace`, 'POST', { quote: 'October', content: 'November', why: 'x', priority: 9, priorityReason: 'x' }, K);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'INVALID_PRIORITY');
  });

  await test('agent: a share-token AI suggestion without "why" goes through with a warning header (WHY_POLICY)', async () => {
    const r = await call(`/api/agent/${slug}/ops`, 'POST', { type: 'suggestion.add', kind: 'replace', quote: 'October', content: 'November', by: 'ai:script' }, S);
    if (aids.WHY_POLICY.enforce === 'all-ai') {
      assert.equal(r.status, 400);
      return;
    }
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.headers.get(aids.WHY_POLICY.warningHeader), aids.WHY_POLICY.warningCode);
    assert.ok(r.body.warnings.some((w: any) => w.code === 'WHY_MISSING'));
    const human = await call(`/api/agent/${slug}/marks/suggest-insert`, 'POST', { quote: 'review the plan.', content: ' Twice.', by: 'human:mw@mike-wolf.com' }, OWNER);
    assert.equal(human.status, 200, JSON.stringify(human.body));
    assert.equal(human.headers.get(aids.WHY_POLICY.warningHeader), null, 'a person\'s suggestion needs no why');
  });

  await test('agent: POST /notes on a line (hints + priority) and on a suggestion; people cannot write notes', async () => {
    const note = await call(`/api/agent/${slug}/notes`, 'POST', { quote: 'Every customer asked', why: 'From 40 interviews', rejectHints: ['Only 12 asked'], priority: 3, priorityReason: 'Drives the roadmap' }, K);
    assert.equal(note.status, 200, JSON.stringify(note.body));
    assert.equal(note.body.note.target.lineIndex, CUST);
    const noReason = await call(`/api/agent/${slug}/notes`, 'POST', { markId: suggestionId, priority: 1 }, K);
    assert.equal(noReason.body.code, 'PRIORITY_REASON_REQUIRED');
    const human = await call(`/api/agent/${slug}/notes`, 'POST', { quote: 'Every customer', why: 'x', by: 'human:mw@mike-wolf.com' }, OWNER);
    assert.equal(human.status, 403);
    const list = await call(`/api/agent/${slug}/notes`, 'GET', undefined, K);
    assert.equal(list.body.notes.length, 2);
  });

  await test('agent: a line-mark "why" from an AI is kept; the page poll carries notes, flags and objections', async () => {
    const r = await call(`/api/agent/${slug}/marks/line`, 'POST', { quote: 'The team met', status: 'agreed', why: 'Matches the calendar' }, K);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.lineMark.why, 'Matches the calendar');
    const poll = await call(`/api/documents/${slug}/line-marks`);
    assert.ok(poll.body.lineMarks.some((m: any) => m.why === 'Matches the calendar'));
    assert.equal(poll.body.reviewNotes.length, 2);
    assert.deepEqual(poll.body.flags, []);
    assert.deepEqual(poll.body.objections, []);
  });

  let flagId = '';
  await test('flags: an AI flags a line uncertain; /state lists it as an Issue; only the flagger or the owner clears it', async () => {
    const f = await call(`/api/agent/${slug}/flags`, 'POST', { quote: 'We will ship', note: 'Depends on the vendor' }, K);
    assert.equal(f.status, 200, JSON.stringify(f.body));
    flagId = f.body.flag.id;
    const again = await call(`/api/agent/${slug}/flags`, 'POST', { quote: 'We will ship', note: 'Vendor says maybe' }, K);
    assert.equal(again.body.updated, true);
    const state = await call(`/api/agent/${slug}/state`, 'GET', undefined, K);
    assert.equal(state.body.flags.length, 1);
    assert.equal(state.body.flags[0].note, 'Vendor says maybe');
    const issue = state.body.issues.find((i: any) => i.type === 'uncertain');
    assert.ok(issue, 'the flag is an Issue');
    assert.equal(issue.priorityRule, 'uncertain');
    assert.ok(!issue.openFor.includes('ai:claude'), 'not an Issue for the flagger');
    const sugIssue = state.body.issues.find((i: any) => i.type === 'suggestion' && i.markId === suggestionId);
    assert.equal(sugIssue.priority, 2);
    assert.equal(sugIssue.explicitPriority.reason, 'A wrong number goes to the board');
    const other = await call(`/api/agent/${slug}/flags/${flagId}/clear`, 'POST', {}, C);
    assert.equal(other.status, 403);
    assert.equal(other.body.code, 'FLAGGER_REQUIRED');
    const events = await call(`/api/agent/${slug}/events/pending?after=0`, 'GET', undefined, K);
    assert.ok(events.body.events.some((e: any) => e.type === 'line_flag.set'));
  });

  await test('flags: the page flags as its viewer and the flagger clears it', async () => {
    const anchor = shared.anchorForLine(lines[MET]);
    const f = await call(`/api/documents/${slug}/flags`, 'POST', { by: 'Wren', anchor, note: 'Was it Wednesday?' });
    assert.equal(f.status, 200, JSON.stringify(f.body));
    assert.equal(f.body.flag.by, 'guest:Wren');
    const cleared = await call(`/api/documents/${slug}/flags/${f.body.flag.id}/clear`, 'POST', { by: 'Wren' });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    const byOwner = await call(`/api/agent/${slug}/flags/${flagId}/clear`, 'POST', { by: 'ai:owner-script' }, OWNER);
    assert.equal(byOwner.status, 200, JSON.stringify(byOwner.body));
  });

  let objectionId = '';
  await test('objections: a guest cannot object; an AI objects to two lines with a condition; it is an Issue for everyone', async () => {
    const guest = await call(`/api/documents/${slug}/objections`, 'POST', { by: 'Wren', lines: [shared.anchorForLine(lines[REV])], reason: 'No' });
    assert.equal(guest.status, 403);
    assert.equal(guest.body.code, 'VERIFIED_IDENTITY_REQUIRED');
    const noReason = await call(`/api/agent/${slug}/objections`, 'POST', { lines: [{ quote: 'Every customer' }] }, C);
    assert.equal(noReason.body.code, 'REASON_REQUIRED');
    const o = await call(`/api/agent/${slug}/objections`, 'POST', {
      lines: [{ quote: 'Every customer asked' }, { quote: 'We will ship' }], reason: 'Overclaims demand', condition: 'the interview count is stated',
    }, C);
    assert.equal(o.status, 200, JSON.stringify(o.body));
    objectionId = o.body.objection.id;
    assert.equal(o.body.objection.by, 'ai:critic');
    assert.deepEqual(o.body.objection.lines.map((l: any) => l.lineIndex), [CUST, SHIP]);
    assert.equal(o.body.objection.repairPending, false);
    const state = await call(`/api/agent/${slug}/state`, 'GET', undefined, K);
    const issue = state.body.issues.find((i: any) => i.type === 'objection');
    assert.equal(issue.objectionId, objectionId);
    assert.equal(issue.priority, 1);
    assert.equal(state.body.alignment.aligned, false);
    const events = await call(`/api/agent/${slug}/events/pending?after=0`, 'GET', undefined, K);
    const created = events.body.events.find((e: any) => e.type === 'objection.created');
    assert.equal(created.data.condition, 'the interview count is stated');
    assert.equal(created.data.lines.length, 2);
  });

  await test('objections: an edit to a covered line is a repair (event + Since you); Keep; only the objector clears; an owner overrides with a reason', async () => {
    await editBlock(`b${lines[CUST].block + 1}`, 'Every customer we interviewed (12 of 12) asked for the export button first.');
    const list = await call(`/api/agent/${slug}/objections`, 'GET', undefined, C);
    const row = list.body.objections.find((o: any) => o.id === objectionId);
    assert.equal(row.repairPending, true, JSON.stringify(row));
    assert.equal(row.lines[0].changed, true);
    assert.match(row.lines[0].text, /12 of 12/);
    const since = await call(`/api/agent/${slug}/since-you`, 'GET', undefined, C);
    assert.equal(since.body.counts.repairs, 1, JSON.stringify(since.body.counts));
    assert.equal(since.body.repairs[0].objectionId, objectionId);
    const events = await call(`/api/agent/${slug}/events/pending?after=0`, 'GET', undefined, K);
    assert.equal(events.body.events.filter((e: any) => e.type === 'objection.repair_proposed').length, 1);
    const kept = await call(`/api/agent/${slug}/objections/${objectionId}/keep`, 'POST', {}, C);
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    const after = await call(`/api/agent/${slug}/since-you`, 'GET', undefined, C);
    assert.equal(after.body.counts.repairs, 0);
    const byOther = await call(`/api/agent/${slug}/objections/${objectionId}/clear`, 'POST', {}, K);
    assert.equal(byOther.status, 403);
    assert.equal(byOther.body.code, 'OBJECTOR_REQUIRED');
    const noReason = await call(`/api/agent/${slug}/objections/${objectionId}/clear`, 'POST', { by: 'human:mw@mike-wolf.com' }, OWNER);
    assert.equal(noReason.body.code, 'OVERRIDE_REASON_REQUIRED');
    const second = await call(`/api/agent/${slug}/objections`, 'POST', { quote: 'Revenue doubled', reason: 'Q1', condition: 'the sheet is linked' }, C);
    const cleared = await call(`/api/agent/${slug}/objections/${second.body.objection.id}/clear`, 'POST', {}, C);
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.status, 'cleared');
    const over = await call(`/api/agent/${slug}/objections/${objectionId}/clear`, 'POST', { by: 'human:mw@mike-wolf.com', reason: 'Decided at the Friday meeting' }, OWNER);
    assert.equal(over.status, 200, JSON.stringify(over.body));
    assert.equal(over.body.status, 'overridden');
    const closed = await call(`/api/agent/${slug}/objections?closed=1`, 'GET', undefined, K);
    assert.equal(closed.body.objections.length, 0);
    assert.equal(closed.body.closed.find((o: any) => o.id === objectionId).overrideReason, 'Decided at the Friday meeting');
  });

  await test('objections: the owner credential can object as a verified person from the page; a deleted line stays open', async () => {
    const o = await call(`/api/documents/${slug}/objections`, 'POST', {
      by: 'human:mw@mike-wolf.com', lines: [shared.anchorForLine(lines[MET])], reason: 'Wrong day', condition: 'the date is checked', suggestions: [],
    }, OWNER);
    assert.equal(o.status, 200, JSON.stringify(o.body));
    assert.equal(o.body.actor, 'human:mw@mike-wolf.com');
    const state = await call(`/api/agent/${slug}/state`, 'GET', undefined, K);
    const met = state.body.lines.find((l: any) => l.text.startsWith('The team met'));
    await editBlock(met.ref, null);
    const list = await call(`/api/agent/${slug}/objections`, 'GET', undefined, K);
    const row = list.body.objections.find((x: any) => x.id === o.body.objection.id);
    assert.equal(row.open, true);
    assert.equal(row.deletedLines, 1);
    assert.match(row.summary, /deleted/);
  });

  console.log(`\nreview-aids tests: ${passed} passed`);
} finally {
  server.close();
  rmSync(temp, { recursive: true, force: true });
}
