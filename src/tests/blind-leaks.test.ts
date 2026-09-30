/** ac-0f4: regression reproductions for the blind-leak audit, Mike, 2026-09-23 (usability brief). */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';
const temp = mkdtempSync(path.join(tmpdir(), 'accord-blind-'));
Object.assign(process.env, { DATABASE_PATH: path.join(temp, 'test.db'), PROOF_ENV: 'test', PROOF_DB_ENV_INIT: 'test', PROOF_LIBRARY_ENABLED: '1' });
delete process.env.PROOF_SOMA_AUTH_ENABLED;
const db = await import('../../server/db');
const store = await import('../../server/proof-extras-store');
const lm = await import('../../server/line-marks');
const auth = await import('../../server/library/auth');
const { apiRoutes } = await import('../../server/routes');
const { agentRoutes } = await import('../../server/agent-routes');
const { anchorForLine } = await import('../shared/line-marks');
const app = express(); app.use(express.json()); app.use('/api', apiRoutes); app.use('/api/agent', agentRoutes);
const server = createServer(app);
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
type Headers = Record<string, string>;
async function call(url: string, headers: Headers, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Proof-Client-Version': '0.34.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); let json: any = {};
  try { json = JSON.parse(text); } catch { /* exports */ }
  return { status: response.status, body: json, text, headers: response.headers };
}
function ok(r: { status: number; text: string; body: any }) { assert.equal(r.status, 200, r.text.slice(0, 500)); return r.body; }
let passed = 0, failed = 0, serial = 0;
async function test(name: string, run: () => Promise<void>) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e instanceof Error ? e.stack : e}`); }
}
const HUMAN = 'human:other@example.test';
const SECRET = 'PRIVATE_POSITION_REASON';
const markdown = 'First passage is under review.\n\nSecond passage is under review.\n\nThird passage is under review.';
async function fixture(content = markdown) {
  const slug = `blind-${++serial}`;
  db.createDocument(slug, content, {}, 'Blind fixture', `owner-${serial}`, `secret-${serial}`);
  const owner = { 'x-share-token': `secret-${serial}` };
  const reader = { 'x-share-token': db.createDocumentAccessToken(slug, 'editor', undefined, { label: 'Reader', requestedBy: 'test', requestedFrom: '127.0.0.1' }).secret };
  const familiar = { 'x-share-token': db.createDocumentAccessToken(slug, 'editor', undefined, { label: 'Familiar', requestedBy: 'test', requestedFrom: '127.0.0.1' }).secret };
  const share = { 'x-share-token': db.createDocumentAccessToken(slug, 'commenter').secret };
  const A = `/api/agent/${slug}`, P = `/api/documents/${slug}`;
  const mark = async (lineIndex: number, by = HUMAN, status = 'seen', headers = owner) => ok(await call(`${A}/marks/line`, headers, { lineIndex, by, status, reason: status === 'rejected' ? SECRET : undefined, evidence: 'Review evidence' }));
  const objection = async (by = HUMAN) => ok(await call(`${A}/objections`, owner, { by, lines: [{ lineIndex: 0 }, { lineIndex: 1 }], reason: SECRET, condition: 'PRIVATE_CONDITION' })).objection;
  const proxy = async (status = 'rejected-suggested') => {
    ok(await call(`${A}/familiars`, owner, { for: HUMAN, familiar: 'ai:familiar' }));
    ok(await call(`${A}/marks/proxy`, familiar, { for: HUMAN, lines: [{ target: { lineIndex: 0 }, status, confidence: 0.99, evidence: 'PRIVATE_PROXY_EVIDENCE' }] }));
  };
  const blind = () => store.setBlind(slug, true, HUMAN, new Date().toISOString());
  return { slug, A, P, owner, reader, familiar, share, mark, objection, proxy, blind };
}
try {
  for (const page of [true, false]) await test(`1 objections ${page ? 'page' : 'agent including closed'} require whole-span reveal`, async () => {
    const f = await fixture(); const obj = await f.objection(); f.blind();
    const url = page ? `${f.P}/line-marks` : `${f.A}/objections?closed=1`;
    assert.equal(ok(await call(url, f.reader)).objections.length, 0);
    await f.mark(0, 'ai:reader', 'seen', f.reader);
    assert.equal(ok(await call(url, f.reader)).objections.length, 0);
    await f.mark(1, 'ai:reader', 'seen', f.reader);
    assert.match(JSON.stringify(ok(await call(url, f.reader))), /PRIVATE_POSITION_REASON/);
    ok(await call(`${f.A}/objections/${obj.id}/clear`, f.owner, { by: HUMAN }));
    if (!page) {
      assert.equal(ok(await call(url, f.share)).closed.length, 0);
      assert.equal(ok(await call(url, f.reader)).closed.length, 1);
    }
  });
  await test('2 pending events filter existing acknowledged objections, proxy and withdrawn answers at read time', async () => {
    const f = await fixture(); const obj = await f.objection(); await f.proxy();
    db.addDocumentEvent(f.slug, 'ask.answer_withdrawn', { askId: 'missing', choice: 'no', words: SECRET }, HUMAN);
    db.getDb().prepare('UPDATE document_events SET acked_at = ? WHERE document_slug = ?').run(new Date().toISOString(), f.slug);
    f.blind();
    const r = ok(await call(`${f.A}/events/pending`, f.reader));
    assert.ok(!r.events.some((e: any) => e.type.startsWith('objection.')));
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE_|"choice":"no"/);
    assert.ok(r.cursor > 0, 'suppression must still advance the raw event cursor');
    assert.match((await call(`${f.A}/events/pending`, f.owner)).text, /PRIVATE_POSITION_REASON/);
    await f.mark(0, 'ai:reader', 'seen', f.reader); await f.mark(1, 'ai:reader', 'seen', f.reader);
    assert.ok(ok(await call(`${f.A}/events/pending`, f.reader)).events.some((e: any) => e.data.objectionId === obj.id));
  });
  for (const surface of ['page export', 'agent dialect', 'plain counts', 'critic counts', 'state history']) await test(`3 ${surface} filters objections, proxies and imported history`, async () => {
    const f = await fixture(); await f.objection(); await f.proxy();
    db.getDb().prepare(`INSERT INTO document_dialect_history (id, document_slug, mark_text, claimed_by, reason, imported_by, line_excerpt, seq, at) VALUES (?, ?, ?, ?, ?, ?, '', 0, ?)`)
      .run(`history-${serial}`, f.slug, JSON.stringify({ type: 'rejected', fields: { reason: 'PRIVATE_HISTORY' } }), HUMAN, 'test', HUMAN, new Date().toISOString());
    f.blind();
    const url = surface === 'state history' ? `${f.A}/state` : surface === 'page export' ? `${f.P}/export?format=proof-dialect` : `${f.A}/export?format=${surface === 'plain counts' ? 'plain' : surface === 'critic counts' ? 'criticmarkup' : 'proof-dialect'}`;
    const r = await call(url, f.reader); ok(r);
    assert.doesNotMatch(r.text, /PRIVATE_/);
    if (surface.includes('counts')) {
      const counts = JSON.parse(r.headers.get('X-Proof-Export-Counts')!);
      assert.equal(counts.objections ?? 0, 0); assert.equal(counts.proxies ?? 0, 0); assert.equal(counts.history ?? 0, 0);
    }
    if (surface === 'state history') assert.equal(r.body.dialectHistory.length, 0);
  });
  await test('4 proxy for query authorizes person, Familiar or administrative owner', async () => {
    const f = await fixture(); await f.proxy(); f.blind();
    const url = `${f.A}/marks/proxy?for=${encodeURIComponent(HUMAN)}`;
    assert.equal((await call(url, f.reader)).status, 403);
    assert.match((await call(url, f.familiar)).text, /PRIVATE_PROXY_EVIDENCE/);
    assert.match((await call(url, f.owner)).text, /PRIVATE_PROXY_EVIDENCE/);
  });
  for (const surface of ['page', 'agent', 'state', 'poll']) await test(`5 asks ${surface} hides answers and answer-dependent state`, async () => {
    const f = await fixture();
    const ask = ok(await call(`${f.A}/asks`, f.owner, { by: HUMAN, lineIndex: 2, to: [HUMAN], recommend: 'Yes' })).ask;
    ok(await call(`${f.A}/asks/${ask.id}/answer`, f.owner, { by: HUMAN, choice: 'not_yet', words: SECRET }));
    f.blind();
    const url = surface === 'page' ? `${f.P}/asks` : surface === 'poll' ? `${f.P}/line-marks` : `${f.A}/${surface === 'agent' ? 'asks' : 'state'}`;
    const r = ok(await call(url, f.reader));
    assert.doesNotMatch(JSON.stringify(r.asks), /PRIVATE_|not_yet/);
    const row = r.asks[0];
    assert.ok(row.answers.every((a: any) => a.hidden));
    assert.equal(row.snoozedFor, undefined); assert.equal(row.closed, undefined); assert.equal(row.settled, undefined);
    await f.mark(2, 'ai:reader', 'seen', f.reader);
    assert.match((await call(url, f.reader)).text, /PRIVATE_POSITION_REASON/);
  });
  for (const page of [true, false]) await test(`6 ${page ? 'page' : 'agent'} snapshot JSON and ledger deny blind non-owners`, async () => {
    const f = await fixture();
    // A real aligned snapshot is created before a later reader joins the blind review.
    for (const actor of [HUMAN, 'ai:reader', 'ai:familiar']) for (const i of [0, 1, 2]) await f.mark(i, actor, 'agreed');
    const state = ok(await call(`${f.A}/state`, f.owner));
    const id = state.alignment.lastSnapshot?.id; assert.ok(id, 'fixture must be aligned');
    f.blind();
    for (const suffix of ['', '.md']) {
      const url = `${page ? f.P : f.A}/snapshots/${id}${suffix}`;
      assert.equal((await call(url, f.share)).status, 403);
      assert.equal((await call(url, f.owner)).status, 200);
    }
  });
  for (const page of [true, false]) await test(`7 ${page ? 'typed guest' : 'unbound AI'} cannot borrow reveal`, async () => {
    const f = await fixture(); await f.mark(0, HUMAN, 'rejected');
    const borrowed = page ? 'guest:Borrowed' : 'ai:borrowed'; await f.mark(0, borrowed); f.blind();
    const url = `${page ? `${f.P}/line-marks` : `${f.A}/state`}?by=${encodeURIComponent(borrowed)}`;
    const r = ok(await call(url, f.share));
    assert.equal(r.lineMarks.find((m: any) => m.by === HUMAN).hidden, true);
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE_POSITION_REASON/);
    await f.mark(0, 'ai:reader', 'seen', f.reader);
    assert.match((await call(page ? `${f.P}/line-marks` : `${f.A}/state`, f.reader)).text, /PRIVATE_POSITION_REASON/);
  });
  await test('8 state Issues and alignment counts do not reveal hidden rejection', async () => {
    const f = await fixture(`# Review\n\n${markdown}`); await f.objection(); await f.mark(2, HUMAN, 'rejected'); f.blind();
    const r = ok(await call(`${f.A}/state`, f.reader));
    assert.doesNotMatch(JSON.stringify(r.issues), /rejected-by-others|disagreement|PRIVATE_|lapsedFor/);
    assert.equal(r.alignment.counts, undefined);
    assert.ok(r.sections.length > 0);
    assert.ok(r.sections.every((s: any) => s.counts === undefined && s.issues === undefined));
    const check = ok(await call(`${f.P}/alignment-check`, f.reader, {}));
    assert.equal(check.issues, undefined); assert.equal(check.aligned, undefined);
  });
  for (const surface of ['poll', 'state', 'tiers']) await test(`9 ${surface} tier signals hide others' proxy rejection and positive read`, async () => {
    const f = await fixture(); await f.proxy();
    ok(await call(`${f.A}/tiers`, f.owner, { by: HUMAN, lineIndex: 0, tier: 'context' }));
    await f.mark(1, 'ai:familiar', 'agreed', f.familiar); f.blind();
    const r = ok(await call(surface === 'poll' ? `${f.P}/line-marks` : `${f.A}/${surface}`, f.reader));
    if (surface === 'poll') { assert.deepEqual(r.tierSignals.flags, []); assert.deepEqual(r.tierSignals.reads, []); }
    else for (const tier of r.tiers) { assert.deepEqual(tier.flaggedFor, []); assert.deepEqual(tier.readBy, []); }
  });
  await test('10 own proxy brief uses the same neutral hold with and without hidden objections', async () => {
    const f = await fixture(); await f.proxy('agreed'); f.blind();
    const url = `${f.A}/marks/proxy?for=${encodeURIComponent(HUMAN)}`;
    const before = ok(await call(url, f.familiar)).brief;
    await f.objection();
    const after = ok(await call(url, f.familiar)).brief;
    assert.deepEqual(after.items.map((i: any) => [i.bucket, i.held]), before.items.map((i: any) => [i.bucket, i.held]));
    assert.deepEqual(after.counts, before.counts);
    assert.deepEqual(before.items[0].held, ['blind']);
  });
  for (const surface of ['state', 'ttl']) await test(`11 ${surface} TTL conceals decayed mark IDs and named decision lists`, async () => {
    const f = await fixture(); await f.mark(0, HUMAN, 'agreed');
    ok(await call(`${f.A}/ttl`, f.owner, { by: HUMAN, lineIndex: 0, ttl: '1s' }));
    db.getDb().prepare('UPDATE document_line_ttls SET period_start = ? WHERE document_slug = ?').run('2000-01-01T00:00:00.000Z', f.slug);
    f.blind(); const r = ok(await call(`${f.A}/${surface}`, f.reader));
    assert.deepEqual(r.ttls[0].decayedMarks ?? [], []); assert.equal(r.ttls[0].openFor, undefined);
  });
  await test('12 hidden mark origin cannot prove proxy agreement', async () => {
    const f = await fixture(); const lines = await lm.computeServerLines(markdown);
    const result = lm.writeLineMarksBatch(f.slug, { by: HUMAN, status: 'agreed', via: 'proxy', allowServerVias: true, canApprove: false, source: 'page', lines: [{ anchor: anchorForLine(lines[0]) }], context: { ratificationId: 'private-ratification', familiar: 'ai:familiar' } });
    assert.equal(result.status, 200); f.blind();
    const r = ok(await call(`${f.A}/state`, f.reader));
    assert.equal(r.lineMarks[0].hidden, true); assert.equal(r.lineMarks[0].via, undefined);
    assert.doesNotMatch((await call(`${f.A}/events/pending`, f.reader)).text, /private-ratification|"via":"proxy"/);
  });
  await test('13 alternative summaries and Issue priorities hide disagreement', async () => {
    const f = await fixture();
    const alt = ok(await call(`${f.A}/alternatives`, f.owner, { by: HUMAN, lineIndex: 0, text: 'A proposed replacement.' })).alternative;
    ok(await call(`${f.A}/alternatives/pick`, f.owner, { by: HUMAN, lineIndex: 0, choice: alt.id }));
    ok(await call(`${f.A}/alternatives/pick`, f.familiar, { lineIndex: 0, choice: 'original' }));
    f.blind();
    const r = ok(await call(`${f.A}/state`, f.reader));
    assert.doesNotMatch(JSON.stringify(r.alternatives), /picks differ/);
    assert.ok(!r.issues.some((i: any) => i.disagree || i.disagreement || i.priorityRule === 'disagreement'));
  });
  await test('7 verified session reveal ignores typed names and typed since-you stays blind', async () => {
    const f = await fixture(); await f.mark(0, HUMAN, 'rejected'); await f.mark(0, 'guest:Borrowed'); await f.mark(0, 'ai:borrowed');
    const member = auth.createLibraryMember({ name: 'Verified Reader', email: 'reader@example.test' });
    const link = auth.createLibrarySigninLink({ memberId: member.id, purpose: 'operator', origin: base });
    const session = auth.consumeLibrarySigninToken(new URL(link.link).hash.slice(3), null)!;
    const headers = { ...f.share, Cookie: `${auth.LIBRARY_SESSION_COOKIE}=${encodeURIComponent(session.sessionId)}`, Origin: base };
    f.blind();
    assert.doesNotMatch((await call(`${f.P}/line-marks?by=guest:Borrowed`, headers)).text, /PRIVATE_POSITION_REASON/);
    const lines = await lm.computeServerLines(markdown);
    ok(await call(`${f.P}/line-marks`, headers, { by: 'guest:Borrowed', status: 'seen', anchor: anchorForLine(lines[0]) }));
    assert.match((await call(`${f.P}/line-marks`, headers)).text, /PRIVATE_POSITION_REASON/);
    assert.doesNotMatch((await call(`${f.P}/since-you?by=guest:Borrowed`, f.share)).text, /PRIVATE_POSITION_REASON/);
    assert.doesNotMatch((await call(`${f.A}/since-you?by=ai:borrowed`, f.share)).text, /PRIVATE_POSITION_REASON/);
  });
  await test('7 revoked key identity on a share token cannot borrow reveal', async () => {
    const f = await fixture(); await f.mark(0, HUMAN, 'rejected'); await f.mark(0, 'ai:reader', 'seen', f.reader);
    db.getDb().prepare('UPDATE document_access SET revoked_at = ? WHERE document_slug = ? AND label = ?').run(new Date().toISOString(), f.slug, 'Reader');
    f.blind();
    assert.doesNotMatch((await call(`${f.A}/state?by=ai:reader`, f.share)).text, /PRIVATE_POSITION_REASON/);
  });
  await test('10 blind ratification refusals cannot distinguish another person’s objection', async () => {
    const f = await fixture(); await f.proxy('agreed'); f.blind();
    const member = auth.createLibraryMember({ name: 'Proxy Person', email: 'other@example.test' });
    const link = auth.createLibrarySigninLink({ memberId: member.id, purpose: 'operator', origin: base });
    const session = auth.consumeLibrarySigninToken(new URL(link.link).hash.slice(3), null)!;
    const headers = { ...f.share, Cookie: `${auth.LIBRARY_SESSION_COOKIE}=${encodeURIComponent(session.sessionId)}`, Origin: base };
    const proxy = ok(await call(`${f.A}/marks/proxy?for=${encodeURIComponent(HUMAN)}`, f.familiar)).brief.items[0];
    const before = await call(`${f.P}/proxy/ratify`, headers, { proxyIds: [proxy.proxyId] });
    await f.objection('human:someone-else@example.test');
    const after = await call(`${f.P}/proxy/ratify`, headers, { proxyIds: [proxy.proxyId] });
    assert.equal(before.status, 409); assert.equal(after.status, 409);
    assert.deepEqual(after.body, before.body); assert.doesNotMatch(after.text, /objection|rejected/);
  });
  for (const page of [true, false]) await test(`11 ${page ? 'page' : 'agent'} TTL creation and expiry events omit decision fields`, async () => {
    const f = await fixture(); await f.mark(0, HUMAN, 'agreed'); f.blind();
    const lines = await lm.computeServerLines(markdown);
    const result = ok(await call(page ? `${f.P}/ttl` : `${f.A}/ttl`, f.reader, { lineIndex: 0, anchor: anchorForLine(lines[0]), ttl: '1s' }));
    assert.equal(result.ttl.openFor, undefined); assert.equal(result.ttl.decayedMarks, undefined);
    db.getDb().prepare('UPDATE document_line_ttls SET period_start = ? WHERE document_slug = ?').run('2000-01-01T00:00:00.000Z', f.slug);
    ok(await call(`${f.A}/state`, f.reader));
    const events = ok(await call(`${f.A}/events/pending`, f.reader)).events.filter((e: any) => e.type === 'ttl.expired');
    assert.equal(events.length, 1);
    assert.equal(events[0].data.decayedMarks, undefined); assert.equal(events[0].data.openFor, undefined);
  });
  for (const surface of ['page', 'agent', 'events']) await test(`13 ${surface} closed alternative history cannot disclose a hidden unanimous winner`, async () => {
    const f = await fixture();
    const alt = ok(await call(`${f.A}/alternatives`, f.owner, { by: HUMAN, lineIndex: 0, text: 'A proposed replacement.' })).alternative;
    // Real persisted resolution shape, left on unchanged text so reveal remains independently testable.
    store.closeAlternativeRow(f.slug, alt.id, 'chosen', HUMAN, new Date().toISOString(), { how: 'unanimous', winner: alt.id, winnerText: 'PRIVATE_WINNER' });
    db.addDocumentEvent(f.slug, 'alternative.resolved', { lineIndex: 0, how: 'unanimous', choice: alt.id, text: 'PRIVATE_WINNER' }, HUMAN);
    f.blind();
    const url = surface === 'page' ? `${f.P}/line-marks` : surface === 'agent' ? `${f.A}/alternatives?closed=1` : `${f.A}/events/pending`;
    const result = ok(await call(url, f.reader));
    assert.doesNotMatch(JSON.stringify(result), /unanimous|PRIVATE_WINNER/);
    assert.match((await call(url, f.owner)).text, /PRIVATE_WINNER/);
  });
  for (const page of [true, false]) await test(`7 ${page ? 'page' : 'agent'} since-you cannot borrow an earlier reader’s reveal`, async () => {
    const f = await fixture(); const by = page ? 'guest:Borrowed' : 'ai:borrowed';
    await f.mark(0, by); await f.mark(0, HUMAN, 'rejected'); f.blind();
    const r = await call(`${page ? f.P : f.A}/since-you?by=${encodeURIComponent(by)}`, f.share);
    ok(r); assert.doesNotMatch(r.text, /PRIVATE_POSITION_REASON/);
  });
  await test('10 partial answer reveal cannot bypass a multi-line objection through proxy ratification', async () => {
    const f = await fixture(); await f.proxy('agreed');
    const ask = ok(await call(`${f.A}/asks`, f.owner, { by: HUMAN, lineIndex: 0, to: [HUMAN], recommend: 'Yes' })).ask;
    ok(await call(`${f.A}/asks/${ask.id}/answer`, f.owner, { by: HUMAN, choice: 'yes', words: 'Yes' }));
    // Removing the mark leaves a legitimate answer-based reveal, but no current human mark
    // to make the proxy moot. This is the partial-span case the neutral hold must protect.
    await f.mark(0, HUMAN, 'unseen'); f.blind();
    const url = `${f.A}/marks/proxy?for=${encodeURIComponent(HUMAN)}&by=${encodeURIComponent(HUMAN)}`;
    const before = ok(await call(url, f.owner)).brief;
    assert.deepEqual(before.items[0].held, ['blind']);
    await f.objection('human:someone-else@example.test');
    const after = ok(await call(url, f.owner)).brief;
    assert.deepEqual(after, before);
    assert.equal(after.items[0].bucket, 'held');
  });
} finally {
  server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
  rmSync(temp, { recursive: true, force: true });
}
console.log(`Blind leak regressions: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
