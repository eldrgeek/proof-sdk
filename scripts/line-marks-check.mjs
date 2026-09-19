#!/usr/bin/env node
// Browser check for Proof Documents Step 1 (line marks, Issues, Next issue).
// Authorship: Claude Opus 5 (worker proof-line-marks), 2026-09-18, in the style of mobile-check.mjs.
// Starts an isolated local server on the current dist/ build (run `npm run build` first), creates
// throwaway documents on a temp SQLite database, and drives Chromium at desktop and phone sizes.
// Screenshots go to .preview/. Exit code 0 only if every check passes.
// Step 1b (reading walk, 2026-09-18): on desktop a dot focuses its line and the mark box sits in
// the right rail (no popover); the focus line becomes Seen after a short dwell, so counts below
// wait for that first.
// Usage: node scripts/line-marks-check.mjs [--style playmaker|proof]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const shots = path.join(root, '.preview');
mkdirSync(shots, { recursive: true });
const styleArg = process.argv.indexOf('--style');
const style = styleArg > 0 ? process.argv[styleArg + 1] : 'playmaker';

const clientHeaders = { 'X-Proof-Client-Version': '0.31.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `line-marks-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer() {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-line-marks-check-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      PORT: String(port), COLLAB_EMBEDDED_WS: '1', PROOF_DEFAULT_REVIEW_STYLE: style,
      PROOF_FEEDBACK_ENABLED: '1', SOMA_FEEDBACK_ENDPOINT: 'http://127.0.0.1:9/feedback',
      DATABASE_PATH: path.join(temp, 'test.db'), SNAPSHOT_DIR: path.join(temp, 'snapshots'),
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => { child.kill('SIGTERM'); await new Promise(r => setTimeout(r, 300)); rmSync(temp, { recursive: true, force: true }); };
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const health = await fetch(`${base}/health`).catch(() => null);
    if (health?.ok) return { base, stop };
    await new Promise(r => setTimeout(r, 150));
  }
  await stop();
  throw new Error('server did not start');
}

const markdown = `# Proof Document (line marks check)

The first line is a short paragraph that the team must read.

The second paragraph is long enough to wrap across several lines on a phone, so the margin dot must stay beside its first line and never push the text sideways.

- A list item is a line of its own
- So is this second item

| Name | Role |
| --- | --- |
| Mike | Owner |

The last paragraph sits near the bottom.`;
const LINE_COUNT = 8;

async function createDoc(base) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown, title: 'Line marks check' }),
  });
  assert.equal(response.status, 200);
  return await response.json();
}

async function openDoc(browser, base, slug, name, contextOptions = {}, query = '') {
  const context = await browser.newContext(contextOptions);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.addInitScript(viewer => { try { localStorage.setItem('proof-share-viewer-name', viewer); } catch {} }, name);
  const page = await context.newPage();
  if (process.env.DEBUG) {
    page.on('response', r => { if (r.url().includes('line-marks') && r.request().method() === 'POST') r.text().then(t => console.log(`  [${name}] POST ${r.status()} ${t.slice(0, 100)}`)); });
    page.on('console', m => { if (m.type() === 'error') console.log(`  [${name}] console: ${m.text().slice(0, 160)}`); });
  }
  await page.goto(`${base}/d/${slug}${query}`);
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForSelector('#share-banner');
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForTimeout(500);
  page.setDefaultTimeout(6000);
  return { context, page };
}

const dotStatus = (page, line) => page.evaluate(i => document.querySelector(`.plm-dot[data-line="${i}"]`)?.dataset.status ?? null, line);
const issues = page => page.evaluate(() => window.__proofLineMarks.debugState().issues);
const waitFor = (page, fn, arg, timeout = 9000) => page.waitForFunction(fn, arg, { timeout, polling: 200 });
// Desktop: the dot focuses the line and its box is in the right rail. Phones: the Step 1 sheet.
const markBox = (page, line) => page.locator(`.prw-right .plm-box[data-line="${line}"], .plm-menu`);
async function mark(page, line, label, reason) {
  await page.locator(`.plm-dot[data-line="${line}"]`).click();
  const menu = markBox(page, line);
  await menu.waitFor({ state: 'visible' });
  await menu.getByRole('button', { name: label }).click();
  if (reason !== undefined) {
    await menu.getByRole('textbox', { name: /Reason/ }).fill(reason);
    await menu.locator('.plm-reason button[type="submit"]').click();
  }
  await page.waitForTimeout(150);
}

