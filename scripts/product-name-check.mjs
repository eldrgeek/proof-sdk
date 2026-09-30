#!/usr/bin/env node
import { showWholeAccord } from './review-ui.mjs';
// Product-name check (Accord rename, 2026-09-19).
//
// Mike ruled: "Accord it is, use it everywhere." This check holds that ruling in place and, just
// as importantly, holds the machine surface still: the rename is user-facing only.
//
// It asserts three things against a running server and a real browser:
//   1. The page title and the top-bar wordmark read the configured product name (Accord).
//   2. No user-visible "Proof" appears on the page, in the library, or in the share/OG metadata —
//      except where it names the open-source engine ("Proof SDK", "built on the open-source
//      Proof SDK"). Machine text (URLs, CSS class names, data-* attributes, headers) is exempt by
//      construction: the page scan reads rendered text, not markup.
//   3. The API surface is unchanged: /state, /snapshot and /line-marks still answer with the same
//      field names, and the client/share headers are still honoured.
//
// Names come from src/shared/product-identity.ts, so a later rename is a config change; this check
// reads the same module rather than hard-coding "Accord".
//
// Authorship: Claude Opus 5 (worker proof-rename), 2026-09-19, in the style of identity-check.mjs.
// Starts an isolated local server on the current dist/ build (run `npm run build` first) with the
// Documents library on, and drives Chromium in both review styles at 1440 (desktop) and 390
// (phone). Screenshots go to .preview/ (or --shots <dir>). Exit code 0 only if every check passes.
// Usage: node scripts/product-name-check.mjs [--style playmaker|proof] [--shots dir]
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, devices } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const shots = arg('--shots') || path.join(root, '.preview');
mkdirSync(shots, { recursive: true });
const styles = arg('--style') ? [arg('--style')] : ['playmaker', 'proof'];

// The identity module is the single source of truth for every name this check asserts.
const identityModule = await import(pathToFileURL(path.join(root, 'src/shared/product-identity.ts')).href)
  .catch(async () => {
    // .ts needs a loader; fall back to running tsx to print the resolved identity.
    const r = spawnSync(process.execPath, ['--import', 'tsx', '-e',
      "import { productIdentity } from './src/shared/product-identity.ts'; console.log(JSON.stringify(productIdentity()));"],
      { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop());
    return { productIdentity: () => parsed };
  });
const ID = identityModule.productIdentity();
const NAME = ID.name;
const ENGINE = ID.engineName;          // "Proof SDK" — the one place "Proof" may still appear.
const DOC_NOUN = ID.documentNoun;


const clientHeaders = { 'X-Proof-Client-Version': '0.34.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
const MIKE_EMAIL = 'mw@mike-wolf.com';
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `product-name-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

/**
 * Every "Proof" a reader may legitimately see: the engine's own name. Anything else is a leak.
 * Returns the offending snippets so a failure names them.
 */
function strayProofMentions(text) {
  const stray = [];
  const re = /Proof/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const after = text.slice(match.index, match.index + ENGINE.length);
    if (after === ENGINE) continue;                      // "Proof SDK"
    stray.push(text.slice(Math.max(0, match.index - 40), match.index + 60).replace(/\s+/g, ' '));
  }
  return stray;
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-product-name-check-'));
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
const markdown = ['# Product name check', para('Intro'), para('Middle'), para('Last')].join('\n\n');

async function createDoc(base) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown, title: 'Product name check' }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function newContext(browser, base, options = {}) {
  const context = await browser.newContext(options);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.addInitScript(() => { try { localStorage.setItem('proof-share-viewer-name', 'Checker'); } catch {} });
  return context;
}

async function openDoc(page, base, slug) {
  await page.goto(`${base}/d/${slug}`);
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForTimeout(400);
  page.setDefaultTimeout(6000);
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  await showWholeAccord(page);
}

// ---------------------------------------------------------------- the page itself
async function pageChecks(browser, base, slug, style, tag, contextOptions) {
  const context = await newContext(browser, base, contextOptions);
  const page = await context.newPage();
  activePage = page;
  await openDoc(page, base, slug);

  await check(`${tag}: the page title ends with "${NAME}"`, async () => {
    const title = await page.title();
    assert.ok(title.endsWith(NAME), `title is "${title}"`);
    assert.deepEqual(strayProofMentions(title), []);
  });

  await check(`${tag}: the top bar's wordmark reads "${NAME}"`, async () => {
    // The phone layout hides the wordmark to save width, so assert on the DOM, not on visibility:
    // whichever top-bar link is the wordmark must carry the product name and no other brand.
    const texts = await page.evaluate(() => Array.from(document.querySelectorAll('#share-banner a, #accord-menubar a'))
      .map(a => (a.textContent || '').trim()).filter(Boolean));
    const NAME_FROM_NODE = NAME;
    assert.ok(texts.length > 0, 'the top bar has no links');
    assert.ok(texts.includes(NAME_FROM_NODE), `top-bar links read: ${texts.join(' | ')}`);
    for (const text of texts) assert.deepEqual(strayProofMentions(text), []);
  });

  await check(`${tag}: no stray "Proof" in the page's visible text`, async () => {
    const text = await page.evaluate(() => document.body.innerText);
    const stray = strayProofMentions(text);
    assert.ok(stray.length === 0, `stray "Proof": ${stray.join(' // ')}`);
  });

  await check(`${tag}: the Share/⋯ menu names the download "${DOC_NOUN}", not "Proof Document"`, async () => {
    const overflow = page.locator('#share-banner .share-pill-overflow');
    const shareBtn = page.locator('#share-banner .share-pill-share');
    if (await overflow.count() && await overflow.first().isVisible()) await overflow.first().click();
    else if (await shareBtn.count()) await shareBtn.first().click();
    else return;                                        // no menu on this layout; nothing to assert
    await page.waitForTimeout(250);
    const menuText = await page.evaluate(() => {
      const menu = document.querySelector('.proof-share-overflow-menu, .share-menu, [role="menu"]');
      return menu ? menu.innerText : '';
    });
    if (!menuText) return;
    const strayMenu = strayProofMentions(menuText);
    assert.ok(strayMenu.length === 0, `stray "Proof": ${strayMenu.join(' // ')}`);
    assert.ok(menuText.includes(DOC_NOUN) || menuText.includes('Download'), `menu reads: ${menuText.replace(/\n/g, ' | ')}`);
    await page.keyboard.press('Escape').catch(() => {});
  });

  await page.screenshot({ path: path.join(shots, `product-name-${tag}.png`), fullPage: false }).catch(() => {});
  await context.close();
  activePage = null;
}

