#!/usr/bin/env node
import { showWholeAccord } from './review-ui.mjs';
// A local write to a line a remote writer is touching updates that line AND NOTHING ELSE.
//
// The bug this check exists for (measured 2026-09-22 by worker accord-edit, fixed 2026-09-23):
// a local programmatic write — the shape the direct-Editing conversion uses, and the shape every
// AI suggestion uses — goes through ProseMirror's dispatch. Inside that dispatch the marks-sync
// plugin view writes the marks map in its OWN Yjs transaction (collab-client.setMarksMetadata).
// A Yjs transaction created while an earlier transaction is being cleaned up does not run its own
// cleanup: the outer cleanup loop runs it, AFTER y-prosemirror's mutex has been released. The
// binding then took its own fragment write for a REMOTE change and replaced the whole document
// from the Yjs fragment — re-entrantly, while ProseMirror was still applying the transaction that
// caused it. The replace was computed against a document that had already moved, so it appended
// instead of replacing and the paragraph was written twice.
//
// This check does not go through the edit gesture, so it is independent of
// EDIT_SESSION_POLICY.convertDirectEditsToProposals: it drives window.proof.markSuggestReplace,
// the ordinary local-write path, while a second client writes to the same line.
//
// Asserts, every round: the document keeps its block count, the edited line holds exactly the
// words the write put there (never the old words with the new ones appended), the Yjs fragment
// and the ProseMirror document agree, and no local write comes back as a whole-document replace.
//
// Authorship: Mike Wolf (rulings), built by Claude Opus 5 (worker accord-yjs), 2026-09-23.
// Usage: node scripts/local-write-resync-check.mjs [--style playmaker|proof] [--device desktop|phone]
//        [--rounds N] [--shots dir] [--trace]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, openSync } from 'node:fs';
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
const deviceNames = arg('--device') ? [arg('--device')] : ['desktop', 'phone'];
const ROUNDS = Number(arg('--rounds') ?? 10);

const clientHeaders = { 'X-Proof-Client-Version': '0.34.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n').slice(0, 8).join(' | ')}`);
    await activePage?.screenshot({ path: path.join(shots, `local-write-resync-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer(style) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-local-write-resync-check-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      PORT: String(port), COLLAB_EMBEDDED_WS: '1', PROOF_DEFAULT_REVIEW_STYLE: style,
      DATABASE_PATH: path.join(temp, 'test.db'), SNAPSHOT_DIR: path.join(temp, 'snapshots'),
    },
    stdio: trace ? ['ignore', ...Array(2).fill(openSync(path.join(shots, `local-write-resync-server-${style}.log`), 'w'))] : 'ignore',
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
const blocks = [
  '# Local write resync check',
  ...Array.from({ length: 10 }, (_, i) => plain(i + 1)),
  '## Second section',
  ...Array.from({ length: 10 }, (_, i) => plain(i + 11)),
];
// The contended line: the person writes to it and the other client marks it, over and over. Its
// words are unique in the document, because a quote that occurs twice is refused before it is
// written and this check is about the write, not about resolving it.
// One unique token per round, because a suggestion is a proposal: it does not change the words
// underneath, so a round cannot quote what the round before it proposed.
const ROUND_TOKENS = Array.from({ length: 32 }, (_, i) => `alpha${String(i).padStart(2, '0')}`);
const CONTENDED = `Paragraph 15 is the contended line, and it carries ${ROUND_TOKENS.join(' ')} for the writer and the typist.`;
const TARGET_LINE = blocks.indexOf(plain(15));
blocks[TARGET_LINE] = CONTENDED;
const markdown = blocks.join('\n\n');
const OTHER_LINES = [2, 5, 8, 13, 18].filter(i => i !== TARGET_LINE);

