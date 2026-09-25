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

const clientHeaders = { 'X-Proof-Client-Version': '0.33.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
let failures = 0;
const results = [];
let activePage = null;
const amber = page => page.evaluate(() => [...document.querySelectorAll('.plm-open-dot[data-needs-you="true"]')].map(d => Number(d.dataset.line)).sort((a, b) => a - b));
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

// Mike, 2026-09-24, yfbqrau4: stages 1 and 3's Margin/mark UI assertions are
// superseded by layout-v2-check.mjs. Stage 2's menu, Share and toolbar checks stay here.
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
    for (const label of c.controls) assert.match(label, /^(Review|People|Share|Waiting on Mike|Edit text|Leave text|Enter Editing|Leave Editing|Undo|Nothing to undo)/, `unexpected toolbar control: ${label}`);
    const rails = await page.evaluate(() => ({ left: document.querySelector('.prw-left').getBoundingClientRect().top, right: document.querySelector('.prw-right').getBoundingClientRect().top }));
    assert.ok(rails.left >= c.toolbar.bottom && rails.right >= c.toolbar.bottom, 'a rail sits under the toolbar');
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
    assert.ok(!view.includes('Show only decisions'), 'retired tier filter');
    for (const label of ['Review panel', 'View agreed copy', 'Accords list', 'Collapse all sections', 'Expand all sections', 'Reading settings…', 'Keyboard shortcuts']) assert.ok(view.includes(label), `View lacks ${label}: ${view}`);
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
  await check(`${tag}: View › Reading settings holds This sitting (gone from the rail), and both still work`, async () => {
    const panel = page.locator('#reading-settings');
    assert.equal(await page.locator('.prw-right .prw-rate, .prw-right .plm-budget').count(), 0, 'a setting is still in the rail');
    assert.equal(await panel.locator('.prw-rate').count(), 0, 'retired dwell controls');
    await panel.locator('.plm-budget select').selectOption('5');
    await waitFor(page, () => document.querySelector('#reading-settings .plm-budget')?.dataset.state === 'on');
    await page.screenshot({ path: path.join(shots, `${tag}-reading-settings.png`) });
    await panel.locator('.plm-budget select').selectOption('0');
    await panel.getByRole('button', { name: 'Close reading settings' }).click();
    assert.equal(await panel.isVisible(), false);
  });
  await check(`${tag}: Edit and the toolbar put the caret in the text; Escape returns to Review`, async () => {
    await page.locator('#accord-menubar .amb-top[data-menu="edit"]').click();
    assert.ok((await menuItems(page)).some(i => i.label === 'Edit text'));
    await page.locator('.amb-menu .amb-item', { hasText: 'Edit text' }).click();
    await page.waitForFunction(() => window.__proofEditingGuard().writing);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.__proofEditingGuard().writing), false);
    await page.getByRole('button', { name: 'Edit text', exact: true }).click();
    await page.waitForFunction(() => window.__proofEditingGuard().writing);
    await page.keyboard.press('Escape');
  });
  await check(`${tag}: Edit Undo reverses live proposal typing`, async () => {
    await page.evaluate(i => window.__proofReadingWalk.focusDocument(i), L.S1 + 2);
    const before = await page.evaluate(() => window.__editorView.state.doc.textContent);
    await page.keyboard.type('Undo this typing ');
    await page.keyboard.press('Escape');
    await page.locator('#accord-menubar .amb-top[data-menu="edit"]').click();
    await page.locator('.amb-menu .amb-item[data-item="edit-undo"]').click();
    await page.waitForFunction(t => window.__editorView.state.doc.textContent === t, before);
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
    // Step 3 round 2 (brief B1): the People menu starts with who you are (and Sign in, when the server has it).
    const people = (await menuItems(page)).map(i => i.label).filter(label => label !== 'Sign in');
    assert.match(people[0], /— guest, unverified$|^Signed in as /, `People menu does not say who you are: ${people[0]}`);
    assert.deepEqual(people.slice(1), ['Share…', 'Invite person…', 'Add agent…', 'Who is here']);
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
    await page.getByRole('button', { name: /^More options/ }).tap();
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
  await check(`${tag}: the phone edit command places the caret; Escape returns to Reading`, async () => {
    await page.getByRole('button', { name: /^More options/ }).tap();
    await page.locator('.proof-share-overflow-menu').getByRole('menuitem', { name: 'Enter Editing' }).tap();
    await page.waitForFunction(() => window.__proofEditingGuard().writing);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.__proofEditingGuard().writing);
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
const browser = await chromium.launch();
try {
  for (const style of styles) {
    const { base, stop } = await startServer(style);
    try {

      if (stages.includes(2) && !peek) { await desktop2(browser, base, style); await phone2(browser, base, style); }

    } finally {
      await stop();
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${results.length - failures}/${results.length} layout checks passed`);
if (!failures && (stages.includes(1) || stages.includes(3))) await import('./layout-v2-check.mjs');
process.exit(failures ? 1 : 0);
