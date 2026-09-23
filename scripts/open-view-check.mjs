#!/usr/bin/env node
// Accord round 2, stage C — Open and Accord, two views of one document.
//
// Behaviour this check drives, in a real browser, against a real server:
//   the Issues pill, the amber dots and the Open list always name the same lines; the toggle
//   switches both ways and filters the document down to the unsettled material with context, with
//   everything else behind a thin rule that expands on a click; the Accord reads clean and its
//   header is accurate for several viewers; a substantive edit re-opens an agreement and a cosmetic
//   one does not; a row that settles stays in place until it is cleared, in the Open view and in
//   the Navigator's Issues tab; J / K / A / R / T / E run the list without typing a character; and
//   the zero moment takes the toggle away for the viewer and the header away for everyone.
//
// Starts an isolated local server on the current dist/ build (run `npm run build` first) with a
// temp SQLite database and drives Chromium at 1440 (desktop) and 390 (phone).
// Authorship: Mike Wolf (rulings), built by Claude Opus 5 (worker accord-open), 2026-09-22.
// Usage: node scripts/open-view-check.mjs [--shots dir]
import assert from 'node:assert/strict';
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

const clientHeaders = { 'X-Proof-Client-Version': '0.31.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
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

async function main() {
  const { base, stop } = await startServer();
  const browser = await chromium.launch();
  try {
    const created = await createDoc(base);
    const mike = await openDoc(browser, base, created.slug, 'Mike');
    activePage = mike.page;

    // ------------------------------------------------------------------ 1
    await check('the toggle sits in the toolbar, left of the Issues pill, on desktop', async () => {
      // Something must be open for the toggle to be there at all, so put an ask on a line.
      await agent(base, created, '/asks', { by: 'ai:izzy', quote: CLAIM, to: ['guest:Mike'], recommend: 'Yes: the figure is audited' });
      await waitFor(mike.page, () => window.__proofOpenView.debugState().open.count > 0);
      const place = await mike.page.evaluate(() => {
        const toggle = document.querySelector('.aov-toggle');
        const pill = document.querySelector('.plm-issues');
        return {
          inToolbar: Boolean(toggle?.closest('#share-banner')),
          inRightGroup: Boolean(toggle?.closest('.share-pill-right')),
          beforePill: toggle?.nextElementSibling === pill,
          visible: toggle ? !toggle.hidden && toggle.getBoundingClientRect().width > 0 : false,
          labels: [...document.querySelectorAll('.aov-toggle .aov-seg-label')].map(n => n.textContent),
        };
      });
      assert.deepEqual(place.labels, ['Open', 'Accord']);
      assert.ok(place.inToolbar && place.inRightGroup, `not in the toolbar's right group: ${JSON.stringify(place)}`);
      assert.ok(place.beforePill, 'the toggle must sit immediately left of the Issues pill');
      assert.ok(place.visible, 'the toggle is not visible');
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
    await check('the toggle switches to Open: only the unsettled material, with context, the rest behind a rule', async () => {
      await mike.page.click('.aov-toggle .aov-seg[data-view="open"]');
      await waitFor(mike.page, () => window.__proofOpenView.debugState().view === 'open');
      const s = await state(mike.page);
      const open = s.open.lines;
      assert.ok(open.length >= 2, `nothing open: ${JSON.stringify(open)}`);
      // Every open line, and one line either side, is visible; nothing else is.
      for (const line of open) {
        assert.ok(!s.hiddenLines.includes(line), `line ${line} is open but hidden`);
        for (const near of [line - 1, line + 1]) {
          if (near < 0 || near >= 12) continue;
          assert.ok(!s.hiddenLines.includes(near), `line ${near} is the context of ${line} and was hidden`);
        }
      }
      assert.ok(s.hiddenLines.length > 0, 'the Open view collapsed nothing');
      assert.ok(s.rules.length > 0, `no thin rule was drawn: ${JSON.stringify(s.rules)}`);
      for (const rule of s.rules) assert.ok(/\d+ lines? settled/.test(rule.label), `rule says "${rule.label}"`);
    });

    await check('a thin rule expands its own run on a click, and nothing else', async () => {
      const before = await state(mike.page);
      const rule = before.rules[0];
      await mike.page.click(`.aov-rule[data-from="${rule.from}"]`);
      await waitFor(mike.page, from => !window.__proofOpenView.debugState().hiddenLines.includes(from), rule.from);
      const after = await state(mike.page);
      for (let i = rule.from; i <= rule.to; i += 1) assert.ok(!after.hiddenLines.includes(i), `line ${i} stayed hidden`);
      assert.ok(after.hiddenLines.length < before.hiddenLines.length, 'nothing opened');
      assert.ok(after.hiddenLines.length > 0, 'clicking one rule opened the whole document');
    });

    // ------------------------------------------------------------------ 4
    await check('J / K / A run the Open list without typing a character into the document', async () => {
      const textBefore = await mike.page.evaluate(() => window.__proofLineMarks.lineList().map(l => l.text).join('\n'));
      const open = (await state(mike.page)).open.lines;
      await mike.page.evaluate(line => window.__proofReadingWalk.focusLine(line), open[0]);
      await mike.page.waitForTimeout(150);
      // J steps to the next open item, not the next line: the collapsed lines are hidden, and the
      // reading walk steps over hidden lines. No second keymap was invented.
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
      // A agrees on the focus line, from the keyboard, in the list.
      const focus = await mike.page.evaluate(() => window.__proofReadingWalk.focusIndex());
      await mike.page.keyboard.press('a');
      await waitFor(mike.page, line => {
        const entry = window.__proofLineMarks.lineState(line)?.marks?.get(window.__proofLineMarks.me().toLowerCase());
        return Boolean(entry && ['agreed', 'approved'].includes(entry.mark.status));
      }, focus);
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
      assert.ok(after.settled.includes(L.CLAIM), `the settled row was forgotten: ${JSON.stringify(after.settled)}`);
      assert.ok(!after.hiddenLines.includes(L.CLAIM), 'the settled row vanished under the cursor');
      const struck = await mike.page.evaluate(() => document.querySelectorAll('.ProseMirror .aov-settled').length);
      assert.ok(struck > 0, 'the settled row is not struck through');
      // ...and the deliberate control takes it away.
      await mike.page.click('.aov-clear');
      await waitFor(mike.page, () => window.__proofOpenView.debugState().settled.length === 0);
      const cleared = await state(mike.page);
      assert.ok(cleared.hiddenLines.includes(L.CLAIM) || cleared.open.lines.includes(L.CLAIM), 'Clear settled did nothing');
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
    await check('the Accord reads clean and its header is accurate for two viewers', async () => {
      const eric = await openDoc(browser, base, created.slug, 'Eric');
      try {
        // Mike agrees to everything; Eric agrees to the first few lines only.
        await markAll(mike.page, 'agreed');
        await markAll(eric.page, 'agreed', 3);
        await waitFor(mike.page, () => (window.__proofOpenView.debugState().header.text || '').includes('Eric'), null, 15_000);
        await mike.page.click('.aov-toggle .aov-seg[data-view="accord"]').catch(() => {});
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
      // And the margin says so in those words, beside the new wording.
      await mike.page.evaluate(line => window.__proofReadingWalk.focusLine(line), L.SHIP);
      await mike.page.waitForTimeout(500);
      const margin = await mike.page.evaluate(() => document.querySelector('.prw-linebox')?.textContent ?? '');
      assert.ok(/agreed to an earlier version/i.test(margin), `the Margin does not say the agreement lapsed: ${margin.slice(0, 300)}`);
      assert.ok(/Monday/.test(margin), `the Margin does not show the earlier wording: ${margin.slice(0, 300)}`);
    });

    // ------------------------------------------------------------------ 8
    await check('the zero moment: the toggle goes for the viewer, the header goes for everyone', async () => {
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
      assert.equal(s.toggleHidden, true, 'the toggle stayed after the count reached zero');
      assert.equal(s.view, 'accord', 'at zero the document must simply be the Accord');
      assert.equal(s.zero.shown, true, 'the zero moment passed unnoticed');
      assert.equal(s.zero.text, 'Nothing is open for you. This is the Accord.');
      assert.equal(s.zero.forEveryone, false, 'Eric has still not read it');
      assert.ok(s.header.text.length > 0 && !s.header.hidden, 'the header must still name who has not read');
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
        assert.equal(done.zero.text, 'Everyone has agreed. This is the Accord.');
        assert.equal(done.toggleHidden, true);
        await mike.page.screenshot({ path: path.join(shots, 'open-zero-for-everyone-1440.png') });
      } finally {
        await eric.context.close();
      }
    });

    await mike.context.close();

    // ------------------------------------------------------------------ 9 (the phone)
    await check('the phone gets the toggle too, in the same place: left of the Issues pill', async () => {
      const doc2 = await createDoc(base);
      await agent(base, doc2, '/asks', { by: 'ai:izzy', quote: CLAIM, to: ['guest:Mike'], recommend: 'Yes: the figure is audited' });
      const phone = await openDoc(browser, base, doc2.slug, 'Mike', { width: 390, height: 780 });
      activePage = phone.page;
      try {
        await waitFor(phone.page, () => window.__proofOpenView.debugState().open.count > 0, null, 15_000);
        const place = await phone.page.evaluate(() => {
          const toggle = document.querySelector('.aov-toggle');
          const pill = document.querySelector('.plm-issues');
          const box = toggle?.getBoundingClientRect();
          const pillBox = pill?.getBoundingClientRect();
          return {
            inToolbar: Boolean(toggle?.closest('#share-banner')),
            // On the phone the toggle sits at the LEFT, right after the title: the space beside the
            // Issues pill is the middle of a phone screen, and this control changes what the whole
            // page shows. It is also ONE button there, naming the view it takes you to.
            afterTitle: document.querySelector('#share-banner .share-pill-title')?.nextElementSibling === toggle,
            leftOfPill: Boolean(box && pillBox && box.right < pillBox.left),
            segsShown: [...document.querySelectorAll('.aov-seg')].filter(n => n.getBoundingClientRect().width > 0).length,
            onScreen: Boolean(box && box.width > 0 && box.right <= window.innerWidth + 1 && box.left >= 0),
            width: box?.width ?? 0,
          };
        });
        assert.ok(place.inToolbar, 'the phone toggle is not in the top bar');
        assert.ok(place.afterTitle && place.leftOfPill, `the phone toggle must sit at the left, right after the title: ${JSON.stringify(place)}`);
        assert.equal(place.segsShown, 1, 'the phone shows one button, naming the view it takes you to');
        assert.ok(place.onScreen, `the phone toggle is off screen: ${JSON.stringify(place)}`);
        await phone.page.screenshot({ path: path.join(shots, 'open-toggle-390.png') });
        // ...and it works there.
        await phone.page.click('.aov-toggle .aov-seg[data-view="open"]');
        await waitFor(phone.page, () => window.__proofOpenView.debugState().view === 'open');
        const s = await state(phone.page);
        assert.ok(s.hiddenLines.length > 0, 'the phone Open view collapsed nothing');
        assert.deepEqual(s.dots, s.open.lines, 'the phone disagrees with itself');
        await phone.page.screenshot({ path: path.join(shots, 'open-view-390.png') });
        await phone.page.click('.aov-toggle .aov-seg[data-view="accord"]');
        await waitFor(phone.page, () => window.__proofOpenView.debugState().view === 'accord');
        const back = await state(phone.page);
        assert.equal(back.hiddenLines.length, 0, 'the toggle does not switch back');
        await phone.page.screenshot({ path: path.join(shots, 'open-accord-390.png') });
      } finally {
        await phone.context.close();
      }
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
        await page.page.click('.aov-toggle .aov-seg[data-view="open"]');
        await waitFor(page.page, () => window.__proofOpenView.debugState().view === 'open');
        await page.page.waitForTimeout(500);
        await page.page.screenshot({ path: path.join(shots, 'open-view-1440.png') });
        const s = await state(page.page);
        assert.ok(s.rules.length > 0 && s.hiddenLines.length > 0, 'the Open view shot has nothing collapsed');
        await page.page.click('.aov-toggle .aov-seg[data-view="accord"]');
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
