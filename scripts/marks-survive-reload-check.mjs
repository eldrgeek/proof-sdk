#!/usr/bin/env node
// Browser check: pending suggestion marks survive a server restart when the usability client opens the page.
// Reproduces ac-lhc (2026-09-24): deploy d15df82 cleared documents.marks on first editor guest load.
// Creates a replace suggestion via the agent API, restarts the server on the same SQLite file, opens the
// document once as an editor-role guest (access token, not owner secret), then asserts the suggestion
// is still pending in the page, /state, and documents.marks.
// Usage: node scripts/marks-survive-reload-check.mjs [--style playmaker|proof]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const styleArg = process.argv.indexOf('--style');
const styles = styleArg > 0 ? [process.argv[styleArg + 1]] : ['playmaker', 'proof'];
const clientHeaders = { 'X-Proof-Client-Version': '0.31.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };

let failures = 0;
async function check(name, fn) {
  let line;
  try { await fn(); line = `PASS ${name}`; }
  catch (error) { failures += 1; line = `FAIL ${name}: ${error?.message?.split('\n')[0]}`; }
  console.log(line);
}

async function startServer(style, tempDir) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const dbPath = path.join(tempDir, 'test.db');
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      PORT: String(port), COLLAB_EMBEDDED_WS: '1', PROOF_DEFAULT_REVIEW_STYLE: style,
      PROOF_FEEDBACK_ENABLED: '0',
      DATABASE_PATH: dbPath, SNAPSHOT_DIR: path.join(tempDir, 'snapshots'),
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 400));
  };
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const health = await fetch(`${base}/health`).catch(() => null);
    if (health?.ok) return { base, stop, dbPath, port };
    await new Promise(r => setTimeout(r, 150));
  }
  await stop();
  throw new Error('server did not start');
}

const markdown = `# Marks survive reload

The target phrase sits here.

A closing line.`;

async function createDoc(base) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown, title: 'Marks survive reload check' }),
  });
  assert.equal(response.status, 200);
  return await response.json();
}

async function agent(base, slug, token, method, route, body) {
  const r = await fetch(`${base}/api/agent/${slug}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-share-token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

function pendingReplaceMarks(marks) {
  return Object.entries(marks ?? {}).filter(([, m]) => m?.kind === 'replace' && m?.status === 'pending');
}

async function editorGuestToken(base, slug, ownerSecret) {
  const response = await fetch(`${base}/api/documents/${slug}/access-links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ role: 'editor', ownerSecret }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(typeof payload.accessToken === 'string' && payload.accessToken.length > 0);
  return payload.accessToken;
}

async function readDbMarks(dbPath, slug) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT marks FROM documents WHERE slug = ?').get(slug);
    assert.ok(row, 'documents row missing');
    return typeof row.marks === 'string' ? JSON.parse(row.marks) : row.marks;
  } finally {
    db.close();
  }
}

async function openAsEditorGuest(browser, base, slug, editorToken) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.addInitScript(() => { try { localStorage.setItem('proof-share-viewer-name', 'ReloadGuest'); } catch {} });
  const page = await context.newPage();
  await page.goto(`${base}/d/${slug}?token=${encodeURIComponent(editorToken)}`);
  await page.getByRole('button', { name: 'Continue anonymously', exact: true }).click({ timeout: 3_000 }).catch(() => {});
  await page.waitForFunction(
    () => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true,
    null,
    { timeout: 25_000 },
  );
  await page.waitForTimeout(1200);
  return { context, page };
}

async function runStyle(browser, style) {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'proof-marks-survive-'));
  try {
    let { base, stop, dbPath } = await startServer(style, tempDir);
    const created = await createDoc(base);
    const slug = created.slug;
    const ownerSecret = created.ownerSecret;
    assert.ok(ownerSecret, 'ownerSecret required');

    const suggest = await agent(base, slug, created.accessToken, 'POST', '/marks/suggest-replace', {
      quote: 'target phrase',
      by: 'ai:check',
      content: 'new phrase',
    });
    assert.equal(suggest.status, 200, `suggest-replace failed: ${JSON.stringify(suggest.body).slice(0, 200)}`);
    const replaceId = pendingReplaceMarks(suggest.body.marks)[0]?.[0];
    assert.ok(replaceId, 'expected replace mark id from suggest-replace');

    const editorToken = await editorGuestToken(base, slug, ownerSecret);

    await stop();
    ({ base, stop, dbPath } = await startServer(style, tempDir));

    const marksBeforeOpen = await readDbMarks(dbPath, slug);
    assert.ok(pendingReplaceMarks(marksBeforeOpen).length >= 1, 'DB marks missing pending replace before page open');

    const { context, page } = await openAsEditorGuest(browser, base, slug, editorToken);
    try {
      await check(`${style}: page keeps pending replace decoration`, async () => {
        const pending = await page.evaluate(() => (window.proof?.getAllMarks?.() ?? [])
          .filter(m => m.data?.status === 'pending' && m.kind === 'replace'));
        assert.ok(pending.length >= 1, 'page has no pending replace marks');
      });

      await check(`${style}: /state keeps pending replace`, async () => {
        const st = await agent(base, slug, editorToken, 'GET', '/state');
        assert.equal(st.status, 200);
        assert.ok(pendingReplaceMarks(st.body.marks).length >= 1, '/state marks empty');
      });

      await check(`${style}: documents.marks keeps pending replace`, async () => {
        await page.waitForTimeout(800);
        const dbMarks = await readDbMarks(dbPath, slug);
        const pending = pendingReplaceMarks(dbMarks);
        assert.ok(pending.length >= 1, `documents.marks cleared: ${JSON.stringify(dbMarks)}`);
        assert.ok(pending.some(([id]) => id === replaceId), 'original replace id missing from DB');
      });
    } finally {
      await context.close();
    }

    await stop();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const browser = await chromium.launch();
try {
  for (const style of styles) await runStyle(browser, style);
} finally {
  await browser.close();
}
console.log(failures ? `marks-survive-reload-check: ${failures} FAILED` : 'marks-survive-reload-check: all passed');
process.exit(failures ? 1 : 0);
