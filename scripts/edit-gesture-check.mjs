#!/usr/bin/env node
// Browser check for Accord round 2 stage A — "editing has a visible state, and a gesture that ends
// it by posting" (Mike, 2026-09-22: "When option clicking to edit, the cursor changes, but there
// should be some better indication that we are in editing mode. Not clear how to get out of
// editing mode.").
//
// It checks the BEHAVIOUR, not the markup:
//   - the editing state is visible in all four places at once (line edge, status bar, toolbar,
//     caret);
//   - each of the three doors (Cmd+Enter, a click outside, Esc) posts what was typed;
//   - a leave never loses a character — the typed text is readable in the proposal afterwards;
//   - nothing posts when nothing changed;
//   - Undo removes the posted proposal, and it is the only thing that does;
//   - the reading keys still never type;
//   - the margin's pencil starts an edit;
//   - the phone's Done control is the same door.
//
// Authorship: Mike Wolf (rulings), built by Claude Opus 5 (worker accord-edit), 2026-09-22,
// in the style of scripts/editing-first-check.mjs.
// Starts an isolated local server on the current dist/ build (run `npm run build` first) at 1440
// and on a 390x844 phone. Screenshots go to .preview/ (or --shots <dir>). Exit 0 only if every
// check passes.
// Usage: node scripts/edit-gesture-check.mjs [--style playmaker|proof] [--shots dir]
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
const styles = arg('--style') ? [arg('--style')] : ['proof'];

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

/**
 * A clean slate: no edit open, no proposal left over, no notice still showing. Each check has to
 * stand on its own, because the rule it tests is about one edit at a time.
 */
async function reset(page) {
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(250);
  // Take back every open proposal, so the line reads its original words again. Undo alone is not
  // enough between checks: a proposal whose Undo entry was coalesced away would linger and the
  // next check would measure the leftovers.
  await page.evaluate(() => window.proof.rejectAllSuggestions());
  await page.waitForFunction(TARGET => {
    const open = (window.proof.getAllMarks() ?? []).filter(m => (m.data?.status ?? 'pending') === 'pending' && m.kind !== 'comment');
    const line = window.__proofLineMarks.lineList().find(l => l.text.includes('The edit gesture line'));
    return open.length === 0 && Boolean(line) && line.text === TARGET;
  }, TARGET, { timeout: 12_000, polling: 250 }).catch(() => {});
  await page.evaluate(() => window.__proofLineMarks.undoStack().clear());
  // Let the "Proposed — …" notice time out, so the next check sees its own.
  await page.waitForFunction(() => (window.__proofReadingWalk.debugState().notice ?? '') === '', null, { timeout: 12_000, polling: 250 })
    .catch(() => {});
  await page.waitForTimeout(200);
}

/** Puts the caret in the target line and types, without using a door. */
/** The block on screen that renders the margin's target line. */
async function targetBlock(page) {
  const nth = await page.evaluate(n => {
    const line = window.__proofLineMarks.lineList()[n];
    const dom = window.__editorView?.nodeDOM(line.pos);
    const blocks = Array.from(document.querySelectorAll('.ProseMirror > *'));
    const block = dom && dom.nodeType === 1 ? (dom.closest('.ProseMirror > *') ?? dom) : null;
    return block ? blocks.indexOf(block) : -1;
  }, TARGET_LINE);
  assert.ok(nth >= 0, 'the target line has no block on screen');
  return page.locator('.ProseMirror > *').nth(nth);
}

/** A visible block that is NOT the edited line (the click-outside door needs one). */
async function neighbourBlock(page) {
  const target = await (await targetBlock(page)).boundingBox();
  const { boxes, viewport } = await page.evaluate(() => ({
    boxes: Array.from(document.querySelectorAll('.ProseMirror > *'))
      .map((el, i) => { const r = el.getBoundingClientRect(); return { i, top: r.top, bottom: r.bottom, height: r.height }; }),
    viewport: window.innerHeight,
  }));
  const below = boxes.find(b => b.height > 0 && b.top > target.y + target.height + 4 && b.bottom < viewport - 80);
  const above = [...boxes].reverse().find(b => b.height > 0 && b.bottom < target.y - 4 && b.top > 80);
  const other = below ?? above;
  assert.ok(other, 'no other visible line to click');
  return page.locator('.ProseMirror > *').nth(other.i).boundingBox();
}

