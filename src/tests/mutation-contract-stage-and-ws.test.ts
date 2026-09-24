import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';

type CreatedDoc = {
  slug: string;
  ownerSecret: string;
};

type StatePayload = {
  success: boolean;
  updatedAt: string;
  revision: number;
};

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.33.0',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${name}`);
    console.error(`  ${(error as Error).message}`);
  }
}

async function mustJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON response, got: ${text.slice(0, 240)}`);
  }
}

function wsHeaders(headers: Record<string, string>): Record<string, string> {
  return headers;
}

async function openWs(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: wsHeaders(headers) });
    const timeout = setTimeout(() => {
      try { ws.terminate(); } catch { /* noop */ }
      reject(new Error(`Timed out waiting for websocket open: ${url}`));
    }, 5000);
    ws.once('open', () => {
      clearTimeout(timeout);
      resolve(ws);
    });
    ws.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    ws.once('close', (code, reason) => {
      clearTimeout(timeout);
      reject(new Error(`Websocket closed before open (${code}): ${String(reason)}`));
    });
  });
}

async function expectWsCloseCode(url: string, expectedCode: number, headers: Record<string, string> = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url, { headers: wsHeaders(headers) });
    const timeout = setTimeout(() => {
      try { ws.terminate(); } catch { /* noop */ }
      reject(new Error(`Timed out waiting for websocket close: ${url}`));
    }, 5000);
    ws.once('close', (code) => {
      clearTimeout(timeout);
      if (code !== expectedCode) {
        reject(new Error(`Expected close code ${expectedCode}, got ${code}`));
        return;
      }
      resolve();
    });
    ws.once('error', () => {
      // close event carries the authoritative close code
    });
  });
}

async function closeWs(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve) => {
    ws.once('close', () => resolve());
    try {
      ws.close();
    } catch {
      resolve();
    }
  });
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs: number = 2000,
  intervalMs: number = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return condition();
}

async function run(): Promise<void> {
  const previousStage = process.env.PROOF_MUTATION_CONTRACT_STAGE;
  const previousProofEnv = process.env.PROOF_ENV;
  const previousBarrierFail = process.env.PROOF_REWRITE_BARRIER_FORCE_FAIL;
  const dbName = `proof-mutation-stage-${Date.now()}-${randomUUID()}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';
  process.env.PROOF_MUTATION_CONTRACT_STAGE = 'A';

  const [{ apiRoutes }, { agentRoutes }, { bridgeRouter }, wsModule, collab, metricsModule] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/agent-routes.js'),
    import('../../server/bridge.js'),
    import('../../server/ws.js'),
    import('../../server/collab.js'),
    import('../../server/metrics.js'),
  ]);
  const { setupWebSocket, getActiveCollabClientCount } = wsModule;
  const { renderMetricsText } = metricsModule;

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRoutes);
  app.use('/api/agent', agentRoutes);
  app.use('/d/:slug/bridge', bridgeRouter);

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;

  await collab.startCollabRuntimeEmbedded(address.port);

  const createDoc = async (): Promise<CreatedDoc> => {
    const response = await fetch(`${base}/api/documents`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdown: '# Contract test\n\nInitial paragraph.',
        marks: {},
      }),
    });
    assert(response.ok, `Create document failed: ${response.status}`);
    return mustJson<CreatedDoc>(response);
  };

  const getState = async (doc: CreatedDoc): Promise<StatePayload> => {
    const response = await fetch(`${base}/api/agent/${doc.slug}/state`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': doc.ownerSecret },
    });
    assert(response.ok, `State request failed: ${response.status}`);
    const payload = await mustJson<StatePayload>(response);
    assert(payload.success === true, 'Expected success=true in state payload');
    return payload;
  };

  const getCollabToken = async (doc: CreatedDoc): Promise<string> => {
    const response = await fetch(`${base}/api/documents/${doc.slug}/collab-session`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': doc.ownerSecret },
    });
    assert(response.ok, `collab-session failed: ${response.status}`);
    const payload = await mustJson<{ success: boolean; session?: { token?: string } }>(response);
    const token = payload.session?.token;
    assert(typeof token === 'string' && token.length > 0, 'Expected collab token');
    return token;
  };

  try {
    await test('Stage A keeps comment.add precondition optional', async () => {
      process.env.PROOF_MUTATION_CONTRACT_STAGE = 'A';
      const doc = await createDoc();
      const response = await fetch(`${base}/api/agent/${doc.slug}/ops`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-share-token': doc.ownerSecret },
        body: JSON.stringify({
          op: 'comment.add',
          quote: 'Initial paragraph.',
          text: 'Stage A optional base check',
        }),
      });
      const body = await mustJson<{ success?: boolean; code?: string; error?: string }>(response);
      assert(response.ok, `Expected stage A comment.add success, got ${response.status} ${JSON.stringify(body)}`);
      assert(body.success === true, 'Expected successful stage A comment.add');
    });

    await test('Stage B requires Idempotency-Key for mutation requests', async () => {
      process.env.PROOF_MUTATION_CONTRACT_STAGE = 'B';
      const doc = await createDoc();
      const state = await getState(doc);
      const response = await fetch(`${base}/api/agent/${doc.slug}/ops`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-share-token': doc.ownerSecret },
        body: JSON.stringify({
          op: 'comment.add',
          baseRevision: state.revision,
          quote: 'Initial paragraph.',
          text: 'Missing key should fail',
        }),
      });
      const body = await mustJson<{ code?: string; error?: string }>(response);
      assert(response.status === 409, `Expected 409, got ${response.status}`);
      assert(body.code === 'IDEMPOTENCY_KEY_REQUIRED', `Expected IDEMPOTENCY_KEY_REQUIRED, got ${String(body.code)}`);
    });

    await test('Stage B accepts canonical Idempotency-Key header', async () => {
      process.env.PROOF_MUTATION_CONTRACT_STAGE = 'B';
      const doc = await createDoc();
      const state = await getState(doc);
      const response = await fetch(`${base}/api/agent/${doc.slug}/ops`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-share-token': doc.ownerSecret,
          'Idempotency-Key': `stage-b-canonical-${randomUUID()}`,
        },
        body: JSON.stringify({
          op: 'comment.add',
          baseRevision: state.revision,
          quote: 'Initial paragraph.',
          text: 'Canonical idempotency header should pass',
        }),
      });
      const body = await mustJson<{ success?: boolean; code?: string; error?: string }>(response);
      assert(response.ok, `Expected stage B mutation success with Idempotency-Key, got ${response.status} ${JSON.stringify(body)}`);
      assert(body.success === true, 'Expected successful stage B mutation');
    });

    await test('Agent /state exposes mutation contract stage metadata', async () => {
      process.env.PROOF_MUTATION_CONTRACT_STAGE = 'C';
      const doc = await createDoc();
      const response = await fetch(`${base}/api/agent/${doc.slug}/state`, {
        headers: { ...CLIENT_HEADERS, 'x-share-token': doc.ownerSecret },
      });
      assert(response.ok, `State request failed: ${response.status}`);
      const payload = await mustJson<{
        contract?: { mutationStage?: string; idempotencyRequired?: boolean; preconditionMode?: string };
        _links?: { title?: { method?: string; href?: string } };
        agent?: { titleApi?: string };
      }>(response);
      assert(payload.contract?.mutationStage === 'C', `Expected mutationStage C, got ${String(payload.contract?.mutationStage)}`);
      assert(payload.contract?.idempotencyRequired === true, 'Expected idempotencyRequired=true in stage C');
      assert(payload.contract?.preconditionMode === 'revision-only', `Expected revision-only precondition mode, got ${String(payload.contract?.preconditionMode)}`);
      assert(payload._links?.title?.method === 'PUT', `Expected _links.title.method=PUT, got ${String(payload._links?.title?.method)}`);
      assert(
        payload._links?.title?.href === `/api/documents/${doc.slug}/title`,
        `Expected _links.title.href to target document title endpoint, got ${String(payload._links?.title?.href)}`,
      );
      assert(payload.agent?.titleApi === `/api/documents/${doc.slug}/title`, `Expected agent.titleApi, got ${String(payload.agent?.titleApi)}`);
    });

    await test('Stage B requires base precondition on ops route', async () => {
      process.env.PROOF_MUTATION_CONTRACT_STAGE = 'B';
      const doc = await createDoc();
      const response = await fetch(`${base}/api/agent/${doc.slug}/ops`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-share-token': doc.ownerSecret,
          'x-idempotency-key': 'stage-b-missing-base',
        },
        body: JSON.stringify({
          op: 'comment.add',
          quote: 'Initial paragraph.',
          text: 'No base should fail in Stage B',
        }),
      });
      const body = await mustJson<{ code?: string; error?: string }>(response);
      assert(response.status === 409, `Expected 409, got ${response.status}`);
      assert(body.code === 'MISSING_BASE', `Expected MISSING_BASE, got ${String(body.code)}`);
    });

    await test('Stage B requires base precondition on legacy /marks routes', async () => {
      process.env.PROOF_MUTATION_CONTRACT_STAGE = 'B';
      const doc = await createDoc();
      const routes = [
        '/marks/comment',
        '/marks/suggest-replace',
        '/marks/suggest-insert',
        '/marks/suggest-delete',
        '/marks/accept',
        '/marks/reject',
        '/marks/reply',
        '/marks/resolve',
      ];
      for (const route of routes) {
        const response = await fetch(`${base}/api/agent/${doc.slug}${route}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-share-token': doc.ownerSecret,
            'x-idempotency-key': `stage-b-missing-base-${route}-${randomUUID()}`,
          },
          body: JSON.stringify({}),
        });
        const body = await mustJson<{ code?: string; error?: string }>(response);
        assert(response.status === 409, `Expected 409 for ${route}, got ${response.status} ${JSON.stringify(body)}`);
        assert(body.code === 'MISSING_BASE', `Expected MISSING_BASE for ${route}, got ${String(body.code)}`);
      }
    });

    await test('Stage C rejects baseUpdatedAt-only edit preconditions', async () => {
      process.env.PROOF_MUTATION_CONTRACT_STAGE = 'C';
      const doc = await createDoc();
      const state = await getState(doc);
      const response = await fetch(`${base}/api/agent/${doc.slug}/edit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-share-token': doc.ownerSecret,
          'x-idempotency-key': 'stage-c-baseupdatedat',
        },
        body: JSON.stringify({
          by: 'ai:test',
          baseUpdatedAt: state.updatedAt,
          operations: [{ op: 'append', section: '# Contract test', content: '\n\nAdded line.' }],
        }),
      });
      const body = await mustJson<{ code?: string; error?: string }>(response);
      assert(response.status === 409, `Expected 409, got ${response.status}`);
      assert(body.code === 'BASE_REVISION_REQUIRED', `Expected BASE_REVISION_REQUIRED, got ${String(body.code)}`);
    });

    await test('Agent /ops enforces idempotency replay + mismatch semantics', async () => {
      process.env.PROOF_MUTATION_CONTRACT_STAGE = 'A';
      const doc = await createDoc();
      const key = 'ops-idempotency-replay';
      const first = await fetch(`${base}/api/agent/${doc.slug}/ops`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-share-token': doc.ownerSecret,
          'x-idempotency-key': key,
        },
        body: JSON.stringify({
          op: 'comment.add',
          quote: 'Initial paragraph.',
          text: 'Idempotent comment',
        }),
      });
      const firstBody = await mustJson<{ success?: boolean }>(first);
      assert(first.ok && firstBody.success === true, 'Expected first idempotent /ops request to succeed');

      const replay = await fetch(`${base}/api/agent/${doc.slug}/ops`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-share-token': doc.ownerSecret,
          'x-idempotency-key': key,
        },
        body: JSON.stringify({
          op: 'comment.add',
          quote: 'Initial paragraph.',
          text: 'Idempotent comment',
        }),
      });
      const replayBody = await mustJson<{ success?: boolean }>(replay);
      assert(replay.ok && replayBody.success === true, 'Expected idempotency replay to return stored success');

      const mismatch = await fetch(`${base}/api/agent/${doc.slug}/ops`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-share-token': doc.ownerSecret,
          'x-idempotency-key': key,
        },
        body: JSON.stringify({
          op: 'comment.add',
          quote: 'Initial paragraph.',
          text: 'Different payload with same key',
        }),
      });
      const mismatchBody = await mustJson<{ code?: string }>(mismatch);
      assert(mismatch.status === 409, `Expected 409 mismatch, got ${mismatch.status}`);
      assert(mismatchBody.code === 'IDEMPOTENCY_KEY_REUSED', `Expected IDEMPOTENCY_KEY_REUSED, got ${String(mismatchBody.code)}`);
    });

    await test('Agent /ops idempotency replay does not bypass auth', async () => {
      process.env.PROOF_MUTATION_CONTRACT_STAGE = 'A';
      const doc = await createDoc();
      const key = `ops-auth-bypass-${randomUUID()}`;
      const payload = {
        op: 'comment.add',
        quote: 'Initial paragraph.',
        text: 'Auth replay bypass guard',
      };
      const first = await fetch(`${base}/api/agent/${doc.slug}/ops`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-share-token': doc.ownerSecret,
          'x-idempotency-key': key,
        },
        body: JSON.stringify(payload),
      });
      assert(first.ok, `Expected initial authorized /agent ops request success, got ${first.status}`);

      const replayWithoutAuth = await fetch(`${base}/api/agent/${doc.slug}/ops`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-idempotency-key': key,
        },
        body: JSON.stringify(payload),
      });
      const replayBody = await mustJson<{ success?: boolean; error?: string }>(replayWithoutAuth);
      assert(replayWithoutAuth.status === 403, `Expected 403 for unauthorized replay, got ${replayWithoutAuth.status} ${JSON.stringify(replayBody)}`);
      assert(replayBody.success !== true, 'Expected unauthorized replay to fail');
    });

    await test('/documents/:slug/ops idempotency replay does not bypass authorization checks', async () => {
      process.env.PROOF_MUTATION_CONTRACT_STAGE = 'A';
      const doc = await createDoc();
      const key = `documents-ops-auth-bypass-${randomUUID()}`;
      const payload = {
        type: 'comment.add',
        quote: 'Initial paragraph.',
        text: 'Auth replay bypass guard',
      };
      const first = await fetch(`${base}/api/documents/${doc.slug}/ops`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-share-token': doc.ownerSecret,
          'x-idempotency-key': key,
        },
        body: JSON.stringify(payload),
      });
      assert(first.ok, `Expected initial authorized /documents ops request success, got ${first.status}`);

      const revoke = await fetch(`${base}/api/documents/${doc.slug}/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-share-token': doc.ownerSecret,
        },
      });
      assert(revoke.ok, `Expected revoke to succeed before replay check, got ${revoke.status}`);

      const replayWithoutAuth = await fetch(`${base}/api/documents/${doc.slug}/ops`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-idempotency-key': key,
        },
        body: JSON.stringify(payload),
      });
      const replayBody = await mustJson<{ success?: boolean; error?: string }>(replayWithoutAuth);
      assert(replayWithoutAuth.status === 403, `Expected 403 for replay on revoked share, got ${replayWithoutAuth.status} ${JSON.stringify(replayBody)}`);
      assert(replayBody.success !== true, 'Expected replay on revoked share to fail');
    });

    await test('Agent /edit enforces idempotency replay + mismatch semantics', async () => {
      process.env.PROOF_MUTATION_CONTRACT_STAGE = 'A';
      const doc = await createDoc();
      const state = await getState(doc);
      const key = 'edit-idempotency-replay';
      const payload = {
        by: 'ai:test',
        baseUpdatedAt: state.updatedAt,
        operations: [{ op: 'append', section: '# Contract test', content: '\n\nIdempotent edit.' }],
      };

      const first = await fetch(`${base}/api/agent/${doc.slug}/edit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-share-token': doc.ownerSecret,
          'x-idempotency-key': key,
        },
        body: JSON.stringify(payload),
      });
      const firstBody = await mustJson<{ success?: boolean }>(first);
      assert(first.ok && firstBody.success === true, 'Expected first /edit call to succeed');

      const replay = await fetch(`${base}/api/agent/${doc.slug}/edit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-share-token': doc.ownerSecret,
          'x-idempotency-key': key,
        },
        body: JSON.stringify(payload),
      });
      const replayBody = await mustJson<{ success?: boolean }>(replay);
      assert(replay.ok && replayBody.success === true, 'Expected /edit idempotency replay to succeed');

      const mismatch = await fetch(`${base}/api/agent/${doc.slug}/edit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-share-token': doc.ownerSecret,
          'x-idempotency-key': key,
        },
        body: JSON.stringify({
          ...payload,
          operations: [{ op: 'append', section: '# Contract test', content: '\n\nDifferent edit body.' }],
        }),
      });
      const mismatchBody = await mustJson<{ code?: string }>(mismatch);
      assert(mismatch.status === 409, `Expected 409 mismatch, got ${mismatch.status}`);
      assert(mismatchBody.code === 'IDEMPOTENCY_KEY_REUSED', `Expected IDEMPOTENCY_KEY_REUSED, got ${String(mismatchBody.code)}`);
    });

    await test('/ws collab pre-gate accepts header token and query token parity', async () => {
      process.env.PROOF_MUTATION_CONTRACT_STAGE = 'A';
      const doc = await createDoc();
      const token = await getCollabToken(doc);

      const headerWs = await openWs(
        `${wsBase}/ws?slug=${encodeURIComponent(doc.slug)}&role=editor`,
        { Authorization: `Bearer ${token}` },
      );
      await closeWs(headerWs);

      const queryWs = await openWs(
        `${wsBase}/ws?slug=${encodeURIComponent(doc.slug)}&role=editor&token=${encodeURIComponent(token)}`,
      );
      await closeWs(queryWs);

      await expectWsCloseCode(
        `${wsBase}/ws?slug=${encodeURIComponent(doc.slug)}&role=editor`,
        4401,
        { Authorization: 'Bearer invalid-collab-token' },
      );
    });

    await test('/ws collab registration ignores unauthenticated sockets for rewrite gating', async () => {
      process.env.PROOF_MUTATION_CONTRACT_STAGE = 'A';
      const doc = await createDoc();
      const unauthWs = new WebSocket(`${wsBase}/ws?slug=${encodeURIComponent(doc.slug)}&role=editor`);
      unauthWs.on('error', () => {
        // ignore; connection may be closed by auth hooks
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert(getActiveCollabClientCount(doc.slug) === 0, `Expected unauthenticated collab socket count=0, got ${getActiveCollabClientCount(doc.slug)}`);
      try {
        unauthWs.terminate();
      } catch {
        // ignore
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    await test('/ws collab accepts authenticated sockets without slug query param', async () => {
      process.env.PROOF_MUTATION_CONTRACT_STAGE = 'A';
      const doc = await createDoc();
      const token = await getCollabToken(doc);
      const sluglessWs = await openWs(
        `${wsBase}/ws?role=editor&token=${encodeURIComponent(token)}`,
      );
      try {
        const counted = await waitForCondition(() => getActiveCollabClientCount(doc.slug) > 0, 2000, 50);
        assert(counted, 'Expected authenticated slugless collab connection to be counted');
      } finally {
        await closeWs(sluglessWs);
      }
    });

    await test('rewrite live-client gate keeps force behavior in local env', async () => {
      process.env.PROOF_MUTATION_CONTRACT_STAGE = 'A';
      process.env.PROOF_ENV = 'development';
      const doc = await createDoc();
      const token = await getCollabToken(doc);
      const liveWs = await openWs(
        `${wsBase}/ws?slug=${encodeURIComponent(doc.slug)}&role=editor&token=${encodeURIComponent(token)}`,
      );

      try {
        const state = await getState(doc);

        const blocked = await fetch(`${base}/api/agent/${doc.slug}/rewrite`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-share-token': doc.ownerSecret,
            'x-idempotency-key': 'rewrite-blocked',
          },
          body: JSON.stringify({
            baseRevision: state.revision,
            content: '# Contract test\n\nBlocked while live clients are connected.',
          }),
        });
        const blockedBody = await mustJson<{ code?: string; connectedClients?: number }>(blocked);
        assert(blocked.status === 409, `Expected 409 when live clients connected, got ${blocked.status}`);
        assert(blockedBody.code === 'LIVE_CLIENTS_PRESENT', `Expected LIVE_CLIENTS_PRESENT, got ${String(blockedBody.code)}`);
        assert((blockedBody.connectedClients ?? 0) > 0, 'Expected connectedClients > 0 on blocked rewrite');

        const forced = await fetch(`${base}/api/agent/${doc.slug}/rewrite`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-share-token': doc.ownerSecret,
            'x-idempotency-key': 'rewrite-forced',
          },
          body: JSON.stringify({
            baseRevision: state.revision,
            content: '# Contract test\n\nForced rewrite.',
            force: true,
          }),
        });
        const forcedBody = await mustJson<{
          success?: boolean;
          force?: boolean;
          forceRequested?: boolean;
          forceHonored?: boolean;
          forceIgnored?: boolean;
          rewriteBarrierApplied?: boolean;
          connectedClients?: number;
        }>(forced);
        assert(forced.ok, `Expected forced rewrite success, got ${forced.status}`);
        assert(forcedBody.success === true, 'Expected forced rewrite success payload');
        assert(forcedBody.force === true, 'Expected force alias=true for compatibility');
        assert(forcedBody.forceRequested === true, 'Expected forceRequested=true');
        assert(forcedBody.forceHonored === true, 'Expected forceHonored=true');
        assert(forcedBody.forceIgnored === false, 'Expected forceIgnored=false');
        assert(forcedBody.rewriteBarrierApplied === true, 'Expected rewriteBarrierApplied metadata');
        assert((forcedBody.connectedClients ?? 0) > 0, 'Expected connectedClients metadata on forced rewrite');
      } finally {
        await closeWs(liveWs);
      }
    });

    await test('hosted env ignores force=true and blocks rewrite across all entrypoints', async () => {
      process.env.PROOF_MUTATION_CONTRACT_STAGE = 'A';
      process.env.PROOF_ENV = 'staging';
      const previousAllowCrossEnvWrites = process.env.ALLOW_CROSS_ENV_WRITES;
      process.env.ALLOW_CROSS_ENV_WRITES = '1';
      const doc = await createDoc();
      const token = await getCollabToken(doc);
      const liveWs = await openWs(
        `${wsBase}/ws?slug=${encodeURIComponent(doc.slug)}&role=editor&token=${encodeURIComponent(token)}`,
      );

      try {
        const state = await getState(doc);

        const attempts: Array<{
          label: string;
          routeLabel: string;
          call: () => Promise<Response>;
        }> = [
          {
            label: 'agent rewrite',
            routeLabel: 'POST /rewrite',
            call: () => fetch(`${base}/api/agent/${doc.slug}/rewrite`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-share-token': doc.ownerSecret,
                'x-idempotency-key': 'hosted-force-agent-rewrite',
              },
              body: JSON.stringify({
                baseRevision: state.revision,
                content: '# Contract test\n\nHosted force should be ignored.',
                force: true,
              }),
            }),
          },
          {
            label: 'agent ops rewrite.apply',
            routeLabel: 'POST /ops',
            call: () => fetch(`${base}/api/agent/${doc.slug}/ops`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-share-token': doc.ownerSecret,
                'x-idempotency-key': 'hosted-force-agent-ops',
              },
              body: JSON.stringify({
                op: 'rewrite.apply',
                baseRevision: state.revision,
                content: '# Contract test\n\nHosted force should be ignored.',
                force: true,
              }),
            }),
          },
          {
            label: 'documents ops rewrite.apply',
            routeLabel: 'POST /documents/:slug/ops',
            call: () => fetch(`${base}/api/documents/${doc.slug}/ops`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-share-token': doc.ownerSecret,
                'x-idempotency-key': 'hosted-force-docs-ops',
              },
              body: JSON.stringify({
                type: 'rewrite.apply',
                baseRevision: state.revision,
                content: '# Contract test\n\nHosted force should be ignored.',
                force: true,
              }),
            }),
          },
          {
            label: 'bridge rewrite',
            routeLabel: 'POST /d/:slug/bridge/rewrite',
            call: () => fetch(`${base}/d/${doc.slug}/bridge/rewrite`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-bridge-token': doc.ownerSecret,
              },
              body: JSON.stringify({
                baseRevision: state.revision,
                content: '# Contract test\n\nHosted force should be ignored.',
                force: true,
              }),
            }),
          },
        ];

        for (const attempt of attempts) {
          const response = await attempt.call();
          const body = await mustJson<{
            code?: string;
            retryable?: boolean;
            reason?: string;
            nextSteps?: unknown;
            connectedClients?: number;
            force?: boolean;
            forceRequested?: boolean;
            forceHonored?: boolean;
            forceIgnored?: boolean;
          }>(response);
          assert(response.status === 409, `Expected 409 for ${attempt.label}, got ${response.status}`);
          assert(body.code === 'LIVE_CLIENTS_PRESENT', `Expected LIVE_CLIENTS_PRESENT for ${attempt.label}, got ${String(body.code)}`);
          assert(body.retryable === true, `Expected retryable=true for ${attempt.label}`);
          assert(body.reason === 'live_clients_present', `Expected live_clients_present reason for ${attempt.label}`);
          assert(Array.isArray(body.nextSteps) && body.nextSteps.length >= 2, `Expected nextSteps guidance for ${attempt.label}`);
          assert((body.connectedClients ?? 0) > 0, `Expected connectedClients > 0 for ${attempt.label}`);
          assert(body.force === true, `Expected force alias=true for ${attempt.label}`);
          assert(body.forceRequested === true, `Expected forceRequested=true for ${attempt.label}`);
          assert(body.forceHonored === false, `Expected forceHonored=false for ${attempt.label}`);
          assert(body.forceIgnored === true, `Expected forceIgnored=true for ${attempt.label}`);
        }

        const metricsText = renderMetricsText();
        for (const attempt of attempts) {
          assert(
            metricsText.includes(`rewrite_live_client_block_total{env="staging",force_ignored="true",force_requested="true",route="${attempt.routeLabel}"}`),
            `Expected rewrite_live_client_block_total metric for ${attempt.routeLabel}`,
          );
        }
      } finally {
        await closeWs(liveWs);
        if (previousAllowCrossEnvWrites === undefined) delete process.env.ALLOW_CROSS_ENV_WRITES;
        else process.env.ALLOW_CROSS_ENV_WRITES = previousAllowCrossEnvWrites;
      }
    });

    await test('rewrite barrier failures return 503 and do not mutate across all rewrite entrypoints', async () => {
      process.env.PROOF_MUTATION_CONTRACT_STAGE = 'A';
      process.env.PROOF_ENV = 'development';
      process.env.PROOF_REWRITE_BARRIER_FORCE_FAIL = '1';
      const doc = await createDoc();
      const state = await getState(doc);
      const contentResponse = await fetch(`${base}/api/documents/${doc.slug}`, {
        headers: { ...CLIENT_HEADERS, 'x-share-token': doc.ownerSecret },
      });
      const contentPayload = await mustJson<{ markdown?: string }>(contentResponse);
      const beforeMarkdown = String(contentPayload.markdown ?? '');

      const attempts: Array<{
        label: string;
        routeLabel: string;
        call: () => Promise<Response>;
      }> = [
        {
          label: 'agent rewrite',
          routeLabel: 'POST /rewrite',
          call: () => fetch(`${base}/api/agent/${doc.slug}/rewrite`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-share-token': doc.ownerSecret,
              'x-idempotency-key': 'barrier-fail-agent-rewrite',
            },
            body: JSON.stringify({
              baseRevision: state.revision,
              content: '# Contract test\n\nBarrier fail should not write.',
            }),
          }),
        },
        {
          label: 'agent ops rewrite.apply',
          routeLabel: 'POST /ops',
          call: () => fetch(`${base}/api/agent/${doc.slug}/ops`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-share-token': doc.ownerSecret,
              'x-idempotency-key': 'barrier-fail-agent-ops',
            },
            body: JSON.stringify({
              op: 'rewrite.apply',
              baseRevision: state.revision,
              content: '# Contract test\n\nBarrier fail should not write.',
            }),
          }),
        },
        {
          label: 'documents ops rewrite.apply',
          routeLabel: 'POST /documents/:slug/ops',
          call: () => fetch(`${base}/api/documents/${doc.slug}/ops`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-share-token': doc.ownerSecret,
              'x-idempotency-key': 'barrier-fail-docs-ops',
            },
            body: JSON.stringify({
              type: 'rewrite.apply',
              baseRevision: state.revision,
              content: '# Contract test\n\nBarrier fail should not write.',
            }),
          }),
        },
        {
          label: 'bridge rewrite',
          routeLabel: 'POST /d/:slug/bridge/rewrite',
          call: () => fetch(`${base}/d/${doc.slug}/bridge/rewrite`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-bridge-token': doc.ownerSecret,
            },
            body: JSON.stringify({
              baseRevision: state.revision,
              content: '# Contract test\n\nBarrier fail should not write.',
            }),
          }),
        },
      ];

      try {
        for (const attempt of attempts) {
          const response = await attempt.call();
          const body = await mustJson<{
            code?: string;
            retryable?: boolean;
            retryWithState?: string;
          }>(response);
          assert(response.status === 503, `Expected 503 for ${attempt.label}, got ${response.status}`);
          assert(body.code === 'REWRITE_BARRIER_FAILED', `Expected REWRITE_BARRIER_FAILED for ${attempt.label}, got ${String(body.code)}`);
          assert(body.retryable === true, `Expected retryable=true for ${attempt.label}`);
        }
      } finally {
        process.env.PROOF_REWRITE_BARRIER_FORCE_FAIL = '0';
      }

      const stateAfter = await getState(doc);
      assert(stateAfter.revision === state.revision, `Expected revision unchanged after barrier failures (${state.revision} -> ${stateAfter.revision})`);
      const contentAfterResponse = await fetch(`${base}/api/documents/${doc.slug}`, {
        headers: { ...CLIENT_HEADERS, 'x-share-token': doc.ownerSecret },
      });
      const contentAfterPayload = await mustJson<{ markdown?: string }>(contentAfterResponse);
      assert(String(contentAfterPayload.markdown ?? '') === beforeMarkdown, 'Expected markdown unchanged after barrier failures');

      const metricsText = renderMetricsText();
      for (const attempt of attempts) {
        assert(
          metricsText.includes(`rewrite_barrier_failure_total{reason="forced",route="${attempt.routeLabel}"}`),
          `Expected rewrite_barrier_failure_total metric for ${attempt.routeLabel}`,
        );
      }
      assert(
        metricsText.includes('rewrite_barrier_latency_ms_bucket'),
        'Expected rewrite barrier latency histogram metrics to be emitted',
      );
    });
  } finally {
    process.env.PROOF_MUTATION_CONTRACT_STAGE = previousStage;
    if (previousProofEnv === undefined) delete process.env.PROOF_ENV;
    else process.env.PROOF_ENV = previousProofEnv;
    if (previousBarrierFail === undefined) delete process.env.PROOF_REWRITE_BARRIER_FORCE_FAIL;
    else process.env.PROOF_REWRITE_BARRIER_FORCE_FAIL = previousBarrierFail;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      unlinkSync(dbPath);
    } catch {
      // ignore cleanup failures
    }
  }

  if (failed > 0) {
    throw new Error(`${failed} tests failed (${passed} passed)`);
  }
  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
