#!/usr/bin/env node
import { showWholeAccord } from './review-ui.mjs';
// Check for the Accord dialect (2026-09-19; named 2026-09-21, machine value proof-dialect): a Mike-like document on a running server (Mike signs in
// and marks lines, answers an ask, objects and tags a decision line; Claude, through its agent key,
// suggests, comments, flags, sets a time-to-live, reads with evidence and tags context) is
// exported as an Accord dialect file, re-imported with the operator key, and the two documents' /state
// are compared (every live mark the same, by the same identity, on the same line). The imported
// document's export must equal the first export. Then the page: "Download as Accord (.accord.md)"
// from the Share menu at 1440 and from the ⋯ menu on a 390 phone, both review styles, downloads
// the same file, named <title>.accord.md. Polish pass (2026-09-21): format=accord-dialect is an
// alias of proof-dialect (export and import), and File › Import takes .accord.md and .proof.md.
// Authorship: Claude Opus 5 (worker proof-dialect), 2026-09-19, in the style of line-tiers-check.mjs.
// Starts an isolated local server on the current dist/ build (run `npm run build` first).
// Usage: node scripts/dialect-check.mjs [--style playmaker|proof] [--shots dir]
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const shots = arg('--shots') || path.join(root, '.preview');
mkdirSync(shots, { recursive: true });
const styles = arg('--style') ? [arg('--style')] : ['playmaker', 'proof'];

const clientHeaders = { 'X-Proof-Client-Version': '0.33.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
const OPERATOR_KEY = `dialect-check-${process.pid}`;
const MIKE_EMAIL = 'mw@mike-wolf.com';
const MIKE = `human:${MIKE_EMAIL}`;
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n').slice(0, 10).join(' | ')}`);
    await activePage?.screenshot({ path: path.join(shots, `dialect-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-dialect-check-'));
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    PORT: String(port), COLLAB_EMBEDDED_WS: '1', PROOF_DEFAULT_REVIEW_STYLE: style,
    PROOF_FEEDBACK_ENABLED: '1', SOMA_FEEDBACK_ENDPOINT: 'http://127.0.0.1:9/feedback',
    PROOF_LIBRARY_ENABLED: '1', PROOF_SHARE_MARKDOWN_API_KEY: OPERATOR_KEY,
    DATABASE_PATH: path.join(temp, 'test.db'), SNAPSHOT_DIR: path.join(temp, 'snapshots'),
  };
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: root, env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => { child.kill('SIGTERM'); await new Promise(r => setTimeout(r, 300)); rmSync(temp, { recursive: true, force: true }); };
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const health = await fetch(`${base}/health`).catch(() => null);
    if (health?.ok) {
      const cli = (...args) => {
        const r = spawnSync(process.execPath, ['--import', 'tsx', 'server/library/cli.ts', ...args], { cwd: root, env, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        return r.stdout.trim();
      };
      return { base, stop, cli };
    }
    await new Promise(r => setTimeout(r, 150));
  }
  await stop();
  throw new Error('server did not start');
}

// A Mike-like document: a short plan with a decision table and next steps.
const markdown = [
  '# Q3 launch plan',
  'We launch in the second quarter, after the beta closes.',
  'The budget is fixed at ten thousand dollars for the first year.',
  'Background: the team is five people across two cities.',
  '- Hire two engineers\n- Book the venue\n- Brief the press',
  '| Item | Cost |\n|---|---|\n| Venue | 4000 |\n| Travel | 1500 |',
  'Next steps: Eric drafts the invitation and Mike signs off.',
  'Last line of the plan.',
].join('\n\n');

async function newContext(browser, base, options = {}) {
  const context = await browser.newContext({ acceptDownloads: true, ...options });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  return context;
}

async function signIn(context, cli, base, email) {
  const link = cli('signin-link', '--email', email, '--origin', base, '--hours', '1');
  const page = await context.newPage();
  await page.goto(link);
  await page.waitForURL(url => url.pathname === '/', { timeout: 15_000 });
  return page;
}

async function openDoc(page, base, slug) {
  await page.goto(`${base}/d/${slug}`);
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForTimeout(300);
  page.setDefaultTimeout(8000);
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  await showWholeAccord(page);
}

/** An agent call; writes retry while a live page's newest typing is being saved (409 PROJECTION_STALE / STALE_BASE). */
const agent = async (base, slug, headers, method, route, body) => {
  for (let attempt = 0; ; attempt += 1) {
    const r = await fetch(`${base}/api/agent/${slug}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(async res => ({ status: res.status, text: await res.clone().text(), body: await res.json().catch(() => ({})) }));
    if (r.status !== 409 || !['PROJECTION_STALE', 'STALE_BASE', 'LIVE_DOC_UNAVAILABLE'].includes(r.body.code) || attempt > 40) return r;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
};
const exportText = (base, slug, headers, format = 'proof-dialect') => fetch(`${base}/api/agent/${slug}/export?format=${format}`, { headers }).then(async r => ({ status: r.status, text: await r.text() }));
const ok = (r, what) => assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text?.slice(0, 300) ?? JSON.stringify(r.body).slice(0, 300)}`);

async function mintKey(page, slug, label) {
  const key = await page.evaluate(async ({ s, h, label }) => {
    const r = await fetch(`/api/documents/${s}/agent-keys`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify({ label, runtime: 'Claude Opus 5 (Anthropic)' }) });
    return { status: r.status, body: await r.json() };
  }, { s: slug, h: clientHeaders, label });
  assert.equal(key.status, 201, JSON.stringify(key));
  return { 'Content-Type': 'application/json', ...clientHeaders, 'x-share-token': key.body.token };
}

/** Mike's own page actions (a signed-in session, same origin). */
async function mikeDoes(page, slug, route, body) {
  const r = await page.evaluate(async ({ s, route, body, h }) => {
    const res = await fetch(`/api/documents/${s}${route}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) });
    return { status: res.status, text: await res.text() };
  }, { s: slug, route, body, h: clientHeaders });
  assert.ok(r.status >= 200 && r.status < 300, `${route}: ${r.status} ${r.text.slice(0, 300)}`);
  return JSON.parse(r.text || '{}');
}
const anchorOf = (page, startsWith) => page.evaluate((prefix) => {
  const line = window.__proofLineMarks.lineList().find(l => l.text.startsWith(prefix));
  if (!line) return null;
  return { hash: line.hash, occurrence: line.occurrence, ordinal: line.index, kind: line.kind, excerpt: line.text.slice(0, 80), text: line.text };
}, startsWith);

