import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { stripAllProofSpanTags } from '../../server/proof-span-strip.js';
import { WebSocketServer } from 'ws';
const { SourceMapConsumer } = createRequire(import.meta.url)('source-map-js');
// npm run build is sufficient; use `npx vite build --sourcemap` for mapped diagnostics.
const sourceMap = existsSync('dist/assets/editor.js.map')
  ? new SourceMapConsumer(JSON.parse(readFileSync('dist/assets/editor.js.map', 'utf8'))) : null;
function mapStack(stack: string): string {
  if (!sourceMap) return stack;
  return stack.replace(/http:\/\/[^\s)]+\/assets\/editor\.js:(\d+):(\d+)/g, (frame, line, column) => {
    const pos = sourceMap.originalPositionFor({ line: Number(line), column: Number(column) - 1 });
    const source = pos.source?.includes('/node_modules/')
      ? pos.source.replace(/^.*node_modules\//, 'node_modules/')
      : pos.source?.replace(/^(\.\.\/)+/, '');
    return source ? `${source}:${pos.line}:${pos.column + 1} (${pos.name ?? frame})` : frame;
  });
}
const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.31.2',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

type CreatedDocument = {
  slug: string;
  ownerSecret: string;
  accessToken?: string;
};

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

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function mustJson<T>(response: Response, label: string): Promise<T> {
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(`${label}: HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text) as T;
}

async function postAgent(
  httpBase: string,
  slug: string,
  ownerSecret: string,
  route: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const deadline = Date.now() + 10_000;
  const key = randomUUID();
  while (true) {
    const response = await fetch(`${httpBase}/api/agent/${slug}${route}`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': ownerSecret,
        'Idempotency-Key': key,
      },
      body: JSON.stringify(body),
    });
    if (response.status !== 409 || Date.now() >= deadline) return response;
    const result = await response.clone().json();
    if (result.code !== 'PROJECTION_STALE') return response;
    await sleep(100);
  }
}

type AgentState = { markdown: string; marks: Record<string, any> };

async function runLoadingCase(httpBase: string, chromium: any, parseMarkdown: (value: string) => any): Promise<void> {
  const browser = await chromium.launch();
  try {
    // A second editor's selection after the inserted blocks exercises relative-position
    // conversion. Without it, the same ordering bug silently overwrites remote text.
    for (const withToken of [true, false]) {
      const created = await mustJson<CreatedDocument>(await fetch(`${httpBase}/api/documents`, {
        method: 'POST', headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Loading regression', markdown: '# Loading\n\nIntro anchor here.\n\nReplace target here.\n\nDelete target here.\n\nComment target here.\n', marks: {} }),
      }), 'create');
      const getState = () => fetch(`${httpBase}/api/agent/${created.slug}/state`, {
        headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
      }).then(response => mustJson<AgentState>(response, 'agent state'));
      await getState(); // Seed the legacy creation route's canonical Yjs baseline.
      const errors: string[] = [];
      const pendingStatuses: number[] = [];
      const openPage = async () => {
        const page = await browser.newPage();
        await page.route('**/*', (route: any) => {
          const url = new URL(route.request().url());
          return url.hostname === '127.0.0.1' || url.hostname === 'localhost'
            ? route.continue() : route.abort();
        });
        await page.addInitScript(() => {
          (Error as any).stackTraceLimit = 100;
          localStorage.setItem('proof-share-viewer-name', 'E1 tester');
        });
        // CDP copies Error.description (including its stack) synchronously. JSHandles
        // can disappear before evaluation when error recovery reloads the page.
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Runtime.enable');
        cdp.on('Runtime.consoleAPICalled', (event: any) => {
          if (event.type !== 'error') return;
          const stack = mapStack(event.args.map((arg: any) => String(arg.value ?? arg.description ?? arg.type)).join(' '));
          errors.push(stack);
          console.error(stack);
        });
        page.on('pageerror', (error: Error) => {
          const stack = mapStack(error.stack ?? error.message);
          errors.push(stack);
          console.error(stack);
        });
        page.on('response', (response: any) => {
          if (response.url().includes('/events/pending')) pendingStatuses.push(response.status());
        });
        return page;
      };
      const witness = await openPage();
      await witness.goto(`${httpBase}/d/${created.slug}?token=${created.accessToken}`);
      await witness.waitForFunction(() => document.querySelector('.ProseMirror')?.getAttribute('contenteditable') === 'true');
      await witness.locator('.ProseMirror').click();
      await witness.keyboard.press('ControlOrMeta+End');
      const page = await openPage();
      const started = Date.now();
      await page.goto(`${httpBase}/d/${created.slug}${withToken ? `?token=${created.accessToken}` : ''}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.ProseMirror');
      // Start at the first rendered editor, without waiting for the usual settled
      // editor delay. The burst crosses initial binding and review initialization.
      const ids: string[] = [];
      for (const op of [
        { type: 'suggestion.add', kind: 'insert', quote: 'Intro anchor', content: ' inserted words\n\nNew remote paragraph.\n\n' },
        { type: 'suggestion.add', kind: 'replace', quote: 'Replace target', content: 'Replacement words' },
        { type: 'suggestion.add', kind: 'delete', quote: 'Delete target' },
        { type: 'comment.add', quote: 'Comment target', text: 'Loading comment' },
      ]) {
        const result = await mustJson<{ markId: string }>(await postAgent(httpBase, created.slug, created.ownerSecret, '/ops', { ...op, by: 'ai:e1' }), op.type);
        ids.push(result.markId);
        await sleep(100);
      }
      await mustJson(await postAgent(httpBase, created.slug, created.ownerSecret, '/ops', {
        type: 'comment.reply', markId: ids[3], text: 'Loading reply', by: 'ai:e1',
      }), 'comment reply');
      console.log(`Loading burst (${withToken ? 'token' : 'no token'}): five operations in ${Date.now() - started}ms`);
      await page.waitForFunction(() => Boolean((window as any).proof?.getAllMarks));

      const checkConvergence = async (label: string) => {
        await waitFor(async () => {
          const server = await getState();
          const expectedDoc = parseMarkdown(stripAllProofSpanTags(server.markdown));
          const expectedText = expectedDoc.textBetween(0, expectedDoc.content.size, '\n', '\n');
          const client = await page.evaluate(() => ({
            text: (window as any).proof.getFullState()?.plainText,
            marks: (window as any).proof.getAllMarks(),
          }));
          if (client.text !== expectedText) return false;
          const actual = client.marks;
          const expected = Object.entries(server.marks).map(([id, mark]) => ({ id, ...mark }));
          if (actual.length !== expected.length) return false;
          return expected.every(mark => {
            const found = actual.find((candidate: any) => candidate.id === mark.id);
            return found && found.kind === mark.kind && found.by === mark.by
              && found.quote === mark.quote
              && (found.data?.content ?? '') === (mark.content ?? '')
              && (found.data?.status ?? '') === (mark.status ?? '')
              && (found.data?.text ?? '') === (mark.text ?? '')
              && (found.data?.resolved ?? false) === (mark.resolved ?? false)
              && JSON.stringify(found.data?.replies ?? []) === JSON.stringify(mark.replies ?? []);
          });
        }, 10_000, `${label}: browser text and marks equal GET /state`);
        const current = await getState();
        assert(current.markdown.includes('New remote paragraph.'), `${label}: inserted blocks must survive`);
        assert(current.marks[ids[3]]?.replies?.[0]?.text === 'Loading reply', `${label}: reply must survive`);
      };
      await sleep(500);
      assert(errors.length === 0, `Client errors during load:\n${errors.join('\n')}`);
      await checkConvergence('load');
      console.log('PASS: loading insert, replace, delete, comment and reply converge');

      await sleep(1200);
      console.log(`events/pending (${withToken ? 'token' : 'no token'}): ${JSON.stringify(pendingStatuses)}`);
      assert(errors.length === 0, `Client errors:\n${errors.join('\n')}`);
      await witness.close();
      await page.close();
    }
  } finally { await browser.close(); }
}

