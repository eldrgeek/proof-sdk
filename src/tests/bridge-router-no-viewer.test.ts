import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

async function run(): Promise<void> {
  const dbName = `proof-bridge-no-viewer-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  const prevDatabasePath = process.env.DATABASE_PATH;
  const prevProofDbEnvInit = process.env.PROOF_DB_ENV_INIT;
  process.env.DATABASE_PATH = dbPath;
  process.env.PROOF_DB_ENV_INIT = 'development';
  const { bridgeRouter } = await import('../../server/bridge');
  const db = await import('../../server/db');
  // ac-ok7 (2026-09-25): bridge routes need a credential and a stored document, so the no-viewer
  // path is reached by an owner request the server cannot complete itself (an unknown mark).
  db.createDocument('testslug', '# Test\n\nLine.', {}, 'Test', 'owner-1', 'owner-secret');

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
    const missing = await fetch(`${base}/d/nosuchdoc/bridge/state`, { method: 'GET' });
    assert.equal(missing.status, 404, 'An unknown document answers 404 without trying viewers');
    const res = await fetch(`${base}/d/testslug/bridge/marks/accept`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-token': 'owner-secret' }, body: JSON.stringify({ markId: 'no-such-mark' }) });
    const body = await res.json() as {
      code?: string;
      hint?: string;
      viewerUrl?: string;
      nextSteps?: string[];
    };

    assert.equal(res.status, 503, 'No-viewer request should return 503');
    assert.equal(body.code, 'NO_VIEWERS', 'Expected NO_VIEWERS code');
    assert.equal(
      body.viewerUrl,
      `${base}/d/testslug`,
      'Expected viewerUrl with direct open target'
    );
    assert.match(
      String(body.hint),
      /Open .* yourself .* ask the user .* retry/i,
      'Hint should explain both self-open and ask-user options'
    );
    assert(Array.isArray(body.nextSteps), 'Expected nextSteps array');
    assert((body.nextSteps ?? []).length >= 3, 'Expected multiple actionable next steps');

    console.log('bridge-router-no-viewer.test.ts passed');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    if (prevDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDatabasePath;
    if (prevProofDbEnvInit === undefined) delete process.env.PROOF_DB_ENV_INIT;
    else process.env.PROOF_DB_ENV_INIT = prevProofDbEnvInit;
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
  console.error(error);
  process.exit(1);
});
