#!/usr/bin/env node
// Interaction fixes from the 2026-09-28 usability test, on a local scratch copy of
// the estate plan (scripts/fixtures/estate-plan-sep23-26ksoubn.md).
//
// Viewports: phone 390x844 with touch, and desktop 1280x800 with the keyboard.
// Videos land in .preview/fixes-2026-09-28/<label>/.
//
//   node scripts/interaction-fixes-check.mjs              # assert, label "after"
//   node scripts/interaction-fixes-check.mjs --record-only --label before
//
// --record-only keeps going after a failed check and exits 0, so a base-commit
// run can save the before videos. The asserting run exits 1 if any check fails.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const recordOnly = args.includes('--record-only');
const label = args.includes('--label') ? args[args.indexOf('--label') + 1] : 'after';
const outDir = path.join(root, '.preview', 'fixes-2026-09-28', label);
mkdirSync(outDir, { recursive: true });
const markdown = readFileSync(path.join(root, 'scripts/fixtures/estate-plan-sep23-26ksoubn.md'), 'utf8');
const headers = {
  'Content-Type': 'application/json',
  'X-Proof-Client-Version': '0.34.0',
  'X-Proof-Client-Build': 'test',
  'X-Proof-Client-Protocol': '3',
};
const results = [];

function note(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    note(name, true, detail || '');
  } catch (error) {
    note(name, false, error?.message?.split('\n')[0] || String(error));
  }
}

/** Runs every scenario. The asserting run fails if any scenario failed; --record-only keeps going. */
async function scenarios(pairs) {
  for (const [name, fn] of pairs) {
    try {
      await fn();
      note(name, true, '');
    } catch (error) {
      note(name, false, error?.message?.split('\n')[0] || String(error));
    }
  }
}

async function startServer() {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'accord-fixes-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      PORT: String(port), COLLAB_EMBEDDED_WS: '1', PROOF_DEFAULT_REVIEW_STYLE: 'proof',
      PROOF_FEEDBACK_ENABLED: '1', SOMA_FEEDBACK_ENDPOINT: 'http://127.0.0.1:9/feedback',
      DATABASE_PATH: path.join(temp, 'test.db'), SNAPSHOT_DIR: path.join(temp, 'snapshots'),
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    rmSync(temp, { recursive: true, force: true });
  };
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const health = await fetch(`${base}/health`).catch(() => null);
    if (health?.ok) return { base, stop };
    await new Promise(r => setTimeout(r, 150));
  }
  await stop();
  throw new Error('server did not start');
}

async function createDoc(base) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers,
    body: JSON.stringify({ markdown, title: 'Estate organization: where we are, and the plan', role: 'commenter' }),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body.slice(0, 300));
  return JSON.parse(body);
}

async function openPage(browser, base, slug, kind, videoName) {
  const phone = kind === 'phone';
  const context = await browser.newContext({
    ...(phone ? devices['iPhone 13'] : {}),
    viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    hasTouch: phone,
    isMobile: phone,
    recordVideo: { dir: outDir, size: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 } },
  });
  await context.addInitScript(() => localStorage.setItem('proof-share-viewer-name', 'Guest Reader'));
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  await page.goto(`${base}/d/${slug}`);
  const anon = page.getByRole('button', { name: 'Continue anonymously', exact: true });
  if (await anon.isVisible().catch(() => false)) await anon.click();
  await page.waitForFunction(() => window.proof?.collabIsSynced === true
    && window.__proofFolding?.debugState().ready
    && window.__proofLineMarks?.debugState().loaded
    && window.__proofReadingWalk?.debugState().ready);
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  await page.waitForTimeout(300);
  return {
    context, page,
    async finish() {
      const video = page.video();
      await context.close();
      if (video) await video.saveAs(path.join(outDir, `${videoName}.webm`));
    },
  };
}

function lineHidden(page, snippet) {
  return page.evaluate(snippet => {
    const line = window.__proofLineMarks.lineList().find(l => l.text.includes(snippet));
    if (!line) return { missing: true };
    return { index: line.index, hidden: window.__proofFolding.isHidden(line.index), text: line.text.slice(0, 80) };
  }, snippet);
}

async function refold(page) {
  await page.keyboard.press('Escape');
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.evaluate(() => {
    history.replaceState(null, '', location.pathname + location.search);
    window.getSelection()?.removeAllRanges();
    const view = window.__editorView;
    if (view && !view.state.selection.empty) {
      const Sel = view.state.selection.constructor;
      view.dispatch(view.state.tr.setSelection(Sel.create(view.state.doc, 1)).setMeta('addToHistory', false));
    }
    window.__proofFolding?.foldAll?.({ record: false });
  });
  await page.waitForFunction(() => {
    const line = window.__proofLineMarks.lineList().find(l => l.text.includes('The board project'));
    return line && window.__proofFolding.isHidden(line.index) && !window.__proofFolding.debugState().whole;
  });
}

