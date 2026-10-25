// Accord — multi-party dispositions through the HTTP routes (server/dispositions.ts).
// Mike, 2026-10-24: a suggestion becomes common only when every participant promoted it; a reject
// is a cut, not a veto; observers argue but do not dispose. Off by default per document.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-dispositions-'));
process.env.DATABASE_PATH = path.join(temp, 'test.db');
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

Launch moves to September 30 for every customer.

The milestone review happens on September 23 in Boston.

Budget line stays the same for the quarter.`;

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
  const slug = 'dispositions-test';
  db.createDocument(slug, doc, {}, 'Dispositions test', 'owner-1', 'owner-secret-123');
  const claude = { 'x-share-token': db.createDocumentAccessToken(slug, 'editor', undefined, { label: 'Claude', requestedBy: 'test', requestedFrom: '127.0.0.1' }).secret };
  const gemini = { 'x-share-token': db.createDocumentAccessToken(slug, 'editor', undefined, { label: 'Gemini', requestedBy: 'test', requestedFrom: '127.0.0.1' }).secret };
  const OWNER = { 'x-share-token': 'owner-secret-123' };
  const MIKE = 'human:mike@x.co';
  const markdown = async () => (await call(`/api/agent/${slug}/state`, 'GET', undefined, claude)).body.markdown as string;
  const suggest = async (quote: string, content: string) => {
    const r = await call(`/api/agent/${slug}/marks/suggest-replace`, 'POST', { quote, content, why: 'Test change' }, claude);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const id = r.body.markId ?? r.body.suggestion?.markId ?? Object.entries(r.body.marks ?? {}).find(([, m]: [string, any]) => m.quote === quote && m.status === 'pending')?.[0];
    assert.ok(id, JSON.stringify(r.body));
    return id as string;
  };
  const decide = (verb: 'accept' | 'reject', markId: string, headers: Record<string, string>, by?: string) =>
    call(`/api/agent/${slug}/marks/${verb}`, 'POST', { markId, ...(by ? { by } : {}) }, headers);

  await test('off by default: one accept applies the suggestion, as today', async () => {
    const report = await call(`/api/agent/${slug}/dispositions`, 'GET', undefined, claude);
    assert.equal(report.body.multiParty, false);
    const id = await suggest('September 30', 'October 14');
    const accepted = await decide('accept', id, OWNER, MIKE);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.multiParty, undefined);
    assert.match(await markdown(), /October 14/);
  });

  await test('only the owner credential turns the model on', async () => {
    const refused = await call(`/api/agent/${slug}/dispositions/settings`, 'POST', { multiParty: true }, claude);
    assert.ok(refused.status === 401 || refused.status === 403, String(refused.status));
    const on = await call(`/api/agent/${slug}/dispositions/settings`, 'POST', { multiParty: true, by: MIKE }, OWNER);
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.multiParty, true);
  });

  let budget = '';
  await test('opted in: an accept is a promote; the text changes only when every participant promoted', async () => {
    budget = await suggest('September 23', 'October 7');
    const mike = await decide('accept', budget, OWNER, MIKE);
    assert.equal(mike.status, 200, JSON.stringify(mike.body));
    assert.equal(mike.body.multiParty, true);
    assert.equal(mike.body.proposal.status, 'open');
    assert.deepEqual(mike.body.proposal.openFor, ['ai:gemini']);
    assert.doesNotMatch(await markdown(), /October 7/);
    const report = await call(`/api/agent/${slug}/dispositions`, 'GET', undefined, gemini);
    const view = report.body.proposals.find((p: any) => p.markId === budget);
    assert.deepEqual(view.promotedBy.sort(), ['ai:claude', MIKE].sort());
    assert.equal(report.body.fullAccord, false);
    const last = await decide('accept', budget, gemini);
    assert.equal(last.status, 200, JSON.stringify(last.body));
    assert.equal(last.body.multiParty, undefined, 'the last promote finalizes through the normal accept');
    assert.match(await markdown(), /October 7/);
  });

  await test('opted in: a reject is a cut, not a veto; it stays open as a disagreement until everyone cut it', async () => {
    const id = await suggest('stays the same', 'rises 5 percent');
    const cut = await decide('reject', id, gemini);
    assert.equal(cut.status, 200, JSON.stringify(cut.body));
    assert.equal(cut.body.proposal.status, 'open');
    assert.equal(cut.body.proposal.disagree, true);
    const report = await call(`/api/agent/${slug}/dispositions`, 'GET', undefined, claude);
    assert.deepEqual(report.body.whereWeDiffer, [id]);
    assert.equal((report.body.proposals as any[]).find(p => p.markId === id).status, 'open');
    assert.match(await markdown(), /stays the same/);
    assert.equal((await decide('reject', id, OWNER, MIKE)).body.proposal.status, 'open');
    const withdrawn = await decide('reject', id, claude);
    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
    assert.equal(withdrawn.body.multiParty, undefined, 'the last cut finalizes through the normal reject');
    const after = await call(`/api/agent/${slug}/dispositions`, 'GET', undefined, claude);
    assert.equal(after.body.fullAccord, true);
    assert.match(await markdown(), /stays the same/);
  });

  await test('observers argue but cannot promote or cut, and are not waited on', async () => {
    const set = await call(`/api/agent/${slug}/dispositions/settings`, 'POST', { observers: ['ai:gemini'], by: MIKE }, OWNER);
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const id = await suggest('every customer', 'every paying customer');
    const refused = await decide('accept', id, gemini);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'OBSERVER_CANNOT_DISPOSE');
    const mike = await decide('accept', id, OWNER, MIKE);
    assert.equal(mike.status, 200, JSON.stringify(mike.body));
    assert.match(await markdown(), /every paying customer/);
  });

  await test('the Owner overrules as a special act, and the disagreement is recorded', async () => {
    await call(`/api/agent/${slug}/dispositions/settings`, 'POST', { observers: [], by: MIKE }, OWNER);
    const id = await suggest('in Boston', 'in Denver');
    const cut = await decide('reject', id, gemini);
    assert.equal(cut.body.proposal.disagree, true);
    const notOwner = await call(`/api/agent/${slug}/dispositions/overrule`, 'POST', { markId: id, outcome: 'common' }, claude);
    assert.ok(notOwner.status === 401 || notOwner.status === 403, String(notOwner.status));
    const ruled = await call(`/api/agent/${slug}/dispositions/overrule`, 'POST', { markId: id, outcome: 'common', by: MIKE }, OWNER);
    assert.equal(ruled.status, 200, JSON.stringify(ruled.body));
    assert.equal(ruled.body.action, 'accept');
    assert.deepEqual(ruled.body.overrule.dissent, [{ actor: 'ai:gemini', pile: 'cutting-room' }]);
    const report = await call(`/api/agent/${slug}/dispositions`, 'GET', undefined, claude);
    assert.equal((report.body.proposals as any[]).find(p => p.markId === id).status, 'common');
    const applied = await decide('accept', id, OWNER, MIKE);
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(applied.body.multiParty, undefined, 'after an overrule the accept finalizes through the normal route');
    assert.match(await markdown(), /in Denver/);
    const events = await call(`/api/agent/${slug}/events/pending?after=0`, 'GET', undefined, claude);
    const overruled = (events.body.events as any[]).find(e => e.type === 'disposition.overruled');
    assert.ok(overruled, 'no disposition.overruled event');
    assert.deepEqual(overruled.data.dissent, [{ actor: 'ai:gemini', pile: 'cutting-room' }]);
  });

  await test('every disposition is an event, so the path to accord can be replayed', async () => {
    const events = await call(`/api/agent/${slug}/events/pending?after=0`, 'GET', undefined, claude);
    const recorded = (events.body.events as any[]).filter(e => e.type === 'disposition.recorded');
    assert.ok(recorded.length >= 6, JSON.stringify(recorded.length));
    assert.ok(recorded.every(e => typeof e.data.markId === 'string' && ['promote', 'cut'].includes(e.data.disposition)));
  });

  console.log(`\ndispositions-routes tests: ${passed} passed`);
} finally {
  server.close();
  rmSync(temp, { recursive: true, force: true });
}
