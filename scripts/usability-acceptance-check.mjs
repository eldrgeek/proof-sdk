#!/usr/bin/env node
// Accord usability S6a — independent acceptance harness for the brief's twelve checks
// (docs/accord/usability-brief-2026-09-23.md, "Acceptance checks").
//
// Starts an isolated local server (run `npm run build` first), builds a review fixture through
// the agent API, and drives Chromium at 1280×800 and 375×812. One line per case: PASS, FAIL, or
// SKIP. Exit non-zero if any case FAILs.
//
// Usage: node scripts/usability-acceptance-check.mjs [--shots dir]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
import { hoverChangesNothing, selectPassage } from './usability-s1-assertions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const shots = arg('--shots') || path.join(root, '.preview', 'usability');
mkdirSync(shots, { recursive: true });

/** Selectors from src/ui — one adapter; TODO entries await S2/S3/S4 UI. */
const SEL = {
  proseMirror: '.ProseMirror',
  foldChip: '.pfold-chip[data-heading]',
  marginDot: '.plm-dot[data-line]',
  rail: '.prw-right',
  lineBox: '.prw-linebox',
  railActions: '.prw-right .plm-actions',
  sectionNote: '.prw-right .plm-section-note',
  sectionHint: '.prw-right .plm-section-hint',
  scrollProvisional: '.prw-right .prw-provisional',
  statusBar: '.pst-bar',
  statusProvisional: '.pst-bar .pst-provisional',
  openToggle: '.aov-toggle',
  openSegment: '.aov-toggle .aov-seg',
  honestHeader: '.aov-header',
  honestHeaderText: '.aov-header-text',
  issuesPill: '.plm-issues',
  issuesCount: '.plm-issues-count',
  nextIssue: '#share-banner .plm-next',
  shareBanner: '#share-banner',
  navigatorTab: '.prw-left .anv-tab[data-tab]',
  threadComposer: '.amg-thread-new',
  threadCard: '.amg-thread',
  playmakerReviewPanel: '.pm-review-panel',
  // TODO S2 — Review list beside the document (replaces Issues pill queue).
  reviewPanelToggle: '[data-accord-review-toggle]',
  reviewList: '[data-accord-review-list]',
  reviewScopeNeedsYou: '[data-accord-review-scope="needs-you"]',
  reviewClearCompleted: '[data-accord-review-clear-completed]',
  // TODO S3 — inline draft until Propose change.
  suggestChangeButton: '[data-accord-suggest-change]',
  proposeChangeButton: '[data-accord-propose-change]',
  draftResume: '[data-accord-draft-resume]',
  draftDiscard: '[data-accord-draft-discard]',
  // TODO S4 — unified status copy ("finished reviewing", rejecter not "unread").
  personalCompletionStatus: '[data-accord-review-complete-status]',
};

