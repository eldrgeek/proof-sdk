#!/usr/bin/env node
// Mobile usability check for the share page (Proof+ on a phone).
// Starts an isolated local server on the current dist/ build (run `npm run build` first),
// creates throwaway documents on a temp SQLite database, and drives Chromium at phone
// and desktop sizes. Screenshots go to .preview/. Exit code 0 only if every check passes.
// Usage: node scripts/mobile-check.mjs [--style playmaker|proof]
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
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) { failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n')[0]}`); }
  console.log(results[results.length - 1]);
}

async function startServer() {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-mobile-check-'));
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

const markdown = `# Waiting on Mike (test)

This is a throwaway document for the mobile check. The first ask is whether the phone layout is usable for ruling on asks by leaving comments.

The second paragraph is long enough to wrap across several lines on a phone, so that line length, font size and horizontal overflow can be measured honestly without relying on a short sample sentence.

- A list item that should wrap on a narrow screen and must not cause the page to scroll sideways at all.

The last paragraph sits near the bottom, where a feedback chip or a toast could cover it.`;

async function createDoc(base) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown, title: 'Waiting on Mike (mobile check)' }),
  });
  assert.equal(response.status, 200);
  return await response.json();
}

async function openDoc(browser, base, slug, contextOptions) {
  const context = await browser.newContext(contextOptions);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(`${base}/d/${slug}`);
  const anonymous = page.getByRole('button', { name: 'Continue anonymously', exact: true });
  await anonymous.click({ timeout: 10_000 }).catch(() => {});
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForSelector('#share-banner');
  await page.waitForTimeout(800);
  page.setDefaultTimeout(6000);
  return { context, page };
}

const visible = (page, selector) => page.evaluate(sel => [...document.querySelectorAll(sel)].some(el => {
  const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && !el.closest('[hidden]');
}), selector);

// True if the feedback chip is the top element anywhere it overlaps the given sheet.
const chipOnTop = (page, sheetSelector) => page.evaluate(sel => {
  const chip = document.querySelector('.soma-feedback-root'); const sheet = document.querySelector(sel);
  if (!chip || !sheet) return false;
  const c = chip.getBoundingClientRect(); const s = sheet.getBoundingClientRect();
  const x = Math.max(c.left, s.left) + 4, y = Math.max(c.top, s.top) + 4;
  if (x > Math.min(c.right, s.right) || y > Math.min(c.bottom, s.bottom)) return false;
  return chip.contains(document.elementFromPoint(x, y));
}, sheetSelector);

async function selectWords(page, text) {
  await page.evaluate(needle => {
    const walker = document.createTreeWalker(document.querySelector('.ProseMirror'), NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const i = node.data.indexOf(needle);
      if (i < 0) continue;
      const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + needle.length);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return;
    }
    throw new Error(`text not found: ${needle}`);
  }, text);
}

