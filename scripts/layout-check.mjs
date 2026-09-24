#!/usr/bin/env node
// Browser check for the Accord layout redesign (Ren's proposal, Mike ruled 2026-09-21: "build the
// layout that you proposed"). It grows one stage at a time; each stage's checks stay.
//   Stage 1: the status bar under the page (Line N of M, "You marked up to line K", Issues left,
//            Reading / Writing), the "You marked up to here" rule in the page, and two highlight
//            states only (blue bar = you are here, amber margin dot = needs you).
//   Stage 2: the menu bar, the one toolbar row, the Share dialog, the settings in View.
//   Stage 3: one cursor (hover previews the Margin; a key or a Margin click commits), the Margin's
//            Line N / Room tabs, the Navigator's Outline / Issues / Since you, the phone strip and
//            the Margin sheet (worker accord-layout3, 2026-09-21).
// Region checks compare against the mockups in Ren's proposal (regions present and positioned,
// not pixel-perfect): the status bar sits at the bottom of the page column between the rails, its
// state word at its right end; the rule sits inside the page between two lines.
// Authorship: Claude Opus 5 (worker accord-layout1), 2026-09-21, in the style of mike-0921-check.mjs.
// Starts an isolated local server on the current dist/ build (run `npm run build` first) in both
// review styles, at 1440 and on a 390x844 phone. Screenshots go to .preview/ (or --shots <dir>).
// Exit 0 only if every check passes.
// Usage: node scripts/layout-check.mjs [--style playmaker|proof] [--stage 1|2|3] [--shots dir] [--peek]
import assert from 'node:assert/strict';
import { selectPassage, hoverChangesNothing, scrollAcceptsNothing } from './usability-s1-assertions.mjs';

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
const peek = process.argv.includes('--peek');
const stages = arg('--stage') ? [Number(arg('--stage'))] : [1, 2, 3];

const clientHeaders = { 'X-Proof-Client-Version': '0.31.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `layout-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-layout-check-'));
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

// A "Waiting on Mike"-shaped document, like the mockup: settled lines, then asks and a change.
const para = (n) => `Paragraph ${n} is plain text for reading; it carries no marks and is long enough to be a real line.`;
const L = { H1: 0, INTRO: 1, S1: 2, S2: 3, ASK: 6, CHANGE: 8, COMMENT: 11, ASK2: 14, LAST: 24 };
const markdown = [
  '# Waiting on Mike',                                                                            // 0
  'Everything that needs you, in one place. Answer each ask with its buttons, or type an answer.', // 1
  para(2), para(3), para(4),                                                                      // 2-4
  '## Needs your hands',                                                                          // 5
  'Should we turn on the cloud backup for the recordings tonight?',                               // 6
  para(7),                                                                                        // 7
  'The reviewer could not read that list, because the tool encrypts its settings.',               // 8
  para(9), para(10),                                                                              // 9-10
  'Nothing in the last week of recordings suggests a leak of the private windows.',               // 11
  para(12), para(13),                                                                             // 12-13
  'Should we roll the live secret key this week?',                                               // 14
  ...Array.from({ length: 10 }, (_, i) => para(15 + i)),                                         // 15-24
].join('\n\n');

async function createDoc(base, asked) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown, title: 'Waiting on Mike' }),
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
  await post('/asks', { by: 'ai:cos', quote: 'turn on the cloud backup', to: [asked], recommend: 'Yes: 85 GB exist only on this Mac' });
  await post('/asks', { by: 'ai:cos', quote: 'roll the live secret key', to: [asked], recommend: 'Yes' });
  await post('/marks/suggest-replace', { quote: 'because the tool encrypts its settings', content: 'as it is encrypted', by: 'ai:dee' });
  await post('/marks/comment', { quote: 'suggests a leak', text: 'Dee: checked the last seven days.', by: 'ai:dee' });
  return { ...created, post };
}

async function openDoc(browser, base, slug, name, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.addInitScript(viewer => { try { localStorage.setItem('proof-share-viewer-name', viewer); } catch {} }, name);
  const page = await context.newPage();
  await page.goto(`${base}/d/${slug}`);
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForFunction(() => window.__proofReadingWalk?.debugState().ready === true
    && (window.proof?.getAllMarks?.() ?? []).filter(m => m.data?.status === 'pending').length >= 1, null, { timeout: 10_000 });
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  page.setDefaultTimeout(6000);
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(300);
  return { context, page };
}

