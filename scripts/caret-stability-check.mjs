#!/usr/bin/env node
// Caret stability stress check (Mike, 2026-09-19: "When I tried to click before that line it
// started to make changes but moved the view away from where I was typing"; his typing landed as
// scattered fragments). Clicks at a mid-document position and types 40 characters at human speed
// (60–120 ms per key) while (a) the line-marks poll fires, (b) another client writes marks,
// comments and asks through the API, (c) the mouse hovers over other lines (desktop). Runs in both
// review styles, in direct Editing and legacy API Suggesting modes, at 1440 and on a 390x844 phone.
// Asserts: every character lands contiguously at the click position, the selection never jumps,
// the typed line keeps its place on screen (scrollY moves only by the height of content inserted
// above it, by browser scroll anchoring). Every transaction that changes the selection and was not caused by the
// typing is logged with its metas and stack (printed on failure; --trace prints always).
// Authorship: Claude Opus 5 (worker proof-caret), 2026-09-19, in the style of editing-first-check.mjs.
// Usage: node scripts/caret-stability-check.mjs [--style playmaker|proof] [--mode editing|suggesting]
//        [--device desktop|phone] [--shots dir] [--trace]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const trace = process.argv.includes('--trace');
const shots = arg('--shots') || path.join(root, '.preview');
mkdirSync(shots, { recursive: true });
const styles = arg('--style') ? [arg('--style')] : ['playmaker', 'proof'];
const modes = arg('--mode') ? [arg('--mode')] : ['suggesting', 'editing'];
const deviceNames = arg('--device') ? [arg('--device')] : ['desktop', 'phone'];

const clientHeaders = { 'X-Proof-Client-Version': '0.31.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n').slice(0, 6).join(' | ')}`);
    await activePage?.screenshot({ path: path.join(shots, `caret-stability-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-caret-stability-check-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      PORT: String(port), COLLAB_EMBEDDED_WS: '1', PROOF_DEFAULT_REVIEW_STYLE: style,
      PROOF_FEEDBACK_ENABLED: '1', SOMA_FEEDBACK_ENDPOINT: 'http://127.0.0.1:9/feedback',
      DATABASE_PATH: path.join(temp, 'test.db'), SNAPSHOT_DIR: path.join(temp, 'snapshots'),
    },
    // --trace keeps the server output (caret-server-<style>.log in the shots dir).
    stdio: trace ? ['ignore', ...Array(2).fill(openSync(path.join(shots, `caret-server-${style}.log`), 'w'))] : 'ignore',
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

const plain = (n) => `Paragraph ${n} is plain text for reading and marking; it is long enough to be a real line of prose.`;
// Two sections so the fold, tier and closed-fold decorations have something to work on.
const blocks = [
  '# Caret stability check',
  ...Array.from({ length: 10 }, (_, i) => plain(i + 1)),
  '## Second section',
  ...Array.from({ length: 10 }, (_, i) => plain(i + 11)),
  'This line carries the alpha word for a suggestion and a comment on the open words here.',
  '## Third section',
  ...Array.from({ length: 10 }, (_, i) => plain(i + 21)),
];
const markdown = blocks.join('\n\n');
const TARGET_LINE = blocks.indexOf(plain(15));
// The caret goes just before "text" in the target line: mid-line, mid-document.
const CLICK_BEFORE = 'text for reading';
const TYPED = 'caret stays put while others write here '; // 40 characters
assert.equal(TYPED.length, 40);
// --writer line|comment|ask limits the other client to one kind of write (for bisecting).
const WRITER_KINDS = { line: [0], comment: [1], ask: [2] }[arg("--writer")] ?? [0, 1, 2];
const OTHER_LINES = [2, 5, 8, 13, 18, 24, 27, 30].filter(i => i !== TARGET_LINE);

