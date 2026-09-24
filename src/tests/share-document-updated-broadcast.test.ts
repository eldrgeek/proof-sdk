import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

type ShareCreateResponse = {
  slug: string;
  ownerSecret: string;
};

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.33.0',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

function parseMessage(data: RawData): Record<string, unknown> {
  return JSON.parse(data.toString()) as Record<string, unknown>;
}

async function waitForMessage(
  ws: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timed out waiting for websocket message'));
    }, timeoutMs);
    const onMessage = (data: RawData) => {
      try {
        const message = parseMessage(data);
        if (!predicate(message)) return;
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(message);
      } catch {
        // ignore malformed payloads
      }
    };
    ws.on('message', onMessage);
  });
}

async function mustJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
  }
  return JSON.parse(text) as T;
}

async function run(): Promise<void> {
  const dbPath = path.join(tmpdir(), `proof-share-doc-updated-${randomUUID()}.db`);
  process.env.DATABASE_PATH = dbPath;

  const [{ apiRoutes }, { agentRoutes }, { setupWebSocket }] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/agent-routes.js'),
    import('../../server/ws.js'),
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
  const wsBase = `ws://127.0.0.1:${address.port}`;

  let ws: WebSocket | null = null;

  try {
    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdown: '# Title\n\nHello there.',
        marks: {},
        title: 'Broadcast test',
      }),
    });
    const created = await mustJson<ShareCreateResponse>(createRes);
    assert.equal(typeof created.slug, 'string');
    assert.equal(typeof created.ownerSecret, 'string');

    ws = new WebSocket(`${wsBase}/ws?slug=${encodeURIComponent(created.slug)}&token=${encodeURIComponent(created.ownerSecret)}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out opening websocket')), 3000);
      ws!.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws!.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    ws.send(JSON.stringify({
      type: 'viewer.identify',
      name: 'QA Viewer',
      capabilities: { bridge: true },
    }));

    const putMessagePromise = waitForMessage(ws, (message) =>
      message.type === 'document.updated'
      && typeof message.markdown === 'string'
      && String(message.markdown).includes('Updated by PUT'),
    5000);

    const putRes = await fetch(`${httpBase}/api/documents/${created.slug}`, {
      method: 'PUT',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerSecret: created.ownerSecret,
        markdown: '# Title\n\nUpdated by PUT.',
      }),
    });
    assert.equal(putRes.ok, true, `Expected PUT success, got ${putRes.status}`);

    const putMessage = await putMessagePromise;
    assert.equal(putMessage.type, 'document.updated');
    assert.equal(typeof putMessage.markdown, 'string');

    const editV2MessagePromise = waitForMessage(ws, (message) =>
      message.type === 'document.updated'
      && message.source === 'agent-edit-v2',
    5000);

    const editRes = await fetch(`${httpBase}/api/agent/${created.slug}/edit/v2`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        by: 'ai:test',
        baseRevision: 2,
        operations: [
          { op: 'replace_block', ref: 'b2', block: { markdown: 'Updated by edit v2.' } },
        ],
      }),
    });
    assert.equal(editRes.ok, true, `Expected edit/v2 success, got ${editRes.status}`);

    const editMessage = await editV2MessagePromise;
    assert.equal(editMessage.type, 'document.updated');
    assert.equal(editMessage.source, 'agent-edit-v2');

    console.log('✓ share websocket receives document.updated broadcasts from REST and edit/v2 routes');
  } finally {
    try {
      ws?.close();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
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

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
