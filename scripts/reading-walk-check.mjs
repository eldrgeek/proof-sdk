#!/usr/bin/env node
// Browser check for Proof Documents Step 1b: the three-column reading layout and the reading walk.
// Authorship: Claude Opus 5 (worker reading-walk), 2026-09-18, in the style of line-marks-check.mjs.
// Starts an isolated local server on the current dist/ build (run `npm run build` first), creates
// throwaway documents on a temp SQLite database, and drives Chromium in both review styles at
// 1440 and 1280 (desktop) and 390 (phone). Screenshots go to .preview/ (or --shots <dir>).
// Exit code 0 only if every check passes.
// Usage: node scripts/reading-walk-check.mjs [--style playmaker|proof] [--width 1440] [--shots dir]
import assert from 'node:assert/strict';
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
const dotStatus = (page, line) => page.evaluate(i => document.querySelector(`.plm-dot[data-line="${i}"]`)?.dataset.status ?? null, line);
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

  await check(`${tag}: three columns; the text sits centred between the rails`, async () => {
    const info = await page.evaluate(() => {
      const r = s => document.querySelector(s)?.getBoundingClientRect().toJSON();
      const vis = s => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0; };
      return { left: r('.prw-left'), right: r('.prw-right'), text: r('.ProseMirror'), leftVis: vis('.prw-left'), rightVis: vis('.prw-right'),
        sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
    });
    assert.ok(info.leftVis && info.rightVis, 'a rail is hidden');
    assert.ok(info.left.right <= info.text.left - 8, `left rail ${info.left.right} overlaps text ${info.text.left}`);
    assert.ok(info.right.left >= info.text.right + 8, `right rail ${info.right.left} overlaps text ${info.text.right}`);
    const gapMid = (info.left.right + info.right.left) / 2;
    const textMid = (info.text.left + info.text.right) / 2;
    assert.ok(Math.abs(gapMid - textMid) <= 40, `text centre ${textMid} vs column centre ${gapMid}`);
    assert.ok(info.text.width >= 420 && info.text.width <= 780, `text width ${info.text.width}`);
    assert.ok(info.sw <= info.cw + 1, 'page scrolls sideways');
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
  await check(`${tag}: on open the first line is the focus line, highlighted, with its mark box in the right rail`, async () => {
    const state = await walk(page);
    assert.equal(state.focus, 0);
    const info = await page.evaluate(() => {
      const f = document.querySelector('.prw-focus');
      const h = document.querySelector('.ProseMirror h1');
      return { f: f && !f.hidden ? f.getBoundingClientRect().toJSON() : null, h: h.getBoundingClientRect().toJSON(),
        box: document.querySelector('.prw-right .plm-box')?.dataset.line ?? null,
        boxRect: document.querySelector('.prw-right .plm-box')?.getBoundingClientRect().toJSON(),
        popover: !!document.querySelector('.plm-menu') };
    });
    assert.ok(info.f, 'no focus highlight');
    assert.ok(info.f.top <= info.h.top && info.f.bottom >= info.h.bottom, 'highlight does not cover the first line');
    assert.equal(info.box, '0', 'mark box is not for line 1');
    assert.ok(info.boxRect.left > info.h.right, 'box is not beside the text');
    assert.equal(info.popover, false, 'a popover is open');
    await page.screenshot({ path: path.join(shots, `${tag}-1-open.png`) });
  });
  await check(`${tag}: dwelling on the first line marks it Seen`, async () => {
    await waitFor(page, () => document.querySelector('.plm-dot[data-line="0"]')?.dataset.status === 'seen');
  });
  await check(`${tag}: J moves the focus; A agrees with the focus line`, async () => {
    await page.keyboard.press('j');
    await waitFor(page, () => window.__proofReadingWalk.debugState().focus === 1);
    await page.keyboard.press('a');
    await waitFor(page, () => document.querySelector('.plm-dot[data-line="1"]')?.dataset.status === 'agreed');
  });
  await check(`${tag}: keys typed into an input do not mark or move`, async () => {
    // (Typing into the document itself is checked at the end: it needs a press on the text,
    // which starts writing — see scripts/mike-0921-check.mjs for every entry path.)
    let state = await walk(page);
    assert.equal(state.focus, 1);
    assert.equal(await dotStatus(page, 1), 'agreed');
    await page.keyboard.press('j'); // line 2
    await page.keyboard.press('r');
    const input = page.locator('.prw-right .plm-reason input:not(.plm-condition)');
    await input.waitFor({ state: 'visible' });
    assert.ok(await input.evaluate(e => e === document.activeElement), 'R did not focus the reason field');
    await page.keyboard.type('Needs a source, ask Jake');
    state = await walk(page);
    assert.equal(state.focus, 2, 'typing the reason moved the focus');
    assert.equal(await input.inputValue(), 'Needs a source, ask Jake');
    await page.keyboard.press('Enter');
    await waitFor(page, () => document.querySelector('.plm-dot[data-line="2"]')?.dataset.status === 'rejected');
    await page.evaluate(() => document.activeElement?.blur());
  });
  await check(`${tag}: scrolling at reading pace marks lines Seen after the dwell`, async () => {
    // line 2 -> 3 -> 4, pausing longer than line 3's reading time (Step B3b: its words at the
    // reader's rate, from debugState().dwellMs).
    await gesture(page, await lineDelta(page, 2));
    await waitFor(page, () => window.__proofReadingWalk.debugState().focus === 3);
    const need = (await walk(page)).dwellMs;
    assert.ok(need > 1000, `a 20-word line should need more than 1 s at 4 words/s (dwellMs ${need})`);
    await page.waitForTimeout(need + 200);
    await gesture(page, await lineDelta(page, 3));
    await waitFor(page, () => window.__proofReadingWalk.debugState().focus === 4);
    await waitFor(page, () => window.__proofReadingWalk.debugState().seenWrites.includes(3));
    assert.equal(await dotStatus(page, 3), 'seen');
    await page.waitForTimeout(400);
  });
  await check(`${tag}: a fling marks nothing, and stops at the first line with changes`, async () => {
    await page.mouse.wheel(0, 2500);
    await waitFor(page, () => window.__proofReadingWalk.debugState().focus >= 10);
    await page.waitForTimeout(500);
    const state = await walk(page);
    assert.equal(state.focus, TRIPLE, `focus ${state.focus}: the fling ran past the changes`);
    for (let line = 5; line < TRIPLE; line += 1) {
      assert.ok(!state.seenWrites.includes(line), `line ${line} was marked Seen by a fling`);
      // Step B3b: a line the fling passed is skimmed (a hollow dot), never Seen.
      assert.equal(await dotStatus(page, line), 'skimmed', `line ${line}`);
    }
  });
  const bob = await openDoc(browser, base, created.slug, 'Bob', { viewport: { width: 1280, height: 900 } });
  await check(`${tag}: each scroll gesture steps to the next change while the page stays on the line`, async () => {
    const before = await page.evaluate(() => window.scrollY);
    let state = await walk(page);
    assert.equal(state.marksOnFocus.length, 3);
    assert.equal(state.current, state.marksOnFocus[0]);
    await page.screenshot({ path: path.join(shots, `${tag}-2-stepping.png`) });
    // A trackpad-like gesture: 20 events with inertia is still one step.
    await gesture(page, 30, 20);
    state = await walk(page);
    assert.equal(state.current, state.marksOnFocus[1], 'first gesture did not step exactly once');
    assert.equal(state.provisional.length, 1);
    await gesture(page, 120);
    await gesture(page, 120);
    state = await walk(page);
    assert.equal(state.focus, TRIPLE, 'focus left the line while stepping');
    assert.equal(state.current, null);
    assert.equal(state.provisional.length, 3);
    const after = await page.evaluate(() => window.scrollY);
    assert.ok(Math.abs(after - before) <= 2, `page moved while stepping (${before} -> ${after})`);
    const rail = await page.locator('.prw-right .prw-provisional').innerText();
    assert.ok(/scrolled past 3 changes, so they count as accepted by scrolling/.test(rail), rail);
    // Accord layout stage 1: a scroll-accept renders as an ordinary insert / delete (Docs style);
    // the status bar under the page lists it with Save (the old look hid the old words).
    const hidden = await page.evaluate(() => [...document.querySelectorAll('.ProseMirror .mark-delete')].filter(e => getComputedStyle(e).display === 'none').length);
    assert.equal(hidden, 0, `provisionally accepted old words were hidden (${hidden})`);
    assert.match(await page.locator('.pst-bar .pst-provisional').innerText(), /3 accepted by scrolling, not saved/);
    await page.screenshot({ path: path.join(shots, `${tag}-3-provisional.png`) });
  });
  await check(`${tag}: a provisional accept is not written: the other reader still sees the changes pending`, async () => {
    assert.equal((await pendingIds(bob.page)).length, 4);
    assert.equal((await pendingIds(page)).length, 4);
  });
  await check(`${tag}: scrolling back up above the line reverts the provisional accepts`, async () => {
    await gesture(page, 120); // leaves the line (native scroll)
    await waitFor(page, () => window.__proofReadingWalk.debugState().focus > 11);
    assert.equal((await walk(page)).provisional.length, 3, 'moving on removed the accepts');
    await gesture(page, -400);
    await waitFor(page, () => window.__proofReadingWalk.debugState().focus < 11);
    const state = await walk(page);
    assert.equal(state.provisional.length, 0);
    const hidden = await page.evaluate(() => [...document.querySelectorAll('.ProseMirror .mark-delete')].filter(e => getComputedStyle(e).display === 'none').length);
    assert.equal(hidden, 0, 'old words still hidden after revert');
  });
  await check(`${tag}: provisional accepts commit on a later explicit A; only then does the other reader see them`, async () => {
    // Walk down with J: through the three changes, past the delta change, to the line after it.
    for (let i = 0; i < 30; i += 1) {
      const s = await walk(page);
      if (s.focus > DELTA) break;
      await page.keyboard.press('j');
      await page.waitForTimeout(40);
    }
    let state = await walk(page);
    assert.equal(state.focus, DELTA + 1);
    assert.equal(state.provisional.length, 4);
    assert.equal((await pendingIds(bob.page)).length, 4, 'the other reader saw an accept before commit');
    await page.keyboard.press('a');
    await waitFor(page, () => (window.proof?.getAllMarks?.() ?? []).filter(m => m.data?.status === 'pending').length === 0);
    state = await walk(page);
    assert.equal(state.provisional.length, 0);
    await waitFor(bob.page, () => (window.proof?.getAllMarks?.() ?? []).filter(m => m.data?.status === 'pending').length === 0, null, 12000);
    await waitFor(bob.page, () => document.querySelector('.ProseMirror')?.innerText.includes('ALPHA word'), null, 12000);
    await waitFor(page, i => document.querySelector(`.plm-dot[data-line="${i}"]`)?.dataset.status === 'agreed', DELTA + 1);
  });
  await check(`${tag}: explicit accepts are never undone by scrolling back up`, async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await waitFor(page, () => window.__proofReadingWalk.debugState().focus === 0);
    await page.waitForTimeout(300);
    assert.equal((await pendingIds(page)).length, 0);
    assert.ok((await page.locator('.ProseMirror').innerText()).includes('DELTA word'));
  });
  await check(`${tag}: Next issue moves the focus line`, async () => {
    await page.keyboard.press('j'); await page.keyboard.press('j');
    const before = (await walk(page)).focus;
    await page.locator('#share-banner .plm-next').click();
    await page.waitForTimeout(200);
    const after = (await walk(page)).focus;
    const flash = await page.evaluate(() => document.querySelector('.plm-flash')?.getBoundingClientRect().top ?? null);
    const focusTop = await page.evaluate(() => document.querySelector('.prw-focus')?.getBoundingClientRect().top ?? null);
    assert.notEqual(after, before, 'focus did not move');
    assert.ok(flash !== null && Math.abs(flash - focusTop) < 12, `flash ${flash} vs focus ${focusTop}`);
  });
  await check(`${tag}: a margin dot focuses its line and keeps the box in the rail (no popover)`, async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.locator('.plm-dot[data-line="3"]').click();
    await waitFor(page, () => window.__proofReadingWalk.debugState().focus === 3);
    assert.equal(await page.locator('.plm-menu').count(), 0);
    assert.equal(await page.locator('.prw-right .plm-box').getAttribute('data-line'), '3');
  });
  await check(`${tag}: both rails collapse and the text re-centres`, async () => {
    await page.locator('.prw-left .prw-collapse').click();
    await page.locator('.prw-right .prw-collapse').click();
    await page.waitForTimeout(200);
    const info = await page.evaluate(() => ({ t: document.querySelector('.ProseMirror').getBoundingClientRect().toJSON(), w: innerWidth,
      l: document.querySelector('.prw-left').getBoundingClientRect().width, r: document.querySelector('.prw-right').getBoundingClientRect().width }));
    assert.ok(info.l < 60 && info.r < 60, `collapsed widths ${info.l}/${info.r}`);
    assert.ok(Math.abs((info.t.left + info.t.right) / 2 - info.w / 2) < 40, 'text not centred');
    await page.screenshot({ path: path.join(shots, `${tag}-4-collapsed.png`) });
    await page.locator('.prw-left .prw-collapse').click();
    await page.locator('.prw-right .prw-collapse').click();
  });
  await check(`${tag}: keys typed into the document (writing) do not mark or move`, async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
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
  await check(`${tag}: one column: rails hidden, no sideways scroll, focus line highlighted`, async () => {
    const info = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      left: getComputedStyle(document.querySelector('.prw-left')).display, right: getComputedStyle(document.querySelector('.prw-right')).display,
      text: document.querySelector('.ProseMirror').getBoundingClientRect().toJSON(),
      focus: (() => { const f = document.querySelector('.prw-focus'); return f && !f.hidden ? f.getBoundingClientRect().toJSON() : null; })(),
    }));
    assert.ok(info.sw <= info.cw + 1, `scrollWidth ${info.sw}`);
    assert.equal(info.left, 'none'); assert.equal(info.right, 'none');
    assert.ok(info.text.width >= 280, `text width ${info.text.width}`);
    assert.ok(info.focus, 'no focus highlight');
    await page.screenshot({ path: path.join(shots, `${tag}-1-open.png`) });
  });
  await check(`${tag}: a dot still opens the Step 1 bottom sheet`, async () => {
    await page.locator('.plm-dot[data-line="1"]').tap();
    await page.locator('.plm-menu.plm-sheet').waitFor({ state: 'visible' });
    await page.locator('.plm-menu .plm-close').tap();
  });
  await check(`${tag}: the ⋯ menu opens "This line" as a bottom sheet with the mark box`, async () => {
    await page.locator('#share-banner .share-pill-overflow').tap();
    await page.getByRole('menuitem', { name: /This line/ }).tap();
    const sheet = page.locator('.prw-right.prw-sheet-open');
    await sheet.waitFor({ state: 'visible' });
    const r = await rect(page, '.prw-right.prw-sheet-open');
    assert.ok(Math.abs(r.bottom - 844) <= 2 && r.width >= 388, `sheet ${JSON.stringify(r)}`);
    assert.ok(await sheet.locator('.plm-box').count() === 1, 'no mark box');
    await page.screenshot({ path: path.join(shots, `${tag}-2-sheet.png`) });
    await sheet.locator('.prw-collapse').tap();
  });
  await check(`${tag}: scrolling moves the focus and stops at the line with changes`, async () => {
    await page.evaluate(() => window.scrollBy(0, 4000));
    await waitFor(page, () => window.__proofReadingWalk.debugState().focus === 11);
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