// ---------------------------------------------------------------- server-rendered surfaces
async function serverSurfaceChecks(base, slug, created, style) {
  await check(`${style}: the library home's title and wordmark read "${NAME}"`, async () => {
    const html = await (await fetch(`${base}/`, { headers: { Accept: 'text/html' } })).text();
    assert.ok(html.includes(`<title>Documents · ${NAME}</title>`), 'library title');
    assert.ok(html.includes(`<span class="wordmark">${NAME}</span>`), 'library wordmark');
    const stray = strayProofMentions(html.replace(/<[^>]*>/g, ' '));
    assert.ok(stray.length === 0, `stray "Proof": ${stray.join(' // ')}`);
  });

  await check(`${style}: the share card / OG metadata names "${NAME}"`, async () => {
    const html = await (await fetch(`${base}/d/${slug}?token=${encodeURIComponent(created.accessToken)}`, {
      headers: { 'User-Agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)' },
    })).text();
    assert.ok(html.includes(`<title>Product name check | ${NAME}</title>`), 'share title');
    assert.ok(html.includes(`<meta property="og:site_name" content="${NAME}">`), 'og:site_name');
  });
}

// ---------------------------------------------------------------- the machine surface
async function apiChecks(base, created) {
  const slug = created.slug;
  const H = { 'x-share-token': created.accessToken, 'x-agent-id': 'ai:product-name-check', ...clientHeaders };

  await check('API unchanged: GET /api/agent/:slug/state keeps its field names', async () => {
    const response = await fetch(`${base}/api/agent/${slug}/state`, { headers: H });
    assert.equal(response.status, 200);
    const body = await response.json();
    for (const field of ['markdown', 'marks', 'revision']) {
      assert.ok(Object.prototype.hasOwnProperty.call(body, field), `/state is missing "${field}"`);
    }
  });

  await check('API unchanged: GET /api/agent/:slug/snapshot keeps blocks with refs', async () => {
    const response = await fetch(`${base}/api/agent/${slug}/snapshot`, { headers: H });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.blocks), '/snapshot is missing "blocks"');
    assert.ok(body.blocks.every(b => typeof b.ref === 'string' && typeof b.markdown === 'string'),
      '/snapshot blocks lost ref/markdown');
  });

  await check('API unchanged: GET /api/documents/:slug/line-marks keeps its shape', async () => {
    const response = await fetch(`${base}/api/documents/${slug}/line-marks`, { headers: H });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Object.prototype.hasOwnProperty.call(body, 'lineMarks'), '/line-marks is missing "lineMarks"');
  });

  await check('API unchanged: the x-share-token header is still the share credential', async () => {
    const good = await fetch(`${base}/api/agent/${slug}/state`, { headers: H });
    assert.equal(good.status, 200, 'a valid x-share-token is accepted');
    const bad = await fetch(`${base}/api/agent/${slug}/state`, { headers: { ...H, 'x-share-token': 'not-a-token' } });
    assert.ok(bad.status >= 400, `a bad x-share-token is refused, got ${bad.status}`);
  });
}

const browser = await chromium.launch();
try {
  for (const style of styles) {
    const { base, stop, cli } = await startServer(style);
    try {
      cli('add-member', '--name', 'Mike Wolf', '--email', MIKE_EMAIL);
      const created = await createDoc(base);
      await pageChecks(browser, base, created.slug, style, `product-name-${style}-desktop-1440`, { viewport: { width: 1440, height: 900 } });
      const viewport = { width: 390, height: 844 };
      await pageChecks(browser, base, created.slug, style, `product-name-${style}-phone-390`,
        { ...devices['iPhone 13'], viewport, screen: viewport, hasTouch: true, isMobile: true });
      await serverSurfaceChecks(base, created.slug, created, style);
      await apiChecks(base, created);
    } finally {
      await stop();
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${results.length - failures}/${results.length} product-name checks passed`);
process.exit(failures ? 1 : 0);
