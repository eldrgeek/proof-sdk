#!/usr/bin/env node
// Accord first screen: the Room opens with a code-written next-step row (fix 10), no name modal
// on arrival (11), and compact empty chat (12). Fixture: three open asks for one guest viewer.
// Usage: npm run build && node scripts/next-step-check.mjs [--style playmaker|proof] [--shots dir]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { showWholeAccord } from './review-ui.mjs';

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
    await activePage?.screenshot({ path: path.join(shots, `next-step-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-next-step-check-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      PORT: String(port), COLLAB_EMBEDDED_WS: '1', PROOF_DEFAULT_REVIEW_STYLE: style,
      PROOF_FEEDBACK_ENABLED: '1', SOMA_FEEDBACK_ENDPOINT: 'http://127.0.0.1:9/feedback',
      PROOF_GUEST_ACCESS_DEFAULT: 'edit',
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

const markdown = [
  '# Next step check',
  'Intro paragraph is plain text for reading; it is long enough to be a real line of the document.',
  'Should we ship the first ask tonight?',
  'Middle paragraph is plain text for reading; it is long enough to be a real line of the document.',
  'Can we retire the second ask this week?',
  'Last paragraph is plain text for reading; it is long enough to be a real line of the document.',
  'Is the third ask ready to answer?',
].join('\n\n');

async function api(base, created, method, route, body) {
  const r = await fetch(`${base}/api/agent/${created.slug}${route}`, {
    method, headers: { 'Content-Type': 'application/json', 'x-share-token': created.accessToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

async function createDoc(base) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown, title: 'Next step check' }),
  });
  assert.equal(response.status, 200);
  const created = await response.json();
  for (const [quote, recommend] of [
    ['ship the first ask', 'Yes: ship it'],
    ['retire the second ask', 'Yes: retire it'],
    ['third ask ready', 'Yes: answer it'],
  ]) {
    const a = await api(base, created, 'POST', '/asks', { by: 'ai:cos', quote, to: ['guest:Guest'], recommend });
    assert.equal(a.status, 200, JSON.stringify(a.body));
  }
  return created;
}

async function openGuest(page, base, slug) {
  await page.goto(`${base}/d/${slug}`);
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForFunction(() => window.__proofChat?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForFunction(() => window.__proofLineMarks.debugState().asks.length >= 3, null, { timeout: 10_000 });
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  await showWholeAccord(page);
  if (!(await page.evaluate(() => window.__proofChat?.debugState().visible))) {
    await page.locator('.prw-chat-bottom .pch-toggle').click();
  }
  await page.waitForFunction(() => document.querySelector('.pch-next-step'), null, { timeout: 10_000 });
  page.setDefaultTimeout(8000);
}

async function run(browser, style) {
  const { base, stop } = await startServer(style);
  try {
    const created = await createDoc(base);
    const tag = `next-step-${style}-desktop`;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await context.addInitScript(() => { try { localStorage.removeItem('proof-share-viewer-name'); } catch {} });
    const page = await context.newPage();
    activePage = page;
    await openGuest(page, base, created.slug);

    await check(`${tag}: no name modal on arrival; top bar offers Guest · set your name`, async () => {
      assert.equal(await page.locator('[data-proof-name-prompt="overlay"]').count(), 0);
      assert.match(await page.locator('.share-pill-viewer').innerText(), /Guest · set your name/);
      await page.screenshot({ path: path.join(shots, `${tag}-arrival.png`) });
    });

    await check(`${tag}: first chat row names the first open ask`, async () => {
      const row = page.locator('.pch-next-step');
      await row.waitFor({ state: 'visible' });
      const text = await row.innerText();
      assert.match(text, /3 decisions wait/);
      assert.match(text, /ship the first ask/i);
      assert.match(text, /Recommend:\s*Yes/);
      await page.screenshot({ path: path.join(shots, `${tag}-chat-next-step.png`) });
    });

    await check(`${tag}: Go to it reaches the first open ask on click`, async () => {
      await page.evaluate(() => window.__proofReadingWalk.focusLine(0));
      await page.locator('.pch-next-step-go').click();
      await page.waitForFunction(() => window.__proofReadingWalk.debugState().target === 2, null, { timeout: 5000 });
      assert.equal((await page.evaluate(() => window.__proofChat.debugState().pointerClicks)).at(-1), 2);
    });

    await check(`${tag}: Review and status bar use "open"`, async () => {
      assert.match(await page.locator('#share-banner .plm-issues-count').innerText(), /^\d+ open$/);
      const barIssues = page.locator('.pst-issues');
      if (await barIssues.count()) assert.match(await barIssues.innerText(), /^\d+ open$/);
    });

    await context.close();
  } finally {
    await stop();
  }
}

const browser = await chromium.launch();
for (const style of styles) await run(browser, style);
await browser.close();
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll next-step checks passed');
