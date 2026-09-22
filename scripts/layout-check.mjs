#!/usr/bin/env node
// Browser check for the Accord layout redesign (Ren's proposal, Mike ruled 2026-09-21: "build the
// layout that you proposed"). It grows one stage at a time; each stage's checks stay.
//   Stage 1: the status bar under the page (Line N of M, "You marked up to line K", Issues left,
//            Reading / Writing), the "You marked up to here" rule in the page, and two highlight
//            states only (blue bar = you are here, amber margin dot = needs you).
// Region checks compare against the mockups in Ren's proposal (regions present and positioned,
// not pixel-perfect): the status bar sits at the bottom of the page column between the rails, its
// state word at its right end; the rule sits inside the page between two lines.
// Authorship: Claude Opus 5 (worker accord-layout1), 2026-09-21, in the style of mike-0921-check.mjs.
// Starts an isolated local server on the current dist/ build (run `npm run build` first) in both
// review styles, at 1440 and on a 390x844 phone. Screenshots go to .preview/ (or --shots <dir>).
// Exit 0 only if every check passes.
// Usage: node scripts/layout-check.mjs [--style playmaker|proof] [--shots dir] [--peek]
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
const styles = arg('--style') ? [arg('--style')] : ['playmaker', 'proof'];
const peek = process.argv.includes('--peek');

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
  await check(`${tag}: scrolling moves the line number and never moves the bar`, async () => {
    const before = await bar(page);
    await page.mouse.move(700, 500);
    for (let i = 0; i < 6; i += 1) { await page.mouse.wheel(0, 240); await page.waitForTimeout(120); }
    await page.waitForTimeout(300);
    const after = await bar(page);
    const w = await walk(page);
    assert.ok(w.target > 0, 'the walk did not move');
    assert.equal(after.line, `Line ${w.target + 1} of ${w.lines}`);
    assert.equal(Math.round(after.top), Math.round(before.top), 'the bar moved');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
  });
  await check(`${tag}: the caret in the text shows Writing in the bar; Esc shows Reading`, async () => {
    const box = await block(page, L.S1).boundingBox();
    await page.mouse.click(box.x + 80, box.y + 10);
    await waitFor(page, () => document.querySelector('.pst-bar .pst-mode')?.textContent === 'Writing');
    await page.screenshot({ path: path.join(shots, `${tag}-writing.png`), clip: { x: 240, y: 840, width: 880, height: 60 } });
    await page.keyboard.press('Escape');
    await waitFor(page, () => document.querySelector('.pst-bar .pst-mode')?.textContent === 'Reading');
  });

  await check(`${tag}: marking lines explicitly sets "You marked up to line K · just now" and the rule sits after line K`, async () => {
    assert.equal((await walk(page)).rule, null, 'a rule with no marks');
    for (const i of [L.S1, L.S2]) {
      await hoverLine(page, i);
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
    await hoverLine(page, L.ASK);
    await page.keyboard.press('y');
    await waitFor(page, i => !document.querySelector(`.plm-dot[data-line="${i}"][data-needs-you="true"]`), L.ASK);
    const lines = await amber(page);
    assert.deepEqual(lines, [L.CHANGE, L.COMMENT, L.ASK2]);
    await waitFor(page, n => Number(document.querySelector('.pst-issues')?.dataset.count) === n, lines.length);
  });

  await check(`${tag}: one "you are here" look — the hovered line gets the same bar and tint as the reading line`, async () => {
    const style = () => page.evaluate(() => { const f = document.querySelector('.prw-focus'); const s = getComputedStyle(f); return { source: f.dataset.source, bg: s.backgroundColor, shadow: s.boxShadow }; });
    await page.mouse.move(5, 450);
    await page.keyboard.press('j');
    await page.waitForTimeout(200);
    const reading = await style();
    await hoverLine(page, L.LAST - 3);
    await page.waitForTimeout(250);
    const hover = await style();
    assert.equal(hover.source, 'hover');
    assert.equal(reading.source, 'reading');
    assert.equal(hover.bg, reading.bg);
    assert.equal(hover.shadow, reading.shadow);
    const alpha = Number(/rgba?\([^)]*?([\d.]+)\)$/.exec(hover.bg)?.[1] ?? '1');
    assert.ok(alpha >= 0.1, `the band is too faint (alpha ${alpha})`);
    assert.match(hover.shadow, /inset/, 'no left bar');
  });
  await check(`${tag}: no decision ◆ in the margin and no dimmed context text`, async () => {
    assert.equal(await page.locator('.plm-dot .plm-tier').count(), 0);
    assert.equal(await page.evaluate(() => document.body.classList.contains('phl-context-dim')), false);
  });
  await check(`${tag}: a change scrolled past stays an ordinary insert / delete; the bar lists it with Save`, async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await page.mouse.move(5, 450);
    for (let i = 0; i < 40; i += 1) {
      const s = await walk(page);
      if (s.focus > L.CHANGE) break;
      await page.keyboard.press('j');
      await page.waitForTimeout(40);
    }
    await waitFor(page, () => window.__proofReadingWalk.debugState().provisional.length === 1);
    const look = await page.evaluate(() => {
      const del = document.querySelector('.ProseMirror .mark-delete');
      const ins = document.querySelector('.ProseMirror .mark-insert:not(.mark-delete), .ProseMirror .mark-replace-insert');
      return { delShown: del ? getComputedStyle(del).display !== 'none' : null, insBorder: ins ? getComputedStyle(ins).borderBottomStyle : null };
    });
    assert.equal(look.delShown, true, 'the old words were hidden');
    assert.notEqual(look.insBorder, 'dashed', 'the new words are dashed');
    const b = await bar(page);
    assert.match(b.provisional, /1 accepted by scrolling, not saved/);
    await page.screenshot({ path: path.join(shots, `${tag}-provisional.png`) });
    await page.locator('.pst-bar .pst-save').click();
    await waitFor(page, () => window.__proofReadingWalk.debugState().provisional.length === 0);
    const w = await walk(page);
    assert.ok(w.commits.some(c => c.ok), 'Save did not commit');
    await waitFor(page, () => !document.querySelector('.pst-bar .pst-provisional:not([hidden])'));
    await waitFor(page, i => !document.querySelector(`.plm-dot[data-line="${i}"][data-needs-you="true"]`), L.CHANGE);
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
  await check(`${tag}: a compact one-line status bar sits right above the bottom strip`, async () => {
    const b = await bar(page);
    assert.ok(b, 'no status bar');
    const strip = await page.locator('.prw-strip').boundingBox();
    assert.ok(strip, 'no strip');
    assert.ok(Math.abs(b.bottom - strip.y) <= 2, `bar bottom ${b.bottom}, strip top ${strip.y}`);
    assert.ok(b.height <= 28, `bar height ${b.height}`);
    assert.ok(b.left <= 1 && b.right >= 389, 'the bar does not span the phone');
    const fits = await page.evaluate(() => { const e = document.querySelector('.pst-bar'); return e.scrollWidth <= e.clientWidth + 1; });
    assert.ok(fits, 'the bar overflows its one line');
    assert.equal(b.line, 'Line 1 of 25');
    assert.match(b.issues, /^4 Issues left$/);
    assert.equal(b.mode, 'Reading');
    const chip = await page.locator('.soma-feedback-root').boundingBox().catch(() => null);
    if (chip) assert.ok(chip.y + chip.height <= b.top + 1, 'the feedback chip covers the bar');
    await page.screenshot({ path: path.join(shots, `${tag}-statusbar.png`) });
  });
  await check(`${tag}: amber dots match the count; marking a line shows "Marked to line K"`, async () => {
    assert.deepEqual(await amber(page), [L.ASK, L.CHANGE, L.COMMENT, L.ASK2]);
    await page.locator('.prw-strip-agree').tap();
    await waitFor(page, () => /line 1/.test(document.querySelector('.pst-bar .pst-marked')?.textContent ?? ''));
    // Phones say "Marked to line 1" (the label's first words come from the link's ::before).
    const text = await page.evaluate(() => {
      const link = document.querySelector('.pst-bar .pst-marked-link');
      return `${getComputedStyle(link, '::before').content.replace(/"/g, '')}${link.textContent}`;
    });
    assert.equal(text, 'Marked to line 1');
    const fits = await page.evaluate(() => { const e = document.querySelector('.pst-bar'); return e.scrollWidth <= e.clientWidth + 1; });
    assert.ok(fits, 'the bar overflows its one line');
    await page.screenshot({ path: path.join(shots, `${tag}-marked.png`) });
  });
  await check(`${tag}: a tap on the text shows Writing; the bar stays on screen when the strip steps aside`, async () => {
    await block(page, L.S1).scrollIntoViewIfNeeded();
    const box = await block(page, L.S1).boundingBox();
    await page.touchscreen.tap(box.x + 60, box.y + 10);
    await waitFor(page, () => document.querySelector('.pst-bar .pst-mode')?.textContent === 'Writing');
    const b = await bar(page);
    assert.ok(b.bottom <= b.innerHeight + 1 && b.top >= 0, 'the bar left the screen');
    await page.screenshot({ path: path.join(shots, `${tag}-writing.png`) });
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
console.log(`\n${results.length - failures}/${results.length} layout checks passed`);
process.exit(failures ? 1 : 0);
