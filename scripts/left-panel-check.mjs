#!/usr/bin/env node
// ac-2vs: local browser verification, both styles at 1280/1440/390. Reviewer runs Chromium.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
import { assertSinglePanel, assertMarkKeysInactive, assertPassageActions, assertPanelToggle } from './left-panel-assertions.mjs';
import { hoverChangesNothing } from './usability-s1-assertions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const arg = key => { const i = process.argv.indexOf(key); return i < 0 ? null : process.argv[i + 1]; };
const shots = arg('--shots') ?? path.join(root, '.preview');
mkdirSync(shots, { recursive: true });
const styles = arg('--style') ? [arg('--style')] : ['proof', 'playmaker'];
const headers = { 'Content-Type': 'application/json', 'X-Proof-Client-Version': '0.31.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
const markdown = '# Left panel check\n\nThe launch date is Monday.\n\nThe team needs a clear explanation of the proposed change.\n\n## Context\n\nThe original words stay readable while the reader considers the proposal.';

async function startServer(style) {
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'accord-left-panel-'));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    PORT: String(port), COLLAB_EMBEDDED_WS: '1', PROOF_DEFAULT_REVIEW_STYLE: style,
    PROOF_LIBRARY_ENABLED: '1', DATABASE_PATH: path.join(temp, 'test.db'), SNAPSHOT_DIR: path.join(temp, 'snapshots') };
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: root, env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited; rmSync(temp, { recursive: true, force: true }); };
  for (let i = 0; i < 150; i++) {
    if ((await fetch(`${base}/health`).catch(() => null))?.ok) {
      const cli = (...args) => {
        const result = spawnSync(process.execPath, ['--import', 'tsx', 'server/library/cli.ts', ...args], { cwd: root, env, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
      };
      cli('add-member', '--name', 'Ada', '--email', 'ada@example.test');
      return { base, cli, stop };
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  await stop(); throw new Error('local server did not start');
}
async function ready(page) {
  await page.waitForFunction(() => window.proof?.collabIsSynced && window.__proofLineMarks?.debugState().loaded && window.__proofReadingWalk?.debugState().ready && window.__proofChat?.debugState().loaded, null, { timeout: 30000 });
  for (const button of await page.locator('.proof-share-welcome-toast button').all()) await button.click();
}
async function run(browser, server, style, width) {
  const phone = width <= 700;
  const viewport = { width, height: phone ? 844 : 900 };
  const context = await browser.newContext(phone ? { ...devices['iPhone 13'], viewport, screen: viewport } : { viewport });
  await context.route('**/*', route => new URL(route.request().url()).origin === server.base ? route.continue() : route.abort());
  const page = await context.newPage();
  const tag = `left-panel-${style}-${width}`;
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(server.cli('signin-link', '--email', 'ada@example.test', '--origin', server.base, '--hours', '1'));
    await page.waitForURL(url => url.pathname === '/');
    const created = await page.evaluate(async ({ markdown, headers }) => {
      const r = await fetch('/library/api/documents', { method: 'POST', headers, body: JSON.stringify({ title: 'A local Accord with a readable title', markdown }) });
      if (!r.ok) throw new Error(await r.text()); return r.json();
    }, { markdown, headers });
    const slug = created.slug;
    await page.goto(`${server.base}/d/${slug}`); await ready(page);
    // A real suggestion, posted through a local test agent key.
    const key = await page.evaluate(async ({ slug, headers }) => {
      const r = await fetch(`/api/documents/${slug}/agent-keys`, { method: 'POST', headers, body: JSON.stringify({ label: 'Reviewer', runtime: 'Local browser fixture' }) });
      if (!r.ok) throw new Error(await r.text()); return (await r.json()).token;
    }, { slug, headers });
    const response = await fetch(`${server.base}/api/agent/${slug}/marks/suggest-replace`, { method: 'POST', headers: { ...headers, 'x-share-token': key }, body: JSON.stringify({ quote: 'Monday', content: 'Tuesday', why: 'The team needs another day to review.' }) });
    assert.ok(response.ok, await response.text());
    await page.waitForFunction(() => window.__proofLineMarks.needsYouLines().includes(1));
    await assertSinglePanel(page);
    if (phone) {
      assert.equal(await page.locator('.prw-left.prw-sheet-open').count(), 0, 'phone panel should start closed');
      await page.locator('.prw-strip-review').tap();
    }
    await page.locator('.anv-accords .prw-doc[aria-current="page"]').waitFor();
    assert.match(await page.locator('.anv-accords .prw-doc[aria-current="page"]').innerText(), /open now/);
    assert.equal(await page.locator('.anv-accords .prw-doc[aria-current="page"]').getAttribute('href'), `/d/${slug}`);
    assert.equal(await page.locator('.anv-accords .prw-all').getAttribute('href'), '/');
    assert.equal(await page.locator('.anv-accords summary').textContent(), 'Accords');
    await page.screenshot({ path: path.join(shots, `${tag}-panel.png`) });
    // Disclosure and tab choices survive an actual reload.
    await page.locator('.anv-accords summary').click();
    await page.locator('#anv-tab-outline').click();
    await page.reload(); await ready(page);
    assert.equal(await page.locator('.anv-accords').evaluate(n => n.open), false);
    assert.equal(await page.locator('#anv-tab-outline').getAttribute('aria-selected'), 'true');
    if (phone && !(await page.locator('.prw-left.prw-sheet-open').count())) await page.locator('.prw-strip-review').tap();
    await page.locator('.anv-accords summary').click();
    await assertPanelToggle(page);
    await page.locator('#anv-tab-room').click();
    const input = page.locator('#anv-pane-room .pch-input');
    await input.fill(`Room message ${tag}`); await input.press('Enter');
    await page.locator('#anv-pane-room .pch-text').filter({ hasText: `Room message ${tag}` }).waitFor();
    const chat = await fetch(`${server.base}/api/agent/${slug}/chat`, { headers: { 'x-share-token': key } });
    assert.match(await chat.text(), new RegExp(`Room message ${tag}`));
    await page.screenshot({ path: path.join(shots, `${tag}-room.png`) });
    // Explicit chat opens the left panel after closure; unread mentions follow the Room tab.
    await page.locator('.prw-left .prw-collapse').click();
    const mention = await fetch(`${server.base}/api/agent/${slug}/chat`, { method: 'POST', headers: { ...headers, 'x-share-token': key }, body: JSON.stringify({ text: '@Ada Please check the Room.', mentions: ['human:ada@example.test'] }) });
    assert.ok(mention.ok, await mention.text());
    await page.waitForFunction(() => !document.querySelector('#anv-tab-room .amg-badge')?.hidden);
    await page.evaluate(() => window.__proofChat.open(true));
    await input.waitFor({ state: 'visible' });
    assert.equal(await page.locator('#anv-tab-room').getAttribute('aria-selected'), 'true');
    await page.locator('.prw-left .prw-collapse').click();
    // Real click/tap selects a passage; hover and A/R cannot retarget it or write marks.
    const passage = page.locator('.ProseMirror p').filter({ hasText: 'The launch date is' }).first();
    if (phone) await passage.tap(); else await passage.click();
    await page.waitForFunction(() => document.querySelector('.accord-passage-actions')?.dataset.line === '1');
    await assertPassageActions(page); await assertMarkKeysInactive(page);
    if (!phone) await hoverChangesNothing(page, 2);
    await page.locator('.accord-passage-actions .plm-suggest').click();
    const draft = page.getByRole('textbox', { name: 'Proposed passage text' });
    await draft.waitFor();
    const actionBox = await page.locator('.accord-passage-actions').boundingBox();
    await draft.fill('The launch date is Wednesday.');
    assert.deepEqual(await page.locator('.accord-passage-actions').boundingBox(), actionBox, 'typing moved the action strip');
    await page.screenshot({ path: path.join(shots, `${tag}-draft.png`) });
    await page.locator('.accord-draft').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.locator('.accord-passage-actions .plm-discuss').click();
    const thread = page.locator('.anv-detail .amg-thread-text-input');
    await thread.fill(`Discussion ${tag}`);
    await page.locator('.amg-thread-send').click();
    await page.locator('.anv-detail .amg-thread-text').filter({ hasText: `Discussion ${tag}` }).waitFor();
    await page.locator('.prw-left .prw-collapse').click();
    const dot = page.locator('.plm-needs-you[data-line="1"]'); await dot.click();
    assert.equal(await page.locator('#anv-tab-issues').getAttribute('aria-selected'), 'true');
    await page.locator('.anv-detail .prw-accept').first().waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => window.__proofReadingWalk.cursorLine()), 1);
    assert.deepEqual(errors, []);
    console.log(`PASS ${tag}: panels, library, persistence, Room, actions and retired marks`);
  } catch (error) {
    await page.screenshot({ path: path.join(shots, `${tag}-FAIL.png`) }).catch(() => {}); throw error;
  } finally { await context.close(); }
}
const browser = await chromium.launch();
try {
  for (const style of styles) {
    const server = await startServer(style);
    try { for (const width of [1280, 1440, 390]) await run(browser, server, style, width); }
    finally { await server.stop(); }
  }
} finally { await browser.close(); }
