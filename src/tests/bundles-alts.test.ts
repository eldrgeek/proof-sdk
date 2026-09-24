// Proof Documents Steps B4e + B4f: review bundles, competing alternatives, blind marking, Explain
// with the term ledger, and perishable claims — pure rules and the HTTP routes.
// Authorship: Claude Opus 5 (worker proof-bundles), 2026-09-19, in the style of review-aids.test.ts.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-bundles-'));
process.env.DATABASE_PATH = path.join(temp, 'test.db');
const shared = await import('../shared/line-marks');
const aids = await import('../shared/review-aids');
const bundles = await import('../shared/bundles');
const alts = await import('../shared/alternatives');
const blind = await import('../shared/blind');
const explain = await import('../shared/explain');
const ttl = await import('../shared/ttl');
const walkMod = await import('../shared/reading-walk');
const serverLines = await import('../../server/line-marks');
const { blindViewFor } = await import('../../server/proof-extras-eval');
const db = await import('../../server/db');
const { apiRoutes } = await import('../../server/routes');
const { agentRoutes } = await import('../../server/agent-routes');

type DocLine = import('../shared/line-marks').DocLine;
type LineMark = import('../shared/line-marks').LineMark;

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const doc = `# Plan

Launch moves to September 30 for every customer.

The milestone review happens on September 23 in Boston.

Budget line stays the same for the quarter.

Every open Issue shows in the count at the top.

Pricing is 20 dollars per seat this year.

## Terms

**Issue** — a line or mark that someone has not seen, or that someone rejected.

Owner: the person who created the document.`;

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

