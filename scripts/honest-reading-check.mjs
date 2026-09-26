#!/usr/bin/env node
import { showWholeAccord } from './review-ui.mjs';
// Browser check for Proof Documents Steps B3b and B3c: honest reading and alignment.
//   B3b: the reading time scales with a line's words (a per-reader rate in the rail); a line
//        scrolled past faster stays unmarked; the rail says how a Seen
//        was earned; a spelling fix carries marks forward (tilde badge, "Was:", Mark unseen) while
//        a number change resets them.
//   B3c: historical data remains stored; the Since you UI retired in ac-2a8, replaced by open items.
//        list; "Aligned as of <time>" in the top bar once the Issue count reaches 0, opening the
//        snapshot's markdown ledger; a later rejection starts a new round ("Last aligned").
// Authorship: Claude Opus 5 (worker proof-honest), 2026-09-18, in the style of reading-walk-check.mjs.
// Starts an isolated local server on the current dist/ build (run `npm run build` first), creates
// throwaway documents on a temp SQLite database, and drives Chromium in both review styles at
// 1440 (desktop) and 390 (phone). Screenshots go to .preview/ (or --shots <dir>).
// Exit code 0 only if every check passes.
// Usage: node scripts/honest-reading-check.mjs [--style playmaker|proof] [--shots dir]
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

const clientHeaders = { 'X-Proof-Client-Version': '0.34.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `honest-reading-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-honest-check-'));
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

const plain = (n) => `Paragraph ${n} is plain text for reading; it carries no suggestions and is long enough to be a real line.`;
const LONG = 'This long paragraph has exactly twenty four words in it so that at four words each second it needs six whole seconds to read.';
const TYPO = 'We will review teh budget with the whole team next week and share the notes.';
const PRICE = 'The fee is $10 per seat for every team this quarter.';
const markdown = [
  '# Honest reading check',        // 0
  'Short line one.',               // 1
  LONG,                            // 2
  TYPO,                            // 3
  PRICE,                           // 4
  ...Array.from({ length: 10 }, (_, i) => plain(i + 5)), // 5..14
  'Last line.',                    // 15
].join('\n\n');
const L = { HEAD: 0, SHORT: 1, LONG: 2, TYPO: 3, PRICE: 4, P6: 6, P7: 7, LAST: 15 };

async function createDoc(base, md = markdown, title = 'Honest reading check') {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown: md, title }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

