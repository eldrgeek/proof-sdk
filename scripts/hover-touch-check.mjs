#!/usr/bin/env node
// Browser check for hover focus, touch focus and closed-Issue folding (Mike, 2026-09-19):
// - Desktop: resting the mouse on a line makes it the focus line within 300 ms; the rail box shows
//   it; hover writes no mark and does not scroll; passing the mouse across lines does not thrash;
//   keys act on the hovered line; while editing, the caret owns the focus.
// - Phone: a "current line" strip is docked at the bottom, shows the line's own mark, does not
//   cover the line; Agree marks the current line; More… opens the line's sheet.
// - Closing an Issue folds the line for that viewer; a click opens it; something new on the line
//   reopens it; "Unfold closed" / "Fold closed"; a passively read line never folds.
// Authorship: Claude Opus 5 (worker proof-hover), 2026-09-19, in the style of editing-first-check.mjs.
// Starts an isolated local server on the current dist/ build (run `npm run build` first) in both
// review styles at 1440 and on a 390x844 phone. Screenshots go to .preview/ (or --shots <dir>).
// Usage: node scripts/hover-touch-check.mjs [--style playmaker|proof] [--shots dir]
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

const clientHeaders = { 'X-Proof-Client-Version': '0.31.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
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
const folded = page => page.evaluate(() => window.__proofClosedFold.debugState().folded.map(f => f.index));
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

  await check(`${tag}: hovering a line makes it the focus within 300 ms; the rail box shows it`, async () => {
    const before = await page.evaluate(() => window.scrollY);
    await hoverLine(page, 5);
    const start = Date.now();
    await page.waitForFunction(() => window.__proofReadingWalk.debugState().target === 5, null, { timeout: 1000, polling: 20 });
    const took = Date.now() - start;
    assert.ok(took <= 300, `took ${took} ms`);
    await page.waitForFunction(() => document.querySelector('.prw-linebox .plm-box')?.getAttribute('data-line') === '5', null, { timeout: 300 });
    assert.equal(await page.evaluate(() => window.scrollY), before, 'hover scrolled the page');
    assert.equal((await walk(page)).focus, 0, 'hover moved the reading position');
    await page.screenshot({ path: path.join(shots, `${tag}-hover.png`) });
  });

  await check(`${tag}: hover is not reading (no mark on the hovered line after its dwell)`, async () => {
    await page.waitForTimeout(1500);
    assert.equal(await myMarkOn(page, 5), null);
    assert.ok(!(await walk(page)).seenWrites.includes(5), 'the hovered line was written Seen');
  });

  await check(`${tag}: passing the mouse across lines does not thrash (one focus change, at the resting line)`, async () => {
    const before = (await walk(page)).hoverWrites;
    const first = await block(page, 7).boundingBox();
    const last = await block(page, 12).boundingBox();
    await page.mouse.move(first.x + 50, first.y + 5);
    for (let y = first.y + 5; y <= last.y + last.height / 2; y += 12) { await page.mouse.move(first.x + 50, y); await page.waitForTimeout(8); }
    await page.waitForFunction(() => window.__proofReadingWalk.debugState().target === 12, null, { timeout: 1000, polling: 20 });
    const after = (await walk(page)).hoverWrites;
    assert.ok(after - before <= 2, `${after - before} focus changes`);
  });

  await check(`${tag}: moving off the text keeps the focus`, async () => {
    await page.mouse.move(1430, 450, { steps: 3 });
    await page.waitForTimeout(400);
    assert.equal((await walk(page)).target, 12);
  });

  const isFolded = (i) => page.evaluate(i => Boolean(document.querySelector(`.ProseMirror .pclose-folded[data-pclose-line="${i}"]`)), i);
  const scrollAwayAndBack = async (i) => {
    await page.evaluate(() => window.scrollTo(0, 2600));
    await page.waitForFunction(i => document.querySelector(`.ProseMirror .pclose-folded[data-pclose-line="${i}"]`), i, { timeout: 4000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
  };

  await check(`${tag}: A on the hovered line agrees it; it never folds while in view, and folds for me once scrolled away`, async () => {
    await hoverLine(page, 6);
    await page.waitForFunction(() => window.__proofReadingWalk.debugState().target === 6, null, { timeout: 1000 });
    await page.keyboard.press('a');
    await page.waitForFunction(i => window.__proofLineMarks.debugState().marks.some(m => m.by === window.__proofLineMarks.me() && m.anchor.ordinal === i && m.status === 'agreed'), 6, { timeout: 4000 });
    await page.waitForTimeout(1600);
    assert.equal(await isFolded(6), false, 'folded under the reader while it is the focus line');
    await hoverLine(page, 3);
    await page.waitForTimeout(1000);
    assert.equal(await isFolded(6), false, 'folded while in view');
    await scrollAwayAndBack(6);
    assert.equal(await isFolded(6), true, 'did not stay folded when scrolled back');
    const summary = await page.locator('.ProseMirror .pclose-folded[data-pclose-line="6"]').getAttribute('data-pclose-summary');
    assert.match(summary, /^✓ agreed — Paragraph 6 is plain text/);
    const h = (await block(page, 6).boundingBox()).height;
    assert.ok(h < 40, `folded height ${h}`);
    await page.screenshot({ path: path.join(shots, `${tag}-closed-folded.png`) });
  });

  await check(`${tag}: a passively read line never folds`, async () => {
    const seen = (await walk(page)).seenWrites;
    assert.ok(seen.length > 0, 'nothing was read passively');
    const f = await folded(page);
    for (const line of seen) assert.ok(!f.includes(line), `passively read line ${line} folded`);
  });

  await check(`${tag}: a click on a folded line opens it (no caret, no scroll)`, async () => {
    const before = await page.evaluate(() => window.scrollY);
    const row = page.locator('.ProseMirror .pclose-folded[data-pclose-line="6"]');
    const box = await row.boundingBox();
    await page.mouse.click(box.x + 30, box.y + box.height / 2);
    await page.waitForTimeout(250);
    assert.equal(await row.count(), 0, 'still folded');
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest?.('.ProseMirror'))), false, 'the click placed a caret');
    assert.equal(await page.evaluate(() => window.scrollY), before);
  });

  await check(`${tag}: Fold closed folds opened lines again; Unfold closed opens them all`, async () => {
    // Accord layout stage 3: these outline tools live on the Navigator's Outline tab.
    await page.locator('.prw-left .anv-tab[data-tab="outline"]').click();
    await page.locator('.prw-left .pclose-refold').click();
    await page.waitForFunction(() => document.querySelector('.ProseMirror .pclose-folded[data-pclose-line="6"]'), null, { timeout: 2000 });
    await page.locator('.prw-left .pclose-unfold').click();
    await page.waitForFunction(() => !document.querySelector('.ProseMirror .pclose-folded'), null, { timeout: 2000 });
    await page.locator('.prw-left .pclose-refold').click();
    await page.waitForFunction(() => document.querySelector('.ProseMirror .pclose-folded[data-pclose-line="6"]'), null, { timeout: 2000 });
  });

  await check(`${tag}: something new on a folded line reopens it`, async () => {
    await page.evaluate(() => document.activeElement?.blur());
    await hoverLine(page, 8);
    await page.waitForFunction(() => window.__proofReadingWalk.debugState().target === 8, null, { timeout: 1000 });
    await page.keyboard.press('a');
    await hoverLine(page, 3);
    await page.waitForTimeout(1500);
    await scrollAwayAndBack(8);
    await created.post('/marks/suggest-replace', { quote: 'Paragraph 8 is plain', content: 'Paragraph 8 is simple', by: 'ai:check' });
    await page.waitForFunction(() => !document.querySelector('.ProseMirror .pclose-folded[data-pclose-line="8"]'), null, { timeout: 8000 });
  });

  await check(`${tag}: while editing, the caret owns the focus (hover does not move it)`, async () => {
    await page.waitForFunction(() => window.__proofReadingWalk?.debugState().ready === true, null, { timeout: 10_000 });
    const target = block(page, 14);
    await target.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.waitForTimeout(300);
    const box = await target.boundingBox();
    await page.mouse.click(box.x + 20, box.y + box.height / 2);
    // Let the click settle into the editor's selection before typing (see the report: typing at
    // once after a click here put the caret at the end of the document, with or without folds).
    await page.waitForTimeout(200);
    await page.keyboard.type('x');
    await page.waitForFunction(() => window.__proofReadingWalk.debugState().target === 14, null, { timeout: 2000 });
    await hoverLine(page, 16);
    await page.waitForTimeout(400);
    assert.equal((await walk(page)).target, 14);
  });
  await check(`${tag}: folds are per viewer and survive a reload`, async () => {
    await page.reload();
    await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 15_000 });
    await page.waitForFunction(() => document.querySelector('.ProseMirror .pclose-folded[data-pclose-line="6"]'), null, { timeout: 6000 });
    const other = await openDoc(browser, base, created.slug, 'Bea', { viewport: { width: 1440, height: 900 } });
    await other.page.waitForTimeout(1500);
    assert.equal(await other.page.locator('.ProseMirror .pclose-folded').count(), 0, 'another viewer sees folds');
    await other.context.close();
  });

  await context.close();
}

