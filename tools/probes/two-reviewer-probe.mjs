// two-reviewer-probe.mjs — two people type at the same moment; is anyone's text garbled or lost?
// Mike and Eric each open the document in their own browser context. They type insertions at the same time in
// different paragraphs (key by key), and each deletes or suggests deleting one word. Then both reload, and each
// resolves one of the other's suggestions at the same moment. After every phase the script prints what each page
// shows and what the server stores.
// Env: PROOF_DOC_URL (fresh doc, tokenized — never printed);
//      MODE=suggest|edit (default suggest); SEPARATE_BROWSERS=1 runs each person in their own browser process,
//      which rules out keystrokes being misrouted between two pages of one browser.
// Authored 2026-09-14 by Claude Opus 5 (CCc) for Mike Wolf.
import { createRequire } from 'module';

const require = createRequire('/Users/mikewolf/Projects/playmaker/package.json');
const { chromium } = require('playwright');

const DOC_URL = process.env.PROOF_DOC_URL;
if (!DOC_URL) { console.error('need PROOF_DOC_URL'); process.exit(2); }
const MODE = process.env.MODE === 'edit' ? 'edit' : 'suggest';
const SEPARATE = process.env.SEPARATE_BROWSERS === '1';
const u = new globalThis.URL(DOC_URL);
const slug = u.pathname.split('/').pop();
const token = u.searchParams.get('token');

const browserM = await chromium.launch();
const browserE = SEPARATE ? await chromium.launch() : browserM;

async function openAs(ctx, name, page) {
  const p = page ?? await ctx.newPage();
  if (page) await p.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} }).catch(() => {});
  await p.goto(DOC_URL, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.querySelector('.ProseMirror')?.getAttribute('contenteditable') === 'true', null, { timeout: 30000 });
  await p.waitForTimeout(1500);
  const nameInput = p.getByPlaceholder('Your name');
  if (await nameInput.isVisible()) {
    await nameInput.fill(name);
    await p.getByRole('button', { name: 'Continue', exact: true }).click();
    await nameInput.waitFor({ state: 'hidden', timeout: 10000 });
    await p.waitForTimeout(500);
  }
  const wantSuggest = MODE === 'suggest';
  if ((await p.evaluate(() => window.proof.isSuggestionsEnabled())) !== wantSuggest) await p.click('.share-pill-suggest-toggle');
  return p;
}

async function caretAfter(p, needle) {
  const ok = await p.evaluate((n) => {
    const v = window.proof.editor.ctx.get('editorView');
    let pos = -1;
    v.state.doc.descendants((node, at) => {
      if (pos >= 0 || !node.isText) return;
      const i = node.text.indexOf(n);
      if (i >= 0) pos = at + i + n.length;
    });
    if (pos < 0) return false;
    const Sel = v.state.selection.constructor;
    v.dispatch(v.state.tr.setSelection(Sel.near(v.state.doc.resolve(pos))));
    v.focus();
    return true;
  }, needle);
  if (!ok) throw new Error(`needle not found: ${needle}`);
}

async function selectWord(p, word) {
  await p.evaluate((w) => {
    const v = window.proof.editor.ctx.get('editorView');
    let from = -1;
    v.state.doc.descendants((node, at) => {
      if (from >= 0 || !node.isText) return;
      const i = node.text.indexOf(w);
      if (i >= 0) from = at + i;
    });
    const Sel = v.state.selection.constructor;
    v.dispatch(v.state.tr.setSelection(Sel.create(v.state.doc, from, from + w.length)));
    v.focus();
  }, word);
}

const view = (p) => p.evaluate(() => {
  const v = window.proof.editor.ctx.get('editorView');
  const text = v.state.doc.textContent;
  const pending = (window.proof.getAllMarks() || [])
    .filter((m) => ['insert', 'delete', 'replace'].includes(m.kind) && m.range)
    .map((m) => `${m.kind}:${String(m.by).replace('human:', '')}:${v.state.doc.textBetween(m.range.from, m.range.to)}`);
  return { mikeWords: text.includes('mike typed words'), ericWords: text.includes('eric typed words'), text, pending: pending.sort() };
});

