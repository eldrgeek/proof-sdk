// agent-concurrent-probe.mjs — an AI acts through the REST API while a person is typing. Is any typing lost?
// The person types a long phrase at the end of the document in Suggesting mode, in bursts with short pauses (people
// pause to think). The AI adds a replace ("teh" -> "the") and an insert (after "needs one more scene"), then rejects
// its replace. The server refuses AI writes with 409 PROJECTION_STALE while the person's typing is unsaved, so each AI
// call retries every 250 ms until it is accepted; that way the AI's writes land during a pause and the person keeps
// typing straight after them, which is the case where a save could put the saved copy's older text over the live
// document. After a reload with empty storage, the whole phrase must be on the page and on the server, the server
// must be fresh, "teh" must be back (the replace was rejected), and the AI's insert must still be pending.
// Document markdown: # Proof E2E\n\nERIC\\\nI think teh play is ready.\n\nDIANA\\\nThe second act needs one more scene.\n
// Env: PROOF_DOC_URL (fresh doc, tokenized — never printed); DELAY_MS per key (default 90); PAUSE_MS between bursts
// (default 1500); CHUNKS bursts (default 4).
// Exit code: 0 when nothing was lost, 1 when typing or a suggestion was lost, 3 when the AI never got a write in.
// Authored 2026-09-15 by Claude Opus 5 (CCc) for Mike Wolf; retry and bursts added the same day.
import { createRequire } from 'module';

const require = createRequire('/Users/mikewolf/Projects/playmaker/package.json');
const { chromium } = require('playwright');

const DOC_URL = process.env.PROOF_DOC_URL;
if (!DOC_URL) { console.error('need PROOF_DOC_URL'); process.exit(2); }
const DELAY_MS = Number(process.env.DELAY_MS || 90);
const PAUSE_MS = Number(process.env.PAUSE_MS || 1500);
const CHUNKS = Number(process.env.CHUNKS || 4);
const u = new globalThis.URL(DOC_URL);
const slug = u.pathname.split('/').pop();
const token = u.searchParams.get('token');
const auth = { Authorization: `Bearer ${token}`, 'X-Agent-Id': 'agent-concurrent-probe' };
const PHRASE = ' the person keeps typing this whole sentence while the AI works on its own changes elsewhere in the play';

// Split the phrase into CHUNKS bursts at word boundaries.
const words = PHRASE.split(/(?= )/);
const bursts = [];
for (let i = 0; i < CHUNKS; i += 1) {
  bursts.push(words.slice(Math.round((i * words.length) / CHUNKS), Math.round(((i + 1) * words.length) / CHUNKS)).join(''));
}

let t0 = 0;
let typingDone = false;
const since = () => Date.now() - t0;

async function opOnce(body) {
  const res = await fetch(`${u.origin}/documents/${slug}/ops`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, success: json.success, code: json.code, markId: json.markId };
}

// Retry on 409 PROJECTION_STALE every 250 ms until accepted, or until 3 s after the typing ends.
async function op(body) {
  let attempts = 0;
  let last;
  let doneAt = 0;
  for (;;) {
    attempts += 1;
    last = await opOnce(body);
    if (!(last.status === 409 && last.code === 'PROJECTION_STALE')) break;
    if (typingDone && !doneAt) doneAt = Date.now();
    if (doneAt && Date.now() - doneAt > 3000) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ...last, attempts, atMs: since(), whileTyping: !typingDone };
}

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1100, height: 640 } })).newPage();

async function openDoc() {
  if (page.url().startsWith('http')) await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} }).catch(() => {});
  await page.goto(DOC_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.ProseMirror')?.getAttribute('contenteditable') === 'true', null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  const nameInput = page.getByPlaceholder('Your name');
  if (await nameInput.isVisible()) {
    await nameInput.fill('Claude Person');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await nameInput.waitFor({ state: 'hidden', timeout: 10000 });
    await page.waitForTimeout(500);
  }
}

const view = () => page.evaluate((phrase) => {
  const v = window.proof.editor.ctx.get('editorView');
  const text = v.state.doc.textContent;
  return {
    phraseWhole: text.includes(phrase.trim()),
    tehKept: text.includes('teh play'),
    aiInsertText: text.includes('AI concurrent words'),
    pending: (window.proof.getAllMarks() || []).filter((m) => ['insert', 'delete', 'replace'].includes(m.kind) && m.range).map((m) => `${m.kind}:${String(m.by).replace('human:', '')}`),
  };
}, PHRASE);

