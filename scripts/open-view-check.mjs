#!/usr/bin/env node
// Review beside the full document; counts, scopes, completion and the explicit agreed copy.
// Mike, 2026-09-23 (usability brief). Local fixtures only.
import assert from 'node:assert/strict';
import { showReview } from './review-ui.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const shots = arg('--shots') || path.join(root, '.preview');
mkdirSync(shots, { recursive: true });

const clientHeaders = { 'X-Proof-Client-Version': '0.33.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1;
    results.push(`FAIL ${name}: ${String(error?.message ?? error).split('\n').slice(0, 5).join(' | ')}`);
    await activePage?.screenshot({ path: path.join(shots, `open-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer() {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-open-check-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      PORT: String(port), COLLAB_EMBEDDED_WS: '1', PROOF_DEFAULT_REVIEW_STYLE: 'proof',
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

// A document long enough that the Open view has something real to collapse.
const SHIP = 'We will ship the export button on Monday next week.';
const CLAIM = 'Revenue doubled in the second quarter of this year.';
const EXPORTS = 'Every customer asked for the export button first of all.';
const LINES = [
  '# Open view check',                                                        // 0
  'The opening line of the document gives the page some body to scroll.',     // 1
  'A second paragraph that nothing ever happens to at all.',                  // 2
  'A third paragraph that nothing ever happens to at all.',                   // 3
  CLAIM,                                                                      // 4
  'A fifth paragraph that nothing ever happens to at all.',                   // 5
  'A sixth paragraph that nothing ever happens to at all.',                   // 6
  EXPORTS,                                                                    // 7
  'An eighth paragraph that nothing ever happens to at all.',                 // 8
  'A ninth paragraph that nothing ever happens to at all.',                   // 9
  SHIP,                                                                       // 10
  'The last line sits near the bottom of the document itself.',               // 11
];
const L = { HEAD: 0, INTRO: 1, CLAIM: 4, EXPORTS: 7, SHIP: 10, LAST: 11 };

async function createDoc(base) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown: LINES.join('\n\n'), title: 'Open view check' }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

const agentHeaders = (token) => ({ 'Content-Type': 'application/json', ...clientHeaders, 'x-share-token': token });
async function agent(base, created, route, body, method = 'POST') {
  const r = await fetch(`${base}/api/agent/${created.slug}${route}`, {
    method, headers: { ...agentHeaders(created.ownerSecret), 'Idempotency-Key': `k-${Date.now()}-${Math.random()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  assert.ok(r.ok || r.status === 202, `${route}: ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/** Rewrites one whole block the way an AI would (this is what must lapse an agreement). */
async function rewriteBlock(base, created, needle, markdown) {
  const snap = await agent(base, created, '/snapshot', undefined, 'GET');
  const block = (snap.blocks ?? []).find(b => String(b.markdown ?? b.text ?? '').includes(needle));
  assert.ok(block, `block not found for "${needle}"`);
  const body = { by: 'ai:check', operations: [{ op: 'replace_block', ref: block.ref, block: { markdown } }] };
  // One base only: the server refuses baseToken together with baseRevision.
  if (snap.mutationBase) body.baseToken = typeof snap.mutationBase === 'string' ? snap.mutationBase : snap.mutationBase.token;
  else if (snap.revision !== undefined && snap.revision !== null) body.baseRevision = snap.revision;
  assert.ok(body.baseToken || body.baseRevision !== undefined, 'no base on the snapshot');
  await agent(base, created, '/edit/v2', body);
}

async function openDoc(browser, base, slug, name, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  await context.route('**/*', route => new URL(route.request().url()).origin === base || route.request().url().startsWith('blob:') ? route.continue() : route.abort());
  await context.addInitScript(viewer => { try { localStorage.setItem('proof-share-viewer-name', viewer); } catch {} }, name);
  const page = await context.newPage();
  await page.goto(`${base}/d/${slug}`);
  await page.getByRole('button', { name: 'Continue anonymously', exact: true }).click({ timeout: 6000 }).catch(() => {});
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForFunction(() => window.__proofReadingWalk?.debugState().ready === true, null, { timeout: 10_000 });
  await page.waitForFunction(() => Boolean(window.__proofOpenView), null, { timeout: 10_000 });
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  page.setDefaultTimeout(6000);
  return { context, page };
}

const waitFor = (page, fn, arg, timeout = 9000) => page.waitForFunction(fn, arg, { timeout, polling: 100 });
const state = page => page.evaluate(() => window.__proofOpenView.debugState());
const nav = page => page.evaluate(() => window.__proofReadingWalk.debugState().navigator ?? window.__proofReadingWalk.navigator?.debugState?.());
/** Marks a line through the page's own API (the same call the Agree button makes). */
const markLine = (page, line, status = 'agreed') => page.evaluate(
  ({ line, status }) => window.__proofLineMarks.setLineStatus(line, status, undefined, 'click'), { line, status });
/** Marks every line, in order, the way a reader working down the document would. */
const markAll = (page, status = 'agreed', upTo = 9999) => page.evaluate(
  async ({ status, upTo }) => {
    for (const line of window.__proofLineMarks.lineList().slice(0, upTo)) {
      await window.__proofLineMarks.setLineStatus(line.index, status, undefined, 'click');
    }
  }, { status, upTo });

async function chooseCopy(page, clean) {
  const current = (await state(page)).clean;
  if (current === clean) return;
  await page.locator('#accord-menubar .amb-top[data-menu="view"]').click();
  await page.locator('.amb-menu').getByRole('menuitem', { name: clean ? /^View agreed copy/ : 'Return to document' }).click();
}

async function main() {
  const { base, stop } = await startServer();
  const browser = await chromium.launch();
  try {
    const created = await createDoc(base);
    const mike = await openDoc(browser, base, created.slug, 'Mike');
    activePage = mike.page;

    // ------------------------------------------------------------------ 1
    await check('Review is in the toolbar, followed by People and Share', async () => {
      await agent(base, created, '/asks', { by: 'ai:izzy', quote: CLAIM, to: ['guest:Mike'], recommend: 'Yes: the figure is audited' });
      await waitFor(mike.page, () => window.__proofOpenView.debugState().open.count > 0);
      const button = mike.page.locator('[data-accord-review-toggle]');
      await button.waitFor({ state: 'visible' });
      assert.match(await button.innerText(), /Review.*\d+ need you/s);
      assert.equal(await mike.page.locator('.aov-toggle').count(), 0);
      if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
      assert.equal(await button.getAttribute('aria-expanded'), 'true');
    });

    // ------------------------------------------------------------------ 2
    await check('the Issues pill, the amber dots and the Navigator name exactly the same lines', async () => {
      await agent(base, created, '/marks/comment', { by: 'ai:izzy', quote: EXPORTS, text: 'Is "every" literally true?' });
      await waitFor(mike.page, () => window.__proofOpenView.debugState().open.count >= 2);
      await mike.page.evaluate(() => window.__proofReadingWalk.navigator.select('issues'));
      await mike.page.waitForTimeout(400);
      const s = await state(mike.page);
      assert.deepEqual(s.dots, s.open.lines, `amber dots ${JSON.stringify(s.dots)} vs Open ${JSON.stringify(s.open.lines)}`);
      assert.deepEqual(s.amberFromLineMarks, s.open.lines, 'the margin reads a different list');
      assert.deepEqual(s.navigator, s.open.lines, `the Navigator ${JSON.stringify(s.navigator)} vs Open ${JSON.stringify(s.open.lines)}`);
      assert.equal(s.pill, s.open.count, `the pill says ${s.pill}, Open says ${s.open.count}`);
      assert.equal(s.open.count, s.open.lines.length);
    });

    // ------------------------------------------------------------------ 3
    await check('Review opens beside the full document, without collapsed runs', async () => {
      const before = await state(mike.page);
      await mike.page.locator('[data-accord-review-toggle]').click();
      await mike.page.locator('[data-accord-review-toggle]').click();
      const after = await state(mike.page);
      assert.deepEqual(after.hiddenLines, before.hiddenLines);
      assert.equal(after.hiddenLines.length, 0);
      assert.equal(await mike.page.locator('.aov-rule').count(), 0);
    });

    await check('both Review scopes name their count and use document order', async () => {
      await mike.page.locator('[data-accord-review-scope="all-open"]').click();
      assert.match(await mike.page.locator('.plm-issues-count').innerText(), /^\d+ open$/);
      const rows = (await nav(mike.page)).issues.filter(row => !row.settled).map(row => row.line);
      assert.deepEqual(rows, [...new Set(rows)].sort((a,b) => a-b));
      await mike.page.locator('[data-accord-review-scope="needs-you"]').click();
      assert.match(await mike.page.locator('.plm-issues-count').innerText(), /^\d+ need you$/);
    });

    await check('new Review items enter document order without moving the selected row or focus', async () => {
      const row = mike.page.locator(`.anv-issue[data-line="${L.EXPORTS}"]`);
      await row.click();
      await row.focus();
      const before = await row.boundingBox();
      await agent(base, created, '/asks', { by: 'ai:izzy', quote: LINES[L.INTRO], to: ['guest:Mike'], recommend: 'Check the introduction.' });
      await waitFor(mike.page, line => Boolean(document.querySelector(`.anv-issue[data-line="${line}"][data-new="true"]`)), L.INTRO);
      const after = await row.boundingBox();
      assert.ok(Math.abs(after.y - before.y) <= 2, `selected row moved ${after.y - before.y}px`);
      assert.equal(await row.evaluate(node => node === document.activeElement), true, 'focus moved');
      const rows = (await nav(mike.page)).issues.filter(row => !row.settled).map(row => row.line);
      assert.deepEqual(rows, [...rows].sort((a,b) => a-b));
      assert.match(await mike.page.locator(`.anv-issue[data-line="${L.INTRO}"]`).innerText(), /New/);
      await mike.page.evaluate(() => document.activeElement?.blur());
    });

    // ------------------------------------------------------------------ 4
    await check('J / K / A run the Open list without typing a character into the document', async () => {
      const textBefore = await mike.page.evaluate(() => window.__proofLineMarks.lineList().map(l => l.text).join('\n'));
      const open = (await state(mike.page)).open.lines;
      await mike.page.evaluate(line => window.__proofReadingWalk.focusLine(line), open[0]);
      await mike.page.waitForTimeout(150);
      // Step 1 (Mike, 2026-09-24, Accord yfbqrau4 P1): J, K, A and Delete act in the open-items
      // list, so the list takes focus first; the document follows the selected item.
      await mike.page.locator(`.anv-issue[data-line="${open[0]}"]`).focus();
      await mike.page.keyboard.press('j');
      await mike.page.waitForTimeout(250);
      const afterJ = await mike.page.evaluate(() => window.__proofReadingWalk.focusIndex());
      await mike.page.keyboard.press('k');
      await mike.page.waitForTimeout(250);
      const afterK = await mike.page.evaluate(() => window.__proofReadingWalk.focusIndex());
      assert.ok(afterJ > open[0], `J did not move forward (${open[0]} -> ${afterJ})`);
      assert.ok(afterK <= afterJ, `K did not move back (${afterJ} -> ${afterK})`);
      const textAfter = await mike.page.evaluate(() => window.__proofLineMarks.lineList().map(l => l.text).join('\n'));
      assert.equal(textAfter, textBefore, 'a reading key typed into the document');
      // A outside the Review list no longer marks or decides anything.
      const marksBefore = await mike.page.evaluate(() => window.__proofLineMarks.debugState().marks.filter(m => ['agreed', 'rejected'].includes(m.status)));
      await mike.page.keyboard.press('a');
      assert.deepEqual(await mike.page.evaluate(() => window.__proofLineMarks.debugState().marks.filter(m => ['agreed', 'rejected'].includes(m.status))), marksBefore);
      assert.equal(
        await mike.page.evaluate(() => window.__proofLineMarks.lineList().map(l => l.text).join('\n')),
        textBefore, 'A typed an "a" into the document');
    });

    await check('T and E are commands in the Open view too, and still never type', async () => {
      const textBefore = await mike.page.evaluate(() => window.__proofLineMarks.lineList().map(l => l.text).join('\n'));
      const open = (await state(mike.page)).open.lines;
      await mike.page.evaluate(line => window.__proofReadingWalk.focusLine(line), open[0]);
      await mike.page.waitForTimeout(150);
      await mike.page.keyboard.press('t');
      await waitFor(mike.page, () => Boolean(document.querySelector('.amg-thread-new, .amg-thread-text-input')));
      await mike.page.keyboard.press('Escape');
      await mike.page.waitForTimeout(200);
      assert.equal(
        await mike.page.evaluate(() => window.__proofLineMarks.lineList().map(l => l.text).join('\n')),
        textBefore, 'T typed a "t" into the document');
    });

    // ------------------------------------------------------------------ 5
    await check('a settled row greys out and STAYS IN PLACE until it is cleared', async () => {
      const before = await state(mike.page);
      const openBefore = before.open.lines;
      assert.ok(openBefore.length >= 1, 'nothing to settle');
      // Answer the ask on the CLAIM line: it stops being open.
      await mike.page.evaluate(async (line) => {
        const ask = window.__proofLineMarks.debugState().asks.find(a => a.lineIndex === line);
        await window.__proofLineMarks.answerAsk(ask.id, 'yes', 'Checked the audit.');
      }, L.CLAIM);
      await waitFor(mike.page, line => !window.__proofOpenView.debugState().open.lines.includes(line), L.CLAIM, 12_000);
      const after = await state(mike.page);
      assert.ok((await nav(mike.page)).settled.includes(L.CLAIM), 'the completed row was forgotten');
      assert.ok(!after.hiddenLines.includes(L.CLAIM), 'the settled row vanished under the cursor');
      const struck = await mike.page.evaluate(() => document.querySelectorAll('.anv-issue[data-settled="true"]').length);
      assert.ok(struck > 0, 'the settled row is not struck through');
      // ...and the deliberate control takes it away.
      await mike.page.click('.anv-clear-settled');
      await waitFor(mike.page, () => window.__proofReadingWalk.navigator.debugState().settled.length === 0);
      const cleared = await state(mike.page);
      assert.ok(!cleared.hiddenLines.includes(L.CLAIM), 'clearing a completed row hid document text');
    });

    await check("the Navigator's Issues tab keeps a settled row in place too", async () => {
      await mike.page.evaluate(() => window.__proofReadingWalk.navigator.select('issues'));
      await mike.page.waitForTimeout(300);
      const line = (await state(mike.page)).open.lines[0];
      assert.ok(line !== undefined, 'nothing open to settle');
      const before = await nav(mike.page);
      assert.ok(before.issues.some(row => row.line === line), `line ${line} is not in the Issues tab`);
      await markLine(mike.page, line, 'agreed');
      // Resolve whatever else is open on it, so the row really leaves the live list.
      await mike.page.evaluate(async (l) => {
        const lm = window.__proofLineMarks;
        for (const ask of lm.debugState().asks) {
          if (ask.lineIndex === l && (ask.openFor ?? []).length) await lm.answerAsk(ask.id, 'yes', 'Agreed.').catch(() => {});
        }
        for (const t of lm.allThreads()) {
          if (t.lineIndex === l && t.open) await lm.closeThread(t.thread.id, 'resolved').catch(() => {});
        }
      }, line);
      await waitFor(mike.page, l => !window.__proofOpenView.debugState().open.lines.includes(l), line, 12_000);
      await mike.page.waitForTimeout(400);
      const after = await nav(mike.page);
      const row = after.issues.find(r => r.line === line);
      assert.ok(row, `the row for line ${line} vanished from the Issues tab under the cursor`);
      assert.equal(row.settled, true, 'the row stayed but was not marked settled');
      assert.ok(after.settled.includes(line));
      await mike.page.click('.anv-clear-settled');
      await mike.page.waitForTimeout(300);
      assert.ok(!(await nav(mike.page)).issues.some(r => r.line === line && r.settled), 'Clear settled did nothing in the Navigator');
    });

    // ------------------------------------------------------------------ 6
    await check('the honest header names two viewers and the agreed copy waits for both', async () => {
      const eric = await openDoc(browser, base, created.slug, 'Eric');
      try {
        // Mike agrees to everything; Eric agrees to the first few lines only.
        await markAll(mike.page, 'agreed');
        await markAll(eric.page, 'agreed', 3);
        // The header names Eric as soon as his first mark syncs ("from line 2"). Wait for the
        // three marks, which is the state the assertion below describes.
        await waitFor(mike.page, () => /Eric[^.]* has not read from line 4 on\./.test(window.__proofOpenView.debugState().header.text || ''), null, 20_000);
        await mike.page.locator('#accord-menubar .amb-top[data-menu="view"]').click();
        const offer = mike.page.locator('[data-item="view-agreed-copy"]');
        assert.equal(await offer.isDisabled(), true);
        assert.match(await offer.innerText(), /Not yet agreed: waiting for.*Eric/);
        await mike.page.keyboard.press('Escape');
        await mike.page.waitForTimeout(500);
        const s = await state(mike.page);
        assert.ok(/^Agreed by you/.test(s.header.text), `header: ${s.header.text}`);
        assert.ok(/Eric[^.]* has not read from line 4 on\./.test(s.header.text), `header: ${s.header.text}`);
        assert.equal(s.header.settled, false, 'the Accord must never imply a document is settled when it is not');
        // ...and Eric's own header is his, not Mike's.
        const his = await state(eric.page);
        assert.ok(/You have not read from line 4 on\./.test(his.header.text), `Eric's header: ${his.header.text}`);
        assert.ok(/Mike/.test(his.header.text), `Eric's header should name Mike: ${his.header.text}`);
        assert.ok(!/^Agreed by you/.test(his.header.text), "Eric's header must be his own, not Mike's");
        // The clean read: no margin dots, no rail.
        if (s.clean) {
          const chrome = await mike.page.evaluate(() => ({
            dots: [...document.querySelectorAll('.plm-dot')].filter(d => d.getBoundingClientRect().width > 0).length,
            rail: (document.querySelector('.prw-right')?.getBoundingClientRect().width ?? 0) > 0,
          }));
          assert.equal(chrome.dots, 0, 'the Accord still shows margin dots');
          assert.equal(chrome.rail, false, 'the Accord still shows the Margin rail');
        }
        await mike.page.screenshot({ path: path.join(shots, 'open-accord-header-1440.png') });
      } finally {
        await eric.context.close();
      }
    });

    // ------------------------------------------------------------------ 7
    await check('a substantive edit re-opens an agreement; a cosmetic one does not', async () => {
      // Mike has agreed to every line (previous check). A spelling/case fix must carry.
      await rewriteBlock(base, created, SHIP, 'We will ship the Export button on Monday next week');
      await mike.page.waitForTimeout(1500);
      const cosmetic = await state(mike.page);
      assert.ok(!cosmetic.open.lines.includes(L.SHIP),
        `a cosmetic edit sent the line back to the Open list: ${JSON.stringify(cosmetic.open.items)}`);

      // ...and a change of meaning must not.
      await rewriteBlock(base, created, 'Export button on Monday', 'We will ship the export button on Friday next month.');
      await waitFor(mike.page, line => window.__proofOpenView.debugState().open.lines.includes(line), L.SHIP, 15_000);
      const s = await state(mike.page);
      const item = s.open.items.find(i => i.line === L.SHIP);
      assert.ok(item, `the lapsed line is not in the Open list: ${JSON.stringify(s.open.items)}`);
      assert.ok(item.kinds.includes('lapsed'), `the row does not say the agreement lapsed: ${JSON.stringify(item)}`);
      assert.ok(String(item.agreedTo || '').includes('Monday'), `the row does not carry the wording that was agreed to: ${JSON.stringify(item)}`);
      // The three still agree about it.
      assert.deepEqual(s.dots, s.open.lines);
      assert.equal(s.pill, s.open.count);
      // The retired Line tab does not render; the Review row retains the lapsed kind.
      assert.equal(await mike.page.locator('.prw-linebox').count(), 0);
      await showReview(mike.page);
      assert.match(await mike.page.locator(`.anv-issue[data-line="${L.SHIP}"]`).innerText(), /earlier|agreement|changed/i);

    });

    // ------------------------------------------------------------------ 8
    await check('resolving the final item preserves the document view and Review controls', async () => {
      await chooseCopy(mike.page, false);
      // Mike settles everything that is open for him.
      await mike.page.evaluate(async () => {
        const lm = window.__proofLineMarks;
        for (const ask of lm.debugState().asks) {
          if ((ask.openFor ?? []).length) await lm.answerAsk(ask.id, 'yes', 'Agreed.').catch(() => {});
        }
        for (const t of lm.allThreads()) {
          if (t.open) await lm.closeThread(t.thread.id, 'resolved').catch(() => {});
        }
      });
      await markAll(mike.page, 'agreed');
      await waitFor(mike.page, () => window.__proofOpenView.debugState().open.count === 0, null, 20_000)
        .catch(async () => { throw new Error(`still open: ${JSON.stringify((await state(mike.page)).open.items)}`); });
      await mike.page.waitForTimeout(600);
      const s = await state(mike.page);
      assert.equal(s.open.count, 0);
      assert.equal(s.zero.forViewer, true, 'the zero moment did not fire');
      assert.equal(s.view, 'open', 'completion switched views');
      assert.equal(s.clean, false, 'completion removed controls');
      assert.equal(await mike.page.locator('[data-accord-review-toggle]').isVisible(), true);
      assert.equal(await mike.page.locator('.plm-issues-count').innerText(), '0 need you');
      assert.equal(s.zero.forEveryone, false, 'Eric has still not read it');
      await mike.page.screenshot({ path: path.join(shots, 'open-zero-for-you-1440.png') });

      // Now Eric agrees to everything too: zero for EVERYONE, and the header goes.
      const eric = await openDoc(browser, base, created.slug, 'Eric');
      try {
        await markAll(eric.page, 'agreed');
        // Izzy is on the team too (it left the ask and the comment), so the header is not settled
        // until Izzy has agreed as well. That is the header being honest, not the check being fussy.
        await agent(base, created, '/marks/line', { by: 'ai:izzy', status: 'agreed', section: { quote: 'Open view check' } });
        await waitFor(mike.page, () => window.__proofOpenView.debugState().zero.forEveryone === true, null, 25_000)
          .catch(async () => { throw new Error(`not settled: ${JSON.stringify((await state(mike.page)).header)}`); });
        await mike.page.waitForTimeout(500);
        const done = await state(mike.page);
        assert.equal(done.zero.forEveryone, true);
        assert.equal(done.header.settled, true);
        assert.equal(done.header.hidden, true, 'when it is zero for everyone the header goes too');
        assert.equal(done.zero.text, 'Everyone has agreed.');
        assert.equal(done.view, 'open');
        await mike.page.screenshot({ path: path.join(shots, 'open-zero-for-everyone-1440.png') });
      } finally {
        await eric.context.close();
      }
    });

    await mike.context.close();

    // ------------------------------------------------------------------ 9 (the phone)
    await check('the phone opens the same Review list in its bottom sheet', async () => {
      const doc2 = await createDoc(base);
      await agent(base, doc2, '/asks', { by: 'ai:izzy', quote: CLAIM, to: ['guest:Mike'], recommend: 'Yes: the figure is audited' });
      const phone = await openDoc(browser, base, doc2.slug, 'Mike', { width: 375, height: 812 });
      activePage = phone.page;
      try {
        await waitFor(phone.page, () => window.__proofOpenView.debugState().open.count > 0);
        const button = phone.page.locator('[data-accord-review-toggle]');
        const box = await button.boundingBox();
        assert.ok(box && box.height >= 44 && box.x >= 0 && box.x + box.width <= 375);
        await button.click();
        await phone.page.locator('.prw-right.prw-sheet-open').waitFor({ state: 'visible' });
        await phone.page.locator(`.anv-issue[data-line="${L.CLAIM}"]`).click();
        assert.equal(await button.getAttribute('aria-expanded'), 'true');
        assert.equal((await state(phone.page)).hiddenLines.length, 0);
        await button.click();
        assert.equal(await button.getAttribute('aria-expanded'), 'false');
        assert.ok(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await phone.page.screenshot({ path: path.join(shots, 'review-375.png') });
      } finally { await phone.context.close(); }
    });

    // ------------------------------------------------------------------ 10 (desktop shots)
    await check('the Open view and the Accord view, at 1440', async () => {
      const doc3 = await createDoc(base);
      await agent(base, doc3, '/asks', { by: 'ai:izzy', quote: CLAIM, to: ['guest:Mike'], recommend: 'Yes: the figure is audited' });
      await agent(base, doc3, '/marks/comment', { by: 'ai:izzy', quote: EXPORTS, text: 'Is "every customer" literally true?' });
      const page = await openDoc(browser, base, doc3.slug, 'Mike');
      activePage = page.page;
      try {
        await waitFor(page.page, () => window.__proofOpenView.debugState().open.count >= 2, null, 15_000);
        await chooseCopy(page.page, false);
        await waitFor(page.page, () => window.__proofOpenView.debugState().view === 'open');
        await page.page.waitForTimeout(500);
        await page.page.screenshot({ path: path.join(shots, 'open-view-1440.png') });
        const s = await state(page.page);
        assert.equal(s.hiddenLines.length, 0, 'Review filtered the document');
        await markAll(page.page, 'agreed');
        const current = await agent(base, doc3, '/state', undefined, 'GET');
        for (const actor of current.alignment.team) {
          if (/Mike/.test(actor)) continue;
          for (const line of current.lines) await agent(base, doc3, '/marks/line', { by: actor, quote: line.text, status: 'agreed' });
        }
        await waitFor(page.page, () => window.__proofLineMarks.agreedCopyOffer().enabled);
        await chooseCopy(page.page, true);
        assert.match(await page.page.locator('.aov-header-text').innerText(), /Wording revision.*Agreed by.*Mike/);
        await waitFor(page.page, () => window.__proofOpenView.debugState().view === 'accord');
        await page.page.waitForTimeout(500);
        const back = await state(page.page);
        assert.equal(back.hiddenLines.length, 0, 'switching back left the document filtered');
        assert.equal(back.clean, true, 'a chosen Accord must read clean');
        // ...and "clean" means it: no dots, no rail, no ask cards, no coloured review marks.
        const chrome = await page.page.evaluate(() => {
          const shown = sel => [...document.querySelectorAll(sel)].filter(n => n.getBoundingClientRect().width > 0).length;
          const marked = [...document.querySelectorAll('.ProseMirror [data-mark-id]')]
            .filter(n => getComputedStyle(n).backgroundColor !== 'rgba(0, 0, 0, 0)').length;
          return { dots: shown('.plm-dot'), asks: shown('.ProseMirror .pask'), chips: shown('.pfold-chip'), marked,
            rail: (document.querySelector('.prw-right')?.getBoundingClientRect().width ?? 0) > 0 };
        });
        assert.deepEqual(chrome, { dots: 0, asks: 0, chips: 0, marked: 0, rail: false },
          `the Accord is not reading clean: ${JSON.stringify(chrome)}`);
        // The words themselves are all still there: it is one document, not two.
        const text = await page.page.evaluate(() => document.querySelector('.ProseMirror')?.innerText ?? '');
        assert.ok(text.includes('The last line sits near the bottom'), 'the Accord dropped text');
        await page.page.screenshot({ path: path.join(shots, 'open-accord-1440.png') });
      } finally {
        await page.context.close();
      }
    });
  } finally {
    await browser.close();
    await stop();
  }

  console.log(`\n${results.length - failures} of ${results.length} open-view checks passed`);
  if (failures) { console.error(results.filter(r => r.startsWith('FAIL')).join('\n')); process.exit(1); }
}

main().catch(error => { console.error(error); process.exit(1); });