const T0 = Date.parse('2026-09-19T10:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

try {
  const lines = await serverLines.computeServerLines(doc);
  const LAUNCH = 1; const REVIEW = 2; const BUDGET = 3; const USE = 4; const PRICE = 5; const DEF = 7;
  assert.match(lines[LAUNCH].text, /^Launch/);
  assert.match(lines[DEF].text, /^Issue —/);
  const mk = (by: string, line: DocLine, status: import('../shared/line-marks').LineMarkStatus, minutes = 0, via: import('../shared/line-marks').MarkVia = 'click'): LineMark =>
    ({ id: `${by}-${line.index}-${status}-${minutes}`, by, status, at: at(minutes), anchor: shared.anchorForLine(line), via, reason: status === 'rejected' ? 'no' : null });

  // ---------------- bundles (pure) ----------------
  await test('bundles: acceptable while every member is pending on its bundled text; one changed line refuses the whole bundle', () => {
    const b: import('../shared/bundles').ProofBundle = {
      id: 'launch', by: 'ai:claude', title: 'Move launch', why: 'Vendor slipped', createdAt: at(0), status: 'open', closedAt: null, closedBy: null,
      members: [
        { markId: 'a', lineHash: lines[LAUNCH].hash, quote: 'September 30', kind: 'replace' },
        { markId: 'b', lineHash: lines[REVIEW].hash, quote: 'September 23', kind: 'replace' },
      ],
    };
    const where = { a: LAUNCH, b: REVIEW } as Record<string, number>;
    let view = bundles.evaluateBundle(b, lines, id => ({ state: 'pending', lineIndex: where[id] }));
    assert.equal(view.acceptable, true);
    assert.deepEqual(view.pending, ['a', 'b']);
    view = bundles.evaluateBundle(b, lines, id => ({ state: 'pending', lineIndex: id === 'b' ? BUDGET : where[id] }));
    assert.deepEqual(view.stale, ['b']);
    assert.equal(view.acceptable, false);
    assert.match(bundles.describeBundle(view), /1 of 2 changed since bundled/);
    view = bundles.evaluateBundle(b, lines, id => ({ state: id === 'b' ? 'rejected' : 'pending', lineIndex: where[id] }));
    assert.equal(view.status, 'split');
    view = bundles.evaluateBundle(b, lines, () => ({ state: 'accepted', lineIndex: null }));
    assert.equal(view.status, 'accepted');
    assert.equal(bundles.bundleIndex([b]).get('b'), 'launch');
    assert.equal(bundles.isBundleId('ok_id-1'), true);
    assert.equal(bundles.isBundleId('no spaces'), false);
  });

  await test('walk: scrolling past a bundle only records reading, never a decision', () => {
    const w = new walkMod.ReadingWalk([
      { key: 'l0', marks: [{ id: 'a', kind: 'suggestion', group: 'launch' }] },
      { key: 'l1', marks: [{ id: 'b', kind: 'suggestion', group: 'launch' }] },
      { key: 'l2', marks: [] },
    ], 0);
    w.moveTo(2, 1000, 'scroll');
    w.moveTo(0, 2000, 'jump');
    assert.deepEqual(w.snapshot().provisional, []);
    assert.deepEqual(w.snapshot().passed, []);
    assert.ok(w.drain().every(event => ['seen', 'focus'].includes(event.type)));
    assert.equal(w.marksOn(0)[0].id, 'a');
    assert.equal(w.marksOn(1)[0].id, 'b');
  });

  // ---------------- alternatives (pure) ----------------
  const alt = (id: string, by: string, text: string, line: DocLine, minutes = 0): import('../shared/alternatives').ProofAlternative =>
    ({ id, by, text, anchor: shared.anchorForLine(line), createdAt: at(minutes), status: 'open', closedAt: null, closedBy: null, resolution: null });

  await test('alternatives: original first; open for members without a pick; unanimous only when every member picked the same', () => {
    const team = ['human:m@x.co', 'ai:claude'];
    const offers = [alt('x1', 'ai:claude', 'Budget line rises 5 percent.', lines[BUDGET])];
    const pick = (by: string, choice: string, hash = lines[BUDGET].hash) => ({ by, choice, lineHash: hash, at: at(1) });
    let [view] = alts.evaluateAlternatives(offers, [pick('ai:claude', 'x1')], lines, team);
    assert.deepEqual(view.options.map(o => o.id), ['original', 'x1']);
    assert.deepEqual(view.openFor, ['human:m@x.co']);
    assert.equal(view.unanimous, null);
    [view] = alts.evaluateAlternatives(offers, [pick('ai:claude', 'x1'), pick('human:m@x.co', 'original')], lines, team);
    assert.equal(view.disagree, true);
    assert.deepEqual(alts.alternativeIssueInputs([view], team)[0].openFor, team, 'all picked but differ: open for everyone');
    [view] = alts.evaluateAlternatives(offers, [pick('ai:claude', 'x1'), pick('human:m@x.co', 'x1')], lines, team);
    assert.equal(view.unanimous, 'x1');
    assert.equal(alts.alternativeIssueInputs([view], team)[0].openFor.length, 0);
    [view] = alts.evaluateAlternatives(offers, [pick('ai:claude', 'x1'), pick('human:m@x.co', 'x1', 'old-hash')], lines, team);
    assert.deepEqual(view.openFor, ['human:m@x.co'], 'a pick on older text does not count');
    const summary = shared.computeIssues({ lines, lineMarks: [], team, alternatives: alts.alternativeIssueInputs([view], team), disagreementAlternatives: true });
    assert.equal(summary.counts.alternativeIssues, 1);
    const ranked = aids.rankIssues(summary.issues, { viewer: 'human:m@x.co' });
    assert.equal(ranked.find(r => r.issue.type === 'alternative')!.rule, 'open-alternative');
  });

  // ---------------- blind marking (pure) ----------------
  await test('blind: others\' positions are hidden on lines the viewer has not marked; a skim is not a position; reveal shows disagreement', () => {
    const me = 'human:m@x.co';
    const marks = [mk('ai:claude', lines[USE], 'rejected', 1), mk('ai:claude', lines[LAUNCH], 'agreed', 1), mk(me, lines[LAUNCH], 'skimmed', 2)];
    let revealed = blind.revealedLines(lines, marks, me);
    assert.equal(revealed.size, 0, 'a skim reveals nothing');
    let red = blind.redactLineMarks(lines, marks, me, revealed);
    assert.equal(red.hidden, 2);
    const hidden = red.marks.find(m => m.anchor.hash === lines[USE].hash)!;
    assert.equal(hidden.hidden, true);
    assert.equal(hidden.status, 'seen');
    assert.equal(hidden.reason, null);
    const summary = shared.computeIssues({ lines, lineMarks: red.marks, team: [me, 'ai:claude'] });
    const useIssue = summary.issues.find(i => i.type === 'line' && i.lineIndex === USE) as Extract<import('../shared/line-marks').ProofIssue, { type: 'line' }>;
    assert.deepEqual(useIssue.rejectedBy, [], 'the hidden reject does not leak through the Issue');
    assert.deepEqual(useIssue.unseenBy, [me], 'the AI still counts as having marked it');
    const after = [...marks, mk(me, lines[USE], 'agreed', 3)];
    revealed = blind.revealedLines(lines, after, me);
    assert.equal(revealed.has(USE), true);
    red = blind.redactLineMarks(lines, after, me, revealed);
    assert.equal(red.marks.find(m => m.by === 'ai:claude' && m.anchor.hash === lines[USE].hash)!.status, 'rejected');
    const states = shared.buildLineStates(lines, red.marks);
    const dis = blind.disagreementLines(states);
    assert.deepEqual([...dis], [USE]);
    const issues = shared.computeIssues({ lines, lineMarks: red.marks, team: [me, 'ai:claude'], disagreementLines: dis });
    const ranked = aids.rankIssues(issues.issues, { viewer: me });
    assert.equal(ranked[0].rule, 'disagreement');
    assert.equal(blind.disagreementCounts(true), blind.BLIND_POLICY.disagreementPriority !== 'never');
  });

  // ---------------- Explain + terms (pure) ----------------
  await test('terms: definitions in a Terms section ("Term — …" and "Term: …"); first use linked until the reader has seen the definition', () => {
    const terms = explain.findTerms(lines);
    assert.deepEqual(terms.map(t => t.term), ['Issue', 'Owner']);
    const uses = explain.firstTermUses(lines, terms);
    assert.deepEqual(uses.map(u => [u.term, u.lineIndex]), [['Issue', USE]]);
    const me = 'human:m@x.co';
    assert.equal(explain.termLinksFor(lines, shared.buildLineStates(lines, []), me).length, 1);
    assert.equal(explain.termLinksFor(lines, shared.buildLineStates(lines, [mk(me, lines[DEF], 'skimmed')]), me).length, 1, 'a skim is not seeing it');
    assert.equal(explain.termLinksFor(lines, shared.buildLineStates(lines, [mk(me, lines[DEF], 'seen')]), me).length, 0);
    assert.equal(explain.explainCommentText('', ['claude']), `Explain: @claude ${explain.EXPLAIN_POLICY.defaultQuestion}`);
    assert.equal(explain.EXPLAIN_POLICY.commentIsIssue, false);
    const summary = shared.computeIssues({ lines, lineMarks: [], team: [me], reviewMarks: [{ id: 'c1', kind: 'comment', open: true, quote: 'x', explain: true }] });
    assert.equal(summary.counts.reviewMarkIssues, 0, 'an Explain thread is not an Issue');
  });

  // ---------------- times-to-live (pure) ----------------
  await test('ttl: parse; expiry decays earlier Agree marks to stale and opens it for the AIs first; "no" opens it for people; a new Agree settles it', () => {
    assert.deepEqual(ttl.parseTtl('7d'), { ms: 7 * 86_400_000, label: '7d' });
    assert.equal(ttl.parseTtl('7 days'), null);
    assert.equal(ttl.parseTtl('0s'), null);
    const me = 'human:m@x.co';
    const team = [me, 'ai:claude'];
    const t: import('../shared/ttl').ProofTtl = { id: 't1', by: me, ttlMs: 60 * 60_000, label: '1h', anchor: shared.anchorForLine(lines[PRICE]), setAt: at(0), periodStart: at(0), periodHash: lines[PRICE].hash, checks: [] };
    const marks = [mk(me, lines[PRICE], 'agreed', 5)];
    let states = shared.buildLineStates(lines, marks);
    let [v] = ttl.evaluateTtls([t], lines, states, team, T0 + 30 * 60_000);
    assert.equal(v.expired, false);
    assert.equal(v.openFor.length, 0);
    [v] = ttl.evaluateTtls([t], lines, states, team, T0 + 61 * 60_000);
    assert.equal(v.expired, true);
    assert.deepEqual(v.decayed, [marks[0].id]);
    assert.deepEqual(v.openFor, ['ai:claude']);
    assert.equal(v.reason, 'expired');
    ttl.applyDecay(states, [v]);
    assert.equal(states[PRICE].marks.get(me)!.decayed, true);
    const issues = shared.computeIssues({ lines, lineMarks: marks, team, ttl: ttl.ttlIssueInputs([v]) });
    assert.equal(issues.counts.ttlIssues, 1);
    assert.equal(aids.rankIssues(issues.issues, { viewer: 'ai:claude' }).find(r => r.issue.type === 'ttl')!.rule, 'ttl-check');
    assert.equal(aids.rankIssues(issues.issues, { viewer: me }).find(r => r.issue.type === 'ttl')!.rule, 'waiting-on-others');
    const no = { ...t, checks: [{ by: 'ai:claude', stillTrue: false, at: at(62), why: 'Prices rose' }] };
    [v] = ttl.evaluateTtls([no], lines, states, team, T0 + 63 * 60_000);
    assert.equal(v.reason, 'not-true');
    assert.deepEqual(v.openFor, [me]);
    states = shared.buildLineStates(lines, [mk(me, lines[PRICE], 'agreed', 64)]);
    [v] = ttl.evaluateTtls([no], lines, states, team, T0 + 65 * 60_000);
    assert.deepEqual(v.openFor, [], 'a deliberate Agree after the "no" settles it for that person');
    assert.deepEqual(v.decayed, [], 'the new Agree is not stale');
  });

  // ---------------- HTTP routes ----------------
  const slug = 'bundles-test';
  db.createDocument(slug, doc, {}, 'Bundles test', 'owner-1', 'owner-secret-123');
  const key = db.createDocumentAccessToken(slug, 'editor', undefined, { label: 'Claude', requestedBy: 'test', requestedFrom: '127.0.0.1' });
  const K = { 'x-share-token': key.secret };
  const OWNER = { 'x-share-token': 'owner-secret-123' };

  await test('agent: bundle two suggestions; the bundle accepts both in one mutation and records bundle.accepted', async () => {
    const a = await call(`/api/agent/${slug}/marks/suggest-replace`, 'POST', { quote: 'September 30', content: 'October 14', why: 'Vendor slipped', bundle: { id: 'launch', title: 'Move launch to October', why: 'Vendor slipped two weeks' } }, K);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const b = await call(`/api/agent/${slug}/marks/suggest-replace`, 'POST', { quote: 'September 23', content: 'October 7', why: 'Follows the launch', bundle: 'launch' }, K);
    assert.equal(b.status, 200, JSON.stringify(b.body));
    const list = await call(`/api/agent/${slug}/bundles`, 'GET', undefined, K);
    assert.equal(list.body.bundles[0].members.length, 2);
    const accepted = await call(`/api/agent/${slug}/bundles/launch/accept`, 'POST', {}, K);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const state = await call(`/api/agent/${slug}/state`, 'GET', undefined, K);
    assert.match(state.body.markdown, /October 14/);
    assert.match(state.body.markdown, /October 7/);
    const closed = await call(`/api/agent/${slug}/bundles?closed=1`, 'GET', undefined, K);
    assert.equal(closed.body.bundles.find((x: any) => x.id === 'launch').status, 'accepted');
    const again = await call(`/api/agent/${slug}/bundles/launch/accept`, 'POST', {}, K);
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'BUNDLE_CLOSED');
  });

  await test('agent: offer an alternative; picks by every member make it the line (a normal edit) and fold the rest', async () => {
    const offered = await call(`/api/agent/${slug}/alternatives`, 'POST', { quote: 'Budget line stays', text: 'Budget line rises 5 percent for the quarter.' }, K);
    assert.equal(offered.status, 200, JSON.stringify(offered.body));
    const same = await call(`/api/agent/${slug}/alternatives`, 'POST', { quote: 'Budget line stays', text: 'Budget line rises 5 percent for the quarter.' }, K);
    assert.equal(same.body.code, 'ALTERNATIVE_EXISTS');
    const list = await call(`/api/agent/${slug}/alternatives`, 'GET', undefined, K);
    const set = list.body.alternatives[0];
    assert.deepEqual(set.options.map((o: any) => o.key), ['1', '2']);
    assert.equal(set.unanimous, null, 'an AI alone never rewrites the line (ALT_POLICY.unanimityNeedsHuman)');
    // The owner credential decides for the owner (the team's other member).
    const decided = await call(`/api/agent/${slug}/alternatives/decide`, 'POST', { quote: 'Budget line stays', choice: '2', by: 'human:owner@x.co' }, OWNER);
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    const state = await call(`/api/agent/${slug}/state`, 'GET', undefined, K);
    assert.match(state.body.markdown, /Budget line rises 5 percent for the quarter\./);
    assert.equal(state.body.alternatives.length, 0);
    const hist = await call(`/api/agent/${slug}/alternatives?closed=1`, 'GET', undefined, K);
    assert.equal(hist.body.closed[0].status, 'chosen');
    const notOwner = await call(`/api/agent/${slug}/alternatives/decide`, 'POST', { quote: 'Pricing', choice: '1' }, K);
    assert.ok([401, 403].includes(notOwner.status), String(notOwner.status));
  });

  await test('agent: blind marking hides other members\' positions in /state until the AI marks that line', async () => {
    const refused = await call(`/api/agent/${slug}/settings`, 'POST', { blind: true }, K);
    assert.ok([401, 403].includes(refused.status), String(refused.status));
    const on = await call(`/api/agent/${slug}/settings`, 'POST', { blind: true, by: 'human:owner@x.co' }, OWNER);
    assert.equal(on.status, 200, JSON.stringify(on.body));
    const m = await call(`/api/agent/${slug}/marks/line`, 'POST', { quote: 'Every open Issue', status: 'rejected', reason: 'Lags', by: 'human:owner@x.co' }, OWNER);
    assert.equal(m.status, 200, JSON.stringify(m.body));
    let state = await call(`/api/agent/${slug}/state`, 'GET', undefined, K);
    const hidden = state.body.lineMarks.find((x: any) => x.by === 'human:owner@x.co');
    assert.equal(hidden.hidden, true);
    assert.equal(hidden.reason, null);
    assert.ok(!state.body.issues.some((i: any) => i.type === 'line' && i.rejectedBy.length > 0), 'no rejection leaks through issues');
    const own = await call(`/api/agent/${slug}/state`, 'GET', undefined, OWNER);
    assert.equal(own.body.lineMarks.find((x: any) => x.by === 'human:owner@x.co').status, 'rejected', 'the owner credential reads everything');
    await call(`/api/agent/${slug}/marks/line`, 'POST', { quote: 'Every open Issue', status: 'agreed' }, K);
    state = await call(`/api/agent/${slug}/state`, 'GET', undefined, K);
    assert.equal(state.body.lineMarks.find((x: any) => x.by === 'human:owner@x.co').status, 'rejected');
    assert.ok(state.body.disagreementLines.includes(USE), JSON.stringify(state.body.disagreementLines));
    const ev = await call(`/api/agent/${slug}/events/pending?after=0`, 'GET', undefined, K);
    const lm = ev.body.events.filter((e: any) => e.type === 'line_mark.updated').pop();
    assert.equal(lm.data.blind, true);
    assert.equal(lm.data.status, undefined);
    await call(`/api/agent/${slug}/settings`, 'POST', { blind: false, by: 'human:owner@x.co' }, OWNER);
  });

  await test('blind status: rejection and objection details stay hidden until each covered line is revealed', async () => {
    const slug = 'blind-participant-status';
    const markdown = 'The launch date is Friday.\n\nThe budget is fixed.\n\nThe review is complete.';
    db.createDocument(slug, markdown, {}, 'Blind status', 'blind-owner', 'blind-owner-secret');
    const owner = { 'x-share-token': 'blind-owner-secret' };
    const key = db.createDocumentAccessToken(slug, 'editor', undefined, { label: 'Blind viewer', requestedBy: 'test', requestedFrom: '127.0.0.1' });
    const viewer = { 'x-share-token': key.secret };
    const other = 'human:owner@x.co';
    const rejectionReason = 'PRIVATE_REJECTION_REASON';
    const objectionReason = 'PRIVATE_OBJECTION_REASON';
    const condition = 'PRIVATE_RESOLUTION_CONDITION';
    const on = await call(`/api/agent/${slug}/settings`, 'POST', { blind: true, by: other }, owner);
    assert.equal(on.status, 200);
    const rejection = await call(`/api/agent/${slug}/marks/line`, 'POST', { lineIndex: 0, status: 'rejected', reason: rejectionReason, by: other }, owner);
    assert.equal(rejection.status, 200, JSON.stringify(rejection.body));
    const objection = await call(`/api/agent/${slug}/objections`, 'POST', {
      lines: [{ lineIndex: 1 }, { lineIndex: 2 }], by: other, reason: objectionReason, condition,
    }, owner);
    assert.equal(objection.status, 200, JSON.stringify(objection.body));

    const read = async () => {
      const state = await call(`/api/agent/${slug}/state`, 'GET', undefined, viewer);
      assert.equal(state.status, 200);
      const report = await serverLines.buildIssueReport(slug, markdown, {});
      const view = blindViewFor({ lines: report.docLines!, lineMarks: report.lineMarks, viewer: 'ai:blind-viewer', picks: [] });
      const direct = serverLines.viewerParticipantStatus(report, view.lineMarks, view.revealed);
      assert.deepEqual(state.body.participantStatus, direct, '/state must publish the redacted computation');
      const person = direct.participants.find(person => person.actor === other)!;
      assert.ok(person);
      return { state, direct, person };
    };
    let result = await read();
    assert.deepEqual(result.person.passages.map(passage => passage.state), ['unseen', 'unseen', 'unseen']);
    assert.deepEqual(result.person.rejections, []);
    assert.equal(result.person.counts.rejected, 0);
    for (const secret of [rejectionReason, objectionReason, condition]) {
      assert.ok(!JSON.stringify(result.direct).includes(secret));
      assert.ok(!JSON.stringify(result.state.body).includes(secret), `blind /state leaked ${secret}`);
    }
    assert.ok(!result.state.body.issues.some((issue: { type: string }) => issue.type === 'objection'));
    const admin = await call(`/api/agent/${slug}/state`, 'GET', undefined, owner);
    assert.equal(admin.body.participantStatus.participants.find((person: { actor: string }) => person.actor === other).counts.rejected, 3, 'owner credential without a viewer keeps its administrative view');

    // Revealing one passage must not reveal a different passage or a multi-line condition.
    for (const lineIndex of [0, 1, 2]) {
      const marked = await call(`/api/agent/${slug}/marks/line`, 'POST', { lineIndex, status: 'seen' }, viewer);
      assert.equal(marked.status, 200, JSON.stringify(marked.body));
      result = await read();
      assert.equal(result.person.passages[0].state, 'rejected');
      assert.equal(result.person.passages[0].reason, rejectionReason);
      if (lineIndex < 2) {
        assert.ok(!JSON.stringify(result.state.body).includes(objectionReason));
        assert.ok(!JSON.stringify(result.state.body).includes(condition));
        assert.equal(result.person.counts.rejected, 1);
      }
    }
    assert.equal(result.person.counts.rejected, 3);
    assert.deepEqual(result.person.rejections.slice(1), [1, 2].map(lineIndex => ({ lineIndex, reason: objectionReason, condition })));
    assert.equal(result.state.body.objections[0].condition, condition);
    assert.equal(result.state.body.issues.find((issue: { type: string }) => issue.type === 'objection').reason, objectionReason);
  });

  await test('agent: a time-to-live: set, lazily expired in /state, "still true" checks are an AI\'s, a yes renews it', async () => {
    const bad = await call(`/api/agent/${slug}/ttl`, 'POST', { quote: 'Pricing is', ttl: 'soon' }, K);
    assert.equal(bad.body.code, 'INVALID_TTL');
    const set = await call(`/api/agent/${slug}/ttl`, 'POST', { quote: 'Pricing is', ttl: '1s' }, K);
    assert.equal(set.status, 200, JSON.stringify(set.body));
    await new Promise(resolve => setTimeout(resolve, 1200));
    const state = await call(`/api/agent/${slug}/state`, 'GET', undefined, K);
    const row = state.body.ttls[0];
    assert.equal(row.expired, true);
    assert.ok(state.body.evaluatedAt);
    assert.ok(state.body.issues.some((i: any) => i.type === 'ttl' && i.openFor.includes('ai:claude')));
    const human = await call(`/api/agent/${slug}/ttl/${row.id}/check`, 'POST', { stillTrue: true, by: 'human:owner@x.co' }, OWNER);
    assert.equal(human.status, 403);
    const yes = await call(`/api/agent/${slug}/ttl/${row.id}/check`, 'POST', { stillTrue: true, why: 'Price list unchanged' }, K);
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
    assert.equal(yes.body.renewed, true);
    const after = await call(`/api/agent/${slug}/ttl`, 'GET', undefined, K);
    assert.equal(after.body.ttls[0].expired, false);
    const ev = await call(`/api/agent/${slug}/events/pending?after=0`, 'GET', undefined, K);
    const types = ev.body.events.map((e: any) => e.type);
    for (const t of ['ttl.set', 'ttl.expired', 'ttl.checked']) assert.ok(types.includes(t), `missing ${t}`);
  });

  await test('page: an Explain thread is recorded (explain.requested) and the terms route lists the definitions', async () => {
    const lines2 = await serverLines.computeServerLines((await call(`/api/agent/${slug}/state`, 'GET', undefined, K)).body.markdown);
    const use = lines2.find(l => l.text.startsWith('Every open Issue'))!;
    const r = await call(`/api/documents/${slug}/explain`, 'POST', { by: 'human:owner@x.co', anchor: shared.anchorForLine(use), question: '', commentMarkId: 'c-1' }, OWNER);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const list = await call(`/api/agent/${slug}/explains`, 'GET', undefined, K);
    assert.equal(list.body.explains[0].question, explain.EXPLAIN_POLICY.defaultQuestion);
    const terms = await call(`/api/agent/${slug}/terms`, 'GET', undefined, K);
    assert.deepEqual(terms.body.terms.map((t: any) => t.term), ['Issue', 'Owner']);
    const ev = await call(`/api/agent/${slug}/events/pending?after=0`, 'GET', undefined, K);
    assert.ok(ev.body.events.some((e: any) => e.type === 'explain.requested' && e.data.commentMarkId === 'c-1'));
  });

  console.log(`\nbundles-alts tests: ${passed} passed`);
} finally {
  server.close();
  rmSync(temp, { recursive: true, force: true });
}
