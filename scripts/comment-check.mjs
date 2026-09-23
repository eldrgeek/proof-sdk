#!/usr/bin/env node
// Desktop comment-flow check for the share page, in both review styles.
// Starts an isolated local server (one per style) on the current dist/ build (run
// `npm run build` first) with a temp SQLite database, and drives Chromium with a real
// mouse at 1280x800 and 1440x900: select text -> Comment in the selection bar -> a visible
// composer -> post -> the comment reaches the server -> reply -> resolve.
// Screenshots go to .preview/. Exit code 0 only if every check passes.
// Usage: node scripts/comment-check.mjs [--style playmaker|proof]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const shots = path.join(root, '.preview');
mkdirSync(shots, { recursive: true });
const styleArg = process.argv.indexOf('--style');
const styles = styleArg > 0 ? [process.argv[styleArg + 1]] : ['playmaker', 'proof'];
const viewports = [{ width: 1280, height: 800 }, { width: 1440, height: 900 }];

const clientHeaders = { 'X-Proof-Client-Version': '0.31.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
let failures = 0;
async function check(name, fn) {
  let line;
  try { await fn(); line = `PASS ${name}`; }
  catch (error) { failures += 1; line = `FAIL ${name}: ${error?.message?.split('\n')[0]}`; }
  console.log(line);
  return !line.startsWith('FAIL');
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-comment-check-'));
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

This is a throwaway document for the desktop comment check. The first ask is whether a ruling can be left by selecting words and commenting.

The second paragraph gives the page some body so the composer and the thread have room to open below the selection.

The last paragraph sits near the bottom of the document.`;

async function createDoc(base) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown, title: 'Waiting on Mike (comment check)' }),
  });
  assert.equal(response.status, 200);
  return await response.json();
}

async function openDoc(browser, base, slug, viewport) {
  const context = await browser.newContext({ viewport });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(`${base}/d/${slug}`);
  await page.getByRole('button', { name: 'Continue anonymously', exact: true }).click({ timeout: 10_000 }).catch(() => {});
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForSelector('#share-banner');
  await page.waitForTimeout(800);
  page.setDefaultTimeout(6000);
  const toastClose = page.locator('.proof-share-welcome-toast').getByRole('button', { name: /dismiss/i });
  if (await toastClose.count()) await toastClose.click().catch(() => {});
  return { context, page };
}

// A real element is visible if it has a box, is not display:none/visibility:hidden, and is the
// topmost element at its own centre (so a box hidden behind something else does not count).
const reallyVisible = locator => locator.evaluate(el => {
  const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
  if (r.width <= 0 || r.height <= 0 || s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
  const x = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1); const y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
  const top = document.elementFromPoint(x, y);
  return !!top && (el === top || el.contains(top) || top.contains(el));
});

// Selects text the way a person does: press at the first character, drag to the last.
async function dragSelect(page, needle) {
  const box = await page.evaluate(text => {
    const walker = document.createTreeWalker(document.querySelector('.ProseMirror'), NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const i = node.data.indexOf(text);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(node, i); range.setEnd(node, i + 1); const a = range.getBoundingClientRect();
      range.setStart(node, i + text.length - 1); range.setEnd(node, i + text.length); const b = range.getBoundingClientRect();
      return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 };
    }
    return null;
  }, needle);
  assert.ok(box, `text not found: ${needle}`);
  await page.mouse.move(box.x1, box.y1);
  await page.mouse.down();
  await page.mouse.move((box.x1 + box.x2) / 2, box.y2, { steps: 5 });
  await page.mouse.move(box.x2, box.y2, { steps: 5 });
  await page.mouse.up();
  const selected = await page.evaluate(() => getSelection().toString());
  assert.equal(selected.trim(), needle, `selected "${selected}"`);
}

async function serverMarks(base, created) {
  const state = await fetch(`${base}/api/agent/${created.slug}/state`, { headers: { 'x-share-token': created.accessToken } }).then(r => r.json()).catch(() => ({}));
  return JSON.stringify(state);
}
async function waitForServer(base, created, predicate, what) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (predicate(await serverMarks(base, created))) return;
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error(`server never showed ${what}`);
}
const localComment = (page, text) => page.evaluate(t => (window.proof?.getAllMarks?.() ?? window.proof?.getMarks?.() ?? [])
  .find(m => m.kind === 'comment' && m.data?.text === t) ?? null, text);

async function run(browser, base, style, viewport) {
  const tag = `desktop-${style}-${viewport.width}x${viewport.height}`;
  const created = await createDoc(base);
  const { context, page } = await openDoc(browser, base, created.slug, viewport);
  const commentText = `Yes — because the comment flow works on ${tag}`;
  const replyText = `Reply on ${tag}`;
  const bar = page.locator('.mark-selection-bar');
  const commentButton = bar.getByRole('button', { name: 'Comment', exact: true });

  // Rect of one element, or null when it is not on screen.
  const rectOf = selector => page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const st = getComputedStyle(el);
    if (el.hidden || st.display === 'none' || st.visibility === 'hidden') return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right } : null;
  }, selector);
  const intersects = (a, b) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  const selected = await check(`${tag}: selecting text shows a visible Comment control`, async () => {
    await dragSelect(page, 'first ask is whether');
    await commentButton.waitFor({ state: 'visible', timeout: 3000 });
    assert.equal(await reallyVisible(commentButton), true, 'Comment button is covered or hidden');
    await page.screenshot({ path: path.join(shots, `${tag}-1-selection.png`) });
  });
  if (!selected) { await context.close(); return; }

  await check(`${tag}: the selection bar clears the Marks panel, the top bar, the chip and the selected words`, async () => {
    const barRect = await rectOf('.mark-selection-bar');
    assert.ok(barRect, 'selection bar has no rect');
    for (const [name, selector] of [['Marks panel', '.pm-review-panel'], ['top bar', '#share-banner'], ['feedback chip', '.soma-feedback-root']]) {
      const other = await rectOf(selector);
      if (!other) continue;
      assert.equal(intersects(barRect, other), false, `selection bar overlaps the ${name}`);
    }
    const anchor = await page.evaluate(() => {
      const r = getSelection().getRangeAt(0).getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    });
    assert.equal(intersects(barRect, anchor), false, 'selection bar covers the selected words');
    const view = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    assert.ok(barRect.left >= 0 && barRect.right <= view.w && barRect.top >= 0 && barRect.bottom <= view.h, `selection bar off screen ${JSON.stringify(barRect)}`);
  });

  // Editing first (Mike 2026-09-19): the review-dialog walk ("Start review") and the Review
  // style selector are gone; Proof Documents (the rail) is the only review behaviour.
  await check(`${tag}: no Start review button and no Review style selector`, async () => {
    assert.equal(await page.getByRole('button', { name: 'Start review', exact: true }).count(), 0, 'Start review is still offered');
    assert.equal(await page.locator('.review-style-control select:visible').count(), 0, 'the Review style selector is still shown');
  });

  const composer = page.locator('.mark-popover textarea').first();
  const opened = await check(`${tag}: Comment opens a visible composer`, async () => {
    await commentButton.click();
    await composer.waitFor({ state: 'attached', timeout: 3000 });
    await page.waitForTimeout(250);
    const popover = page.locator('.mark-popover').first();
    assert.equal(await reallyVisible(popover), true, `composer is hidden (display=${await popover.evaluate(el => getComputedStyle(el).display)})`);
    assert.equal(await reallyVisible(composer), true, 'composer textarea is hidden or covered');
    await page.screenshot({ path: path.join(shots, `${tag}-2-composer.png`) });
  });
  if (!opened) { await page.screenshot({ path: path.join(shots, `${tag}-2-composer-FAIL.png`) }); await context.close(); return; }

  const posted = await check(`${tag}: a comment can be posted and reaches the server`, async () => {
    await composer.fill(commentText);
    const add = page.locator('.mark-popover button', { hasText: /^Add$/ }).first();
    assert.equal(await reallyVisible(add), true, 'Add button is covered (for example by the feedback chip)');
    await add.click();
    await waitForServer(base, created, s => s.includes(commentText), 'the comment');
    assert.ok(await localComment(page, commentText), 'comment not in the page marks');
  });
  await check(`${tag}: the selection bar is gone once the comment is posted`, async () => {
    await page.waitForTimeout(300);
    assert.equal(await rectOf('.mark-selection-bar'), null, 'selection bar is still on screen');
  });
  if (!posted) { await context.close(); return; }

  await check(`${tag}: the selection bar goes away when the selection is cleared`, async () => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await dragSelect(page, 'second paragraph');
    await page.locator('.mark-selection-bar').waitFor({ state: 'visible', timeout: 3000 });
    await page.evaluate(() => getSelection().removeAllRanges());
    await page.mouse.click(8, Math.round(await page.evaluate(() => innerHeight / 2)));
    await page.waitForFunction(() => {
      const el = document.querySelector('.mark-selection-bar');
      return !el || getComputedStyle(el).display === 'none';
    }, null, { timeout: 14_000 });
  });

  await check(`${tag}: the comment is visible in the document${style === 'playmaker' ? ' and in the Marks panel' : ''}`, async () => {
    const mark = await localComment(page, commentText);
    const highlight = page.locator(`.ProseMirror [data-mark-id="${mark.id}"]`).first();
    await highlight.waitFor({ state: 'visible', timeout: 3000 });
    if (style === 'playmaker') {
      const row = page.locator(`.pm-review-panel [data-review-row="${mark.id}"]`);
      await row.waitFor({ state: 'visible', timeout: 3000 });
    }
    await page.screenshot({ path: path.join(shots, `${tag}-3-posted.png`) });
  });

  // Editing first (Mike 2026-09-19): clicking the highlighted words places the caret and opens
  // nothing; the thread is in the right rail (the focus line follows the caret).
  const openThread = async () => {
    await page.keyboard.press('Escape');
    const mark = await localComment(page, commentText);
    const highlight = page.locator(`.ProseMirror [data-mark-id="${mark.id}"]`).first();
    await highlight.click();
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.pm-review-dialog:visible, .mark-popover:visible').count(), 0, 'a review dialog or popover opened on click');
    assert.ok(await page.evaluate(() => {
      const sel = getSelection();
      return !!sel && sel.isCollapsed && !!sel.anchorNode && !!document.querySelector('.ProseMirror')?.contains(sel.anchorNode);
    }), 'the click did not place the caret in the text');
    // Accord round 2 stage C: a comment is a THREAD, and it shows once, in Discussion. It used to
    // show twice — also in "Changes on this line", which now carries only proposals. Same
    // behaviour, same rail, one card instead of two.
    const card = page.locator(`.prw-right .amg-thread[data-thread="${mark.id}"]`);
    await card.first().waitFor({ state: 'visible', timeout: 3000 });
    assert.ok((await card.first().innerText()).includes(commentText), 'the rail does not show the comment');
    assert.equal(await page.locator(`.prw-changes .prw-card[data-mark-id="${mark.id}"]`).count(), 0,
      'the comment is in "Changes on this line" as well as in Discussion: it shows twice');
    await page.evaluate(() => document.activeElement?.blur());
    return card.first();
  };

  await check(`${tag}: clicking the comment places the caret; the rail shows it and a reply can be posted`, async () => {
    const thread = await openThread();
    await thread.locator('.amg-thread-reply-input').fill(replyText);
    await page.screenshot({ path: path.join(shots, `${tag}-4-reply.png`) });
    await thread.locator('.amg-thread-reply-send').click();
    await waitForServer(base, created, s => s.includes(replyText), 'the reply');
  });

  await check(`${tag}: the comment can be resolved from the rail`, async () => {
    const thread = await openThread();
    await page.waitForFunction(({ id, r }) => document.querySelector(`.prw-right .amg-thread[data-thread="${id}"]`)?.textContent?.includes(r),
      { id: (await localComment(page, commentText)).id, r: replyText }, { timeout: 5000 });
    // A comment thread closes with "Done" (src/shared/threads.ts resolutionsFor): the same act,
    // and the same result on the mark (data.resolved === true), asserted below exactly as before.
    await thread.locator('.amg-thread-resolve').first().click();
    await page.waitForFunction(t => (window.proof?.getAllMarks?.() ?? window.proof?.getMarks?.() ?? [])
      .some(m => m.kind === 'comment' && m.data?.text === t && m.data?.resolved === true), commentText, { timeout: 5000 });
    await waitForServer(base, created, s => /"resolved":\s*true/.test(s), 'the comment resolved');
    await page.screenshot({ path: path.join(shots, `${tag}-5-resolved.png`) });
  });
  await context.close();
}

const browser = await chromium.launch({ headless: true });
try {
  for (const style of styles) {
    const { base, stop } = await startServer(style);
    try {
      for (const viewport of viewports) await run(browser, base, style, viewport);
    } finally {
      await stop();
    }
  }
} finally {
  await browser.close();
}
console.log(failures ? `comment-check: ${failures} FAILED` : 'comment-check: all passed');
process.exit(failures ? 1 : 0);