function diffHint(a, b) {
  const al = a.split('\n');
  const bl = b.split('\n');
  for (let i = 0; i < Math.max(al.length, bl.length); i += 1) if (al[i] !== bl[i]) return `line ${i + 1}: - ${al[i]} + ${bl[i]}`;
  return 'equal';
}

/** The live marks of a document, as comparable facts (no ids, no timestamps of creation). */
function facts(state) {
  const lineText = (i) => (state.lines ?? [])[i]?.text ?? null;
  const out = [];
  for (const m of state.lineMarks ?? []) out.push(`line ${m.by} ${m.status} "${m.anchor.text ?? m.anchor.excerpt}" ${m.at} ${m.via ?? ''} ${m.reason ?? ''} ${m.why ?? ''} ${m.evidence ?? ''}`);
  for (const [, m] of Object.entries(state.marks ?? {})) {
    if (m.kind === 'comment') out.push(`comment ${m.by} "${m.quote}" "${m.text}" resolved=${m.resolved === true} ${m.createdAt} replies=${JSON.stringify((m.replies ?? m.thread ?? []).map(r => [r.by, r.text, r.at]))}`);
    else if (['insert', 'delete', 'replace'].includes(m.kind) && (m.status ?? 'pending') === 'pending') out.push(`suggest ${m.kind} ${m.by} "${m.quote}" "${m.content ?? ''}" ${m.createdAt}`);
  }
  for (const t of state.tiers ?? []) if (t.tagged) out.push(`tier ${t.tier} ${t.by} "${lineText(t.lineIndex)}" proposed=${t.proposed}`);
  for (const f of state.flags ?? []) out.push(`flag ${f.by} "${lineText(f.lineIndex)}" ${f.note}`);
  for (const t of state.ttls ?? []) out.push(`ttl ${t.by} "${lineText(t.lineIndex)}" ${t.ttl}`);
  for (const a of state.asks ?? []) out.push(`ask ${a.by} "${a.question}" ${a.recommend} to=${a.to.join(',')} ${JSON.stringify(a.people.map(p => [p.actor, p.state, p.choice, p.words]))}`);
  for (const o of state.objections ?? []) out.push(`objection ${o.by} ${o.reason} ${o.condition} ${o.lines.map(l => l.text).join(' / ')}`);
  for (const b of state.bundles ?? []) out.push(`bundle ${b.id} ${b.title} ${b.members.length}`);
  out.push(`issues ${state.alignment?.counts ? JSON.stringify(state.alignment.counts) : ''}`);
  return out.sort();
}

