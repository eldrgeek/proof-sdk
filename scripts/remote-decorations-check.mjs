#!/usr/bin/env node
// Browser check: view-only decorations survive a remote collaboration update.
// A remote Yjs update rebuilds the whole ProseMirror document, which drops mapped decorations.
// Two pages open one document; page A types; page B's ask widgets, folded sections and
// alternatives stacks must all still be there afterwards (and after a second, later edit).
// Authorship: Claude Opus 5 (worker proof-do), 2026-09-18, in the style of asks-check.mjs.
// Usage: node scripts/remote-decorations-check.mjs [--style playmaker|proof] [--shots dir]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const shots = arg('--shots') || path.join(root, '.preview');
mkdirSync(shots, { recursive: true });
const styles = arg('--style') ? [arg('--style')] : ['playmaker', 'proof'];

const clientHeaders = { 'X-Proof-Client-Version': '0.33.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `remote-deco-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-remote-deco-'));
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

const para = (tag, n) => `${tag} paragraph ${n} is plain text for reading; it is long enough to be a real line of the document.`;
const markdown = [
  '# Remote decorations', para('Intro', 1),
  'Should we ship the first thing tonight?',
  'Should we ship the second thing this week?',
  'The wording line has two competing wordings.',
  '## Folded section', para('Hidden', 1), para('Hidden', 2),
  '## After', para('Last', 1),
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
    body: JSON.stringify({ markdown, title: 'Remote decorations' }),
  });
  assert.equal(response.status, 200);
  const created = await response.json();
  for (const quote of ['ship the first thing', 'ship the second thing']) {
    const r = await api(base, created, 'POST', '/asks', { by: 'ai:cos', quote, to: ['Bea'], recommend: 'Yes' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const alt = await api(base, created, 'POST', '/alternatives', { by: 'ai:cos', quote: 'two competing wordings', text: 'The wording line has a rival wording.' });
  created.altOk = alt.status === 200;
  if (!created.altOk) console.log(`note: alternatives route answered ${alt.status} ${JSON.stringify(alt.body).slice(0, 160)}`);
  return created;
}

async function openDoc(browser, base, slug, name) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.addInitScript(viewer => { try { localStorage.setItem('proof-share-viewer-name', viewer); } catch {} }, name);
  const page = await context.newPage();
  await page.goto(`${base}/d/${slug}`);
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelectorAll('.ProseMirror .pask').length >= 2, null, { timeout: 10_000 });
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  page.setDefaultTimeout(6000);
  return { context, page };
}

const counts = page => page.evaluate(() => ({
  asks: document.querySelectorAll('.ProseMirror .pask').length,
  tags: document.querySelectorAll('.ProseMirror .pask-inline-tag').length,
  alts: document.querySelectorAll('.ProseMirror .pdx-alts').length,
  hidden: document.querySelectorAll('.ProseMirror .pfold-hidden').length,
  folded: document.querySelectorAll('.ProseMirror .pfold-folded-heading').length,
}));

async function typeInto(page, words, where = 'last') {
  // Direct Editing is the labelled control. A click while Reading only selects, so the keys
  // would be swallowed. Mike, 2026-09-23 (usability brief). Press the text like a person does,
  // at the end of the line, then pin the caret to the exact position below.
  await page.evaluate(() => {
    const btn = document.querySelector('.share-pill-suggest-toggle');
    if (btn && btn.getAttribute('aria-label') !== 'Leave Editing') btn.click();
  });
  const at = await page.evaluate(where => {
    const view = window.__proofLineMarks.editorView();
    const lines = window.__proofLineMarks.lineList();
    const line = where === 'first' ? lines[1] : lines[lines.length - 1];
    const dom = view.nodeDOM(line.pos);
    dom.scrollIntoView({ block: 'center', behavior: 'instant' });
    const c = view.coordsAtPos(line.pos + line.nodeSize - 1);
    return { x: c.left - 2, y: (c.top + c.bottom) / 2 };
  }, where);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(80);
  await page.evaluate(where => {
    const view = window.__proofLineMarks.editorView();
    const lines = window.__proofLineMarks.lineList();
    // 'last' edits after every widget, so no widget's position changes (the case that used to
    // drop them); 'first' edits above them, so every position shifts.
    const line = where === 'first' ? lines[1] : lines[lines.length - 1];
    const end = line.pos + line.nodeSize - 1;
    view.focus();
    const { TextSelection } = window.__proofPm ?? {};
    const sel = TextSelection ? TextSelection.create(view.state.doc, end) : null;
    if (sel) view.dispatch(view.state.tr.setSelection(sel));
    else {
      const dom = view.nodeDOM(line.pos);
      const range = document.createRange(); range.selectNodeContents(dom); range.collapse(false);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
    }
  }, where);
  await page.keyboard.type(words, { delay: 20 });
}