const clientHeaders = { 'X-Proof-Client-Version': '0.31.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
const DESKTOP = { width: 1280, height: 800 };
const PHONE = devices['iPhone 13'];

let failures = 0;
const results = [];
let activePage = null;

function skip(name, reason) {
  results.push(`SKIP ${name} (${reason})`);
  console.log(results[results.length - 1]);
}

async function check(name, fn) {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    results.push(`FAIL ${name}: ${String(error?.message ?? error).split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `usability-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer() {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-usability-accept-'));
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

const para = (section, n) => `${section} paragraph ${n} is plain text for the usability acceptance fixture; it is long enough to read as a real passage in the document.`;
const SAFE_LINE = 'The platform keeps customer data safe during routine maintenance every quarter of the year.';
const PROPOSAL_LINE = 'Section two paragraph two carries the change word for a pending proposal from participant B.';
const THREAD_LINE = 'Section three paragraph two hosts an open discussion thread from participant B.';
const markdown = [
  '# Usability acceptance fixture',
  para('Intro', 1),
  para('Intro', 2),
  '## Section one',
  para('One', 1),
  SAFE_LINE,
  para('One', 3),
  para('One', 4),
  '- First list item in section one',
  '- Second list item in section one',
  '## Section two',
  para('Two', 1),
  PROPOSAL_LINE,
  para('Two', 3),
  para('Two', 4),
  para('Two', 5),
  para('Two', 6),
  '## Section three',
  para('Three', 1),
  THREAD_LINE,
  para('Three', 3),
  para('Three', 4),
  para('Three', 5),
  para('Three', 6),
].join('\n\n');

/** Filled from GET /state after the fixture is written (one block per line). */
let L = {};

const agentHeaders = (token) => ({ 'Content-Type': 'application/json', ...clientHeaders, 'x-share-token': token });
async function agent(base, created, route, body, method = 'POST') {
  const r = await fetch(`${base}/api/agent/${created.slug}${route}`, {
    method,
    headers: { ...agentHeaders(created.ownerSecret), 'Idempotency-Key': `k-${Date.now()}-${Math.random()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  assert.ok(r.ok || r.status === 202, `${route}: ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function createFixture(base) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown, title: 'Usability acceptance fixture' }),
  });
  assert.equal(response.status, 200);
  const created = await response.json();
  await agent(base, created, '/marks/suggest-replace', {
    by: 'ai:bob', quote: 'change word', content: 'CHANGED word',
  });
  await agent(base, created, '/marks/comment', {
    by: 'ai:bob', quote: THREAD_LINE, text: 'Participant B opened this discussion thread.',
  });
  await agent(base, created, '/marks/line', {
    by: 'ai:chris', quote: THREAD_LINE, status: 'rejected', reason: 'The wording is wrong for our policy.',
  });
  const state = await agent(base, created, '/state', undefined, 'GET');
  const line = (needle) => {
    const hit = (state.lines ?? []).find(l => String(l.text ?? '').includes(needle));
    assert.ok(hit, `line not found for "${needle}"`);
    return hit.index;
  };
  const section = (title) => {
    const hit = (state.sections ?? []).find(s => String(s.text ?? '').includes(title));
    assert.ok(hit, `section not found for "${title}"`);
    return hit.headingIndex;
  };
  L = {
    TITLE: line('Usability acceptance fixture'),
    INTRO1: line('Intro paragraph 1'),
    INTRO2: line('Intro paragraph 2'),
    SAFE: line('keeps customer data safe'),
    SEC1: section('Section one'),
    ONE1: line('One paragraph 1'),
    ONE3: line('One paragraph 3'),
    SEC2: section('Section two'),
    PROPOSAL: line('change word for a pending proposal'),
    SEC3: section('Section three'),
    THREAD: line('open discussion thread from participant B'),
    LIST_TAIL: line('Second list item'),
    SPELLING: line('Three paragraph 6'),
  };
  return created;
}

async function rewriteQuote(base, created, needle, replacement) {
  const snap = await agent(base, created, '/snapshot', undefined, 'GET');
  const block = (snap.blocks ?? []).find(b => String(b.markdown ?? b.text ?? '').includes(needle));
  assert.ok(block, `block not found for "${needle}"`);
  const old = String(block.markdown ?? block.text ?? '');
  const body = {
    by: 'ai:fixture',
    operations: [{ op: 'replace_block', ref: block.ref, block: { markdown: old.replace(needle, replacement) } }],
  };
  if (snap.mutationBase) body.baseToken = typeof snap.mutationBase === 'string' ? snap.mutationBase : snap.mutationBase.token;
  else if (snap.revision !== undefined && snap.revision !== null) body.baseRevision = snap.revision;
  await agent(base, created, '/edit/v2', body);
}

async function openDoc(browser, base, slug, name, viewport) {
  const context = await browser.newContext(viewport?.isMobile ? { ...devices['iPhone 13'], ...viewport } : { viewport });
  await context.route('**/*', route => {
    const url = route.request().url();
    return new URL(url).origin === base || url.startsWith('blob:') ? route.continue() : route.abort();
  });
  await context.addInitScript(viewer => {
    try {
      localStorage.setItem('proof-share-viewer-name', viewer);
      localStorage.setItem('proof:reading-rate', '0');
    } catch {}
  }, name);
  const page = await context.newPage();
  await page.goto(`${base}/d/${slug}`);
  await page.getByRole('button', { name: 'Continue anonymously', exact: true }).click({ timeout: 6000 }).catch(() => {});
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 25_000 });
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 12_000 });
  await page.waitForFunction(() => window.__proofReadingWalk?.debugState().ready === true, null, { timeout: 12_000 });
  await page.waitForFunction(() => (window.__proofFolding?.debugState().sections.length ?? 0) >= 3, null, { timeout: 12_000 });
  await page.waitForFunction(() => (window.proof?.getAllMarks?.() ?? []).filter(m => m.data?.status === 'pending').length >= 1, null, { timeout: 12_000 });
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  page.setDefaultTimeout(8000);
  return { context, page };
}

