#!/usr/bin/env node
// Browser check for Mike's 2026-09-21 report (Waiting on Mike Accord, items 1-5 and 7):
//   1. a click on a link opens it (new tab; a #heading link moves the focus line); no "Open link" card
//   2. the reading keys never type into the document: writing mode vs reading mode, every entry path
//   3. Reading makes no decisions. Explicit Accept and its Undo still use the accept bridge.
//   4. Incoming rail content offers New below without scrolling the list.
//   5. the rail and the text scroll independently (a wheel over the rail never scrolls the page)
//   7. the top bar is tight around its buttons (desktop and phone; phone targets stay >= 44 px)
// Authorship: Claude Opus 5 (worker proof-bugs6), 2026-09-21, in the style of hover-touch-check.mjs.
// Starts an isolated local server on the current dist/ build (run `npm run build` first) in both
// review styles, at 1440 and on a 390x844 phone. Screenshots go to .preview/ (or --shots <dir>).
// Exit 0 only if every check passes.
// Usage: node scripts/mike-0921-check.mjs [--style playmaker|proof] [--shots dir]
import assert from 'node:assert/strict';
import { selectPassage, hoverChangesNothing, scrollAcceptsNothing, explicitAcceptUndo, explicitRefusalPreservesText } from './usability-s1-assertions.mjs';

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

const clientHeaders = { 'X-Proof-Client-Version': '0.31.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `mike-0921-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-mike-0921-check-'));
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
// Line indexes (one top-level block per line).
const L = { H1: 0, LINKS: 3, TRIPLE: 8, DELTA: 12, END_HEAD: 16 };
const markdown = [
  '# Mike 0921 check',                                                                        // 0
  plain(1), plain(2),                                                                          // 1-2
  'Links: see [the example page](https://example.com/page) or [jump to the end](#the-end) and then read on.', // 3
  plain(4), plain(5), plain(6), plain(7),                                                      // 4-7
  'Three changes: the alpha word, the beta word and the gamma word all sit on this one line.', // 8
  plain(9), plain(10), plain(11),                                                              // 9-11
  'One more change sits here on the delta word.',                                              // 12
  plain(13), plain(14), plain(15),                                                             // 13-15
  '## The end',                                                                                // 16
  ...Array.from({ length: 10 }, (_, i) => plain(17 + i)),                                     // 17-26
].join('\n\n');

