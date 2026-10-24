// Proof Documents — Familiar proxy marks: binding, proxy writes (evidence required, only the bound
// Familiar, no Approve, reject only as a recommendation), the brief (ratify set, flagged, held
// lines), Ratify all and Undo, reset on a meaning change and carry on a cosmetic one, and
// "claimed" AI marks. Proxy marks never change the Issue count until ratified.
// Authorship: Claude Opus 5 (worker proof-proxy), 2026-09-19.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-proxy-'));
process.env.DATABASE_PATH = path.join(temp, 'test.db');
Object.assign(process.env, { PROOF_ENV: 'test', PROOF_DB_ENV_INIT: 'test', PROOF_LIBRARY_ENABLED: '1' });
delete process.env.PROOF_SOMA_AUTH_ENABLED;
delete process.env.PROOF_PUBLIC_ORIGIN;

const shared = await import('../shared/line-marks');
const proxy = await import('../shared/proxy-marks');
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

We launch in the second quarter.

The budget is fixed at ten thousand.

Marketing starts two weeks before launch.

Should we hire a contractor for support?

Support hours are nine to five.

Last line of the plan.`;

const app = express();
app.use(express.json());
app.use('/api', apiRoutes);
app.use('/api/agent', agentRoutes);
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const clientHeaders = { 'X-Proof-Client-Version': '0.34.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
const call = async (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...clientHeaders, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
};

try {
  // ------------------------------------------------------------------ pure
  await test('evidence: one line, at least 12 characters; confidence 0..1; AI marks without evidence are "claimed"', () => {
    assert.equal(proxy.cleanEvidence('too short'), null);
    assert.equal(proxy.cleanEvidence('  Checked\nthe budget sheet  '), 'Checked the budget sheet');
    assert.equal(proxy.cleanEvidence('x'.repeat(400))!.length, proxy.EVIDENCE_POLICY.maxChars);
    assert.equal(proxy.cleanConfidence(0.95), 0.95);
    assert.equal(proxy.cleanConfidence(1.2), null);
    assert.equal(proxy.cleanConfidence('x'), null);
    assert.equal(proxy.isClaimedMark({ by: 'ai:claude' }), true);
    assert.equal(proxy.isClaimedMark({ by: 'ai:claude', evidence: 'Compared with the sheet' }), false);
    assert.equal(proxy.isClaimedMark({ by: 'human:mw@mike-wolf.com' }), false);
  });

  await test('brief buckets: ratify (≥ threshold), check (below), reject (recommended), seen, held; a meaning change resets, a cosmetic one carries', async () => {
    const lines = await serverLines.computeServerLines(doc);
    const L = (text: string) => lines.find(l => l.text.includes(text))!;
    const mk = (id: string, text: string, status: any, confidence: number) => ({
      id, familiar: 'ai:claude', for: 'human:mw@mike-wolf.com', status, confidence, evidence: 'Paraphrase of the line checked', at: `2026-09-19T10:00:0${id.length}Z`, anchor: shared.anchorForLine(L(text)),
    });
    const proxies = [
      mk('a', 'second quarter', 'agreed', 0.95),
      mk('bb', 'ten thousand', 'agreed', 0.7),
      mk('ccc', 'Marketing', 'rejected-suggested', 0.8),
      mk('dddd', 'contractor', 'agreed', 0.99),
      mk('eeeee', 'nine to five', 'seen', 0.5),
    ];
    const states = shared.buildLineStates(lines, []);
    const held = new Map([[L('contractor').index, ['ask' as const]]]);
    const brief = proxy.evaluateProxies({ proxies, human: 'human:mw@mike-wolf.com', familiar: 'ai:claude', lines, states, held, humanIssueLines: lines.map(l => l.index) });
    assert.deepEqual(brief.ratify.map(i => i.proxy.id), ['a']);
    assert.deepEqual(brief.flagged.map(i => [i.proxy.id, i.bucket]), [['bb', 'check'], ['ccc', 'reject'], ['dddd', 'held']]);
    assert.deepEqual(brief.seen.map(i => i.proxy.id), ['eeeee']);
    assert.deepEqual(brief.counts, { read: 5, agreed: 1, flagged: 3, needYou: lines.length - 4 });
    assert.match(proxy.briefHeadline(brief, 'Claude'), /^Claude read 5 lines for you: agreed 1, flagged 3 for you, \d+ need you$/);
    // Another Familiar's proxies are not this person's brief.
    assert.equal(proxy.evaluateProxies({ proxies, human: 'human:mw@mike-wolf.com', familiar: 'ai:other', lines, states, held }).items.length, 0);
    // Edits: "second" -> "third" changes the meaning (reset); removing a final period is cosmetic (carries).
    const edited = await serverLines.computeServerLines(doc.replace('second quarter', 'third quarter').replace('fixed at ten thousand.', 'fixed at ten thousand'));
    const after = proxy.evaluateProxies({ proxies, human: 'human:mw@mike-wolf.com', familiar: 'ai:claude', lines: edited, states: shared.buildLineStates(edited, []), held: new Map() });
    assert.deepEqual(after.reset.map(p => p.id), ['a'], 'the meaning change reset the proxy');
    assert.equal(after.items.find(i => i.proxy.id === 'bb')?.carried, true, 'the cosmetic change carried it');
    // A line the person already marked is moot.
    const marked = shared.buildLineStates(lines, [{ id: 'm1', by: 'human:mw@mike-wolf.com', status: 'seen', at: 'x', anchor: shared.anchorForLine(L('second quarter')), via: 'click' }]);
    const moot = proxy.evaluateProxies({ proxies, human: 'human:mw@mike-wolf.com', familiar: 'ai:claude', lines, states: marked, held });
    assert.equal(moot.moot, 1);
    assert.equal(moot.ratify.length, 0);
  });

  await test('Q4: a passive read of a flagged line gives at most Seen and keeps it in the brief; an explicit mark settles it', async () => {
    assert.equal(proxy.PROXY_POLICY.passiveReadCapsAtSeenWhenFlagged, true);
    assert.equal(proxy.capPassiveRead('agreed', { bucket: 'reject' }), 'seen');
    assert.equal(proxy.capPassiveRead('agreed', { bucket: 'check' }), 'seen');
    assert.equal(proxy.capPassiveRead('agreed', { bucket: 'held' }), 'seen');
    assert.equal(proxy.capPassiveRead('agreed', { bucket: 'ratify' }), 'agreed');
    assert.equal(proxy.capPassiveRead('agreed', null), 'agreed');
    assert.equal(proxy.capPassiveRead('seen', { bucket: 'reject' }), 'seen');
    const lines = await serverLines.computeServerLines(doc);
    const L = (text: string) => lines.find(l => l.text.includes(text))!;
    const mk = (id: string, text: string, status: any, confidence: number) => ({
      id, familiar: 'ai:claude', for: 'human:mw@mike-wolf.com', status, confidence, evidence: 'Paraphrase of the line checked', at: '2026-09-19T10:00:00Z', anchor: shared.anchorForLine(L(text)),
    });
    const proxies = [mk('rej', 'nine to five', 'rejected-suggested', 0.8), mk('ok', 'second quarter', 'agreed', 0.95)];
    const mark = (text: string, status: any, via: any) => ({ id: `m-${text}-${via}`, by: 'human:mw@mike-wolf.com', status, at: 'x', anchor: shared.anchorForLine(L(text)), via });
    const brief = (marks: any[]) => proxy.evaluateProxies({ proxies, human: 'human:mw@mike-wolf.com', familiar: 'ai:claude', lines, states: shared.buildLineStates(lines, marks), held: new Map() });
    const dwelled = brief([mark('nine to five', 'seen', 'dwell'), mark('second quarter', 'seen', 'dwell')]);
    assert.deepEqual(dwelled.flagged.map(i => i.proxy.id), ['rej'], 'the flagged line stays after a dwell');
    assert.equal(dwelled.moot, 1, 'an unflagged line is settled by the dwell as before');
    const clicked = brief([mark('nine to five', 'seen', 'click')]);
    assert.equal(clicked.flagged.length, 0, 'an explicit mark settles it');
  });

  await test('held lines: objection, open ask, uncertain for the person, {do}, rejected by someone else, pending suggestion', () => {
    const issues: any[] = [
      { type: 'objection', lineIndices: [1, 2] },
      { type: 'ask', lineIndex: 3, openFor: ['human:x@y.z'], snoozedFor: [] },
      { type: 'uncertain', lineIndex: 4, openFor: ['human:mw@mike-wolf.com'] },
      { type: 'uncertain', lineIndex: 5, openFor: ['human:other@y.z'] },
      { type: 'do', lineIndex: 6 },
      { type: 'line', lineIndex: 7, rejectedBy: [{ by: 'ai:critic', reason: 'no' }] },
    ];
    const held = proxy.heldLines({ issues, human: 'human:mw@mike-wolf.com', suggestionLines: [8] });
    assert.deepEqual([...held.keys()].sort(), [1, 2, 3, 4, 6, 7, 8]);
    assert.deepEqual(held.get(1), ['objection']);
    assert.deepEqual(held.get(8), ['suggestion']);
  });

  // ------------------------------------------------------------------ HTTP
  const mike = auth.createLibraryMember({ name: 'Mike Wolf', email: 'mw@mike-wolf.com' });
  const eric = auth.createLibraryMember({ name: 'Eric', email: 'eric@example.test' });
  const sessionCookie = (memberId: string) => {
    const link = auth.createLibrarySigninLink({ memberId, purpose: 'operator', origin: base });
    const signedIn = auth.consumeLibrarySigninToken(new URL(link.link).hash.slice(3), null)!;
    return `${auth.LIBRARY_SESSION_COOKIE}=${encodeURIComponent(signedIn.sessionId)}`;
  };
  const slug = 'proxy-test';
  db.createDocument(slug, doc, {}, 'Proxy test', 'owner-1', 'owner-secret-proxy');
  db.getDb().prepare(`INSERT INTO library_document_meta (slug, created_by_member_id) VALUES (?, ?)`).run(slug, mike.id);
  const share = db.createDocumentAccessToken(slug, 'commenter');
  const claudeKey = db.createDocumentAccessToken(slug, 'editor', undefined, { label: 'Claude', requestedBy: 'test', requestedFrom: '127.0.0.1' });
  const criticKey = db.createDocumentAccessToken(slug, 'editor', undefined, { label: 'Critic', requestedBy: 'test', requestedFrom: '127.0.0.1' });
  const MIKE = { Cookie: sessionCookie(mike.id), 'x-share-token': share.secret };
  const ERIC = { Cookie: sessionCookie(eric.id), 'x-share-token': share.secret };
  const GUEST = { 'x-share-token': share.secret };
  const CLAUDE = { 'x-share-token': claudeKey.secret };
  const CRITIC = { 'x-share-token': criticKey.secret };
  const OWNER = { 'x-share-token': 'owner-secret-proxy' };
  const lines = await serverLines.computeServerLines(doc);
  const L = (text: string) => lines.find(l => l.text.includes(text))!;
  const MIKE_ACTOR = 'human:mw@mike-wolf.com';
  const state = async () => (await call(`/api/agent/${slug}/state`, 'GET', undefined, OWNER)).body;
  const mikeLineIssues = (s: Record<string, any>) => (s.issues as any[]).filter(i => i.type === 'line' && i.unseenBy.includes(MIKE_ACTOR)).length;

  await test('binding: a guest and an agent key cannot choose; the Familiar must be present; Mike chooses Claude in the page', async () => {
    const guest = await call(`/api/documents/${slug}/familiar`, 'POST', { by: 'Ann', familiar: 'ai:claude' }, GUEST);
    assert.equal(guest.status, 403);
    assert.equal(guest.body.code, 'SIGNED_IN_PERSON_REQUIRED');
    const key = await call(`/api/documents/${slug}/familiar`, 'POST', { familiar: 'ai:claude' }, CLAUDE);
    assert.equal(key.status, 403, 'an agent key on the page acts as its AI, never as a person');
    const keyAgent = await call(`/api/agent/${slug}/familiars`, 'POST', { for: MIKE_ACTOR, familiar: 'ai:claude' }, CLAUDE);
    assert.equal(keyAgent.status, 403);
    assert.equal(keyAgent.body.code, 'OWNER_CREDENTIAL_REQUIRED');
    const absent = await call(`/api/documents/${slug}/familiar`, 'POST', { familiar: 'ai:nobody' }, MIKE);
    assert.equal(absent.status, 400);
    assert.equal(absent.body.code, 'FAMILIAR_NOT_PRESENT');
    const ok = await call(`/api/documents/${slug}/familiar`, 'POST', { familiar: 'ai:claude', by: 'human:eric@example.test' }, MIKE);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.familiar.human, MIKE_ACTOR, 'a session binds only its own person, whatever "by" says');
    assert.equal(ok.body.familiar.familiar, 'ai:claude');
    const page = await call(`/api/documents/${slug}/line-marks`, 'GET', undefined, MIKE);
    assert.equal(page.body.familiar.familiar, 'ai:claude');
    assert.deepEqual(page.body.proxies, []);
    const ericPage = await call(`/api/documents/${slug}/line-marks`, 'GET', undefined, ERIC);
    assert.equal(ericPage.body.familiar, null);
    // Scripts: the owner credential binds Eric's Familiar.
    const scripted = await call(`/api/agent/${slug}/familiars`, 'POST', { for: 'eric@example.test', familiar: 'ai:critic' }, OWNER);
    assert.equal(scripted.status, 200, JSON.stringify(scripted.body));
    assert.equal((await call(`/api/agent/${slug}/familiars`, 'GET', undefined, CLAUDE)).body.familiars.length, 2);
  });

  const before = await state();
  const issuesBefore = before.alignment.counts.total;
  const mikeBefore = mikeLineIssues(before);

  let proxyIds: Record<string, string> = {};
  await test('proxy writes: evidence required (nothing written), no Approve, reject only as a recommendation, only the bound Familiar', async () => {
    const noEvidence = await call(`/api/agent/${slug}/marks/proxy`, 'POST', {
      for: MIKE_ACTOR,
      lines: [
        { target: { quote: 'second quarter' }, status: 'agreed', confidence: 0.95, evidence: 'Launch quarter matches the roadmap' },
        { target: { quote: 'ten thousand' }, status: 'agreed', confidence: 0.95, evidence: 'short' },
      ],
    }, CLAUDE);
    assert.equal(noEvidence.status, 400);
    assert.equal(noEvidence.body.code, 'EVIDENCE_REQUIRED');
    assert.equal(noEvidence.body.index, 1);
    assert.equal((await state()).proxies[MIKE_ACTOR].items.length, 0, 'one bad entry writes nothing');
    const approve = await call(`/api/agent/${slug}/marks/proxy`, 'POST', { for: MIKE_ACTOR, lines: [{ quote: 'second quarter', status: 'approved', confidence: 1, evidence: 'Launch quarter matches the roadmap' }] }, CLAUDE);
    assert.equal(approve.status, 403);
    assert.equal(approve.body.code, 'PROXY_CANNOT_APPROVE');
    const reject = await call(`/api/agent/${slug}/marks/proxy`, 'POST', { for: MIKE_ACTOR, lines: [{ quote: 'second quarter', status: 'rejected', confidence: 1, evidence: 'Launch quarter matches the roadmap' }] }, CLAUDE);
    assert.equal(reject.status, 400);
    assert.equal(reject.body.code, 'PROXY_REJECT_IS_SUGGESTED');
    const other = await call(`/api/agent/${slug}/marks/proxy`, 'POST', { for: MIKE_ACTOR, lines: [{ quote: 'second quarter', status: 'agreed', confidence: 1, evidence: 'Launch quarter matches the roadmap' }] }, CRITIC);
    assert.equal(other.status, 403);
    assert.equal(other.body.code, 'NOT_THIS_PERSONS_FAMILIAR');
    const owner = await call(`/api/agent/${slug}/marks/proxy`, 'POST', { by: 'ai:claude', for: MIKE_ACTOR, lines: [{ quote: 'second quarter', status: 'agreed', confidence: 1, evidence: 'Launch quarter matches the roadmap' }] }, OWNER);
    assert.equal(owner.status, 403, 'the owner credential cannot write as the Familiar');
    assert.equal(owner.body.code, 'AGENT_KEY_REQUIRED');
    const unbound = await call(`/api/agent/${slug}/marks/proxy`, 'POST', { for: 'human:nobody@example.test', lines: [{ quote: 'second quarter', status: 'agreed', confidence: 1, evidence: 'Launch quarter matches the roadmap' }] }, CLAUDE);
    assert.equal(unbound.status, 403);
    assert.equal(unbound.body.code, 'NOT_BOUND');

    const ok = await call(`/api/agent/${slug}/marks/proxy`, 'POST', {
      for: MIKE_ACTOR,
      lines: [
        { target: { quote: 'second quarter' }, status: 'agreed', confidence: 0.95, evidence: 'Launch quarter matches the roadmap' },
        { target: { quote: 'ten thousand' }, status: 'agreed', confidence: 0.92, evidence: 'Budget equals the finance sheet total' },
        { target: { quote: 'Marketing starts' }, status: 'agreed', confidence: 0.6, evidence: 'Marketing timing is plausible but unconfirmed' },
        { target: { quote: 'contractor' }, status: 'agreed', confidence: 0.99, evidence: 'Hiring support was agreed last week' },
        { target: { quote: 'nine to five' }, status: 'rejected-suggested', confidence: 0.8, evidence: 'The support page says eight to six' },
        { target: { quote: 'Last line' }, status: 'agreed', confidence: 0.97, evidence: 'Closing line, no claims in it' },
      ],
    }, CLAUDE);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.count, 6);
    for (const p of ok.body.proxies) proxyIds[p.anchor.excerpt.split(' ')[0]] = p.id;
    const events = db.getDb().prepare(`SELECT event_type FROM document_events WHERE document_slug = ? AND event_type = 'proxy.marked'`).all(slug);
    assert.equal(events.length, 1);
  });

  await test('an ask and an objection hold their lines; proxies do not change the Issue count; /state lists them apart', async () => {
    const ask = await call(`/api/agent/${slug}/asks`, 'POST', { quote: 'contractor', to: ['human:mw@mike-wolf.com'], recommend: 'Yes: the queue is growing' }, CLAUDE);
    assert.equal(ask.status, 200, JSON.stringify(ask.body));
    const objection = await call(`/api/agent/${slug}/objections`, 'POST', { quote: 'Last line', reason: 'Too vague' }, CRITIC);
    assert.equal(objection.status, 200, JSON.stringify(objection.body));
    const s = await state();
    // The ask and the objection add their own Issues; the proxies add and remove none.
    assert.equal(mikeLineIssues(s), mikeBefore, 'proxies do not change Mike’s line Issues');
    assert.equal(s.alignment.counts.total, issuesBefore + 2, 'only the new ask and objection were added');
    assert.equal(s.alignment.unratifiedProxies, 6);
    assert.ok(!(s.lineMarks as any[]).some(m => m.by === MIKE_ACTOR), 'no proxy became Mike’s mark');
    const brief = s.proxies[MIKE_ACTOR];
    assert.equal(brief.familiar, 'ai:claude');
    const bucket = (word: string) => brief.items.find((i: any) => i.proxyId === proxyIds[word]).bucket;
    assert.equal(bucket('We'), 'ratify');
    assert.equal(bucket('The'), 'ratify');
    assert.equal(bucket('Marketing'), 'check');
    assert.equal(bucket('Should'), 'held');
    assert.equal(bucket('Support'), 'reject');
    assert.equal(bucket('Last'), 'held');
    assert.deepEqual(brief.counts, { read: 6, agreed: 2, flagged: 4, needYou: mikeBefore - 6 });
    const get = await call(`/api/agent/${slug}/marks/proxy?for=mw@mike-wolf.com`, 'GET', undefined, CLAUDE);
    assert.equal(get.body.brief.counts.agreed, 2);
  });

  let ratificationId = '';
  await test('Ratify all: only the ratify set becomes Mike\'s Agreed via proxy (with Familiar, evidence, confidence); Issues drop by that many', async () => {
    const guest = await call(`/api/documents/${slug}/proxy/ratify`, 'POST', { by: 'Ann', proxyIds: Object.values(proxyIds) }, GUEST);
    assert.equal(guest.status, 403);
    const s0 = await state();
    const r = await call(`/api/documents/${slug}/proxy/ratify`, 'POST', { proxyIds: Object.values(proxyIds) }, MIKE);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ratification.count, 2);
    assert.equal(r.body.skipped.length, 4, 'held, check and reject items are skipped');
    ratificationId = r.body.ratification.id;
    const s = await state();
    assert.equal(mikeLineIssues(s), mikeLineIssues(s0) - 2, 'two fewer lines wait on Mike');
    assert.ok(s.alignment.counts.total <= s0.alignment.counts.total);
    const mine = (s.lineMarks as any[]).filter(m => m.by === MIKE_ACTOR);
    assert.equal(mine.length, 2);
    for (const m of mine) {
      assert.equal(m.status, 'agreed');
      assert.equal(m.via, 'proxy');
      assert.equal(m.proxy.familiar, 'ai:claude');
      assert.ok(m.proxy.confidence >= 0.9);
      assert.ok(m.evidence && m.evidence === m.proxy.evidence);
      assert.equal(m.proxy.ratificationId, ratificationId);
    }
    assert.equal(s.proxies[MIKE_ACTOR].counts.agreed, 0, 'ratified lines leave the brief');
    const ev = db.getDb().prepare(`SELECT event_data FROM document_events WHERE document_slug = ? AND event_type = 'proxy.ratified'`).get(slug) as { event_data: string };
    const data = JSON.parse(ev.event_data);
    assert.equal(data.lines.length, 2, 'the event names every line the click covered');
    assert.ok(data.lines.every((l: any) => l.evidence && l.confidence));
    const again = await call(`/api/documents/${slug}/proxy/ratify`, 'POST', { proxyIds: Object.values(proxyIds) }, MIKE);
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'NOTHING_TO_RATIFY');
  });

  await test('the page cannot claim via "proxy" on an ordinary mark', async () => {
    const r = await call(`/api/documents/${slug}/line-marks`, 'POST', { status: 'agreed', via: 'proxy', anchor: shared.anchorForLine(L('Marketing')) }, MIKE);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'VIA_NOT_ALLOWED');
  });

  await test('Undo restores what the lines held before, in one request; only once; only its person', async () => {
    const ericUndo = await call(`/api/documents/${slug}/proxy/ratifications/${ratificationId}/undo`, 'POST', {}, ERIC);
    assert.equal(ericUndo.status, 404);
    const page = await call(`/api/documents/${slug}/line-marks`, 'GET', undefined, MIKE);
    assert.equal(page.body.ratifications.length, 1);
    const s0 = await state();
    const r = await call(`/api/documents/${slug}/proxy/ratifications/${ratificationId}/undo`, 'POST', {}, MIKE);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.restored, 2);
    const s = await state();
    assert.equal(mikeLineIssues(s), mikeLineIssues(s0) + 2);
    assert.equal((s.lineMarks as any[]).filter(m => m.by === MIKE_ACTOR).length, 0);
    assert.equal(s.proxies[MIKE_ACTOR].counts.agreed, 2, 'the proxies are back in the brief');
    const twice = await call(`/api/documents/${slug}/proxy/ratifications/${ratificationId}/undo`, 'POST', {}, MIKE);
    assert.equal(twice.status, 409);
    // Undo restores an earlier mark too: Mike skimmed the budget line, ratifies, undoes.
    const skim = await call(`/api/documents/${slug}/line-marks`, 'POST', { status: 'skimmed', via: 'dwell', anchor: shared.anchorForLine(L('ten thousand')) }, MIKE);
    assert.equal(skim.status, 200);
    const r2 = await call(`/api/documents/${slug}/proxy/ratify`, 'POST', { proxyIds: [proxyIds.The] }, MIKE);
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    await call(`/api/documents/${slug}/proxy/ratifications/${r2.body.ratification.id}/undo`, 'POST', {}, MIKE);
    const back = ((await state()).lineMarks as any[]).filter(m => m.by === MIKE_ACTOR);
    assert.deepEqual(back.map(m => m.status), ['skimmed']);
    assert.equal(back[0].id, skim.body.lineMark.id, 'the very same mark came back');
  });

  await test('a meaning-changing edit resets a proxy; a cosmetic edit carries it (server)', async () => {
    // A second document already carries the edits; the proxies were written on the old text.
    const slug2 = 'proxy-edited';
    const edited = doc.replace('second quarter', 'third quarter').replace('fixed at ten thousand.', 'fixed at ten thousand');
    db.createDocument(slug2, edited, {}, 'Proxy edited', 'owner-2', 'owner-secret-proxy2');
    const key2 = db.createDocumentAccessToken(slug2, 'editor', undefined, { label: 'Claude', requestedBy: 'test', requestedFrom: '127.0.0.1' });
    const bound = await call(`/api/agent/${slug2}/familiars`, 'POST', { for: MIKE_ACTOR, familiar: 'ai:claude' }, { 'x-share-token': 'owner-secret-proxy2' });
    assert.equal(bound.status, 200, JSON.stringify(bound.body));
    const insert = db.getDb().prepare(`INSERT INTO document_proxy_marks (id, document_slug, familiar_actor, familiar_key, for_actor, for_key, status, confidence, evidence,
      line_hash, line_occurrence, line_ordinal, line_kind, line_excerpt, line_text, at) VALUES (?, ?, 'ai:claude', 'ai:claude', ?, ?, 'agreed', 0.95, 'Checked against the plan', ?, ?, ?, ?, ?, ?, ?)`);
    for (const [id, text] of [['p-launch', 'second quarter'], ['p-budget', 'ten thousand']] as const) {
      const a = shared.anchorForLine(L(text));
      insert.run(id, slug2, MIKE_ACTOR, MIKE_ACTOR, a.hash, a.occurrence, a.ordinal, a.kind, a.excerpt, a.text ?? null, new Date().toISOString());
    }
    const s = (await call(`/api/agent/${slug2}/state`, 'GET', undefined, { 'x-share-token': key2.secret })).body;
    const brief = s.proxies[MIKE_ACTOR];
    assert.deepEqual(brief.reset.map((p: any) => p.proxyId), ['p-launch'], 'the launch line changed meaning: reset');
    const budget = brief.items.find((i: any) => i.proxyId === 'p-budget');
    assert.equal(budget.carried, true);
    assert.equal(budget.bucket, 'ratify');
    assert.equal(brief.counts.agreed, 1);
  });

  await test('AI line marks take evidence; without it they are "claimed" in /state', async () => {
    const withEv = await call(`/api/agent/${slug}/marks/line`, 'POST', { quote: 'Marketing', status: 'agreed', evidence: 'Matches the launch calendar' }, CLAUDE);
    assert.equal(withEv.status, 200, JSON.stringify(withEv.body));
    assert.equal(withEv.body.lineMark.evidence, 'Matches the launch calendar');
    const without = await call(`/api/agent/${slug}/marks/line`, 'POST', { quote: 'Last line', status: 'seen' }, CLAUDE);
    assert.equal(without.status, 200);
    const s = await state();
    const marks = (s.lineMarks as any[]).filter(m => m.by === 'ai:claude');
    assert.equal(marks.find(m => m.status === 'agreed').claimed, undefined);
    assert.equal(marks.find(m => m.status === 'seen').claimed, true);
    // A person's evidence is not kept (evidence is for AI marks and ratified proxies).
    const human = await call(`/api/agent/${slug}/marks/line`, 'POST', { quote: 'Marketing', status: 'seen', by: 'human:eric@example.test', evidence: 'I read it carefully today' }, OWNER);
    assert.equal(human.status, 200);
    assert.equal(human.body.lineMark.evidence, undefined);
  });

  await test('rebinding: proxies from a Familiar Mike no longer chose leave his brief; withdrawing a proxy with "unseen"', async () => {
    const w = await call(`/api/agent/${slug}/marks/proxy`, 'POST', { for: MIKE_ACTOR, lines: [{ quote: 'Marketing', status: 'unseen' }] }, CLAUDE);
    assert.equal(w.status, 200);
    assert.equal(w.body.replaced, 1);
    const re = await call(`/api/documents/${slug}/familiar`, 'POST', { familiar: 'ai:critic' }, MIKE);
    assert.equal(re.status, 200);
    assert.equal((await state()).proxies[MIKE_ACTOR].items.length, 0);
    const back = await call(`/api/documents/${slug}/familiar`, 'POST', { familiar: null }, MIKE);
    assert.equal(back.status, 200);
    assert.equal((await call(`/api/documents/${slug}/line-marks`, 'GET', undefined, MIKE)).body.familiar, null);
  });

  console.log(`\n${passed} proxy-mark tests passed`);
} finally {
  server.close();
}
process.exit(0);
