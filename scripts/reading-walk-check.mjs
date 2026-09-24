#!/usr/bin/env node
import { assertRetiredMarks, assertMarkKeysInactive, assertSinglePanel, assertPassageActions, assertPanelToggle, seedLegacyMark } from './left-panel-assertions.mjs';
// Browser check for Proof Documents Step 1b: the three-column reading layout and the reading walk.
// Authorship: Claude Opus 5 (worker reading-walk), 2026-09-18, in the style of line-marks-check.mjs.
// Starts an isolated local server on the current dist/ build (run `npm run build` first), creates
// throwaway documents on a temp SQLite database, and drives Chromium in both review styles at
// 1440 and 1280 (desktop) and 390 (phone). Screenshots go to .preview/ (or --shots <dir>).
// Exit code 0 only if every check passes.
// Usage: node scripts/reading-walk-check.mjs [--style playmaker|proof] [--width 1440] [--shots dir]
import { nextReview, showReview } from './review-ui.mjs';
import assert from 'node:assert/strict';
import { selectPassage, scrollAcceptsNothing, explicitAcceptUndo } from './usability-s1-assertions.mjs';

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
const widths = arg('--width') ? [Number(arg('--width'))] : [1440, 1280];

const clientHeaders = { 'X-Proof-Client-Version': '0.31.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `reading-walk-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-reading-walk-check-'));
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

const plain = (n) => `Paragraph ${n} is plain text for reading; it carries no suggestions and is long enough to be a real line.`;
const markdown = [
  '# Reading walk check',
  ...Array.from({ length: 10 }, (_, i) => plain(i + 1)),
  'Three changes: the alpha word, the beta word and the gamma word all sit on this one line.',
  plain(12), plain(13),
  'One more change sits here on the delta word.',
  plain(15), plain(16), plain(17), plain(18),
].join('\n\n');
const TRIPLE = 11;
const DELTA = 14;
const LAST = 18;

async function createDoc(base) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown, title: 'Reading walk check' }),
  });
  assert.equal(response.status, 200);
  const created = await response.json();
  for (const [quote, content] of [['alpha word', 'ALPHA word'], ['beta word', 'BETA word'], ['gamma word', 'GAMMA word'], ['delta word', 'DELTA word']]) {
    const r = await fetch(`${base}/api/agent/${created.slug}/marks/suggest-replace`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-share-token': created.accessToken },
      body: JSON.stringify({ quote, content, by: 'ai:check' }),
    });
    assert.ok(r.ok, `suggest ${quote}: ${r.status} ${await r.text()}`);
  }
  return created;
}

async function openDoc(browser, base, slug, name, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.addInitScript(viewer => { try { localStorage.setItem('proof-share-viewer-name', viewer); } catch {} }, name);
  const page = await context.newPage();
  await page.goto(`${base}/d/${slug}`);
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForFunction(() => window.__proofReadingWalk?.debugState().ready === true
    && (window.proof?.getAllMarks?.() ?? []).filter(m => m.data?.status === 'pending').length >= 4, null, { timeout: 10_000 });
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  page.setDefaultTimeout(6000);
  return { context, page };
}

const walk = page => page.evaluate(() => window.__proofReadingWalk.debugState());
const pendingIds = page => page.evaluate(() => (window.proof?.getAllMarks?.() ?? []).filter(m => m.data?.status === 'pending').map(m => m.id));
const dotStatus = (page, line) => page.evaluate(i => window.__proofLineMarks.myStatus(i), line);
const waitFor = (page, fn, arg, timeout = 8000) => page.waitForFunction(fn, arg, { timeout, polling: 100 });
const rect = (page, selector) => page.evaluate(s => document.querySelector(s)?.getBoundingClientRect().toJSON() ?? null, selector);
async function gesture(page, dy, events = 1) {
  for (let i = 0; i < events; i += 1) {
    await page.mouse.wheel(0, dy);
    if (events > 1) await page.waitForTimeout(16);
  }
  await page.waitForTimeout(320); // > GESTURE_GAP_MS: the next wheel is a new gesture
}
async function lineDelta(page, from) {
  return page.evaluate(i => { const t = window.__proofReadingWalk.debugState().tops; return t[i + 1] - t[i]; }, from);
}

