#!/usr/bin/env node
// Browser check: an Accord as a surface inside a (stub) SOMA Room (src/shared/room-surface.ts).
// Mike, 2026-11-05: room members are the Accord's participants; Accord Chat goes away; "the chat
// in a room with an accord should move with the accord".
// Opens public/room-surface/demo.html, which embeds /d/<slug>?surface=room beside a stub room, and
// checks that: the surface draws no Accord chat; the room's members are the Accord's roster; room
// chat lands in the Accord's record; a tagged message becomes an argument; moving the Accord to a
// new room keeps the conversation. Desktop and phone width; screenshots in .preview/.
// Run `npm run build` first. Usage: node scripts/room-surface-check.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const clientHeaders = { 'Content-Type': 'application/json', 'X-Proof-Client-Version': '0.34.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
mkdirSync(path.join(root, '.preview'), { recursive: true });

let failures = 0;
async function check(name, fn) {
  let line;
  try { await fn(); line = `PASS ${name}`; }
  catch (error) { failures += 1; line = `FAIL ${name}: ${error?.message?.split('\n')[0]}`; }
  console.log(line);
}

async function startServer() {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-room-surface-check-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      PORT: String(port), COLLAB_EMBEDDED_WS: '1', PROOF_FEEDBACK_ENABLED: '0',
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

async function poll(fn, message, timeout = 10_000) {
  const end = Date.now() + timeout;
  do { if (await fn()) return; await new Promise(r => setTimeout(r, 150)); } while (Date.now() < end);
  assert.fail(message);
}

const markdown = `# Launch plan

Launch moves to September 30 for every customer.

Budget line stays the same for the quarter.`;

const { base, stop } = await startServer();
const browser = await chromium.launch();
try {
  const created = await call(base, '/api/documents', { markdown, title: 'Room surface check', role: 'editor' });
  const { slug, ownerSecret } = created;
  await call(base, `/api/agent/${slug}/dispositions/settings`, { multiParty: true, by: 'mike@example.com' }, ownerSecret);
  const proposal = await call(base, `/api/agent/${slug}/marks/suggest-replace`, { quote: 'September 30', content: 'October 14', by: 'ai:claude', why: 'Vendor slipped' }, ownerSecret);
  const markId = proposal.markId ?? proposal.suggestion?.markId;
  assert.ok(markId);
  const record = () => call(base, `/api/agent/${slug}/room/record`, undefined, ownerSecret);

  for (const [label, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(() => { try { localStorage.setItem('proof-share-viewer-name', 'Mike'); } catch {} });
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto(`${base}/room-surface/demo.html?slug=${slug}&token=${encodeURIComponent(ownerSecret)}`);
    const frame = page.frameLocator('iframe[title="Accord"]');
    const surface = () => page.frames().find(f => f.url().includes(`/d/${slug}`));
    await poll(async () => !!surface(), 'the Accord iframe did not load');
    await surface().waitForFunction(() => window.proof?.collabConnectionStatus === 'connected', null, { timeout: 20_000 }).catch(() => {});
    await frame.getByRole('button', { name: /Continue anonymously/i }).click({ timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const tag = `room-surface-${label}`;

    await check(`${tag}: the surface draws no Accord chat`, async () => {
      const f = surface();
      assert.equal(await f.evaluate(() => document.documentElement.dataset.roomSurface), 'true');
      assert.equal(await f.evaluate(() => !!window.__proofChat), false, 'ChatUI was created');
      assert.equal(await f.evaluate(() => [...document.querySelectorAll('.prw-chat')].every(el => el.hidden || el.offsetParent === null)), true, 'a chat slot is visible');
      assert.equal(await f.locator('[data-meet-live]').count(), 0, 'Meet live link shown inside a room');
    });

    if (label === 'desktop') {
      await check(`${tag}: the room's members are the Accord's roster`, async () => {
        await poll(async () => (await record()).roster.some(e => e.actor === 'noel@example.com'), 'Noel is not on the roster');
        const r = await record();
        assert.equal(r.roster.find(e => e.actor === 'mike@example.com')?.role, 'owner');
        assert.equal(r.roster.find(e => e.actor === 'ai:claude')?.role, 'participant');
      });

      await check(`${tag}: room chat lands in the Accord's record`, async () => {
        await page.selectOption('#as', 'u-noel');
        await page.fill('#text', 'Can we keep September for the early customers?');
        await page.click('#say button');
        await poll(async () => (await record()).messages.some(m => m.text.includes('early customers') && m.actor === 'noel@example.com'), 'the message did not reach the Accord');
      });

      await check(`${tag}: a message tagged to a proposal becomes an argument`, async () => {
        await page.selectOption('#as', 'u-noel');
        await page.fill('#text', `[against ${markId}] Two customers already planned for September.`);
        await page.click('#say button');
        await poll(async () => (await record()).allArguments.some(a => a.markId === markId && a.by === 'noel@example.com' && a.stance === 'against'), 'no argument recorded');
      });

      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(root, '.preview', 'room-surface-desktop.png') });

      await check(`${tag}: moving the Accord to a new room keeps the conversation`, async () => {
        const before = (await record()).messages.length;
        await page.click('#move');
        await poll(async () => (await record()).rooms.length === 2, 'the Accord did not move');
        await page.selectOption('#as', 'u-mike');
        await page.fill('#text', 'Same Accord, new room.');
        await page.click('#say button');
        await poll(async () => (await record()).messages.some(m => m.text === 'Same Accord, new room.'), 'the new room\'s chat did not arrive');
        const r = await record();
        assert.ok(r.messages.length > before, 'messages were lost');
        assert.equal(new Set(r.messages.map(m => m.roomId)).size, 2, 'messages from both rooms');
        assert.equal(r.rooms[0].unboundAt !== null, true);
      });
    } else {
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(root, '.preview', 'room-surface-phone.png') });
    }
    await context.close();
  }
} finally {
  await browser.close();
  await stop();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall room-surface checks passed');
process.exit(failures ? 1 : 0);
