#!/usr/bin/env node
import { showWholeAccord } from './review-ui.mjs';
// Browser check for Proof Documents Step B7: chat in the right rail (desktop) and a bottom sheet
// (phone). Two signed-in people (Mike, Eric) and an AI (an agent key minted in Mike's page, talking
// through the agent API) chat about a document: line pointers, @mentions with the unread badge,
// a suggestion proposed from chat, Explain mirrored into chat, the reading keys not firing while
// typing, persistence after a reload, and no change to the document text from chat.
// Authorship: Claude Opus 5 (worker proof-chat), 2026-09-19, in the style of do-check.mjs.
// Starts an isolated local server on the current dist/ build (run `npm run build` first).
// Screenshots go to .preview/ (or --shots <dir>). Exit code 0 only if every check passes.
// Usage: node scripts/chat-check.mjs [--style playmaker|proof] [--shots dir]
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

const clientHeaders = { 'X-Proof-Client-Version': '0.33.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
const MIKE_EMAIL = 'mw@mike-wolf.com';
const ERIC_EMAIL = 'eric@example.test';
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `chat-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-chat-check-'));
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
// Lines: 0 Title | 1 Intro | 2 Budget | 3 Middle | 4 Last
const markdown = ['# Chat check', para('Intro'), 'The budget is fixed at ten thousand dollars for the first year.', para('Middle'), para('Last')].join('\n\n');
const L = { INTRO: 1, BUDGET: 2, MIDDLE: 3, LAST: 4 };

const waitFor = (page, fn, argument, timeout = 12000) => page.waitForFunction(fn, argument, { timeout, polling: 200 });

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
  await page.waitForFunction(() => window.__proofChat?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForTimeout(300);
  page.setDefaultTimeout(6000);
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  await showWholeAccord(page);
}

const agentCall = (base, slug, KEY, method, route, body) => fetch(`${base}/api/agent/${slug}${route}`, {
  method, headers: KEY, body: body === undefined ? undefined : JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json() }));
const chatState = page => page.evaluate(() => window.__proofChat.debugState());
// Accord round 2, stage D: talk about a line belongs to the document, so the Room folds it behind
// one control. Everything below still tests what it always tested — it just opens that control
// first, the way a person would.
const showLineTalk = async page => { if (!(await chatState(page)).visible) await page.locator('.prw-chat-bottom .pch-toggle').click(); };
const docText = page => page.evaluate(() => window.proof.getMarkdownSnapshot()?.content);

async function run(browser, style) {
  const { base, stop, cli } = await startServer(style);
  try {
    cli('add-member', '--name', 'Mike Wolf', '--email', MIKE_EMAIL);
    cli('add-member', '--name', 'Eric', '--email', ERIC_EMAIL);
    const tag = `chat-${style}-desktop-1440`;
    const mikeCtx = await newContext(browser, base, { viewport: { width: 1440, height: 900 } });
    const mike = await signIn(mikeCtx, cli, base, MIKE_EMAIL);
    activePage = mike;
    const created = await mike.evaluate(async md => {
      const r = await fetch('/library/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Chat check', markdown: md }) });
      return { status: r.status, body: await r.json() };
    }, markdown);
    assert.ok(created.status === 200 || created.status === 201, JSON.stringify(created));
    const slug = created.body.slug;
    await mike.goto(`${base}/d/${slug}`);
    await mike.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 20_000 });
    const key = await mike.evaluate(async ({ s, h }) => {
      const r = await fetch(`/api/documents/${s}/agent-keys`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify({ label: 'Claude COS', runtime: 'Claude Opus 5 (Anthropic)' }) });
      return { status: r.status, body: await r.json() };
    }, { s: slug, h: clientHeaders });
    assert.equal(key.status, 201, JSON.stringify(key));
    const KEY = { 'Content-Type': 'application/json', ...clientHeaders, 'x-share-token': key.body.token };
    await openDoc(mike, base, slug);
    const mdBefore = await docText(mike);

    const ericCtx = await newContext(browser, base, { viewport: { width: 1280, height: 900 } });
    const eric = await signIn(ericCtx, cli, base, ERIC_EMAIL);
    await openDoc(eric, base, slug);

    // Accord layout stage 3 (decision 6): the chat is the Margin's Room tab (the Line tab is the line's thread).
    await check(`${tag}: the composer is permanent and the empty conversation expands upward`, async () => {
      assert.equal(await mike.locator('.prw-chat-bottom .pch-input').isVisible(), true);
      assert.match(await mike.locator('.prw-chat-bottom .pch-empty').innerText(), /No messages yet/);
      for (const page of [mike, eric]) await page.locator('.prw-chat-bottom .pch-toggle').click();
      assert.equal((await chatState(mike)).visible, true);
      assert.equal(await mike.locator('.amg-tab').count(), 0);
    });

    await check(`${tag}: typing in the composer never fires the reading keys (A R J K Y N T E 1-9)`, async () => {
      await mike.evaluate(i => window.__proofReadingWalk.focusLine(i), L.BUDGET);
      const before = { walk: await mike.evaluate(() => window.__proofReadingWalk.debugState()), marks: (await mike.evaluate(() => window.__proofLineMarks.debugState())).marks.length };
      await mike.locator('.prw-chat-bottom .pch-input').click();
      await mike.keyboard.type('arjkyntE19 ARJK');
      await mike.waitForTimeout(400);
      const after = { walk: await mike.evaluate(() => window.__proofReadingWalk.debugState()), marks: (await mike.evaluate(() => window.__proofLineMarks.debugState())).marks.length };
      assert.equal(after.walk.focus, L.BUDGET, 'J/K moved the focus');
      assert.equal(after.walk.explained.length, before.walk.explained.length, 'E asked for an explanation');
      assert.equal(after.marks, before.marks, 'A marked the line');
      assert.equal(await mike.locator('.prw-chat-bottom .pch-input').inputValue(), 'arjkyntE19 ARJK');
      await mike.locator('.prw-chat-bottom .pch-input').fill('');
      assert.equal(await mike.locator('.prw-right .plm-reason:visible').count(), 0, 'R opened the reason field');
    });

    await check(`${tag}: 📍 attaches the focus line; @ suggests the AI; Enter sends; the message points at the line`, async () => {
      await mike.locator('.prw-chat-bottom .pch-pin').click();
      assert.equal(await mike.locator('.prw-chat-bottom .pch-chip').count(), 1);
      assert.equal(await mike.locator('.prw-chat-bottom .pch-chip').getAttribute('data-line'), String(L.BUDGET));
      const input = mike.locator('.prw-chat-bottom .pch-input');
      await input.click();
      await mike.keyboard.type('Is this right, @Cla');
      const option = mike.locator('.prw-chat-bottom .pch-suggest-item').first();
      await option.waitFor({ state: 'visible' });
      assert.match(await option.innerText(), /Claude COS/);
      await mike.screenshot({ path: path.join(shots, `${tag}-1-mention.png`) });
      await mike.keyboard.press('Enter');
      assert.equal(await input.inputValue(), 'Is this right, @Claude COS ');
      await mike.keyboard.type('**check** the `budget`?');
      await mike.keyboard.press('Enter');
      await waitFor(mike, () => window.__proofChat.debugState().sent.length === 1);
      const s = await chatState(mike);
      assert.equal(s.messages.length, 1);
      assert.deepEqual(s.messages[0].mentions, ['ai:claude-cos']);
      assert.equal(s.messages[0].by, 'human:mw@mike-wolf.com');
      await showLineTalk(mike);
      const msg = mike.locator('.prw-chat-bottom .pch-msg').first();
      assert.equal(await msg.locator('.pch-text strong').innerText(), 'check');
      assert.equal(await msg.locator('.pch-text code').innerText(), 'budget');
      assert.match(await msg.locator('.pch-who').innerText(), /Mike Wolf\s*✓/);
      assert.equal(await msg.locator('.pch-pointer').getAttribute('data-line'), String(L.BUDGET));
      await waitFor(mike, l => document.querySelector(`.plm-chat-bubble[data-line="${l}"]`)?.textContent === '1', L.BUDGET);
    });

    await check(`${tag}: Eric's page receives it; the pointer chip moves Eric's focus line to the line`, async () => {
      await waitFor(eric, () => window.__proofChat.debugState().messages.length === 1, null, 15000);
      await eric.evaluate(() => window.__proofReadingWalk.focusLine(0));
      await showLineTalk(eric);
      await eric.locator('.prw-chat-bottom .pch-msg .pch-pointer').first().click();
      await waitFor(eric, l => window.__proofReadingWalk.debugState().focus === l, L.BUDGET);
      assert.match(await eric.locator('.prw-chat-bottom .pch-msg .pch-who').first().innerText(), /Mike Wolf/);
    });

    await check(`${tag}: Eric replies (Shift+Enter is a new line); the reply quotes Mike's message`, async () => {
      await showLineTalk(eric);
      await eric.locator('.prw-chat-bottom .pch-msg .pch-reply').first().click();
      await eric.keyboard.type('Looks right to me.');
      await eric.keyboard.press('Shift+Enter');
      await eric.keyboard.type('Second line.');
      await eric.keyboard.press('Enter');
      await waitFor(eric, () => window.__proofChat.debugState().sent.length === 1);
      const s = await chatState(eric);
      const reply = s.messages.find(m => m.by === 'human:eric@example.test');
      assert.equal(reply.text, 'Looks right to me.\nSecond line.');
      assert.equal(reply.replyTo, s.messages[0].id);
      assert.match(await eric.locator('.prw-chat-bottom .pch-msg').last().locator('.pch-quote').innerText(), /Mike Wolf: Is this right/);
    });

    await check(`${tag}: chat has not changed the document's text (everyone's page)`, async () => {
      assert.equal(await docText(mike), mdBefore);
      assert.equal(await docText(eric), mdBefore);
    });

    let markId = '';
    await check(`${tag}: an AI answers through the agent API with a suggestion: a card in chat and a real suggestion in the text`, async () => {
      const r = await agentCall(base, slug, KEY, 'POST', '/chat', {
        text: '@Mike Wolf the sheet says twelve thousand.', replyTo: (await chatState(mike)).messages[0].id,
        suggestion: { kind: 'replace', quote: 'ten thousand', content: 'twelve thousand', why: 'The finance sheet was updated on Monday.' },
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      markId = r.body.message.suggestion.markId;
      await waitFor(mike, () => window.__proofChat.debugState().messages.length === 3, null, 15000);
      const card = mike.locator('.prw-chat-bottom .pch-proposal');
      await card.waitFor({ state: 'visible' });
      assert.match(await card.innerText(), /Claude COS proposed a change/);
      assert.match(await card.innerText(), /ten thousand\s*→\s*twelve thousand/);
      assert.match(await card.innerText(), /Why: The finance sheet was updated on Monday\./);
      await waitFor(mike, id => !!document.querySelector(`.ProseMirror [data-mark-id="${id}"]`), markId, 15000);
      const ai = mike.locator('.prw-chat-bottom .pch-msg').last();
      assert.match(await ai.locator('.pch-who').innerText(), /Claude COS\s*AI/);
      await mike.evaluate(() => window.__proofReadingWalk.focusLine(0));
      await card.locator('.pch-view').click();
      await waitFor(mike, l => window.__proofReadingWalk.debugState().focus === l, L.BUDGET);
      await mike.screenshot({ path: path.join(shots, `${tag}-2-proposal.png`) });
    });

    await check(`${tag}: Mike's chat was open, so the @mention is read at once (no badge)`, async () => {
      await waitFor(mike, () => window.__proofChat.debugState().unread === 0);
      assert.equal(await mike.locator('.prw-right .prw-collapse .prw-badge').count(), 0);
    });

    await check(`${tag}: a collapsed conversation keeps its mention badge until expanded`, async () => {
      await eric.locator('.prw-chat-bottom .pch-toggle').click();
      assert.equal((await chatState(eric)).collapsed, true);
      const r = await agentCall(base, slug, KEY, 'POST', '/chat', { text: '@Eric can you confirm the Middle paragraph?', lines: [{ lineIndex: 3 }] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.message.mentions, ['human:eric@example.test']);
      await waitFor(eric, () => window.__proofChat.debugState().unread === 1, null, 15000);
      assert.equal(await eric.locator('.prw-chat-bottom .pch-count').isVisible(), true);
      await eric.screenshot({ path: path.join(shots, `${tag}-3-badge.png`) });
      await eric.locator('.prw-chat-bottom .pch-toggle').click();
      await waitFor(eric, () => window.__proofChat.debugState().unread === 0);
      assert.equal(await eric.locator('.prw-chat-bottom .pch-count').getAttribute('data-unread'), 'false');
    });

    await check(`${tag}: E on the focus line posts the Explain thread and mirrors it into the chat`, async () => {
      await mike.evaluate(i => window.__proofReadingWalk.focusLine(i), L.LAST);
      await mike.evaluate(() => document.activeElement?.blur?.());
      await mike.locator('body').press('e');
      await waitFor(mike, () => window.__proofChat.debugState().messages.some(m => m.kind === 'explain'), null, 15000);
      const s = await chatState(mike);
      const ex = s.messages.find(m => m.kind === 'explain');
      assert.ok(ex.commentMarkId, 'linked to the comment thread');
      assert.deepEqual(ex.mentions, ['ai:claude-cos']);
      const item = mike.locator(`.prw-chat-bottom .pch-msg[data-id="${ex.id}"]`);
      await item.waitFor({ state: 'visible' });
      assert.match(await item.locator('.pch-kind').innerText(), /Explain/);
      // The thread still works: the AI answers on it, and the chat shows the reply.
      const reply = await agentCall(base, slug, KEY, 'POST', '/marks/reply', { markId: ex.commentMarkId, by: 'ai:claude-cos', text: 'It closes the document.' });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      await waitFor(mike, id => /It closes the document/.test(document.querySelector(`.prw-chat-bottom .pch-msg[data-id="${id}"] .pch-thread`)?.textContent ?? ''), ex.id, 15000);
    });

    await check(`${tag}: a speech bubble in the margin opens the chat at the newest message about that line`, async () => {
      const bubble = mike.locator(`.plm-chat-bubble[data-line="${L.BUDGET}"]`);
      await waitFor(mike, l => Number(document.querySelector(`.plm-chat-bubble[data-line="${l}"]`)?.textContent) >= 2, L.BUDGET);
      await bubble.click();
      await waitFor(mike, l => window.__proofReadingWalk.debugState().focus === l, L.BUDGET);
      await mike.screenshot({ path: path.join(shots, `${tag}-4-bubbles.png`) });
    });

    await check(`${tag}: after a reload the messages are all there, in order`, async () => {
      const before = (await chatState(mike)).messages.map(m => m.id);
      await openDoc(mike, base, slug);
      const after = (await chatState(mike)).messages.map(m => m.id);
      assert.deepEqual(after, before);
      // The bottom conversation keeps the reader's collapsed choice across a reload (2026-09-24);
      // open it before counting what it shows.
      if (await mike.locator('.prw-chat-bottom[data-expanded="true"]').count() === 0) await mike.locator('.prw-chat-bottom .pch-toggle').click();
      assert.equal(await mike.locator('.prw-chat-bottom .pch-msg').count(), before.length);
      assert.equal(await mike.locator('.prw-chat-bottom .pch-proposal').count(), 1);
    });
    await ericCtx.close();
    await mikeCtx.close();

    // ---------------------------------------------------------------- phone 390
    const ptag = `chat-${style}-phone-390x844`;
    const viewport = { width: 390, height: 844 };
    const phoneCtx = await newContext(browser, base, { ...devices['iPhone 13'], viewport, screen: viewport, hasTouch: true, isMobile: true });
    const phone = await signIn(phoneCtx, cli, base, MIKE_EMAIL);
    activePage = phone;
    await openDoc(phone, base, slug);
    await check(`${ptag}: an @mention while the sheet is closed shows on the ⋯ button and in its menu`, async () => {
      const r = await agentCall(base, slug, KEY, 'POST', '/chat', { text: '@Mike Wolf one more thing on the Intro.', lines: [{ lineIndex: 1 }] });
      assert.equal(r.status, 200);
      await waitFor(phone, () => document.querySelector('#share-banner .share-pill-overflow .pch-overflow-badge')?.textContent === '1', null, 15000);
      await phone.locator('#share-banner .share-pill-overflow').tap();
      const item = phone.locator('.proof-share-overflow-menu [role="menuitem"]', { hasText: 'Room' });
      await item.waitFor({ state: 'visible' });
      assert.match(await item.innerText(), /1 @you/);
      await phone.screenshot({ path: path.join(shots, `${ptag}-1-menu.png`) });
      await item.tap();
    });
    // Accord layout stage 3 (decision 11): the same chat expands upward above its permanent composer (Mike, 2026-09-24).
    await check(`${ptag}: Room expands the bottom conversation: it fits the screen, with touch-sized controls; the mention is read`, async () => {
      const sheet = phone.locator('.prw-chat-bottom[data-expanded="true"]');
      await sheet.waitFor({ state: 'visible' });
      await waitFor(phone, () => window.__proofChat.debugState().unread === 0);
      const info = await phone.evaluate(() => {
        const r = (sel) => document.querySelector(sel)?.getBoundingClientRect().toJSON();
        return {
          sheet: r('.prw-chat-bottom[data-expanded="true"]'), input: r('.prw-chat-bottom .pch-input'), send: r('.prw-chat-bottom .pch-send'), pin: r('.prw-chat-bottom .pch-pin'),
          sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, font: getComputedStyle(document.querySelector('.prw-chat-bottom .pch-input')).fontSize,
          expanded: document.querySelector('.prw-chat-bottom')?.dataset.expanded,
        };
      });
      assert.ok(info.sw <= info.cw + 1, `no sideways scroll ${info.sw}`);
      assert.ok(Math.abs(info.sheet.bottom - 844) <= 1 && info.sheet.left >= 0 && info.sheet.right <= 390, JSON.stringify(info.sheet));
      assert.ok(info.input.bottom <= 844 && info.send.bottom <= 844, 'the composer is on screen');
      assert.ok(info.send.height >= 44 && info.pin.height >= 44, `touch targets ${info.send.height} ${info.pin.height}`);
      assert.equal(info.font, '16px', 'no zoom-on-focus on iOS');
      assert.equal(info.expanded, 'true');
      assert.equal(await phone.locator('#share-banner .share-pill-overflow .pch-overflow-badge').count(), 0);
      await phone.screenshot({ path: path.join(shots, `${ptag}-2-sheet.png`) });
    });
    await check(`${ptag}: with the keyboard up, the composer stays above it (--proof-keyboard-offset)`, async () => {
      await phone.evaluate(() => document.documentElement.style.setProperty('--proof-keyboard-offset', '300px'));
      const r = await phone.evaluate(() => ({ sheet: document.querySelector('.prw-chat-bottom[data-expanded="true"]').getBoundingClientRect().toJSON(), input: document.querySelector('.prw-chat-bottom .pch-input').getBoundingClientRect().toJSON() }));
      assert.ok(Math.abs(r.sheet.bottom - (844 - 300)) <= 1, `sheet bottom ${r.sheet.bottom}`);
      assert.ok(r.input.bottom <= 844 - 300 && r.input.top >= 0, `input ${JSON.stringify(r.input)}`);
      await phone.screenshot({ path: path.join(shots, `${ptag}-3-keyboard.png`) });
      await phone.evaluate(() => document.documentElement.style.setProperty('--proof-keyboard-offset', '0px'));
    });
    await check(`${ptag}: a message sent from the phone; tapping a pointer closes the sheet and moves the focus line`, async () => {
      await phone.locator('.prw-chat-bottom .pch-input').tap();
      await phone.keyboard.type('Sent from my phone');
      await phone.locator('.prw-chat-bottom .pch-send').tap();
      await waitFor(phone, () => window.__proofChat.debugState().sent.length === 1);
      await showLineTalk(phone);
      const pointer = phone.locator(`.prw-chat-bottom .pch-pointer[data-line="${L.MIDDLE}"]`).first();
      await pointer.scrollIntoViewIfNeeded();
      await pointer.tap();
      await waitFor(phone, () => !document.querySelector('.prw-chat-bottom[data-expanded="true"]'));
      await waitFor(phone, l => window.__proofReadingWalk.debugState().focus === l, L.MIDDLE);
      await phone.screenshot({ path: path.join(shots, `${ptag}-4-pointer.png`) });
    });
    await check(`${ptag}: the margin speech bubbles are there on the phone too`, async () => {
      await waitFor(phone, l => !!document.querySelector(`.plm-chat-bubble[data-line="${l}"]`), L.BUDGET);
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
console.log(`\n${results.length - failures}/${results.length} chat checks passed`);
process.exit(failures ? 1 : 0);
