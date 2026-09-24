#!/usr/bin/env node
// Browser check for Proof Documents Step 1 (line marks, Issues, Next issue).
// Authorship: Claude Opus 5 (worker proof-line-marks), 2026-09-18, in the style of mobile-check.mjs.
// Starts an isolated local server on the current dist/ build (run `npm run build` first), creates
// throwaway documents on a temp SQLite database, and drives Chromium at desktop and phone sizes.
// Screenshots go to .preview/. Exit code 0 only if every check passes.
// Step 1b (reading walk, 2026-09-18): on desktop a dot focuses its line and the mark box sits in
// the right rail (no popover); the focus line becomes Seen after a short dwell, so counts below
// wait for that first.
// Usage: node scripts/line-marks-check.mjs [--style playmaker|proof]
import { nextReview, showReview } from './review-ui.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const shotsArg = process.argv.indexOf('--shots');
const shots = shotsArg > 0 ? process.argv[shotsArg + 1] : path.join(root, '.preview');
mkdirSync(shots, { recursive: true });
const styleArg = process.argv.indexOf('--style');
const style = styleArg > 0 ? process.argv[styleArg + 1] : 'playmaker';

const clientHeaders = { 'X-Proof-Client-Version': '0.33.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `line-marks-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer() {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-line-marks-check-'));
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

const markdown = `# Proof Document (line marks check)

The first line is a short paragraph that the team must read.

The second paragraph is long enough to wrap across several lines on a phone, so the margin dot must stay beside its first line and never push the text sideways.

- A list item is a line of its own
- So is this second item

| Name | Role |
| --- | --- |
| Mike | Owner |

The last paragraph sits near the bottom.`;
const LINE_COUNT = 8;

async function createDoc(base) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown, title: 'Line marks check' }),
  });
  assert.equal(response.status, 200);
  return await response.json();
}