async function runPhone(browser, base, tag) {
  const created = await createDoc(base);
  const { context, page } = await openDoc(browser, base, created.slug, 'Ada', { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
  activePage = page;
  const strip = page.locator('.prw-strip');

  await check(`${tag}: the current-line strip is visible and names the reading line and its mark`, async () => {
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

  await check(`${tag}: Agree in the strip marks the current line (and it then folds for me)`, async () => {
    const focus = (await walk(page)).focus;
    await page.locator('.prw-strip-agree').tap();
    await page.waitForFunction(i => window.__proofLineMarks.debugState().marks.some(m => m.by === window.__proofLineMarks.me() && m.anchor.ordinal === i && m.status === 'agreed'), focus, { timeout: 4000 });
    await page.waitForFunction(() => document.querySelector('.prw-strip')?.dataset.status === 'agreed', null, { timeout: 4000 });
    // It folds once scrolled out of view (never under the reader's eyes).
    await page.waitForTimeout(1500);
    assert.equal(await page.locator(`.ProseMirror .pclose-folded[data-pclose-line="${focus}"]`).count(), 0, 'folded in view');
    const y = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => window.scrollBy(0, 2000));
    await page.waitForFunction(i => document.querySelector(`.ProseMirror .pclose-folded[data-pclose-line="${i}"]`), focus, { timeout: 4000 });
    await page.evaluate(y => window.scrollTo(0, y), y);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(shots, `${tag}-agreed-folded.png`) });
    const row = page.locator(`.ProseMirror .pclose-folded[data-pclose-line="${focus}"]`);
    await row.tap();
    await page.waitForTimeout(300);
    assert.equal(await row.count(), 0, 'a tap did not open the folded line');
  });

  // Accord layout stage 3 (decision 11): ⋯ opens the Margin sheet on the Line tab with More showing.
  await check(`${tag}: ⋯ opens the Margin sheet with the line's More marks`, async () => {
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(200);
    await page.locator('.prw-strip-more').tap();
    const sheet = page.locator('.prw-right.prw-sheet-open');
    await sheet.waitFor({ state: 'visible', timeout: 3000 });
    await sheet.locator('.plm-more').waitFor({ state: 'visible', timeout: 3000 });
    const focus = (await walk(page)).target;
    assert.equal(await sheet.locator('.plm-box').getAttribute('data-line'), String(focus));
    await page.screenshot({ path: path.join(shots, `${tag}-more-sheet.png`) });
    await page.locator('.prw-strip-grab').tap();
    await page.waitForFunction(() => !document.querySelector('.prw-right.prw-sheet-open'), null, { timeout: 2000 });
  });

  await check(`${tag}: tapping text still edits, and the strip steps aside while the keyboard is up`, async () => {
    const focus = (await walk(page)).focus;
    const target = block(page, focus + 1);
    const box = await target.boundingBox();
    await page.touchscreen.tap(box.x + 20, box.y + box.height / 2);
    await page.waitForTimeout(300);
    const where = await page.evaluate(() => ({ active: document.activeElement?.className ?? '', tag: document.activeElement?.tagName, hit: document.elementFromPoint(100, 100)?.className }));
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest?.('.ProseMirror'))), true, `no caret ${JSON.stringify(where)} at ${JSON.stringify(box)}`);
    await page.waitForFunction(() => document.querySelector('.prw-strip')?.hidden === true, null, { timeout: 2000 });
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForFunction(() => document.querySelector('.prw-strip')?.hidden === false, null, { timeout: 2000 });
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
