#!/usr/bin/env node
// Browser check for Proof Documents Steps B4e + B4f: review bundles (one card, atomic accept after a
// hash check, stale bundles refuse, the walk steps a bundle as one unit), competing alternatives
// (stacked under the line, keys 1-9, unanimity makes a normal edit, an Owner decides), blind marking
// (hidden until you mark, the reveal puts disagreement first, AIs are blind through /state too),
// Explain (E: a thread for the AIs that is never an Issue) with the term ledger, and perishable
// claims (a time-to-live: marks decay to stale, AIs re-check first).
// Authorship: Claude Opus 5 (worker proof-bundles), 2026-09-19, in the style of review-aids-check.mjs.
// Starts an isolated local server on the current dist/ build (run `npm run build` first) with the
// Documents library on, signs Mike in (an Owner: he creates the document), mints an agent key for
// "Claude", and drives Chromium in both review styles at 1440 (desktop) and 390 (phone).
// Screenshots go to .preview/ (or --shots). Exit code 0 only if every check passes.
// Usage: node scripts/bundles-alts-check.mjs [--style playmaker|proof] [--shots dir]
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
const MIKE_EMAIL = 'mw@mike-wolf.com';
const MIKE = `human:${MIKE_EMAIL}`;
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `bundles-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-bundles-check-'));
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    PORT: String(port), COLLAB_EMBEDDED_WS: '1', PROOF_DEFAULT_REVIEW_STYLE: style,
    PROOF_FEEDBACK_ENABLED: '1', SOMA_FEEDBACK_ENDPOINT: 'http://127.0.0.1:9/feedback',
    PROOF_LIBRARY_ENABLED: '1',
    DATABASE_PATH: path.join(temp, 'test.db'), SNAPSHOT_DIR: path.join(temp, 'snapshots'),
  };
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: root, env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => { child.kill('SIGTERM'); await new Promise(r => setTimeout(r, 300)); rmSync(temp, { recursive: true, force: true }); };
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const health = await fetch(`${base}/health`).catch(() => null);
    if (health?.ok) {
      const cli = (...args) => {
        const r = spawnSync(process.execPath, ['--import', 'tsx', 'server/library/cli.ts', ...args], { cwd: root, env, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        return r.stdout.trim();
      };
      return { base, stop, cli };
    }
    await new Promise(r => setTimeout(r, 150));
  }
  await stop();
  throw new Error('server did not start');
}

// Lines (index): 0 title | 1 intro | 2 launch | 3 milestone | 4 budget | 5 pricing | 6 issue use
// 7 alpha | 8 beta | 9 support | 10 ops | 11 phone | 12 Terms heading | 13 Issue definition | 14 last
const markdown = [
  '# Bundles check',
  'Intro paragraph is plain text for reading and it is long enough to be a real line.',
  'Launch moves to September 30 for every customer.',
  'The milestone review happens on September 23 in Boston.',
  'Budget line stays the same for the quarter.',
  'Pricing is 20 dollars per seat this year.',
  'Every open Issue shows in the count at the top.',
  'Second bundle line alpha words here.',
  'Second bundle line beta words here.',
  'Support hours are nine to five on weekdays.',
  'Ops rotation changes every Monday morning.',
  'Phone line offers a place for a wording on the phone.',
  '## Terms',
  '**Issue** — a line or mark that someone has not seen, or that someone rejected.',
  'Last paragraph closes the document for this check.',
].join('\n\n');
const L = { LAUNCH: 2, MILESTONE: 3, BUDGET: 4, PRICING: 5, USE: 6, ALPHA: 7, BETA: 8, SUPPORT: 9, OPS: 10, PHONE: 11, DEF: 13, LAST: 14 };

const waitFor = (page, fn, argument, timeout = 9000) => page.waitForFunction(fn, argument, { timeout, polling: 150 });
const lm = page => page.evaluate(() => window.__proofLineMarks.debugState());
const walk = page => page.evaluate(() => window.__proofReadingWalk.debugState());
const lineText = (page, i) => page.evaluate(n => window.__proofLineMarks.lineList()[n]?.text ?? null, i);

async function newContext(browser, base, options = {}) {
  const context = await browser.newContext(options);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  return context;
}

async function signIn(context, cli, base) {
  const link = cli('signin-link', '--email', MIKE_EMAIL, '--origin', base, '--hours', '1');
  const page = await context.newPage();
  await page.goto(link);
  await page.waitForURL(url => url.pathname === '/', { timeout: 15_000 });
  return page;
}

async function openDoc(page, base, slug) {
  await page.goto(`${base}/d/${slug}`);
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForFunction(() => window.__proofReadingWalk?.debugState().ready === true, null, { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(300);
  page.setDefaultTimeout(6000);
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
}

async function run(browser, style) {
  const { base, stop, cli } = await startServer(style);
  try {
    cli('add-member', '--name', 'Mike Wolf', '--email', MIKE_EMAIL);
    const tag = `b4ef-${style}-desktop-1440`;
    const ctx = await newContext(browser, base, { viewport: { width: 1440, height: 900 } });
    const mike = await signIn(ctx, cli, base);
    activePage = mike;
    if (process.env.DEBUG_CONSOLE) {
      mike.on('pageerror', e => console.log('PAGEERROR', e.message));
      mike.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('CONSOLE', m.text().slice(0, 300)); });
    }
    const created = await mike.evaluate(async md => {
      const r = await fetch('/library/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Bundles check', markdown: md }) });
      return { status: r.status, body: await r.json() };
    }, markdown);
    assert.ok(created.status === 200 || created.status === 201, JSON.stringify(created));
    const slug = created.body.slug;
    const key = await mike.evaluate(async ({ s, h }) => {
      const r = await fetch(`/api/documents/${s}/agent-keys`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify({ label: 'Claude', runtime: 'Claude Opus 5 (Anthropic)' }) });
      return { status: r.status, body: await r.json() };
    }, { s: slug, h: clientHeaders });
    assert.equal(key.status, 201, JSON.stringify(key));
    const agent = async (method, route, body) => {
      const r = await fetch(`${base}/api/agent/${slug}${route}`, {
        method, headers: { 'Content-Type': 'application/json', ...clientHeaders, 'x-share-token': key.body.token },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    };
    const events = async () => (await agent('GET', '/events/pending?after=0')).body.events ?? [];
    const suggest = (quote, content, extra = {}) => agent('POST', '/marks/suggest-replace', { quote, content, why: 'The vendor slipped two weeks.', ...extra });

    let launchIds = [];
    await check(`${tag}: an AI bundles two suggestions ({bundle} on suggest-replace); a new bundle needs a title`, async () => {
      const untitled = await suggest('September 30', 'October 14', { bundle: { id: 'untitled' } });
      assert.equal(untitled.status, 400, JSON.stringify(untitled.body));
      assert.equal(untitled.body.code, 'BUNDLE_TITLE_REQUIRED');
      const a = await suggest('September 30', 'October 14', { bundle: { id: 'launch', title: 'Move launch to October', why: 'The vendor slipped two weeks; the review moves with it.' } });
      assert.equal(a.status, 200, JSON.stringify(a.body));
      assert.equal(a.body.bundle?.id, 'launch', JSON.stringify(a.body.bundle));
      const b = await suggest('September 23', 'October 7', { bundle: { id: 'launch' } });
      assert.equal(b.status, 200, JSON.stringify(b.body));
      const list = await agent('GET', '/bundles');
      const launch = list.body.bundles.find(x => x.id === 'launch');
      assert.equal(launch.members.length, 2, JSON.stringify(launch));
      assert.equal(launch.acceptable, true, JSON.stringify(launch));
      launchIds = launch.members.map(m => m.markId);
      const state = await agent('GET', '/state');
      const bundled = state.body.issues.filter(i => i.type === 'suggestion' && i.bundleId === 'launch');
      assert.equal(bundled.length, 2, JSON.stringify(state.body.issues.filter(i => i.type === 'suggestion')));
    });

    let secondIds = [];
    await check(`${tag}: POST /bundles groups existing suggestions; a suggestion in one open bundle cannot join another`, async () => {
      const c = await suggest('alpha words', 'ALPHA words');
      const d = await suggest('beta words', 'BETA words');
      assert.equal(c.status, 200, JSON.stringify(c.body));
      secondIds = [c.body.markId, d.body.markId];
      const grouped = await agent('POST', '/bundles', { id: 'second', title: 'Capitalize the second pair', why: 'House style', markIds: secondIds });
      assert.equal(grouped.status, 200, JSON.stringify(grouped.body));
      const clash = await agent('POST', '/bundles', { id: 'third', title: 'Clash', markIds: [secondIds[0]] });
      assert.equal(clash.status, 409, JSON.stringify(clash.body));
      assert.equal(clash.body.code, 'IN_ANOTHER_BUNDLE');
      // Someone edits the beta line after it was bundled: that member is stale now.
      const st = await agent('GET', '/state');
      const beta = st.body.lines.find(l => l.text.startsWith('Second bundle line beta'));
      const snap = await agent('GET', '/snapshot');
      const edit = await agent('POST', '/edit/v2', { baseRevision: snap.body.revision, operations: [{ op: 'find_replace_in_block', ref: beta.ref, find: 'Second bundle', replace: 'Second paired' }] });
      assert.equal(edit.status, 200, JSON.stringify(edit.body));
      const after = (await agent('GET', '/bundles')).body.bundles.find(x => x.id === 'second');
      assert.deepEqual(after.stale, [secondIds[1]], JSON.stringify(after));
      const refused = await agent('POST', '/bundles/second/accept', {});
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.equal(refused.body.code, 'BUNDLE_STALE');
    });

    await openDoc(mike, base, slug);

    await check(`${tag}: the rail shows the bundle as one card: title, why, every passage with its result, and the not-agreement note`, async () => {
      await waitFor(mike, () => window.__proofLineMarks.debugState().extras.bundles.some(b => b.id === 'launch'));
      await mike.evaluate(i => window.__proofReadingWalk.focusLine(i), L.LAUNCH);
      const card = mike.locator('.prw-right .prw-bundle[data-bundle-id="launch"]');
      await card.waitFor({ state: 'visible' });
      assert.equal(await card.locator('.prw-bundle-title').innerText(), 'Move launch to October');
      assert.match(await card.locator('.prw-why').innerText(), /vendor slipped two weeks/);
      const passages = card.locator('.prw-bundle-passage');
      assert.equal(await passages.count(), 2);
      assert.match(await passages.nth(0).locator('.prw-bundle-result').innerText(), /Launch moves to October 14 for every customer\./);
      assert.match(await passages.nth(1).locator('.prw-bundle-result').innerText(), /milestone review happens on October 7/);
      assert.match(await card.locator('.prw-bundle-note').innerText(), /not agreement with the resulting lines/);
      await mike.waitForTimeout(200);
      await mike.screenshot({ path: path.join(shots, `${tag}-1-bundle-card.png`) });
    });

    await check(`${tag}: J/K navigate passages without accepting bundle members`, async () => {
      await mike.evaluate(i => window.__proofReadingWalk.focusLine(i), L.LAUNCH);
      await mike.evaluate(() => window.__proofReadingWalk.next());
      assert.equal((await walk(mike)).cursor, L.LAUNCH + 1);
      await mike.evaluate(() => window.__proofReadingWalk.previous());
      assert.equal((await walk(mike)).cursor, L.LAUNCH);
      const pending = await mike.evaluate(() => window.proof.getAllMarks().filter(m => (m.data?.status ?? 'pending') === 'pending').map(m => m.id));
      assert.ok(launchIds.every(id => pending.includes(id)), 'navigation accepted the bundle');
    });

    await check(`${tag}: Accept bundle applies both changes in one step; the lines still need their own marks`, async () => {
      const card = mike.locator('.prw-right .prw-bundle[data-bundle-id="launch"]');
      await card.locator('.prw-bundle-accept').click();
      await waitFor(mike, n => window.__proofLineMarks.lineList()[n]?.text.includes('October 14'), L.LAUNCH);
      assert.match(await lineText(mike, L.MILESTONE), /October 7/);
      const w = await walk(mike);
      assert.ok(w.bundleDecisions.some(d => d.id === 'launch' && d.ok), JSON.stringify(w.bundleDecisions));
      let recorded = null;
      for (let i = 0; i < 40 && recorded?.status !== 'accepted'; i += 1) {
        recorded = (await agent('GET', '/bundles?closed=1')).body.bundles.find(b => b.id === 'launch');
        if (recorded?.status !== 'accepted') await mike.waitForTimeout(250);
      }
      assert.equal(recorded?.status, 'accepted', JSON.stringify(recorded));
      assert.ok((await events()).some(e => e.type === 'bundle.accepted'), 'bundle.accepted event');
      const s = await lm(mike);
      const mine = s.marks.find(m => m.by === MIKE && m.anchor.excerpt.startsWith('Launch moves'));
      assert.ok(!mine || mine.status !== 'agreed', 'accepting the bundle must not mark the line agreed');
    });

    await check(`${tag}: a stale bundle refuses on the page too; its changes fall back to one-by-one review, the stale one marked`, async () => {
      await mike.evaluate(i => window.__proofReadingWalk.focusLine(i), L.ALPHA);
      const card = mike.locator('.prw-right .prw-bundle[data-bundle-id="second"]');
      await card.waitFor({ state: 'visible' });
      assert.equal(await card.getAttribute('data-stale'), 'true');
      assert.equal(await card.locator('.prw-bundle-passage[data-stale="true"]').count(), 1);
      await card.locator('.prw-bundle-accept').click();
      await waitFor(mike, () => window.__proofReadingWalk.debugState().bundleDecisions.some(d => d.id === 'second' && !d.ok));
      assert.match(await mike.locator('.prw-right .prw-error').innerText(), /changed since they were bundled\. Nothing was accepted/);
      assert.ok(await mike.locator('.prw-right .prw-card[data-mark-id]').count() >= 1, 'individual change cards');
      assert.match(await lineText(mike, L.ALPHA), /alpha words/);
      await mike.screenshot({ path: path.join(shots, `${tag}-2-bundle-stale.png`) });
      const rejected = await agent('POST', '/bundles/second/reject', {});
      assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    });

    await check(`${tag}: an AI offers another wording; it shows stacked under the line (original first) and is an Issue`, async () => {
      const offered = await agent('POST', '/alternatives', { quote: 'Budget line stays', text: 'Budget line rises 5 percent for the quarter.' });
      assert.equal(offered.status, 200, JSON.stringify(offered.body));
      await waitFor(mike, i => window.__proofLineMarks.debugState().extras.alternatives.some(a => a.line === i), L.BUDGET);
      await waitFor(mike, () => document.querySelectorAll('.ProseMirror .pdx-alts .pdx-alt').length === 2);
      const stack = await mike.locator('.ProseMirror .pdx-alts .pdx-alt').allInnerTexts();
      assert.match(stack[0], /Original wording/);
      assert.match(stack[1], /Budget line rises 5 percent/);
      const s = await lm(mike);
      assert.equal(s.extras.alternativeIssues, 1);
      await mike.evaluate(i => window.__proofReadingWalk.focusLine(i), L.BUDGET);
      const alts = mike.locator('.prw-right .plm-box .plm-alts');
      await alts.waitFor({ state: 'visible' });
      assert.equal(await alts.locator('.plm-alt').count(), 2);
      assert.match(await mike.locator('.prw-right .prw-keys').innerText(), /1–2 pick/);
      await mike.waitForTimeout(200);
      await mike.screenshot({ path: path.join(shots, `${tag}-3-alternatives.png`) });
    });

    await check(`${tag}: key 2 picks the AI's wording; everyone picked it, so it becomes the line and the original goes to history`, async () => {
      await mike.evaluate(() => document.activeElement?.blur());
      await mike.keyboard.press('2');
      await waitFor(mike, i => /rises 5 percent/.test(window.__proofLineMarks.lineList()[i]?.text ?? ''), L.BUDGET, 15000)
        .catch(async (error) => { throw new Error(`${error.message} ${JSON.stringify((await events()).filter(e => e.type.startsWith('alternative')).map(e => [e.type, e.data]))} ${JSON.stringify((await lm(mike)).extras.alternatives)} team=${JSON.stringify((await lm(mike)).team)}`); });
      await waitFor(mike, () => window.__proofLineMarks.debugState().extras.alternatives.length === 0, null, 10000)
        .catch(async (error) => { throw new Error(`A ${error.message} ${JSON.stringify((await lm(mike)).extras.alternatives)} ${JSON.stringify((await agent("GET", "/alternatives?closed=1")).body).slice(0, 800)}`); });
      await waitFor(mike, () => document.querySelector('.prw-right .plm-alt-history summary')?.textContent?.includes('Earlier wordings'), null, 20000)
        .catch(async (error) => { throw new Error(`B ${error.message} ${await mike.evaluate(() => document.querySelector('.prw-right .plm-box')?.dataset.line)} focus=${(await walk(mike)).focus} closed=${JSON.stringify((await agent('GET', '/alternatives?closed=1')).body.closed?.map(a => [a.status, a.anchor.excerpt, a.anchor.ordinal]))} html=${(await mike.evaluate(() => document.querySelector('.prw-right .plm-box')?.innerHTML ?? '')).slice(0, 300)}`); });
      assert.ok((await events()).some(e => e.type === 'alternative.resolved' && e.data.how === 'unanimous'), 'alternative.resolved');
    });

    await check(`${tag}: picks that differ keep it open; an Owner decides (the original stays and the offer folds)`, async () => {
      const offered = await agent('POST', '/alternatives', { quote: 'Support hours are', text: 'Support hours are eight to six on weekdays.' });
      assert.equal(offered.status, 200, JSON.stringify(offered.body));
      await mike.evaluate(i => window.__proofReadingWalk.focusLine(i), L.SUPPORT);
      await mike.locator('.prw-right .plm-alts .plm-alt[data-key="1"] input').check();
      await waitFor(mike, i => window.__proofLineMarks.debugState().extras.alternatives.some(a => a.line === i && a.disagree), L.SUPPORT);
      await mike.locator('.prw-right .plm-alts .plm-alt[data-key="1"] .plm-alt-decide').click();
      await waitFor(mike, i => !window.__proofLineMarks.debugState().extras.alternatives.some(a => a.line === i), L.SUPPORT, 10000);
      assert.match(await lineText(mike, L.SUPPORT), /nine to five/);
      assert.ok((await events()).some(e => e.type === 'alternative.resolved' && e.data.how === 'owner'), 'owner decision');
    });

    await check(`${tag}: Explain (E) posts a thread to the AI tagged explain; it is not an Issue and marks nothing`, async () => {
      await mike.evaluate(i => window.__proofReadingWalk.focusLine(i), L.OPS);
      const before = await lm(mike);
      await mike.evaluate(() => document.activeElement?.blur());
      await mike.keyboard.press('e');
      await waitFor(mike, () => window.__proofLineMarks.debugState().extras.explains === 1, null, 10000);
      const ev = (await events()).find(e => e.type === 'explain.requested');
      assert.ok(ev, 'explain.requested');
      assert.match(ev.data.line, /Ops rotation/);
      const markId = ev.data.commentMarkId;
      assert.ok(markId);
      let text = '';
      for (let i = 0; i < 40 && !text; i += 1) {
        const st = await agent('GET', '/state');
        text = st.body.marks?.[markId]?.text ?? '';
        if (!text) await mike.waitForTimeout(250);
      }
      assert.match(text, /^Explain: @claude What does this line mean/);
      const summary = await mike.evaluate(() => window.__proofLineMarks.issueSummary());
      assert.ok(!summary.issues.some(i => i.markId === markId), 'the explain thread is not an Issue');
      const after = await lm(mike);
      const mineBefore = before.marks.filter(m => m.by === MIKE).length;
      assert.equal(after.marks.filter(m => m.by === MIKE).length, mineBefore, 'Explain marks nothing');
    });

    await check(`${tag}: a defined term is linked at its first use until the reader has seen its definition`, async () => {
      await waitFor(mike, () => Boolean(document.querySelector('.ProseMirror .pdx-term[data-term="Issue"]')))
        .catch(async (error) => { const s = await lm(mike); throw new Error(`${error.message} terms=${JSON.stringify(s.extras.terms)} def=${JSON.stringify(s.marks.filter(m => /^Issue/.test(m.anchor.excerpt)))} dom=${await mike.evaluate(() => document.querySelectorAll(".pdx-term").length)} text=${await lineText(mike, L.USE)} deco=${JSON.stringify([s.extras.decoSig, s.extras.decorations, s.extras.termProbe])} closed=${JSON.stringify((await agent("GET", "/alternatives?closed=1")).body.closed?.map(a => [a.status, a.anchor.excerpt]))}`); });
      const s = await lm(mike);
      assert.deepEqual(s.extras.terms.map(t => [t.term, t.line, t.def]), [['Issue', L.USE, L.DEF]]);
      await mike.locator('.ProseMirror .pdx-term[data-term="Issue"]').click();
      await mike.locator('.plm-term-pop').waitFor({ state: 'visible' });
      assert.match(await mike.locator('.plm-term-pop').innerText(), /Issue — a line or mark that someone has not seen/);
      await mike.screenshot({ path: path.join(shots, `${tag}-4-term.png`) });
      await mike.evaluate(i => window.__proofLineMarks.setLineStatus(i, 'seen'), L.DEF);
      await waitFor(mike, () => !document.querySelector('.ProseMirror .pdx-term'));
    });

    await check(`${tag}: blind marking: the AI's reject is hidden until Mike marks the line; the reveal puts the disagreement first`, async () => {
      // Accord layout stage 3: blind marking (an Owner's document setting) is in Share › Link.
      await mike.getByRole('button', { name: 'Share', exact: true }).click();
      const box = mike.locator('#share-dialog #share-panel-link .plm-blind .plm-blind-setting input');
      await box.check();
      await mike.getByRole('button', { name: 'Close share dialog' }).click();
      await waitFor(mike, () => window.__proofLineMarks.debugState().extras.blind === true);
      const rej = await agent('POST', '/marks/line', { quote: 'Every open Issue shows', status: 'rejected', reason: 'The count lags a minute' });
      assert.equal(rej.status, 200, JSON.stringify(rej.body));
      const lastMark = (await events()).filter(e => e.type === 'line_mark.updated').pop();
      assert.equal(lastMark.data.blind, true);
      assert.equal(lastMark.data.status, undefined, 'blind events omit the status');
      await waitFor(mike, () => window.__proofLineMarks.debugState().extras.hiddenMarks >= 1, null, 10000);
      await mike.evaluate(i => window.__proofReadingWalk.focusLine(i), L.USE);
      await mike.locator('.prw-right .plm-box .plm-blind-note').waitFor({ state: 'visible' });
      const claude = mike.locator('.prw-right .plm-team li', { hasText: 'claude' }).locator('.plm-team-status');
      assert.equal(await claude.getAttribute('data-status'), 'hidden');
      await mike.screenshot({ path: path.join(shots, `${tag}-5-blind-hidden.png`) });
      await mike.evaluate(() => document.activeElement?.blur());
      await mike.keyboard.press('a');
      await waitFor(mike, i => window.__proofLineMarks.debugState().extras.disagreement.includes(i), L.USE, 10000);
      await waitFor(mike, i => document.querySelector(`.plm-dot[data-line="${i}"]`)?.dataset.disagreement === 'true', L.USE);
      await mike.locator('.prw-right .plm-box .plm-disagree').waitFor({ state: 'visible' });
      const s = await lm(mike);
      assert.equal(s.aids.ranked[0].rule, 'disagreement', JSON.stringify(s.aids.ranked.slice(0, 3)));
      await mike.waitForTimeout(200);
      await mike.screenshot({ path: path.join(shots, `${tag}-6-blind-reveal.png`) });
    });

    await check(`${tag}: the AI is blind through /state too: Mike's mark is hidden until the AI marks that line`, async () => {
      await mike.evaluate(i => window.__proofLineMarks.setLineStatus(i, 'agreed'), L.LAST);
      await mike.waitForTimeout(400);
      const before = await agent('GET', '/state');
      assert.equal(before.body.blind?.on, true);
      const hidden = before.body.lineMarks.find(m => m.by === MIKE && m.anchor.excerpt.startsWith('Last paragraph'));
      assert.ok(hidden?.hidden === true && hidden.status === 'seen', JSON.stringify(hidden));
      const marked = await agent('POST', '/marks/line', { quote: 'Last paragraph closes', status: 'seen' });
      assert.equal(marked.status, 200, JSON.stringify(marked.body));
      const after = await agent('GET', '/state');
      const shown = after.body.lineMarks.find(m => m.by === MIKE && m.anchor.excerpt.startsWith('Last paragraph'));
      assert.equal(shown?.status, 'agreed', JSON.stringify(shown));
    });

    await check(`${tag}: a time-to-live runs out: Mike's Agree goes stale, the AI re-checks first; "no longer true" reopens it for Mike`, async () => {
      await mike.getByRole('button', { name: 'Share', exact: true }).click();
      await mike.locator('#share-dialog #share-panel-link .plm-blind .plm-blind-setting input').uncheck();
      await waitFor(mike, () => window.__proofLineMarks.debugState().extras.blind === false);
      await mike.getByRole('button', { name: 'Close share dialog' }).click();
      await mike.evaluate(i => window.__proofReadingWalk.focusLine(i), L.PRICING);
      await mike.evaluate(() => document.activeElement?.blur());
      await mike.keyboard.press('a');
      await waitFor(mike, i => document.querySelector(`.plm-dot[data-line="${i}"]`)?.dataset.status === 'agreed', L.PRICING);
      await mike.waitForTimeout(300);
      const box = mike.locator('.prw-right .plm-box');
      // Accord layout stage 3 (decision 8): Time-to-live is under the line's ⋯ More.
      await box.locator('.plm-more-btn').click();
      await box.locator('.plm-ttl-open').click();
      await box.locator('.plm-ttl-form input').fill('2s');
      await box.locator('.plm-ttl-form button[type="submit"]').click();
      await waitFor(mike, i => window.__proofLineMarks.debugState().extras.ttls.some(t => t.line === i), L.PRICING);
      await mike.waitForTimeout(2600);
      await mike.evaluate(() => window.__proofLineMarks.refresh());
      await waitFor(mike, i => document.querySelector(`.plm-dot[data-line="${i}"]`)?.dataset.status === 'stale', L.PRICING, 10000);
      const st = await agent('GET', '/state');
      const ttl = st.body.ttls.find(t => /Pricing/.test(t.text));
      assert.equal(ttl.expired, true, JSON.stringify(ttl));
      assert.ok(st.body.evaluatedAt);
      const issue = st.body.issues.find(i => i.type === 'ttl');
      assert.deepEqual(issue?.openFor, ['ai:claude'], JSON.stringify(issue));
      assert.equal(issue.priorityRule, 'ttl-check');
      assert.ok((await events()).some(e => e.type === 'ttl.expired'), 'ttl.expired');
      await box.locator('.plm-ttl-status[data-state="expired"]').waitFor({ state: 'visible' });
      await mike.screenshot({ path: path.join(shots, `${tag}-7-ttl-stale.png`) });
      const no = await agent('POST', `/ttl/${ttl.id}/check`, { stillTrue: false, why: 'Prices rose in September' });
      assert.equal(no.status, 200, JSON.stringify(no.body));
      await mike.evaluate(() => window.__proofLineMarks.refresh());
      await waitFor(mike, i => window.__proofLineMarks.debugState().extras.ttls.some(t => t.line === i && t.reason === 'not-true' && t.openFor.length === 1), L.PRICING, 10000);
      await mike.evaluate(() => document.activeElement?.blur());
      await mike.keyboard.press('a');
      await waitFor(mike, i => !window.__proofLineMarks.debugState().extras.ttls.some(t => t.line === i && t.openFor.length > 0), L.PRICING, 10000);
    });
    await ctx.close();

    // ---------------------------------------------------------------- phone 390
    const ptag = `b4ef-${style}-phone-390x844`;
    const viewport = { width: 390, height: 844 };
    const pctx = await newContext(browser, base, { ...devices['iPhone 13'], viewport, screen: viewport, hasTouch: true, isMobile: true });
    const phone = await signIn(pctx, cli, base);
    activePage = phone;
    const offered = await agent('POST', '/alternatives', { quote: 'Phone line offers', text: 'Phone line gives a place for another wording.' });
    assert.equal(offered.status, 200, JSON.stringify(offered.body));
    const pb1 = await suggest('Ops rotation', 'On-call rotation', { bundle: { id: 'phone', title: 'Rename the rotation', why: 'Matches the handbook' } });
    assert.equal(pb1.status, 200, JSON.stringify(pb1.body));
    await openDoc(phone, base, slug);
    await check(`${ptag}: the line sheet shows the wordings as 44px radios; tapping one picks it; no sideways scroll`, async () => {
      await waitFor(phone, i => window.__proofLineMarks.debugState().extras.alternatives.some(a => a.line === i), L.PHONE);
      const dot = phone.locator(`.plm-dot[data-line="${L.PHONE}"]`);
      await dot.scrollIntoViewIfNeeded();
      await dot.tap();
      const sheet = phone.locator('.plm-menu.plm-sheet');
      await sheet.waitFor({ state: 'visible' });
      const rows = sheet.locator('.plm-alts .plm-alt');
      assert.equal(await rows.count(), 2);
      const heights = await rows.evaluateAll(els => els.map(e => e.getBoundingClientRect().height));
      assert.ok(heights.every(h => h >= 44), `rows ${heights}`);
      const sw = await phone.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      assert.ok(sw[0] <= sw[1] + 1, `scrollWidth ${sw}`);
      await phone.screenshot({ path: path.join(shots, `${ptag}-1-alternatives.png`) });
      await rows.nth(0).tap();
      await waitFor(phone, (me) => window.__proofLineMarks.debugState().extras.alternatives.some(a => a.picks.some(p => p.by === me && p.choice === 'original')), MIKE);
    });
    await check(`${ptag}: the rail sheet shows a bundle card with Accept bundle / Reject bundle at touch size`, async () => {
      await waitFor(phone, () => window.__proofLineMarks.debugState().extras.bundles.some(b => b.id === 'phone'));
      await phone.keyboard.press('Escape');
      await phone.locator('.plm-menu.plm-sheet').waitFor({ state: 'detached' }).catch(() => {});
      await phone.evaluate(i => window.__proofReadingWalk.focusLine(i), L.OPS);
      await phone.evaluate(() => window.__proofReadingWalk.openSheet('right'));
      const card = phone.locator('.prw-right.prw-sheet-open .prw-bundle[data-bundle-id="phone"]');
      await card.waitFor({ state: 'visible' });
      await card.scrollIntoViewIfNeeded();
      const h = await card.locator('.prw-bundle-accept').evaluate(el => el.getBoundingClientRect().height);
      assert.ok(h >= 32, `accept ${h}px`);
      await phone.screenshot({ path: path.join(shots, `${ptag}-2-bundle.png`) });
      await card.locator('.prw-bundle-accept').tap();
      await waitFor(phone, i => /On-call rotation/.test(window.__proofLineMarks.lineList()[i]?.text ?? ''), L.OPS, 10000);
    });
    await pctx.close();
  } finally {
    await stop();
  }
}

const browser = await chromium.launch();
try {
  for (const style of styles) await run(browser, style);
} finally {
  await browser.close();
}
console.log(`\n${results.length - failures}/${results.length} bundles-alts checks passed`);
process.exit(failures ? 1 : 0);
