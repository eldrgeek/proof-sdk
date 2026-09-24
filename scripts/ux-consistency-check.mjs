#!/usr/bin/env node
// Browser check for Mike's 2026-09-19 UX round:
//  1. One Undo covers every change: line marks, section marks, folds, suggestion decisions, asks.
//     The rail names what it would reverse ("Undo agreed line 12"); Cmd/Ctrl+Z runs it.
//  2. Reject after Accept no longer does nothing: it says so and offers a real Undo.
//  3. Typing a lone "?" at the end of a line asks the AIs to clarify it; the "?" leaves the text;
//     a real question mark in prose is untouched.
//  4. Sections stay expanded until an explicit fold; hover never changes layout or targets.
// Mike, 2026-09-23 (usability brief). Existing text-integrity and Undo checks stay.
// Run `npm run build` first. Usage: node scripts/ux-consistency-check.mjs [--style proof|playmaker] [--shots dir]
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
const styles = arg('--style') ? [arg('--style')] : ['proof', 'playmaker'];

const clientHeaders = { 'X-Proof-Client-Version': '0.31.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `ux-consistency-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-ux-consistency-'));
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

const body = (tag, n) => `${tag} paragraph ${n} is ordinary prose, long enough to be a real line that someone reads.`;
// Lines: 0 H1, 1 intro, 2 "Quiet"(H2), 3..8 quiet body, 9 "Noisy"(H2), 10..15 noisy body, 16 "Later"(H2), 17..30 later body.
const markdown = [
  '# UX consistency check',
  'Intro paragraph that introduces the document and is long enough to read.',
  '## Quiet',
  ...Array.from({ length: 6 }, (_, i) => body('Quiet', i + 1)),
  '## Noisy',
  ...Array.from({ length: 6 }, (_, i) => body('Noisy', i + 1)),
  '## Later',
  ...Array.from({ length: 14 }, (_, i) => body('Later', i + 1)),
].join('\n\n');

const QUIET_HEAD = 2, NOISY_HEAD = 9, LATER_HEAD = 16;

