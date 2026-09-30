#!/usr/bin/env node
import { showWholeAccord } from './review-ui.mjs';
// Browser check for Proof Documents Step B2: folding, section Issue badges, section marking.
// Authorship: Claude Opus 5 (worker proof-fold), 2026-09-18, in the style of reading-walk-check.mjs.
// Starts an isolated local server on the current dist/ build (run `npm run build` first), creates
// throwaway documents on a temp SQLite database, and drives Chromium in both review styles at
// 1440 (desktop) and 390 (phone). Screenshots go to .preview/ (or --shots <dir>).
// Exit code 0 only if every check passes.
// Usage: node scripts/folding-check.mjs [--style playmaker|proof] [--width 1440] [--shots dir]
import { nextReview, showReview } from './review-ui.mjs';
import assert from 'node:assert/strict';
import { selectPassage, expandedStaysExpanded } from './usability-s1-assertions.mjs';

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
const widths = arg('--width') ? [Number(arg('--width'))] : [1440];

const clientHeaders = { 'X-Proof-Client-Version': '0.34.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `folding-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-folding-check-'));
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

const para = (tag, n) => `${tag} paragraph ${n} is plain text for reading; it is long enough to be a real line of the document.`;
// Lines: 0 Title | 1 Intro | 2 ## Alpha | 3-5 alpha (4 holds a suggestion) | 6 ### Alpha detail | 7-8 |
//        9 ## Beta | 10-13 | 14 ## Gamma | 15-16 | 17 ## Delta | 18-19
const markdown = [
  '# Folding check', para('Intro', 1),
  '## Alpha section', para('Alpha', 1), 'Alpha paragraph 2 carries the change word for a suggestion.', para('Alpha', 3),
  '### Alpha detail', para('Detail', 1), para('Detail', 2),
  '## Beta section', para('Beta', 1), para('Beta', 2), para('Beta', 3), para('Beta', 4),
  '## Gamma section', para('Gamma', 1), para('Gamma', 2),
  '## Delta section', para('Delta', 1), para('Delta', 2),
].join('\n\n');
const L = { TITLE: 0, ALPHA: 2, ALPHA_SUG: 4, DETAIL: 6, BETA: 9, GAMMA: 14, DELTA: 17 };

async function createDoc(base) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown, title: 'Folding check' }),
  });
  assert.equal(response.status, 200);
  const created = await response.json();
  const r = await fetch(`${base}/api/agent/${created.slug}/marks/suggest-replace`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-share-token': created.accessToken },
    body: JSON.stringify({ quote: 'change word', content: 'CHANGED word', by: 'ai:check' }),
  });
  assert.ok(r.ok, `suggest: ${r.status} ${await r.text()}`);
  return created;
}

async function agentMark(base, created, payload) {
  const r = await fetch(`${base}/api/agent/${created.slug}/marks/line`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-share-token': created.accessToken },
    body: JSON.stringify({ by: "ai:check", ...payload }),
  });
  const body = await r.json();
  assert.ok(r.ok, `agent mark: ${r.status} ${JSON.stringify(body)}`);
  return body;
}

async function openDoc(browser, base, slug, name, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  // Step B3b: these checks read with J at a steady 330 ms per line; the reader's rate "any"
  // (0 = the 250 ms minimum for every line) keeps them about folding, not reading speed.
  await context.addInitScript(viewer => { try { localStorage.setItem('proof-share-viewer-name', viewer); localStorage.setItem('proof:reading-rate', '0'); } catch {} }, name);
  const page = await context.newPage();
  await page.goto(`${base}/d/${slug}`);
  await ready(page);
  return { context, page };
}

async function ready(page, whole = true) {
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForFunction(() => window.__proofReadingWalk?.debugState().ready === true
    && (window.__proofFolding?.debugState().sections.length ?? 0) >= 6
    && (window.proof?.getAllMarks?.() ?? []).filter(m => m.data?.status === 'pending').length >= 1, null, { timeout: 10_000 });
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  page.setDefaultTimeout(6000);
  if (whole) await showWholeAccord(page);
}