async function desktop(browser, base) {
  const created = await createDoc(base);
  const slug = created.slug;
  const tag = `line-marks-${style}-desktop`;
  const a = await openDoc(browser, base, slug, 'Ada', { viewport: { width: 1280, height: 900 } });
  const page = a.page;
  activePage = page;

  await check(`${tag}: every line has a margin dot left of the text`, async () => {
    const info = await page.evaluate(() => {
      const text = document.querySelector('.ProseMirror').getBoundingClientRect();
      const dots = [...document.querySelectorAll('.plm-dot')].map(d => d.getBoundingClientRect());
      return { count: dots.length, maxRight: Math.max(...dots.map(r => r.right)), textLeft: text.left, minLeft: Math.min(...dots.map(r => r.left)) };
    });
    assert.equal(info.count, LINE_COUNT, `dots ${info.count}`);
    assert.ok(info.maxRight <= info.textLeft + 1, `dot right ${info.maxRight} > text left ${info.textLeft}`);
    assert.ok(info.minLeft >= 0, `dot off screen ${info.minLeft}`);
  });
  await check(`${tag}: top bar shows the issue count and Next issue`, async () => {
    // The first line is the reading walk's focus line: a short dwell marks it Seen.
    await waitFor(page, () => document.querySelector('.plm-dot[data-line="0"]')?.dataset.status === 'seen');
    await waitFor(page, n => document.querySelector('#share-banner .plm-issues-count')?.textContent === `${n} issues`, LINE_COUNT - 1);
    assert.ok(await page.locator('#share-banner .plm-next').isVisible());
  });
  await check(`${tag}: Seen on line 1 lowers the count`, async () => {
    await mark(page, 0, /Seen/);
    assert.equal(await dotStatus(page, 0), 'seen');
    assert.equal(await issues(page), LINE_COUNT - 1);
  });
  await check(`${tag}: Agree and Reject (with a reason) set the dot; Approve is hidden for a non-owner`, async () => {
    await page.locator('.plm-dot[data-line="1"]').click();
    await markBox(page, 1).waitFor({ state: 'visible' });
    const count = await markBox(page, 1).getByRole('button', { name: /Approve/ }).count();
    assert.equal(count, 0, 'non-owner sees Approve');
    await mark(page, 1, /Agree/);
    await mark(page, 2, /Reject/, 'Needs a source');
    assert.equal(await dotStatus(page, 1), 'agreed');
    assert.equal(await dotStatus(page, 2), 'rejected');
    assert.equal(await issues(page), LINE_COUNT - 2, 'rejected line stays an issue');
    await page.locator('.plm-dot[data-line="2"]').click();
    await markBox(page, 2).waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(shots, `${tag}-1-menu.png`) });
    assert.ok((await markBox(page, 2).innerText()).includes('Needs a source'));
  });
  await check(`${tag}: marks survive a reload`, async () => {
    await page.reload();
    await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true && document.querySelectorAll('.plm-dot').length > 0, null, { timeout: 20_000 });
    await waitFor(page, () => document.querySelector('.plm-dot[data-line="1"]')?.dataset.status === 'agreed');
    assert.equal(await dotStatus(page, 0), 'seen');
    assert.equal(await dotStatus(page, 2), 'rejected');
  });
  await check(`${tag}: the document text stays clean`, async () => {
    const doc = await (await fetch(`${base}/api/documents/${slug}`, { headers: clientHeaders })).json();
    assert.ok(!/plm-|line-mark|lineMark|Needs a source/.test(doc.markdown), 'mark data leaked into markdown');
    assert.ok(!JSON.stringify(doc.marks ?? {}).includes('Needs a source'), 'mark data leaked into marks');
  });

  const b = await openDoc(browser, base, slug, 'Bob', { viewport: { width: 1280, height: 900 } });
  await check(`${tag}: a second person sees the first person's marks and joins the team by marking`, async () => {
    await waitFor(b.page, () => document.querySelector('.plm-dot[data-line="1"] .plm-pips i')?.dataset.status === 'agreed');
    await mark(b.page, 1, /Seen/);
    await waitFor(page, () => [...document.querySelectorAll('.plm-dot[data-line="1"] .plm-pips i')].some(i => i.dataset.status === 'seen'));
    const team = await page.evaluate(() => window.__proofLineMarks.debugState().team);
    assert.deepEqual(team.map(t => t.toLowerCase()).sort(), ['human:ada', 'human:bob']);
  });
  await check(`${tag}: an AI's mark through the agent API appears in the margin`, async () => {
    const response = await fetch(`${base}/api/agent/${slug}/marks/line`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders, 'x-share-token': created.ownerSecret },
      body: JSON.stringify({ quote: 'The last paragraph', status: 'agreed', by: 'ai:claude' }),
    });
    assert.equal(response.status, 200, await response.text());
    await waitFor(page, () => document.querySelector('.plm-dot[data-line="7"] .plm-pips i')?.dataset.status === 'agreed');
  });
  await check(`${tag}: editing a line resets the others' marks on it and keeps the changer's`, async () => {
    // Line 2 ("The second paragraph..."): Ada rejected it; Bob marks it Seen, then edits it directly.
    await mark(b.page, 2, /Seen/);
    await b.page.getByRole('button', { name: /^Suggesting:/ }).click();
    await b.page.locator('.ProseMirror p', { hasText: 'The second paragraph' }).click();
    await b.page.keyboard.press('End');
    await b.page.keyboard.insertText(' Edited by Bob.');
    await waitFor(page, () => document.querySelector('.ProseMirror')?.textContent.includes('Edited by Bob.'), null, 12000);
    // Ada's Rejected there is now out of date ("changed"); Bob's Seen followed his own edit.
    await waitFor(page, () => document.querySelector('.plm-dot[data-line="2"]')?.dataset.status === 'changed', null, 12000);
    await waitFor(b.page, () => document.querySelector('.plm-dot[data-line="2"]')?.dataset.status === 'seen', null, 12000);
    await waitFor(page, () => [...document.querySelectorAll('.plm-dot[data-line="2"] .plm-pips i')].some(i => i.dataset.status === 'seen'), null, 12000);
    await page.screenshot({ path: path.join(shots, `${tag}-2-changed.png`) });
  });
  await check(`${tag}: Next issue moves the focus line to an issue and highlights it, then moves on`, async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    const flashTop = () => page.evaluate(() => window.__proofReadingWalk.debugState().focus);
    await page.locator('#share-banner .plm-next').click();
    await page.locator('.plm-flash').waitFor({ state: 'attached', timeout: 2000 });
    const first = await flashTop();
    const focused = await page.evaluate(() => document.activeElement?.dataset?.line ?? null);
    assert.ok(focused !== null, 'the dot of the issue line is not focused');
    await page.screenshot({ path: path.join(shots, `${tag}-3-next-issue.png`) });
    await page.locator('#share-banner .plm-next').click();
    await page.waitForTimeout(100);
    const second = await flashTop();
    assert.ok(second > first, `second Next did not move the focus line down (${first} -> ${second})`);
  });
  await check(`${tag}: the owner can Approve`, async () => {
    const o = await openDoc(browser, base, slug, 'Mike', { viewport: { width: 1280, height: 900 } }, `?token=${encodeURIComponent(created.ownerSecret)}`);
    await mark(o.page, 3, /Approve/);
    assert.equal(await dotStatus(o.page, 3), 'approved');
    await waitFor(page, () => [...document.querySelectorAll('.plm-dot[data-line="3"] .plm-pips i')].some(i => i.dataset.status === 'approved'));
    await o.context.close();
  });
  await check(`${tag}: marking every line by everyone reaches Aligned`, async () => {
    const response = await fetch(`${base}/api/agent/${slug}/state`, { headers: { ...clientHeaders, 'x-share-token': created.ownerSecret } });
    const state = await response.json();
    for (const who of state.alignment.team) {
      for (const line of state.lines) {
        const r = await fetch(`${base}/api/documents/${slug}/line-marks`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
          body: JSON.stringify({ by: who, status: 'seen', anchor: { hash: line.hash, occurrence: line.occurrence, ordinal: line.index, kind: line.kind, excerpt: line.text.slice(0, 80) } }),
        });
        assert.equal(r.status, 200);
      }
    }
    await page.evaluate(() => window.__proofLineMarks.refresh());
    await waitFor(page, () => document.querySelector('#share-banner .plm-issues-count')?.textContent === 'Aligned');
    await page.screenshot({ path: path.join(shots, `${tag}-4-aligned.png`) });
  });
  await b.context.close();
  await a.context.close();
}