await openDoc();
if (!(await page.evaluate(() => window.proof.isSuggestionsEnabled()))) await page.click('.share-pill-suggest-toggle');
await page.evaluate(() => {
  const v = window.proof.editor.ctx.get('editorView');
  let end = 1;
  v.state.doc.descendants((node, pos) => { if (node.isTextblock) end = pos + node.nodeSize - 1; });
  const Sel = v.state.selection.constructor;
  v.dispatch(v.state.tr.setSelection(Sel.near(v.state.doc.resolve(end), -1)));
  v.focus();
});

t0 = Date.now();
const burstLog = [];
const typing = (async () => {
  for (let i = 0; i < bursts.length; i += 1) {
    burstLog.push({ burst: i, startMs: since() });
    await page.keyboard.type(bursts[i], { delay: DELAY_MS });
    if (i < bursts.length - 1) await page.waitForTimeout(PAUSE_MS);
  }
  typingDone = true;
  burstLog.push({ end: since() });
})();
const ai = (async () => {
  await new Promise((r) => setTimeout(r, 1000));
  const replace = await op({ type: 'suggestion.add', kind: 'replace', quote: 'teh', content: 'the', by: 'ai:cos-probe' });
  const insert = await op({ type: 'suggestion.add', kind: 'insert', quote: 'needs one more scene', content: ' AI concurrent words', by: 'ai:cos-probe' });
  await new Promise((r) => setTimeout(r, 1500));
  const reject = replace.markId ? await op({ type: 'suggestion.reject', markId: replace.markId, by: 'ai:cos-probe' }) : { status: 'no markId' };
  return { replace, insert, reject };
})();
const [, aiResults] = await Promise.all([typing, ai]);
console.log('typing bursts (ms since typing began):', JSON.stringify(burstLog));
console.log('AI calls while the person typed:', JSON.stringify(aiResults));
await page.waitForTimeout(4000);
const before = await view();
console.log('before reload, person sees:', JSON.stringify(before));

await openDoc();
const after = await view();
console.log('after reload, person sees:', JSON.stringify(after));
const st = await (await fetch(`${u.origin}/documents/${slug}/state`, { headers: auth })).json();
const md = st.markdown || '';
const server = {
  readSource: st.readSource, projectionFresh: st.projectionFresh, repairPending: st.repairPending, revision: st.revision,
  phraseWhole: md.includes(PHRASE.trim()), tehKept: md.includes('teh play'), aiInsertText: md.includes('AI concurrent words'),
  markupInText: /data-(id|kind|proof)=/.test(md),
  pending: Object.values(st.marks || {}).filter((m) => m.status === 'pending').map((m) => `${m.kind}:${String(m.by).replace('human:', '')}`),
};
console.log('server:', JSON.stringify(server));
await browser.close();

const aiWrote = aiResults.replace.success || aiResults.insert.success;
const aiWroteWhileTyping = [aiResults.replace, aiResults.insert, aiResults.reject].some((r) => r && r.success && r.whileTyping);
const problems = [];
if (!before.phraseWhole) problems.push('typing lost before reload');
if (!after.phraseWhole) problems.push('typing lost after reload');
if (!server.phraseWhole) problems.push('typing missing on server');
if (server.projectionFresh === false) problems.push('server not fresh');
if (server.markupInText) problems.push('markup in server text');
if (aiResults.reject?.success && (!after.tehKept || !server.tehKept)) problems.push('rejected replace did not restore "teh"');
if (aiResults.insert.success && !after.pending.some((p) => p.startsWith('insert:ai'))) problems.push('AI insert no longer pending on page');
if (aiResults.insert.success && !server.pending.some((p) => p.startsWith('insert:ai'))) problems.push('AI insert no longer pending on server');
if (problems.length) {
  console.log(`VERDICT FAIL: ${problems.join('; ')}`);
  process.exitCode = 1;
} else if (!aiWrote) {
  console.log('VERDICT INCONCLUSIVE: the AI never got a write accepted, so the risky path was not reached');
  process.exitCode = 3;
} else {
  console.log(`VERDICT PASS: nothing lost; AI write accepted while the person was still typing: ${aiWroteWhileTyping}`);
}