async function runFold(page, phone) {
  const where = phone ? 'phone' : 'desktop';
  await scenarios([
    [`${where} hash opens the section`, async () => {
      await refold(page);
      await page.evaluate(() => { location.hash = 'needs-your-hands'; });
      await page.waitForFunction(() => {
        const line = window.__proofLineMarks.lineList().find(l => l.text.includes('Only what needs your fingertip'));
        return line && !window.__proofFolding.isHidden(line.index);
      });
      assert.equal((await lineHidden(page, 'Only what needs your fingertip')).hidden, false, 'hash left the section folded');
      assert.equal((await lineHidden(page, 'The board project')).hidden, true, 'hash unfolded an unrelated section');
    }],
    [`${where} window.find opens the section`, async () => {
      await refold(page);
      const found = await page.evaluate(() => {
        const sel = window.getSelection();
        sel?.removeAllRanges();
        return window.find('Give the estate organization an owner seat', false, false, true);
      });
      assert.equal(found, true, 'window.find did not match the folded heading');
      await page.waitForFunction(() => {
        const line = window.__proofLineMarks.lineList().find(l => l.text.includes('estate-owner-seat'));
        return line && !window.__proofFolding.isHidden(line.index);
      });
      assert.equal((await lineHidden(page, 'The board project')).hidden, true, 'find unfolded an unrelated section');
    }],
    [`${where} in-app find opens the section`, async () => {
      await refold(page);
      if (phone) {
        await page.locator('#share-banner .share-pill-overflow').click();
        await page.getByRole('menuitem', { name: /^Find/ }).click();
      } else {
        await page.keyboard.press('Alt+e');
        await page.keyboard.press('f');
        await page.keyboard.press('Enter');
      }
      const find = page.getByPlaceholder('Find in this document');
      await find.waitFor({ state: 'visible' });
      await find.fill('Needs your hands');
      await find.press('Enter');
      await page.waitForFunction(() => {
        const line = window.__proofLineMarks.lineList().find(l => l.text.includes('fingertip'));
        return line && !window.__proofFolding.isHidden(line.index);
      });
    }],
    [`${where} outline opens the section`, async () => {
      await refold(page);
      if (phone) {
        await page.locator('#share-banner .share-pill-overflow').click();
        await page.getByRole('menuitem', { name: 'Outline', exact: true }).click();
      } else {
        await page.keyboard.press('Alt+v');
        await page.keyboard.press('o');
        await page.keyboard.press('Enter');
      }
      const outlineItem = page.locator('.accord-outline-item', { hasText: 'Needs your hands' });
      await outlineItem.waitFor({ state: 'visible' });
      if (phone) await outlineItem.tap();
      else await outlineItem.press('Enter');
      await page.waitForFunction(() => {
        const line = window.__proofLineMarks.lineList().find(l => l.text.includes('fingertip'));
        return line && !window.__proofFolding.isHidden(line.index);
      });
    }],
    [`${where} J opens the next section`, async () => {
      await refold(page);
      await page.evaluate(() => document.activeElement?.blur());
      for (let i = 0; i < 40; i++) {
        const at = await page.evaluate(() => window.__proofReadingWalk.focusIndex());
        if (at === 0) break;
        await page.keyboard.press('k');
      }
      await page.keyboard.press('j');
      await page.waitForFunction(() => {
        const line = window.__proofLineMarks.lineList().find(l => l.text.includes('The board project'));
        return line && !window.__proofFolding.isHidden(line.index);
      });
    }],
  ]);
}

async function selectText(page, snippet) {
  const ok = await page.evaluate(snippet => {
    const root = document.querySelector('.ProseMirror');
    if (!root) return false;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const at = node.textContent.indexOf(snippet);
      if (at < 0) continue;
      node.parentElement.scrollIntoView({ block: 'center' });
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + snippet.length);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return true;
    }
    return false;
  }, snippet);
  assert.equal(ok, true, `could not select “${snippet}”`);
}

