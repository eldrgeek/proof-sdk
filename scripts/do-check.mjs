#!/usr/bin/env node
// Browser check for {do} action lines, SAFE SLICE: the page shows a proposed action, a signed-in
// owner can approve it, and nothing can run.
// Authorship: Claude Opus 5 (worker proof-do), 2026-09-18, in the style of identity-check.mjs.
// Starts an isolated local server on the current dist/ build (run `npm run build` first) with the
// Documents library on, signs Mike in through a real operator sign-in link, lets an AI (an agent
// key minted in Mike's page) propose a {do}, then drives Chromium in both review styles at 1440
// (desktop) and 390 (phone). Screenshots go to .preview/ (or --shots <dir>).
// Exit code 0 only if every check passes.
// Usage: node scripts/do-check.mjs [--style playmaker|proof] [--shots dir]
import { nextReview, showReview, showWholeAccord } from './review-ui.mjs';
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

const clientHeaders = { 'X-Proof-Client-Version': '0.34.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
const MIKE_EMAIL = 'mw@mike-wolf.com';
const MIKE = `human:${MIKE_EMAIL}`;
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `do-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-do-check-'));
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
// Lines: 0 Title | 1 Intro | 2 Do line | 3 Middle | 4 Last
const markdown = ['# Do check', para('Intro'), 'Authorize the Google Docs bridge for Mike', para('Middle'), para('Last')].join('\n\n');
const L = { INTRO: 1, DO: 2, MIDDLE: 3 };

function gdocAction(overrides = {}) {
  return {
    id: 'authorize-gdoc-bridge', revision: 1, executor: 'workflow', label: 'Authorize the Google Docs bridge',
    operation: 'gdoc_bridge_authorize', params: { project_id: 'soma-gdoc-bridge', account: MIKE_EMAIL },
    human_gate: { instruction: 'Click Allow on Google’s consent page', target: { url: 'https://accounts.google.com/o/oauth2/v2/auth', ref: 'google.oauth.consent.primary', label: 'Allow' } },
    completion: { mode: 'verified', success_message: 'Totally harmless, trust me' },
    verification: { kind: 'google_drive_about' },
    ...overrides,
  };
}

const waitFor = (page, fn, argument, timeout = 12000) => page.waitForFunction(fn, argument, { timeout, polling: 200 });

async function newContext(browser, base, options = {}) {
  const context = await browser.newContext(options);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  return context;
}

async function signIn(context, cli, base) {
  const link = cli('signin-link', '--email', MIKE_EMAIL, '--origin', base, '--hours', '1');
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
  await page.waitForFunction(() => document.querySelectorAll('.ProseMirror .pdo').length >= 1, null, { timeout: 10_000 });
  await page.waitForTimeout(300);
  page.setDefaultTimeout(6000);
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  await showWholeAccord(page);
}

const inline = page => page.locator('.ProseMirror .pdo');
const agentCall = (base, slug, KEY, method, route, body) => fetch(`${base}/api/agent/${slug}${route}`, {
  method, headers: KEY, body: body === undefined ? undefined : JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json() }));

async function run(browser, style) {
  const { base, stop, cli } = await startServer(style);
  try {
    cli('add-member', '--name', 'Mike Wolf', '--email', MIKE_EMAIL);
    const tag = `do-${style}-desktop`;
    const mikeCtx = await newContext(browser, base, { viewport: { width: 1440, height: 900 } });
    const mike = await signIn(mikeCtx, cli, base);
    activePage = mike;
    const created = await mike.evaluate(async md => {
      const r = await fetch('/library/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Do check', markdown: md }) });
      return { status: r.status, body: await r.json() };
    }, markdown);
    assert.ok(created.status === 200 || created.status === 201, JSON.stringify(created));
    const slug = created.body.slug;
    // An AI's agent key, minted in Mike's page the way "Add agent" mints it.
    await mike.goto(`${base}/d/${slug}`);
    await mike.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 20_000 });
    const key = await mike.evaluate(async ({ s, h }) => {
      const r = await fetch(`/api/documents/${s}/agent-keys`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify({ label: 'Claude COS', runtime: 'Claude Opus 5 (Anthropic)' }) });
      return { status: r.status, body: await r.json() };
    }, { s: slug, h: clientHeaders });
    assert.equal(key.status, 201, JSON.stringify(key));
    const KEY = { 'Content-Type': 'application/json', ...clientHeaders, 'x-share-token': key.body.token };
    const proposed = await agentCall(base, slug, KEY, 'POST', '/dos', { quote: 'Authorize the Google Docs bridge', action: gdocAction() });
    assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
    const doId = proposed.body.do.id;
    await openDoc(mike, base, slug);
    const mdBefore = await mike.evaluate(() => window.proof.getMarkdownSnapshot()?.content);

    await check(`${tag}: the {do} line shows a Do tag, the operation's own consequence, its state and a disabled Run`, async () => {
      const info = await mike.evaluate(i => {
        const lm = window.__proofLineMarks; const view = lm.editorView(); const line = lm.lineList()[i];
        const dom = view.nodeDOM(line.pos);
        const control = dom.querySelector('.pdo');
        const run = control?.querySelector('[data-action="run"]');
        return {
          tag: dom.querySelector('.pdo-inline-tag')?.textContent,
          state: control?.querySelector('.pdo-state')?.textContent,
          consequence: control?.querySelector('.pdo-consequence')?.textContent,
          predicate: control?.querySelector('.pdo-predicate')?.textContent,
          text: control?.textContent,
          run: run ? { label: run.textContent, disabled: run.disabled } : null,
          approve: control?.querySelector('[data-action="approve"]')?.disabled,
          lineText: line.text,
        };
      }, L.DO);
      assert.equal(info.tag, 'Do');
      assert.equal(info.state, 'Waiting for approval');
      assert.match(info.consequence, /If run: Opens Google’s consent page on Mike’s Mac/);
      assert.match(info.predicate, /Done means: Google Drive answers an "about" request as mw@mike-wolf\.com/);
      assert.doesNotMatch(info.text, /Totally harmless/, 'the author\'s success message is never shown');
      assert.deepEqual(info.run, { label: 'Execution not enabled yet', disabled: true });
      assert.equal(info.approve, false, 'Mike (signed in, owner, named) can approve');
      assert.equal(info.lineText, 'Authorize the Google Docs bridge for Mike', 'the widget leaked into the line text');
      await mike.locator('.ProseMirror .pdo').scrollIntoViewIfNeeded();
      await mike.screenshot({ path: path.join(shots, `${tag}-1-proposed.png`) });
    });

    await check(`${tag}: the widgets are view-only and the unfinished {do} is an Issue`, async () => {
      assert.equal(await mike.evaluate(() => window.proof.getMarkdownSnapshot()?.content), mdBefore);
      const s = await mike.evaluate(() => window.__proofLineMarks.debugState());
      assert.equal(s.doIssues, 1);
      assert.match(await mike.locator('#share-banner .plm-issues-count').getAttribute('title'), /need you/);
    });

    await check(`${tag}: Next issue lands on the {do} first (waiting for Mike's approval outranks unseen lines)`, async () => {
      await mike.evaluate(() => window.scrollTo(0, 0));
      await nextReview(mike);
      await mike.waitForTimeout(150);
      assert.equal(await mike.evaluate(() => window.__proofReadingWalk.focusIndex()), L.DO);
    });

    // A guest on the same document.
    const guestCtx = await newContext(browser, base, { viewport: { width: 1280, height: 900 } });
    await guestCtx.addInitScript(() => { try { localStorage.setItem('proof-share-viewer-name', 'Mike Wolf'); } catch {} });
    const guest = await guestCtx.newPage();
    await openDoc(guest, base, slug);
    await check(`${tag}: a guest typing Mike's name sees the action but cannot approve (button off; the server refuses too)`, async () => {
      const control = inline(guest);
      assert.equal(await control.locator('[data-action="approve"]').isDisabled(), true);
      assert.match(await control.locator('.pdo-note-line').innerText(), /Sign in to approve/);
      const forced = await guest.evaluate(async ({ s, id, h }) => {
        const r = await fetch(`/api/documents/${s}/dos/${id}/approve`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify({ digest: 'x', by: 'human:mw@mike-wolf.com' }) });
        return { status: r.status, body: await r.json() };
      }, { s: slug, id: doId, h: clientHeaders });
      assert.equal(forced.status, 403);
      // Invite person (2026-09-19): under the default guest setting a guest is refused earlier.
      assert.match(forced.body.code, /^(SIGNED_IN_PERSON_REQUIRED|SIGN_IN_TO_MARK)$/);
    });
    await check(`${tag}: the AI's key cannot approve from the page either`, async () => {
      const r = await guest.evaluate(async ({ s, id, h }) => {
        const res = await fetch(`/api/documents/${s}/dos/${id}/approve`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify({ digest: 'x' }) });
        return res.status;
      }, { s: slug, id: doId, h: { ...clientHeaders, 'x-share-token': key.body.token } });
      assert.equal(r, 403);
    });

    await check(`${tag}: Mike approves; the state says Approved; nothing is queued; no line mark is written`, async () => {
      // "Approving is not agreeing": compare the marks a person chose (Agree, Reject, Approve, Seen
      // by click or key). Passive reads are left out: the reading walk keeps writing Seen by dwell
      // for the lines at the top of this short page while the check runs (seen on 3474b69: the
      // {do} line's dwell Seen landed ~1 s after line 0's, between the two fetches, with the focus
      // line never leaving line 0), which made this check flaky without any approval writing a mark.
      const deliberate = list => list.filter(m => !['dwell', 'section', 'proxy'].includes(m.via ?? 'api') && m.status !== 'skimmed');
      const readMarks = () => mike.evaluate(async s => (await (await fetch(`/api/documents/${s.s}/line-marks`, { credentials: 'same-origin', headers: s.h })).json()).lineMarks, { s: slug, h: clientHeaders });
      const marksBefore = deliberate(await readMarks());
      await mike.evaluate(() => window.scrollTo(0, 0));
      const control = inline(mike);
      await control.scrollIntoViewIfNeeded();
      await control.locator('[data-action="approve"]').click();
      await waitFor(mike, () => window.__proofLineMarks.debugState().doWrites >= 1);
      await waitFor(mike, () => document.querySelector('.ProseMirror .pdo')?.dataset.state === 'approved');
      assert.match(await inline(mike).locator('.pdo-approval').innerText(), /Approved by Mike Wolf \(one run\)/);
      assert.equal(await inline(mike).locator('[data-action="run"]').isDisabled(), true);
      const list = await agentCall(base, slug, KEY, 'GET', '/dos');
      assert.equal(list.body.dos[0].state, 'approved');
      assert.equal(list.body.dos[0].approval.by, MIKE);
      assert.deepEqual(list.body.dos[0].runs, []);
      const marksAfter = deliberate(await readMarks());
      assert.deepEqual(marksAfter.map(m => m.id), marksBefore.map(m => m.id), `approving is not agreeing: ${JSON.stringify(marksAfter.map(m => [m.anchor?.ordinal, m.status, m.via]))}`);
      await mike.screenshot({ path: path.join(shots, `${tag}-2-approved.png`) });
    });

    await check(`${tag}: Run is refused by the server even when called directly`, async () => {
      const r = await mike.evaluate(async ({ s, id, h }) => {
        const res = await fetch(`/api/documents/${s}/dos/${id}/run`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...h }, body: '{}' });
        return { status: res.status, body: await res.json() };
      }, { s: slug, id: doId, h: clientHeaders });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.code, 'EXECUTION_NOT_ENABLED');
    });

    await check(`${tag}: when the AI changes the action, Mike's page shows the approval no longer counts`, async () => {
      const revised = await agentCall(base, slug, KEY, 'POST', `/dos/${doId}/revise`, { action: gdocAction({ revision: 2, params: { project_id: 'another-project', account: MIKE_EMAIL } }) });
      assert.equal(revised.status, 200, JSON.stringify(revised.body));
      await waitFor(mike, () => document.querySelector('.ProseMirror .pdo')?.dataset.state === 'proposed', null, 15000);
      assert.match(await inline(mike).locator('.pdo-approval').innerText(), /before it changed: approve it again/);
      assert.match(await inline(mike).locator('.pdo-consequence').innerText(), /another-project/);
      await mike.screenshot({ path: path.join(shots, `${tag}-3-changed.png`) });
    });

    await check(`${tag}: the guest's page shows the same state (poll)`, async () => {
      await waitFor(guest, () => document.querySelector('.ProseMirror .pdo')?.dataset.state === 'proposed', null, 15000);
    });
    await guestCtx.close();
    await mikeCtx.close();

    // ---------------------------------------------------------------- phone 390
    const ptag = `do-${style}-phone-390x844`;
    const viewport = { width: 390, height: 844 };
    const phoneCtx = await newContext(browser, base, { ...devices['iPhone 13'], viewport, screen: viewport, hasTouch: true, isMobile: true });
    const phone = await signIn(phoneCtx, cli, base);
    activePage = phone;
    await openDoc(phone, base, slug);
    await check(`${ptag}: the inline control fits the screen with touch-sized buttons; no sideways scroll`, async () => {
      const control = inline(phone);
      await control.scrollIntoViewIfNeeded();
      const info = await phone.evaluate(() => {
        const c = document.querySelector('.ProseMirror .pdo');
        return {
          box: c.getBoundingClientRect().toJSON(),
          buttons: [...c.querySelectorAll('.pdo-btn')].map(b => ({ ...b.getBoundingClientRect().toJSON(), label: b.textContent })),
          sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
        };
      });
      assert.ok(info.sw <= info.cw + 1, `scrollWidth ${info.sw}`);
      assert.ok(info.box.right <= 390 && info.box.left >= 0, `control off screen ${info.box.left}..${info.box.right}`);
      assert.ok(info.buttons.length >= 2);
      for (const b of info.buttons) assert.ok(b.height >= 44, `button ${b.label} ${b.width}x${b.height}`);
      await phone.screenshot({ path: path.join(shots, `${ptag}-1-inline.png`) });
    });
    await check(`${ptag}: inline Approve works on phone; the retired action box stays absent`, async () => {
      const control = inline(phone);
      await control.scrollIntoViewIfNeeded();
      assert.equal(await phone.locator('.prw-right .pdo').count(), 0, 'retired action box');
      assert.equal(await control.locator('[data-action="run"]').isDisabled(), true);
      await phone.screenshot({ path: path.join(shots, `${ptag}-2-inline-approve.png`) });
      await control.locator('[data-action="approve"]').tap();
      await waitFor(phone, () => window.__proofLineMarks.debugState().doWrites >= 1);
      const list = await agentCall(base, slug, KEY, 'GET', '/dos');
      assert.equal(list.body.dos[0].state, 'approved');
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
console.log(`\n${results.length - failures}/${results.length} {do} checks passed`);
process.exit(failures ? 1 : 0);
