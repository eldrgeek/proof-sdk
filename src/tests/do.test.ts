// Proof Documents {do} action lines — SAFE SLICE: validator, digest, state machine, run
// authorization, Issues, and the HTTP routes with real Documents library sessions.
// Authorship: Claude Opus 5 (worker proof-do), 2026-09-18.
// The critique (do-critique-astra.md) asks for these refusals to be tested before anything runs:
// forged identities, share tokens, agent keys and guests cannot approve; an approval dies when any
// digest field changes; approvals are single use; a timeout is "stalled", not "failed"; receipts
// never create agreement; and nothing can run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-do-'));
process.env.DATABASE_PATH = path.join(temp, 'test.db');
Object.assign(process.env, { PROOF_ENV: 'test', PROOF_DB_ENV_INIT: 'test', PROOF_LIBRARY_ENABLED: '1' });
delete process.env.PROOF_SOMA_AUTH_ENABLED;
delete process.env.PROOF_PUBLIC_ORIGIN;

const shared = await import('../shared/line-marks');
const doMod = await import('../shared/do');
const aids = await import('../shared/review-aids');
const serverLines = await import('../../server/line-marks');
const db = await import('../../server/db');
const auth = await import('../../server/library/auth');
const executor = await import('../../server/do-executor');
const { apiRoutes } = await import('../../server/routes');
const { agentRoutes } = await import('../../server/agent-routes');

const { DO_POLICY } = doMod;

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const doc = `# Actions

Authorize the Google Docs bridge for Mike

Plain line after it.

Last line.`;

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

const MIKE_ACTOR = 'human:mw@mike-wolf.com';
const ERIC_ACTOR = 'human:eric@example.test';

function gdocAction(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'authorize-gdoc-bridge',
    revision: 1,
    executor: 'workflow',
    label: 'Authorize the Google Docs bridge',
    operation: 'gdoc_bridge_authorize',
    params: { project_id: 'soma-gdoc-bridge', account: 'mw@mike-wolf.com' },
    human_gate: {
      instruction: 'Click Allow on Google’s consent page',
      target: { url: 'https://accounts.google.com/o/oauth2/v2/auth', ref: 'google.oauth.consent.primary', label: 'Allow' },
    },
    completion: { mode: 'verified', success_message: 'The bridge is authorized' },
    verification: { kind: 'google_drive_about' },
    ...overrides,
  };
}

const T0 = Date.parse('2026-09-18T10:00:00.000Z');
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function record(overrides: Partial<import('../shared/do').ProofDo> = {}, line?: import('../shared/line-marks').DocLine): import('../shared/do').ProofDo {
  return {
    id: 'do-1', by: 'ai:claude-cos', to: [MIKE_ACTOR], presser: 'approver', retryBudget: 0,
    action: gdocAction(), anchor: shared.anchorForLine(line!), createdAt: iso(0), withdrawnAt: null, approvals: [], runs: [],
    ...overrides,
  };
}

const ENABLED = { executionEnabled: true, macPrincipals: [MIKE_ACTOR], stallAfterMs: DO_POLICY.stallAfterMs, needsFingerStalls: false };