async function desktop(browser, base, style, width) {
  const created = await createDoc(base);
  const tag = `reading-walk-${style}-${width}`;
  const a = await openDoc(browser, base, created.slug, 'Ada', { viewport: { width, height: 900 } });
  const page = a.page;
  activePage = page;
  const text = await rect(page, '.ProseMirror');
  await page.mouse.move(text.left + text.width / 2, 500);

  await check(`${tag}: ac-2vs: one side panel leaves the prose clear`, async () => {
    // ac-2vs: the 2026-09-24 rules retire the Margin/marking gesture in this case.
    await assertSinglePanel(page);
  });
  if (style === 'playmaker') {
    // Accord layout stage 3: the Marks panel is a whole-document list, so it docks under the
    // Navigator's Issues list (left side), never over the text.
    await check(`${tag}: the PlayMaker Marks panel lives in the Navigator's Issues tab, not over the text`, async () => {
      const info = await page.evaluate(() => {
        const panel = document.querySelector('.pm-review-panel');
        const t = document.querySelector('.ProseMirror').getBoundingClientRect();
        const p = panel?.getBoundingClientRect();
        return { inRail: !!panel?.closest('.prw-left .anv-pane[data-tab="issues"]'), hidden: panel?.hidden, pRight: p?.right, tLeft: t.left };
      });
      assert.ok(info.inRail, 'panel not in the Navigator');
      assert.equal(info.hidden, false, 'panel hidden');
      assert.ok(info.pRight <= info.tLeft, 'panel overlaps the text');
    });
  }
  await check(`${tag}: ac-2vs: the first selected passage has its action strip`, async () => {
    // ac-2vs: the 2026-09-24 rules retire the Margin/marking gesture in this case.
    assert.equal((await walk(page)).focus,0); await assertPassageActions(page); await assertRetiredMarks(page);
  });
  await check(`${tag}: dwelling on the first line marks it Seen`, async () => {
    await waitFor(page, () => window.__proofLineMarks.myStatus(0) === 'seen');
  });
  await check(`${tag}: ac-2vs: J moves selection and A/R do nothing`, async () => {
    // ac-2vs: the 2026-09-24 rules retire the Margin/marking gesture in this case.
    await page.keyboard.press('j'); await waitFor(page,()=>window.__proofReadingWalk.debugState().focus===1); await assertMarkKeysInactive(page);
  });
  await check(`${tag}: ac-2vs: draft input accepts letters without moving selection`, async () => {
    // ac-2vs: the 2026-09-24 rules retire the Margin/marking gesture in this case.
    await selectPassage(page,2); await page.keyboard.press('s'); const input=page.getByRole('textbox',{name:'Proposed passage text'}); await input.fill('arjk are draft words'); assert.equal(await input.inputValue(),'arjk are draft words'); assert.equal((await walk(page)).focus,2); await page.locator('.accord-draft').getByRole('button',{name:'Cancel',exact:true}).click();
  });
  await check(`${tag}: scrolling at reading pace marks lines Seen after the dwell`, async () => {
    // line 2 -> 3 -> 4, pausing longer than line 3's reading time (Step B3b: its words at the
    // reader's rate, from debugState().dwellMs).
    await gesture(page, await lineDelta(page, 2));
    await waitFor(page, () => window.__proofReadingWalk.debugState().readingFocus === 3);
    const need = (await walk(page)).dwellMs;
    assert.ok(need > 1000, `a 20-word line should need more than 1 s at 4 words/s (dwellMs ${need})`);
    await page.waitForTimeout(need + 200);
    await gesture(page, await lineDelta(page, 3));
    await waitFor(page, () => window.__proofReadingWalk.debugState().readingFocus === 4);
    await waitFor(page, () => window.__proofReadingWalk.debugState().seenWrites.includes(3));
    assert.equal(await dotStatus(page, 3), 'seen');
    await page.waitForTimeout(400);
  });
  await check(`${tag}: a fling does not select or accept a proposal`, async () => {
    await scrollAcceptsNothing(page);
  });
  const bob = await openDoc(browser, base, created.slug, 'Bob', { viewport: { width: 1280, height: 900 } });
  await check(`${tag}: J steps between visible passages even when proposals are present`, async () => {
    await selectPassage(page, TRIPLE);
    const before = await pendingIds(page);
    await page.keyboard.press('j');
    assert.equal((await walk(page)).cursor, TRIPLE + 1);
    assert.deepEqual(await pendingIds(page), before);
  });
  await check(`${tag}: the other reader still sees pending proposals after scrolling`, async () => {
    await scrollAcceptsNothing(page);
    assert.deepEqual(await pendingIds(bob.page), await pendingIds(page));
  });

  await check(`${tag}: a later explicit Agree accepts no earlier proposal`, async () => {
    await selectPassage(page, DELTA + 1);
    const before = await pendingIds(page);
    await page.keyboard.press('a'); await page.waitForTimeout(400);
    assert.deepEqual(await pendingIds(page), before);
  });
  await check(`${tag}: explicit Accept survives scrolling and one Undo restores the proposal`, async () => {
    await explicitAcceptUndo(page, TRIPLE);
  });
  await check(`${tag}: Next issue moves the focus line`, async () => {
    await page.keyboard.press('j'); await page.keyboard.press('j');
    const before = (await walk(page)).focus;
    await nextReview(page);
    await page.waitForTimeout(200);
    const after = (await walk(page)).focus;

    const focusTop = await page.evaluate(() => document.querySelector('.prw-focus')?.getBoundingClientRect().top ?? null);
    assert.notEqual(after, before, 'focus did not move');
    assert.ok(focusTop !== null && focusTop >= 0, 'the selected passage is not visible');
    assert.equal(Number(await page.locator('.anv-issue[aria-current="true"]').getAttribute('data-line')), after);
  });
  await check(`${tag}: ac-2vs: an amber dot opens that passage in Review`, async () => {
    // ac-2vs: the 2026-09-24 rules retire the Margin/marking gesture in this case.
    await page.locator('.plm-needs-you').first().click(); assert.equal(await page.locator('#anv-tab-issues').getAttribute('aria-selected'),'true'); await assertRetiredMarks(page);
  });
  await check(`${tag}: ac-2vs: collapsing the side panel returns width to the prose`, async () => {
    // ac-2vs: the 2026-09-24 rules retire the Margin/marking gesture in this case.
    await assertPanelToggle(page);
  });
  await check(`${tag}: keys typed into the document (writing) do not mark or move`, async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    // Direct Editing is the labelled control. A click while Reading only selects.
    // Mike, 2026-09-23 (usability brief).
    await page.evaluate(() => {
      const btn = document.querySelector('.share-pill-suggest-toggle');
      if (btn && btn.getAttribute('aria-label') !== 'Leave Editing') btn.click();
    });
    await page.waitForFunction(() => document.querySelector('.pst-mode')?.textContent === 'Editing');
    // Line 5 was only skimmed (a line already agreed may be folded, and a click on a fold opens it).
    const line5 = await page.locator('.ProseMirror > *').nth(5).boundingBox();
    await page.mouse.click(line5.x + line5.width - 20, line5.y + 8);
    await page.waitForTimeout(150);
    const focus = (await walk(page)).focus;
    const before = await page.evaluate(() => window.__proofLineMarks.editorView().state.doc.textContent.length);
    for (const key of ['a', 'j', 'r']) await page.keyboard.press(key);
    assert.equal(await page.evaluate(() => window.__proofLineMarks.editorView().state.doc.textContent.length), before + 3, 'the keys did not type');
    assert.equal((await walk(page)).focus, focus, 'moved while typing in the document');
    assert.equal(await page.locator('.prw-right .plm-reason input:not(.plm-condition)').isVisible().catch(() => false), false, 'R opened the reason field while typing');
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('Backspace');
    await page.keyboard.press('Escape');
  });
  await bob.context.close();
  await a.context.close();
}

