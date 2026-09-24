#!/usr/bin/env node
// Browser check for Proof Documents Step B3: {ask} decision lines.
// Authorship: Claude Opus 5 (worker proof-ask), 2026-09-18, in the style of folding-check.mjs.
// Starts an isolated local server on the current dist/ build (run `npm run build` first), creates
// throwaway documents on a temp SQLite database, and drives Chromium in both review styles at
// 1440 (desktop) and 390 (phone). Screenshots go to .preview/ (or --shots <dir>).
// Exit code 0 only if every check passes.
// Usage: node scripts/asks-check.mjs [--style playmaker|proof] [--width 1440] [--shots dir]
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
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const shots = arg('--shots') || path.join(root, '.preview');
mkdirSync(shots, { recursive: true });
const styles = arg('--style') ? [arg('--style')] : ['playmaker', 'proof'];
const widths = arg('--width') ? [Number(arg('--width'))] : [1440];

const clientHeaders = { 'X-Proof-Client-Version': '0.32.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `asks-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-asks-check-'));
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

const para = (tag, n) => `${tag} paragraph ${n} is plain text for reading; it is long enough to be a real line of the document.`;
// Lines: 0 Title | 1 Intro | 2 Alpha (holds a suggestion) | 3 Q1 (ask) | 4 Middle | 5 Q2 (inserted ask) | 6 Last
const markdown = [
  '# Ask check', para('Intro', 1),
  'Alpha paragraph carries the change word for a suggestion.',
  'Should we ship the ask control tonight?',
  para('Middle', 1), para('Last', 1),
].join('\n\n');
const L = { ALPHA: 2, Q1: 3, MIDDLE: 4, Q2: 5, LAST: 6 };

async function api(base, created, method, route, body) {
  const r = await fetch(`${base}/api/agent/${created.slug}${route}`, {
    method, headers: { 'Content-Type': 'application/json', 'x-share-token': created.accessToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await r.json();
  return { status: r.status, body: json };
}

async function createDoc(base, asked) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown, title: 'Ask check' }),
  });
  assert.equal(response.status, 200);
  const created = await response.json();
  const sug = await api(base, created, 'POST', '/marks/suggest-replace', { quote: 'change word', content: 'CHANGED word', by: 'ai:check' });
  assert.ok(sug.status === 200, `suggest: ${sug.status} ${JSON.stringify(sug.body)}`);
  const a1 = await api(base, created, 'POST', '/asks', {
    by: 'ai:cos', quote: 'ship the ask control', to: [asked], recommend: 'Yes: every check passes', ifYes: 'The COS deploys at 06:00 UTC',
  });
  assert.equal(a1.status, 200, `ask 1: ${JSON.stringify(a1.body)}`);
  const a2 = await api(base, created, 'POST', '/asks', {
    by: 'ai:cos', insertAfter: { quote: 'Middle paragraph' }, text: 'Can we retire the old review page this week?', to: [asked], recommend: 'Yes: Proof covers it',
  });
  assert.equal(a2.status, 200, `ask 2: ${JSON.stringify(a2.body)}`);
  assert.equal(a2.body.ask.lineIndex, L.Q2);
  return { ...created, ask1: a1.body.ask.id, ask2: a2.body.ask.id };
}

async function openDoc(browser, base, slug, name, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.addInitScript(viewer => { try { localStorage.setItem('proof-share-viewer-name', viewer); } catch {} }, name);
  const page = await context.newPage();
  await page.goto(`${base}/d/${slug}`);
  await ready(page);
  return { context, page };
}

async function ready(page) {
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForFunction(() => window.__proofReadingWalk?.debugState().ready === true
    && window.__proofLineMarks.debugState().asks.length >= 2
    && document.querySelectorAll('.ProseMirror .pask').length >= 2, null, { timeout: 10_000 });
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  page.setDefaultTimeout(6000);
}

