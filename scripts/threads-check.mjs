#!/usr/bin/env node
// Accord round 2, stage D — threads live in the document, not the chat.
//
// Behaviour this check drives, in a real browser, against a real server:
//   T with no selection starts a thread on the cursor line; T with a selection takes the selection
//   as its subject; the closing condition is required and is shown at the thread's head; a
//   discussion and a proposal resolve by their own rules; deleting the anchored text DETACHES the
//   thread and says so (it never deletes an unresolved disagreement); a resolved thread folds to a
//   mark and the mark reopens the history; the `?` clarify gesture produces the same object; the
//   comments and suggestions already on a document still read and still resolve; and the Room no
//   longer carries talk about a line.
//
// Starts an isolated local server on the current dist/ build (run `npm run build` first) with a
// temp SQLite database and drives Chromium at 1440 (desktop) and 390 (phone).
// Authorship: Mike Wolf (rulings), built by Claude Opus 5 (worker accord-threads), 2026-09-22.
// Usage: node scripts/threads-check.mjs [--style playmaker|proof] [--shots dir]
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
const styles = arg('--style') ? [arg('--style')] : ['proof'];

const clientHeaders = { 'X-Proof-Client-Version': '0.31.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${String(error?.message ?? error).split('\n').slice(0, 4).join(' | ')}`);
    await activePage?.screenshot({ path: path.join(shots, `threads-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-threads-check-'));
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

const CLAIM = 'Revenue doubled in the second quarter of this year.';
const EXPORTS = 'Every customer asked for the export button first.';
const SHIP = 'We will ship the export button in October.';
const DOOMED = 'This sentence exists only so that it can be deleted while a thread is open on it.';
const INTRO = 'The opening line of the document gives the page some body to scroll.';
const markdown = [
  '# Threads check',              // 0
  INTRO,                          // 1
  CLAIM,                          // 2
  EXPORTS,                        // 3
  SHIP,                           // 4
  DOOMED,                         // 5
  'The team met on Tuesday to review the plan and agreed to look again.', // 6
  'The last line sits near the bottom of the document.', // 7
].join('\n\n');
const L = { HEAD: 0, INTRO: 1, CLAIM: 2, EXPORTS: 3, SHIP: 4, DOOMED: 5, NOTES: 6, LAST: 7 };

async function createDoc(base) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown, title: 'Threads check' }),
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

/** Deletes a whole block the way an AI would (this is what must detach a thread, not delete it). */
async function deleteBlock(base, created, needle) {
  const snap = await agent(base, created, '/snapshot', undefined, 'GET');
  const block = (snap.blocks ?? []).find(b => String(b.markdown ?? b.text ?? '').includes(needle));
  assert.ok(block, `block not found for "${needle}" in ${JSON.stringify((snap.blocks ?? []).map(b => b.ref))}`);
  const body = { by: 'ai:check', operations: [{ op: 'delete_block', ref: block.ref }] };
  if (snap.revision !== undefined && snap.revision !== null) body.baseRevision = snap.revision;
  if (snap.mutationBase) body.baseToken = typeof snap.mutationBase === 'string' ? snap.mutationBase : snap.mutationBase.token;
  assert.ok(body.baseRevision !== undefined || body.baseToken, `no base on the snapshot: ${JSON.stringify({ revision: snap.revision, mutationBase: snap.mutationBase, warning: snap.warning })}`);
  await agent(base, created, '/edit/v2', body);
}

async function openDoc(browser, base, slug, name, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
  await context.route('**/*', route => new URL(route.request().url()).origin === base || route.request().url().startsWith('blob:') ? route.continue() : route.abort());
  await context.addInitScript(viewer => { try { localStorage.setItem('proof-share-viewer-name', viewer); } catch {} }, name);
  const page = await context.newPage();
  await page.goto(`${base}/d/${slug}`);
  await page.getByRole('button', { name: 'Continue anonymously', exact: true }).click({ timeout: 6000 }).catch(() => {});
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForFunction(() => window.__proofReadingWalk?.debugState().ready === true, null, { timeout: 10_000 });
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  page.setDefaultTimeout(6000);
  return { context, page };
}

const waitFor = (page, fn, arg, timeout = 9000) => page.waitForFunction(fn, arg, { timeout, polling: 100 });
const panel = page => page.evaluate(() => window.__proofReadingWalk.threadsPanel().debugState());
const threads = page => page.evaluate(() => window.__proofLineMarks.allThreads().map(v => ({
  id: v.thread.id, asks: v.thread.asks, kind: v.thread.kind, status: v.thread.status, source: v.thread.source,
  text: v.thread.text, line: v.lineIndex, detached: v.detached, changed: v.changed, replies: v.thread.replies.length,
})));

/** Moves the cursor to a line (the same hook every other check uses). */
async function focusLine(page, line) {
  await page.evaluate(i => window.__proofReadingWalk.focusLine(i), line);
  await waitFor(page, i => window.__proofReadingWalk.debugState().focus === i, line);
}

/** Selects text the way a person does: press at the first character, drag to the last. */
async function dragSelect(page, needle) {
  const box = await page.evaluate(text => {
    const walker = document.createTreeWalker(document.querySelector('.ProseMirror'), NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const i = node.data.indexOf(text);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(node, i); range.setEnd(node, i + 1); const a = range.getBoundingClientRect();
      range.setStart(node, i + text.length - 1); range.setEnd(node, i + text.length); const b = range.getBoundingClientRect();
      return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 };
    }
    return null;
  }, needle);
  assert.ok(box, `text not found: ${needle}`);
  await page.mouse.move(box.x1, box.y1);
  await page.mouse.down();
  await page.mouse.move((box.x1 + box.x2) / 2, box.y2, { steps: 5 });
  await page.mouse.move(box.x2, box.y2, { steps: 5 });
  await page.mouse.up();
}

/** Starts a thread through the composer the way a person does. */
async function startThread(page, { text, asks }) {
  const composer = page.locator('.amg-thread-new');
  await composer.waitFor({ state: 'visible' });
  if (asks) await composer.locator(`.amg-thread-ask[data-asks="${asks}"] input`).check();
  await composer.locator('.amg-thread-text-input').fill(text);
  await composer.locator('.amg-thread-send').click();
  await waitFor(page, ([t, a]) => window.__proofLineMarks.allThreads().some(v => v.thread.text === t && v.thread.asks === a), [text, asks], 20000);
}

async function desktop(browser, base, style) {
  const created = await createDoc(base);
  const tag = `threads-${style}-1440`;
  const { context, page } = await openDoc(browser, base, created.slug, 'Ada', { viewport: { width: 1440, height: 900 } });
  activePage = page;
  const rail = page.locator('.prw-right');

  await check(`${tag}: T with no selection starts a thread on the cursor line, and the closing condition is offered`, async () => {
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await focusLine(page, L.CLAIM);
    await page.keyboard.press('t');
    const composer = page.locator('.amg-thread-new');
    await composer.waitFor({ state: 'visible' });
    const subject = await composer.locator('.amg-thread-subject').innerText();
    assert.match(subject, new RegExp(`On line ${L.CLAIM + 1}`), `the subject is the cursor line (${subject})`);
    assert.match(subject, /Revenue doubled/, 'and it quotes that line');
    // "Every thread states what would close it": all five choices, "just a comment" among them.
    const choices = await composer.locator('.amg-thread-ask .amg-thread-ask-label').allInnerTexts();
    assert.deepEqual(choices, ['accept or reject', 'pick one wording', 'yes or no', 'someone answer this', 'just a comment']);
    const checked = await composer.locator('.amg-thread-ask input:checked').getAttribute('value');
    assert.equal(checked, 'answer', 'a discussion defaults to "someone answer this"');
    await page.screenshot({ path: path.join(shots, `${tag}-1-composer.png`) });
    await startThread(page, { text: 'Is this the right figure for Q2?', asks: 'yes-no' });
    const all = await threads(page);
    const made = all.find(t => t.text === 'Is this the right figure for Q2?');
    assert.ok(made, 'the thread exists');
    assert.equal(made.line, L.CLAIM, 'anchored to the cursor line');
    assert.equal(made.asks, 'yes-no');
    assert.equal(made.kind, 'discussion');
    assert.equal(made.status, 'open');
  });

  await check(`${tag}: the closing condition is shown at the thread's head, and the head says why it is open`, async () => {
    const card = rail.locator('.amg-thread').first();
    await card.waitFor({ state: 'visible' });
    assert.equal(await card.locator('.amg-thread-closes').innerText(), 'Closes when: yes or no');
    assert.equal(await card.getAttribute('data-asks'), 'yes-no');
    const state = await panel(page);
    assert.equal(state.threads[0].closes, 'yes or no');
    await page.screenshot({ path: path.join(shots, `${tag}-2-thread.png`) });
  });

  await check(`${tag}: the server refuses a thread that cannot say what would close it`, async () => {
    const r = await fetch(`${base}/api/documents/${created.slug}/threads`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
      body: JSON.stringify({ by: 'human:ada@example.com', anchor: [], asks: '' }),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.code, 'CLOSING_CONDITION_REQUIRED', JSON.stringify(body));
  });

  await check(`${tag}: T with a selection takes the selection as the subject of the thread`, async () => {
    await dragSelect(page, 'export button first');
    // With a selection the keyboard is in the text, where a letter types: the selection bar's
    // "Thread" is the way in (T is the key on the cursor line).
    await page.locator('.mark-selection-bar').getByRole('button', { name: 'Thread', exact: true }).click();
    const composer = page.locator('.amg-thread-new');
    await composer.waitFor({ state: 'visible' });
    assert.match(await composer.locator('.amg-thread-subject').innerText(), /export button first/, 'the selection is the subject');
    await startThread(page, { text: 'Which customers, exactly?', asks: 'answer' });
    const made = (await threads(page)).find(t => t.text === 'Which customers, exactly?');
    assert.equal(made.line, L.EXPORTS, 'anchored to the selected line');
    assert.equal(made.asks, 'answer');
  });

  await check(`${tag}: a discussion resolves by agreement; a proposal resolves by accept or reject`, async () => {
    await focusLine(page, L.EXPORTS);
    const card = rail.locator('.amg-thread[data-asks="answer"]').first();
    await card.waitFor({ state: 'visible' });
    assert.deepEqual(await card.locator('.amg-thread-resolve').allInnerTexts(), ['Agreed', 'Withdraw'], 'a discussion agrees or is withdrawn');
    // A suggestion already in the document is a proposal, and it accepts or rejects.
    await page.evaluate(([quote, content]) => window.proof.markSuggestReplace(quote, 'ai:check', content), [SHIP, 'We will ship the export button in November.']);
    await waitFor(page, () => window.__proofLineMarks.allThreads().some(v => v.thread.kind === 'proposal'));
    await focusLine(page, L.SHIP);
    const proposal = rail.locator('.amg-thread[data-kind="proposal"]').first();
    await proposal.waitFor({ state: 'visible' });
    assert.equal(await proposal.locator('.amg-thread-closes').innerText(), 'Closes when: accept or reject');
    assert.deepEqual(await proposal.locator('.amg-thread-resolve').allInnerTexts(), ['Accept', 'Reject'], 'a proposal accepts or rejects');
    await page.screenshot({ path: path.join(shots, `${tag}-3-proposal.png`) });
  });

  await check(`${tag}: a suggestion and a comment already on the document read as threads and still resolve`, async () => {
    const all = await threads(page);
    const fromSuggestion = all.find(t => t.source === 'suggestion');
    assert.ok(fromSuggestion, 'the suggestion reads as a thread');
    assert.equal(fromSuggestion.asks, 'accept-reject');
    // A plain comment made the old way (no thread row) reads as "just a comment".
    const made = await page.evaluate(q => window.proof.markComment(q, 'ai:check', 'An older comment, made before threads existed.')?.id ?? null, INTRO);
    assert.ok(made, 'markComment made no mark');
    await waitFor(page, () => window.__proofLineMarks.allThreads().some(v => v.thread.source === 'comment'), null, 20000)
      .catch(async () => { throw new Error(`no thread read from the plain comment; threads: ${JSON.stringify(await threads(page))}`); });
    const legacy = (await threads(page)).find(t => t.source === 'comment');
    assert.equal(legacy.asks, 'comment', 'it asks "just a comment": it is not a disagreement');
    assert.equal(legacy.status, 'open');
    // ...and a comment made the old way still resolves, on the same one rule as every thread.
    await focusLine(page, L.INTRO);
    const card = rail.locator('.amg-thread[data-source="comment"]').first();
    await card.waitFor({ state: 'visible' });
    assert.deepEqual(await card.locator('.amg-thread-resolve').allInnerTexts(), ['Done'], 'a comment is done, not agreed: it was never a disagreement');
    await card.locator('.amg-thread-resolve[data-resolve="resolved"]').click();
    await waitFor(page, () => window.__proofLineMarks.allThreads().some(v => v.thread.source === 'comment' && v.thread.status === 'resolved'), null, 15000)
      .catch(async () => { throw new Error(`the old comment did not resolve; threads: ${JSON.stringify(await threads(page))}`); });
  });

  await check(`${tag}: resolution stays expanded; returning offers history that opens explicitly`, async () => {
    await focusLine(page, L.CLAIM);
    const card = rail.locator('.amg-thread[data-asks="yes-no"]').first();
    await card.waitFor({ state: 'visible' });
    await card.locator('.amg-thread-reply-input').fill('Yes, that is the Q2 figure.');
    await card.locator('.amg-thread-reply-send').click();
    await waitFor(page, () => window.__proofLineMarks.allThreads().some(v => v.thread.asks === 'yes-no' && v.thread.replies.length === 1), null, 12000);
    await rail.locator('.amg-thread[data-asks="yes-no"] .amg-thread-resolve[data-resolve="resolved"]').first().click();
    await waitFor(page, () => window.__proofLineMarks.allThreads().some(v => v.thread.asks === 'yes-no' && v.thread.status === 'resolved'), null, 12000);
    assert.equal(await rail.locator('.amg-thread[data-asks="yes-no"]').count(), 1, 'resolving collapsed the thread under the reader');
    await focusLine(page, L.NOTES);
    await focusLine(page, L.CLAIM);
    await waitFor(page, () => window.__proofReadingWalk.threadsPanel().debugState().threads.some(t => t.folded), null, 12000);
    const mark = rail.locator('.amg-thread-mark[data-folded="true"]').first();
    await mark.waitFor({ state: 'visible' });
    assert.match(await mark.innerText(), /resolved/, 'the fold leaves a mark that says what happened');
    assert.match(await mark.innerText(), /1 reply/, 'and how much history it holds');
    await page.screenshot({ path: path.join(shots, `${tag}-4-folded.png`) });
    await mark.click();
    const reopened = rail.locator('.amg-thread[data-asks="yes-no"]').first();
    await reopened.waitFor({ state: 'visible' });
    assert.match(await reopened.locator('.amg-thread-replies').innerText(), /Yes, that is the Q2 figure\./, 'the history is back');
    await reopened.locator('.amg-thread-fold').click();
    await mark.waitFor({ state: 'visible' });
  });

  await check(`${tag}: the \`?\` clarify gesture produces the same object — a thread that asks clarify`, async () => {
    await focusLine(page, L.NOTES);
    await page.keyboard.press('e');
    await waitFor(page, () => window.__proofLineMarks.allThreads().some(v => v.thread.asks === 'clarify'), null, 12000);
    const clarify = (await threads(page)).find(t => t.asks === 'clarify');
    assert.ok(clarify, 'it is a thread, not a separate explain object');
    assert.equal(clarify.status, 'open');
    await focusLine(page, L.NOTES);
    const card = rail.locator('.amg-thread[data-asks="clarify"]').first();
    await card.waitFor({ state: 'visible' });
    assert.equal(await card.locator('.amg-thread-closes').innerText(), 'Closes when: an AI answers this');
    // It is never an Issue for the asker, and it never marks the line.
    const why = await card.locator('.amg-thread-why').getAttribute('data-open');
    assert.equal(why, 'false', 'asking is not the asker’s own Issue');
    const mine = await page.evaluate(i => {
      const lm = window.__proofLineMarks;
      return lm.lineState(i)?.marks.get(lm.me().toLowerCase())?.mark.status ?? null;
    }, L.NOTES);
    assert.notEqual(mine, 'rejected', 'asking is never a rejection');
  });

  await check(`${tag}: DELETING the anchored text detaches the thread and says so — it never deletes it`, async () => {
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await focusLine(page, L.DOOMED);
    await page.keyboard.press('t');
    await startThread(page, { text: 'I do not agree with this sentence.', asks: 'yes-no' });
    const before = (await threads(page)).find(t => t.text === 'I do not agree with this sentence.');
    assert.equal(before.detached, false);
    assert.equal(before.line, L.DOOMED);
    await deleteBlock(base, created, DOOMED);
    await waitFor(page, t => {
      const v = window.__proofLineMarks.allThreads().find(x => x.thread.text === t);
      return Boolean(v && v.detached);
    }, 'I do not agree with this sentence.', 25000)
      .catch(async () => { throw new Error(`the thread never detached; threads: ${JSON.stringify(await threads(page))}`); });
    const after = (await threads(page)).find(t => t.text === 'I do not agree with this sentence.');
    assert.equal(after.detached, true, 'it detached');
    assert.equal(after.status, 'open', 'and it is STILL OPEN: a deletion never closes a disagreement');
    assert.notEqual(after.line, null, 'it attached to a surviving line');
    await focusLine(page, after.line);
    const card = page.locator('.prw-right .amg-thread[data-detached="true"]').first();
    await card.waitFor({ state: 'visible' });
    const notice = await card.locator('.amg-thread-detached').innerText();
    assert.match(notice, /the text this was about has changed/, notice);
    assert.match(notice, /deleted while a thread is open on it/, 'and the original is quoted');
    // It is still an Issue for the people it was waiting on (it is not for its own author, who
    // wrote it — that is what threadOpenFor answers, and what the Open list is built on).
    const forOther = await page.evaluate(() => window.__proofLineMarks.openThreadsFor('human:someone-else@example.com'));
    const still = forOther.find(t => t.because.includes('the text this was about has changed'));
    assert.ok(still, `the detached thread is no longer open for anyone: ${JSON.stringify(forOther)}`);
    assert.equal(still.why, 'detached');
    assert.equal(still.detached, true);
    // ...and it is still counted: a deletion cannot make a disagreement vanish from the Issues.
    const counted = await page.evaluate(() => window.__proofLineMarks.issueSummary().issues.some(i => i.type === 'comment' && String(i.excerpt ?? '').includes('deleted while a thread is open')));
    assert.equal(counted, true, 'the detached thread is still an Issue');
    await page.screenshot({ path: path.join(shots, `${tag}-5-detached.png`) });
  });

  await check(`${tag}: the Room keeps only what is about no line; talk about the text is a thread`, async () => {
    const roomOnly = `A message about nobody's line ${Date.now()}`;
    await page.evaluate(() => window.__proofReadingWalk.selectMarginTab('room'));
    const chat = page.locator('.prw-right .pch');
    await chat.waitFor({ state: 'visible' });
    await chat.locator('.pch-input').fill(roomOnly);
    await chat.locator('.pch-send').click();
    await waitFor(page, t => window.__proofChat.debugState().messages.some(m => m.text === t), roomOnly, 12000);
    // ...and a message that points at a line, posted the old way.
    const aboutLine = `This is about the intro line ${Date.now()}`;
    const r = await fetch(`${base}/api/agent/${created.slug}/chat`, {
      method: 'POST', headers: agentHeaders(created.ownerSecret),
      body: JSON.stringify({ by: 'ai:check', text: aboutLine, lines: [{ lineIndex: L.INTRO }] }),
    });
    assert.ok(r.ok, `chat post ${r.status}`);
    await waitFor(page, t => window.__proofChat.debugState().messages.some(m => m.text === t), aboutLine, 15000);
    const state = await page.evaluate(() => window.__proofChat.debugState());
    const byText = Object.fromEntries(state.messages.map(m => [m.text, m.id]));
    assert.ok(state.room.includes(byText[roomOnly]), 'the Room keeps a message about no line');
    assert.ok(!state.room.includes(byText[aboutLine]), 'the Room no longer carries line talk');
    assert.ok(state.lineTalk.includes(byText[aboutLine]), 'that message moved to the document');
    // Nothing is deleted: it is still readable, behind the one control that names it.
    const bar = page.locator('.pch-line-talk');
    await bar.waitFor({ state: 'visible' });
    const toggle = bar.locator('.pch-line-talk-summary');
    assert.match(await toggle.innerText(), /about the text/);
    assert.equal(await page.evaluate(() => window.__proofChat.debugState().lineTalkOpen), false, 'line talk starts folded');
    await toggle.click();
    assert.equal(await page.evaluate(() => window.__proofChat.debugState().lineTalkOpen), true);
    const shown = page.locator('.prw-right .pch-msg.pch-line-talk-msg', { hasText: aboutLine }).first();
    await shown.waitFor({ state: 'visible' });
    assert.ok((await shown.innerText()).includes(aboutLine), 'the message is still readable, in its place in the conversation');
    await page.screenshot({ path: path.join(shots, `${tag}-6-room.png`) });
    await page.evaluate(() => window.__proofReadingWalk.selectMarginTab('line'));
  });

  await check(`${tag}: starting a thread has one Undo, and it takes the thread back`, async () => {
    const before = (await threads(page)).length;
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await focusLine(page, L.NOTES);
    await page.keyboard.press('t');
    await startThread(page, { text: 'A thread started only to be undone.', asks: 'comment' });
    assert.equal((await threads(page)).length, before + 1);
    const undone = await page.evaluate(() => window.__proofLineMarks.undoStack().undo().then(r => r.message));
    assert.match(undone, /Undid: started a thread/, undone);
  });

  await context.close();
}

async function phone(browser, base, style) {
  const created = await createDoc(base);
  const tag = `threads-${style}-390`;
  const { context, page } = await openDoc(browser, base, created.slug, 'Bo', {
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
  });
  activePage = page;

  await check(`${tag}: a thread started on a phone shows its closing condition in the Margin sheet`, async () => {
    await page.evaluate(() => window.__proofReadingWalk.startThreadHere());
    const composer = page.locator('.amg-thread-new');
    await composer.waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(shots, `${tag}-1-composer.png`) });
    await startThread(page, { text: 'Does this still hold?', asks: 'yes-no' });
    const card = page.locator('.amg-thread[data-asks="yes-no"]').first();
    await card.waitFor({ state: 'visible' });
    assert.equal(await card.locator('.amg-thread-closes').innerText(), 'Closes when: yes or no');
    const box = await card.locator('.amg-thread-reply-send').boundingBox();
    assert.ok(box && box.height >= 24, `the reply control is reachable on a phone (${JSON.stringify(box)})`);
    await page.screenshot({ path: path.join(shots, `${tag}-2-thread.png`) });
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
console.log(`\n${results.length - failures}/${results.length} thread checks passed`);
process.exit(failures ? 1 : 0);
