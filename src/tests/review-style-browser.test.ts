import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { WebSocketServer } from 'ws';
const { chromium } = createRequire(import.meta.url)('playwright');
const CLIENT_HEADERS = { 'X-Proof-Client-Version': '0.31.2', 'X-Proof-Client-Build': 'r1a-browser-test', 'X-Proof-Client-Protocol': '3' };
async function mustJson(response: Response): Promise<any> {
  const body = await response.text();
  assert(response.ok, `HTTP ${response.status}: ${body}`);
  return JSON.parse(body);
}
async function openEditor(browser: any, url: string, name: string): Promise<any> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // This test uses only the local server, including all browser requests.
  await context.route('**/*', (route: any) => {
    const target = new URL(route.request().url());
    return target.hostname === '127.0.0.1' || target.hostname === 'localhost' ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  await page.addInitScript((slug: string) => sessionStorage.setItem(`proof_share_welcome_${slug}`, '1'), new URL(url).pathname.split('/').pop());
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.ProseMirror')?.getAttribute('contenteditable') === 'true');
  const nameInput = page.getByPlaceholder('Your name');
  if (await nameInput.isVisible()) {
    await nameInput.fill(name);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await nameInput.waitFor({ state: 'hidden' });
  }
  return page;
}
async function run(): Promise<void> {
  const root = process.cwd();
  const dbPath = path.join(
    os.tmpdir(),
    `proof-review-style-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';
  process.env.PROOF_DEFAULT_REVIEW_STYLE = 'playmaker';

  const [
    { apiRoutes },
    { agentRoutes },
    { setupWebSocket },
    collab,
    { shareWebRoutes },
    { createBridgeMountRouter },
    { enforceApiClientCompatibility, enforceBridgeClientCompatibility },
  ] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/agent-routes.js'),
    import('../../server/ws.js'),
    import('../../server/collab.js'),
    import('../../server/share-web-routes.js'),
    import('../../server/bridge.js'),
    import('../../server/client-capabilities.js'),
  ]);

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/assets', express.static(path.join(root, 'dist', 'assets')));
  app.use(express.static(path.join(root, 'public')));
  app.use('/api', enforceApiClientCompatibility, apiRoutes);
  app.use('/api/agent', agentRoutes);
  app.use(apiRoutes);
  app.use('/d', createBridgeMountRouter(enforceBridgeClientCompatibility));
  app.use('/documents', createBridgeMountRouter(enforceBridgeClientCompatibility));
  app.use('/documents', agentRoutes);
  app.use(shareWebRoutes);

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const httpBase = `http://127.0.0.1:${port}`;
  await collab.startCollabRuntimeEmbedded(port);

  let browser: any;
  try {
    browser = await chromium.launch();
    const artifacts = path.join(root, 'test-results', 'r1a');
    mkdirSync(artifacts, { recursive: true });
    const created = await mustJson(await fetch(`${httpBase}/api/documents`, {
      method: 'POST', headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Review together', markdown: '# Review together\n\nExamples are Tidy.\n\nA second proposal.\n\nA third proposal.\n\nA question for the author.\n', marks: {} }),
    }));
    const headers = { ...CLIENT_HEADERS, 'Content-Type': 'application/json', 'x-share-token': created.ownerSecret };
    const state = async () => mustJson(await fetch(`${httpBase}/api/agent/${created.slug}/state`, { headers }));
    const post = async (route: string, body: unknown) => mustJson(await fetch(`${httpBase}/api/agent/${created.slug}${route}`, { method: 'POST', headers, body: JSON.stringify(body) }));
    const ids: string[] = [];
    for (const [quote, content] of [['Examples are Tidy.', 'They include Tidy.'], ['A second proposal.', 'A clearer second proposal.'], ['A third proposal.', 'A clearer third proposal.']]) {
      const result = await post('/ops', { type: 'suggestion.add', kind: 'replace', quote, content, by: 'ai:Izzy' });
      assert(result.markId); ids.push(result.markId);
    }
    await post('/marks/comment', { quote: 'A question for the author.', text: 'Can we explain this example?', by: 'ai:Diana' });
    const initial = await state();
    const commentId = Object.keys(initial.marks).find(id => initial.marks[id].kind === 'comment')!;
    assert(commentId);
    const url = `${httpBase}/d/${created.slug}?token=${encodeURIComponent(created.accessToken)}`;
    const page = await openEditor(browser, url, 'Mike');
    page.on('pageerror', (error: Error) => console.error('PAGE ERROR', error));
    const dialog = page.locator('.pm-review-dialog');
    const check = async (expected: string[], label: string) => {
      let last: any;
      for (let attempt = 0; attempt < 100; attempt++) {
        last = await state();
        const open = Object.entries(last.marks || {}).filter(([, value]: [string, any]) =>
          value.kind === 'comment' ? !value.resolved : ['insert', 'delete', 'replace'].includes(value.kind) && !['accepted', 'rejected'].includes(value.status)
        ).map(([id]) => id).sort();
        const visible = await page.evaluate(() => (window as any).proof.getAllMarks().filter((mark: any) => mark.kind === 'comment' ? !mark.data?.resolved : ['insert', 'delete', 'replace'].includes(mark.kind) && !['accepted', 'rejected'].includes(mark.data?.status)).map((mark: any) => mark.id).sort());
        const detailsMatch = await page.evaluate((serverMarks: Record<string, any>) => (window as any).proof.getAllMarks().every((mark: any) => {
          if (!serverMarks[mark.id] || mark.kind === 'authored') return true;
          const stored = serverMarks[mark.id];
          return mark.kind === 'comment'
            ? mark.data.text === stored.text && JSON.stringify(mark.data.replies || []) === JSON.stringify(stored.replies || [])
            : mark.data.content === stored.content;
        }), last.marks);
        if (detailsMatch && JSON.stringify(open) === JSON.stringify([...expected].sort()) && JSON.stringify(visible) === JSON.stringify(open)) break;
        if (attempt === 99) throw new Error(`${label}: ${JSON.stringify({ expected, open, visible, last })}`);
        await page.waitForTimeout(100);
      }
      assert.equal(await page.locator('.pm-review-counts').textContent(), `${expected.length} open · ${4 - expected.length} settled`, label);
      const browserMarks = await page.evaluate(() => (window as any).proof.getAllMarks());
      for (const id of expected) {
        const mark = browserMarks.find((item: any) => item.id === id);
        assert.equal(mark.by, last.marks[id].by, `${label}: author`);
        if (mark.kind === 'comment') {
          assert.equal(mark.data.text, last.marks[id].text, `${label}: comment body`);
          assert.deepEqual(mark.data.replies || [], last.marks[id].replies || [], `${label}: replies`);
        } else assert.equal(mark.data.content, last.marks[id].content, `${label}: replacement`);
      }
      const text = await page.locator('.ProseMirror').innerText();
      assert.equal(text.includes('Examples are Tidy.'), (last.markdown || last.content).includes('Examples are Tidy.'), `${label}: original matches saved text`);
      console.log(`✓ ${label}: page and GET /state agree`);
      return last;
    };
    await page.waitForFunction(() => document.querySelectorAll('.pm-review-row').length === 4);
    assert.equal(await page.getByLabel('Review style', { exact: true }).inputValue(), 'playmaker', 'Server env reaches page');
    assert.equal(await dialog.count(), 0, 'Do not start review on arrival');
    await page.waitForTimeout(1000);
    await check([...ids, commentId], 'initial');
    const first = page.locator(`.ProseMirror [data-mark-id="${ids[0]}"]`).first();
    await first.waitFor({ state: 'visible' });
    const box = await first.boundingBox(); assert(box);
    await first.click({ position: { x: 6, y: 6 } });
    await dialog.waitFor();
    const dialogBox = await dialog.boundingBox(); assert(dialogBox);
    assert(Math.abs(dialogBox.x - (box.x + 6)) < 15, 'Dialog opens at click');
    assert((await dialog.innerText()).includes('They include Tidy.'));
    await page.screenshot({ path: path.join(artifacts, 'review-1280.png'), fullPage: true });
    // Dragging and keyboard focus containment.
    const drag = await page.locator('.pm-review-drag strong').boundingBox();
    await page.mouse.move(drag.x + 5, drag.y + 5); await page.mouse.down(); await page.mouse.move(drag.x + 45, drag.y + 25); await page.mouse.up();
    assert((await dialog.boundingBox()).x > dialogBox.x + 20);
    await page.getByRole('button', { name: 'Accept (A)', exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    assert(await dialog.evaluate((el: HTMLElement) => el.contains(document.activeElement)), 'Focus stays inside dialog');
    const decidedAt = Date.now();
    await page.keyboard.press('a');
    assert.equal(await dialog.count(), 0, 'Acting closes dialog');
    await check([ids[1], ids[2], commentId], 'accept');
    await page.waitForFunction((id: string) => document.querySelector('.pm-review-dialog')?.getAttribute('data-mark-id') === id, ids[1]);
    assert(Date.now() - decidedAt >= 800, 'Walk pauses before the next mark');
    await page.keyboard.press('r');
    await check([ids[2], commentId], 'reject');
    await page.waitForFunction((id: string) => document.querySelector('.pm-review-dialog')?.getAttribute('data-mark-id') === id, ids[2]);
    await page.keyboard.press('l');
    await check([ids[2], commentId], 'later');
    await page.waitForFunction((id: string) => document.querySelector('.pm-review-dialog')?.getAttribute('data-mark-id') === id, commentId);
    await page.keyboard.press('Control+z');
    await check([ids[1], ids[2], commentId], 'undo rejection');
    await page.keyboard.press('Control+Shift+z');
    await check([ids[2], commentId], 'redo rejection');
    await page.keyboard.press('Control+z');
    await check([ids[1], ids[2], commentId], 'undo rejection again');
    await page.keyboard.press('Control+z');
    const restored = await check([...ids, commentId], 'undo acceptance');
    assert.equal(restored.markdown, initial.markdown, 'Undo restores exact stored Markdown');
    assert.deepEqual(restored.marks, initial.marks, 'Undo restores exact stored mark records');
    await page.locator(`[data-review-row="${commentId}"]`).click();
    await page.keyboard.press('e'); await check(ids, 'resolve');
    await page.keyboard.press('Control+z'); await check([...ids, commentId], 'undo resolve');
    await page.locator(`[data-review-row="${commentId}"]`).click();
    await page.keyboard.press('c'); await page.getByRole('textbox', { name: 'Reply', exact: true }).fill('Yes, here is the context.');
    await page.getByRole('button', { name: 'Send reply', exact: true }).click();
    await check([...ids, commentId], 'reply');
    await page.keyboard.press('Control+z'); await check([...ids, commentId], 'undo reply');
    await page.getByLabel('Go to the next mark after I decide').uncheck();
    await page.setViewportSize({ width: 400, height: 900 });
    await page.locator(`[data-review-row="${ids[0]}"]`).click();
    const sheet = await dialog.boundingBox(); assert(sheet); assert.equal(sheet.x, 0); assert.equal(sheet.width, 400); assert(Math.abs(sheet.y + sheet.height - 900) < 2);
    await page.screenshot({ path: path.join(artifacts, 'review-400.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await page.screenshot({ path: path.join(artifacts, 'marks-400.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: path.join(artifacts, 'marks-1280.png'), fullPage: true });
    await page.getByLabel('Review style', { exact: true }).selectOption('proof');
    assert.equal(await page.locator('.pm-review-panel').isVisible(), false);
    await page.locator('.share-pill-suggestion-review').waitFor({ state: 'visible' });
    await first.click();
    await page.locator('.mark-popover').waitFor({ state: 'visible' });
    assert.equal(await dialog.count(), 0);
    const proofState = await state(); assert.deepEqual(proofState.marks, initial.marks, 'Switching changes no marks');
    await page.getByLabel('Review style', { exact: true }).selectOption('playmaker');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('.pm-review-row').length === 4);
    assert.equal(await page.getByLabel('Go to the next mark after I decide').isChecked(), false, 'Walk preference survives reload');
    assert.equal(await dialog.count(), 0);
    await page.getByRole('button', { name: 'Start review', exact: true }).click();
    assert.equal(await dialog.getAttribute('data-mark-id'), ids[0]);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Accept all', exact: true }).click();
    await check([commentId], 'accept all');
    await page.keyboard.press('Control+z'); await check([...ids, commentId], 'undo accept all');
    await page.getByRole('button', { name: 'Reject all', exact: true }).click();
    await check([commentId], 'reject all');
    await page.keyboard.press('Control+z'); await check([...ids, commentId], 'undo reject all');
    await page.getByRole('button', { name: 'Enter Editing', exact: true }).click();
    // Typing on the page dismisses the decision dialog and keeps native undo.
    await page.locator(`[data-review-row="${ids[0]}"]`).click();
    await page.locator('.ProseMirror h1').click();
    await page.keyboard.press('End'); await page.keyboard.type(' live typing');
    assert.equal(await dialog.count(), 0);
    await page.waitForTimeout(700);
    assert((await state()).markdown.includes('live typing'));
    const modifier = await page.evaluate(() => /Mac/.test(navigator.platform) ? 'Meta' : 'Control');
    await page.keyboard.press(`${modifier}+z`);
    await page.waitForTimeout(700);
    assert(!(await state()).markdown.includes('live typing'));
    await check([...ids, commentId], 'native typing undo');
    const bulkDoc = await mustJson(await fetch(`${httpBase}/api/documents`, {
      method: 'POST', headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Eleven decisions', markdown: Array.from({ length: 11 }, (_, i) => `Original paragraph number ${i}.`).join('\n\n'), marks: {} }),
    }));
    const bulkHeaders = { ...headers, 'x-share-token': bulkDoc.ownerSecret };
    for (let i = 0; i < 11; i++) await mustJson(await fetch(`${httpBase}/api/agent/${bulkDoc.slug}/ops`, {
      method: 'POST', headers: bulkHeaders,
      body: JSON.stringify({ type: 'suggestion.add', kind: 'replace', quote: `Original paragraph number ${i}.`, content: `Revised paragraph number ${i}.`, by: 'ai:Izzy' }),
    }));
    const bulkPage = await openEditor(browser, `${httpBase}/d/${bulkDoc.slug}?token=${bulkDoc.accessToken}`, 'Mike');
    await bulkPage.waitForFunction(() => document.querySelectorAll('.pm-review-row').length === 11);
    let confirmationCount = 0;
    bulkPage.on('dialog', async (confirmation: any) => { confirmationCount++; assert(confirmation.message().includes('11')); await confirmation.dismiss(); });
    await bulkPage.getByRole('button', { name: 'Accept all', exact: true }).click();
    await bulkPage.getByRole('button', { name: 'Reject all', exact: true }).click();
    assert.equal(confirmationCount, 2);
    assert.equal(await bulkPage.locator('.pm-review-row').count(), 11, 'Cancelling bulk confirmation leaves marks open');
    console.log('✓ bulk actions ask first above ten suggestions');
    console.log('✓ review styles, keyboard walk, undo/redo, reply, resolve, dragging, focus and responsive screenshots');
  } finally {
    await browser?.close();
    await collab.stopCollabRuntime();
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.closeAllConnections();
    await Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // Ignore missing temporary database files.
      }
    }
  }
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
