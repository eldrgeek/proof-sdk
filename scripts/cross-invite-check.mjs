#!/usr/bin/env node
// Browser check for cross invitation (Mike Wolf, 2026-09-19): "if a human is invited, they should
// be able to invite their AI and the reverse… when you invite an AI the identity test may be far
// more stringent than when a human is invited. And an invited AI becomes an IDP for humans."
//
// In a real browser, on the current dist/ build, in both review styles at 1440 (desktop) and 390
// (phone): an invited person adds their own AI from Add agent (name + runtime; it is bound to them
// as its sponsor and shown as "Izzy — added by Eric"); that AI cannot add another AI; the AI
// nominates a person, the owner sees a nomination Issue and a row in the people dialog with the
// AI's own words, and Confirm sends the real invitation (captured, never sent) so that the person
// signs in and their marks count; the AI attests to someone else, who then reads and comments but
// whose marks are refused (NOT_VERIFIED); removing the sponsor suspends their AI; and every row
// shows how it got in.
//
// Authorship: Claude Opus 5 (worker proof-crossinvite), 2026-09-19, in the style of invite-check.mjs.
// Run `npm run build` first. Screenshots go to .preview/ (or --shots <dir>). Exit 0 only if every
// check passes.
// Usage: node scripts/cross-invite-check.mjs [--style playmaker|proof] [--shots dir]
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const shots = arg('--shots') || path.join(root, '.preview');
mkdirSync(shots, { recursive: true });
const styles = arg('--style') ? [arg('--style')] : ['playmaker', 'proof'];

