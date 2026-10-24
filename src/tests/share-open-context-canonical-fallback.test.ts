import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import * as Y from 'yjs';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function mustJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.34.0',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

async function run(): Promise<void> {
  const dbName = `proof-share-open-context-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);

  const prevDatabasePath = process.env.DATABASE_PATH;
  const prevProofEnv = process.env.PROOF_ENV;
  const prevNodeEnv = process.env.NODE_ENV;
  const prevDbEnvInit = process.env.PROOF_DB_ENV_INIT;

  process.env.DATABASE_PATH = dbPath;
  process.env.PROOF_ENV = 'development';
  process.env.NODE_ENV = 'development';
  delete process.env.PROOF_DB_ENV_INIT;

  const [{ apiRoutes }, db] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/db.js'),
  ]);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRoutes);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const httpBase = `http://127.0.0.1:${address.port}`;

  try {
    const baseMarkdown = '# Share fallback\n\nBase paragraph.\n';
    const fallbackMarker = 'fallback-marker-visible';
    const canonicalMarkdown = `${baseMarkdown}\n${fallbackMarker}\n`;

    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'share open-context fallback',
        markdown: baseMarkdown,
        marks: {},
      }),
    });
    const created = await mustJson<{ slug: string; ownerSecret: string }>(createRes, 'create');

    const ydoc = new Y.Doc();
    ydoc.getText('markdown').insert(0, canonicalMarkdown);
    const snapshot = Y.encodeStateAsUpdate(ydoc);
    db.saveYSnapshot(created.slug, 1, snapshot);
    db.getDb().prepare(`
      UPDATE documents
      SET y_state_version = 1
      WHERE slug = ?
    `).run(created.slug);

    const docRes = await fetch(`${httpBase}/api/documents/${created.slug}`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
      },
    });
    const docPayload = await mustJson<{ markdown?: string }>(docRes, 'documents');
    assert(
      typeof docPayload.markdown === 'string' && docPayload.markdown.includes(fallbackMarker),
      'Expected /api/documents to serve canonical markdown from Yjs fallback when projection is stale',
    );

    const contextRes = await fetch(`${httpBase}/api/documents/${created.slug}/open-context`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
      },
    });
    const contextPayload = await mustJson<{ doc?: { markdown?: string } }>(contextRes, 'open-context');
    assert(
      typeof contextPayload.doc?.markdown === 'string' && contextPayload.doc.markdown.includes(fallbackMarker),
      'Expected /open-context to serve canonical markdown from Yjs fallback when projection is stale',
    );

    console.log('✓ share open-context and documents endpoints honor canonical fallback reads');
  } finally {
    server.close();
    if (prevDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDatabasePath;
    if (prevProofEnv === undefined) delete process.env.PROOF_ENV;
    else process.env.PROOF_ENV = prevProofEnv;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevDbEnvInit === undefined) delete process.env.PROOF_DB_ENV_INIT;
    else process.env.PROOF_DB_ENV_INIT = prevDbEnvInit;
    try {
      unlinkSync(dbPath);
    } catch {
      // ignore
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