async function seedReviewAsks(base, created, page, indices) {
  const facts = await page.evaluate(indices => ({ viewer: window.__proofLineMarks.me(), quotes: indices.map(i => window.__proofLineMarks.lineList()[i].text) }), indices);
  for (const quote of facts.quotes) {
    const response = await fetch(`${base}/api/agent/${created.slug}/asks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders, 'x-share-token': created.ownerSecret },
      body: JSON.stringify({ by: 'ai:fixture', quote, to: [facts.viewer], recommend: 'Review this passage.' }),
    });
    assert.ok(response.ok, await response.text());
  }
  await waitFor(page, indices => indices.every(i => window.__proofOpenView.openItems().lines.includes(i)), indices);
}

async function openDoc(browser, base, slug, name, contextOptions = {}, query = '') {
  const context = await browser.newContext(contextOptions);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.addInitScript(viewer => { try { localStorage.setItem('proof-share-viewer-name', viewer); } catch {} }, name);
  const page = await context.newPage();
  if (process.env.DEBUG) {
    page.on('response', r => { if (r.url().includes('line-marks') && r.request().method() === 'POST') r.text().then(t => console.log(`  [${name}] POST ${r.status()} ${t.slice(0, 100)}`)); });
    page.on('console', m => { if (m.type() === 'error') console.log(`  [${name}] console: ${m.text().slice(0, 160)}`); });
  }
  await page.goto(`${base}/d/${slug}${query}`);
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForSelector('#share-banner');
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForTimeout(500);
  page.setDefaultTimeout(6000);
  return { context, page };
}

const dotStatus = (page, line) => page.evaluate(i => window.__proofLineMarks.myStatus(i), line);
const issues = page => page.evaluate(() => window.__proofLineMarks.debugState().issues);
const waitFor = (page, fn, arg, timeout = 9000) => page.waitForFunction(fn, arg, { timeout, polling: 200 });
// Desktop: the dot focuses the line and its box is in the right rail. Phones: the Step 1 sheet.
const markBox = (page, line) => page.locator(`.prw-right .plm-box[data-line="${line}"], .plm-menu`);
// Historical fixtures only. Mike retired the user controls, not stored marks or their APIs.
async function mark(page, line, label, reason) {
  const status = /Approve/.test(label.source) ? 'approved' : /Reject/.test(label.source) ? 'rejected' : /Agree/.test(label.source) ? 'agreed' : 'seen';
  await page.evaluate(({ line, status, reason }) => window.__proofLineMarks.setLineStatus(line, status, reason, 'click'), { line, status, reason });
}

async function desktop(browser, base) {
  const created = await createDoc(base);
  const slug = created.slug;
  const tag = `line-marks-${style}-desktop`;
  const a = await openDoc(browser, base, slug, 'Ada', { viewport: { width: 1280, height: 900 } });
  const page = a.page;
  activePage = page;

  await check(`${tag}: plain lines have no mark circles or mark controls`, async () => {
    assert.equal(await page.locator('.plm-dot, .plm-box, .plm-menu').count(), 0);
    assert.equal(await page.locator('.plm-open-dot').count(), 0);
  });
  await check(`${tag}: Review names its scope and excludes unread lines`, async () => {
    await waitFor(page, () => window.__proofLineMarks.myStatus(0) === 'seen');
    assert.equal(await page.locator('#share-banner .plm-issues-count').textContent(), '0 need you');
    assert.ok(await page.locator('[data-accord-review-toggle]').isVisible());
  });
  await check(`${tag}: Seen on line 1 lowers the count`, async () => {
    await mark(page, 0, /Seen/);
    assert.equal(await dotStatus(page, 0), 'seen');
    assert.equal(await issues(page), LINE_COUNT - 1);
  });
  await check(`${tag}: historical Agree and Reject records remain stored without rendering circles`, async () => {
    await mark(page, 1, /Agree/);
    await mark(page, 2, /Reject/, 'Needs a source');
    assert.equal(await dotStatus(page, 1), 'agreed');
    assert.equal(await dotStatus(page, 2), 'rejected');
    assert.equal(await page.locator('.plm-dot, .plm-box').count(), 0);
    assert.ok((await page.evaluate(() => window.__proofLineMarks.debugState().marks)).some(m => m.reason === 'Needs a source'));
  });
  await check(`${tag}: marks survive a reload`, async () => {
    await page.reload();
    await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 20_000 });
    await waitFor(page, () => window.__proofLineMarks.myStatus(1) === 'agreed');
    assert.equal(await dotStatus(page, 0), 'seen');
    assert.equal(await dotStatus(page, 2), 'rejected');
  });
  await check(`${tag}: the document text stays clean`, async () => {
    const doc = await (await fetch(`${base}/api/documents/${slug}`, { headers: clientHeaders })).json();
    assert.ok(!/plm-|line-mark|lineMark|Needs a source/.test(doc.markdown), 'mark data leaked into markdown');
    assert.ok(!JSON.stringify(doc.marks ?? {}).includes('Needs a source'), 'mark data leaked into marks');
  });

  const b = await openDoc(browser, base, slug, 'Bob', { viewport: { width: 1280, height: 900 } });
  await check(`${tag}: a second person sees the first person's marks and joins the team by marking`, async () => {
    await waitFor(b.page, () => window.__proofLineMarks.debugState().marks.some(m => m.anchor.ordinal === 1 && m.status === 'agreed'));
    await mark(b.page, 1, /Seen/);
    await waitFor(page, () => window.__proofLineMarks.debugState().marks.some(m => m.anchor.ordinal === 1 && m.status === 'seen'));
    const team = await page.evaluate(() => window.__proofLineMarks.debugState().team);
    assert.deepEqual(team.map(t => t.toLowerCase()).sort(), ['guest:ada', 'guest:bob']);
  });
  await check(`${tag}: an AI's historical mark remains available through the API`, async () => {
    const response = await fetch(`${base}/api/agent/${slug}/marks/line`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders, 'x-share-token': created.ownerSecret },
      body: JSON.stringify({ quote: 'The last paragraph', status: 'agreed', by: 'ai:claude' }),
    });
    assert.equal(response.status, 200, await response.text());
    await waitFor(page, () => window.__proofLineMarks.debugState().marks.some(m => m.anchor.ordinal === 7 && m.status === 'agreed'));
  });
  await check(`${tag}: editing a line publishes a proposal without a line agreement`, async () => {
    const before = await b.page.evaluate(() => window.__proofLineMarks.myStatus(2));
    await b.page.locator('.ProseMirror p', { hasText: 'The second paragraph' }).click();
    await b.page.keyboard.press('End');
    await b.page.keyboard.type(' Proposed by Bob.');
    await waitFor(page, () => window.proof.getAllMarks().some(m => m.kind === 'insert' && m.data?.content?.includes('Proposed by Bob.')), null, 12000);
    assert.equal(await b.page.evaluate(() => window.__proofLineMarks.myStatus(2)) === 'agreed' && before !== 'agreed', false, 'typing must not manufacture line agreement');
    await b.page.keyboard.press('Escape');
    await page.screenshot({ path: path.join(shots, `${tag}-2-proposed.png`) });
  });
  await check(`${tag}: Next selects open passages in document order and preserves keyboard focus`, async () => {
    await seedReviewAsks(base, created, page, [3, 5]);
    await showReview(page);
    const rows = await page.locator('.anv-issue[data-settled="false"]').evaluateAll(nodes => nodes.map(n => Number(n.dataset.line)));
    const before = await page.evaluate(() => window.__proofReadingWalk.focusIndex());
    const expected = rows.find(line => line > before) ?? rows[0];
    await nextReview(page);
    await waitFor(page, i => window.__proofReadingWalk.focusIndex() === i, expected);
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.anv-issues')), true);
    await nextReview(page);
    await waitFor(page, i => window.__proofReadingWalk.focusIndex() === i, rows.find(line => line > expected) ?? rows[0]);
  });
  await check(`${tag}: the owner can Approve`, async () => {
    const o = await openDoc(browser, base, slug, 'Mike', { viewport: { width: 1280, height: 900 } }, `?token=${encodeURIComponent(created.ownerSecret)}`);
    await mark(o.page, 3, /Approve/);
    assert.equal(await dotStatus(o.page, 3), 'approved');
    await waitFor(page, () => window.__proofLineMarks.debugState().marks.some(m => m.anchor.ordinal === 3 && m.status === 'approved'));
    await o.context.close();
  });
  await check(`${tag}: marking every line by everyone reaches Aligned`, async () => {
    const response = await fetch(`${base}/api/agent/${slug}/state`, { headers: { ...clientHeaders, 'x-share-token': created.ownerSecret } });
    const state = await response.json();
    for (const who of state.alignment.team) {
      for (const line of state.lines) {
        const r = await fetch(`${base}/api/documents/${slug}/line-marks`, {
          // Step B6: only the owner credential may write as another team member (AIs included).
          method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders, 'x-share-token': created.ownerSecret },
          body: JSON.stringify({ by: who, status: 'seen', anchor: { hash: line.hash, occurrence: line.occurrence, ordinal: line.index, kind: line.kind, excerpt: line.text.slice(0, 80) } }),
        });
        assert.equal(r.status, 200);
      }
    }
    await page.evaluate(() => window.__proofLineMarks.refresh());
    await waitFor(page, () => window.__proofLineMarks.debugState().aligned === true, null, 15000);
    assert.equal(await page.evaluate(() => window.__proofLineMarks.debugState().aligned), true);
    await page.screenshot({ path: path.join(shots, `${tag}-4-aligned.png`) });
  });
  await b.context.close();
  await a.context.close();
}

