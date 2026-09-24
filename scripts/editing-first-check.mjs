#!/usr/bin/env node
// Browser check for "editing first" (Mike, 2026-09-19): clicking text under a comment and
// suggestions places the caret and opens nothing; typing never moves the view; the focus line
// follows the caret; editing another's statement gives the editor Agreed and the rail says
// "changed by <name> — meaning changed".
// Authorship: Claude Opus 5 (worker proof-editfix), 2026-09-19, in the style of reading-walk-check.mjs.
// Starts an isolated local server on the current dist/ build (run `npm run build` first) in both
// review-style settings (the style is locked, so both must behave the same) at 1440 and on a
// 390x844 phone. Screenshots go to .preview/ (or --shots <dir>). Exit 0 only if every check passes.
// Usage: node scripts/editing-first-check.mjs [--style playmaker|proof] [--shots dir]
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

const clientHeaders = { 'X-Proof-Client-Version': '0.33.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `editing-first-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-editing-first-check-'));
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

const plain = (n) => `Paragraph ${n} is plain text for reading; it carries no marks and is long enough to be a real line.`;
const TARGET = 'For use in the open Source Editor Proof, this line carries a comment, the alpha word and the beta word.';
const markdown = [
  '# Editing first check',
  ...Array.from({ length: 12 }, (_, i) => plain(i + 1)),
  TARGET,
  ...Array.from({ length: 12 }, (_, i) => plain(i + 14)),
].join('\n\n');
const TARGET_LINE = 13;
const TYPED = 'SOMA Marked Document Editor ok'; // 30 characters
assert.equal(TYPED.length, 30);