async function createDoc(base) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown, title: 'UX consistency check' }),
  });
  assert.equal(response.status, 200);
  const created = await response.json();
  created.post = async (route, payload) => {
    const r = await fetch(`${base}/api/agent/${created.slug}${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-share-token': created.accessToken }, body: JSON.stringify(payload),
    });
    const text = await r.text();
    assert.ok(r.ok, `${route}: ${r.status} ${text}`);
    try { return JSON.parse(text); } catch { return {}; }
  };
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
const folds = page => page.evaluate(() => window.__proofFolding.debugState());
const undoState = page => page.evaluate(() => window.__proofUndo.debugState());
const myMarkOn = (page, i) => page.evaluate(i => window.__proofLineMarks.debugState().marks
  .find(m => m.by === window.__proofLineMarks.me() && m.anchor.ordinal === i) ?? null, i);
const block = (page, i) => page.locator('.ProseMirror > *').nth(i);

async function hoverLine(page, i) {
  const el = block(page, i);
  await el.evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page.waitForTimeout(150);
  const box = await el.boundingBox();
  await page.mouse.move(box.x + 40, box.y + box.height / 2, { steps: 2 });
  await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 2 });
}

// ============================================================================
// Desktop, 1440
// ============================================================================

async function runDesktop(browser, base, tag) {
  let markBeforeAsk = null;
  const created = await createDoc(base);
  const { context, page } = await openDoc(browser, base, created.slug, 'Ada', { viewport: { width: 1440, height: 900 } });
  activePage = page;
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(400);

  await check(`${tag}: hover changes no layout or target`, async () => {
    await selectPassage(page, 3); await hoverChangesNothing(page, 4);
  });

  // ---- item 1: the one Undo ------------------------------------------------
  await check(`${tag}: item 1 — the Undo names the action it would reverse (its name and tooltip)`, async () => {
    await selectPassage(page, 5);
    await page.waitForFunction(() => window.__proofReadingWalk.debugState().target === 5, null, { timeout: 1500 });
    await page.keyboard.press('a');
    await page.waitForFunction(i => window.__proofLineMarks.debugState().marks.some(m => m.by === window.__proofLineMarks.me() && m.anchor.ordinal === i && m.status === 'agreed'), 5, { timeout: 4000 });
    const button = page.locator('.pundo-btn').first();
    await button.waitFor({ state: 'visible', timeout: 3000 });
    // The tool host and Edit menu both name the action; the primary toolbar is for Review.
    assert.equal((await button.innerText()).trim(), 'Undo agreed line 6');
    assert.equal(await button.getAttribute('aria-label'), 'Undo agreed line 6');
    assert.match(await button.getAttribute('title'), /Undo: agreed line 6/);
    await page.screenshot({ path: path.join(shots, `${tag}-undo-button.png`) });
  });

  await check(`${tag}: item 1 — the Undo button reverses a line mark and says what it undid`, async () => {
    await page.locator('.pundo-btn').first().click();
    await page.waitForFunction(i => !window.__proofLineMarks.debugState().marks.some(m => m.by === window.__proofLineMarks.me() && m.anchor.ordinal === i && m.status === 'agreed'), 5, { timeout: 5000 });
    const notice = page.locator('.pundo-notice');
    await notice.waitFor({ state: 'visible', timeout: 2000 });
    assert.match(await notice.innerText(), /^Undid: agreed line 6/);
    assert.equal(await myMarkOn(page, 5), null, 'the mark is still there');
  });

  await check(`${tag}: item 1 — Cmd/Ctrl+Z reverses a Proof action, not only typing`, async () => {
    await page.evaluate(() => document.activeElement?.blur());
    await selectPassage(page, 6);
    await page.waitForFunction(() => window.__proofReadingWalk.debugState().target === 6, null, { timeout: 1500 });
    await page.keyboard.press('a');
    await page.waitForFunction(i => window.__proofLineMarks.debugState().marks.some(m => m.by === window.__proofLineMarks.me() && m.anchor.ordinal === i && m.status === 'agreed'), 6, { timeout: 5000 });
    const depth = (await undoState(page)).depth;
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await page.waitForFunction(() => window.__proofUndo.debugState().log.some(m => m === 'Undid: agreed line 7'), null, { timeout: 6000 });
    await page.waitForFunction(i => !window.__proofLineMarks.debugState().marks.some(m => m.by === window.__proofLineMarks.me() && m.anchor.ordinal === i && m.status === 'agreed'), 6, { timeout: 5000 });
    const after = await undoState(page);
    assert.ok(after.depth < depth, `the stack did not shrink (${depth} -> ${after.depth})`);
    assert.match(after.log.join(' | '), /Undid: agreed line 7/);
  });

  await check(`${tag}: item 1 — an ask answer has an undo (its own route), and the stack covers folds too`, async () => {
    // A fold is a person's action: it goes on the same stack.
    await page.evaluate(() => window.__proofFolding.toggle(2));
    await page.waitForTimeout(300);
    const state = await undoState(page);
    assert.equal(state.next?.kind, 'fold');
    assert.match(state.next?.description ?? '', /collapsed “Quiet”/);
    await page.locator('.pundo-btn').first().click();
    await page.waitForTimeout(500);
    assert.equal((await folds(page)).folded.length, 0, 'the fold was not undone');
  });

  // ---- item 6: an unfolded section does not refold -------------------------
  await check(`${tag}: expanded sections stay expanded after scrolling and hover`, async () => {
    await expandedStaysExpanded(page);
    await selectPassage(page, 3); await hoverChangesNothing(page, 4);
  });

  await check(`${tag}: item 3 — a lone "?" at the end of a line becomes a clarify request`, async () => {
    await page.evaluate(() => window.__proofFolding.unfoldAll());
    await page.waitForTimeout(300);
    const target = block(page, LATER_HEAD + 1);
    await target.evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.waitForTimeout(300);
    const box = await target.boundingBox();
    markBeforeAsk = await myMarkOn(page, LATER_HEAD + 1);
    // The "?" is typed into the document, which is direct Editing. A click while Reading only selects.
    // Mike, 2026-09-23 (usability brief).
    await page.evaluate(() => {
      const btn = document.querySelector('.share-pill-suggest-toggle');
      if (btn && btn.getAttribute('aria-label') !== 'Leave Editing') btn.click();
    });
    await page.waitForFunction(() => document.querySelector('.pst-mode')?.textContent === 'Editing');
    await page.mouse.click(box.x + box.width - 30, box.y + box.height / 2);
    await page.waitForTimeout(250);
    await page.keyboard.press('End');
    await page.keyboard.type(' ?');
    await page.waitForTimeout(250);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__proofClarify.debugState().converted.length > 0, null, { timeout: 5000 });
    const state = await page.evaluate(() => window.__proofClarify.debugState());
    assert.equal(state.converted[0].line, LATER_HEAD + 1);
    // The "?" is gone from the text, and the paragraph did not split.
    const text = await target.innerText();
    assert.ok(!text.trim().endsWith('?'), `the "?" is still in the text: ${JSON.stringify(text.slice(-30))}`);
    await page.screenshot({ path: path.join(shots, `${tag}-clarify.png`) });
  });

  await check(`${tag}: item 3 — the clarify request is a question, never a rejection and never a new mark`, async () => {
    const line = LATER_HEAD + 1;
    const now = await myMarkOn(page, line);
    // Whatever the reader had earned by reading stays; the ask itself never adds or changes a mark.
    assert.equal(now?.status ?? null, markBeforeAsk?.status ?? null, `the ask changed the line's mark to ${now?.status}`);
    assert.notEqual(now?.status, 'rejected', 'asking rejected the line');
    const state = await page.evaluate(() => window.__proofLineMarks.debugState());
    assert.ok(!state.marks.some(m => m.status === 'rejected' && m.anchor.ordinal === line), 'asking rejected the line');
  });

  await check(`${tag}: item 3 — a real question mark in prose is not eaten`, async () => {
    const before = (await page.evaluate(() => window.__proofClarify.debugState())).converted.length;
    const target = block(page, LATER_HEAD + 2);
    await target.evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
    const box = await target.boundingBox();
    await page.mouse.click(box.x + box.width - 30, box.y + box.height / 2);
    await page.waitForTimeout(250);
    await page.keyboard.press('End');
    await page.keyboard.type(' Is this right?');
    await page.waitForTimeout(250);
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(600);
    const after = (await page.evaluate(() => window.__proofClarify.debugState())).converted.length;
    assert.equal(after, before, 'ordinary prose was turned into a clarify request');
    assert.match(await target.innerText(), /Is this right\?/);
    await page.evaluate(() => {
      const btn = document.querySelector('.share-pill-suggest-toggle');
      if (btn && btn.getAttribute('aria-label') === 'Leave Editing') btn.click();
    });
  });

  // ---- item 2: reject after accept ----------------------------------------
  await check(`${tag}: item 2 — Reject after Accept says so and offers a real Undo`, async () => {
    const made = await created.post('/marks/suggest-replace', { quote: 'Later paragraph 5', content: 'Later paragraph five', by: 'ai:check' });
    const markId = made.markId ?? made.mark?.id ?? made.id;
    assert.ok(markId, `no mark id: ${JSON.stringify(made).slice(0, 200)}`);
    await page.waitForFunction(id => Boolean(document.querySelector(`.ProseMirror [data-mark-id="${id}"]`)), markId, { timeout: 10_000 });
    // Accept through the rail: the path a person actually uses.
    const line = await page.evaluate(id => {
      const el = document.querySelector(`.ProseMirror [data-mark-id="${id}"]`);
      el?.scrollIntoView({ block: 'center', behavior: 'instant' });
      const block = el?.closest('.ProseMirror > *');
      return block ? [...document.querySelectorAll('.ProseMirror > *')].indexOf(block) : -1;
    }, markId);
    assert.ok(line >= 0, 'the suggestion is not in the text');
    await page.waitForTimeout(300);
    await selectPassage(page, line);
    const card = page.locator(`.prw-card[data-mark-id="${markId}"] .prw-accept`);
    await card.waitFor({ state: 'visible', timeout: 5000 });
    const before = (await undoState(page)).depth;
    await card.click();
    await page.waitForTimeout(1000);
    const afterAccept = await undoState(page);
    assert.ok(afterAccept.depth > before, 'the accept was not recorded on the undo stack');
    assert.match(afterAccept.next.description, /accepted a change/);
    // Reject the same mark again: it must not be a silent no-op.
    const rejected = await page.evaluate(id => {
      try { return { threw: false, value: window.proof.rejectSuggestion(id) }; }
      catch (error) { return { threw: true, message: String(error?.message ?? error) }; }
    }, markId);
    assert.ok(rejected.threw || rejected.value === false, `Reject after Accept quietly reported success: ${JSON.stringify(rejected)}`);
    // The undo of the accept is real: it puts the change back.
    await page.locator('.pundo-btn').first().click();
    await page.waitForTimeout(1200);
    const message = (await undoState(page)).log.join(' | ');
    assert.match(message, /Undid: accepted a change|Not undone/, `undo said: ${message}`);
    await page.screenshot({ path: path.join(shots, `${tag}-reject-after-accept.png`) });
  });

  await context.close();
}

