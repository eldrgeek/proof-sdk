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
        await page.getByLabel('Go to the next mark after I decide').uncheck();
      }
      async function fetchState() { return await fetch(`${httpBase}/api/agent/${created.slug}/state`, { headers }); }
      return { alice, bob, ids, state: async () => mustJson(await fetchState()), agentReply: async (id: string) => mustJson(await fetch(`${httpBase}/api/agent/${created.slug}/marks/reply`, { method: 'POST', headers, body: JSON.stringify({ markId: id, by: 'ai:Proof', text: 'External reply' }) })) };
    }
    let failures = 0;
    for (const source of ['api-ai', 'api-human', 'api-accept', 'server-ai', 'direct-ai', 'agent']) {
      if (process.argv[2] && process.argv[2] !== source) continue;
      const { alice, bob, ids: [id], agentReply, state } = await fixture();
      try {
        await alice.getByRole('button', { name: 'Enter Editing', exact: true }).click();
        await alice.evaluate(() => {
          const proof = (window as any).proof, view = proof.editor.ctx.get('editorView');
          proof.getReviewDecisionHistory().manager.clear();
          view.dispatch(view.state.tr.insertText(' ALICE', view.state.doc.content.size - 1));
          proof.getReviewDecisionHistory().manager.stopCapturing();
        });
        await bob.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('ALICE'));
        const count = await alice.evaluate(() => (window as any).proof.getReviewDecisionHistory().manager.undoStack.length);
        if (source === 'agent') {
          for (let attempt = 0; attempt < 30; attempt++) {
            if ((await state()).markdown.includes('ALICE')) break;
            await alice.waitForTimeout(200);
          }
          await alice.waitForTimeout(1000);
          await agentReply(id);
        }
        else await alice.evaluate(({ id, source }: any) => {
          const proof = (window as any).proof;
          if (source.startsWith('api-')) {
            if (source === 'api-accept') proof.markAccept(id);
            else proof.markReply(id, source === 'api-ai' ? 'ai:Proof' : 'human:API', 'External reply');
          } else {
            const h = proof.getReviewDecisionHistory(), map = h.doc.getMap('marks');
            const value = { ...map.get(id), replies: [{ by: 'ai:Proof', text: 'External reply', at: '2026-09-15T00:00:00Z' }] };
            if (source === 'server-ai') h.doc.transact(() => map.set(id, value), 'server-ai');
            else {
              const view = proof.editor.ctx.get('editorView');
              const key = view.state.plugins.find((p: any) => p.key === 'marks$');
              view.dispatch(view.state.tr.setMeta(key, { type: 'SET_METADATA', metadata: { ...map.toJSON(), [id]: value } }).setMeta('proofLocalMarkChange', true));
            }
          }
        }, { id, source });
        await bob.waitForFunction(({ id, accept }: any) => {
          const proof = (window as any).proof, map = proof.getReviewDecisionHistory().doc.getMap('marks');
          return accept ? !map.has(id) : map.get(id)?.replies?.some((r: any) => r.text === 'External reply');
        }, { id, accept: source === 'api-accept' });
        assert.equal(await alice.evaluate(() => (window as any).proof.getReviewDecisionHistory().manager.undoStack.length), count, 'External mark write creates no history entry');
        await alice.evaluate(() => (window as any).proof.restoreReviewDecision(false));
        await bob.waitForFunction(() => !document.querySelector('.ProseMirror')?.textContent?.includes('ALICE'));
        for (const page of [alice, bob]) {
          const kept = await page.evaluate(({ id, accept }: any) => {
            const map = (window as any).proof.getReviewDecisionHistory().doc.getMap('marks');
            return accept ? !map.has(id) : map.get(id)?.replies?.some((r: any) => r.text === 'External reply');
          }, { id, accept: source === 'api-accept' });
          assert(kept, 'Alice undo preserves the external operation on both documents');
        }
        console.log(`PASS ${source}`);
      } catch (e) { failures++; console.error(`FAIL ${source}: ${(e as Error).message.split('\n')[0]}`); }
      finally { await alice.context().close(); await bob.context().close(); }
    }
    assert.equal(failures, 0, 'R1a4 external mark history');
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
