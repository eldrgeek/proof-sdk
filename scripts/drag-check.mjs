#!/usr/bin/env node
import { showWholeAccord } from './review-ui.mjs';
// ac-l71. Local-only desktop drag checks; reviewer runs Chromium outside the worker sandbox.
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
const headers = { 'Content-Type': 'application/json', 'X-Proof-Client-Version': '0.34.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
async function start(style) {
  const socket = createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  const temp = mkdtempSync(path.join(tmpdir(), 'accord-drag-'));
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
const markdown = '# Moving items\n\nAlpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.\n\n### First task\n\nFirst task body.\n\n### Second task\n\nSecond task body.\n\n### Last task\n\nLast task body.';
async function focus(page, text) {
  await page.evaluate(text => {
    const line = window.__proofLineMarks.lineList().find(l => l.text === text);
    if (!line) throw Error(`No line ${text}`);
    window.__proofReadingWalk.focusLine(line.index);
    document.activeElement?.blur();
  }, text);
}
async function drag(page, source, target, side = 'after') {
  const a = await source.boundingBox(), b = await target.boundingBox();
  assert.ok(a && b, 'Drag endpoints must be visible');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, side === 'before' ? b.y + 1 : b.y + b.height - 1, { steps: 18 });
  await page.locator('.accord-drop-line').waitFor({ state: 'visible' });
  await page.mouse.up();
}
const blocks = page => page.evaluate(() => {
  const out = []; window.__editorView.state.doc.forEach(n => out.push(n.textContent)); return out;
});
async function waitOrder(page, expected) {
  await page.waitForFunction(expected => {
    const out = []; window.__editorView.state.doc.forEach(n => out.push(n.textContent)); return JSON.stringify(out) === JSON.stringify(expected);
  }, expected);
}
async function pendingMove(page) {
  await page.waitForFunction(() => window.__proofLineMarks.bundleList().some(b => b.bundle.kind === 'move' && b.status === 'open'));
  return page.evaluate(() => window.__proofLineMarks.bundleList().find(b => b.bundle.kind === 'move' && b.status === 'open').bundle.id);
}
async function decide(page, id, action, sourceText) {
  await focus(page, sourceText);
  const card = page.locator(`[data-bundle-id="${id}"]`);
  await card.waitFor({ state: 'visible' });
  assert.equal(await card.count(), 1, 'one move card');
  assert.match(await card.innerText(), /Moves .* to (before|after)/);
  const scrollBefore = await page.evaluate(() => scrollY);
  await card.getByRole('button', { name: `${action} move`, exact: true }).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.ok(Math.abs(await page.evaluate(() => scrollY) - scrollBefore) < 3, `${action} jumped the page`);
}
async function undo(page) {
  await page.locator('.amb-top[data-menu="edit"]').click();
  await page.locator('.amb-menu [data-item="edit-undo"]').click();
}
async function run(browser, server, style, width) {
  const created = await request(server.base, '/documents', { title: 'Dragging', markdown, role: 'editor' });
  const api = (route, body) => request(server.base, `/api/agent/${created.slug}${route}`, body, created.ownerSecret);
  const a = await reader(browser, server.base, created.slug, 'Alice', width);
  const b = await reader(browser, server.base, created.slug, 'Bob', width);
  const tag = `drag-${style}-${width}`;
  try {
    const initial = await blocks(a.page);
    await focus(a.page, 'Alpha paragraph.');
    if (width < 701) {
      assert.equal(await a.page.locator('.accord-move-handle:visible').count(), 0);
      assert.deepEqual(await blocks(a.page), initial);
      assert.equal(await a.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await a.page.screenshot({ path: path.join(shots, `${tag}.png`), fullPage: true });
      assert.deepEqual(a.errors, []); console.log(`PASS ${tag}: phone has no handles or overflow`); return;
    }
    const beforeScroll = await a.page.evaluate(() => scrollY);
    await drag(a.page, a.page.locator('.plm-gutter .accord-move-handle'), a.page.locator('.ProseMirror p').filter({ hasText: /^Gamma paragraph\.$/ }));
    const id = await pendingMove(b.page);
    assert.deepEqual(await blocks(b.page), initial, 'proposal preserves one copy at original location');
    assert.ok(Math.abs(await a.page.evaluate(() => scrollY) - beforeScroll) < 3, 'proposal jumped the page');
    await decide(b.page, id, 'Accept', 'Alpha paragraph.');
    const moved = [...initial]; moved.splice(1, 1); moved.splice(3, 0, initial[1]);
    await waitOrder(a.page, moved); await waitOrder(b.page, moved);
    await b.page.screenshot({ path: path.join(shots, `${tag}-accepted.png`), fullPage: true });
    await undo(b.page); await waitOrder(a.page, initial);
    await decide(b.page, id, 'Reject', 'Alpha paragraph.');
    await waitOrder(a.page, initial);

    // A folded heading moves its body as one unit.
    await a.page.evaluate(() => { const l = window.__proofLineMarks.lineList().find(l => l.text === 'First task'); window.__proofFolding.setFolded(l.index, true); });
    await drag(a.page, a.page.locator('.pfold-chip[data-folded="true"] .accord-move-handle').first(), a.page.locator('.ProseMirror h3').filter({ hasText: /^Last task$/ }), 'before');
    const folded = await pendingMove(b.page);
    await decide(b.page, folded, 'Accept', 'First task');
    const sectionOrder = [initial[0], initial[1], initial[2], initial[3], initial[6], initial[7], initial[4], initial[5], initial[8], initial[9]];
    await waitOrder(a.page, sectionOrder); await undo(b.page); await waitOrder(a.page, initial);
    await decide(b.page, folded, 'Reject', 'First task'); await showWholeAccord(a.page);

    // Review list rows remain document-ordered and move whole heading sections.
    await api('/marks/suggest-replace', { by: 'ai:reviewer', quote: 'First task', content: 'First task revised' });
    await api('/marks/suggest-replace', { by: 'ai:reviewer', quote: 'Second task', content: 'Second task revised' });
    const firstRow = a.page.locator('.anv-issue').filter({ hasText: 'First task' }).first();
    const secondRow = a.page.locator('.anv-issue').filter({ hasText: 'Second task' }).first();
    await firstRow.waitFor(); await secondRow.waitFor();
    await drag(a.page, firstRow, secondRow);
    const review = await pendingMove(b.page);
    await decide(b.page, review, 'Accept', 'First task');
    await waitOrder(a.page, sectionOrder); await undo(b.page); await waitOrder(a.page, initial);
    await decide(b.page, review, 'Reject', 'First task');

    await focus(a.page, 'Alpha paragraph.'); await a.page.keyboard.press('Alt+Shift+ArrowDown');
    const key = await pendingMove(b.page); await decide(b.page, key, 'Accept', 'Alpha paragraph.');
    await waitOrder(a.page, [initial[0], initial[2], initial[1], ...initial.slice(3)]);
    await undo(b.page); await waitOrder(a.page, initial); await decide(b.page, key, 'Reject', 'Alpha paragraph.');

    await a.page.locator('.amb-top[data-menu="view"]').click();
    await a.page.locator('[data-item="view-outline"]').click();
    assert.equal(await a.page.locator('.accord-outline-item').count(), initial.length);
    await drag(a.page, a.page.locator('.accord-outline-item').filter({ hasText: /^Alpha paragraph\.$/ }), a.page.locator('.accord-outline-item').filter({ hasText: /^Gamma paragraph\.$/ }));
    const outline = await pendingMove(b.page); await decide(b.page, outline, 'Accept', 'Alpha paragraph.');
    await waitOrder(a.page, moved); await a.page.screenshot({ path: path.join(shots, `${tag}-outline.png`), fullPage: true });
    await a.page.keyboard.press('Escape'); assert.equal(await a.page.locator('.accord-item-outline').count(), 0);
    await undo(b.page); await waitOrder(a.page, initial); await decide(b.page, outline, 'Reject', 'Alpha paragraph.');

    await api('/move-settings', { by: 'human:Alice', immediateMoveActors: ['human:Alice'] });
    await a.page.waitForFunction(() => window.__proofLineMarks.immediateMoveActors().some(a => a.toLowerCase() === 'human:alice'));
    await focus(a.page, 'Alpha paragraph.');
    await a.page.keyboard.press('Alt+Shift+ArrowDown');
    await waitOrder(b.page, [initial[0], initial[2], initial[1], ...initial.slice(3)]);
    const state = await api('/state');
    assert.ok(Object.values(state.marks).some(m => m.move && m.status === 'accepted' && m.resolvedBy === 'human:Alice'));
    await undo(a.page); await waitOrder(b.page, initial);
    assert.deepEqual(a.errors, []); assert.deepEqual(b.errors, []);
    console.log(`PASS ${tag}: mouse, two peers, decision/Undo, folded section, Review row, keyboard, outline, immediate move, stable scroll`);
  } finally { await a.context.close(); await b.context.close(); }
}
const browser = await chromium.launch({ headless: true });
try {
  for (const style of styles) {
    const server = await start(style);
    try { for (const width of widths) await run(browser, server, style, width); }
    catch (e) { console.error(readFileSync(server.log, 'utf8').slice(-4000)); throw e; }
    finally { await server.stop(); }
  }
} finally { await browser.close(); }