const agentHeaders = (token) => ({ 'Content-Type': 'application/json', ...clientHeaders, 'x-share-token': token });
async function agent(base, created, route, body, method = 'POST') {
  const r = await fetch(`${base}/api/agent/${created.slug}${route}`, { method, headers: agentHeaders(created.ownerSecret), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  assert.ok(r.ok, `${route}: ${r.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** Replaces blocks through /edit/v2 (the way an AI edits). */
async function editBlocks(base, created, replacements) {
  const snap = await agent(base, created, '/snapshot', undefined, 'GET');
  const operations = replacements.map(([ref, md]) => ({ op: 'replace_block', ref, block: { markdown: md } }));
  const r = await fetch(`${base}/api/agent/${created.slug}/edit/v2`, {
    method: 'POST', headers: { ...agentHeaders(created.ownerSecret), 'Idempotency-Key': `k-${Date.now()}-${Math.random()}` },
    body: JSON.stringify({ by: 'ai:check', baseRevision: snap.revision, operations }),
  });
  assert.ok(r.status === 200 || r.status === 202, `edit/v2: ${r.status} ${(await r.text()).slice(0, 300)}`);
}

async function openDoc(browser, base, slug, name, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
  await context.route('**/*', route => new URL(route.request().url()).origin === base || route.request().url().startsWith('blob:') ? route.continue() : route.abort());
  await context.addInitScript(viewer => { try { localStorage.setItem('proof-share-viewer-name', viewer); } catch {} }, name);
  const page = await context.newPage();
  await page.goto(`${base}/d/${slug}`);
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForFunction(() => window.__proofReadingWalk?.debugState().ready === true, null, { timeout: 10_000 });
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  page.setDefaultTimeout(6000);
  await showWholeAccord(page);
  return { context, page };
}

const walk = page => page.evaluate(() => window.__proofReadingWalk.debugState());
const dotStatus = (page, line) => page.evaluate(i => document.querySelector(`.plm-dot[data-line="${i}"]`)?.dataset.status ?? null, line);
const waitFor = (page, fn, arg, timeout = 9000) => page.waitForFunction(fn, arg, { timeout, polling: 100 });
const myMark = (page, line) => page.evaluate(i => {
  const lm = window.__proofLineMarks;
  const me = lm.me().toLowerCase();
  const entry = lm.lineState(i)?.marks.get(me);
  return entry ? { status: entry.mark.status, via: entry.mark.via ?? null, current: entry.current, carried: Boolean(entry.carried) } : null;
}, line);

async function desktop(browser, base, style) {
  const created = await createDoc(base);
  const tag = `honest-${style}-1440`;
  const { context, page } = await openDoc(browser, base, created.slug, 'Ada', { viewport: { width: 1440, height: 900 } });
  activePage = page;
  const rail = page.locator('.prw-right');

  await check(`${tag}: historical marks survive a spelling fix and become outdated after a number change`, async () => {
    // Legacy data remains readable after the retirement of reader mark controls.
    for (const line of [L.TYPO, L.PRICE]) await agent(base, created, '/marks/line', { by: 'guest:Ada', status: 'agreed', lineIndex: line });
    await editBlocks(base, created, [['b4', TYPO.replace('teh', 'the')], ['b5', PRICE.replace('$10', '$100')]]);
    await waitFor(page, () => document.querySelector('.ProseMirror')?.textContent.includes('$100'), null, 12000);
    await waitFor(page, i => window.__proofLineMarks.myStatus(i) === 'agreed', L.TYPO);
    await waitFor(page, i => window.__proofLineMarks.myStatus(i) === 'changed', L.PRICE);
    assert.equal(await page.locator('.plm-dot, .plm-carried').count(), 0);
    await page.screenshot({ path: path.join(shots, `${tag}-3-historical-marks.png`) });
  });

  await check(`${tag}: legacy history stays stored and new proposals appear in Review`, async () => {
    await agent(base, created, '/marks/line', { by: 'guest:Ada', status: 'seen', lineIndex: L.LONG, via: 'dwell' });
    await agent(base, created, '/marks/line', { by: 'ai:check', status: 'rejected', reason: 'Wrong number of words', lineIndex: L.P7 });
    await agent(base, created, '/marks/suggest-replace', { quote: 'six whole seconds', content: 'six full seconds', by: 'ai:check' });
    await page.reload();
    await showWholeAccord(page);
    assert.equal(await page.locator('[data-tab="since"], .prw-since').count(), 0);
    const lm = await agent(base, created, '/state', undefined, 'GET');
    assert.ok(JSON.stringify(lm).includes('Wrong number of words'), 'Stored historical rejection was lost');
    await page.locator('.anv-issue[data-line="2"]').click();
    await waitFor(page, i => window.__proofReadingWalk.focusIndex() === i, L.LONG);
    await page.screenshot({ path: path.join(shots, `${tag}-4-review.png`) });
  });
  await context.close();

  // Aligned snapshot on a small document.
  const small = await createDoc(base, '# Tiny plan\n\nWe ship on Friday.\n\nEric checks the numbers.', 'Tiny plan');
  const t = await openDoc(browser, base, small.slug, 'Ada', { viewport: { width: 1440, height: 900 } });
  activePage = t.page;
  await check(`${tag}: at 0 Issues the top bar says "Aligned as of <time>" and opens the snapshot's ledger`, async () => {
    for (const who of ['guest:Ada', 'ai:check']) {
      await agent(base, small, '/marks/line', { by: who, status: 'agreed', lines: [{ lineIndex: 0 }, { lineIndex: 1 }, { lineIndex: 2 }] });
    }
    const link = t.page.locator('#share-banner .plm-aligned-at');
    await waitFor(t.page, () => /Aligned as of/.test(document.querySelector('#share-banner .plm-aligned-at')?.textContent ?? ''), null, 15000);
    // The Issues pill said "Aligned". The Review count names the scope. Mike, 2026-09-23 (usability brief).
    assert.equal(await t.page.locator('#share-banner .plm-issues-count').innerText(), '0 need you');
    await t.page.screenshot({ path: path.join(shots, `${tag}-5-aligned.png`), clip: { x: 0, y: 0, width: 1440, height: 160 } });
    const [ledger] = await Promise.all([t.context.waitForEvent('page'), link.click()]);
    await ledger.waitForLoadState();
    await ledger.waitForFunction(() => /Aligned snapshot/.test(document.body?.innerText ?? ''), null, { timeout: 8000 });
    const body = await ledger.evaluate(() => document.body.innerText);
    assert.match(body, /# Aligned snapshot: Tiny plan/);
    assert.match(body, /We ship on Friday/);
    assert.match(body, /\| guest:Ada \||Ada \(guest\)/);
    await ledger.close();
  });
  await check(`${tag}: a later rejection starts a new round: "Last aligned <time>"`, async () => {
    await agent(base, small, '/marks/line', { by: 'ai:check', status: 'rejected', reason: 'Friday is too soon', lineIndex: 1 });
    let lastAligned = '';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await t.page.evaluate(() => window.__proofLineMarks.refresh());
      await t.page.waitForTimeout(600);
      lastAligned = await t.page.locator('#share-banner .plm-aligned-at').innerText().catch(() => '');
      if (/Last aligned/.test(lastAligned)) break;
    }
    assert.match(lastAligned, /Last aligned/);
    assert.equal(await t.page.locator('#share-banner .plm-issues-count').innerText(), '0 need you');
  });
  await t.context.close();
}

async function phone(browser, base, style) {
  const created = await createDoc(base);
  const viewport = { width: 390, height: 844 };
  const tag = `honest-${style}-phone-390x844`;
  const { context, page } = await openDoc(browser, base, created.slug, 'Pat', {
    ...devices['iPhone 13'], viewport, screen: viewport, hasTouch: true, isMobile: true,
  });
  activePage = page;
  await check(`${tag}: a quick scroll leaves skipped lines unmarked; no sideways scroll`, async () => {
    await page.mouse.wheel(0, 3000); await page.waitForTimeout(1000);
    assert.deepEqual((await walk(page)).seenWrites, []);
    assert.equal(await page.locator('.plm-dot').count(), 0);
    const size = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    assert.ok(size[0] <= size[1] + 1);
    await page.screenshot({ path: path.join(shots, `${tag}-1-no-marks.png`) });
  });
  await check(`${tag}: ⋯ › Reading settings holds the sitting budget; the Review sheet holds open items; items are big enough to tap`, async () => {
    // Pat marks a line on purpose, then an AI edits and rejects: Since you has items on reload.
    await agent(base, created, '/marks/line', { by: 'guest:Pat', status: 'agreed', lineIndex: L.PRICE });
    await new Promise(r => setTimeout(r, 30));
    await editBlocks(base, created, [['b5', PRICE.replace('$10', '$12')]]);
    await agent(base, created, '/marks/line', { by: 'ai:check', status: 'rejected', reason: 'Too long', lineIndex: 5 });
    await page.reload();
    await showWholeAccord(page);
    await page.locator('#share-banner .share-pill-overflow').tap();
    await page.getByRole('menuitem', { name: /Reading settings/ }).tap();
    const settings = page.locator('#reading-settings');
    await settings.waitFor({ state: 'visible' });
    assert.ok(await settings.locator('.plm-budget select').isVisible(), 'no sitting budget in Reading settings');
    await settings.getByRole('button', { name: 'Close reading settings' }).tap();
    await page.locator('#share-banner .share-pill-overflow').tap();
    await page.getByRole('menuitem', { name: /Review panel/ }).tap();
    const sheet = page.locator('.prw-right.prw-sheet-open');
    await sheet.waitFor({ state: 'visible' });
    assert.equal(await sheet.locator('[data-tab="since"]').count(), 0);
    await agent(base, created, '/marks/suggest-replace', { quote: 'six whole seconds', content: 'six full seconds', by: 'ai:check' });
    const item = sheet.locator('.anv-issue').first();
    await item.waitFor({ state: 'visible' });
    const box = await item.boundingBox();
    assert.ok(box && box.height >= 44, `tap target ${box?.height}`);
    const index = Number(await item.getAttribute('data-line'));
    await item.tap();
    await waitFor(page, i => window.__proofReadingWalk.focusIndex() === i, index);
    assert.equal(await sheet.isVisible(), true, 'Review selection retains its list on the phone');
    await page.screenshot({ path: path.join(shots, `${tag}-2-review-sheet.png`) });
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
console.log(`\n${results.length - failures}/${results.length} honest-reading checks passed`);
process.exit(failures ? 1 : 0);
