import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { WebSocketServer } from 'ws';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function normalizeWsBase(collabWsUrl: string): string {
  const raw = collabWsUrl.replace(/\?slug=.*$/, '');
  try {
    const url = new URL(raw);
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    return url.toString();
  } catch {
    return raw.replace('ws://localhost:', 'ws://127.0.0.1:');
  }
}

async function mustJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.34.0',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

async function run(): Promise<void> {
  const dbName = `proof-agent-edit-v2-stale-markdown-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';
  process.env.AGENT_EDIT_V2_ENABLED = '1';

  const [{ apiRoutes }, { agentRoutes }, { setupWebSocket }, collab, canonical] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/agent-routes.js'),
    import('../../server/ws.js'),
    import('../../server/collab.js'),
    import('../../server/canonical-document.js'),
  ]);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRoutes);
  app.use('/api/agent', agentRoutes);

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const httpBase = `http://127.0.0.1:${address.port}`;

  await collab.startCollabRuntimeEmbedded(address.port);

  const ydoc = new Y.Doc();
  let provider: HocuspocusProvider | null = null;
  let connected = false;
  let synced = false;

  const baseMarkdown = [
    '# Long Session',
    '',
    '## Notes',
    '',
    'Use this section for the soak append loop.',
  ].join('\n');
  const browserMarker = 'browser-marker-live-fragment';
  const canonicalMarkdown = [
    '# Long Session',
    '',
    '## Notes',
    '',
    `Use this section for the soak append loop. ${browserMarker}`,
  ].join('\n');
  const apiMarker = 'api-marker-after-stale-text';

  try {
    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'agent edit v2 stale markdown regression',
        markdown: baseMarkdown,
        marks: {},
      }),
    });
    const created = await mustJson<{ slug: string; ownerSecret: string }>(createRes, 'create');

    const sessionRes = await fetch(`${httpBase}/api/documents/${created.slug}/collab-session`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const session = await mustJson<{
      success: boolean;
      session: { collabWsUrl: string; slug: string; token: string; role: string };
    }>(sessionRes, 'collab-session');
    assert(session.success, 'Expected successful collab session');

    provider = new HocuspocusProvider({
      url: normalizeWsBase(session.session.collabWsUrl),
      name: session.session.slug,
      document: ydoc,
      parameters: {
        token: session.session.token,
        role: session.session.role,
      },
      token: session.session.token,
      preserveConnection: false,
      broadcast: false,
    });
    provider.on('status', (event: { status: string }) => {
      if (event.status === 'connected') connected = true;
    });
    provider.on('synced', (event: { state?: boolean }) => {
      if (event.state !== false) synced = true;
    });
    await waitFor(() => connected, 10_000, 'provider connected');
    await waitFor(() => synced, 10_000, 'provider synced');

    const aligned = await canonical.mutateCanonicalDocument({
      slug: created.slug,
      nextMarkdown: canonicalMarkdown,
      nextMarks: {},
      source: 'ai:align-regression',
      baseRevision: 1,
      strictLiveDoc: false,
    });
    assert(aligned.ok, `Expected canonical/live alignment step to succeed: ${JSON.stringify(aligned)}`);

    await waitFor(async () => {
      const fragmentMarkdown = await collab.getLoadedCollabMarkdownFromFragment(created.slug);
      return fragmentMarkdown?.includes(browserMarker) === true;
    }, 10_000, 'live fragment aligned to canonical markdown');

    const loadedDoc = collab.__unsafeGetLoadedDocForTests(created.slug);
    assert(Boolean(loadedDoc), 'Expected live loaded doc');

    loadedDoc!.transact(() => {
      const markdownText = loadedDoc!.getText('markdown');
      if (markdownText.length > 0) markdownText.delete(0, markdownText.length);
      markdownText.insert(0, baseMarkdown);
    }, 'stale-markdown-text');

    const fragmentMarkdown = await collab.getLoadedCollabMarkdownFromFragment(created.slug);
    assert(
      fragmentMarkdown?.includes(browserMarker) === true,
      `Expected live fragment to keep browser marker while markdown text lags. markdown=${String(fragmentMarkdown)}`,
    );
    assert(
      loadedDoc!.getText('markdown').toString() === baseMarkdown,
      'Expected derived markdown text channel to be intentionally stale before strict live-doc mutation',
    );

    const result = await canonical.mutateCanonicalDocument({
      slug: created.slug,
      nextMarkdown: `${canonicalMarkdown} ${apiMarker}`,
      nextMarks: {},
      source: 'ai:direct-regression',
      baseRevision: aligned.document.revision,
      strictLiveDoc: true,
    });
    assert(
      result.ok,
      `Expected strict live-doc mutation to trust the live fragment over stale markdown text: ${JSON.stringify(result)}`,
    );

    console.log('✓ strict live-doc checks trust the live fragment when derived markdown text lags');
  } finally {
    try {
      provider?.disconnect();
      provider?.destroy();
      try {
        (provider as any)?.configuration?.websocketProvider?.destroy?.();
      } catch {
        // ignore
      }
    } catch {
      // ignore
    }
    ydoc.destroy();
    await collab.stopCollabRuntime();
    try {
      wss.close();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
