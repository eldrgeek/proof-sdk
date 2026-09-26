#!/usr/bin/env node
import { showWholeAccord } from './review-ui.mjs';
// ac-l71. Local-only desktop drag checks; reviewer runs Chromium outside the worker sandbox.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
  const index = await page.evaluate(text => {
    const line = window.__proofLineMarks.lineList().find(l => l.text === text);
    if (!line) throw Error(`No line ${text}`);
    window.__proofReadingWalk.focusLine(line.index);
    document.activeElement?.blur();
    return line.index;
  }, text);
  // The gutter redraws on the next frame, and the move handle follows the focus line. Reading the
  // handle before that pressed where the previous line's handle had been (reviewer, 2026-09-26).
  await page.waitForFunction(i => innerWidth < 701 || document.querySelector('.plm-gutter .accord-move-handle')?.dataset.moveLine === String(i), index);
}
async function drag(page, source, target, side = 'after') {
  // Press only where the source really is. The gutter handle and the fold chips are redrawn on the
  // next frame after a focus or fold change, and a box read before that pressed where the handle
  // had been, so no drag started (reviewer, 2026-09-26).
  await source.waitFor({ state: 'visible' });
  let a = null;
  for (let i = 0; i < 30 && !a; i++) {
    const box = await source.boundingBox();
    const under = box && await source.evaluate((el, [x, y]) => { const hit = document.elementFromPoint(x, y); return Boolean(hit && (el === hit || el.contains(hit))); },
      [box.x + box.width / 2, box.y + box.height / 2]);
    if (under) a = box; else await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
  }
  if (!a) {
    const seen = await source.evaluate(el => {
      const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      const describe = n => n ? `${n.tagName.toLowerCase()}.${String(n.className).slice(0, 50)}` : 'none';
      const chip = el.closest('.pfold-chip');
      return { box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], covering: describe(hit),
        coveringBox: hit ? (({ x, y, width, height }) => [Math.round(x), Math.round(y), Math.round(width), Math.round(height)])(hit.getBoundingClientRect()) : null,
        chip: chip ? (({ x, y, width, height }) => [Math.round(x), Math.round(y), Math.round(width), Math.round(height)])(chip.getBoundingClientRect()) : null,
        pe: getComputedStyle(el).pointerEvents };
    });
    assert.fail(`The drag source never sat under its own box: ${JSON.stringify(seen)}`);
  }
  const b = await target.boundingBox();
  assert.ok(b, 'Drag target must be visible');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, side === 'before' ? b.y + 1 : b.y + b.height - 1, { steps: 18 });
  try {
    await page.locator('.accord-drop-line').waitFor({ state: 'visible' });
  } catch (error) {
    const state = await page.evaluate(() => ({ moving: document.body.classList.contains('accord-moving') }));
    throw new Error(`No drop line: ${state.moving ? 'the drag started but found no valid place' : 'the drag never started'} (${error.message.split('\n')[0]})`);
  }
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
// The focus box slides 120 ms to its new line after a move; a screenshot taken during the slide shows it
// a line away from the focus (measured 2026-09-26: 155 px mid-slide, 263 px settled around a line at 265).
const settled = page => page.waitForTimeout(400);
async function decide(page, id, action, sourceText) {
  await focus(page, sourceText);
  const card = page.locator(`[data-bundle-id="${id}"]`);
  await card.waitFor({ state: 'visible' });
  assert.equal(await card.count(), 1, 'one move card');
  assert.match(await card.innerText(), /Moves .* to (before|after)/);
  // The reader's item holds still on screen. After an Accept the focus follows the moved item (the
  // reading walk keeps focus on the same line key) and the page scrolls just enough to keep that item
  // where it was, so the reader is not moved off what they were looking at. Measured 2026-09-26: the
  // item stayed at 224 px while scrollY went 0 to 83 (reviewer; the first version asserted scrollY).
  const focusTop = () => page.evaluate(text => {
    const line = window.__proofLineMarks.lineList().find(l => l.text === text);
    const dom = line ? window.__editorView.nodeDOM(line.pos) : null;
    return dom?.getBoundingClientRect ? Math.round(dom.getBoundingClientRect().top) : null;
  }, sourceText);
  const before = await focusTop();
  await card.getByRole('button', { name: `${action} move`, exact: true }).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const after = await focusTop();
  assert.ok(before !== null && after !== null && Math.abs(after - before) < 3, `${action} moved the reader's item on screen (top ${before} to ${after})`);
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
    // One change to a person, though two records: the Undo says 'a move', not '2 changes'.
    await b.page.getByRole('button', { name: 'Undo accepted a move', exact: true }).first().waitFor();
    const moved = [...initial]; moved.splice(1, 1); moved.splice(3, 0, initial[1]);
    await waitOrder(a.page, moved); await waitOrder(b.page, moved);
    await settled(b.page); await b.page.screenshot({ path: path.join(shots, `${tag}-accepted.png`), fullPage: true });
    await undo(b.page); await waitOrder(a.page, initial);
    await decide(b.page, id, 'Reject', 'Alpha paragraph.');
    await waitOrder(a.page, initial);

    // A folded heading moves its body as one unit.
    const firstTask = await a.page.evaluate(() => { const l = window.__proofLineMarks.lineList().find(l => l.text === 'First task'); window.__proofFolding.setFolded(l.index, true); return l.index; });
    // The chip of First task itself: the title's chip can be folded too, and it comes first.
    await drag(a.page, a.page.locator(`.pfold-chip[data-heading="${firstTask}"][data-move-line]`), a.page.locator('.ProseMirror h3').filter({ hasText: /^Last task$/ }), 'before');
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
    await waitOrder(a.page, moved); await settled(a.page); await a.page.screenshot({ path: path.join(shots, `${tag}-outline.png`), fullPage: true });
    await a.page.keyboard.press('Escape'); assert.equal(await a.page.locator('.accord-item-outline').count(), 0);
    await undo(b.page); await waitOrder(a.page, initial); await decide(b.page, outline, 'Reject', 'Alpha paragraph.');

    // A guest's move stays a proposal even when an owner lists the name: the list takes verified ids only.
    const refused = await fetch(`${server.base}/api/agent/${created.slug}/move-settings`, { method: 'POST', headers: { ...headers, 'x-share-token': created.ownerSecret },
      body: JSON.stringify({ by: 'owner', immediateMoveActors: ['guest:Alice'] }) });
    assert.equal(refused.status, 400, 'a guest was accepted as an immediate mover');
    assert.deepEqual(a.errors, []); assert.deepEqual(b.errors, []);
    console.log(`PASS ${tag}: mouse, two peers, decision/Undo, folded section, Review row, keyboard, outline, guests never immediate, the reader's item holds still`);
  } finally { await a.context.close(); await b.context.close(); }
}
// A listed verified person's own moves apply at once (Waiting on Mike: Mike's moves). Guests cannot be
// listed (the server takes only human: and ai: ids, by design), so this case runs as a signed-in
// member on a server with the library on, seeded the way agent-join-check does it: no mail, no
// production credentials (reviewer, 2026-09-26; the first version listed human:Alice for a guest page).
async function startSignedIn(style) {
  const socket = createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  const base = `http://127.0.0.1:${port}`;
  const temp = mkdtempSync(path.join(tmpdir(), 'accord-drag-signed-'));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    PORT: String(port), DATABASE_PATH: path.join(temp, 'test.db'), SNAPSHOT_DIR: path.join(temp, 'snapshots'),
    PROOF_LIBRARY_ENABLED: '1', PROOF_ENV: 'test', PROOF_DB_ENV_INIT: 'test',
    COLLAB_EMBEDDED_WS: '1', PROOF_DEFAULT_REVIEW_STYLE: style };
  const fixture = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    const db = await import('./server/db.ts');
    const auth = await import('./server/library/auth.ts');
    const member = auth.createLibraryMember({ name: 'Mike', email: 'mike@example.test', isOwner: true });
    db.createDocument('drag-signed', ${JSON.stringify(markdown)}, {}, 'Dragging', 'owner', 'local-drag-owner');
    db.getDb().prepare('INSERT INTO library_document_meta (slug, created_by_member_id) VALUES (?, ?)').run('drag-signed', member.id);
    const link = auth.createLibrarySigninLink({ memberId: member.id, purpose: 'operator', origin: ${JSON.stringify(base)} });
    const session = auth.consumeLibrarySigninToken(new URL(link.link).hash.slice(3), null);
    console.log('FIXTURE:' + JSON.stringify({ name: auth.LIBRARY_SESSION_COOKIE, value: session.sessionId }));
  `], { cwd: root, env, encoding: 'utf8' });
  if (fixture.status !== 0) { rmSync(temp, { recursive: true, force: true }); throw Error(fixture.stderr); }
  const cookie = JSON.parse(fixture.stdout.split('\n').find(line => line.startsWith('FIXTURE:')).slice(8));
  const log = path.join(temp, 'server.log'); const fd = openSync(log, 'w');
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: root, env, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  const stop = async () => { child.kill('SIGTERM'); if (child.exitCode === null && child.signalCode === null) await new Promise(r => child.once('exit', r)); rmSync(temp, { recursive: true, force: true }); };
  for (let i = 0; i < 200; i++) {
    if ((await fetch(`${base}/health`).catch(() => null))?.ok) return { base, cookie, stop, log };
    if (child.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 150));
  }
  const error = readFileSync(log, 'utf8'); await stop(); throw Error(`Signed-in server did not start: ${error.slice(-2000)}`);
}
async function immediate(browser, style) {
  const server = await startSignedIn(style);
  const tag = `drag-${style}-1440-immediate`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await context.addCookies([{ ...server.cookie, url: server.base }]);
    await context.route('**/*', route => new URL(route.request().url()).origin === server.base ? route.continue() : route.abort());
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${server.base}/d/drag-signed`);
    await page.waitForFunction(() => window.proof?.collabIsSynced && window.__proofReadingWalk?.debugState().ready && window.__proofLineMarks?.debugState().loaded);
    const welcome = page.locator('.proof-share-welcome-toast button'); if (await welcome.count()) await welcome.first().click();
    const me = await page.evaluate(() => window.__proofLineMarks.me());
    assert.match(me, /^human:/, `the signed-in page acts as ${me}, not a verified person`);
    await request(server.base, '/api/agent/drag-signed/move-settings', { by: 'owner', immediateMoveActors: [me] }, 'local-drag-owner');
    await page.waitForFunction(me => window.__proofLineMarks.immediateMoveActors().includes(me.toLowerCase()), me);
    // A signed-in owner arrives in the folded view, where the paragraphs are hidden and cannot take the focus.
    await showWholeAccord(page);
    const initial = await blocks(page);
    await focus(page, 'Alpha paragraph.');
    await page.keyboard.press('Alt+Shift+ArrowDown');
    await waitOrder(page, [initial[0], initial[2], initial[1], ...initial.slice(3)]);
    const state = await request(server.base, '/api/agent/drag-signed/state', undefined, 'local-drag-owner');
    const marks = Array.isArray(state.marks) ? state.marks : Object.values(state.marks ?? {});
    assert.ok(marks.some(m => m.move && m.status === 'accepted' && String(m.resolvedBy).toLowerCase() === me.toLowerCase()), "the immediate move is not recorded as the mover's own decision");
    await settled(page); await page.screenshot({ path: path.join(shots, `${tag}.png`), fullPage: true });
    await undo(page); await waitOrder(page, initial);
    assert.deepEqual(errors, []);
    console.log(`PASS ${tag}: a listed verified person's own move applies at once, is recorded as their decision, and has one Undo`);
  } catch (e) { console.error(readFileSync(server.log, 'utf8').slice(-4000)); throw e; }
  finally { await context.close(); await server.stop(); }
}
const browser = await chromium.launch({ headless: true });
try {
  for (const style of styles) {
    const server = await start(style);
    try { for (const width of widths) await run(browser, server, style, width); if (widths.some(w => w >= 701)) await immediate(browser, style); }
    catch (e) { console.error(readFileSync(server.log, 'utf8').slice(-4000)); throw e; }
    finally { await server.stop(); }
  }
} finally { await browser.close(); }
