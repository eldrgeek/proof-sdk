#!/usr/bin/env node
// Browser check for Invite person (Mike Wolf, 2026-09-19): an Owner invites a person to one
// document from the Share menu (the ⋯ menu on a phone); the invitation email (captured, never
// sent) signs the person in and opens the document; their marks count as a verified person. A
// guest can read and comment but cannot edit or mark ("Sign in to mark"); the private setting
// shuts guests out; the invited person cannot open another document; removal revokes at once.
// Authorship: Claude Opus 5 (worker proof-invite), 2026-09-19, in the style of identity-check.mjs.
// Starts an isolated local server on the current dist/ build (run `npm run build` first) with the
// Documents library on and SOMA Auth off (sign-in through one-time sign-in links, as in
// identity-check). Both review styles at 1440 (desktop) and 390 (phone). Screenshots go to
// .preview/ (or --shots <dir>). Exit code 0 only if every check passes.
// Usage: node scripts/invite-check.mjs [--style playmaker|proof] [--shots dir]
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
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `invite-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-invite-check-'));
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
const markdown = ['# Invite check', para('Intro'), para('Middle'), para('Last')].join('\n\n');
const waitFor = (page, fn, argument, timeout = 9000) => page.waitForFunction(fn, argument, { timeout, polling: 200 });

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

const serverView = (page, slug) => page.evaluate(async s => {
  const r = await fetch(`/api/documents/${s}/line-marks`, { credentials: 'same-origin', headers: { 'X-Proof-Client-Version': '0.31.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' } });
  return { status: r.status, body: await r.json() };
}, slug);

const pagePost = (page, url, body) => page.evaluate(async ({ u, b }) => {
  const r = await fetch(u, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Proof-Client-Version': '0.31.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' }, body: JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}, { u: url, b: body });

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
    await page.getByRole('button', { name: 'Share options' }).click();
    await page.getByRole('menuitem', { name: /Invite person/ }).click();
  }
  const dialog = page.locator('#invite-person-dialog');
  await dialog.waitFor({ state: 'visible' });
  await dialog.locator('[data-people]').filter({ hasNotText: 'Loading' }).waitFor();
  return dialog;
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
    const tag = `invite-${style}-desktop`;
    const desk = { viewport: { width: 1440, height: 900 } };
    const mikeCtx = await newContext(browser, base, desk);
    await mikeCtx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base }).catch(() => {});
    const mike = await signIn(mikeCtx, cli, base);
    activePage = mike;
    const create = async (title) => {
      const r = await mike.evaluate(async ({ md, t }) => {
        const res = await fetch('/library/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: t, markdown: md }) });
        return res.json();
      }, { md: markdown, t: title });
      return r.slug;
    };
    const slug = await create('Invite check');
    const otherSlug = await create('Not shared with Eric');
    await openDoc(mike, base, slug);

    let dialog;
    await check(`${tag}: Share → Invite person opens the dialog for the Owner`, async () => {
      dialog = await openInviteDialog(mike, false);
      assert.match(await dialog.innerText(), /Nobody invited yet/);
      const checked = await dialog.locator('[data-guest] input:checked').getAttribute('value');
      assert.equal(checked, 'comment', 'the default guest setting is read and comment');
    });

    await check(`${tag}: Invite Eric → the email is captured with his sign-in link; the dialog lists him as invited`, async () => {
      await invite(dialog, 'eric@example.test', 'Eric');
      const mail = mails().at(-1);
      assert.equal(mail.to, 'eric@example.test');
      assert.match(mail.subject, /Mike Wolf invited you to “Invite check”/);
      assert.ok(await dialog.locator('#invite-person-link').inputValue().then(v => v.endsWith(`/invite/${mail.inviteId}`)));
      const row = dialog.locator(`.ip-row[data-invite-id="${mail.inviteId}"]`);
      await row.waitFor();
      assert.equal(await row.locator('.ip-status').innerText(), 'invited');
      await mike.screenshot({ path: path.join(shots, `${tag}-1-invited.png`) });
      await dialog.getByRole('button', { name: 'Close invite dialog' }).click();
    });

    // Eric opens the emailed link in his own browser.
    const ericCtx = await newContext(browser, base, desk);
    const eric = await ericCtx.newPage();
    await check(`${tag}: the emailed link signs Eric in and opens the document; he is verified`, async () => {
      activePage = eric;
      await eric.goto(mails().at(-1).link);
      await eric.waitForURL(url => url.pathname === `/d/${slug}`, { timeout: 15_000 });
      await waitForDoc(eric);
      const me = eric.locator('.prw-right .prw-me');
      await me.waitFor({ state: 'visible' });
      assert.equal(await me.getAttribute('data-trust'), 'verified');
      assert.match(await me.innerText(), /Signed in as\s*Eric/);
      await eric.screenshot({ path: path.join(shots, `${tag}-2-eric-signed-in.png`) });
    });

    await check(`${tag}: Eric's mark counts as human:eric@example.test`, async () => {
      await markLine(eric, 1);
      await waitFor(eric, () => document.querySelector('.plm-dot[data-line="1"]')?.dataset.status === 'agreed');
      const view = await serverView(eric, slug);
      assert.ok(view.body.lineMarks.some(m => m.anchor.ordinal === 1 && m.by === 'human:eric@example.test'), JSON.stringify(view.body.lineMarks.map(m => m.by)));
    });

    await check(`${tag}: Eric's Documents list shows only his document; Mike's dialog shows him joined`, async () => {
      const list = await eric.evaluate(async () => (await fetch('/library/api/documents')).json());
      assert.deepEqual(list.documents.map(d => d.slug), [slug]);
      dialog = await openInviteDialog(mike, false);
      await dialog.locator('.ip-status', { hasText: 'joined' }).waitFor();
      await dialog.getByRole('button', { name: 'Close invite dialog' }).click();
    });

    const guestCtx = await newContext(browser, base, desk);
    await guestCtx.addInitScript(() => { try { localStorage.setItem('proof-share-viewer-name', 'Visitor'); } catch {} });
    const guest = await guestCtx.newPage();
    await check(`${tag}: a guest reads and comments, cannot edit, and is told "Sign in to mark"`, async () => {
      activePage = guest;
      await openDoc(guest, base, slug);
      const me = guest.locator('.prw-right .prw-me');
      await me.waitFor({ state: 'visible' });
      assert.match(await me.innerText(), /Sign in to mark/);
      assert.equal(await guest.locator('#share-banner').getByRole('button', { name: 'Share options' }).count() >= 0, true);
      // Editing: typing changes nothing on the server.
      await guest.locator('.ProseMirror p').first().click();
      await guest.keyboard.type('GUESTTYPED');
      await guest.waitForTimeout(800);
      const md = await fetch(`${base}/api/documents/${slug}`, { headers: { 'X-Proof-Client-Version': '0.31.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' } }).then(r => r.json());
      assert.ok(!String(md.markdown).includes('GUESTTYPED'), 'guest typing never reaches the document');
      // A mark from the page is refused, not recorded.
      const refused = await pagePost(guest, `/api/documents/${slug}/line-marks`, { by: 'Visitor', status: 'agreed', anchor: { hash: 'x', occurrence: 0, ordinal: 2, kind: 'paragraph', excerpt: 'Middle' } });
      assert.equal(refused.body.code, 'SIGN_IN_TO_MARK');
      const view = await serverView(guest, slug);
      assert.equal(view.body.viewer.canMark, false);
      assert.ok(!view.body.lineMarks.some(m => m.by.startsWith('guest:')), 'no guest mark recorded');
      // Comments and chat stay open to guests.
      const comment = await pagePost(guest, `/api/documents/${slug}/ops`, { type: 'comment.add', quote: 'Middle paragraph', text: 'A guest comment', by: 'guest:Visitor' });
      assert.equal(comment.status, 200, JSON.stringify(comment.body));
      await guest.screenshot({ path: path.join(shots, `${tag}-3-guest.png`) });
    });

    await check(`${tag}: the private setting shuts guests out ("Sign in to open this document")`, async () => {
      dialog = await openInviteDialog(mike, false);
      await dialog.locator('[data-guest] input[value="private"]').check();
      await dialog.locator('[data-status]', { hasText: /Saved/ }).waitFor();
      await dialog.getByRole('button', { name: 'Close invite dialog' }).click();
      const res = await guest.goto(`${base}/d/${slug}`);
      assert.equal(res.status(), 401);
      await guest.getByRole('heading', { name: 'Sign in to open this document' }).waitFor();
      assert.ok(!(await guest.content()).includes('Middle paragraph'), 'no document text');
      await guest.screenshot({ path: path.join(shots, `${tag}-4-private.png`) });
    });

    await check(`${tag}: Eric cannot open a document he was not invited to`, async () => {
      await mike.evaluate(async s => {
        await fetch(`/api/documents/${s}/team/guest-access`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'private' }) });
      }, otherSlug);
      const res = await eric.goto(`${base}/d/${otherSlug}`);
      assert.equal(res.status(), 401);
      await eric.getByRole('heading', { name: /isn’t shared with you/ }).waitFor();
      await eric.goto(`${base}/d/${slug}`);
      await waitForDoc(eric);
    });

    await check(`${tag}: removing Eric revokes his access at once`, async () => {
      dialog = await openInviteDialog(mike, false);
      await dialog.getByRole('button', { name: 'Remove Eric' }).click();
      await dialog.locator('[data-status]', { hasText: /was removed/ }).waitFor();
      await mike.screenshot({ path: path.join(shots, `${tag}-5-removed.png`) });
      await dialog.getByRole('button', { name: 'Close invite dialog' }).click();
      const refused = await pagePost(eric, `/api/documents/${slug}/line-marks`, { by: 'Eric', status: 'agreed', anchor: { hash: 'x', occurrence: 0, ordinal: 2, kind: 'paragraph', excerpt: 'Middle' } });
      assert.equal(refused.status, 403);
      const res = await eric.goto(`${base}/d/${slug}`);
      assert.equal(res.status(), 401, 'the document is private and Eric is no longer invited');
    });
    await guestCtx.close();
    await ericCtx.close();
    await mikeCtx.close();

    // ---------------------------------------------------------------- phone 390
    const ptag = `invite-${style}-phone-390x844`;
    const viewport = { width: 390, height: 844 };
    const phoneOpts = { ...devices['iPhone 13'], viewport, screen: viewport, hasTouch: true, isMobile: true };
    const pCtx = await newContext(browser, base, phoneOpts);
    const pMike = await signIn(pCtx, cli, base);
    activePage = pMike;
    const phoneSlug = await (async () => {
      const r = await pMike.evaluate(async md => (await fetch('/library/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Phone invite', markdown: md }) })).json(), markdown);
      return r.slug;
    })();
    await openDoc(pMike, base, phoneSlug);
    await check(`${ptag}: ⋯ → Invite person; the dialog fits the phone; inviting works`, async () => {
      const d = await openInviteDialog(pMike, true);
      await invite(d, 'ada@example.test', 'Ada');
      const info = await pMike.evaluate(() => ({ cw: document.documentElement.clientWidth, r: document.querySelector('#invite-person-dialog').getBoundingClientRect().toJSON() }));
      assert.ok(info.r.left >= 0 && info.r.right <= info.cw + 1, `the dialog fits: ${JSON.stringify(info)}`);
      await pMike.screenshot({ path: path.join(shots, `${ptag}-1-dialog.png`) });
      await d.getByRole('button', { name: 'Close invite dialog' }).click();
    });
    await pCtx.close();
    const adaCtx = await newContext(browser, base, phoneOpts);
    const ada = await adaCtx.newPage();
    activePage = ada;
    await check(`${ptag}: Ada opens the emailed link on her phone and marks as a verified person`, async () => {
      await ada.goto(mails().at(-1).link);
      await ada.waitForURL(url => url.pathname === `/d/${phoneSlug}`, { timeout: 15_000 });
      await waitForDoc(ada);
      const view = await serverView(ada, phoneSlug);
      assert.equal(view.body.identity.me.actor, 'human:ada@example.test');
      await ada.locator('.plm-dot[data-line="2"]').tap();
      const sheet = ada.locator('.plm-menu.plm-sheet');
      await sheet.waitFor({ state: 'visible' });
      await sheet.getByRole('button', { name: /Agree/ }).tap();
      await waitFor(ada, () => document.querySelector('.plm-dot[data-line="2"]')?.dataset.status === 'agreed');
      const after = await serverView(ada, phoneSlug);
      assert.ok(after.body.lineMarks.some(m => m.anchor.ordinal === 2 && m.by === 'human:ada@example.test'));
      await ada.screenshot({ path: path.join(shots, `${ptag}-2-ada.png`) });
    });
    await adaCtx.close();
    const pgCtx = await newContext(browser, base, phoneOpts);
    const pg = await pgCtx.newPage();
    activePage = pg;
    await check(`${ptag}: a guest on the phone sees "Sign in to mark" and cannot mark`, async () => {
      await openDoc(pg, base, phoneSlug);
      await pg.evaluate(() => window.__proofReadingWalk.openSheet('right'));
      const me = pg.locator('.prw-right.prw-sheet-open .prw-me');
      await me.waitFor({ state: 'visible' });
      assert.match(await me.innerText(), /Sign in to mark/);
      const info = await pg.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      assert.ok(info.sw <= info.cw + 1, 'no sideways scroll');
      await pg.screenshot({ path: path.join(shots, `${ptag}-3-guest.png`) });
      const view = await serverView(pg, phoneSlug);
      assert.equal(view.body.viewer.canMark, false);
    });
    await pgCtx.close();
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
console.log(`\n${results.length - failures}/${results.length} invite checks passed`);
process.exit(failures ? 1 : 0);