async function runReviewCase(httpBase: string, chromium: any, action: 'accept' | 'reject', parseMarkdown: (value: string) => any): Promise<void> {
  const created = await mustJson<CreatedDocument>(await fetch(`${httpBase}/api/documents`, {
    method: 'POST', headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `Review ${action}`, markdown: '# Review\n\nKeep TARGET here.\n\nComment anchor here.', marks: {} }),
  }), 'create review document');
  const getState = () => fetch(`${httpBase}/api/agent/${created.slug}/state`, {
    headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
  }).then(response => mustJson<AgentState>(response, 'review state'));
  await getState();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => localStorage.setItem('proof-share-viewer-name', 'Review tester'));
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.stack ?? error.message));
    page.on('console', (message: any) => {
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) errors.push(message.text());
    });
    let holdRemote = false;
    const queued: Array<() => void> = [];
    await page.routeWebSocket('**/ws*', (socket: any) => {
      const serverSocket = socket.connectToServer();
      serverSocket.onMessage((message: string | Buffer) => {
        if (holdRemote) queued.push(() => socket.send(message));
        else socket.send(message);
      });
    });
    await page.goto(`${httpBase}/d/${created.slug}?token=${created.accessToken}`);
    await page.waitForFunction(() => document.querySelector('.ProseMirror')?.getAttribute('contenteditable') === 'true');
    const suggestion = await mustJson<{markId: string}>(await postAgent(httpBase, created.slug, created.ownerSecret, '/ops', {
      type: 'suggestion.add', kind: 'delete', quote: 'TARGET', by: 'ai:e1',
    }), 'review suggestion');
    await page.waitForFunction((id: string) => (window as any).proof.getAllMarks().some((mark: any) => mark.id === id), suggestion.markId);
    holdRemote = true;
    const comment = await mustJson<{markId: string}>(await postAgent(httpBase, created.slug, created.ownerSecret, '/ops', {
      type: 'comment.add', quote: 'Comment anchor', text: `During ${action}`, by: 'ai:e1',
    }), 'concurrent review comment');
    await waitFor(() => queued.length > 0, 5000, 'queued remote update');
    const review = page.evaluate(({ action, id }: {action: string; id: string}) => {
      return (window as any).proof[action === 'accept' ? 'acceptSuggestion' : 'rejectSuggestion'](id);
    }, { action, id: suggestion.markId });
    holdRemote = false;
    for (const send of queued.splice(0)) send();
    assert(await review === true, `${action} returned success`);
    await waitFor(async () => {
      const server = await getState();
      const client = await page.evaluate(() => ({
        text: (window as any).proof.getFullState()?.plainText,
        marks: (window as any).proof.getAllMarks().filter((mark: any) => mark.kind !== 'authored'),
      }));
      const expected = Object.entries(server.marks).filter(([, mark]) => mark.kind !== 'authored');
      return !server.marks[suggestion.markId] && client.text.replace(/\s+/g, '') === parseMarkdown(stripAllProofSpanTags(server.markdown)).textContent.replace(/\s+/g, '')
        && client.marks.length === expected.length
        && expected.every(([id, mark]) => client.marks.some((actual: any) => actual.id === id
          && actual.kind === mark.kind && actual.quote === mark.quote
          && (actual.data?.status ?? '') === (mark.status ?? '')
          && (actual.data?.text ?? '') === (mark.text ?? '')))
        && Boolean(server.marks[comment.markId]);
    }, 15_000, `${action}: remote comment and browser match canonical state`);
    console.log(`Review ${action}: canonical suggestion status=${(await getState()).marks[suggestion.markId]?.status ?? 'removed'}`);
    assert(errors.length === 0, `${action} client errors: ${errors.join('\n')}`);
    console.log(`PASS: ${action} during a remote change converges`);
  } finally { await browser.close(); }
}