async function createDoc(base) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown, title: 'Local write resync check' }),
  });
  assert.equal(response.status, 200);
  const created = await response.json();
  created.api = async (route, body) => {
    try {
      const r = await fetch(`${base}/api/agent/${created.slug}${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-share-token': created.accessToken },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      });
      return { ok: r.ok, status: r.status, text: r.ok ? '' : await r.text() };
    } catch (error) {
      return { ok: false, status: 0, text: `${route}: ${error?.cause?.code ?? error?.name ?? error}` };
    }
  };
  return created;
}

/** A second client writing continuously, including to the line being edited. */
function startWriter(created) {
  let stopped = false;
  let writes = 0;
  const errors = [];
  const loop = (async () => {
    let n = 0;
    while (!stopped) {
      // Every other write lands on the contended line itself.
      const onTarget = n % 2 === 0;
      const line = onTarget ? TARGET_LINE : OTHER_LINES[n % OTHER_LINES.length];
      const r = await created.api('/marks/line', { lineIndex: line, status: n % 4 < 2 ? 'seen' : 'agreed', by: `ai:writer${n % 3}` });
      if (r.ok) writes += 1; else errors.push(`${r.status} ${r.text.slice(0, 120)}`);
      n += 1;
      await new Promise(res => setTimeout(res, 120));
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
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  if (trace) page.on('console', m => { if (/markSuggestReplace|suggest|refus|reject/i.test(m.text())) console.log(`  [page] ${m.text().slice(0, 200)}`); });
  page.setDefaultTimeout(8000);
  await showWholeAccord(page);
  return { context, page };
}

/**
 * Counts local writes that came back as a whole-document ProseMirror replace tagged as a remote
 * Yjs change — the resync this check exists to keep out — and records the document each time.
 */
async function instrument(page) {
  await page.evaluate(() => {
    const view = window.__editorView;
    const w = window;
    w.__resyncEvents = [];
    const original = view.dispatch.bind(view);
    let localDepth = 0;
    view.dispatch = tr => {
      const beforeDoc = view.state.doc;
      const remote = Object.keys(tr.meta || {}).some(k => k.startsWith('y-sync') && tr.meta[k]?.isChangeOrigin);
      const wholeDoc = tr.steps.some(step => step.from === 0 && step.to === beforeDoc.content.size);
      if (remote && tr.docChanged && wholeDoc && localDepth > 0) {
        w.__resyncEvents.push({ blocksBefore: beforeDoc.childCount, at: Math.round(performance.now()) });
      }
      const local = !remote && tr.docChanged;
      if (local) localDepth += 1;
      try { original(tr); } finally { if (local) localDepth -= 1; }
    };
  });
}

/** The document as the page holds it, and as Yjs holds it, so the two can be compared. */
const documentState = page => page.evaluate(() => {
  const view = window.__editorView;
  const pm = [];
  view.state.doc.forEach(node => pm.push(node.textContent));
  // The Yjs fragment behind the binding, as plain text per top-level block.
  let yjs = null;
  for (const plugin of view.state.plugins) {
    const state = plugin.getState(view.state);
    if (state && state.binding) {
      yjs = state.binding.type.toArray().map(t => t.toString().replace(/<[^>]+>/g, ''));
      break;
    }
  }
  return { pm, yjs, resyncs: window.__resyncEvents.length };
});

async function run(browser, base, style, device) {
  const phone = device === 'phone';
  const tag = `local-write-resync-${style}-${phone ? 'phone-390x844' : '1440'}`;
  const contextOptions = phone ? { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } : { viewport: { width: 1440, height: 900 } };
  const created = await createDoc(base);
  const { context, page } = await openDoc(browser, base, created.slug, 'Ada', contextOptions);
  activePage = page;
  // Direct Editing mode: the local write is the document's text, which is the contended case.
  await page.evaluate(() => document.querySelector('.share-pill-suggest-toggle').click());
  await page.waitForTimeout(300);
  await instrument(page);

  const startBlocks = (await documentState(page)).pm.length;
  const writer = startWriter(created);
  const rounds = [];
  try {
    for (let round = 0; round < ROUNDS; round += 1) {
      // The local write, in the shape the direct-Editing conversion uses: a direct edit to the
      // contended line, then a proposal posted over words on the same line, back to back.
      const quote = ROUND_TOKENS[round % ROUND_TOKENS.length];
      const wrote = await page.evaluate(({ quote, line }) => {
        const view = window.__editorView;
        // The caret goes in the contended line first: a local write with the caret elsewhere is a
        // different, and easier, case than the one the conversion makes.
        let pos = 1;
        for (let i = 0; i < line; i += 1) pos += view.state.doc.child(i).nodeSize;
        const Selection = view.state.selection.constructor;
        try { view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(pos + 4)))); }
        catch { /* the selection is setup here, not the thing under test */ }
        // 1. A direct edit to the line (the conversion puts the original words back).
        view.dispatch(view.state.tr.insertText('.', pos + 4));
        // 2. A proposal over words on the same line (the conversion posts what was typed).
        const mark = window.proof.markSuggestReplace(quote, 'human:Ada', `${quote}-proposed`);
        return { ok: !!mark, id: mark?.id ?? null };
      }, { quote, line: TARGET_LINE });
      // Let the marks write, its Yjs transaction and any resync it provokes all settle.
      await page.waitForTimeout(260);
      const state = await documentState(page);
      rounds.push({ round, wrote, blocks: state.pm.length, line: state.pm[TARGET_LINE], yjs: state.yjs?.[TARGET_LINE], resyncs: state.resyncs });
      if (trace) console.log(`  ${tag} round ${round}: wrote=${wrote.ok} blocks=${state.pm.length} resyncs=${state.resyncs}\n    line: ${state.pm[TARGET_LINE]}`);
    }
  } finally {
    const w = await writer.stop();
    if (w.errors.length) console.log(`  writer errors (${tag}): ${w.errors.slice(0, 3).join(' ; ')}`);
    if (trace) console.log(`  writer: ${w.writes} writes`);
  }

  const final = await documentState(page);
  const show = line => (line ?? '').slice(0, 220);

  await check(`${tag}: every local write reached the document`, async () => {
    const refused = rounds.filter(r => !r.wrote.ok);
    assert.equal(refused.length, 0, `${refused.length} of ${ROUNDS} writes were refused (rounds ${refused.map(r => r.round).join(',')})`);
  });
  await check(`${tag}: a local write to the contended line never writes the line twice`, async () => {
    // The signature of the bug: the line holds its old words AND the new ones, end to end.
    const doubled = rounds.filter(r => {
      const line = r.line ?? '';
      const head = 'Paragraph 15 is the contended line';
      return line.indexOf(head) !== line.lastIndexOf(head);
    });
    assert.equal(doubled.length, 0,
      `the line was written twice in ${doubled.length} of ${ROUNDS} rounds (first: round ${doubled[0]?.round})\n    ${show(doubled[0]?.line)}`);
  });
  await check(`${tag}: the document keeps its blocks`, async () => {
    const grew = rounds.filter(r => r.blocks !== startBlocks);
    assert.equal(grew.length, 0,
      `the document went from ${startBlocks} to ${grew.map(r => r.blocks).join(',')} blocks (rounds ${grew.map(r => r.round).join(',')})`);
  });
  await check(`${tag}: the Yjs fragment and the document agree`, async () => {
    assert.deepEqual(final.pm, final.yjs, `Yjs and ProseMirror disagree\n    pm:  ${show(final.pm[TARGET_LINE])}\n    yjs: ${show(final.yjs?.[TARGET_LINE])}`);
  });
  await check(`${tag}: no local write comes back as a whole-document replace`, async () => {
    assert.equal(final.resyncs, 0, `${final.resyncs} local writes were re-applied as whole-document Yjs replaces`);
  });
  // Step 3: exercise the same contention with actual keys and live proposals.
  const TYPED = 'typed by the person ';
  const gesture = await (async () => {
    const before = await documentState(page);
    const original = before.pm[TARGET_LINE];
    const writer2 = startWriter(created);
    try {
      await page.evaluate(i => window.__proofReadingWalk.focusDocument(i), TARGET_LINE);
      await page.evaluate(i => {
        const view = window.__editorView; let pos = 0;
        for (let n = 0; n <= i; n++) pos += view.state.doc.child(n).nodeSize;
        view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.create(view.state.doc, pos - 1)));
      }, TARGET_LINE);
      await page.keyboard.type(TYPED, { delay: 60 });
      await page.waitForTimeout(1200);
    } finally { await writer2.stop(); }
    const after = await documentState(page);
    const proposals = await page.evaluate(() => window.proof.getAllMarks().filter(m => m.kind === 'insert' && (m.data?.status ?? 'pending') === 'pending'));
    return { original, after, proposals };
  })();
  await check(`${tag}: typing on the contended line proposes the words without writing the line twice`, async () => {
    assert.equal(gesture.after.pm[TARGET_LINE], gesture.original + TYPED);
    assert.ok(gesture.proposals.some(m => m.data.content.includes(TYPED)), 'typed words have no insertion proposal');
  });
  await check(`${tag}: the gesture keeps the document and the Yjs fragment in step`, async () => {
    assert.equal(gesture.after.pm.length, startBlocks, `the document went to ${gesture.after.pm.length} blocks`);
    assert.deepEqual(gesture.after.pm, gesture.after.yjs, 'Yjs and ProseMirror disagree after the gesture');
    assert.equal(gesture.after.resyncs, 0, `${gesture.after.resyncs} local writes came back as whole-document replaces`);
  });

  await page.screenshot({ path: path.join(shots, `${tag}.png`), timeout: 15_000 }).catch(() => {});
  await context.close();
}

const browser = await chromium.launch();
try {
  for (const style of styles) {
    const { base, stop } = await startServer(style);
    try {
      for (const device of deviceNames) await run(browser, base, style, device);
    } finally {
      await stop();
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${results.length - failures}/${results.length} local-write-resync checks passed`);
process.exit(failures ? 1 : 0);
