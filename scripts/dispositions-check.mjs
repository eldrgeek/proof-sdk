#!/usr/bin/env node
// Browser check: on a multi-party Accord (src/shared/dispositions.ts), the page's accept and
// reject are a promote and a cut sent to the server. The page never applies them itself; the text
// changes only once every participant has promoted the change.
// Mike, 2026-10-24: "Each participant has its own view of the draft and of their accord."
// Starts an isolated local server on the current dist/ build (run `npm run build` first) with a
// temp SQLite database, in both review styles. Exit code 0 only if every check passes.
// Usage: node scripts/dispositions-check.mjs [--style playmaker|proof]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { showWholeAccord } from './review-ui.mjs';
import { keepBottomChat } from './keep-bottom-chat.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const styleArg = process.argv.indexOf('--style');
const styles = styleArg > 0 ? [process.argv[styleArg + 1]] : ['playmaker', 'proof'];
const clientHeaders = { 'Content-Type': 'application/json', 'X-Proof-Client-Version': '0.34.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };

let failures = 0;
async function check(name, fn) {
  let line;
  try { await fn(); line = `PASS ${name}`; }
  catch (error) { failures += 1; line = `FAIL ${name}: ${error?.message?.split('\n')[0]}`; }
  console.log(line);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-dispositions-check-'));
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

const markdown = `# Dispositions check

Launch moves to September 30 for every customer.

The milestone review happens on September 23 in Boston.

Budget line stays the same for the quarter.`;

async function call(base, route, body, token) {
  const response = await fetch(`${base}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...clientHeaders, ...(token ? { 'x-share-token': token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await response.json().catch(() => ({}));
  assert.ok(response.ok, `${route} -> ${response.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

async function poll(fn, message, timeout = 8000) {
  const end = Date.now() + timeout;
  do { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } while (Date.now() < end);
  assert.fail(message);
}

async function openDoc(browser, base, slug, query = '') {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => { localStorage.setItem('proof-share-viewer-name', 'Mike'); });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(`${base}/d/${slug}${query}`);
  await page.getByRole('button', { name: /Continue anonymously/i }).click({ timeout: 3_000 }).catch(() => {});
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForTimeout(800);
  await showWholeAccord(page);
  return { context, page };
}

const editorText = page => page.evaluate(() => document.querySelector('.ProseMirror')?.innerText ?? '');
const pendingIds = page => page.evaluate(() => (window.proof?.getAllMarks?.() ?? [])
  .filter(m => ['insert', 'delete', 'replace'].includes(m.kind) && (m.data?.status ?? 'pending') === 'pending').map(m => ({ id: m.id, by: m.by })));

async function run(browser, base, style) {
  const tag = `dispositions-${style}`;
  const created = await call(base, '/api/documents', { markdown, title: 'Dispositions check', role: 'editor' });
  const { slug, ownerSecret } = created;
  const agent = (route, body) => call(base, `/api/agent/${slug}${route}`, body, ownerSecret);
  await agent('/dispositions/settings', { multiParty: true, by: 'human:Mike' });
  // Two AIs propose, so three participants decide: ai:claude, ai:gemini and the page's person.
  const first = await agent('/marks/suggest-replace', { quote: 'September 30', content: 'October 14', by: 'ai:claude', why: 'Vendor slipped' });
  await agent('/marks/suggest-replace', { quote: 'September 23', content: 'October 7', by: 'ai:gemini', why: 'Follows the launch' });
  const launchId = first.markId ?? first.suggestion?.markId;
  assert.ok(launchId, JSON.stringify(first).slice(0, 200));
  const { context, page } = await openDoc(browser, base, slug);
  try {
    await page.waitForFunction(() => (window.proof?.getAllMarks?.() ?? []).filter(m => m.data?.status === 'pending').length >= 2, null, { timeout: 10_000 });

    await check(`${tag}: the page knows this Accord is multi-party`, async () => {
      const report = await call(base, `/api/agent/${slug}/dispositions`, undefined, ownerSecret);
      assert.equal(report.multiParty, true);
    });

    await check(`${tag}: the count line shows this person's draft before they decide`, async () => {
      const line = page.locator('[data-accord-dispositions]');
      await line.waitFor({ state: 'visible', timeout: 15_000 });
      assert.match(await line.textContent(), /^2 in your draft/);
    });

    await check(`${tag}: accepting on the page promotes the change but does not apply it while others are still deciding`, async () => {
      assert.equal(await page.evaluate(id => window.proof.markAccept(id), launchId), true);
      await poll(async () => {
        const report = await call(base, `/api/agent/${slug}/dispositions`, undefined, ownerSecret);
        const view = report.proposals.find(p => p.markId === launchId);
        return view && view.promotedBy.length === 2 && view.openFor.includes('ai:gemini');
      }, 'the page accept was not recorded as a promote');
      await page.waitForTimeout(600);
      assert.match(await editorText(page), /September 30/, 'the page applied the change itself');
      assert.ok((await pendingIds(page)).some(m => m.id === launchId), 'the change is no longer pending on the page');
      await page.locator('#proof-disposition-notice').waitFor({ state: 'visible', timeout: 5000 });
      assert.match(await page.locator('#proof-disposition-notice').innerText(), /stays open until everyone agrees/);
    });

    await check(`${tag}: the last participant's promote applies the change, and the page shows it`, async () => {
      await agent('/marks/accept', { markId: launchId, by: 'ai:gemini' });
      await poll(async () => /October 14/.test(await editorText(page)), 'the page never showed the common change');
      assert.ok(!(await pendingIds(page)).some(m => m.id === launchId), 'the change is still pending on the page');
    });

    await check(`${tag}: rejecting on the page is a cut, not a veto: the proposal stays open`, async () => {
      const review = (await pendingIds(page)).find(m => m.by === 'ai:gemini');
      assert.ok(review, 'no pending proposal from ai:gemini');
      assert.equal(await page.evaluate(id => window.proof.markReject(id), review.id), true);
      await poll(async () => {
        const report = await call(base, `/api/agent/${slug}/dispositions`, undefined, ownerSecret);
        return report.whereWeDiffer.includes(review.id);
      }, 'the page reject was not recorded as a cut');
      await page.waitForTimeout(600);
      assert.match(await editorText(page), /September 23/, 'the original wording should still stand');
      assert.ok((await pendingIds(page)).some(m => m.id === review.id), 'the cut proposal disappeared from the page');
      await page.evaluate(() => window.proof?.refreshShareMultiParty?.());
      await poll(async () => /^Nothing left in your draft · 1 where we differ$/.test(await page.locator('[data-accord-dispositions]').textContent().catch(() => '')), 'the count line never showed an empty draft and where we differ', 15_000);
      // The older count agrees: what this person cut no longer waits on them, but it waits on others.
      await poll(async () => /^0 open for you · 1 waiting on others/.test(await page.locator('.aov-header-text').textContent().catch(() => '')), `"open for you" still counts the cut change: ${await page.locator('.aov-header-text').textContent().catch(() => '')}`, 15_000);
      await page.screenshot({ path: `.preview/dispositions-count-line-${style}.png` });
    });

    await check(`${tag}: the pile switch shows this person's piles, and each pile lists only its changes`, async () => {
      const piles = page.locator('[data-accord-piles]');
      await piles.waitFor({ state: 'visible', timeout: 10_000 });
      const label = id => page.locator(`[data-accord-pile="${id}"]`).textContent();
      assert.equal(await label('draft'), 'Draft 0');
      assert.equal(await label('cutting-room'), 'Cutting room 1');
      assert.equal(await label('differ'), 'Where we differ 1');
      await page.locator('[data-accord-pile="draft"]').click();
      await poll(async () => (await page.locator('.anv-empty').textContent()) === 'Nothing in your draft.' && await page.locator('.anv-empty').isVisible(), 'Draft should be empty');
      await page.locator('[data-accord-pile="cutting-room"]').click();
      await poll(async () => (await page.locator('[data-accord-review-list] .anv-issue[data-settled="false"]').count()) === 1, 'Cutting room should list the one cut change');
      assert.match(await page.locator('[data-accord-review-list] .anv-issue[data-settled="false"]').first().innerText(), /September 23/);
      assert.equal(await page.locator('[data-accord-pile="cutting-room"]').getAttribute('aria-pressed'), 'true');
      // Stance on the row: the AI that proposed it has it in its accord; this person cut it.
      const stance = page.locator('[data-accord-review-list] .anv-issue[data-settled="false"] [data-accord-stance]').first();
      await poll(async () => /^In accord: .+ · Cut: Mike/.test(await stance.textContent().catch(() => '') ?? ''), `no stance on the cut row: ${await stance.textContent().catch(() => '')}`);
      await page.screenshot({ path: `.preview/dispositions-piles-${style}.png` });
      await page.locator('[data-accord-pile="cutting-room"]').click();
      assert.equal(await page.locator('[data-accord-pile="cutting-room"]').getAttribute('aria-pressed'), 'false');
    });

    await check(`${tag}: U on the cut change sends it back to this person's draft`, async () => {
      const review = (await pendingIds(page)).find(m => m.by === 'ai:gemini');
      assert.ok(review, 'no pending proposal from ai:gemini');
      // The reader's own path: All open, pick the cut change's row, press U.
      await page.locator('[data-accord-review-scope="all-open"]').click();
      const row = page.locator('[data-accord-review-list] .anv-issue[data-settled="false"]', { hasText: 'September 23' }).first();
      await row.click();
      await page.keyboard.press('u');
      await poll(async () => {
        const report = await call(base, `/api/agent/${slug}/dispositions`, undefined, ownerSecret);
        const view = report.proposals.find(p => p.proposer === 'ai:gemini');
        return view && view.cutBy.length === 0 && !report.whereWeDiffer.includes(view.markId);
      }, 'U did not send the cut change back to the draft');
      await poll(async () => /^1 in your draft$/.test(await page.locator('[data-accord-dispositions]').textContent().catch(() => '')), 'the count line never showed the change back in the draft', 15_000);
      await page.locator('#proof-disposition-notice').waitFor({ state: 'visible', timeout: 5000 });
      assert.match(await page.locator('#proof-disposition-notice').innerText(), /Back in your draft/);
    });

    await check(`${tag}: when the page's promote is the last one, the page applies the change as it always has`, async () => {
      const made = await agent('/marks/suggest-replace', { quote: 'the same', content: 'flat', by: 'ai:claude', why: 'Clearer' });
      const id = made.markId ?? made.suggestion?.markId;
      await agent('/marks/accept', { markId: id, by: 'ai:gemini' });
      await poll(async () => (await pendingIds(page)).some(m => m.id === id), 'the new proposal never reached the page');
      assert.match(await editorText(page), /stays the same/);
      assert.equal(await page.evaluate(i => window.proof.markAccept(i), id), true);
      await poll(async () => /stays flat/.test(await editorText(page)), 'the agreed change was not applied on the page');
      await poll(async () => {
        const state = await call(base, `/api/agent/${slug}/state`, undefined, ownerSecret);
        return /stays flat/.test(state.markdown);
      }, 'the agreed change never reached the server');
    });
  } finally {
    await context.close();
  }

  // The Owner's special act, from the page opened with the owner credential.
  const ruling = await agent('/marks/suggest-replace', { quote: 'in Boston', content: 'in Denver', by: 'ai:claude', why: 'Venue moved' });
  const rulingId = ruling.markId ?? ruling.suggestion?.markId;
  await agent('/marks/reject', { markId: rulingId, by: 'ai:gemini' });
  const owner = await openDoc(browser, base, slug, `?token=${encodeURIComponent(ownerSecret)}`);
  try {
    await check(`${tag}: a reader argues for or against the selected change, and everyone's arguments show on it`, async () => {
      await owner.page.waitForFunction(() => (window.proof?.getAllMarks?.() ?? []).some(m => m.data?.status === 'pending'), null, { timeout: 10_000 });
      await agent('/dispositions/argue', { markId: rulingId, stance: 'for', text: 'The venue moved last week.', by: 'ai:claude' });
      await owner.page.evaluate(() => window.proof?.refreshShareMultiParty?.());
      await owner.page.locator('[data-accord-review-scope="all-open"]').click();
      await owner.page.locator('[data-accord-review-list] .anv-issue[data-settled="false"]', { hasText: 'Boston' }).first().click();
      const tools = owner.page.locator('[data-accord-argue-tools]');
      await tools.waitFor({ state: 'visible', timeout: 10_000 });
      // This line carries two changes; the box starts on the one in dispute, and names both.
      assert.equal(await owner.page.locator('[data-accord-argue-target]').count(), 2);
      assert.equal(await owner.page.locator(`[data-accord-argue-target="${rulingId}"]`).getAttribute('aria-pressed'), 'true');
      assert.match(await owner.page.locator(`[data-accord-argue-target="${rulingId}"]`).textContent(), /in Boston" → "in Denver/);
      await poll(async () => (await owner.page.locator('[data-accord-argument]').allTextContents()).some(t => /^For, .+: The venue moved last week\.$/.test(t)), 'the AI\'s argument is not listed');
      await owner.page.locator('[data-accord-argue="against"]').click();
      const box = owner.page.locator('[data-accord-argue-text]');
      await box.fill('Boston is already booked.');
      await box.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
      await poll(async () => {
        const report = await call(base, `/api/agent/${slug}/dispositions`, undefined, ownerSecret);
        return report.arguments.some(a => a.markId === rulingId && a.stance === 'against' && a.text === 'Boston is already booked.');
      }, 'the page argument never reached the server');
      await poll(async () => (await owner.page.locator('[data-accord-argument]').count()) === 2, 'the page does not list both arguments');
      const count = owner.page.locator('[data-accord-review-list] .anv-issue[data-settled="false"]', { hasText: 'Boston' }).first().locator('[data-accord-arguments]');
      await poll(async () => (await count.textContent().catch(() => '')) === 'Arguments: 1 for · 1 against', `no argument count on the row: ${await count.textContent().catch(() => '')}`);
      assert.match(await editorText(owner.page), /in Boston/, 'arguing changed the text');
      await owner.page.screenshot({ path: `.preview/dispositions-arguments-${style}.png` });
    });
    await check(`${tag}: the Owner overrules a disagreement from the page, and the dissent is recorded`, async () => {
      await owner.page.waitForFunction(() => (window.proof?.getAllMarks?.() ?? []).some(m => m.data?.status === 'pending'), null, { timeout: 10_000 });
      await owner.page.locator('[data-accord-review-scope="all-open"]').click();
      await owner.page.locator('[data-accord-review-list] .anv-issue[data-settled="false"]', { hasText: 'Boston' }).first().click();
      const accept = owner.page.locator('[data-accord-overrule="common"]');
      await accept.waitFor({ state: 'visible', timeout: 10_000 });
      await owner.page.screenshot({ path: `.preview/dispositions-overrule-${style}.png` });
      await accept.click();
      await poll(async () => /in Denver/.test(await editorText(owner.page)), 'the overrule was not applied on the page');
      await poll(async () => /in Denver/.test((await call(base, `/api/agent/${slug}/state`, undefined, ownerSecret)).markdown), 'the overrule never reached the server');
      const events = await call(base, `/api/agent/${slug}/events/pending?after=0`, undefined, ownerSecret);
      const ruled = events.events.find(e => e.type === 'disposition.overruled' && e.data.markId === rulingId);
      assert.equal(events.events.filter(e => e.type === 'disposition.overruled').length, 1, 'the overrule settled more than the one disagreement');
      assert.ok(ruled, 'no disposition.overruled event');
      assert.ok(ruled.data.dissent.some(d => d.actor === 'ai:gemini' && d.pile === 'cutting-room'), JSON.stringify(ruled.data.dissent));
      const after = await call(base, `/api/agent/${slug}/dispositions`, undefined, ownerSecret);
      assert.equal(after.arguments.filter(a => a.markId === rulingId).length, 0, 'arguments on a settled change did not retire');
      assert.ok(after.retiredArguments >= 2, String(after.retiredArguments));
      assert.equal(events.events.filter(e => e.type === 'disposition.argued' && e.data.markId === rulingId).length, 2, 'retired arguments are not in the log');
    });
    await check(`${tag}: a reader who is not the Owner never sees the overrule`, async () => {
      const guest = await openDoc(browser, base, slug);
      try {
        await guest.page.waitForTimeout(1500);
        assert.equal(await guest.page.locator('[data-accord-overrule]:visible').count(), 0);
      } finally { await guest.context.close(); }
    });
  } finally {
    await owner.context.close();
  }
}

const browser = await chromium.launch({ headless: true });
keepBottomChat(browser);
try {
  for (const style of styles) {
    const { base, stop } = await startServer(style);
    try { await run(browser, base, style); } finally { await stop(); }
  }
} finally {
  await browser.close();
}
console.log(failures ? `dispositions-check: ${failures} FAILED` : 'dispositions-check: all passed');
process.exit(failures ? 1 : 0);
