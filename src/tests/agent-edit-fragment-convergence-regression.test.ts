import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';
import { WebSocket as NodeWebSocket } from 'ws';
import { getHeadlessMilkdownParser } from '../../server/milkdown-headless.js';

if (typeof (globalThis as any).WebSocket === 'undefined') {
  (globalThis as any).WebSocket = NodeWebSocket;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
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

type CreateResponse = { slug: string; ownerSecret: string };
type CollabSessionResponse = {
  success: boolean;
  session: {
    slug: string;
    collabWsUrl: string;
    token: string;
    role: 'viewer' | 'commenter' | 'editor' | 'owner_bot';
  };
};
type StateResponse = { updatedAt?: string; markdown?: string; content?: string };
type EditResponse = {
  success?: boolean;
  code?: string;
  error?: string;
  recommendedEndpoint?: string;
  collab?: {
    status?: string;
    reason?: string;
    markdownStatus?: string;
    fragmentStatus?: string;
  };
  expectedFragmentTextHash?: string | null;
  liveFragmentTextHash?: string | null;
};

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.34.0',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

async function mustJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

async function run(): Promise<void> {
  const dbName = `proof-fragment-convergence-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
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
  const { WebSocketServer } = await import('ws');
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const httpBase = `http://127.0.0.1:${address.port}`;

  await collab.startCollabRuntimeEmbedded(address.port);

  const parser = await getHeadlessMilkdownParser();
  let editorDoc = new Y.Doc();
  let viewerDoc = new Y.Doc();
  let editorProvider: HocuspocusProvider | null = null;
  let viewerProvider: HocuspocusProvider | null = null;

  try {
    const fixture = [
      '# Daily Plan',
      '',
      '## Thursday, Feb 26, 2026',
      '',
      '**📅 Planning**',
      '',
      '* [ ] Figure out calendar and scheduling for Proof / Sheriff / Claw launches',
      '',
      '* [ ] Process Lucas\'s stakeholder synthesis dashboard',
      '',
      '## Wednesday, Feb 25, 2026',
      '',
      '* [x] Done item',
      '',
    ].join('\n');

    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Fragment convergence regression', markdown: fixture, marks: {} }),
    });
    const created = await mustJson<CreateResponse>(createRes, 'create');

    const sessionRes = await fetch(`${httpBase}/api/documents/${created.slug}/collab-session`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const session = await mustJson<CollabSessionResponse>(sessionRes, 'collab-session');
    assert(session.success, 'Expected successful collab session');

    const wsUrl = normalizeWsBase(session.session.collabWsUrl);
    editorProvider = new HocuspocusProvider({
      url: wsUrl,
      name: session.session.slug,
      document: editorDoc,
      parameters: { token: session.session.token, role: session.session.role },
      token: session.session.token,
      preserveConnection: false,
      broadcast: false,
    });
    viewerProvider = new HocuspocusProvider({
      url: wsUrl,
      name: session.session.slug,
      document: viewerDoc,
      parameters: { token: session.session.token, role: session.session.role },
      token: session.session.token,
      preserveConnection: false,
      broadcast: false,
    });

    let editorConnected = false;
    let editorSynced = false;
    editorProvider.on('status', (event: { status: string }) => {
      if (event.status === 'connected') editorConnected = true;
    });
    editorProvider.on('synced', (event: { state?: boolean }) => {
      if (event.state !== false) editorSynced = true;
    });

    let viewerConnected = false;
    let viewerSynced = false;
    viewerProvider.on('status', (event: { status: string }) => {
      if (event.status === 'connected') viewerConnected = true;
    });
    viewerProvider.on('synced', (event: { state?: boolean }) => {
      if (event.state !== false) viewerSynced = true;
    });

    await waitFor(() => editorConnected && editorSynced, 10_000, 'editor provider connected+synced');
    await waitFor(() => viewerConnected && viewerSynced, 10_000, 'viewer provider connected+synced');

    const stateBeforeRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const stateBefore = await mustJson<StateResponse>(stateBeforeRes, 'state before edit');
    const baseMarkdown = typeof stateBefore.markdown === 'string' ? stateBefore.markdown : (stateBefore.content || '');
    assert(Boolean(stateBefore.updatedAt), 'Expected updatedAt before edit');

    const stalePmDoc = parser.parseMarkdown(baseMarkdown);

    const markerA = `FRAGCHECKA${Date.now()}`;
    const markerALine = `* [ ] ${markerA}`;
    const anchor = "Process Lucas's stakeholder synthesis dashboard";

    let jammer: ReturnType<typeof setInterval> | null = setInterval(() => {
      editorDoc.transact(() => {
        const fragment = editorDoc.getXmlFragment('prosemirror');
        if (fragment.length > 0) fragment.delete(0, fragment.length);
        prosemirrorToYXmlFragment(stalePmDoc as any, fragment as any);
      }, 'fragment-jammer');
    }, 40);

    const editARes = await fetch(`${httpBase}/api/agent/${created.slug}/edit`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        by: 'ai:fragment-regression',
        baseUpdatedAt: stateBefore.updatedAt,
        operations: [{ op: 'insert', after: anchor, content: `\n\n${markerALine}` }],
      }),
    });
    assert(editARes.status === 409, `Expected legacy /edit status 409, got ${editARes.status}`);
    const editA = await editARes.json() as EditResponse;

    assert(editA.success === false, 'Expected legacy /edit to hard-fail under live collab');
    assert(editA.code === 'LEGACY_EDIT_UNSAFE', `Expected LEGACY_EDIT_UNSAFE, got ${String(editA.code)}`);
    assert(
      editA.recommendedEndpoint === `/api/agent/${created.slug}/edit/v2`,
      `Expected /edit/v2 guidance, got ${String(editA.recommendedEndpoint)}`,
    );

    clearInterval(jammer);
    jammer = null;

    const stateAfterRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const stateAfter = await mustJson<StateResponse>(stateAfterRes, 'state after blocked edit');
    const stateAfterMarkdown = typeof stateAfter.markdown === 'string' ? stateAfter.markdown : (stateAfter.content || '');
    assert(!stateAfterMarkdown.includes(markerA), 'Expected blocked legacy /edit to leave document unchanged');
    assert(!editorDoc.getText('markdown').toString().includes(markerA), 'Expected blocked legacy /edit not to write marker to live markdown');

    console.log('✓ agent /edit is hard-blocked for live fragment divergence scenarios');
  } finally {
    try {
      editorProvider?.disconnect();
      editorProvider?.destroy();
    } catch {
      // ignore
    }
    try {
      viewerProvider?.disconnect();
      viewerProvider?.destroy();
    } catch {
      // ignore
    }
    editorDoc.destroy();
    viewerDoc.destroy();

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
