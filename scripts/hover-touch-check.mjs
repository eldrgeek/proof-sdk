#!/usr/bin/env node
// Hover changes no target, selection, mode or layout. Closing Issues never folds text.
// Touch controls mark the selected passage. Mike, 2026-09-23 (usability brief).
// Starts an isolated local server on the current dist/ build (run `npm run build` first) in both
// review styles at 1440 and on a 390x844 phone. Screenshots go to .preview/ (or --shots <dir>).
// Usage: node scripts/hover-touch-check.mjs [--style playmaker|proof] [--shots dir]
import assert from 'node:assert/strict';
import { selectPassage, hoverChangesNothing, expandedStaysExpanded } from './usability-s1-assertions.mjs';

import { spawn } from 'node:child_process';
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

const clientHeaders = { 'X-Proof-Client-Version': '0.32.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `hover-touch-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-hover-touch-check-'));
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

const plain = (n) => `Paragraph ${n} is plain text for reading and marking; it is long enough to be a real line of prose.`;
const markdown = ['# Hover and touch check', ...Array.from({ length: 30 }, (_, i) => plain(i + 1))].join('\n\n');

async function createDoc(base) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown, title: 'Hover and touch check' }),
  });
  assert.equal(response.status, 200);
  const created = await response.json();
  created.post = async (route, body) => {
    const r = await fetch(`${base}/api/agent/${created.slug}${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-share-token': created.accessToken }, body: JSON.stringify(body),
    });
    assert.ok(r.ok, `${route}: ${r.status} ${await r.text()}`);
  };
  // A second team member, so the team is more than the reader.
  await created.post('/marks/line', { lineIndex: 30, status: 'agreed', by: 'ai:check' });
  return created;
}

async function openDoc(browser, base, slug, name, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.addInitScript(viewer => { try { localStorage.setItem('proof-share-viewer-name', viewer); } catch {} }, name);
  const page = await context.newPage();
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.goto(`${base}/d/${slug}`);
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForFunction(() => window.__proofReadingWalk?.debugState().ready === true, null, { timeout: 10_000 });
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  page.setDefaultTimeout(6000);
  return { context, page };
}

const walk = page => page.evaluate(() => window.__proofReadingWalk.debugState());
const myMarkOn = (page, i) => page.evaluate(i => window.__proofLineMarks.debugState().marks
  .find(m => m.by === window.__proofLineMarks.me() && m.anchor.ordinal === i) ?? null, i);
const block = (page, i) => page.locator('.ProseMirror > *').nth(i);

async function hoverLine(page, i) {
  const el = block(page, i);
  const box = await el.boundingBox();
  await page.mouse.move(box.x + 40, box.y + box.height / 2, { steps: 2 });
  await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 2 });
}

async function runDesktop(browser, base, tag) {
  const created = await createDoc(base);
  const { context, page } = await openDoc(browser, base, created.slug, 'Ada', { viewport: { width: 1440, height: 900 } });
  activePage = page;
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(400);

  await check(`${tag}: hover preserves the selected passage and every element box`, async () => {
    await selectPassage(page, 3); await hoverChangesNothing(page, 5);
  });
  await check(`${tag}: A and R after hover never mark or fold a passage`, async () => {
    await selectPassage(page, 3); await hoverChangesNothing(page, 5);
    const before = await page.evaluate(() => window.__proofLineMarks.myStatus(3));
    await page.keyboard.press('a'); await page.keyboard.press('r');
    assert.equal(await page.evaluate(() => window.__proofLineMarks.myStatus(3)), before);
    await expandedStaysExpanded(page);
  });
  await check(`${tag}: while editing, the caret owns the focus (hover does not move it)`, async () => {
    await page.waitForFunction(() => window.__proofReadingWalk?.debugState().ready === true, null, { timeout: 10_000 });
    // A click while Reading only selects. Direct Editing is the labelled control.
    // Mike, 2026-09-23 (usability brief).
    await page.evaluate(() => document.querySelector('.share-pill-suggest-toggle').click());
    await page.waitForFunction(() => document.querySelector('.pst-mode')?.textContent === 'Editing');
    const target = block(page, 14);
    await target.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.waitForTimeout(300);
    const box = await target.boundingBox();
    await page.mouse.click(box.x + 20, box.y + box.height / 2);
    await page.waitForTimeout(200);
    await page.keyboard.type('x');
    await page.waitForFunction(() => window.__proofReadingWalk.debugState().target === 14, null, { timeout: 2000 });
    await hoverLine(page, 16);
    await page.waitForTimeout(4500);
    assert.equal((await walk(page)).target, 14);
    assert.equal(await page.evaluate(() => window.__proofEditingGuard().writing), true);
    await page.evaluate(() => document.querySelector('.share-pill-suggest-toggle').click());
  });
  await check(`${tag}: closed-Issue records never collapse text after reload`, async () => {
    await page.reload();
    await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded);
    await page.waitForTimeout(1600);
    assert.equal(await page.locator('.pclose-folded, .pclose-controls').count(), 0);
  });

  await context.close();
}

async function runPhone(browser, base, tag) {
  const created = await createDoc(base);
  const { context, page } = await openDoc(browser, base, created.slug, 'Ada', { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
  activePage = page;
  const strip = page.locator('.prw-strip');

  await check(`${tag}: the strip is visible and names the selected passage and open count`, async () => {
    await strip.waitFor({ state: 'visible', timeout: 4000 });
    const state = await walk(page);
    assert.equal(state.touch, true);
    assert.equal(state.strip?.line, state.focus);
    assert.match(await strip.innerText(), new RegExp(`Line ${state.focus + 1}`));
  });

  await check(`${tag}: the strip does not cover the current line`, async () => {
    await page.evaluate(() => window.scrollBy(0, 400));
    await page.waitForTimeout(500);
    const focus = (await walk(page)).focus;
    const line = await block(page, focus).boundingBox();
    const s = await strip.boundingBox();
    assert.ok(line.y + line.height <= s.y, `line bottom ${line.y + line.height} vs strip top ${s.y}`);
    const band = await page.locator('.prw-focus').boundingBox();
    assert.ok(band && Math.abs(band.y - line.y) < 12, 'the focus band is not on the current line');
    await page.screenshot({ path: path.join(shots, `${tag}-strip.png`) });
  });

  await check(`${tag}: Review opens and closes without marking or folding the selected passage`, async () => {
    await selectPassage(page, 3);
    await page.locator('.prw-strip-review').tap();
    assert.equal(await page.locator('.prw-right .plm-box').count(), 0);
    await page.locator('.prw-right .prw-collapse').tap();
    await expandedStaysExpanded(page);
    await selectPassage(page, 3);
  });

  // Accord layout stage 3 (decision 11): ⋯ opens the Margin sheet on the Line tab with More showing.
  await check(`${tag}: the count opens Review with no Line tab or More marks`, async () => {
    await page.locator('.prw-strip-review').tap();
    const sheet = page.locator('.prw-right.prw-sheet-open');
    await sheet.waitFor({ state: 'visible' });
    assert.equal(await sheet.locator('.plm-more, .plm-box').count(), 0);
    assert.equal(await sheet.locator('.anv-issues').count(), 1);
    await page.screenshot({ path: path.join(shots, `${tag}-review-sheet.png`) });
    await sheet.locator('.prw-collapse').tap();
  });

  await check(`${tag}: a tap selects the passage while Reading, and the strip stays`, async () => {
    // A tap does not put a caret in the text, so the strip does not step aside.
    // Mike, 2026-09-23 (usability brief).
    const focus = (await walk(page)).focus;
    const next = focus + 1;
    const target = block(page, next);
    const box = await target.boundingBox();
    await page.touchscreen.tap(box.x + 20, box.y + box.height / 2);
    await page.waitForFunction(i => window.__proofReadingWalk.debugState().focus === i, next);
    assert.equal(await page.locator('.pst-mode').evaluate(el => el.textContent), 'Reading');
    assert.notEqual(await page.locator('.ProseMirror').getAttribute('contenteditable'), 'true');
    assert.equal(await page.locator('.prw-strip').isVisible(), true, 'the strip stepped aside');
  });
  await context.close();
}

const browser = await chromium.launch();
try {
  for (const style of styles) {
    const { base, stop } = await startServer(style);
    try {
      await runDesktop(browser, base, `hover-touch-${style}-1440`);
      await runPhone(browser, base, `hover-touch-${style}-phone-390x844`);
    } finally {
      await stop();
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${results.length - failures}/${results.length} hover-touch checks passed`);
process.exit(failures ? 1 : 0);
