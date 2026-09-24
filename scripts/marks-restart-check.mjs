#!/usr/bin/env node
// ac-lhc: fresh API fixtures, same tab/port/database across restart. No marks-map writes.
// Optional: P0_OLD_BUILD_DIR=/built/0913728/tree tests old page -> new server too.
// --reinit drives the public share activation path after reconnect; no synthetic mark loss.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, openSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';

const root = fileURLToPath(new URL('../', import.meta.url));
const oldBuild = process.env.P0_OLD_BUILD_DIR;
const temp = mkdtempSync(path.join(tmpdir(), 'proof-marks-restart-'));
const dbPath = path.join(temp, 'test.db');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const headers = { 'Content-Type': 'application/json', 'X-Proof-Client-Version': '0.32.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
let server, browser, base, port;
async function start(repo, style) {
  const fd = openSync(path.join(temp, 'server.log'), 'a');
  server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: repo, stdio: ['ignore', fd, fd],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      NODE_ENV: 'production', PORT: String(port), DATABASE_PATH: dbPath,
      SNAPSHOT_DIR: path.join(temp, 'snapshots'), COLLAB_EMBEDDED_WS: '1',
      PROOF_DEFAULT_REVIEW_STYLE: style, PROOF_FEEDBACK_ENABLED: '0',
      PROOF_COLLAB_SIGNING_SECRET: 'local-p0-restart-check-fixed-secret' },
  });
  closeSync(fd);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Server exited; see ${temp}/server.log`);
    if ((await fetch(`${base}/health`).catch(() => null))?.ok) return;
    await sleep(100);
  }
  throw new Error(`Server startup timed out; see ${temp}/server.log`);
}
async function stop() {
  if (!server) return;
  const child = server; server = null;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  const kill = setTimeout(() => child.kill('SIGKILL'), 10_000);
  await done; clearTimeout(kill);
}
async function json(url, method = 'GET', body, token) {
  const response = await fetch(base + url, { method, headers: { ...headers, ...(token ? { 'x-share-token': token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  assert.ok(response.ok, `${method} ${url}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}
async function fixture() {
  const created = await json('/api/documents', 'POST', {
    title: 'Restart regression fixture',
    markdown: '# Restart fixture\n\nAlpha original phrase stays here.\n\nBeta insertion anchor stays here.\n',
  });
  assert.ok(created.accessToken, 'Guest editor access token');
  assert.equal(created.accessRole, 'editor');
  const ids = [];
  for (const [route, quote, content] of [
    ['suggest-replace', 'original phrase', 'replacement phrase'],
    ['suggest-insert', 'insertion anchor', ' proposed insertion'],
  ]) {
    const added = await json(`/api/agent/${created.slug}/marks/${route}`, 'POST', { quote, content, by: 'ai:restart-check' }, created.accessToken);
    assert.ok(added.markId); ids.push(added.markId);
  }
  return { ...created, ids };
}
function pending(marks, ids, label) {
  for (const id of ids) {
    assert.ok(marks[id], `${label}: missing ${id}`);
    assert.equal(marks[id].status ?? 'pending', 'pending', `${label}: ${id}`);
  }
  assert.equal(marks[ids[0]].kind, 'replace'); assert.equal(marks[ids[1]].kind, 'insert');
}
async function synced(page) {
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, undefined, { timeout: 60_000 });
  assert.equal(await page.evaluate(() => window.proof?.activeCollabSession?.role), 'editor', 'Editor-role guest');
  assert.equal(await page.evaluate(() => window.proof?.collabCanEdit), true);
}
let passed = false;
try {
  // Launch first so a restricted runner reports the actual Chromium limitation immediately.
  browser = await chromium.launch({ headless: true });
  const listener = createServer(); await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  port = listener.address().port; await new Promise(resolve => listener.close(resolve)); base = `http://127.0.0.1:${port}`;
  for (const first of [root, ...(oldBuild ? [path.resolve(oldBuild)] : [])]) {
    for (const style of ['playmaker', 'proof']) {
      for (const variant of ['navigate', 'hidden']) {
        for (let iteration = 1; iteration <= 10; iteration++) {
          await start(first, style);
          const doc = await fixture();
          const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
          await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
          await context.addInitScript(() => {
            localStorage.setItem('proof-share-viewer-name', 'Restart reviewer');
            window.__p0Hidden = 0;
            document.addEventListener('visibilitychange', () => { if (document.hidden) window.__p0Hidden++; });
          });
          const page = await context.newPage();
          let refusedOldClient = false;
          page.on('response', response => {
            if (response.status() === 426 && /\/(collab-session|collab-refresh|open-context)(?:\?|$)/.test(response.url())) refusedOldClient = true;
          });
          await page.goto(`${base}/d/${doc.slug}?token=${encodeURIComponent(doc.accessToken)}`);
          await synced(page); await sleep(1000);
          await stop(); await sleep(3000);
          await start(root, style);
          if (first === root) await synced(page);
          else {
            // Old sessions are refused. Reloading the same tab must replay its
            // durable queue through a current session without losing suggestions.
            await page.evaluate(() => window.proof.refreshCollabSessionAndReconnect(true));
            const refusalDeadline = Date.now() + 30_000;
            while (!refusedOldClient && Date.now() < refusalDeadline) await sleep(100);
            assert.ok(refusedOldClient, 'Old page must receive the upgrade-required response');
            await page.reload();
            await synced(page);
          }
          if (process.argv.includes('--reinit')) {
            assert.equal(await page.evaluate(() => window.proof.activateShareRuntime()), true);
            await page.waitForFunction(() => !window.proof?.shareRuntimeActivationInFlight);
            await synced(page);
          }
          await sleep(1000);
          if (variant === 'navigate') await page.goto('about:blank');
          else {
            const cdp = await context.newCDPSession(page);
            // Chromium itself hides/freezes the page, delivering the real visibilitychange.
            await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
            await sleep(200);
            await cdp.send('Page.setWebLifecycleState', { state: 'active' });
            assert.ok(await page.evaluate(() => window.__p0Hidden > 0), 'Real hidden visibilitychange must run');
            await cdp.detach();
          }
          await sleep(2000);
          const state = await json(`/api/agent/${doc.slug}/state`, 'GET', undefined, doc.accessToken);
          pending(state.marks, doc.ids, '/state');
          const db = new Database(dbPath, { readonly: true });
          try {
            pending(JSON.parse(db.prepare('SELECT marks FROM documents WHERE slug = ?').get(doc.slug).marks), doc.ids, 'documents.marks');
            const projection = db.prepare('SELECT marks_json FROM document_projections WHERE document_slug = ?').get(doc.slug);
            if (projection) pending(JSON.parse(projection.marks_json), doc.ids, 'projection');
          } finally { db.close(); }
          await context.close(); await stop();
          console.log(`PASS ${first === root ? 'restart' : 'old-to-new'} ${style} ${variant} ${iteration}/10`);
        }
      }
    }
  }
  passed = true;
} finally {
  await browser?.close(); await stop();
  if (passed) rmSync(temp, { recursive: true, force: true });
  else console.error(`Check did not pass. Local diagnostics: ${temp}`);
}
