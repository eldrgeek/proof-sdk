// Orphaned suggestion marks: pending suggestions whose text was removed by /edit/v2 must not
// wedge the document. Rejecting an orphan deletes its stored mark with no text change; accepting
// one is a clear 409 MARK_ORPHANED; and one orphan must not block unrelated mark operations.
// Authorship: Claude Opus 5 (worker fix/orphan-marks), 2026-09-19, for Mike Wolf's Proof fork.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-orphans-'));
process.env.DATABASE_PATH = path.join(temp, 'test.db');
Object.assign(process.env, { PROOF_ENV: 'test', PROOF_DB_ENV_INIT: 'test' });
delete process.env.PROOF_SOMA_AUTH_ENABLED;
delete process.env.PROOF_PUBLIC_ORIGIN;

const db = await import('../../server/db');
const { agentRoutes } = await import('../../server/agent-routes');
const orphans = await import('../../server/proof-mark-orphans');

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const app = express();
app.use(express.json());
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

const slug = 'orphan-test';
const doc = [
  '# Orphans',
  '',
  'Alpha bravo charlie delta carry the suggestions.',
  '',
  'The second paragraph stays untouched for later.',
].join('\n');
db.createDocument(slug, doc, {}, 'Orphan test', 'owner-1', 'owner-secret-123');
const OWNER = { 'x-share-token': 'owner-secret-123' };
const by = 'human:tester';

const revision = async (): Promise<number> => {
  const state = await call(`/api/agent/${slug}/state`, 'GET', undefined, OWNER);
  assert.equal(state.status, 200, JSON.stringify(state.body));
  return state.body.revision;
};