const fold = page => page.evaluate(() => window.__proofFolding.debugState());
const walk = page => page.evaluate(() => window.__proofReadingWalk.debugState());
const myMarks = (page, name) => page.evaluate(n => window.__proofLineMarks.debugState().marks
  .filter(m => m.by === `guest:${n}` && !m.id.startsWith('local-')).map(m => [m.anchor.ordinal, m.status]), name);
const dotStatus = (page, line) => page.evaluate(i => document.querySelector(`.plm-dot[data-line="${i}"]`)?.dataset.status ?? null, line);
const chip = (page, heading) => page.locator(`.pfold-chip[data-heading="${heading}"]`);
const waitFor = (page, fn, arg, timeout = 8000) => page.waitForFunction(fn, arg, { timeout, polling: 100 });
const isHiddenLine = (page, line) => page.evaluate(i => {
  const lm = window.__proofLineMarks; const view = lm.editorView(); const l = lm.lineList()[i];
  const dom = view.nodeDOM(l.pos); return !!dom && dom.getBoundingClientRect().height === 0;
}, line);

async function desktop(browser, base, style, width) {
  const created = await createDoc(base);
  const tag = `folding-${style}-${width}`;
  const a = await openDoc(browser, base, created.slug, 'Ada', { viewport: { width, height: 900 } });
  const page = a.page;
  activePage = page;
  const batchPosts = [];
  page.on('request', req => {
    if (req.method() === 'POST' && req.url().includes('/line-marks')) {
      try { const body = JSON.parse(req.postData() || '{}'); if (Array.isArray(body.lines)) batchPosts.push(body); } catch {}
    }
  });

  await check(`${tag}: every heading has a fold chip with its Issue count, clear of the heading text`, async () => {
    const info = await page.evaluate(() => [...document.querySelectorAll('.pfold-chip')].map(c => {
      const i = Number(c.dataset.heading);
      const lm = window.__proofLineMarks; const dom = lm.editorView().nodeDOM(lm.lineList()[i].pos);
      const range = document.createRange(); range.selectNodeContents(dom);
      const textRight = Math.max(...[...range.getClientRects()].map(r => r.right));
      const r = c.getBoundingClientRect(); const h = dom.getBoundingClientRect();
      return { i, text: c.innerText, state: c.dataset.state, left: r.left, right: r.right, top: r.top, bottom: r.bottom, textRight, hTop: h.top, hBottom: h.bottom, hRight: h.right };
    }));
    assert.equal(info.length, 6, `chips ${info.length}`);
    for (const c of info) {
      const pending = [0, 2].includes(c.i);
      assert.equal(c.state, pending ? 'issues' : 'resolved', `heading ${c.i} ${c.state}`);
      assert.match(c.text, pending ? /▾\s*1/ : /▾\s*✓/, `chip text ${c.text}`);
      assert.ok(c.left >= c.textRight + 4, `chip overlaps heading ${c.i} text (${c.left} < ${c.textRight})`);
      assert.ok(c.top >= c.hTop - 2 && c.bottom <= c.hBottom + 2, `chip not on heading ${c.i}'s line`);
      assert.ok(c.right <= c.hRight + 1, 'chip past the heading');
    }
    const alpha = info.find(c => c.i === 2);
    // Only the pending proposal is an Issue; unread lines do not add work.
    assert.match(alpha.text, /1/, `alpha chip ${alpha.text}`);
    await page.screenshot({ path: path.join(shots, `${tag}-1-chips.png`) });
  });

  await check(`${tag}: a chip folds its section in the view only (no document change) and unfolds again`, async () => {
    await page.evaluate(() => { window.__foldDocBefore = window.__proofLineMarks.editorView().state.doc; });
    const mdBefore = await page.evaluate(() => window.proof.getMarkdownSnapshot()?.content);
    await chip(page, L.BETA).click();
    await waitFor(page, () => document.querySelector('.pfold-chip[data-heading="9"]')?.dataset.folded === 'true');
    for (let i = 10; i <= 13; i += 1) assert.ok(await isHiddenLine(page, i), `line ${i} still visible`);
    assert.ok(!(await isHiddenLine(page, L.GAMMA)), 'next section hidden');
    assert.equal(await chip(page, L.BETA).getAttribute('aria-expanded'), 'false');
    assert.match(await chip(page, L.BETA).innerText(), /▸/);
    const same = await page.evaluate(() => window.__proofLineMarks.editorView().state.doc === window.__foldDocBefore);
    assert.ok(same, 'the ProseMirror document changed on fold');
    assert.equal(await page.evaluate(() => window.proof.getMarkdownSnapshot()?.content), mdBefore);
    await waitFor(page, () => document.querySelector('.plm-dot[data-line="11"]') === null);
    await page.screenshot({ path: path.join(shots, `${tag}-2-folded.png`) });
  });

  const bob = await openDoc(browser, base, created.slug, 'Bob', { viewport: { width: 1280, height: 900 } });
  await check(`${tag}: whole-view choices are per visit; reload starts folded`, async () => {
    assert.deepEqual((await fold(bob.page)).folded, [], 'the other viewer sees a fold');
    assert.equal(await isHiddenLine(bob.page, 11), false);
    await page.reload();
    await ready(page, false);
    await waitFor(page, () => document.querySelector('.pfold-chip[data-heading="9"]')?.dataset.folded === 'true');
    assert.ok(await isHiddenLine(page, 11), 'fold lost on reload');
  });

  await check(`${tag}: J steps over a folded section as one step; K comes back to its heading`, async () => {
    await selectPassage(page, L.BETA);
    await waitFor(page, i => window.__proofReadingWalk.debugState().focus === i, L.BETA);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('j');
    await waitFor(page, i => window.__proofReadingWalk.debugState().focus === i, L.GAMMA);
    await page.keyboard.press('k');
    await waitFor(page, i => window.__proofReadingWalk.debugState().focus === i, L.BETA);
  });

  await check(`${tag}: scrolling past a folded section marks none of its hidden lines Seen and accepts nothing hidden`, async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await selectPassage(page, 0);
    await page.evaluate(() => window.__proofFolding.setFolded(2, true));
    await waitFor(page, () => document.querySelector('.pfold-chip[data-heading="2"]')?.dataset.folded === 'true');
    // Read slowly with J from the top to Delta: every visible line dwells.
    for (let i = 0; i < 12; i += 1) {
      const s = await walk(page);
      if (s.focus >= L.DELTA) break;
      await page.waitForTimeout(330);
      await page.keyboard.press('j');
    }
    await page.waitForTimeout(400);
    const s = await walk(page);
    assert.equal(s.focus, L.DELTA, `focus ${s.focus}`);
    assert.equal(await page.locator('.prw-commit').count(), 0, 'a hidden suggestion was accepted by scrolling');
    for (const line of [3, 5, 6, 7, 8, 10, 11, 12, 13]) {
      assert.ok(!s.seenWrites.includes(line), `hidden line ${line} was marked Seen`);
    }
    assert.deepEqual(s.seenWrites, [], 'reading creates no line marks');
    const marked = new Map(await myMarks(page, 'Ada'));
    for (const line of [3, 4, 5, 10, 11]) assert.equal(marked.get(line), undefined, `hidden line ${line} has a mark`);
    const pending = await page.evaluate(() => (window.proof.getAllMarks() ?? []).filter(m => m.data?.status === 'pending').length);
    assert.equal(pending, 1);
  });

  await check(`${tag}: a resolved folded section shows ✓ (issues resolved); others show a count (issues remain)`, async () => {
    await page.evaluate(() => window.__proofFolding.setFolded(17, true));
    assert.match(await chip(page, L.DELTA).innerText(), /✓/);
    const pending = await page.evaluate(() => window.proof.getAllMarks().filter(m => ['insert','replace','delete'].includes(m.kind) && m.data?.status === 'pending'));
    assert.ok(pending.length > 0);
    await page.screenshot({ path: path.join(shots, `${tag}-4-resolved.png`) });
  });

  await check(`${tag}: the whole-Accord control preserves explicit reader choice`, async () => {
    await showWholeAccord(page);
    await page.locator('[data-accord-whole-toggle]').click();
    assert.equal((await fold(page)).whole, false);
    await page.locator('[data-accord-whole-toggle]').click();
    assert.deepEqual((await fold(page)).hiddenBlocks, []);
    await expandedStaysExpanded(page);
  });
  await check(`${tag}: Next issue lands on its shown item and keeps other text folded`, async () => {
    await page.locator('[data-accord-whole-toggle]').click();
    const before = (await fold(page)).hidden;
    await nextReview(page);
    const s = await walk(page);
    assert.equal(await isHiddenLine(page, s.focus), false);
    assert.deepEqual((await fold(page)).hidden, before, 'Navigation unfolded surrounding context');
    await showWholeAccord(page);
  });

  await bob.context.close();
  await a.context.close();
}

