#!/usr/bin/env node
// ac-2xr: Large API-created document — AI comment anchors must not leak as raw HTML in the page.
// Models the SRMW reading-room failure locally: POST /share/markdown (~320k chars, ~2500 blocks),
// 32 POST /api/agent/<slug>/marks/comment (ai:*) before any browser, 2 suggest-insert + owner reject,
// then Playwright asserts the editor shows no literal `data-by=` or `<span`.
// The check also requires all 32 comments to be live in the editor and highlighted, so it cannot pass
// because the comments never anchored. `--mutation leak` plants one literal anchor in the seeded text;
// the check must FAIL under it, which proves the detector can see a leak.
// Usage:
//   node scripts/large-doc-comments-check.mjs [--variant full|no-reject|small] [--runs N] [--style proof|playmaker] [--mutation leak]
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { keepBottomChat } from './keep-bottom-chat.mjs';
import { showWholeAccord } from './review-ui.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const shots = path.join(root, '.preview');
mkdirSync(shots, { recursive: true });

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const variant = arg('--variant', 'full');
const runs = Math.max(1, Number(arg('--runs', '1')) || 1);
const style = arg('--style', 'proof');
const mutation = arg('--mutation', null);

const clientHeaders = {
  'Content-Type': 'application/json',
  'X-Proof-Client-Version': '0.34.0',
  'X-Proof-Client-Build': 'test',
  'X-Proof-Client-Protocol': '3',
};

const TARGET_CHARS = 320_000;
const TARGET_BLOCKS = 2_500;
const COMMENT_COUNT = 32;

let failures = 0;

function buildLargeMarkdown(blockCount, targetChars) {
  const header = '# Large document comments check\n\n';
  const blocks = [];
  for (let i = 0; i < blockCount; i += 1) {
    const anchor = `ANCHOR-${i}-seed`;
    blocks.push(`Block ${i} ${anchor} ${'x'.repeat(80)}.`);
  }
  let markdown = header + blocks.join('\n\n') + '\n';
  if (mutation === 'leak') {
    markdown = markdown.replace('Block 1 ', 'Block 1 `<span data-by="ai:planted">` ');
  }
  if (markdown.length < targetChars) {
    const pad = 'p'.repeat(targetChars - markdown.length);
    markdown = markdown.replace(/\.\n$/, `. ${pad}\n`);
  }
  return { markdown, blocks };
}

async function startServer(reviewStyle) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-large-doc-comments-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      PORT: String(port),
      COLLAB_EMBEDDED_WS: '1',
      PROOF_DEFAULT_REVIEW_STYLE: reviewStyle,
      PROOF_FEEDBACK_ENABLED: '0',
      DATABASE_PATH: path.join(temp, 'test.db'),
      SNAPSHOT_DIR: path.join(temp, 'snapshots'),
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 400));
    rmSync(temp, { recursive: true, force: true });
  };
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const health = await fetch(`${base}/health`).catch(() => null);
    if (health?.ok) return { base, stop };
    await new Promise(r => setTimeout(r, 150));
  }
  await stop();
  throw new Error('server did not start');
}

