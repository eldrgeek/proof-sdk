#!/usr/bin/env node
// ac-ug8 (2026-09-25): Undo while someone else adds a mark. Before the fix, an AI's comment made the
// typist's next Cmd+Z do nothing (Milkdown's hardbreak plugin turned the page's stamping of the
// server's marks into an invisible Undo step), and the Cmd+Z after it refused with "Can't undo:
// someone has replied to this suggestion" (the server re-sets unchanged records, and the Undo
// guard counted that as someone else's edit). Local server, both review styles, desktop first.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
import { showWholeAccord } from './review-ui.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const shots = path.join(root, '.preview'); mkdirSync(shots, { recursive: true });
const headers = { 'Content-Type': 'application/json', 'X-Proof-Client-Version': '0.34.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
const markdown = '# Undo while others mark\n\nAgreed words stay here.\n\nOriginal replacement words.\n\nLast paragraph stays once.';
let failures = 0;

async function start(style) {
  const socket = createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  const temp = mkdtempSync(path.join(tmpdir(), 'accord-undo-others-'));
  const fd = openSync(path.join(temp, 'server.log'), 'w');
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      PORT: String(port), DATABASE_PATH: path.join(temp, 'test.db'), SNAPSHOT_DIR: path.join(temp, 'snapshots'),
      COLLAB_EMBEDDED_WS: '1', PROOF_DEFAULT_REVIEW_STYLE: style }, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) await new Promise(r => child.once('exit', r));
    rmSync(temp, { recursive: true, force: true });
  };
  for (let i = 0; i < 200; i++) {
    if ((await fetch(`${base}/health`).catch(() => null))?.ok) return { base, stop };
    await new Promise(r => setTimeout(r, 150));
  }
  await stop(); throw Error('Local server failed to start');
}
async function request(base, route, body, token) {
  const r = await fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(token ? { 'x-share-token': token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(r.ok, `${route}: ${r.status} ${r.ok ? '' : await r.text()}`); return r.json();
}
async function poll(fn, message, timeout = 8000) {
  const end = Date.now() + timeout;
  do { if (await fn()) return; await new Promise(r => setTimeout(r, 60)); } while (Date.now() < end);
  assert.fail(message);
}

async function run(browser, style, width) {
  const tag = `undo-others-${style}-${width}`;
  const server = await start(style);
  const context = await browser.newContext(width < 700 ? { ...devices['iPhone 13'], viewport: { width, height: 844 } } : { viewport: { width, height: 900 } });
  try {
    const created = await request(server.base, '/documents', { title: 'Undo while others mark', markdown, role: 'editor' });
    await context.addInitScript(() => localStorage.setItem('proof-share-viewer-name', 'Alice'));
    await context.route('**/*', route => new URL(route.request().url()).origin === server.base ? route.continue() : route.abort());
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${server.base}/d/${created.slug}`);
    await page.waitForFunction(() => window.proof?.collabIsSynced && window.__proofLineMarks?.debugState().loaded);
    await showWholeAccord(page);
    const text = () => page.evaluate(() => window.__editorView.state.doc.textContent);
    const undoSteps = () => page.evaluate(() => window.__editorView.state['y-undo$'].undoManager.undoStack.length);
    // Place the caret at the end of the first item and type a live proposal.
    const at = await page.evaluate(() => {
      const view = window.__editorView; let pos;
      view.state.doc.descendants((node, start) => { if (pos === undefined && node.isText && node.text.includes('Agreed words stay here.')) pos = start + node.text.indexOf('Agreed words stay here.') + 'Agreed words stay here.'.length; });
      const r = view.coordsAtPos(pos); return { pos, x: r.left, y: (r.top + r.bottom) / 2 };
    });
    await page.mouse.click(at.x, at.y);
    await poll(() => page.evaluate(pos => window.__editorView.state.selection.head === pos, at.pos), 'The click did not place the caret');
    await page.keyboard.type(' typed by Alice', { delay: 30 });
    await poll(async () => (await text()).includes('typed by Alice'), 'The typing did not land');
    await page.waitForTimeout(600);
    const steps = await undoSteps();
    // Someone else adds a mark: an AI's comment on another line, through the API.
    await request(server.base, `/api/agent/${created.slug}/marks/comment`, { quote: 'Original replacement words.', text: 'A comment from an AI', by: 'ai:tester' }, created.ownerSecret);
    await poll(() => page.evaluate(() => (window.proof.getAllMarks() ?? []).some(m => m.kind === 'comment')), 'The AI comment never reached the page');
    await page.waitForTimeout(800);
    assert.equal(await undoSteps(), steps, 'Someone else\'s mark added a step to this person\'s Undo');
    // One Cmd+Z takes the typing back, with no refusal.
    await page.keyboard.press('ControlOrMeta+z');
    await poll(async () => !(await text()).includes('typed by Alice'), 'One Cmd+Z did not take the typing back');
    const refusal = await page.evaluate(() => [...document.querySelectorAll('#error-banner, .pst-notice, [role="alert"]')].map(e => e.textContent ?? '').find(t => /can.t undo/i.test(t)) ?? null);
    assert.equal(refusal, null, `Undo refused: ${refusal}`);
    // The proposal is withdrawn with a recorded decision, never deleted, on the server too.
    await poll(async () => {
      const state = await request(server.base, `/api/agent/${created.slug}/state`, undefined, created.ownerSecret);
      const marks = Array.isArray(state.marks) ? state.marks : Object.values(state.marks ?? {});
      const insert = marks.find(m => m.kind === 'insert' && String(m.content ?? '').includes('typed by Alice'));
      return insert && insert.status === 'rejected';
    }, 'The server does not hold the proposal as withdrawn');
    await page.screenshot({ path: path.join(shots, `${tag}.png`) });
    assert.deepEqual(errors, []);
    console.log(`PASS ${tag}: an AI's comment adds no Undo step; one Cmd+Z takes the typing back and withdraws the proposal`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${tag}: ${error?.message?.split('\n')[0]}`);
  } finally {
    await context.close();
    await server.stop();
  }
}

// ac-x31 (2026-09-25): Undo of a decision after an AI's API write. The server re-sets every record
// then, so the rejected record became its Yjs item and Undo brought the AI's words back as plain
// text while the Review list said Done. Desktop first: the rail's Reject is the desktop control.
async function runDecision(browser, style) {
  const tag = `undo-others-decision-${style}-1440`;
  const server = await start(style);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const created = await request(server.base, '/documents', { title: 'Undo a decision while others mark', markdown, role: 'editor' });
    await context.addInitScript(() => localStorage.setItem('proof-share-viewer-name', 'Alice'));
    await context.route('**/*', route => new URL(route.request().url()).origin === server.base ? route.continue() : route.abort());
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${server.base}/d/${created.slug}`);
    await page.waitForFunction(() => window.proof?.collabIsSynced && window.__proofLineMarks?.debugState().loaded);
    await showWholeAccord(page);
    await request(server.base, `/api/agent/${created.slug}/marks/suggest-insert`, { quote: 'Agreed words stay here.', content: ' added by the AI', by: 'ai:tester' }, created.ownerSecret);
    await poll(() => page.evaluate(() => (window.proof.getAllMarks() ?? []).some(m => m.kind === 'insert')), 'The AI proposal never reached the page');
    const id = await page.evaluate(() => window.proof.getAllMarks().find(m => m.kind === 'insert').id);
    const record = () => page.evaluate(i => window.__editorView.state['y-sync$'].doc.getMap('marks').get(i)?.status ?? 'pending', id);
    const words = () => page.evaluate(() => window.__editorView.state.doc.textContent.includes('added by the AI'));
    // Alice rejects it with the rail's Reject, then an AI comments on another line.
    await page.evaluate(() => window.__proofReadingWalk.focusLine(1));
    const reject = page.locator('.prw-right .prw-card .prw-reject').first();
    await reject.waitFor({ state: 'visible' });
    await reject.click();
    await poll(async () => await record() === 'rejected' && !(await words()), 'Reject did not remove the words and record the decision');
    await request(server.base, `/api/agent/${created.slug}/marks/comment`, { quote: 'Original replacement words.', text: 'A comment from an AI', by: 'ai:tester' }, created.ownerSecret);
    await poll(() => page.evaluate(() => (window.proof.getAllMarks() ?? []).some(m => m.kind === 'comment')), 'The AI comment never reached the page');
    await page.waitForTimeout(800);
    // One Cmd+Z undoes the rejection: the words come back as the AI's pending proposal, not as text.
    await page.keyboard.press('ControlOrMeta+z');
    await poll(words, 'One Cmd+Z did not bring the words back');
    await poll(async () => await record() === 'pending', 'The words came back, but the record still says rejected (plain text nobody accepted)');
    const pmStatus = await page.evaluate(i => { const m = window.proof.getAllMarks().find(x => x.id === i); return m ? (m.data?.status ?? m.status ?? 'pending') : null; }, id);
    assert.equal(pmStatus, 'pending', 'The page does not show the words as a pending proposal');
    await poll(async () => {
      const state = await request(server.base, `/api/agent/${created.slug}/state`, undefined, created.ownerSecret);
      const marks = Array.isArray(state.marks) ? state.marks : Object.values(state.marks ?? {});
      const insert = marks.find(m => m.kind === 'insert' && String(m.content ?? '').includes('added by the AI'));
      return insert && (insert.status ?? 'pending') === 'pending';
    }, 'The server does not hold the proposal as pending again');
    await page.screenshot({ path: path.join(shots, `${tag}.png`) });
    assert.deepEqual(errors, []);
    console.log(`PASS ${tag}: after an AI's comment, one Cmd+Z undoes a rejection as a whole: the words and the pending proposal`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${tag}: ${error?.message?.split('\n')[0]}`);
  } finally {
    await context.close();
    await server.stop();
  }
}

const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 390]) for (const style of ['playmaker', 'proof']) await run(browser, style, width);
  for (const style of ['playmaker', 'proof']) await runDecision(browser, style);
} finally { await browser.close(); }
console.log(failures ? `undo-while-others-mark-check: ${failures} FAILED` : 'undo-while-others-mark-check: all passed');
process.exit(failures ? 1 : 0);
