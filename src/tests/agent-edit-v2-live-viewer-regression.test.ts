import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { WebSocketServer } from 'ws';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';
import { getHeadlessMilkdownParser } from '../../server/milkdown-headless.js';

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

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.33.0',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

const DIRTY = [
  '# T',
  '',
  '## Wednesday, Feb 25, 2026',
  '',
  '**🍅 Pomodoro 1 — 9:13 AM (30 min)**',
  '',
  '- [x] task1',
  '',
  '**🔧 Proof**',
  '',
  '- [x] dup',
  '',
].join('\n');

async function run(): Promise<void> {
  const dbName = `proof-agent-edit-v2-live-viewer-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';
  process.env.AGENT_EDIT_V2_ENABLED = '1';

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
    const parser = await getHeadlessMilkdownParser();
    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'agent edit v2 live viewer regression',
        markdown: DIRTY,
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

    const stateRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const state = await mustJson<{ revision: number }>(stateRes, 'state');

    // Simulate a stale client repeatedly replaying pre-edit content during edit.v2 apply.
    let replayCount = 0;
    const replayInterval = setInterval(() => {
      replayCount += 1;
      ydoc.transact(() => {
        const text = ydoc.getText('markdown');
        if (text.length > 0) text.delete(0, text.length);
        text.insert(0, DIRTY);
        const fragment = ydoc.getXmlFragment('prosemirror');
        if (fragment.length > 0) fragment.delete(0, fragment.length);
        prosemirrorToYXmlFragment(parser.parseMarkdown(DIRTY) as any, fragment as any);
      }, 'stale-replay');
      if (replayCount >= 20) clearInterval(replayInterval);
    }, 80);

    const editRes = await fetch(`${httpBase}/api/agent/${created.slug}/edit/v2`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        by: 'ai:regression-test',
        baseRevision: state.revision,
        operations: [
          { op: 'replace_block', ref: 'b3', block: { markdown: '**✅ Done**' } },
          { op: 'delete_block', ref: 'b5' },
        ],
      }),
    });
    const edit = await editRes.json() as {
      success?: boolean;
      code?: string;
      collab?: { status?: string; reason?: string };
    };
    clearInterval(replayInterval);
    const acceptedHardFail = editRes.status === 409 && edit.code === 'FRAGMENT_DIVERGENCE';
    const acceptedPending =
      editRes.status === 200
      && edit.success === true
      && edit.collab?.status === 'pending';
    assert(
      acceptedHardFail || acceptedPending,
      `Expected stale live replay pressure to hard-fail or return pending, got ${editRes.status}: ${JSON.stringify(edit).slice(0, 500)}`,
    );

    const readRes = await fetch(`${httpBase}/api/documents/${created.slug}`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const read = await mustJson<{ markdown: string }>(readRes, 'read');
    assert(typeof read.markdown === 'string' && read.markdown.length > 0, 'Expected readable canonical markdown after stale replay pressure');

    console.log('✓ agent /edit/v2 safely avoids false confirmation under stale live replay pressure');
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