async function agentPost(base, slug, token, route, body) {
  const deadline = Date.now() + 120_000;
  const key = randomUUID();
  while (true) {
    const response = await fetch(`${base}/api/agent/${slug}${route}`, {
      method: 'POST',
      headers: { ...clientHeaders, 'x-share-token': token, 'Idempotency-Key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const json = await response.json().catch(() => ({}));
    if (response.status !== 409 || Date.now() >= deadline || json.code !== 'PROJECTION_STALE') {
      return { ok: response.ok, status: response.status, json };
    }
    await new Promise(r => setTimeout(r, 120));
  }
}

async function seedDocument(base, { blockCount, targetChars, withReject }) {
  const { markdown, blocks } = buildLargeMarkdown(blockCount, targetChars);
  assert.ok(markdown.length >= targetChars * 0.98, `markdown too short: ${markdown.length} vs ${targetChars}`);
  assert.equal(blocks.length, blockCount, 'block count');

  const createRes = await fetch(`${base}/api/share/markdown`, {
    method: 'POST',
    headers: clientHeaders,
    body: JSON.stringify({
      markdown,
      title: 'Large doc comments check',
      role: 'commenter',
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const createText = await createRes.text();
  assert.equal(createRes.status, 200, createText);
  const created = JSON.parse(createText);
  assert.ok(created.slug, 'slug');
  assert.ok(created.accessToken, 'accessToken');
  assert.ok(created.ownerSecret, 'ownerSecret');

  const commentToken = created.accessToken;
  const commentStep = Math.max(1, Math.floor(blockCount / COMMENT_COUNT));
  for (let c = 0; c < COMMENT_COUNT; c += 1) {
    const blockIndex = Math.min(blockCount - 1, 5 + c * commentStep);
    const quote = `ANCHOR-${blockIndex}-seed`;
    const model = `ai:model-${c % 8}`;
    const r = await agentPost(base, created.slug, commentToken, '/marks/comment', {
      quote,
      text: `Comment ${c} from ${model} on block ${blockIndex}.`,
      by: model,
    });
    assert.ok(r.ok, `comment ${c}: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  }

  if (withReject) {
    const insertBlocks = [Math.floor(blockCount * 0.12), Math.floor(blockCount * 0.88)];
    const insertIds = [];
    for (const bi of insertBlocks) {
      const quote = `ANCHOR-${bi}-seed`;
      const r = await agentPost(base, created.slug, commentToken, '/marks/suggest-insert', {
        quote,
        content: `\n\nProposed insert after block ${bi}.`,
        by: 'ai:proposer',
      });
      assert.ok(r.ok, `insert: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
      insertIds.push(r.json.markId);
    }
    for (const markId of insertIds) {
      const r = await agentPost(base, created.slug, created.ownerSecret, '/marks/reject', {
        markId,
        by: 'human:owner',
      });
      assert.ok(r.ok, `reject ${markId}: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    }
  }

  return { ...created, blockCount, charCount: markdown.length };
}

async function assertNoHtmlLeak(page, expectedComments) {
  await page.waitForFunction(
    () => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true,
    null,
    { timeout: 120_000 },
  );
  await page.waitForFunction(
    () => window.__proofLineMarks?.debugState().loaded === true,
    null,
    { timeout: 60_000 },
  );
  await showWholeAccord(page);
  await page.waitForTimeout(1500);

  const live = await page.evaluate(() => {
    const marks = (window.proof?.getAllMarks?.() ?? window.proof?.getMarks?.() ?? []).filter(m => m.kind === 'comment');
    const highlighted = marks.filter(m => document.querySelector(`.ProseMirror [data-mark-id="${CSS.escape(m.id)}"]`)).length;
    return { comments: marks.length, highlighted };
  });
  assert.ok(live.comments >= expectedComments, `only ${live.comments} of ${expectedComments} comments are live in the editor`);
  assert.ok(live.highlighted >= expectedComments, `only ${live.highlighted} of ${expectedComments} comments are highlighted in the page`);

  const leak = await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror');
    if (!pm) return { ok: false, reason: 'no ProseMirror' };
    const text = pm.innerText ?? '';
    const html = pm.textContent ?? '';
    const dataBy = text.includes('data-by=') || html.includes('data-by=');
    const spanTag = /\<\s*span\b/i.test(text) || /\<\s*span\b/i.test(html);
    const sample = (text.match(/data-by=[^\n]{0,80}/) ?? html.match(/data-by=[^\n]{0,80}/) ?? [''])[0];
    return { ok: !dataBy && !spanTag, dataBy, spanTag, sample, len: text.length };
  });
  assert.ok(leak.ok, `HTML leak: data-by=${leak.dataBy} span=${leak.spanTag} sample=${leak.sample} textLen=${leak.len}`);
}

async function runOnce(browser, runIndex) {
  const blockCount = variant === 'small' ? 40 : TARGET_BLOCKS;
  const targetChars = variant === 'small' ? 12_000 : TARGET_CHARS;
  const withReject = variant !== 'no-reject';
  const tag = `large-doc-comments-${variant}-${style}${mutation ? `-mutation-${mutation}` : ''}-run${runIndex}`;

  const server = await startServer(style);
  try {
    const doc = await seedDocument(server.base, { blockCount, targetChars, withReject });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === server.base ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto(`${server.base}/d/${doc.slug}`);
    await page.getByRole('button', { name: 'Continue anonymously', exact: true }).click({ timeout: 10_000 }).catch(() => {});
    await assertNoHtmlLeak(page, COMMENT_COUNT);
    await page.screenshot({ path: path.join(shots, `${tag}.png`) });
    assert.deepEqual(errors, []);
    console.log(`PASS ${tag}: ${doc.charCount} chars, ${doc.blockCount} blocks, comments=${COMMENT_COUNT}, reject=${withReject}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${tag}: ${error?.message?.split('\n')[0]}`);
  } finally {
    await server.stop();
  }
}

const browser = await chromium.launch({ headless: true });
keepBottomChat(browser);
try {
  for (let i = 1; i <= runs; i += 1) {
    await runOnce(browser, i);
  }
} finally {
  await browser.close();
}
console.log(failures ? `large-doc-comments-check: ${failures} FAILED` : 'large-doc-comments-check: all passed');
process.exit(failures ? 1 : 0);
