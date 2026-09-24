#!/usr/bin/env node
// ac-0f4 — Mike, 2026-09-23 (usability brief): blind data stays off the page until reveal.
// Run after npm run build. Local server only; both styles at desktop and phone widths.
// The reviewer runs Chromium and regenerates .preview/blind-leaks screenshots.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('../', import.meta.url));
const shots = path.join(root, '.preview', 'blind-leaks');
const clientHeaders = { 'X-Proof-Client-Version': '0.33.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
const MIKE_EMAIL = 'mw@mike-wolf.com';
async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-bundles-check-'));
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    PORT: String(port), COLLAB_EMBEDDED_WS: '1', PROOF_DEFAULT_REVIEW_STYLE: style,
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

async function newContext(browser, base, options = {}) {
  const context = await browser.newContext(options);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  return context;
}

async function signIn(context, cli, base) {
  const link = cli('signin-link', '--email', MIKE_EMAIL, '--origin', base, '--hours', '1');
  const page = await context.newPage();
  await page.goto(link);
  await page.waitForURL(url => url.pathname === '/', { timeout: 15_000 });
  return page;
}

async function openDoc(page, base, slug) {
  await page.goto(`${base}/d/${slug}`);
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForFunction(() => window.__proofReadingWalk?.debugState().ready === true, null, { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(300);
  page.setDefaultTimeout(6000);
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
}


mkdirSync(shots, { recursive: true });
const browser = await chromium.launch();
let passed = 0;
try {
  for (const style of ['playmaker', 'proof']) {
    const { base, stop, cli } = await startServer(style);
    try {
      cli('add-member', '--name', 'Mike Wolf', '--email', MIKE_EMAIL);
      for (const width of [1280, 375]) {
        const context = await newContext(browser, base, { viewport: { width, height: 812 } });
        const page = await signIn(context, cli, base);
        const errors = []; page.on('pageerror', e => errors.push(e.message));
        const request = async (url, body) => page.evaluate(async ({ url, body, h }) => {
          const r = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
          return { status: r.status, body: await r.json() };
        }, { url, body, h: clientHeaders });
        const made = await request('/library/api/documents', { title: 'Blind leak check', markdown: '# Blind review\n\nFirst covered paragraph.\n\nSecond covered paragraph.\n\nAn unanswered decision.' });
        assert.ok([200, 201].includes(made.status), JSON.stringify(made));
        const slug = made.body.slug;
        const key = await request(`/api/documents/${slug}/agent-keys`, { label: 'Writer', runtime: 'Local regression fixture' });
        assert.equal(key.status, 201);
        const agent = async (route, body) => {
          const r = await fetch(`${base}/api/agent/${slug}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...clientHeaders, 'Content-Type': 'application/json', 'x-share-token': key.body.token }, body: body === undefined ? undefined : JSON.stringify(body) });
          return { status: r.status, body: await r.json() };
        };
        const reason = 'PRIVATE_BROWSER_OBJECTION';
        const objection = await agent('/objections', { lines: [{ lineIndex: 1 }, { lineIndex: 2 }], reason, condition: 'PRIVATE_BROWSER_CONDITION' });
        assert.equal(objection.status, 200, JSON.stringify(objection));
        assert.equal((await request(`/api/documents/${slug}/settings`, { blind: true })).status, 200);
        await openDoc(page, base, slug);
        const poll = () => request(`/api/documents/${slug}/line-marks`);
        let response = await poll();
        assert.equal(response.body.objections.length, 0);
        assert.ok(!JSON.stringify(response.body).includes(reason));
        assert.ok(!(await page.locator('body').innerText()).includes(reason));
        const placeholders = response.body.lineMarks.filter(mark => mark.by === 'ai:writer' && mark.hidden);
        assert.ok(placeholders.length > 0);
        assert.ok(placeholders.every(mark => mark.via === undefined && mark.reason === null));
        await page.screenshot({ path: path.join(shots, `${style}-${width}-hidden.png`) });
        await page.evaluate(() => window.__proofLineMarks.setLineStatus(1, 'seen'));
        assert.equal((await poll()).body.objections.length, 0, 'partial reveal must not disclose a span');
        await page.evaluate(() => window.__proofLineMarks.setLineStatus(2, 'seen'));
        await page.waitForFunction(() => window.__proofLineMarks.debugState().aids.objections.length === 1);
        response = await poll();
        assert.equal(response.body.objections[0].reason, reason);
        await page.evaluate(() => window.__proofReadingWalk.focusLine(1));
        if (width < 600) await page.evaluate(() => window.__proofReadingWalk.openSheet('right'));
        await page.locator('.plm-objection').filter({ hasText: reason }).first().waitFor({ state: 'visible' });
        await page.screenshot({ path: path.join(shots, `${style}-${width}-revealed.png`) });
        assert.deepEqual(errors, [], 'the page must render redacted responses without exceptions');
        passed++; console.log(`PASS ${style} ${width}: hidden payload, placeholder rendering, partial and full reveal`);
        await context.close();
      }
    } finally { await stop(); }
  }
} finally { await browser.close(); }
console.log(`${passed}/4 blind-leak browser cases passed`);
