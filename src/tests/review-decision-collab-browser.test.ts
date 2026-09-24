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
    // The dialog walk's checkbox is not in the review flow. The preference it used to set still
    // starts on, and a decision would open the next mark. Mike, 2026-09-23 (usability brief).
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

    const tests: Record<string, () => Promise<void>> = {};
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
    const mapRecord = (page: any, id: string) => page.evaluate((id: string) => (window as any).proof.getReviewDecisionHistory().doc.getMap('marks').get(id), id);
    const changeRecord = (page: any, id: string, changes: any) => page.evaluate(({ id, changes }: any) => {
      const map = (window as any).proof.getReviewDecisionHistory().doc.getMap('marks'); map.set(id, { ...map.get(id), ...changes });
    }, { id, changes });
    // A row selects the passage. It does not open a review dialog. The margin Accept is the same
    // decision the dialog's Accept button used, so one Undo still removes it. Mike, 2026-09-23 (usability brief).
    const accept = async (page: any, id: string) => {
      await page.locator(`[data-review-row="${id}"]`).click();
      await page.locator(`.prw-card[data-mark-id="${id}"] .prw-accept`).click();
      await page.locator(`[data-review-row="${id}"]`).waitFor({ state: 'hidden' });
    };
    const documentText = (page: any) => page.evaluate(() => (window as any).proof.editor.ctx.get('editorView').state.doc.textContent);
    const history = async (page: any, redo = false) => {
      // Undo while focus is outside the text. The Marks button is not always on screen; the
      // Editing control is. The key still reaches the one Undo. Mike, 2026-09-23 (usability brief).
      const marks = page.getByRole('button', { name: 'Marks', exact: true });
      if (await marks.isVisible()) await marks.focus();
      else await page.locator('.share-pill-suggest-toggle').focus();
      await page.keyboard.press(redo ? 'Control+Shift+z' : 'Control+z');
    };
    tests['2'] = async () => {
      const { alice, bob, ids: [id], state } = await fixture();
      const details = { createdAt: '2026-01-01T00:00:00Z', replies: [{ by: 'human:Bob', text: 'Keep this explanation', at: '2026-01-02T00:00:00Z' }] };
      await changeRecord(bob, id, details);
      await alice.waitForFunction(({ id, at }: any) => (window as any).proof.getAllMarks().find((m: any) => m.id === id)?.at === at, { id, at: details.createdAt });
      const original = await mapRecord(alice, id);
      await accept(alice, id); await bob.waitForFunction(() => document.querySelectorAll('.pm-review-row').length === 0);
      await history(alice); await bob.waitForFunction(() => document.querySelectorAll('.pm-review-row').length === 1);
      await alice.waitForTimeout(1200);
      for (const page of [alice, bob]) {
        assert.deepEqual(await mapRecord(page, id), original, 'Shared map must restore exact record');
        const metadata = await page.evaluate((id: string) => {
          const view = (window as any).proof.editor.ctx.get('editorView');
          return view.state.plugins.find((p: any) => p.key === 'marks$').getState(view.state).metadata[id];
        }, id);
        assert.equal(metadata.createdAt, original.createdAt); assert.deepEqual(metadata.replies, original.replies);
      }
      assert.deepEqual((await state()).marks[id], original, '/state must restore exact record');
    };
    tests['4'] = async () => {
      const { alice, bob, ids: [id], state } = await fixture();
      await accept(alice, id); await history(alice);
      await bob.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('Original'));
      await bob.getByRole('button', { name: 'Enter Editing', exact: true }).click();
      await bob.evaluate(() => {
        const view = (window as any).proof.editor.ctx.get('editorView'); view.dispatch(view.state.tr.insertText('BOB', 5));
      });
      await alice.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('OrigBOBinal'));
      await history(alice, true); await alice.waitForTimeout(500);
      for (const page of [alice, bob]) assert((await documentText(page)).includes('OrigBOBinal'), 'Bob’s text must survive redo');
      const refusal = "Can't redo: someone has changed this text since.";
      const shown = await alice.evaluate(() => [...document.querySelectorAll('.pm-review-panel, .pundo-notice, .review-history-notice')]
        .filter(el => (el as HTMLElement).hidden !== true && getComputedStyle(el).display !== 'none')
        .map(el => el.textContent || '').join('\n'));
      assert(shown.includes(refusal), `Visible one-line refusal. saw: ${JSON.stringify(shown)}`);
      assert((await state()).markdown.includes('OrigBOBinal'));
    };
    tests['5'] = async () => {
      const entries = Array.from({ length: 11 }, (_, i) => ({ quote: `Original paragraph ${i}`, content: `Changed paragraph ${i}`, kind: i === 0 ? 'insert' : 'replace', by: i === 0 ? 'human:Alice' : 'ai:Izzy' }));
      const { alice, bob, ids, state } = await fixture(entries);
      // The insertion's recorded table row has become a paragraph. Its structural
      // rejection must refuse, while the ten ordinary replacements remain valid.
      await changeRecord(bob, ids[0], { insertStructure: 'table_row' });
      await alice.waitForFunction((id: string) => (window as any).proof.getReviewDecisionHistory().doc.getMap('marks').get(id)?.insertStructure === 'table_row', ids[0]);
      const before = await state();
      const beforeText = await alice.locator('.ProseMirror').innerText();
      alice.on('dialog', (dialog: any) => dialog.accept());
      await alice.getByRole('button', { name: 'Reject all', exact: true }).click(); await alice.waitForTimeout(600);
      assert.equal(await alice.locator('.pm-review-row').count(), 11, 'Failed batch must leave all eleven open');
      assert.equal(await alice.locator('.ProseMirror').innerText(), beforeText);
      assert.deepEqual((await state()).marks, before.marks);
      assert((await alice.locator('.pm-review-panel').innerText()).includes("1 of 11 suggestions changed and can't be rejected. Nothing was changed."));
      assert.equal(await alice.locator(`[data-review-row="${ids[0]}"]`).getAttribute('aria-invalid'), 'true');
    };
    tests['6'] = async () => {
      const { alice, bob, ids: [id], state } = await fixture();
      await changeRecord(bob, id, { content: 'Refreshed proposal' });
      await alice.waitForFunction((id: string) => (window as any).proof.getAllMarks().find((m: any) => m.id === id)?.data?.content === 'Refreshed proposal', id);
      // There is no review dialog holding a stale preview. Accept applies the current proposal.
      await accept(alice, id);
      await bob.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('Refreshed proposal'));
      const text = await documentText(alice);
      assert(text.includes('Refreshed proposal'), 'Accept applies the current proposal');
      assert(!text.includes('Changed'), 'Accept does not apply the proposal Bob already replaced');
      assert((await state()).markdown.includes('Refreshed proposal'));
    };
    tests['history-order'] = async () => {
      const { alice, ids: [id] } = await fixture([{ quote: 'Original', content: 'Changed' }, { quote: 'Another paragraph', content: 'Another proposal' }]);
      await accept(alice, id);
      await alice.getByRole('button', { name: 'Enter Editing', exact: true }).click();
      await alice.evaluate(() => {
        const view = (window as any).proof.editor.ctx.get('editorView');
        view.dispatch(view.state.tr.insertText(' local', view.state.doc.content.size - 1));
      });
      await history(alice);
      assert(!(await documentText(alice)).includes(' local'), 'Undo from the queue must undo the most recent edit');
      assert((await documentText(alice)).includes('Changed'), 'The accepted text must be Changed');
      await alice.locator('.ProseMirror').focus(); await alice.keyboard.press('Control+z');
      assert((await documentText(alice)).includes('Original'), 'Next undo must undo the decision even with text focus');
      await history(alice, true);
      assert((await documentText(alice)).includes('Changed'), 'The accepted text must be Changed');
      await history(alice, true);
      assert((await documentText(alice)).includes(' local'), 'Second redo must restore the local edit');
    };
    let failures = 0;
    for (const [id, test] of Object.entries(tests)) {
      if (process.argv[2] && process.argv[2] !== id) continue;
      try { await test(); console.log(`PASS browser finding ${id}`); }
      catch (e) { failures++; console.error(`FAIL browser finding ${id}: ${(e as Error).message.split('\n')[0]}`); }
    }
    assert.equal(failures, 0, 'R1a2 browser regressions');
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
