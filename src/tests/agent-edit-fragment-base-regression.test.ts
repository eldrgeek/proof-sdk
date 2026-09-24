import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import { WebSocket as NodeWebSocket, WebSocketServer } from 'ws';
import { getHeadlessMilkdownParser, serializeMarkdown } from '../../server/milkdown-headless.js';

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'undefined') {
  (globalThis as { WebSocket?: unknown }).WebSocket = NodeWebSocket;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function escapeMarkdownLiteral(value: string): string {
  return value.replace(/_/g, '\\_');
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
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

async function serializeFragmentMarkdown(doc: Y.Doc, schema: Parameters<typeof yXmlFragmentToProseMirrorRootNode>[1]): Promise<string> {
  const root = yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment('prosemirror') as any, schema as any);
  return serializeMarkdown(root as any);
}

type CreateResponse = { slug: string; ownerSecret: string };
type StateResponse = { updatedAt: string; markdown?: string; content?: string };
type CollabSessionResponse = {
  success: boolean;
  session: {
    slug: string;
    collabWsUrl: string;
    token: string;
    role: 'viewer' | 'commenter' | 'editor' | 'owner_bot';
  };
};
type EditResponse = {
  success?: boolean;
  collab?: {
    status?: string;
    reason?: string;
    markdownStatus?: string;
    fragmentStatus?: string;
  };
};

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.32.0',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

async function run(): Promise<void> {
  const dbName = `proof-agent-edit-fragment-base-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';

  const [{ apiRoutes }, { agentRoutes }, { setupWebSocket }, collab] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/agent-routes.js'),
    import('../../server/ws.js'),
    import('../../server/collab.js'),
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

  const parser = await getHeadlessMilkdownParser();
  const editorDoc = new Y.Doc();
  let provider: HocuspocusProvider | null = null;
  let connected = false;
  let synced = false;

  try {
    const initialMarkdown = [
      '# Fragment Base Regression',
      '',
      '## Working Notes',
      '',
      'Anchor paragraph',
      '',
      'Tail paragraph',
      '',
    ].join('\n');

    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Fragment base regression',
        markdown: initialMarkdown,
        marks: {},
      }),
    });
    const created = await mustJson<CreateResponse>(createRes, 'create');

    const sessionRes = await fetch(`${httpBase}/api/documents/${created.slug}/collab-session`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const session = await mustJson<CollabSessionResponse>(sessionRes, 'collab-session');
    assert(session.success, 'Expected successful collab session');

    provider = new HocuspocusProvider({
      url: normalizeWsBase(session.session.collabWsUrl),
      name: session.session.slug,
      document: editorDoc,
      parameters: { token: session.session.token, role: session.session.role },
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
    await waitFor(() => connected && synced, 10_000, 'provider connected+synced');

    const stateBeforeRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const stateBefore = await mustJson<StateResponse>(stateBeforeRes, 'state before edit');
    const baseMarkdown = typeof stateBefore.markdown === 'string' ? stateBefore.markdown : (stateBefore.content || '');
    assert(Boolean(stateBefore.updatedAt), 'Expected updatedAt before edit');

    const instance = collab.__unsafeGetHocuspocusInstanceForTests() as {
      documents?: Map<string, Y.Doc>;
      createDocument: (
        docName: string,
        requestParameters?: Record<string, unknown>,
        socketId?: string,
        connection?: Record<string, unknown>,
        context?: Record<string, unknown>,
      ) => Promise<Y.Doc>;
    };
    assert(instance && typeof instance.createDocument === 'function', 'Expected hocuspocus test instance');
    const liveDoc = instance.documents?.get(created.slug) ?? await instance.createDocument(
      created.slug,
      {},
      'fragment-base-test-socket',
      { isAuthenticated: true, readOnly: false, requiresAuthentication: true },
      {},
    );

    const browserMarker = `BROWSER_${Date.now()}`;
    const apiMarker = `API_${Date.now()}`;
    const escapedBrowserMarker = escapeMarkdownLiteral(browserMarker);
    const escapedApiMarker = escapeMarkdownLiteral(apiMarker);
    const fragmentAheadMarkdown = baseMarkdown.replace(
      'Anchor paragraph',
      `Anchor paragraph\n\n${browserMarker}`,
    );
    const fragmentAheadDoc = parser.parseMarkdown(fragmentAheadMarkdown);

    liveDoc.transact(() => {
      const fragment = liveDoc.getXmlFragment('prosemirror');
      if (fragment.length > 0) fragment.delete(0, fragment.length);
      prosemirrorToYXmlFragment(fragmentAheadDoc as any, fragment as any);
    }, 'test-fragment-ahead-of-projection');

    try {
      const serialized = await serializeFragmentMarkdown(liveDoc, parser.schema);
      assert(serialized.includes(escapedBrowserMarker), 'Expected direct fragment serialization to include browser marker');
    } catch (error) {
      console.error('[fragment-base-test] direct fragment serialization failed', error);
      throw error;
    }

    await waitFor(async () => {
      const liveFragmentMarkdown = await collab.getLoadedCollabMarkdownFromFragment(created.slug);
      return typeof liveFragmentMarkdown === 'string' && liveFragmentMarkdown.includes(escapedBrowserMarker);
    }, 10_000, 'server fragment reflects browser marker');

    const liveProjectionMarkdown = collab.getLoadedCollabMarkdown(created.slug);
    assert(
      !String(liveProjectionMarkdown ?? '').includes(browserMarker),
      'Expected markdown projection to remain stale before /edit',
    );

    const editRes = await fetch(`${httpBase}/api/agent/${created.slug}/edit`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        by: 'ai:fragment-base-regression',
        baseUpdatedAt: stateBefore.updatedAt,
        operations: [{ op: 'append', section: 'Working Notes', content: `\n\n${apiMarker}` }],
      }),
    });
    const edit = await editRes.json() as EditResponse & {
      code?: string;
      recommendedEndpoint?: string;
      success?: boolean;
    };
    assert(editRes.status === 409, `Expected legacy /edit status 409, got ${editRes.status}`);
    assert(edit.success === false, 'Expected legacy /edit to hard-fail under fragment-ahead live collab');
    assert(edit.code === 'LEGACY_EDIT_UNSAFE', `Expected LEGACY_EDIT_UNSAFE, got ${String(edit.code)}`);
    assert(
      edit.recommendedEndpoint === `/api/agent/${created.slug}/edit/v2`,
      `Expected /edit/v2 guidance, got ${String(edit.recommendedEndpoint)}`,
    );

    await waitFor(async () => {
      const latestRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
        headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
      });
      const latest = await mustJson<StateResponse>(latestRes, 'latest state');
      const content = typeof latest.markdown === 'string' ? latest.markdown : (latest.content || '');
      const hasBrowserMarker = content.includes(browserMarker) || content.includes(escapedBrowserMarker);
      const hasApiMarker = content.includes(apiMarker) || content.includes(escapedApiMarker);
      return !hasBrowserMarker && !hasApiMarker;
    }, 10_000, 'canonical state remains unchanged after blocked legacy edit');

    try {
      await waitFor(async () => {
        const liveFragmentMarkdown = await collab.getLoadedCollabMarkdownFromFragment(created.slug);
        const hasBrowserMarker = typeof liveFragmentMarkdown === 'string'
          && (liveFragmentMarkdown.includes(escapedBrowserMarker) || liveFragmentMarkdown.includes(browserMarker));
        const hasApiMarker = typeof liveFragmentMarkdown === 'string'
          && (liveFragmentMarkdown.includes(escapedApiMarker) || liveFragmentMarkdown.includes(apiMarker));
        return typeof liveFragmentMarkdown === 'string'
          && hasBrowserMarker
          && !hasApiMarker;
      }, 10_000, 'live fragment preserves browser marker without API marker');
    } catch (error) {
      const liveFragmentMarkdown = await collab.getLoadedCollabMarkdownFromFragment(created.slug);
      const latestRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
        headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
      });
      const latest = await mustJson<StateResponse>(latestRes, 'latest state after live fragment failure');
      console.error('[fragment-base-test] live fragment mismatch', {
        liveFragmentMarkdown,
        latestMarkdown: typeof latest.markdown === 'string' ? latest.markdown : latest.content,
      });
      throw error;
    }

    console.log('✓ legacy /edit blocks fragment-ahead live edits without dropping browser fragment text');
  } finally {
    try {
      provider?.disconnect();
      provider?.destroy();
    } catch {
      // ignore
    }
    editorDoc.destroy();
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