async function server() {
  const st = await (await fetch(`${u.origin}/documents/${slug}/state`, { headers: { Authorization: `Bearer ${token}`, 'X-Agent-Id': 'two-reviewer-probe' } })).json();
  const md = st.markdown || '';
  return {
    readSource: st.readSource, projectionFresh: st.projectionFresh, revision: st.revision,
    mikeWords: md.includes('mike typed words'), ericWords: md.includes('eric typed words'),
    markupInText: /data-(id|kind|proof)=/.test(md),
    pending: Object.values(st.marks || {}).filter((m) => m.status === 'pending').map((m) => `${m.kind}:${String(m.by).replace('human:', '')}`).sort(),
  };
}

const ctxM = await browserM.newContext({ viewport: { width: 1100, height: 640 } });
const ctxE = await browserE.newContext({ viewport: { width: 1100, height: 640 } });
let mike = await openAs(ctxM, 'Mike Probe');
let eric = await openAs(ctxE, 'Eric Probe');
console.log('1 both open in', MODE === 'edit' ? 'Editing' : 'Suggesting', 'mode,', SEPARATE ? 'separate browser processes' : 'one browser process');

// Phase A: both type at the same time, in different paragraphs; then each deletes or suggests deleting one word.
await Promise.all([
  (async () => { await caretAfter(mike, 'play is ready.'); await mike.keyboard.type(' mike typed words', { delay: 60 }); })(),
  (async () => { await caretAfter(eric, 'one more scene.'); await eric.keyboard.type(' eric typed words', { delay: 60 }); })(),
]);
await Promise.all([
  (async () => { await selectWord(mike, 'teh'); await mike.keyboard.press('Backspace'); })(),
  (async () => { await selectWord(eric, 'second'); await eric.keyboard.press('Backspace'); })(),
]);
await Promise.all([mike.waitForTimeout(3000), eric.waitForTimeout(3000)]);
console.log('2 Mike sees:', JSON.stringify(await view(mike)));
console.log('2 Eric sees:', JSON.stringify(await view(eric)));
console.log('2 server:', JSON.stringify(await server()));

// Phase B: both reload with empty storage.
mike = await openAs(ctxM, 'Mike Probe', mike);
eric = await openAs(ctxE, 'Eric Probe', eric);
console.log('3 after reload, Mike sees:', JSON.stringify(await view(mike)));
console.log('3 after reload, Eric sees:', JSON.stringify(await view(eric)));

if (MODE === 'suggest') {
  // Phase C: at the same moment, Mike accepts Eric's insertion and Eric rejects Mike's deletion.
  const idOf = (p, kind, author) => p.evaluate(([k, a]) => (window.proof.getAllMarks() || []).find((m) => m.kind === k && String(m.by).includes(a))?.id ?? null, [kind, author]);
  const ericInsert = await idOf(mike, 'insert', 'Eric');
  const mikeDelete = await idOf(eric, 'delete', 'Mike');
  const [accepted, rejected] = await Promise.all([
    ericInsert ? mike.evaluate((id) => window.proof.markAccept(id), ericInsert) : null,
    mikeDelete ? eric.evaluate((id) => window.proof.markReject(id), mikeDelete) : null,
  ]);
  console.log('4 Mike accepted Eric insert:', accepted, '| Eric rejected Mike delete:', rejected);
  await Promise.all([mike.waitForTimeout(3000), eric.waitForTimeout(3000)]);
  console.log('5 Mike sees:', JSON.stringify(await view(mike)));
  console.log('5 Eric sees:', JSON.stringify(await view(eric)));
  mike = await openAs(ctxM, 'Mike Probe', mike);
  console.log('6 after reload, Mike sees:', JSON.stringify(await view(mike)));
  console.log('6 server:', JSON.stringify(await server()));
}
await browserM.close();
if (browserE !== browserM) await browserE.close();