async function runRecoveryCase(httpBase: string, chromium: any): Promise<void> {
  const created = await mustJson<CreatedDocument>(await fetch(`${httpBase}/api/documents`, {
    method: 'POST', headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Recovery', markdown: 'Recovery anchor.', marks: {} }),
  }), 'create recovery document');
  const getState = () => fetch(`${httpBase}/api/agent/${created.slug}/state`, {
    headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
  }).then(response => mustJson<AgentState>(response, 'recovery state'));
  await getState();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => localStorage.setItem('proof-share-viewer-name', 'Recovery tester'));
    const errors: string[] = [];
    page.on('console', (message: any) => {
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
        errors.push(message.text());
        console.error(mapStack(message.text()));
      }
    });
    page.on('pageerror', (error: Error) => errors.push(error.stack ?? error.message));
    await page.goto(`${httpBase}/d/${created.slug}?token=${created.accessToken}`);
    await page.waitForFunction(() => document.querySelector('.ProseMirror')?.getAttribute('contenteditable') === 'true');
    await page.evaluate(() => {
      const proof = (window as any).proof;
      const apply = proof.applyExternalMarks;
      proof.applyExternalMarks = function (marks: Record<string, any>, options: unknown) {
        if (Object.values(marks).some(mark => mark.text === 'Recovery comment')) {
          proof.applyExternalMarks = apply;
          throw new Error('E1 injected marks delivery failure');
        }
        return apply.call(this, marks, options);
      };
    });
    const reloaded = page.waitForEvent('framenavigated', {
      predicate: (frame: any) => frame === page.mainFrame(), timeout: 15_000,
    });
    const comment = await mustJson<{markId: string}>(await postAgent(httpBase, created.slug, created.ownerSecret, '/ops', {
      type: 'comment.add', quote: 'Recovery anchor', text: 'Recovery comment', by: 'ai:e1',
    }), 'recovery comment');
    await reloaded;
    await page.waitForFunction((id: string) => (window as any).proof?.getAllMarks().some((mark: any) => mark.id === id), comment.markId);
    const server = await getState();
    const client = await page.evaluate(() => ({ text: (window as any).proof.getFullState().plainText, marks: (window as any).proof.getAllMarks() }));
    assert(client.text === server.markdown.trim(), 'Recovery text must match the server');
    assert(client.marks.length === Object.keys(server.marks).length
      && client.marks[0].data.text === server.marks[comment.markId].text, 'Recovery marks must match the server');
    assert(errors.length === 1 && errors[0].includes('[collab] Failed to apply Yjs update')
      && errors[0].includes('E1 injected marks delivery failure') && errors[0].includes('at '),
      `Expected one logged failure with stack, got ${errors.join('\n')}`);
    console.log('PASS: failed update logs its stack and reloads into server state');
  } finally { await browser.close(); }
}

