import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import type { AddressInfo } from 'node:net';

import { mergePendingServerMarks, type StoredMark } from '../editor/plugins/marks';

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.31.0',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

const DEFAULT_TIMEOUT_MS = 10_000;

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function readMarksMap(map: Y.Map<unknown>): Record<string, StoredMark> {
  const marks: Record<string, StoredMark> = {};
  map.forEach((value, key) => {
    marks[key] = value as StoredMark;
  });
  return marks;
}

function applyMarksMap(map: Y.Map<unknown>, marks: Record<string, StoredMark>): void {
  const nextKeys = new Set(Object.keys(marks));
  map.forEach((_value, key) => {
    if (!nextKeys.has(key)) map.delete(key);
  });
  for (const [key, value] of Object.entries(marks)) {
    map.set(key, value);
  }
}

function testMergePendingServerMarks(): void {
  const localMetadata: Record<string, StoredMark> = {
    local: {
      kind: 'insert',
      by: 'user:test',
      createdAt: '2024-01-01T00:00:00Z',
      status: 'pending',
      content: 'local',
    },
  };
  const serverMarks: Record<string, StoredMark> = {
    local: {
      kind: 'insert',
      by: 'server:test',
      createdAt: '2024-01-02T00:00:00Z',
      status: 'pending',
      content: 'server',
    },
    comment: {
      kind: 'comment',
      by: 'server:test',
      createdAt: '2024-01-02T00:00:00Z',
      resolved: false,
      thread: 'Looks good.',
    },
    accepted: {
      kind: 'replace',
      by: 'server:test',
      createdAt: '2024-01-02T00:00:00Z',
      status: 'accepted',
      content: 'accepted',
    },
    rejected: {
      kind: 'delete',
      by: 'server:test',
      createdAt: '2024-01-02T00:00:00Z',
      status: 'rejected',
    },
  };

  const merged = mergePendingServerMarks(localMetadata, serverMarks);
  assert(merged.local?.by === 'server:test', 'Expected server attribution to remain authoritative for pending suggestions');
  assert(merged.local?.content === 'local', 'Expected stale server content not to replace current local suggestion content');
  assert(Boolean(merged.comment), 'Expected comment (no status) to be preserved');
  assert(!merged.accepted, 'Expected accepted mark to be dropped');
  assert(!merged.rejected, 'Expected rejected mark to be dropped');
}

async function run(): Promise<void> {
  testMergePendingServerMarks();

  const dbName = `proof-track-changes-race-${Date.now()}-${randomUUID()}.db`;
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

  let provider: HocuspocusProvider | null = null;
  const ydoc = new Y.Doc();
  let connected = false;
  let synced = false;

  try {
    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdown: '# Test\n\nThis sentence should get a suggestion.',
        marks: {},
        title: 'Track changes race test',
      }),
    });
    const created = await createRes.json() as { slug: string; ownerSecret: string };
    assert(typeof created.slug === 'string' && created.slug.length > 0, 'Expected create response slug');
    assert(typeof created.ownerSecret === 'string' && created.ownerSecret.length > 0, 'Expected create response ownerSecret');

    const sessionRes = await fetch(`${httpBase}/api/documents/${created.slug}/collab-session`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
      },
    });
    const sessionPayload = await sessionRes.json() as { success: boolean; session: { collabWsUrl: string; token: string; role: string } };
    assert(sessionPayload.success === true, 'Expected collab-session success');

    const wsUrl = (() => {
      const raw = sessionPayload.session.collabWsUrl.replace(/\?slug=.*$/, '');
      try {
        const url = new URL(raw);
        if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
        return url.toString();
      } catch {
        return raw.replace('ws://localhost:', 'ws://127.0.0.1:');
      }
    })();

    provider = new HocuspocusProvider({
      url: wsUrl,
      name: created.slug,
      document: ydoc,
      parameters: { token: sessionPayload.session.token, role: sessionPayload.session.role },
      token: sessionPayload.session.token,
      preserveConnection: false,
      broadcast: false,
    });

    provider.on('status', (event: { status: string }) => {
      if (event.status === 'connected') connected = true;
    });
    provider.on('synced', (event: { state?: boolean }) => {
      const state = event?.state;
      if (state !== false) synced = true;
    });

    await waitFor(() => connected, DEFAULT_TIMEOUT_MS, 'provider connected');
    await waitFor(() => synced, DEFAULT_TIMEOUT_MS, 'provider synced');

    const opsRes = await fetch(`${httpBase}/api/agent/${created.slug}/ops`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        type: 'suggestion.add',
        by: 'ai:test',
        kind: 'replace',
        quote: 'should get a suggestion',
        content: 'has a suggestion',
      }),
    });
    assert(opsRes.ok, `Expected ops suggestion.add to succeed, got HTTP ${opsRes.status}`);

    const marksMap = ydoc.getMap('marks');
    await waitFor(() => marksMap.size > 0, DEFAULT_TIMEOUT_MS, 'marks map populated');

    const serverMarks = readMarksMap(marksMap);
    const markIds = Object.keys(serverMarks);
    assert(markIds.length > 0, 'Expected server marks after suggestion.add');
    const markId = markIds[0] as string;
    assert(serverMarks[markId]?.status === 'pending', 'Expected pending suggestion status');

    const merged = mergePendingServerMarks({}, serverMarks);
    assert(Boolean(merged[markId]), 'Expected merge to preserve pending server mark');

    applyMarksMap(marksMap, merged);
    await sleep(50);

    const afterMarks = readMarksMap(marksMap);
    assert(Boolean(afterMarks[markId]), 'Expected server mark to survive merged flush');
    assert(afterMarks[markId]?.status === 'pending', 'Expected pending status after merged flush');

    console.log('✓ pending suggestion survives initial client mark sync');
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
    try {
      wss.close();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await collab.stopCollabRuntime();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