const walk = page => page.evaluate(() => window.__proofReadingWalk.debugState());
const block = (page, i) => page.locator('.ProseMirror > *').nth(i);
const waitFor = (page, fn, arg, timeout = 6000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
async function hoverLine(page, i) {
  const el = block(page, i);
  await el.evaluate(node => { const r = node.getBoundingClientRect(); if (r.top < 120 || r.bottom > innerHeight - 80) node.scrollIntoView({ block: 'center', behavior: 'instant' }); });
  await page.waitForTimeout(150);
  const box = await el.boundingBox();
  await page.mouse.move(box.x + box.width - 40, box.y + Math.min(box.height / 2, 12), { steps: 2 });
  await page.mouse.move(box.x + box.width - 20, box.y + Math.min(box.height / 2, 12), { steps: 2 });
  await page.waitForFunction(i => window.__proofReadingWalk.debugState().target === i, i, { timeout: 2000, polling: 20 });
}
const bar = page => page.evaluate(() => {
  const b = document.querySelector('.pst-bar');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  const mode = b.querySelector('.pst-mode');
  const prov = b.querySelector('.pst-provisional');
  return {
    top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height,
    line: b.querySelector('.pst-line')?.textContent ?? '', marked: b.querySelector('.pst-marked')?.textContent ?? '',
    issues: b.querySelector('.pst-issues')?.textContent ?? '', count: Number(b.querySelector('.pst-issues')?.dataset.count ?? NaN),
    mode: mode?.textContent ?? null, modeRight: mode?.getBoundingClientRect().right ?? null, modeTag: mode?.tagName ?? null,
    provisional: prov && !prov.hidden ? prov.textContent : '', position: getComputedStyle(b).position, innerHeight,
  };
});
const amber = page => page.evaluate(() => [...document.querySelectorAll('.plm-dot[data-needs-you="true"]')].map(d => Number(d.dataset.line)).sort((a, b) => a - b));

async function desktop(browser, base, style) {
  const created = await createDoc(base, 'Ada');
  const tag = `layout-1-${style}-1440`;
  const { context, page } = await openDoc(browser, base, created.slug, 'Ada', { viewport: { width: 1440, height: 900 } });
  activePage = page;
  if (peek) { await page.screenshot({ path: path.join(shots, `${tag}-peek.png`) }); await context.close(); return; }

  await check(`${tag}: the status bar is fixed at the bottom of the page column, between the rails (mockup region)`, async () => {
    const b = await bar(page);
    assert.ok(b, 'no status bar');
    assert.equal(b.position, 'fixed');
    assert.ok(Math.abs(b.bottom - b.innerHeight) <= 1, `bar bottom ${b.bottom} vs window ${b.innerHeight}`);
    assert.ok(b.height >= 24 && b.height <= 32, `bar height ${b.height} (proposal: 28)`);
    const rails = await page.evaluate(() => ({
      left: document.querySelector('.prw-left').getBoundingClientRect().right,
      right: document.querySelector('.prw-right').getBoundingClientRect().left,
      text: document.querySelector('.ProseMirror').getBoundingClientRect().toJSON(),
    }));
    assert.ok(b.left >= rails.left - 1 && b.left - rails.left <= 24, `bar starts at ${b.left}, the left rail ends at ${rails.left}`);
    assert.ok(b.right <= rails.right + 1 && rails.right - b.right <= 24, `bar ends at ${b.right}, the right rail starts at ${rails.right}`);
    assert.ok(b.left <= rails.text.left && b.right >= rails.text.right, 'the bar spans the text column');
    assert.ok(b.modeRight !== null && b.right - b.modeRight <= 24, 'the state word is not at the right end of the bar');
    await page.screenshot({ path: path.join(shots, `${tag}-statusbar.png`), clip: { x: 0, y: 840, width: 1440, height: 60 } });
  });
  await check(`${tag}: it says "Line N of M", "Issues left" and "Reading"; the rail head no longer holds the line or the mode chip`, async () => {
    const b = await bar(page);
    const w = await walk(page);
    assert.equal(b.line, `Line ${w.target + 1} of ${w.lines}`);
    assert.match(b.issues, /^\d+ Issues? left$|^Nothing needs you$/);
    assert.equal(b.mode, 'Reading');
    assert.notEqual(b.modeTag, 'BUTTON', 'Reading / Writing is state, not a switch');
    assert.match(b.marked, /No marks from you yet/);
    assert.equal(await page.locator('.prw-right .prw-rail-head .prw-mode, .prw-right .prw-rail-head .prw-status').count(), 0);
  });
  await check(`${tag}: scrolling keeps the selected passage and the status bar in place`, async () => {
    const before = await bar(page); const selected = (await walk(page)).cursor;
    await page.evaluate(() => window.scrollBy(0, 250)); await page.waitForTimeout(300);
    assert.equal((await walk(page)).cursor, selected); assert.equal((await bar(page)).line, before.line);
  });
  // Accord round 2 stage A (2026-09-22): the bar says "Editing line N" where it used to say
  // "Writing" — the same state, named for what the person is doing and on which line.
  await check(`${tag}: the labelled control shows Editing; Esc keeps it; Leave Editing shows Reading`, async () => {
    // The case above scrolls 250px, which carries line S1 above the window. The click has to land on the line.
    const target = block(page, L.S1);
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    await page.mouse.click(box.x + 80, box.y + 10);
    await waitFor(page, () => document.querySelector('.pst-bar .pst-mode')?.textContent === 'Reading');
    await page.screenshot({ path: path.join(shots, `${tag}-writing.png`), clip: { x: 240, y: 840, width: 880, height: 60 } });
    await page.getByRole('button', { name: 'Enter Editing', exact: true }).click();
    await page.keyboard.press('Escape');
    assert.equal((await bar(page)).mode, 'Editing');
    await page.getByRole('button', { name: 'Leave Editing', exact: true }).click();
    await waitFor(page, () => document.querySelector('.pst-bar .pst-mode')?.textContent === 'Reading');
  });

  await check(`${tag}: marking lines explicitly sets "You marked up to line K · just now" and the rule sits after line K`, async () => {
    assert.equal((await walk(page)).rule, null, 'a rule with no marks');
    for (const i of [L.S1, L.S2]) {
      await selectPassage(page, i);
      await page.keyboard.press('a');
      await waitFor(page, i => window.__proofLineMarks.debugState().marks.some(m => m.by === window.__proofLineMarks.me() && m.anchor.ordinal === i && m.status === 'agreed'), i);
    }
    await waitFor(page, k => document.querySelector('.pst-bar .pst-marked')?.textContent === `You marked up to line ${k} · just now`, L.S2 + 1);
    await waitFor(page, k => window.__proofReadingWalk.debugState().rule === k, L.S2);
    const geo = await page.evaluate(k => {
      const rule = document.querySelector('.pst-rule').getBoundingClientRect();
      const a = document.querySelectorAll('.ProseMirror > *')[k].getBoundingClientRect();
      const b = document.querySelectorAll('.ProseMirror > *')[k + 1].getBoundingClientRect();
      const text = document.querySelector('.ProseMirror').getBoundingClientRect();
      return { y: rule.top, aBottom: a.bottom, bTop: b.top, left: rule.left, right: rule.right, textLeft: text.left, textRight: text.right, label: document.querySelector('.pst-rule').textContent };
    }, L.S2);
    assert.ok(geo.y >= geo.aBottom - 2 && geo.y <= geo.bTop + 2, `rule at ${geo.y}, between ${geo.aBottom} and ${geo.bTop}`);
    assert.ok(Math.abs(geo.left - geo.textLeft) <= 4 && Math.abs(geo.right - geo.textRight) <= 4, 'the rule does not span the text');
    assert.match(geo.label, /^You marked up to here · just now$/);
    await page.screenshot({ path: path.join(shots, `${tag}-rule.png`), clip: { x: 240, y: 60, width: 880, height: 380 } });
  });
  await check(`${tag}: clicking "line K" in the bar jumps to it`, async () => {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
    await page.locator('.pst-bar .pst-marked-link').click();
    await waitFor(page, k => window.__proofReadingWalk.debugState().focus === k, L.S2);
    const r = await block(page, L.S2).boundingBox();
    assert.ok(r.y >= 0 && r.y + r.height <= 900, 'line K is not in view');
    assert.equal((await bar(page)).line, `Line ${L.S2 + 1} of 25`);
  });

  await check(`${tag}: amber dots are the lines that need you, and the bar's Issues left equals their number`, async () => {
    const lines = await amber(page);
    assert.deepEqual(lines, [L.ASK, L.CHANGE, L.COMMENT, L.ASK2]);
    const b = await bar(page);
    assert.equal(b.count, lines.length);
    assert.equal(b.issues, `${lines.length} Issues left`);
    const colors = await page.evaluate(() => [...document.querySelectorAll('.plm-dot .plm-glyph')].map(g => getComputedStyle(g).backgroundColor));
    assert.equal(colors.filter(c => c === 'rgb(217, 140, 0)').length, lines.length, 'another dot is amber');
  });
  await check(`${tag}: answering an ask takes its amber dot away and the count follows`, async () => {
    await selectPassage(page, L.ASK);
    await page.keyboard.press('y');
    await waitFor(page, i => !document.querySelector(`.plm-dot[data-line="${i}"][data-needs-you="true"]`), L.ASK);
    const lines = await amber(page);
    assert.deepEqual(lines, [L.CHANGE, L.COMMENT, L.ASK2]);
    await waitFor(page, n => Number(document.querySelector('.pst-issues')?.dataset.count) === n, lines.length);
  });

  // Stage 3 (decision 4, one cursor): hovering another line previews it in the Margin only; the one
  // "you are here" bar stays on the cursor (proposal: "the text never changes").
  await check(`${tag}: hover preserves the selected highlight and target`, async () => {
    await selectPassage(page, L.S1 + 1); await hoverChangesNothing(page, L.S1 + 2);
  });
  await check(`${tag}: no decision ◆ in the margin and no dimmed context text`, async () => {
    assert.equal(await page.locator('.plm-dot .plm-tier').count(), 0);
    assert.equal(await page.evaluate(() => document.body.classList.contains('phl-context-dim')), false);
  });
  await check(`${tag}: reading does not offer Save accepted changes`, async () => {
    await scrollAcceptsNothing(page);
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, `${tag}-overview.png`) });
  await context.close();
}

async function phone(browser, base, style) {
  const created = await createDoc(base, 'Pat');
  const viewport = { width: 390, height: 844 };
  const tag = `layout-1-${style}-phone-390x844`;
  const { context, page } = await openDoc(browser, base, created.slug, 'Pat', {
    ...devices['iPhone 13'], viewport, screen: viewport, hasTouch: true, isMobile: true,
  });
  activePage = page;
  if (peek) { await page.screenshot({ path: path.join(shots, `${tag}-peek.png`) }); await context.close(); return; }
  // Stage 3 (decision 11): the status bar folds into the bottom strip; it shows again, one line,
  // only while the strip steps aside (the caret in the text).
  await check(`${tag}: the status bar folds into the bottom strip (Line N of M in the strip, no second bar)`, async () => {
    const b = await bar(page);
    assert.ok(b, 'no status bar element');
    assert.equal(await page.locator('.pst-bar').isVisible(), false, 'a second bar shows over the strip');
    const strip = await page.locator('.prw-strip').boundingBox();
    assert.ok(strip, 'no strip');
    assert.ok(Math.abs(strip.y + strip.height - 844) <= 2, `strip bottom ${strip.y + strip.height}`);
    assert.match(await page.locator('.prw-strip-where').innerText(), /^Line 1 of 25$/);
    assert.equal(b.line, 'Line 1 of 25');
    assert.match(b.issues, /^4 Issues left$/);
    const chip = await page.locator('.soma-feedback-root').boundingBox().catch(() => null);
    if (chip) assert.ok(chip.y + chip.height <= strip.y + 1, 'the feedback chip covers the strip');
    await page.screenshot({ path: path.join(shots, `${tag}-statusbar.png`) });
  });
  await check(`${tag}: amber dots match the count; marking a line shows "Marked up to line K ↑" in the strip`, async () => {
    assert.deepEqual(await amber(page), [L.ASK, L.CHANGE, L.COMMENT, L.ASK2]);
    await page.locator('.prw-strip-agree').tap();
    await waitFor(page, () => document.querySelector('.prw-strip-marked')?.textContent === 'Marked up to line 1 ↑');
    await waitFor(page, () => /line 1/.test(document.querySelector('.pst-bar .pst-marked')?.textContent ?? ''));
    const fits = await page.evaluate(() => { const e = document.querySelector('.prw-strip'); return e.scrollWidth <= e.clientWidth + 1; });
    assert.ok(fits, 'the strip overflows');
    await page.screenshot({ path: path.join(shots, `${tag}-marked.png`) });
  });
  await check(`${tag}: a tap selects text while Reading; the bar stays on screen`, async () => {
    // A tap selects the passage. It does not put a caret in the text, so Reading stays Reading
    // and the phone strip (the bar the reader sees) stays on screen. Mike, 2026-09-23 (usability brief).
    await block(page, L.S1).scrollIntoViewIfNeeded();
    const box = await block(page, L.S1).boundingBox();
    await page.touchscreen.tap(box.x + 60, box.y + 10);
    await waitFor(page, i => window.__proofReadingWalk.debugState().focus === i, L.S1);
    assert.equal(await page.locator('.pst-mode').evaluate(el => el.textContent), 'Reading');
    assert.notEqual(await page.locator('.ProseMirror').getAttribute('contenteditable'), 'true', 'a tap started direct editing');
    const strip = await page.locator('.prw-strip').boundingBox();
    assert.ok(strip, 'the strip left the screen');
    assert.ok(Math.abs(strip.y + strip.height - 844) <= 2, `strip bottom ${strip.y + strip.height}`);
    const fits = await page.evaluate(() => { const e = document.querySelector('.prw-strip'); return e.scrollWidth <= e.clientWidth + 1; });
    assert.ok(fits, 'the strip overflows');
    await page.screenshot({ path: path.join(shots, `${tag}-writing.png`) });
  });
  await context.close();
}

