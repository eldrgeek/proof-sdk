import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { unlinkSync } from 'node:fs';
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
    `proof-unified-history-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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
    let failures = 0;
    for (const source of ['playmaker', 'proof']) {
      for (const switchStyle of [true, false]) {
        const created = await mustJson(await fetch(`${httpBase}/api/documents`, {
          method: 'POST', headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'History cursor', markdown: 'Original\n\nSecond\n', marks: {} }),
        }));
        const page = await openEditor(browser, `${httpBase}/d/${created.slug}?token=${encodeURIComponent(created.accessToken)}&mode=edit`, 'Alice');
        let stage = 'style and initial typing';
        try {
          await page.getByLabel('Review style', { exact: true }).selectOption(source);
          await page.waitForTimeout(1000);
          const select = async (pos: number) => page.evaluate((at: number) => {
            const view = (window as any).proof.editor.ctx.get('editorView');
            view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.create(view.state.doc, at)));
            view.focus();
          }, pos);
          const text = () => page.evaluate(() => (window as any).proof.editor.ctx.get('editorView').state.doc.textContent);
          await select(5); await page.keyboard.type('XY');
          assert.equal(await text(), 'OrigXYinalSecond');
          await select(14);
          if (switchStyle) await page.getByLabel('Review style', { exact: true }).selectOption(source === 'proof' ? 'playmaker' : 'proof');
          await page.evaluate(() => (window as any).proof.editor.ctx.get('editorView').focus());
          const modifier = await page.evaluate(() => /Mac/.test(navigator.platform) ? 'Meta' : 'Control');
          stage = 'undo';
          await page.keyboard.press(`${modifier}+z`);
          assert.equal(await text(), 'OriginalSecond', 'Undo removes the last edit across styles');
          stage = 'redo';
          await page.keyboard.press(`${modifier}+Shift+z`);
          assert.equal(await text(), 'OrigXYinalSecond');
          assert.equal(await page.evaluate(() => (window as any).proof.editor.ctx.get('editorView').state.selection.from), 7, 'Redo restores cursor after XY');
          stage = 'typing after redo';
          await page.keyboard.type('Z');
          assert.equal(await text(), 'OrigXYZinalSecond', 'New typing lands after restored text');
          console.log(`PASS browser ${source} ${switchStyle ? 'switch' : 'cursor'}`);
        } catch {
          failures++;
          console.error(`FAIL browser ${source} ${switchStyle ? 'switch' : 'cursor'}: ${stage} failed`);
        } finally { await page.context().close(); }
      }
    }
    assert.equal(failures, 0, 'All real-page history probes pass');
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
    console.error(error instanceof Error ? error.message : 'Browser history test failed');
    process.exit(1);
  });
