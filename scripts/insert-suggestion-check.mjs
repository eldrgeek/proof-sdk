#!/usr/bin/env node
// Browser check: an AI's pending insert suggestion shows exactly once, in both review styles.
// Regression for 2026-09-18: a paragraph insert added through the agent API
// (suggest-insert, content "\n\n<paragraph>") is materialized in the document by the server,
// and the page ALSO drew the raw content (leading "\n\n", markdown escapes) in a
// .mark-replace-insert widget, so every pending insert appeared twice.
// Starts an isolated local server (one per style) on the current dist/ build (run
// `npm run build` first) with a temp SQLite database. Checks: the insert shows once and
// raw markdown never shows; accept leaves it once as plain text; reject removes it; a
// replace suggestion still shows the old words struck and the new words in a widget.
// Exit code 0 only if every check passes.
// Usage: node scripts/insert-suggestion-check.mjs [--style playmaker|proof]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-insert-check-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      PORT: String(port), COLLAB_EMBEDDED_WS: '1', PROOF_DEFAULT_REVIEW_STYLE: style,
      PROOF_FEEDBACK_ENABLED: '0',
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

const markdown = `# Insert check

The anchor paragraph ends here.

The replace paragraph has an old phrase in it.

The last paragraph sits near the bottom.`;

const INSERT_TEXT = 'Inserted [bracketed] paragraph from the AI.';
const INSERT_CONTENT = '\n\nInserted \\[bracketed\\] paragraph from the AI.';

async function createDoc(base) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown, title: 'Insert suggestion check' }),
  });
  assert.equal(response.status, 200);
  return await response.json();
}

async function agent(base, created, route, body) {
  const response = await fetch(`${base}/api/agent/${created.slug}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-share-token': created.accessToken },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  assert.ok(response.ok, `${route} -> ${response.status} ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

async function openDoc(browser, base, slug) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(`${base}/d/${slug}`);
  await page.getByRole('button', { name: 'Continue anonymously', exact: true }).click({ timeout: 10_000 }).catch(() => {});
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => window.__proofEditingGuard().writing), false, 'opening proposals must stay in Reading');
  return { context, page };
}

const editorText = page => page.evaluate(() => document.querySelector('.ProseMirror')?.innerText ?? '');
const occurrences = (haystack, needle) => haystack.split(needle).length - 1;
const pendingOf = (page, kind) => page.evaluate(k => (window.proof?.getAllMarks?.() ?? window.proof?.getMarks?.() ?? [])
  .filter(m => m.kind === k && m.data?.status === 'pending').map(m => m.id), kind);

async function run(browser, base, style) {
  const tag = `insert-${style}`;
  const created = await createDoc(base);
  await agent(base, created, '/marks/suggest-insert', { quote: 'The anchor paragraph ends here.', content: INSERT_CONTENT, by: 'ai:check' });
  await agent(base, created, '/marks/suggest-replace', { quote: 'old phrase', content: 'new phrase', by: 'ai:check' });
  const { context, page } = await openDoc(browser, base, created.slug);
  try {
    await page.waitForFunction(() => (window.proof?.getAllMarks?.() ?? []).filter(m => m.data?.status === 'pending').length >= 2, null, { timeout: 10_000 });

    await check(`${tag}: a pending paragraph insert shows exactly once`, async () => {
      const text = await editorText(page);
      assert.equal(occurrences(text, 'paragraph from the AI.'), 1, `insert text appears ${occurrences(text, 'paragraph from the AI.')} times`);
      assert.equal(occurrences(text, '\\['), 0, 'raw markdown escapes are visible');
      const insertWidgets = await page.locator('.ProseMirror .ProseMirror-widget.mark-insert[data-mark-kind="insert"]').count();
      assert.equal(insertWidgets, 0, `found ${insertWidgets} raw insert widget(s)`);
    });

    await check(`${tag}: a replace suggestion shows the old words struck and the new words once`, async () => {
      const struck = page.locator('.ProseMirror .mark-replace.mark-delete');
      assert.equal((await struck.first().innerText()).trim(), 'old phrase');
      const widgets = page.locator('.ProseMirror .ProseMirror-widget.mark-insert');
      assert.equal(await widgets.count(), 1, 'expected exactly the one replace widget');
      assert.equal((await widgets.first().innerText()).trim(), 'new phrase');
    });

    await check(`${tag}: suggestion spans carry no [object Object] attributes`, async () => {
      const html = await page.evaluate(() => document.querySelector('.ProseMirror')?.innerHTML ?? '');
      assert.equal(html.includes('[object Object]'), false);
    });

    await check(`${tag}: accept leaves the inserted paragraph once as normal text`, async () => {
      const [id] = await pendingOf(page, 'insert');
      assert.ok(id, 'no pending insert');
      assert.equal(await page.evaluate(i => window.proof.markAccept(i), id), true);
      await page.waitForTimeout(600);
      const text = await editorText(page);
      assert.equal(occurrences(text, INSERT_TEXT), 1, `after accept the text appears ${occurrences(text, INSERT_TEXT)} times`);
      assert.equal(await page.locator(`.ProseMirror [data-mark-id="${id}"]`).count(), 0, 'accepted insert is still decorated');
      assert.equal((await pendingOf(page, 'insert')).length, 0);
    });

    // Second insert for the reject path.
    await agent(base, created, '/marks/suggest-insert', { quote: 'The last paragraph sits near the bottom.', content: '\n\nA paragraph to reject.', by: 'ai:check' });
    await page.waitForFunction(() => (window.proof?.getAllMarks?.() ?? []).some(m => m.kind === 'insert' && m.data?.status === 'pending'), null, { timeout: 10_000 });
    await page.waitForTimeout(400);

    await check(`${tag}: reject removes the inserted paragraph cleanly`, async () => {
      assert.equal(occurrences(await editorText(page), 'A paragraph to reject.'), 1, 'second insert should show once before reject');
      const [id] = await pendingOf(page, 'insert');
      assert.equal(await page.evaluate(i => window.proof.markReject(i), id), true);
      await page.waitForTimeout(600);
      const text = await editorText(page);
      assert.equal(occurrences(text, 'A paragraph to reject.'), 0, 'rejected insert text is still on the page');
      assert.equal(occurrences(text, 'The last paragraph sits near the bottom.'), 1, 'anchor paragraph was damaged');
      assert.equal(await page.locator('.ProseMirror .ProseMirror-widget.mark-insert[data-mark-kind="insert"]').count(), 0);
    });
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({ headless: true });
try {
  for (const style of styles) {
    const { base, stop } = await startServer(style);
    try { await run(browser, base, style); } finally { await stop(); }
  }
} finally {
  await browser.close();
}
console.log(failures ? `insert-suggestion-check: ${failures} FAILED` : 'insert-suggestion-check: all passed');
process.exit(failures ? 1 : 0);