async function createDoc(base) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown, title: 'Mike 0921 check' }),
  });
  assert.equal(response.status, 200);
  const created = await response.json();
  const post = async (route, body) => {
    const r = await fetch(`${base}/api/agent/${created.slug}${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-share-token': created.accessToken },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    assert.ok(r.ok, `${route}: ${r.status} ${text}`);
    return JSON.parse(text || '{}');
  };
  for (const [quote, content] of [['alpha word', 'ALPHA word'], ['beta word', 'BETA word'], ['gamma word', 'GAMMA word'], ['delta word', 'DELTA word']]) {
    await post('/marks/suggest-replace', { quote, content, by: 'ai:check' });
  }
  return { ...created, post };
}

async function openDoc(browser, base, slug, name, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.addInitScript(viewer => {
    try { localStorage.setItem('proof-share-viewer-name', viewer); } catch {}
    // Links open in a new tab through window.open: record instead of opening.
    window.__opened = [];
    window.open = (url, target, features) => { window.__opened.push({ url: String(url), target, features }); return null; };
  }, name);
  const page = await context.newPage();
  await page.goto(`${base}/d/${slug}`);
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForFunction(() => window.__proofReadingWalk?.debugState().ready === true
    && (window.proof?.getAllMarks?.() ?? []).filter(m => m.data?.status === 'pending').length >= 4, null, { timeout: 10_000 });
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  page.setDefaultTimeout(6000);
  return { context, page };
}

const walk = page => page.evaluate(() => window.__proofReadingWalk.debugState());
const docText = page => page.evaluate(() => window.__proofLineMarks.editorView().state.doc.textContent);
const pendingIds = page => page.evaluate(() => (window.proof?.getAllMarks?.() ?? []).filter(m => m.data?.status === 'pending').map(m => m.id));
const block = (page, i) => page.locator('.ProseMirror > *').nth(i);
const waitFor = (page, fn, arg, timeout = 6000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
const myMarkOn = (page, i) => page.evaluate(i => window.__proofLineMarks.debugState().marks.find(m => m.by === window.__proofLineMarks.me() && m.anchor.ordinal === i)?.status ?? null, i);
const writing = page => page.evaluate(() => window.__proofReadingWalk.debugState().writing);

async function hoverLine(page, i) {
  const el = block(page, i);
  await el.evaluate(node => { const r = node.getBoundingClientRect(); if (r.top < 120 || r.bottom > innerHeight - 80) node.scrollIntoView({ block: 'center', behavior: 'instant' }); });
  await page.waitForTimeout(150);
  const box = await el.boundingBox();
  await page.mouse.move(box.x + box.width - 40, box.y + box.height / 2, { steps: 2 });
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2, { steps: 2 });
}
async function scrollLineIntoView(page, i) {
  await block(page, i).evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page.waitForTimeout(200);
}
/** Focus handed to the text by code (what a dialog or popover does when it closes). */
async function codeFocusesText(page, line) {
  await page.evaluate(i => {
    const view = window.__proofLineMarks.editorView();
    const l = window.__proofLineMarks.lineList()[i];
    view.focus();
    const { TextSelection } = window.__proofPm ?? {};
    if (TextSelection) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, l.pos + 2)));
    else {
      const dom = view.nodeDOM(l.pos); const range = document.createRange(); range.setStart(dom.firstChild ?? dom, 1); range.collapse(true);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
    }
  }, line);
  await page.waitForTimeout(80);
}

async function desktop(browser, base, style) {
  const created = await createDoc(base);
  const tag = `mike-0921-${style}-1440`;
  const { context, page } = await openDoc(browser, base, created.slug, 'Ada', { viewport: { width: 1440, height: 900 } });
  activePage = page;

  // ---- item 7: the top bar --------------------------------------------------------------------
  await check(`${tag}: item 7 — the top bar is tight around its buttons and the text starts just below it`, async () => {
    const info = await page.evaluate(() => {
      const bar = document.getElementById('share-banner').getBoundingClientRect();
      const buttons = [...document.querySelectorAll('#share-banner button, #share-banner a, #share-banner .share-pill-title')]
        .filter(e => e.getBoundingClientRect().width > 0).map(e => e.getBoundingClientRect());
      const first = document.querySelector('.ProseMirror > *').getBoundingClientRect();
      return { top: bar.top, h: bar.height, bottom: bar.bottom, tallest: Math.max(...buttons.map(b => b.height)), shortest: Math.min(...buttons.map(b => b.height)), firstTop: first.top };
    });
    // Accord layout stage 2: the toolbar sits right under the 28 px menu bar, which starts at 0.
    const menubar = await page.evaluate(() => document.getElementById('accord-menubar').getBoundingClientRect().toJSON());
    assert.equal(menubar.top, 0);
    assert.ok(Math.abs(info.top - menubar.bottom) <= 1, `bar top ${info.top}, menu bar bottom ${menubar.bottom}`);
    assert.ok(info.h <= 50, `bar height ${info.h} (was 82)`);
    assert.ok(info.h - info.tallest <= 12, `whitespace above+below the buttons ${info.h - info.tallest}`);
    assert.ok(info.shortest >= 28, `a button is ${info.shortest} px tall`);
    assert.ok(info.firstTop - info.bottom <= 30, `gap under the bar ${info.firstTop - info.bottom}`);
    await page.screenshot({ path: path.join(shots, `${tag}-topbar.png`), clip: { x: 0, y: 0, width: 1440, height: 220 } });
  });

  // ---- item 1: links --------------------------------------------------------------------------
  await check(`${tag}: item 1 — hovering a link shows no "Open link" card`, async () => {
    await scrollLineIntoView(page, L.LINKS);
    const link = page.locator('.ProseMirror a[href="https://example.com/page"]');
    await link.hover();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.markdown-link-action-card').count(), 0, 'the card exists');
    assert.equal(await page.getByRole('button', { name: /Open link/ }).count(), 0);
  });
  await check(`${tag}: hovering the link leaves the selected passage unchanged`, async () => {
    const before = (await walk(page)).cursor;
    await page.locator('.ProseMirror a[href]').first().hover();
    await page.waitForTimeout(350); assert.equal((await walk(page)).cursor, before);
  });
  await check(`${tag}: item 1 — a click on a link opens it in a new tab, places no caret and starts no writing`, async () => {
    await page.locator('.ProseMirror a[href="https://example.com/page"]').click();
    await waitFor(page, () => window.__opened.length === 1);
    const opened = await page.evaluate(() => window.__opened[0]);
    assert.equal(opened.url, 'https://example.com/page');
    assert.equal(opened.target, '_blank');
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest?.('.ProseMirror'))), false, 'the click put a caret in the text');
    assert.equal(await writing(page), false);
  });
  await check(`${tag}: item 1 — a #heading link moves the focus line to that heading, in this page`, async () => {
    await page.locator('.ProseMirror a[href="#the-end"]').click();
    await waitFor(page, i => window.__proofReadingWalk.debugState().focus === i, L.END_HEAD);
    assert.equal(await page.evaluate(() => window.__opened.length), 1, 'an in-page link opened a tab');
    const top = await block(page, L.END_HEAD).evaluate(n => n.getBoundingClientRect().top);
    assert.ok(top > 0 && top < 900, `heading not in view (${top})`);
  });
  await page.evaluate(() => document.querySelector('.share-pill-suggest-toggle').click());
  await check(`${tag}: item 1 — Alt/Option+click in direct Editing puts the caret in its words to edit them (nothing opens)`, async () => {
    await scrollLineIntoView(page, L.LINKS);
    const link = page.locator('.ProseMirror a[href="https://example.com/page"]');
    const box = await link.boundingBox();
    await page.keyboard.down('Alt');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.up('Alt');
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => window.__opened.length), 1, 'Alt+click opened the link');
    assert.equal(await writing(page), true, 'Alt+click did not start writing');
    await page.keyboard.type('Z');
    assert.ok((await docText(page)).includes('the exZample page') || /the ex[a-z]*Z[a-z]* page/.test(await docText(page)) || (await docText(page)).includes('Z'), 'typing did not go into the link');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Escape');
    assert.equal(await writing(page), true, 'Esc changed direct Editing');
    await page.evaluate(() => document.querySelector('.share-pill-suggest-toggle').click());
  });
  await check(`${tag}: item 1 — clicking beside a link selects the passage and leaves Reading on`, async () => {
    const box = await block(page, L.LINKS).boundingBox();
    await page.mouse.click(box.x + 12, box.y + 10);
    assert.equal(await writing(page), false);
    assert.equal((await walk(page)).focus, L.LINKS);
    assert.equal(await page.evaluate(() => window.__opened.length), 1);
  });

  // ---- item 2: the reading keys never type ----------------------------------------------------
  await check(`${tag}: item 2 — a click selects; S drafts; Esc keeps the draft; A never types into the document`, async () => {
    await scrollLineIntoView(page, 5);
    const box = await block(page, 5).boundingBox();
    await page.mouse.click(box.x + 60, box.y + 10);
    assert.equal(await writing(page), false);
    const before = await docText(page);
    await page.keyboard.press('s');
    await page.locator('.accord-draft textarea').fill('local asj draft');
    assert.equal(await docText(page), before);
    await page.keyboard.press('Escape');
    assert.equal(await writing(page), false);
    await page.locator('[data-draft-action="discard"]').click();
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('a');
    await waitFor(page, i => window.__proofLineMarks.debugState().marks.some(m => m.by === window.__proofLineMarks.me() && m.anchor.ordinal === i && m.status === 'agreed'), 5);
    assert.equal(await docText(page), before);
  });
  await check(`${tag}: item 2 — focus handed back to the text by code (a dialog closing) is reading: keys act, nothing types`, async () => {
    await codeFocusesText(page, 6);
    assert.equal(await writing(page), false, 'code focus counted as writing');
    const caret = await page.evaluate(() => getComputedStyle(document.querySelector('.ProseMirror')).caretColor);
    assert.match(caret, /rgba\(0, 0, 0, 0\)|transparent/, `a caret blinks while reading (${caret})`);
    const text = await docText(page);
    for (const key of ['x', 'z', 'y', 'n', 't', ' ', 'Backspace', 'Delete', '1', '2']) {
      await page.keyboard.press(key);
      await page.waitForTimeout(30);
      assert.equal(await docText(page), text, `"${key}" changed the text while reading`);
      // Accord round 2, stage D: T is a command that opens the thread composer in the Margin. It
      // still types nothing (which is what this loop tests); close it again before the next key.
      if (key === 't') { await page.keyboard.press('Escape'); await page.waitForTimeout(60); }
    }
    await selectPassage(page, 7);
    await page.waitForFunction(() => window.__proofReadingWalk.debugState().target === 7, null, { timeout: 2000 });
    await codeFocusesText(page, 6);
    await page.keyboard.press('a');
    await waitFor(page, () => window.__proofLineMarks.debugState().marks.some(m => m.by === window.__proofLineMarks.me() && m.anchor.ordinal === 7 && m.status === 'agreed'));
    assert.equal(await docText(page), text, 'A typed into the text');
    const routes = await page.evaluate(() => window.__proofReadingWalk && window.__proofEditingGuard?.().routes);
    if (routes) assert.ok(routes.some(r => r.key === 'a' && r.route === 'command'), JSON.stringify(routes.slice(-3)));
  });
  await check(`${tag}: item 2 — hover, scroll and blur keep direct Editing; letter keys outside the text do nothing`, async () => {
    await page.evaluate(() => document.querySelector('.share-pill-suggest-toggle').click());
    await scrollLineIntoView(page, 9);
    const box = await block(page, 9).boundingBox();
    await page.mouse.click(box.x + 60, box.y + 10);
    await page.keyboard.type('q'); await page.keyboard.press('Backspace');
    await page.waitForTimeout(4300);
    await hoverChangesNothing(page, 10);
    await page.evaluate(() => window.scrollBy(0, 1500)); await page.waitForTimeout(500);
    assert.equal(await writing(page), true, 'scroll left direct Editing');
    const before = await docText(page);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('a');
    assert.equal(await docText(page), before, 'a letter outside the text typed into the document');
    assert.equal(await writing(page), true, 'blur left direct Editing');
    await page.keyboard.press('Escape');
    assert.equal(await writing(page), true, 'Esc left direct Editing');
    await page.evaluate(() => document.querySelector('.share-pill-suggest-toggle').click());
  });
  await check(`${tag}: item 2 — after the rail takes the keyboard (a click in it), A is a command`, async () => {
    await scrollLineIntoView(page, 13);
    const box = await block(page, 13).boundingBox();
    await page.mouse.click(box.x + 60, box.y + 10);
    await page.waitForTimeout(120);
    assert.equal(await writing(page), false);
    // Accord layout stage 3: the Margin's Line tab (a control in the rail, not the text).
    await page.locator('.prw-right .amg-tab[data-tab="line"]').click();
    await page.waitForTimeout(100);
    assert.equal(await writing(page), false, 'a click in the rail did not return to reading');
    const text = await docText(page);
    const target = (await walk(page)).target;
    await page.keyboard.press('a');
    await waitFor(page, i => window.__proofLineMarks.debugState().marks.some(m => m.by === window.__proofLineMarks.me() && m.anchor.ordinal === i && m.status === 'agreed'), target);
    assert.equal(await docText(page), text);
  });
  await check(`${tag}: item 2 — a remote update does not change the mode: writing keeps typing, reading keeps acting`, async () => {
    await page.evaluate(() => document.querySelector('.share-pill-suggest-toggle').click());
    await scrollLineIntoView(page, 14);
    const box = await block(page, 14).boundingBox();
    await page.mouse.click(box.x + box.width - 30, box.y + 10);
    await page.waitForTimeout(120);
    await created.post('/marks/suggest-replace', { quote: 'Paragraph 24 is plain', content: 'Paragraph 24 is simple', by: 'ai:check' });
    await waitFor(page, () => (window.proof?.getAllMarks?.() ?? []).some(m => m.data?.status === 'pending' && /simple/.test(String(m.data?.content ?? ''))), null, 10_000);
    assert.equal(await writing(page), true, 'a remote update ended writing');
    const before = (await docText(page)).length;
    await page.keyboard.type('k');
    assert.equal((await docText(page)).length, before + 1, 'typing after a remote update did not type');
    await page.keyboard.press('Backspace');
    await page.evaluate(() => document.querySelector('.share-pill-suggest-toggle').click());
    await created.post('/marks/suggest-replace', { quote: 'Paragraph 25 is plain', content: 'Paragraph 25 is simple', by: 'ai:check' });
    await page.waitForTimeout(600);
    const text = await docText(page);
    const focus = (await walk(page)).focus;
    await page.keyboard.press('j');
    await page.waitForTimeout(100);
    assert.notEqual((await walk(page)).focus, focus, 'J did not move the focus');
    assert.equal(await docText(page), text, 'J typed into the text');
  });
  await check(`${tag}: item 2 — Enter never starts direct Editing; S opens a draft for the selected passage`, async () => {
    await page.evaluate(() => document.activeElement?.blur());
    const before = await docText(page);
    await page.keyboard.press('Enter');
    assert.equal(await writing(page), false);
    await page.keyboard.press('s');
    const field = page.locator('.accord-draft textarea');
    const original = await field.inputValue();
    await field.fill(`${original}!`);
    assert.equal(await docText(page), before);
    await page.locator('[data-draft-action="cancel"]').click();
    assert.match(await page.locator('.pst-bar .pst-mode').innerText(), /Reading/);
  });

  // ---- item 3: Save N accepted ---------------------------------------------------------------
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await check(`${tag}: scrolling records reading without a Save acceptance control`, async () => {
    await scrollAcceptsNothing(page);
  });
  await check(`${tag}: explicit Accept uses the decision bridge and one Undo restores it`, async () => {
    await explicitAcceptUndo(page, L.TRIPLE);
  });
  await check(`${tag}: a refused explicit Accept preserves the text and reports the error`, async () => {
    await explicitRefusalPreservesText(page, L.TRIPLE);
  });

  // ---- items 4 and 5: the rail and the chat scroll -------------------------------------------
  await check(`${tag}: item 5 — each rail list scrolls on its own and never hands the scroll to the page`, async () => {
    const css = await page.evaluate(() => ({
      body: getComputedStyle(document.querySelector('.prw-right .prw-rail-body')).overscrollBehaviorY,
      rail: getComputedStyle(document.querySelector('.prw-right')).overscrollBehaviorY,
    }));
    assert.equal(css.body, 'contain');
    assert.equal(css.rail, 'contain');
    const before = await page.evaluate(() => ({ y: scrollY, focus: window.__proofReadingWalk.debugState().focus }));
    const head = await page.locator('.prw-right .prw-rail-head').boundingBox();
    await page.mouse.move(head.x + 60, head.y + 10);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(400);
    const body = await page.locator('.prw-right .prw-rail-body').boundingBox();
    await page.mouse.move(body.x + 40, body.y + body.height - 20);
    for (let i = 0; i < 4; i += 1) { await page.mouse.wheel(0, 800); await page.waitForTimeout(60); }
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({ y: scrollY, focus: window.__proofReadingWalk.debugState().focus }));
    assert.equal(after.y, before.y, 'a wheel over the rail scrolled the page');
    assert.equal(after.focus, before.focus, 'a wheel over the rail moved the reading focus');
  });
  await check(`${tag}: incoming layout updates never scroll the rail`, async () => {
    await selectPassage(page, L.TRIPLE);
    const before = await page.locator('.prw-right .prw-rail-body').evaluate(n => n.scrollTop);
    await page.evaluate(() => window.__proofReadingWalk.notifyViewUpdate()); await page.waitForTimeout(200);
    assert.equal(await page.locator('.prw-right .prw-rail-body').evaluate(n => n.scrollTop), before);
  });
  await check(`${tag}: item 4 — a rail the person scrolled up in stays put and offers "New below ↓"`, async () => {
    const railBody = page.locator('.prw-right .prw-rail-body');
    const b = await railBody.boundingBox();
    await page.mouse.move(b.x + 40, b.y + 40);
    await page.mouse.wheel(0, -2000);
    await page.waitForTimeout(250);
    const top = await railBody.evaluate(n => n.scrollTop);
    await selectPassage(page, L.TRIPLE);
    await page.waitForFunction(i => window.__proofReadingWalk.debugState().target === i, L.TRIPLE, { timeout: 2000 });
    await page.waitForTimeout(200);
    const s = (await walk(page)).rail;
    // The rail must never move under the person, whatever it holds.
    assert.equal(await railBody.evaluate(n => n.scrollTop), top, 'the rail moved under the person');
    // The pill is offered only when the person is actually ABOVE what the rail follows. (Accord
    // round 2, stage D added the Discussion section to the rail body, so the body can be taller
    // than its viewport while the focus line's box is still fully above the person's scroll
    // position; height alone was never the precondition — distance from the target is.)
    if (s.scrollHeight > s.clientHeight + 30 && s.target - s.scrollTop > 24) {
      const pill = page.locator('.prw-right .prw-follow-pill[data-follow="rail"]');
      await pill.waitFor({ state: 'visible', timeout: 2000 });
      await page.screenshot({ path: path.join(shots, `${tag}-rail-pill.png`), clip: { x: 1080, y: 0, width: 360, height: 900 } });
      await pill.click();
      await page.waitForTimeout(150);
      const after = (await walk(page)).rail;
      assert.equal(after.following, true);
      assert.ok(Math.abs(after.scrollTop - after.target) <= 2, JSON.stringify(after));
      assert.equal(await pill.isVisible(), false);
    } else {
      // At or above what it follows: the rail is following and there is nothing new below.
      assert.equal(s.following, true, `the rail is not following at its target ${JSON.stringify(s)}`);
      assert.equal(await page.locator('.prw-right .prw-follow-pill[data-follow="rail"]').isVisible(), false);
    }
  });
  await check(`${tag}: incoming chat stays put; the reader can choose "New below ↓"`, async () => {
    // Filler to make the Room scroll. These are about no line: Accord round 2, stage D moves talk
    // about a line into the document, so line-pointed messages are folded away in the Room and
    // would not fill it. What this check tests — following the end, and the "New below" pill — is
    // about the Room's own messages either way.
    for (let i = 1; i <= 14; i += 1) await created.post('/chat', { by: 'ai:check', text: `Message ${i}: a line of chat long enough to take some room in the rail.` });
    await page.evaluate(() => window.__proofChat?.notifyRemoteChange());
    await waitFor(page, () => (window.__proofChat?.debugState().messages.length ?? 0) >= 14, null, 12_000);
    await page.waitForTimeout(300);
    const list = page.locator('.prw-right .pch-list');
    // Accord layout stage 3 (decision 6): the chat is the Margin's Room tab.
    if (!(await list.isVisible())) await page.locator('.prw-right .amg-tab[data-tab="room"]').click();
    await page.waitForTimeout(300);
    let f = (await page.evaluate(() => window.__proofChat.debugState().follow));
    assert.ok(f.scrollHeight - f.clientHeight - f.scrollTop > 2, 'incoming messages automatically scrolled the chat');
    await page.locator('.prw-right .prw-follow-pill[data-follow="chat"]').click();
    f = await page.evaluate(() => window.__proofChat.debugState().follow);
    assert.ok(f.scrollHeight - f.clientHeight - f.scrollTop <= 2, 'explicit New below did not scroll');
    const lb = await list.boundingBox();
    await page.mouse.move(lb.x + 30, lb.y + 30);
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(250);
    const y = await page.evaluate(() => scrollY);
    const top = await list.evaluate(n => n.scrollTop);
    await created.post('/chat', { by: 'ai:check', text: 'Message 15: arrives while the person reads older ones.' });
    await page.evaluate(() => window.__proofChat?.notifyRemoteChange());
    await waitFor(page, () => window.__proofChat.debugState().messages.length >= 15, null, 12_000);
    await page.waitForTimeout(300);
    assert.equal(await list.evaluate(n => n.scrollTop), top, 'the chat moved under the person');
    const pill = page.locator('.prw-right .prw-follow-pill[data-follow="chat"]');
    await pill.waitFor({ state: 'visible', timeout: 2000 });
    await page.screenshot({ path: path.join(shots, `${tag}-chat-pill.png`), clip: { x: 1080, y: 300, width: 360, height: 600 } });
    await pill.click();
    await page.waitForTimeout(150);
    f = await page.evaluate(() => window.__proofChat.debugState().follow);
    assert.ok(f.scrollHeight - f.clientHeight - f.scrollTop <= 2, 'the pill did not go to the newest');
    // A wheel over the chat at its end never scrolls the page.
    await page.mouse.move(lb.x + 30, lb.y + 30);
    for (let i = 0; i < 3; i += 1) { await page.mouse.wheel(0, 900); await page.waitForTimeout(60); }
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => scrollY), y, 'a wheel over the chat scrolled the page');
  });
  await check(`${tag}: scrolling the text does not change the selected passage or rail scroll`, async () => {
    const before = (await walk(page)).cursor;
    const top = await page.locator('.prw-right .prw-rail-body').evaluate(n => n.scrollTop);
    await page.evaluate(() => window.scrollBy(0, 350)); await page.waitForTimeout(300);
    assert.equal((await walk(page)).cursor, before);
    assert.equal(await page.locator('.prw-right .prw-rail-body').evaluate(n => n.scrollTop), top);
  });
  await context.close();
}

