#!/usr/bin/env node
// Meet live (Mike, 2026-10-30). The Accord page asks the rooms service after load and, on a
// rooms URL, shows one quiet "Meet live" link in the top bar. A 404, a failure, or any other
// URL shows nothing.
//
// The rooms service is stubbed here. The foreign-url case is the one that goes red if the page
// uses the answer's url without checking it is under https://vps.mike-wolf.com/rooms/.
//
// Run after `npm run build`. Optional --style playmaker|proof and --shots directory.
// Usage: node scripts/meet-live-check.mjs [--style playmaker|proof] [--shots dir]
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
const ROOMS = 'https://vps.mike-wolf.com/rooms/api/team/accord/';
const ROOM = 'https://vps.mike-wolf.com/rooms/team/live-room';
const FOREIGN = 'https://evil.example/live';
const headers = { 'Content-Type': 'application/json', 'X-Proof-Client-Version': '0.34.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };

let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1;
    results.push(`FAIL ${name}: ${error?.message?.split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `meet-live-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'accord-meet-live-'));
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    PORT: String(port), COLLAB_EMBEDDED_WS: '1', PROOF_DEFAULT_REVIEW_STYLE: style,
    DATABASE_PATH: path.join(temp, 'test.db'), SNAPSHOT_DIR: path.join(temp, 'snapshots'),
  };
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: root, env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    child.kill('SIGTERM');
    if (child.exitCode === null && !child.killed) await new Promise(resolve => child.once('exit', resolve));
    rmSync(temp, { recursive: true, force: true });
  };
  for (let i = 0; i < 200; i += 1) {
    if ((await fetch(`${base}/health`).catch(() => null))?.ok) return { base, stop };
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  await stop();
  throw new Error('Local server did not start');
}

async function createDoc(base) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers,
    body: JSON.stringify({ title: 'Rooms link', markdown: '# Rooms link\n\nA short Accord for the rooms link.\n' }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

function fulfill(status, body) {
  return (route) => route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'cache-control': 'no-store' },
    body: body === undefined ? '' : JSON.stringify(body),
  });
}

const roomsUrl = (url) => url.href.startsWith(ROOMS);

async function openDoc(page, base, slug, answer) {
  await page.unroute(roomsUrl).catch(() => {});
  await page.route(roomsUrl, fulfill(answer.status, answer.body));
  await page.addInitScript(() => {
    window.__meetLiveAskedAfterLoad = null;
    window.addEventListener('load', () => { window.__meetLiveLoadDone = true; });
    const orig = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (String(url).includes('/rooms/api/team/accord/')) {
        window.__meetLiveAskedAfterLoad = window.__meetLiveLoadDone === true && document.readyState === 'complete';
      }
      return orig(input, init);
    };
  });
  const response = await page.goto(`${base}/d/${slug}`, { waitUntil: 'load' });
  await page.waitForSelector('#share-banner');
  await page.waitForFunction(() => window.__meetLiveAskedAfterLoad !== null, null, { timeout: 8_000 });
  return response;
}

async function runSurface(browser, base, slug, style, phone) {
  const tag = `${style}${phone ? '-phone' : ''}`;
  const context = await browser.newContext(phone ? { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } : { viewport: { width: 1440, height: 900 } });
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(ROOMS) || new URL(url).origin === base) return route.fallback();
    return route.abort();
  });
  await context.addInitScript(() => { try { localStorage.setItem('proof-share-viewer-name', 'Checker'); } catch { /* a private page still opens */ } });

  const linked = await context.newPage();
  activePage = linked;
  linked.setDefaultTimeout(8_000);
  const linkedResponse = await openDoc(linked, base, slug, { status: 200, body: { url: ROOM } });
  await check(`${tag}: the page connect-src allows the rooms origin and no wider source`, async () => {
    const csp = linkedResponse?.headers()['content-security-policy'] ?? '';
    const sources = csp.replace(/^connect-src\s+/, '').split(/\s+/).filter(Boolean);
    assert.equal(csp.startsWith('connect-src '), true, csp);
    assert.ok(sources.includes('https://vps.mike-wolf.com'), csp);
    assert.ok(sources.includes("'self'"), csp);
    for (const source of sources) {
      assert.notEqual(source, '*', csp);
      assert.notEqual(source, 'https:', csp);
      assert.notEqual(source, 'http:', csp);
      assert.notEqual(source, 'wss:', csp);
      assert.equal(source.includes('*'), false, source);
    }
  });
  await check(`${tag}: the lookup runs after load`, async () => {
    assert.equal(await linked.evaluate(() => window.__meetLiveAskedAfterLoad), true);
  });
  await check(`${tag}: a rooms url shows one Meet live link that opens a new tab`, async () => {
    const link = linked.locator('#share-banner [data-meet-live]');
    await link.waitFor({ state: 'visible' });
    assert.equal(await link.count(), 1);
    assert.equal((await link.innerText()).trim(), 'Meet live');
    assert.equal(await link.getAttribute('href'), ROOM);
    assert.equal(await link.getAttribute('target'), '_blank');
    const topBar = await linked.evaluate(() => Array.from(document.querySelectorAll('#share-banner a, #accord-menubar a')).map(a => a.textContent.trim()).filter(Boolean));
    assert.equal(topBar.filter(text => text === 'Meet live').length, 1, topBar.join(' | '));
  });
  await linked.screenshot({ path: path.join(shots, `meet-live-${tag}.png`) }).catch(() => {});
  await linked.close();

  const missing = await context.newPage();
  activePage = missing;
  missing.setDefaultTimeout(8_000);
  await openDoc(missing, base, slug, { status: 404 });
  await check(`${tag}: a 404 shows no Meet live link`, async () => {
    await missing.waitForTimeout(400);
    const count = await missing.locator('[data-meet-live]').count();
    assert.equal(count, 0, `Meet live links on a 404: ${count}`);
  });
  await missing.close();

  const foreign = await context.newPage();
  activePage = foreign;
  foreign.setDefaultTimeout(8_000);
  await openDoc(foreign, base, slug, { status: 200, body: { url: FOREIGN } });
  await check(`${tag}: a url outside the rooms site shows no link`, async () => {
    await foreign.waitForTimeout(400);
    assert.equal(await foreign.locator('[data-meet-live]').count(), 0);
    const hrefs = await foreign.evaluate(() => Array.from(document.querySelectorAll('#share-banner a, #accord-menubar a')).map(a => a.href));
    assert.equal(hrefs.some(href => href.includes('evil.example')), false, hrefs.join(' '));
  });
  await foreign.close();
  activePage = null;
  await context.close();
}

const browser = await chromium.launch({ headless: true });
try {
  for (const style of styles) {
    const server = await startServer(style);
    try {
      const created = await createDoc(server.base);
      await runSurface(browser, server.base, created.slug, style, false);
      await runSurface(browser, server.base, created.slug, style, true);
    } finally {
      await server.stop();
    }
  }
} finally {
  await browser.close();
}

if (failures) {
  console.error(`meet-live-check: ${failures} failed`);
  process.exit(1);
}
console.log('meet-live-check: all passed');