try {
  await test('policy: only a pending suggestion whose quote is absent from the text is orphaned', () => {
    const markdown = 'Hello **bold** world.';
    assert.equal(orphans.isOrphanedSuggestionMark(markdown, { kind: 'insert', by, quote: 'gone text', status: 'pending' } as any), true);
    assert.equal(orphans.isOrphanedSuggestionMark(markdown, { kind: 'insert', by, quote: 'bold world', status: 'pending' } as any), false, 'formatting does not hide text');
    assert.equal(orphans.isOrphanedSuggestionMark(markdown, { kind: 'insert', by, quote: 'gone text', status: 'rejected' } as any), false, 'finalized marks are not orphans');
    assert.equal(orphans.isOrphanedSuggestionMark(markdown, { kind: 'comment', by, quote: 'gone text', text: 'x' } as any), false, 'comments are never orphans');
    assert.equal(orphans.isOrphanedSuggestionMark(markdown, { kind: 'insert', by, quote: '', status: 'pending' } as any), false, 'no quote, no orphan claim');
    assert.ok(orphans.ORPHANED_SUGGESTION_POLICY.kinds.includes('insert'));
  });

  const suggestionIds: string[] = [];
  await test('setup: four pending insert suggestions on the first paragraph', async () => {
    for (const quote of ['Alpha', 'bravo', 'charlie', 'delta']) {
      const r = await call(`/api/agent/${slug}/marks/suggest-insert`, 'POST', { quote, content: ` ${quote.toUpperCase()}X`, by }, OWNER);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      suggestionIds.push(r.body.markId);
    }
    assert.equal(new Set(suggestionIds).size, 4);
  });

  await test('edit/v2 replace_block removes the suggested text and leaves the marks orphaned', async () => {
    const r = await call(`/api/agent/${slug}/edit/v2`, 'POST', {
      by, baseRevision: await revision(),
      operations: [{ op: 'replace_block', ref: 'b2', block: { markdown: 'A brand new sentence replaced it all.' } }],
    }, OWNER);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const stored = db.getDocumentBySlug(slug)!;
    const marks = JSON.parse(stored.marks) as Record<string, any>;
    for (const id of suggestionIds) {
      assert.ok(marks[id], `mark ${id} is still stored`);
      assert.equal(marks[id].status, 'pending');
    }
  });

  await test('/state lists the orphaned marks with id, kind, by and quote', async () => {
    const state = await call(`/api/agent/${slug}/state`, 'GET', undefined, OWNER);
    assert.equal(state.status, 200);
    const listed = state.body.orphanedMarks as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(listed), JSON.stringify(state.body));
    assert.deepEqual(listed.map(m => m.id).sort(), [...suggestionIds].sort());
    for (const entry of listed) {
      assert.equal(entry.kind, 'insert');
      assert.equal(entry.by, by);
      assert.equal(typeof entry.quote, 'string');
    }
  });

  await test('an unrelated suggestion can be added and rejected while orphans exist', async () => {
    const added = await call(`/api/agent/${slug}/marks/suggest-replace`, 'POST', { quote: 'untouched', content: 'unchanged', by }, OWNER);
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const rejected = await call(`/api/agent/${slug}/marks/reject`, 'POST', { markId: added.body.markId, by }, OWNER);
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    const markdown = db.getDocumentBySlug(slug)!.markdown;
    assert.ok(markdown.includes('untouched'), 'reject leaves the text alone');
  });

  await test('accepting an orphaned insert is a clear 409 MARK_ORPHANED', async () => {
    const r = await call(`/api/agent/${slug}/marks/accept`, 'POST', { markId: suggestionIds[0], by }, OWNER);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, 'MARK_ORPHANED');
  });

  await test('rejecting each orphan succeeds, drops the stored mark, and leaves the text unchanged', async () => {
    for (const id of suggestionIds) {
      const before = db.getDocumentBySlug(slug)!.markdown;
      const r = await call(`/api/agent/${slug}/marks/reject`, 'POST', { markId: id, by }, OWNER);
      assert.equal(r.status, 200, `${id}: ${JSON.stringify(r.body)}`);
      const after = db.getDocumentBySlug(slug)!;
      assert.equal(after.markdown, before, 'no text change');
      const marks = JSON.parse(after.marks) as Record<string, any>;
      assert.ok(!marks[id] || marks[id].status === 'rejected', 'orphan is gone from pending');
    }
    const state = await call(`/api/agent/${slug}/state`, 'GET', undefined, OWNER);
    assert.deepEqual(state.body.orphanedMarks, []);
  });

  await test('after the orphans are cleared, a new suggestion can be accepted', async () => {
    const added = await call(`/api/agent/${slug}/marks/suggest-replace`, 'POST', { quote: 'untouched', content: 'polished', by }, OWNER);
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const accepted = await call(`/api/agent/${slug}/marks/accept`, 'POST', { markId: added.body.markId, by }, OWNER);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.ok(db.getDocumentBySlug(slug)!.markdown.includes('polished'));
  });

  await test('an orphan does not block accepting an unrelated suggestion', async () => {
    const orphan = await call(`/api/agent/${slug}/marks/suggest-insert`, 'POST', { quote: 'brand new', content: ' SHINY', by }, OWNER);
    assert.equal(orphan.status, 200, JSON.stringify(orphan.body));
    const edit = await call(`/api/agent/${slug}/edit/v2`, 'POST', {
      by, baseRevision: await revision(),
      operations: [{ op: 'replace_block', ref: 'b2', block: { markdown: 'Rewritten once more.' } }],
    }, OWNER);
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    const state = await call(`/api/agent/${slug}/state`, 'GET', undefined, OWNER);
    assert.deepEqual(state.body.orphanedMarks.map((m: any) => m.id), [orphan.body.markId]);
    const added = await call(`/api/agent/${slug}/marks/suggest-replace`, 'POST', { quote: 'second', content: 'final', by }, OWNER);
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const accepted = await call(`/api/agent/${slug}/marks/accept`, 'POST', { markId: added.body.markId, by }, OWNER);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const marks = JSON.parse(db.getDocumentBySlug(slug)!.marks) as Record<string, any>;
    assert.ok(marks[orphan.body.markId], 'the orphan stays in storage until someone rejects it');
    const rejected = await call(`/api/agent/${slug}/marks/reject`, 'POST', { markId: orphan.body.markId, by }, OWNER);
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  });

  console.log(`\n${passed} orphaned-suggestion tests passed`);
} finally {
  server.close();
  rmSync(temp, { recursive: true, force: true });
}
process.exit(0);
