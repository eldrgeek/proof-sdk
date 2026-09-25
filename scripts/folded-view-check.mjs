#!/usr/bin/env node
// ac-2a8. Mike, 2026-09-24, yfbqrau4 point 9. Local browser gate; reviewer runs Chromium.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
import { showReview } from './review-ui.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const arg = key => { const i = process.argv.indexOf(key); return i > 0 ? process.argv[i + 1] : null; };
const styles = arg('--style') ? [arg('--style')] : ['playmaker', 'proof'];
const widths = arg('--width') ? [Number(arg('--width'))] : [1440, 390];
const shots = arg('--shots') || path.join(root, '.preview'); mkdirSync(shots, { recursive: true });
const headers = { 'Content-Type': 'application/json', 'X-Proof-Client-Version': '0.33.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
async function start(style) {
  const socket = createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  const temp = mkdtempSync(path.join(tmpdir(), 'accord-click-edit-'));
  const log = path.join(temp, 'server.log'); const fd = openSync(log, 'w');
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      PORT: String(port), DATABASE_PATH: path.join(temp, 'test.db'), SNAPSHOT_DIR: path.join(temp, 'snapshots'),
      COLLAB_EMBEDDED_WS: '1', PROOF_DEFAULT_REVIEW_STYLE: style }, stdio: ['ignore', fd, fd] });
  closeSync(fd); const base = `http://127.0.0.1:${port}`;
  const stop = async () => { child.kill('SIGTERM'); if (child.exitCode === null) await new Promise(r => child.once('exit', r)); rmSync(temp, { recursive: true, force: true }); };
  for (let i = 0; i < 200; i++) {
    if ((await fetch(`${base}/health`).catch(() => null))?.ok) return { base, stop, log };
    await new Promise(r => setTimeout(r, 150));
  }
  await stop(); throw Error('Local server failed to start');
}
async function request(base, route, body, token) {
  const r = await fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(token ? { 'x-share-token': token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(r.ok, `${route}: ${r.status} ${r.ok ? '' : await r.text()}`); return r.json();
}
async function reader(browser, base, slug, name, width) {
  const context = await browser.newContext(width < 700 ? { ...devices['iPhone 13'], viewport: { width, height: 844 } } : { viewport: { width, height: 900 } });
  await context.addInitScript(name => { localStorage.setItem('proof-share-viewer-name', name); }, name);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/d/${slug}`);
  // Existing name prompt varies with first-visit state. Give this context its own identity.
  const prompt = page.getByRole('button', { name: /Continue anonymously/i });
  if (await prompt.isVisible().catch(() => false)) await prompt.click();
  await page.waitForFunction(() => window.proof?.collabIsSynced && window.__proofReadingWalk?.debugState().ready && window.__proofLineMarks?.debugState().loaded);
  const welcome = page.locator('.proof-share-welcome-toast button');
  if (await welcome.count()) await welcome.first().click();
  return { context, page, errors };
}

const markdown = ['# Folded view', 'Opening word: preamble.', '## List',
  '1. Entry one hidden.\n2. Entry two hidden.\n3. Entry three open.\n4. Entry four hidden.\n5. Entry five open.\n6. Entry six hidden.',
  '## Nested', '### Path heading', 'Nested proposal open.', 'Nested hidden word: sapphire.',
  '## Quiet', 'Quiet body hidden.'].join('\n\n');
const state = page => page.evaluate(() => window.__proofFolding.debugState());
const whole = page => page.locator('[data-accord-whole-toggle]');
const lineIndex = (page, text) => page.evaluate(text => window.__proofLineMarks.lineList().find(l => l.text.includes(text))?.index, text);
const shownTexts = page => page.evaluate(() => {
  const f=window.__proofFolding, lm=window.__proofLineMarks, view=lm.editorView();
  return lm.lineList().filter(l=>!f.isHidden(l.index)).map(l=>({text:l.text, height:view.nodeDOM(l.pos).getBoundingClientRect().height}));
});
const ready = page => page.waitForFunction(() => window.__proofFolding?.debugState().ready && window.proof?.collabIsSynced);
async function caret(page, text, end = false) {
  const point = await page.evaluate(({text,end})=>{
    const lm=window.__proofLineMarks, l=lm.lineList().find(l=>l.text.includes(text)), v=lm.editorView();
    const pos=l.pos+(end?l.nodeSize-1:1); v.nodeDOM(l.pos).scrollIntoView({block:'center'});
    const r=v.coordsAtPos(pos); return {pos,x:r.left+1,y:(r.top+r.bottom)/2};
  },{text,end});
  await page.mouse.click(point.x,point.y);
  await page.waitForFunction(pos=>window.__editorView.state.selection.head===pos,point.pos);
}
async function run(browser, server, style, width) {
  const created=await request(server.base,'/documents',{title:'Folded view',markdown,role:'editor'});
  const api=(route,body)=>request(server.base,`/api/agent/${created.slug}${route}`,body,created.ownerSecret);
  for(const [quote,content] of [['Entry three open.','Entry three proposed.'],['Entry five open.','Entry five proposed.'],['Nested proposal open.','Nested proposal proposed.']])
    await api('/marks/suggest-replace',{quote,content,by:'ai:folded',why:'Local folded-view fixture.'});
  const a=await reader(browser,server.base,created.slug,'Alice',width);
  const b=await reader(browser,server.base,created.slug,'Bob',width);
  const page=a.page, tag=`folded-view-${style}-${width}`;
  try {
    await ready(page);
    const initial=await state(page);
    assert.deepEqual(initial.shown,[0,2,5,7,9,10,11,13]);
    assert.equal(initial.count,'3 open for you · 12 in accord');
    assert.deepEqual(initial.runs.map(r=>r.label),['1 item in accord','2 items in accord','1 item in accord','1 item in accord','1 item in accord','1 item in accord']);
    for(const line of await shownTexts(page)) assert.ok(line.height>0,`Shown item hidden in DOM: ${line.text}`);
    assert.equal(await page.locator('[data-tab="outline"], [data-tab="since"], .anv-outline, .prw-since').count(),0);
    const numbers=await page.locator('.ProseMirror ol > li:not(.pfold-hidden):not(.aov-rule-entry)').evaluateAll(nodes=>nodes.map(n=>n.value));
    assert.deepEqual(numbers,[3,5]);
    const countRect=await page.locator('.aov-header').boundingBox(), titleRect=await page.locator('.ProseMirror h1').boundingBox();
    assert.ok(countRect.y+countRect.height<=titleRect.y);
    if(width<700) {
      for(const rule of await page.locator('.aov-rule').all()) assert.ok((await rule.boundingBox()).height>=44);
      await page.locator('.prw-strip-review').click();
      await page.locator('.prw-right.prw-sheet-open').waitFor({state:'visible'});
    }
    if(width<700 && await page.locator('.prw-right.prw-sheet-open').count()) await page.locator('.prw-right .prw-collapse').click();
    // The menu uses the same toggle, including the phone overflow menu.
    const menu = () => width<700 ? page.locator('#share-banner .share-pill-overflow').click() : page.locator('#accord-menubar .amb-top[data-menu="view"]').click();
    await menu(); await page.getByRole('menuitem',{name:'Show the whole Accord',exact:true}).click();
    assert.equal((await state(page)).hidden.length,0);
    await menu(); await page.getByRole('menuitem',{name:'Show only open items',exact:true}).click();
    assert.deepEqual((await state(page)).shown,initial.shown);
    await page.screenshot({path:path.join(shots,`${tag}-arrival.png`),fullPage:true});
    await showReview(page);
    await page.locator('.anv-issue[data-line="5"]').click(); await page.keyboard.press('a');
    await page.waitForFunction(()=>window.__proofFolding.countText()==='2 open for you · 13 in accord');
    assert.deepEqual((await state(page)).shown,initial.shown,'Acceptance changed visibility');
    // A second reader proposes a replacement in a still-hidden line.
    const before=await page.evaluate(()=>({scroll:scrollY,boxes:window.__proofLineMarks.lineList().filter(l=>!window.__proofFolding.isHidden(l.index)).map(l=>{
      const r=window.__editorView.nodeDOM(l.pos).getBoundingClientRect(); return [l.index,r.top,r.height];
    })}));
    await whole(b.page).click();
    await b.page.evaluate(()=>window.proof.markSuggestReplace('Entry two hidden.','ai:second-writer','Entry two proposed.'));
    await page.waitForFunction(()=>window.__proofFolding.countText()==='3 open for you · 12 in accord');
    assert.deepEqual((await state(page)).shown,initial.shown);
    assert.ok((await state(page)).runs.some(r=>r.label==='2 items, 1 open'));
    await page.locator('.anv-issue[data-line="4"]').waitFor({state:'visible'});
    const after=await page.evaluate(()=>({scroll:scrollY,boxes:window.__proofLineMarks.lineList().filter(l=>!window.__proofFolding.isHidden(l.index)).map(l=>{
      const r=window.__editorView.nodeDOM(l.pos).getBoundingClientRect(); return [l.index,r.top,r.height];
    })}));
    assert.deepEqual(after,before,'Remote hidden proposal moved shown text');
    // New rows append. J reaches the new row after the remaining original proposals.
    await page.locator('.anv-issue[data-line="11"]').click(); await page.keyboard.press('j');
    await page.waitForFunction(()=>window.__proofReadingWalk.focusIndex()===4);
    assert.equal(await page.evaluate(()=>window.__proofFolding.isHidden(4)),false);
    assert.equal(await page.evaluate(()=>window.__proofFolding.isHidden(3)),true);
    assert.equal(await page.evaluate(()=>window.__proofFolding.isFolded(2)),true);
    // Close the sheet before document gestures on a phone.
    if(width<700) await page.locator('.prw-right .prw-collapse').click();
    const run=(await state(page)).runs.find(r=>r.from===6);
    const beforeRule=(await state(page)).shown;
    await page.locator(`.aov-rule[data-from="${run.from}"]`).click();
    assert.deepEqual((await state(page)).shown.filter(i=>!beforeRule.includes(i)),[6]);
    await page.locator('.pfold-chip[data-heading="2"]').click();
    assert.equal(await page.evaluate(()=>window.__proofFolding.isHidden(3)),false);
    await page.locator('.pfold-chip[data-heading="2"]').click();
    assert.equal(await page.evaluate(()=>window.__proofFolding.isHidden(3)),true);
    assert.equal(await page.evaluate(()=>window.__proofFolding.isHidden(6)),false,'Rule disclosure was lost on refold');
    await whole(page).click(); assert.equal((await state(page)).hidden.length,0);
    assert.equal(await whole(page).innerText(),'Show only open items');
    await whole(page).click(); assert.ok((await state(page)).hidden.length>0);
    await whole(page).click(); await page.reload(); await ready(page);
    assert.equal((await state(page)).whole,false,'Reload inherited whole view');
    assert.equal(await page.evaluate(()=>Object.keys(localStorage).some(k=>k.startsWith('proof:fold:'))),false);
    // The hidden fourth entry precedes entry five after the new visit.
    if(width<700 && await page.locator('.prw-right.prw-sheet-open').count()) await page.locator('.prw-right .prw-collapse').click();
    await caret(page,'Entry five open.');
    const textBefore=await page.evaluate(()=>window.__editorView.state.doc.textContent);
    await page.keyboard.press('Backspace');
    await page.getByText('That would change hidden text. Show it first.',{exact:true}).waitFor({state:'visible'});
    assert.equal(await page.evaluate(()=>window.__editorView.state.doc.textContent),textBefore);
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(()=>window.__proofFolding.isHidden(window.__proofLineMarks.lineAtPos(window.__editorView.state.selection.head))),false);
    await caret(page,'Entry five open.',true); await page.keyboard.type(' live');
    await page.waitForFunction(()=>window.proof.getAllMarks().some(m=>m.by==='human:Alice' && m.data?.content?.includes(' live')));
    // Find searches the hidden item through the actual Edit menu control.
    await page.keyboard.press('Escape');
    if(width<700) await page.locator('#share-banner .share-pill-overflow').click();
    else await page.locator('#accord-menubar .amb-top[data-menu="edit"]').click();
    await page.getByRole('menuitem',{name:/^Find/}).click();
    const find=page.getByPlaceholder('Find in this document'); await find.fill('sapphire'); await find.press('Enter');
    const index=await lineIndex(page,'sapphire');
    assert.equal(await page.evaluate(i=>window.__proofFolding.isHidden(i),index),false);
    assert.equal(await page.evaluate(()=>window.__proofFolding.isHidden(14)),true,'Find unfolded an unrelated section');
    await page.screenshot({path:path.join(shots,`${tag}-find.png`),fullPage:true});
    assert.deepEqual(a.errors,[]); assert.deepEqual(b.errors,[]);
    console.log(`PASS ${tag}: arrival, counts, acceptance, remote proposal, J, rules, chips, toggle, reload, editing guard, arrows, Find, phone sheet`);
  } catch(error) { await page.screenshot({path:path.join(shots,`${tag}-FAIL.png`),fullPage:true}).catch(()=>{}); throw error; }
  finally { await a.context.close(); await b.context.close(); }
}
async function delayedLoad(browser, server, style) {
  const created=await request(server.base,'/documents',{title:'Delayed load',markdown:'# Delayed load\n\nHidden while loading.',role:'editor'});
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  await context.addInitScript(()=>localStorage.setItem('proof-share-viewer-name','Timeout reader'));
  await context.route('**/*', route=>new URL(route.request().url()).origin===server.base?route.continue():route.abort());
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  await context.route('**/documents/*/line-marks*', async route=>{await gate; await route.continue().catch(()=>{});});
  const page=await context.newPage();
  try {
    await page.goto(`${server.base}/d/${created.slug}`);
    await page.waitForFunction(()=>window.__proofFolding);
    assert.equal(await page.locator('.ProseMirror > h1').isVisible(),false,'Document text appeared before open items loaded');
    await page.waitForFunction(()=>window.__proofFolding.debugState().timedOut,null,{timeout:8000});
    assert.equal(await page.locator('.ProseMirror > h1').isVisible(),true);
    assert.match(await page.locator('.aov-header-text').innerText(),/did not load.*whole Accord/);
    release(); await page.waitForFunction(()=>window.__proofLineMarks.isLoaded());
    assert.equal((await state(page)).whole,true,'Late open items collapsed the visible page');
    await page.screenshot({path:path.join(shots,`folded-view-${style}-timeout.png`),fullPage:true});
    console.log(`PASS folded-view-${style}: blank loading, five-second fallback, no late collapse`);
  } finally { release(); await context.close(); }
}
const browser=await chromium.launch();
try { for(const style of styles) { const server=await start(style); try { for(const width of widths) await run(browser,server,style,width); await delayedLoad(browser,server,style); } finally { await server.stop(); } } }
finally { await browser.close(); }
