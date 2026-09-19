// Proof Documents Step B6: marks and answers name a verified person or a named AI.
// Authorship: Claude Opus 5 (worker proof-identity), 2026-09-18.
// Pure identity rules, then the HTTP routes with real Documents library sessions (the cookie
// proof_library_session, created the way a sign-in link creates it).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-identity-'));
process.env.DATABASE_PATH = path.join(temp, 'test.db');
Object.assign(process.env, { PROOF_ENV: 'test', PROOF_DB_ENV_INIT: 'test', PROOF_LIBRARY_ENABLED: '1' });
delete process.env.PROOF_SOMA_AUTH_ENABLED;
delete process.env.PROOF_PUBLIC_ORIGIN;

const shared = await import('../shared/line-marks');
const identity = await import('../shared/identity');
const asks = await import('../shared/asks');
const serverIdentity = await import('../../server/identity');
const serverLines = await import('../../server/line-marks');
const db = await import('../../server/db');
const auth = await import('../../server/library/auth');
const { apiRoutes } = await import('../../server/routes');
const { agentRoutes } = await import('../../server/agent-routes');

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

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

const doc = `# Identity

Ship identity tonight?

Retire typed names?

Ada's question?

Anyone's question?

Last line.`;

try {
  // ------------------------------------------------------------------ pure rules
  await test('actors: typed human names read as guests; emails are verified; ai stays ai', () => {
    assert.equal(identity.normalizeActorString('human:Mike'), 'guest:Mike');
    assert.equal(identity.normalizeActorString('Mike Wolf'), 'guest:Mike Wolf');
    assert.equal(identity.normalizeActorString('human:MW@Mike-Wolf.com'), 'human:mw@mike-wolf.com');
    assert.equal(identity.normalizeActorString('mw@mike-wolf.com'), 'human:mw@mike-wolf.com');
    assert.equal(identity.normalizeActorString('ai:Claude'), 'ai:Claude');
    assert.equal(identity.actorTrust('human:mw@mike-wolf.com'), 'verified');
    assert.equal(identity.actorTrust('human:Mike'), 'guest');
    assert.equal(identity.actorTrust('guest:Ada'), 'guest');
    assert.equal(identity.guestActor('human:mw@mike-wolf.com'), 'guest:mw@mike-wolf.com', 'a guest typing an email stays a guest');
  });

  await test('labels: guests carry a visible (guest) suffix; verified people show their profile name', () => {
    shared.registerActorLabels({ 'human:mw@mike-wolf.com': 'Mike Wolf' });
    assert.equal(shared.actorLabel('human:mw@mike-wolf.com'), 'Mike Wolf');
    assert.equal(shared.actorLabel('guest:Ada'), 'Ada (guest)');
    assert.equal(shared.actorLabel('human:Mike'), 'Mike (guest)', 'an old typed-name row is unverified');
    assert.equal(shared.actorLabel('ai:claude-cos'), 'claude-cos');
  });

  const dir: import('../shared/identity').IdentityDirectory = {
    merges: { 'guest:mike': { into: 'human:mw@mike-wolf.com', before: '2026-09-18T12:00:00.000Z' } },
    names: { 'mike wolf': 'human:mw@mike-wolf.com', 'mw@mike-wolf.com': 'human:mw@mike-wolf.com', 'sam': '' },
    labels: { 'human:mw@mike-wolf.com': 'Mike Wolf' },
  };

  await test('merges: apply to what the typed name wrote up to the merge, never after', () => {
    assert.equal(identity.canonicalActor('human:Mike', dir, '2026-09-18T11:00:00.000Z'), 'human:mw@mike-wolf.com');
    assert.equal(identity.canonicalActor('guest:Mike', dir, '2026-09-18T13:00:00.000Z'), 'guest:Mike', 'a later guest "Mike" is still a guest');
    assert.equal(identity.canonicalActor('guest:Mike Wolf', dir, '2026-09-18T11:00:00.000Z'), 'guest:Mike Wolf', 'a name is never merged by itself');
  });

  await test('targets: a member\'s name or email means that verified person; other names mean the guest who types them', () => {
    assert.equal(identity.resolveTargetActor('human:Mike Wolf', dir), 'human:mw@mike-wolf.com');
    assert.equal(identity.resolveTargetActor('mw@mike-wolf.com', dir), 'human:mw@mike-wolf.com');
    assert.equal(identity.resolveTargetActor('human:Ada', dir), 'guest:Ada');
    assert.equal(identity.resolveTargetActor('human:Sam', dir), 'human:Sam', 'a name two members share matches nobody');
    assert.equal(identity.resolveTargetActor('ai:critic', dir), 'ai:critic');
  });

  await test('decideActor: agent key > session > owner credential > share token > guest; "by" never raises trust', () => {
    const key = serverIdentity.decideActor({ mode: 'page', typedBy: undefined, agentKeyLabel: 'Claude (COS)' });
    assert.deepEqual(key, { ok: true, actor: 'ai:claude-cos', trust: 'ai', source: 'agent-key' });
    const keyAsHuman = serverIdentity.decideActor({ mode: 'agent', typedBy: 'human:mw@mike-wolf.com', agentKeyLabel: 'Claude (COS)' });
    assert.equal(keyAsHuman.ok, false);
    assert.equal((keyAsHuman as any).body.code, 'ACTOR_MISMATCH');
    const session = { memberId: 'm1', name: 'Mike Wolf', email: 'MW@mike-wolf.com' };
    const signedIn = serverIdentity.decideActor({ mode: 'page', typedBy: 'human:Eric', session, sessionOriginOk: true });
    assert.deepEqual(signedIn, { ok: true, actor: 'human:mw@mike-wolf.com', trust: 'verified', source: 'session' });
    const crossSite = serverIdentity.decideActor({ mode: 'page', typedBy: '', session, sessionOriginOk: false });
    assert.equal((crossSite as any).body.code, 'CROSS_ORIGIN');
    const owner = serverIdentity.decideActor({ mode: 'agent', typedBy: 'human:mw@mike-wolf.com', ownerCredential: true });
    assert.equal((owner as any).actor, 'human:mw@mike-wolf.com', 'the owner credential (scripts) may name a verified person');
    const token = serverIdentity.decideActor({ mode: 'agent', typedBy: 'ai:claude-cos', activeKeyActors: ['ai:claude-cos'] });
    assert.equal((token as any).body.code, 'ACTOR_RESERVED', 'a share token cannot pose as a key\'s AI');
    const tokenHuman = serverIdentity.decideActor({ mode: 'agent', typedBy: 'human:mw@mike-wolf.com' });
    assert.equal((tokenHuman as any).body.code, 'AI_ACTOR_REQUIRED');
    const guest = serverIdentity.decideActor({ mode: 'page', typedBy: 'human:mw@mike-wolf.com' });
    assert.deepEqual(guest, { ok: true, actor: 'guest:mw@mike-wolf.com', trust: 'guest', source: 'guest' });
  });

  // ------------------------------------------------------------------ HTTP
  const mike = auth.createLibraryMember({ name: 'Mike Wolf', email: 'mw@mike-wolf.com' });
  const eric = auth.createLibraryMember({ name: 'Eric', email: 'eric@example.test' });
  auth.createLibraryMember({ name: 'Zed Private', email: 'zed@example.test' });
  const sessionCookie = (memberId: string) => {
    const link = auth.createLibrarySigninLink({ memberId, purpose: 'operator', origin: base });
    const signedIn = auth.consumeLibrarySigninToken(new URL(link.link).hash.slice(3), null)!;
    return `${auth.LIBRARY_SESSION_COOKIE}=${encodeURIComponent(signedIn.sessionId)}`;
  };
  const MIKE = { Cookie: sessionCookie(mike.id) };
  const ERIC = { Cookie: sessionCookie(eric.id) };
  const slug = 'id-test';
  db.createDocument(slug, doc, {}, 'Identity test', 'owner-1', 'owner-secret-id');
  db.getDb().prepare(`INSERT INTO library_document_meta (slug, created_by_member_id) VALUES (?, ?)`).run(slug, mike.id);
  const key = db.createDocumentAccessToken(slug, 'editor', undefined, { label: 'Claude (COS)', requestedBy: 'test', requestedFrom: '127.0.0.1' });
  const KEY = { 'x-share-token': key.secret };
  const lines = await serverLines.computeServerLines(doc);
  const anchor = (i: number) => shared.anchorForLine(lines[i]);

  await test('owner: the creator is the owner as a verified person', () => {
    assert.deepEqual(serverLines.documentOwnerActors(slug), ['human:mw@mike-wolf.com']);
  });

  await test('page: a signed-in mark is attributed to the email, whatever "by" says', async () => {
    const set = await call(`/api/documents/${slug}/line-marks`, 'POST', { by: 'human:Eric', status: 'agreed', anchor: anchor(1) }, MIKE);
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.lineMark.by, 'human:mw@mike-wolf.com');
    assert.equal(set.body.trust, 'verified');
    const list = await call(`/api/documents/${slug}/line-marks`, 'GET', undefined, MIKE);
    assert.equal(list.body.identity.me.actor, 'human:mw@mike-wolf.com');
    assert.equal(list.body.identity.me.name, 'Mike Wolf');
    assert.equal(list.body.identity.me.trust, 'verified');
    assert.equal(list.body.identity.directory.labels['human:mw@mike-wolf.com'], 'Mike Wolf');
    assert.equal(list.body.viewer.canApprove, true, 'the creator may approve');
  });

  await test('page: a guest mark is guest:<typed name>; typing an email or "human:" does not verify it', async () => {
    const spoof = await call(`/api/documents/${slug}/line-marks`, 'POST', { by: 'human:mw@mike-wolf.com', status: 'agreed', anchor: anchor(2) });
    assert.equal(spoof.status, 200);
    assert.equal(spoof.body.lineMark.by, 'guest:mw@mike-wolf.com');
    assert.equal(spoof.body.trust, 'guest');
    const forged = await call(`/api/documents/${slug}/line-marks`, 'POST', { by: 'Mike Wolf', status: 'seen', anchor: anchor(2) }, { Cookie: `${auth.LIBRARY_SESSION_COOKIE}=forged-session-value` });
    assert.equal(forged.body.lineMark.by, 'guest:Mike Wolf', 'a forged cookie is no session');
    const guestView = await call(`/api/documents/${slug}/line-marks`);
    assert.equal(guestView.body.identity.me.trust, 'guest');
    assert.equal(guestView.body.identity.me.signInUrl, '/');
    assert.equal(guestView.body.viewer.canApprove, false);
    const approve = await call(`/api/documents/${slug}/line-marks`, 'POST', { by: 'human:mw@mike-wolf.com', status: 'approved', anchor: anchor(2) });
    assert.equal(approve.status, 403, 'a guest typing the owner\'s email cannot approve');
    const json = JSON.stringify(guestView.body);
    assert.ok(!json.includes('zed@example.test') && !json.includes('Zed Private'), 'members with no part in the document are not sent to viewers');
  });

  await test('page: a signed-in write from another origin is refused; same origin is accepted', async () => {
    const evil = await call(`/api/documents/${slug}/line-marks`, 'POST', { status: 'seen', anchor: anchor(3) }, { ...ERIC, Origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    assert.equal(evil.body.code, 'CROSS_ORIGIN');
    const same = await call(`/api/documents/${slug}/line-marks`, 'POST', { status: 'seen', anchor: anchor(3) }, { ...ERIC, Origin: base });
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.equal(same.body.lineMark.by, 'human:eric@example.test');
    const notOwner = await call(`/api/documents/${slug}/line-marks`, 'POST', { status: 'approved', anchor: anchor(3) }, ERIC);
    assert.equal(notOwner.status, 403, 'a member who did not create the document is not an owner');
  });

  await test('agent key: marks as its own AI and cannot mark as a human, on the agent API or the page API', async () => {
    const asHuman = await call(`/api/agent/${slug}/marks/line`, 'POST', { lineIndex: 1, status: 'seen', by: 'human:mw@mike-wolf.com' }, KEY);
    assert.equal(asHuman.status, 403);
    assert.equal(asHuman.body.code, 'ACTOR_MISMATCH');
    const pageAsHuman = await call(`/api/documents/${slug}/line-marks`, 'POST', { by: 'human:mw@mike-wolf.com', status: 'seen', anchor: anchor(1) }, KEY);
    assert.equal(pageAsHuman.status, 403);
    const pageAsKey = await call(`/api/documents/${slug}/line-marks`, 'POST', { status: 'seen', anchor: anchor(1) }, KEY);
    assert.equal(pageAsKey.body.lineMark.by, 'ai:claude-cos');
    const ownerScript = await call(`/api/agent/${slug}/marks/line`, 'POST', { lineIndex: 5, status: 'approved', by: 'human:mw@mike-wolf.com' }, { 'x-share-token': 'owner-secret-id' });
    assert.equal(ownerScript.status, 200, 'the owner credential path for scripts still works');
    assert.equal(ownerScript.body.lineMark.by, 'human:mw@mike-wolf.com');
  });

  let emailAsk = '';
  await test('asks: an ask to human:<email> is closed by that signed-in person, not by a guest typing the name', async () => {
    const created = await call(`/api/agent/${slug}/asks`, 'POST', { quote: 'Ship identity', to: ['human:mw@mike-wolf.com'], recommend: 'Yes' }, KEY);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    emailAsk = created.body.ask.id;
    const guest = await call(`/api/documents/${slug}/asks/${emailAsk}/answer`, 'POST', { by: 'Mike Wolf', choice: 'yes', anchor: anchor(1) });
    assert.equal(guest.status, 200);
    assert.equal(guest.body.answer.by, 'guest:Mike Wolf');
    assert.equal(guest.body.askedOf, false, 'recorded, but not asked of a guest');
    let list = await call(`/api/agent/${slug}/asks`, 'GET', undefined, KEY);
    let row = list.body.asks.find((a: any) => a.id === emailAsk);
    assert.deepEqual(row.openFor, ['human:mw@mike-wolf.com']);
    const mikeYes = await call(`/api/documents/${slug}/asks/${emailAsk}/answer`, 'POST', { by: 'guest:Somebody', choice: 'yes', anchor: anchor(1) }, MIKE);
    assert.equal(mikeYes.body.answer.by, 'human:mw@mike-wolf.com');
    assert.equal(mikeYes.body.askedOf, true);
    list = await call(`/api/agent/${slug}/asks`, 'GET', undefined, KEY);
    row = list.body.asks.find((a: any) => a.id === emailAsk);
    assert.equal(row.status, 'yes');
    assert.deepEqual(row.openFor, []);
  });

  await test('asks: "to" by display name resolves to the member; old typed-name asks keep working for the signed-in person', async () => {
    const byName = await call(`/api/agent/${slug}/asks`, 'POST', { quote: 'Retire typed names', to: ['Mike Wolf'], recommend: 'Yes' }, KEY);
    assert.equal(byName.status, 200, JSON.stringify(byName.body));
    assert.deepEqual(byName.body.ask.to, ['human:mw@mike-wolf.com']);
    // A pre-B6 row stored with the typed name.
    const legacyId = 'legacy-ask';
    const a = shared.anchorForLine(lines[4]);
    db.insertDocumentAsk({ id: legacyId, document_slug: slug, by_actor: 'human:Eric', to_json: JSON.stringify(['human:Mike Wolf']), recommend: 'Yes', if_yes: null,
      line_hash: a.hash, line_occurrence: a.occurrence, line_ordinal: a.ordinal, line_kind: a.kind, line_excerpt: a.excerpt, created_at: '2026-09-18T01:00:00.000Z', asked_at: '2026-09-18T01:00:00.000Z', withdrawn_at: null });
    // lines[4] is "Anyone's question?" - used here only as the legacy ask's line.
    let list = await call(`/api/documents/${slug}/asks`);
    let legacy = list.body.asks.find((x: any) => x.id === legacyId);
    assert.deepEqual(legacy.to, ['human:mw@mike-wolf.com']);
    assert.deepEqual(legacy.toRaw, ['human:Mike Wolf'], 'the stored row is not rewritten');
    await call(`/api/documents/${slug}/asks/${legacyId}/answer`, 'POST', { by: 'Mike Wolf', choice: 'yes', anchor: a });
    const view = await call(`/api/agent/${slug}/asks`, 'GET', undefined, KEY);
    assert.deepEqual(view.body.asks.find((x: any) => x.id === legacyId).openFor, ['human:mw@mike-wolf.com'], 'a guest typing the name does not close it');
    await call(`/api/documents/${slug}/asks/${legacyId}/answer`, 'POST', { choice: 'yes', anchor: a }, MIKE);
    const after = await call(`/api/agent/${slug}/asks`, 'GET', undefined, KEY);
    assert.equal(after.body.asks.find((x: any) => x.id === legacyId).status, 'yes');
    list = await call(`/api/documents/${slug}/asks`);
    legacy = list.body.asks.find((x: any) => x.id === legacyId);
    assert.equal(legacy.by, 'guest:Eric', 'the typed-name asker reads as a guest');
  });

  await test('asks: an unreserved name can be answered by the guest who types it; "to": [] counts guests (badged)', async () => {
    const ada = await call(`/api/agent/${slug}/asks`, 'POST', { quote: 'Ada', to: ['Ada'], recommend: 'Yes' }, KEY);
    assert.equal(ada.status, 200, JSON.stringify(ada.body));
    assert.deepEqual(ada.body.ask.to, ['guest:Ada']);
    await call(`/api/documents/${slug}/asks/${ada.body.ask.id}/answer`, 'POST', { by: 'Ada', choice: 'yes', anchor: anchor(3) });
    let list = await call(`/api/agent/${slug}/asks`, 'GET', undefined, KEY);
    assert.equal(list.body.asks.find((x: any) => x.id === ada.body.ask.id).status, 'yes');
    const view = asks.evaluateAsk({ id: 'x', by: 'ai:claude-cos', to: [], recommend: 'Yes', ifYes: null, anchor: anchor(1), createdAt: 'a', askedAt: 'a',
      answers: [{ id: 'y', by: 'guest:Pat', choice: 'yes', words: '', at: 'b', lineHash: lines[1].hash }] }, lines);
    assert.equal(view.closed, true, 'IDENTITY_POLICY.emptyToCountsGuests: an empty "to" is closed by a guest too');
    assert.equal(shared.actorLabel(view.people[0].answer!.by), 'Pat (guest)');
    list = await call(`/api/agent/${slug}/asks`, 'GET', undefined, KEY);
    assert.ok(list.body.asks.length >= 3);
  });

  await test('re-ask and withdraw on the page: the asker or an owner, by verified identity', async () => {
    const eric1 = await call(`/api/documents/${slug}/asks/${emailAsk}/reask`, 'POST', {}, ERIC);
    assert.equal(eric1.status, 403);
    assert.equal(eric1.body.code, 'ASKER_REQUIRED');
    const guest = await call(`/api/documents/${slug}/asks/${emailAsk}/reask`, 'POST', { by: 'ai:claude-cos' });
    assert.equal(guest.status, 403, 'a guest typing the asker\'s name is not the asker');
    const owner = await call(`/api/documents/${slug}/asks/${emailAsk}/reask`, 'POST', {}, MIKE);
    assert.equal(owner.status, 200, JSON.stringify(owner.body));
    const gone = await call(`/api/documents/${slug}/asks/${emailAsk}`, 'DELETE', {}, MIKE);
    assert.equal(gone.status, 200);
  });

  await test('team + merge: one person is one team member after the COS merges the typed name (CLI)', async () => {
    const slug2 = 'id-merge';
    db.createDocument(slug2, doc, {}, 'Merge test', 'owner-2', 'owner-secret-2');
    db.getDb().prepare(`INSERT INTO library_document_meta (slug, created_by_member_id) VALUES (?, ?)`).run(slug2, mike.id);
    // Before signing in, Mike typed "Mike" as a guest and marked every line; then he signs in.
    for (let i = 0; i < lines.length; i += 1) {
      await call(`/api/documents/${slug2}/line-marks`, 'POST', { by: 'Mike', status: 'seen', anchor: anchor(i) });
    }
    await call(`/api/documents/${slug2}/line-marks`, 'POST', { status: 'agreed', anchor: anchor(0) }, MIKE);
    let state = await call(`/api/agent/${slug2}/state`, 'GET', undefined, { 'x-share-token': 'owner-secret-2' });
    assert.deepEqual([...state.body.alignment.team].sort(), ['guest:Mike', 'human:mw@mike-wolf.com']);
    assert.equal(state.body.alignment.aligned, false, 'the verified Mike has not seen lines 1..');
    const env = { ...process.env };
    const cli = spawnSync(process.execPath, ['--import', 'tsx', 'server/library/cli.ts', 'merge-identity', '--from', 'Mike', '--into', 'human:mw@mike-wolf.com', '--slug', slug2], { env, encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /Merged guest:mike into human:mw@mike-wolf.com \(id-merge\)/);
    const refused = spawnSync(process.execPath, ['--import', 'tsx', 'server/library/cli.ts', 'merge-identity', '--from', 'human:eric@example.test', '--into', 'human:mw@mike-wolf.com', '--slug', slug2], { env, encoding: 'utf8' });
    assert.notEqual(refused.status, 0, 'a verified person cannot be merged into another');
    state = await call(`/api/agent/${slug2}/state`, 'GET', undefined, { 'x-share-token': 'owner-secret-2' });
    assert.deepEqual(state.body.alignment.team, ['human:mw@mike-wolf.com']);
    assert.equal(state.body.alignment.aligned, true, JSON.stringify(state.body.issues.slice(0, 2)));
    assert.ok(state.body.lineMarks.every((m: any) => m.by === 'human:mw@mike-wolf.com'));
    assert.ok(state.body.lineMarks.some((m: any) => m.originalBy === 'guest:Mike'), 'the original typed name stays readable');
    // A merge does not cover later writes: a guest typing "Mike" now is still a guest.
    await new Promise(r => setTimeout(r, 5));
    const later = await call(`/api/documents/${slug2}/line-marks`, 'POST', { by: 'Mike', status: 'rejected', reason: 'spoof', anchor: anchor(2) });
    assert.equal(later.body.lineMark.by, 'guest:Mike');
    state = await call(`/api/agent/${slug2}/state`, 'GET', undefined, { 'x-share-token': 'owner-secret-2' });
    const rejected = state.body.issues.find((i: any) => i.type === 'line' && i.lineIndex === 2);
    assert.deepEqual(rejected.rejectedBy, [{ by: 'guest:Mike', reason: 'spoof' }]);
    const actors = spawnSync(process.execPath, ['--import', 'tsx', 'server/library/cli.ts', 'actors', '--slug', slug2], { env, encoding: 'utf8' });
    assert.equal(actors.status, 0, actors.stderr);
    assert.match(actors.stdout, /guest:Mike\thuman:mw@mike-wolf.com/);
  });

  console.log(`\nidentity tests: ${passed} passed`);
} finally {
  server.close();
  rmSync(temp, { recursive: true, force: true });
}

