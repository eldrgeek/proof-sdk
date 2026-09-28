#!/usr/bin/env node
// Brief 1 truthful count (ac-fbw): stale skims and ordinal Seen marks must not inflate the count.
// Mike, 2026-09-27. Local server + agent API; one PASS/FAIL line per assertion for release-gate.sh.
// Usage: node scripts/truthful-count-check.mjs [--shots dir]  (run `npm run build` first)
import { showWholeAccord } from './review-ui.mjs';
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

const clientHeaders = { 'X-Proof-Client-Version': '0.34.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
const MIKE = 'guest:Mike';
const DATE = '2026-09-27';
const TITLE_A = 'Approve zebra corridor routing';
const TITLE_B = 'Harbor lighthouse painting budget';

const LAUNCH_BEFORE = 'Launch ship date for zebra corridor rollout is Monday the fifth of July.';
const LAUNCH_AFTER = 'Launch ship date for zebra corridor rollout is Friday the ninth of July.';
const BUDGET_BEFORE = 'Budget cap for zebra corridor is twelve thousand dollars this quarter.';
const BUDGET_AFTER = 'Unrelated treasury forecast sentence replaces the budget line entirely.';
const VENUE_BEFORE = 'Venue option for zebra corridor meetup is the north hall downtown.';
const VENUE_AFTER = 'Venue option for zebra corridor meetup is the waterfront pavilion eastside.';

const markdown = [
  '# Truthful count fixture',
  'Intro paragraph for the truthful count browser check.',
  '## Decisions for you',
  `### ${TITLE_A}`,
  'Why: zebra corridor routing reduces handoffs.',
  'Recommend: Yes, adopt zebra corridor routing.',
  `Ask key: a · asked ${DATE} · from check`,
  '## Notes',
  BUDGET_BEFORE,
  VENUE_BEFORE,
  LAUNCH_BEFORE,
  '## Done since last revision',
  'Done section seed line for truthful count check.',
].join('\n\n');

let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1;
    results.push(`FAIL ${name}: ${String(error?.message ?? error).split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `truthful-count-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer() {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-truthful-count-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      PORT: String(port), COLLAB_EMBEDDED_WS: '1', PROOF_DEFAULT_REVIEW_STYLE: 'proof',
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

const agentHeaders = (token) => ({ 'Content-Type': 'application/json', ...clientHeaders, 'x-share-token': token });
async function agent(base, created, route, body, method = 'POST') {
  const r = await fetch(`${base}/api/agent/${created.slug}${route}`, {
    method,
    headers: { ...agentHeaders(created.ownerSecret), 'Idempotency-Key': `k-${Date.now()}-${Math.random()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  assert.ok(r.ok || r.status === 202, `${route}: ${r.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

function blockByNeedle(snap, needle) {
  const block = (snap.blocks ?? []).find(b => String(b.markdown ?? b.text ?? '').includes(needle));
  assert.ok(block, `block not found for "${needle}"`);
  return block;
}

async function editV2(base, created, by, operations) {
  const snap = await agent(base, created, '/snapshot', undefined, 'GET');
  const body = { by, operations };
  if (snap.mutationBase) body.baseToken = typeof snap.mutationBase === 'string' ? snap.mutationBase : snap.mutationBase.token;
  else if (snap.revision !== undefined && snap.revision !== null) body.baseRevision = snap.revision;
  assert.ok(body.baseToken || body.baseRevision !== undefined, 'no mutation base on snapshot');
  await agent(base, created, '/edit/v2', body);
}

async function replaceInBlock(base, created, by, needle, replacement) {
  const snap = await agent(base, created, '/snapshot', undefined, 'GET');
  const block = blockByNeedle(snap, needle);
  const old = String(block.markdown ?? block.text ?? '');
  await editV2(base, created, by, [{ op: 'replace_block', ref: block.ref, block: { markdown: old.replace(needle, replacement) } }]);
}

function lineByNeedle(state, needle) {
  const line = (state.lines ?? []).find(l => String(l.text ?? '').includes(needle));
  assert.ok(line, `line not found for "${needle}"`);
  return line;
}

function lineIssuesForMike(state) {
  return (state.issues ?? []).filter(i => i.type === 'line' && (i.changedFor ?? []).includes(MIKE));
}

async function stampClerkLines(base, created, state) {
  const ruled = lineByNeedle(state, 'Ruled ');
  const resolved = lineByNeedle(state, 'Ask key: a · resolved');
  const keyB = lineByNeedle(state, 'Ask key: b · asked');
  const targets = [ruled, resolved, keyB].map(l => ({ hash: l.hash, occurrence: l.occurrence }));
  await agent(base, created, '/tiers', {
    by: 'ai:ask-mike',
    tier: 'context',
    reason: 'ask-mike bookkeeping line (an ask key or a ruling stamp). Clerical work stays with the AI (The Accord rules, gfmd0z5p).',
    lines: targets,
  });
  await agent(base, created, '/marks/line', {
    by: 'ai:ask-mike',
    status: 'seen',
    via: 'api',
    evidence: 'ask-mike wrote this line itself; it records an ask key or a ruling, not a claim',
    lines: targets,
  });
}

async function openMike(browser, base, slug) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(name => { localStorage.setItem('proof-share-viewer-name', name); }, 'Mike');
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(`${base}/d/${slug}`);
  await page.getByRole('button', { name: 'Continue anonymously', exact: true }).click({ timeout: 6000 }).catch(() => {});
  await page.waitForFunction(() => window.proof?.collabIsSynced && window.__proofLineMarks?.debugState().loaded && window.__proofReadingWalk?.debugState().ready, null, { timeout: 25_000 });
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  await showWholeAccord(page);
  return { context, page };
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();
  try {
    const created = await fetch(`${server.base}/api/documents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
      body: JSON.stringify({ markdown, title: 'Truthful count fixture' }),
    }).then(r => { assert.equal(r.status, 200); return r.json(); });

    const askA = await agent(server.base, created, '/asks', {
      by: 'ai:ask-mike', quote: TITLE_A, to: ['Mike'], recommend: 'Yes: adopt zebra corridor routing.',
    });

    let state = await agent(server.base, created, '/state', undefined, 'GET');
    const titleLine = lineByNeedle(state, TITLE_A);
    const whyLine = lineByNeedle(state, 'Why: zebra corridor');
    const recLine = lineByNeedle(state, 'Recommend: Yes, adopt');
    const keyALine = lineByNeedle(state, 'Ask key: a · asked');
    const budgetLine = lineByNeedle(state, 'Budget cap');
    const venueLine = lineByNeedle(state, 'Venue option');
    const launchLine = lineByNeedle(state, 'Launch ship date');

    const markLine = (lineIndex, status, via = 'dwell') => agent(server.base, created, '/marks/line', { by: MIKE, status, via, lineIndex });
    await markLine(titleLine.index, 'seen');
    await markLine(whyLine.index, 'seen');
    await markLine(keyALine.index, 'seen');
    await markLine(launchLine.index, 'seen');
    await markLine(recLine.index, 'skimmed');
    await markLine(venueLine.index, 'skimmed');
    await agent(server.base, created, '/marks/line', { by: MIKE, status: 'agreed', via: 'click', lineIndex: budgetLine.index });

    await agent(server.base, created, `/asks/${askA.ask.id}/answer`, { by: MIKE, choice: 'yes' });

    const snapBeforeB = await agent(server.base, created, '/snapshot', undefined, 'GET');
    const afterAKey = blockByNeedle(snapBeforeB, 'Ask key: a · asked');
    await editV2(server.base, created, 'ai:ask-mike', [{
      op: 'insert_after',
      ref: afterAKey.ref,
      blocks: [
        { markdown: `### ${TITLE_B}` },
        { markdown: 'Why: harbor lighthouse needs fresh paint.' },
        { markdown: 'Recommend: Yes, schedule harbor lighthouse painting.' },
        { markdown: `Ask key: b · asked ${DATE} · from check` },
      ],
    }]);
    state = await agent(server.base, created, '/state', undefined, 'GET');
    const titleBLine = lineByNeedle(state, TITLE_B);
    await agent(server.base, created, '/asks', {
      by: 'ai:ask-mike', quote: TITLE_B, to: ['Mike'], recommend: 'Yes: schedule harbor lighthouse painting.',
    });

    const snapMove = await agent(server.base, created, '/snapshot', undefined, 'GET');
    const doneTail = blockByNeedle(snapMove, 'Done section seed');
    const aRefs = [
      blockByNeedle(snapMove, `### ${TITLE_A}`).ref,
      blockByNeedle(snapMove, 'Why: zebra corridor').ref,
      blockByNeedle(snapMove, 'Recommend: Yes, adopt').ref,
      blockByNeedle(snapMove, 'Ask key: a · asked').ref,
    ].sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
    await editV2(server.base, created, 'ai:ask-mike', [
      { op: 'insert_after', ref: doneTail.ref, blocks: [
        { markdown: `### ${TITLE_A}` },
        { markdown: `Ruled ${DATE} (Yes button)` },
        { markdown: `Ask key: a · resolved ${DATE}` },
      ] },
      ...aRefs.map(ref => ({ op: 'delete_block', ref })),
    ]);

    state = await agent(server.base, created, '/state', undefined, 'GET');
    await stampClerkLines(server.base, created, state);

    await check('clerk move: alignment total 1, lineIssues 0, no line changedFor guest:Mike', async () => {
      state = await agent(server.base, created, '/state', undefined, 'GET');
      assert.equal(state.alignment?.counts?.total, 1, JSON.stringify(state.alignment?.counts));
      assert.equal(state.alignment?.counts?.lineIssues, 0);
      assert.equal(lineIssuesForMike(state).length, 0);
    });

    await check('real rewrite still opens: launch line changed, total 2', async () => {
      await replaceInBlock(server.base, created, 'ai:writer', 'Monday the fifth', 'Friday the ninth');
      state = await agent(server.base, created, '/state', undefined, 'GET');
      const launchIssue = (state.issues ?? []).find(i => i.type === 'line' && String(i.excerpt ?? '').includes('Friday the ninth'));
      assert.ok(launchIssue?.changedFor?.includes(MIKE), `launch issue: ${JSON.stringify(launchIssue)}`);
      assert.equal(state.alignment?.counts?.total, 2);
    });

    await check('agreement to a replaced line still opens: budget replaced, total 3', async () => {
      await replaceInBlock(server.base, created, 'ai:writer', BUDGET_BEFORE, BUDGET_AFTER);
      state = await agent(server.base, created, '/state', undefined, 'GET');
      const budgetIssue = (state.issues ?? []).find(i => i.type === 'line' && String(i.excerpt ?? '').includes('treasury forecast'));
      assert.ok(budgetIssue?.changedFor?.includes(MIKE));
      assert.equal(state.alignment?.counts?.total, 3);
    });

    await check('a skim does not open: venue changed substantively, total stays 3', async () => {
      await replaceInBlock(server.base, created, 'ai:writer', 'north hall downtown', 'waterfront pavilion eastside');
      state = await agent(server.base, created, '/state', undefined, 'GET');
      assert.equal(state.alignment?.counts?.total, 3);
    });

    await check('browser Needs you count is 3 for guest Mike', async () => {
      const { context, page } = await openMike(browser, server.base, created.slug);
      activePage = page;
      const countText = await page.evaluate(() => window.__proofFolding?.countText?.() ?? '');
      const match = countText.match(/^(\d+) open for you/);
      assert.ok(match, `count line: "${countText}"`);
      assert.equal(Number(match[1]), 3);
      await page.screenshot({ path: path.join(shots, 'truthful-count-needs-you.png') });
      await context.close();
    });
  } finally {
    await browser.close();
    await server.stop();
  }
  if (failures) process.exit(1);
}

main().catch(error => { console.error(error); process.exit(1); });
