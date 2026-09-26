import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.34.0',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

const CONNECTION_TTL_MS = 90;
const CONFIGURED_HEARTBEAT_MS = 1_000;
const CLOCK_ADVANCE_MS = 46_000;

function assert(condition: boolean, message: string): asserts condition {
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
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function run(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `proof-collab-heartbeat-${Date.now()}-${randomUUID()}.db`);
  const previousEnv = {
    databasePath: process.env.DATABASE_PATH,
    embeddedWs: process.env.COLLAB_EMBEDDED_WS,
    proofEnv: process.env.PROOF_ENV,
    allowCrossEnvWrites: process.env.ALLOW_CROSS_ENV_WRITES,
    connectionTtlMs: process.env.ACTIVE_COLLAB_CONNECTION_TTL_MS,
    heartbeatMs: process.env.DOCUMENT_LIVE_COLLAB_LEASE_HEARTBEAT_MS,
    hostedGraceMs: process.env.HOSTED_LIVE_DOC_GRACE_MS,
    hostedGracePollMs: process.env.HOSTED_LIVE_DOC_GRACE_POLL_MS,
  };
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';
  process.env.PROOF_ENV = 'staging';
  process.env.ALLOW_CROSS_ENV_WRITES = '1';
  process.env.ACTIVE_COLLAB_CONNECTION_TTL_MS = String(CONNECTION_TTL_MS);
  process.env.DOCUMENT_LIVE_COLLAB_LEASE_HEARTBEAT_MS = String(CONFIGURED_HEARTBEAT_MS);
  process.env.HOSTED_LIVE_DOC_GRACE_MS = '25';
  process.env.HOSTED_LIVE_DOC_GRACE_POLL_MS = '5';

  const [{ apiRoutes }, { agentRoutes }, { setupWebSocket, getActiveCollabClientBreakdown }, collab] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/agent-routes.js'),
    import('../../server/ws.js'),
    import('../../server/collab.js'),
  ]);
  assert(
    collab.__unsafeGetAuthenticatedCollabPresenceHeartbeatMsForTests() === CONNECTION_TTL_MS / 3,
    'Heartbeat longer than one third of the connection window must be capped',
  );
  process.env.DOCUMENT_LIVE_COLLAB_LEASE_HEARTBEAT_MS = '0';
  assert(
    collab.__unsafeGetAuthenticatedCollabPresenceHeartbeatMsForTests() === CONNECTION_TTL_MS / 3,
    'Disabled lease heartbeat must still refresh active connection presence',
  );
  process.env.DOCUMENT_LIVE_COLLAB_LEASE_HEARTBEAT_MS = String(CONFIGURED_HEARTBEAT_MS);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRoutes);
  app.use('/api/agent', agentRoutes);
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const httpBase = `http://127.0.0.1:${address.port}`;
  await collab.startCollabRuntimeEmbedded(address.port);

  const RealDate = Date;
  let wallClockOffsetMs = 0;
  class OffsetDate extends RealDate {
    constructor(...args: [] | [string | number]) {
      if (args.length === 0) super(RealDate.now() + wallClockOffsetMs);
      else super(args[0]);
    }

    static now(): number {
      return RealDate.now() + wallClockOffsetMs;
    }
  }

  let provider: HocuspocusProvider | null = null;
  const ydoc = new Y.Doc();
  try {
    const createResponse = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Live connection heartbeat',
        markdown: '# Live heartbeat\n\nKeep this page open.',
        marks: {},
      }),
    });
    const created = await createResponse.json() as { slug?: string; ownerSecret?: string };
    assert(
      createResponse.ok && typeof created.slug === 'string' && typeof created.ownerSecret === 'string',
      'Expected document creation to succeed',
    );

    const sessionResponse = await fetch(`${httpBase}/api/documents/${created.slug}/collab-session`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const sessionPayload = await sessionResponse.json() as {
      success?: boolean;
      session?: { collabWsUrl: string; token: string; role: string };
    };
    assert(
      sessionResponse.ok && sessionPayload.success === true && sessionPayload.session !== undefined,
      'Expected collab session',
    );
    const wsUrl = new URL(sessionPayload.session.collabWsUrl.replace(/\?slug=.*$/, ''));
    if (wsUrl.hostname === 'localhost') wsUrl.hostname = '127.0.0.1';

    provider = new HocuspocusProvider({
      url: wsUrl.toString(),
      name: created.slug,
      document: ydoc,
      parameters: {
        token: sessionPayload.session.token,
        role: sessionPayload.session.role,
      },
      token: sessionPayload.session.token,
      preserveConnection: false,
      broadcast: false,
    });
    let connected = false;
    let synced = false;
    provider.on('status', (event: { status: string }) => {
      connected = event.status === 'connected';
    });
    provider.on('synced', (event: { state?: boolean }) => {
      if (event.state !== false) synced = true;
    });
    await waitFor(() => connected && synced, 10_000, 'authenticated collab client to connect');
    await waitFor(
      () => getActiveCollabClientBreakdown(created.slug!).exactEpochCount >= 1,
      2_000,
      'initial exact-epoch connection row',
    );

    globalThis.Date = OffsetDate as DateConstructor;
    wallClockOffsetMs += CLOCK_ADVANCE_MS;
    await waitFor(
      () => getActiveCollabClientBreakdown(created.slug!).documentLeaseExactCount >= 1,
      2_000,
      'lease heartbeat after the connection window',
    );

    const breakdown = getActiveCollabClientBreakdown(created.slug);
    const suggestionResponse = await fetch(`${httpBase}/api/agent/${created.slug}/ops`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({
        type: 'suggestion.add',
        kind: 'replace',
        quote: 'Keep this page open.',
        content: 'Keep this page live.',
        by: 'ai:test',
      }),
    });
    const suggestionBody = await suggestionResponse.text();
    assert(
      breakdown.exactEpochCount >= 1,
      `Open socket became stale after 46 seconds: ${JSON.stringify(breakdown)}; suggestion HTTP ${suggestionResponse.status}: ${suggestionBody}`,
    );
    assert(
      suggestionResponse.ok,
      `Expected suggestion.add to succeed after 46 seconds, got HTTP ${suggestionResponse.status}: ${suggestionBody}`,
    );

    provider.disconnect();
    provider.destroy();
    (provider as any)?.configuration?.websocketProvider?.destroy?.();
    provider = null;
    await waitFor(
      () => getActiveCollabClientBreakdown(created.slug!).exactEpochCount === 0,
      2_000,
      'connection row removal after socket close',
    );
    wallClockOffsetMs += CLOCK_ADVANCE_MS;
    await sleep(CONNECTION_TTL_MS);
    assert(
      getActiveCollabClientBreakdown(created.slug).exactEpochCount === 0,
      'Closed socket heartbeat recreated a ghost active connection',
    );

    console.log('✓ an open collab page stays live past 45 seconds and stops counting after close');
  } finally {
    globalThis.Date = RealDate;
    try {
      provider?.disconnect();
      provider?.destroy();
      (provider as any)?.configuration?.websocketProvider?.destroy?.();
    } catch {
      // best-effort test cleanup
    }
    ydoc.destroy();
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await collab.stopCollabRuntime();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('DATABASE_PATH', previousEnv.databasePath);
    restore('COLLAB_EMBEDDED_WS', previousEnv.embeddedWs);
    restore('PROOF_ENV', previousEnv.proofEnv);
    restore('ALLOW_CROSS_ENV_WRITES', previousEnv.allowCrossEnvWrites);
    restore('ACTIVE_COLLAB_CONNECTION_TTL_MS', previousEnv.connectionTtlMs);
    restore('DOCUMENT_LIVE_COLLAB_LEASE_HEARTBEAT_MS', previousEnv.heartbeatMs);
    restore('HOSTED_LIVE_DOC_GRACE_MS', previousEnv.hostedGraceMs);
    restore('HOSTED_LIVE_DOC_GRACE_POLL_MS', previousEnv.hostedGracePollMs);
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // best-effort test cleanup
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
