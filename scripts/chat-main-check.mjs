#!/usr/bin/env node
// Chat-main layout check (Mike, 2026-10-21, Accord 9b72a5rp: "the agreements fill the space and I
// cannot see the chat"). On a wide desktop window the chat fills the centre at full height and the
// text (the agreements) is a column at its left; narrow windows and phones keep the chat at the
// centre's foot; View › "Chat as the main space" turns it off and back on.
//
// Starts an isolated local server on the current dist/ build (run `npm run build` first).
// Usage: node scripts/chat-main-check.mjs [--shots dir]
// Authorship: Claude Opus 5.5 (CCc), for Mike Wolf, 2026-10-21. Bead ac-kub.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { showWholeAccord } from './review-ui.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const shotsArg = process.argv.indexOf('--shots');
const shots = shotsArg > 0 ? process.argv[shotsArg + 1] : path.join(root, '.preview');
mkdirSync(shots, { recursive: true });
const MIKE_EMAIL = 'mike@example.test';
const clientHeaders = { 'X-Proof-Client-Version': '0.31.2', 'X-Proof-Client-Build': 'tests', 'X-Proof-Client-Protocol': '3' };

const results = [];
let failures = 0;
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `chat-main-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer() {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-chat-main-check-'));
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    PORT: String(port), COLLAB_EMBEDDED_WS: '1', PROOF_DEFAULT_REVIEW_STYLE: 'proof',
    PROOF_FEEDBACK_ENABLED: '1', SOMA_FEEDBACK_ENDPOINT: 'http://127.0.0.1:9/feedback',
    PROOF_LIBRARY_ENABLED: '1',
    DATABASE_PATH: path.join(temp, 'test.db'), SNAPSHOT_DIR: path.join(temp, 'snapshots'),
  };
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: root, env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => { child.kill('SIGTERM'); await new Promise(r => setTimeout(r, 300)); rmSync(temp, { recursive: true, force: true }); };
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const health = await fetch(`${base}/health`).catch(() => null);
    if (health?.ok) {
      const cli = (...args) => {
        const r = spawnSync(process.execPath, ['--import', 'tsx', 'server/library/cli.ts', ...args], { cwd: root, env, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        return r.stdout.trim();
      };
      return { base, stop, cli };
    }
    await new Promise(r => setTimeout(r, 150));
  }
  await stop();
  throw new Error('server did not start');
}

// A room-shaped Accord: headed sections of agreements, long enough to fill any window.
const sections = ['Who is in the room', 'How the room works', 'The one rule that is not negotiable', 'What we are working on first', 'Money and ownership', 'What happens next'];
const markdown = ['# The working room', 'This page holds what the room has agreed. The chat beside it is where the agreeing happens.',
  ...sections.flatMap((h, i) => [`## ${h}`, ...[1, 2, 3, 4].map(n => `Agreement ${i + 1}.${n}: a plain sentence the room agreed, long enough to wrap onto a second line in a narrow column.`)])].join('\n\n');

const layout = page => page.evaluate(() => {
  const r = el => { const b = document.querySelector(el)?.getBoundingClientRect(); return b ? { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom), width: Math.round(b.width), height: Math.round(b.height) } : null; };
  const chrome = Number.parseFloat(document.body.style.getPropertyValue('--prw-chrome')) || 0;
  return {
    chatMain: document.body.classList.contains('prw-chat-main'),
    chat: r('.prw-chat-bottom'), text: r('#editor-container'), status: r('.pst-bar'), right: r('.prw-right'),
    list: r('.prw-chat-bottom .pch-list'), composer: r('.prw-chat-bottom .pch-input'), chrome,
    innerWidth: window.innerWidth, innerHeight: window.innerHeight,
    visible: window.__proofChat?.debugState().visible,
    shownMessages: document.querySelectorAll('.prw-chat-bottom .pch-list > .pch-msg:not([hidden])').length,
  };
});