async function phone(browser, base) {
  const created = await createDoc(base);
  const viewport = { width: 390, height: 844 };
  const tag = `line-marks-${style}-phone-390x844`;
  const { context, page } = await openDoc(browser, base, created.slug, 'Pat', {
    ...devices['iPhone 13'], viewport, screen: viewport, hasTouch: true, isMobile: true,
  });
  activePage = page;
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  await check(`${tag}: bar stays one row with the issue button`, async () => {
    await waitFor(page, () => window.__proofLineMarks.myStatus(0) === 'seen');
    const h = await page.evaluate(() => document.getElementById('share-banner').getBoundingClientRect().height);
    assert.ok(h <= 60, `bar height ${h}`);
    const btn = page.locator('[data-accord-review-toggle]');
    assert.ok(await btn.isVisible(), 'issue button hidden');
    assert.equal(await page.locator('#share-banner .plm-issues-count').innerText(), '0 need you');
    const r = await btn.boundingBox();
    assert.ok(r.height >= 44 && r.width >= 44, `issue button ${r.width}x${r.height}`);
  });
  await check(`${tag}: dots are on screen, touch-sized, and cause no sideways scroll`, async () => {
    const info = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      dots: [...document.querySelectorAll('.plm-dot')].map(d => d.getBoundingClientRect().toJSON()),
      textLeft: document.querySelector('.ProseMirror').getBoundingClientRect().left,
    }));
    assert.ok(info.sw <= info.cw + 1, `scrollWidth ${info.sw} > ${info.cw}`);
    assert.equal(info.dots.length, 0);
    for (const d of info.dots) {
      assert.ok(d.left >= 0 && d.width >= 32, `dot ${JSON.stringify(d)}`);
      assert.ok(d.right <= info.textLeft + 2, `dot covers text: ${d.right} > ${info.textLeft}`);
    }
  });
  await page.screenshot({ path: path.join(shots, `${tag}-1-load.png`) });
  await check(`${tag}: phone Review has no Line tab while historical records remain usable`, async () => {
    await page.locator('.prw-strip-review').tap();
    const sheet = page.locator('.prw-right.prw-sheet-open');
    await sheet.waitFor({ state: 'visible' });
    assert.equal(await sheet.locator('.plm-box').count(), 0);
    await sheet.locator('.prw-collapse').tap();
    await mark(page, 1, /Agree/);
    assert.equal(await dotStatus(page, 1), 'agreed');
  });
  await check(`${tag}: a historical rejection with its reason stays stored on phone`, async () => {
    await mark(page, 4, /Reject/, 'Not true for phones');
    assert.equal(await dotStatus(page, 4), 'rejected');
  });
  await check(`${tag}: the issue button goes to the next issue`, async () => {
    await seedReviewAsks(base, created, page, [6]);
    await nextReview(page);
    await waitFor(page, () => window.__proofReadingWalk.focusIndex() === 6);
    await page.screenshot({ path: path.join(shots, `${tag}-3-next.png`) });
  });
  await context.close();
}

const { base, stop } = await startServer();
const browser = await chromium.launch();
try {
  await desktop(browser, base);
  await phone(browser, base);
} finally {
  await browser.close();
  await stop();
}
console.log(`\n${results.length - failures}/${results.length} line-marks checks passed (${style} style)`);
process.exit(failures ? 1 : 0);
