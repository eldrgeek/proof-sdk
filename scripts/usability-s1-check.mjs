#!/usr/bin/env node
// Accord usability S1: explicit folding/targets, Seen-only reading and stable viewport.
// Mike, 2026-09-23 (usability brief). Loopback fixtures, both review styles and phone.
// Usage: node scripts/usability-s1-check.mjs [--shots dir]
import assert from 'node:assert/strict';
import { selectPassage, hoverChangesNothing, scrollAcceptsNothing, expandedStaysExpanded } from './usability-s1-assertions.mjs';
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
const widths = arg('--width') ? [Number(arg('--width'))] : [1280];

const clientHeaders = { 'X-Proof-Client-Version': '0.31.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `usability-s1-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-usability-s1-'));
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
// Lines: 0 Title | 1 Intro | 2 ## Alpha | 3-5 alpha (4 holds a suggestion) | 6 ### Alpha detail | 7-8 |
//        9 ## Beta | 10-13 | 14 ## Gamma | 15-16 | 17 ## Delta | 18-19
const markdown = [
  '# Folding check', para('Intro', 1),
  '## Alpha section', para('Alpha', 1), 'Alpha paragraph 2 carries the change word for a suggestion.', para('Alpha', 3),
  '### Alpha detail', para('Detail', 1), para('Detail', 2),
  '## Beta section', para('Beta', 1), para('Beta', 2), para('Beta', 3), para('Beta', 4),
  '## Gamma section', para('Gamma', 1), para('Gamma', 2),
  '## Delta section', para('Delta', 1), para('Delta', 2),
].join('\n\n');
const L = { TITLE: 0, ALPHA: 2, ALPHA_SUG: 4, DETAIL: 6, BETA: 9, GAMMA: 14, DELTA: 17 };

async function createDoc(base) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown, title: 'Folding check' }),
  });
  assert.equal(response.status, 200);
  const created = await response.json();
  const r = await fetch(`${base}/api/agent/${created.slug}/marks/suggest-replace`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-share-token': created.accessToken },
    body: JSON.stringify({ quote: 'change word', content: 'CHANGED word', by: 'ai:check' }),
  });
  assert.ok(r.ok, `suggest: ${r.status} ${await r.text()}`);
  return created;
}

