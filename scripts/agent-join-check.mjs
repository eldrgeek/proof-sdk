#!/usr/bin/env node
// ac-220: HTTP AI requests; a real session admits in the page; the AI comments.
// Local temporary fixture only. Run after npm run build. Both styles, desktop 1440.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, openSync, closeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { showReview, showWholeAccord } from './review-ui.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const shots = path.join(root, '.preview');
mkdirSync(shots, { recursive: true });
const styles = process.argv.includes('--style') ? [process.argv[process.argv.indexOf('--style') + 1]] : ['playmaker', 'proof'];
for (const style of styles) assert.ok(['playmaker', 'proof'].includes(style));
const headers = { 'Content-Type': 'application/json', 'X-Proof-Client-Version': '0.33.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
async function start(style) {
  const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const temp = mkdtempSync(path.join(tmpdir(), 'accord-join-browser-'));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    PORT: String(port), DATABASE_PATH: path.join(temp, 'test.db'), SNAPSHOT_DIR: path.join(temp, 'snapshots'),
    PROOF_LIBRARY_ENABLED: '1', PROOF_ENV: 'test', PROOF_DB_ENV_INIT: 'test',
    COLLAB_EMBEDDED_WS: '1', PROOF_DEFAULT_REVIEW_STYLE: style };
  // Seed a local human session directly. No mail, production credentials or auth services.
  const fixture = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    const db = await import('./server/db.ts');
    const auth = await import('./server/library/auth.ts');
    const member = auth.createLibraryMember({ name: 'Mike', email: 'mike@example.test', isOwner: true });
    db.createDocument('join-browser', '# Join check\\n\\nA line to discuss.', {}, 'Join check', 'owner', 'local-fixture-owner');
    db.getDb().prepare('INSERT INTO library_document_meta (slug, created_by_member_id) VALUES (?, ?)').run('join-browser', member.id);
    const link = auth.createLibrarySigninLink({ memberId: member.id, purpose: 'operator', origin: ${JSON.stringify(base)} });
    const session = auth.consumeLibrarySigninToken(new URL(link.link).hash.slice(3), null);
    console.log('FIXTURE:' + JSON.stringify({ name: auth.LIBRARY_SESSION_COOKIE, value: session.sessionId }));
  `], { cwd: root, env, encoding: 'utf8' });
  if (fixture.status !== 0) { rmSync(temp, { recursive: true, force: true }); throw Error(fixture.stderr); }
  const cookie = JSON.parse(fixture.stdout.split('\n').find(line => line.startsWith('FIXTURE:')).slice(8));
  const log = path.join(temp, 'server.log'); const fd = openSync(log, 'w');
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: root, env, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  const stop = async () => {
    child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('exit', resolve));
    rmSync(temp, { recursive: true, force: true });
  };
  for (let i = 0; i < 200; i++) {
    if ((await fetch(`${base}/health`).catch(() => null))?.ok) return { base, cookie, log, stop };
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  const error = readFileSync(log, 'utf8'); await stop(); throw Error(`Server did not start: ${error}`);
}
async function json(base, route, body, extraHeaders = {}) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${route}: HTTP ${response.status}`);
  return response.json();
}
const browser = await chromium.launch({ headless: true });
try {
  for (const style of styles) {
    const local = await start(style);
    let context;
    try {
      context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await context.addCookies([{ ...local.cookie, url: local.base }]);
      await context.route('**/*', route => new URL(route.request().url()).origin === local.base ? route.continue() : route.abort());
      const page = await context.newPage(); const second = await context.newPage();
      const urls = []; const errors = [];
      context.on('request', request => urls.push(request.url()));
      page.on('pageerror', error => errors.push(error.message));
      for (const reader of [page, second]) {
        reader.setDefaultTimeout(15000);
        await reader.goto(`${local.base}/d/join-browser`);
        await reader.waitForFunction(() => window.proof?.collabIsSynced && window.__proofLineMarks?.debugState().loaded);
        await showWholeAccord(reader);
        const welcome = reader.locator('.proof-share-welcome-toast button');
        if (await welcome.count()) await welcome.first().click();
      }
      const request = await json(local.base, '/api/agent/join-browser/join', { name: 'Drew', runtime: 'OpenAI GPT-6' });
      const notice = page.locator('#agent-join-notices .agent-join-row', { hasText: request.code });
      await notice.waitFor({ state: 'visible' });
      await second.locator('#agent-join-notices .agent-join-row', { hasText: request.code }).waitFor({ state: 'visible' });
      assert.match(await notice.innerText(), /Drew \(OpenAI GPT-6\) asks to join/);
      await page.screenshot({ path: path.join(shots, `agent-join-${style}-1440-request.png`) });
      await page.getByRole('button', { name: 'Share', exact: true }).click();
      await page.locator('#share-tab-ais').click();
      const row = page.locator('#share-panel-ais .agent-join-row', { hasText: request.code });
      await row.waitFor({ state: 'visible' });
      await page.screenshot({ path: path.join(shots, `agent-join-${style}-1440-share.png`) });
      await row.getByRole('button', { name: 'Admit', exact: true }).click();
      await row.waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'Close share dialog' }).click();
      await second.locator('#agent-join-notices .agent-join-row').waitFor({ state: 'detached' });
      const admitted = await json(local.base, request.pollUrl, undefined, { 'x-join-token': request.pollToken });
      assert.equal(admitted.status, 'admitted'); assert.ok(admitted.token);
      assert.equal((await json(local.base, request.pollUrl, undefined, { 'x-join-token': request.pollToken })).token, undefined);
      await json(local.base, '/api/agent/join-browser/ops', {
        type: 'comment.add', by: 'ai:drew', quote: 'A line to discuss.', text: 'Drew joined and read the Accord.',
      }, { 'x-share-token': admitted.token });
      await page.waitForFunction(() => window.__proofLineMarks.allThreads().some(view => view.thread.text === 'Drew joined and read the Accord.'));
      await showReview(page);
      await page.evaluate(() => window.__proofReadingWalk.openReviewItem(1));
      const comment = page.locator('.amg-thread', { hasText: 'Drew joined and read the Accord.' });
      await comment.waitFor({ state: 'visible' });
      // The page learns a new key's sponsor on its next marks poll (every 4 s), so wait for it.
      await page.waitForFunction(() => [...document.querySelectorAll('.amg-thread .amg-thread-by')].some(node => node.textContent === 'Drew — added by Mike'), null, { timeout: 10000 })
        .catch(async () => { throw new Error(`thread author reads "${await comment.locator('.amg-thread-by').innerText()}", not "Drew — added by Mike"`); });
      await page.screenshot({ path: path.join(shots, `agent-join-${style}-1440-comment.png`) });
      await page.getByRole('button', { name: 'Share', exact: true }).click();
      await page.locator('#share-tab-ais').click();
      const listed = page.locator('#share-panel-ais .key-row', { hasText: 'Drew' });
      await listed.waitFor({ state: 'visible' });
      assert.match(await listed.innerText(), /Added by Mike/);
      for (const secret of [request.pollToken, admitted.token]) {
        assert.ok(!urls.some(url => url.includes(secret)), 'A secret appeared in a browser URL');
        assert.ok(!(await page.content()).includes(secret), 'A secret appeared in the page');
        assert.ok(!readFileSync(local.log, 'utf8').includes(secret), 'A secret appeared in server logs');
      }
      assert.deepEqual(errors, []);
      console.log(`PASS agent join ${style} 1440: two readers, matching codes, Share admission, one-time delivery, sponsored comment`);
      // Seen live on 2026-09-26 (ac-pb1): the "shared with you" note, shown for 5 s when a page
      // opens, sat over a waiting request's Admit and Refuse buttons. A fresh page (new session, so
      // the note shows) opens while a request waits: the note goes below the notice, and each
      // button is the element under its own centre.
      const waiting = await json(local.base, '/api/agent/join-browser/join', { name: 'Iris', runtime: 'Google Gemini' });
      const fresh = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      try {
        await fresh.addCookies([{ ...local.cookie, url: local.base }]);
        await fresh.route('**/*', route => new URL(route.request().url()).origin === local.base ? route.continue() : route.abort());
        // The note lives 5 s, so the page samples the layout every frame while both boxes exist.
        await fresh.addInitScript(() => {
          window.__noticeSamples = [];
          const sample = () => {
            const note = document.querySelector('.proof-share-welcome-toast');
            const row = document.querySelector('#agent-join-notices .agent-join-row');
            if (note && row) {
              const hits = [...row.querySelectorAll('button')].map(button => {
                const r = button.getBoundingClientRect();
                const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                return hit === button || button.contains(hit);
              });
              // The note slides in for 250 ms (proof-toast-slide-in); only settled frames judge its place.
              const animating = note.getAnimations().some(animation => animation.playState === 'running');
              window.__noticeSamples.push({ hits, animating, noteTop: note.getBoundingClientRect().top,
                noticeBottom: document.getElementById('agent-join-notices').getBoundingClientRect().bottom });
              if (window.__noticeSamples.length > 400) window.__noticeSamples.shift();
            }
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
        const opener = await fresh.newPage(); opener.setDefaultTimeout(15000);
        await opener.goto(`${local.base}/d/join-browser`);
        const waitingRow = opener.locator('#agent-join-notices .agent-join-row', { hasText: waiting.code });
        await waitingRow.waitFor({ state: 'visible' });
        await opener.waitForFunction(() => window.__noticeSamples.filter(sample => !sample.animating).length >= 10, null, { timeout: 6000 })
          .catch(() => { throw new Error('the welcome note and the join request never showed together, so the overlap was not measured'); });
        await opener.screenshot({ path: path.join(shots, `agent-join-${style}-1440-welcome-note.png`) });
        const samples = await opener.evaluate(() => window.__noticeSamples);
        // A button is never covered, in any frame; once the note has settled it sits below the notice.
        const covered = samples.find(sample => sample.hits.some(onTop => !onTop));
        assert.equal(covered, undefined, `the welcome note covered a join button: ${JSON.stringify(covered)}`);
        const settled = samples.filter(sample => !sample.animating).slice(-5);
        const overlapping = settled.find(sample => sample.noteTop < sample.noticeBottom);
        assert.equal(overlapping, undefined, `the settled welcome note overlaps the join notice: ${JSON.stringify(overlapping)}`);
        await waitingRow.getByRole('button', { name: 'Refuse', exact: true }).click();
        await waitingRow.waitFor({ state: 'detached' });
        console.log(`PASS agent join ${style} 1440: the welcome note sits below a waiting request and covers neither button (${samples.length} frames)`);
      } finally { await fresh.close(); }
    } finally { await context?.close(); await local.stop(); }
  }
} finally { await browser.close(); }
