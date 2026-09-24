#!/usr/bin/env node
// Faithful reproduction of ac-lhc (2026-09-24): pending suggestions created on the pre-usability client
// (0913728) must survive the first open of the post-usability client (d15df82) on the same SQLite DB
// and the same Playwright persistent profile (localStorage as live). The broken release clears
// documents.marks on that first open; the fix on deploy/vps must keep both suggestions pending.
//
// Prereq (once per machine):
//   git worktree add ../p0-old 0913728 && git worktree add ../p0-new d15df82
//   npm install && npm run build in each worktree.
//
// Usage: node scripts/marks-migration-check.mjs [--style proof|playmaker]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as Y from 'yjs';
import { chromium } from 'playwright';

const fixedRoot = fileURLToPath(new URL('../', import.meta.url));
const p0Old = path.resolve(fixedRoot, '../p0-old');
const p0Broken = path.resolve(fixedRoot, '../p0-new');

const styleArg = process.argv.indexOf('--style');
const style = styleArg > 0 ? process.argv[styleArg + 1] : 'proof';
const clientHeaders = {
  'X-Proof-Client-Version': '0.31.0',
  'X-Proof-Client-Build': 'test',
  'X-Proof-Client-Protocol': '3',
};

const markdown = `# Marks migration check

The first passage holds the target phrase for an AI replace suggestion.

The second passage is where the guest types in Suggesting mode.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pendingSuggestions(marks) {
  return Object.entries(marks ?? {}).filter(([, m]) => {
    const kind = m?.kind;
    if (kind !== 'insert' && kind !== 'replace' && kind !== 'delete') return false;
    return m?.status === 'pending';
  });
}

function assertWorktrees() {
  for (const [label, dir] of [['p0-old (0913728)', p0Old], ['p0-new (d15df82)', p0Broken]]) {
    assert.ok(existsSync(path.join(dir, 'dist', 'index.html')), `${label} missing dist/ — run npm install && npm run build in ${dir}`);
  }
  assert.ok(existsSync(path.join(fixedRoot, 'dist', 'index.html')), 'fix tree missing dist/ — run npm run build');
}

async function startServer(repoRoot, tempDir) {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const dbPath = path.join(tempDir, 'test.db');
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      PORT: String(port),
      COLLAB_EMBEDDED_WS: '1',
      PROOF_DEFAULT_REVIEW_STYLE: style,
      PROOF_FEEDBACK_ENABLED: '0',
      DATABASE_PATH: dbPath,
      SNAPSHOT_DIR: path.join(tempDir, 'snapshots'),
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    child.kill('SIGTERM');
    await sleep(400);
  };
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const health = await fetch(`${base}/health`).catch(() => null);
    if (health?.ok) return { base, stop, dbPath, port };
    await sleep(150);
  }
  await stop();
  throw new Error(`server did not start (${repoRoot})`);
}

async function createDoc(base) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown, title: 'Marks migration check' }),
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

/** Live deploy mismatch: documents.marks held suggestions the Yjs marks map did not (row-only API era + first collab open). */
function stripYjsMarksMap(dbPath, slug) {
  const db = new Database(dbPath);
  try {
    const row = db.prepare('SELECT y_state_blob FROM documents WHERE slug = ?').get(slug);
    if (!row?.y_state_blob) return;
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, new Uint8Array(row.y_state_blob));
    const marksMap = ydoc.getMap('marks');
    marksMap.forEach((_v, key) => marksMap.delete(key));
    const encoded = Y.encodeStateAsUpdate(ydoc);
    db.prepare('UPDATE documents SET y_state_blob = ? WHERE slug = ?').run(Buffer.from(encoded), slug);
  } finally {
    db.close();
  }
}

function readYjsMarks(dbPath, slug) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT y_state_blob, y_state_version FROM documents WHERE slug = ?').get(slug);
    if (!row?.y_state_blob) return { version: row?.y_state_version ?? 0, marks: {} };
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, new Uint8Array(row.y_state_blob));
    return { version: row.y_state_version ?? 0, marks: ydoc.getMap('marks').toJSON() };
  } finally {
    db.close();
  }
}

function readDbMarks(dbPath, slug) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT marks FROM documents WHERE slug = ?').get(slug);
    assert.ok(row, 'documents row missing');
    return typeof row.marks === 'string' ? JSON.parse(row.marks) : row.marks;
  } finally {
    db.close();
  }
}

async function waitForPendingCount(dbPath, slug, n, label) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const marks = readDbMarks(dbPath, slug);
    const pending = pendingSuggestions(marks);
    if (pending.length >= n) return { marks, pending };
    await sleep(400);
  }
  const marks = readDbMarks(dbPath, slug);
  throw new Error(`${label}: wanted ${n} pending suggestions in documents.marks, got ${pendingSuggestions(marks).length}: ${JSON.stringify(marks)}`);
}

function copyTree(src, dest) {
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
}

async function routeLocalhost(context) {
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') route.continue();
    else route.abort();
  });
}

async function openGuestPage(context, base, slug, editorToken) {
  const page = await context.newPage();
  await page.goto(`${base}/d/${slug}?token=${encodeURIComponent(editorToken)}`);
  await page.getByRole('button', { name: 'Continue anonymously', exact: true }).click({ timeout: 4_000 }).catch(() => {});
  await page.waitForFunction(
    () => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true,
    null,
    { timeout: 30_000 },
  );
  return page;
}

/** Old client (0913728): inline Suggesting on a share link — type in the document, not the draft box. */
async function seedOldClientSession(page, dbPath, slug) {
  await page.waitForFunction(
    () => window.__proofLineMarks?.debugState().loaded === true,
    null,
    { timeout: 20_000 },
  );
  const suggesting = await page.evaluate(() => window.proof?.isSuggestionsEnabled?.());
  assert.equal(suggesting, true, 'old share guest should start in Suggesting mode');

  const secondLine = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.ProseMirror > *')];
    const idx = blocks.findIndex((el) => /second passage/i.test(el.textContent ?? ''));
    return idx >= 0 ? idx : 2;
  });

  const block = page.locator('.ProseMirror > *').nth(secondLine);
  await block.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await sleep(400);
  const box = await block.boundingBox();
  assert.ok(box, 'second passage block missing');
  await page.mouse.click(box.x + 12, box.y + box.height / 2);
  await sleep(200);
  await page.keyboard.type('a');
  await page.keyboard.press('Escape');
  await page.mouse.wheel(0, 500);
  await sleep(350);
  await page.mouse.wheel(0, -500);
  await sleep(350);

  const { pending } = await waitForPendingCount(dbPath, slug, 2, 'old-client session');
  const yjs = readYjsMarks(dbPath, slug);
  console.log(
    `  fixture row pending=${pending.length} yjs marks keys=${Object.keys(yjs.marks).length} y_state_version=${yjs.version}`,
  );
  return pending.map(([id]) => id);
}

async function assertMarksSurvive(label, repoRoot, fixtureDir, slug, editorToken, expectPass) {
  const workDir = mkdtempSync(path.join(tmpdir(), 'proof-marks-migration-run-'));
  try {
    copyTree(path.join(fixtureDir, 'db'), workDir);
    copyTree(path.join(fixtureDir, 'profile'), path.join(workDir, 'profile'));

    const { base, stop, dbPath } = await startServer(repoRoot, workDir);
    const context = await chromium.launchPersistentContext(path.join(workDir, 'profile'), {
      headless: true,
      viewport: { width: 1440, height: 900 },
    });
    try {
      await routeLocalhost(context);
      const page = await openGuestPage(context, base, slug, editorToken);
      await sleep(5_000);
      await page.close();

      const dbMarks = readDbMarks(dbPath, slug);
      const dbPending = pendingSuggestions(dbMarks);
      const st = await agent(base, slug, editorToken, 'GET', '/state');
      assert.equal(st.status, 200);
      const statePending = pendingSuggestions(st.body.marks);

      const ok = dbPending.length >= 2 && statePending.length >= 2;
      const line = [
        `${label}:`,
        `documents.marks pending=${dbPending.length}`,
        `/state pending=${statePending.length}`,
        expectPass ? '(expect PASS)' : '(expect FAIL — reproduction)',
      ].join(' ');
      console.log(line);
      if (dbPending.length < 2) console.log(`  documents.marks: ${JSON.stringify(dbMarks)}`);
      if (statePending.length < 2) console.log(`  /state marks: ${JSON.stringify(st.body.marks)}`);

      if (expectPass) {
        assert.ok(ok, `${label}: fix tree should keep both pending suggestions`);
        console.log(`PASS ${label}`);
        return true;
      }
      if (ok) {
        console.log(`FAIL ${label}: broken build kept marks — reproduction missing`);
        return false;
      }
      console.log(`PASS ${label}: broken build cleared marks (incident reproduced)`);
      return true;
    } finally {
      await context.close();
      await stop();
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function buildFixture() {
  const runDir = mkdtempSync(path.join(tmpdir(), 'proof-marks-migration-fixture-'));
  const profileDir = path.join(runDir, 'profile');
  const dataDir = path.join(runDir, 'data');
  const fixtureDir = path.join(runDir, 'fixture');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(fixtureDir, { recursive: true });

  const { base, stop, dbPath } = await startServer(p0Old, dataDir);
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    viewport: { width: 1440, height: 900 },
  });

  let slug;
  let editorToken;
  let markIds;
  try {
    await context.addInitScript(() => {
      try {
        localStorage.setItem('proof-share-viewer-name', 'MigrationGuest');
      } catch {}
    });
    await routeLocalhost(context);

    const created = await createDoc(base);
    slug = created.slug;
    const ownerSecret = created.ownerSecret;
    assert.ok(ownerSecret);

    const suggest = await agent(base, slug, created.accessToken, 'POST', '/marks/suggest-replace', {
      quote: 'target phrase',
      by: 'ai:check',
      content: 'revised phrase',
    });
    assert.equal(suggest.status, 200, `suggest-replace: ${JSON.stringify(suggest.body).slice(0, 200)}`);
    assert.ok(pendingSuggestions(suggest.body.marks).length >= 1, 'API replace missing');

    editorToken = await editorGuestToken(base, slug, ownerSecret);
    const page = await openGuestPage(context, base, slug, editorToken);
    markIds = await seedOldClientSession(page, dbPath, slug);
    await page.close();
  } finally {
    await context.close();
    await stop();
  }

  copyTree(dataDir, path.join(fixtureDir, 'db'));
  copyTree(profileDir, path.join(fixtureDir, 'profile'));

  const fixtureDbPath = path.join(fixtureDir, 'db', 'test.db');
  const rowPending = pendingSuggestions(readDbMarks(fixtureDbPath, slug)).length;
  const yjsBefore = readYjsMarks(fixtureDbPath, slug);
  const yjsKeys = Object.keys(yjsBefore.marks).length;
  let ingredient = 'natural row/yjs split';
  if (yjsKeys >= rowPending) {
    stripYjsMarksMap(fixtureDbPath, slug);
    ingredient = 'simulated deploy mismatch (documents.marks ahead of empty Yjs marks map)';
  }
  const yjsAfter = readYjsMarks(fixtureDbPath, slug);
  const rowAfter = pendingSuggestions(readDbMarks(fixtureDbPath, slug)).length;
  console.log(
    `  fixture ingredient: ${ingredient}; row pending=${rowAfter} yjs keys=${Object.keys(yjsAfter.marks).length} (was ${yjsKeys})`,
  );

  return { fixtureDir, slug, editorToken, markIds, runDir };
}

assertWorktrees();

console.log(`marks-migration-check: style=${style}`);
console.log('Building fixture on 0913728 (old client + server)...');
const { fixtureDir, slug, editorToken, markIds, runDir } = await buildFixture();
console.log(`Fixture: slug=${slug} pending ids=${markIds.join(', ')}`);

let brokenOk = false;
let fixedOk = false;
try {
  brokenOk = await assertMarksSurvive('d15df82 first open', p0Broken, fixtureDir, slug, editorToken, false);
  fixedOk = await assertMarksSurvive('fix tree first open', fixedRoot, fixtureDir, slug, editorToken, true);
} finally {
  rmSync(runDir, { recursive: true, force: true });
}

const failures = [];
if (!brokenOk) failures.push('broken build did not reproduce deletion');
if (!fixedOk) failures.push('fix tree did not preserve marks');

if (failures.length) {
  console.log(`marks-migration-check: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('marks-migration-check: all passed');
process.exit(0);
