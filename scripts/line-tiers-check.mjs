#!/usr/bin/env node
// Browser check for line tiers (Mike, 2026-09-19): decision lines and context lines. An untagged
// document looks as before (no ◆); an AI (agent key) tags setup lines context, which shows as "AI
// proposed context"; context lines are quieter, decision lines get a ◆; a context line an AI read is
// not an Issue for Mike, an unread one still is; Mike confirms from the rail box; D flips the focus
// line; J / K skip covered context lines; "Show only decisions" folds them (view only). Desktop 1440
// and phone 390, both review styles.
// Authorship: Claude Opus 5 (worker proof-tiers), 2026-09-19, in the style of proxy-marks-check.mjs.
// Starts an isolated local server on the current dist/ build (run `npm run build` first).
// Usage: node scripts/line-tiers-check.mjs [--style playmaker|proof] [--shots dir]
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

const clientHeaders = { 'X-Proof-Client-Version': '0.31.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
const MIKE_EMAIL = 'mw@mike-wolf.com';
const MIKE = `human:${MIKE_EMAIL}`;
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n').slice(0, 8).join(' | ')}`);
    await activePage?.screenshot({ path: path.join(shots, `tiers-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-tiers-check-'));
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    PORT: String(port), COLLAB_EMBEDDED_WS: '1', PROOF_DEFAULT_REVIEW_STYLE: style,
    PROOF_FEEDBACK_ENABLED: '1', SOMA_FEEDBACK_ENDPOINT: 'http://127.0.0.1:9/feedback',
    PROOF_LIBRARY_ENABLED: '1',
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

const markdown = [
  '# Tiers check',                                                                        // 0
  'This plan explains how the team will work together over the coming year.',             // 1 context (read by Claude)
  'Background: the team is five people spread across two cities and three time zones.',   // 2 context (read by Claude)
  'The budget is fixed at ten thousand dollars for the first year.',                      // 3 decision
  'Launch is planned for the second quarter of next year.',                              // 4 decision
  'History: the previous plan was written two years ago and never finished.',             // 5 context (nobody read it)
  'Closing: we review this plan again at the end of the quarter.',                       // 6 decision
].join('\n\n');
const L = { TITLE: 0, INTRO: 1, BACKGROUND: 2, BUDGET: 3, LAUNCH: 4, HISTORY: 5, CLOSING: 6 };

const waitFor = (page, fn, argument, timeout = 15000) => page.waitForFunction(fn, argument, { timeout, polling: 200 });

async function newContext(browser, base, options = {}) {
  const context = await browser.newContext(options);
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
  await page.waitForFunction(() => window.__proofReadingWalk?.debugState().ready === true, null, { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(300);
  page.setDefaultTimeout(6000);
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
}

const call = (base, slug, headers, method, route, body) => fetch(`${base}/api/agent/${slug}${route}`, {
  method, headers, body: body === undefined ? undefined : JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json() }));
const lm = page => page.evaluate(() => window.__proofLineMarks.debugState());
const tierState = async page => (await lm(page)).tiers;
const issues = async page => (await lm(page)).issues;
const focus = page => page.evaluate(() => window.__proofReadingWalk.debugState().focus);
const lineClass = (page, i) => page.evaluate(i => {
  const lines = window.__proofLineMarks.lineList();
  const view = window.__proofLineMarks.editorView();
  const dom = view.nodeDOM(lines[i].pos);
  return dom ? { cls: dom.className, h: dom.getBoundingClientRect().height, color: getComputedStyle(dom).color } : null;
}, i);
const dot = (page, i) => page.evaluate(i => {
  const d = document.querySelector(`.plm-dot[data-line="${i}"]`);
  return d ? { tier: d.dataset.tier ?? null, diamond: d.querySelector('.plm-tier')?.textContent ?? null, proposed: d.dataset.tierProposed ?? null } : null;
}, i);

async function mintKey(page, slug, label) {
  const key = await page.evaluate(async ({ s, h, label }) => {
    const r = await fetch(`/api/documents/${s}/agent-keys`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify({ label, runtime: 'Claude Opus 5 (Anthropic)' }) });
    return { status: r.status, body: await r.json() };
  }, { s: slug, h: clientHeaders, label });
  assert.equal(key.status, 201, JSON.stringify(key));
  return { 'Content-Type': 'application/json', ...clientHeaders, 'x-share-token': key.body.token };
}

async function run(browser, style) {
  const { base, stop, cli } = await startServer(style);
  try {
    cli('add-member', '--name', 'Mike Wolf', '--email', MIKE_EMAIL);
    const tag = `tiers-${style}-desktop-1440`;
    const ctx = await newContext(browser, base, { viewport: { width: 1440, height: 900 } });
    const mike = await signIn(ctx, cli, base, MIKE_EMAIL);
    activePage = mike;
    const created = await mike.evaluate(async md => {
      const r = await fetch('/library/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Tiers check', markdown: md }) });
      return { status: r.status, body: await r.json() };
    }, markdown);
    assert.ok(created.status === 200 || created.status === 201, JSON.stringify(created));
    const slug = created.body.slug;
    await mike.goto(`${base}/d/${slug}`);
    await mike.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 20_000 });
    const CLAUDE = await mintKey(mike, slug, 'Claude');
    // Claude reads every line with evidence except the History line.
    const readLines = Object.values(L).filter(i => i !== L.HISTORY).map(i => ({ lineIndex: i }));
    const read = await call(base, slug, CLAUDE, 'POST', '/marks/line', { status: 'seen', lines: readLines, evidence: 'Read the line and compared it with the plan' });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    await openDoc(mike, base, slug);

    await check(`${tag}: an untagged document looks as before: no ◆, no tier control, every line a decision line`, async () => {
      const t = await tierState(mike);
      assert.equal(t.anyTagged, false);
      assert.deepEqual(await dot(mike, L.BUDGET), { tier: null, diamond: null, proposed: null });
      assert.equal(await mike.locator('.prw-rail .plm-tiers').isHidden(), true);
      assert.equal(t.counts.context.lines, 0);
    });

    const before = await issues(mike);
    await check(`${tag}: Claude tags three setup lines context (a proposal): quieter text, ◆ on decision lines, Issue count drops by the two Claude read`, async () => {
      const r = await call(base, slug, CLAUDE, 'POST', '/tiers', { tier: 'context', reason: 'Setup, not a claim', lines: [{ lineIndex: L.INTRO }, { lineIndex: L.BACKGROUND }, { lineIndex: L.HISTORY }] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      await mike.evaluate(() => window.__proofLineMarks.refresh());
      await waitFor(mike, () => window.__proofLineMarks.debugState().tiers.anyTagged === true);
      await waitFor(mike, n => window.__proofLineMarks.debugState().issues === n - 2, before);
      const t = await tierState(mike);
      assert.deepEqual(t.views.map(v => [v.line, v.tier, v.proposed]), [[1, 'context', true], [2, 'context', true], [5, 'context', true]]);
      assert.deepEqual(t.counts.context, { lines: 3, issues: 1, readForPeople: 2, proposed: 3 });
      assert.equal(t.counts.decision.lines, 4);
      await waitFor(mike, i => /ptier-context/.test(window.__proofLineMarks.editorView().nodeDOM(window.__proofLineMarks.lineList()[i].pos)?.className ?? ''), L.INTRO);
      const intro = await lineClass(mike, L.INTRO);
      assert.match(intro.cls, /ptier-context/);
      assert.match(intro.cls, /ptier-proposed/);
      const budget = await lineClass(mike, L.BUDGET);
      assert.doesNotMatch(budget.cls, /ptier-context/);
      // Accord layout stage 1: context text is no longer dimmed (the tier lives in the line's box and the dot's label).
      assert.equal(intro.color, budget.color, 'context text is dimmed');
      await waitFor(mike, i => document.querySelector(`.plm-dot[data-line="${i}"]`)?.dataset.tier === 'decision', L.BUDGET);
      assert.deepEqual(await dot(mike, L.BUDGET), { tier: 'decision', diamond: null, proposed: null });
      assert.deepEqual(await dot(mike, L.INTRO), { tier: 'context', diamond: null, proposed: 'true' });
      // The unread History line stays an Issue for Mike; the read ones do not.
      assert.ok(t.myIssueLines.includes(L.HISTORY));
      assert.ok(!t.myIssueLines.includes(L.INTRO) && !t.myIssueLines.includes(L.BACKGROUND));
      assert.deepEqual(t.skippable, [L.INTRO, L.BACKGROUND]);
      // Accord layout stage 3: the counts and "Show only decisions" sit with the Outline's tools.
      await mike.locator('.prw-left .anv-tab[data-tab="outline"]').click();
      const control = mike.locator('.prw-left .plm-tiers');
      await control.waitFor({ state: 'visible' });
      assert.match(await control.innerText(), /◆ 4 decision lines[\s\S]*3 context \(2 read for you, 1 open\)[\s\S]*Show only decisions/);
      await mike.screenshot({ path: path.join(shots, `${tag}-1-tagged.png`) });
    });

    await check(`${tag}: the rail box says "AI proposed context — read for you by Claude"; Mike confirms it (recorded with his name)`, async () => {
      await mike.evaluate(i => window.__proofReadingWalk.focusLine(i), L.INTRO);
      // Accord layout stage 3 (decision 8): the tier is under the line's ⋯ More.
      await mike.locator('.prw-right .plm-box .plm-more-btn').click();
      const row = mike.locator('.prw-right .plm-box .plm-tier-row');
      await row.waitFor({ state: 'visible' });
      assert.match(await row.locator('.plm-tier-text').innerText(), /AI proposed context — read for you by Claude/);
      assert.match(await row.locator('.plm-tier-who').innerText(), /Tagged context by Claude, .*: Setup, not a claim/);
      await mike.screenshot({ path: path.join(shots, `${tag}-2-proposed.png`) });
      await row.locator('.plm-tier-confirm').click();
      await waitFor(mike, () => window.__proofLineMarks.debugState().tiers.writes.some(w => w.tier === 'context' && w.ok));
      await waitFor(mike, i => window.__proofLineMarks.debugState().tiers.views.find(v => v.line === i)?.proposed === false, L.INTRO);
      const v = (await tierState(mike)).views.find(x => x.line === L.INTRO);
      assert.equal(v.by, MIKE);
      await waitFor(mike, () => /^Context — read for you by Claude/.test(document.querySelector('.prw-right .plm-box .plm-tier-text')?.textContent ?? ''));
      if (!(await mike.locator('.prw-right .plm-box .plm-more').isVisible())) await mike.locator('.prw-right .plm-box .plm-more-btn').click();
      assert.equal(await mike.locator('.prw-right .plm-box .plm-tier-confirm').count(), 0);
      const history = await call(base, slug, CLAUDE, 'GET', '/tiers');
      assert.deepEqual(history.body.history.map(h => h.by), ['ai:claude', 'ai:claude', 'ai:claude', MIKE]);
    });

    await check(`${tag}: J / K skip the context lines Claude read; the unread one is still a stop`, async () => {
      await mike.evaluate(() => window.__proofReadingWalk.focusLine(0));
      await mike.locator('body').click({ position: { x: 5, y: 450 } }).catch(() => {});
      await mike.evaluate(() => document.activeElement?.blur?.());
      await mike.keyboard.press('j');
      await waitFor(mike, l => window.__proofReadingWalk.debugState().focus === l, L.BUDGET);
      await mike.keyboard.press('j');
      await waitFor(mike, l => window.__proofReadingWalk.debugState().focus === l, L.LAUNCH);
      await mike.keyboard.press('j');
      await waitFor(mike, l => window.__proofReadingWalk.debugState().focus === l, L.HISTORY);
      await mike.keyboard.press('k');
      await waitFor(mike, l => window.__proofReadingWalk.debugState().focus === l, L.LAUNCH);
      await mike.keyboard.press('k');
      await mike.keyboard.press('k');
      await waitFor(mike, () => window.__proofReadingWalk.debugState().focus === 0);
    });

    await check(`${tag}: D flips the focus line to context (Claude read it: no longer Mike's Issue) and back`, async () => {
      await mike.evaluate(i => window.__proofReadingWalk.focusLine(i), L.CLOSING);
      await mike.waitForTimeout(200);
      const n = await issues(mike);
      const mine = (await tierState(mike)).myIssueLines.includes(L.CLOSING);
      await mike.keyboard.press('d');
      await waitFor(mike, i => window.__proofLineMarks.debugState().tiers.views.some(v => v.line === i && v.tier === 'context' && !v.proposed), L.CLOSING);
      if (mine) await waitFor(mike, m => window.__proofLineMarks.debugState().issues === m - 1, n);
      await waitFor(mike, () => /Make decision/.test(document.querySelector('.prw-right .plm-box .plm-tier-flip')?.textContent ?? ''));
      await mike.keyboard.press('d');
      await waitFor(mike, i => !window.__proofLineMarks.debugState().tiers.views.some(v => v.line === i && v.tier === 'context'), L.CLOSING);
      await waitFor(mike, m => window.__proofLineMarks.debugState().issues === m, n);
      await waitFor(mike, () => window.__proofLineMarks.debugState().tiers.writes.length >= 3);
      const writes = (await tierState(mike)).writes.slice(-2);
      assert.deepEqual(writes.map(w => [w.tier, w.ok]), [['context', true], ['decision', true]], JSON.stringify((await tierState(mike)).writes));
      await mike.evaluate(() => window.__proofReadingWalk.focusLine(0));
    });

    await check(`${tag}: "Show only decisions" folds the covered context lines (view only); the unread one stays; off restores`, async () => {
      const onFolded = async () => (await lm(mike)).marks.filter(m => m.by === MIKE && [L.INTRO, L.BACKGROUND].includes(m.anchor.ordinal)).map(m => `${m.id}:${m.status}`).sort().join(',');
      const marksBefore = await onFolded();
      await mike.locator('.prw-left .anv-tab[data-tab="outline"]').click();
      await mike.locator('.prw-left .plm-tiers-only input').check();
      await waitFor(mike, () => window.__proofLineMarks.debugState().tiers.folded.length === 2);
      assert.deepEqual((await tierState(mike)).folded, [L.INTRO, L.BACKGROUND]);
      await waitFor(mike, i => (window.__proofLineMarks.editorView().nodeDOM(window.__proofLineMarks.lineList()[i].pos)?.getBoundingClientRect().height ?? 1) === 0, L.INTRO);
      assert.equal((await lineClass(mike, L.BACKGROUND)).h, 0);
      assert.ok((await lineClass(mike, L.HISTORY)).h > 0, 'the unread context line stays visible');
      assert.ok((await lineClass(mike, L.BUDGET)).h > 0);
      assert.equal(await mike.locator(`.plm-dot[data-line="${L.INTRO}"]`).count(), 0, 'no dot on a folded line');
      await mike.screenshot({ path: path.join(shots, `${tag}-3-only-decisions.png`) });
      await mike.locator('.prw-left .plm-tiers-only input').uncheck();
      await waitFor(mike, () => window.__proofLineMarks.debugState().tiers.folded.length === 0);
      await waitFor(mike, i => (window.__proofLineMarks.editorView().nodeDOM(window.__proofLineMarks.lineList()[i].pos)?.getBoundingClientRect().height ?? 0) > 0, L.INTRO);
      assert.equal(await onFolded(), marksBefore, 'folding marked nothing on the folded lines');
    });
    await ctx.close();

    // ---------------------------------------------------------------- phone 390
    const ptag = `tiers-${style}-phone-390x844`;
    const viewport = { width: 390, height: 844 };
    const phoneCtx = await newContext(browser, base, { ...devices['iPhone 13'], viewport, screen: viewport, hasTouch: true, isMobile: true });
    const phone = await signIn(phoneCtx, cli, base, MIKE_EMAIL);
    activePage = phone;
    await openDoc(phone, base, slug);
    await check(`${ptag}: context lines are quieter and decision dots carry ◆; no sideways scroll`, async () => {
      await waitFor(phone, i => document.querySelector(`.plm-dot[data-line="${i}"]`)?.dataset.tier === 'decision', L.BUDGET);
      assert.equal((await dot(phone, L.BUDGET)).tier, 'decision'); // no ◆ in the margin since the Accord layout
      await waitFor(phone, i => /ptier-context/.test(window.__proofLineMarks.editorView().nodeDOM(window.__proofLineMarks.lineList()[i].pos)?.className ?? ''), L.BACKGROUND);
      const sw = await phone.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      assert.ok(sw[0] <= sw[1] + 1, `no sideways scroll ${sw}`);
      const d = await phone.locator(`.plm-dot[data-line="${L.BUDGET}"]`).boundingBox();
      assert.ok(d.x >= 0, `dot on screen ${JSON.stringify(d)}`);
      await phone.screenshot({ path: path.join(shots, `${ptag}-1-page.png`) });
    });
    await check(`${ptag}: a margin dot's sheet shows the tier row; a touch-sized button flips the line to decision`, async () => {
      await phone.locator(`.plm-dot[data-line="${L.BACKGROUND}"]`).scrollIntoViewIfNeeded();
      await phone.locator(`.plm-dot[data-line="${L.BACKGROUND}"]`).tap();
      const sheet = phone.locator('.plm-menu.plm-sheet, .prw-right.prw-sheet-open').first();
      await sheet.waitFor({ state: 'visible' });
      const row = sheet.locator('.plm-tier-row');
      await row.waitFor({ state: 'visible' });
      assert.match(await row.innerText(), /AI proposed context — read for you by Claude/);
      const flip = row.locator('.plm-tier-flip');
      const fb = await flip.boundingBox();
      assert.ok(fb.height >= 44, `touch target ${fb.height}`);
      assert.ok(fb.x + fb.width <= 390, `button fits ${JSON.stringify(fb)}`);
      await phone.screenshot({ path: path.join(shots, `${ptag}-2-sheet.png`) });
      await flip.tap();
      await waitFor(phone, i => !window.__proofLineMarks.debugState().tiers.views.some(v => v.line === i && v.tier === 'context'), L.BACKGROUND);
      assert.ok((await tierState(phone)).myIssueLines.includes(L.BACKGROUND), 'a decision line needs Mike again');
    });
    await check(`${ptag}: the Navigator sheet's Outline has the counts and "Show only decisions" (touch-sized)`, async () => {
      await phone.keyboard.press('Escape').catch(() => {});
      await phone.evaluate(() => { document.querySelector('.plm-menu')?.remove(); window.__proofReadingWalk.openSheet('left'); });
      await phone.locator('.prw-left.prw-sheet-open .anv-tab[data-tab="outline"]').tap();
      const control = phone.locator('.prw-left.prw-sheet-open .plm-tiers');
      await control.waitFor({ state: 'visible' });
      assert.match(await control.innerText(), /◆ 5 decision lines[\s\S]*2 context/);
      const lb = await control.locator('.plm-tiers-only').boundingBox();
      assert.ok(lb.height >= 44, `touch target ${lb.height}`);
      await phone.screenshot({ path: path.join(shots, `${ptag}-3-rail.png`) });
    });
    await phoneCtx.close();
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
console.log(`\n${results.length - failures}/${results.length} line-tier checks passed`);
process.exit(failures ? 1 : 0);
