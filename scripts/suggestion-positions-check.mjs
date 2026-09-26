#!/usr/bin/env node
import { showWholeAccord } from './review-ui.mjs';
// Browser check: a person's pending suggestions and comments keep pointing at their own words when
// an AI edits text above them, and a page open never drops a stored pending suggestion.
// Regressions for 2026-09-19 (ask-mike worker): after an AI /edit/v2 replace_block grew the intro
// line by 11 characters, Mike's pending insertions below kept their old stored range / startRel /
// endRel, 11 characters off. With a quote that occurs twice ("The mat"), the page then anchored the
// suggestion on the wrong occurrence and Accept changed the wrong words.
// Per review style (playmaker, proof) and per device (desktop 1440, phone 390x844):
//   A. page closed during the AI edit: Mike's suggestions (made in his page on the SECOND "The mat")
//      → page closed → AI /edit/v2 grows the intro → stored positions shift by exactly the growth →
//      a new page decorates the second occurrence → Accept replaces the second occurrence only.
//   B. page open during the AI edit: the same, while Mike's page stays open.
//   C. an AI suggest-replace while no page is open → a page opens → the suggestion is still
//      pending (in /state and on the page) and Accept works.
// Starts an isolated local server per style on the current dist/ build (run `npm run build` first).
// Authorship: Claude Opus 5 (worker fix/suggestion-positions), 2026-09-19, for Mike Wolf's Proof fork.
// Usage: node scripts/suggestion-positions-check.mjs [--style playmaker|proof] [--device desktop|phone] [--shots dir]
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
const styles = arg('--style') ? [arg('--style')] : ['playmaker', 'proof'];
const deviceNames = arg('--device') ? [arg('--device')] : ['desktop', 'phone'];
const shots = arg('--shots') || path.join(root, '.preview');
mkdirSync(shots, { recursive: true });
const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
};
const clientHeaders = { 'X-Proof-Client-Version': '0.34.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };

let failures = 0;
let activePage = null;
async function check(name, fn) {
  let line;
  try { await fn(); line = `PASS ${name}`; }
  catch (error) {
    failures += 1;
    line = `FAIL ${name}: ${error?.message?.split('\n').slice(0, 4).join(' | ')}`;
    await activePage?.screenshot({ path: path.join(shots, `suggestion-positions-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(line);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-suggestion-positions-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      PORT: String(port), COLLAB_EMBEDDED_WS: '1', PROOF_DEFAULT_REVIEW_STYLE: style,
      PROOF_FEEDBACK_ENABLED: '0',
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

const INTRO = 'Intro line.';
const INTRO_GROWN = 'Intro line, 11 longer.'; // +11 characters
const markdown = [
  '# Suggestion positions',
  INTRO,
  'The mat is red.',
  'The mat is blue today.',
  'A closing line for the reader.',
].join('\n\n');

const MARKDOWN_X = [
  '# Suggestion positions',
  INTRO,
  'Step X comes first.',
  'The mat is blue today.',
].join('\n\n');

async function createDoc(base, text = markdown) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown: text, title: 'Suggestion positions check' }),
  });
  assert.equal(response.status, 200);
  return await response.json();
}

/** An agent call; retries while a live page's newest typing is being saved. */
async function agent(base, created, method, route, body) {
  for (let attempt = 0; ; attempt += 1) {
    const r = await fetch(`${base}/api/agent/${created.slug}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-share-token': created.accessToken },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async res => ({ status: res.status, body: await res.json().catch(() => ({})) }));
    if (r.status !== 409 || !['PROJECTION_STALE', 'STALE_BASE', 'LIVE_DOC_UNAVAILABLE'].includes(r.body.code) || attempt > 40) return r;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

async function openDoc(browser, base, created, device) {
  const context = await browser.newContext(DEVICES[device]);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.addInitScript(() => { try { localStorage.setItem('proof-share-viewer-name', 'Mike'); } catch {} });
  const page = await context.newPage();
  activePage = page;
  await page.goto(`${base}/d/${created.slug}?token=${encodeURIComponent(created.ownerSecret ?? created.accessToken)}`);
  await page.getByRole('button', { name: 'Continue anonymously', exact: true }).click({ timeout: 3_000 }).catch(() => {});
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForTimeout(600);
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  page.setDefaultTimeout(8000);
  assert.equal(await page.evaluate(() => window.__proofEditingGuard().writing), false, 'opening proposals must stay in Reading');
  await showWholeAccord(page);
  return { context, page };
}

/** PM range of the nth occurrence of text in the page's document. */
const rangeOf = (page, text, occurrence) => page.evaluate(([t, n]) => {
  const doc = window.__editorView.state.doc;
  const hits = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    let at = node.text.indexOf(t);
    while (at >= 0) { hits.push({ from: pos + at, to: pos + at + t.length }); at = node.text.indexOf(t, at + 1); }
  });
  return hits[n - 1] ?? null;
}, [text, occurrence]);

/** The paragraph text that holds each decorated element of a mark. */
const decoratedParagraphs = (page, id) => page.evaluate(i => [...document.querySelectorAll(`.ProseMirror [data-mark-id="${i}"]`)]
  .map(e => e.closest('p, h1, h2, h3, li')?.textContent ?? ''), id);
const pendingIds = (page) => page.evaluate(() => (window.proof?.getAllMarks?.() ?? []).filter(m => m.data?.status === 'pending').map(m => m.id));
const state = async (base, created) => (await agent(base, created, 'GET', '/state')).body;

/** Mike's page makes a replace on the SECOND "The mat" and a comment on "blue today". */
async function mikeMarks(page) {
  const second = await rangeOf(page, 'The mat', 2);
  assert.ok(second, 'second "The mat" found');
  const replaceId = await page.evaluate(r => window.proof.markSuggestReplace('The mat', 'human:Mike', 'The rug', r)?.id ?? null, second);
  assert.ok(replaceId, 'replace suggestion created in the page');
  const commentRange = await rangeOf(page, 'blue today', 1);
  const commentId = await page.evaluate(r => {
    const view = window.__editorView;
    const sel = view.state.selection.constructor.create(view.state.doc, r.from, r.to);
    view.dispatch(view.state.tr.setSelection(sel));
    return window.proof.markCommentSelection('human:Mike', 'Why blue?')?.id ?? null;
  }, commentRange);
  assert.ok(commentId, 'comment created in the page');
  return { replaceId, commentId, secondFrom: second.from };
}

async function waitStored(base, created, ids) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const st = await state(base, created);
    if (ids.every(id => st.marks?.[id]?.range)) return st;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`marks ${ids} not stored with positions`);
}

async function growIntro(base, created) {
  const st = (await agent(base, created, 'GET', '/snapshot')).body;
  // With a page open the projection can lag (revision null); the mutation base token is exact.
  const precondition = typeof st.revision === 'number' ? { baseRevision: st.revision } : { baseToken: st.mutationBase?.token };
  assert.ok(precondition.baseRevision !== undefined || precondition.baseToken, `snapshot: ${JSON.stringify(st).slice(0, 200)}`);
  // /edit/v2 numbers blocks by position: b1 is the heading, b2 the intro line.
  const ref = 'b2';
  const r = await agent(base, created, 'POST', '/edit/v2', {
    by: 'ai:claude', ...precondition,
    operations: [{ op: 'replace_block', ref, block: { markdown: INTRO_GROWN } }],
  });
  assert.ok(r.status === 200 || r.status === 202, `/edit/v2 -> ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
}

async function assertAcceptHitsSecond(page, base, created, replaceId, tag) {
  assert.ok((await pendingIds(page)).includes(replaceId), 'replace is pending on the page');
  assert.equal(await page.evaluate(i => window.proof.markAccept(i), replaceId), true, 'accept returns true');
  const deadline = Date.now() + 10_000;
  let visible = '';
  while (Date.now() < deadline) {
    visible = (await state(base, created)).content ?? '';
    if (/The rug/.test(visible)) break;
    await new Promise(r => setTimeout(r, 200));
  }
  const text = await page.evaluate(() => document.querySelector('.ProseMirror')?.innerText ?? '');
  assert.ok(/The mat is red\./.test(text), `first "The mat" untouched on the page: ${JSON.stringify(text)}`);
  assert.ok(/The rug is blue today\./.test(text), `second became "The rug" on the page: ${JSON.stringify(text)}`);
  assert.ok(/The mat is red\./.test(visible) && /The rug is blue today\./.test(visible), `stored text: ${JSON.stringify(visible)}`);
  await page.screenshot({ path: path.join(shots, `${tag}-accepted.png`) });
}

async function run(browser, base, style, device) {
  // ---------------------------------------------------------------- A. page closed during the edit
  {
    const tag = `suggestion-positions-${style}-${device}-closed`;
    const created = await createDoc(base);
    let { context, page } = await openDoc(browser, base, created, device);
    let ids;
    let before;
    await check(`${tag}: Mike's replace (second "The mat") and comment are stored with positions`, async () => {
      ids = await mikeMarks(page);
      before = await waitStored(base, created, [ids.replaceId, ids.commentId]);
      assert.equal(before.marks[ids.replaceId].range.from, ids.secondFrom);
    });
    await page.waitForTimeout(500);
    await context.close();
    await check(`${tag}: an AI edit above shifts the stored positions by exactly the growth`, async () => {
      await growIntro(base, created);
      const after = await state(base, created);
      for (const id of [ids.replaceId, ids.commentId]) {
        const b = before.marks[id];
        const a = after.marks[id];
        assert.equal(a.range.from - b.range.from, 11, `${id} range.from ${b.range.from} -> ${a.range.from}`);
        assert.equal(a.range.to - b.range.to, 11, `${id} range.to`);
        if (b.startRel) assert.equal(Number(a.startRel.slice(5)) - Number(b.startRel.slice(5)), 11, `${id} startRel`);
      }
    });
    ({ context, page } = await openDoc(browser, base, created, device));
    await check(`${tag}: a new page decorates the second "The mat" and the comment's words`, async () => {
      await page.waitForFunction(i => (window.proof?.getAllMarks?.() ?? []).some(m => m.id === i), ids.replaceId, { timeout: 10_000 });
      const paras = await decoratedParagraphs(page, ids.replaceId);
      assert.ok(paras.length > 0 && paras.every(p => p.startsWith('The mat') && p.includes('is blue today')),`replace decorated in ${JSON.stringify(paras)}`);
      const commentParas = await decoratedParagraphs(page, ids.commentId);
      assert.ok(commentParas.length > 0 && commentParas.every(p => p.includes('blue today')), `comment decorated in ${JSON.stringify(commentParas)}`);
      await page.screenshot({ path: path.join(shots, `${tag}-reopened.png`) });
    });
    await check(`${tag}: Accept replaces the second occurrence only`, async () => {
      await assertAcceptHitsSecond(page, base, created, ids.replaceId, tag);
    });
    await context.close();
  }

  // ---------------------------------------------------------------- B. page open during the edit
  {
    const tag = `suggestion-positions-${style}-${device}-open`;
    const created = await createDoc(base);
    const { context, page } = await openDoc(browser, base, created, device);
    let ids;
    let before;
    await check(`${tag}: Mike's marks stored; the AI edits above while his page is open`, async () => {
      ids = await mikeMarks(page);
      before = await waitStored(base, created, [ids.replaceId, ids.commentId]);
      await growIntro(base, created);
      await page.waitForFunction(t => (document.querySelector('.ProseMirror')?.innerText ?? '').includes(t), INTRO_GROWN, { timeout: 10_000 });
      await page.waitForTimeout(800);
    });
    await check(`${tag}: the page keeps both marks on their words and the stored positions follow`, async () => {
      const paras = await decoratedParagraphs(page, ids.replaceId);
      assert.ok(paras.length > 0 && paras.every(p => p.startsWith('The mat') && p.includes('is blue today')), `replace decorated in ${JSON.stringify(paras)}`);
      const deadline = Date.now() + 8_000;
      let a;
      while (Date.now() < deadline) {
        a = (await state(base, created)).marks?.[ids.replaceId];
        if (a?.range?.from === before.marks[ids.replaceId].range.from + 11) break;
        await new Promise(r => setTimeout(r, 200));
      }
      assert.equal(a?.range?.from, before.marks[ids.replaceId].range.from + 11, `stored ${JSON.stringify(a?.range)}`);
    });
    await check(`${tag}: Accept replaces the second occurrence only`, async () => {
      await assertAcceptHitsSecond(page, base, created, ids.replaceId, tag);
    });
    await context.close();
  }

  // ---------------------------------------------------- D. an AI insertion whose quote occurs twice
  // An insertion made through the API has no inline anchor in the text; the page places it from its
  // stored positions, falling back to its quote ("X") only when those are stale. Before the fix the
  // stale fallback landed on the earlier "X" and Reject deleted the wrong letter.
  {
    const tag = `suggestion-positions-${style}-${device}-api-insert`;
    const created = await createDoc(base, MARKDOWN_X);
    let markId;
    let before;
    await check(`${tag}: an AI insertion " X" below an earlier "X" is stored; the AI then edits above`, async () => {
      const r = await agent(base, created, 'POST', '/marks/suggest-insert', { quote: 'blue today', content: ' X', by: 'ai:claude' });
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
      markId = r.body.markId;
      before = (await state(base, created)).marks[markId];
      assert.ok(before?.range, `stored with a range: ${JSON.stringify(before)}`);
      await growIntro(base, created);
      const after = (await state(base, created)).marks[markId];
      assert.equal(after.range.from - before.range.from, 11, `range ${JSON.stringify(before.range)} to ${JSON.stringify(after.range)}`);
    });
    const { context, page } = await openDoc(browser, base, created, device);
    await check(`${tag}: the page decorates the inserted "X", not the earlier one`, async () => {
      await page.waitForFunction(i => (window.proof?.getAllMarks?.() ?? []).some(m => m.id === i), markId, { timeout: 10_000 });
      const paras = await decoratedParagraphs(page, markId);
      assert.ok(paras.length > 0 && paras.every(p => p.includes('blue today')), `insert decorated in ${JSON.stringify(paras)}`);
      await page.screenshot({ path: path.join(shots, `${tag}-reopened.png`) });
    });
    await check(`${tag}: Reject removes the inserted "X" and keeps "Step X"`, async () => {
      assert.equal(await page.evaluate(i => window.proof.markReject(i), markId), true);
      await page.waitForFunction(() => /blue today\./.test(document.querySelector('.ProseMirror')?.innerText ?? ''), null, { timeout: 8_000 });
      const text = await page.evaluate(() => document.querySelector('.ProseMirror')?.innerText ?? '');
      assert.ok(/Step X comes first\./.test(text), `the earlier X survives: ${JSON.stringify(text)}`);
      assert.ok(!/today X/.test(text), `the inserted X is gone: ${JSON.stringify(text)}`);
    });
    await context.close();
  }

  // ---------------------------------------------------------------- C. AI suggestion, no page open
  {
    const tag = `suggestion-positions-${style}-${device}-nopage`;
    const created = await createDoc(base);
    // A first page open and close gives the document persisted collaborative state.
    let { context, page } = await openDoc(browser, base, created, device);
    await context.close();
    let markId;
    await check(`${tag}: an AI suggest-replace with no page open is stored pending`, async () => {
      const r = await agent(base, created, 'POST', '/marks/suggest-replace', { quote: 'closing line', content: 'final line', by: 'ai:claude' });
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
      markId = r.body.markId;
      assert.equal((await state(base, created)).marks[markId]?.status, 'pending');
    });
    ({ context, page } = await openDoc(browser, base, created, device));
    await check(`${tag}: after a page opens it is still pending (state and page) and Accept works`, async () => {
      await page.waitForFunction(i => (window.proof?.getAllMarks?.() ?? []).some(m => m.id === i && m.data?.status === 'pending'), markId, { timeout: 10_000 });
      await page.waitForTimeout(800);
      assert.equal((await state(base, created)).marks[markId]?.status, 'pending', 'still pending in /state after the page opened');
      assert.equal(await page.evaluate(i => window.proof.markAccept(i), markId), true);
      await page.waitForFunction(() => /final line/.test(document.querySelector('.ProseMirror')?.innerText ?? ''), null, { timeout: 8_000 });
      await page.screenshot({ path: path.join(shots, `${tag}-accepted.png`) });
    });
    await context.close();
  }
}

const browser = await chromium.launch({ headless: true });
try {
  for (const style of styles) {
    const { base, stop } = await startServer(style);
    try {
      for (const device of deviceNames) await run(browser, base, style, device);
    } finally { await stop(); }
  }
} finally {
  await browser.close();
}
console.log(failures ? `suggestion-positions-check: ${failures} FAILED` : 'suggestion-positions-check: all passed');
process.exit(failures ? 1 : 0);