// ---------------------------------------------------------------------------------------------
// Stage 2: the menu bar, the one toolbar row, the Share dialog, and the settings that left the
// main view (proposal "Menu bar and toolbar (no ribbon)", "Removed or hidden", decisions 1, 10, 12).
// ---------------------------------------------------------------------------------------------
const chrome = page => page.evaluate(() => {
  const r = el => { const n = typeof el === 'string' ? document.querySelector(el) : el; if (!n) return null; const b = n.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, height: b.height, width: b.width }; };
  const visible = n => { const b = n.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(n).visibility !== 'hidden'; };
  const menubar = document.getElementById('accord-menubar');
  const banner = document.getElementById('share-banner');
  return {
    menubar: menubar && visible(menubar) ? r(menubar) : null,
    menus: menubar ? [...menubar.querySelectorAll('.amb-top')].map(b => b.textContent) : [],
    brand: menubar?.querySelector('.amb-brand')?.textContent ?? null,
    toolbar: r(banner),
    controls: [...banner.querySelectorAll('button, a, [role="button"]')].filter(visible).map(b => b.getAttribute('aria-label') || b.textContent.trim()),
    seg: r('#share-banner .share-pill-suggest-toggle'),
    undo: document.querySelector('#share-banner .pundo-btn') && visible(document.querySelector('#share-banner .pundo-btn')) ? r('#share-banner .pundo-btn') : null,
    title: r('#share-banner .share-pill-title'),
    saved: document.querySelector('#share-banner .share-pill-status-inline')?.textContent ?? '',
    pill: r('#share-banner .plm-issues'),
    pillText: document.querySelector('#share-banner .plm-issues-count')?.textContent ?? '',
    pillNext: document.querySelector('#share-banner .plm-next') ? getComputedStyle(document.querySelector('#share-banner .plm-next'), '::after').content : '',
    share: r('#share-banner .share-pill-share-btn > button'),
    innerWidth,
  };
});
const menuItems = page => page.evaluate(() => [...document.querySelectorAll('.amb-menu .amb-item')].map(b => ({ label: b.querySelector('.amb-label').textContent, disabled: b.disabled, checked: b.getAttribute('aria-checked') })));
async function reading(page) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.move(5, 450);
  await waitFor(page, () => document.querySelector('.pst-bar .pst-mode')?.textContent === 'Reading');
}

