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

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function mustJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
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
type StateResponse = { revision: number; markdown?: string; content?: string };
type SnapshotResponse = {
  success?: boolean;
  revision?: number;
  blocks?: Array<{ ref?: string; markdown?: string }>;
};
type CollabSessionResponse = {
  success: boolean;
  session: {
    collabWsUrl: string;
    slug: string;
    token: string;
    role: string;
  };
};

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.33.0',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

const FIXTURE_MARKDOWN = [
  '# HTML Parse Regression Fixture',
  '',
  '*A super-smart deputy who automates what you **dread***',
  '',
  '<br />',
  '',
  '## Section',
  '',
  'A paragraph after a raw HTML line.',
  '',
].join('\n');

async function run(): Promise<void> {
  const dbName = `proof-agent-edit-html-parse-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';
  process.env.COLLAB_SINGLE_WRITER_EDIT = '1';

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

  const ydoc = new Y.Doc();
  let provider: HocuspocusProvider | null = null;
  let connected = false;
  let synced = false;

  try {
    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Agent edit HTML parse live-collab regression',
        markdown: FIXTURE_MARKDOWN,
        marks: {},
      }),
    });
    const created = await mustJson<CreateResponse>(createRes, 'create');

    const collabSessionRes = await fetch(`${httpBase}/api/documents/${created.slug}/collab-session`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
      },
    });
    const collabSession = await mustJson<CollabSessionResponse>(collabSessionRes, 'collab-session');
    assert(collabSession.success === true, 'Expected successful collab session');

    provider = new HocuspocusProvider({
      url: normalizeWsBase(collabSession.session.collabWsUrl),
      name: collabSession.session.slug,
      document: ydoc,
      parameters: {
        token: collabSession.session.token,
        role: collabSession.session.role,
      },
      token: collabSession.session.token,
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

    const stateBeforeRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const stateBefore = await mustJson<StateResponse>(stateBeforeRes, 'state before');

    const editRes = await fetch(`${httpBase}/api/agent/${created.slug}/edit`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        by: 'ai:html-parse-regression',
        baseRevision: stateBefore.revision,
        operations: [
          {
            op: 'replace',
            search: 'automates what you **dread**',
            content: 'automates the tasks you **dread**',
          },
        ],
      }),
    });
    const editJson = await mustJson<{
      success?: boolean;
      collab?: { status?: string };
      collabApplied?: boolean;
    }>(editRes, 'agent edit');

    assert(editJson.success === true, 'Expected edit success');
    assert(editJson.collabApplied === true, 'Expected collabApplied=true');
    assert(editJson.collab?.status === 'confirmed', 'Expected collab.status=confirmed');

    const stateAfterRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const stateAfter = await mustJson<StateResponse>(stateAfterRes, 'state after');
    const markdown = stateAfter.markdown ?? stateAfter.content ?? '';

    assert(markdown.includes('automates the tasks you **dread**'), 'Expected replacement text in state');
    assert(!markdown.includes('automates what you **dread**'), 'Expected old phrase removed in state');

    const snapshotRes = await fetch(`${httpBase}/api/agent/${created.slug}/snapshot`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const snapshot = await mustJson<SnapshotResponse>(snapshotRes, 'snapshot');
    assert(snapshot.success === true, 'Expected snapshot success for HTML fixture');
    assert(Array.isArray(snapshot.blocks) && snapshot.blocks.length > 0, 'Expected non-empty snapshot blocks');

    const targetBlock = (snapshot.blocks ?? []).find((block) => {
      const markdown = block.markdown ?? '';
      const normalized = markdown.replace(/[*_`]/g, '');
      return normalized.includes('automates the tasks you dread');
    });
    const targetRef = targetBlock?.ref ?? '';
    const targetMarkdown = targetBlock?.markdown ?? '';
    assert(Boolean(targetRef), 'Expected snapshot ref for edited block');
    assert(targetMarkdown.includes('tasks'), 'Expected target snapshot block markdown to include tasks');

    const editV2Res = await fetch(`${httpBase}/api/agent/${created.slug}/edit/v2`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        by: 'ai:html-parse-regression-v2',
        baseRevision: stateAfter.revision,
        operations: [
          {
            op: 'replace_block',
            ref: targetRef,
            block: {
              markdown: targetMarkdown.replace('tasks', 'work'),
            },
          },
        ],
      }),
    });
    const editV2Json = await mustJson<{ success?: boolean }>(editV2Res, 'agent edit v2');
    assert(editV2Json.success === true, 'Expected edit/v2 success on HTML fixture');

    const stateAfterV2Res = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const stateAfterV2 = await mustJson<StateResponse>(stateAfterV2Res, 'state after v2');
    const markdownV2 = stateAfterV2.markdown ?? stateAfterV2.content ?? '';
    const normalizedV2 = markdownV2.replace(/[*_`]/g, '');
    assert(normalizedV2.includes('automates the work you dread'), 'Expected edit/v2 replacement text in state');
  } finally {
    try {
      provider?.disconnect();
      provider?.destroy();
      try {
        (provider as any)?.configuration?.websocketProvider?.destroy?.();
      } catch {}
    } catch {}
    ydoc.destroy();
    try { await collab.stopCollabRuntime(); } catch {}
    try { wss.close(); } catch {}
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      unlinkSync(dbPath);
    } catch {}
  }
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('agent /edit HTML parse live-collab regression failed');
    console.error(error);
    process.exit(1);
  });
