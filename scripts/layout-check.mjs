#!/usr/bin/env node
import { assertRetiredMarks, assertMarkKeysInactive, assertSinglePanel, assertPassageActions, assertPanelToggle, seedLegacyMark } from './left-panel-assertions.mjs';
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
const amber = page => page.evaluate(() => [...document.querySelectorAll('.plm-needs-you[data-needs-you="true"]')].map(d => Number(d.dataset.line)).sort((a, b) => a - b));

async function desktop(browser, base, style) {
  const created = await createDoc(base, 'Ada');
  const tag = `layout-1-${style}-1440`;
  const { context, page } = await openDoc(browser, base, created.slug, 'Ada', { viewport: { width: 1440, height: 900 } });
  activePage = page;
  if (peek) { await page.screenshot({ path: path.join(shots, `${tag}-peek.png`) }); await context.close(); return; }

  await check(`${tag}: ac-2vs: the status bar ends at the edge of the page beside one panel`, async () => {
    // ac-2vs: the 2026-09-24 rules retire the Margin/marking gesture in this case.
    await assertSinglePanel(page); const b = await bar(page); assert.equal(b.position, 'fixed'); assert.ok(Math.abs(b.bottom-b.innerHeight)<=1); assert.ok(Math.abs(b.right-1440)<=1);
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

  await check(`${tag}: stored marks set "You marked up to line K · just now" and the rule sits after line K`, async () => {
    assert.equal((await walk(page)).rule, null, 'a rule with no marks');
    for (const i of [L.S1, L.S2]) {
      await selectPassage(page, i);
      await seedLegacyMark(page, i, 'agreed');
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
    const colors = await page.evaluate(() => [...document.querySelectorAll('.plm-needs-you')].map(g => getComputedStyle(g, '::after').backgroundColor));
    assert.equal(colors.filter(c => c === 'rgb(217, 140, 0)').length, lines.length, 'another dot is amber');
  });
  await check(`${tag}: answering an ask takes its amber dot away and the count follows`, async () => {
    await selectPassage(page, L.ASK);
    await page.keyboard.press('y');
    await waitFor(page, i => !document.querySelector(`.plm-needs-you[data-line="${i}"][data-needs-you="true"]`), L.ASK);
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
  await check(`${tag}: ac-2vs: the phone strip shows the title, Review and more options`, async () => {
    // ac-2vs: the 2026-09-24 rules retire the Margin/marking gesture in this case.
    await page.locator('.prw-strip').waitFor({state:'visible'}); assert.match(await page.locator('.prw-strip-info').innerText(),/Waiting on Mike/); assert.equal(await page.locator('.pst-bar').isVisible(),false);
  });
  await check(`${tag}: ac-2vs: the phone keeps open-item dots and ignores A/R`, async () => {
    // ac-2vs: the 2026-09-24 rules retire the Margin/marking gesture in this case.
    assert.deepEqual(await amber(page), await page.evaluate(()=>[...window.__proofLineMarks.needsYouLines()].sort((a,b)=>a-b))); await assertMarkKeysInactive(page);
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
    assert.equal(c.undo, null, 'Undo belongs to the Edit menu');
    assert.ok(c.seg && c.seg.width > 0, 'the labelled Editing control is not in the toolbar');
    assert.match(c.saved, /Saved|Sync|Connect|Offline/);
    assert.ok(c.title.right <= c.pill.left && c.pill.right <= c.share.left, 'title, Review and Share are out of order');
    assert.equal(await page.locator('.aov-toggle').count(), 0);
    assert.equal(await page.locator('#share-banner .anv-people').isVisible(), true);
    // S2a's toolbar (title, Review, People, Share) plus S3's one labelled control for direct Editing.
    for (const label of c.controls) assert.match(label, /^(Review|People|Share|Waiting on Mike|Enter Editing|Leave Editing|Undo|Nothing to undo)/, `unexpected toolbar control: ${label}`);
    const rails = await page.evaluate(() => ({ left: document.querySelector('.prw-left').getBoundingClientRect().top }));
    assert.ok(rails.left >= c.toolbar.bottom, 'a rail sits under the toolbar');
    await page.screenshot({ path: path.join(shots, `${tag}-chrome.png`), clip: { x: 0, y: 0, width: 1440, height: 120 } });
  });
  await check(`${tag}: the Issues pill counts the viewer's own Issues: it equals the status bar and the amber dots`, async () => {
    const lines = await amber(page);
    const c = await chrome(page);
    const b = await bar(page);
    assert.equal(c.pillText, `${lines.length} need you`);
    assert.equal(b.count, lines.length);
    const team = await page.evaluate(() => Number(document.querySelector('#share-banner .plm-issues-count').dataset.teamCount));
    assert.ok(team >= lines.length, 'All open must include Needs you');
    assert.match(await page.locator('#share-banner .plm-issues-count').getAttribute('title'), new RegExp(`^${lines.length} need you; ${team} open for the team`));
  });
  await check(`${tag}: Next goes to the lines that need you first`, async () => {
    const lines = await amber(page);
    const seen = [];
    for (let i = 0; i < lines.length; i += 1) {
      await page.locator('.anv-next').click();
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
    for (const label of ['Side panel', 'View agreed copy', 'Collapse all sections', 'Expand all sections', 'Show only decisions', 'Reading settings…', 'Familiar’s brief', 'Keyboard shortcuts']) assert.ok(view.includes(label), `View lacks ${label}: ${view}`);
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
  await check(`${tag}: Edit Undo names and reverses a stored agreement fixture`, async () => {
    await selectPassage(page, L.S1 + 2);
    await seedLegacyMark(page, L.S1 + 2, 'agreed');
    await page.locator('#accord-menubar .amb-top[data-menu="edit"]').click();
    assert.equal((await menuItems(page))[0].label, 'Undo agreed line 5');
    await page.locator('.amb-menu .amb-item').first().click();
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
    assert.equal(Number(await counts.getAttribute('data-team')), await page.evaluate(() => window.__proofLineMarks.issueSummary().counts.total));
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
  await check(`${tag}: the phone toolbar shows title, Review, People and Share with touch targets`, async () => {
    const c = await chrome(page);
    assert.equal(c.menubar, null);
    assert.equal(c.toolbar.top, 0);
    assert.equal(c.undo, null);
    assert.ok(!c.seg || c.seg.width === 0);
    assert.equal(c.pillText, `${(await amber(page)).length} need you`);
    for (const selector of ['[data-accord-review-toggle]', '.anv-people', '.share-pill-share-btn > button']) {
      const box = await page.locator(`#share-banner ${selector}`).boundingBox();
      assert.ok(box && box.height >= 44 && box.x >= 0 && box.x + box.width <= 391, selector);
    }
    assert.equal(await page.locator('.aov-toggle').count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(shots, `${tag}-toolbar.png`), clip: { x: 0, y: 0, width: 390, height: 120 } });
  });
  await check(`${tag}: the ⋯ menu holds the menu bar's menus; Reading settings opens as a sheet`, async () => {
    await page.locator('#share-banner').getByRole('button', { name: /^More options/ }).tap();
    const menu = page.locator('.proof-share-overflow-menu');
    await menu.waitFor();
    const text = await menu.innerText();
    for (const heading of ['FILE', 'EDIT', 'VIEW', 'PEOPLE', 'HELP']) assert.ok(text.toUpperCase().includes(heading), `no ${heading} group`);
    for (const label of ['Open…', 'Reading settings…', 'Share…', 'Add agent…', 'Keyboard shortcuts']) assert.ok(text.includes(label), `no ${label}`);
    // The switch and Share lead the menu (TOOLBAR_POLICY.phoneMenuTop), each only once.
    const top = await menu.evaluate(m => [...m.querySelectorAll('.apm-mode .amb-item')].map(b => ({ label: b.querySelector('.amb-label').textContent, checked: b.getAttribute('aria-checked') })));
    assert.deepEqual(top.map(t => t.label), ['Enter Editing']);
    assert.equal(await page.locator('.pst-mode').innerText(), 'Reading');
    const count = label => menu.evaluate((m, l) => [...m.querySelectorAll('.amb-item .amb-label')].filter(n => n.textContent === l).length, label);
    for (const label of ['Enter Editing']) assert.equal(await count(label), 1, `${label} appears twice`);
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
    await page.locator('#share-banner').getByRole('button', { name: /^More options/ }).tap();
    const menu = page.locator('.proof-share-overflow-menu');
    await menu.waitFor();
    await menu.locator('.apm-mode').getByRole('menuitem', { name: 'Enter Editing' }).tap();
    assert.equal(await page.locator('.pst-mode').innerText(), 'Editing');
    await page.locator('#share-banner').getByRole('button', { name: /^More options/ }).tap();
    await menu.waitFor();
    await menu.locator('.apm-mode').getByRole('menuitem', { name: 'Leave Editing' }).tap();
    assert.equal(await page.locator('.pst-mode').innerText(), 'Reading');
  });
  await check(`${tag}: ⋯ › Share… opens the Share dialog; it fits the phone`, async () => {
    await page.locator('#share-banner').getByRole('button', { name: /^More options/ }).tap();
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

  await check(`${tag}: ac-2vs: one 320 px panel leaves the remaining width for the page`, async () => {
    // ac-2vs: the 2026-09-24 rules retire the Margin/marking gesture in this case.
    await assertSinglePanel(page); assert.equal(await page.locator('.prw-left').evaluate(n=>n.getBoundingClientRect().width),320); await assertPassageActions(page);
  });

  await check(`${tag}: Issues lists the viewer's own Issues — the same lines as the amber dots and the pill — each with its kind and line`, async () => {
    const lines = await amber(page);
    const items = await page.evaluate(() => [...document.querySelectorAll('.prw-left .anv-issue')].map(b => ({ line: Number(b.dataset.line), title: b.querySelector('.anv-issue-title').textContent, kind: b.querySelector('.anv-issue-kind').textContent })));
    assert.deepEqual(items.map(i => i.line), lines);
    assert.equal(await page.locator('.prw-left .anv-tab[data-tab="issues"] .anv-badge').textContent(), String(lines.length));
    assert.equal((await chrome(page)).pillText, `${lines.length} need you`);
    assert.match(items[0].kind, new RegExp(`^Ask · line ${L.ASK + 1}$`));
    assert.match(items[1].kind, new RegExp(`^Change from \\w+ · line ${L.CHANGE + 1}$`));
    assert.match(items[2].kind, new RegExp(`^Comment from \\w+ · line ${L.COMMENT + 1}$`));
    assert.match(items[0].title, /turn on the cloud backup/);
    await page.screenshot({ path: path.join(shots, `${tag}-issues.png`), clip: { x: 0, y: 60, width: 260, height: 420 } });
  });
  await check(`${tag}: clicking an Issue moves the one cursor there — the status bar and passage actions name that line`, async () => {
    await page.locator(`.prw-left .anv-issue[data-line="${L.CHANGE}"]`).click();
    await waitFor(page, i => window.__proofReadingWalk.debugState().focus === i, L.CHANGE);
    const w = await walk(page);
    assert.equal(w.cursor, L.CHANGE);
    assert.equal(w.target, L.CHANGE);
    assert.equal(await page.evaluate(() => Number(document.querySelector('.prw-focus').dataset.line)), L.CHANGE);
    assert.equal((await bar(page)).line, `Line ${L.CHANGE + 1} of 25`);
    assert.equal(await page.locator('.accord-passage-actions').getAttribute('data-line'), String(L.CHANGE));
    assert.equal(await page.locator(`.prw-left .anv-issue[data-line="${L.CHANGE}"]`).getAttribute('aria-current'), 'true');
  });
  await check(`${tag}: ac-2vs: the passage has two actions and Review keeps proposal detail`, async () => {
    // ac-2vs: the 2026-09-24 rules retire the Margin/marking gesture in this case.
    await assertRetiredMarks(page); await assertPassageActions(page); assert.equal(await page.locator('.anv-detail .prw-accept').count(),1);
  });
  await check(`${tag}: ac-2vs: passage actions replace the retired More marking controls`, async () => {
    // ac-2vs: the 2026-09-24 rules retire the Margin/marking gesture in this case.
    await assertRetiredMarks(page); await assertPassageActions(page);
  });
  await check(`${tag}: Review replies to the selected comment; Discuss opens a new thread on a plain line`, async () => {
    await page.locator(`.prw-left .anv-issue[data-line="${L.COMMENT}"]`).click();
    await waitFor(page, i => window.__proofReadingWalk.debugState().focus === i, L.COMMENT);
    await page.locator('.anv-detail .amg-thread-reply-input').first().fill('Thanks, that settles it.');
    await page.locator('.anv-detail .amg-thread-reply-input').first().press('Enter');
    await waitFor(page, () => (window.proof.getAllMarks() ?? []).some(m => m.kind === 'comment' && (m.data?.replies ?? []).some(r => r.text === 'Thanks, that settles it.')));
    await page.evaluate(() => document.activeElement?.blur());
    await page.locator('.prw-left .anv-tab[data-tab="outline"]').click();
    await page.locator(`.prw-left .anv-heading[data-line="${L.H1}"]`).click();
    await waitFor(page, i => window.__proofReadingWalk.debugState().focus === i, L.H1);
    await page.keyboard.press('j');
    await waitFor(page, () => window.__proofReadingWalk.debugState().focus === 1);
    await page.locator('.plm-discuss').click();
    await page.locator('.amg-thread-text-input').fill('Is this line still true?');
    await page.locator('.amg-thread-new button[type="submit"]').click();
    await waitFor(page, () => (window.proof.getAllMarks() ?? []).some(m => m.kind === 'comment' && m.data?.text === 'Is this line still true?'));
    await page.evaluate(() => document.activeElement?.blur());
  });
  await check(`${tag}: Outline lists the headings with fold chips and counts; a chip folds its section, a heading moves the cursor`, async () => {
    await page.locator('.prw-left .anv-tab[data-tab="outline"]').click();
    const rows = await page.evaluate(() => [...document.querySelectorAll('.prw-left .anv-row')].map(r => ({ heading: Number(r.dataset.heading), count: r.querySelector('.anv-count').textContent, text: r.querySelector('.anv-heading').textContent })));
    assert.deepEqual(rows.map(r => r.heading), [L.H1, 5]);
    assert.equal(rows[1].text, 'Needs your hands');
    assert.match(rows[1].count, /^\d+$/);
    for (const label of ['Collapse all sections', 'Expand all sections']) assert.equal(await page.locator('.prw-left .pfold-controls').getByRole('button', { name: label, exact: true }).count(), 1, `${label} is not on the Outline`);
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
  await check(`${tag}: Since you keeps its report; Accords sit above the tabs and settings stay in their dialog`, async () => {
    await page.locator('.prw-left .anv-tab[data-tab="since"]').click();
    assert.equal(await page.locator('.prw-left .anv-pane[data-tab="since"]').isVisible(), true);
    assert.equal(await page.locator('.prw-left .anv-pane[data-tab="since"] .prw-since').count(), 1);
    assert.equal(await page.locator('.prw-rail .plm-blind, .prw-rail .prw-rate, .prw-rail .plm-budget').count(), 0);
    assert.equal(await page.locator('.anv-accords').count(), 1);
    await page.locator('.prw-left .anv-tab[data-tab="issues"]').click();
  });

  await check(`${tag}: hover preserves the selected passage`, async () => {
    await selectPassage(page, L.S2 + 3); await hoverChangesNothing(page, L.S2 + 5);
  });
  await check(`${tag}: ac-2vs: A/R after hover leave marks unchanged`, async () => {
    // ac-2vs: the 2026-09-24 rules retire the Margin/marking gesture in this case.
    await selectPassage(page,L.S2+3); await hoverChangesNothing(page,L.S2+5); await assertMarkKeysInactive(page);
  });
  await check(`${tag}: ac-2vs: passage actions stay with the selected passage after hover`, async () => {
    // ac-2vs: the 2026-09-24 rules retire the Margin/marking gesture in this case.
    await selectPassage(page,L.S2+3); await hoverChangesNothing(page,L.S2+5); await assertPassageActions(page);
  });
  await check(`${tag}: J selects the next visible passage after hover`, async () => {
    await selectPassage(page, L.S2 + 3); await hoverChangesNothing(page, L.S2 + 5);
    await page.keyboard.press('j'); assert.equal((await walk(page)).cursor, L.S2 + 4);
  });

  await check(`${tag}: ac-2vs: Room stays selected when the passage changes`, async () => {
    // ac-2vs: the 2026-09-24 rules retire the Margin/marking gesture in this case.
    await page.locator('#anv-tab-room').click(); await page.locator('#anv-pane-room .pch-input').waitFor({state:'visible'}); await selectPassage(page,L.S2); assert.equal(await page.locator('#anv-tab-room').getAttribute('aria-selected'),'true'); await page.locator('#anv-tab-issues').click();
  });
  await check(`${tag}: ac-2vs: the left panel and selected tab persist across reload`, async () => {
    // ac-2vs: the 2026-09-24 rules retire the Margin/marking gesture in this case.
    await page.locator('#anv-tab-outline').click(); await page.locator('.prw-left .prw-collapse').click(); await page.reload(); await page.waitForFunction(()=>window.__proofReadingWalk?.debugState().ready); assert.equal(await page.evaluate(()=>document.body.classList.contains('prw-left-collapsed')),true); await page.locator('.prw-left .prw-collapse').click(); assert.equal(await page.locator('#anv-tab-outline').getAttribute('aria-selected'),'true'); await page.locator('#anv-tab-issues').click();
  });
  await check(`${tag}: View › Side panel shows and hides the left panel`, async () => {
    await page.locator('#accord-menubar .amb-top[data-menu="view"]').click();
    await page.locator('.amb-menu .amb-item', { hasText: 'Side panel' }).click();
    await waitFor(page, () => document.body.classList.contains('prw-left-collapsed'));
    await page.locator('#accord-menubar .amb-top[data-menu="view"]').click();
    await page.locator('.amb-menu .amb-item', { hasText: 'Side panel' }).click();
    await waitFor(page, () => !document.body.classList.contains('prw-left-collapsed'));
  });
  await check(`${tag}: ac-2vs: stored team marks do not render marking controls`, async () => {
    // ac-2vs: the 2026-09-24 rules retire the Margin/marking gesture in this case.
    await seedTeamMarks(created); await page.evaluate(()=>window.__proofLineMarks.refresh()); await assertRetiredMarks(page);
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
  await check(`${tag}: ac-2vs: the phone strip shows title, Review and more options`, async () => {
    // ac-2vs: the 2026-09-24 rules retire the Margin/marking gesture in this case.
    await page.locator('.prw-strip').waitFor({state:'visible'}); assert.match(await page.locator('.prw-strip-info').innerText(),/Waiting on Mike/); assert.equal(await page.locator('.prw-strip-review').isVisible(),true); await assertRetiredMarks(page);
  });
  await check(`${tag}: ac-2vs: Review opens the left sheet with four tabs`, async () => {
    // ac-2vs: the 2026-09-24 rules retire the Margin/marking gesture in this case.
    await page.locator('.prw-strip-review').tap(); await page.locator('.prw-left.prw-sheet-open').waitFor({state:'visible'}); assert.deepEqual(await page.locator('.anv-tab').evaluateAll(ns=>ns.map(n=>n.dataset.tab)),['issues','outline','since','room']);
  });
  await check(`${tag}: ac-2vs: the sheet’s Room tab hosts chat and its close control works`, async () => {
    // ac-2vs: the 2026-09-24 rules retire the Margin/marking gesture in this case.
    await page.locator('#anv-tab-room').tap(); await page.locator('#anv-pane-room .pch-input').waitFor({state:'visible'}); assert.equal(await page.evaluate(()=>window.__proofChat.debugState().visible),true); await page.locator('.prw-left .prw-collapse').tap();
  });
  await check(`${tag}: ac-2vs: more options opens Room in the left sheet`, async () => {
    // ac-2vs: the 2026-09-24 rules retire the Margin/marking gesture in this case.
    await page.locator('.prw-strip-more').tap(); await page.locator('.proof-share-overflow-menu').getByRole('menuitem',{name:/^Room/}).tap(); await page.locator('#anv-pane-room .pch-input').waitFor({state:'visible'}); await page.locator('.prw-left .prw-collapse').tap();
  });
  await check(`${tag}: ac-2vs: the phone passage has touch actions and ignores A/R`, async () => {
    // ac-2vs: the 2026-09-24 rules retire the Margin/marking gesture in this case.
    await selectPassage(page,L.S1); await assertMarkKeysInactive(page); await assertPassageActions(page);
  });
  await check(`${tag}: Review opens the bottom sheet; selecting a row keeps it open`, async () => {
    await page.locator('[data-accord-review-toggle]').tap();
    const nav = page.locator('.prw-left.prw-sheet-open');
    await nav.waitFor({ state: 'visible' });
    const tabs = await page.evaluate(() => [...document.querySelectorAll('.prw-left.prw-sheet-open .anv-tab')].map(t => t.firstChild.textContent.trim()));
    assert.deepEqual(tabs, ['Review', 'Outline', 'Since you', 'Room']);
    await page.screenshot({ path: path.join(shots, `${tag}-navigator.png`) });
    await nav.locator(`.anv-issue[data-line="${L.CHANGE}"]`).tap();
    await waitFor(page, i => window.__proofReadingWalk.debugState().cursor === i, L.CHANGE);
    assert.equal(await page.locator('.prw-left.prw-sheet-open').count(), 1, 'the Review panel closed on selection');
    await page.locator('[data-accord-review-toggle]').tap();
    assert.equal(await page.locator('.prw-strip').getAttribute('data-line'), String(L.CHANGE));
  });
  await check(`${tag}: ac-2vs: stored team marks remain hidden on the phone`, async () => {
    // ac-2vs: the 2026-09-24 rules retire the Margin/marking gesture in this case.
    await seedTeamMarks(created); await page.evaluate(()=>window.__proofLineMarks.refresh()); await assertRetiredMarks(page); await assertPanelToggle(page);
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