/** One base only: the server refuses baseToken together with baseRevision. */
async function agentEdit(base, created, operations, key) {
  const headers = { 'Content-Type': 'application/json', 'x-share-token': created.accessToken };
  const snap = await (await fetch(`${base}/api/agent/${created.slug}/snapshot`, { headers })).json();
  const body = { by: 'ai:remote', operations };
  if (snap.mutationBase) body.baseToken = typeof snap.mutationBase === 'string' ? snap.mutationBase : snap.mutationBase.token;
  else if (snap.revision !== undefined && snap.revision !== null) body.baseRevision = snap.revision;
  assert.ok(body.baseToken || body.baseRevision !== undefined, `no base on the snapshot: ${JSON.stringify({ revision: snap.revision, mutationBase: snap.mutationBase })}`);
  const response = await fetch(`${base}/api/agent/${created.slug}/edit/v2`, {
    method: 'POST', headers: { ...headers, 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
  assert.ok(response.ok, await response.text());
}

async function agentMark(base, created, payload) {
  const r = await fetch(`${base}/api/agent/${created.slug}/marks/line`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-share-token': created.accessToken },
    body: JSON.stringify({ by: "ai:check", ...payload }),
  });
  const body = await r.json();
  assert.ok(r.ok, `agent mark: ${r.status} ${JSON.stringify(body)}`);
  return body;
}

async function openDoc(browser, base, slug, name, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  // Step B3b: these checks read with J at a steady 330 ms per line; the reader's rate "any"
  // (0 = the 250 ms minimum for every line) keeps them about folding, not reading speed.
  await context.addInitScript(viewer => { try { if (!localStorage.getItem('proof-share-viewer-name')) localStorage.setItem('proof-share-viewer-name', viewer); localStorage.setItem('proof:reading-rate', '0'); } catch {} }, name);
  const page = await context.newPage();
  await page.goto(`${base}/d/${slug}`);
  await ready(page);
  return { context, page };
}

async function ready(page) {
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForFunction(() => window.__proofReadingWalk?.debugState().ready === true
    && (window.__proofFolding?.debugState().sections.length ?? 0) >= 6
    && (window.proof?.getAllMarks?.() ?? []).filter(m => m.data?.status === 'pending').length >= 1, null, { timeout: 10_000 });
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  page.setDefaultTimeout(6000);
}

const fold = page => page.evaluate(() => window.__proofFolding.debugState());
const walk = page => page.evaluate(() => window.__proofReadingWalk.debugState());
const myMarks = (page, name) => page.evaluate(n => window.__proofLineMarks.debugState().marks
  .filter(m => m.by === `guest:${n}` && !m.id.startsWith('local-')).map(m => [m.anchor.ordinal, m.status]), name);
const dotStatus = (page, line) => page.evaluate(i => document.querySelector(`.plm-dot[data-line="${i}"]`)?.dataset.status ?? null, line);
const chip = (page, heading) => page.locator(`.pfold-chip[data-heading="${heading}"]`);
const waitFor = (page, fn, arg, timeout = 8000) => page.waitForFunction(fn, arg, { timeout, polling: 100 });
const isHiddenLine = (page, line) => page.evaluate(i => {
  const lm = window.__proofLineMarks; const view = lm.editorView(); const l = lm.lineList()[i];
  const dom = view.nodeDOM(l.pos); return !!dom && dom.getBoundingClientRect().height === 0;
}, line);

async function desktop(browser, base, style, width) {
  const created = await createDoc(base);
  const { context, page } = await openDoc(browser, base, created.slug, 'S1 Reader', { viewport: { width, height: 800 } });
  const tag = `usability-s1-${style}-${width}`;
  activePage = page;
  await check(`${tag}: first open is expanded and scrolling never collapses it`, async () => {
    assert.deepEqual((await fold(page)).folded, []);
    await expandedStaysExpanded(page);
  });
  await check(`${tag}: hover changes no target, selection, mode or element box`, async () => {
    await selectPassage(page, 3);
    await hoverChangesNothing(page, 4);
  });
  await check(`${tag}: shortcut after hover acts on the selected passage only`, async () => {
    await selectPassage(page, 3);
    await hoverChangesNothing(page, 4);
    await page.keyboard.press('a');
    await waitFor(page, () => window.__proofLineMarks.myStatus(3) === 'agreed');
    assert.notEqual(await page.evaluate(() => window.__proofLineMarks.myStatus(4)), 'agreed');
    assert.equal(await isHiddenLine(page, 3), false, 'Agree hid its passage');
    await expandedStaysExpanded(page);
  });
  await check(`${tag}: collapsed heading agreement marks only the heading`, async () => {
    await page.evaluate(() => window.__proofFolding.setFolded(9, true));
    await selectPassage(page, 9);
    await hoverChangesNothing(page, 9);
    const before = await page.evaluate(() => window.__proofLineMarks.debugState().sectionWrites);
    await page.keyboard.press('a');
    await waitFor(page, () => window.__proofLineMarks.myStatus(9) === 'agreed');
    assert.equal(await page.evaluate(() => window.__proofLineMarks.debugState().sectionWrites), before);
    for (const i of [10, 11, 12, 13]) assert.notEqual(await page.evaluate(i => window.__proofLineMarks.myStatus(i), i), 'agreed');
    const explicit = page.locator('.prw-right .plm-section-note');
    assert.equal(await explicit.textContent(), 'Show all 5 lines to agree with this section');
  });
  await check(`${tag}: J/K treat the collapsed section as one passage`, async () => {
    await selectPassage(page, 9);
    await page.keyboard.press('j');
    assert.equal((await walk(page)).cursor, 14);
    await page.keyboard.press('k');
    assert.equal((await walk(page)).cursor, 9);
  });
  await check(`${tag}: navigation opens only ancestors and preserves unrelated folds`, async () => {
    await page.evaluate(() => { window.__proofFolding.setFolded(2, true); window.__proofFolding.setFolded(9, true); });
    await selectPassage(page, 7);
    assert.equal(await isHiddenLine(page, 7), false);
    assert.equal(await page.evaluate(() => window.__proofFolding.isFolded(9)), true);
    await page.reload(); await ready(page);
    assert.equal(await page.evaluate(() => window.__proofFolding.isFolded(9)), true, 'fold lost on reload');
    assert.equal(await page.evaluate(() => window.__proofFolding.isFolded(2)), false, 'explicit reveal lost on reload');
  });
  await check(`${tag}: disclosure choices belong to the reader in this browser`, async () => {
    await page.evaluate(() => localStorage.setItem('proof-share-viewer-name', 'Another S1 Reader'));
    await page.reload(); await ready(page);
    assert.deepEqual((await fold(page)).folded, [], 'another reader inherited the first reader folds');
    await page.evaluate(() => localStorage.setItem('proof-share-viewer-name', 'S1 Reader'));
    await page.reload(); await ready(page);
    assert.equal(await page.evaluate(() => window.__proofFolding.isFolded(9)), true, 'original reader lost their choice');
  });
  await check(`${tag}: scrolling past proposals and later navigation accept nothing`, () => scrollAcceptsNothing(page));
  await check(`${tag}: letter shortcuts can be disabled; IME and fields never run them`, async () => {
    await selectPassage(page, 15);
    await page.evaluate(() => window.__proofReadingWalk.toggleLetterShortcuts());
    await page.keyboard.press('a'); await page.keyboard.press('j');
    assert.equal((await walk(page)).cursor, 15);
    assert.notEqual(await page.evaluate(() => window.__proofLineMarks.myStatus(15)), 'agreed');
    await page.evaluate(() => window.__proofReadingWalk.toggleLetterShortcuts());
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, isComposing: true })));
    assert.notEqual(await page.evaluate(() => window.__proofLineMarks.myStatus(15)), 'agreed');
    await page.locator('.prw-right .plm-choice[data-status="rejected"]').click();
    const reason = page.locator('.prw-right .plm-reason input').first();
    await reason.fill('arjke');
    assert.equal((await walk(page)).cursor, 15);
    assert.notEqual(await page.evaluate(() => window.__proofLineMarks.myStatus(15)), 'agreed');
    await page.evaluate(() => { document.activeElement?.blur(); window.proof.disableSuggestions(); });
    await page.keyboard.press('a'); await page.keyboard.press('j');
    assert.equal((await walk(page)).cursor, 15, 'direct Editing mode ran a letter shortcut');
    assert.notEqual(await page.evaluate(() => window.__proofLineMarks.myStatus(15)), 'agreed');
    await page.evaluate(() => window.proof.enableSuggestions());

  });
  await check(`${tag}: remote comment preserves folds, panels, focus and passage position`, async () => {
    await selectPassage(page, 15);
    await page.locator('.prw-right .plm-actions button').first().focus();
    const state = () => page.evaluate(() => {
      const lm = window.__proofLineMarks, w = window.__proofReadingWalk.debugState();
      return { cursor: w.cursor, top: lm.editorView().nodeDOM(lm.lineList()[15].pos).getBoundingClientRect().top,
        folded: window.__proofFolding.debugState().folded, rails: [document.body.classList.contains('prw-left-collapsed'), document.body.classList.contains('prw-right-collapsed'), w.marginTab],
        focused: document.activeElement?.outerHTML, selection: lm.editorView().state.selection.toJSON() };
    });
    const before = await state();
    const response = await fetch(`${base}/api/agent/${created.slug}/marks/comment`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-share-token': created.accessToken },
      body: JSON.stringify({ quote: 'Alpha paragraph 2', text: 'Remote review', by: 'ai:remote' }),
    });
    assert.ok(response.ok);
    const body = await response.json();
    await waitFor(page, id => window.proof.getAllMarks().some(m => m.id === id), body.markId);
    await page.waitForTimeout(300);
    const after = await state();
    assert.ok(Math.abs(after.top - before.top) <= 2, 'remote comment shifted the selected passage');
    assert.deepEqual({ ...after, top: 0 }, { ...before, top: 0 });
  });
  if (style === 'playmaker') await check(`${tag}: incoming review items preserve list order and keyboard focus`, async () => {
    await page.locator('.prw-left .anv-tab[data-tab="issues"]').click();
    const rows = page.locator('.pm-review-row');
    const before = await rows.evaluateAll(rows => rows.map(row => row.dataset.reviewRow));
    await rows.first().focus();
    await page.evaluate(() => { window.__s1FocusedRow = document.activeElement; });
    const response = await fetch(`${base}/api/agent/${created.slug}/marks/comment`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-share-token': created.accessToken },
      body: JSON.stringify({ quote: 'Intro paragraph', text: 'A new first-in-document item', by: 'ai:remote' }),
    });
    assert.ok(response.ok);
    const body = await response.json();
    await waitFor(page, id => window.proof.getAllMarks().some(mark => mark.id === id), body.markId);
    assert.equal(await page.evaluate(() => document.activeElement === window.__s1FocusedRow), true);
    await page.evaluate(() => document.activeElement.blur());
    await waitFor(page, id => !!document.querySelector(`[data-review-row="${id}"]`), body.markId);
    const after = await rows.evaluateAll(rows => rows.map(row => row.dataset.reviewRow));
    assert.deepEqual(after.slice(0, before.length), before, 'incoming item reordered the list');
    assert.equal(after.at(-1), body.markId, 'incoming item was not appended');
  });
  await check(`${tag}: remote height change and heading rename preserve selected position and disclosure`, async () => {
    await selectPassage(page, 15);
    await page.evaluate(() => window.scrollBy(0, -80));
    const top = () => page.evaluate(() => {
      const lm = window.__proofLineMarks;
      return lm.editorView().nodeDOM(lm.lineList()[15].pos).getBoundingClientRect().top;
    });
    const before = await top();
    const edit = async (operations) => {
      await agentEdit(base, created, operations, `s1-${Date.now()}-${Math.random()}`);
    };
    await edit([
      { op: 'replace_block', ref: 'b2', block: { markdown: 'Remote expanded introduction. '.repeat(45) } },
      { op: 'replace_block', ref: 'b10', block: { markdown: '## Beta renamed remotely' } },
    ]);
    await waitFor(page, () => window.__proofLineMarks.lineList()[9].text === 'Beta renamed remotely');
    await page.waitForTimeout(350);
    assert.equal((await walk(page)).cursor, 15);
    assert.ok(Math.abs(await top() - before) <= 2, 'remote edit shifted selected passage');
    assert.equal(await page.evaluate(() => window.__proofFolding.isFolded(9)), true, 'renaming a heading opened its section');
    await page.reload(); await ready(page);
    assert.equal(await page.evaluate(() => window.__proofFolding.isFolded(9)), true);
  });
  await check(`${tag}: a collapsed subsection must be shown before the section can be agreed`, async () => {
    await page.evaluate(() => window.__proofFolding.setFolded(6, true));
    await selectPassage(page, 2);
    const note = page.locator('.prw-right .plm-section-note');
    assert.equal(await note.textContent(), 'Show all 7 lines to agree with this section');
    await note.click();
    await waitFor(page, () => window.__proofFolding.isFolded(6) === false && window.__proofFolding.isFolded(2) === false);
    assert.equal(await note.textContent(), 'Agree with this section (7 lines)');
    assert.notEqual(await page.evaluate(() => window.__proofLineMarks.myStatus(8)), 'agreed', 'showing the lines agreed a hidden line');
  });
  await check(`${tag}: captured section agreement excludes a concurrent insertion`, async () => {
    await selectPassage(page, 14);
    await page.evaluate(() => {
      const action = document.querySelector('.prw-right .plm-section-note');
      window.__s1SectionAction = action;
    });
    await agentEdit(base, created, [
      { op: 'insert_after', ref: 'b16', blocks: [{ markdown: 'A newly inserted sentence is not consented to.' }] },
    ], `s1-scope-${Date.now()}-${Math.random()}`);
    await waitFor(page, () => window.__proofLineMarks.lineList().some(l => l.text.startsWith('A newly inserted')));
    await page.evaluate(() => window.__s1SectionAction.click());
    await waitFor(page, () => window.__proofLineMarks.myStatus(14) === 'agreed');
    const insertedStatus = await page.evaluate(() => {
      const lm = window.__proofLineMarks;
      return lm.myStatus(lm.lineList().find(l => l.text.startsWith('A newly inserted')).index);
    });
    assert.notEqual(insertedStatus, 'agreed');
  });
  await page.screenshot({ path: path.join(shots, `${tag}.png`) });
  await context.close();
}

