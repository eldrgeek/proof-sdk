// Regression: mixed markdown created via the HTTP create route should remain
// projection-fresh even when Milkdown normalizes list marker style (`-` -> `*`)
// and table formatting. Before the fix, this divergence could wedge reads into
// yjs_fallback and reject mutations with 409 PROJECTION_STALE.

import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function mustJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.31.2',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

async function run(): Promise<void> {
  const dbName = `proof-collab-list-marker-route-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);

  const prevDatabasePath = process.env.DATABASE_PATH;
  const prevProofEnv = process.env.PROOF_ENV;
  const prevNodeEnv = process.env.NODE_ENV;
  const prevDbEnvInit = process.env.PROOF_DB_ENV_INIT;

  process.env.DATABASE_PATH = dbPath;
  process.env.PROOF_ENV = 'development';
  process.env.NODE_ENV = 'development';
  delete process.env.PROOF_DB_ENV_INIT;

  const [{ apiRoutes }, { agentRoutes }] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/agent-routes.js'),
  ]);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRoutes);
  app.use('/api/agent', agentRoutes);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const httpBase = `http://127.0.0.1:${address.port}`;

  const markdown = [
    '# Projection Freshness',
    '',
    'Intro paragraph for suggestion target.',
    '',
    '- first bullet',
    '- second bullet',
    '',
    '---',
    '',
    '> quoted line',
    '>',
    '> continued quote',
    '',
    '    const indented = true;',
    '    console.log(indented);',
    '',
    '| Name | Value |',
    '| --- | --- |',
    '| alpha | one |',
    '| beta | two |',
    '',
  ].join('\n');

  try {
    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'list marker projection regression',
        markdown,
        marks: {},
      }),
    });
    const created = await mustJson<{ slug: string; ownerSecret: string }>(createRes, 'create');

    const stateRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
      },
    });
    const state = await mustJson<{
      readSource?: string;
      projectionFresh?: boolean;
      mutationReady?: boolean;
      markdown?: string;
      content?: string;
    }>(stateRes, 'state');
    const stateMarkdown = typeof state.markdown === 'string' ? state.markdown : (state.content ?? '');
    assert(stateMarkdown.includes('first bullet'), 'Expected state markdown to include list content');
    assert(stateMarkdown.includes('alpha'), 'Expected state markdown to include table content');
    assert(state.readSource === 'projection', `Expected readSource=projection, got ${String(state.readSource)}`);
    assert(state.projectionFresh === true, `Expected projectionFresh=true, got ${String(state.projectionFresh)}`);
    assert(state.mutationReady === true, `Expected mutationReady=true, got ${String(state.mutationReady)}`);

    const opsRes = await fetch(`${httpBase}/api/agent/${created.slug}/ops`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        type: 'suggestion.add',
        by: 'qa:list-marker',
        kind: 'replace',
        quote: 'Intro paragraph for suggestion target.',
        content: 'Intro paragraph for suggestion target (edited).',
      }),
    });
    const opsBodyText = await opsRes.text();
    assert(opsRes.ok, `Expected suggestion.add to succeed, got HTTP ${opsRes.status}: ${opsBodyText.slice(0, 400)}`);

    console.log('✓ list-marker + table create-route markdown stays projection-fresh and accepts suggestion.add');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));

    if (prevDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDatabasePath;

    if (prevProofEnv === undefined) delete process.env.PROOF_ENV;
    else process.env.PROOF_ENV = prevProofEnv;

    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;

    if (prevDbEnvInit === undefined) delete process.env.PROOF_DB_ENV_INIT;
    else process.env.PROOF_DB_ENV_INIT = prevDbEnvInit;

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
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