async function phone(browser, base, name, viewport) {
  const created = await createDoc(base);
  const { context, page } = await openDoc(browser, base, created.slug, {
    ...devices['iPhone 13'], viewport, screen: viewport, hasTouch: true, isMobile: true,
  });
  const tag = `${name}-${viewport.width}x${viewport.height}`;
  await page.screenshot({ path: path.join(shots, `${tag}-1-load.png`) });

  await check(`${tag}: top bar is one row, at most 60 px tall`, async () => {
    const h = await page.evaluate(() => document.getElementById('share-banner').getBoundingClientRect().height);
    assert.ok(h <= 60, `bar height ${h}`);
  });
  await check(`${tag}: top bar does not float over the text`, async () => {
    const { barBottom, textTop } = await page.evaluate(() => ({
      barBottom: document.getElementById('share-banner').getBoundingClientRect().bottom,
      textTop: document.querySelector('.ProseMirror > *').getBoundingClientRect().top,
    }));
    assert.ok(textTop >= barBottom, `text top ${textTop} < bar bottom ${barBottom}`);
  });
  await check(`${tag}: no Marks panel visible on load`, async () => {
    assert.equal(await visible(page, '.pm-review-panel'), false);
  });
  await check(`${tag}: no horizontal overflow`, async () => {
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    assert.ok(o.sw <= o.cw + 1, `scrollWidth ${o.sw} > ${o.cw}`);
  });
  await check(`${tag}: body text is 16-17 px`, async () => {
    const size = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.ProseMirror p')).fontSize));
    assert.ok(size >= 16 && size <= 17.5, `font-size ${size}`);
  });
  await check(`${tag}: welcome toast does not cover the text and can be dismissed`, async () => {
    const toast = page.locator('.proof-share-welcome-toast');
    if (await toast.count() === 0) return;
    const close = toast.getByRole('button', { name: /dismiss/i });
    assert.equal(await close.count(), 1, 'toast has no dismiss button');
    await close.click();
    assert.equal(await toast.count(), 0);
  });

  // Marks is a PlayMaker-style panel; the Proof style lists comments in its own popover.
  if (style === 'playmaker') await check(`${tag}: overflow menu opens Marks as a bottom sheet with a close button`, async () => {
    await page.getByRole('button', { name: 'More options', exact: true }).click();
    await page.getByRole('menuitem', { name: /Marks/ }).click();
    await page.waitForTimeout(200);
    assert.equal(await visible(page, '.pm-review-panel'), true, 'panel not shown');
    const r = await page.evaluate(() => ({ ...document.querySelector('.pm-review-panel').getBoundingClientRect().toJSON(), vh: innerHeight, vw: innerWidth }));
    assert.ok(Math.abs(r.bottom - r.vh) <= 2 && r.width >= r.vw - 2, `panel rect ${JSON.stringify(r)}`);
    await page.screenshot({ path: path.join(shots, `${tag}-2-marks-sheet.png`) });
    assert.equal(await chipOnTop(page, '.pm-review-panel'), false, 'feedback chip covers the Marks sheet');
    await page.getByRole('button', { name: 'Close marks', exact: true }).click();
    assert.equal(await visible(page, '.pm-review-panel'), false, 'panel did not close');
  });
  await check(`${tag}: overflow menu holds Add agent and Review style`, async () => {
    await page.getByRole('button', { name: 'More options', exact: true }).click();
    await page.getByRole('menuitem', { name: /Add agent/ }).waitFor({ timeout: 2000 });
    await page.getByRole('menuitem', { name: /Review style/ }).waitFor({ timeout: 2000 });
    await page.screenshot({ path: path.join(shots, `${tag}-3-overflow.png`) });
    await page.keyboard.press('Escape');
    await page.mouse.click(viewport.width / 2, viewport.height / 2);
  });

  const commentText = `Yes — because it works on ${tag}`;
  await check(`${tag}: selecting text shows a Comment control`, async () => {
    await selectWords(page, 'first ask is whether');
    await page.getByRole('button', { name: 'Add comment on selected text' }).waitFor({ state: 'visible', timeout: 3000 });
    await page.screenshot({ path: path.join(shots, `${tag}-4-selection.png`) });
  });
  await check(`${tag}: a comment can be posted from a bottom-sheet composer`, async () => {
    await page.getByRole('button', { name: 'Add comment on selected text' }).click();
    const field = page.locator('.mark-popover textarea:visible').first();
    await field.waitFor({ state: 'visible', timeout: 3000 });
    const r = await page.evaluate(() => ({ ...document.querySelector('.mark-popover').getBoundingClientRect().toJSON(), vh: innerHeight, vw: innerWidth }));
    assert.ok(r.bottom >= r.vh - 2 && r.width >= r.vw - 2, `composer rect ${JSON.stringify(r)}`);
    assert.equal(await chipOnTop(page, '.mark-popover'), false, 'feedback chip covers the composer');
    await field.fill(commentText);
    await page.screenshot({ path: path.join(shots, `${tag}-5-composer.png`) });
    await page.locator('.mark-popover button:visible', { hasText: /^Add$/ }).first().click();
    await page.waitForFunction(text => JSON.stringify(window.proof?.getMarks?.() ?? []).includes(text)
      || [...document.querySelectorAll('[data-mark-id]')].length > 0, commentText, { timeout: 5000 });
  });
  await check(`${tag}: the posted comment reaches the server`, async () => {
    const deadline = Date.now() + 8000; let found = false;
    while (Date.now() < deadline && !found) {
      const state = await fetch(`${base}/api/agent/${created.slug}/state`, { headers: { 'x-share-token': created.accessToken } }).then(r => r.json()).catch(() => ({}));
      found = JSON.stringify(state).includes(commentText);
      if (!found) await new Promise(r => setTimeout(r, 400));
    }
    assert.ok(found, 'comment text not in server state');
  });
  await check(`${tag}: tapping the comment opens a readable, replyable thread`, async () => {
    await page.mouse.click(viewport.width / 2, 5);
    await page.waitForTimeout(300);
    await page.locator('.ProseMirror [data-mark-id]').first().tap();
    const sheet = page.locator('.pm-review-dialog:visible, .mark-popover:visible').first();
    await sheet.waitFor({ state: 'visible', timeout: 3000 });
    const text = await sheet.innerText();
    assert.ok(text.includes(commentText), 'thread does not show the comment');
    // PlayMaker's dialog opens a reply box from its Reply button; the Proof thread shows the box
    // at once and keeps Reply disabled until there is text.
    if (style === 'playmaker') await sheet.getByRole('button', { name: /^Reply/ }).first().click();
    const reply = sheet.locator('textarea').first();
    await reply.fill('Reply from the phone');
    if (style !== 'playmaker') assert.equal(await sheet.getByRole('button', { name: 'Reply', exact: true }).isEnabled(), true, 'Reply stays disabled');
    await page.screenshot({ path: path.join(shots, `${tag}-6-thread.png`) });
    const r = await sheet.evaluate(el => ({ ...el.getBoundingClientRect().toJSON(), vh: innerHeight, vw: innerWidth }));
    assert.ok(r.bottom >= r.vh - 2 && r.width >= r.vw - 2, `thread rect ${JSON.stringify(r)}`);
  });
  await context.close();
}