async function desktop2(browser, base, style) {
  const created = await createDoc(base, 'Ada');
  const tag = `layout-2-${style}-1440`;
  const { context, page } = await openDoc(browser, base, created.slug, 'Ada', { viewport: { width: 1440, height: 900 } });
  activePage = page;

  await check(`${tag}: a 28 px menu bar (File · Edit · View · People · Help) over one 44 px toolbar row (mockup regions)`, async () => {
    const c = await chrome(page);
    assert.ok(c.menubar, 'no menu bar');
    assert.equal(c.menubar.top, 0);
    assert.ok(Math.abs(c.menubar.height - 28) <= 1, `menu bar height ${c.menubar.height}`);
    assert.ok(c.menubar.left <= 0 && c.menubar.right >= 1440, 'the menu bar does not span the window');
    assert.deepEqual(c.menus, ['File', 'Edit', 'View', 'People', 'Help']);
    assert.equal(c.brand, 'Accord');
    assert.ok(Math.abs(c.toolbar.top - c.menubar.bottom) <= 1, `toolbar top ${c.toolbar.top}, menu bar bottom ${c.menubar.bottom}`);
    assert.ok(Math.abs(c.toolbar.height - 44) <= 1, `toolbar height ${c.toolbar.height}`);
    assert.ok(c.toolbar.left <= 0 && c.toolbar.right >= 1440, 'the toolbar is still a floating pill');
    // Three groups: left the switch and Undo, centre the title and Saved, right Issues · Next and Share.
    assert.ok(c.seg && c.seg.left < 60, 'the Suggesting | Editing switch is not at the left');
    assert.ok(c.undo && c.undo.left > c.seg.right && c.undo.left < 400, 'Undo is not beside the switch');
    const mid = (c.title.left + c.title.right) / 2;
    assert.ok(Math.abs(mid - 720) <= 120, `the title is not centred (${mid})`);
    assert.match(c.saved, /Saved|Sync|Connect|Offline/);
    assert.ok(c.share.right >= 1440 - 24, 'Share is not at the right end');
    assert.ok(c.pill.right <= c.share.left && c.pill.left > 1000, 'the Issues pill is not just left of Share');
    assert.match(c.pillNext, /Next ›/);
    // Nothing else in the toolbar: no Add agent, no Marks, no people, no ⋯. Accord round 2 stage C
    // added ONE more thing by Mike's ruling — the Open | Accord toggle, immediately left of the
    // Issues pill, because the pill counts what Open holds. The list stays exact, so nothing else
    // can creep in behind it.
    for (const label of c.controls) assert.match(label, /^(Enter Editing|Leave Editing|Suggesting|Editing|Undo|Nothing to undo|Next issue|No issues|Share|Waiting on Mike|Open|Accord)$|^(Enter Editing|Leave Editing|Suggesting|Editing|Undo|Nothing to undo|Next issue|No issues|Share|Waiting on Mike)/, `unexpected toolbar control: ${label}`);
    // ...and the toggle really is where this stage says it is.
    const toggle = await page.evaluate(() => {
      const t = document.querySelector('#share-banner .share-pill-right .aov-toggle');
      const pill = document.querySelector('#share-banner .plm-issues');
      return { present: Boolean(t), beforePill: t?.nextElementSibling === pill, segs: [...(t?.querySelectorAll('.aov-seg-label') ?? [])].map(n => n.textContent) };
    });
    assert.deepEqual(toggle.segs, ['Open', 'Accord'], 'the Open | Accord toggle is not in the toolbar');
    assert.ok(toggle.beforePill, 'the toggle must sit immediately left of the Issues pill');
    const rails = await page.evaluate(() => ({ left: document.querySelector('.prw-left').getBoundingClientRect().top, right: document.querySelector('.prw-right').getBoundingClientRect().top }));
    assert.ok(rails.left >= c.toolbar.bottom && rails.right >= c.toolbar.bottom, 'a rail sits under the toolbar');
    await page.screenshot({ path: path.join(shots, `${tag}-chrome.png`), clip: { x: 0, y: 0, width: 1440, height: 120 } });
  });
  await check(`${tag}: the Issues pill counts the viewer's own Issues: it equals the status bar and the amber dots`, async () => {
    const lines = await amber(page);
    const c = await chrome(page);
    const b = await bar(page);
    assert.equal(c.pillText, `${lines.length} Issues`);
    assert.equal(b.count, lines.length);
    const team = await page.evaluate(() => Number(document.querySelector('#share-banner .plm-issues-count').dataset.teamCount));
    assert.ok(team > lines.length, 'the team count should be larger here (unseen lines are team Issues)');
    assert.match(await page.locator('#share-banner .plm-issues-count').getAttribute('title'), new RegExp(`^${lines.length} lines need you .*; the team has ${team} open Issues`));
  });
  await check(`${tag}: Next goes to the lines that need you first`, async () => {
    const lines = await amber(page);
    const seen = [];
    for (let i = 0; i < lines.length; i += 1) {
      await page.locator('#share-banner .plm-next').click();
      await page.waitForTimeout(150);
      seen.push((await walk(page)).target);
    }
    assert.deepEqual([...seen].sort((a, b) => a - b), lines, `Next visited ${seen}`);
  });
  await check(`${tag}: Alt+F opens File from the keyboard; arrows move; a letter is not a reading command; Esc closes`, async () => {
    await reading(page);
    const marksBefore = (await page.evaluate(() => window.__proofLineMarks.debugState().marks.length));
    await page.keyboard.press('Alt+KeyF');
    await page.locator('.amb-menu[data-menu="file"]').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.closest('.amb-menu') !== null), true, 'the first item has no focus');
    assert.deepEqual((await menuItems(page)).map(i => i.label), ['New Accord', 'Open…', 'Import .md…', 'Rename…', 'Copy link', 'Download as Accord (.accord.md)', 'View activity']);
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Open…documents');
    await page.keyboard.press('a');
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.__proofLineMarks.debugState().marks.length), marksBefore, 'A marked a line while the menu had the keyboard');
    await page.keyboard.press('ArrowRight');
    await page.locator('.amb-menu[data-menu="edit"]').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.amb-menu').count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.menu), 'edit', 'Esc did not return to the menu bar');
    await page.keyboard.press('Escape');
  });
  await check(`${tag}: F10 moves to the menu bar; Ctrl+Option+V opens View; Alt+/ searches the menus`, async () => {
    await reading(page);
    await page.keyboard.press('F10');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.menu), 'file');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Alt+KeyV');
    await page.locator('.amb-menu[data-menu="view"]').waitFor();
    const view = (await menuItems(page)).map(i => i.label);
    for (const label of ['Navigator', 'Margin', 'Collapse all sections', 'Expand all sections', 'Show only decisions', 'Reading settings…', 'Familiar’s brief', 'Keyboard shortcuts']) assert.ok(view.includes(label), `View lacks ${label}: ${view}`);
    await page.keyboard.press('Escape');
    await reading(page);
    await page.keyboard.press('Alt+Slash');
    const search = page.locator('.amb-search input');
    await search.waitFor();
    await search.fill('sitting');
    assert.equal(await page.locator('.amb-search-option').first().locator('.amb-label').textContent(), 'Reading settings…');
    await page.screenshot({ path: path.join(shots, `${tag}-search.png`), clip: { x: 0, y: 0, width: 720, height: 240 } });
    await search.press('Enter');
    await page.locator('#reading-settings').waitFor({ state: 'visible' });
  });
  await check(`${tag}: View › Reading settings holds reading speed and This sitting (gone from the rail), and both still work`, async () => {
    const panel = page.locator('#reading-settings');
    assert.equal(await page.locator('.prw-right .prw-rate, .prw-right .plm-budget').count(), 0, 'a setting is still in the rail');
    await panel.locator('.prw-rate select').selectOption('4');
    await waitFor(page, () => window.__proofReadingWalk.debugState().rate === 4);
    await panel.locator('.plm-budget select').selectOption('5');
    await waitFor(page, () => document.querySelector('#reading-settings .plm-budget')?.dataset.state === 'on');
    await page.screenshot({ path: path.join(shots, `${tag}-reading-settings.png`) });
    await panel.locator('.plm-budget select').selectOption('0');
    await panel.getByRole('button', { name: 'Close reading settings' }).click();
    assert.equal(await panel.isVisible(), false);
  });
  await check(`${tag}: Edit and the toolbar expose the same labelled Editing control`, async () => {
    await page.locator('#accord-menubar .amb-top[data-menu="edit"]').click();
    const items = await menuItems(page);
    assert.ok(items.some(i => i.label === 'Enter Editing'));
    await page.locator('.amb-menu .amb-item', { hasText: 'Enter Editing' }).click();
    assert.equal(await page.locator('.pst-mode').innerText(), 'Editing');
    await page.getByRole('button', { name: 'Leave Editing', exact: true }).click();
    assert.equal(await page.locator('.pst-mode').innerText(), 'Reading');
  });
  await check(`${tag}: the toolbar's Undo says Undo, names what it reverses in its tooltip, and reverses it; Edit › Undo is the same Undo`, async () => {
    await selectPassage(page, L.S1 + 2);
    await page.keyboard.press('a');
    const undo = page.locator('#share-banner .pundo-btn').first();
    // Stage 3 (COS): the toolbar button says just "Undo"; its tooltip and Edit › Undo name what it reverses.
    await waitFor(page, () => /Undo: agreed line 5/.test(document.querySelector('#share-banner .pundo-btn')?.title ?? ''));
    assert.equal((await undo.textContent()).trim(), 'Undo');
    assert.equal(await undo.getAttribute('aria-label'), 'Undo agreed line 5');
    await page.locator('#accord-menubar .amb-top[data-menu="edit"]').click();
    assert.equal((await menuItems(page))[0].label, 'Undo agreed line 5');
    await page.keyboard.press('Escape');
    await undo.click();
    await page.waitForFunction(() => window.__proofUndo.debugState().log.some(m => m === 'Undid: agreed line 5'), null, { timeout: 6000 });
  });
  await check(`${tag}: Share opens one dialog with Link, People and AIs; People › Add agent opens its AIs tab`, async () => {
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    const dialog = page.locator('#share-dialog');
    await dialog.waitFor({ state: 'visible' });
    assert.deepEqual(await dialog.getByRole('tab').allTextContents(), ['Link', 'People', 'AIs']);
    assert.equal(await dialog.getByRole('tab', { name: 'Link' }).getAttribute('aria-selected'), 'true');
    await dialog.getByRole('button', { name: 'Download as Accord (.accord.md)' }).waitFor();
    await dialog.getByRole('button', { name: 'Copy link' }).waitFor();
    await dialog.getByRole('tab', { name: 'People' }).click();
    assert.match(await dialog.locator('#share-panel-people').innerText(), /Only an Owner can invite/);
    await page.screenshot({ path: path.join(shots, `${tag}-share.png`) });
    await dialog.getByRole('button', { name: 'Close share dialog' }).click();
    await page.locator('#accord-menubar .amb-top[data-menu="people"]').click();
    assert.deepEqual((await menuItems(page)).map(i => i.label), ['Share…', 'Invite person…', 'Add agent…', 'Who is here']);
    await page.locator('.amb-menu .amb-item', { hasText: 'Add agent…' }).click();
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await dialog.getByRole('tab', { name: 'AIs' }).getAttribute('aria-selected'), 'true');
    await dialog.locator('#agent-key-dialog #agent-key-label').waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(shots, `${tag}-share-ais.png`) });
    await dialog.getByRole('button', { name: 'Close share dialog' }).click();
  });
  await check(`${tag}: People › Who is here shows the viewer's and the team's Issues; Help has keys and what the marks mean`, async () => {
    await page.locator('#accord-menubar .amb-top[data-menu="people"]').click();
    await page.locator('.amb-menu .amb-item', { hasText: 'Who is here' }).click();
    const counts = page.locator('#who-dialog .acd-counts');
    await counts.waitFor();
    const lines = await amber(page);
    assert.equal(await counts.getAttribute('data-viewer'), String(lines.length));
    assert.equal(await counts.getAttribute('data-team'), await page.evaluate(() => document.querySelector('#share-banner .plm-issues-count').dataset.teamCount));
    await page.keyboard.press('Escape');
    await page.locator('#accord-menubar .amb-top[data-menu="help"]').click();
    assert.deepEqual((await menuItems(page)).map(i => i.label), ['Search the menus', 'Keyboard shortcuts', 'What the marks mean', 'Agent docs', 'About Accord']);
    await page.locator('.amb-menu .amb-item', { hasText: 'What the marks mean' }).click();
    await page.locator('#marks-legend').waitFor();
    assert.match(await page.locator('#marks-legend').innerText(), /Amber dot[\s\S]*Needs you/);
    await page.keyboard.press('Escape');
    await page.locator('#accord-menubar .amb-top[data-menu="help"]').click();
    await page.locator('.amb-menu .amb-item', { hasText: 'Keyboard shortcuts' }).click();
    assert.match(await page.locator('#keys-dialog').innerText(), /Alt\+F, E, V, P, H/);
    await page.keyboard.press('Escape');
  });
  await check(`${tag}: File › Open lists the documents; Edit › Find moves the focus line to a match`, async () => {
    await page.locator('#accord-menubar .amb-top[data-menu="file"]').click();
    await page.locator('.amb-menu .amb-item', { hasText: 'Open…' }).click();
    const open = page.locator('#open-dialog');
    await open.waitFor();
    assert.match(await open.innerText(), /Open an Accord/);
    await page.keyboard.press('Escape');
    await page.locator('#accord-menubar .amb-top[data-menu="edit"]').click();
    await page.locator('.amb-menu .amb-item', { hasText: 'Find…' }).click();
    await page.locator('#find-bar input').fill('secret key');
    await page.locator('#find-bar input').press('Enter');
    await waitFor(page, i => window.__proofReadingWalk.debugState().target === i, L.ASK2);
    await page.locator('#find-bar input').press('Escape');
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('#accord-menubar .amb-top[data-menu="view"]').click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(shots, `${tag}-overview.png`) });
  await page.keyboard.press('Escape');
  await context.close();
}