async function run(browser, style) {
  const { base, stop, cli } = await startServer(style);
  try {
    cli('add-member', '--name', 'Mike Wolf', '--email', MIKE_EMAIL);
    const tag = `dialect-${style}-desktop-1440`;
    const ctx = await newContext(browser, base, { viewport: { width: 1440, height: 900 } });
    const mike = await signIn(ctx, cli, base, MIKE_EMAIL);
    activePage = mike;
    const created = await mike.evaluate(async md => {
      const r = await fetch('/library/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Q3 launch plan', markdown: md }) });
      return { status: r.status, body: await r.json() };
    }, markdown);
    assert.ok(created.status === 200 || created.status === 201, JSON.stringify(created));
    const slug = created.body.slug;
    await mike.goto(`${base}/d/${slug}`);
    await mike.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 20_000 });
    const CLAUDE = await mintKey(mike, slug, 'Claude');

    // ------------------------------------------------------------ build the Mike-like marks
    ok(await agent(base, slug, CLAUDE, 'POST', '/marks/suggest-replace', { quote: 'second quarter', content: 'third quarter', why: 'The beta slipped a month', bundle: { id: 'q3', title: 'Move the launch to Q3', why: 'Beta slipped' } }), 'replace');
    ok(await agent(base, slug, CLAUDE, 'POST', '/marks/suggest-insert', { quote: 'Brief the press', content: ' and the partners', why: 'Partners asked to be told first' }), 'insert');
    ok(await agent(base, slug, CLAUDE, 'POST', '/marks/suggest-delete', { quote: 'for the first year', why: 'The budget is annual anyway' }), 'delete');
    const comment = await agent(base, slug, CLAUDE, 'POST', '/marks/comment', { by: 'ai:claude', quote: 'Book the venue', text: 'Which venue: the hall or the loft?' });
    ok(comment, 'comment');
    ok(await agent(base, slug, CLAUDE, 'POST', '/marks/reply', { markId: comment.body.markId, by: 'ai:claude', text: 'The hall is cheaper.' }), 'reply');
    ok(await agent(base, slug, CLAUDE, 'POST', '/marks/line', { status: 'seen', lines: [{ quote: 'Background:' }, { quote: 'Last line' }], evidence: 'Read it and compared it with the brief' }), 'claude reads');
    ok(await agent(base, slug, CLAUDE, 'POST', '/tiers', { tier: 'context', lines: [{ quote: 'Background:' }] }), 'context tag');
    ok(await agent(base, slug, CLAUDE, 'POST', '/flags', { quote: 'The budget is fixed', note: 'Check with finance' }), 'flag');
    ok(await agent(base, slug, CLAUDE, 'POST', '/ttl', { quote: 'Next steps:', ttl: '14d' }), 'ttl');
    const ask = await agent(base, slug, CLAUDE, 'POST', '/asks', { quote: 'Next steps:', to: [MIKE], recommend: 'Yes: the invitation is ready to draft', ifYes: 'Eric starts today' });
    ok(ask, 'ask');
    await mike.reload(); await showWholeAccord(mike);
    await mike.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 20_000 });
    await mike.waitForFunction(() => window.__proofLineMarks.lineList().some(l => l.text.startsWith('Next steps')), null, { timeout: 10_000 });
    await mikeDoes(mike, slug, '/line-marks', { by: MIKE, status: 'agreed', via: 'key', anchor: await anchorOf(mike, 'Q3 launch plan') });
    await mikeDoes(mike, slug, '/line-marks', { by: MIKE, status: 'rejected', reason: 'Too vague: say which dollars', via: 'click', anchor: await anchorOf(mike, 'The budget is fixed') });
    await mikeDoes(mike, slug, '/line-marks', { by: MIKE, status: 'approved', via: 'click', anchor: await anchorOf(mike, 'Venue | 4000') });
    await mikeDoes(mike, slug, `/asks/${ask.body.ask.id}/answer`, { by: MIKE, choice: 'yes', words: 'Go ahead', anchor: await anchorOf(mike, 'Next steps') });
    await mikeDoes(mike, slug, '/objections', { by: MIKE, lines: [await anchorOf(mike, 'Hire two engineers'), await anchorOf(mike, 'Book the venue')], reason: 'Wrong order', condition: 'book the venue first' });
    await mikeDoes(mike, slug, '/tiers', { by: MIKE, tier: 'decision', reason: 'Money', anchor: await anchorOf(mike, 'Travel | 1500') });

    // ------------------------------------------------------------ export → import → compare
    let first = '';
    let importedSlug = '';
    let importedSecret = '';
    await check(`${tag}: export writes every mark; the operator import recreates the same /state`, async () => {
      const ex = await exportText(base, slug, CLAUDE);
      assert.equal(ex.status, 200, ex.text);
      first = ex.text;
      for (const needle of ['{changed @claude', '{comment @claude', '{reply @claude', '{agreed @mw', '{rejected @mw', '{approved @mw', '{context @claude', '{decision @mw', '{uncertain @claude', '{ttl @claude for=14d since=', '{ask @claude to=@mw', '{answer @mw choice=yes', '{objection @mw id=o1', 'bundles:']) {
        assert.ok(first.includes(needle), `export has ${needle}\n${first}`);
      }
      const imported = await fetch(`${base}/share/markdown`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': OPERATOR_KEY }, body: JSON.stringify({ markdown: first, format: 'proof-dialect' }) }).then(r => r.json());
      assert.equal(imported.success, true, JSON.stringify(imported));
      assert.equal(imported.import.authority, 'operator');
      assert.deepEqual(imported.import.warnings, []);
      importedSlug = imported.slug;
      importedSecret = imported.ownerSecret;
      const owner = { ...clientHeaders, 'x-share-token': importedSecret };
      const a = await agent(base, slug, CLAUDE, 'GET', '/state');
      const b = await agent(base, importedSlug, owner, 'GET', '/state');
      assert.equal(b.body.markdown, a.body.markdown, 'the same text (pending insertions included)');
      const fa = facts(a.body);
      const fb = facts(b.body);
      const onlyA = fa.filter(x => !fb.includes(x));
      const onlyB = fb.filter(x => !fa.includes(x));
      assert.deepEqual({ onlyA, onlyB }, { onlyA: [], onlyB: [] });
      assert.equal(b.body.alignment.counts.total ?? b.body.issues.length, a.body.alignment.counts.total ?? a.body.issues.length);
    });
    await check(`${tag}: export → import → export is stable`, async () => {
      const again = await exportText(base, importedSlug, { ...clientHeaders, 'x-share-token': importedSecret });
      assert.equal(again.status, 200);
      assert.equal(again.text, first);
    });
    await check(`${tag}: format=accord-dialect is an alias of proof-dialect; the file is <title>.accord.md; links keep proof-dialect`, async () => {
      const r = await fetch(`${base}/api/agent/${slug}/export?format=accord-dialect`, { headers: CLAUDE });
      assert.equal(r.status, 200);
      assert.equal(await r.text(), (await exportText(base, slug, CLAUDE)).text);
      assert.match(r.headers.get('content-disposition') ?? '', /filename="Q3-launch-plan\.accord\.md"/);
      const bad = await fetch(`${base}/api/agent/${slug}/export?format=nonsense`, { headers: CLAUDE });
      assert.equal(bad.status, 400);
      assert.match((await bad.json()).error, /proof-dialect, criticmarkup, plain \(accord-dialect is accepted for proof-dialect\)/);
      const state = await agent(base, slug, CLAUDE, 'GET', '/state');
      const links = JSON.stringify(state.body._links ?? state.body.links ?? {});
      if (links.includes('export')) assert.ok(links.includes('format=proof-dialect') && !links.includes('accord-dialect'), links);
      const imported = await fetch(`${base}/share/markdown`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': OPERATOR_KEY }, body: JSON.stringify({ markdown: first, format: 'accord-dialect' }) }).then(r => r.json());
      assert.equal(imported.success, true, JSON.stringify(imported));
      assert.equal(imported.import.authority, 'operator');
      const again = await exportText(base, imported.slug, { ...clientHeaders, 'x-share-token': imported.ownerSecret });
      assert.equal(again.text, first, 'an accord-dialect import is the same as a proof-dialect one');
    });

    // ------------------------------------------------------------ the page: Share menu download
    await openDoc(mike, base, slug);
    // Accord layout stage 2: the download lives in File (and in the Share dialog's Link tab).
    await check(`${tag}: File › "Download as Accord (.accord.md)" saves the same file`, async () => {
      await mike.locator('#accord-menubar .amb-top[data-menu="file"]').click();
      const item = mike.getByRole('menuitem', { name: /Download as Accord \(\.accord\.md\)/ });
      await item.waitFor({ state: 'visible' });
      await mike.screenshot({ path: path.join(shots, `${tag}-1-menu.png`) });
      const [download] = await Promise.all([mike.waitForEvent('download'), item.click()]);
      assert.match(download.suggestedFilename(), /^Q3-launch-plan\.accord\.md$/);
      const file = readFileSync(await download.path(), 'utf8');
      const pageExport = await mike.evaluate(async ({ s, h }) => (await fetch(`/api/documents/${s}/export`, { credentials: "same-origin", headers: h })).text(), { s: slug, h: clientHeaders });
      assert.equal(file, pageExport, `download = page export: ${diffHint(pageExport, file)}`);
      // Opening the page reads lines (dwell marks), so compare with a fresh export by Claude's key.
      const fresh = await exportText(base, slug, CLAUDE);
      assert.equal(file, fresh.text, `Mike (signed in) gets the same file as the API export: ${diffHint(fresh.text, file)}`);
      assert.ok(file.includes('{rejected @mw') && file.includes('{changed @claude'), 'the marks are in it');
    });
    // Polish pass: File › Import takes <title>.accord.md (this file) and an older <title>.proof.md.
    await check(`${tag}: File › Import takes a .accord.md file (its marks kept) and a .proof.md file (title without the suffix)`, async () => {
      const importVia = async (name, text) => {
        await mike.locator('#accord-menubar .amb-top[data-menu="file"]').click();
        const [chooser] = await Promise.all([mike.waitForEvent('filechooser'), mike.getByRole('menuitem', { name: /Import \.md/ }).click()]);
        const before = mike.url();
        await chooser.setFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from(text, 'utf8') });
        await mike.waitForURL(url => url.toString() !== before && /\/d\//.test(url.toString()), { timeout: 15_000 });
        return mike.url().match(/\/d\/([^/?#]+)/)[1];
      };
      const accordSlug = await importVia('Q3-launch-plan.accord.md', first);
      const accordExport = await mike.evaluate(async ({ s, h }) => (await fetch(`/api/documents/${s}/export`, { credentials: 'same-origin', headers: h })).text(), { s: accordSlug, h: clientHeaders });
      assert.ok(accordExport.includes('{rejected @mw'), `Mike's own marks came in with the .accord.md file\n${accordExport.slice(0, 600)}`);
      const proofSlug = await importVia('Notes-from-Eric.proof.md', 'Plain line one, written before the rename.\n\nPlain line two.\n');
      assert.notEqual(proofSlug, accordSlug);
      await mike.waitForFunction(() => /Notes-from-Eric/.test(document.title), null, { timeout: 10_000 });
      assert.ok(!/\.proof/.test(await mike.title()), `the .proof suffix is in the title: ${await mike.title()}`);
    });
    await ctx.close();

    // ------------------------------------------------------------ phone 390: ⋯ → Download
    const ptag = `dialect-${style}-phone-390x844`;
    const viewport = { width: 390, height: 844 };
    const phoneCtx = await newContext(browser, base, { ...devices['iPhone 13'], viewport, screen: viewport, hasTouch: true, isMobile: true });
    const phone = await signIn(phoneCtx, cli, base, MIKE_EMAIL);
    activePage = phone;
    await openDoc(phone, base, slug);
    await check(`${ptag}: ⋯ → Download (Accord .accord.md) saves the same file; touch-sized; no sideways scroll`, async () => {
      await phone.locator('#share-banner .share-pill-overflow').tap();
      const item = phone.locator('.proof-share-overflow-menu [role="menuitem"]', { hasText: 'Download' });
      await item.waitFor({ state: 'visible' });
      const box = await item.boundingBox();
      assert.ok(box.height >= 40, `touch target ${box.height}`);
      assert.ok(box.x >= 0 && box.x + box.width <= 390, `fits ${JSON.stringify(box)}`);
      const sw = await phone.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      assert.ok(sw[0] <= sw[1] + 1, `no sideways scroll ${sw}`);
      await phone.screenshot({ path: path.join(shots, `${ptag}-1-menu.png`) });
      const [download] = await Promise.all([phone.waitForEvent('download'), item.tap()]);
      assert.match(download.suggestedFilename(), /^Q3-launch-plan\.accord\.md$/);
      const file = readFileSync(await download.path(), 'utf8');
      const fresh = await exportText(base, slug, CLAUDE);
      assert.equal(file, fresh.text);
    });
    await phoneCtx.close();

    // ------------------------------------------------------------ typed insertions (2026-09-19)
    // Interrupted typing in suggestion mode (the Waiting on Mike export): adjacent pieces, a
    // whitespace-only one, pieces inside italics, a heading and link text, and an orphan. The file
    // imports byte-identically, and in the editor every piece is one suggestion over its own words.
    const typedFile = typedInsertionsFile();
    const imp = await fetch(`${base}/share/markdown`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': OPERATOR_KEY }, body: JSON.stringify({ markdown: typedFile, format: 'proof-dialect' }) }).then(r => r.json());
    const typedOwner = { ...clientHeaders, 'x-share-token': imp.ownerSecret };
    await check(`dialect-${style}: typed insertions import as they are and export byte-identically`, async () => {
      assert.equal(imp.success, true, JSON.stringify(imp).slice(0, 300));
      assert.deepEqual(imp.import.warnings, []);
      assert.equal(imp.import.created.suggestions, 17);
      assert.equal(imp.import.created.orphans, 1);
      const again = await exportText(base, imp.slug, typedOwner);
      assert.equal(again.text, typedFile, diffHint(typedFile, again.text));
    });
    const changedOnly = text => (text.match(/\[[^\]\n]*\]\{changed [^}]*\}|\{changed [^}]*orphan=1[^}]*\}/g) ?? []).join('\n');
    for (const [vtag, options] of [
      ['desktop-1440', { viewport: { width: 1440, height: 900 } }],
      ['phone-390x844', { ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
    ]) {
      const tctx = await newContext(browser, base, options);
      const page = await tctx.newPage();
      activePage = page;
      await openDoc(page, base, `${imp.slug}?token=${encodeURIComponent(imp.ownerSecret)}`);
      await check(`dialect-${style}-${vtag}: every typed insertion is one suggestion over its own words (italics, heading, link kept)`, async () => {
        const st = (await agent(base, imp.slug, typedOwner, 'GET', '/state')).body;
        const orphans = new Set((st.orphanedMarks ?? []).map(o => o.id));
        const inserts = Object.entries(st.marks).filter(([id, m]) => m.kind === 'insert' && !orphans.has(id));
        assert.equal(inserts.length, 16, JSON.stringify({ keys: Object.keys(st), n: Object.keys(st.marks ?? {}).length, orphans: [...orphans].length }));
        await page.waitForFunction(n => (window.proof?.getAllMarks?.() ?? []).filter(m => m.kind === 'insert' && m.data?.status === 'pending').length >= n, 16, { timeout: 10_000 });
        for (const [id, m] of inserts) {
          const text = await page.evaluate(i => [...document.querySelectorAll(`.ProseMirror [data-mark-id="${i}"]`)].map(e => e.textContent).join(''), id);
          assert.equal(text, m.content, `insertion ${JSON.stringify(m.content)} is decorated over exactly its words (got ${JSON.stringify(text)})`);
        }
        const editor = await page.evaluate(() => document.querySelector('.ProseMirror')?.innerText ?? '');
        assert.ok(!/\{changed|\]\{/.test(editor), 'no dialect syntax in the editor');
        assert.ok(await page.evaluate(() => [...document.querySelectorAll('.ProseMirror em')].some(e => e.textContent.includes('moves the ask to Done.'))), 'the insertion stays inside the italics');
        assert.ok(await page.evaluate(() => [...document.querySelectorAll('.ProseMirror a')].some(e => e.textContent === 'add a webhook endpoint')), 'and inside the link text');
        const sw = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
        assert.ok(sw[0] <= sw[1] + 1, `no sideways scroll ${sw}`);
        const anonymous = page.getByRole('button', { name: 'Continue anonymously' });
        if (await anonymous.count()) { await anonymous.first().click(); await page.waitForTimeout(300); }
        await page.screenshot({ path: path.join(shots, `dialect-${style}-${vtag}-typed.png`) });
        // Opening the page must not move any suggestion (it may add reading marks, and the editor
        // writes "sk\_live" as the equivalent "sk_live", so escapes are not compared).
        const after = await exportText(base, imp.slug, typedOwner);
        const unescaped = t => changedOnly(t).replace(/\\(.)/g, '$1');
        assert.equal(unescaped(after.text), unescaped(typedFile));
      });
      await tctx.close();
    }
  } finally {
    await stop();
  }
}

/** A Proof Document with typed insertions, in the exact form export writes. */
function typedInsertionsFile() {
  const at = s => `at=2026-09-18T02:00:${String(s).padStart(2, '0')}.000Z`;
  const c = (text, s) => `[${text}]{changed @mw ${at(s)}}`;
  return [
    '---',
    'proof:',
    '  version: 1',
    '  title: Typed insertions',
    '  handles:',
    '    mw: "human:mw@mike-wolf.com"',
    '---',
    '',
    '# Waiting on Mike',
    '',
    `*Everything that needs you. An AI moves the ask to${c(' Done', 20)}. Every action has a link.*`,
    '',
    `### Roll the ${c('full ', 21)}live key`,
    '',
    `It breaks nothing of ours.${c(' sk', 1)}${c('\\_live has no', 2)}${c(' Roll', 3)}${c(' Key o', 4)}${c('pt', 5)}${c('i', 6)}${c('on', 7)}`,
    '',
    `Ruled (typed inline):${c(' ', 10)}“${c('I have ', 11)}${c('res', 12)}${c('et my ', 13)}${c('usag', 14)}${c('e so we are OK', 15)}”`,
    '',
    // An orphan goes on the line of the same person's nearest-in-time placed insertion ("p").
    `Then [add a webhook end${c('p', 22)}oint](https://example.test/webhooks) for the site. {changed @mw kind=insert to="jere to " orphan=1 ${at(32)}}`,
    '',
  ].join('\n');
}

const browser = await chromium.launch();
try {
  for (const style of styles) await run(browser, style);
} finally {
  await browser.close();
}
console.log(`\n${results.length - failures}/${results.length} dialect checks passed`);
process.exit(failures ? 1 : 0);
