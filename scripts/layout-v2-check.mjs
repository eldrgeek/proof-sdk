#!/usr/bin/env node
// Mike, 2026-09-24, yfbqrau4 / ac-2vs. Local fixtures only; reviewer runs Chromium.
// Replaces layout assertions about the retired Margin, mark circles and A/R line marks.
// Run after npm run build. Optional --style playmaker|proof and --shots directory.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
import { hoverChangesNothing, scrollAcceptsNothing, selectPassage } from './usability-s1-assertions.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const arg = name => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : null; };
const styles = arg('--style') ? [arg('--style')] : ['playmaker', 'proof'];
const shots = arg('--shots') || path.join(root, '.preview');
mkdirSync(shots, { recursive: true });
const headers = { 'Content-Type': 'application/json', 'X-Proof-Client-Version': '0.33.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
const first = 'The first proposal replaces this original wording.';
const second = 'The second proposal also keeps its original wording until accepted.';
const markdown = ['# Layout v2', first, second, 'Should we publish this version?', ...Array.from({ length: 16 }, (_, i) => `Passage ${i + 1} is here to check deliberate navigation and a stable reading view.`)].join('\n\n');
async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'accord-layout-v2-'));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    PORT: String(port), COLLAB_EMBEDDED_WS: '1', PROOF_DEFAULT_REVIEW_STYLE: style, PROOF_LIBRARY_ENABLED: '1',
    DATABASE_PATH: path.join(temp, 'test.db'), SNAPSHOT_DIR: path.join(temp, 'snapshots') };
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: root, env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
    rmSync(temp, { recursive: true, force: true });
  };
  const cli = (...args) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'server/library/cli.ts', ...args], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  for (let i = 0; i < 200; i++) {
    if ((await fetch(`${base}/health`).catch(() => null))?.ok) return { base, stop, cli };
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  await stop(); throw new Error('Local server did not start');
}
const waitReady = page => page.waitForFunction(() => window.proof?.collabIsSynced && window.__proofLineMarks?.debugState().loaded && window.__proofReadingWalk?.debugState().ready && window.__proofChat?.debugState().loaded);
const pending = page => page.evaluate(() => window.proof.getAllMarks().filter(m => ['insert', 'replace', 'delete'].includes(m.kind) && !['accepted', 'rejected'].includes(m.data?.status)).map(m => m.id));
const text = page => page.evaluate(() => window.__editorView.state.doc.textContent);
async function run(browser, server, style, width) {
  const phone = width < 700;
  const context = await browser.newContext(phone ? { ...devices['iPhone 13'], viewport: { width, height: 844 } } : { viewport: { width, height: 900 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === server.base ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const tag = `layout-v2-${style}-${width}`;
  try {
    const email = `${style}-${width}@layout.test`;
    server.cli('add-member', '--name', 'Layout Reader', '--email', email);
    await page.goto(server.cli('signin-link', '--email', email, '--origin', server.base, '--hours', '1'));
    await page.waitForURL(url => url.pathname === '/');
    const create = async title => {
      const r = await context.request.post(`${server.base}/library/api/documents`, { headers: { ...headers, Origin: server.base }, data: { title, markdown } });
      assert.ok(r.ok(), await r.text()); return r.json();
    };
    await create('Another Accord');
    const created = await create('Layout v2');
    const slug = created.slug;
    await page.goto(`${server.base}/d/${slug}`); await waitReady(page);
    const keyResponse = await context.request.post(`${server.base}/api/documents/${slug}/agent-keys`, { headers: { ...headers, Origin: server.base }, data: { label: 'layout', runtime: 'test' } });
    assert.equal(keyResponse.status(), 201, await keyResponse.text());
    const token = (await keyResponse.json()).token;
    const api = async (route, data) => {
      if (route.startsWith('/marks/suggest-')) data = { why: 'Exercise decisions in this local layout fixture.', ...data };
      const r = await context.request.post(`${server.base}/api/agent/${slug}${route}`, { headers: { ...headers, 'x-share-token': token }, data });
      assert.ok(r.ok(), await r.text()); return r.json();
    };
    await api('/marks/suggest-replace', { quote: first, content: 'The first proposal has been accepted.', by: 'ai:layout' });
    await api('/marks/suggest-replace', { quote: second, content: 'The second replacement must be rejected.', by: 'ai:layout' });
    await page.waitForFunction(() => window.proof.getAllMarks().filter(m => m.kind === 'replace' && !['accepted', 'rejected'].includes(m.data?.status)).length === 2);
    // Actual library data, shared with File > Open, including highlight, counts and links.
    if (phone) await page.locator('.prw-documents-toggle').click();
    await page.locator(`.prw-left .prw-doc[aria-current="page"][href="/d/${slug}"]`).waitFor({ state: 'visible' });
    const data = await page.evaluate(() => window.__proofReadingWalk.documentsList());
    assert.equal(await page.locator('.prw-left .prw-doc').count(), data.docs.length);
    assert.deepEqual(await page.locator('.prw-left .prw-doc-count').allTextContents(), data.docs.map(d => String(d.count)));
    assert.equal(await page.locator('.prw-all').getAttribute('href'), '/');
    assert.equal(await page.locator('.prw-left .anv-tabs, .prw-left .pch, .prw-left .plm-box').count(), 0);
    const beforeWidth = (await page.locator('#editor-container').boundingBox()).width;
    await page.locator('.prw-left .prw-collapse').click();
    if (phone) {
      assert.equal(await page.locator('.prw-left.prw-sheet-open').count(), 0);
      await page.locator('.prw-documents-toggle').click();
      assert.equal(await page.locator('.prw-left.prw-sheet-open').count(), 1);
      await page.locator('.prw-left .prw-collapse').click();
    } else {
      assert.ok((await page.locator('#editor-container').boundingBox()).width > beforeWidth + 150);
      await page.reload(); await waitReady(page);
      assert.equal(await page.evaluate(() => document.body.classList.contains('prw-left-collapsed')), true);
      await page.locator('.prw-left .prw-collapse').click();
    }
    if (phone) await page.locator('.prw-strip-review').click();
    await page.locator('.prw-right .anv-issues').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.prw-right .anv-tab').count(), 3);
    assert.equal(await page.locator('.amg-tab, .plm-box, .plm-dot, .plm-familiar-fold').count(), 0);
    assert.ok(await page.locator('.plm-open-dot[data-line="1"]').count());
    // J from the list selects the first open item; row clicks keep focus in the list.
    await page.locator('.anv-issues').focus(); await page.keyboard.press('j');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.line), '1');
    await page.locator('.anv-issue[data-line="2"]').click();
    assert.equal(await page.evaluate(() => window.__proofReadingWalk.debugState().focus), 2);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.line), '2');
    await page.keyboard.press('k');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.line), '1');
    const original = await text(page); const ids = await pending(page);
    const depth = await page.evaluate(() => window.__proofUndo.debugState().depth);
    await page.keyboard.press('a');
    await page.waitForFunction(() => window.__editorView.state.doc.textContent.includes('The first proposal has been accepted.'));
    assert.equal((await pending(page)).length, 1);
    assert.equal(await page.evaluate(() => window.__proofUndo.debugState().depth), depth + 1);
    await page.locator('.pundo-btn:visible').first().click();
    await page.waitForFunction(t => window.__editorView.state.doc.textContent === t, original);
    assert.deepEqual((await pending(page)).sort(), ids.sort());
    await page.locator('.anv-issue[data-line="2"]').click(); await page.keyboard.press('Delete');
    // A rejected replacement leaves the text, so the page no longer lists its mark; the decision
    // is recorded on the server (status rejected, never a deletion: ac-lhc).
    await page.waitForFunction(n => window.proof.getAllMarks().filter(m => ['insert', 'replace', 'delete'].includes(m.kind) && !['accepted', 'rejected'].includes(m.data?.status)).length === n, 1);
    assert.equal(await text(page), original); assert.equal((await pending(page)).length, 1);
    const decided = await context.request.get(`${server.base}/api/agent/${slug}/state`, { headers: { ...headers, 'x-share-token': token } });
    const marks = Object.values((await decided.json()).marks || {});
    assert.ok(marks.some(m => m.kind === 'replace' && m.status === 'rejected'), 'Delete did not record a rejection on the server');
    await page.keyboard.press('k'); await page.keyboard.press('Enter');
    // Step 3: Enter from the list places the caret in the selected passage.
    assert.equal(await page.evaluate(() => window.__proofReadingWalk.debugState().focus), 1);
    const pendingBeforeTyping = await pending(page); const docBeforeTyping = await text(page);
    await page.keyboard.press('End'); await page.keyboard.type('A');
    assert.notEqual(await text(page), docBeforeTyping);
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Delete');
    assert.equal(await text(page), docBeforeTyping);
    assert.deepEqual(await pending(page), pendingBeforeTyping);
    await page.keyboard.press('Escape');
    // Retired mark keys cannot mark a passage outside the list.
    await selectPassage(page, 1);
    const markStatuses = () => page.evaluate(() => window.__proofLineMarks.debugState().marks.filter(m => ['agreed', 'rejected'].includes(m.status)));
    const marksBefore = await markStatuses(); await page.keyboard.press('a'); await page.keyboard.press('r');
    assert.deepEqual(await markStatuses(), marksBefore);
    // Ask keys give a hint; its own inline answer buttons stay available.
    const me = await page.evaluate(() => window.__proofLineMarks.me());
    await api('/asks', { by: 'ai:layout', quote: 'Should we publish this version?', to: [me], recommend: 'Yes: the layout is ready.' });
    await page.waitForSelector('.plm-open-dot[data-line="3"]');
    await page.locator('.plm-open-dot[data-line="3"]').click();
    await page.keyboard.press('a');
    assert.match(await page.locator('.anv-key-hint').innerText(), /Ask: answer Yes, Not yet or No/);
    assert.deepEqual(await pending(page), pendingBeforeTyping);
    assert.equal(await page.locator('.ProseMirror .pask button[data-choice="yes"]').count() > 0, true);
    if (phone) await page.locator('.prw-right .prw-collapse').click();
    // Bundle keys use the card's atomic decision and one existing undo entry.
    await api('/marks/suggest-replace', { quote: 'Passage 1 is here', content: 'Bundle first replacement', by: 'ai:layout', bundle: { id: 'layout-pair', title: 'Two passages together' } });
    await api('/marks/suggest-replace', { quote: 'Passage 2 is here', content: 'Bundle second replacement', by: 'ai:layout', bundle: { id: 'layout-pair' } });
    await page.waitForFunction(() => window.__proofLineMarks.debugState().extras.bundles.some(b => b.id === 'layout-pair' && b.pending.length === 2 && b.acceptable));
    const bundleIds = await page.evaluate(() => window.__proofLineMarks.debugState().extras.bundles.find(b => b.id === 'layout-pair').pending);
    if (phone) await page.locator('.prw-strip-review').click();
    await page.locator('.anv-issue[data-line="4"]').click();
    const bundleText = await text(page);
    const bundleDepth = await page.evaluate(() => window.__proofUndo.debugState().depth);
    await page.keyboard.press('a');
    await page.waitForFunction(() => window.__editorView.state.doc.textContent.includes('Bundle first replacement') && window.__editorView.state.doc.textContent.includes('Bundle second replacement'));
    assert.equal(await page.evaluate(() => window.__proofUndo.debugState().depth), bundleDepth + 1);
    await page.locator('.pundo-btn:visible').first().click();
    await page.waitForFunction(t => window.__editorView.state.doc.textContent === t, bundleText);
    // KNOWN GAP (filed as its own bead): undoing a bundle accept restores the text, but the bundle
    // stays closed, so the undone bundle is not decided again here. Reject uses a second bundle.
    await api('/marks/suggest-replace', { quote: 'Passage 3 is here', content: 'Second bundle first replacement', by: 'ai:layout', bundle: { id: 'layout-pair-b', title: 'Two more passages' } });
    await api('/marks/suggest-replace', { quote: 'Passage 4 is here', content: 'Second bundle second replacement', by: 'ai:layout', bundle: { id: 'layout-pair-b' } });
    await page.waitForFunction(() => window.__proofLineMarks.debugState().extras.bundles.some(b => b.id === 'layout-pair-b' && b.pending.length === 2 && b.acceptable));
    const bundleBIds = await page.evaluate(() => window.__proofLineMarks.debugState().extras.bundles.find(b => b.id === 'layout-pair-b').pending);
    const bundleBText = await text(page);
    await page.locator('.anv-issue[data-line="6"]').click(); await page.keyboard.press('Backspace');
    // Rejected members leave the page's mark list; the server records the decision (ac-lhc).
    await page.waitForFunction(ids => ids.every(id => !window.proof.getAllMarks().some(m => m.id === id && !['accepted', 'rejected'].includes(m.data?.status))), bundleBIds);
    const bundleState = await context.request.get(`${server.base}/api/agent/${slug}/state`, { headers: { ...headers, 'x-share-token': token } });
    const bundleMarks = (await bundleState.json()).marks || {};
    assert.ok(bundleBIds.every(id => bundleMarks[id]?.status === 'rejected'), 'Backspace did not record the bundle members as rejected on the server');
    assert.equal(await text(page), bundleBText);
    // Retained tabs live on the right. Only explicit disclosure folds the document.
    await page.locator('.prw-right .anv-tab[data-tab="outline"]').click();
    assert.equal(await page.locator('.prw-right .anv-outline').isVisible(), true);
    await page.locator('.prw-right .anv-tab[data-tab="since"]').click();
    assert.equal(await page.locator('.prw-right .anv-pane[data-tab="since"]').isVisible(), true);
    await page.locator('.prw-right .anv-tab[data-tab="issues"]').click();
    if (phone) await page.locator('.prw-right .prw-collapse').click();
    // One composer at the bottom, one latest message, explicit upward expansion.
    const composer = page.locator('.prw-chat-bottom .pch-input');
    await composer.fill(`Earlier message ${tag}`); await composer.press('Enter');
    await page.locator('.prw-chat-bottom .pch-msg', { hasText: `Earlier message ${tag}` }).waitFor();
    await composer.fill(`Latest message ${tag}`); await composer.press('Enter');
    await page.locator('.prw-chat-bottom .pch-msg', { hasText: `Latest message ${tag}` }).waitFor();
    assert.equal(await page.locator('.prw-chat-bottom .pch-msg').count(), 1);
    const compact = await page.locator('.prw-chat-bottom').boundingBox();
    assert.ok(Math.abs(compact.y + compact.height - page.viewportSize().height) < 3);
    await page.locator('.prw-chat-bottom .pch-toggle').click();
    const expanded = await page.locator('.prw-chat-bottom').boundingBox();
    assert.ok(await page.locator('.prw-chat-bottom .pch-msg').count() >= 2);
    assert.ok(expanded.y < compact.y - 100); assert.equal(await composer.isVisible(), true);
    await page.locator('.prw-chat-bottom .pch-toggle').click();
    assert.equal(await composer.isVisible(), true);
    if (!phone) { await selectPassage(page, 1); await hoverChangesNothing(page, 2); }
    await scrollAcceptsNothing(page);
    await page.screenshot({ path: path.join(shots, `${tag}.png`), fullPage: false });
    console.log(`PASS ${tag}`);
  } catch (error) {
    await page.screenshot({ path: path.join(shots, `${tag}-FAIL.png`) }).catch(() => {});
    throw error;
  } finally { await context.close(); }
}
const browser = await chromium.launch();
try {
  for (const style of styles) {
    const server = await startServer(style);
    try { for (const width of [1280, 1440, 390]) await run(browser, server, style, width); }
    finally { await server.stop(); }
  }
} finally { await browser.close(); }
