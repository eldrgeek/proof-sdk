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
const HEALTHY_SLUG = 'restart-healthy-stale-content';
const QUARANTINE_REASON = 'projection_guard_pathological_repeat';
const QUARANTINED_UPDATED_AT = '2020-06-01T00:00:00.000Z';
const DOCUMENT_UPDATED_AT = '2099-01-01T00:00:00.000Z';
const QUARANTINED_DOC_REVISION = 4;
const QUARANTINED_DOC_Y_STATE_VERSION = 9;
const QUARANTINED_STALE_MARKDOWN = '# Quarantined stale\n\nDo not replace.';
const QUARANTINED_STALE_MARKS = '{"note":"quarantine-stale"}';
const MISSING_DOC_REVISION = 3;
const MISSING_DOC_Y_STATE_VERSION = 8;
const MISSING_MARKDOWN = '# Missing projection\n\nShould be backfilled healthy.';
const HEALTHY_DOC_MARKDOWN = '# Healthy sync\n\nCurrent document body.';
const HEALTHY_DOC_MARKS = '{"note":"current"}';
const HEALTHY_STALE_MARKDOWN = '# Stale projection\n\nLagging body.';
const HEALTHY_STALE_MARKS = '{"note":"stale"}';
const HEALTHY_STALE_PLAIN = 'STALE PLAIN TEXT SENTINEL';
const HEALTHY_PROJECTION_UPDATED_AT = '2021-01-01T00:00:00.000Z';
const HEALTHY_DOC_REVISION = 6;
const HEALTHY_DOC_Y_STATE_VERSION = 11;
const HEALTHY_PLAIN_TEXT = 'Healthy sync Current document body.';

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
  db.createDocument(HEALTHY_SLUG, '# Healthy sync\n\nSeed body.', {}, 'Restart healthy');

  const marked = db.setDocumentProjectionHealth(QUARANTINED_SLUG, 'quarantined', QUARANTINE_REASON);
  assert(marked, 'Expected setDocumentProjectionHealth to quarantine the projection');

  const sqlite = db.getDb();
  sqlite.prepare(`
    UPDATE document_projections
    SET updated_at = ?, revision = ?, y_state_version = ?, markdown = ?, marks_json = ?, plain_text = ?
    WHERE document_slug = ?
  `).run(
    QUARANTINED_UPDATED_AT,
    1,
    2,
    QUARANTINED_STALE_MARKDOWN,
    QUARANTINED_STALE_MARKS,
    'quarantine stale plain',
    QUARANTINED_SLUG,
  );
  sqlite.prepare(`
    UPDATE documents
    SET markdown = ?, marks = ?, revision = ?, y_state_version = ?, updated_at = ?
    WHERE slug = ?
  `).run(
    HEALTHY_DOC_MARKDOWN,
    HEALTHY_DOC_MARKS,
    HEALTHY_DOC_REVISION,
    HEALTHY_DOC_Y_STATE_VERSION,
    DOCUMENT_UPDATED_AT,
    HEALTHY_SLUG,
  );
  sqlite.prepare(`
    UPDATE document_projections
    SET markdown = ?, marks_json = ?, plain_text = ?, revision = ?, y_state_version = ?,
        health = 'healthy', health_reason = NULL, updated_at = ?
    WHERE document_slug = ?
  `).run(
    HEALTHY_STALE_MARKDOWN,
    HEALTHY_STALE_MARKS,
    HEALTHY_STALE_PLAIN,
    2,
    3,
    HEALTHY_PROJECTION_UPDATED_AT,
    HEALTHY_SLUG,
  );
  sqlite.prepare(`
    UPDATE documents
    SET updated_at = ?, revision = ?, y_state_version = ?
    WHERE slug = ?
  `).run(DOCUMENT_UPDATED_AT, QUARANTINED_DOC_REVISION, QUARANTINED_DOC_Y_STATE_VERSION, QUARANTINED_SLUG);
  sqlite.prepare(`
    UPDATE documents
    SET revision = ?, y_state_version = ?
    WHERE slug = ?
  `).run(MISSING_DOC_REVISION, MISSING_DOC_Y_STATE_VERSION, MISSING_SLUG);
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
  assert(
    quarantined?.revision === QUARANTINED_DOC_REVISION,
    `Expected startup to sync projection revision to ${QUARANTINED_DOC_REVISION}, got ${String(quarantined?.revision)}`,
  );
  assert(
    quarantined?.y_state_version === QUARANTINED_DOC_Y_STATE_VERSION,
    `Expected startup to sync projection y_state_version to ${QUARANTINED_DOC_Y_STATE_VERSION}, got ${String(quarantined?.y_state_version)}`,
  );
  assert(
    quarantined?.markdown === QUARANTINED_STALE_MARKDOWN,
    'Expected quarantined projection markdown to stay versions-only',
  );
  assert(
    quarantined?.marks_json === QUARANTINED_STALE_MARKS,
    'Expected quarantined projection marks to stay versions-only',
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
  assert(
    missing?.revision === MISSING_DOC_REVISION,
    `Expected backfilled projection revision ${MISSING_DOC_REVISION}, got ${String(missing?.revision)}`,
  );
  assert(
    missing?.y_state_version === MISSING_DOC_Y_STATE_VERSION,
    `Expected backfilled projection y_state_version ${MISSING_DOC_Y_STATE_VERSION}, got ${String(missing?.y_state_version)}`,
  );

  const collab = await import('../../server/collab.ts');
  const healthyDocument = db.getDocumentBySlug(HEALTHY_SLUG);
  const healthy = db.getDocumentProjectionBySlug(HEALTHY_SLUG);
  assert(healthyDocument != null && healthy != null, 'Expected the healthy document and its projection after restart');
  assert(healthy.health === 'healthy', `Expected healthy projection to stay healthy, got ${healthy.health}`);
  assert(healthy.health_reason == null, `Expected healthy health_reason to stay null, got ${String(healthy.health_reason)}`);
  assert(
    healthy.updated_at === HEALTHY_PROJECTION_UPDATED_AT,
    `Expected healthy projection updated_at to stay ${HEALTHY_PROJECTION_UPDATED_AT}, got ${healthy.updated_at}`,
  );
  assert(healthy.markdown === healthyDocument.markdown, 'Expected startup to copy healthy projection markdown from the document');
  assert(healthy.markdown === HEALTHY_DOC_MARKDOWN, 'Expected healthy projection markdown to match the document body');
  assert(healthy.marks_json === healthyDocument.marks, 'Expected startup to copy healthy projection marks from the document');
  assert(healthy.marks_json === HEALTHY_DOC_MARKS, 'Expected healthy projection marks_json to match documents.marks');
  assert(
    healthy.plain_text === HEALTHY_PLAIN_TEXT,
    `Expected healthy plain_text ${HEALTHY_PLAIN_TEXT}, got ${healthy.plain_text}`,
  );
  assert(healthy.revision === HEALTHY_DOC_REVISION, `Expected healthy revision ${HEALTHY_DOC_REVISION}, got ${healthy.revision}`);
  assert(
    healthy.y_state_version === HEALTHY_DOC_Y_STATE_VERSION,
    `Expected healthy y_state_version ${HEALTHY_DOC_Y_STATE_VERSION}, got ${healthy.y_state_version}`,
  );
  const projected = db.getProjectedDocumentBySlug(HEALTHY_SLUG);
  assert(
    collab.isProjectionFresh(projected),
    'Expected the restarted healthy projection to be fresh once content matches the document',
  );
  assert(
    collab.isProjectionFresh(db.getProjectedDocumentBySlug(QUARANTINED_SLUG)) === false,
    'Expected the quarantined projection to stay not fresh',
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
    console.log('✓ startup projection backfill preserves quarantine, refreshes healthy content, and inserts missing rows as healthy');
  } finally {
    cleanupDbArtifacts(dbPath);
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
