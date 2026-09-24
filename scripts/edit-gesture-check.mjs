// Mike, 2026-09-23 (usability brief): drafts publish only on explicit submission.
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
const styles = arg('--style') ? [arg('--style')] : ['proof', 'playmaker'];

const clientHeaders = { 'X-Proof-Client-Version': '0.31.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `edit-FAIL-${failures}.png`), fullPage: false }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-edit-gesture-check-'));
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
const TARGET = 'The edit gesture line: this sentence is what a person will change, and it must survive every door.';
const markdown = [
  '# Edit gesture check',
  ...Array.from({ length: 8 }, (_, i) => plain(i + 1)),
  TARGET,
  ...Array.from({ length: 20 }, (_, i) => plain(i + 10)),
].join('\n\n');
// The line index is the MARGIN's index (window.__proofLineMarks.lineList()), which is not
// always the nth child of .ProseMirror; every run resolves it from the text.
let TARGET_LINE = 9;
// Deliberately awkward: a word no reading key would produce, and a DOUBLE space. The margin's
// line text is normalised (whitespace collapsed), so a leave that measures the line with it
// instead of with the document's own text lands a character off and writes the line twice. That
// is a real bug this check is here to catch (2026-09-22), so the typed text must contain one.
const TYPED = 'ZEPHYR-QUOKKA  PROOF-2026 ';
assert.ok(TYPED.includes('  '), 'the typed text must contain a double space');

async function createDoc(base) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown, title: 'Edit gesture check' }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function openDoc(browser, base, slug, name, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.addInitScript(viewer => { try { localStorage.setItem('proof-share-viewer-name', viewer); } catch {} }, name);
  const page = await context.newPage();
  await page.goto(`${base}/d/${slug}`);
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForFunction(() => window.__proofReadingWalk?.debugState().ready === true, null, { timeout: 10_000 });
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  page.setDefaultTimeout(6000);
  return { context, page };
}

const walkState = page => page.evaluate(() => window.__proofReadingWalk.debugState());
const postedLog = page => page.evaluate(() => window.__proofEditGesture?.debugState().posted ?? []);
const allLines = page => page.evaluate(() => window.__proofLineMarks.lineList().map(l => l.text));
const lineTextOf = async (page, i) => (await allLines(page))[i] ?? '';
/** The line's text as the DOCUMENT holds it, not as the margin normalises it. */
const rawLineText = (page, i) => page.evaluate(n => {
  const line = window.__proofLineMarks.lineList()[n];
  const doc = window.__editorView.state.doc;
  return doc.textBetween(line.pos + 1, line.pos + line.nodeSize - 1, '\n', '\n');
}, i);
/** The margin's index for the line that holds `text`. */
const lineIndexOf = (page, text) => page.evaluate(t => window.__proofLineMarks.lineList().findIndex(l => l.text.includes(t)), text);
/** Every open suggestion the viewer has posted, with the words it proposes. */
const myProposals = page => page.evaluate(() => (window.proof.getAllMarks() ?? [])
  .filter(m => (m.kind === 'replace' || m.kind === 'insert') && (m.data?.status ?? 'pending') === 'pending')
  .map(m => ({ id: m.id, kind: m.kind, by: String(m.by), content: String(m.data?.content ?? ''), quote: String(m.quote ?? '') })));