async function phone(browser, base) {
  const created = await createDoc(base);
  const viewport = { width: 390, height: 844 };
  const tag = `line-marks-${style}-phone-390x844`;
  const { context, page } = await openDoc(browser, base, created.slug, 'Pat', {
    ...devices['iPhone 13'], viewport, screen: viewport, hasTouch: true, isMobile: true,
  });
  activePage = page;
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  await check(`${tag}: bar stays one row with the issue button`, async () => {
    await waitFor(page, () => document.querySelector('.plm-dot[data-line="0"]')?.dataset.status === 'seen');
    const h = await page.evaluate(() => document.getElementById('share-banner').getBoundingClientRect().height);
    assert.ok(h <= 60, `bar height ${h}`);
    const btn = page.locator('#share-banner .plm-next');
    assert.ok(await btn.isVisible(), 'issue button hidden');
    await waitFor(page, n => document.querySelector('#share-banner .plm-next')?.innerText.trim() === `${n} ›`, LINE_COUNT - 1);
    const r = await btn.boundingBox();
    assert.ok(r.height >= 44 && r.width >= 44, `issue button ${r.width}x${r.height}`);
  });
  await check(`${tag}: dots are on screen, touch-sized, and cause no sideways scroll`, async () => {
    const info = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      dots: [...document.querySelectorAll('.plm-dot')].map(d => d.getBoundingClientRect().toJSON()),
      textLeft: document.querySelector('.ProseMirror').getBoundingClientRect().left,
    }));
    assert.ok(info.sw <= info.cw + 1, `scrollWidth ${info.sw} > ${info.cw}`);
    assert.equal(info.dots.length, LINE_COUNT);
    for (const d of info.dots) {
      assert.ok(d.left >= 0 && d.width >= 32, `dot ${JSON.stringify(d)}`);
      assert.ok(d.right <= info.textLeft + 2, `dot covers text: ${d.right} > ${info.textLeft}`);
    }
  });
  await page.screenshot({ path: path.join(shots, `${tag}-1-load.png`) });
  await check(`${tag}: tapping a dot opens a bottom sheet above the feedback chip; Agree sets the mark`, async () => {
    await page.locator('.plm-dot[data-line="1"]').tap();
    const sheet = page.locator('.plm-menu.plm-sheet');
    await sheet.waitFor({ state: 'visible' });
    const r = await page.evaluate(() => ({ ...document.querySelector('.plm-menu').getBoundingClientRect().toJSON(), vh: innerHeight, vw: innerWidth }));
    assert.ok(Math.abs(r.bottom - r.vh) <= 2 && r.width >= r.vw - 2, `sheet rect ${JSON.stringify(r)}`);
    const chipOnTop = await page.evaluate(() => {
      const chip = document.querySelector('.soma-feedback-root'); const sheet = document.querySelector('.plm-menu');
      if (!chip || !sheet) return false;
      const c = chip.getBoundingClientRect(); const s = sheet.getBoundingClientRect();
      const x = Math.max(c.left, s.left) + 4, y = Math.max(c.top, s.top) + 4;
      if (x > Math.min(c.right, s.right) || y > Math.min(c.bottom, s.bottom)) return false;
      return chip.contains(document.elementFromPoint(x, y));
    });
    assert.equal(chipOnTop, false, 'feedback chip covers the sheet');
    await page.screenshot({ path: path.join(shots, `${tag}-2-sheet.png`) });
    const agree = sheet.getByRole('button', { name: /Agree/ });
    const box = await agree.boundingBox();
    assert.ok(box.height >= 44, `Agree button ${box.height}px tall`);
    await agree.tap();
    await waitFor(page, () => document.querySelector('.plm-dot[data-line="1"]')?.dataset.status === 'agreed');
    await waitFor(page, n => document.querySelector('#share-banner .plm-next')?.innerText.trim() === `${n} ›`, LINE_COUNT - 2);
  });
  await check(`${tag}: Reject asks for a reason on the phone`, async () => {
    await page.locator('.plm-dot[data-line="4"]').tap();
    const sheet = page.locator('.plm-menu.plm-sheet');
    await sheet.getByRole('button', { name: /Reject/ }).tap();
    await sheet.getByRole('textbox', { name: /Reason/ }).fill('Not true for phones');
    await sheet.locator('.plm-reason button[type="submit"]').tap();
    await waitFor(page, () => document.querySelector('.plm-dot[data-line="4"]')?.dataset.status === 'rejected');
  });
  await check(`${tag}: the issue button goes to the next issue`, async () => {
    await page.locator('#share-banner .plm-next').tap();
    await page.locator('.plm-flash').waitFor({ state: 'attached', timeout: 2000 });
    await page.screenshot({ path: path.join(shots, `${tag}-3-next.png`) });
  });
  await context.close();
}

const { base, stop } = await startServer();
const browser = await chromium.launch();
try {
  await desktop(browser, base);
  await phone(browser, base);
} finally {
  await browser.close();
  await stop();
}
console.log(`\n${results.length - failures}/${results.length} line-marks checks passed (${style} style)`);
process.exit(failures ? 1 : 0);