const waitFor = (page, fn, arg, timeout = 10_000) => page.waitForFunction(fn, arg, { timeout, polling: 100 });
const walk = page => page.evaluate(() => window.__proofReadingWalk.debugState());
const foldState = page => page.evaluate(() => window.__proofFolding.debugState());
const openState = page => page.evaluate(() => window.__proofOpenView?.debugState?.() ?? null);
const chip = (page, heading) => page.locator(`.pfold-chip[data-heading="${heading}"]`);
const dot = (page, line) => page.locator(`.plm-dot[data-line="${line}"]`);

async function setFolded(page, heading, folded) {
  await page.evaluate(({ heading, folded }) => {
    window.__proofFolding.setFolded(heading, folded);
  }, { heading, folded });
  await waitFor(page, ({ heading, folded }) => {
    const el = document.querySelector(`.pfold-chip[data-heading="${heading}"]`);
    return el?.dataset.folded === (folded ? 'true' : 'false');
  }, { heading, folded });
}

async function focusLine(page, line) {
  await page.evaluate(i => window.__proofReadingWalk.focusLine(i), line);
  await waitFor(page, i => window.__proofReadingWalk.debugState().focus === i, line);
}

async function blurKeys(page) {
  await page.evaluate(() => document.activeElement?.blur());
}

async function layoutSnapshot(page, heading = L.SEC2) {
  return page.evaluate(h => {
    const chipEl = document.querySelector(`.pfold-chip[data-heading="${h}"]`);
    const fold = window.__proofFolding?.debugState?.() ?? { folded: [] };
    return {
      foldedSection: fold.folded?.includes(h) ?? false,
      chipExpanded: chipEl?.getAttribute('aria-expanded'),
      scrollY: window.scrollY,
      focus: window.__proofReadingWalk?.debugState?.().focus,
    };
  }, heading);
}

async function lineViewportTop(page, line) {
  return page.evaluate(i => {
    const lm = window.__proofLineMarks;
    const l = lm.lineList()[i];
    const dom = lm.editorView().nodeDOM(l.pos);
    return dom?.getBoundingClientRect().top ?? null;
  }, line);
}

async function isHiddenLine(page, line) {
  return page.evaluate(i => {
    const lm = window.__proofLineMarks;
    const l = lm.lineList()[i];
    const dom = lm.editorView().nodeDOM(l.pos);
    return !!dom && dom.getBoundingClientRect().height === 0;
  }, line);
}

async function hasReviewListUI(page) {
  return (await page.locator(SEL.reviewPanelToggle).count()) > 0;
}

async function hasDraftUI(page) {
  return (await page.locator(SEL.proposeChangeButton).count()) > 0;
}

async function hoverBlock(page, lineIndex) {
  const top = await page.evaluate(i => {
    const lm = window.__proofLineMarks;
    const l = lm.lineList()[i];
    const dom = lm.editorView().nodeDOM(l.pos);
    const r = dom?.getBoundingClientRect();
    return r ? { x: r.left + 24, y: r.top + r.height / 2 } : null;
  }, lineIndex);
  assert.ok(top, `line ${lineIndex} has no box`);
  await page.mouse.move(top.x, top.y, { steps: 3 });
  await page.waitForTimeout(350);
}

/** Agree every line in a section so the viewer has zero Issues there (auto-close precondition). */
async function markSectionIssueFree(page, headingIndex) {
  await page.evaluate(h => {
    const fold = window.__proofFolding.debugState();
    const section = fold.sections.find(s => s.headingIndex === h);
    if (!section) throw new Error('section missing');
    const lines = [];
    for (let i = section.headingIndex; i < section.lineEnd; i += 1) lines.push(i);
    const heading = window.__proofLineMarks.lineList()[h]?.text ?? 'section';
    return window.__proofLineMarks.writeSectionMark({ lines, heading }, 'agreed');
  }, headingIndex);
  await page.waitForTimeout(900);
}