const state = page => page.evaluate(() => {
  const view = window.__editorView;
  const pm = []; view.state.doc.forEach(node => pm.push(node.textContent));
  const binding = view.state.plugins.map(p => p.getState(view.state)).find(s => s?.binding)?.binding;
  const yjs = binding?.type.toArray().map(t => t.toString().replace(/<[^>]+>/g, ''));
  return { pm, yjs };
});
const toggleEditing = page => page.evaluate(() => document.querySelector('.share-pill-suggest-toggle').click());
// textContent, not innerText: on a phone the status bar is folded into the strip (display:none)
// and innerText is empty, while the mode word is still the named status.
const modeText = page => page.locator('.pst-mode').evaluate(el => el.textContent);
async function run(browser, base, style, phone) {
  const options = phone ? { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } : { viewport: { width: 1440, height: 900 } };
  const created = await createDoc(base);
  const { context, page } = await openDoc(browser, base, created.slug, 'Ada', options);
  const peer = await openDoc(browser, base, created.slug, 'Bob', options);
  activePage = page;
  const tag = `${style}-${phone ? 'phone' : 'desktop'}`;
  TARGET_LINE = await lineIndexOf(page, TARGET);
  const originalState = await state(page);
  const open = async () => {
    await page.evaluate(i => window.__proofReadingWalk.focusLine(i), TARGET_LINE);
    // S is the keyboard entry; phone uses the persistent margin pencil.
    if (phone) await page.locator('.plm-edit-pencil').click();
    else { await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('s'); }
    await page.locator('.accord-draft textarea').waitFor();
  };
  await check(`${tag}: click selects, typing does not edit, S or the visible control opens a prefilled draft`, async () => {
    const paragraph = page.locator('.ProseMirror p').filter({ hasText: TARGET }).first();
    await paragraph.click();
    assert.equal((await walkState(page)).focus, TARGET_LINE);
    await page.keyboard.press('x');
    assert.deepEqual((await state(page)).pm, originalState.pm);
    await open();
    assert.equal(await page.locator('.accord-draft textarea').inputValue(), TARGET);
    assert.equal(await page.locator('[data-draft-action="propose"]').isDisabled(), true);
  });
  const proposed = `${TARGET} ${TYPED}`;
  await check(`${tag}: typing, scrolling, hover, focus changes and Esc publish nothing and retain exact text`, async () => {
    await page.locator('.accord-draft textarea').fill(proposed);
    await page.evaluate(() => window.scrollBy(0, 80));
    if (!phone) await page.mouse.move(40, 300);
    // A click outside the draft keeps it. On a phone the mode chip is not on screen: the status
    // bar is folded into the strip. Click another passage instead. Mike, 2026-09-23 (usability brief).
    if (phone) {
      const other = page.locator('.ProseMirror p').filter({ hasText: 'Paragraph 1 is plain' }).first();
      await other.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await other.click({ position: { x: 12, y: 8 } });
    } else await page.locator('.pst-mode').click();
    assert.equal((await myProposals(page)).length, 0);
    await page.locator('[data-draft-action="resume"]').click();
    assert.equal(await page.locator('.accord-draft textarea').inputValue(), proposed);
    await page.keyboard.press('Escape');
    assert.equal((await myProposals(page)).length, 0);
    assert.deepEqual((await state(page)).pm, originalState.pm);
    assert.equal((await peer.page.locator('.accord-draft').count()), 0, 'draft leaked to another reader');
  });
  await check(`${tag}: reload keeps a collapsed draft; Resume restores its exact text`, async () => {
    await page.reload();
    await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded && window.__proofReadingWalk?.debugState().ready);
    await page.locator('[data-draft-action="resume"]').click();
    assert.equal(await page.locator('.accord-draft textarea').inputValue(), proposed);
    assert.equal((await myProposals(page)).length, 0);
  });
  await check(`${tag}: a remote comment keeps draft focus and caret`, async () => {
    await page.locator('.accord-draft textarea').focus();
    const selection = await page.locator('.accord-draft textarea').evaluate(e => [e.selectionStart, e.selectionEnd]);
    await peer.page.evaluate(() => window.proof.markComment('Paragraph 1 is plain', 'human:Bob', 'Remote note'));
    await page.waitForFunction(() => window.proof.getAllMarks().some(m => m.kind === 'comment' && m.data?.text === 'Remote note'));
    assert.equal(await page.locator('.accord-draft textarea').evaluate(e => document.activeElement === e), true);
    assert.deepEqual(await page.locator('.accord-draft textarea').evaluate(e => [e.selectionStart, e.selectionEnd]), selection);
  });
  let undoDepthBefore = 0;
  await check(`${tag}: a second participant edits this passage while submission writes one attributed proposal`, async () => {
    await toggleEditing(peer.page);
    await peer.page.locator('.ProseMirror p').filter({ hasText: TARGET }).first().click();
    await peer.page.evaluate(index => {
      const view = window.__editorView;
      const line = window.__proofLineMarks.lineList()[index];
      view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(line.pos + line.nodeSize - 1))));
      view.focus();
    }, TARGET_LINE);
    await peer.page.keyboard.type(' REMOTE-BEFORE');
    await page.waitForFunction(() => window.__editorView.state.doc.textContent.includes('REMOTE-BEFORE'));
    assert.match(await page.locator('.accord-draft-warning').innerText(), /changed/);
    undoDepthBefore = await page.evaluate(() => window.__proofUndo.debugState().depth);
    await Promise.all([
      peer.page.keyboard.type(' REMOTE-DURING', { delay: 30 }),
      phone ? page.locator('[data-draft-action="propose"]').click() : page.locator('.accord-draft textarea').press('Control+Enter'),
    ]);
    await page.waitForFunction(() => window.__editorView.state.doc.textContent.includes('REMOTE-DURING'));
    const proposals = await myProposals(page);
    assert.equal(proposals.length, 1); assert.match(proposals[0].by, /Ada/);
    assert.equal(await page.evaluate(() => window.__proofUndo.debugState().depth), undoDepthBefore + 1);
    assert.equal(proposals[0].content, proposed);
    const current = await state(page);
    assert.equal(current.pm.length, originalState.pm.length);
    assert.deepEqual(current.pm, current.yjs, 'Yjs and ProseMirror disagree');
    assert.deepEqual(current.pm, (await state(peer.page)).pm);
    for (const text of [TARGET, 'REMOTE-BEFORE', 'REMOTE-DURING']) assert.equal(current.pm.join('\n').split(text).length - 1, 1, text);
    assert.equal(current.pm.join('\n').includes(TYPED), false, 'draft was written as document text');
  });
  await check(`${tag}: one Undo removes that proposal and retains both participants' text`, async () => {
    const before = (await state(page)).pm;
    await page.evaluate(() => window.__proofUndo.undo());
    assert.equal(await page.evaluate(() => window.__proofUndo.debugState().depth), undoDepthBefore);
    assert.equal((await myProposals(page)).length, 0);
    assert.deepEqual((await state(page)).pm, before);
  });
  await check(`${tag}: Cancel discards; direct Editing has a named control and ignores letter shortcuts`, async () => {
    await open(); await page.locator('.accord-draft textarea').fill('Cancel me');
    await page.locator('[data-draft-action="cancel"]').click();
    assert.equal(await page.locator('.accord-draft').count(), 0);
    await toggleEditing(page);
    assert.equal(await modeText(page), 'Editing');
    assert.equal(await page.locator('.share-pill-suggest-toggle').getAttribute('aria-label'), 'Leave Editing');
    const passage = page.locator('.ProseMirror p').filter({ hasText: TARGET }).first();
    await passage.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await passage.click({ position: { x: 24, y: 8 } });
    const before = (await state(page)).pm.join('');
    await page.keyboard.type('asj');
    assert.equal((await state(page)).pm.join('').length, before.length + 3);
    await page.keyboard.press('Escape');
    assert.equal(await modeText(page), 'Editing');
    await toggleEditing(page);
    assert.equal(await modeText(page), 'Reading');
    assert.equal((await myProposals(page)).length, 0);
  });
  await page.screenshot({ path: path.join(shots, `draft-${tag}.png`) });
  await context.close(); await peer.context.close();
}
const browser = await chromium.launch({ headless: true });
try {
  for (const style of styles) {
    const server = await startServer(style);
    try { for (const phone of [false, true]) await run(browser, server.base, style, phone); }
    finally { await server.stop(); }
  }
} finally { await browser.close(); }
console.log(`\n${results.length - failures}/${results.length} draft checks passed`);
if (failures) process.exitCode = 1;
