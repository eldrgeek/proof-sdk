/**
 * Startup backfill must not clear projection quarantine.
 *
 * backfillDocumentProjections() runs from initDatabase() on every DB open.
 * A quarantined row (health + health_reason + updated_at) has to survive that
 * open, and a document with no projection row still receives a healthy one.
 */

import { spawnSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const QUARANTINED_SLUG = 'restart-quarantined';
const MISSING_SLUG = 'restart-missing-projection';
const QUARANTINE_REASON = 'projection_guard_pathological_repeat';
const QUARANTINED_UPDATED_AT = '2020-06-01T00:00:00.000Z';
const DOCUMENT_UPDATED_AT = '2099-01-01T00:00:00.000Z';
const MISSING_MARKDOWN = '# Missing projection\n\nShould be backfilled healthy.';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function cleanupDbArtifacts(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // ignore cleanup errors
    }
  }
}

async function seedAndQuarantine(): Promise<void> {
  const db = await import('../../server/db.ts');
  db.createDocument(QUARANTINED_SLUG, '# Quarantined\n\nStay quarantined.', {}, 'Restart quarantine');
  db.createDocument(MISSING_SLUG, MISSING_MARKDOWN, {}, 'Restart missing');

  const marked = db.setDocumentProjectionHealth(QUARANTINED_SLUG, 'quarantined', QUARANTINE_REASON);
  assert(marked, 'Expected setDocumentProjectionHealth to quarantine the projection');

  const sqlite = db.getDb();
  sqlite.prepare(`
    UPDATE document_projections
    SET updated_at = ?
    WHERE document_slug = ?
  `).run(QUARANTINED_UPDATED_AT, QUARANTINED_SLUG);
  sqlite.prepare(`
    UPDATE documents
    SET updated_at = ?
    WHERE slug = ?
  `).run(DOCUMENT_UPDATED_AT, QUARANTINED_SLUG);
  sqlite.prepare(`
    DELETE FROM document_projections
    WHERE document_slug = ?
  `).run(MISSING_SLUG);

  const quarantined = db.getDocumentProjectionBySlug(QUARANTINED_SLUG);
  assert(quarantined?.health === 'quarantined', `Seed health was ${String(quarantined?.health)}`);
  assert(
    quarantined?.health_reason === QUARANTINE_REASON,
    `Seed reason was ${String(quarantined?.health_reason)}`,
  );
  assert(quarantined?.updated_at === QUARANTINED_UPDATED_AT, 'Seed updated_at was not applied');
  assert(
    db.getDocumentProjectionBySlug(MISSING_SLUG) === undefined,
    'Expected the missing-projection document to have no projection row before restart',
  );

  sqlite.pragma('wal_checkpoint(TRUNCATE)');
}

async function reopenAndAssert(): Promise<void> {
  const db = await import('../../server/db.ts');
  const quarantined = db.getDocumentProjectionBySlug(QUARANTINED_SLUG);
  assert(
    quarantined?.health === 'quarantined',
    `Expected quarantine to survive DB open, got ${String(quarantined?.health)}`,
  );
  assert(
    quarantined?.health_reason === QUARANTINE_REASON,
    `Expected health_reason to stay ${QUARANTINE_REASON}, got ${String(quarantined?.health_reason)}`,
  );
  assert(
    quarantined?.updated_at === QUARANTINED_UPDATED_AT,
    `Expected projection updated_at to stay ${QUARANTINED_UPDATED_AT}, got ${String(quarantined?.updated_at)}`,
  );

  const missing = db.getDocumentProjectionBySlug(MISSING_SLUG);
  assert(missing != null, 'Expected startup backfill to create a projection for the document that lacked one');
  assert(missing?.health === 'healthy', `Expected backfilled projection to be healthy, got ${String(missing?.health)}`);
  assert(
    missing?.health_reason == null,
    `Expected backfilled projection health_reason to be null, got ${String(missing?.health_reason)}`,
  );
  assert(
    missing?.markdown === MISSING_MARKDOWN,
    'Expected backfilled projection markdown to match the document',
  );
}

function runPhase(phase: 'seed' | 'verify', dbPath: string): void {
  const testFile = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(testFile), '../..');
  const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
  const result = spawnSync(tsxBin, [testFile], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PROJECTION_BACKFILL_PHASE: phase,
      DATABASE_PATH: dbPath,
      PROOF_ENV: 'development',
      NODE_ENV: 'development',
      PROOF_DB_ENV_INIT: 'development',
    },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    throw new Error(`projection backfill ${phase} phase exited ${result.status ?? 'null'}${output ? `\n${output}` : ''}`);
  }
}

async function run(): Promise<void> {
  const phase = process.env.PROJECTION_BACKFILL_PHASE;
  if (phase === 'seed') {
    await seedAndQuarantine();
    return;
  }
  if (phase === 'verify') {
    await reopenAndAssert();
    return;
  }

  const dbName = `proof-projection-backfill-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  try {
    runPhase('seed', dbPath);
    runPhase('verify', dbPath);
    console.log('✓ startup projection backfill preserves quarantine and inserts missing rows as healthy');
  } finally {
    cleanupDbArtifacts(dbPath);
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
