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
  await page.addInitScript((slug: string) => {
    sessionStorage.setItem(`proof_share_welcome_${slug}`, '1');
    localStorage.setItem('proof:review-walk', 'false');
  }, new URL(url).pathname.split('/').pop());
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // The review document is not editable until Enter Editing. Readiness is the editor and the sync, not a caret in the text. Mike, 2026-09-23 (usability brief).
  await page.waitForFunction(() => Boolean(document.querySelector('.ProseMirror')) && (window as any).proof?.collabIsSynced === true);
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

    async function fixture(entries: Array<{ quote: string; content: string; kind?: string; by?: string }> = [{ quote: 'Original', content: 'Changed' }]) {
      const created = await mustJson(await fetch(`${httpBase}/api/documents`, {
        method: 'POST', headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'R1a2', markdown: entries.map(e => e.quote).join('\n\n'), marks: {} }),
      }));
      const headers = { ...CLIENT_HEADERS, 'Content-Type': 'application/json', 'x-share-token': created.ownerSecret };
      const ids: string[] = [];
      for (const entry of entries) {
        const result = await mustJson(await fetch(`${httpBase}/api/agent/${created.slug}/ops`, { method: 'POST', headers,
          body: JSON.stringify({ type: 'suggestion.add', kind: entry.kind || 'replace', by: entry.by || 'ai:Izzy', ...entry }) }));
        ids.push(result.markId);
      }
      const url = `${httpBase}/d/${created.slug}?token=${encodeURIComponent(created.accessToken)}`;
      const alice = await openEditor(browser, url, 'Alice'), bob = await openEditor(browser, url, 'Bob');
      for (const page of [alice, bob]) {
        await page.waitForFunction((n: number) => document.querySelectorAll('.pm-review-row').length === n, ids.length);
      }
      async function fetchState() { return await fetch(`${httpBase}/api/agent/${created.slug}/state`, { headers }); }
      return { alice, bob, ids, state: async () => mustJson(await fetchState()) };
    }
    const accept = async (page: any, id: string) => {
      await page.locator(`[data-review-row="${id}"]`).click();
      await page.locator(`.prw-card[data-mark-id="${id}"] .prw-accept`).click();
      await page.locator(`[data-review-row="${id}"]`).waitFor({ state: 'hidden' });
    };
    const history = async (page: any, redo = false) => {
      const marks = page.getByRole('button', { name: 'Marks', exact: true });
      if (await marks.isVisible()) await marks.focus();
      else await page.locator('.share-pill-suggest-toggle').focus();
      await page.keyboard.press(redo ? 'Control+Shift+z' : 'Control+z');
    };
    const routes = ['Meta+z', 'Control+z', 'Meta+Shift+z', 'Control+Shift+z', 'Meta+y', 'Control+y', 'historyUndo', 'historyRedo'];
    let failures = 0;
    for (const style of ['playmaker', 'proof']) for (const route of routes) {
      const { alice, bob, ids: [id] } = await fixture();
      try {
        const redo = !['Meta+z', 'Control+z', 'historyUndo'].includes(route);
        await accept(alice, id);
        if (redo) await history(alice);
        await bob.waitForFunction((text: string) => document.querySelector('.ProseMirror')?.textContent?.includes(text), redo ? 'Original' : 'Changed');
        await bob.getByRole('button', { name: 'Enter Editing', exact: true }).click();
        await bob.evaluate(() => {
          const view = (window as any).proof.editor.ctx.get('editorView'); view.dispatch(view.state.tr.insertText('BOB', 5));
        });
        await alice.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('BOB'));
        await alice.getByLabel('Review style', { exact: true }).selectOption(style);
        const snapshot = async (page: any) => page.evaluate(() => {
          const proof = (window as any).proof, h = proof.getReviewDecisionHistory();
          return JSON.stringify([proof.editor.ctx.get('editorView').state.doc.toJSON(), h.doc.getMap('marks').toJSON(), h.manager.undoStack.length, h.manager.redoStack.length, h.manager.lastChange]);
        });
        const before = await snapshot(alice), beforeBob = await snapshot(bob);
        await alice.locator('.ProseMirror').focus();
        if (route.startsWith('history')) await alice.locator('.ProseMirror').evaluate((element: HTMLElement, inputType: string) => element.dispatchEvent(new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true })), route);
        else await alice.keyboard.press(route);
        await alice.waitForTimeout(150);
        assert.equal(await snapshot(alice), before, 'refusal must preserve Alice document, records and both stacks');
        assert.equal(await snapshot(bob), beforeBob, 'refusal must preserve Bob');
        assert((await alice.locator(style === 'proof' ? '.review-history-notice' : '.pm-review-panel').innerText()).includes(`Can't ${redo ? 'redo' : 'undo'}: someone has changed this text since.`));
        console.log(`PASS ${style} ${route}`);
      } catch (e) { failures++; console.error(`FAIL ${style} ${route}: ${(e as Error).message.split('\n')[0]}`); }
      finally { await alice.context().close(); await bob.context().close(); }
    }
    assert.equal(failures, 0, 'R1a4 guarded input routes');
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
