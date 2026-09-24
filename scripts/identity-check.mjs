#!/usr/bin/env node
// Browser check for Proof Documents Step B6: marks and answers name a verified person or a named AI.
// Authorship: Claude Opus 5 (worker proof-identity), 2026-09-18, in the style of asks-check.mjs.
// Starts an isolated local server on the current dist/ build (run `npm run build` first) with the
// Documents library on (PROOF_LIBRARY_ENABLED=1, SOMA Auth off), adds a member with the library
// CLI and signs in through a real operator sign-in link (the proof_library_session cookie), so
// no test-only session injection is needed. Then drives Chromium in both review styles at 1440
// (desktop) and 390 (phone). Screenshots go to .preview/ (or --shots <dir>).
// Exit code 0 only if every check passes.
// Usage: node scripts/identity-check.mjs [--style playmaker|proof] [--shots dir]
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
const MIKE_EMAIL = 'mw@mike-wolf.com';
const MIKE = `human:${MIKE_EMAIL}`;
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `identity-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-identity-check-'));
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    PORT: String(port), COLLAB_EMBEDDED_WS: '1', PROOF_DEFAULT_REVIEW_STYLE: style,
    PROOF_FEEDBACK_ENABLED: '1', SOMA_FEEDBACK_ENDPOINT: 'http://127.0.0.1:9/feedback',
    PROOF_LIBRARY_ENABLED: '1',
    // Invite person (2026-09-19): this check covers guest marks, which count where a document's
    // guest setting is "edit"; the new default ("comment") is covered by invite-check.mjs.
    PROOF_GUEST_ACCESS_DEFAULT: 'edit',
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

const para = (tag) => `${tag} paragraph is plain text for reading; it is long enough to be a real line of the document.`;
// Lines: 0 Title | 1 Intro | 2 Middle | 3 Question | 4 Last
const markdown = ['# Identity check', para('Intro'), para('Middle'), 'Should identity ship tonight?', para('Last')].join('\n\n');
const L = { INTRO: 1, MIDDLE: 2, Q: 3 };

const waitFor = (page, fn, argument, timeout = 9000) => page.waitForFunction(fn, argument, { timeout, polling: 200 });

async function newContext(browser, base, options = {}) {
  const context = await browser.newContext(options);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  return context;
}

/** Signs Mike in through an operator sign-in link (the Documents library's own flow). */
async function signIn(context, cli, base) {
  const link = cli('signin-link', '--email', MIKE_EMAIL, '--origin', base, '--hours', '1');
  const page = await context.newPage();
  await page.goto(link);
  await page.waitForURL(url => url.pathname === '/', { timeout: 15_000 });
  const cookies = await context.cookies(base);
  assert.ok(cookies.some(c => c.name === 'proof_library_session' && c.httpOnly), 'the session cookie is set, HttpOnly');
  return page;
}

async function openDoc(page, base, slug) {
  await page.goto(`${base}/d/${slug}`);
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForFunction(() => window.__proofReadingWalk?.debugState().ready === true, null, { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(400);
  page.setDefaultTimeout(6000);
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
}

async function guestPage(browser, base, slug, name, options) {
  const context = await newContext(browser, base, options);
  await context.addInitScript(viewer => { try { localStorage.setItem('proof-share-viewer-name', viewer); } catch {} }, name);
  const page = await context.newPage();
  await openDoc(page, base, slug);
  return { context, page };
}

const markBox = (page, line) => page.locator(`.prw-right .plm-box[data-line="${line}"], .plm-menu`);
async function mark(page, line, label) {
  await page.locator(`.plm-dot[data-line="${line}"]`).click();
  const menu = markBox(page, line);
  await menu.waitFor({ state: 'visible' });
  await menu.getByRole('button', { name: label }).click();
  await page.waitForTimeout(150);
}

const serverMarks = (page, slug) => page.evaluate(async ({ s, h }) => {
  const r = await fetch(`/api/documents/${s}/line-marks`, { credentials: 'same-origin', headers: h });
  return (await r.json());
}, { s: slug, h: clientHeaders });

async function run(browser, style) {
  const { base, stop, cli } = await startServer(style);
  try {
    cli('add-member', '--name', 'Mike Wolf', '--email', MIKE_EMAIL);
    // ---------------------------------------------------------------- desktop 1440
    const tag = `identity-${style}-desktop`;
    const mikeCtx = await newContext(browser, base, { viewport: { width: 1440, height: 900 } });
    const mike = await signIn(mikeCtx, cli, base);
    activePage = mike;
    const created = await mike.evaluate(async md => {
      const r = await fetch('/library/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Identity check', markdown: md }) });
      return { status: r.status, body: await r.json() };
    }, markdown);
    assert.ok(created.status === 200 || created.status === 201, JSON.stringify(created));
    const slug = created.body.slug;
    await openDoc(mike, base, slug);

    await check(`${tag}: the right rail header says "Signed in as Mike Wolf" (verified)`, async () => {
      const me = mike.locator('.prw-right .prw-me');
      await me.waitFor({ state: 'visible' });
      assert.equal(await me.getAttribute('data-trust'), 'verified');
      assert.match(await me.innerText(), /Signed in as\s*Mike Wolf/);
      assert.equal(await me.locator('.prw-me-signin').count(), 0);
      await mike.screenshot({ path: path.join(shots, `${tag}-1-signed-in.png`) });
    });

    await check(`${tag}: a signed-in mark is attributed to the email`, async () => {
      await mark(mike, L.INTRO, /Agree/);
      await waitFor(mike, () => document.querySelector('.plm-dot[data-line="1"]')?.dataset.status === 'agreed');
      const body = await serverMarks(mike, slug);
      const m = body.lineMarks.find(x => x.anchor.ordinal === 1);
      assert.equal(m?.by, 'human:mw@mike-wolf.com', JSON.stringify(body.lineMarks));
      assert.deepEqual(body.owners, ['human:mw@mike-wolf.com']);
      assert.equal(body.viewer.canApprove, true, 'the creator is an owner');
    });

    // An agent key, minted in Mike's page the way "Add agent" mints it.
    const key = await mike.evaluate(async ({ s, h }) => {
      const r = await fetch(`/api/documents/${s}/agent-keys`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify({ label: 'Claude COS', runtime: 'Claude Opus 5 (Anthropic)' }) });
      return { status: r.status, body: await r.json() };
    }, { s: slug, h: clientHeaders });
    assert.equal(key.status, 201, JSON.stringify(key));
    const KEY = { 'Content-Type': 'application/json', ...clientHeaders, 'x-share-token': key.body.token };

    await check(`${tag}: an agent key cannot mark as a human (agent API and page API)`, async () => {
      const a = await fetch(`${base}/api/agent/${slug}/marks/line`, { method: 'POST', headers: KEY, body: JSON.stringify({ lineIndex: L.MIDDLE, status: 'seen', by: MIKE }) });
      assert.equal(a.status, 403);
      assert.equal((await a.json()).code, 'ACTOR_MISMATCH');
      const lines = (await serverMarks(mike, slug)).lineMarks;
      assert.ok(!lines.some(m => m.anchor.ordinal === L.MIDDLE), 'nothing was written');
      const ok = await fetch(`${base}/api/agent/${slug}/marks/line`, { method: 'POST', headers: KEY, body: JSON.stringify({ lineIndex: L.MIDDLE, status: 'seen' }) });
      assert.equal((await ok.json()).lineMark.by, 'ai:claude-cos');
    });

    const ask = await fetch(`${base}/api/agent/${slug}/asks`, { method: 'POST', headers: KEY, body: JSON.stringify({ lineIndex: L.Q, to: [MIKE], recommend: 'Yes: every check passes' }) });
    const askBody = await ask.json();
    assert.equal(ask.status, 200, JSON.stringify(askBody));
    const askId = askBody.ask.id;

    const g = await guestPage(browser, base, slug, 'Mike Wolf', { viewport: { width: 1440, height: 900 } });
    await check(`${tag}: a guest typing "Mike Wolf" is shown as a guest, unverified, with Sign in`, async () => {
      activePage = g.page;
      const me = g.page.locator('.prw-right .prw-me');
      await me.waitFor({ state: 'visible' });
      assert.equal(await me.getAttribute('data-trust'), 'guest');
      assert.match(await me.innerText(), /Mike Wolf\s*guest, unverified\s*—\s*Sign in/);
      assert.equal(await me.locator('.prw-me-signin').getAttribute('href'), '/');
      await g.page.screenshot({ path: path.join(shots, `${tag}-2-guest.png`) });
    });

    await check(`${tag}: a guest's mark is guest:<name> and shows "(guest)" to the team`, async () => {
      await mark(g.page, L.MIDDLE, /Agree/);
      await waitFor(g.page, () => document.querySelector('.plm-dot[data-line="2"]')?.dataset.status === 'agreed');
      const body = await serverMarks(g.page, slug);
      const m = body.lineMarks.find(x => x.anchor.ordinal === L.MIDDLE && x.by.startsWith('guest:'));
      assert.equal(m?.by, 'guest:Mike Wolf');
      assert.ok(!body.lineMarks.some(x => x.anchor.ordinal === L.MIDDLE && x.by === MIKE), 'the guest did not mark as Mike');
      await mike.evaluate(() => window.__proofLineMarks.refresh());
      await waitFor(mike, () => window.__proofLineMarks.debugState().team.includes('guest:Mike Wolf'));
      await mike.locator('.anv-people').click();
      await mike.getByRole('menuitem', { name: 'Who is here' }).click();
      await mike.locator('#who-dialog .acd-participant-statuses').waitFor({ state: 'visible', timeout: 8000 });
      const peopleText = await mike.locator('#who-dialog .acd-participant-statuses').innerText();
      assert.match(peopleText, /Mike Wolf \(guest\)/);
      const team = await mike.evaluate(() => window.__proofLineMarks.debugState().team);
      assert.ok(team.includes('guest:Mike Wolf'), JSON.stringify(team));
      assert.ok(team.some(actor => actor.includes('claude')), JSON.stringify(team));
      await mike.locator('#who-dialog .acd-close').click();
    });

    await check(`${tag}: an ask to human:<email> is not closed by the guest typing the name; the signed-in person closes it`, async () => {
      const inlineGuest = g.page.locator(`.ProseMirror .pask[data-ask-id="${askId}"]`);
      await inlineGuest.waitFor({ state: 'attached', timeout: 10_000 });
      assert.equal(await inlineGuest.locator('.pask-btn').count(), 0, 'the guest gets no answer buttons');
      // The guest calls the answer route directly, typing Mike's verified identity as "by",
      // with the question line's anchor as the page would send it.
      const state = await (await fetch(`${base}/api/agent/${slug}/state`, { headers: KEY })).json();
      const q = state.lines[L.Q];
      const anchor = { hash: q.hash, occurrence: q.occurrence, ordinal: q.index, kind: q.kind, excerpt: q.text.slice(0, 80) };
      const spoof = await g.page.evaluate(async ({ s, id, a, h }) => {
        const r = await fetch(`/api/documents/${s}/asks/${id}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify({ by: 'human:mw@mike-wolf.com', choice: 'yes', anchor: a }) });
        return r.json();
      }, { s: slug, id: askId, a: anchor, h: clientHeaders });
      assert.equal(spoof.answer?.by, 'guest:mw@mike-wolf.com', JSON.stringify(spoof));
      assert.equal(spoof.askedOf, false);
      let list = await (await fetch(`${base}/api/agent/${slug}/asks`, { headers: KEY })).json();
      assert.deepEqual(list.asks.find(a => a.id === askId).openFor, [MIKE]);
      const control = mike.locator(`.ProseMirror .pask[data-ask-id="${askId}"]`);
      await mike.evaluate(() => window.__proofLineMarks.refresh());
      await control.locator('.pask-btn', { hasText: /^Yes$/ }).click();
      await waitFor(mike, id => window.__proofLineMarks.debugState().asks.find(a => a.id === id)?.outcome === 'yes', askId);
      list = await (await fetch(`${base}/api/agent/${slug}/asks`, { headers: KEY })).json();
      const row = list.asks.find(a => a.id === askId);
      assert.equal(row.status, 'yes');
      assert.equal(row.people[0].actor, MIKE);
      await mike.screenshot({ path: path.join(shots, `${tag}-3-answered.png`) });
    });
    await g.context.close();
    await mikeCtx.close();

    // ---------------------------------------------------------------- phone 390
    const ptag = `identity-${style}-phone-390x844`;
    const viewport = { width: 390, height: 844 };
    const phoneOpts = { ...devices['iPhone 13'], viewport, screen: viewport, hasTouch: true, isMobile: true };
    const pCtx = await newContext(browser, base, phoneOpts);
    const pMike = await signIn(pCtx, cli, base);
    await openDoc(pMike, base, slug);
    activePage = pMike;
    await check(`${ptag}: the reading sheet's header says who you are (signed in)`, async () => {
      await pMike.evaluate(() => window.__proofReadingWalk.openSheet('right'));
      const me = pMike.locator('.prw-right.prw-sheet-open .prw-me');
      await me.waitFor({ state: 'visible' });
      assert.match(await me.innerText(), /Signed in as\s*Mike Wolf/);
      const info = await pMike.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, r: document.querySelector('.prw-right .prw-me').getBoundingClientRect().toJSON() }));
      assert.ok(info.sw <= info.cw + 1, `no sideways scroll (${info.sw} > ${info.cw})`);
      assert.ok(info.r.right <= info.cw + 1, `the header fits: ${JSON.stringify(info.r)}`);
      await pMike.screenshot({ path: path.join(shots, `${ptag}-1-signed-in.png`) });
    });
    await pCtx.close();
    const pg = await guestPage(browser, base, slug, 'Ada', phoneOpts);
    activePage = pg.page;
    await check(`${ptag}: a guest on the phone sees "guest, unverified" and Sign in; a tap-mark is guest:Ada`, async () => {
      await pg.page.evaluate(() => window.__proofReadingWalk.openSheet('right'));
      const me = pg.page.locator('.prw-right.prw-sheet-open .prw-me');
      await me.waitFor({ state: 'visible' });
      assert.match(await me.innerText(), /Ada\s*guest, unverified\s*—\s*Sign in/);
      await pg.page.screenshot({ path: path.join(shots, `${ptag}-2-guest.png`) });
      await pg.page.evaluate(() => window.__proofReadingWalk.closeSheets());
      await pg.page.locator('.plm-dot[data-line="4"]').tap();
      const sheet = pg.page.locator('.prw-right.prw-sheet-open');
      await sheet.waitFor({ state: 'visible' });
      await sheet.getByRole('button', { name: /Agree/ }).tap();
      await waitFor(pg.page, () => document.querySelector('.plm-dot[data-line="4"]')?.dataset.status === 'agreed');
      const body = await serverMarks(pg.page, slug);
      assert.ok(body.lineMarks.some(m => m.anchor.ordinal === 4 && m.by === 'guest:Ada'), JSON.stringify(body.lineMarks.map(m => [m.anchor.ordinal, m.by])));
    });
    await pg.context.close();
  } finally {
    await stop();
  }
}

const browser = await chromium.launch();
try {
  for (const style of styles) await run(browser, style);
} finally {
  await browser.close();
}
console.log(`\n${results.length - failures}/${results.length} identity checks passed`);
process.exit(failures ? 1 : 0);
