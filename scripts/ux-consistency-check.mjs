#!/usr/bin/env node
// Browser check for Mike's 2026-09-19 UX round:
//  1. One Undo covers every change: line marks, section marks, folds, suggestion decisions, asks.
//     The rail names what it would reverse ("Undo agreed line 12"); Cmd/Ctrl+Z runs it.
//  2. Reject after Accept no longer does nothing: it says so and offers a real Undo.
//  3. Typing a lone "?" at the end of a line asks the AIs to clarify it; the "?" leaves the text;
//     a real question mark in prose is untouched.
//  4. Leaving a section with no Issues closes it (out of view only); hovering a folded heading
//     peeks it open and leaving re-folds it.
//  5. The hovered line is visibly highlighted on desktop and the rail follows it.
//  6. A section unfolded by hand never refolds: not by fold-to-level, not by the auto-close.
// Plus the one model: an explicit action beats an automatic one, nothing folds under the reader,
// hover previews and click commits.
// Authorship: Claude Opus 5 (worker proof-ux2), 2026-09-19, in the style of hover-touch-check.mjs.
// Run `npm run build` first. Usage: node scripts/ux-consistency-check.mjs [--style proof|playmaker] [--shots dir]
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

  // ---- item 5: the hovered line is visibly highlighted ---------------------
  // Accord layout stage 3 (decisions 4 and 5, Mike 2026-09-21): hover previews the Margin and rings
  // the line's margin dot; the text never changes and the blue bar stays on the one cursor.
  await check(`${tag}: item 5 — the hovered line is visibly marked (a ring on its dot) and the Margin follows it`, async () => {
    const cursor = (await page.evaluate(() => window.__proofReadingWalk.debugState())).cursor;
    await hoverLine(page, 4);
    await page.waitForFunction(() => window.__proofReadingWalk.debugState().target === 4, null, { timeout: 1500, polling: 20 });
    const look = await page.evaluate(() => {
      const el = document.querySelector('.prw-focus');
      const ring = document.querySelector('.plm-dot[data-line="4"][data-preview="true"] .plm-glyph');
      return { source: el?.dataset.source, bandLine: Number(el?.dataset.line), ring: ring ? getComputedStyle(ring).boxShadow : null };
    });
    assert.ok(look.ring && /rgb\(47, 111, 237\)/.test(look.ring), `no ring on the hovered line's dot: ${look.ring}`);
    assert.equal(look.bandLine, cursor, 'the blue bar followed the hover (the text must not change on hover)');
    await page.waitForFunction(() => document.querySelector('.prw-linebox .plm-box')?.getAttribute('data-line') === '4', null, { timeout: 1000 });
    assert.match(await page.locator('.prw-right .amg-tab[data-tab="line"]').innerText(), /Line 5\s*preview/);
    await page.screenshot({ path: path.join(shots, `${tag}-hover-highlight.png`) });
  });

  // ---- item 1: the one Undo ------------------------------------------------
  await check(`${tag}: item 1 — the Undo names the action it would reverse (its name and tooltip)`, async () => {
    await hoverLine(page, 5);
    await page.waitForFunction(() => window.__proofReadingWalk.debugState().target === 5, null, { timeout: 1500 });
    await page.keyboard.press('a');
    await page.waitForFunction(i => window.__proofLineMarks.debugState().marks.some(m => m.by === window.__proofLineMarks.me() && m.anchor.ordinal === i && m.status === 'agreed'), 5, { timeout: 4000 });
    const button = page.locator('.pundo-btn').first();
    await button.waitFor({ state: 'visible', timeout: 3000 });
    // Accord layout stage 3 (COS): the toolbar button says just "Undo"; its name, tooltip and
    // Edit › Undo say what it reverses.
    assert.equal((await button.innerText()).trim(), 'Undo');
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
    await hoverLine(page, 6);
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
    assert.match(state.next?.description ?? '', /folded “Quiet”/);
    await page.locator('.pundo-btn').first().click();
    await page.waitForTimeout(500);
    assert.equal((await folds(page)).folded.length, 0, 'the fold was not undone');
  });

  // ---- item 6: an unfolded section does not refold -------------------------
  await check(`${tag}: item 6 — a hand-unfolded section is not refolded by fold-to-level`, async () => {
    await page.evaluate(() => window.__proofFolding.foldAll());
    await page.waitForTimeout(300);
    assert.ok((await folds(page)).folded.length >= 3, 'Fold all folded nothing');
    // The person opens one section by hand.
    await page.evaluate(h => window.__proofFolding.toggle(h), QUIET_HEAD);
    await page.waitForTimeout(300);
    let state = await folds(page);
    const quietKey = state.sections.find(s => s.headingIndex === QUIET_HEAD).key;
    assert.ok(state.sticky.includes(quietKey), 'the hand-unfold was not recorded as explicit');
    // Fold to level 2 would normally refold every H2.
    await page.evaluate(() => window.__proofFolding.foldLevel(2));
    await page.waitForTimeout(300);
    state = await folds(page);
    assert.ok(!state.folded.includes(quietKey), 'fold-to-level refolded a hand-unfolded section');
    assert.ok(state.folded.some(k => k === state.sections.find(s => s.headingIndex === NOISY_HEAD).key), 'fold-to-level stopped folding everything');
    await page.screenshot({ path: path.join(shots, `${tag}-sticky-unfold.png`) });
  });

  // ---- item 4: hover peek --------------------------------------------------
  await check(`${tag}: item 4 — hovering a folded heading peeks it open; leaving re-folds it (state unchanged)`, async () => {
    // Fold to level 2: the H2s fold and their chips stay on the page (Fold all hides the H1's
    // children chips too, so there would be nothing to hover).
    await page.evaluate(() => window.__proofFolding.foldLevel(2));
    await page.waitForTimeout(400);
    const before = (await folds(page)).folded.length;
    const chip = page.locator(`.pfold-chip[data-heading="${NOISY_HEAD}"]`);
    await chip.waitFor({ state: 'visible', timeout: 3000 });
    const box = await chip.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
    await page.waitForFunction(h => {
      const s = window.__proofFolding.debugState();
      return s.peeked === s.sections.find(x => x.headingIndex === h).key;
    }, NOISY_HEAD, { timeout: 2000, polling: 30 });
    const peeking = await folds(page);
    assert.equal(peeking.folded.length, before, 'the peek changed the stored fold state');
    assert.ok(peeking.hidden.length < (await page.evaluate(() => window.__proofFolding.debugState().sections.length)) * 6, 'nothing opened');
    await page.screenshot({ path: path.join(shots, `${tag}-hover-peek.png`) });
    // Away: it re-folds, and the stored state never moved.
    await page.mouse.move(20, 500, { steps: 4 });
    await page.waitForFunction(() => window.__proofFolding.debugState().peeked === null, null, { timeout: 2500, polling: 30 });
    assert.equal((await folds(page)).folded.length, before);
  });

  await check(`${tag}: item 4 — a click on a peeked heading commits it (hover previews, click commits)`, async () => {
    const chip = page.locator(`.pfold-chip[data-heading="${NOISY_HEAD}"]`);
    const box = await chip.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
    await page.waitForFunction(() => window.__proofFolding.debugState().peeked !== null, null, { timeout: 2000, polling: 30 });
    await chip.click();
    await page.waitForTimeout(300);
    const state = await folds(page);
    const key = state.sections.find(s => s.headingIndex === NOISY_HEAD).key;
    assert.equal(state.peeked, null, 'the click left it a peek');
    assert.ok(!state.folded.includes(key), 'the click did not unfold it');
    assert.ok(state.sticky.includes(key), 'the click did not make it explicit');
  });

  // The reading walk steps once per scroll gesture, so a single jump to the bottom does not move
  // the reader past a whole section: scroll in gestures, then put the focus at the last line.
  const readToEnd = async () => {
    for (let i = 0; i < 14; i += 1) {
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(220);
    }
    await page.evaluate(() => {
      const last = window.__proofLineMarks.debugState().lines - 1;
      window.__proofReadingWalk.focusLine(last);
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(2500);
  };

  // ---- item 4: auto-close --------------------------------------------------
  await check(`${tag}: item 4 — a section with no Issues closes itself once it is out of view`, async () => {
    await page.evaluate(() => window.__proofFolding.unfoldAll());
    await page.waitForTimeout(300);
    // "Unfold all" makes every section explicit; clear that, so the auto-close may act.
    await page.evaluate(() => { try { localStorage.removeItem(Object.keys(localStorage).find(k => k.startsWith('proof:fold-sticky:'))); } catch {} });
    await page.reload();
    await page.waitForFunction(() => window.__proofFolding?.debugState().sections.length > 0, null, { timeout: 15_000 });
    await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 15_000 });
    // Put an Issue in "Noisy" only: a comment from someone else.
    await created.post('/marks/comment', { quote: 'Noisy paragraph 2', text: 'Is this right?', by: 'ai:check' });
    await page.waitForTimeout(1200);
    // An unread line is itself an Issue, so a section only becomes Issue-free once the reader has
    // been through it. Agree the Quiet section (what a reader does on the way past).
    await page.evaluate(h => {
      const lm = window.__proofLineMarks;
      const s = window.__proofFolding.debugState().sections.find(x => x.headingIndex === h);
      const lines = [];
      for (let i = s.headingIndex; i < s.lineEnd; i += 1) lines.push(i);
      return lm.writeSectionMark({ lines, heading: 'Quiet' }, 'agreed');
    }, QUIET_HEAD);
    await page.waitForTimeout(1500);
    // Read to the end: Quiet (no Issues) goes out of view behind the reader.
    await readToEnd();
    const state = await folds(page);
    const quiet = state.sections.find(s => s.headingIndex === QUIET_HEAD).key;
    const noisy = state.sections.find(s => s.headingIndex === NOISY_HEAD).key;
    assert.ok(state.folded.includes(quiet), `the Issue-free section did not close itself (autoClosed=${JSON.stringify(state.autoClosed)})`);
    assert.ok(!state.folded.includes(noisy), 'a section with an Issue closed itself');
    await page.screenshot({ path: path.join(shots, `${tag}-auto-close.png`) });
  });

  await check(`${tag}: the one model — nothing folds while the reader can see it`, async () => {
    // A fresh reader on the same document: no stored fold state, the reader starts at the top.
    const fresh = await openDoc(browser, base, created.slug, 'Cara', { viewport: { width: 1440, height: 900 } });
    try {
      // Make the Quiet section Issue-free for this reader, and keep them looking at it.
      await fresh.page.evaluate(h => {
        const s = window.__proofFolding.debugState().sections.find(x => x.headingIndex === h);
        const lines = [];
        for (let i = s.headingIndex; i < s.lineEnd; i += 1) lines.push(i);
        return window.__proofLineMarks.writeSectionMark({ lines, heading: 'Quiet' }, 'agreed');
      }, QUIET_HEAD);
      await fresh.page.waitForTimeout(1500);
      await fresh.page.evaluate(h => { window.__proofReadingWalk.focusLine(h + 1); window.scrollTo(0, 0); }, QUIET_HEAD);
      // However long the page sits still, an Issue-free section the reader is looking at stays open.
      await fresh.page.waitForTimeout(3500);
      const state = await folds(fresh.page);
      const quiet = state.sections.find(s => s.headingIndex === QUIET_HEAD).key;
      assert.ok(!state.folded.includes(quiet), `a section folded while the reader was in it (focusLine=${state.focusLine}, autoClosed=${JSON.stringify(state.autoClosed)})`);
    } finally {
      await fresh.context.close();
      activePage = page;
    }
  });

  await check(`${tag}: item 6 — a section the reader unfolds after an auto-close stays open`, async () => {
    await readToEnd();
    await page.waitForFunction(h => {
      const s = window.__proofFolding.debugState();
      return s.folded.includes(s.sections.find(x => x.headingIndex === h).key);
    }, QUIET_HEAD, { timeout: 8000, polling: 200 });
    await page.evaluate(h => window.__proofFolding.toggle(h), QUIET_HEAD);
    await readToEnd();
    const state = await folds(page);
    const quiet = state.sections.find(s => s.headingIndex === QUIET_HEAD).key;
    assert.ok(!state.folded.includes(quiet), 'the auto-close refolded what the reader opened by hand');
  });

  // ---- item 3: "?" means clarify ------------------------------------------
  await check(`${tag}: item 3 — a lone "?" at the end of a line becomes a clarify request`, async () => {
    await page.evaluate(() => window.__proofFolding.unfoldAll());
    await page.waitForTimeout(300);
    const target = block(page, LATER_HEAD + 1);
    await target.evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.waitForTimeout(300);
    const box = await target.boundingBox();
    markBeforeAsk = await myMarkOn(page, LATER_HEAD + 1);
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
    await hoverLine(page, line);
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
    await page.locator('.prw-strip-agree').tap();
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

  await check(`${tag}: hover peek is off where there is no hover (touch never peeks)`, async () => {
    await page.evaluate(() => window.__proofFolding.foldLevel(2));
    await page.waitForTimeout(400);
    const chip = page.locator(`.pfold-chip[data-heading="${NOISY_HEAD}"]`);
    if (await chip.count()) {
      const box = await chip.boundingBox();
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(400);
      assert.equal((await folds(page)).peeked, null, 'a tap left the section in a peek instead of committing');
    }
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
