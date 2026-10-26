/**
 * clearYjsState resets documents.y_state_version to 0. The projection row
 * has to follow, without dropping quarantine metadata.
 */

import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SLUG = 'clear-yjs-projection-version';
const QUARANTINE_REASON = 'projection_guard_pathological_repeat';
const PROJECTION_UPDATED_AT = '2020-06-01T00:00:00.000Z';

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

async function run(): Promise<void> {
  const dbName = `proof-clear-yjs-version-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);

  const prevDatabasePath = process.env.DATABASE_PATH;
  const prevProofEnv = process.env.PROOF_ENV;
  const prevNodeEnv = process.env.NODE_ENV;
  const prevDbEnvInit = process.env.PROOF_DB_ENV_INIT;

  process.env.DATABASE_PATH = dbPath;
  process.env.PROOF_ENV = 'development';
  process.env.NODE_ENV = 'development';
  process.env.PROOF_DB_ENV_INIT = 'development';

  const db = await import('../../server/db.ts');

  try {
    db.createDocument(SLUG, '# Clear Yjs\n\nVersion should follow.', {}, 'Clear Yjs version');
    const sqlite = db.getDb();
    sqlite.prepare(`
      UPDATE documents
      SET y_state_version = ?
      WHERE slug = ?
    `).run(5, SLUG);
    sqlite.prepare(`
      UPDATE document_projections
      SET y_state_version = ?, health = 'quarantined', health_reason = ?, updated_at = ?
      WHERE document_slug = ?
    `).run(7, QUARANTINE_REASON, PROJECTION_UPDATED_AT, SLUG);

    const cleared = db.clearYjsState(SLUG);
    assert(typeof cleared.clearedUpdates === 'number', 'Expected clearYjsState to report cleared updates');

    const document = db.getDocumentBySlug(SLUG);
    const projection = db.getDocumentProjectionBySlug(SLUG);
    assert(document?.y_state_version === 0, `Expected documents.y_state_version 0, got ${String(document?.y_state_version)}`);
    assert(
      projection?.y_state_version === document?.y_state_version,
      `Expected projection y_state_version ${String(document?.y_state_version)} to match documents, got ${String(projection?.y_state_version)}`,
    );
    assert(projection?.health === 'quarantined', `Expected quarantine to survive clearYjsState, got ${String(projection?.health)}`);
    assert(
      projection?.health_reason === QUARANTINE_REASON,
      `Expected health_reason to stay ${QUARANTINE_REASON}, got ${String(projection?.health_reason)}`,
    );
    assert(
      projection?.updated_at === PROJECTION_UPDATED_AT,
      `Expected projection updated_at to stay ${PROJECTION_UPDATED_AT}, got ${String(projection?.updated_at)}`,
    );

    console.log('✓ clearYjsState keeps projection y_state_version aligned with documents');
  } finally {
    if (prevDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDatabasePath;
    if (prevProofEnv === undefined) delete process.env.PROOF_ENV;
    else process.env.PROOF_ENV = prevProofEnv;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevDbEnvInit === undefined) delete process.env.PROOF_DB_ENV_INIT;
    else process.env.PROOF_DB_ENV_INIT = prevDbEnvInit;
    cleanupDbArtifacts(dbPath);
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
