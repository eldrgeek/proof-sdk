#!/usr/bin/env node
// Browser check for Proof Documents Step B2: folding, section Issue badges, section marking.
// Authorship: Claude Opus 5 (worker proof-fold), 2026-09-18, in the style of reading-walk-check.mjs.
// Starts an isolated local server on the current dist/ build (run `npm run build` first), creates
// throwaway documents on a temp SQLite database, and drives Chromium in both review styles at
// 1440 (desktop) and 390 (phone). Screenshots go to .preview/ (or --shots <dir>).
// Exit code 0 only if every check passes.
// Usage: node scripts/folding-check.mjs [--style playmaker|proof] [--width 1440] [--shots dir]
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
const widths = arg('--width') ? [Number(arg('--width'))] : [1440];

const clientHeaders = { 'X-Proof-Client-Version': '0.31.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
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

async function ready(page) {
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForFunction(() => window.__proofReadingWalk?.debugState().ready === true
    && (window.__proofFolding?.debugState().sections.length ?? 0) >= 6
    && (window.proof?.getAllMarks?.() ?? []).filter(m => m.data?.status === 'pending').length >= 1, null, { timeout: 10_000 });
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  page.setDefaultTimeout(6000);
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
      assert.equal(c.state, 'issues', `heading ${c.i} ${c.state}`);
      assert.match(c.text, /▾\s*\d+/, `chip text ${c.text}`);
      assert.ok(c.left >= c.textRight + 4, `chip overlaps heading ${c.i} text (${c.left} < ${c.textRight})`);
      assert.ok(c.top >= c.hTop - 2 && c.bottom <= c.hBottom + 2, `chip not on heading ${c.i}'s line`);
      assert.ok(c.right <= c.hRight + 1, 'chip past the heading');
    }
    const alpha = info.find(c => c.i === 2);
    // Alpha: 7 lines, every one unseen by ai:check at least, plus the pending suggestion.
    assert.match(alpha.text, /8/, `alpha chip ${alpha.text}`);
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
  await check(`${tag}: fold state is per viewer and survives a reload`, async () => {
    assert.deepEqual((await fold(bob.page)).folded, [], 'the other viewer sees a fold');
    assert.equal(await isHiddenLine(bob.page, 11), false);
    await page.reload();
    await ready(page);
    await waitFor(page, () => document.querySelector('.pfold-chip[data-heading="9"]')?.dataset.folded === 'true');
    assert.ok(await isHiddenLine(page, 11), 'fold lost on reload');
  });

  await check(`${tag}: J steps over a folded section as one step; K comes back to its heading`, async () => {
    await page.locator(`.plm-dot[data-line="${L.BETA}"]`).click();
    await waitFor(page, i => window.__proofReadingWalk.debugState().focus === i, L.BETA);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('j');
    await waitFor(page, i => window.__proofReadingWalk.debugState().focus === i, L.GAMMA);
    await page.keyboard.press('k');
    await waitFor(page, i => window.__proofReadingWalk.debugState().focus === i, L.BETA);
  });

  await check(`${tag}: scrolling past a folded section marks none of its hidden lines Seen and accepts nothing hidden`, async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await waitFor(page, () => window.__proofReadingWalk.debugState().focus === 0);
    await chip(page, L.ALPHA).click();
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
    assert.deepEqual(s.provisional, [], 'a hidden suggestion was accepted by scrolling');
    for (const line of [3, 4, 5, 6, 7, 8, 10, 11, 12, 13]) {
      assert.ok(!s.seenWrites.includes(line), `hidden line ${line} was marked Seen`);
    }
    for (const line of [0, 1, L.ALPHA, L.BETA, L.GAMMA]) assert.notEqual(await dotStatus(page, line), 'unseen', `visible line ${line} not read`);
    const marked = new Map(await myMarks(page, 'Ada'));
    for (const line of [3, 4, 5, 10, 11]) assert.equal(marked.get(line), undefined, `hidden line ${line} has a mark`);
    const pending = await page.evaluate(() => (window.proof.getAllMarks() ?? []).filter(m => m.data?.status === 'pending').length);
    assert.equal(pending, 1);
  });

  await check(`${tag}: A on a folded heading agrees with every line of the section in one request; Undo restores`, async () => {
    // Alpha is folded. Line 3 gets a Seen and line 5 an Approve? (not owner) — give line 7 a Reject first.
    await chip(page, L.ALPHA).click(); // unfold to reject one line inside
    await waitFor(page, () => document.querySelector('.pfold-chip[data-heading="2"]')?.dataset.folded === 'false');
    await page.locator('.plm-dot[data-line="7"]').click();
    await waitFor(page, () => window.__proofReadingWalk.debugState().focus === 7);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('r');
    await page.locator('.prw-right .plm-reason input:not(.plm-condition)').fill('Detail is wrong');
    await page.keyboard.press('Enter');
    await waitFor(page, () => document.querySelector('.plm-dot[data-line="7"]')?.dataset.status === 'rejected');
    await page.evaluate(() => document.activeElement?.blur());
    await chip(page, L.ALPHA).click();
    await waitFor(page, () => document.querySelector('.pfold-chip[data-heading="2"]')?.dataset.folded === 'true');
    await page.locator(`.plm-dot[data-line="${L.ALPHA}"]`).click();
    await waitFor(page, i => window.__proofReadingWalk.debugState().focus === i, L.ALPHA);
    const note = await page.locator('.prw-right .plm-section-note').innerText();
    assert.match(note, /all 7 lines/, note);
    await page.evaluate(() => document.activeElement?.blur());
    const before = batchPosts.length;
    await page.keyboard.press('a');
    await waitFor(page, () => document.querySelector('.plm-toast[data-action]') !== null);
    await page.waitForTimeout(600);
    assert.equal(batchPosts.length - before, 1, `section mark sent ${batchPosts.length - before} batch requests`);
    const sent = batchPosts[batchPosts.length - 1];
    assert.equal(sent.status, 'agreed');
    assert.equal(sent.lines.length, 6, 'the rejected line was overwritten or a line is missing');
    await waitFor(page, () => window.__proofLineMarks.debugState().marks.filter(m => m.by === 'guest:Ada' && m.status === 'agreed' && !m.id.startsWith('local-')).length >= 6);
    const marks = new Map(await myMarks(page, 'Ada'));
    for (const line of [2, 3, 4, 5, 6, 8]) assert.equal(marks.get(line), 'agreed', `line ${line}: ${marks.get(line)}`);
    assert.equal(marks.get(7), 'rejected', 'my reject was overwritten');
    assert.equal(await dotStatus(page, L.ALPHA), 'agreed');
    await page.screenshot({ path: path.join(shots, `${tag}-3-section-agreed.png`) });
    // Bob sees the marks too.
    await waitFor(bob.page, () => window.__proofLineMarks.debugState().marks.filter(m => m.by === 'guest:Ada' && m.status === 'agreed').length >= 6, null, 12000);
    // Undo: one request; lines go back to their earlier marks (Seen from reading, or none).
    await page.locator('.plm-toast[data-action] .plm-toast-action').click();
    await page.waitForTimeout(800);
    assert.equal(batchPosts.length - before, 2, 'undo is not one request');
    await waitFor(page, () => window.__proofLineMarks.debugState().marks.filter(m => m.by === 'guest:Ada' && m.status === 'agreed').length === 0);
    const after = new Map(await myMarks(page, 'Ada'));
    assert.equal(after.get(L.ALPHA), 'seen', 'heading did not go back to Seen');
    assert.equal(after.get(3), undefined, 'hidden line kept a mark after undo');
    assert.equal(after.get(7), 'rejected');
  });

  await check(`${tag}: R on a folded heading shows the "reject a specific line" hint, not a reason field`, async () => {
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('r');
    const hint = page.locator('.prw-right .plm-section-hint');
    await hint.waitFor({ state: 'visible' });
    assert.match(await hint.innerText(), /specific line/);
    assert.equal(await page.locator('.prw-right .plm-reason').isVisible(), false);
  });

  await check(`${tag}: on an unfolded heading a mark applies to the heading line only`, async () => {
    await chip(page, L.GAMMA).scrollIntoViewIfNeeded();
    await page.locator(`.plm-dot[data-line="${L.GAMMA}"]`).click();
    await waitFor(page, i => window.__proofReadingWalk.debugState().focus === i, L.GAMMA);
    assert.equal(await page.locator('.prw-right .plm-section-note').count(), 0);
    await page.evaluate(() => document.activeElement?.blur());
    const before = batchPosts.length;
    await page.keyboard.press('a');
    await waitFor(page, i => document.querySelector(`.plm-dot[data-line="${i}"]`)?.dataset.status === 'agreed', L.GAMMA);
    await page.waitForTimeout(300);
    assert.equal(batchPosts.length, before, 'an unfolded heading sent a batch');
    assert.notEqual(await dotStatus(page, L.GAMMA + 1), 'agreed');
  });

  await check(`${tag}: a resolved folded section shows ✓ (issues resolved); others show a count (issues remain)`, async () => {
    // Close Delta's issues for the whole team: the AI marks it by section, Bob and Ada by folded heading.
    await agentMark(base, created, { status: 'seen', section: { quote: 'Delta section' } });
    for (const p of [bob.page, page]) {
      await p.evaluate(() => window.__proofFolding.setFolded(17, true));
      await p.evaluate(() => { window.__proofReadingWalk.focusLine(17); });
      await p.evaluate(() => document.activeElement?.blur());
      await p.waitForTimeout(200);
      await p.keyboard.press('a');
      await p.waitForTimeout(500);
    }
    await waitFor(page, () => document.querySelector('.pfold-chip[data-heading="17"]')?.dataset.state === 'resolved', null, 12000);
    assert.match(await chip(page, L.DELTA).innerText(), /✓/);
    assert.equal(await chip(page, L.BETA).getAttribute('data-state'), 'issues');
    await page.screenshot({ path: path.join(shots, `${tag}-4-resolved.png`) });
  });

  await check(`${tag}: Fold all, level and Unfold all controls in the right rail`, async () => {
    const controls = page.locator('.prw-right .pfold-controls');
    await controls.getByRole('button', { name: 'Fold every section', exact: true }).click();
    let f = await fold(page);
    assert.equal(f.folded.length, 6);
    assert.ok(await isHiddenLine(page, L.ALPHA), 'Alpha heading visible under a folded title');
    await controls.getByRole('button', { name: 'Show headings down to level 2' }).click();
    f = await fold(page);
    assert.equal(await isHiddenLine(page, L.ALPHA), false);
    assert.ok(await isHiddenLine(page, 3));
    assert.equal(await isHiddenLine(page, 1), false, 'the H1 body before the first H2 is hidden');
    await page.screenshot({ path: path.join(shots, `${tag}-5-level2.png`) });
    await controls.getByRole('button', { name: 'Unfold every section', exact: true }).click();
    f = await fold(page);
    assert.deepEqual(f.folded, []);
    assert.deepEqual(f.hiddenBlocks, []);
  });

  await check(`${tag}: Next issue unfolds the section that holds the next issue`, async () => {
    await page.locator('.prw-right .pfold-controls').getByRole('button', { name: 'Fold every section', exact: true }).click();
    const hiddenBefore = new Set((await fold(page)).hidden);
    let unfoldedOne = false;
    for (let i = 0; i < 6 && !unfoldedOne; i += 1) {
      await page.locator('#share-banner .plm-next').click();
      await page.waitForTimeout(250);
      const s = await walk(page);
      assert.equal(await isHiddenLine(page, s.focus), false, `Next issue landed on hidden line ${s.focus}`);
      if (hiddenBefore.has(s.focus)) unfoldedOne = true;
    }
    assert.ok(unfoldedOne, 'Next issue never went into a folded section');
    await page.locator('.prw-right .pfold-controls').getByRole('button', { name: 'Unfold every section', exact: true }).click();
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
  await check(`${tag}: a tap folds a section; the folded heading's dot sheet marks the whole section`, async () => {
    await chip(page, L.BETA).scrollIntoViewIfNeeded();
    await chip(page, L.BETA).tap();
    await waitFor(page, () => document.querySelector('.pfold-chip[data-heading="9"]')?.dataset.folded === 'true');
    assert.ok(await isHiddenLine(page, 10));
    await page.locator(`.plm-dot[data-line="${L.BETA}"]`).tap();
    const sheet = page.locator('.plm-menu.plm-sheet');
    await sheet.waitFor({ state: 'visible' });
    assert.match(await sheet.locator('.plm-section-note').innerText(), /all 5 lines/);
    await page.screenshot({ path: path.join(shots, `${tag}-2-sheet.png`) });
    await sheet.getByRole('button', { name: /Seen/ }).tap();
    await waitFor(page, () => window.__proofLineMarks.debugState().marks.filter(m => m.by === 'guest:Pat' && m.status === 'seen' && !m.id.startsWith('local-')).length >= 5);
    await page.screenshot({ path: path.join(shots, `${tag}-3-marked.png`) });
  });
  await check(`${tag}: the ⋯ menu has Fold all and Unfold all`, async () => {
    await page.locator('#share-banner .share-pill-overflow').tap();
    await page.getByRole('menuitem', { name: /Fold all/ }).tap();
    await waitFor(page, () => window.__proofFolding.debugState().folded.length === 6);
    await page.locator('#share-banner .share-pill-overflow').tap();
    await page.getByRole('menuitem', { name: /Unfold all/ }).tap();
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