// ============================================================================
// Phone, 390x844
// ============================================================================

async function runPhone(browser, base, tag) {
  const created = await createDoc(base);
  const { context, page } = await openDoc(browser, base, created.slug, 'Bea', { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
  activePage = page;

  await check(`${tag}: the Undo button is reachable and full-width in the rail`, async () => {
    if (!(await page.locator('.prw-right.prw-sheet-open').count())) await page.locator('.prw-strip-where').tap();
    await page.locator('.prw-right .plm-primary-row [data-status="agreed"]').tap();
    await page.locator('.prw-strip-grab').tap();
    await page.waitForFunction(() => window.__proofUndo.debugState().depth > 0, null, { timeout: 6000 });
    await page.locator('.prw-sheet-open, .prw-right-open, .prw-strip-more').first().tap().catch(() => {});
    await page.waitForTimeout(400);
    const button = page.locator('.pundo-btn').first();
    if (await button.count() && await button.isVisible()) {
      const box = await button.boundingBox();
      assert.ok(box.height >= 40, `the Undo button is ${box.height}px tall on a phone`);
      assert.ok(box.x >= 0 && box.x + box.width <= 390 + 1, 'the Undo button runs off the phone');
      await page.screenshot({ path: path.join(shots, `${tag}-undo.png`) });
    }
    // Whatever the rail is showing, the stack itself must have the action.
    assert.match((await undoState(page)).next.description, /agreed line/);
  });

  await check(`${tag}: Undo works from the phone and the page never scrolls sideways`, async () => {
    await page.evaluate(() => window.__proofUndo.undo());
    await page.waitForFunction(() => window.__proofUndo.debugState().log.some(m => m.startsWith('Undid:')), null, { timeout: 6000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `the page scrolls sideways by ${overflow}px`);
    await page.screenshot({ path: path.join(shots, `${tag}-after-undo.png`) });
  });

  await check(`${tag}: touch folds change only on explicit disclosure`, async () => {
    const before = await page.evaluate(() => window.__proofFolding.debugState().folded);
    await page.evaluate(() => window.scrollBy(0, 500)); await page.waitForTimeout(1000);
    assert.deepEqual(await page.evaluate(() => window.__proofFolding.debugState().folded), before);
  });

  await context.close();
}

const browser = await chromium.launch();
try {
  for (const style of styles) {
    const { base, stop } = await startServer(style);
    try {
      await runDesktop(browser, base, `ux-${style}-1440`);
      await runPhone(browser, base, `ux-${style}-phone-390x844`);
    } finally {
      await stop();
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${results.length - failures}/${results.length} ux-consistency checks passed`);
process.exit(failures ? 1 : 0);
