import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';

async function run(): Promise<void> {
  process.env.DATABASE_PATH = path.join(tmpdir(), `proof-bridge-errors-${randomUUID()}.db`);
  process.env.BRIDGE_RATE_LIMIT_MAX_UNAUTH_PER_MIN = '2';
  process.env.BRIDGE_RATE_LIMIT_WINDOW_MS = '60000';

  const [{ bridgeRouter }, dbModule] = await Promise.all([
    import('../../server/bridge'),
    import('../../server/db'),
  ]);

  dbModule.createDocument('authslug', '# Test', {}, 'Bridge Test', 'owner-1', 'secret-token');

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/d/:slug/bridge', bridgeRouter);
  const server = createServer(app);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start test server');
  }
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const unknownRes = await fetch(`${base}/d/authslug/bridge/not-real`, { method: 'GET' });
    const unknownBody = await unknownRes.json() as {
      code?: string;
      supportedRoutes?: string[];
      hint?: string;
      requestedRoute?: string;
    };
    assert.equal(unknownRes.status, 404, 'Unknown routes should return 404');
    assert.equal(unknownBody.code, 'UNKNOWN_ROUTE', 'Unknown routes should include UNKNOWN_ROUTE code');
    assert.equal(unknownBody.requestedRoute, 'GET /not-real', 'Unknown route response should include requested route');
    assert(Array.isArray(unknownBody.supportedRoutes), 'Unknown route response should include supportedRoutes list');
    assert((unknownBody.supportedRoutes ?? []).includes('GET /state'), 'Unknown route response should include known routes');
    assert.match(String(unknownBody.hint), /supported bridge routes|Try/i, 'Unknown route response should include hint');

    const unauthorizedRes = await fetch(`${base}/d/authslug/bridge/marks/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markId: 'mark-1' }),
    });
    const unauthorizedBody = await unauthorizedRes.json() as {
      code?: string;
      acceptedHeaders?: string[];
      hint?: string;
      nextSteps?: string[];
    };
    assert.equal(unauthorizedRes.status, 401, 'Missing token on protected route should return 401');
    assert.equal(unauthorizedBody.code, 'UNAUTHORIZED', 'Missing token should return UNAUTHORIZED');
    assert(Array.isArray(unauthorizedBody.acceptedHeaders), 'Unauthorized response should document accepted headers');
    assert((unauthorizedBody.acceptedHeaders ?? []).some((line) => line.includes('x-bridge-token')),
      'Unauthorized response should mention x-bridge-token');
    assert.match(String(unauthorizedBody.hint), /bridge token/i, 'Unauthorized response should include token hint');
    assert((unauthorizedBody.nextSteps ?? []).length >= 2, 'Unauthorized response should include actionable next steps');

    const rewriteRes = await fetch(`${base}/d/authslug/bridge/rewrite`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bridge-token': 'secret-token',
      },
      body: JSON.stringify({}),
    });
    const rewriteBody = await rewriteRes.json() as {
      code?: string;
      hint?: string;
      route?: string;
      nextSteps?: string[];
    };
    assert.equal(rewriteRes.status, 400, 'Invalid rewrite payload should return 400');
    assert.equal(rewriteBody.code, 'VALIDATION_ERROR', 'Invalid rewrite payload should be VALIDATION_ERROR');
    assert.equal(rewriteBody.route, 'POST /rewrite', 'Rewrite validation should include route');
    assert.match(String(rewriteBody.hint), /content|changes/i, 'Rewrite validation should explain accepted payload shapes');
    assert((rewriteBody.nextSteps ?? []).length >= 2, 'Rewrite validation should include next steps');

    const stateFirst = await fetch(`${base}/d/ratelimit/bridge/state`, { method: 'GET' });
    const stateSecond = await fetch(`${base}/d/ratelimit/bridge/state`, { method: 'GET' });
    const stateThird = await fetch(`${base}/d/ratelimit/bridge/state`, { method: 'GET' });

    // ac-ok7 (2026-09-25): an unknown document answers 404 at once (no viewer fallback without a
    // stored document); the rate limit still counts those requests.
    assert.equal(stateFirst.status, 404, 'First state call on an unknown document is 404');
    assert.equal(stateSecond.status, 404, 'Second state call on an unknown document is 404');
    assert.equal(stateThird.status, 429, 'Third state call should hit rate limit');

    const rateBody = await stateThird.json() as {
      code?: string;
      retryAfterSeconds?: number;
      hint?: string;
    };
    assert.equal(rateBody.code, 'RATE_LIMITED', 'Rate-limited response should include RATE_LIMITED code');
    assert.equal(typeof rateBody.retryAfterSeconds, 'number', 'Rate-limited response should include retryAfterSeconds');
    assert.match(String(rateBody.hint), /retry/i, 'Rate-limited response should include retry guidance');

    console.log('bridge-router-errors.test.ts passed');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