async function phone(browser, base, style) {
  const created = await createDoc(base);
  const viewport = { width: 390, height: 844 };
  const tag = `reading-walk-${style}-phone-390x844`;
  const { context, page } = await openDoc(browser, base, created.slug, 'Pat', {
    ...devices['iPhone 13'], viewport, screen: viewport, hasTouch: true, isMobile: true,
  });
  activePage = page;
  await check(`${tag}: ac-2vs: the phone starts with its side panel closed`, async () => {
    // ac-2vs: the 2026-09-24 rules retire the Margin/marking gesture in this case.
    await assertSinglePanel(page); assert.equal(await page.locator('.prw-left.prw-sheet-open').count(),0);
  });
  await check(`${tag}: ac-2vs: an amber dot opens the left Review sheet`, async () => {
    // ac-2vs: the 2026-09-24 rules retire the Margin/marking gesture in this case.
    await page.locator('.plm-needs-you').first().tap(); await page.locator('.prw-left.prw-sheet-open').waitFor({state:'visible'}); await page.locator('.prw-left .prw-collapse').tap();
  });
  await check(`${tag}: ac-2vs: more options opens the Side panel`, async () => {
    // ac-2vs: the 2026-09-24 rules retire the Margin/marking gesture in this case.
    await page.locator('.prw-strip-more').tap(); await page.locator('.proof-share-overflow-menu').getByRole('menuitem',{name:/Side panel/}).tap(); await page.locator('.prw-left.prw-sheet-open').waitFor({state:'visible'}); await page.locator('.prw-left .prw-collapse').tap();
  });
  await check(`${tag}: phone scrolling keeps the selected passage and proposals pending`, async () => {
    await scrollAcceptsNothing(page);
  });
  await context.close();
}

const browser = await chromium.launch();
try {
  for (const style of styles) {
    const { base, stop } = await startServer(style);
    try {
      for (const width of widths) await desktop(browser, base, style, width);
      await phone(browser, base, style);
    } finally {
      await stop();
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${results.length - failures}/${results.length} reading-walk checks passed`);
process.exit(failures ? 1 : 0);