async function phone(browser, base, style) {
  const created = await createDoc(base);
  const viewport = { width: 390, height: 844 };
  const tag = `mike-0921-${style}-phone-390x844`;
  const { context, page } = await openDoc(browser, base, created.slug, 'Pat', {
    ...devices['iPhone 13'], viewport, screen: viewport, hasTouch: true, isMobile: true,
  });
  activePage = page;
  await check(`${tag}: item 7 — the phone bar is tight, every control stays >= 44 px, and the text starts just below`, async () => {
    const info = await page.evaluate(() => {
      const bar = document.getElementById('share-banner').getBoundingClientRect();
      const controls = [...document.querySelectorAll('#share-banner button, #share-banner a')]
        .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && getComputedStyle(e).visibility !== 'hidden'; })
        .map(e => ({ c: e.className, h: e.getBoundingClientRect().height }));
      const first = document.querySelector('.ProseMirror > *').getBoundingClientRect();
      return { h: bar.height, top: bar.top, bottom: bar.bottom, controls, firstTop: first.top };
    });
    assert.equal(info.top, 0);
    assert.ok(info.h <= 50, `bar height ${info.h} (was 52)`);
    for (const c of info.controls) assert.ok(c.h >= 44, `${c.c} is ${c.h} px tall`);
    assert.ok(info.firstTop - info.bottom <= 24, `gap under the bar ${info.firstTop - info.bottom}`);
    await page.screenshot({ path: path.join(shots, `${tag}-topbar.png`), clip: { x: 0, y: 0, width: 390, height: 200 } });
  });
  await check(`${tag}: item 1 — a tap on a link opens it; no card`, async () => {
    await scrollLineIntoView(page, L.LINKS);
    await page.locator('.ProseMirror a[href="https://example.com/page"]').tap();
    await waitFor(page, () => window.__opened.length === 1);
    assert.equal(await page.locator('.markdown-link-action-card').count(), 0);
    assert.equal(await writing(page), false);
  });
  await check(`${tag}: item 2 — a tap selects the passage; focus handed over by code keeps Reading (nothing types)`, async () => {
    await scrollLineIntoView(page, 5);
    const box = await block(page, 5).boundingBox();
    await page.touchscreen.tap(box.x + 60, box.y + 10);
    await page.waitForTimeout(200);
    assert.equal(await writing(page), false, 'a tap started direct Editing');
    assert.equal((await walk(page)).focus, 5);
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(50);
    await codeFocusesText(page, 6);
    assert.equal(await writing(page), false);
    const text = await docText(page);
    for (const key of ['a', 'x', 'j']) { await page.keyboard.press(key); await page.waitForTimeout(40); }
    assert.equal(await docText(page), text, 'a key typed while reading');
  });
  await context.close();
}

const browser = await chromium.launch();
try {
  for (const style of styles) {
    const { base, stop } = await startServer(style);
    try {
      await desktop(browser, base, style);
      await phone(browser, base, style);
    } finally {
      await stop();
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${results.length - failures}/${results.length} mike-0921 checks passed`);
process.exit(failures ? 1 : 0);
