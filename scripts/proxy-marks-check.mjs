#!/usr/bin/env node
// Browser check for Familiar proxy marks (Mike, 2026-09-19): Mike chooses his Familiar in the
// rail's header; the Familiar (an agent key, through the agent API) pre-marks lines with evidence;
// the proxies change no Issue count; the brief shows the counts; Ratify all turns the sure ones into
// Mike's Agreed (via proxy) and the Issue count drops; Undo restores; Review the flagged walks only
// those; a meaning-changing edit resets a proxy; another AI key cannot proxy; an AI mark without
// evidence reads "claimed". Desktop 1440 and phone 390, both review styles.
// Authorship: Claude Opus 5 (worker proof-proxy), 2026-09-19, in the style of chat-check.mjs.
// Starts an isolated local server on the current dist/ build (run `npm run build` first).
// Usage: node scripts/proxy-marks-check.mjs [--style playmaker|proof] [--shots dir]
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
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n').slice(0, 8).join(' | ')}`);
    await activePage?.screenshot({ path: path.join(shots, `proxy-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-proxy-check-'));
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

const para = (tag) => `${tag} paragraph is plain text for reading; it is long enough to be a real line of the document.`;
const markdown = [
  '# Proxy check',                                                   // 0
  para('Intro'),                                                     // 1
  'The budget is fixed at ten thousand dollars for the first year.', // 2
  'Launch is planned for the second quarter of next year.',         // 3
  'Marketing starts two weeks before the launch date.',             // 4
  'Support hours are nine to five on weekdays.',                    // 5
  'Should we hire a contractor for support?',                       // 6
  para('Closing'),                                                   // 7
].join('\n\n');
const L = { TITLE: 0, INTRO: 1, BUDGET: 2, LAUNCH: 3, MARKETING: 4, SUPPORT: 5, ASK: 6, CLOSING: 7 };

const waitFor = (page, fn, argument, timeout = 15000) => page.waitForFunction(fn, argument, { timeout, polling: 200 });

async function newContext(browser, base, options = {}) {
  const context = await browser.newContext(options);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  return context;
}

async function signIn(context, cli, base, email) {
  const link = cli('signin-link', '--email', email, '--origin', base, '--hours', '1');
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

const call = (base, slug, headers, method, route, body) => fetch(`${base}/api/agent/${slug}${route}`, {
  method, headers, body: body === undefined ? undefined : JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json() }));
const lm = page => page.evaluate(() => window.__proofLineMarks.debugState());
const proxyState = async page => (await lm(page)).proxy;
const issues = async page => (await lm(page)).issues;

/** Every line marked Seen by an AI, with evidence (so only Mike's own reading is left). */
async function aiReadsAll(base, slug, KEY, evidence = true) {
  const lines = Object.values(L).map(i => ({ lineIndex: i, ...(evidence ? { evidence: 'Read the line and compared it with the plan' } : {}) }));
  const r = await call(base, slug, KEY, 'POST', '/marks/line', { status: 'seen', lines });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

async function mintKey(page, slug, label) {
  const key = await page.evaluate(async ({ s, h, label }) => {
    const r = await fetch(`/api/documents/${s}/agent-keys`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify({ label, runtime: 'Claude Opus 5 (Anthropic)' }) });
    return { status: r.status, body: await r.json() };
  }, { s: slug, h: clientHeaders, label });
  assert.equal(key.status, 201, JSON.stringify(key));
  return { 'Content-Type': 'application/json', ...clientHeaders, 'x-share-token': key.body.token };
}

const PROXIES = [
  { target: { lineIndex: L.INTRO }, status: 'agreed', confidence: 0.97, evidence: 'Intro only frames the plan; no claims to check' },
  { target: { lineIndex: L.BUDGET }, status: 'agreed', confidence: 0.95, evidence: 'Budget matches the finance sheet (10,000 USD, year one)' },
  { target: { lineIndex: L.LAUNCH }, status: 'agreed', confidence: 0.93, evidence: 'Launch quarter matches the roadmap you approved' },
  { target: { lineIndex: L.MARKETING }, status: 'agreed', confidence: 0.6, evidence: 'Marketing lead time is plausible but unconfirmed' },
  { target: { lineIndex: L.SUPPORT }, status: 'rejected-suggested', confidence: 0.8, evidence: 'The support page says eight to six, not nine to five' },
  { target: { lineIndex: L.ASK }, status: 'agreed', confidence: 0.99, evidence: 'You said yes to a contractor on Monday' },
  { target: { lineIndex: L.CLOSING }, status: 'agreed', confidence: 0.96, evidence: 'Closing paragraph restates the plan' },
];

async function run(browser, style) {
  const { base, stop, cli } = await startServer(style);
  try {
    cli('add-member', '--name', 'Mike Wolf', '--email', MIKE_EMAIL);
    const tag = `proxy-${style}-desktop-1440`;
    const ctx = await newContext(browser, base, { viewport: { width: 1440, height: 900 } });
    const mike = await signIn(ctx, cli, base, MIKE_EMAIL);
    activePage = mike;
    const created = await mike.evaluate(async md => {
      const r = await fetch('/library/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Proxy check', markdown: md }) });
      return { status: r.status, body: await r.json() };
    }, markdown);
    assert.ok(created.status === 200 || created.status === 201, JSON.stringify(created));
    const slug = created.body.slug;
    await mike.goto(`${base}/d/${slug}`);
    await mike.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 20_000 });
    const CLAUDE = await mintKey(mike, slug, 'Claude');
    const CRITIC = await mintKey(mike, slug, 'Critic');
    // Both AIs read every line (Claude with evidence, Critic too), and Claude asks Mike on line 6.
    await aiReadsAll(base, slug, CLAUDE);
    await aiReadsAll(base, slug, CRITIC);
    const ask = await call(base, slug, CLAUDE, 'POST', '/asks', { lineIndex: L.ASK, to: [MIKE], recommend: 'Yes: the support queue doubled' });
    assert.equal(ask.status, 200, JSON.stringify(ask.body));
    await openDoc(mike, base, slug);

    await check(`${tag}: "My Familiar" sits in the Line tab's footer (with who you are) and lists the AIs present; Mike chooses Claude`, async () => {
      const select = mike.locator('.prw-right .amg-me .ppx-familiar-select');
      await select.waitFor({ state: 'visible' });
      const options = await select.locator('option').allInnerTexts();
      assert.equal(options[0], 'none');
      assert.deepEqual(options.slice(1).sort(), ['Claude', 'Critic']);
      await select.selectOption('ai:claude');
      await waitFor(mike, () => window.__proofLineMarks.debugState().proxy.familiar === 'ai:claude');
      assert.equal(await mike.locator('.prw-right .ppx-brief').isHidden(), true, 'no brief before any proxy');
    });

    const before = await issues(mike);
    await check(`${tag}: the Familiar's proxies need evidence; another AI key cannot proxy for Mike`, async () => {
      const noEvidence = await call(base, slug, CLAUDE, 'POST', '/marks/proxy', { for: MIKE, lines: [{ lineIndex: L.INTRO, status: 'agreed', confidence: 0.99 }] });
      assert.equal(noEvidence.status, 400);
      assert.equal(noEvidence.body.code, 'EVIDENCE_REQUIRED');
      const critic = await call(base, slug, CRITIC, 'POST', '/marks/proxy', { for: MIKE, lines: [PROXIES[0]] });
      assert.equal(critic.status, 403);
      assert.equal(critic.body.code, 'NOT_THIS_PERSONS_FAMILIAR');
      const ok = await call(base, slug, CLAUDE, 'POST', '/marks/proxy', { for: MIKE, lines: PROXIES });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.count, PROXIES.length);
    });

    // Note: moving the focus line makes the reading walk mark it for Mike after its reading time
    // (dwell), which takes it out of the brief. Checks that move the focus come last.
    await check(`${tag}: the brief shows the counts at the top of the rail; the proxies change no Issue count`, async () => {
      await waitFor(mike, () => window.__proofLineMarks.debugState().proxy.counts?.read === 7);
      const p = await proxyState(mike);
      // The title was read by dwell when the page opened, so no line is left without a proxy.
      assert.deepEqual(p.counts, { read: 7, agreed: 4, flagged: 3, needYou: 0 });
      assert.deepEqual(p.ratify, [L.INTRO, L.BUDGET, L.LAUNCH, L.CLOSING]);
      assert.deepEqual(p.flagged, [[L.MARKETING, 'check'], [L.SUPPORT, 'reject'], [L.ASK, 'held']]);
      assert.equal(await issues(mike), before, 'proxies must not change the Issue count');
      const brief = mike.locator('.prw-right .ppx-brief');
      await brief.waitFor({ state: 'visible' });
      assert.equal(await brief.locator('.ppx-headline').innerText(), 'Claude read 7 lines for you: agreed 4, flagged 3 for you, 0 need you');
      const first = await mike.evaluate(() => document.querySelector('.prw-right .prw-rail-body')?.firstElementChild?.className);
      assert.match(first, /ppx-brief/, 'the brief is the first thing in the rail');
      // Accord layout stage 2 (decision 10): the brief is folded to its headline; View › Familiar's brief opens it.
      assert.equal(await brief.locator('.ppx-body').isHidden(), true, 'the brief starts folded');
      await mike.locator('#accord-menubar .amb-top[data-menu="view"]').click();
      await mike.locator('.amb-menu .amb-item', { hasText: 'Familiar’s brief' }).click();
      await brief.locator('.ppx-ratify').waitFor({ state: 'visible' });
      assert.equal(await brief.locator('.ppx-fold-toggle').getAttribute('aria-expanded'), 'true');
      assert.equal(await brief.locator('.ppx-ratify').innerText(), 'Ratify all 4');
      assert.equal(await brief.locator('.ppx-review').innerText(), 'Review the 3 flagged');
      // The ringer list: every line the click would cover, with its evidence.
      assert.equal(await brief.locator('.ppx-list[data-kind="ratify"] .ppx-item').count(), 4);
      assert.match(await brief.locator('.ppx-list[data-kind="ratify"] .ppx-item').nth(1).innerText(), /finance sheet/);
      assert.match(await brief.locator('.ppx-list[data-kind="flagged"]').innerText(), /below 0\.9: suggest you check[\s\S]*recommends rejecting[\s\S]*an open ask/);
      // Lavender dots with the Familiar's initial; Mike's own glyph is still unmarked.
      await waitFor(mike, l => document.querySelector(`.plm-dot[data-line="${l}"]`)?.dataset.proxy === 'agreed', L.BUDGET);
      const dot = await mike.evaluate(l => { const d = document.querySelector(`.plm-dot[data-line="${l}"]`); return { status: d.dataset.status, initial: d.querySelector('.plm-proxy')?.textContent }; }, L.BUDGET);
      assert.deepEqual(dot, { status: 'unseen', initial: 'C' });
      assert.equal(await mike.evaluate(l => document.querySelector(`.plm-dot[data-line="${l}"]`)?.dataset.proxy, L.SUPPORT), 'rejected-suggested');
      await mike.screenshot({ path: path.join(shots, `${tag}-1-brief.png`) });
    });

    await check(`${tag}: a meaning-changing edit (by the AI, through the agent API) resets that proxy`, async () => {
      const snap = await fetch(`${base}/api/agent/${slug}/snapshot`, { headers: CLAUDE }).then(r => r.json());
      const block = snap.blocks.find(b => /Closing paragraph/.test(b.markdown));
      const r = await fetch(`${base}/api/agent/${slug}/edit/v2`, {
        method: 'POST', headers: { ...CLAUDE, 'Idempotency-Key': `k-${Date.now()}` },
        body: JSON.stringify({ by: 'ai:claude', baseRevision: snap.revision, operations: [{ op: 'replace_block', ref: block.ref, block: { markdown: 'Closing paragraph is no longer the plan; we cancelled it.' } }] }),
      });
      assert.ok(r.status === 200 || r.status === 202, `edit/v2 ${r.status}`);
      await waitFor(mike, () => window.__proofLineMarks.debugState().proxy.reset === 1, null, 20000);
      const p = await proxyState(mike);
      assert.deepEqual(p.counts, { read: 6, agreed: 3, flagged: 3, needYou: 1 });
      assert.equal(await mike.evaluate(l => document.querySelector(`.plm-dot[data-line="${l}"]`)?.dataset.proxy ?? null, L.CLOSING), null);
    });

    let afterEdit = 0;
    const proxyMarks = async page => (await lm(page)).marks.filter(m => m.by === MIKE && m.via === 'proxy');
    await check(`${tag}: Ratify all turns the 3 sure lines into Mike's Agreed via proxy, and the Issue count drops by 3`, async () => {
      afterEdit = await issues(mike);
      await mike.locator('.prw-right .ppx-ratify').click();
      await waitFor(mike, () => window.__proofLineMarks.debugState().proxy.writes.some(w => w.kind === 'ratify' && w.ok));
      await waitFor(mike, n => window.__proofLineMarks.debugState().issues === n - 3, afterEdit);
      const marks = await proxyMarks(mike);
      assert.equal(marks.length, 3);
      for (const m of marks) {
        assert.equal(m.status, 'agreed');
        assert.equal(m.proxy.familiar, 'ai:claude');
        assert.ok(m.evidence && m.proxy.confidence >= 0.9);
      }
      const done = mike.locator('.prw-right .ppx-done');
      await done.waitFor({ state: 'visible' });
      assert.match(await done.innerText(), /Ratified 3 lines as Agreed \(from Claude\)/);
      assert.equal(await mike.evaluate(l => document.querySelector(`.plm-dot[data-line="${l}"]`)?.dataset.status, L.BUDGET), 'agreed');
      await mike.evaluate(i => window.__proofReadingWalk.focusLine(i), L.BUDGET);
      const team = await mike.locator('.prw-right .plm-team').innerText();
      assert.match(team, /ratified from Claude, confidence 0\.95/);
      assert.match(team, /Evidence: Budget matches the finance sheet/);
      await mike.screenshot({ path: path.join(shots, `${tag}-2-ratified.png`) });
      // Back to the title (already read) so no dwell lands on a line while it is undone.
      await mike.evaluate(() => window.__proofReadingWalk.focusLine(0));
      await mike.waitForTimeout(300);
    });

    await check(`${tag}: Undo restores the previous marks in one request, and the Issue count returns`, async () => {
      await mike.locator('.prw-right .ppx-undo').click();
      await waitFor(mike, n => window.__proofLineMarks.debugState().issues === n, afterEdit);
      assert.equal((await proxyMarks(mike)).length, 0);
      assert.equal((await proxyState(mike)).counts.agreed, 3, 'the proxies are back in the brief');
      assert.equal(await mike.locator('.prw-right .ppx-done').count(), 0);
      assert.equal((await proxyState(mike)).writes.filter(w => w.kind === 'undo').length, 1);
    });

    await check(`${tag}: the line's box says the proxy is not Mike's, with its evidence`, async () => {
      await mike.evaluate(i => window.__proofReadingWalk.focusLine(i), L.SUPPORT);
      // Accord layout stage 3: the Familiar's note folds to "Familiar says (1)" after the line's changes.
      const fold = mike.locator('.prw-right .plm-familiar-fold');
      await fold.locator('summary').click();
      assert.equal(await fold.locator('summary').innerText(), 'Familiar says (1)');
      const note = mike.locator('.prw-right .plm-familiar-fold .plm-proxy-note');
      await note.waitFor({ state: 'visible' });
      const text = await note.innerText();
      assert.match(text, /Your Familiar Claude recommends rejecting this line/);
      assert.match(text, /Evidence: The support page says eight to six/);
      assert.match(text, /reject it yourself/);
      await mike.evaluate(() => window.__proofReadingWalk.focusLine(0));
    });

    await check(`${tag}: reading a flagged line by dwell gives Mike at most Seen, and it stays in the brief`, async () => {
      // Claude (not Mike) is the last to have claimed the support line, so a dwell would otherwise give Agreed.
      await call(base, slug, CLAUDE, 'POST', '/marks/line', { lineIndex: L.SUPPORT, status: 'agreed', evidence: 'Checked against last year\'s plan' });
      await mike.evaluate(() => window.__proofLineMarks.refresh());
      await mike.evaluate(i => window.__proofReadingWalk.focusLine(i), L.SUPPORT);
      await waitFor(mike, l => window.__proofLineMarks.debugState().marks.some(m => m.by === 'human:mw@mike-wolf.com' && m.anchor.ordinal === l && m.via === 'dwell'), L.SUPPORT, 15000);
      // Stay on the line past its reading time again: an upgrade to Agreed would land now.
      await mike.waitForTimeout(2500);
      const mine = (await lm(mike)).marks.find(m => m.by === MIKE && m.anchor.ordinal === L.SUPPORT);
      assert.equal(mine.status, 'seen', `the dwell gave ${mine.status}`);
      const p = await proxyState(mike);
      assert.ok(p.flagged.some(([line, bucket]) => line === L.SUPPORT && bucket === 'reject'), JSON.stringify(p.flagged));
      assert.equal(await mike.evaluate(l => document.querySelector(`.plm-dot[data-line="${l}"]`)?.dataset.proxy, L.SUPPORT), 'rejected-suggested');
      await mike.evaluate(() => window.__proofReadingWalk.focusLine(0));
    });

    await check(`${tag}: Review the flagged walks Next issue through only those lines, then stops`, async () => {
      await mike.waitForTimeout(300);
      const flagged = (await proxyState(mike)).flagged.map(([line]) => line);
      assert.ok(flagged.length >= 2 && flagged.includes(L.MARKETING) && flagged.includes(L.ASK), JSON.stringify(flagged));
      await mike.locator('.prw-right .ppx-review').click();
      await waitFor(mike, l => window.__proofReadingWalk.debugState().focus === l, flagged[0]);
      assert.match(await mike.locator('.prw-right .ppx-walk').innerText(), new RegExp(`Reviewing flagged: 1 of ${flagged.length}`));
      await mike.locator('.plm-next').click();
      await waitFor(mike, l => window.__proofReadingWalk.debugState().focus === l, flagged[1]);
      await mike.screenshot({ path: path.join(shots, `${tag}-3-flagged-walk.png`) });
      for (let i = 2; i < flagged.length; i += 1) {
        await mike.locator('.prw-right .ppx-walk-next').click();
        await waitFor(mike, l => window.__proofReadingWalk.debugState().focus === l, flagged[i]);
      }
      await mike.locator('.prw-right .ppx-walk-next').click();
      await waitFor(mike, () => window.__proofLineMarks.debugState().proxy.walk === null);
      await mike.evaluate(() => window.__proofReadingWalk.focusLine(0));
    });

    await check(`${tag}: an AI mark without evidence reads "claimed"; with evidence it shows the evidence`, async () => {
      const r = await call(base, slug, CRITIC, 'POST', '/marks/line', { lineIndex: L.CLOSING, status: 'agreed' });
      assert.equal(r.status, 200);
      const c = await call(base, slug, CLAUDE, 'POST', '/marks/line', { lineIndex: L.CLOSING, status: 'seen', evidence: 'Read the cancelled closing line' });
      assert.equal(c.status, 200);
      await mike.evaluate(() => window.__proofLineMarks.refresh());
      await mike.evaluate(i => window.__proofReadingWalk.focusLine(i), L.CLOSING);
      await waitFor(mike, () => !!document.querySelector('.prw-right .plm-team .plm-claimed'));
      const team = await mike.locator('.prw-right .plm-team').innerText();
      // Cross invitation: an AI's row now reads "Critic — added by <the human who added it>".
      assert.match(team, /critic(\s*—\s*added by[^\n]*)?\s*Agreed\s*claimed/i);
      assert.match(team, /claude[\s\S]*Evidence: Read the cancelled closing line/i);
      await mike.evaluate(() => window.__proofReadingWalk.focusLine(0));
    });
    await ctx.close();

    // ---------------------------------------------------------------- phone 390
    const ptag = `proxy-${style}-phone-390x844`;
    const viewport = { width: 390, height: 844 };
    const phoneCtx = await newContext(browser, base, { ...devices['iPhone 13'], viewport, screen: viewport, hasTouch: true, isMobile: true });
    const phone = await signIn(phoneCtx, cli, base, MIKE_EMAIL);
    activePage = phone;
    await openDoc(phone, base, slug);
    await check(`${ptag}: a pill under the top bar says what the Familiar read, and opens the brief in the sheet`, async () => {
      const pill = phone.locator('.ppx-pill');
      await pill.waitFor({ state: 'visible' });
      assert.match(await pill.innerText(), /Claude read \d+ for you: 3 to ratify/);
      const box = await pill.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 390, `pill fits ${JSON.stringify(box)}`);
      await waitFor(phone, l => document.querySelector(`.plm-dot[data-line="${l}"]`)?.dataset.proxy === 'agreed', L.BUDGET);
      await phone.screenshot({ path: path.join(shots, `${ptag}-1-pill.png`) });
      await pill.locator('.ppx-pill-open').tap();
      const brief = phone.locator('.prw-right.prw-sheet-open .ppx-brief');
      await brief.waitFor({ state: 'visible' });
      assert.equal(await pill.isHidden(), true);
      const ratify = brief.locator('.ppx-ratify');
      const rb = await ratify.boundingBox();
      assert.ok(rb.height >= 44, `touch target ${rb.height}`);
      const sw = await phone.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      assert.ok(sw[0] <= sw[1] + 1, `no sideways scroll ${sw}`);
      await phone.screenshot({ path: path.join(shots, `${ptag}-2-sheet.png`) });
    });
    await check(`${ptag}: Ratify all from the sheet: the Issue count drops by 3; Undo brings it back`, async () => {
      const n = await issues(phone);
      await phone.locator('.prw-right.prw-sheet-open .ppx-ratify').tap();
      await waitFor(phone, m => window.__proofLineMarks.debugState().issues === m - 3, n);
      await phone.locator('.prw-right.prw-sheet-open .ppx-undo').waitFor({ state: 'visible' });
      await phone.screenshot({ path: path.join(shots, `${ptag}-3-ratified.png`) });
      await phone.locator('.prw-right.prw-sheet-open .ppx-undo').tap();
      await waitFor(phone, m => window.__proofLineMarks.debugState().issues === m, n);
    });
    await phoneCtx.close();
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
console.log(`\n${results.length - failures}/${results.length} proxy-mark checks passed`);
process.exit(failures ? 1 : 0);
