// Proof Documents — dialect export and import through the real routes: a rich document (every
// mark type we store) exports as a Proof Document; importing it with the operator key recreates
// the marks; export → import → export is stable; CriticMarkup files import; and an import cannot
// forge a verified person's marks.
// Authorship: Claude Opus 5 (worker proof-dialect) for Mike Wolf, 2026-09-19.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-dialect-'));
process.env.DATABASE_PATH = path.join(temp, 'test.db');
Object.assign(process.env, { PROOF_ENV: 'test', PROOF_DB_ENV_INIT: 'test', PROOF_LIBRARY_ENABLED: '1', PROOF_SHARE_MARKDOWN_API_KEY: 'operator-key-test' });
delete process.env.PROOF_SOMA_AUTH_ENABLED;
delete process.env.PROOF_PUBLIC_ORIGIN;

const shared = await import('../shared/line-marks');
const dialect = await import('../shared/proof-dialect');
const db = await import('../../server/db');
const auth = await import('../../server/library/auth');
const libraryDocs = await import('../../server/library/documents');
const serverLines = await import('../../server/line-marks');
const { apiRoutes } = await import('../../server/routes');
const { agentRoutes } = await import('../../server/agent-routes');

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const app = express();
app.use(express.json({ limit: '12mb' }));
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
  const text = await response.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { json = {}; }
  return { status: response.status, headers: response.headers, text, body: json };
};
const ok = (r: { status: number; body: unknown }, what: string) => assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);

const MIKE = 'human:mw@mike-wolf.com';
const ERIC = 'human:eric@example.test';
const OPERATOR = { 'x-api-key': 'operator-key-test' };

const fixture = `# Launch plan

We launch in the second quarter.

The budget is fixed at ten thousand.

Marketing starts after the beta.

- Hire two engineers
- Book the venue

| Item | Cost |
|---|---|
| Venue | 4000 |

Next steps follow.

Last line.`;

function gdocAction(): Record<string, unknown> {
  return {
    id: 'authorize-gdoc-bridge', revision: 1, executor: 'workflow', label: 'Authorize the Google Docs bridge', operation: 'gdoc_bridge_authorize',
    params: { project_id: 'soma-gdoc-bridge', account: 'mw@mike-wolf.com' },
    human_gate: { instruction: 'Click Allow', target: { url: 'https://accounts.google.com/o/oauth2/v2/auth', ref: 'google.oauth.consent.primary', label: 'Allow' } },
    completion: { mode: 'verified', success_message: 'Authorized' },
    verification: { kind: 'google_drive_about' },
  };
}