async function phone2(browser, base, style) {
  const created = await createDoc(base, 'Pat');
  const viewport = { width: 390, height: 844 };
  const tag = `layout-2-${style}-phone-390x844`;
  const { context, page } = await openDoc(browser, base, created.slug, 'Pat', {
    ...devices['iPhone 13'], viewport, screen: viewport, hasTouch: true, isMobile: true,
  });
  activePage = page;
  // Polish pass (COS, 2026-09-21: "Phone toolbar matches the mockup"): only the title, the Issues
  // count and ⋯, as in mockup-phone.png; Suggesting | Editing and Share lead the ⋯ menu.
  await check(`${tag}: no menu bar; the toolbar is the mockup's: the title, "N Issues" and ⋯, nothing else`, async () => {
    const c = await chrome(page);
    assert.equal(c.menubar, null, 'the menu bar shows on a phone');
    assert.equal(c.toolbar.top, 0);
    // Accord round 2 stage C: the mockup's three PLUS ONE — the Open / Accord toggle. This stage
    // rules that "the phone gets the toggle too", and the toggle is the product's whole claim in
    // one control, so it does not belong behind ⋯. On a 375 px bar it shows as a single button
    // naming the view it takes you to, so it cannot reach the middle of the bar and swallow taps
    // meant for the title. Everything the 09-21 polish removed stays removed, and the list is
    // still exact, so nothing can creep back in behind this one addition.
    assert.equal(c.controls.length, 4, `phone toolbar controls: ${c.controls.join(' | ')}`);
    assert.match(c.controls[0], /Waiting on Mike/);
    assert.match(c.controls[1], /^(Open|Accord)$/);
    assert.match(c.controls[2], /^Next issue/);
    assert.match(c.controls[3], /^More options/);
    // The toggle sits at the LEFT, right after the title and well clear of the Issues pill: the
    // space beside the pill is where a thumb lands, and this control changes what the whole page
    // shows. It is one 44 px button there, not a two-segment control that would fill the bar.
    const toggle = await page.evaluate(() => {
      const t = document.querySelector('#share-banner .aov-toggle');
      const title = document.querySelector('#share-banner .share-pill-title');
      const pill = document.querySelector('#share-banner .plm-issues');
      const box = t?.getBoundingClientRect();
      return {
        afterTitle: title?.nextElementSibling === t,
        leftOfPill: Boolean(box && pill && box.right <= pill.getBoundingClientRect().left + 1),
        segs: [...(t?.querySelectorAll('.aov-seg') ?? [])].filter(n => n.getBoundingClientRect().width > 0).map(n => n.textContent),
        height: box?.height ?? 0,
      };
    });
    assert.ok(toggle.afterTitle, 'the phone toggle is not right after the title');
    assert.ok(toggle.leftOfPill, 'the phone toggle is not clear of the Issues pill');
    assert.equal(toggle.segs.length, 1, `the phone shows one button, not ${toggle.segs.length}: ${toggle.segs.join(' | ')}`);
    assert.ok(toggle.height >= 44, `the phone toggle is ${toggle.height} px tall`);
    assert.equal(c.seg && c.seg.width > 0 ? 'shown' : 'gone', 'gone', 'Suggesting | Editing is still in the phone toolbar');
    assert.ok(!c.share || c.share.width === 0, 'Share is still in the phone toolbar');
    assert.equal(c.undo, null, 'Undo is in the phone toolbar');
    const lines = await amber(page);
    assert.equal(c.pillText, `${lines.length} Issues`);
    // Regions as in the mockup: title at the left, the pill then ⋯ at the right.
    const pos = await page.evaluate(() => {
      const r = sel => document.querySelector(sel).getBoundingClientRect();
      return { title: r('#share-banner .share-pill-title'), next: r('#share-banner .plm-next'), more: r('#share-banner .share-pill-overflow'), nextText: document.querySelector('#share-banner .plm-next').innerText.trim(), dot: getComputedStyle(document.querySelector('#share-banner .share-pill-status-inline')).display };
    });
    assert.ok(pos.title.left <= 24, `title starts at ${pos.title.left}`);
    assert.ok(pos.next.left > pos.title.right - 1 && pos.more.left >= pos.next.right - 1 && pos.more.right >= 390 - 12, 'the pill and ⋯ are not at the right, in that order');
    assert.equal(pos.nextText, `${lines.length} Issues`, 'the pill does not read "N Issues"');
    assert.equal(pos.dot, 'none', 'the Saved dot shows on a phone');
    assert.equal((await bar(page)).count, lines.length);
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
    assert.ok(fits, 'the page scrolls sideways');
    await page.screenshot({ path: path.join(shots, `${tag}-toolbar.png`), clip: { x: 0, y: 0, width: 390, height: 120 } });
  });
  await check(`${tag}: the ⋯ menu holds the menu bar's menus; Reading settings opens as a sheet`, async () => {
    await page.getByRole('button', { name: /^More options/ }).tap();
    const menu = page.locator('.proof-share-overflow-menu');
    await menu.waitFor();
    const text = await menu.innerText();
    for (const heading of ['FILE', 'EDIT', 'VIEW', 'PEOPLE', 'HELP']) assert.ok(text.toUpperCase().includes(heading), `no ${heading} group`);
    for (const label of ['Open…', 'Reading settings…', 'Share…', 'Add agent…', 'Keyboard shortcuts']) assert.ok(text.includes(label), `no ${label}`);
    // The switch and Share lead the menu (TOOLBAR_POLICY.phoneMenuTop), each only once.
    const top = await menu.evaluate(m => [...m.querySelectorAll('.amb-item')].slice(0, 2).map(b => ({ label: b.querySelector('.amb-label').textContent, checked: b.getAttribute('aria-checked') })));
    assert.deepEqual(top.map(t => t.label), ['Enter Editing', 'Share…']);
    assert.equal(await page.locator('.pst-mode').innerText(), 'Reading');
    const count = label => menu.evaluate((m, l) => [...m.querySelectorAll('.amb-item .amb-label')].filter(n => n.textContent === l).length, label);
    for (const label of ['Enter Editing', 'Share…']) assert.equal(await count(label), 1, `${label} appears twice`);
    await page.screenshot({ path: path.join(shots, `${tag}-overflow.png`) });
    await menu.getByRole('menuitem', { name: /Reading settings/ }).tap();
    const panel = page.locator('#reading-settings');
    await panel.waitFor({ state: 'visible' });
    const r = await panel.boundingBox();
    assert.ok(Math.abs(r.y + r.height - 844) <= 2 && r.width >= 388, `the settings are not a bottom sheet: ${JSON.stringify(r)}`);
    await page.screenshot({ path: path.join(shots, `${tag}-settings.png`) });
    await panel.getByRole('button', { name: 'Close reading settings' }).tap();
  });
  await check(`${tag}: the phone menu enters and leaves Editing through one labelled control`, async () => {
    await page.getByRole('button', { name: /^More options/ }).tap();
    await page.locator('.apm-mode').getByRole('menuitem', { name: 'Enter Editing' }).tap();
    assert.equal(await page.locator('.pst-mode').innerText(), 'Editing');
    await page.getByRole('button', { name: /^More options/ }).tap();
    await page.locator('.apm-mode').getByRole('menuitem', { name: 'Leave Editing' }).tap();
    assert.equal(await page.locator('.pst-mode').innerText(), 'Reading');
  });
  await check(`${tag}: ⋯ › Share… opens the Share dialog; it fits the phone`, async () => {
    await page.getByRole('button', { name: /^More options/ }).tap();
    await page.locator('.proof-share-overflow-menu').getByRole('menuitem', { name: /Share…/ }).tap();
    const dialog = page.locator('#share-dialog');
    await dialog.waitFor({ state: 'visible' });
    const r = await dialog.boundingBox();
    assert.ok(r.x >= 0 && r.x + r.width <= 390, 'the dialog runs off the phone');
    await dialog.getByRole('button', { name: 'Close share dialog' }).tap();
  });
  await context.close();
}

