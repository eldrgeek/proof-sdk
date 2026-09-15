// two-reviewer-probe.mjs — two people type at the same moment; is anyone's text garbled or lost?
// Mike and Eric each open the document in their own browser context. They type insertions at the same time in
// different paragraphs (key by key), and each deletes or suggests deleting one word. Then both reload, and each
// resolves one of the other's suggestions at the same moment. After every phase the script prints what each page
// shows and what the server stores.
// In Suggesting mode it also checks that every character each person typed sits inside that person's insert
// suggestion, both as an inline mark in the page and inside a mark range from window.proof.getAllMarks(). Characters
// outside it would skip review. Finally Mike's inserts are all rejected, and nothing of his phrase may be left behind.
// Env: PROOF_DOC_URL (fresh doc, tokenized — never printed);
//      MODE=suggest|edit (default suggest); SEPARATE_BROWSERS=1 runs each person in their own browser process,
//      which rules out keystrokes being misrouted between two pages of one browser;
//      SAME_PARAGRAPH=1 puts both carets in the same paragraph.
// Exit code: 0 when every check holds, 1 when any fails (the VERDICT line lists them).
// Authored 2026-09-14 by Claude Opus 5 (CCc) for Mike Wolf; coverage, reject-all and verdict added 2026-09-15.
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
const MIKE_PHRASE = ' mike typed words';
const ERIC_PHRASE = ' eric typed words';
const problems = [];

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

// For each character of `phrase` in the page: is it inside an inline insert-suggestion mark by `author`, and inside
// the range of an insert mark by `author` from getAllMarks()? Returns the characters that are not.
const coverageOf = (p, phrase, author) => p.evaluate(([ph, a]) => {
  const v = window.proof.editor.ctx.get('editorView');
  const chars = [];
  v.state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    const inline = node.marks.some((mk) => /suggest/i.test(mk.type.name) && mk.attrs.kind === 'insert' && String(mk.attrs.by).includes(a));
    for (let i = 0; i < node.text.length; i += 1) chars.push({ ch: node.text[i], pos: pos + i, inline });
  });
  const at = chars.map((c) => c.ch).join('').indexOf(ph);
  if (at < 0) return { found: false };
  const ranges = (window.proof.getAllMarks() || [])
    .filter((m) => m.kind === 'insert' && String(m.by).includes(a) && m.range)
    .map((m) => m.range);
  let notInline = '';
  let notInRange = '';
  for (let i = 0; i < ph.length; i += 1) {
    const c = chars[at + i];
    if (!c.inline) notInline += c.ch;
    if (!ranges.some((r) => r.from <= c.pos && c.pos < r.to)) notInRange += c.ch;
  }
  return { found: true, marks: ranges.length, notInline: JSON.stringify(notInline), notInRange: JSON.stringify(notInRange) };
}, [phrase, author]);

async function checkCoverage(step, p) {
  const mikeCov = await coverageOf(p, MIKE_PHRASE, 'Mike');
  const ericCov = await coverageOf(p, ERIC_PHRASE, 'Eric');
  console.log(`${step} suggestion coverage:`, JSON.stringify({ mike: mikeCov, eric: ericCov }));
  for (const [who, cov] of [['Mike', mikeCov], ['Eric', ericCov]]) {
    if (!cov.found) problems.push(`${step}: ${who}'s phrase not found`);
    else if (cov.notInline !== '""' || cov.notInRange !== '""') {
      problems.push(`${step}: ${who}'s typing partly outside his suggestion (not inline ${cov.notInline}, not in range ${cov.notInRange})`);
    }
  }
}

function checkWords(step, seen) {
  if (!seen.mikeWords) problems.push(`${step}: Mike's words missing`);
  if (!seen.ericWords) problems.push(`${step}: Eric's words missing`);
}

async function server() {
  const st = await (await fetch(`${u.origin}/documents/${slug}/state`, { headers: { Authorization: `Bearer ${token}`, 'X-Agent-Id': 'two-reviewer-probe' } })).json();
  const md = st.markdown || '';
  return {
    readSource: st.readSource, projectionFresh: st.projectionFresh, revision: st.revision,
    mikeWords: md.includes('mike typed words'), ericWords: md.includes('eric typed words'),
    markupInText: /data-(id|kind|proof)=/.test(md),
    pending: Object.values(st.marks || {}).filter((m) => m.status === 'pending').map((m) => `${m.kind}:${String(m.by).replace('human:', '')}`).sort(),
    dianaLine: JSON.stringify(md.split('\n').find((l) => l.includes('act')) ?? null),
  };
}

function checkServer(step, s) {
  checkWords(`${step} server`, s);
  if (s.projectionFresh === false) problems.push(`${step}: server not fresh`);
  if (s.markupInText) problems.push(`${step}: markup in server text`);
}

const ctxM = await browserM.newContext({ viewport: { width: 1100, height: 640 } });
const ctxE = await browserE.newContext({ viewport: { width: 1100, height: 640 } });
let mike = await openAs(ctxM, 'Mike Probe');
let eric = await openAs(ctxE, 'Eric Probe');
console.log('1 both open in', MODE === 'edit' ? 'Editing' : 'Suggesting', 'mode,', SEPARATE ? 'separate browser processes' : 'one browser process');