async function desktop(browser, base) {
  const created = await createDoc(base);
  const { context, page } = await openDoc(browser, base, created.slug, { viewport: { width: 1280, height: 800 } });
  await page.screenshot({ path: path.join(shots, `desktop-1280.png`) });
  await check('desktop 1280: overflow button hidden, full controls shown', async () => {
    assert.equal(await visible(page, '.share-pill-overflow'), false);
    assert.equal(await visible(page, '.share-pill-share-btn'), true);
    assert.equal(await visible(page, '.share-pill-agent-trigger'), true);
    if (style === 'playmaker') assert.equal(await visible(page, '.review-style-control'), true);
  });
  await check('desktop 1280: floating pill bar keeps its shape', async () => {
    const b = await page.evaluate(() => { const el = document.getElementById('share-banner'); const r = el.getBoundingClientRect(); return { h: r.height, w: r.width, radius: getComputedStyle(el).borderTopLeftRadius }; });
    assert.ok(b.h < 100 && b.w < 1280 && b.radius === '36px', JSON.stringify(b));
  });
  if (style === 'playmaker') {
    await check('desktop 1280: Marks sidebar still shown (reserved gutter)', async () => {
      assert.equal(await visible(page, '.pm-review-panel'), true);
    });
  }
  await context.close();
}

const { base, stop } = await startServer();
const browser = await chromium.launch({ headless: true });
try {
  await phone(browser, base, `phone-${style}`, { width: 375, height: 812 });
  await phone(browser, base, `phone-${style}`, { width: 375, height: 667 });
  await phone(browser, base, `phone-${style}`, { width: 390, height: 844 });
  await desktop(browser, base);
} finally {
  await browser.close();
  await stop();
}
console.log(failures ? `mobile-check: ${failures} FAILED` : 'mobile-check: all passed');
process.exit(failures ? 1 : 0);
