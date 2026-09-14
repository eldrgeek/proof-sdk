// caret-jump-probe.mjs — does another person's typing move my caret? (the two-reviewer garbling)
// Mike places his caret after "play is ready." and waits. Eric types " xyz" at the end of the document, one
// key at a time. After each of Eric's keys the script reads Mike's caret position, and it logs every
// transaction Mike's page applies from the collaboration layer (y-sync), with its steps. Then Mike types one
// letter, and the script reports where it landed.
// Env: PROOF_DOC_URL (fresh doc, tokenized — never printed); MODE=suggest|edit (default suggest).
// Authored 2026-09-14 by Claude Opus 5 (CCc) for Mike Wolf.
import { createRequire } from 'module';

const require = createRequire('/Users/mikewolf/Projects/playmaker/package.json');
const { chromium } = require('playwright');

const DOC_URL = process.env.PROOF_DOC_URL;
const MODE = process.env.MODE === 'edit' ? 'edit' : 'suggest';
if (!DOC_URL) { console.error('need PROOF_DOC_URL'); process.exit(2); }

const browser = await chromium.launch();

async function openAs(name) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 640 } });
  const p = await ctx.newPage();
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
  const suggesting = await p.evaluate(() => window.proof.isSuggestionsEnabled());
  if ((MODE === 'suggest') !== suggesting) await p.click('.share-pill-suggest-toggle');
  return p;
}

async function caretAfter(p, needle) {
  return p.evaluate((n) => {
    const v = window.proof.editor.ctx.get('editorView');
    let pos = -1;
    v.state.doc.descendants((node, at) => {
      if (pos >= 0 || !node.isText) return;
      const i = node.text.indexOf(n);
      if (i >= 0) pos = at + i + n.length;
    });
    const Sel = v.state.selection.constructor;
    v.dispatch(v.state.tr.setSelection(Sel.near(v.state.doc.resolve(pos))));
    v.focus();
    return pos;
  }, needle);
}

const caret = (p) => p.evaluate(() => {
  const v = window.proof.editor.ctx.get('editorView');
  const from = v.state.selection.from;
  return { from, docEnd: v.state.doc.content.size, before: v.state.doc.textBetween(Math.max(0, from - 12), from, '/') };
});

const mike = await openAs('Mike Probe');
const eric = await openAs('Eric Probe');
console.log('mode:', MODE, '| Mike suggesting:', await mike.evaluate(() => window.proof.isSuggestionsEnabled()), '| Eric suggesting:', await eric.evaluate(() => window.proof.isSuggestionsEnabled()));

console.log('Mike caret placed at', await caretAfter(mike, 'play is ready.'), JSON.stringify(await caret(mike)));
await mike.evaluate(() => {
  const v = window.proof.editor.ctx.get('editorView');
  window.__ylog = [];
  const inner = v.dispatch.bind(v);
  v.dispatch = (tr) => {
    const selBefore = v.state.selection.from;
    inner(tr);
    const metas = Object.keys(tr.meta || {});
    if (metas.some((k) => k.startsWith('y-sync'))) {
      window.__ylog.push({
        steps: tr.steps.map((s) => { const j = s.toJSON(); return `${j.stepType}[${j.from}-${j.to}]`; }),
        metas: metas.join(','), selBefore, selAfter: v.state.selection.from,
      });
    }
  };
});

await caretAfter(eric, 'one more scene.');
for (const key of [' ', 'x', 'y', 'z']) {
  await eric.keyboard.type(key);
  await eric.waitForTimeout(400);
  console.log(`after Eric typed ${JSON.stringify(key)}: Mike caret`, JSON.stringify(await caret(mike)));
}
const ylog = await mike.evaluate(() => window.__ylog);
console.log(`Mike applied ${ylog.length} collaboration transactions; those that moved his caret:`);
for (const t of ylog.filter((x) => x.selBefore !== x.selAfter).slice(0, 8)) console.log('   ', JSON.stringify(t));
console.log('first 4 collaboration transactions:', JSON.stringify(ylog.slice(0, 4)));

await mike.keyboard.type('M');
await mike.waitForTimeout(1500);
const text = await mike.evaluate(() => window.proof.editor.ctx.get('editorView').state.doc.textContent.replace(/\n/g, ' / '));
console.log('Mike typed "M"; it landed', text.includes('ready.M') ? 'CORRECTLY after "play is ready."' : 'ELSEWHERE', '| text:', JSON.stringify(text));
await browser.close();
