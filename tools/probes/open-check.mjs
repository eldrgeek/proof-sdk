// open-check.mjs — does a document open and become editable, and how long does it take?
// Opens the document in a fresh browser, waits up to TIMEOUT_MS for the editor to become editable, then prints
// the time it took, whether the editor exists, its top-level blocks, any error banner, and the page's console
// errors and warnings. Use it on a document that failed to reopen.
// Env: PROOF_DOC_URL (tokenized — never printed); TIMEOUT_MS (default 90000).
// Authored 2026-09-14 by Claude Opus 5 (CCc) for Mike Wolf.
import { createRequire } from 'module';

const require = createRequire('/Users/mikewolf/Projects/playmaker/package.json');
const { chromium } = require('playwright');

const DOC_URL = process.env.PROOF_DOC_URL;
const TIMEOUT = Number(process.env.TIMEOUT_MS ?? 90000);
if (!DOC_URL) { console.error('need PROOF_DOC_URL'); process.exit(2); }

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
const messages = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') messages.push(`${m.type()}: ${m.text().slice(0, 220)}`); });
page.on('pageerror', (e) => messages.push(`pageerror: ${String(e).slice(0, 220)}`));

const started = Date.now();
await page.goto(DOC_URL, { waitUntil: 'domcontentloaded' });
let editableAfterMs = null;
try {
  await page.waitForFunction(() => document.querySelector('.ProseMirror')?.getAttribute('contenteditable') === 'true', null, { timeout: TIMEOUT });
  editableAfterMs = Date.now() - started;
} catch {
  // reported below as editableAfterMs: null
}

const info = await page.evaluate(() => {
  const pm = document.querySelector('.ProseMirror');
  let blocks;
  try {
    const v = window.proof?.editor?.ctx.get('editorView');
    const out = [];
    v.state.doc.forEach((node) => out.push(`${node.type.name}: ${node.textContent.slice(0, 60)}`));
    blocks = out;
  } catch (error) {
    blocks = `unavailable: ${String(error).slice(0, 120)}`;
  }
  return {
    hasEditor: Boolean(pm),
    contenteditable: pm?.getAttribute('contenteditable') ?? null,
    blocks,
    banner: document.querySelector('[role=alert], .share-banner, .error-banner')?.textContent?.slice(0, 200) ?? null,
  };
});
console.log(JSON.stringify({ editableAfterMs, waitedUpToMs: TIMEOUT, ...info }));
console.log(`console errors and warnings (${messages.length}, first 15):`);
for (const line of messages.slice(0, 15)) console.log('  ', line);
await browser.close();
