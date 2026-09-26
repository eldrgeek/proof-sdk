#!/usr/bin/env node
import { showWholeAccord } from './review-ui.mjs';
// ac-8ae. Mike, 2026-09-24, yfbqrau4 P2/P3. Local server, two independent readers.
// Reviewer gate: run five times, then local-write-resync, caret-stability and marks-restart.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, openSync, closeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
import { hoverChangesNothing, scrollAcceptsNothing } from './usability-s1-assertions.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const arg = key => { const i = process.argv.indexOf(key); return i > 0 ? process.argv[i + 1] : null; };
const styles = arg('--style') ? [arg('--style')] : ['playmaker', 'proof'];
const widths = arg('--width') ? [Number(arg('--width'))] : [1440, 390];
const shots = arg('--shots') || path.join(root, '.preview'); mkdirSync(shots, { recursive: true });
const headers = { 'Content-Type': 'application/json', 'X-Proof-Client-Version': '0.34.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
const markdown = '# Click editing\n\nAgreed words stay here.\n\nOriginal replacement words.\n\nShared line: left | right.\n\nLast paragraph stays once.';
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
  // The caret must sit at the quoted words in the CURRENT text: a withdrawal or another writer's
  // edit that lands after the click shifts later positions (the same fix as discussions-check).
  await poll(() => page.evaluate(({ quote, after }) => {
    const view = window.__editorView; let pos;
    view.state.doc.descendants((node, start) => { if (pos === undefined && node.isText && node.text.includes(quote)) pos = start + node.text.indexOf(quote) + (after ? quote.length : 0); });
    const sel = view.state.selection; return pos !== undefined && sel.anchor === pos && sel.head === pos;
  }, { quote, after }), 'Click did not place a caret', 2000);
}
async function poll(fn, message, timeout = 5000) {
  const end = Date.now() + timeout;
  do { if (await fn()) return; await new Promise(r => setTimeout(r, 50)); } while (Date.now() < end);
  assert.fail(message);
}
async function run(browser, server, style, width) {
  const created = await request(server.base, '/documents', { title: 'Click editing', markdown, role: 'editor' });
  const slug = created.slug, token = created.ownerSecret;
  const a = await reader(browser, server.base, slug, 'Alice', width), b = await reader(browser, server.base, slug, 'Bob', width);
  const tag = `click-edit-${style}-${width}`;
  const api = (route, body) => request(server.base, `/api/agent/${slug}${route}`, body, token);
  const stored = async () => { const state = await api('/state'); return Array.isArray(state.marks) ? state.marks : Object.entries(state.marks ?? {}).map(([id, mark]) => ({ id, ...mark })); };
  const decision = async (id, actor) => poll(async () => (await stored()).some(m => m.id === id && m.status === 'rejected' && m.resolvedBy === actor), `No rejected record for ${id}`);
  try {
    assert.equal(await a.page.evaluate(() => window.proof.isSuggestionsEnabled()), true);
    await clickAt(a.page, 'Agreed words stay here.');
    await poll(async () => a.page.evaluate(() => {
      const lm = window.__proofLineMarks;
      return window.__proofReadingWalk.focusIndex() === lm.lineAtPos(window.__editorView.state.selection.head);
    }), 'Click did not select the caret passage');
    const beforeTypingY = await a.page.evaluate(() => scrollY);
    await a.page.keyboard.type(' live', { delay: 50 });
    assert.ok(Math.abs(await a.page.evaluate(() => scrollY) - beforeTypingY) <= 2, 'Typing moved the view');
    const focusBeforeScroll = await a.page.evaluate(() => window.__proofReadingWalk.focusIndex());
    await a.page.evaluate(() => scrollBy(0, 80));
    const scrolledY = await a.page.evaluate(() => scrollY);
    await a.page.waitForTimeout(200);
    assert.equal(await a.page.evaluate(() => window.__proofReadingWalk.focusIndex()), focusBeforeScroll, 'Scrolling while writing moved the passage');
    assert.equal(await a.page.evaluate(() => scrollY), scrolledY, 'Scrolling while writing snapped back');
    await poll(async () => (await pending(b.page)).some(m => m.by === 'human:Alice' && m.data.content === ' live'), 'Typing did not reach Bob in two seconds', 2000);
    assert.equal(await a.page.locator('.accord-draft').count(), 0);
    assert.equal(await a.page.locator('.pst-mode').textContent(), 'Writing');
    // Actual Delete must edit text, leaving the independent proposal below pending.
    await selectText(a.page, 'words'); await a.page.keyboard.press('Delete');
    const deletion = (await pending(a.page)).find(m => m.kind === 'delete'); assert.ok(deletion);
    assert.equal(await a.page.locator(`.mark-delete[data-mark-id="${deletion.id}"]`).first().textContent(), 'words');
    await selectText(a.page, 'Original replacement words.'); await a.page.keyboard.type('Changed', { delay: 60 });
    const replacement = (await pending(a.page)).find(m => m.kind === 'replace'); assert.ok(replacement);
    assert.equal(replacement.data.content, 'Changed', 'Replacement typing split or lost characters');
    assert.equal((await pending(a.page)).filter(m => m.kind === 'replace').length, 1);
    await poll(async () => (await pending(b.page)).some(m => m.id === replacement.id && m.data.content === 'Changed'), 'Replacement failed to reach Bob');
    const widget = b.page.locator(`[data-live-suggestion][data-mark-id="${replacement.id}"]`);
    await widget.focus(); await b.page.keyboard.press('ControlOrMeta+A'); await b.page.keyboard.press('Backspace');
    await decision(replacement.id, 'human:Bob');
    assert.ok((await text(b.page)).includes('Original replacement words.'));
    await b.page.keyboard.press('ControlOrMeta+z');
    await poll(async () => (await pending(b.page)).some(m => m.id === replacement.id), 'Undo did not restore replacement');
    // Complete deletion of another person's inserted text uses that same path.
    await selectText(b.page, ' live'); const insert = (await pending(b.page)).find(m => m.data?.content === ' live');
    await b.page.keyboard.press('Backspace'); await decision(insert.id, 'human:Bob');
    await b.page.keyboard.press('ControlOrMeta+z');
    await poll(async () => (await text(b.page)).includes(' live'), 'Undo did not restore insert');
    // Alice acts next. Bob's Undo reaches her page a few milliseconds after his own page shows it, and
    // a click aimed before it arrives lands five characters early (ac-1oj, measured 2026-09-26).
    await poll(async () => await text(a.page) === await text(b.page), "Bob's Undo did not reach Alice");
    const withdrawn = [];
    for (let i = 0; i < 5; i++) {
      await clickAt(a.page, 'Last paragraph stays once.');
      await a.page.keyboard.type(`withdraw${i}`, { delay: 20 });
      const mark = (await pending(a.page)).find(m => m.data?.content === `withdraw${i}`); assert.ok(mark);
      withdrawn.push(mark.id);
      for (let j = 0; j < 9; j++) await a.page.keyboard.press('Backspace');
      await decision(mark.id, 'human:Alice');
    }
    await clickAt(a.page, 'Last paragraph stays once.');
    const beforeLetter = await text(a.page), beforeIds = (await pending(a.page)).map(m => m.id).sort();
    await a.page.keyboard.press('A'); assert.equal(await text(a.page), beforeLetter.replace('Last paragraph stays once.', 'Last paragraph stays once.A'));
    const selNow = () => a.page.evaluate(() => { const s = window.__editorView.state.selection; return [s.anchor, s.head, String(document.activeElement?.className).slice(0, 30)]; });
    const headBeforeArrow = (await selNow())[1];
    await a.page.keyboard.press('ArrowLeft');
    // ProseMirror reads the browser's moved caret on its selectionchange event; wait for it.
    await poll(async () => (await selNow())[1] === headBeforeArrow - 1, 'ArrowLeft did not move the caret', 2000);
    await a.page.keyboard.press('Delete');
    assert.equal(await text(a.page), beforeLetter);
    assert.deepEqual((await pending(a.page)).map(m => m.id).sort(), beforeIds, 'Letter/Delete decided another proposal');
    await a.page.keyboard.press('Escape'); assert.equal(await a.page.locator('.pst-mode').textContent(), 'Reading');
    assert.equal(await a.page.locator('.pst-bar').textContent().then(t => /No marks from you|You marked up to/.test(t)), false);
    // Leaving the text brings the phone strip back on its own schedule; measure hover after that.
    await a.page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 250)))));
    await hoverChangesNothing(a.page, 1); await scrollAcceptsNothing(a.page);
    // Both people type for ten seconds on the same line. Unique characters expose lost or
    // duplicated keystrokes even when the two runs interleave in CRDT order.
    await clickAt(a.page, 'left'); await clickAt(b.page, 'right');
    const typeRun = async (page, start) => {
      const chars = Array.from({ length: 50 }, (_, i) => String.fromCodePoint(start + i));
      for (const char of chars) { await page.keyboard.insertText(char); await page.waitForTimeout(200); }
      return chars;
    };
    const [aliceChars, bobChars] = await Promise.all([typeRun(a.page, 0x410), typeRun(b.page, 0x510)]);
    await poll(async () => await text(a.page) === await text(b.page), 'Peers did not converge');
    const final = await text(a.page);
    for (const char of [...aliceChars, ...bobChars]) assert.equal(final.split(char).length - 1, 1, `Lost or duplicated ${char}`);
    for (const peer of [a, b]) {
      const agrees = await peer.page.evaluate(() => {
        const view = window.__editorView; const sync = view.state.plugins.find(p => p.key === 'y-sync$')?.getState(view.state);
        const children = sync.type.toArray(); return children.length === view.state.doc.childCount && children.every((child, i) => sync.binding.mapping.get(child) === view.state.doc.child(i));
      }); assert.equal(agrees, true, 'Yjs fragment and PM document differ');
      assert.equal(await peer.page.locator('.ProseMirror').getAttribute('contenteditable'), 'true');
      assert.deepEqual(peer.errors, []);
    }
    const events = (await api('/events/pending?after=0&limit=1000')).events ?? [];
    assert.equal(events.some(e => ['suggestion.deletion_restored', 'collab.reload_required'].includes(e.type)), false);
    for (const id of [insert.id, replacement.id]) {
      assert.ok(events.some(e => e.type === 'suggestion.rejected' && e.data?.markId === id && e.data.resolvedBy === 'human:Bob'), `Missing delete-to-reject event ${id}`);
      assert.ok(events.some(e => e.type === 'suggestion.reopened' && e.data?.markId === id), `Missing Undo reopen event ${id}`);
    }
    for (const id of withdrawn) assert.ok(events.some(e => e.type === 'suggestion.rejected' && e.data?.markId === id && e.data.by === 'human:Alice' && e.data.resolvedBy === 'human:Alice'), `Missing author-withdrawal decision event ${id}`);
    assert.equal(/reload required after repeated suggestion deletion/.test(readFileSync(server.log, 'utf8')), false);
    await a.page.screenshot({ path: path.join(shots, `${tag}.png`), fullPage: true });
    console.log(`PASS ${tag}: typing, replacement, deletion, five withdrawals, decisions/Undo, keys, ten-second concurrent typing`);
  } catch (error) {
    await a.page.screenshot({ path: path.join(shots, `${tag}-FAIL.png`), fullPage: true }).catch(() => {}); throw error;
  } finally { await a.context.close(); await b.context.close(); }
}
const browser = await chromium.launch();
try {
  for (const style of styles) {
    const server = await start(style);
    try { for (const width of widths) await run(browser, server, style, width); } finally { await server.stop(); }
  }
} finally { await browser.close(); }