const MIKE_EMAIL = 'mw@mike-wolf.com';
const ERIC_EMAIL = 'eric@example.test';
const ADA_EMAIL = 'ada@example.test';
const SAM_EMAIL = 'sam@example.test';
const RUNTIME = 'ChatGPT (OpenAI)';
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `cross-invite-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-cross-check-'));
  const mailFile = path.join(temp, 'mail.jsonl');
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    PORT: String(port), COLLAB_EMBEDDED_WS: '1', PROOF_DEFAULT_REVIEW_STYLE: style,
    PROOF_FEEDBACK_ENABLED: '1', SOMA_FEEDBACK_ENDPOINT: 'http://127.0.0.1:9/feedback',
    PROOF_LIBRARY_ENABLED: '1',
    // Never email anyone: invitations are appended to a local file.
    PROOF_INVITE_MAIL_TRANSPORT: 'capture', PROOF_INVITE_MAIL_CAPTURE: mailFile,
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
      const mails = () => (existsSync(mailFile) ? readFileSync(mailFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
      return { base, stop, cli, mails };
    }
    await new Promise(r => setTimeout(r, 150));
  }
  await stop();
  throw new Error('server did not start');
}

const para = (tag) => `${tag} paragraph is plain text for reading; it is long enough to be a real line of the document.`;
const markdown = ['# Cross invitation check', para('Intro'), para('Middle'), para('Last')].join('\n\n');
const CLIENT = { 'X-Proof-Client-Version': '0.31.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };

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

async function waitForDoc(page) {
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForFunction(() => window.__proofReadingWalk?.debugState().ready === true, null, { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(400);
  page.setDefaultTimeout(6000);
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
}

async function openDoc(page, base, slug) {
  await page.goto(`${base}/d/${slug}`);
  await waitForDoc(page);
}

const serverView = (page, slug) => page.evaluate(async ({ s, h }) => {
  const r = await fetch(`/api/documents/${s}/line-marks`, { credentials: 'same-origin', headers: h });
  return { status: r.status, body: await r.json() };
}, { s: slug, h: CLIENT });

const pagePost = (page, url, body) => page.evaluate(async ({ u, b, h }) => {
  const r = await fetch(u, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}, { u: url, b: body, h: CLIENT });

/** The AI's own calls, made from outside any page with its key (never a browser session). */
const agent = (base, slug, key, method, path, body) => fetch(`${base}/api/agent/${slug}${path}`, {
  method, headers: { 'Content-Type': 'application/json', 'x-share-token': key, ...CLIENT },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

async function markLine(page, line) {
  await page.locator(`.plm-dot[data-line="${line}"]`).click();
  const menu = page.locator(`.prw-right .plm-box[data-line="${line}"], .plm-menu`);
  await menu.waitFor({ state: 'visible' });
  await menu.getByRole('button', { name: /Agree/ }).click();
}

async function openInviteDialog(page, phone) {
  if (phone) {
    await page.locator('#share-banner .share-pill-overflow').click();
    await page.locator('.proof-share-overflow-menu [role="menuitem"]', { hasText: 'Invite person' }).click();
  } else {
    // Accord layout stage 2: People › Invite person… opens the Share dialog's People tab.
    await page.locator('#accord-menubar .amb-top[data-menu="people"]').click();
    await page.locator('.amb-menu [role="menuitem"]', { hasText: 'Invite person' }).click();
  }
  const dialog = page.locator('#invite-person-dialog');
  await dialog.waitFor({ state: 'visible' });
  await dialog.locator('[data-people]').filter({ hasNotText: 'Loading' }).waitFor();
  return dialog;
}

async function openAgentDialog(page, phone) {
  if (phone) {
    await page.locator('#share-banner .share-pill-overflow').click();
    await page.locator('.proof-share-overflow-menu [role="menuitem"]', { hasText: 'Add agent' }).click();
  } else {
    // Accord layout stage 2: People › Add agent… opens the Share dialog's AIs tab.
    await page.locator('#accord-menubar .amb-top[data-menu="people"]').click();
    await page.locator('.amb-menu [role="menuitem"]', { hasText: 'Add agent' }).click();
  }
  const dialog = page.locator('#agent-key-dialog');
  await dialog.waitFor({ state: 'visible' });
  await dialog.locator('[data-keys]').filter({ hasNotText: 'Loading' }).waitFor();
  return dialog;
}

async function addAgent(dialog, name, runtime) {
  await dialog.locator('#agent-key-label').fill(name);
  await dialog.locator('#agent-key-runtime').fill(runtime);
  await dialog.getByRole('button', { name: 'Create agent key' }).click();
  await dialog.locator('[data-status]', { hasText: /Key created/ }).waitFor();
  const instructions = await dialog.locator('#agent-key-instructions').inputValue();
  const key = /x-share-token:\s*(\S+)/i.exec(instructions)?.[1] ?? /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(instructions)?.[1];
  assert.ok(key, `no key in the instructions: ${instructions.slice(0, 400)}`);
  return key;
}

async function invite(dialog, email, name) {
  await dialog.locator('#invite-person-email').fill(email);
  await dialog.locator('#invite-person-name').fill(name);
  await dialog.getByRole('button', { name: 'Invite', exact: true }).click();
  await dialog.locator('[data-status]', { hasText: /Invitation emailed/ }).waitFor();
}

async function run(browser, style) {
  const { base, stop, cli, mails } = await startServer(style);
  try {
    cli('add-member', '--name', 'Mike Wolf', '--email', MIKE_EMAIL);
    const tag = `cross-invite-${style}-desktop`;
    const desk = { viewport: { width: 1440, height: 900 } };
    const mikeCtx = await newContext(browser, base, desk);
    await mikeCtx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base }).catch(() => {});
    const mike = await signIn(mikeCtx, cli, base, MIKE_EMAIL);
    activePage = mike;
    const slug = (await mike.evaluate(async md => (await fetch('/library/api/documents', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Cross invitation check', markdown: md }),
    })).json(), markdown)).slug;
    await openDoc(mike, base, slug);

    // Mike invites Eric, and Eric signs in from the emailed link.
    let dialog = await openInviteDialog(mike, false);
    await invite(dialog, ERIC_EMAIL, 'Eric');
    await dialog.page().locator('#share-dialog').getByRole('button', { name: 'Close share dialog' }).click();
    const ericCtx = await newContext(browser, base, desk);
    const eric = await ericCtx.newPage();
    await eric.goto(mails().at(-1).link);
    await eric.waitForURL(url => url.pathname === `/d/${slug}`, { timeout: 15_000 });
    await waitForDoc(eric);

    // ---- 1 + 2: an invited person adds their own AI ------------------------------------------
    let izzyKey = '';
    await check(`${tag}: an invited person adds their own AI from Add agent, with a runtime, and it is bound to them`, async () => {
      activePage = eric;
      const agents = await openAgentDialog(eric, false);
      // The runtime is required here: the form will not submit without it, and the server refuses
      // a key with no runtime even when the form is bypassed.
      await agents.locator('#agent-key-label').fill('Izzy');
      await agents.getByRole('button', { name: 'Create agent key' }).click();
      assert.equal(await agents.locator('#agent-key-runtime').evaluate(el => el.required && !el.checkValidity()), true, 'the runtime field blocks the form');
      assert.equal(await agents.locator('[data-keys]').innerText(), 'No agent keys yet.');
      const bypassed = await pagePost(eric, `/api/documents/${slug}/agent-keys`, { label: 'Runtimeless' });
      assert.equal(bypassed.body.code, 'RUNTIME_REQUIRED');
      izzyKey = await addAgent(agents, 'Izzy', RUNTIME);
      const row = agents.locator('.key-row', { hasText: 'Izzy' }).first();
      assert.match(await row.innerText(), /Added by Eric/);
      assert.match(await row.innerText(), new RegExp(RUNTIME.replace(/[()]/g, '\\$&')));
      await eric.screenshot({ path: path.join(shots, `${tag}-1-agent-added.png`) });
      await agents.page().locator('#share-dialog').getByRole('button', { name: 'Close share dialog' }).click();
    });

    await check(`${tag}: the AI works, and its marks read "Izzy — added by Eric"`, async () => {
      const marked = await agent(base, slug, izzyKey, 'POST', '/marks/line', { status: 'seen', lineIndex: 2 });
      assert.equal(marked.status, 200, JSON.stringify(marked.body).slice(0, 300));
      await eric.reload();
      await waitForDoc(eric);
      const view = await serverView(eric, slug);
      assert.equal(view.body.agentSponsors['ai:izzy'].sponsorName, 'Eric');
      assert.equal(view.body.agentSponsors['ai:izzy'].runtime, RUNTIME);
      await eric.locator('.plm-dot[data-line="2"]').click();
      const box = eric.locator('.prw-right .plm-box[data-line="2"], .plm-menu').first();
      await box.waitFor({ state: 'visible' });
      await box.locator('.plm-team li', { hasText: 'added by Eric' }).first().waitFor();
      await eric.screenshot({ path: path.join(shots, `${tag}-2-sponsor-on-mark.png`) });
    });

    await check(`${tag}: the depth cap — the AI cannot add another AI`, async () => {
      const refused = await fetch(`${base}/api/documents/${slug}/agent-keys`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'x-share-token': izzyKey, ...CLIENT },
        body: JSON.stringify({ label: 'Izzy Junior', runtime: RUNTIME }),
      });
      assert.equal(refused.status, 403);
      assert.equal((await refused.json()).code, 'AI_CANNOT_ADMIT_AI');
    });

    // ---- 3: the AI nominates a person; Mike confirms -------------------------------------------
    await check(`${tag}: the AI nominates Ada — nothing is emailed, and Mike sees a nomination Issue`, async () => {
      activePage = mike;
      const before = mails().length;
      const nominated = await agent(base, slug, izzyKey, 'POST', '/team/nominations', {
        email: ADA_EMAIL, name: 'Ada', why: 'Ada wrote the timing section and Eric asked me to bring her in.',
      });
      assert.equal(nominated.status, 201, JSON.stringify(nominated.body).slice(0, 300));
      assert.equal(nominated.body.invited, false);
      assert.equal(mails().length, before, 'a nomination emails nobody');
      const state = await agent(base, slug, izzyKey, 'GET', '/state');
      const issue = state.body.issues.find(i => i.type === 'nomination');
      assert.ok(issue, 'no nomination Issue in /state');
      assert.equal(issue.email, ADA_EMAIL);
    });

    await check(`${tag}: the people dialog shows the nomination with the AI's own words, and Confirm sends the invitation`, async () => {
      await mike.reload();
      await waitForDoc(mike);
      dialog = await openInviteDialog(mike, false);
      const section = dialog.locator('[data-nominations]');
      await section.waitFor({ state: 'visible' });
      assert.match(await section.innerText(), /Ada wrote the timing section/);
      assert.match(await section.innerText(), /put forward by Izzy/);
      await mike.screenshot({ path: path.join(shots, `${tag}-3-nomination.png`) });
      await section.getByRole('button', { name: /^Confirm Ada/ }).click();
      await dialog.locator('[data-status]', { hasText: /was invited/ }).waitFor();
      const mail = mails().at(-1);
      assert.equal(mail.to, ADA_EMAIL);
      await dialog.locator('.ip-row', { hasText: ADA_EMAIL }).first().waitFor();
      await mike.screenshot({ path: path.join(shots, `${tag}-4-confirmed.png`) });
      await dialog.page().locator('#share-dialog').getByRole('button', { name: 'Close share dialog' }).click();
    });

    const adaCtx = await newContext(browser, base, desk);
    const ada = await adaCtx.newPage();
    await check(`${tag}: Ada signs in from that invitation and her marks count`, async () => {
      activePage = ada;
      await ada.goto(mails().at(-1).link);
      await ada.waitForURL(url => url.pathname === `/d/${slug}`, { timeout: 15_000 });
      await waitForDoc(ada);
      const me = ada.locator('.prw-right .prw-me');
      await me.waitFor({ state: 'visible' });
      assert.equal(await me.getAttribute('data-trust'), 'verified');
      await markLine(ada, 1);
      await ada.waitForFunction(() => document.querySelector('.plm-dot[data-line="1"]')?.dataset.status === 'agreed', null, { timeout: 9000 });
      const view = await serverView(ada, slug);
      assert.ok(view.body.lineMarks.some(m => m.anchor.ordinal === 1 && m.by === `human:${ADA_EMAIL}`), 'her mark counts as a verified person');
      await ada.screenshot({ path: path.join(shots, `${tag}-5-ada-marks.png`) });
    });

    // ---- 4: the AI attests to a person --------------------------------------------------------
    const samCtx = await newContext(browser, base, desk);
    const sam = await samCtx.newPage();
    await check(`${tag}: the AI attests to Sam — he reads and comments, and his marks are refused`, async () => {
      activePage = mike;
      // Private first, so that what the attestation grants is the only thing measured.
      await mike.evaluate(async s => {
        await fetch(`/api/documents/${s}/team/guest-access`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'private' }) });
      }, slug);
      const attested = await agent(base, slug, izzyKey, 'POST', '/team/attestations', {
        email: SAM_EMAIL, basis: 'Sam is in the meeting I am transcribing and gave this address.', confidence: 'medium',
      });
      assert.equal(attested.status, 201, JSON.stringify(attested.body).slice(0, 300));
      assert.equal(attested.body.grants.marksCount, false);
      activePage = sam;
      // Sam signs in with that address. No invitation was ever sent to him.
      const link = cli('signin-link', '--email', SAM_EMAIL, '--origin', base, '--hours', '1');
      await sam.goto(link);
      await sam.waitForURL(url => url.pathname === '/', { timeout: 15_000 });
      await openDoc(sam, base, slug);
      const me = sam.locator('.prw-right .prw-me');
      await me.waitFor({ state: 'visible' });
      assert.match(await me.innerText(), /vouched for by Izzy/);
      const refused = await pagePost(sam, `/api/documents/${slug}/line-marks`, {
        by: 'Sam', status: 'agreed', anchor: { hash: 'x', occurrence: 0, ordinal: 2, kind: 'paragraph', excerpt: 'Middle' },
      });
      assert.equal(refused.status, 403);
      assert.equal(refused.body.code, 'NOT_VERIFIED');
      const comment = await pagePost(sam, `/api/documents/${slug}/ops`, { type: 'comment.add', quote: 'Middle paragraph', text: 'Sam comments', by: 'guest:Sam' });
      assert.equal(comment.status, 200, JSON.stringify(comment.body).slice(0, 200));
      await sam.screenshot({ path: path.join(shots, `${tag}-6-attested.png`) });
    });

    // ---- 5: provenance, and 1's other half: suspension with the sponsor -------------------------
    await check(`${tag}: the people dialog shows how everyone got in, and Izzy with its sponsor and runtime`, async () => {
      activePage = mike;
      await mike.reload();
      await waitForDoc(mike);
      dialog = await openInviteDialog(mike, false);
      const text = await dialog.innerText();
      assert.match(text, /Ada — nominated by Izzy, confirmed by Mike Wolf/);
      assert.match(text, /Eric — invited by Mike Wolf/);
      assert.match(text, /Izzy — added by Eric/);
      assert.match(text, new RegExp(`Izzy states this is them|${SAM_EMAIL}`));
      assert.match(text, /Runs on ChatGPT \(OpenAI\)/);
      await mike.screenshot({ path: path.join(shots, `${tag}-7-provenance.png`) });
    });

    await check(`${tag}: removing Eric suspends his AI, and the dialog says so`, async () => {
      await dialog.getByRole('button', { name: 'Remove Eric' }).click();
      await dialog.locator('[data-status]', { hasText: /was removed/ }).waitFor();
      await dialog.locator('[data-agent-rows] .ip-row[data-suspended="1"]').waitFor();
      assert.match(await dialog.locator('[data-agents]').innerText(), /Suspended: the person who added it is no longer on this document/);
      await mike.screenshot({ path: path.join(shots, `${tag}-8-suspended.png`) });
      const quiet = await agent(base, slug, izzyKey, 'GET', '/state');
      assert.equal(quiet.status, 401, 'the AI goes quiet with its sponsor');
      await dialog.page().locator('#share-dialog').getByRole('button', { name: 'Close share dialog' }).click();
    });

    await samCtx.close();
    await adaCtx.close();
    await ericCtx.close();
    await mikeCtx.close();

    // ---------------------------------------------------------------- phone 390
    const ptag = `cross-invite-${style}-phone-390x844`;
    const viewport = { width: 390, height: 844 };
    const phoneOpts = { ...devices['iPhone 13'], viewport, screen: viewport, hasTouch: true, isMobile: true };
    const pCtx = await newContext(browser, base, phoneOpts);
    const pMike = await signIn(pCtx, cli, base, MIKE_EMAIL);
    activePage = pMike;
    const phoneSlug = (await pMike.evaluate(async md => (await fetch('/library/api/documents', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Phone cross invitation', markdown: md }),
    })).json(), markdown)).slug;
    await openDoc(pMike, base, phoneSlug);

    let phoneKey = '';
    await check(`${ptag}: ⋯ → Add agent takes a name and a runtime, and the dialog fits the phone`, async () => {
      const agents = await openAgentDialog(pMike, true);
      phoneKey = await addAgent(agents, 'Izzy', RUNTIME);
      const info = await pMike.evaluate(() => ({ cw: document.documentElement.clientWidth, r: document.querySelector('#agent-key-dialog').getBoundingClientRect().toJSON() }));
      assert.ok(info.r.left >= 0 && info.r.right <= info.cw + 1, `the dialog fits: ${JSON.stringify(info)}`);
      assert.match(await agents.locator('.key-row', { hasText: 'Izzy' }).first().innerText(), /Added by Mike Wolf/);
      await pMike.screenshot({ path: path.join(shots, `${ptag}-1-add-agent.png`) });
      await agents.page().locator('#share-dialog').getByRole('button', { name: 'Close share dialog' }).click();
    });

    await check(`${ptag}: a nomination is answerable on the phone, and the dialog does not scroll sideways`, async () => {
      const nominated = await agent(base, phoneSlug, phoneKey, 'POST', '/team/nominations', {
        email: ADA_EMAIL, name: 'Ada', why: 'Ada owns this section and should see it.',
      });
      assert.equal(nominated.status, 201, JSON.stringify(nominated.body).slice(0, 300));
      await pMike.reload();
      await waitForDoc(pMike);
      const d = await openInviteDialog(pMike, true);
      const section = d.locator('[data-nominations]');
      await section.waitFor({ state: 'visible' });
      const info = await pMike.evaluate(() => ({
        sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
        r: document.querySelector('#invite-person-dialog').getBoundingClientRect().toJSON(),
      }));
      assert.ok(info.sw <= info.cw + 1, `no sideways scroll: ${JSON.stringify(info)}`);
      assert.ok(info.r.left >= 0 && info.r.right <= info.cw + 1, `the dialog fits: ${JSON.stringify(info)}`);
      await pMike.screenshot({ path: path.join(shots, `${ptag}-2-nomination.png`) });
      await section.getByRole('button', { name: /^Confirm Ada/ }).tap();
      await d.locator('[data-status]', { hasText: /was invited/ }).waitFor();
      assert.equal(mails().at(-1).to, ADA_EMAIL);
      assert.match(await d.innerText(), /Ada — nominated by Izzy, confirmed by Mike Wolf/);
      await pMike.screenshot({ path: path.join(shots, `${ptag}-3-confirmed.png`) });
      await d.page().locator('#share-dialog').getByRole('button', { name: 'Close share dialog' }).click();
    });
    await pCtx.close();
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
console.log(`\n${results.length - failures}/${results.length} cross-invitation checks passed`);
process.exit(failures ? 1 : 0);
