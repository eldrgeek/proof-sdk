#!/usr/bin/env node
import { showWholeAccord } from './review-ui.mjs';
// ac-yoc: local server and two readers. Desktop first, then phone, in both review styles.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, openSync, closeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
const root = fileURLToPath(new URL('../', import.meta.url));
const arg = key => { const i = process.argv.indexOf(key); return i > 0 ? process.argv[i + 1] : null; };
const styles = arg('--style') ? [arg('--style')] : ['playmaker', 'proof'];
const widths = arg('--width') ? [Number(arg('--width'))] : [1440, 390];
const shots = arg('--shots') || path.join(root, '.preview'); mkdirSync(shots, { recursive: true });
const headers = { 'Content-Type': 'application/json', 'X-Proof-Client-Version': '0.33.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
const markdown = '# Typed discussions\n\nAgreed words stay here.\n\nOriginal replacement words.\n\nShared line: left | right.\n\nLast paragraph stays once.';
async function start(style) {
  const socket = createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  const temp = mkdtempSync(path.join(tmpdir(), 'accord-click-edit-'));
  const log = path.join(temp, 'server.log'); const fd = openSync(log, 'w');
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      PORT: String(port), DATABASE_PATH: path.join(temp, 'test.db'), SNAPSHOT_DIR: path.join(temp, 'snapshots'),
      COLLAB_EMBEDDED_WS: '1', PROOF_DEFAULT_REVIEW_STYLE: style }, stdio: ['ignore', fd, fd] });
  closeSync(fd); const base = `http://127.0.0.1:${port}`;
  const stop = async () => { child.kill('SIGTERM'); if (child.exitCode === null && child.signalCode === null) await new Promise(r => child.once('exit', r)); rmSync(temp, { recursive: true, force: true }); };
  for (let i = 0; i < 200; i++) {
    if ((await fetch(`${base}/health`).catch(() => null))?.ok) return { base, stop, log };
    await new Promise(r => setTimeout(r, 150));
  }
  await stop(); throw Error('Local server failed to start');
}
async function request(base, route, body, token) {
  const r = await fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(token ? { 'x-share-token': token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(r.ok, `${route}: ${r.status} ${r.ok ? '' : await r.text()}`); return r.json();
}
async function reader(browser, base, slug, name, width) {
  const context = await browser.newContext(width < 700 ? { ...devices['iPhone 13'], viewport: { width, height: 844 } } : { viewport: { width, height: 900 } });
  await context.addInitScript(name => { localStorage.setItem('proof-share-viewer-name', name); }, name);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/d/${slug}`);
  // Existing name prompt varies with first-visit state. Give this context its own identity.
  const prompt = page.getByRole('button', { name: /Continue anonymously/i });
  if (await prompt.isVisible().catch(() => false)) await prompt.click();
  await page.waitForFunction(() => window.proof?.collabIsSynced && window.__proofReadingWalk?.debugState().ready && window.__proofLineMarks?.debugState().loaded);
  const welcome = page.locator('.proof-share-welcome-toast button');
  if (await welcome.count()) await welcome.first().click();
  await showWholeAccord(page);
  return { context, page, errors };
}
const pending = page => page.evaluate(() => window.proof.getAllMarks().filter(m => ['insert', 'delete', 'replace'].includes(m.kind) && (m.data?.status ?? 'pending') === 'pending'));
const text = page => page.evaluate(() => window.__editorView.state.doc.textContent);
async function selectText(page, quote) {
  await page.evaluate(quote => {
    const view = window.__editorView; let from;
    view.state.doc.descendants((node, pos) => { if (from === undefined && node.isText && node.text.includes(quote)) from = pos + node.text.indexOf(quote); });
    if (from === undefined) throw Error(`Missing text ${quote}`);
    const Selection = view.state.selection.constructor;
    view.dispatch(view.state.tr.setSelection(Selection.create(view.state.doc, from, from + quote.length)));
    view.focus();
  }, quote);
}
async function clickAt(page, quote, after = true) {
  const point = await page.evaluate(({ quote, after }) => {
    const view = window.__editorView; let pos;
    view.state.doc.descendants((node, start) => { if (pos === undefined && node.isText && node.text.includes(quote)) pos = start + node.text.indexOf(quote) + (after ? quote.length : 0); });
    if (pos === undefined) throw Error(`Missing click target ${quote}`);
    const node = view.domAtPos(pos).node; (node.nodeType === 1 ? node : node.parentElement).scrollIntoView({ block: 'center' });
    return { pos };
  }, { quote, after });
  // Wait until the scroll has settled (the page may scroll smoothly), then read the position.
  const at = await page.evaluate(async pos => {
    const view = window.__editorView; let last = null;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => requestAnimationFrame(r));
      const r = view.coordsAtPos(pos); const now = `${Math.round(r.left)},${Math.round(r.top)}`;
      if (now === last) return { x: r.left, y: (r.top + r.bottom) / 2 };
      last = now;
    }
    const r = view.coordsAtPos(pos); return { x: r.left, y: (r.top + r.bottom) / 2 };
  }, point.pos);
  // Rapid clicks at one spot count as a double or triple click, which selects a word or the
  // paragraph. A person placing the caret clicks once; space the check's clicks the same way.
  const since = Date.now() - (clickAt.last ?? 0);
  if (since < 700) await page.waitForTimeout(700 - since);
  await page.mouse.click(at.x, at.y);
  clickAt.last = Date.now();
  await poll(async () => { const s = await page.evaluate(() => { const sel = window.__editorView.state.selection; return [sel.anchor, sel.head]; }); return s[0] === point.pos && s[1] === point.pos; }, 'Click did not place a caret', 2000);
}
async function poll(fn, message, timeout = 5000) {
  const end = Date.now() + timeout;
  do { if (await fn()) return; await new Promise(r => setTimeout(r, 50)); } while (Date.now() < end);
  assert.fail(message);
}
const threads = page => page.evaluate(() => window.__proofLineMarks.allThreads().filter(v => v.thread.id.startsWith('typed-discussion:')).map(v => ({ id: v.thread.id, text: v.thread.text, waitingOn: v.thread.waitingOn, status: v.thread.status, replies: v.thread.replies, line: v.lineIndex })));
const scrollState = page => page.evaluate(() => [window.scrollY, ...[...document.querySelectorAll('.ProseMirror')].flatMap(el => { const out = []; for (let p = el; p; p = p.parentElement) out.push(p.scrollTop); return out; })]);
async function run(browser, server, style, width) {
  const created = await request(server.base, '/documents', { title: 'Typed discussions', markdown, role: 'editor' });
  const slug = created.slug, token = created.ownerSecret;
  const a = await reader(browser, server.base, slug, 'Alice', width), b = await reader(browser, server.base, slug, 'Bob', width);
  const tag = `discussions-${style}-${width}`;
  const api = (route, body) => request(server.base, `/api/agent/${slug}${route}`, body, token);
  const baseText = await text(a.page);
  const stored = async () => { const s = await api('/state'); return Array.isArray(s.marks) ? s.marks : Object.entries(s.marks ?? {}).map(([id, mark]) => ({ id, ...mark })); };
  const discussion = async (words, ending) => {
    await clickAt(a.page, 'Agreed words stay here.');
    await a.page.keyboard.type(words, { delay: 30 });
    const run = (await pending(a.page)).find(m => m.data.content === words); assert(run, 'Typing must remain one live insert');
    await poll(async () => (await pending(b.page)).some(m => m.id === run.id), 'Second reader never saw the live proposal');
    assert.equal((await threads(a.page)).some(t => t.text === words.trim()), false, 'Converted before the run ended');
    await a.page.locator('.accord-typed-discussion-hint').waitFor({ state: 'visible' });
    const before = await scrollState(a.page);
    if (ending === 'click') await clickAt(a.page, 'Original replacement words.');
    else await a.page.keyboard.press(ending);
    await poll(async () => (await threads(a.page)).some(t => t.text === words.trim()), 'No typed discussion');
    const thread = (await threads(a.page)).find(t => t.text === words.trim());
    await poll(async () => !(await pending(b.page)).some(m => m.id === run.id), 'Leftover pending proposal on second reader');
    await poll(async () => (await stored()).some(m => m.id === run.id && m.status === 'rejected' && m.resolvedBy === 'human:Alice'), 'Withdrawal decision was not stored');
    assert.equal(await text(a.page), baseText, 'Enter split or changed the item');
    if (ending !== 'click') assert.deepEqual(await scrollState(a.page), before, 'Conversion scrolled the page');
    await poll(async () => b.page.evaluate(id => window.__proofLineMarks.openThreadsFor().some(t => t.id === id && t.why === 'answer-this'), thread.id), 'Other reader Review does not need the discussion');
    await poll(async () => b.page.evaluate(line => window.__proofLineMarks.reviewViews()['needs-you'].lines.includes(line), thread.line), 'Discussion is missing from the second reader Review list');
    return thread;
  };
  try {
    const enter = await discussion(' What is your reasoning?', 'Enter');
    await a.page.screenshot({ path: path.join(shots, `${tag}-sent.png`), fullPage: true });
    await a.page.keyboard.press('ControlOrMeta+z');
    await poll(async () => (await pending(a.page)).some(m => m.data.content === ' What is your reasoning?'), 'Undo did not restore a live proposal');
    await poll(async () => !(await threads(b.page)).some(t => t.id === enter.id), 'Undo left the thread behind');
    await a.page.keyboard.press('ControlOrMeta+z');
    await poll(async () => (await text(a.page)) === baseText, 'Second Undo did not undo the typing run');

    if (width >= 700) {
      const menuThread = await discussion(' Could the menu undo this?', 'Enter');
      await a.page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
      await a.page.getByRole('menuitem', { name: /^Undo asked a discussion/ }).click();
      await poll(async () => (await pending(a.page)).some(m => m.data.content === ' Could the menu undo this?'), 'Edit menu Undo did not restore the proposal');
      await poll(async () => !(await threads(b.page)).some(t => t.id === menuThread.id), 'Edit menu Undo left a thread');
      await selectText(a.page, ' Could the menu undo this?'); await a.page.keyboard.press('Backspace');
    }

    const escaped = await discussion(' Could you explain?', 'Escape');
    // The card's control in the same visit, after a later edit has buried the conversion's own Undo
    // step, so the words are put back the way typing puts them in.
    await clickAt(a.page, 'Last paragraph stays once.');
    await a.page.keyboard.type(' later', { delay: 30 });
    await a.page.keyboard.press('Escape');
    await a.page.evaluate(line => window.__proofReadingWalk.openReviewItem(line), escaped.line);
    const back = a.page.locator(`.amg-thread[data-thread="${escaped.id}"] .amg-thread-turn-back`);
    await back.click();
    await poll(async () => (await pending(a.page)).some(m => m.data.content === ' Could you explain?'), 'Turn back did not restore the text');
    await poll(async () => !(await threads(b.page)).some(t => t.id === escaped.id), 'Turn back left the thread behind');
    for (const words of [' Could you explain?', ' later']) { await selectText(a.page, words); await a.page.keyboard.press('Backspace'); }
    await poll(async () => (await text(a.page)) === baseText, 'Restored text did not withdraw');
    // Typing must not leave one completed Review row per keystroke (it left 690 before the
    // review-list fix, 2026-09-25, and the pages spun redrawing them).
    for (const [who, page] of [['first', a.page], ['second', b.page]]) {
      const rows = await page.locator('.anv-issue').count();
      assert.ok(rows <= 12, `the ${who} reader's Review list holds ${rows} rows after typing`);
    }

    // After a reload the visit's history is gone, and so is the control
    // (TYPED_DISCUSSION_POLICY.turnBackAfterReload, bead ac-m23): the discussion stays a discussion.
    const reloaded = await discussion(' And after a reload?', 'Escape');
    await a.page.reload();
    await a.page.waitForFunction(() => window.proof?.collabIsSynced && window.__proofLineMarks?.debugState().loaded);
    await showWholeAccord(a.page);
    await a.page.evaluate(line => window.__proofReadingWalk.openReviewItem(line), reloaded.line);
    await a.page.locator(`.amg-thread[data-thread="${reloaded.id}"]`).waitFor();
    assert.equal(await a.page.locator(`.amg-thread[data-thread="${reloaded.id}"] .amg-thread-turn-back`).count(), 0, 'Turn back offered after a reload');
    assert.ok((await threads(b.page)).some(t => t.id === reloaded.id), 'The discussion did not survive the reload');

    const clicked = await discussion(' What about this?', 'click');
    await b.page.evaluate(({ id }) => window.__proofLineMarks.replyOnThread(id, 'Here is my reasoning.'), clicked);
    await poll(async () => (await threads(a.page)).some(t => t.id === clicked.id && t.replies.length), 'Reply did not arrive');
    await a.page.evaluate(line => window.__proofReadingWalk.openReviewItem(line), clicked.line);
    assert.equal(await a.page.locator(`.amg-thread[data-thread="${clicked.id}"] .amg-thread-turn-back`).count(), 0, 'Turn back must disappear after reply');
    assert.equal(await a.page.evaluate(id => window.__proofLineMarks.canTurnThreadBack(id), clicked.id), false);

    await clickAt(a.page, 'Original replacement words.');
    await a.page.keyboard.type(' Just an edit.', { delay: 30 }); await a.page.keyboard.press('Escape');
    assert((await pending(a.page)).some(m => m.data.content === ' Just an edit.'), 'Ordinary typing stopped being a live proposal');
    await selectText(a.page, ' Just an edit.'); await a.page.keyboard.press('Backspace');

    await clickAt(a.page, 'Agreed words stay here.');
    await a.page.keyboard.type(' @Bob please look', { delay: 30 }); await a.page.keyboard.press('Enter');
    await poll(async () => (await threads(a.page)).some(t => t.text === '@Bob please look'), 'Known mention did not become a discussion');
    const mentioned = (await threads(a.page)).find(t => t.text === '@Bob please look');
    assert.equal(mentioned.waitingOn.length, 1); assert.match(mentioned.waitingOn[0], /bob/i);
    await a.page.screenshot({ path: path.join(shots, `${tag}-mention.png`), fullPage: true });

    await clickAt(a.page, 'Last paragraph stays once.');
    await a.page.keyboard.type(' Shift stays?', { delay: 30 }); await a.page.keyboard.press('Shift+Enter');
    assert((await pending(a.page)).some(m => m.data.content.includes('Shift stays?')), 'Shift+Enter sent a discussion');
    assert.equal((await threads(a.page)).some(t => t.text === 'Shift stays?'), false);
    const state = await api('/state');
    const pageOpen = await a.page.evaluate(() => window.__proofLineMarks.reviewViews()['all-open'].count);
    await poll(async () => (await api('/state')).alignment.counts.total === pageOpen, 'Server alignment disagrees with the page');
    assert.equal(state.alignment.aligned, false);
    const events = (await api('/events/pending?after=0&limit=1000')).events ?? [];
    assert.equal(events.some(e => ['suggestion.deletion_restored', 'collab.reload_required'].includes(e.type)), false);
    assert.deepEqual(a.errors, []); assert.deepEqual(b.errors, []);
    console.log(`PASS ${tag}`);
  } catch (error) {
    await a.page.screenshot({ path: path.join(shots, `${tag}-FAIL.png`), fullPage: true }).catch(() => {});
    throw error;
  } finally { await a.context.close(); await b.context.close(); }
}
const browser = await chromium.launch({ headless: true });
try {
  // All desktop configurations pass before any phone configuration starts.
  for (const width of widths) for (const style of styles) {
    const server = await start(style);
    try { await run(browser, server, style, width); } finally { await server.stop(); }
  }
} finally { await browser.close(); }