async function scrollLineIntoView(page, lineIndex, block = 'center') {
  await page.evaluate(({ line, block }) => {
    const lm = window.__proofLineMarks;
    const dom = lm.editorView().nodeDOM(lm.lineList()[line].pos);
    dom?.scrollIntoView({ block, behavior: 'instant' });
  }, { line: lineIndex, block });
  await page.waitForTimeout(250);
}

async function scrollFullyOutOfViewThenIdle(page, idleMs = 1500) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(idleMs);
}

async function headingLayoutBoxes(page, headingA, headingB) {
  return page.evaluate(({ a, b }) => {
    const rect = (heading) => {
      const lm = window.__proofLineMarks;
      const dom = lm.editorView().nodeDOM(lm.lineList()[heading].pos);
      const r = dom?.getBoundingClientRect();
      return r ? { top: r.top, left: r.left, height: r.height } : null;
    };
    return { first: rect(a), second: rect(b) };
  }, { a: headingA, b: headingB });
}

function boxesStable(before, after, label) {
  for (const key of ['first', 'second']) {
    const a = before[key];
    const b = after[key];
    assert.ok(a && b, `${label}: missing box for ${key}`);
    const dTop = Math.abs(b.top - a.top);
    const dLeft = Math.abs(b.left - a.left);
    assert.ok(dTop < 4 && dLeft < 4, `${label}: ${key} moved Δtop=${dTop} Δleft=${dLeft}`);
  }
}

async function lineShowsFullPassage(page, lineIndex, needle) {
  return page.evaluate(({ line, needle }) => {
    const folded = document.querySelector(`.ProseMirror .pclose-folded[data-pclose-line="${line}"]`);
    if (folded) {
      return { ok: false, detail: folded.getAttribute('data-pclose-summary') ?? 'folded' };
    }
    const lm = window.__proofLineMarks;
    const dom = lm.editorView().nodeDOM(lm.lineList()[line].pos);
    const text = (dom?.textContent ?? '').trim();
    if (/^✓ agreed|^✗ rejected|^✓ approved/i.test(text)) {
      return { ok: false, detail: text.slice(0, 60) };
    }
    return { ok: text.includes(needle), detail: text.slice(0, 80) };
  }, { line: lineIndex, needle });
}