async function createDoc(base) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown, title: 'Caret stability check' }),
  });
  assert.equal(response.status, 200);
  const created = await response.json();
  created.api = async (route, body) => {
    const started = Date.now();
    try {
      const r = await fetch(`${base}/api/agent/${created.slug}${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-share-token': created.accessToken }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      return { ok: r.ok, status: r.status, ms: Date.now() - started, text: r.ok ? '' : await r.text() };
    } catch (error) {
      return { ok: false, status: 0, ms: Date.now() - started, text: `${route}: ${error?.cause?.code ?? error?.name ?? error}` };
    }
  };
  const seed = [
    ['/marks/comment', { quote: 'open words here', text: 'Claude: is this right?', by: 'ai:check' }],
    ['/marks/suggest-replace', { quote: 'alpha word', content: 'ALPHA word', by: 'ai:check' }],
    ['/marks/line', { lineIndex: 3, status: 'agreed', by: 'ai:check' }],
  ];
  for (const [route, body] of seed) {
    const r = await created.api(route, body);
    assert.ok(r.ok, `${route}: ${r.status} ${r.text}`);
  }
  return created;
}

/** Another client writing through the API while the person types: line marks, comments, asks. */
function startWriter(created) {
  let stopped = false;
  let writes = 0;
  const errors = [];
  const loop = (async () => {
    let n = 0;
    while (!stopped) {
      const line = OTHER_LINES[n % OTHER_LINES.length];
      const kind = WRITER_KINDS[n % WRITER_KINDS.length];
      let r;
      if (kind === 0) r = await created.api('/marks/line', { lineIndex: line, status: n % 2 ? 'seen' : 'agreed', by: 'ai:writer' });
      else if (kind === 1) r = await created.api('/marks/comment', { quote: `Paragraph ${line > 11 ? line - 1 : line} is plain`, text: `Writer note ${n}`, by: 'ai:writer' });
      else r = await created.api('/asks', { by: 'ai:cos', lineIndex: line, to: ['Ada'], recommend: `Yes: note ${n}` });
      if (r.ok) writes += 1; else errors.push(`${r.status} ${r.text.slice(0, 120)}`);
      n += 1;
      await new Promise(res => setTimeout(res, 350));
    }
  })();
  return { stop: async () => { stopped = true; await loop; return { writes, errors }; } };
}

async function openDoc(browser, base, slug, name, contextOptions) {
  const context = await browser.newContext(contextOptions);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.addInitScript(viewer => { try { localStorage.setItem('proof-share-viewer-name', viewer); } catch {} }, name);
  const page = await context.newPage();
  await page.goto(`${base}/d/${slug}`);
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForFunction(() => window.__proofLineMarks?.debugState().loaded === true, null, { timeout: 10_000 });
  await page.waitForFunction(() => window.__proofReadingWalk?.debugState().ready === true, null, { timeout: 10_000 });
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  page.setDefaultTimeout(8000);
  return { context, page };
}

/**
 * Instrumentation: wraps view.dispatch and logs every transaction that changes the selection or
 * scrolls. It is "foreign" (not caused by the person) when
 *  - it is a Yjs-origin (remote) transaction that scrolls, or moves the caret to another block or
 *    another offset within its block (a remote change elsewhere must leave the caret where it was);
 *  - or it is any other transaction that sets the selection or scrolls outside the ~50 ms after a
 *    key, input, pointer or selectionchange event (ProseMirror's own input handling).
 */
async function instrument(page) {
  await page.evaluate((trace) => {
    Error.stackTraceLimit = trace ? 60 : 12;
    const view = window.__editorView;
    const w = window;
    w.__caretLog = [];
    w.__caretViewSwaps = 0;
    // Echoes: a Yjs-origin ("remote") transaction dispatched while one of the person's own
    // transactions is still being applied, i.e. the editor re-applying its own keystroke as a
    // whole-document remote replace.
    w.__caretEchoes = 0;
    const localDepth = { n: 0 };
    let userUntil = 0;
    for (const type of ['keydown', 'keypress', 'beforeinput', 'input', 'compositionend', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'click', 'selectionchange']) {
      document.addEventListener(type, () => { userUntil = performance.now() + 50; }, true);
    }
    const describe = tr => Object.keys(tr.meta || {}).map(k => {
      const v = tr.meta[k];
      if (v && typeof v === 'object') return `${k}:{${Object.keys(v).slice(0, 4).join(',')}}`;
      return `${k}=${String(v).slice(0, 20)}`;
    });
    // "block:offset" of a position: comparable across a whole-document replace.
    const where = (doc, pos) => {
      const $pos = doc.resolve(Math.min(pos, doc.content.size));
      return `${$pos.index(0)}:${$pos.depth ? $pos.pos - $pos.start(1) : 0}`;
    };
    const wrap = v => {
      if (v.__caretWrapped) return;
      v.__caretWrapped = true;
      const original = v.dispatch.bind(v);
      v.dispatch = tr => {
        const before = v.state.selection;
        const beforeDoc = v.state.doc;
        const scrollBefore = window.scrollY;
        const remote = Object.keys(tr.meta || {}).some(k => k.startsWith('y-sync') && tr.meta[k]?.isChangeOrigin);
        // Only y-prosemirror's whole-document replace counts (a nested marks refresh tagged as
        // remote is not an echo of the keystroke).
        const wholeDoc = tr.steps.some(step => step.from === 0 && step.to === beforeDoc.content.size);
        if (remote && tr.docChanged && wholeDoc && localDepth.n > 0) {
          w.__caretEchoes += 1;
          (w.__caretEchoStacks ||= []).push((new Error().stack || '').split('\n').slice(2, 40).map(x => x.trim()).join(' <- '));
        }
        const local = !remote && tr.docChanged;
        if (local) localDepth.n += 1;
        try { original(tr); } finally { if (local) localDepth.n -= 1; }
        const after = v.state.selection;
        if (before.eq(after) && !tr.scrolledIntoView) return;
        const user = performance.now() <= userUntil;
        const from = where(beforeDoc, before.head);
        const to = where(v.state.doc, after.head);
        const foreign = remote ? (tr.scrolledIntoView || from !== to) : (!user && (tr.selectionSet || tr.scrolledIntoView));
        w.__caretLog.push({
          t: Math.round(performance.now()), user, remote, foreign,
          from: [before.anchor, before.head, from], to: [after.anchor, after.head, to],
          selectionSet: tr.selectionSet, docChanged: tr.docChanged, steps: tr.steps.length,
          scrolled: tr.scrolledIntoView, scrollBefore, meta: describe(tr),
          stack: foreign ? (new Error().stack || '').split('\n').slice(2, trace ? 60 : 12).map(s => s.trim()).join(' <- ') : '',
        });
        if (w.__caretLog.length > 600) w.__caretLog.shift();
      };
    };
    wrap(view);
    w.__caretRewrap = () => { if (w.__editorView !== view) { w.__caretViewSwaps += 1; wrap(w.__editorView); } };
    // --trace: which top-level blocks each remote Yjs transaction touches, and how.
    w.__yLog = [];
    const binding = trace && view.state.plugins.map(p => p.getState(view.state)).find(st => st && st.binding)?.binding;
    if (binding) {
      binding.type.observeDeep((events, transaction) => {
        if (transaction.local) return;
        const touched = events.map(event => {
          let t = event.target; let top = t;
          while (t && t.parent && t.parent !== binding.type) t = t.parent;
          top = t && t.parent === binding.type ? binding.type.toArray().indexOf(t) : 'root';
          const delta = event.target === binding.type ? event.changes.delta : event.delta ?? event.changes.delta;
          return { top, delta: JSON.stringify(delta).slice(0, 160) };
        });
        w.__yLog.push({ t: Math.round(performance.now()), origin: String(transaction.origin?.constructor?.name ?? transaction.origin), touched });
      });
    }
  }, trace);
}

/** Viewport point just before `needle` inside top-level block `index`. */
async function pointBefore(page, index, needle) {
  return page.evaluate(({ index, needle }) => {
    const block = document.querySelectorAll('.ProseMirror > *')[index];
    block.scrollIntoView({ block: 'center', behavior: 'instant' });
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent.indexOf(needle);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at); range.setEnd(node, at + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + 0.5, y: rect.top + rect.height / 2 };
    }
    return null;
  }, { index, needle });
}

const selectionNow = page => page.evaluate(() => {
  window.__caretRewrap?.();
  const view = window.__editorView;
  const s = view.state.selection;
  // caretY: where the caret is on screen; blockTop: the typed line's top on the page.
  let caretY = null;
  try { caretY = Math.round(view.coordsAtPos(s.head).top); } catch {}
  const block = document.querySelectorAll(".ProseMirror > *")[window.__caretTarget ?? -1];
  const blockTop = block ? Math.round(block.getBoundingClientRect().top + window.scrollY) : null;
  const out = { anchor: s.anchor, head: s.head, scrollY: window.scrollY, caretY, blockTop };
  if (window.__caretTrace) {
    // The y-prosemirror binding's node mapping: top-level Yjs children whose mapped ProseMirror
    // node is missing, or is not the node in the live document.
    const binding = view.state.plugins.map(p => p.getState(view.state)).find(st => st && st.binding)?.binding;
    if (binding) {
      const kids = binding.type.toArray();
      out.stale = [];
      kids.forEach((t, i) => {
        const node = binding.mapping.get(t);
        if (!node) out.stale.push(`${i}:missing`);
        else if (node !== view.state.doc.maybeChild(i)) out.stale.push(`${i}:${node.nodeSize}/${view.state.doc.maybeChild(i)?.nodeSize}`);
      });
      out.kids = `${kids.length}/${view.state.doc.childCount}`;
    }
  }
  return out;
});
const blockText = (page, index) => page.evaluate(i => document.querySelectorAll('.ProseMirror > *')[i]?.textContent ?? '', index);
const jitter = () => 60 + Math.floor(Math.random() * 61);

async function run(browser, base, style, mode, device) {
  const phone = device === 'phone';
  const tag = `caret-${style}-${mode}-${phone ? 'phone-390x844' : '1440'}`;
  const contextOptions = phone ? { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } : { viewport: { width: 1440, height: 900 } };
  const created = await createDoc(base);
  const { context, page } = await openDoc(browser, base, created.slug, 'Ada', contextOptions);
  activePage = page;
  // Enter via the labelled control. The legacy mode remains an API compatibility check.
  await page.evaluate(m => { document.querySelector('.share-pill-suggest-toggle').click(); if (m === 'suggesting') window.proof.enableSuggestions(); }, mode);
  await page.waitForTimeout(300);
  await instrument(page);
  if (trace) await page.evaluate(() => { window.__caretTrace = true; });
  await page.evaluate(i => { window.__caretTarget = i; }, TARGET_LINE);

  const original = await blockText(page, TARGET_LINE);
  const offset = original.indexOf(CLICK_BEFORE);
  assert.ok(offset > 0, 'target text not found');
  const expected = original.slice(0, offset) + TYPED + original.slice(offset);
  const point = await pointBefore(page, TARGET_LINE, CLICK_BEFORE);
  assert.ok(point, 'no click point');
  await page.waitForTimeout(250);

  const writer = startWriter(created);
  const samples = [];
  let clickSel;
  try {
    // Click and type immediately: no pause between the click and the first key.
    if (phone) await page.touchscreen.tap(point.x, point.y); else await page.mouse.click(point.x, point.y);
    // Read the caret once the browser has delivered the click selectionchange (two frames);
    // a person types later than that.
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    clickSel = await selectionNow(page);
    for (let i = 0; i < TYPED.length; i += 1) {
      await page.keyboard.type(TYPED[i]);
      samples.push({ i, ...(await selectionNow(page)) });
      if (i === 12 || i === 27) await page.evaluate(() => window.__proofLineMarks?.refresh?.()); // the poll, forced
      if (!phone && i % 3 === 1) {
        // The mouse drifts over other lines while typing (hover focus).
        const other = OTHER_LINES[i % OTHER_LINES.length];
        const box = await page.evaluate(k => {
          const r = document.querySelectorAll('.ProseMirror > *')[k]?.getBoundingClientRect();
          return r ? { x: r.left + 40, y: r.top + r.height / 2 } : null;
        }, other);
        if (box && box.y > 0 && box.y < 900) await page.mouse.move(box.x + (i % 7) * 9, box.y, { steps: 3 });
      }
      await page.waitForTimeout(jitter());
    }
    await page.waitForTimeout(4500); // one more real poll after the last key
  } finally {
    const w = await writer.stop();
    if (w.errors.length) console.log(`  writer errors (${tag}): ${w.errors.slice(0, 3).join(' ; ')}`);
    if (trace) console.log(`  writer: ${w.writes} writes`);
  }
  const log = await page.evaluate(() => window.__caretLog);
  const swaps = await page.evaluate(() => window.__caretViewSwaps);
  const echoes = await page.evaluate(() => window.__caretEchoes);
  const echoStacks = await page.evaluate(() => window.__caretEchoStacks || []);
  const foreign = log.filter(e => e.foreign);
  const dump = () => foreign.slice(0, 8).map(e => `${e.t} ${JSON.stringify(e.from)}->${JSON.stringify(e.to)} set=${e.selectionSet} doc=${e.docChanged} scroll=${e.scrolled} meta=[${e.meta.join(' ')}] ${e.stack}`).join('\n    ');
  if (trace) writeFileSync(path.join(shots, `${tag}-log.json`), JSON.stringify({ clickSel, samples, log, yLog: await page.evaluate(() => window.__yLog) }, null, 1));
  if (trace) console.log(`  ${tag}: ${log.length} selection transactions, ${foreign.length} foreign, view swaps ${swaps}\n    ${dump()}`);

  await check(`${tag}: the click puts the caret before "${CLICK_BEFORE}"`, async () => {
    assert.equal(clickSel.anchor, clickSel.head, 'the click made a range, not a caret');
    const want = await page.evaluate(({ index, offset }) => {
      const doc = window.__editorView.state.doc;
      let pos = 0;
      for (let i = 0; i < index; i += 1) pos += doc.child(i).nodeSize;
      return pos + 1 + offset;
    }, { index: TARGET_LINE, offset });
    // After typing, positions before the click are unchanged, so the start is comparable.
    assert.equal(clickSel.head, want, `caret at ${clickSel.head}, expected ${want}`);
  });
  await check(`${tag}: every character lands contiguously at the click position`, async () => {
    const text = await blockText(page, TARGET_LINE);
    assert.equal(text, expected, `line reads: ${text}`);
  });
  await check(`${tag}: the selection never jumps while typing`, async () => {
    const jumps = samples.filter(s => s.anchor !== s.head || s.head !== clickSel.head + s.i + 1);
    assert.equal(jumps.length, 0, `jumps: ${JSON.stringify(jumps.slice(0, 4))}\n    ${dump()}`);
  });
  await check(`${tag}: scrollY is stable: the typed line keeps its place on screen`, async () => {
    // Content inserted above the line (an ask, a comment row) makes the browser keep the line in
    // place by scrolling by that height (scroll anchoring); any other scroll moves the view. The
    // line is measured, not the caret: the caret legitimately moves down when the line wraps.
    const onScreen = x => x.blockTop - x.scrollY;
    const drift = Math.max(...samples.map(x => Math.abs(onScreen(x) - onScreen(clickSel))));
    assert.ok(drift <= 2, `the typed line moved on screen by ${drift}px (line top on screen ${samples.map(onScreen).join(',')}; scrollY ${samples.map(x => x.scrollY).join(',')})`);
  });
  await check(`${tag}: the editor never re-applies its own keystroke as a remote change`, async () => {
    assert.equal(echoes, 0, `${echoes} of the person's own edits came back as whole-document Yjs replaces${trace ? `\n    ${echoStacks.join('\n    ')}` : ''}`);
  });
  await check(`${tag}: no transaction from our plugins changed the selection or scrolled`, async () => {
    assert.equal(foreign.length, 0, `${foreign.length} foreign selection changes:\n    ${dump()}`);
  });
  await page.screenshot({ path: path.join(shots, `${tag}.png`), timeout: 15_000 }).catch(() => {});
  await context.close();
}

const browser = await chromium.launch();
try {
  for (const style of styles) {
    const { base, stop } = await startServer(style);
    try {
      for (const device of deviceNames) {
        for (const mode of modes) await run(browser, base, style, mode, device);
      }
    } finally {
      await stop();
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${results.length - failures}/${results.length} caret-stability checks passed`);
process.exit(failures ? 1 : 0);