async function createDoc(base) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown, title: 'Editing first check' }),
  });
  assert.equal(response.status, 200);
  const created = await response.json();
  const post = async (route, body) => {
    const r = await fetch(`${base}/api/agent/${created.slug}${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-share-token': created.accessToken }, body: JSON.stringify(body),
    });
    assert.ok(r.ok, `${route}: ${r.status} ${await r.text()}`);
  };
  await post('/marks/comment', { quote: 'open Source Editor Proof', text: 'Claude: rename this?', by: 'ai:check' });
  for (const [quote, content] of [['alpha word', 'ALPHA word'], ['beta word', 'BETA word']]) {
    await post('/marks/suggest-replace', { quote, content, by: 'ai:check' });
  }
  // Another person's claim on the line: it is "another's statement" for the reader.
  await post('/marks/line', { lineIndex: TARGET_LINE, status: 'agreed', by: 'ai:check' });
  return created;
}

async function openDoc(browser, base, slug, name, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.addInitScript(viewer => { try { localStorage.setItem('proof-share-viewer-name', viewer); } catch {} }, name);
  const page = await context.newPage();
  await page.goto(`${base}/d/${slug}`);
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForFunction(() => window.__proofReadingWalk?.debugState().ready === true
    && (window.proof?.getAllMarks?.() ?? []).filter(m => m.data?.status === 'pending').length >= 2, null, { timeout: 10_000 });
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  page.setDefaultTimeout(6000);
  return { context, page };
}

const walk = page => page.evaluate(() => window.__proofReadingWalk.debugState());
const lineText = page => page.evaluate(i => window.__proofLineMarks.debugState().lines?.[i]?.text
  ?? document.querySelectorAll('.ProseMirror > *')[i]?.textContent ?? '', TARGET_LINE);
const reviewUiOpen = page => page.locator('.pm-review-dialog:visible, .mark-popover:visible, [role="dialog"]:visible').count();

async function run(browser, base, style, tag, contextOptions, phone) {
  const created = await createDoc(base);
  const { context, page } = await openDoc(browser, base, created.slug, 'Ada', contextOptions);
  activePage = page;
  const comment = await page.evaluate(() => (window.proof.getAllMarks() ?? []).find(m => m.kind === 'comment')?.id);

  await check(`${tag}: clicking text under a comment selects its passage and opens nothing`, async () => {
    const highlight = page.locator(`.ProseMirror [data-mark-id="${comment}"]`).first();
    await highlight.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.waitForTimeout(600);
    const box = await highlight.boundingBox();
    // Just before "Source": inside the commented words.
    if (phone) await page.touchscreen.tap(box.x + 4, box.y + box.height / 2);
    else await page.mouse.click(box.x + 4, box.y + box.height / 2);
    await page.waitForTimeout(400);
    assert.equal(await reviewUiOpen(page), 0, 'a review dialog or popover opened');
    assert.equal((await walk(page)).focus, TARGET_LINE, 'click did not select the passage');
    assert.equal(await page.evaluate(() => window.__proofEditingGuard().writing), false);

  });

  await check(`${tag}: typing a local draft keeps every character and never moves the view`, async () => {
    await page.evaluate(i => window.__proofEditGesture.open(i), TARGET_LINE);
    await page.locator('.accord-draft textarea').focus();
    await page.locator('.accord-draft textarea').evaluate(e => e.setSelectionRange(0, 0));
    const before = await page.evaluate(() => window.scrollY);
    const textBefore = await lineText(page);
    for (const ch of TYPED) { await page.keyboard.type(ch); await page.waitForTimeout(25); }
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => window.scrollY);
    assert.ok(Math.abs(after - before) <= 2, `the view moved from ${before} to ${after}`);
    const text = await page.locator('.accord-draft textarea').inputValue();
    assert.ok(text.includes(TYPED), `the typed text is not in the target line: ${text}`);
    assert.equal(await lineText(page), textBefore, 'drafting changed the shared line');
    assert.equal(await reviewUiOpen(page), 0, 'a review dialog or popover opened while typing');
    await page.screenshot({ path: path.join(shots, `${tag}-typed.png`) });
  });

  await check(`${tag}: the focus line follows the caret`, async () => {
    assert.equal((await walk(page)).focus, TARGET_LINE);
  });

  await check(`${tag}: a scroll while editing does not step, snap or move the focus`, async () => {
    const focus = (await walk(page)).focus;
    await page.keyboard.type(' ');
    if (!phone) { await page.mouse.wheel(0, 300); await page.waitForTimeout(400); }
    else { await page.evaluate(() => window.scrollBy(0, 300)); await page.waitForTimeout(400); }
    assert.equal((await walk(page)).focus, focus, 'the focus moved while editing');
  });

  await check(`${tag}: only Propose change writes one attributed proposal`, async () => {
    assert.equal(await page.evaluate(() => window.proof.isSuggestionsEnabled()), false);
    const mine = () => page.evaluate(() => window.proof.getAllMarks().filter(m => m.kind === 'replace' && m.data?.status === 'pending' && String(m.by).includes('Ada')));
    assert.equal((await mine()).length, 0);
    await page.locator('[data-draft-action="propose"]').click();
    assert.equal((await mine()).length, 1);
    assert.ok((await mine())[0].data.content.includes(TYPED));
  });

  await check(`${tag}: editing another's statement in Editing mode: the editor's mark is Agreed and the rail says the meaning changed`, async () => {
    await page.evaluate(() => document.querySelector('.share-pill-suggest-toggle').click());
    const words = page.locator('.ProseMirror > *').nth(TARGET_LINE);
    await words.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.waitForTimeout(300);
    const box = await words.boundingBox();
    const before = await page.evaluate(() => window.scrollY);
    if (phone) await page.touchscreen.tap(box.x + 2, box.y + 6); else await page.mouse.click(box.x + 2, box.y + 6);
    // No Home key: at a line's start Chrome turns Home into a page scroll to the top.
    for (const ch of 'We never agreed: ') { await page.keyboard.type(ch); await page.waitForTimeout(25); }
    await page.waitForFunction(i => document.querySelector(`.plm-dot[data-line="${i}"]`)?.dataset.status === 'agreed', TARGET_LINE, { timeout: 8000, polling: 150 });
    const after = await page.evaluate(() => window.scrollY);
    assert.ok(Math.abs(after - before) <= 2, `the view moved from ${before} to ${after}`);
    const mine = await page.evaluate(i => window.__proofLineMarks.debugState().marks
      .find(m => m.by === window.__proofLineMarks.me() && m.status === 'agreed' && m.anchor.ordinal === i), TARGET_LINE);
    assert.equal(mine?.via, 'edit', `the editor's mark ${JSON.stringify(mine)}`);
    if (phone) {
      await page.evaluate(() => document.activeElement?.blur());
      await page.getByRole('button', { name: 'More options', exact: true }).click();
      await page.getByRole('menuitem', { name: /This line/ }).click();
    }
    const note = page.locator('.prw-right .prw-edit-note');
    await note.waitFor({ state: 'visible', timeout: 6000 });
    const text = await note.innerText();
    assert.ok(/changed by .*meaning changed/.test(text), `rail note: ${text}`);
    await page.screenshot({ path: path.join(shots, `${tag}-edit-note.png`) });
  });
  await context.close();
}

const browser = await chromium.launch();
try {
  for (const style of styles) {
    const { base, stop } = await startServer(style);
    try {
      await run(browser, base, style, `editing-first-${style}-1440`, { viewport: { width: 1440, height: 900 } }, false);
      await run(browser, base, style, `editing-first-${style}-phone-390x844`, { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } }, true);
    } finally {
      await stop();
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${results.length - failures}/${results.length} editing-first checks passed`);
process.exit(failures ? 1 : 0);