try {
  const lines = await serverLines.computeServerLines(doc);
  const DO_LINE = lines.findIndex(line => line.text.startsWith('Authorize'));
  assert.ok(DO_LINE > 0);

  // ------------------------------------------------------------------ the switch
  await test('policy: execution is not enabled; receipts never mark agreement; single use by default', () => {
    assert.equal(DO_POLICY.executionEnabled, false);
    assert.equal(DO_POLICY.executionDisabledLabel, 'Execution not enabled yet');
    assert.equal(DO_POLICY.receiptMarksLineAgreed, false);
    assert.equal(DO_POLICY.approvalSingleUse, true);
    assert.equal(DO_POLICY.defaultRetryBudget, 0);
    assert.deepEqual([...DO_POLICY.approverSources], ['session']);
  });

  await test('no enqueue path: the server {do} code holds no Supabase client, mac_commands write or credential', () => {
    for (const file of ['server/do.ts', 'server/do-executor.ts', 'server/do-store.ts', 'server/do-report.ts', 'src/shared/do.ts']) {
      const text = readFileSync(path.join(process.cwd(), file), 'utf8');
      assert.doesNotMatch(text, /createClient|supabase-js|@supabase|SUPABASE_|service_role/i, `${file} mentions Supabase`);
      assert.doesNotMatch(text, /from\s+['"](node:)?(child_process|net|https?)['"]|fetch\(/, `${file} can reach out`);
      assert.doesNotMatch(text, /INSERT INTO mac_commands|\.from\(['"]mac_commands/, `${file} writes mac_commands`);
    }
    const store = readFileSync(path.join(process.cwd(), 'server/do-store.ts'), 'utf8');
    assert.doesNotMatch(store, /INSERT INTO document_do_runs/, 'nothing writes a run in this slice');
  });

  await test('NullExecutor refuses every request', async () => {
    const result = await executor.getDoExecutor().enqueue({
      slug: 's', doId: 'd', runId: 'r', attempt: 1, approvalId: 'a', digest: 'sha256:x', action: gdocAction(), presser: MIKE_ACTOR, idempotencyKey: 'proof:s:d:r1:a1',
    });
    assert.deepEqual(result, { ok: false, code: 'EXECUTION_NOT_ENABLED', error: 'No executor is installed: {do} execution is not enabled yet' });
    assert.equal(executor.getDoExecutor().name, 'null');
  });

  // ------------------------------------------------------------------ validator
  await test('actionErrors: the Pulse v1 validator, message for message', () => {
    assert.deepEqual(doMod.actionErrors(null, 0), ['actions[0] must be an object']);
    assert.deepEqual(doMod.actionErrors(gdocAction(), 0), []);
    const bad = doMod.actionErrors({ id: 'Bad Id', revision: 0, executor: 'shell', label: '', operation: '', params: [], completion: { mode: 'click' }, verification: {}, description: '' }, 2);
    assert.deepEqual(bad, [
      'actions[2].id must be a lowercase slug (letters, numbers, hyphens)',
      'actions[2].revision must be a positive integer',
      'actions[2].executor must be workflow, web, or mac',
      'actions[2].label is required',
      'actions[2].description must be a non-empty string when present',
      'actions[2].operation is required',
      'actions[2].params must be an object',
      'actions[2].completion.mode must be verified',
      'actions[2].completion.success_message is required',
      'actions[2].verification.kind is required',
    ]);
    const macGate = doMod.actionErrors({ ...gdocAction(), executor: 'mac', human_gate: { instruction: 'x', target: { url: 'http://x', ref: '9', label: '' } } }, 0);
    assert.ok(macGate.includes('actions[0].human_gate is only valid for workflow or web executors'));
    assert.ok(macGate.includes('actions[0].human_gate.target.url must be an absolute https URL'));
    assert.ok(macGate.includes('actions[0].human_gate.target.ref must name a Yeshie abstract target'));
    assert.ok(macGate.includes('actions[0].human_gate.target.label is required'));
  });

  await test('doActionErrors: only table operations; params are references, never secrets; gate and verification match the table', () => {
    assert.deepEqual(doMod.doActionErrors(gdocAction()), []);
    assert.match(doMod.doActionErrors(gdocAction({ operation: 'clipboard_take_and_deploy' })).join(), /not an allowed operation/);
    assert.match(doMod.doActionErrors(gdocAction({ executor: 'web' })).join(), /not an allowed operation/);
    assert.match(doMod.doActionErrors(gdocAction({ params: { project_id: 'p', account: 'sk-abcdefghijklmnopqrstuvwxyz' } })).join(), /looks like a credential/);
    assert.match(doMod.doActionErrors(gdocAction({ params: { project_id: 'p', account: 'a@b.c', api_key: 'x' } })).join(), /never secrets/);
    assert.match(doMod.doActionErrors(gdocAction({ params: { project_id: 'p; rm -rf /', account: 'a@b.c' } })).join(), /characters a param may not carry/);
    assert.match(doMod.doActionErrors(gdocAction({ params: { project_id: 'p' } })).join(), /requires action.params.account/);
    assert.match(doMod.doActionErrors(gdocAction({ verification: { kind: 'none' } })).join(), /requires verification.kind google_drive_about/);
    const noGate = gdocAction(); delete noGate.human_gate;
    assert.match(doMod.doActionErrors(noGate).join(), /requires action.human_gate/);
    const evilGate = gdocAction(); evilGate.human_gate.target.url = 'https://evil.example/consent';
    assert.match(doMod.doActionErrors(evilGate).join(), /must start with https:\/\/accounts.google.com\//);
    const otherRef = gdocAction(); otherRef.human_gate.target.ref = 'google.oauth.deny';
    assert.match(doMod.doActionErrors(otherRef).join(), /target.ref must be one of/);
  });

  await test('consequence text is the operation\'s own, never the author\'s', () => {
    const a = gdocAction({ label: 'Totally harmless', completion: { mode: 'verified', success_message: 'Everything is fine' } });
    const text = doMod.consequenceText(a);
    assert.match(text, /Opens Google’s consent page on Mike’s Mac/);
    assert.match(text, /soma-gdoc-bridge/);
    assert.match(text, /mw@mike-wolf\.com/);
    assert.doesNotMatch(text, /harmless|Everything is fine/);
    assert.equal(doMod.verifiedPredicateText(a), 'Google Drive answers an "about" request as mw@mike-wolf.com.');
    assert.equal(doMod.consequenceText(null), 'Unknown operation: this cannot run.');
  });

  // ------------------------------------------------------------------ digest
  await test('sha256Hex matches node:crypto (block boundaries, unicode)', () => {
    for (const text of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(119), 'Mike’s Mac — {do} ✓', JSON.stringify(gdocAction())]) {
      assert.equal(doMod.sha256Hex(text), createHash('sha256').update(text, 'utf8').digest('hex'), `length ${text.length}`);
    }
  });

  await test('digest: any change to operation, params, account, gate, verification, presser, retry budget, revision or line text changes it', () => {
    const r = record({}, lines[DO_LINE]);
    const baseDigest = doMod.actionDigest(r, lines[DO_LINE].hash, 'doc');
    assert.equal(doMod.actionDigest({ ...r }, lines[DO_LINE].hash, 'doc'), baseDigest, 'stable');
    const keyOrder = { ...r, action: { ...gdocAction(), params: { account: 'mw@mike-wolf.com', project_id: 'soma-gdoc-bridge' } } };
    assert.equal(doMod.actionDigest(keyOrder, lines[DO_LINE].hash, 'doc'), baseDigest, 'key order does not matter');
    const variants: Array<[string, ReturnType<typeof record>, string | null]> = [
      ['params', { ...r, action: gdocAction({ params: { project_id: 'other-project', account: 'mw@mike-wolf.com' } }) }, lines[DO_LINE].hash],
      ['account', { ...r, action: gdocAction({ params: { project_id: 'soma-gdoc-bridge', account: 'someone@else.com' } }) }, lines[DO_LINE].hash],
      ['gate', { ...r, action: { ...gdocAction(), human_gate: { ...gdocAction().human_gate, instruction: 'Click Allow twice' } } }, lines[DO_LINE].hash],
      ['verification', { ...r, action: gdocAction({ verification: { kind: 'google_drive_about', params: { strict: true } } }) }, lines[DO_LINE].hash],
      ['revision', { ...r, action: gdocAction({ revision: 2 }) }, lines[DO_LINE].hash],
      ['presser', { ...r, presser: ERIC_ACTOR }, lines[DO_LINE].hash],
      ['retryBudget', { ...r, retryBudget: 1 }, lines[DO_LINE].hash],
      ['line text', r, 'otherhash'],
      ['document', r, lines[DO_LINE].hash],
    ];
    for (const [name, variant, hash] of variants) {
      const digest = doMod.actionDigest(variant, hash, name === 'document' ? 'other-doc' : 'doc');
      assert.notEqual(digest, baseDigest, `${name} did not change the digest`);
    }
    const input = doMod.digestInput(r, lines[DO_LINE].hash, 'doc');
    assert.ok(input.includes(JSON.stringify(doMod.consequenceText(r.action))), 'the consequence text is bound');
    assert.ok(input.includes(JSON.stringify(doMod.verifiedPredicateText(r.action))), 'the verified predicate is bound');
  });

  // ------------------------------------------------------------------ state machine
  const approvalFor = (r: ReturnType<typeof record>, by = MIKE_ACTOR, at = iso(1), extra: Record<string, unknown> = {}) => ({
    id: `ap-${at}`, by, at, digest: doMod.actionDigest(r, lines[DO_LINE].hash, 'doc'), source: 'session', revokedAt: null, revokedBy: null, ...extra,
  });
  const run = (approvalId: string, digest: string, receipts: any[], attempt = 1, startedAt = iso(2)) => ({
    id: `run-${attempt}`, attempt, approvalId, digest, presser: MIKE_ACTOR, startedAt, receipts,
  });

  await test('states: proposed → approved; a changed action or line voids the approval (back to proposed)', () => {
    const r = record({}, lines[DO_LINE]);
    assert.equal(doMod.evaluateDo(r, lines, 'doc', T0).state, 'proposed');
    const approved = { ...r, approvals: [approvalFor(r)] };
    const view = doMod.evaluateDo(approved, lines, 'doc', T0);
    assert.equal(view.state, 'approved');
    assert.equal(view.approvalCurrent, true);
    const revised = { ...approved, action: gdocAction({ revision: 2 }) };
    const after = doMod.evaluateDo(revised, lines, 'doc', T0);
    assert.equal(after.state, 'proposed');
    assert.equal(after.approvalStale, true);
    const edited = lines.map(line => line.index === DO_LINE ? { ...line, text: `${line.text} now`, hash: 'edited' } : line);
    assert.equal(doMod.evaluateDo(approved, edited, 'doc', T0).state, 'proposed', 'a line edit voids it too');
    const revoked = { ...r, approvals: [approvalFor(r, MIKE_ACTOR, iso(1), { revokedAt: iso(3), revokedBy: MIKE_ACTOR })] };
    assert.equal(doMod.evaluateDo(revoked, lines, 'doc', T0).state, 'proposed');
    assert.equal(doMod.evaluateDo({ ...r, withdrawnAt: iso(4) }, lines, 'doc', T0).state, 'withdrawn');
  });

  await test('receipts: the bridge\'s row semantics (open + result.state, target_ready) map to states', () => {
    const d = 'sha256:run';
    const phase = (receipt: any) => doMod.receiptPhase({ at: iso(3), digest: d, ...receipt }, d);
    assert.equal(phase({ rowStatus: 'open' }), 'queued');
    assert.equal(phase({ rowStatus: 'open', state: 'queued' }), 'queued');
    assert.equal(phase({ rowStatus: 'open', state: 'running' }), 'running');
    assert.equal(phase({ rowStatus: 'open', state: 'waiting_human' }), 'running', 'not needs-finger until the control is on screen');
    assert.equal(phase({ rowStatus: 'open', state: 'waiting_human', targetReady: true }), 'needs-finger');
    assert.equal(phase({ rowStatus: 'open', state: 'verifying' }), 'verifying');
    assert.equal(phase({ rowStatus: 'done', verified: true }), 'done');
    assert.equal(phase({ rowStatus: 'done', verified: false }), 'failed');
    assert.equal(phase({ rowStatus: 'done' }), 'failed', 'done without verified=true is not done');
    assert.equal(doMod.receiptPhase({ at: iso(3), rowStatus: 'done', verified: true, digest: 'sha256:other' }, d), 'failed', 'a receipt for another digest certifies nothing');
    assert.equal(phase({ rowStatus: 'failed' }), 'failed');
    assert.equal(phase({ rowStatus: 'cancelled' }), 'stalled', 'an unknown row status is unknown, not failed');
    assert.equal(phase({ rowStatus: 'open', state: 'mystery' }), 'stalled');
  });

  await test('timeout: a quiet active run is stalled (unknown), never failed; a run waiting on a human does not stall', () => {
    const d = 'sha256:run';
    const running = run('a', d, [{ at: iso(3), rowStatus: 'open', state: 'running', digest: d }]);
    assert.equal(doMod.runPhase(running, T0 + 10 * 60_000), 'running');
    assert.equal(doMod.runPhase(running, T0 + 60 * 60_000), 'stalled');
    const queuedNoReceipt = run('a', d, [], 1, iso(0));
    assert.equal(doMod.runPhase(queuedNoReceipt, T0 + 16 * 60_000), 'stalled');
    const waiting = run('a', d, [{ at: iso(3), rowStatus: 'open', state: 'waiting_human', targetReady: true, digest: d }]);
    assert.equal(doMod.runPhase(waiting, T0 + 120 * 60_000), 'needs-finger');
    const done = run('a', d, [{ at: iso(3), rowStatus: 'done', verified: true, digest: d }]);
    assert.equal(doMod.runPhase(done, T0 + 999 * 60_000), 'done');
  });

  await test('a run in flight stays visible after its approval is revoked', () => {
    const r = record({}, lines[DO_LINE]);
    const ap = approvalFor(r, MIKE_ACTOR, iso(1), { revokedAt: iso(4), revokedBy: MIKE_ACTOR });
    const view = doMod.evaluateDo({ ...r, approvals: [ap], runs: [run(ap.id, ap.digest, [{ at: iso(3), rowStatus: 'open', state: 'running', digest: ap.digest }])] }, lines, 'doc', T0 + 5 * 60_000);
    assert.equal(view.state, 'running');
  });

  // ------------------------------------------------------------------ run authorization
  await test('authorizeRun: refuses while execution is disabled, whatever else is true', () => {
    const r = record({}, lines[DO_LINE]);
    const view = doMod.evaluateDo({ ...r, approvals: [approvalFor(r)] }, lines, 'doc', T0);
    const refused = doMod.authorizeRun(view, { presser: MIKE_ACTOR, source: 'session', now: T0 });
    assert.equal(refused.ok, false);
    assert.equal((refused as any).code, 'EXECUTION_NOT_ENABLED');
  });

  await test('authorizeRun (switch on in the test only): identity, approval, digest, presser, Mac principal', () => {
    const r = record({}, lines[DO_LINE]);
    const code = (rec: any, presser: string, source = 'session') => {
      const result = doMod.authorizeRun(doMod.evaluateDo(rec, lines, 'doc', T0), { presser, source, now: T0, policy: ENABLED });
      return result.ok ? 'OK' : (result as any).code;
    };
    assert.equal(code(r, MIKE_ACTOR), 'APPROVAL_REQUIRED');
    const approved = { ...r, approvals: [approvalFor(r)] };
    assert.equal(code(approved, MIKE_ACTOR), 'OK');
    for (const [presser, source] of [['guest:Mike Wolf', 'guest'], ['ai:claude-cos', 'agent-key'], ['ai:claude', 'share-token'], [MIKE_ACTOR, 'owner-credential'], [MIKE_ACTOR, 'agent-key']]) {
      assert.equal(code(approved, presser, source), 'SIGNED_IN_PERSON_REQUIRED', `${presser} via ${source}`);
    }
    assert.equal(code({ ...r, approvals: [approvalFor(r, MIKE_ACTOR, iso(1), { revokedAt: iso(2), revokedBy: MIKE_ACTOR })] }, MIKE_ACTOR), 'APPROVAL_REVOKED');
    assert.equal(code({ ...approved, action: gdocAction({ params: { project_id: 'soma-gdoc-bridge', account: 'attacker@evil.example' } }) }, MIKE_ACTOR), 'APPROVAL_STALE');
    assert.equal(code(approved, ERIC_ACTOR), 'PRESSER_NOT_PERMITTED', 'only the approver presses by default');
    const ericApproved = { ...r, to: [MIKE_ACTOR, ERIC_ACTOR], approvals: [approvalFor({ ...r, to: [MIKE_ACTOR, ERIC_ACTOR] }, ERIC_ACTOR)] };
    assert.equal(code(ericApproved, ERIC_ACTOR), 'MAC_PRINCIPAL_REQUIRED', 'document authority is not Mac authority');
  });

  await test('authorizeRun: single use; a stalled run blocks (unknown effect); a failed one needs a retry budget', () => {
    const r = record({}, lines[DO_LINE]);
    const ap = approvalFor(r);
    const code = (rec: any) => { const res = doMod.authorizeRun(doMod.evaluateDo(rec, lines, 'doc', T0 + 30 * 60_000), { presser: MIKE_ACTOR, source: 'session', now: T0 + 30 * 60_000, policy: ENABLED }); return res.ok ? `OK:${res.attempt}` : (res as any).code; };
    const failed = run(ap.id, ap.digest, [{ at: iso(3), rowStatus: 'failed', digest: ap.digest }]);
    assert.equal(code({ ...r, approvals: [ap], runs: [failed] }), 'APPROVAL_USED', 'single use');
    assert.equal(doMod.evaluateDo({ ...r, approvals: [ap], runs: [failed] }, lines, 'doc', T0 + 30 * 60_000).state, 'failed');
    const r1 = { ...r, retryBudget: 1 };
    const ap1 = approvalFor(r1);
    assert.equal(code({ ...r1, approvals: [ap1], runs: [run(ap1.id, ap1.digest, [{ at: iso(3), rowStatus: 'failed', digest: ap1.digest }])] }), 'OK:2', 'one retry allowed');
    const stalled = run(ap1.id, ap1.digest, [{ at: iso(3), rowStatus: 'open', state: 'running', digest: ap1.digest }]);
    assert.equal(code({ ...r1, approvals: [ap1], runs: [stalled] }), 'RUN_UNRESOLVED', 'a stalled run blocks a retry');
    assert.equal(doMod.evaluateDo({ ...r1, approvals: [ap1], runs: [stalled] }, lines, 'doc', T0 + 30 * 60_000).state, 'stalled');
    const active = run(ap1.id, ap1.digest, [{ at: iso(25), rowStatus: 'open', state: 'running', digest: ap1.digest }]);
    assert.equal(code({ ...r1, approvals: [ap1], runs: [active] }), 'RUN_ACTIVE');
    const done = run(ap.id, ap.digest, [{ at: iso(3), rowStatus: 'done', verified: true, digest: ap.digest }]);
    assert.equal(code({ ...r, approvals: [ap], runs: [done] }), 'ALREADY_DONE');
  });

  await test('checkApprover: only a signed-in person named in "to" with Owner rights', () => {
    const view = doMod.evaluateDo(record({}, lines[DO_LINE]), lines, 'doc', T0);
    const code = (actor: string, source: string, isOwner = true) => { const r = doMod.checkApprover(view, { actor, source, isOwner }); return r.ok ? 'OK' : (r as any).code; };
    assert.equal(code(MIKE_ACTOR, 'session'), 'OK');
    assert.equal(code(MIKE_ACTOR, 'owner-credential'), 'SIGNED_IN_PERSON_REQUIRED');
    assert.equal(code(MIKE_ACTOR, 'agent-key'), 'SIGNED_IN_PERSON_REQUIRED');
    assert.equal(code(MIKE_ACTOR, 'share-token'), 'SIGNED_IN_PERSON_REQUIRED');
    assert.equal(code('guest:mw@mike-wolf.com', 'session'), 'SIGNED_IN_PERSON_REQUIRED');
    assert.equal(code('ai:claude-cos', 'session'), 'SIGNED_IN_PERSON_REQUIRED');
    assert.equal(code(ERIC_ACTOR, 'session'), 'NOT_AN_APPROVER');
    assert.equal(code(MIKE_ACTOR, 'session', false), 'OWNER_REQUIRED');
  });

  // ------------------------------------------------------------------ Issues
  await test('Issues: an unfinished {do} is an Issue of type "do"; priority by state; done is not an Issue', () => {
    const r = record({}, lines[DO_LINE]);
    const summary = (rec: any, now = T0) => shared.computeIssues({
      lines, lineMarks: [], team: [MIKE_ACTOR], dos: doMod.doIssueInputs(doMod.evaluateDos([rec], lines, 'doc', now)),
    });
    const proposed = summary(r);
    const issue = proposed.issues.find(i => i.type === 'do') as any;
    assert.ok(issue, 'no do Issue');
    assert.equal(issue.doId, 'do-1');
    assert.equal(issue.state, 'proposed');
    assert.equal(proposed.counts.doIssues, 1);
    assert.equal(aids.priorityRule(issue, MIKE_ACTOR), 'do-approve');
    assert.equal(aids.ISSUE_PRIORITY.byRule['do-approve'], 2);
    assert.equal(aids.priorityRule(issue, ERIC_ACTOR), 'waiting-on-others');
    const approved = summary({ ...r, approvals: [approvalFor(r)] });
    const approvedIssue = approved.issues.find(i => i.type === 'do') as any;
    assert.equal(approvedIssue.state, 'approved', 'approved but not run is still unfinished');
    assert.equal(aids.priorityRule(approvedIssue, MIKE_ACTOR), 'waiting-on-others', 'waits on execution being enabled, not on Mike');
    const ap = approvalFor(r);
    const failed = summary({ ...r, approvals: [ap], runs: [run(ap.id, ap.digest, [{ at: iso(3), rowStatus: 'failed', digest: ap.digest }])] }, T0 + 5 * 60_000);
    assert.equal(aids.priorityRule(failed.issues.find(i => i.type === 'do') as any, MIKE_ACTOR), 'do-failed');
    const done = summary({ ...r, approvals: [ap], runs: [run(ap.id, ap.digest, [{ at: iso(3), rowStatus: 'done', verified: true, digest: ap.digest }])] }, T0 + 5 * 60_000);
    assert.equal(done.counts.doIssues, 0);
    const ranked = aids.rankIssues(proposed.issues, { viewer: MIKE_ACTOR });
    const lineIssue = ranked.findIndex(x => x.issue.type === 'line');
    const doIssue = ranked.findIndex(x => x.issue.type === 'do');
    assert.ok(doIssue < lineIssue, 'the approval comes before unseen lines in the priority order');
  });

  await test('receipts never create agreement: a verified run leaves every line mark as it was', () => {
    const r = record({}, lines[DO_LINE]);
    const ap = approvalFor(r);
    const marks: any[] = [];
    const before = JSON.stringify(marks);
    const rec = { ...r, approvals: [ap], runs: [run(ap.id, ap.digest, [{ at: iso(3), rowStatus: 'done', verified: true, digest: ap.digest }])] };
    const view = doMod.evaluateDo(rec, lines, 'doc', T0 + 5 * 60_000);
    assert.equal(view.state, 'done');
    const summary = shared.computeIssues({ lines, lineMarks: marks, team: [MIKE_ACTOR], dos: doMod.doIssueInputs([view]) });
    assert.equal(JSON.stringify(marks), before);
    const lineIssue = summary.issues.find(i => i.type === 'line' && i.lineIndex === DO_LINE) as any;
    assert.ok(lineIssue && lineIssue.unseenBy.includes(MIKE_ACTOR), 'the line is still unseen by Mike: done is not agreed');
  });

  // ------------------------------------------------------------------ HTTP
  const mike = auth.createLibraryMember({ name: 'Mike Wolf', email: 'mw@mike-wolf.com' });
  const eric = auth.createLibraryMember({ name: 'Eric', email: 'eric@example.test' });
  const sessionCookie = (memberId: string) => {
    const link = auth.createLibrarySigninLink({ memberId, purpose: 'operator', origin: base });
    const signedIn = auth.consumeLibrarySigninToken(new URL(link.link).hash.slice(3), null)!;
    return `${auth.LIBRARY_SESSION_COOKIE}=${encodeURIComponent(signedIn.sessionId)}`;
  };
  const MIKE = { Cookie: sessionCookie(mike.id) };
  const ERIC = { Cookie: sessionCookie(eric.id) };
  const ORIGIN = { Origin: base };
  const slug = 'do-test';
  db.createDocument(slug, doc, {}, 'Do test', 'owner-1', 'owner-secret-do');
  db.getDb().prepare(`INSERT INTO library_document_meta (slug, created_by_member_id) VALUES (?, ?)`).run(slug, mike.id);
  const key = db.createDocumentAccessToken(slug, 'editor', undefined, { label: 'Claude (COS)', requestedBy: 'test', requestedFrom: '127.0.0.1' });
  const KEY = { 'x-share-token': key.secret };
  const OWNER = { 'x-share-token': 'owner-secret-do' };
  let doId = '';
  let digest = '';

  await test('agent: an AI proposes a {do}; to defaults to the signed-in owner; bad actions and approvers are refused', async () => {
    const unknown = await call(`/api/agent/${slug}/dos`, 'POST', { quote: 'Authorize the Google Docs', action: gdocAction({ operation: 'clipboard_take_and_deploy' }) }, KEY);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.code, 'INVALID_ACTION');
    const secret = await call(`/api/agent/${slug}/dos`, 'POST', { quote: 'Authorize the Google Docs', action: gdocAction({ params: { project_id: 'p', account: 'ghp_abcdefghijklmnopqrstuvwxyz0123' } }) }, KEY);
    assert.equal(secret.status, 400);
    const guestTo = await call(`/api/agent/${slug}/dos`, 'POST', { quote: 'Authorize the Google Docs', to: ['Mike'], action: gdocAction() }, KEY);
    assert.equal(guestTo.status, 400);
    assert.equal(guestTo.body.code, 'APPROVER_MUST_BE_VERIFIED');
    const aiTo = await call(`/api/agent/${slug}/dos`, 'POST', { quote: 'Authorize the Google Docs', to: ['ai:claude-cos'], action: gdocAction() }, KEY);
    assert.equal(aiTo.body.code, 'APPROVER_MUST_BE_VERIFIED');
    const created = await call(`/api/agent/${slug}/dos`, 'POST', { quote: 'Authorize the Google Docs', action: gdocAction() }, KEY);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    doId = created.body.do.id;
    digest = created.body.do.digest;
    assert.equal(created.body.do.by, 'ai:claude-cos');
    assert.deepEqual(created.body.do.to, [MIKE_ACTOR]);
    assert.equal(created.body.do.state, 'proposed');
    assert.equal(created.body.do.executionEnabled, false);
    assert.match(created.body.do.consequence, /Opens Google’s consent page/);
    assert.match(digest, /^sha256:[0-9a-f]{64}$/);
    const again = await call(`/api/agent/${slug}/dos`, 'POST', { quote: 'Authorize the Google Docs', action: gdocAction() }, KEY);
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'DO_EXISTS');
  });

  await test('/state and GET /dos: the {do} is an Issue (type do) and listed with its state', async () => {
    const state = await call(`/api/agent/${slug}/state`, 'GET', undefined, KEY);
    assert.equal(state.status, 200);
    assert.equal(state.body.dos.length, 1);
    assert.equal(state.body.dos[0].state, 'proposed');
    const issue = state.body.issues.issues?.find?.((i: any) => i.type === 'do') ?? (state.body.issues as any[]).find?.((i: any) => i.type === 'do');
    assert.ok(issue, `no do Issue in ${JSON.stringify(state.body.issues).slice(0, 300)}`);
    assert.equal(state.body.alignment.counts.doIssues, 1);
    assert.equal(state.body._links.dos.href, `/api/agent/${slug}/dos`);
    const list = await call(`/api/agent/${slug}/dos`, 'GET', undefined, KEY);
    assert.equal(list.body.dos[0].id, doId);
    assert.equal(list.body.policy.executionEnabled, false);
    assert.equal(list.body.policy.macPrincipals, undefined, 'the Mac principals are not published');
    const poll = await call(`/api/documents/${slug}/line-marks`, 'GET', undefined, MIKE);
    assert.equal(poll.body.dos.length, 1);
    assert.equal(poll.body.doPolicy.executionEnabled, false);
  });

  const approve = (headers: Record<string, string>, body: Record<string, unknown> = { digest }) => call(`/api/documents/${slug}/dos/${doId}/approve`, 'POST', body, headers);

  await test('approve: guests, forged cookies, agent keys, share tokens and the owner credential are refused', async () => {
    // An agent key naming someone else is refused as ACTOR_MISMATCH before anything else; either way 403.
    const cases: Array<[string, Record<string, string>, string]> = [
      // Invite person (2026-09-19): under the default guest setting a guest is refused earlier.
      ['guest', { ...ORIGIN }, 'SIGNED_IN_PERSON_REQUIRED|SIGN_IN_TO_MARK'],
      ['guest typing Mike\'s email', { ...ORIGIN }, 'SIGNED_IN_PERSON_REQUIRED|SIGN_IN_TO_MARK'],
      ['forged session cookie', { ...ORIGIN, Cookie: `${auth.LIBRARY_SESSION_COOKIE}=forged-session-value` }, 'SIGNED_IN_PERSON_REQUIRED|SIGN_IN_TO_MARK'],
      ['agent key', { ...ORIGIN, ...KEY }, 'SIGNED_IN_PERSON_REQUIRED|ACTOR_MISMATCH'],
      ['agent key with Mike\'s cookie', { ...ORIGIN, ...KEY, ...MIKE }, 'SIGNED_IN_PERSON_REQUIRED|ACTOR_MISMATCH'],
      ['owner credential (script)', { ...ORIGIN, ...OWNER }, 'SIGNED_IN_PERSON_REQUIRED'],
    ];
    for (const [name, headers, want] of cases) {
      const r = await approve(headers, { digest, by: MIKE_ACTOR });
      assert.equal(r.status, 403, `${name}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.code, new RegExp(`^(${want})$`), name);
      const bare = await approve(headers, { digest });
      assert.ok(bare.status === 403 || bare.status === 400, `${name} without "by": ${JSON.stringify(bare.body)}`);
      assert.match(bare.body.code, /^(SIGNED_IN_PERSON_REQUIRED|INVALID_ACTOR|SIGN_IN_TO_MARK)$/, `${name} without "by"`);
    }
    const agentApi = await call(`/api/agent/${slug}/dos/${doId}/approve`, 'POST', { by: MIKE_ACTOR }, OWNER);
    assert.equal(agentApi.status, 403);
    assert.equal(agentApi.body.code, 'SIGNED_IN_PERSON_REQUIRED');
    const viaKeyApi = await call(`/api/agent/${slug}/dos/${doId}/approve`, 'POST', {}, KEY);
    assert.equal(viaKeyApi.status, 403);
  });

  await test('approve: CSRF — Mike\'s session without Origin, from another origin, cross-site or not JSON is refused', async () => {
    const noOrigin = await approve({ ...MIKE });
    assert.equal(noOrigin.status, 403);
    assert.equal(noOrigin.body.code, 'SAME_ORIGIN_REQUIRED');
    const evil = await approve({ ...MIKE, Origin: 'https://evil.example' });
    assert.equal(evil.body.code, 'SAME_ORIGIN_REQUIRED');
    const crossSite = await approve({ ...MIKE, ...ORIGIN, 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(crossSite.body.code, 'SAME_ORIGIN_REQUIRED');
    const form = await fetch(`${base}/api/documents/${slug}/dos/${doId}/approve`, {
      method: 'POST', headers: { ...MIKE, ...ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `digest=${encodeURIComponent(digest)}`,
    });
    assert.equal(form.status, 415);
  });

  await test('approve: a signed-in person not named, or named without Owner rights, is refused; a stale digest is refused', async () => {
    const eric1 = await approve({ ...ERIC, ...ORIGIN });
    assert.equal(eric1.status, 403);
    assert.equal(eric1.body.code, 'NOT_AN_APPROVER');
    const revise = await call(`/api/agent/${slug}/dos/${doId}/revise`, 'POST', { to: [MIKE_ACTOR, ERIC_ACTOR] }, KEY);
    assert.equal(revise.status, 200, JSON.stringify(revise.body));
    digest = revise.body.do.digest;
    const eric2 = await approve({ ...ERIC, ...ORIGIN });
    assert.equal(eric2.status, 403);
    assert.equal(eric2.body.code, 'OWNER_REQUIRED');
    const stale = await approve({ ...MIKE, ...ORIGIN }, { digest: 'sha256:0000' });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'DIGEST_MISMATCH');
  });

  await test('approve: Mike, signed in, from this site, approves; nothing is queued, no line mark is written', async () => {
    const marksBefore = db.getDb().prepare(`SELECT COUNT(*) AS n FROM document_line_marks WHERE document_slug = ?`).get(slug) as { n: number };
    const ok = await approve({ ...MIKE, ...ORIGIN, 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.queued, false);
    assert.equal(ok.body.do.state, 'approved');
    assert.equal(ok.body.do.approval.by, MIKE_ACTOR);
    assert.equal(ok.body.do.approval.source, 'session');
    assert.equal(ok.body.do.approval.digest, digest);
    const marksAfter = db.getDb().prepare(`SELECT COUNT(*) AS n FROM document_line_marks WHERE document_slug = ?`).get(slug) as { n: number };
    assert.equal(marksAfter.n, marksBefore.n, 'approval is not agreement');
    const runs = db.getDb().prepare(`SELECT COUNT(*) AS n FROM document_do_runs`).get() as { n: number };
    assert.equal(runs.n, 0);
    const twice = await approve({ ...MIKE, ...ORIGIN });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.code, 'ALREADY_APPROVED');
    const events = await call(`/api/agent/${slug}/events/pending?after=0`, 'GET', undefined, KEY);
    const approved = events.body.events.filter((e: any) => e.type === 'do.approved');
    assert.equal(approved.length, 1);
    assert.equal(approved[0].actor, MIKE_ACTOR);
    assert.equal(approved[0].data.executionEnabled, false);
  });

  await test('run: refused for everyone (409 EXECUTION_NOT_ENABLED), on the page and on the agent API', async () => {
    const page = await call(`/api/documents/${slug}/dos/${doId}/run`, 'POST', {}, { ...MIKE, ...ORIGIN });
    assert.equal(page.status, 409);
    assert.equal(page.body.code, 'EXECUTION_NOT_ENABLED');
    const agent = await call(`/api/agent/${slug}/dos/${doId}/run`, 'POST', {}, KEY);
    assert.equal(agent.status, 409);
    assert.equal(agent.body.code, 'EXECUTION_NOT_ENABLED');
    const ownerRun = await call(`/api/agent/${slug}/dos/${doId}/run`, 'POST', { by: MIKE_ACTOR }, OWNER);
    assert.equal(ownerRun.body.code, 'EXECUTION_NOT_ENABLED');
    const runs = db.getDb().prepare(`SELECT COUNT(*) AS n FROM document_do_runs`).get() as { n: number };
    assert.equal(runs.n, 0);
  });

  await test('revise: a new action revision voids the approval (back to an Issue for Mike)', async () => {
    const lower = await call(`/api/agent/${slug}/dos/${doId}/revise`, 'POST', { action: gdocAction({ revision: 1, params: { project_id: 'x', account: 'mw@mike-wolf.com' } }) }, KEY);
    assert.equal(lower.status, 409);
    assert.equal(lower.body.code, 'REVISION_REQUIRED');
    const revised = await call(`/api/agent/${slug}/dos/${doId}/revise`, 'POST', { action: gdocAction({ revision: 2, params: { project_id: 'soma-gdoc-bridge-2', account: 'mw@mike-wolf.com' } }) }, KEY);
    assert.equal(revised.status, 200, JSON.stringify(revised.body));
    assert.equal(revised.body.do.state, 'proposed');
    assert.equal(revised.body.do.approval.current, false);
    assert.notEqual(revised.body.do.digest, digest);
    const oldDigest = await approve({ ...MIKE, ...ORIGIN });
    assert.equal(oldDigest.body.code, 'DIGEST_MISMATCH', 'the page must show the new action before Mike can approve it');
    digest = revised.body.do.digest;
    const state = await call(`/api/agent/${slug}/state`, 'GET', undefined, KEY);
    assert.equal(state.body.alignment.counts.doIssues, 1);
  });

  await test('revoke: the approver revokes; the audit trail keeps the approval; an unrelated AI cannot revoke', async () => {
    const ok = await approve({ ...MIKE, ...ORIGIN });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const other = db.createDocumentAccessToken(slug, 'editor', undefined, { label: 'Other AI', requestedBy: 'test', requestedFrom: '127.0.0.1' });
    const stranger = await call(`/api/agent/${slug}/dos/${doId}/revoke`, 'POST', {}, { 'x-share-token': other.secret });
    assert.equal(stranger.status, 403);
    const revoked = await call(`/api/documents/${slug}/dos/${doId}/revoke`, 'POST', {}, { ...MIKE, ...ORIGIN });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(revoked.body.do.state, 'proposed');
    const list = await call(`/api/agent/${slug}/dos`, 'GET', undefined, KEY);
    const approvals = list.body.dos[0].approvals;
    assert.ok(approvals.length >= 2 && approvals.every((a: any) => a.revokedAt), 'every approval is kept, revoked');
    const guestRevoke = await call(`/api/documents/${slug}/dos/${doId}/revoke`, 'POST', {}, { ...ORIGIN });
    assert.equal(guestRevoke.status, 403);
  });

  await test('guests cannot propose (owner credential naming a guest)', async () => {
    const r = await call(`/api/agent/${slug}/dos`, 'POST', { quote: 'Plain line after it', by: 'guest:Ada', action: gdocAction() }, OWNER);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.code, 'GUEST_CANNOT_PROPOSE');
  });

  await test('withdraw: the proposer withdraws; it is no longer an Issue', async () => {
    const gone = await call(`/api/agent/${slug}/dos/${doId}`, 'DELETE', {}, KEY);
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    const state = await call(`/api/agent/${slug}/state`, 'GET', undefined, KEY);
    assert.equal(state.body.dos.length, 0);
    assert.equal(state.body.alignment.counts.doIssues, 0);
  });

  console.log(`\n${passed} {do} tests passed`);
} finally {
  server.close();
  rmSync(temp, { recursive: true, force: true });
}
process.exit(0);
