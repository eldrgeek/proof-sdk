import { createRequire } from 'node:module';
import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { WebSocketServer } from 'ws';

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.31.2',
  'X-Proof-Client-Build': 'concurrent-typing-browser-test',
  'X-Proof-Client-Protocol': '3',
};

const INITIAL_MARKDOWN = [
  '# Proof E2E',
  '',
  'ERIC\\',
  'I think teh play is ready.',
  '',
  'DIANA\\',
  'The second act needs one more scene.',
  '',
].join('\n');

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function mustJson<T>(response: Response, label: string): Promise<T> {
  const body = await response.text();
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}: ${body.slice(0, 500)}`);
  return JSON.parse(body) as T;
}

async function waitForAsync(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function loadChromium(): any {
  const packageJson = process.env.PROOF_PLAYWRIGHT_PACKAGE_JSON;
  const require = createRequire(packageJson || import.meta.url);
  try {
    return require('playwright').chromium;
  } catch {
    throw new Error(
      'Playwright is required. Set PROOF_PLAYWRIGHT_PACKAGE_JSON to a package.json beside an installed playwright package.',
    );
  }
}

async function openEditor(browser: any, url: string, name: string, suggest: boolean): Promise<any> {
  const context = await browser.newContext({ viewport: { width: 1100, height: 640 } });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.querySelector('.ProseMirror')?.getAttribute('contenteditable') === 'true',
    null,
    { timeout: 30_000 },
  );

  const nameInput = page.getByPlaceholder('Your name');
  if (await nameInput.isVisible()) {
    await nameInput.fill(name);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await nameInput.waitFor({ state: 'hidden', timeout: 10_000 });
    await page.waitForTimeout(500);
  }

  const suggestionsEnabled = await page.evaluate(() => (window as any).proof.isSuggestionsEnabled());
  if (suggestionsEnabled !== suggest) {
    await page.click('.share-pill-suggest-toggle');
  }
  return page;
}

async function placeCaretAfter(page: any, needle: string): Promise<void> {
  const found = await page.evaluate((text: string) => {
    const view = (window as any).proof.editor.ctx.get('editorView');
    let position = -1;
    view.state.doc.descendants((node: any, at: number) => {
      if (position >= 0 || !node.isText) return;
      const index = node.text.indexOf(text);
      if (index >= 0) position = at + index + text.length;
    });
    if (position < 0) return false;
    const Selection = view.state.selection.constructor;
    view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(position))));
    view.focus();
    return true;
  }, needle);
  assert(found, `Could not place caret after "${needle}"`);
}

async function readEditor(page: any): Promise<{
  text: string;
  markdown: string;
  insertSuggestions: Array<{ by: string; text: string }>;
  suggestionSegments: Array<{ id: string; by: string; from: number; to: number; text: string }>;
}> {
  return page.evaluate(() => {
    const proof = (window as any).proof;
    const view = proof.editor.ctx.get('editorView');
    const insertSuggestions = (proof.getAllMarks() || [])
      .filter((mark: any) => mark.kind === 'insert' && mark.range)
      .map((mark: any) => ({
        by: String(mark.by),
        text: view.state.doc.textBetween(mark.range.from, mark.range.to, '\n', '\n'),
      }));
    const suggestionSegments: Array<{ id: string; by: string; from: number; to: number; text: string }> = [];
    view.state.doc.descendants((node: any, from: number) => {
      if (!node.isText) return true;
      for (const mark of node.marks) {
        if (mark.type.name !== 'proofSuggestion' || mark.attrs.kind !== 'insert') continue;
        suggestionSegments.push({
          id: String(mark.attrs.id),
          by: String(mark.attrs.by),
          from,
          to: from + node.nodeSize,
          text: node.text ?? '',
        });
      }
      return true;
    });
    return {
      text: view.state.doc.textContent,
      markdown: proof.getMarkdownSnapshot()?.content ?? '',
      insertSuggestions,
      suggestionSegments,
    };
  });
}

async function runMode(
  httpBase: string,
  chromium: any,
  mode: 'edit' | 'suggest',
): Promise<void> {
  const created = await mustJson<{
    slug: string;
    tokenUrl: string;
    accessToken: string;
  }>(await fetch(`${httpBase}/api/documents`, {
    method: 'POST',
    headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: `Concurrent typing ${mode}`,
      markdown: INITIAL_MARKDOWN,
      marks: {},
    }),
  }), `create ${mode} document`);

  const browserA = await chromium.launch();
  const browserB = await chromium.launch();
  try {
    const url = `${httpBase}/d/${created.slug}?token=${encodeURIComponent(created.accessToken)}`;
    const [mike, eric] = await Promise.all([
      openEditor(browserA, url, 'Mike Concurrent', mode === 'suggest'),
      openEditor(browserB, url, 'Eric Concurrent', mode === 'suggest'),
    ]);

    await Promise.all([
      placeCaretAfter(mike, 'play is ready.'),
      placeCaretAfter(eric, 'one more scene.'),
    ]);
    await Promise.all([
      mike.keyboard.type(' mike typed words', { delay: 40 }),
      eric.keyboard.type(' eric typed words', { delay: 40 }),
    ]);

    await waitForAsync(async () => {
      const [mikeState, ericState] = await Promise.all([readEditor(mike), readEditor(eric)]);
      return mikeState.text.includes('play is ready. mike typed words')
        && mikeState.text.includes('one more scene. eric typed words')
        && ericState.text.includes('play is ready. mike typed words')
        && ericState.text.includes('one more scene. eric typed words');
    }, 15_000, `${mode} editors to converge`);

    const [mikeState, ericState] = await Promise.all([readEditor(mike), readEditor(eric)]);
    for (const [label, state] of [['Mike', mikeState], ['Eric', ericState]] as const) {
      assert(
        state.text.includes('play is ready. mike typed words'),
        `${mode}: ${label} lost or moved Mike's insertion: ${state.text}`,
      );
      assert(
        state.text.includes('one more scene. eric typed words'),
        `${mode}: ${label} lost or moved Eric's insertion: ${state.text}`,
      );
    }

    if (mode === 'suggest') {
      const mikeInsertions = mikeState.insertSuggestions.filter((mark) => mark.by.includes('Mike Concurrent'));
      const ericInsertions = mikeState.insertSuggestions.filter((mark) => mark.by.includes('Eric Concurrent'));
      assert(
        mikeInsertions.length === 1 && mikeInsertions[0].text === ' mike typed words',
        `suggest: expected one continuous Mike insertion, got ${JSON.stringify(mikeInsertions)}; segments=${JSON.stringify(mikeState.suggestionSegments)}`,
      );
      assert(
        ericInsertions.length === 1 && ericInsertions[0].text === ' eric typed words',
        `suggest: expected one continuous Eric insertion, got ${JSON.stringify(ericInsertions)}`,
      );
    }

    await waitForAsync(async () => {
      const state = await mustJson<{ markdown?: string; content?: string }>(
        await fetch(`${httpBase}/documents/${created.slug}/state`, {
          headers: {
            Authorization: `Bearer ${created.accessToken}`,
            'X-Agent-Id': 'concurrent-typing-browser-test',
          },
        }),
        `${mode} server state`,
      );
      const markdown = state.markdown ?? state.content ?? '';
      return markdown.includes('play is ready. mike typed words')
        && markdown.includes('one more scene. eric typed words');
    }, 15_000, `${mode} server projection`);

    console.log(`✓ concurrent ${mode} typing stays at each client caret`);
  } finally {
    await Promise.allSettled([browserA.close(), browserB.close()]);
  }
}

async function run(): Promise<void> {
  const root = process.cwd();
  const dbPath = path.join(
    os.tmpdir(),
    `proof-collab-concurrent-typing-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';

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

  try {
    const chromium = loadChromium();
    await runMode(httpBase, chromium, 'edit');
    await runMode(httpBase, chromium, 'suggest');
  } finally {
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