async function run(browser, base, style) {
  const created = await createDoc(base);
  const tag = `remote-deco-${style}`;
  const a = await openDoc(browser, base, created.slug, 'Ada');
  const b = await openDoc(browser, base, created.slug, 'Bea');
  activePage = b.page;
  // Fold "Folded section" on page B.
  const folded = await b.page.evaluate(() => {
    const fold = window.__proofFolding;
    if (!fold) return 'no-folding-hook';
    const lines = window.__proofLineMarks.lineList();
    const heading = lines.find(l => /Folded section/.test(l.text));
    try { fold.toggle?.(heading.index) ?? fold.fold?.(heading.index); } catch (e) { return String(e); }
    return 'ok';
  });
  await b.page.waitForTimeout(300);
  const before = await counts(b.page);
  await check(`${tag}: page B starts with its widgets (asks ${before.asks}, alts ${before.alts}, hidden ${before.hidden}; fold hook ${folded})`, async () => {
    assert.equal(before.asks, 2);
    assert.equal(before.tags, 2);
    // Step 3 round 2 retired the stacked-alternatives widget (a proposal does that job); stored alternatives stay.
    assert.equal(before.alts, 0, 'the retired alternatives stack rendered');
  });
  await typeInto(a.page, ' Typed by Ada.');
  await b.page.waitForFunction(() => /Typed by Ada\./.test(window.proof.getMarkdownSnapshot()?.content ?? ''), null, { timeout: 10_000 });
  await b.page.waitForTimeout(600);
  const after = await counts(b.page);
  await b.page.screenshot({ path: path.join(shots, `${tag}-after-remote-edit.png`) });
  await check(`${tag}: after page A types, page B still shows both ask controls and tags (got ${JSON.stringify(after)})`, async () => {
    assert.equal(after.asks, 2);
    assert.equal(after.tags, 2);
  });
  await check(`${tag}: after page A types, page B still shows no alternatives stack`, async () => {
    assert.equal(after.alts, 0);
  });
  await check(`${tag}: after page A types, page B's folded section stays folded`, async () => {
    assert.equal(after.hidden, before.hidden);
    assert.equal(after.folded, before.folded);
  });
  await typeInto(a.page, ' Again.', 'first');
  await b.page.waitForFunction(() => /Again\./.test(window.proof.getMarkdownSnapshot()?.content ?? ''), null, { timeout: 10_000 });
  await b.page.waitForTimeout(600);
  const again = await counts(b.page);
  await check(`${tag}: a second remote edit keeps every widget (got ${JSON.stringify(again)})`, async () => {
    assert.deepEqual(again, before);
  });
  await check(`${tag}: the typing page A keeps its own widgets`, async () => {
    const own = await counts(a.page);
    assert.equal(own.asks, 2);
    assert.equal(own.tags, 2);
  });
  await a.context.close();
  await b.context.close();
}

const browser = await chromium.launch();
try {
  for (const style of styles) {
    const { base, stop } = await startServer(style);
    try { await run(browser, base, style); } finally { await stop(); }
  }
} finally {
  await browser.close();
}
console.log(`\n${results.length - failures}/${results.length} remote-decoration checks passed`);
process.exit(failures ? 1 : 0);