async function run(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `proof-rest-live-suggestion-${Date.now()}-${randomUUID()}.db`);
  const previousDbPath = process.env.DATABASE_PATH;
  const previousEmbeddedWs = process.env.COLLAB_EMBEDDED_WS;
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';

  const [
    { apiRoutes },
    { agentRoutes },
    { setupWebSocket },
    collab,
    milkdown,
    { shareWebRoutes },
    { createBridgeMountRouter },
    { enforceApiClientCompatibility, enforceBridgeClientCompatibility },
  ] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/agent-routes.js'),
    import('../../server/ws.js'),
    import('../../server/collab.js'),
    import('../../server/milkdown-headless.js'),
    import('../../server/share-web-routes.js'),
    import('../../server/bridge.js'),
    import('../../server/client-capabilities.js'),
  ]);

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/assets', express.static(path.join(process.cwd(), 'dist', 'assets')));
  app.use(express.static(path.join(process.cwd(), 'public')));
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
  const address = server.address() as AddressInfo;
  const httpBase = `http://127.0.0.1:${address.port}`;
  await collab.startCollabRuntimeEmbedded(address.port);
  await milkdown.getHeadlessMilkdownParser();

  try {
    const { parseMarkdown } = await milkdown.getHeadlessMilkdownParser();
    const reviewAction = process.argv.find(arg => arg.startsWith('--review-race='))?.split('=')[1];
    if (reviewAction === 'accept' || reviewAction === 'reject') {
      await runReviewCase(httpBase, loadChromium(), reviewAction, parseMarkdown);
    } else {
      await runLoadingCase(httpBase, loadChromium(), parseMarkdown);
      await runRecoveryCase(httpBase, loadChromium());
    }
  } finally {
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {
        // best-effort test cleanup
      }
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await sleep(50);
    await collab.stopCollabRuntime();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousDbPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDbPath;
    if (previousEmbeddedWs === undefined) delete process.env.COLLAB_EMBEDDED_WS;
    else process.env.COLLAB_EMBEDDED_WS = previousEmbeddedWs;
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // best-effort test cleanup
      }
    }
  }
}

setTimeout(() => { console.error('E1 regression exceeded 90 seconds'); process.exit(1); }, 90_000).unref();
run().then(() => process.exit(0)).catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
