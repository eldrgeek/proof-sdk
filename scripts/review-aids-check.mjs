#!/usr/bin/env node
// Browser check for Proof Documents Steps B4c + B4d: an AI change's "why" and Ask why, uncertain
// flags, Issue priority and the sitting budget, reject reason chips, and objections with a
// resolution condition (several lines, repair proposed, Keep / Clear).
// Authorship: Claude Opus 5 (worker proof-aids), 2026-09-19, in the style of identity-check.mjs.
// Starts an isolated local server on the current dist/ build (run `npm run build` first) with the
// Documents library on, signs Mike in through an operator sign-in link (objections need a verified
// identity), mints an agent key for "Claude" (its suggestions need a "why"), and drives Chromium
// in both review styles at 1440 (desktop) and 390 (phone). Screenshots go to .preview/ (or --shots).
// Exit code 0 only if every check passes.
// Usage: node scripts/review-aids-check.mjs [--style playmaker|proof] [--shots dir]
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
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `aids-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-aids-check-'));
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

const para = (tag) => `${tag} paragraph is plain text for reading; it is long enough to be a real line of the document.`;
// Lines: 0 Title | 1 Intro | 2 Alpha (AI suggestion with a why) | 3 Beta (flagged uncertain)
//        4 Gamma | 5 Delta (rejected by the AI) | 6 Epsilon | 7 Last
const markdown = [
  '# Aids check', para('Intro'),
  'Alpha paragraph carries the change word for a suggestion.',
  'Beta revenue doubled in the second quarter, the writer is not sure of it.',
  'Gamma line makes a strong claim about every customer wanting exports.',
  'Delta line promises the export button ships in October.',
  para('Epsilon'), para('Last'),
].join('\n\n');
const L = { ALPHA: 2, BETA: 3, GAMMA: 4, DELTA: 5 };

const waitFor = (page, fn, argument, timeout = 9000) => page.waitForFunction(fn, argument, { timeout, polling: 150 });
const lm = page => page.evaluate(() => window.__proofLineMarks.debugState());
const walk = page => page.evaluate(() => window.__proofReadingWalk.debugState());

async function newContext(browser, base, options = {}) {
  const context = await browser.newContext(options);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  return context;
}

async function signIn(context, cli, base) {
  const link = cli('signin-link', '--email', MIKE_EMAIL, '--origin', base, '--hours', '1');
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
  await waitFor(page, () => window.__proofLineMarks.debugState().aids.flags.length >= 1, null, 12000);
  await page.waitForTimeout(300);
  page.setDefaultTimeout(6000);
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
}

async function run(browser, style) {
  const { base, stop, cli } = await startServer(style);
  try {
    cli('add-member', '--name', 'Mike Wolf', '--email', MIKE_EMAIL);
    const tag = `b4c-${style}-desktop-1440`;
    const ctx = await newContext(browser, base, { viewport: { width: 1440, height: 900 } });
    const mike = await signIn(ctx, cli, base);
    activePage = mike;
    const created = await mike.evaluate(async md => {
      const r = await fetch('/library/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Aids check', markdown: md }) });
      return { status: r.status, body: await r.json() };
    }, markdown);
    assert.ok(created.status === 200 || created.status === 201, JSON.stringify(created));
    const slug = created.body.slug;
    const key = await mike.evaluate(async ({ s, h }) => {
      const r = await fetch(`/api/documents/${s}/agent-keys`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify({ label: 'Claude', runtime: 'Claude Opus 5 (Anthropic)' }) });
      return { status: r.status, body: await r.json() };
    }, { s: slug, h: clientHeaders });
    assert.equal(key.status, 201, JSON.stringify(key));
    const agent = async (method, route, body) => {
      const r = await fetch(`${base}/api/agent/${slug}${route}`, {
        method, headers: { 'Content-Type': 'application/json', ...clientHeaders, 'x-share-token': key.body.token },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    };

    await check(`${tag}: the agent key's suggestion without "why" is refused (400 WHY_REQUIRED); with one it lands`, async () => {
      const missing = await agent('POST', '/marks/suggest-replace', { quote: 'change word', content: 'CHANGED word' });
      assert.equal(missing.status, 400, JSON.stringify(missing.body));
      assert.equal(missing.body.code, 'WHY_REQUIRED');
      const ok = await agent('POST', '/marks/suggest-replace', {
        quote: 'change word', content: 'CHANGED word', why: 'The style guide spells it this way.', rejectHints: ['Keep the old word', 'Style guide is out of date'],
      });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const flag = await agent('POST', '/flags', { quote: 'Beta revenue doubled', note: 'Q1 or Q2? The sheet is unclear.' });
      assert.equal(flag.status, 200, JSON.stringify(flag.body));
      const reject = await agent('POST', '/marks/line', { quote: 'Delta line promises', status: 'rejected', reason: 'The vendor slipped', why: 'Vendor email of 17 Sept' });
      assert.equal(reject.status, 200, JSON.stringify(reject.body));
    });

    await openDoc(mike, base, slug);

    await check(`${tag}: the flagged line has an amber tick; the rail says who is unsure and why; the walk reads it at 2×`, async () => {
      await waitFor(mike, i => document.querySelector(`.plm-dot[data-line="${i}"]`)?.dataset.uncertain === 'true', L.BETA);
      await mike.evaluate(i => window.__proofReadingWalk.focusLine(i), L.BETA);
      const note = mike.locator('.prw-right .plm-box .plm-flag-note');
      await note.waitFor({ state: 'visible' });
      assert.match(await note.innerText(), /claude flagged this line uncertain: Q1 or Q2\? The sheet is unclear\./i);
      const w = await walk(mike);
      const words = await mike.evaluate(i => window.__proofLineMarks.lineList()[i].text.split(/\s+/).filter(Boolean).length, L.BETA);
      const base1 = Math.round(Math.min(w.constants.MAX_DWELL_MS, Math.max(w.constants.MIN_DWELL_MS, (words / w.rate) * 1000)));
      assert.equal(w.dwellMs, base1 * 2, `dwell ${w.dwellMs} for ${words} words at ${w.rate}/s`);
      const s = await lm(mike);
      assert.equal(s.aids.uncertainIssues, 1);
      assert.match(await mike.locator('#share-banner .plm-issues-count').getAttribute('title'), /1 uncertain line/);
      await mike.waitForTimeout(250);
      await mike.screenshot({ path: path.join(shots, `${tag}-1-uncertain.png`) });
    });

    await check(`${tag}: the change card shows the AI's why; Ask why replies to the author and records it`, async () => {
      await mike.evaluate(i => window.__proofReadingWalk.focusLine(i), L.ALPHA);
      const card = mike.locator('.prw-right .prw-changes .prw-card').first();
      await card.waitFor({ state: 'visible' });
      assert.match(await card.locator('.prw-why').innerText(), /Why: The style guide spells it this way\./);
      await mike.waitForTimeout(250);
      await mike.screenshot({ path: path.join(shots, `${tag}-2-why.png`) });
      await card.locator('.prw-ask-why').click();
      await waitFor(mike, () => window.__proofReadingWalk.debugState().whyAsked.length === 1);
      let replied = false;
      for (let i = 0; i < 40 && !replied; i += 1) {
        const st = await agent('GET', '/state');
        replied = Object.values(st.body.marks ?? {}).some(m => (m.replies ?? m.thread ?? []).some(r => /@claude Why this change\?/.test(r.text ?? '')));
        if (!replied) await mike.waitForTimeout(250);
      }
      assert.ok(replied, 'the Ask why reply did not reach the suggestion thread');
      const events = await agent('GET', '/events/pending?after=0');
      const asked = events.body.events.filter(e => e.type === 'review.why_asked');
      assert.equal(asked.length, 1, JSON.stringify(events.body.events.map(e => e.type)));
      assert.equal(asked[0].actor, `human:${MIKE_EMAIL}`);
    });

    // Accord layout stage 2 (NEXT_ISSUE_POLICY.viewerFirst): Next takes the Issues that need the
    // viewer (the pill's count, the amber dots) first, each group in stakes order.
    await check(`${tag}: Next issue goes by stakes: the uncertain line that needs Mike, then the AI's rejection`, async () => {
      await mike.evaluate(() => window.scrollTo(0, 0));
      const s = await lm(mike);
      assert.equal(s.aids.ranked[0].rule, 'rejected-by-others', JSON.stringify(s.aids.ranked.slice(0, 4)));
      await mike.locator('#share-banner .plm-next').click();
      await waitFor(mike, () => document.querySelector('#share-banner .plm-issues-count')?.dataset.current === 'uncertain 4')
        .catch(async () => { throw new Error(`first Next: ${await mike.evaluate(() => JSON.stringify({ ...document.querySelector('#share-banner .plm-issues-count').dataset, needs: window.__proofLineMarks.needsYouLines() }))}`); });
      assert.equal((await walk(mike)).focus, L.BETA);
      // The other Issues that need Mike come next; then the team's, led by the AI's rejection.
      const needs = await mike.evaluate(() => [...window.__proofLineMarks.needsYouLines()]);
      for (let i = 0; i < 12; i += 1) {
        await mike.locator('#share-banner .plm-next').click();
        await mike.waitForTimeout(120);
        if (await mike.evaluate(() => document.querySelector('#share-banner .plm-issues-count')?.dataset.priority === 'rejected-by-others')) break;
        assert.ok(needs.includes((await walk(mike)).focus), `Next left the lines that need Mike before the team's (${(await walk(mike)).focus} not in ${needs})`);
      }
      await waitFor(mike, () => document.querySelector('#share-banner .plm-issues-count')?.dataset.priority === 'rejected-by-others');
      assert.equal((await walk(mike)).focus, L.DELTA);
    });

    await check(`${tag}: R on a line opens the reason with chips: the AI author's hints first, then defaults; a chip fills the reason`, async () => {
      await mike.evaluate(i => window.__proofReadingWalk.focusLine(i), L.ALPHA);
      await mike.evaluate(() => document.activeElement?.blur());
      await mike.keyboard.press('r');
      const chips = mike.locator('.prw-right .plm-box .plm-chip');
      await chips.first().waitFor({ state: 'visible' });
      assert.deepEqual(await chips.allInnerTexts(), ['Keep the old word', 'Style guide is out of date', 'Wrong fact']);
      assert.equal(await chips.first().getAttribute('data-source'), 'author');
      await chips.nth(2).click();
      assert.equal(await mike.locator('.prw-right .plm-box .plm-reason input').first().inputValue(), 'Wrong fact');
      await mike.screenshot({ path: path.join(shots, `${tag}-3-chips.png`) });
      await mike.keyboard.press('Escape');
    });

    let objectionId = '';
    await check(`${tag}: shift-click selects two lines; the Reject covers both and "I'd agree if…" makes an objection`, async () => {
      await mike.evaluate(i => window.__proofReadingWalk.focusLine(i), L.GAMMA);
      await mike.locator(`.plm-dot[data-line="${L.DELTA}"]`).click({ modifiers: ['Shift'] });
      await waitFor(mike, () => window.__proofLineMarks.debugState().aids.selection.length === 2);
      await mike.evaluate(() => document.activeElement?.blur());
      await mike.keyboard.press('r');
      const box = mike.locator('.prw-right .plm-box');
      await box.locator('.plm-reject-scope').waitFor({ state: 'visible' });
      assert.match(await box.locator('.plm-reject-scope').innerText(), /covers lines 5–6 \(2 lines\)/);
      await box.locator('.plm-chip', { hasText: 'Too strong' }).click();
      await box.locator('.plm-condition').fill('the interview count and the vendor date are stated');
      await mike.screenshot({ path: path.join(shots, `${tag}-4-objection-form.png`) });
      await box.locator('.plm-reason button[type="submit"]').click();
      await waitFor(mike, () => window.__proofLineMarks.debugState().aids.objections.length === 1);
      const s = await lm(mike);
      objectionId = s.aids.objections[0].id;
      assert.deepEqual(s.aids.objections[0].lines, [L.GAMMA, L.DELTA]);
      assert.equal(s.aids.objectionIssues, 1);
      await waitFor(mike, i => document.querySelector(`.plm-dot[data-line="${i}"]`)?.dataset.objection === 'true', L.GAMMA);
      const card = box.locator('.plm-objection');
      await card.waitFor({ state: 'visible' });
      assert.match(await card.innerText(), /Your objection: Too strong/);
      assert.match(await card.innerText(), /You’d agree if: the interview count and the vendor date are stated/);
      await mike.screenshot({ path: path.join(shots, `${tag}-5-objection.png`) });
    });

    await check(`${tag}: the AI edits a covered line: "a repair was proposed" (rail + Since you); Keep, then Clear`, async () => {
      const state = await agent('GET', '/state');
      const gamma = state.body.lines.find(l => l.text.startsWith('Gamma line'));
      const edit = await agent('POST', '/edit/v2', {
        baseRevision: (await agent('GET', '/snapshot')).body.revision,
        operations: [{ op: 'replace_block', ref: gamma.ref, block: { markdown: 'Gamma line claims 12 of 12 interviewed customers wanted exports.' } }],
      });
      assert.equal(edit.status, 200, JSON.stringify(edit.body));
      await waitFor(mike, () => window.__proofLineMarks.debugState().aids.objections[0]?.repairPending === true, null, 15000);
      await mike.evaluate(i => window.__proofReadingWalk.focusLine(i), L.GAMMA);
      const card = mike.locator('.prw-right .plm-box .plm-objection');
      await card.locator('.plm-objection-repair').waitFor({ state: 'visible' });
      const since = await mike.evaluate(async ({ s, h }) => (await (await fetch(`/api/documents/${s}/since-you`, { credentials: 'same-origin', headers: h })).json()), { s: slug, h: clientHeaders });
      assert.equal(since.counts?.repairs, 1, JSON.stringify(since).slice(0, 300));
      await mike.screenshot({ path: path.join(shots, `${tag}-6-repair.png`) });
      await card.locator('.plm-objection-keep').click();
      await waitFor(mike, () => window.__proofLineMarks.debugState().aids.objections[0]?.repairPending === false, null, 10000);
      await card.locator('.plm-objection-clear').click();
      await waitFor(mike, () => window.__proofLineMarks.debugState().aids.objections.length === 0, null, 10000);
      const events = await agent('GET', '/events/pending?after=0');
      const types = events.body.events.map(e => e.type);
      for (const t of ['objection.created', 'objection.repair_proposed', 'objection.kept', 'objection.cleared']) assert.ok(types.includes(t), `missing ${t}: ${types.join(',')}`);
      assert.ok(objectionId);
    });

    await check(`${tag}: a sitting of 5 issues: after five, Next says what is left and lets the reader stop`, async () => {
      // Accord layout stage 2 (decision 10): This sitting lives in View › Reading settings.
      await mike.locator('#accord-menubar .amb-top[data-menu="view"]').click();
      await mike.locator('.amb-menu .amb-item', { hasText: 'Reading settings…' }).click();
      const setting = mike.locator('#reading-settings .plm-budget select');
      await setting.selectOption('5');
      await mike.getByRole('button', { name: 'Close reading settings' }).click();
      for (let i = 0; i < 5; i += 1) {
        await mike.locator('#share-banner .plm-next').click();
        await mike.waitForTimeout(120);
      }
      assert.equal((await lm(mike)).aids.sitting.visited, 5);
      await mike.locator('#share-banner .plm-next').click();
      // Reaching the budget opens Reading settings, which says what is left.
      const status = mike.locator('#reading-settings .plm-budget .plm-budget-status');
      await waitFor(mike, () => document.querySelector('#reading-settings .plm-budget')?.dataset.state === 'reached');
      assert.ok(await mike.locator('#reading-settings').isVisible(), 'Reading settings did not open at the budget');
      const s = await lm(mike);
      assert.match(await status.innerText(), new RegExp(`Sitting done: 5 of 5\\. ${s.aids.sitting.remaining} more, (none urgent|\\d+ urgent)\\.`));
      await mike.waitForTimeout(200);
      await mike.screenshot({ path: path.join(shots, `${tag}-7-budget.png`) });
      await mike.locator('#reading-settings .plm-budget-stop').click();
      await waitFor(mike, () => document.querySelector('#reading-settings .plm-budget')?.dataset.state === 'stopped');
      assert.match(await status.innerText(), /Stopped with \d+ more, .*They wait for next time\./);
      await setting.selectOption('0');
      await mike.getByRole('button', { name: 'Close reading settings' }).click();
    });

    await check(`${tag}: a person flags a line from the rail; the flag is theirs to clear`, async () => {
      await mike.evaluate(i => window.__proofReadingWalk.focusLine(i), L.DELTA);
      const row = mike.locator('.prw-right .plm-box .plm-flag');
      await row.locator('.plm-flag-open').click();
      await row.locator('.plm-flag-form input').fill('Is October still true?');
      await row.locator('.plm-flag-form button[type="submit"]').click();
      await waitFor(mike, () => window.__proofLineMarks.debugState().aids.flags.length === 2);
      await waitFor(mike, i => document.querySelector(`.plm-dot[data-line="${i}"]`)?.dataset.uncertain === 'true', L.DELTA);
      await row.locator('.plm-flag-note', { hasText: 'You flagged' }).locator('.plm-flag-clear').click();
      await waitFor(mike, () => window.__proofLineMarks.debugState().aids.flags.length === 1);
    });
    await ctx.close();

    // ---------------------------------------------------------------- phone 390
    const ptag = `b4c-${style}-phone-390x844`;
    const viewport = { width: 390, height: 844 };
    const pctx = await newContext(browser, base, { ...devices['iPhone 13'], viewport, screen: viewport, hasTouch: true, isMobile: true });
    const phone = await signIn(pctx, cli, base);
    activePage = phone;
    await openDoc(phone, base, slug);
    await check(`${ptag}: the flagged line's sheet shows the note; Reject shows touch-sized chips and "I'd agree if…"; no sideways scroll`, async () => {
      await phone.locator(`.plm-dot[data-line="${L.BETA}"]`).scrollIntoViewIfNeeded();
      assert.equal(await phone.locator(`.plm-dot[data-line="${L.BETA}"]`).getAttribute('data-uncertain'), 'true');
      await phone.locator(`.plm-dot[data-line="${L.BETA}"]`).tap();
      const sheet = phone.locator('.plm-menu.plm-sheet');
      await sheet.waitFor({ state: 'visible' });
      assert.match(await sheet.locator('.plm-flag-note').innerText(), /claude flagged this line uncertain/i);
      await sheet.getByRole('button', { name: /Reject/ }).tap();
      const chips = sheet.locator('.plm-chip');
      await chips.first().waitFor({ state: 'visible' });
      const sizes = await chips.evaluateAll(cs => cs.map(c => c.getBoundingClientRect().height));
      assert.ok(sizes.length === 3 && sizes.every(h => h >= 44), `chips ${sizes}`);
      await sheet.locator('.plm-condition').waitFor({ state: 'visible' });
      const sw = await phone.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      assert.ok(sw[0] <= sw[1] + 1, `scrollWidth ${sw}`);
      await phone.screenshot({ path: path.join(shots, `${ptag}-1-sheet.png`) });
      await chips.first().tap();
      await sheet.locator('.plm-reason button[type="submit"]').tap();
      await waitFor(phone, i => document.querySelector(`.plm-dot[data-line="${i}"]`)?.dataset.status === 'rejected', L.BETA);
    });
    await check(`${ptag}: ⋯ › Reading settings carries "This sitting" as a sheet`, async () => {
      await phone.locator('#share-banner .share-pill-overflow').tap();
      await phone.getByRole('menuitem', { name: /Reading settings/ }).tap();
      const budget = phone.locator('#reading-settings .plm-budget select');
      await budget.waitFor({ state: 'visible' });
      const h = await budget.evaluate(el => el.getBoundingClientRect().height);
      assert.ok(h >= 44, `select ${h}px`);
      await phone.screenshot({ path: path.join(shots, `${ptag}-2-budget.png`) });
    });
    await pctx.close();
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
console.log(`\n${results.length - failures}/${results.length} review-aids checks passed`);
process.exit(failures ? 1 : 0);