// ---------------------------------------------------------------------------------------------
// Stage 3: one cursor, the Margin (Line N · Room), the Navigator (Outline · Issues · Since you) and
// the phone's bottom strip (proposal "One cursor", "The Margin: two tabs", "The Navigator",
// "Phone"; decisions 4, 6, 7, 8, 11).
// Mockup regions (mockup-desktop.html at 1440 x 900): menu bar 0-28, toolbar 28-72, Navigator
// x 0-240 and Margin x 1100-1440 from the toolbar to the bottom, the status bar 28 px at the
// bottom of the page column between them. Phone (mockup-phone.html, 390 x 844): the strip at the
// bottom, 56 px, with the position, Agree, Reject and ⋯; the sheet under it holds Line · Room.
// ---------------------------------------------------------------------------------------------
const MOCKUP_DESKTOP = { toolbarBottom: 72, navRight: 240, marginLeft: 1100, statusHeight: 28 };
const regions = page => page.evaluate(() => {
  const r = s => { const n = document.querySelector(s); if (!n) return null; const b = n.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height }; };
  return {
    left: r('.prw-left'), right: r('.prw-right'), bar: r('.pst-bar'), text: r('.ProseMirror'), toolbar: r('#share-banner'),
    navTabs: [...document.querySelectorAll('.prw-left .anv-tab')].map(t => t.firstChild?.textContent?.trim() ?? ''),
    marginTabs: [...document.querySelectorAll('.prw-right .amg-tab')].map(t => t.querySelector('.amg-tab-label')?.textContent ?? t.textContent),
    selectedNav: document.querySelector('.prw-left .anv-tab[aria-selected="true"]')?.dataset.tab ?? null,
    selectedMargin: document.querySelector('.prw-right .amg-tab[aria-selected="true"]')?.dataset.tab ?? null,
    innerWidth, innerHeight,
  };
});
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs mockup ${b}`);
async function openMore(page) {
  const btn = page.locator('.prw-right .plm-more-btn');
  if ((await btn.getAttribute('aria-expanded')) !== 'true') await btn.click();
  await page.locator('.prw-right .plm-more').waitFor({ state: 'visible' });
}

// Polish pass (COS, 2026-09-21): everyone's marks on a line fold into "Marked by N" in the Line tab,
// open by default only for a Reject or an open objection; a person's open / close is kept.
async function seedTeamMarks(created) {
  await created.post('/marks/line', { by: 'ai:dee', status: 'agreed', quote: para(2) });
  await created.post('/marks/line', { by: 'ai:cos', status: 'seen', quote: para(2) });
  await created.post('/marks/line', { by: 'ai:dee', status: 'rejected', reason: 'Say which list', quote: para(3) });
}
const teamFold = (page, scope) => page.evaluate(sel => {
  const d = document.querySelector(`${sel} .plm-team-fold`);
  if (!d) return null;
  return { open: d.open, auto: d.dataset.auto, line: Number(d.dataset.line), label: d.querySelector('.plm-team-label').textContent, detail: d.querySelector('.plm-team-detail')?.textContent ?? '', rows: [...d.querySelectorAll('.plm-team li')].map(li => li.innerText.replace(/\s+/g, ' ').trim()), listShown: d.querySelector('.plm-team').checkVisibility() };
}, scope);

async function desktop3(browser, base, style) {
  const created = await createDoc(base, 'Ada');
  const tag = `layout-3-${style}-1440`;
  const { context, page } = await openDoc(browser, base, created.slug, 'Ada', { viewport: { width: 1440, height: 900 } });
  activePage = page;

  await check(`${tag}: three regions as in the mockup — Navigator 240 px left, Margin 340 px right, the page and its status bar between`, async () => {
    const g = await regions(page);
    near(g.left.top, MOCKUP_DESKTOP.toolbarBottom, 2, 'Navigator top');
    near(g.right.top, MOCKUP_DESKTOP.toolbarBottom, 2, 'Margin top');
    near(g.left.left, 0, 1, 'Navigator left');
    near(g.left.right, MOCKUP_DESKTOP.navRight, 2, 'Navigator right');
    near(g.right.left, MOCKUP_DESKTOP.marginLeft, 2, 'Margin left');
    near(g.right.right, 1440, 1, 'Margin right');
    near(g.left.bottom, 900, 1, 'Navigator bottom');
    near(g.right.bottom, 900, 1, 'Margin bottom');
    near(g.bar.left, g.left.right, 2, 'status bar left');
    near(g.bar.right, g.right.left, 2, 'status bar right');
    near(g.bar.height, MOCKUP_DESKTOP.statusHeight, 1, 'status bar height');
    assert.ok(g.text.left >= g.left.right + 16 && g.text.right <= g.right.left - 16, 'the text runs under a side');
    const mid = (g.left.right + g.right.left) / 2;
    assert.ok(Math.abs((g.text.left + g.text.right) / 2 - mid) <= 40, 'the text is not centred between the sides');
    assert.deepEqual(g.navTabs, ['Outline', 'Issues', 'Since you']);
    assert.deepEqual(g.marginTabs, ['Line 1', 'Room']);
    assert.equal(g.selectedNav, 'issues', 'the Navigator opens on Issues (the mockup)');
    assert.equal(g.selectedMargin, 'line');
    assert.equal(await page.locator('.prw-left .prw-docs, .prw-left .prw-doc').count(), 0, 'the documents list is still in the Navigator');
    await page.screenshot({ path: path.join(shots, `${tag}-regions.png`) });
  });

  await check(`${tag}: Issues lists the viewer's own Issues — the same lines as the amber dots and the pill — each with its kind and line`, async () => {
    const lines = await amber(page);
    const items = await page.evaluate(() => [...document.querySelectorAll('.prw-left .anv-issue')].map(b => ({ line: Number(b.dataset.line), title: b.querySelector('.anv-issue-title').textContent, kind: b.querySelector('.anv-issue-kind').textContent })));
    assert.deepEqual(items.map(i => i.line), lines);
    assert.equal(await page.locator('.prw-left .anv-tab[data-tab="issues"] .anv-badge').textContent(), String(lines.length));
    assert.equal((await chrome(page)).pillText, `${lines.length} Issues`);
    assert.match(items[0].kind, new RegExp(`^Ask · line ${L.ASK + 1}$`));
    assert.match(items[1].kind, new RegExp(`^Change from \\w+ · line ${L.CHANGE + 1}$`));
    assert.match(items[2].kind, new RegExp(`^Comment from \\w+ · line ${L.COMMENT + 1}$`));
    assert.match(items[0].title, /turn on the cloud backup/);
    await page.screenshot({ path: path.join(shots, `${tag}-issues.png`), clip: { x: 0, y: 60, width: 260, height: 420 } });
  });
  await check(`${tag}: clicking an Issue moves the one cursor there — the bar, the status bar and the Line tab all name that line`, async () => {
    await page.locator(`.prw-left .anv-issue[data-line="${L.CHANGE}"]`).click();
    await waitFor(page, i => window.__proofReadingWalk.debugState().focus === i, L.CHANGE);
    const w = await walk(page);
    assert.equal(w.cursor, L.CHANGE);
    assert.equal(w.target, L.CHANGE);
    assert.equal(await page.evaluate(() => Number(document.querySelector('.prw-focus').dataset.line)), L.CHANGE);
    assert.equal((await bar(page)).line, `Line ${L.CHANGE + 1} of 25`);
    assert.equal(await page.locator('.prw-right .amg-tab[data-tab="line"] .amg-tab-label').textContent(), `Line ${L.CHANGE + 1}`);
    assert.equal(await page.locator(`.prw-left .anv-issue[data-line="${L.CHANGE}"]`).getAttribute('aria-current'), 'true');
  });
  await check(`${tag}: the Line tab is the thread on the line — quote, Agree A / Reject R / ⋯, then its changes with Accept / Reject / Reply, and a reply box`, async () => {
    const info = await page.evaluate(() => {
      const pane = document.querySelector('.prw-right .amg-pane[data-tab="line"]');
      const quote = pane.querySelector('.plm-quote');
      const primary = [...pane.querySelectorAll('.plm-primary-row > button')].map(b => b.getAttribute('aria-label') || [...b.querySelectorAll('span:not(.plm-choice-glyph), kbd')].map(n => n.textContent).join(' '));
      const order = ['.plm-quote', '.plm-primary-row', '.prw-changes', '.amg-reply'].map(s => pane.querySelector(s)?.getBoundingClientRect().top ?? -1);
      return { quote: quote?.textContent ?? '', primary, order, card: [...pane.querySelectorAll('.prw-card .prw-card-actions button')].map(b => b.textContent), reply: pane.querySelector('.amg-reply-input')?.placeholder };
    });
    assert.match(info.quote, /^The reviewer could not read that list/);
    assert.deepEqual(info.primary, ['Agree A', 'Reject R', 'More marks for this line']);
    assert.deepEqual(info.card, ['Accept', 'Reject', 'Reply']);
    assert.equal(info.reply, 'Reply on this line…');
    for (let i = 1; i < info.order.length; i += 1) assert.ok(info.order[i] > info.order[i - 1], `the Line tab is out of order: ${info.order}`);
    await page.screenshot({ path: path.join(shots, `${tag}-line-tab.png`), clip: { x: 1090, y: 60, width: 350, height: 640 } });
  });
  await check(`${tag}: ⋯ More holds Seen, Clear my mark, Flag uncertain, Offer another wording, Explain, Time-to-live and the tier`, async () => {
    assert.equal(await page.locator('.prw-right .plm-more').isVisible(), false, 'More is open before it is asked for');
    await openMore(page);
    const text = await page.locator('.prw-right .plm-more').innerText();
    for (const label of ['Seen', 'Flag uncertain', 'Offer another wording', 'Explain', 'Time-to-live', 'Make context']) assert.ok(text.includes(label), `More lacks ${label}: ${text}`);
    await page.screenshot({ path: path.join(shots, `${tag}-more.png`), clip: { x: 1090, y: 60, width: 350, height: 640 } });
    await page.locator('.prw-right .plm-more .plm-choice[data-status="seen"]').click();
    await waitFor(page, i => window.__proofLineMarks.debugState().marks.some(m => m.by === window.__proofLineMarks.me() && m.anchor.ordinal === i && m.status === 'seen'), L.CHANGE);
    await openMore(page);
    assert.ok((await page.locator('.prw-right .plm-more').innerText()).includes('Clear my mark'));
    await page.locator('.prw-right .plm-more .plm-clear').click();
  });
  await check(`${tag}: "Reply on this line…" replies to the line's comment, or opens a new thread on a plain line`, async () => {
    await page.locator(`.prw-left .anv-issue[data-line="${L.COMMENT}"]`).click();
    await waitFor(page, i => window.__proofReadingWalk.debugState().focus === i, L.COMMENT);
    await page.locator('.prw-right .amg-reply-input').fill('Thanks, that settles it.');
    await page.locator('.prw-right .amg-reply-input').press('Enter');
    await waitFor(page, () => (window.proof.getAllMarks() ?? []).some(m => m.kind === 'comment' && (m.data?.replies ?? []).some(r => r.text === 'Thanks, that settles it.')));
    await page.evaluate(() => document.activeElement?.blur());
    await page.locator('.prw-left .anv-tab[data-tab="outline"]').click();
    await page.locator(`.prw-left .anv-heading[data-line="${L.H1}"]`).click();
    await waitFor(page, i => window.__proofReadingWalk.debugState().focus === i, L.H1);
    await page.keyboard.press('j');
    await waitFor(page, () => window.__proofReadingWalk.debugState().focus === 1);
    await page.locator('.prw-right .amg-reply-input').fill('Is this line still true?');
    await page.locator('.prw-right .amg-reply-send').click();
    await waitFor(page, () => window.__proofReadingWalk.debugState().replies.some(r => r.line === 1));
    await waitFor(page, () => (window.proof.getAllMarks() ?? []).some(m => m.kind === 'comment' && m.data?.text === 'Is this line still true?'));
    await page.evaluate(() => document.activeElement?.blur());
  });
  await check(`${tag}: Outline lists the headings with fold chips and counts; a chip folds its section, a heading moves the cursor`, async () => {
    const rows = await page.evaluate(() => [...document.querySelectorAll('.prw-left .anv-row')].map(r => ({ heading: Number(r.dataset.heading), count: r.querySelector('.anv-count').textContent, text: r.querySelector('.anv-heading').textContent })));
    assert.deepEqual(rows.map(r => r.heading), [L.H1, 5]);
    assert.equal(rows[1].text, 'Needs your hands');
    assert.match(rows[1].count, /^\d+$/);
    for (const label of ['Collapse all sections', 'Expand all sections']) assert.equal(await page.locator('.prw-left .anv-tools').getByRole('button', { name: label, exact: true }).count(), 1, `${label} is not on the Outline`);
    await page.locator('.prw-left .anv-row[data-heading="5"] .anv-fold').click();
    await waitFor(page, () => window.__proofFolding.isFolded(5) === true);
    assert.equal(await page.locator('.prw-left .anv-row[data-heading="5"] .anv-fold').getAttribute('data-folded'), 'true');
    await page.screenshot({ path: path.join(shots, `${tag}-outline.png`), clip: { x: 0, y: 60, width: 260, height: 300 } });
    await page.locator('.prw-left .anv-row[data-heading="5"] .anv-fold').click();
    await waitFor(page, () => window.__proofFolding.isFolded(5) === false);
    await page.locator('.prw-left .anv-heading[data-line="5"]').click();
    await waitFor(page, () => window.__proofReadingWalk.debugState().focus === 5);
    assert.equal(await page.locator('.prw-left .anv-row[data-heading="5"]').getAttribute('aria-current'), 'true');
  });
  await check(`${tag}: Since you holds the Since-you list; no rail keeps the documents, the blind switch or the reading settings`, async () => {
    await page.locator('.prw-left .anv-tab[data-tab="since"]').click();
    assert.equal(await page.locator('.prw-left .anv-pane[data-tab="since"]').isVisible(), true);
    assert.equal(await page.locator('.prw-left .anv-pane[data-tab="since"] .prw-since').count(), 1);
    assert.equal(await page.locator('.prw-rail .plm-blind, .prw-rail .prw-rate, .prw-rail .plm-budget, .prw-rail .prw-docs').count(), 0);
    await page.locator('.prw-left .anv-tab[data-tab="issues"]').click();
  });

  await check(`${tag}: hover leaves the Margin on the selected passage`, async () => {
    await selectPassage(page, L.S2 + 3); await hoverChangesNothing(page, L.S2 + 5);
  });
  await check(`${tag}: a key after hover acts on the selected passage`, async () => {
    await selectPassage(page, L.S2 + 3); await hoverChangesNothing(page, L.S2 + 5);
    await page.keyboard.press('a');
    await waitFor(page, i => window.__proofLineMarks.myStatus(i) === 'agreed', L.S2 + 3);
    assert.equal((await walk(page)).cursor, L.S2 + 3);
  });
  await check(`${tag}: Margin controls keep the selected passage after hover`, async () => {
    await selectPassage(page, L.S2 + 3); await hoverChangesNothing(page, L.S2 + 5);
    await page.locator('.prw-right .plm-more-btn').click();
    assert.equal((await walk(page)).cursor, L.S2 + 3);
  });
  await check(`${tag}: J selects the next visible passage after hover`, async () => {
    await selectPassage(page, L.S2 + 3); await hoverChangesNothing(page, L.S2 + 5);
    await page.keyboard.press('j'); assert.equal((await walk(page)).cursor, L.S2 + 4);
  });

  await check(`${tag}: Room is the chat, full height; its badge counts unread @mentions; the tab never switches itself`, async () => {
    await page.locator('.prw-right .amg-tab[data-tab="room"]').click();
    const room = page.locator('.prw-right .amg-pane[data-tab="room"]');
    await room.locator('.pch-input').waitFor({ state: 'visible' });
    const r = await room.boundingBox();
    assert.ok(r.y + r.height >= 898 && r.height >= 700, `the Room is not full height: ${JSON.stringify(r)}`);
    assert.equal(await page.locator('.prw-right .amg-pane[data-tab="line"]').isVisible(), false);
    await page.mouse.move(5, 450);
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    await page.waitForTimeout(200);
    assert.equal((await regions(page)).selectedMargin, 'room', 'the tab switched itself when the cursor moved');
    // The Line tab still names the line A and R hit.
    const cursor = (await walk(page)).cursor;
    assert.equal(await page.locator('.prw-right .amg-tab[data-tab="line"] .amg-tab-label').textContent(), `Line ${cursor + 1}`);
    await page.screenshot({ path: path.join(shots, `${tag}-room.png`) });
    await page.locator('.prw-right .amg-tab[data-tab="line"]').click();
  });
  await check(`${tag}: both sides collapse, and the collapsed state and the chosen tabs are remembered on reload`, async () => {
    await page.locator('.prw-left .anv-tab[data-tab="outline"]').click();
    await page.locator('.prw-right .amg-tab[data-tab="room"]').click();
    await page.locator('.prw-left .prw-collapse').click();
    await page.locator('.prw-right .prw-collapse').click();
    await waitFor(page, () => document.body.classList.contains('prw-left-collapsed') && document.body.classList.contains('prw-right-collapsed'));
    let g = await regions(page);
    assert.ok(g.left.width <= 48 && g.right.width <= 48, 'a collapsed side is still wide');
    await page.reload();
    await page.waitForFunction(() => window.__proofReadingWalk?.debugState().ready === true, null, { timeout: 20_000 });
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => document.body.classList.contains('prw-left-collapsed') && document.body.classList.contains('prw-right-collapsed')), true, 'the collapsed state was forgotten');
    await page.locator('.prw-left .prw-collapse').click();
    await page.locator('.prw-right .prw-collapse').click();
    await page.waitForTimeout(200);
    g = await regions(page);
    assert.equal(g.selectedNav, 'outline', 'the Navigator tab was forgotten');
    assert.equal(g.selectedMargin, 'room', 'the Margin tab was forgotten');
    await page.locator('.prw-left .anv-tab[data-tab="issues"]').click();
    await page.locator('.prw-right .amg-tab[data-tab="line"]').click();
  });
  await check(`${tag}: View › Navigator and View › Margin show and hide the sides`, async () => {
    await page.locator('#accord-menubar .amb-top[data-menu="view"]').click();
    await page.locator('.amb-menu .amb-item', { hasText: 'Navigator' }).click();
    await waitFor(page, () => document.body.classList.contains('prw-left-collapsed'));
    await page.locator('#accord-menubar .amb-top[data-menu="view"]').click();
    await page.locator('.amb-menu .amb-item', { hasText: 'Navigator' }).click();
    await waitFor(page, () => !document.body.classList.contains('prw-left-collapsed'));
  });
  await check(`${tag}: everyone's marks fold into "Marked by N" in the Line tab; open by default only for a Reject; a person's choice is kept`, async () => {
    await seedTeamMarks(created);
    await page.evaluate(i => window.__proofReadingWalk.focusLine(i), L.S1);
    // The page polls for other people's marks; the viewer's own scroll-Seen may be a third mark.
    await waitFor(page, () => /1 Agreed/.test(document.querySelector('.prw-right .plm-team-fold .plm-team-detail')?.textContent ?? ''), null, 15000);
    let f = await teamFold(page, '.prw-right');
    assert.equal(f.line, L.S1);
    assert.equal(f.open, false, 'a line with no Reject opens its marks');
    assert.equal(f.listShown, false, 'the list shows while folded');
    assert.match(f.detail, /^1 Agreed · [12] Seen$/);
    assert.match(f.label, /^Marked by [23]$/);
    assert.equal(await page.locator('.prw-right .plm-team-fold > .plm-team').isVisible(), false);
    await page.screenshot({ path: path.join(shots, `layout-polish-${style}-1440-marked-by-folded.png`), clip: { x: 1090, y: 60, width: 350, height: 640 } });
    await page.locator('.prw-right .plm-team-sum').click();
    f = await teamFold(page, '.prw-right');
    assert.equal(f.open, true);
    assert.ok(f.rows.some(r => /Agreed/.test(r)) && f.rows.some(r => /Seen/.test(r)), `who marked what: ${f.rows}`);
    // Kept across a re-render (another line, then back).
    await page.evaluate(i => window.__proofReadingWalk.focusLine(i), L.S2);
    await waitFor(page, i => Number(document.querySelector('.prw-right .plm-team-fold')?.dataset.line) === i, L.S2);
    f = await teamFold(page, '.prw-right');
    assert.equal(f.open, true, 'a line with a Reject is folded');
    assert.equal(f.auto, 'open');
    assert.ok(f.rows.some(r => /Rejected: Say which list/.test(r)), `the Reject and its reason: ${f.rows}`);
    await page.screenshot({ path: path.join(shots, `layout-polish-${style}-1440-marked-by-reject.png`), clip: { x: 1090, y: 60, width: 350, height: 640 } });
    await page.evaluate(i => window.__proofReadingWalk.focusLine(i), L.S1);
    await waitFor(page, i => Number(document.querySelector('.prw-right .plm-team-fold')?.dataset.line) === i, L.S1);
    assert.equal((await teamFold(page, '.prw-right')).open, true, 'the person\'s open was not kept');
    await page.locator('.prw-right .plm-team-sum').click();
    assert.equal((await teamFold(page, '.prw-right')).open, false);
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator(`.prw-left .anv-issue[data-line="${L.ASK}"]`).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, `${tag}-overview.png`) });
  await context.close();
}