async function phone(browser, base, style) {
  const created = await createDoc(base);
  const { context, page } = await openDoc(browser, base, created.slug, 'S1 Phone', {
    ...devices['iPhone 13'], viewport: { width: 375, height: 812 }, screen: { width: 375, height: 812 },
  });
  activePage = page;
  await check(`usability-s1-${style}-phone: tap disclosure and Agree keep hidden text out of scope`, async () => {
    await chip(page, 9).scrollIntoViewIfNeeded(); await chip(page, 9).tap();
    assert.equal(await chip(page, 9).getAttribute('aria-expanded'), 'false');
    await page.locator('.plm-dot[data-line="9"]').tap();
    const sheet = page.locator('.plm-menu.plm-sheet');
    await sheet.getByRole('button', { name: /^Agree$/ }).tap();
    await waitFor(page, () => window.__proofLineMarks.myStatus(9) === 'agreed');
    assert.notEqual(await page.evaluate(() => window.__proofLineMarks.myStatus(10)), 'agreed');
    assert.equal(await isHiddenLine(page, 9), false);
  });
  await check(`usability-s1-${style}-phone: scrolling accepts nothing and sections remain expanded`, async () => {
    await expandedStaysExpanded(page); await scrollAcceptsNothing(page);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  });
  await page.screenshot({ path: path.join(shots, `usability-s1-${style}-375.png`) });
  await context.close();
}

const browser = await chromium.launch();
try {
  for (const style of styles) {
    const { base, stop } = await startServer(style);
    try {
      for (const width of widths) await desktop(browser, base, style, width);
      await phone(browser, base, style);
    } finally {
      await stop();
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${results.length - failures}/${results.length} folding checks passed`);
process.exit(failures ? 1 : 0);