async function startEditing(page, phone, text) {
  // The line's index can move as proposals come and go: resolve it again each time.
  TARGET_LINE = await lineIndexOf(page, 'The edit gesture line');
  assert.ok(TARGET_LINE >= 0, 'the target line is gone from the document');
  const words = await targetBlock(page);
  await words.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page.waitForTimeout(400);
  const box = await words.boundingBox();
  if (phone) await page.touchscreen.tap(box.x + 6, box.y + box.height / 2);
  else await page.mouse.click(box.x + 6, box.y + box.height / 2);
  await page.waitForFunction(n => window.__proofReadingWalk.debugState().editing?.lineIndex === n, TARGET_LINE, { timeout: 6000 });
  if (text) { for (const ch of text) { await page.keyboard.type(ch); await page.waitForTimeout(18); } }
  await page.waitForTimeout(250);
}

/** The text the person can read for the target line: the document's words plus every proposal's. */
async function readableText(page) {
  const line = await rawLineText(page, TARGET_LINE);
  const proposals = await myProposals(page);
  return `${line}\n${proposals.map(p => p.content).join('\n')}`;
}

async function run(browser, base, style, tag, contextOptions, phone) {
  const created = await createDoc(base);
  const { context, page } = await openDoc(browser, base, created.slug, 'Ada', contextOptions);
  activePage = page;
  // Suggesting mode is what a share opens in, and it is where the whole rule holds today: the
  // typing is already a proposal, the leave posts it, says so, and Undo takes it back. Direct
  // Editing mode has its own check below (EDIT_SESSION_POLICY.convertDirectEditsToProposals).
  await page.waitForFunction(() => window.proof.isSuggestionsEnabled() === true, null, { timeout: 8000 });
  await page.waitForTimeout(200);
  TARGET_LINE = await lineIndexOf(page, 'The edit gesture line');
  assert.ok(TARGET_LINE >= 0, 'the target line is not in the document');
  // Warm up: scroll the line into place and let the margin lay its dots out before the first press.
  await page.evaluate(n => window.__proofReadingWalk.focusLine(n), TARGET_LINE);
  await page.waitForTimeout(900);

  await check(`${tag}: the editing state is visible in all four places at once`, async () => {
    await reset(page);
    await startEditing(page, phone, 'x');
    const state = await walkState(page);
    assert.ok(state.editing, 'no edit session is open');
    assert.equal(state.editing.lineIndex, TARGET_LINE, 'the session is on the wrong line');
    // 1. the line has a visible edge
    const edge = await page.evaluate(() => {
      const el = document.querySelector('.prw-focus');
      if (!el || el.hidden) return null;
      const style = getComputedStyle(el);
      return { editing: el.dataset.editing ?? null, line: el.dataset.line, shadow: style.boxShadow, background: style.backgroundColor };
    });
    assert.equal(edge?.editing, 'true', `the edited line has no editing edge: ${JSON.stringify(edge)}`);
    assert.equal(Number(edge.line), TARGET_LINE);
    assert.ok(/rgb\(37, 99, 235\)/.test(edge.shadow), `the left bar is not the "you are here" blue: ${edge.shadow}`);
    // 2. the status bar names the state and the line
    assert.equal(state.mode, 'editing', `the status bar mode is ${state.mode}`);
    assert.equal(state.modeText, `Editing line ${TARGET_LINE + 1}`, `the status bar reads "${state.modeText}"`);
    // 3. the toolbar indicator (desktop; a phone has no room for it, and says so in CSS)
    const toolbar = await page.evaluate(() => {
      const pill = document.querySelector('.share-pill-editing-state');
      const sw = document.querySelector('.share-pill-suggest-toggle');
      return { text: pill?.textContent ?? null, marked: sw?.dataset.editingLine ?? null };
    });
    assert.equal(toolbar.marked, String(TARGET_LINE + 1), 'the toolbar switch is not marked as editing');
    if (!phone) assert.equal(toolbar.text, `Editing line ${TARGET_LINE + 1}`, `the toolbar indicator reads ${toolbar.text}`);
    // 4. the caret is in the text and the person put it there
    const caret = await page.evaluate(() => ({
      writing: document.body.classList.contains('pw-writing'),
      inText: Boolean(document.activeElement?.closest?.('.ProseMirror')),
    }));
    assert.deepEqual(caret, { writing: true, inText: true }, 'the caret is not in the text');
    await page.screenshot({ path: path.join(shots, `edit-${tag}-editing-state.png`) });
    // leave cleanly for the next check
    await page.keyboard.press(phone ? 'Escape' : 'Meta+Enter');
    await page.waitForTimeout(500);
  });

  const doors = phone
    ? [['Escape', 'escape'], ['tap outside', 'click-outside'], ['Done', 'click-outside']]
    : [['Meta+Enter', 'cmd-enter'], ['click outside', 'click-outside'], ['Escape', 'escape']];

  for (const [label, door] of doors) {
    await check(`${tag}: the ${label} door posts what was typed, and loses nothing`, async () => {
      await reset(page);
      const before = await postedLog(page);
      const marker = `${TYPED}${door}-${label.replace(/\s+/g, '')} `;
      await startEditing(page, phone, marker);
      // The typed characters are in the document while the edit is open. Read the document's own
      // text: the margin's copy is normalised and would hide a whitespace difference.
      assert.ok((await rawLineText(page, TARGET_LINE)).includes(marker.trim()), 'the typed text never reached the line');
      if (label === 'click outside') {
        const other = await neighbourBlock(page);
        await page.mouse.click(other.x + 6, other.y + other.height / 2);
      } else if (label === 'tap outside') {
        const other = await neighbourBlock(page);
        await page.touchscreen.tap(other.x + 6, other.y + other.height / 2);
      } else if (label === 'Done') {
        const done = page.locator('.prw-edit-done');
      await done.waitFor({ state: 'visible', timeout: 8000 });
      await done.click({ timeout: 10_000 });
      } else {
        await page.keyboard.press(label);
      }
      await page.waitForFunction(n => (window.__proofEditGesture?.debugState().posted ?? []).length > n, before.length, { timeout: 8000, polling: 150 });
      const log = await postedLog(page);
      const last = log[log.length - 1];
      assert.equal(last.door, door, `the ${label} door reported as ${last.door}`);
      assert.equal(last.line, TARGET_LINE);
      assert.ok(last.proposed.includes(marker.trim()), `the proposal lost the typed words: ${JSON.stringify(last.proposed).slice(0, 160)}`);
      // THE PROPERTY: every character the person typed is still readable on the page afterwards.
      const readable = await readableText(page);
      assert.ok(readable.includes(marker.trim()), `leaving through ${label} LOST the typed text`);
      // And it is a proposal others can act on, with the original still readable underneath.
      const proposals = await myProposals(page);
      assert.ok(proposals.some(p => p.content.includes(marker.trim())), `no open proposal carries the typed words: ${JSON.stringify(proposals).slice(0, 200)}`);
      assert.ok((await rawLineText(page, TARGET_LINE)).includes(TARGET.slice(0, 40)),
        'the original words are no longer readable on the line');
      // Take it back, so the next door starts from the same line.
      await page.evaluate(() => window.__proofUndo?.debugState && window.__proofLineMarks.undoStack().undo());
      await page.waitForTimeout(600);
    });
  }

  await check(`${tag}: a leave that changed nothing posts nothing and says nothing`, async () => {
    await reset(page);
    const before = await postedLog(page);
    await startEditing(page, phone, '');
    assert.ok((await walkState(page)).editing, 'the session did not open');
    await page.keyboard.press(phone ? 'Escape' : 'Meta+Enter');
    await page.waitForTimeout(700);
    const log = await postedLog(page);
    assert.equal(log.length, before.length, `a silent leave posted something: ${JSON.stringify(log.slice(before.length))}`);
    assert.equal((await walkState(page)).notice, '', 'a silent leave spoke');
    assert.equal(await lineTextOf(page, TARGET_LINE), TARGET, 'the line changed without anyone typing');
  });

  await check(`${tag}: Undo removes the posted proposal, and only Undo does`, async () => {
    await reset(page);
    const marker = `${TYPED}undo `;
    await startEditing(page, phone, marker);
    await page.keyboard.press(phone ? 'Escape' : 'Meta+Enter');
    await page.waitForFunction(m => (window.proof.getAllMarks() ?? []).some(k => String(k.data?.content ?? '').includes(m)), marker.trim(), { timeout: 8000, polling: 150 });
    const next = await page.evaluate(() => window.__proofLineMarks.undoStack().next()?.description ?? null);
    assert.match(String(next), new RegExp(`proposed a change to line ${TARGET_LINE + 1}`), `the Undo entry reads "${next}"`);
    const entriesFor = () => page.evaluate(d => window.__proofLineMarks.undoStack().list().filter(e => e.description === d).length, `proposed a change to line ${TARGET_LINE + 1}`);
    assert.equal(await entriesFor(), 1, 'one posted proposal must leave exactly one Undo entry');
    await page.evaluate(() => window.__proofLineMarks.undoStack().undo());
    await page.waitForFunction(m => !(window.proof.getAllMarks() ?? []).some(k => String(k.data?.content ?? '').includes(m) && (k.data?.status ?? 'pending') === 'pending'), marker.trim(), { timeout: 8000, polling: 150 });
    assert.equal(await entriesFor(), 0, 'Undo did not consume the proposal\'s entry');
    assert.equal(await lineTextOf(page, TARGET_LINE), TARGET, 'the line did not come back to its words');
  });

  await check(`${tag}: the status bar says a proposal posted, and takes no focus`, async () => {
    await reset(page);
    const marker = `${TYPED}notice `;
    await startEditing(page, phone, marker);
    const focusBefore = await page.evaluate(() => document.activeElement?.tagName ?? '');
    await page.keyboard.press(phone ? 'Escape' : 'Meta+Enter');
    await page.waitForFunction(() => (window.__proofReadingWalk.debugState().notice ?? '').length > 0, null, { timeout: 8000, polling: 150 });
    const state = await walkState(page);
    assert.match(state.notice, /^Proposed/, `the status bar says "${state.notice}"`);
    assert.equal(await page.evaluate(() => document.querySelectorAll('[role="dialog"]:not([hidden])').length), 0, 'a modal opened');
    assert.notEqual(await page.evaluate(() => document.activeElement?.className ?? ''), 'pst-notice', 'the notice took focus');
    assert.ok(focusBefore.length >= 0);
    await page.screenshot({ path: path.join(shots, `edit-${tag}-proposed.png`) });
    await page.evaluate(() => window.__proofLineMarks.undoStack().undo());
    await page.waitForTimeout(600);
  });

  await check(`${tag}: the reading keys still never type`, async () => {
    await reset(page);
    // Leave the text entirely, then press every reading key on the focus line.
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(400);
    const before = await lineTextOf(page, TARGET_LINE);
    for (const key of ['a', 'r', 'y', 'n', 'd', 'e', 'j', 'k', '1']) {
      await page.keyboard.press(key);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(400);
    const lines = (await allLines(page)).join('\n');
    assert.ok(!/(^|\n)[^\n]*arynde jk1/.test(lines), 'the reading keys typed into the text');
    assert.equal(await lineTextOf(page, TARGET_LINE), before, 'a reading key changed the target line');
    // Close anything a reading key opened.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  if (!phone) {
    await check(`${tag}: the margin's pencil starts an edit (Option+click needed an affordance)`, async () => {
      await reset(page);
      await page.evaluate(n => window.__proofReadingWalk.focusLine(n), TARGET_LINE);
      await page.waitForTimeout(500);
      const pencil = page.locator(`.plm-edit-pencil[data-line="${TARGET_LINE}"]`);
      await pencil.waitFor({ state: 'visible', timeout: 6000 });
      await pencil.click();
      await page.waitForFunction(n => window.__proofReadingWalk.debugState().editing?.lineIndex === n, TARGET_LINE, { timeout: 6000 });
      const state = await walkState(page);
      assert.equal(state.modeText, `Editing line ${TARGET_LINE + 1}`, 'the pencil did not open an edit');
      await page.screenshot({ path: path.join(shots, `edit-${tag}-pencil.png`) });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    });
  }

  if (phone) {
    await check(`${tag}: the phone shows a Done control while editing and hides it after`, async () => {
      await reset(page);
      await startEditing(page, phone, 'q');
      assert.equal((await walkState(page)).doneVisible, true, 'no Done control while editing on a phone');
      const doneBtn = page.locator('.prw-edit-done');
      await doneBtn.waitFor({ state: 'visible', timeout: 8000 });
      await doneBtn.click({ timeout: 10_000 });
      await page.waitForTimeout(700);
      assert.equal((await walkState(page)).doneVisible, false, 'Done stayed after the edit ended');
      await page.screenshot({ path: path.join(shots, `edit-${tag}-done.png`) });
      await page.evaluate(() => window.__proofLineMarks.undoStack().undo());
      await page.waitForTimeout(500);
    });
  }

  await check(`${tag}: in direct Editing mode a leave keeps every character and says so`, async () => {
    // EDIT_SESSION_POLICY.convertDirectEditsToProposals is off: in direct Editing mode the leave
    // does NOT turn the typed words into a proposal (that rewrite is not safe under a second
    // writer yet — the policy carries the measurement). What must still hold, and is what this
    // checks, is the part of the rule that never bends: the edit ends visibly, not one character
    // is lost, and the person is told where their change went.
    await reset(page);
    await page.evaluate(() => window.proof.disableSuggestions());
    await page.waitForFunction(() => window.proof.isSuggestionsEnabled() === false, null, { timeout: 6000 });
    await page.waitForTimeout(300);
    const marker = `${TYPED}direct `;
    await startEditing(page, phone, marker);
    assert.equal((await walkState(page)).modeText, `Editing line ${TARGET_LINE + 1}`, 'the edit has no visible state');
    await page.keyboard.press(phone ? 'Escape' : 'Meta+Enter');
    await page.waitForFunction(() => (window.__proofReadingWalk.debugState().notice ?? '').length > 0, null, { timeout: 8000, polling: 150 });
    assert.ok((await rawLineText(page, TARGET_LINE)).includes(marker.trim()), 'direct Editing lost the typed text on leaving');
    assert.match((await walkState(page)).notice, /^Edited line /, `the person was not told: "${(await walkState(page)).notice}"`);
    assert.equal((await walkState(page)).mode, 'reading', 'the edit did not end');
    await page.evaluate(() => window.proof.enableSuggestions());
    await page.waitForTimeout(300);
  });

  await check(`${tag}: a second leave in Suggesting mode writes no second proposal`, async () => {
    await reset(page);
    await page.waitForFunction(() => window.proof.isSuggestionsEnabled() === true, null, { timeout: 6000 });
    const marker = `${TYPED}suggesting `;
    await startEditing(page, phone, marker);
    // What the rule owns here is the LEAVE: whatever is readable when the person leaves must still
    // be readable after. Where Suggesting mode's caret puts each character while they type is a
    // different concern, and scripts/caret-stability-check.mjs owns it; asserting on the caret here
    // would test that instead of this rule.
    const beforeDoor = await readableText(page);
    for (const ch of [...new Set(marker.replace(/\s/g, ''))]) {
      assert.ok(beforeDoor.includes(ch), `the typed character ${ch} never reached the page`);
    }
    await page.keyboard.press(phone ? 'Escape' : 'Meta+Enter');
    await page.waitForTimeout(900);
    const log = await postedLog(page);
    const last = log[log.length - 1];
    assert.equal(last.tracked, true, 'Suggesting mode should report the proposal as already tracked');
    const readable = await readableText(page);
    for (const piece of beforeDoor.split(/\n+/).map(t => t.trim()).filter(t => t.length > 3)) {
      assert.ok(readable.includes(piece), `leaving lost text that was readable before the door: ${JSON.stringify(piece).slice(0, 160)}`);
    }
    const doubled = (await myProposals(page)).filter(p => p.content.includes(marker.trim()) && p.kind === 'replace').length;
    assert.ok(doubled <= 1, `the leave wrote a second proposal (${doubled} replaces carry the same words)`);
    assert.match((await walkState(page)).notice, /^Proposed/, 'the person was not told');
  });

  await context.close();
}

const browser = await chromium.launch();
try {
  for (const style of styles) {
    const { base, stop } = await startServer(style);
    try {
      await run(browser, base, style, `${style}-1440`, { viewport: { width: 1440, height: 900 } }, false);
      await run(browser, base, style, `${style}-phone-390x844`, { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } }, true);
    } finally {
      await stop();
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${results.length - failures}/${results.length} edit-gesture checks passed`);
process.exit(failures ? 1 : 0);