async function openDoc(page, base, slug) {
  await page.goto(`${base}/d/${slug}`);
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForFunction(() => window.__proofChat?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForTimeout(400);
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
}

const browser = await chromium.launch();
const { base, stop, cli } = await startServer();
try {
  cli('add-member', '--name', 'Mike Wolf', '--email', MIKE_EMAIL);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await ctx.newPage();
  activePage = page;
  await page.goto(cli('signin-link', '--email', MIKE_EMAIL, '--origin', base, '--hours', '1'));
  await page.waitForURL(url => url.pathname === '/', { timeout: 15_000 });
  const created = await page.evaluate(async md => {
    const r = await fetch('/library/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'The working room', markdown: md }) });
    return { status: r.status, body: await r.json() };
  }, markdown);
  assert.ok(created.status === 200 || created.status === 201, JSON.stringify(created));
  const slug = created.body.slug;
  await page.goto(`${base}/d/${slug}`);
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 20_000 });
  const key = await page.evaluate(async ({ s, h }) => {
    const r = await fetch(`/api/documents/${s}/agent-keys`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify({ label: 'Claude', runtime: 'Claude Opus 5.5 (Anthropic)' }) });
    return { status: r.status, body: await r.json() };
  }, { s: slug, h: clientHeaders });
  assert.equal(key.status, 201, JSON.stringify(key));
  const KEY = { 'Content-Type': 'application/json', ...clientHeaders, 'x-share-token': key.body.token };
  for (let i = 1; i <= 8; i += 1) {
    const r = await fetch(`${base}/api/agent/${slug}/chat`, { method: 'POST', headers: KEY, body: JSON.stringify({ text: `Message ${i} of 8: the room talks here, and the chat has the main space so every message reads at a glance.` }) });
    assert.equal(r.status, 200, await r.text());
  }
  await openDoc(page, base, slug);
  await page.waitForFunction(() => window.__proofChat.debugState().messages.length === 8, null, { timeout: 15_000 });
  await page.waitForTimeout(300);

  await check('1440x900: chat-main is on; the chat runs from under the top bar to the bottom of the window', async () => {
    const l = await layout(page);
    assert.equal(l.chatMain, true);
    assert.ok(Math.abs(l.chat.top - l.chrome) <= 1, `chat top ${l.chat.top} vs chrome ${l.chrome}`);
    assert.ok(Math.abs(l.chat.bottom - l.innerHeight) <= 1, `chat bottom ${l.chat.bottom}`);
    assert.ok(l.chat.height >= l.innerHeight * 0.8, `chat height ${l.chat.height}`);
  });
  await check('1440x900: the text is a side column at the chat\'s left and the two do not overlap', async () => {
    const l = await layout(page);
    assert.ok(l.text.right <= l.chat.left + 1, `text right ${l.text.right} > chat left ${l.chat.left}`);
    assert.ok(l.text.width >= 340 && l.text.width <= 560, `text width ${l.text.width}`);
    assert.ok(l.chat.width > l.text.width, `chat ${l.chat.width} should be wider than text ${l.text.width}`);
    assert.ok(l.chat.right <= l.right.left + 1, 'chat runs under the Review panel');
  });
  await check('1440x900: every message shows (the chat is not folded to one) and the composer is on screen', async () => {
    const l = await layout(page);
    assert.equal(l.visible, true);
    assert.equal(l.shownMessages, 8);
    assert.ok(l.composer && l.composer.bottom <= l.innerHeight && l.composer.top > l.list.top, 'composer below the list, on screen');
    assert.ok(l.list.height >= 300, `list height ${l.list.height}`);
  });
  await check('1440x900: the status bar sits under the text column, not under the chat', async () => {
    const l = await layout(page);
    assert.ok(l.status.right <= l.chat.left + 1, `status right ${l.status.right}`);
  });
  await page.screenshot({ path: path.join(shots, 'chat-main-1440.png') });

  await check('1440x900: walking the text keeps the cursor line in view, and the camera does not stop at the chat', async () => {
    await showWholeAccord(page);
    await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
    for (let i = 0; i < 20; i += 1) { await page.keyboard.press('j'); await page.waitForTimeout(60); }
    const c = await page.evaluate(() => {
      const s = window.__proofReadingWalk.debugState();
      const node = document.querySelectorAll('.ProseMirror')[0]?.children[s.focus];
      const box = node?.getBoundingClientRect();
      return { focus: s.focus, top: box?.top ?? null, bottom: box?.bottom ?? null, view: s.camera.view, height: innerHeight };
    });
    assert.ok(c.focus >= 10, `the cursor walked to line ${c.focus}`);
    assert.ok(c.top !== null && c.top >= c.view.topInset - 1 && c.bottom <= c.height + 1, `cursor line at ${c.top}..${c.bottom}`);
    assert.ok((c.view.bottomInset ?? 0) <= 30, `bottom inset ${c.view.bottomInset}: the chat beside the text must not shrink the reading area`);
  });
  await page.screenshot({ path: path.join(shots, 'chat-main-1440-walked.png') });

  await check('1100x800 with both rails open: the centre is too narrow, so the chat returns to the centre\'s foot', async () => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.waitForTimeout(400);
    const l = await layout(page);
    const centre = l.innerWidth - (await page.evaluate(() => Number.parseFloat(getComputedStyle(document.body).getPropertyValue('--prw-left')) + Number.parseFloat(getComputedStyle(document.body).getPropertyValue('--prw-right'))));
    if (centre < 660) {
      assert.equal(l.chatMain, false);
      assert.ok(l.chat.top > l.innerHeight / 2, `chat top ${l.chat.top}`);
    } else assert.equal(l.chatMain, true);
  });
  await page.screenshot({ path: path.join(shots, 'chat-main-1100.png') });

  await check('1280x800 (both rails open): chat-main still fits, with the text column at its 300 px floor', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(400);
    const l = await layout(page);
    assert.equal(l.chatMain, true);
    assert.ok(l.text.width >= 300 && l.chat.width >= 380, `text ${l.text.width}, chat ${l.chat.width}`);
  });
  await page.screenshot({ path: path.join(shots, 'chat-main-1280.png') });

  await check('1280x800: View › "Chat as the main space" turns it off, then on again, and the choice survives a reload', async () => {
    await page.waitForTimeout(400);
    assert.equal((await layout(page)).chatMain, true);
    await page.evaluate(() => window.__proofReadingWalk.toggleChatMain());
    await page.waitForTimeout(300);
    assert.equal((await layout(page)).chatMain, false);
    await page.reload();
    await page.waitForFunction(() => window.__proofChat?.debugState().loaded === true, null, { timeout: 15_000 });
    await page.waitForTimeout(400);
    assert.equal((await layout(page)).chatMain, false);
    await page.evaluate(() => window.__proofReadingWalk.toggleChatMain());
    await page.waitForTimeout(300);
    assert.equal((await layout(page)).chatMain, true);
  });

  await check('390x844 phone: no chat-main; the phone layout is unchanged', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    assert.equal((await layout(page)).chatMain, false);
  });
} finally {
  await browser.close();
  await stop();
}
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