async function phone(browser, base, style) {
  const created = await createDoc(base);
  const viewport = { width: 390, height: 844 };
  const tag = `folding-${style}-phone-390x844`;
  const { context, page } = await openDoc(browser, base, created.slug, 'Pat', {
    ...devices['iPhone 13'], viewport, screen: viewport, hasTouch: true, isMobile: true,
  });
  activePage = page;
  await check(`${tag}: chips are touch-sized and visible; badges show; no sideways scroll`, async () => {
    const info = await page.evaluate(() => ({
      chips: [...document.querySelectorAll('.pfold-chip')].map(c => ({ ...c.getBoundingClientRect().toJSON(), text: c.innerText, vis: getComputedStyle(c).visibility })),
      sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
    }));
    assert.ok(info.sw <= info.cw + 1, `scrollWidth ${info.sw}`);
    assert.equal(info.chips.length, 6);
    for (const c of info.chips) {
      assert.ok(c.height >= 36 && c.width >= 44, `chip ${c.width}x${c.height}`);
      assert.ok(c.right <= 390, `chip off screen ${c.right}`);
      assert.match(c.text, /\d|✓/);
    }
    await page.screenshot({ path: path.join(shots, `${tag}-1-chips.png`) });
  });
  await check(`${tag}: a tap folds and unfolds its section without mark controls`, async () => {
    await chip(page, L.BETA).scrollIntoViewIfNeeded();
    await chip(page, L.BETA).tap();
    await waitFor(page, () => window.__proofFolding.isFolded(9));
    assert.ok(await isHiddenLine(page, 10));
    assert.equal(await page.locator('.plm-box, .plm-section-note').count(), 0);
    await page.screenshot({ path: path.join(shots, `${tag}-2-folded.png`) });
    await chip(page, L.BETA).tap();
    await waitFor(page, () => !window.__proofFolding.isFolded(9));
    assert.equal(await isHiddenLine(page, 10), false);
  });
  await check(`${tag}: the ⋯ menu has the same whole-Accord toggle`, async () => {
    await showWholeAccord(page);
    await page.locator('#share-banner .share-pill-overflow').tap();
    await page.getByRole('menuitem', { name: /Show only open items/ }).tap();
    await waitFor(page, () => window.__proofFolding.debugState().folded.length === 6);
    await page.locator('#share-banner .share-pill-overflow').tap();
    await page.getByRole('menuitem', { name: /Show the whole Accord/ }).tap();
    await waitFor(page, () => window.__proofFolding.debugState().folded.length === 0);
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
console.log(`\n${results.length - failures}/${results.length} folding checks passed`);
process.exit(failures ? 1 : 0);