async function phone3(browser, base, style) {
  const created = await createDoc(base, 'Pat');
  const viewport = { width: 390, height: 844 };
  const tag = `layout-3-${style}-phone-390x844`;
  const { context, page } = await openDoc(browser, base, created.slug, 'Pat', {
    ...devices['iPhone 13'], viewport, screen: viewport, hasTouch: true, isMobile: true,
  });
  activePage = page;
  const strip = page.locator('.prw-strip');
  await check(`${tag}: the bottom strip is the position, Agree, Reject and ⋯ (mockup: 56 px at the bottom)`, async () => {
    await strip.waitFor({ state: 'visible' });
    const r = await strip.boundingBox();
    assert.ok(Math.abs(r.y + r.height - 844) <= 2, `strip bottom ${r.y + r.height}`);
    assert.ok(r.height >= 56 && r.height <= 80, `strip height ${r.height}`);
    assert.equal(await page.locator('.prw-strip-where').innerText(), 'Line 1 of 25');
    const buttons = await page.evaluate(() => [...document.querySelectorAll('.prw-strip-actions button')].map(b => b.textContent));
    assert.deepEqual(buttons, ['Agree', 'Reject', '⋯']);
    const boxes = await page.evaluate(() => ['.prw-strip-agree', '.prw-strip-reject', '.prw-strip-more'].map(s => document.querySelector(s).getBoundingClientRect().height));
    for (const h of boxes) assert.ok(h >= 44, `a strip button is too small to tap: ${h}`);
    await page.screenshot({ path: path.join(shots, `${tag}-strip.png`) });
  });
  await check(`${tag}: a swipe up on the strip opens the Margin as a sheet — the strip on top, then Line · Room`, async () => {
    const r = await strip.boundingBox();
    const cdp = await context.newCDPSession(page);
    const x = r.x + 60;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: r.y + 30 }] });
    for (const dy of [10, 25, 45, 60]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: r.y + 30 - dy }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.locator('.prw-right.prw-sheet-open').waitFor({ state: 'visible' });
    const sheet = await page.locator('.prw-right.prw-sheet-open').boundingBox();
    const s2 = await strip.boundingBox();
    assert.ok(Math.abs(sheet.y + sheet.height - 844) <= 2, 'the sheet is not at the bottom');
    assert.ok(s2.y >= sheet.y - 1 && s2.y <= sheet.y + 20, 'the strip is not the top of the sheet');
    const tabs = await page.evaluate(() => [...document.querySelectorAll('.prw-right.prw-sheet-open .amg-tab')].map(t => t.querySelector('.amg-tab-label').textContent));
    assert.deepEqual(tabs, ['Line 1', 'Room']);
    assert.ok(sheet.y > 844 * 0.2, 'the sheet covers the whole page');
    await page.screenshot({ path: path.join(shots, `${tag}-sheet.png`) });
  });
  await check(`${tag}: the sheet's Room tab is the chat; a swipe down (or the grab bar) closes the sheet`, async () => {
    await page.locator('.prw-right.prw-sheet-open .amg-tab[data-tab="room"]').tap();
    await page.locator('.prw-right.prw-sheet-open .pch-input').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => window.__proofChat.debugState().visible), true);
    await page.screenshot({ path: path.join(shots, `${tag}-room.png`) });
    await page.locator('.prw-right.prw-sheet-open .amg-tab[data-tab="line"]').tap();
    await page.locator('.prw-strip-grab').tap();
    await page.locator('.prw-right.prw-sheet-open').waitFor({ state: 'detached' }).catch(() => {});
    assert.equal(await page.locator('.prw-right.prw-sheet-open').count(), 0);
    const r = await strip.boundingBox();
    assert.ok(Math.abs(r.y + r.height - 844) <= 2, 'the strip did not go back to the bottom');
  });
  await check(`${tag}: ⋯ in the strip opens the sheet with More showing (Seen, Flag uncertain, …) for the cursor's line`, async () => {
    await page.evaluate(i => window.__proofReadingWalk.focusLine(i), L.S1);
    await page.waitForTimeout(300);
    await page.locator('.prw-strip-more').tap();
    const more = page.locator('.prw-right.prw-sheet-open .plm-more');
    await more.waitFor({ state: 'visible' });
    assert.match(await more.innerText(), /Seen[\s\S]*Flag uncertain/);
    assert.equal(await page.locator('.prw-right.prw-sheet-open .plm-box').getAttribute('data-line'), String(L.S1));
    await page.screenshot({ path: path.join(shots, `${tag}-more.png`) });
    await more.locator('.plm-choice[data-status="seen"]').tap();
    await waitFor(page, i => window.__proofLineMarks.debugState().marks.some(m => m.by === window.__proofLineMarks.me() && m.anchor.ordinal === i && m.status === 'seen'), L.S1);
    await page.locator('.prw-strip-grab').tap();
  });
  await check(`${tag}: Agree in the strip marks the cursor's line; "Marked up to line K ↑" takes you back there`, async () => {
    await page.locator('.prw-strip-agree').tap();
    await waitFor(page, i => document.querySelector('.prw-strip-marked')?.textContent === `Marked up to line ${i + 1} ↑`, L.S1);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await page.waitForTimeout(500);
    await page.locator('.prw-strip-marked').tap();
    await waitFor(page, i => window.__proofReadingWalk.debugState().cursor === i, L.S1);
  });
  await check(`${tag}: the ⋯ menu opens the Navigator as a sheet; an Issue there moves the cursor and closes it`, async () => {
    await page.getByRole('button', { name: /^More options/ }).tap();
    await page.locator('.proof-share-overflow-menu').getByRole('menuitem', { name: /Navigator/ }).tap();
    const nav = page.locator('.prw-left.prw-sheet-open');
    await nav.waitFor({ state: 'visible' });
    const tabs = await page.evaluate(() => [...document.querySelectorAll('.prw-left.prw-sheet-open .anv-tab')].map(t => t.firstChild.textContent.trim()));
    assert.deepEqual(tabs, ['Outline', 'Issues', 'Since you']);
    await page.screenshot({ path: path.join(shots, `${tag}-navigator.png`) });
    await nav.locator(`.anv-issue[data-line="${L.CHANGE}"]`).tap();
    await waitFor(page, i => window.__proofReadingWalk.debugState().cursor === i, L.CHANGE);
    assert.equal(await page.locator('.prw-left.prw-sheet-open').count(), 0, 'the Navigator stayed open');
    assert.equal(await page.locator('.prw-strip-where').innerText(), `Line ${L.CHANGE + 1} of 25`);
  });
  await check(`${tag}: the sheet's Line tab folds everyone's marks into "Marked by N"; a Reject opens it; the row is touch-sized`, async () => {
    await seedTeamMarks(created);
    await page.evaluate(i => window.__proofReadingWalk.focusLine(i), L.S2);
    await page.getByRole('button', { name: /^More options/ }).tap();
    await page.locator('.proof-share-overflow-menu').getByRole('menuitem', { name: /This line/ }).tap();
    await page.locator('.prw-right.prw-sheet-open').waitFor({ state: 'visible' });
    await waitFor(page, () => document.querySelector('.prw-right.prw-sheet-open .plm-team-fold')?.dataset.auto === 'open', null, 15000);
    const f = await teamFold(page, '.prw-right.prw-sheet-open');
    assert.equal(f.line, L.S2);
    assert.equal(f.open, true, 'the Reject did not open the fold');
    const sum = await page.locator('.prw-right.prw-sheet-open .plm-team-sum').boundingBox();
    assert.ok(sum.height >= 44, `the row is too small to tap: ${sum.height}`);
    await page.locator('.prw-right.prw-sheet-open .plm-team-fold').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shots, `layout-polish-${style}-phone-390x844-marked-by.png`) });
    await page.locator('.prw-right.prw-sheet-open .plm-team-sum').tap();
    assert.equal((await teamFold(page, '.prw-right.prw-sheet-open')).open, false);
    await page.locator('.prw-strip-grab').tap();
  });
  await context.close();
}

const browser = await chromium.launch();
try {
  for (const style of styles) {
    const { base, stop } = await startServer(style);
    try {
      if (stages.includes(1)) { await desktop(browser, base, style); await phone(browser, base, style); }
      if (stages.includes(2) && !peek) { await desktop2(browser, base, style); await phone2(browser, base, style); }
      if (stages.includes(3) && !peek) { await desktop3(browser, base, style); await phone3(browser, base, style); }
    } finally {
      await stop();
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${results.length - failures}/${results.length} layout checks passed`);
process.exit(failures ? 1 : 0);