// Phase A: both type at the same time; then each deletes or suggests deleting one word.
// SAME_PARAGRAPH=1 puts both carets in the DIANA paragraph (Mike after "The second act", Eric at its end);
// by default Mike types in the ERIC paragraph instead.
const SAME = process.env.SAME_PARAGRAPH === '1';
console.log('   carets:', SAME ? 'same paragraph' : 'different paragraphs');
await Promise.all([
  (async () => { await caretAfter(mike, SAME ? 'The second act' : 'play is ready.'); await mike.keyboard.type(MIKE_PHRASE, { delay: 60 }); })(),
  (async () => { await caretAfter(eric, 'one more scene.'); await eric.keyboard.type(ERIC_PHRASE, { delay: 60 }); })(),
]);
await Promise.all([
  (async () => { await selectWord(mike, 'teh'); await mike.keyboard.press('Backspace'); })(),
  (async () => { await selectWord(eric, 'second'); await eric.keyboard.press('Backspace'); })(),
]);
await Promise.all([mike.waitForTimeout(3000), eric.waitForTimeout(3000)]);
const v2m = await view(mike);
const v2e = await view(eric);
console.log('2 Mike sees:', JSON.stringify(v2m));
console.log('2 Eric sees:', JSON.stringify(v2e));
checkWords('2 Mike', v2m);
checkWords('2 Eric', v2e);
const s2 = await server();
console.log('2 server:', JSON.stringify(s2));
checkServer('2', s2);
if (MODE === 'suggest') {
  await checkCoverage('2 Mike page', mike);
  await checkCoverage('2 Eric page', eric);
}

// Phase B: both reload with empty storage.
mike = await openAs(ctxM, 'Mike Probe', mike);
eric = await openAs(ctxE, 'Eric Probe', eric);
const v3m = await view(mike);
const v3e = await view(eric);
console.log('3 after reload, Mike sees:', JSON.stringify(v3m));
console.log('3 after reload, Eric sees:', JSON.stringify(v3e));
checkWords('3 Mike', v3m);
checkWords('3 Eric', v3e);
if (MODE === 'suggest') await checkCoverage('3 Mike page', mike);

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
  if (accepted !== true) problems.push('4: accepting Eric\'s insert did not return true');
  if (rejected !== true) problems.push('4: rejecting Mike\'s delete did not return true');
  await Promise.all([mike.waitForTimeout(3000), eric.waitForTimeout(3000)]);
  console.log('5 Mike sees:', JSON.stringify(await view(mike)));
  console.log('5 Eric sees:', JSON.stringify(await view(eric)));
  mike = await openAs(ctxM, 'Mike Probe', mike);
  const v6m = await view(mike);
  console.log('6 after reload, Mike sees:', JSON.stringify(v6m));
  checkWords('6 Mike', v6m);
  const s6 = await server();
  console.log('6 server:', JSON.stringify(s6));
  checkServer('6', s6);

  // Phase D: Eric rejects every insert Mike suggested. Nothing of Mike's phrase may be left behind.
  const mikeInserts = await eric.evaluate(() => (window.proof.getAllMarks() || [])
    .filter((m) => m.kind === 'insert' && String(m.by).includes('Mike')).map((m) => m.id));
  const results = [];
  for (const id of mikeInserts) results.push(await eric.evaluate((markId) => window.proof.markReject(markId), id));
  console.log('7 Eric rejected Mike\'s inserts:', JSON.stringify({ count: mikeInserts.length, results }));
  await eric.waitForTimeout(3000);
  eric = await openAs(ctxE, 'Eric Probe', eric);
  const leftover = await eric.evaluate(([needle, same]) => {
    const doc = window.proof.editor.ctx.get('editorView').state.doc;
    const paragraphs = [];
    doc.descendants((node) => { if (node.isTextblock) paragraphs.push(node.textContent); });
    const text = doc.textContent;
    // Mike typed after "The second act" in the DIANA paragraph (same paragraph) or after "play is ready." in the
    // ERIC paragraph (different paragraphs). Whatever now sits between that anchor and the next original word is
    // left behind.
    // A speech paragraph is "NAME" + hard break + speech, so its text starts with the name; match with includes.
    const para = paragraphs.find((p) => (same ? p.includes('The second act') : p.includes('I think'))) ?? '';
    const [start, end] = same ? ['The second act', 'needs one more scene'] : ['play is ready.', null];
    const from = para.indexOf(start) + start.length;
    const between = end ? para.slice(from, para.indexOf(end)) : para.slice(from);
    return {
      phraseGone: !text.includes(needle.trim()),
      leftBehind: JSON.stringify(same ? between.replace(/^ /, '').replace(/ $/, '') : between),
      paragraph: JSON.stringify(para),
    };
  }, [MIKE_PHRASE, SAME]);
  console.log('8 after reload, Eric sees:', JSON.stringify(leftover));
  if (!leftover.phraseGone) problems.push('8: Mike\'s phrase still present after rejecting all his inserts');
  if (leftover.leftBehind !== '""') problems.push(`8: rejecting all Mike's inserts left ${leftover.leftBehind} behind`);
  const s8 = await server();
  console.log('8 server:', JSON.stringify(s8));
  if (s8.projectionFresh === false) problems.push('8: server not fresh');
}
await browserM.close();
if (browserE !== browserM) await browserE.close();

if (problems.length) {
  console.log(`VERDICT FAIL: ${problems.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log('VERDICT PASS: every check held');
}