try {
  const mike = auth.createLibraryMember({ name: 'Mike Wolf', email: 'mw@mike-wolf.com' });
  const eric = auth.createLibraryMember({ name: 'Eric', email: 'eric@example.test' });
  const sessionCookie = (memberId: string) => {
    const link = auth.createLibrarySigninLink({ memberId, purpose: 'operator', origin: base });
    const signedIn = auth.consumeLibrarySigninToken(new URL(link.link).hash.slice(3), null)!;
    return `${auth.LIBRARY_SESSION_COOKIE}=${encodeURIComponent(signedIn.sessionId)}`;
  };
  const slug = 'dialect-src';
  db.createDocument(slug, fixture, {}, 'Launch plan', 'owner-1', 'owner-secret-dialect');
  db.getDb().prepare(`INSERT INTO library_document_meta (slug, created_by_member_id) VALUES (?, ?)`).run(slug, mike.id);
  const share = db.createDocumentAccessToken(slug, 'commenter');
  const key = db.createDocumentAccessToken(slug, 'editor', undefined, { label: 'Claude', requestedBy: 'test', requestedFrom: '127.0.0.1' });
  const OWNER = { 'x-share-token': 'owner-secret-dialect' };
  const KEY = { 'x-share-token': key.secret };
  const MIKE_PAGE = { Cookie: sessionCookie(mike.id), 'x-share-token': share.secret, Origin: base };
  const ERIC_PAGE = { Cookie: sessionCookie(eric.id), 'x-share-token': share.secret, Origin: base };

  // ------------------------------------------------------------------ a rich document
  await test('fixture: every stored mark type is created through the routes', async () => {
    const A = `/api/agent/${slug}`;
    ok(await call(`${A}/marks/suggest-replace`, 'POST', { quote: 'second quarter', content: 'third quarter', why: 'The beta slipped', bundle: { id: 'launch', title: 'Move launch to Q3', why: 'Beta slipped' } }, KEY), 'replace');
    ok(await call(`${A}/marks/suggest-insert`, 'POST', { quote: 'Last line.', content: ' Really.', why: 'Emphasis', priority: 2, priorityReason: 'Tone matters' }, KEY), 'insert');
    ok(await call(`${A}/marks/suggest-delete`, 'POST', { by: ERIC, quote: 'fixed at ' }, OWNER), 'delete');
    ok(await call(`${A}/marks/suggest-insert`, 'POST', { quote: 'Next steps follow.', content: '\n\nA brand new paragraph.', why: 'Adds the risk note' }, KEY), 'block insert');
    const comment = await call(`${A}/marks/comment`, 'POST', { by: MIKE, quote: 'Book the venue', text: 'Which "venue"? See [x].' }, OWNER);
    ok(comment, 'comment');
    ok(await call(`${A}/marks/reply`, 'POST', { markId: comment.body.markId, by: 'ai:claude', text: 'The hall on Main St.' }, KEY), 'reply');
    const done = await call(`${A}/marks/comment`, 'POST', { by: ERIC, quote: 'Marketing starts', text: 'Resolved question' }, OWNER);
    ok(await call(`${A}/marks/resolve`, 'POST', { markId: done.body.markId, by: ERIC }, OWNER), 'resolve');
    // Line marks: people (owner credential) and the AI (its key, with evidence).
    ok(await call(`${A}/marks/line`, 'POST', { by: MIKE, status: 'agreed', quote: 'Launch plan' }, OWNER), 'mike agrees heading');
    ok(await call(`${A}/marks/line`, 'POST', { by: MIKE, status: 'rejected', quote: 'Marketing starts', reason: 'Too late, start now' }, OWNER), 'mike rejects');
    ok(await call(`${A}/marks/line`, 'POST', { by: MIKE, status: 'approved', quote: 'Venue | 4000' }, OWNER), 'mike approves row');
    ok(await call(`${A}/marks/line`, 'POST', { by: ERIC, status: 'seen', quote: 'Launch plan' }, OWNER), 'eric seen');
    ok(await call(`${A}/marks/line`, 'POST', { status: 'agreed', quote: 'Hire two engineers', evidence: 'Matches the hiring plan', why: 'Budget allows it' }, KEY), 'ai agrees');
    ok(await call(`${A}/tiers`, 'POST', { tier: 'context', lines: [{ quote: 'Hire two engineers' }] }, KEY), 'tier context');
    ok(await call(`${A}/tiers`, 'POST', { by: MIKE, tier: 'decision', reason: 'Money', lines: [{ quote: 'Venue | 4000' }] }, OWNER), 'tier decision');
    ok(await call(`${A}/flags`, 'POST', { quote: 'The budget is fixed', note: 'Check the total' }, KEY), 'flag');
    ok(await call(`${A}/ttl`, 'POST', { quote: 'The budget is fixed', ttl: '7d' }, KEY), 'ttl');
    const ask = await call(`${A}/asks`, 'POST', { quote: 'Next steps follow.', to: [MIKE], recommend: 'Yes: the plan is ready', ifYes: 'We book the venue' }, KEY);
    ok(ask, 'ask');
    const lines = await serverLines.computeServerLines(db.getDocumentBySlug(slug)!.markdown);
    const next = lines.find(l => l.text.startsWith('Next steps'))!;
    ok(await call(`/api/documents/${slug}/asks/${ask.body.ask.id}/answer`, 'POST', { choice: 'not_yet', words: 'After the budget call', anchor: shared.anchorForLine(next) }, MIKE_PAGE), 'mike answers');
    ok(await call(`${A}/objections`, 'POST', { by: MIKE, lines: [{ quote: 'Hire two engineers' }, { quote: 'Book the venue' }], reason: 'Order is wrong', condition: 'venue first' }, OWNER), 'objection');
    ok(await call(`${A}/alternatives`, 'POST', { quote: 'Last line.', text: 'Final line.' }, KEY), 'alternative');
    ok(await call(`${A}/dos`, 'POST', { quote: 'Next steps follow.', action: gdocAction(), to: [MIKE] }, KEY), 'do');
    ok(await call(`${A}/familiars`, 'POST', { for: MIKE, familiar: 'ai:claude' }, OWNER), 'familiar');
    ok(await call(`${A}/marks/proxy`, 'POST', { for: MIKE, lines: [{ target: { quote: 'Book the venue' }, status: 'agreed', confidence: 0.95, evidence: 'Venue is booked in the calendar' }] }, KEY), 'proxy');
    // A stale mark: Eric agreed, then the line changed (through a text edit by the owner).
    ok(await call(`${A}/marks/line`, 'POST', { by: ERIC, status: 'agreed', quote: 'The budget is fixed' }, OWNER), 'eric agrees budget');
    void ERIC_PAGE;
  });

  let exported = '';
  await test('export: GET /api/agent/:slug/export writes every mark in the dialect, with a handle table', async () => {
    const r = await call(`/api/agent/${slug}/export?format=proof-dialect`, 'GET', undefined, OWNER);
    assert.equal(r.status, 200, r.text);
    assert.match(r.headers.get('content-type') ?? '', /text\/markdown/);
    assert.match(r.headers.get('content-disposition') ?? '', /attachment; filename="Launch-plan\.accord\.md"/);
    exported = r.text;
    if (process.env.DIALECT_DEBUG) console.log(exported);
    const p = dialect.parseProofDocument(exported);
    assert.deepEqual(Object.values(p.handles).sort(), ['ai:claude', ERIC, MIKE].sort());
    const h = (actor: string) => dialect.handleForActor(p.handles, actor);
    assert.equal(p.frontMatter.proof?.title, 'Launch plan');
    assert.deepEqual(p.frontMatter.proof?.bundles, { launch: { title: 'Move launch to Q3', why: 'Beta slipped' } });
    assert.ok(exported.includes(`[~~second quarter~~ third quarter]{changed @${h('ai:claude')} at=`), exported);
    assert.ok(/why="The beta slipped" bundle=launch\}/.test(exported), 'why and bundle on the change');
    assert.ok(exported.includes(`[ Really.]{changed @${h('ai:claude')} at=`), 'pure insertion');
    assert.ok(/priority=2 priorityreason="Tone matters"/.test(exported));
    assert.ok(exported.includes(`[~~fixed at ~~]{changed @${h(ERIC)} at=`) || exported.includes(`[~~fixed at~~]{changed @${h(ERIC)} at=`), 'pure deletion');
    assert.ok(/\n\[A brand new paragraph\.\]\{changed @claude at=[^}]*why="Adds the risk note"\}\n/.test(exported), 'a block insertion is its own bracketed paragraph');
    assert.ok(/\[Book the venue\]\{comment @mw text="Which \\"venue\\"\? See \[x\]\." at=[^}]*\}\{reply @claude text="The hall on Main St\." at=[^}]*\}/.test(exported), 'comment and reply');
    assert.ok(/\{comment @eric text="Resolved question" at=\S+ resolved=1\}/.test(exported), 'resolved comment');
    assert.ok(/# Launch plan \{seen @eric at=\S+\} \{agreed @mw at=\S+\}\n/.test(exported), 'the heading carries two people\'s marks');
    assert.ok(/\{rejected @mw at=\S+ reason="Too late, start now"\}/.test(exported));
    assert.ok(/\| Venue \| 4000 \{approved @mw at=\S+\} \{decision @mw reason=Money\} \|/.test(exported), 'table row marks inside the last cell');
    assert.ok(/Hire two engineers \{agreed @claude at=\S+ why="Budget allows it" evidence="Matches the hiring plan"\}.* \{context @claude\}/.test(exported), exported);
    assert.ok(/\{uncertain @claude note="Check the total" at=\S+\} \{ttl @claude for=7d since=\S+\}/.test(exported));
    assert.ok(/\{ask @claude to=@mw recommend="Yes: the plan is ready" ifyes="We book the venue"\} \{answer @mw choice=not_yet words="After the budget call"\}/.test(exported));
    assert.ok(/\{objection @mw id=o1 reason="Order is wrong" if="venue first"\}/.test(exported));
    assert.equal((exported.match(/\{objection @mw id=o1/g) ?? []).length, 2, 'an objection is written on each covered line');
    assert.ok(/\{alternative @claude id=a1 text="Final line\."\} \{pick @claude choice=a1\}/.test(exported));
    assert.ok(/\{do @claude state=proposed to=@mw action="\{\\"id\\":\\"authorize-gdoc-bridge\\"/.test(exported), 'the do line with its action');
    assert.ok(/\{proxy @claude for=@mw status=agreed confidence=0\.95 evidence="Venue is booked in the calendar"\}/.test(exported));
    // Plain renderers: the base is the document without pending changes.
    const plain = await call(`/api/agent/${slug}/export?format=plain`, 'GET', undefined, OWNER);
    assert.equal(plain.status, 200);
    assert.ok(plain.text.includes('We launch in the second quarter.'));
    assert.ok(!plain.text.includes('Really.'), 'pending insertions are left out of plain');
    assert.ok(!plain.text.includes('brand new paragraph'));
    assert.ok(!/\{(agreed|changed|comment)/.test(plain.text));
    const bad = await call(`/api/agent/${slug}/export?format=docx`, 'GET', undefined, OWNER);
    assert.equal(bad.status, 400);
    const noAuth = await call(`/api/agent/${slug}/export`);
    assert.equal(noAuth.status, 401);
  });

  await test('export: CriticMarkup carries suggestions and comments only, and says so', async () => {
    const r = await call(`/api/agent/${slug}/export?format=criticmarkup`, 'GET', undefined, OWNER);
    assert.equal(r.status, 200);
    assert.ok(r.text.includes(dialect.CRITIC_POLICY.exportHeader));
    assert.ok(r.text.includes('{~~second quarter~>third quarter~~}'));
    assert.ok(r.text.includes('{++ Really.++}'));
    assert.ok(/\{==Book the venue==\}\{>>@mw: Which "venue"\? See \[x\]\.<<\}\{>>@claude: The hall on Main St\.<<\}/.test(r.text));
    assert.ok(!/\{agreed|\{ask/.test(r.text));
    assert.match(r.headers.get('content-disposition') ?? '', /\.critic\.md/);
  });

  await test('export: the page route gives the same file (signed-in reader); blind marking hides others\' positions', async () => {
    const page = await call(`/api/documents/${slug}/export`, 'GET', undefined, MIKE_PAGE);
    assert.equal(page.status, 200, page.text);
    assert.equal(page.text, exported);
    ok(await call(`/api/agent/${slug}/settings`, 'POST', { blind: true, by: MIKE }, OWNER), 'blind on');
    const blindPage = await call(`/api/documents/${slug}/export`, 'GET', undefined, ERIC_PAGE);
    assert.ok(/\{agreed @mw/.test(blindPage.text), 'Eric sees Mike on the heading Eric already marked');
    assert.ok(!/\{rejected @mw/.test(blindPage.text), 'Eric cannot see Mike on the unrevealed marketing line');
    assert.ok(/\{seen @eric/.test(blindPage.text), 'Eric sees his own');
    const blindOwner = await call(`/api/agent/${slug}/export`, 'GET', undefined, OWNER);
    assert.equal(blindOwner.text, exported, 'the owner credential reads everything');
    ok(await call(`/api/agent/${slug}/settings`, 'POST', { blind: false, by: MIKE }, OWNER), 'blind off');
  });

  // ------------------------------------------------------------------ import + round trip
  let importedSlug = '';
  let importedSecret = '';
  await test('import (operator key): every live mark is recreated; {do}, proxies and alternatives become history', async () => {
    const r = await call('/api/share/markdown', 'POST', { markdown: exported, format: 'proof-dialect' }, OPERATOR);
    assert.equal(r.status, 200, r.text);
    importedSlug = r.body.slug;
    importedSecret = r.body.ownerSecret;
    const summary = r.body.import;
    assert.equal(summary.authority, 'operator');
    assert.equal(summary.format, 'proof-dialect');
    assert.deepEqual(summary.guests, []);
    assert.equal(summary.created.suggestions, 4);
    assert.equal(summary.created.comments, 2);
    assert.equal(summary.created.replies, 1);
    assert.equal(summary.created.resolved, 1);
    assert.equal(summary.created.bundles, 1);
    assert.equal(summary.created.asks, 1);
    assert.equal(summary.created.answers, 1);
    assert.equal(summary.created.objections, 1);
    assert.equal(summary.created.tiers, 2);
    assert.equal(summary.created.flags, 1);
    assert.equal(summary.created.ttls, 1);
    assert.ok(summary.created.lineMarks >= 7, JSON.stringify(summary));
    assert.equal(summary.history, 4, 'alternative + pick + do + proxy');
    const doc = db.getDocumentBySlug(importedSlug)!;
    assert.equal(doc.title, 'Launch plan', 'the title comes from the proof block');
    const state = await call(`/api/agent/${importedSlug}/state`, 'GET', undefined, { 'x-share-token': r.body.ownerSecret });
    assert.equal(state.status, 200);
    assert.equal(state.body.dos.length, 0, 'a file never proposes an executable action');
    assert.equal(state.body.dialectHistory.length, 4);
    assert.ok(state.body.dialectHistory.every((n: { counts: boolean }) => n.counts === false));
    const mikeMarks = state.body.lineMarks.filter((m: { by: string }) => m.by === MIKE).map((m: { status: string }) => m.status).sort();
    assert.deepEqual(mikeMarks, ['agreed', 'approved', 'rejected', 'seen', 'seen', 'seen']);
    assert.ok(state.body.lineMarks.some((m: { by: string; status: string; evidence?: string }) => m.by === 'ai:claude' && m.status === 'agreed' && m.evidence === 'Matches the hiring plan'));
    assert.ok(state.body.asks[0].people.some((p: { actor: string; choice: string }) => p.actor === MIKE && p.choice === 'not_yet'));
  });

  await test('round trip: export → import → export is stable', async () => {
    const second = await call(`/api/agent/${importedSlug}/export?format=proof-dialect`, 'GET', undefined, { 'x-share-token': importedSecret });
    assert.equal(second.status, 200, second.text);
    const text = second.text;
    assert.equal(text, exported, diffHint(exported, text));
    // And once more (a fixed point).
    const again = await call('/api/share/markdown', 'POST', { markdown: text, format: 'auto' }, OPERATOR);
    assert.equal(again.status, 200, again.text);
    const third = await call(`/api/agent/${again.body.slug}/export`, 'GET', undefined, { 'x-share-token': again.body.ownerSecret });
    assert.equal(third.text, exported, diffHint(exported, third.text));
  });

  // Naming tail (2026-09-21): the file format is the Accord dialect; format=accord-dialect is an
  // alias; proof-dialect stays the canonical machine value; the file is <title>.accord.md.
  await test('naming: format=accord-dialect is an alias of proof-dialect (export and import); the file is <title>.accord.md', async () => {
    const alias = await call(`/api/agent/${slug}/export?format=accord-dialect`, 'GET', undefined, OWNER);
    assert.equal(alias.status, 200, alias.text);
    assert.equal(alias.text, exported);
    assert.match(alias.headers.get('content-disposition') ?? '', /filename="Launch-plan\.accord\.md"/);
    const upper = await call(`/api/agent/${slug}/export?format=Accord-Dialect`, 'GET', undefined, OWNER);
    assert.equal(upper.status, 200);
    const bad = await call(`/api/agent/${slug}/export?format=word`, 'GET', undefined, OWNER);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'INVALID_FORMAT');
    assert.match(String(bad.body.error), /accord-dialect is accepted for proof-dialect/);
    const state = await call(`/api/agent/${slug}/state`, 'GET', undefined, OWNER);
    const link = JSON.stringify(state.body).match(/export\?format=[a-z-]+/)?.[0];
    if (link) assert.equal(link, 'export?format=proof-dialect', 'the canonical machine value in responses');
    const imported = await call('/api/share/markdown', 'POST', { markdown: exported, format: 'accord-dialect' }, OPERATOR);
    assert.equal(imported.status, 200, imported.text);
    assert.equal(imported.body.import?.authority, 'operator');
    const back = await call(`/api/agent/${imported.body.slug}/export`, 'GET', undefined, { 'x-share-token': imported.body.ownerSecret });
    assert.equal(back.text, exported, diffHint(exported, back.text));
    const serverDialect = await import('../../server/proof-dialect');
    assert.equal(serverDialect.normalizeExportFormat('accord-dialect'), 'proof-dialect');
    assert.equal(serverDialect.normalizeExportFormat(undefined), 'proof-dialect');
    assert.equal(serverDialect.normalizeExportFormat('criticmarkup'), 'criticmarkup');
    assert.equal(serverDialect.normalizeExportFormat('word'), null);
    assert.deepEqual([...serverDialect.EXPORT_FORMATS], ['proof-dialect', 'criticmarkup', 'plain']);
    assert.deepEqual([...serverDialect.DIALECT_FILE_POLICY.importSuffixes], ['.accord.md', '.proof.md']);
    // The CriticMarkup header names the product and the Accord dialect; an older "from Proof" header is still recognised.
    assert.match(dialect.CRITIC_POLICY.exportHeader, /^<!-- CriticMarkup export from Accord: .*export the Accord dialect \(format=proof-dialect\)/);
    assert.ok(dialect.CRITIC_POLICY.exportHeaderPattern.test('<!-- CriticMarkup export from Proof: old header -->\n'));
  });

  // ------------------------------------------------------------------ security
  await test('security: an import without the operator key cannot forge a verified person\'s marks', async () => {
    const r = await call('/api/share/markdown', 'POST', { markdown: exported, format: 'proof-dialect' });
    assert.equal(r.status, 200, r.text);
    const summary = r.body.import;
    assert.equal(summary.authority, 'anonymous');
    assert.deepEqual(summary.guests.sort(), ['guest:claude', 'guest:eric', 'guest:mw']);
    const state = await call(`/api/agent/${r.body.slug}/state`, 'GET', undefined, { 'x-share-token': r.body.ownerSecret });
    assert.equal(state.body.lineMarks.length, 0, 'no line mark in anyone\'s name');
    assert.equal(state.body.asks.length, 0);
    assert.equal(state.body.objections.length, 0);
    assert.equal(state.body.tiers.filter((t: { tagged: boolean }) => t.tagged).length, 0);
    assert.ok(state.body.dialectHistory.some((n: { claimedBy: string; reason: string; mark: string }) => n.claimedBy === MIKE && n.reason === 'untrusted-identity' && n.mark.startsWith('{approved')));
    const marks = Object.values(state.body.marks as Record<string, { by: string }>);
    assert.ok(marks.length >= 6 && marks.every(m => m.by.startsWith('guest:')), 'suggestions and comments are guest proposals');
    // Its export writes the untrusted marks as {history}, so a later operator import cannot launder them.
    const ex = await call(`/api/agent/${r.body.slug}/export`, 'GET', undefined, { 'x-share-token': r.body.ownerSecret });
    assert.ok(/\{history mark="\{approved at=\S+\}" claimed=human:mw@mike-wolf\.com reason=untrusted-identity\}/.test(ex.text), ex.text);
    const laundered = await call('/api/share/markdown', 'POST', { markdown: ex.text, format: 'proof-dialect' }, OPERATOR);
    const st2 = await call(`/api/agent/${laundered.body.slug}/state`, 'GET', undefined, { 'x-share-token': laundered.body.ownerSecret });
    assert.equal(st2.body.lineMarks.filter((m: { by: string }) => m.by === MIKE).length, 0, 'history never becomes a mark');
  });

  await test('security: a signed-in member importing (library) keeps only their own marks live', async () => {
    const created = await libraryDocs.createLibraryDocument({ member: { ...eric, isOwner: false, invitedBy: null, createdAt: '', removedAt: null } as never, title: '', markdown: exported });
    assert.ok(created.import, 'the library upload used the importer');
    assert.equal(created.import!.authority, 'session');
    const secret = db.createDocumentAccessToken(created.slug, 'viewer').secret;
    const state = await call(`/api/agent/${created.slug}/state`, 'GET', undefined, { 'x-share-token': secret });
    const by = new Set(state.body.lineMarks.map((m: { by: string }) => m.by));
    assert.deepEqual([...by], [ERIC], 'only Eric\'s own line marks are live');
    assert.ok(Object.values(state.body.marks as Record<string, { by: string; kind: string }>).some(m => m.by === ERIC && m.kind === 'delete'), 'Eric\'s own suggestion keeps his name');
    assert.ok(Object.values(state.body.marks as Record<string, { by: string }>).some(m => m.by === 'guest:mw'), 'Mike\'s comment is a guest proposal');
    assert.equal(db.getDocumentBySlug(created.slug)!.title, 'Launch plan');
  });

  // ------------------------------------------------------------------ CriticMarkup from the wild
  await test('CriticMarkup files import as suggestions and comments (anonymous importer → guest:importer)', async () => {
    const files = [
      { name: 'mmd', text: 'Lorem ipsum dolor{-- sit--} amet, consectetur{++ adipiscing++} elit.\n\nThis is a {~~red~>blue~~} house.{>>Is it though?<<}\n', suggestions: 3, comments: 1, current: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n\nThis is a red house.\n' },
      { name: 'author prefix', text: '# Notes\n\nThe {==quick brown fox==}{>>@editor: cliché<<} jumps over the dog.\n\n- item one\n- item {++two++}\n', suggestions: 1, comments: 1 },
      { name: 'paragraph insert', text: 'First paragraph.\n\n{++\n\nA whole new paragraph.\n\n++}\n\nSecond paragraph.\n', suggestions: 1, comments: 0, current: 'First paragraph.\n\nA whole new paragraph.\n\nSecond paragraph.\n' },
      { name: 'table + code untouched', text: '| A | B |\n|---|---|\n| {~~1~>one~~} | 2 |\n\n```\n{--keep me--}\n```\n', suggestions: 1, comments: 0 },
    ];
    for (const file of files) {
      const r = await call('/api/share/markdown', 'POST', { markdown: file.text, format: 'criticmarkup' });
      assert.equal(r.status, 200, `${file.name}: ${r.text}`);
      assert.equal(r.body.import.created.suggestions ?? 0, file.suggestions, `${file.name}: ${JSON.stringify(r.body.import)}`);
      assert.equal(r.body.import.created.comments ?? 0, file.comments, file.name);
      const st = await call(`/api/agent/${r.body.slug}/state`, 'GET', undefined, { 'x-share-token': r.body.ownerSecret });
      const marks = Object.values(st.body.marks as Record<string, { by: string; status?: string }>);
      assert.ok(marks.every(m => m.by === 'guest:importer' || m.by === 'guest:editor'), `${file.name}: ${JSON.stringify(marks.map(m => m.by))}`);
      assert.ok(!/\{\+\+|\{--|\{~~|\{>>/.test(st.body.markdown.replace(/```[\s\S]*?```/g, '')), `${file.name}: no CriticMarkup left in the text`);
      if ('current' in file) assert.equal(st.body.markdown, file.current, `${file.name}: the text holds the pending insertions, and the deletions until accepted`);
    }
    const auto = await call('/api/share/markdown', 'POST', { markdown: 'Hello {++world++}.', format: 'auto' });
    assert.equal(auto.body.import.format, 'criticmarkup');
    const plainDoc = await call('/api/share/markdown', 'POST', { markdown: 'Plain [link](https://x.test) and {x}.' });
    assert.equal(plainDoc.body.import, undefined, 'plain markdown without format or a proof block is not imported');
  });

  // ------------------------------------------------------------------ interrupted typing
  // The shapes of the live Waiting on Mike document (ttq18nc1, 2026-09-19): about 35 pending
  // insertions from typing in suggestion mode, in pieces, many adjacent, some whitespace only, some
  // inside a heading, a link or italics, two whose text is gone (orphans), and stored offsets that
  // went stale when the document changed before them. Synthetic text: the live document is private.
  const typed = `# Waiting on Mike

*Everything that needs you, in one place. An AI records your words and moves the ask to Done. Every action has a link to the exact page.*

## Needs your hands

### Roll the full live Stripe key

[Open the API keys](https://example.test/keys), find the Secret key (it starts with sk\\_live\\_), and choose Roll key. It breaks nothing of ours. sk\\_live has no Roll Key option

Ruled 2026-09-19 (typed inline): “I have reset my usage so we are OK for a while”

Ruled 2026-09-19 (typed inline): “Key is deleted, but I don't see how to turn off the worker”

Then [add a webhook endpoint](https://example.test/webhooks) for the site.
`;
  const typedSlug = 'dialect-typed';
  const typedMarks: Record<string, Record<string, unknown>> = {};
  let typedN = 0;
  const typedAt = (sec: number) => new Date(Date.UTC(2026, 8, 18, 2, 0, sec)).toISOString();
  const ins = (content: string, sec: number, startRel: number | null) => {
    typedN += 1;
    typedMarks[`m1789700000000_typed_${String(typedN).padStart(2, '0')}`] = {
      kind: 'insert', by: 'human:Mike', createdAt: typedAt(sec), status: 'pending', content,
      quote: content.trim() || content, ...(startRel === null ? {} : { startRel: `char:${startRel}`, endRel: `char:${startRel + content.length}` }),
    };
  };
  // A chain typed into the Stripe paragraph; its offsets are stale (they point at the title,
  // where "on" and "i" also occur).
  ins(' sk', 1, 3); ins('_live has no', 2, 5); ins(' Roll', 3, 8); ins(' Key o', 4, 9); ins('pt', 5, 10); ins('i', 6, 11); ins('on', 7, 12);
  // A whitespace-only insertion, then a chain inside the quotation marks (one untracked "“" between).
  ins(' ', 10, 40); ins('I have ', 11, 41); ins('res', 12, 900); ins('et my ', 13, 42); ins('usag', 14, 43); ins('e so we are OK ', 15, 44); ins('fo', 16, 45); ins('r a while', 17, 46);
  // Inside italics, inside a heading and inside link text (offsets close to right).
  const plainAt = (needle: string) => typed.indexOf(needle);
  ins(' Done', 20, plainAt(' Done.'));
  ins('full ', 21, plainAt('full live') - 4);
  ins('p', 22, plainAt('point]') - 3);
  // Two insertions at the same stored offset whose text is gone (orphans), between placed ones.
  ins('Key is deleted, but ', 30, 300); ins("I don't see ", 31, 300); ins('jere to ', 32, 320); ins('jer', 33, 320); ins('how to turn of', 34, 320); ins('f ', 35, 330);
  const TYPED_INSERTS = typedN;
  let typedExport = '';

  await test('interrupted typing: every insertion is exactly one well-formed [..]{changed} in its place', async () => {
    db.createDocument(typedSlug, typed, typedMarks, 'Waiting on Mike', 'owner-typed', 'owner-secret-typed');
    // A comment on words inside one insertion nests inside it.
    ok(await call(`/api/agent/${typedSlug}/marks/comment`, 'POST', { by: MIKE, quote: 'a while', text: 'How long?' }, { 'x-share-token': 'owner-secret-typed' }), 'comment in an insertion');
    const r = await call(`/api/agent/${typedSlug}/export?format=proof-dialect`, 'GET', undefined, { 'x-share-token': 'owner-secret-typed' });
    assert.equal(r.status, 200, r.text);
    typedExport = r.text;
    const x = typedExport;
    const g = (sec: number) => `\\{changed @mike at=${typedAt(sec).replace(/\./g, '\\.')}\\}`;
    assert.ok(/^# Waiting on Mike$/m.test(x), `the title carries no marks:\n${x}`);
    assert.ok(new RegExp(`ours\\.\\[ sk\\]${g(1)}\\[\\\\_live has no\\]${g(2)}\\[ Roll\\]${g(3)}\\[ Key o\\]${g(4)}\\[pt\\]${g(5)}\\[i\\]${g(6)}\\[on\\]${g(7)}$`, 'm').test(x), `the Stripe chain, in order, each piece its own mark, the escape inside:\n${x}`);
    assert.ok(new RegExp(`\\(typed inline\\):\\[ \\]${g(10)}“\\[I have \\]${g(11)}\\[res\\]${g(12)}\\[et my \\]${g(13)}\\[usag\\]${g(14)}\\[e so we are OK \\]${g(15)}\\[fo\\]${g(16)}\\[r \\[a while\\]\\{comment @mw text="How long\\?" at=\\S+\\}\\]${g(17)}”`).test(x), `the quoted chain (and the comment nested in its last piece):\n${x}`);
    assert.ok(new RegExp(`moves the ask to\\[ Done\\]${g(20)}\\. Every action`).test(x), 'inside italics');
    assert.ok(new RegExp(`^### Roll the \\[full \\]${g(21)}live Stripe key$`, 'm').test(x), 'inside a heading, after its "### "');
    assert.ok(new RegExp(`\\[add a webhook end\\[p\\]${g(22)}oint\\]\\(https://example\\.test/webhooks\\)`).test(x), 'inside link text');
    assert.ok(new RegExp(`“\\[Key is deleted, but \\]${g(30)}\\[I don't see \\]${g(31)}\\[how to turn of\\]${g(34)}\\[f \\]${g(35)}the worker” \\{changed @mike kind=insert to="jere to " orphan=1 at=\\S+\\} \\{changed @mike kind=insert to=jer orphan=1 at=\\S+\\}$`, 'm').test(x), `same-offset insertions in creation order; orphans on their neighbours' line:\n${x}`);
    assert.ok(!/quote=/.test(x), 'no quote= fallbacks');
    assert.ok(!/\[\[[^\]]*\]\{changed/.test(x), 'no insertion nested in another');
    const parsed = dialect.parseProofDocument(x);
    const inlineChanged = parsed.inline.filter(m => m.groups[0].type === 'changed');
    const lineChanged = parsed.lines.flatMap(l => l.groups).filter(gr => gr.type === 'changed');
    assert.equal(inlineChanged.length + lineChanged.length, TYPED_INSERTS, 'one group per suggestion');
    assert.equal(lineChanged.length, 2, 'only the two orphans are line marks');
    assert.equal(parsed.current.replace(/^\n/, ''), typed, 'the file\'s current text is the document');
  });

  await test('interrupted typing: import keeps every insertion (formatting too); export → import → export is byte-identical', async () => {
    const r = await call('/api/share/markdown', 'POST', { markdown: typedExport, format: 'proof-dialect' }, OPERATOR);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.import.created.suggestions, TYPED_INSERTS, JSON.stringify(r.body.import));
    assert.equal(r.body.import.created.orphans, 2);
    assert.deepEqual(r.body.import.warnings, []);
    const H2 = { 'x-share-token': r.body.ownerSecret };
    const st = await call(`/api/agent/${r.body.slug}/state`, 'GET', undefined, H2);
    assert.equal(st.body.markdown, typed, 'the imported text is the original, italics and link included');
    const again = await call(`/api/agent/${r.body.slug}/export?format=proof-dialect`, 'GET', undefined, H2);
    assert.equal(again.text, typedExport, diffHint(typedExport, again.text));
    const third = await call('/api/share/markdown', 'POST', { markdown: again.text, format: 'auto' }, OPERATOR);
    const thirdExport = await call(`/api/agent/${third.body.slug}/export`, 'GET', undefined, { 'x-share-token': third.body.ownerSecret });
    assert.equal(thirdExport.text, typedExport, diffHint(typedExport, thirdExport.text));
    // The attached insertions are real suggestions: rejecting one inside italics removes its text.
    const marks = st.body.marks as Record<string, { kind: string; content?: string }>;
    const done = Object.entries(marks).find(([, m]) => m.kind === 'insert' && m.content === ' Done')![0];
    ok(await call(`/api/agent/${r.body.slug}/marks/reject`, 'POST', { markId: done, by: MIKE }, H2), 'reject the insertion in italics');
    const after = await call(`/api/agent/${r.body.slug}/state`, 'GET', undefined, H2);
    assert.ok(after.body.markdown.includes('*Everything that needs you, in one place. An AI records your words and moves the ask to. Every action has a link to the exact page.*'), after.body.markdown.slice(0, 300));
  });

  console.log(`\n${passed} proof-dialect server tests passed`);
} finally {
  server.close();
  rmSync(temp, { recursive: true, force: true });
}

function diffHint(a: string, b: string): string {
  const al = a.split('\n');
  const bl = b.split('\n');
  for (let i = 0; i < Math.max(al.length, bl.length); i += 1) {
    if (al[i] !== bl[i]) return `first difference at line ${i + 1}:\n- ${al[i]}\n+ ${bl[i]}`;
  }
  return 'equal';
}
process.exit(0);
