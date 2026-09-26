import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

type ShareCreateResponse = {
  slug: string;
  ownerSecret: string;
};

type SnapshotBlock = {
  ref: string;
  markdown: string;
};

type AgentSnapshotResponse = {
  success: boolean;
  revision: number;
  blocks: SnapshotBlock[];
};

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.34.0',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

async function mustJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
  return JSON.parse(text) as T;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const idx = haystack.indexOf(needle, offset);
    if (idx < 0) return count;
    count += 1;
    offset = idx + needle.length;
  }
}

async function run(): Promise<void> {
  const dbName = `proof-agent-edit-v2-collab-regression-${Date.now()}-${randomUUID()}.db`;
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
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const httpBase = `http://127.0.0.1:${address.port}`;
  await collab.startCollabRuntimeEmbedded(address.port);

  try {
    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdown: '# Test Doc\n\nParagraph one.\n\nParagraph two.\n\nParagraph three.',
        title: 'edit-v2 collab duplication regression',
        marks: {},
      }),
    });
    const created = await mustJson<ShareCreateResponse>(createRes);

    const fetchSnapshot = async (): Promise<AgentSnapshotResponse> => {
      const snapshotRes = await fetch(`${httpBase}/api/agent/${created.slug}/snapshot`, {
        headers: {
          ...CLIENT_HEADERS,
          'x-share-token': created.ownerSecret,
        },
      });
      return mustJson<AgentSnapshotResponse>(snapshotRes);
    };

    const applyEditV2 = async (baseRevision: number, operations: Array<Record<string, unknown>>): Promise<AgentSnapshotResponse> => {
      const editRes = await fetch(`${httpBase}/api/agent/${created.slug}/edit/v2`, {
        method: 'POST',
        headers: {
          ...CLIENT_HEADERS,
          'Content-Type': 'application/json',
          'x-share-token': created.ownerSecret,
        },
        body: JSON.stringify({
          by: 'ai:regression',
          baseRevision,
          operations,
        }),
      });
      const body = await mustJson<{ success: boolean; snapshot: AgentSnapshotResponse }>(editRes);
      assert(body.success === true, 'Expected edit/v2 success');
      return body.snapshot;
    };

    const s1 = await fetchSnapshot();
    assert(s1.blocks.length === 4, `Expected baseline 4 blocks, got ${s1.blocks.length}`);

    const s2 = await applyEditV2(s1.revision, [
      { op: 'replace_block', ref: 'b2', block: { markdown: 'Paragraph one EDITED.' } },
    ]);
    assert(s2.revision === s1.revision + 1, `Expected revision +1 after replace_block (${s1.revision} -> ${s2.revision})`);
    assert(s2.blocks.length === 4, `Expected 4 blocks after replace_block, got ${s2.blocks.length}`);
    assert((s2.blocks[1]?.markdown || '').includes('Paragraph one EDITED.'), 'Expected b2 to be replaced');

    const s3 = await applyEditV2(s2.revision, [
      { op: 'delete_block', ref: 'b3' },
    ]);
    assert(s3.revision === s2.revision + 1, `Expected revision +1 after delete_block (${s2.revision} -> ${s3.revision})`);
    assert(s3.blocks.length === 3, `Expected 3 blocks after delete_block, got ${s3.blocks.length}`);

    const s4 = await applyEditV2(s3.revision, [
      { op: 'replace_range', fromRef: 'b2', toRef: 'b3', blocks: [{ markdown: 'Merged paragraph.' }] },
    ]);
    assert(s4.revision === s3.revision + 1, `Expected revision +1 after replace_range (${s3.revision} -> ${s4.revision})`);
    assert(s4.blocks.length === 2, `Expected 2 blocks after replace_range, got ${s4.blocks.length}`);

    const finalContent = s4.blocks.map((block) => block.markdown.trim()).join('\n');
    assert(countOccurrences(finalContent, '# Test Doc') === 1, 'Expected heading to appear once (no document duplication)');
    assert(countOccurrences(finalContent, 'Merged paragraph.') === 1, 'Expected merged paragraph to appear once');

    console.log('✓ edit/v2 structural ops do not duplicate document content in collab runtime');
  } finally {
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

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