async function runMobileComment(page) {
  // The words have to be on screen before the tap. Show the whole Accord, which the
  // base commit can do; the hash check is what opens one section.
  await page.evaluate(() => window.__proofFolding?.unfoldAll?.({ record: false }));
  await page.waitForFunction(() => {
    const line = window.__proofLineMarks.lineList().find(l => l.text.includes('Only what needs your fingertip'));
    return line && !window.__proofFolding.isHidden(line.index);
  });
  await page.waitForTimeout(400);
  await selectText(page, 'Only what needs your fingertip');
  const comment = page.locator('button[aria-label="Add comment on selected text"]');
  await comment.waitFor({ state: 'visible' });
  // The 28 September screenshots show the Feedback chip covering this button.
  // Put the chip there so the tap is the one that used to open Feedback.
  await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Add comment on selected text"]');
    const chip = document.querySelector('.soma-feedback-root');
    if (!btn || !chip) return;
    const r = btn.getBoundingClientRect();
    chip.style.top = `${r.top}px`;
    chip.style.left = `${Math.max(0, r.left - 8)}px`;
    chip.style.bottom = 'auto';
    chip.style.right = 'auto';
  });
  const hit = await comment.evaluate(el => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return {
      x, y,
      className: top?.className || '',
      label: top?.getAttribute?.('aria-label') || '',
      text: (top?.textContent || '').trim().slice(0, 40),
    };
  });
  assert.equal(hit.className.includes('soma-feedback'), false, `Feedback took the tap (${hit.className} ${hit.text})`);
  assert.equal(hit.label, 'Add comment on selected text', `top element was ${hit.label || hit.text}`);
  await page.touchscreen.tap(hit.x, hit.y);
  const composer = page.locator('.mark-popover-composer');
  await composer.waitFor({ state: 'visible' });
  assert.equal(await page.locator('.soma-feedback-panel').isVisible().catch(() => false), false, 'Feedback panel covered the composer');
  const box = await composer.locator('textarea').boundingBox();
  assert.ok(box, 'composer has no textarea');
  const composerHit = await composer.locator('textarea').evaluate(el => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(20, r.height / 2));
    return top === el || el.contains(top);
  });
  assert.equal(composerHit, true, 'something covers the composer');
  await composer.locator('textarea').fill('A comment from the phone.');
  const add = composer.getByRole('button', { name: 'Add', exact: true });
  await add.waitFor({ state: 'visible' });
  assert.equal(await add.isEnabled(), true, 'Add is disabled');
  const addBox = await add.boundingBox();
  await page.touchscreen.tap(addBox.x + addBox.width / 2, addBox.y + addBox.height / 2);
  await page.waitForFunction(() => window.proof.getAllMarks().some(m => m.kind === 'comment' && (m.data?.text || '').includes('phone')));
}

async function runDesktopComment(page) {
  await page.evaluate(() => window.__proofFolding?.unfoldAll?.({ record: false }));
  await page.waitForFunction(() => {
    const line = window.__proofLineMarks.lineList().find(l => l.text.includes('The board project'));
    return line && !window.__proofFolding.isHidden(line.index);
  });
  await page.evaluate(() => document.activeElement?.blur());
  const target = await page.evaluate(() => window.__proofLineMarks.lineList().find(l => l.text.includes('The board project')).index);
  for (let i = 0; i < 40; i++) {
    const at = await page.evaluate(() => window.__proofReadingWalk.focusIndex());
    if (at === target) break;
    await page.keyboard.press('j');
  }
  await page.keyboard.press('Shift+End');
  const selected = await page.evaluate(() => {
    const sel = window.__editorView.state.selection;
    const text = window.__editorView.state.doc.textBetween(sel.from, sel.to, '\n', '\n');
    return { empty: sel.empty, text };
  });
  assert.equal(selected.empty, false, 'Shift+End left an empty selection');
  assert.ok(selected.text.includes('board project') || selected.text.length > 10, `selection was “${selected.text.slice(0, 60)}”`);
  await page.keyboard.press('c');
  const composer = page.locator('.mark-popover-composer');
  await composer.waitFor({ state: 'visible' });
  await page.keyboard.type('A comment from the keyboard.');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => window.proof.getAllMarks().some(m => m.kind === 'comment' && (m.data?.text || '').includes('keyboard')));

  await page.keyboard.press('Escape');
  await page.keyboard.press('Alt+h');
  await page.keyboard.press('k');
  await page.keyboard.press('Enter');
  const dialog = page.locator('#keys-dialog, [role="dialog"]');
  await dialog.getByText('Comment on the selection, or on this line').waitFor({ state: 'visible' });
  await dialog.getByText('Shift+End / Shift+arrows').waitFor({ state: 'visible' });
}

const browser = await chromium.launch();
const server = await startServer();
let failed = false;
try {
  const created = await createDoc(server.base);
  const phoneFold = await openPage(browser, server.base, created.slug, 'phone', 'phone-fold-and-comment');
  const desktop = await openPage(browser, server.base, created.slug, 'desktop', 'desktop-keyboard-and-fold');
  try {
    // Fold checks first, on a document with no comments, so an open item cannot
    // make a line visible before the navigation that is supposed to open it.
    await runFold(phoneFold.page, true);
    await runFold(desktop.page, false);
    await check('phone comment by touch', () => runMobileComment(phoneFold.page));
    await check('desktop keyboard comment', () => runDesktopComment(desktop.page));
  } finally {
    await phoneFold.finish();
    await desktop.finish();
  }
} catch (error) {
  failed = true;
  if (recordOnly) note('run', false, error?.message?.split('\n')[0] || String(error));
  else throw error;
} finally {
  writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ label, recordOnly, results }, null, 2));
  await browser.close();
  await server.stop();
}
const bad = results.filter(r => !r.ok);
if (!recordOnly && (failed || bad.length)) {
  console.error(`${bad.length} check(s) failed`);
  process.exit(1);
}
console.log(`wrote ${outDir}`);