const lm = page => page.evaluate(() => window.__proofLineMarks.debugState());
const walk = page => page.evaluate(() => window.__proofReadingWalk.debugState());
const waitFor = (page, fn, arg, timeout = 8000) => page.waitForFunction(fn, arg, { timeout, polling: 100 });
const inline = (page, id) => page.locator(`.ProseMirror .pask[data-ask-id="${id}"]`);
const serverAsk = async (base, created, id) => (await api(base, created, 'GET', '/asks')).body.asks.find(a => a.id === id);

async function desktop(browser, base, style, width) {
  const created = await createDoc(base, 'Ada');
  const tag = `asks-${style}-${width}`;
  const a = await openDoc(browser, base, created.slug, 'Ada', { viewport: { width, height: 900 } });
  const page = a.page;
  activePage = page;
  const mdBefore = await page.evaluate(() => window.proof.getMarkdownSnapshot()?.content);

  await check(`${tag}: an ask line shows an Ask tag and, under it, the recommendation, If yes, and Yes / Not yet / No`, async () => {
    const info = await page.evaluate(id => {
      const lmUi = window.__proofLineMarks; const view = lmUi.editorView(); const line = lmUi.lineList()[3];
      const dom = view.nodeDOM(line.pos);
      const control = dom.querySelector(`.pask[data-ask-id="${id}"]`);
      const tag = dom.querySelector('.pask-inline-tag');
      return {
        tag: tag?.textContent, control: !!control, tagBeforeText: tag && dom.firstChild === tag,
        rec: control?.querySelector('.pask-rec')?.textContent, ifYes: control?.querySelector('.pask-ifyes')?.textContent,
        buttons: [...(control?.querySelectorAll('.pask-btn') ?? [])].map(b => b.textContent),
        lineText: line.text,
      };
    }, created.ask1);
    assert.equal(info.tag, 'Ask');
    assert.ok(info.control, 'no control inside the question line');
    assert.match(info.rec, /Recommend: Yes: every check passes/);
    assert.match(info.ifYes, /If yes: The COS deploys at 06:00 UTC/);
    assert.deepEqual(info.buttons, ['Yes', 'Not yet', 'No']);
    assert.equal(info.lineText, 'Should we ship the ask control tonight?', 'the widget leaked into the line text');
    await page.screenshot({ path: path.join(shots, `${tag}-1-inline.png`) });
  });

  await check(`${tag}: the widgets are view-only (the document text is unchanged) and open asks are Issues`, async () => {
    assert.equal(await page.evaluate(() => window.proof.getMarkdownSnapshot()?.content), mdBefore);
    assert.doesNotMatch(mdBefore, /Recommend|pask/);
    const s = await lm(page);
    assert.equal(s.askIssues, 2);
    const title = await page.locator('#share-banner .plm-issues-count').getAttribute('title');
    assert.match(title, /need you/);
  });

  await check(`${tag}: Next issue lands on the ask line first`, async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    for (let i = 0; i < 12; i += 1) {
      await nextReview(page);
      await page.waitForTimeout(120);
      const current = await page.evaluate(() => window.__proofReadingWalk.focusIndex());
      if (current === 3) return;
    }
    throw new Error('Next issue never landed on the ask');
  });

  const bob = await openDoc(browser, base, created.slug, 'Bob', { viewport: { width: 1280, height: 900 } });
  await check(`${tag}: someone not asked sees the ask and its status, but no answer buttons inline`, async () => {
    const control = inline(bob.page, created.ask1);
    assert.match(await control.locator('.pask-to').innerText(), /for Ada/);
    assert.equal(await control.locator('.pask-btn').count(), 0);
  });

  await check(`${tag}: No without words asks for a reason and sends nothing; with words it is recorded exactly`, async () => {
    const posts = [];
    page.on('request', req => { if (req.method() === 'POST' && req.url().includes('/asks/')) posts.push(req.url()); });
    const control = inline(page, created.ask1);
    await control.scrollIntoViewIfNeeded();
    await control.getByRole('button', { name: 'No', exact: true }).click();
    await control.locator('.pask-hint').waitFor({ state: 'visible' });
    assert.match(await control.locator('.pask-hint').innerText(), /No needs a reason/);
    assert.equal(posts.length, 0);
    await control.locator('.pask-input').fill('Not before Eric has read it.');
    await page.screenshot({ path: path.join(shots, `${tag}-2-reason.png`) });
    await control.locator('.pask-input').press('Enter');
    await waitFor(page, () => window.__proofLineMarks.debugState().askAnswers >= 1);
    const ask = await serverAsk(base, created, created.ask1);
    assert.equal(ask.status, 'no');
    assert.deepEqual(ask.answers.map(x => [x.by, x.choice, x.words]), [['guest:Ada', 'no', 'Not before Eric has read it.']]);
    await waitFor(page, id => document.querySelector(`.ProseMirror .pask[data-ask-id="${id}"]`)?.dataset.outcome === 'no', created.ask1);
    await waitFor(page, i => window.__proofLineMarks.myStatus(i) === 'seen', L.Q1);
    assert.equal((await lm(page)).askIssues, 1);
    await page.screenshot({ path: path.join(shots, `${tag}-3-answered-no.png`) });
  });

  await check(`${tag}: the other reader's page shows the answer (poll/broadcast), and an AI harvests ask.answered`, async () => {
    await waitFor(bob.page, id => document.querySelector(`.ProseMirror .pask[data-ask-id="${id}"]`)?.dataset.outcome === 'no', created.ask1, 12000);
    assert.match(await inline(bob.page, created.ask1).locator('.pask-answers').innerText(), /Not before Eric has read it\./);
    const events = await api(base, created, 'GET', '/events/pending?after=0');
    const answered = events.body.events.filter(e => e.type === 'ask.answered');
    assert.equal(answered.length, 1);
    assert.equal(answered[0].data.words, 'Not before Eric has read it.');
    assert.equal(answered[0].actor, 'guest:Ada');
  });

  await check(`${tag}: T opens the inline ask reason field`, async () => {
    await page.evaluate(i => window.__proofReadingWalk.focusLine(i), L.Q2);
    await page.evaluate(() => document.activeElement?.blur());
    const rail = inline(page, created.ask2);
    await rail.scrollIntoViewIfNeeded();
    await rail.waitFor({ state: 'visible' });
    await page.keyboard.press('t');
    await waitFor(page, () => document.activeElement?.classList.contains('pask-input') && !!document.activeElement.closest('.ProseMirror'));
    await page.keyboard.type('After the Friday demo.');
    await page.waitForTimeout(250); // the focus band's 120 ms transition
    await page.screenshot({ path: path.join(shots, `${tag}-4-rail-not-yet.png`) });
    await page.keyboard.press('Enter');
    await waitFor(page, () => window.__proofLineMarks.debugState().askAnswers >= 2);
    const ask = await serverAsk(base, created, created.ask2);
    assert.equal(ask.status, 'snoozed');
    assert.equal(ask.answers[0].words, 'After the Friday demo.');
    await waitFor(page, () => window.__proofLineMarks.debugState().askIssues === 0);
  });

  await check(`${tag}: the asker re-asks; the ask is an Issue again`, async () => {
    const r = await api(base, created, 'POST', `/asks/${created.ask2}/reask`, { by: 'ai:cos' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await waitFor(page, () => window.__proofLineMarks.debugState().askIssues === 1, null, 12000);
  });

  await check(`${tag}: Y answers Yes without accepting proposals passed earlier`, async () => {
    const pending = () => page.evaluate(() => (window.proof.getAllMarks() ?? []).filter(m => m.kind !== 'comment' && (m.data?.status ?? 'pending') === 'pending').map(m => m.id).sort());
    const before = await pending();
    assert.ok(before.length > 0);
    await page.evaluate(i => { document.activeElement?.blur(); window.__proofReadingWalk.focusLine(i); }, L.ALPHA);
    await page.keyboard.press('j');
    await page.evaluate(i => window.__proofReadingWalk.focusLine(i), L.Q2);
    await page.keyboard.press('y');
    await waitFor(page, () => window.__proofLineMarks.debugState().askAnswers >= 3);
    assert.deepEqual(await pending(), before, 'answering an ask accepted an unrelated proposal');
    const ask = await serverAsk(base, created, created.ask2);
    assert.equal(ask.status, 'yes');
    await waitFor(page, () => window.__proofLineMarks.debugState().askIssues === 0);
    await page.screenshot({ path: path.join(shots, `${tag}-5-yes.png`) });
  });

  await check(`${tag}: after answering, the inline control says so and offers Change`, async () => {
    const control = inline(page, created.ask2);
    await waitFor(page, id => document.querySelector(`.ProseMirror .pask[data-ask-id="${id}"]`)?.dataset.outcome === 'yes', created.ask2);
    assert.match(await control.locator('.pask-mine').innerText(), /You answered Yes/);
    await control.locator('.pask-mine .pask-link').click();
    assert.equal(await control.locator('.pask-btn').count(), 3);
  });

  await bob.context.close();
  await a.context.close();
}

async function phone(browser, base, style) {
  const created = await createDoc(base, 'Pat');
  const viewport = { width: 390, height: 844 };
  const tag = `asks-${style}-phone-390x844`;
  const { context, page } = await openDoc(browser, base, created.slug, 'Pat', {
    ...devices['iPhone 13'], viewport, screen: viewport, hasTouch: true, isMobile: true,
  });
  activePage = page;
  await check(`${tag}: the inline control fits the screen with touch-sized buttons; no sideways scroll`, async () => {
    const control = inline(page, created.ask1);
    await control.scrollIntoViewIfNeeded();
    const info = await page.evaluate(id => {
      const c = document.querySelector(`.ProseMirror .pask[data-ask-id="${id}"]`);
      return {
        box: c.getBoundingClientRect().toJSON(),
        buttons: [...c.querySelectorAll('.pask-btn')].map(b => b.getBoundingClientRect().toJSON()),
        sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      };
    }, created.ask1);
    assert.ok(info.sw <= info.cw + 1, `scrollWidth ${info.sw}`);
    assert.ok(info.box.right <= 390 && info.box.left >= 0, `control off screen ${info.box.left}..${info.box.right}`);
    assert.equal(info.buttons.length, 3);
    for (const b of info.buttons) assert.ok(b.height >= 44 && b.width >= 44, `button ${b.width}x${b.height}`);
    await page.screenshot({ path: path.join(shots, `${tag}-1-inline.png`) });
  });
  await check(`${tag}: a tap on Yes answers`, async () => {
    await inline(page, created.ask1).getByRole('button', { name: 'Yes', exact: true }).tap();
    await waitFor(page, () => window.__proofLineMarks.debugState().askAnswers >= 1);
    assert.equal((await serverAsk(base, created, created.ask1)).status, 'yes');
  });
  await check(`${tag}: the inline ask supports Not yet with a reason on phone`, async () => {
    const control = inline(page, created.ask2);
    await control.scrollIntoViewIfNeeded();
    await control.waitFor({ state: 'visible' });
    const heights = await control.locator('.pask-btn').evaluateAll(bs => bs.map(b => b.getBoundingClientRect().height));
    assert.ok(heights.every(h => h >= 44), `sheet buttons ${heights}`);
    await control.getByRole('button', { name: 'Not yet', exact: true }).tap();
    await control.locator('.pask-input').fill('Ask me Monday.');
    await page.screenshot({ path: path.join(shots, `${tag}-2-sheet.png`) });
    await control.locator('.pask-input').press('Enter');
    await waitFor(page, () => window.__proofLineMarks.debugState().askAnswers >= 2);
    const ask = await serverAsk(base, created, created.ask2);
    assert.equal(ask.status, 'snoozed');
    assert.equal(ask.answers[0].words, 'Ask me Monday.');
  });
  await context.close();
}

const browser = await chromium.launch();
try {
  for (const style of styles) {
    const { base, stop } = await startServer(style);
    try {
      for (const width of widths) await desktop(browser, base, style, width);
      await phone(browser, base, style);
    } finally {
      await stop();
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${results.length - failures}/${results.length} asks checks passed`);
process.exit(failures ? 1 : 0);