async function runViewportCases(browser, base, created, label, viewport) {
  const readerName = 'Alice';
  const { context, page } = await openDoc(browser, base, created.slug, readerName, viewport);
  activePage = page;
  const touch = Boolean(viewport?.hasTouch || viewport?.isMobile);

  // 1 — Issue-free section stays open after scroll; collapsed heading hover must not move layout.
  await check(`ac01-scroll-hover-stable@${label}`, async () => {
    await markSectionIssueFree(page, L.SEC1);
    await scrollLineIntoView(page, L.SEC1);
    assert.equal((await layoutSnapshot(page, L.SEC1)).chipExpanded, 'true', 'section one must start expanded');
    await scrollFullyOutOfViewThenIdle(page, 1500);
    await scrollLineIntoView(page, L.SEC1, 'start');
    const afterScroll = await layoutSnapshot(page, L.SEC1);
    assert.equal(afterScroll.chipExpanded, 'true', 'section auto-closed after scroll away (brief: nothing folds unless the reader acts)');
    await chip(page, L.SEC1).click();
    await waitFor(page, ({ heading }) => document.querySelector(`.pfold-chip[data-heading="${heading}"]`)?.dataset.folded === 'true', { heading: L.SEC1 });
    const hiddenBodyLines = async () => page.evaluate(h => {
      const fs = window.__proofFolding.debugState();
      const sec = fs.sections.find(s => s.headingIndex === h);
      return fs.hidden.filter(i => i > sec.headingIndex && i < sec.lineEnd).length;
    }, L.SEC1);
    const boxesBefore = await headingLayoutBoxes(page, L.SEC1, L.SEC2);
    const hiddenBefore = await hiddenBodyLines();
    await chip(page, L.SEC1).hover({ force: true });
    await page.waitForTimeout(600);
    const boxesAfter = await headingLayoutBoxes(page, L.SEC1, L.SEC2);
    boxesStable(boxesBefore, boxesAfter, 'hover on collapsed section heading');
    const hiddenAfter = await hiddenBodyLines();
    assert.equal(hiddenAfter, hiddenBefore, `hover revealed ${hiddenBefore - hiddenAfter} folded body line(s)`);
    // Hover-peek left the product (Mike, 2026-09-23, usability brief). A missing field is no peek.
    // The layout and hidden-line checks above are the behaviour. A returned heading index still fails.
    const peeked = await page.evaluate(() => window.__proofFolding.debugState().peeked);
    assert.equal(peeked ?? null, null, `hover peeked section open (peeked=${peeked})`);
  });

  // 2 — agree / reject: viewport stays anchored; closed passages stay full text after scroll away.
  await check(`ac02-viewport-anchored-on-mark@${label}`, async () => {
    const agreeLine = L.ONE1;
    const rejectLine = L.ONE3;
    if (await page.evaluate(h => window.__proofFolding.isFolded(h), L.SEC1)) {
      await chip(page, L.SEC1).click();
      await waitFor(page, ({ heading }) => document.querySelector(`.pfold-chip[data-heading="${heading}"]`)?.dataset.folded === 'false', { heading: L.SEC1 });
    }
    await scrollLineIntoView(page, agreeLine);
    await focusLine(page, agreeLine);
    const y0 = await lineViewportTop(page, agreeLine);
    const scroll0 = await page.evaluate(() => window.scrollY);
    const agreed = await page.evaluate(async line => {
      await window.__proofLineMarks.setLineStatus(line, 'agreed', undefined, 'click');
      const me = window.__proofLineMarks.me();
      const mark = window.__proofLineMarks.debugState().marks.find(m => m.by === me && m.anchor.ordinal === line);
      return mark?.status ?? null;
    }, agreeLine);
    assert.equal(agreed, 'agreed', `Agree did not stick on line ${agreeLine} (got ${agreed})`);
    const y1 = await lineViewportTop(page, agreeLine);
    const scroll1 = await page.evaluate(() => window.scrollY);
    assert.ok(Math.abs(y1 - y0) < 8, `viewport jumped ${y1 - y0}px on agree`);
    assert.ok(Math.abs(scroll1 - scroll0) < 8, `scroll jumped on agree`);
    assert.ok(!(await isHiddenLine(page, agreeLine)), 'agreed passage was hidden');
    await focusLine(page, rejectLine);
    const yReject0 = await lineViewportTop(page, rejectLine);
    const rejected = await page.evaluate(async ({ line, reason }) => {
      await window.__proofLineMarks.setLineStatus(line, 'rejected', reason, 'click');
      const me = window.__proofLineMarks.me();
      const mark = window.__proofLineMarks.debugState().marks.find(m => m.by === me && m.anchor.ordinal === line);
      return mark?.status ?? null;
    }, { line: rejectLine, reason: 'Needs a fix for usability ac02' });
    assert.equal(rejected, 'rejected', `Reject did not stick (got ${rejected})`);
    const y2 = await lineViewportTop(page, rejectLine);
    assert.ok(Math.abs(y2 - yReject0) < 12, `viewport jumped ${y2 - yReject0}px on reject`);
    assert.ok(!(await isHiddenLine(page, rejectLine)), 'rejected passage was hidden');
    await focusLine(page, L.SPELLING);
    await page.waitForTimeout(400);
    await scrollFullyOutOfViewThenIdle(page, 1500);
    await scrollLineIntoView(page, agreeLine);
    const agreedVisible = await lineShowsFullPassage(page, agreeLine, 'One paragraph 1');
    assert.ok(agreedVisible.ok, `agreed line folded to summary: ${agreedVisible.detail}`);
    const rejectedVisible = await lineShowsFullPassage(page, rejectLine, 'One paragraph 3');
    assert.ok(rejectedVisible.ok, `rejected line folded to summary: ${rejectedVisible.detail}`);
  });

  // 3 — collapsed section: passage actions must not include hidden lines; section agree names scope.
  await check(`ac03-collapsed-section-scope@${label}`, async () => {
    await setFolded(page, L.SEC2, true);
    assert.ok(await isHiddenLine(page, L.PROPOSAL), 'proposal line should be hidden inside a folded section');
    await focusLine(page, L.SEC2);
    const note = await page.locator(SEL.sectionNote).innerText().catch(() => '');
    if (note) assert.match(note, /lines|section/i, `section note should name scope: ${note}`);
    const batchBefore = await page.evaluate(() => window.__proofLineMarks.debugState().marks.filter(m => m.by === `guest:${'Alice'}` && m.status === 'agreed').length);
    await blurKeys(page);
    await page.keyboard.press('a');
    await page.waitForTimeout(600);
    const agreedHidden = await page.evaluate(i => {
      const me = window.__proofLineMarks.me();
      const m = window.__proofLineMarks.debugState().marks.find(x => x.anchor.ordinal === i && x.by === me && x.status === 'agreed');
      return Boolean(m);
    }, L.PROPOSAL);
    assert.equal(agreedHidden, false, 'Agree on a folded heading implicitly agreed a hidden paragraph');
    const batchAfter = await page.evaluate(() => window.__proofLineMarks.debugState().marks.filter(m => m.by === `guest:${'Alice'}` && m.status === 'agreed').length);
    if (note && /all \d+ lines/i.test(note)) {
      assert.ok(batchAfter > batchBefore, 'explicit section agreement should write marks');
    }
  });

  // 4 — hover another passage; shortcut still targets the selected passage.
  await check(`ac04-hover-shortcut-target@${label}`, async () => {
    await setFolded(page, L.SEC2, false);
    const target = L.SAFE;
    await selectPassage(page, target);
    await hoverChangesNothing(page, L.PROPOSAL);
    await blurKeys(page);
    await page.keyboard.press('a');
    await waitFor(page, line => {
      const me = window.__proofLineMarks.me();
      return window.__proofLineMarks.debugState().marks.some(m => m.by === me && m.anchor.ordinal === line && m.status === 'agreed');
    }, target);
    // Mark.at is an ISO string. Subtracting two strings is NaN, so a numeric sort does not find
    // the shortcut's mark. Read the selected line and the hovered line directly.
    const agreedLine = await page.evaluate(({ target, hovered }) => {
      const me = window.__proofLineMarks.me();
      const status = line => window.__proofLineMarks.debugState().marks.find(m => m.by === me && m.anchor.ordinal === line)?.status ?? null;
      return { focus: window.__proofReadingWalk.debugState().focus, target: status(target), hovered: status(hovered) };
    }, { target, hovered: L.PROPOSAL });
    assert.equal(agreedLine.focus, target, `hover moved the selected passage to ${agreedLine.focus}`);
    assert.equal(agreedLine.target, 'agreed', `shortcut did not agree selected line ${target}`);
    assert.notEqual(agreedLine.hovered, 'agreed', `shortcut agreed hovered line ${L.PROPOSAL}`);
  });

  // 5 — scroll past proposals: no accept, no agreement.
  await check(`ac05-scroll-never-accepts@${label}`, async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await focusLine(page, L.TITLE);
    await blurKeys(page);
    for (let i = 0; i < 14; i += 1) {
      await page.waitForTimeout(280);
      await page.keyboard.press('j');
    }
    await page.waitForTimeout(500);
    const s = await walk(page);
    // There is no provisional accept list (Mike, 2026-09-23, usability brief). A non-empty list still fails.
    const provisional = Array.isArray(s.provisional) ? s.provisional : [];
    assert.equal(provisional.length, 0, `scroll created provisional accepts: ${JSON.stringify(s.provisional)}`);
    const pending = await page.evaluate(() => (window.proof?.getAllMarks?.() ?? []).filter(m => m.data?.status === 'pending').length);
    assert.ok(pending >= 1, 'fixture proposal missing');
    await page.mouse.click(40, 40);
    await page.waitForTimeout(300);
    const s2 = await walk(page);
    const provisionalAfter = Array.isArray(s2.provisional) ? s2.provisional : [];
    assert.equal(provisionalAfter.length, 0, 'click elsewhere committed scroll accepts');
    const agreedProposal = await page.evaluate(() => {
      const me = window.__proofLineMarks.me();
      return window.__proofLineMarks.debugState().marks.some(m => m.by === me && m.status === 'agreed' && m.kind === 'suggestion');
    });
    assert.equal(agreedProposal, false, 'scrolling recorded agreement on a proposal');
  });

  // 6 — draft until Propose (S3).
  if (!(await hasDraftUI(page))) {
    skip(`ac06-draft-until-propose@${label}`, `awaiting S3; selector ${SEL.proposeChangeButton} TODO`);
  } else {
    await check(`ac06-draft-until-propose@${label}`, async () => {
      assert.fail('draft UI present but case not implemented');
    });
  }

  // 7 — remote activity must not steal focus, unfold sections, or open panels.
  await check(`ac07-remote-distraction-free@${label}`, async () => {
    await setFolded(page, L.SEC2, true);
    await focusLine(page, L.SAFE);
    const before = {
      focus: (await walk(page)).focus,
      folded: (await foldState(page)).folded.slice(),
      panelOpen: await page.locator(SEL.playmakerReviewPanel).isVisible().catch(() => false),
      issueHead: await page.evaluate(() => window.__proofReadingWalk.navigator?.debugState?.()?.issues?.[0]?.line ?? null),
    };
    await agent(base, created, '/marks/comment', {
      by: 'ai:bob', quote: para('Three', 4), text: 'Bob added a comment elsewhere while Alice reads.',
    });
    await page.waitForTimeout(1200);
    const after = {
      focus: (await walk(page)).focus,
      folded: (await foldState(page)).folded.slice(),
      panelOpen: await page.locator(SEL.playmakerReviewPanel).isVisible().catch(() => false),
      issueHead: await page.evaluate(() => window.__proofReadingWalk.navigator?.debugState?.()?.issues?.[0]?.line ?? null),
    };
    assert.equal(after.focus, before.focus, 'remote comment moved focus');
    assert.deepEqual(after.folded, before.folded, 'remote comment unfolded a section');
    assert.equal(after.panelOpen, before.panelOpen, 'remote comment opened a review panel');
    if (before.issueHead !== null && after.issueHead !== null) {
      assert.equal(after.issueHead, before.issueHead, 'review list reordered around the current item');
    }
  });

  // 8 — final review item + completion status (S2/S4).
  if (!(await hasReviewListUI(page))) {
    skip(`ac08-final-item-status@${label}`, `awaiting S2; selector ${SEL.reviewPanelToggle} TODO`);
  } else if (!(await page.locator(SEL.personalCompletionStatus).count())) {
    skip(`ac08-final-item-status@${label}`, `awaiting S4; selector ${SEL.personalCompletionStatus} TODO`);
  } else {
    await check(`ac08-final-item-status@${label}`, async () => {
      assert.fail('Review UI present but case not implemented');
    });
  }

  // 9 — honest status labels; rejecter not called unread.
  await check(`ac09-honest-status-labels@${label}`, async () => {
    const dotLabel = await page.locator(`${SEL.marginDot}[data-line="${L.SAFE}"]`).getAttribute('aria-label')
      ?? await page.locator(`${SEL.marginDot}[data-line="${L.SAFE}"]`).getAttribute('title');
    assert.ok(dotLabel && dotLabel.length > 2, 'line status has no accessible text');
    await page.locator(`${SEL.openSegment}[data-view="accord"]`).click().catch(() => {});
    await page.waitForTimeout(500);
    const header = await page.locator(SEL.honestHeaderText).innerText().catch(() => '');
    assert.ok(header.length > 0, 'honest header missing in Accord view');
    assert.ok(!/chris has not read/i.test(header),
      `rejecter mislabeled unread: ${header}`);
    if (!/reject|object|declin|rejected/i.test(header)) {
      throw new Error(`header should describe Chris's rejection, not unreadness: ${header}`);
    }
    const completion = await page.locator(SEL.personalCompletionStatus).innerText().catch(() => '');
    if (completion) {
      assert.ok(!/everyone agreed|team agreed|fully agreed/i.test(completion),
        `personal completion claims team agreement: ${completion}`);
    }
  });

  // 10 — meaning change lapses agreement (safe → unsafe, etc.).
  await check(`ac10-meaning-change-lapses@${label}`, async () => {
    await focusLine(page, L.SAFE);
    await blurKeys(page);
    await page.keyboard.press('a');
    await waitFor(page, i => {
      const me = window.__proofLineMarks.me().toLowerCase();
      const e = window.__proofLineMarks.lineState(i)?.marks.get(me);
      return e?.mark?.status === 'agreed' && e.current && !e.lapsed;
    }, L.SAFE);
    await rewriteQuote(base, created, 'safe', 'unsafe');
    await page.waitForTimeout(1500);
    const entry = await page.evaluate(i => {
      const me = window.__proofLineMarks.me().toLowerCase();
      const e = window.__proofLineMarks.lineState(i)?.marks.get(me);
      return e ? { current: e.current, lapsed: e.lapsed, carried: e.carried } : null;
    }, L.SAFE);
    assert.ok(entry, 'no mark entry after edit');
    assert.equal(entry.lapsed || !entry.current, true,
      `safe→unsafe still carries agreement: ${JSON.stringify(entry)}`);
    const open = await openState(page);
    if (open?.open?.lines) {
      assert.ok(open.open.lines.includes(L.SAFE), 'meaning change did not reopen the line for review');
    }
  });

  // 11 — reload restores folds.
  await check(`ac11-reload-restore@${label}`, async () => {
    await setFolded(page, L.SEC3, true);
    await page.reload();
    await page.waitForFunction(() => window.__proofReadingWalk?.debugState().ready === true, null, { timeout: 20_000 });
    await waitFor(page, h => document.querySelector(`.pfold-chip[data-heading="${h}"]`)?.dataset.folded === 'true', L.SEC3);
  });
  if (await hasReviewListUI(page)) {
    await check(`ac11-review-document-switch@${label}`, async () => {
      await page.locator(SEL.reviewPanelToggle).click();
      await page.waitForTimeout(400);
      await page.locator(SEL.reviewPanelToggle).click();
      await waitFor(page, h => document.querySelector(`.pfold-chip[data-heading="${h}"]`)?.dataset.folded === 'true', L.SEC3);
    });
  } else {
    skip(`ac11-review-document-switch@${label}`, `awaiting S2; selector ${SEL.reviewPanelToggle} TODO`);
  }

  // 12 — primary actions without hover; focus visible; statuses have text.
  await check(`ac12-actions-a11y@${label}`, async () => {
    await focusLine(page, L.LIST_TAIL);
    const agreeBtn = touch
      ? page.locator('.prw-strip-agree')
      : page.locator('.prw-right .plm-actions button').filter({ hasText: /^Agree$/ }).first();
    if (touch) {
      await agreeBtn.waitFor({ state: 'visible', timeout: 12_000 });
      const box = await agreeBtn.boundingBox();
      assert.ok(box && box.height >= 40, `Agree target too small: ${box?.height}`);
      await agreeBtn.tap();
      await page.waitForFunction(i => document.querySelector(`.plm-dot[data-line="${i}"]`)?.dataset.status !== 'unseen', L.LIST_TAIL, { timeout: 8000 });
    } else {
      await blurKeys(page);
      await page.keyboard.press('a');
      await waitFor(page, line => {
        const me = window.__proofLineMarks.me();
        return window.__proofLineMarks.debugState().marks.some(m => m.by === me && m.anchor.ordinal === line && m.status === 'agreed');
      }, L.LIST_TAIL);
    }
    const status = await page.locator(`${SEL.marginDot}[data-line="${L.LIST_TAIL}"]`).getAttribute('data-status');
    assert.ok(status && status !== 'unseen', 'Agree did not update line status');
    const a11y = await page.evaluate(i => {
      const dot = document.querySelector(`.plm-dot[data-line="${i}"]`);
      return dot?.getAttribute('aria-label') || dot?.getAttribute('title') || dot?.dataset.status || '';
    }, L.LIST_TAIL);
    assert.ok(a11y.length > 1, 'line status is color-only (no text label)');
  });

  await context.close();
}

async function main() {
  const { base, stop } = await startServer();
  const browser = await chromium.launch();
  try {
    await runViewportCases(browser, base, await createFixture(base), '1280x800', DESKTOP);
    await runViewportCases(browser, base, await createFixture(base), '375x812', { ...PHONE, viewport: { width: 375, height: 812 } });
  } finally {
    await browser.close();
    await stop();
  }
  if (failures) {
    console.log(`\n${failures} case(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll runnable acceptance cases passed (SKIP lines are expected until S2–S4 land).');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
