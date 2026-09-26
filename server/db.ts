import { documentAccessEvents } from './document-access-events.js';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import Database from 'better-sqlite3';
import path from 'path';
import type { ShareRole, ShareState } from './share-types.js';
import { fileURLToPath } from 'url';
import {
  getHeadlessMilkdownParser,
  parseMarkdownWithHtmlFallback,
  serializeSingleNode,
  summarizeParseError,
} from './milkdown-headless.js';
import { recordMutationBackfill, recordMutationIdempotencyDualRead } from './metrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let db: Database.Database;

const DEFAULT_EVENT_PAGE_SIZE = 100;
const DB_METADATA_TABLE = 'system_metadata';
const DB_ENV_METADATA_KEY = 'db_environment';
const GLOBAL_COLLAB_ADMISSION_GUARD_METADATA_KEY = 'collab.global_admission_guard';
const GLOBAL_COLLAB_ADMISSION_EPOCH_METADATA_KEY = 'collab.global_admission_epoch';
const MUTATION_IDEMPOTENCY_TABLE = 'mutation_idempotency';
const MUTATION_OUTBOX_TABLE = 'mutation_outbox';
const MARK_TOMBSTONES_TABLE = 'mark_tombstones';
const ACTIVE_COLLAB_CONNECTIONS_TABLE = 'active_collab_connections';
const MARK_TOMBSTONE_RETENTION_DAYS = 35;
const MUTATION_IDEMPOTENCY_BACKFILL_CURSOR_KEY = 'backfill.mutation_idempotency.last_rowid';
const MUTATION_OUTBOX_BACKFILL_CURSOR_KEY = 'backfill.mutation_outbox.last_event_id';
let warnedCrossEnvironmentOverride = false;
let metadataTableInitialized = false;
let idempotencyTableInitialized = false;
let documentEventsTableInitialized = false;
let mutationIdempotencyTableInitialized = false;
let mutationOutboxTableInitialized = false;
let markTombstonesTableInitialized = false;
let activeCollabConnectionsTableInitialized = false;
let lastActiveCollabConnectionPruneAt = 0;
const DEFAULT_ACTIVE_COLLAB_CONNECTION_TTL_MS = 45_000;
const DEFAULT_ACTIVE_COLLAB_CONNECTION_PRUNE_INTERVAL_MS = 10_000;
const DEFAULT_DOCUMENT_LIVE_COLLAB_LEASE_TTL_MS = 45_000;
const DEFAULT_MAX_YJS_UPDATE_BLOB_BYTES = 8 * 1024 * 1024;

export class OversizedYjsUpdateError extends Error {
  readonly slug: string;
  readonly bytes: number;
  readonly limitBytes: number;
  readonly sourceActor: string | null;

  constructor(slug: string, bytes: number, limitBytes: number, sourceActor: string | null) {
    super(`Oversized Yjs update blocked for ${slug}: ${bytes} bytes exceeds ${limitBytes} byte limit`);
    this.name = 'OversizedYjsUpdateError';
    this.slug = slug;
    this.bytes = bytes;
    this.limitBytes = limitBytes;
    this.sourceActor = sourceActor;
  }
}

function getMaxYjsUpdateBlobBytes(): number {
  return parsePositiveInt(process.env.COLLAB_MAX_UPDATE_BLOB_BYTES, DEFAULT_MAX_YJS_UPDATE_BLOB_BYTES);
}

function assertYjsUpdateWithinLimit(
  documentSlug: string,
  update: Uint8Array,
  sourceActor: string | null | undefined,
): void {
  const bytes = update.byteLength;
  const limitBytes = getMaxYjsUpdateBlobBytes();
  if (bytes <= limitBytes) return;
  throw new OversizedYjsUpdateError(documentSlug, bytes, limitBytes, sourceActor ?? null);
}

function normalizeEnvironment(value: string | null | undefined): string {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) return 'development';
  if (normalized === 'prod' || normalized === 'production') return 'production';
  if (normalized === 'dev' || normalized === 'development' || normalized === 'local') return 'development';
  if (normalized === 'stage' || normalized === 'staging') return 'staging';
  if (normalized === 'test' || normalized === 'testing') return 'test';
  return normalized;
}

function getRuntimeEnvironment(): string {
  return normalizeEnvironment(process.env.PROOF_ENV || process.env.NODE_ENV || 'development');
}

function isTruthyFlag(value: string | undefined): boolean {
  const normalized = (value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function isCrossEnvironmentWriteOverrideEnabled(): boolean {
  return isTruthyFlag(process.env.ALLOW_CROSS_ENV_WRITES);
}

function createMetadataTableIfNeeded(d: Database.Database): void {
  if (metadataTableInitialized) return;
  d.exec(`
    CREATE TABLE IF NOT EXISTS ${DB_METADATA_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  metadataTableInitialized = true;
}

function readMetadataValue(d: Database.Database, key: string): string | null {
  const row = d.prepare(`
    SELECT value
    FROM ${DB_METADATA_TABLE}
    WHERE key = ?
    LIMIT 1
  `).get(key) as { value?: string } | undefined;
  return typeof row?.value === 'string' && row.value.trim().length > 0
    ? row.value.trim()
    : null;
}

function writeMetadataValue(d: Database.Database, key: string, value: string): void {
  const now = new Date().toISOString();
  d.prepare(`
    INSERT OR REPLACE INTO ${DB_METADATA_TABLE} (key, value, updated_at)
    VALUES (?, ?, ?)
  `).run(key, value, now);
}

function readMetadataNumber(d: Database.Database, key: string, fallback: number = 0): number {
  const raw = readMetadataValue(d, key);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function writeMetadataNumber(d: Database.Database, key: string, value: number): void {
  const normalized = Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
  writeMetadataValue(d, key, String(normalized));
}

function hasAnyDocuments(d: Database.Database): boolean {
  const row = d.prepare(`
    SELECT 1 AS present
    FROM documents
    LIMIT 1
  `).get() as { present?: number } | undefined;
  return row?.present === 1;
}

function readOrInitializeDatabaseEnvironment(d: Database.Database): string {
  createMetadataTableIfNeeded(d);

  const existing = readMetadataValue(d, DB_ENV_METADATA_KEY);
  if (existing) return normalizeEnvironment(existing);

  const runtimeEnv = getRuntimeEnvironment();
  const explicitInitEnvRaw = (process.env.PROOF_DB_ENV_INIT || '').trim();
  const explicitInitEnv = explicitInitEnvRaw ? normalizeEnvironment(explicitInitEnvRaw) : '';
  if (explicitInitEnv) {
    writeMetadataValue(d, DB_ENV_METADATA_KEY, explicitInitEnv);
    return explicitInitEnv;
  }

  if (runtimeEnv === 'production') {
    writeMetadataValue(d, DB_ENV_METADATA_KEY, runtimeEnv);
    return runtimeEnv;
  }

  if (!hasAnyDocuments(d)) {
    writeMetadataValue(d, DB_ENV_METADATA_KEY, runtimeEnv);
    return runtimeEnv;
  }

  if (isCrossEnvironmentWriteOverrideEnabled()) {
    console.warn('[db] Existing DB missing environment label; inferring from runtime due to ALLOW_CROSS_ENV_WRITES override', {
      runtimeEnv,
    });
    writeMetadataValue(d, DB_ENV_METADATA_KEY, runtimeEnv);
    return runtimeEnv;
  }

  throw new Error(
    `[db] Existing database is missing ${DB_ENV_METADATA_KEY} metadata. `
      + `Refusing to infer label for runtime "${runtimeEnv}". `
      + `Set PROOF_DB_ENV_INIT once (for example: development).`,
  );
}

function assertDatabaseEnvironmentCompatibility(context: 'startup' | 'write', operation?: string): void {
  const d = getDb();
  const runtimeEnv = getRuntimeEnvironment();
  const dbEnv = readOrInitializeDatabaseEnvironment(d);
  if (runtimeEnv === dbEnv) return;

  if (isCrossEnvironmentWriteOverrideEnabled()) {
    if (!warnedCrossEnvironmentOverride) {
      warnedCrossEnvironmentOverride = true;
      console.warn('[db] Cross-environment write override enabled; proceeding unsafely', {
        context,
        operation: operation ?? null,
        runtimeEnv,
        dbEnv,
      });
    }
    return;
  }

  const operationPart = operation ? ` operation="${operation}"` : '';
  throw new Error(
    `[db] ${context} blocked due to environment mismatch:${operationPart} `
      + `runtime="${runtimeEnv}" database="${dbEnv}". `
      + 'Set ALLOW_CROSS_ENV_WRITES=1 to override (unsafe).',
  );
}

export function assertWritesAllowed(operation: string): void {
  assertDatabaseEnvironmentCompatibility('write', operation);
}

export interface DocumentRow {
  slug: string;
  doc_id: string | null;
  title: string | null;
  markdown: string;
  marks: string;
  revision: number;
  y_state_version: number;
  share_state: ShareState;
  access_epoch: number;
  collab_bootstrap_epoch: number;
  live_collab_seen_at: string | null;
  live_collab_access_epoch: number | null;
  active: number;
  owner_id: string | null;
  owner_secret: string | null;
  owner_secret_hash: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface DocumentProjectionRow {
  document_slug: string;
  revision: number;
  y_state_version: number;
  markdown: string;
  marks_json: string;
  plain_text: string;
  updated_at: string;
  health: 'healthy' | 'projection_stale' | 'quarantined';
  health_reason: string | null;
}

export interface ProjectedDocumentRow extends DocumentRow {
  plain_text: string;
  projection_health: 'healthy' | 'projection_stale' | 'quarantined';
  projection_health_reason: string | null;
  projection_revision: number | null;
  projection_y_state_version: number | null;
  projection_updated_at: string | null;
  canonical_markdown: string;
  canonical_marks: string;
}

export interface DocumentAuthStateRow {
  slug: string;
  doc_id: string | null;
  share_state: ShareState;
  access_epoch: number;
  owner_id: string | null;
  owner_secret: string | null;
  owner_secret_hash: string | null;
}

export interface DocumentBlockRow {
  document_id: string;
  block_id: string;
  ordinal: number;
  node_type: string;
  attrs_json: string;
  markdown_hash: string;
  text_preview: string;
  created_revision: number;
  last_seen_revision: number;
  retired_revision: number | null;
}

export interface DocumentAccessRow {
  token_id: string;
  document_slug: string;
  role: ShareRole;
  secret_hash: string;
  created_at: string;
  revoked_at: string | null;
}

export interface PersistedGlobalCollabAdmissionGuardEntry {
  reason: string;
  untilMs: number;
  triggeredAt: number;
  lastTriggeredAt: number;
  count: number;
  details?: Record<string, unknown>;
}

export function getGlobalCollabAdmissionEpoch(): number {
  const d = getDb();
  createMetadataTableIfNeeded(d);
  return readMetadataNumber(d, GLOBAL_COLLAB_ADMISSION_EPOCH_METADATA_KEY, 0);
}

export function bumpGlobalCollabAdmissionEpoch(): number {
  assertWritesAllowed('bumpGlobalCollabAdmissionEpoch');
  const d = getDb();
  createMetadataTableIfNeeded(d);
  const nextEpoch = readMetadataNumber(d, GLOBAL_COLLAB_ADMISSION_EPOCH_METADATA_KEY, 0) + 1;
  writeMetadataNumber(d, GLOBAL_COLLAB_ADMISSION_EPOCH_METADATA_KEY, nextEpoch);
  return nextEpoch;
}

function parsePersistedGlobalCollabAdmissionGuard(
  raw: string | null,
): PersistedGlobalCollabAdmissionGuardEntry | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (typeof parsed.reason !== 'string' || parsed.reason.trim().length === 0) return null;
    const untilMs = Number(parsed.untilMs);
    const triggeredAt = Number(parsed.triggeredAt);
    const lastTriggeredAt = Number(parsed.lastTriggeredAt);
    const count = Number(parsed.count);
    if (!Number.isFinite(untilMs) || untilMs <= 0) return null;
    if (!Number.isFinite(triggeredAt) || triggeredAt <= 0) return null;
    if (!Number.isFinite(lastTriggeredAt) || lastTriggeredAt <= 0) return null;
    if (!Number.isFinite(count) || count <= 0) return null;
    const details = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
      ? parsed.details as Record<string, unknown>
      : undefined;
    return {
      reason: parsed.reason.trim(),
      untilMs: Math.trunc(untilMs),
      triggeredAt: Math.trunc(triggeredAt),
      lastTriggeredAt: Math.trunc(lastTriggeredAt),
      count: Math.trunc(count),
      ...(details ? { details } : {}),
    };
  } catch {
    return null;
  }
}

export interface DocumentEventRow {
  id: number;
  document_slug: string;
  document_revision: number | null;
  event_type: string;
  event_data: string;
  actor: string;
  idempotency_key: string | null;
  mutation_route: string | null;
  tombstone_revision: number | null;
  created_at: string;
  acked_by: string | null;
  acked_at: string | null;
}

export interface ServerIncidentEventRow {
  id: number;
  request_id: string | null;
  slug: string | null;
  subsystem: string;
  level: 'info' | 'warn' | 'error';
  event_type: string;
  message: string;
  data_json: string;
  created_at: string;
}

export type MutationIdempotencyState = 'pending' | 'completed';

export type MutationIdempotencyRecord = {
  state: MutationIdempotencyState;
  response: Record<string, unknown> | null;
  requestHash: string | null;
  statusCode: number | null;
  tombstoneRevision: number | null;
  createdAt: string;
  completedAt: string | null;
  leaseExpiresAt: string | null;
  lastSeenAt: string | null;
};

export interface ServerIncidentEventInput {
  timestamp?: string;
  requestId?: string | null;
  slug?: string | null;
  subsystem: string;
  level: 'info' | 'warn' | 'error';
  eventType: string;
  message: string;
  data?: Record<string, unknown> | null;
}

export interface MutationOutboxRow {
  id: number;
  document_slug: string;
  document_revision: number | null;
  event_id: number | null;
  event_type: string;
  event_data: string;
  actor: string;
  idempotency_key: string | null;
  mutation_route: string | null;
  tombstone_revision: number | null;
  created_at: string;
  delivered_at: string | null;
}

export interface MarkTombstoneRow {
  document_slug: string;
  mark_id: string;
  status: 'accepted' | 'rejected' | 'resolved';
  resolved_revision: number;
  created_at: string;
  expires_at: string;
}

export interface DocumentYUpdateMetaRow {
  seq: number;
  source_actor: string | null;
  created_at: string;
}

export interface DocumentYUpdateRow extends DocumentYUpdateMetaRow {
  update: Uint8Array;
}

export interface DocumentYSnapshotRow {
  version: number;
  snapshot: Uint8Array;
  created_at: string;
}

export interface ShareAuthSessionRow {
  session_token_hash: string;
  provider: string;
  every_user_id: number;
  email: string;
  name: string | null;
  subscriber: number;
  access_token: string;
  refresh_token: string | null;
  access_expires_at: string;
  session_expires_at: string;
  last_verified_at: string;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActiveCollabConnectionRow {
  connection_id: string;
  document_slug: string;
  role: ShareRole;
  access_epoch: number;
  instance_id: string;
  connected_at: string;
  last_seen_at: string;
}

export interface ActiveCollabConnectionInput {
  connectionId: string;
  slug: string;
  role: ShareRole;
  accessEpoch: number;
  instanceId: string;
  observedAt?: string;
}

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'proof-share.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    // Favor availability over full fsync durability for sync writes.
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    initDatabase();
  }
  return db;
}

export function getDatabaseEnvironment(): string {
  return readOrInitializeDatabaseEnvironment(getDb());
}

export function assertDatabaseEnvironmentSafeForRuntime(): void {
  assertDatabaseEnvironmentCompatibility('startup');
}

export function getPersistedGlobalCollabAdmissionGuard(): PersistedGlobalCollabAdmissionGuardEntry | null {
  const d = getDb();
  createMetadataTableIfNeeded(d);
  return parsePersistedGlobalCollabAdmissionGuard(
    readMetadataValue(d, GLOBAL_COLLAB_ADMISSION_GUARD_METADATA_KEY),
  );
}

export function upsertPersistedGlobalCollabAdmissionGuard(
  entry: PersistedGlobalCollabAdmissionGuardEntry,
): PersistedGlobalCollabAdmissionGuardEntry {
  assertWritesAllowed('upsertPersistedGlobalCollabAdmissionGuard');
  const d = getDb();
  createMetadataTableIfNeeded(d);
  writeMetadataValue(d, GLOBAL_COLLAB_ADMISSION_GUARD_METADATA_KEY, JSON.stringify({
    reason: entry.reason,
    untilMs: Math.trunc(entry.untilMs),
    triggeredAt: Math.trunc(entry.triggeredAt),
    lastTriggeredAt: Math.trunc(entry.lastTriggeredAt),
    count: Math.trunc(entry.count),
    details: entry.details ?? {},
  }));
  return getPersistedGlobalCollabAdmissionGuard() as PersistedGlobalCollabAdmissionGuardEntry;
}

export function clearPersistedGlobalCollabAdmissionGuard(): void {
  assertWritesAllowed('clearPersistedGlobalCollabAdmissionGuard');
  const d = getDb();
  createMetadataTableIfNeeded(d);
  d.prepare(`
    DELETE FROM ${DB_METADATA_TABLE}
    WHERE key = ?
  `).run(GLOBAL_COLLAB_ADMISSION_GUARD_METADATA_KEY);
}

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashOpaqueToken(value: string): string {
  return hashSecret(value);
}

function timingSafeEqualString(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeProjectionPlainText(markdown: string): string {
  return (markdown ?? '')
    .replace(/<\/?(?:p|br|div|li|ul|ol|blockquote|h[1-6])\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function upsertDocumentProjectionRow(
  slug: string,
  markdown: string,
  marks: string,
  revision: number,
  yStateVersion: number,
  updatedAt: string,
  health: DocumentProjectionRow['health'] = 'healthy',
  healthReason: string | null = null,
): void {
  getDb().prepare(`
    INSERT INTO document_projections (
      document_slug,
      revision,
      y_state_version,
      markdown,
      marks_json,
      plain_text,
      updated_at,
      health,
      health_reason
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(document_slug) DO UPDATE SET
      revision = excluded.revision,
      y_state_version = excluded.y_state_version,
      markdown = excluded.markdown,
      marks_json = excluded.marks_json,
      plain_text = excluded.plain_text,
      updated_at = excluded.updated_at,
      health = excluded.health,
      health_reason = excluded.health_reason
  `).run(
    slug,
    revision,
    yStateVersion,
    markdown,
    marks,
    normalizeProjectionPlainText(markdown),
    updatedAt,
    health,
    health === 'quarantined' ? healthReason : null,
  );
}

function addMissingDocumentProjectionColumns(): void {
  const d = getDb();
  const columns = d.prepare('PRAGMA table_info(document_projections)').all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('health_reason')) {
    d.exec('ALTER TABLE document_projections ADD COLUMN health_reason TEXT');
  }
}

function backfillDocumentProjections(): void {
  const d = getDb();
  const rows = d.prepare(`
    SELECT slug, markdown, marks, revision, y_state_version, updated_at
    FROM documents
    WHERE share_state != 'DELETED'
  `).all() as Array<{
    slug: string;
    markdown: string;
    marks: string;
    revision: number | null;
    y_state_version: number | null;
    updated_at: string;
  }>;

  const tx = d.transaction(() => {
    for (const row of rows) {
      upsertDocumentProjectionRow(
        row.slug,
        row.markdown ?? '',
        row.marks ?? '{}',
        typeof row.revision === 'number' ? row.revision : 1,
        typeof row.y_state_version === 'number' ? row.y_state_version : 0,
        row.updated_at,
      );
    }
  });
  tx();
}

function getDocumentRevisionForSlug(d: Database.Database, slug: string): number | null {
  const row = d.prepare(`
    SELECT revision
    FROM documents
    WHERE slug = ?
    LIMIT 1
  `).get(slug) as { revision?: number } | undefined;
  return typeof row?.revision === 'number' ? row.revision : null;
}

function addMissingDocumentColumns(): void {
  const d = getDb();
  const columns = d.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));

  if (!names.has('doc_id')) {
    d.exec('ALTER TABLE documents ADD COLUMN doc_id TEXT');
  }
  if (!names.has('share_state')) {
    d.exec('ALTER TABLE documents ADD COLUMN share_state TEXT NOT NULL DEFAULT \'ACTIVE\'');
  }
  if (!names.has('access_epoch')) {
    d.exec('ALTER TABLE documents ADD COLUMN access_epoch INTEGER NOT NULL DEFAULT 0');
  }
  if (!names.has('collab_bootstrap_epoch')) {
    d.exec('ALTER TABLE documents ADD COLUMN collab_bootstrap_epoch INTEGER NOT NULL DEFAULT 0');
  }
  if (!names.has('live_collab_seen_at')) {
    d.exec('ALTER TABLE documents ADD COLUMN live_collab_seen_at TEXT');
  }
  if (!names.has('live_collab_access_epoch')) {
    d.exec('ALTER TABLE documents ADD COLUMN live_collab_access_epoch INTEGER');
  }
  if (!names.has('deleted_at')) {
    d.exec('ALTER TABLE documents ADD COLUMN deleted_at TEXT');
  }
  if (!names.has('owner_secret_hash')) {
    d.exec('ALTER TABLE documents ADD COLUMN owner_secret_hash TEXT');
  }
  if (!names.has('revision')) {
    d.exec('ALTER TABLE documents ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
  }
  if (!names.has('y_state_version')) {
    d.exec('ALTER TABLE documents ADD COLUMN y_state_version INTEGER NOT NULL DEFAULT 0');
  }
  if (!names.has('y_state_blob')) {
    d.exec('ALTER TABLE documents ADD COLUMN y_state_blob BLOB');
  }
}

function addMissingIdempotencyColumns(): void {
  if (idempotencyTableInitialized) return;
  const d = getDb();
  const columns = d.prepare('PRAGMA table_info(idempotency_keys)').all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('request_hash')) {
    d.exec('ALTER TABLE idempotency_keys ADD COLUMN request_hash TEXT');
  }
  idempotencyTableInitialized = true;
}

function addMissingDocumentEventColumns(): void {
  if (documentEventsTableInitialized) return;
  const d = getDb();
  const columns = d.prepare('PRAGMA table_info(document_events)').all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('document_revision')) {
    d.exec('ALTER TABLE document_events ADD COLUMN document_revision INTEGER');
  }
  if (!names.has('tombstone_revision')) {
    d.exec('ALTER TABLE document_events ADD COLUMN tombstone_revision INTEGER');
  }
  if (!names.has('mutation_route')) {
    d.exec('ALTER TABLE document_events ADD COLUMN mutation_route TEXT');
  }
  documentEventsTableInitialized = true;
}

function addMissingMutationIdempotencyColumns(): void {
  if (mutationIdempotencyTableInitialized) return;
  const d = getDb();
  const columns = d.prepare(`PRAGMA table_info(${MUTATION_IDEMPOTENCY_TABLE})`).all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('request_hash')) {
    d.exec(`ALTER TABLE ${MUTATION_IDEMPOTENCY_TABLE} ADD COLUMN request_hash TEXT`);
  }
  if (!names.has('status_code')) {
    d.exec(`ALTER TABLE ${MUTATION_IDEMPOTENCY_TABLE} ADD COLUMN status_code INTEGER NOT NULL DEFAULT 200`);
  }
  if (!names.has('tombstone_revision')) {
    d.exec(`ALTER TABLE ${MUTATION_IDEMPOTENCY_TABLE} ADD COLUMN tombstone_revision INTEGER`);
  }
  if (!names.has('state')) {
    d.exec(`ALTER TABLE ${MUTATION_IDEMPOTENCY_TABLE} ADD COLUMN state TEXT NOT NULL DEFAULT 'completed'`);
  }
  if (!names.has('completed_at')) {
    d.exec(`ALTER TABLE ${MUTATION_IDEMPOTENCY_TABLE} ADD COLUMN completed_at TEXT`);
  }
  if (!names.has('lease_expires_at')) {
    d.exec(`ALTER TABLE ${MUTATION_IDEMPOTENCY_TABLE} ADD COLUMN lease_expires_at TEXT`);
  }
  if (!names.has('last_seen_at')) {
    d.exec(`ALTER TABLE ${MUTATION_IDEMPOTENCY_TABLE} ADD COLUMN last_seen_at TEXT`);
  }
  if (!names.has('reservation_token')) {
    d.exec(`ALTER TABLE ${MUTATION_IDEMPOTENCY_TABLE} ADD COLUMN reservation_token TEXT`);
  }
  d.prepare(`
    UPDATE ${MUTATION_IDEMPOTENCY_TABLE}
    SET state = 'completed'
    WHERE state IS NULL OR TRIM(state) = ''
  `).run();
  d.prepare(`
    UPDATE ${MUTATION_IDEMPOTENCY_TABLE}
    SET completed_at = created_at
    WHERE state = 'completed' AND completed_at IS NULL
  `).run();
  d.prepare(`
    UPDATE ${MUTATION_IDEMPOTENCY_TABLE}
    SET last_seen_at = COALESCE(last_seen_at, completed_at, created_at)
    WHERE last_seen_at IS NULL
  `).run();
  mutationIdempotencyTableInitialized = true;
}

function addMissingMutationOutboxColumns(): void {
  if (mutationOutboxTableInitialized) return;
  const d = getDb();
  const columns = d.prepare(`PRAGMA table_info(${MUTATION_OUTBOX_TABLE})`).all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('document_revision')) {
    d.exec(`ALTER TABLE ${MUTATION_OUTBOX_TABLE} ADD COLUMN document_revision INTEGER`);
  }
  if (!names.has('event_id')) {
    d.exec(`ALTER TABLE ${MUTATION_OUTBOX_TABLE} ADD COLUMN event_id INTEGER`);
  }
  if (!names.has('idempotency_key')) {
    d.exec(`ALTER TABLE ${MUTATION_OUTBOX_TABLE} ADD COLUMN idempotency_key TEXT`);
  }
  if (!names.has('tombstone_revision')) {
    d.exec(`ALTER TABLE ${MUTATION_OUTBOX_TABLE} ADD COLUMN tombstone_revision INTEGER`);
  }
  if (!names.has('delivered_at')) {
    d.exec(`ALTER TABLE ${MUTATION_OUTBOX_TABLE} ADD COLUMN delivered_at TEXT`);
  }
  if (!names.has('mutation_route')) {
    d.exec(`ALTER TABLE ${MUTATION_OUTBOX_TABLE} ADD COLUMN mutation_route TEXT`);
  }
  d.prepare(`
    UPDATE ${MUTATION_OUTBOX_TABLE}
    SET mutation_route = (
      SELECT document_events.mutation_route
      FROM document_events
      WHERE document_events.id = ${MUTATION_OUTBOX_TABLE}.event_id
      LIMIT 1
    )
    WHERE mutation_route IS NULL AND event_id IS NOT NULL
  `).run();
  mutationOutboxTableInitialized = true;
}

function backfillLegacyMutationRouteMetadata(filters?: {
  documentSlug?: string;
  idempotencyKey?: string;
}): void {
  const d = getDb();
  const clauses = ['mutation_route IS NULL', 'idempotency_key IS NOT NULL'];
  const params: Array<string> = [];
  if (typeof filters?.documentSlug === 'string' && filters.documentSlug.trim()) {
    clauses.push('document_slug = ?');
    params.push(filters.documentSlug);
  }
  if (typeof filters?.idempotencyKey === 'string' && filters.idempotencyKey.trim()) {
    clauses.push('idempotency_key = ?');
    params.push(filters.idempotencyKey);
  }
  const whereClause = clauses.join(' AND ');

  d.prepare(`
    UPDATE document_events
    SET mutation_route = (
      SELECT CASE WHEN COUNT(DISTINCT route) = 1 THEN MIN(route) ELSE NULL END
      FROM (
        SELECT route
        FROM ${MUTATION_IDEMPOTENCY_TABLE}
        WHERE document_slug = document_events.document_slug
          AND idempotency_key = document_events.idempotency_key
          AND route IS NOT NULL
        UNION ALL
        SELECT route
        FROM idempotency_keys
        WHERE document_slug = document_events.document_slug
          AND idempotency_key = document_events.idempotency_key
          AND route IS NOT NULL
      ) inferred_routes
    )
    WHERE ${whereClause}
      AND (
        SELECT COUNT(DISTINCT route)
        FROM (
          SELECT route
          FROM ${MUTATION_IDEMPOTENCY_TABLE}
          WHERE document_slug = document_events.document_slug
            AND idempotency_key = document_events.idempotency_key
            AND route IS NOT NULL
          UNION ALL
          SELECT route
          FROM idempotency_keys
          WHERE document_slug = document_events.document_slug
            AND idempotency_key = document_events.idempotency_key
            AND route IS NOT NULL
        ) inferred_routes
      ) = 1
  `).run(...params);

  d.prepare(`
    UPDATE ${MUTATION_OUTBOX_TABLE}
    SET mutation_route = COALESCE(
      (
        SELECT document_events.mutation_route
        FROM document_events
        WHERE document_events.id = ${MUTATION_OUTBOX_TABLE}.event_id
          AND document_events.mutation_route IS NOT NULL
        LIMIT 1
      ),
      (
        SELECT CASE WHEN COUNT(DISTINCT route) = 1 THEN MIN(route) ELSE NULL END
        FROM (
          SELECT route
          FROM ${MUTATION_IDEMPOTENCY_TABLE}
          WHERE document_slug = ${MUTATION_OUTBOX_TABLE}.document_slug
            AND idempotency_key = ${MUTATION_OUTBOX_TABLE}.idempotency_key
            AND route IS NOT NULL
          UNION ALL
          SELECT route
          FROM idempotency_keys
          WHERE document_slug = ${MUTATION_OUTBOX_TABLE}.document_slug
            AND idempotency_key = ${MUTATION_OUTBOX_TABLE}.idempotency_key
            AND route IS NOT NULL
        ) inferred_routes
      )
    )
    WHERE ${whereClause}
      AND COALESCE(
        (
          SELECT document_events.mutation_route
          FROM document_events
          WHERE document_events.id = ${MUTATION_OUTBOX_TABLE}.event_id
            AND document_events.mutation_route IS NOT NULL
          LIMIT 1
        ),
        (
          SELECT CASE WHEN COUNT(DISTINCT route) = 1 THEN MIN(route) ELSE NULL END
          FROM (
            SELECT route
            FROM ${MUTATION_IDEMPOTENCY_TABLE}
            WHERE document_slug = ${MUTATION_OUTBOX_TABLE}.document_slug
              AND idempotency_key = ${MUTATION_OUTBOX_TABLE}.idempotency_key
              AND route IS NOT NULL
            UNION ALL
            SELECT route
            FROM idempotency_keys
            WHERE document_slug = ${MUTATION_OUTBOX_TABLE}.document_slug
              AND idempotency_key = ${MUTATION_OUTBOX_TABLE}.idempotency_key
              AND route IS NOT NULL
          ) inferred_routes
        )
      ) IS NOT NULL
  `).run(...params);
}

function addMissingMarkTombstoneColumns(): void {
  if (markTombstonesTableInitialized) return;
  const d = getDb();
  const columns = d.prepare(`PRAGMA table_info(${MARK_TOMBSTONES_TABLE})`).all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('status')) {
    d.exec(`ALTER TABLE ${MARK_TOMBSTONES_TABLE} ADD COLUMN status TEXT NOT NULL DEFAULT 'resolved'`);
  }
  if (!names.has('resolved_revision')) {
    d.exec(`ALTER TABLE ${MARK_TOMBSTONES_TABLE} ADD COLUMN resolved_revision INTEGER NOT NULL DEFAULT 0`);
  }
  if (!names.has('expires_at')) {
    d.exec(`ALTER TABLE ${MARK_TOMBSTONES_TABLE} ADD COLUMN expires_at TEXT`);
    const ttlDays = parsePositiveInt(process.env.MARK_TOMBSTONE_RETENTION_DAYS, MARK_TOMBSTONE_RETENTION_DAYS);
    d.prepare(`
      UPDATE ${MARK_TOMBSTONES_TABLE}
      SET expires_at = datetime(created_at, ?)
      WHERE expires_at IS NULL
    `).run(`+${ttlDays} days`);
  }
  markTombstonesTableInitialized = true;
}

function backfillDocumentColumns(): void {
  const d = getDb();
  const rows = d.prepare(`
    SELECT slug, doc_id, active, share_state, owner_secret, owner_secret_hash, revision, y_state_version
    FROM documents
  `).all() as Array<{
    slug: string;
    doc_id: string | null;
    active: number;
    share_state: string | null;
    owner_secret: string | null;
    owner_secret_hash: string | null;
    revision: number | null;
    y_state_version: number | null;
  }>;

  const setDocId = d.prepare('UPDATE documents SET doc_id = ? WHERE slug = ?');
  const setShareState = d.prepare('UPDATE documents SET share_state = ? WHERE slug = ?');
  const setOwnerSecretHash = d.prepare('UPDATE documents SET owner_secret_hash = ? WHERE slug = ?');
  const setRevision = d.prepare('UPDATE documents SET revision = ? WHERE slug = ?');
  const setYStateVersion = d.prepare('UPDATE documents SET y_state_version = ? WHERE slug = ?');
  const clearLegacyOwnerSecret = d.prepare(`
    UPDATE documents
    SET owner_secret = NULL
    WHERE owner_secret_hash IS NOT NULL AND owner_secret IS NOT NULL
  `);

  for (const row of rows) {
    if (!row.doc_id) {
      setDocId.run(randomUUID(), row.slug);
    }
    const shareStateMissing = !row.share_state || row.share_state.trim().length === 0;
    const legacyInactiveMismatch = row.active === 0 && row.share_state === 'ACTIVE';
    if (shareStateMissing || legacyInactiveMismatch) {
      setShareState.run(row.active === 1 ? 'ACTIVE' : 'PAUSED', row.slug);
    }
    if (!row.owner_secret_hash && row.owner_secret) {
      setOwnerSecretHash.run(hashSecret(row.owner_secret), row.slug);
    }
    if (row.revision == null) {
      setRevision.run(1, row.slug);
    }
    if (row.y_state_version == null) {
      setYStateVersion.run(0, row.slug);
    }
  }
  clearLegacyOwnerSecret.run();
}

function initDatabase(): void {
  const d = db;

  d.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      slug TEXT PRIMARY KEY,
      doc_id TEXT UNIQUE,
      title TEXT,
      markdown TEXT NOT NULL,
      marks TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      y_state_version INTEGER NOT NULL DEFAULT 0,
      share_state TEXT NOT NULL DEFAULT 'ACTIVE',
      access_epoch INTEGER NOT NULL DEFAULT 0,
      collab_bootstrap_epoch INTEGER NOT NULL DEFAULT 0,
      live_collab_seen_at TEXT,
      live_collab_access_epoch INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      owner_id TEXT,
      owner_secret TEXT,
      owner_secret_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);

  createMetadataTableIfNeeded(d);
  assertDatabaseEnvironmentCompatibility('startup');

  addMissingDocumentColumns();
  backfillDocumentColumns();

  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_doc_id ON documents(doc_id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_documents_share_state ON documents(share_state)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_documents_slug_revision ON documents(slug, revision)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_documents_owner_id ON documents(owner_id)');

  d.exec(`
    CREATE TABLE IF NOT EXISTS document_projections (
      document_slug TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      y_state_version INTEGER NOT NULL DEFAULT 0,
      markdown TEXT NOT NULL,
      marks_json TEXT NOT NULL DEFAULT '{}',
      plain_text TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      health TEXT NOT NULL DEFAULT 'healthy',
      health_reason TEXT,
      FOREIGN KEY (document_slug) REFERENCES documents(slug)
    )
  `);
  addMissingDocumentProjectionColumns();
  d.exec('CREATE INDEX IF NOT EXISTS idx_document_projections_revision ON document_projections(document_slug, revision)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_document_projections_health ON document_projections(health, updated_at)');
  backfillDocumentProjections();

  d.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_slug TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_data TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (document_slug) REFERENCES documents(slug)
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS document_access (
      token_id TEXT PRIMARY KEY,
      document_slug TEXT NOT NULL,
      role TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY (document_slug) REFERENCES documents(slug)
    )
  `);
  const accessColumns = new Set((d.prepare('PRAGMA table_info(document_access)').all() as Array<{ name: string }>).map(column => column.name));
  // Cross invitation (2026-09-19): every agent key is bound to the verified human who created it
  // (its sponsor) and carries the runtime that human declared. Keys made before this step are read
  // as sponsored by the document's owner (server/cross-invitation.ts backfillAgentKeySponsors).
  for (const column of ['label', 'requested_by', 'requested_from', 'last_used_at', 'sponsor_actor', 'sponsor_member_id', 'runtime', 'allow_direct_invite']) {
    if (!accessColumns.has(column)) d.exec(`ALTER TABLE document_access ADD COLUMN ${column} TEXT`);
  }
  d.exec('CREATE INDEX IF NOT EXISTS idx_document_access_slug ON document_access(document_slug)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_document_access_secret ON document_access(secret_hash)');

  d.exec(`
    CREATE TABLE IF NOT EXISTS document_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_slug TEXT NOT NULL,
      document_revision INTEGER,
      event_type TEXT NOT NULL,
      event_data TEXT NOT NULL,
      actor TEXT NOT NULL,
      idempotency_key TEXT,
      mutation_route TEXT,
      tombstone_revision INTEGER,
      created_at TEXT NOT NULL,
      acked_by TEXT,
      acked_at TEXT,
      FOREIGN KEY (document_slug) REFERENCES documents(slug)
    )
  `);
  addMissingDocumentEventColumns();
  d.exec('CREATE INDEX IF NOT EXISTS idx_document_events_slug_id ON document_events(document_slug, id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_document_events_slug_tombstone ON document_events(document_slug, tombstone_revision, id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_document_events_slug_revision ON document_events(document_slug, document_revision, id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_document_events_slug_idempotency_route ON document_events(document_slug, idempotency_key, mutation_route, id)');
  d.exec(`
    CREATE TABLE IF NOT EXISTS server_incident_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT,
      slug TEXT,
      subsystem TEXT NOT NULL,
      level TEXT NOT NULL,
      event_type TEXT NOT NULL,
      message TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  d.exec('CREATE INDEX IF NOT EXISTS idx_server_incident_events_request_id_created_at ON server_incident_events(request_id, created_at, id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_server_incident_events_slug_created_at ON server_incident_events(slug, created_at, id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_server_incident_events_subsystem_created_at ON server_incident_events(subsystem, created_at, id)');

  d.exec(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      idempotency_key TEXT NOT NULL,
      document_slug TEXT NOT NULL,
      route TEXT NOT NULL,
      response_json TEXT NOT NULL,
      request_hash TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (idempotency_key, document_slug, route)
    )
  `);
  addMissingIdempotencyColumns();

  d.exec(`
    CREATE TABLE IF NOT EXISTS ${MUTATION_IDEMPOTENCY_TABLE} (
      idempotency_key TEXT NOT NULL,
      document_slug TEXT NOT NULL,
      route TEXT NOT NULL,
      response_json TEXT NOT NULL,
      request_hash TEXT,
      status_code INTEGER NOT NULL DEFAULT 200,
      tombstone_revision INTEGER,
      state TEXT NOT NULL DEFAULT 'completed',
      completed_at TEXT,
      lease_expires_at TEXT,
      last_seen_at TEXT,
      reservation_token TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (idempotency_key, document_slug, route)
    )
  `);
  addMissingMutationIdempotencyColumns();
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_mutation_idempotency_slug_created_at
    ON ${MUTATION_IDEMPOTENCY_TABLE}(document_slug, created_at)
  `);
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_mutation_idempotency_slug_tombstone
    ON ${MUTATION_IDEMPOTENCY_TABLE}(document_slug, tombstone_revision, created_at)
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS ${MUTATION_OUTBOX_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_slug TEXT NOT NULL,
      document_revision INTEGER,
      event_id INTEGER,
      event_type TEXT NOT NULL,
      event_data TEXT NOT NULL,
      actor TEXT NOT NULL,
      idempotency_key TEXT,
      mutation_route TEXT,
      tombstone_revision INTEGER,
      created_at TEXT NOT NULL,
      delivered_at TEXT
    )
  `);
  addMissingMutationOutboxColumns();
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_mutation_outbox_slug_id
    ON ${MUTATION_OUTBOX_TABLE}(document_slug, id)
  `);
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_mutation_outbox_slug_revision
    ON ${MUTATION_OUTBOX_TABLE}(document_slug, document_revision, id)
  `);
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_mutation_outbox_pending
    ON ${MUTATION_OUTBOX_TABLE}(document_slug, delivered_at, tombstone_revision, id)
  `);
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_mutation_outbox_slug_idempotency_route
    ON ${MUTATION_OUTBOX_TABLE}(document_slug, idempotency_key, mutation_route, id)
  `);
  d.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mutation_outbox_event_id_unique
    ON ${MUTATION_OUTBOX_TABLE}(event_id)
    WHERE event_id IS NOT NULL
  `);
  backfillLegacyMutationRouteMetadata();

  d.exec(`
    CREATE TABLE IF NOT EXISTS ${MARK_TOMBSTONES_TABLE} (
      document_slug TEXT NOT NULL,
      mark_id TEXT NOT NULL,
      status TEXT NOT NULL,
      resolved_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (document_slug, mark_id)
    )
  `);
  addMissingMarkTombstoneColumns();
  d.exec(`CREATE INDEX IF NOT EXISTS idx_mark_tombstones_expires_at ON ${MARK_TOMBSTONES_TABLE}(expires_at)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_mark_tombstones_slug_revision ON ${MARK_TOMBSTONES_TABLE}(document_slug, resolved_revision)`);

  d.exec(`
    CREATE TABLE IF NOT EXISTS document_blocks (
      document_id TEXT NOT NULL,
      block_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      node_type TEXT NOT NULL,
      attrs_json TEXT NOT NULL DEFAULT '{}',
      markdown_hash TEXT NOT NULL,
      text_preview TEXT NOT NULL DEFAULT '',
      created_revision INTEGER NOT NULL,
      last_seen_revision INTEGER NOT NULL,
      retired_revision INTEGER,
      PRIMARY KEY (document_id, block_id)
    )
  `);
  d.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_document_blocks_live_ordinal
    ON document_blocks(document_id, ordinal)
    WHERE retired_revision IS NULL
  `);
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_document_blocks_live_doc
    ON document_blocks(document_id, retired_revision, ordinal)
  `);

  // Proof Documents Step 1: per-TM, per-line status marks. Kept beside the document
  // (never in its text or its Yjs state) so collab, repair and projection paths never touch them.
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_line_marks (
      id TEXT PRIMARY KEY,
      document_slug TEXT NOT NULL,
      by_actor TEXT NOT NULL,
      actor_key TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      line_hash TEXT NOT NULL,
      line_occurrence INTEGER NOT NULL,
      line_ordinal INTEGER NOT NULL,
      line_kind TEXT NOT NULL,
      line_excerpt TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_document_line_marks_slug ON document_line_marks(document_slug, updated_at)`);
  // Step B3b: how a mark was earned (via), and the line's whole text when marked (carry-forward).
  {
    const cols = new Set((d.prepare('PRAGMA table_info(document_line_marks)').all() as Array<{ name: string }>).map(c => c.name));
    if (!cols.has('via')) d.exec('ALTER TABLE document_line_marks ADD COLUMN via TEXT');
    if (!cols.has('line_text')) d.exec('ALTER TABLE document_line_marks ADD COLUMN line_text TEXT');
    // Step B4c: an AI's one-line rationale for its mark.
    if (!cols.has('why')) d.exec('ALTER TABLE document_line_marks ADD COLUMN why TEXT');
    // Proxy marks step: what the marker checked, and (for a ratified proxy) where it came from.
    if (!cols.has('evidence')) d.exec('ALTER TABLE document_line_marks ADD COLUMN evidence TEXT');
    if (!cols.has('proxy_json')) d.exec('ALTER TABLE document_line_marks ADD COLUMN proxy_json TEXT');
  }

  // Proof Documents, Familiar proxy marks (Mike, 2026-09-19): each person's Familiar AI per
  // document, the Familiar's proxy marks (never counted as the person's), and ratifications
  // (with what each ratified line held before, for Undo). Beside the document, never in its text.
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_familiars (
      document_slug TEXT NOT NULL,
      human_key TEXT NOT NULL,
      human_actor TEXT NOT NULL,
      familiar_actor TEXT NOT NULL,
      bound_at TEXT NOT NULL,
      bound_by TEXT NOT NULL,
      PRIMARY KEY (document_slug, human_key)
    )
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_proxy_marks (
      id TEXT PRIMARY KEY,
      document_slug TEXT NOT NULL,
      familiar_actor TEXT NOT NULL,
      familiar_key TEXT NOT NULL,
      for_actor TEXT NOT NULL,
      for_key TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      evidence TEXT NOT NULL,
      line_hash TEXT NOT NULL,
      line_occurrence INTEGER NOT NULL,
      line_ordinal INTEGER NOT NULL,
      line_kind TEXT NOT NULL,
      line_excerpt TEXT NOT NULL DEFAULT '',
      line_text TEXT,
      at TEXT NOT NULL
    )
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_document_proxy_marks_slug ON document_proxy_marks(document_slug, for_key, at)`);
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_proxy_ratifications (
      id TEXT PRIMARY KEY,
      document_slug TEXT NOT NULL,
      human_actor TEXT NOT NULL,
      human_key TEXT NOT NULL,
      familiar_actor TEXT NOT NULL,
      at TEXT NOT NULL,
      entries_json TEXT NOT NULL DEFAULT '[]',
      undone_at TEXT
    )
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_document_proxy_ratifications_slug ON document_proxy_ratifications(document_slug, human_key, at)`);

  // Proof Documents, line tiers (Mike, 2026-09-19): decision / context tags per line. Append-only
  // (every flip is kept with who and when); the newest tag still on a line is its tier. Beside the
  // document like line marks, never in its text.
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_line_tiers (
      id TEXT PRIMARY KEY,
      document_slug TEXT NOT NULL,
      tier TEXT NOT NULL,
      by_actor TEXT NOT NULL,
      reason TEXT,
      by_author INTEGER NOT NULL DEFAULT 0,
      line_hash TEXT NOT NULL,
      line_occurrence INTEGER NOT NULL,
      line_ordinal INTEGER NOT NULL,
      line_kind TEXT NOT NULL,
      line_excerpt TEXT NOT NULL DEFAULT '',
      line_text TEXT,
      at TEXT NOT NULL
    )
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_document_line_tiers_slug ON document_line_tiers(document_slug, at)`);

  // Proof Documents, dialect import (2026-09-19): a mark an import could not make live (its author
  // is someone the importer may not write as, or its type never imports live, such as {do}) is kept
  // as a history note on its line. History notes never count for alignment and never become marks.
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_dialect_history (
      id TEXT PRIMARY KEY,
      document_slug TEXT NOT NULL,
      mark_text TEXT NOT NULL,
      claimed_by TEXT,
      reason TEXT NOT NULL,
      imported_by TEXT NOT NULL,
      line_hash TEXT,
      line_occurrence INTEGER,
      line_ordinal INTEGER,
      line_kind TEXT,
      line_excerpt TEXT NOT NULL DEFAULT '',
      line_text TEXT,
      seq INTEGER NOT NULL DEFAULT 0,
      at TEXT NOT NULL
    )
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_document_dialect_history_slug ON document_dialect_history(document_slug, seq)`);

  // Proof Documents Step B4c: review notes (an AI's why / reject hints / explicit priority on a
  // suggestion or a line) and uncertain flags. Beside the document like line marks.
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_review_notes (
      id TEXT PRIMARY KEY,
      document_slug TEXT NOT NULL,
      by_actor TEXT NOT NULL,
      actor_key TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      mark_id TEXT,
      line_hash TEXT,
      line_occurrence INTEGER,
      line_ordinal INTEGER,
      line_kind TEXT,
      line_excerpt TEXT,
      line_text TEXT,
      why TEXT,
      reject_hints_json TEXT NOT NULL DEFAULT '[]',
      priority INTEGER,
      priority_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_document_review_notes_slug ON document_review_notes(document_slug, updated_at)`);
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_line_flags (
      id TEXT PRIMARY KEY,
      document_slug TEXT NOT NULL,
      by_actor TEXT NOT NULL,
      actor_key TEXT NOT NULL,
      note TEXT,
      line_hash TEXT NOT NULL,
      line_occurrence INTEGER NOT NULL,
      line_ordinal INTEGER NOT NULL,
      line_kind TEXT NOT NULL,
      line_excerpt TEXT NOT NULL DEFAULT '',
      line_text TEXT,
      created_at TEXT NOT NULL,
      cleared_at TEXT,
      cleared_by TEXT
    )
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_document_line_flags_slug ON document_line_flags(document_slug, created_at)`);

  // Proof Documents Step B4d: objections ("I'd agree if…"), independent of the text anchors.
  // lines_json keeps each covered line's original and current anchor; ack_json what the objector
  // has seen. Never deleted: a cleared or overridden objection keeps its record.
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_objections (
      id TEXT PRIMARY KEY,
      document_slug TEXT NOT NULL,
      by_actor TEXT NOT NULL,
      actor_key TEXT NOT NULL,
      reason TEXT NOT NULL,
      condition TEXT,
      lines_json TEXT NOT NULL,
      ack_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      closed_at TEXT,
      closed_by TEXT,
      override_reason TEXT,
      kept_at TEXT,
      repair_notified_json TEXT
    )
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_document_objections_slug ON document_objections(document_slug, created_at)`);

  d.exec(`CREATE TABLE IF NOT EXISTS document_move_settings (
    document_slug TEXT PRIMARY KEY, actors_json TEXT NOT NULL DEFAULT '[]'
  )`);
  // Proof Documents Steps B4e + B4f (server/proof-extras-store.ts): review bundles, competing
  // alternatives and picks, per-document settings (blind marking), Explain threads and line
  // times-to-live. All beside the document, never in its text or Yjs state.
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_bundles (
      id TEXT NOT NULL,
      document_slug TEXT NOT NULL,
      by_actor TEXT NOT NULL,
      title TEXT NOT NULL,
      why TEXT,
      members_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      closed_at TEXT,
      closed_by TEXT,
      PRIMARY KEY (document_slug, id)
    )
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_alternatives (
      id TEXT PRIMARY KEY,
      document_slug TEXT NOT NULL,
      by_actor TEXT NOT NULL,
      text TEXT NOT NULL,
      line_hash TEXT NOT NULL,
      line_occurrence INTEGER NOT NULL,
      line_ordinal INTEGER NOT NULL,
      line_kind TEXT NOT NULL,
      line_excerpt TEXT NOT NULL DEFAULT '',
      line_text TEXT,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      closed_at TEXT,
      closed_by TEXT,
      resolution_json TEXT
    )
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_document_alternatives_slug ON document_alternatives(document_slug, created_at)`);
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_alt_picks (
      id TEXT PRIMARY KEY,
      document_slug TEXT NOT NULL,
      by_actor TEXT NOT NULL,
      actor_key TEXT NOT NULL,
      choice TEXT NOT NULL,
      line_hash TEXT NOT NULL,
      at TEXT NOT NULL
    )
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_document_alt_picks_slug ON document_alt_picks(document_slug, at)`);
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_proof_settings (
      document_slug TEXT PRIMARY KEY,
      blind INTEGER NOT NULL DEFAULT 0,
      blind_set_by TEXT,
      blind_set_at TEXT
    )
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_explains (
      id TEXT PRIMARY KEY,
      document_slug TEXT NOT NULL,
      by_actor TEXT NOT NULL,
      comment_mark_id TEXT,
      question TEXT NOT NULL,
      line_hash TEXT NOT NULL,
      line_occurrence INTEGER NOT NULL,
      line_ordinal INTEGER NOT NULL,
      line_kind TEXT NOT NULL,
      line_excerpt TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_document_explains_slug ON document_explains(document_slug, created_at)`);
  // Accord round 2, stage D: threads. A thread is a comment or a suggestion PLUS what would close
  // it and what it is anchored to. This table holds only that extra part, keyed by the mark, so a
  // comment or suggestion already on a document reads as a thread with no row and nothing has to
  // be migrated (src/shared/threads.ts threadsFrom).
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_threads (
      id TEXT PRIMARY KEY,
      document_slug TEXT NOT NULL,
      mark_id TEXT,
      by_actor TEXT NOT NULL,
      asks TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      anchor_json TEXT NOT NULL DEFAULT '[]',
      selection TEXT,
      waiting_on_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'open',
      chat_message_id INTEGER,
      created_at TEXT NOT NULL,
      closed_at TEXT,
      closed_by TEXT,
      -- Accord round 2 stage C (a loose end from stage D): replies live HERE as well as on the
      -- mark. Deleting the text a thread sits on takes the mark with it, and the reply history
      -- went too. Deleting text must never silently delete an unresolved disagreement OR the
      -- discussion of it, so the thread's own row carries its replies.
      replies_json TEXT NOT NULL DEFAULT '[]'
    )
  `);
  {
    const threadColumns = new Set((d.prepare('PRAGMA table_info(document_threads)').all() as Array<{ name: string }>).map(c => c.name));
    if (!threadColumns.has('replies_json')) {
      d.exec(`ALTER TABLE document_threads ADD COLUMN replies_json TEXT NOT NULL DEFAULT '[]'`);
    }
  }
  d.exec(`CREATE INDEX IF NOT EXISTS idx_document_threads_slug ON document_threads(document_slug, created_at)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_document_threads_mark ON document_threads(document_slug, mark_id)`);
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_line_ttls (
      id TEXT PRIMARY KEY,
      document_slug TEXT NOT NULL,
      by_actor TEXT NOT NULL,
      ttl_ms INTEGER NOT NULL,
      label TEXT NOT NULL,
      line_hash TEXT NOT NULL,
      line_occurrence INTEGER NOT NULL,
      line_ordinal INTEGER NOT NULL,
      line_kind TEXT NOT NULL,
      line_excerpt TEXT NOT NULL DEFAULT '',
      line_text TEXT,
      set_at TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_hash TEXT NOT NULL,
      checks_json TEXT NOT NULL DEFAULT '[]',
      expired_noted_at TEXT,
      cleared_at TEXT,
      cleared_by TEXT
    )
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_document_line_ttls_slug ON document_line_ttls(document_slug, set_at)`);

  // Proof Documents Step B3c: aligned snapshots. Frozen when a document's Issue count reaches 0:
  // its markdown, every line mark, the asks with answers and the team. Rows are never changed.
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_aligned_snapshots (
      id TEXT PRIMARY KEY,
      document_slug TEXT NOT NULL,
      created_at TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      markdown TEXT NOT NULL,
      payload TEXT NOT NULL
    )
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_document_aligned_snapshots_slug ON document_aligned_snapshots(document_slug, created_at)`);

  // Proof Documents Step B3: {ask} decision lines. Beside the document like line marks.
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_asks (
      id TEXT PRIMARY KEY,
      document_slug TEXT NOT NULL,
      by_actor TEXT NOT NULL,
      to_json TEXT NOT NULL DEFAULT '[]',
      recommend TEXT NOT NULL,
      if_yes TEXT,
      line_hash TEXT NOT NULL,
      line_occurrence INTEGER NOT NULL,
      line_ordinal INTEGER NOT NULL,
      line_kind TEXT NOT NULL,
      line_excerpt TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      asked_at TEXT NOT NULL,
      withdrawn_at TEXT
    )
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_document_asks_slug ON document_asks(document_slug, created_at)`);
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_ask_answers (
      id TEXT PRIMARY KEY,
      ask_id TEXT NOT NULL,
      document_slug TEXT NOT NULL,
      by_actor TEXT NOT NULL,
      choice TEXT NOT NULL,
      words TEXT NOT NULL DEFAULT '',
      line_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_document_ask_answers_ask ON document_ask_answers(ask_id, created_at)`);

  // Proof Documents {do} action lines (safe slice, 2026-09-18). Beside the document like asks.
  // document_do_approvals rows are never deleted (revocation sets revoked_at). document_do_runs
  // exists for the attended enablement: in this slice nothing writes it (execution is disabled).
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_dos (
      id TEXT PRIMARY KEY,
      document_slug TEXT NOT NULL,
      by_actor TEXT NOT NULL,
      to_json TEXT NOT NULL DEFAULT '[]',
      presser TEXT NOT NULL DEFAULT 'approver',
      retry_budget INTEGER NOT NULL DEFAULT 0,
      action_json TEXT NOT NULL,
      line_hash TEXT NOT NULL,
      line_occurrence INTEGER NOT NULL,
      line_ordinal INTEGER NOT NULL,
      line_kind TEXT NOT NULL,
      line_excerpt TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      withdrawn_at TEXT
    )
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_document_dos_slug ON document_dos(document_slug, created_at)`);
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_do_approvals (
      id TEXT PRIMARY KEY,
      do_id TEXT NOT NULL,
      document_slug TEXT NOT NULL,
      by_actor TEXT NOT NULL,
      digest TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      revoked_by TEXT
    )
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_document_do_approvals_do ON document_do_approvals(do_id, created_at)`);
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_do_runs (
      id TEXT PRIMARY KEY,
      do_id TEXT NOT NULL,
      document_slug TEXT NOT NULL,
      approval_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      digest TEXT NOT NULL,
      presser TEXT NOT NULL,
      started_at TEXT NOT NULL,
      receipts_json TEXT NOT NULL DEFAULT '[]',
      UNIQUE (do_id, attempt)
    )
  `);

  // Proof Documents Step B7: chat beside the document (never in its text or Yjs state). The
  // INTEGER id is the page's and the agent API's cursor (GET /chat?after=<id>).
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_slug TEXT NOT NULL,
      by_actor TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'message',
      text TEXT NOT NULL,
      lines_json TEXT NOT NULL DEFAULT '[]',
      mentions_json TEXT NOT NULL DEFAULT '[]',
      reply_to INTEGER,
      suggestion_json TEXT,
      comment_mark_id TEXT,
      created_at TEXT NOT NULL
    )
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_document_chat_slug ON document_chat_messages(document_slug, id)`);

  // Proof Documents Step B6: explicit identity merges (a typed-name actor -> a verified person).
  // Made only by the COS on request (server/library/cli.ts merge-identity); rows are never
  // rewritten, the merge applies when marks and answers are read. scope = a slug or '*'.
  d.exec(`
    CREATE TABLE IF NOT EXISTS identity_merges (
      scope TEXT NOT NULL,
      from_key TEXT NOT NULL,
      into_actor TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT,
      note TEXT,
      PRIMARY KEY (scope, from_key)
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS document_y_updates (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      document_slug TEXT NOT NULL,
      update_blob BLOB NOT NULL,
      source_actor TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (document_slug) REFERENCES documents(slug)
    )
  `);
  d.exec('CREATE INDEX IF NOT EXISTS idx_document_y_updates_slug_seq ON document_y_updates(document_slug, seq)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_document_y_updates_slug_created_at ON document_y_updates(document_slug, created_at)');

  d.exec(`
    CREATE TABLE IF NOT EXISTS document_y_snapshots (
      document_slug TEXT NOT NULL,
      version INTEGER NOT NULL,
      snapshot_blob BLOB NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (document_slug, version),
      FOREIGN KEY (document_slug) REFERENCES documents(slug)
    )
  `);
  d.exec('CREATE INDEX IF NOT EXISTS idx_document_y_snapshots_slug_version ON document_y_snapshots(document_slug, version)');

  d.exec(`
    CREATE TABLE IF NOT EXISTS maintenance_runs (
      run_key TEXT PRIMARY KEY,
      completed_at TEXT NOT NULL,
      summary TEXT
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS share_auth_sessions (
      session_token_hash TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      every_user_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      name TEXT,
      subscriber INTEGER NOT NULL DEFAULT 1,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      access_expires_at TEXT NOT NULL,
      session_expires_at TEXT NOT NULL,
      last_verified_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  d.exec('CREATE INDEX IF NOT EXISTS idx_share_auth_sessions_revoked ON share_auth_sessions(revoked_at)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_share_auth_sessions_expiry ON share_auth_sessions(session_expires_at)');

  d.exec(`
    CREATE TABLE IF NOT EXISTS ${ACTIVE_COLLAB_CONNECTIONS_TABLE} (
      connection_id TEXT PRIMARY KEY,
      document_slug TEXT NOT NULL,
      role TEXT NOT NULL,
      access_epoch INTEGER NOT NULL,
      instance_id TEXT NOT NULL,
      connected_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )
  `);
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_active_collab_connections_slug_seen
    ON ${ACTIVE_COLLAB_CONNECTIONS_TABLE}(document_slug, last_seen_at)
  `);
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_active_collab_connections_instance_seen
    ON ${ACTIVE_COLLAB_CONNECTIONS_TABLE}(instance_id, last_seen_at)
  `);
  activeCollabConnectionsTableInitialized = true;

  d.exec(`
    CREATE TABLE IF NOT EXISTS user_document_visits (
      every_user_id INTEGER NOT NULL,
      document_slug TEXT NOT NULL,
      role TEXT,
      first_visited_at TEXT NOT NULL,
      last_visited_at TEXT NOT NULL,
      PRIMARY KEY (every_user_id, document_slug)
    )
  `);
  d.exec('CREATE INDEX IF NOT EXISTS idx_udv_user_last ON user_document_visits(every_user_id, last_visited_at)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_udv_document_slug ON user_document_visits(document_slug)');

  d.exec(`
    CREATE TABLE IF NOT EXISTS library_documents (
      every_user_id INTEGER PRIMARY KEY,
      document_slug TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (document_slug) REFERENCES documents(slug)
    )
  `);
  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_library_documents_slug ON library_documents(document_slug)');

  d.exec(`
    CREATE TABLE IF NOT EXISTS library_members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      is_owner INTEGER NOT NULL DEFAULT 0,
      invited_by TEXT,
      created_at TEXT NOT NULL,
      removed_at TEXT
    )
  `);
  d.exec('CREATE INDEX IF NOT EXISTS idx_library_members_active ON library_members(removed_at, created_at)');

  d.exec(`
    CREATE TABLE IF NOT EXISTS library_signin_links (
      token_hash TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      FOREIGN KEY (member_id) REFERENCES library_members(id)
    )
  `);
  d.exec('CREATE INDEX IF NOT EXISTS idx_library_signin_links_member ON library_signin_links(member_id, used_at, expires_at)');

  d.exec(`
    CREATE TABLE IF NOT EXISTS library_sessions (
      session_hash TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT,
      user_agent TEXT,
      FOREIGN KEY (member_id) REFERENCES library_members(id)
    )
  `);
  d.exec('CREATE INDEX IF NOT EXISTS idx_library_sessions_member ON library_sessions(member_id, revoked_at, expires_at)');
  const librarySessionColumns = d.prepare('PRAGMA table_info(library_sessions)').all() as Array<{ name: string }>;
  if (!librarySessionColumns.some((column) => column.name === 'soma_verified_at')) {
    d.exec('ALTER TABLE library_sessions ADD COLUMN soma_verified_at TEXT');
    d.exec('ALTER TABLE library_sessions ADD COLUMN soma_admin INTEGER NOT NULL DEFAULT 0');
  }


  d.exec(`
    CREATE TABLE IF NOT EXISTS library_document_meta (
      slug TEXT PRIMARY KEY,
      created_by_member_id TEXT,
      archived_at TEXT,
      archived_by TEXT,
      FOREIGN KEY (slug) REFERENCES documents(slug),
      FOREIGN KEY (created_by_member_id) REFERENCES library_members(id)
    )
  `);
  d.exec('CREATE INDEX IF NOT EXISTS idx_library_document_meta_archived ON library_document_meta(archived_at)');

  d.exec(`
    CREATE TABLE IF NOT EXISTS library_visits (
      member_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      last_opened_at TEXT,
      last_left_at TEXT,
      PRIMARY KEY (member_id, slug),
      FOREIGN KEY (member_id) REFERENCES library_members(id),
      FOREIGN KEY (slug) REFERENCES documents(slug)
    )
  `);
  d.exec('CREATE INDEX IF NOT EXISTS idx_library_visits_slug ON library_visits(slug)');

  // Invite person (2026-09-19): a member is either a library member ('library', sees every
  // document) or an invited person ('invited', sees only the documents they were invited to).
  const libraryMemberColumns = d.prepare('PRAGMA table_info(library_members)').all() as Array<{ name: string }>;
  if (!libraryMemberColumns.some((column) => column.name === 'scope')) {
    d.exec(`ALTER TABLE library_members ADD COLUMN scope TEXT NOT NULL DEFAULT 'library'`);
  }
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_invites (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      member_id TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT,
      invited_by_member_id TEXT,
      invited_by_actor TEXT,
      created_at TEXT NOT NULL,
      removed_at TEXT,
      removed_by TEXT,
      joined_at TEXT,
      last_seen_at TEXT,
      last_sent_at TEXT,
      send_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_document_invites_active ON document_invites(slug, email) WHERE removed_at IS NULL');
  d.exec('CREATE INDEX IF NOT EXISTS idx_document_invites_member ON document_invites(member_id, removed_at)');
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_guest_access (
      slug TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    )
  `);
  // Cross invitation (2026-09-19): an AI nominates a person (nothing is emailed; an Owner
  // confirms or declines) and attests to a person's identity (read and comment only, marks
  // never count). Both always come from the AI's own API call with its key, are rate-limited,
  // are visible in the people dialog, and carry the AI's own words for the human who reads them.
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_nominations (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      by_actor TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT,
      why TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      decided_at TEXT,
      decided_by TEXT,
      decline_reason TEXT,
      invite_id TEXT
    )
  `);
  d.exec('CREATE INDEX IF NOT EXISTS idx_document_nominations_slug ON document_nominations(slug, status)');
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_attestations (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      by_actor TEXT NOT NULL,
      email TEXT NOT NULL,
      member_id TEXT,
      basis TEXT NOT NULL,
      confidence TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      revoked_by TEXT
    )
  `);
  d.exec('CREATE INDEX IF NOT EXISTS idx_document_attestations_slug ON document_attestations(slug, revoked_at)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_document_attestations_email ON document_attestations(email, revoked_at)');

  d.exec(`CREATE TABLE IF NOT EXISTS client_errors (
    signature TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    sample TEXT NOT NULL,
    forwarded INTEGER NOT NULL DEFAULT 0
  )`);

}

export function createDocument(
  slug: string,
  markdown: string,
  marks: Record<string, unknown>,
  title?: string,
  ownerId?: string,
  ownerSecret?: string,
): DocumentRow {
  assertWritesAllowed('createDocument');
  const now = new Date().toISOString();
  const d = getDb();
  const docId = randomUUID();
  createMetadataTableIfNeeded(d);
  const collabBootstrapEpoch = readMetadataNumber(d, GLOBAL_COLLAB_ADMISSION_EPOCH_METADATA_KEY, 0);
  const ownerSecretHash = ownerSecret ? hashSecret(ownerSecret) : null;

  d.prepare(`
    INSERT INTO documents (
      slug, doc_id, title, markdown, marks, revision, y_state_version, share_state, access_epoch, collab_bootstrap_epoch, active,
      owner_id, owner_secret, owner_secret_hash, created_at, updated_at, deleted_at
    )
    VALUES (?, ?, ?, ?, ?, 1, 0, 'ACTIVE', 0, ?, 1, ?, NULL, ?, ?, ?, NULL)
  `).run(
    slug,
    docId,
    title || null,
    markdown,
    JSON.stringify(marks),
    collabBootstrapEpoch,
    ownerId || null,
    ownerSecretHash,
    now,
    now,
  );

  upsertDocumentProjectionRow(slug, markdown, JSON.stringify(marks), 1, 0, now);

  return d.prepare('SELECT * FROM documents WHERE slug = ?').get(slug) as DocumentRow;
}

export function getDocument(slug: string): DocumentRow | undefined {
  return getDb()
    .prepare('SELECT * FROM documents WHERE slug = ? AND share_state = \'ACTIVE\'')
    .get(slug) as DocumentRow | undefined;
}

export function getDocumentBySlug(slug: string): DocumentRow | undefined {
  return getDb()
    .prepare('SELECT * FROM documents WHERE slug = ?')
    .get(slug) as DocumentRow | undefined;
}

export function getDocumentProjectionBySlug(slug: string): DocumentProjectionRow | undefined {
  return getDb()
    .prepare('SELECT * FROM document_projections WHERE document_slug = ? LIMIT 1')
    .get(slug) as DocumentProjectionRow | undefined;
}

export function getProjectedDocumentBySlug(slug: string): ProjectedDocumentRow | undefined {
  return getDb().prepare(`
    SELECT
      d.*,
      d.markdown AS canonical_markdown,
      d.marks AS canonical_marks,
      COALESCE(p.markdown, d.markdown) AS markdown,
      COALESCE(p.marks_json, d.marks) AS marks,
      COALESCE(p.plain_text, d.markdown) AS plain_text,
      COALESCE(p.health, 'projection_stale') AS projection_health,
      p.health_reason AS projection_health_reason,
      p.revision AS projection_revision,
      p.y_state_version AS projection_y_state_version,
      p.updated_at AS projection_updated_at
    FROM documents d
    LEFT JOIN document_projections p
      ON p.document_slug = d.slug
    WHERE d.slug = ?
    LIMIT 1
  `).get(slug) as ProjectedDocumentRow | undefined;
}

export function setDocumentProjectionHealth(
  slug: string,
  health: DocumentProjectionRow['health'],
  reason: string | null = null,
): boolean {
  assertWritesAllowed('setDocumentProjectionHealth');
  const nextReason = health === 'quarantined'
    ? (reason ?? getDocumentProjectionBySlug(slug)?.health_reason ?? null)
    : null;

  const result = getDb().prepare(`
    UPDATE document_projections
    SET health = ?, health_reason = ?
    WHERE document_slug = ?
  `).run(health, nextReason, slug);

  if (result.changes > 0) return true;

  const row = getDocumentBySlug(slug);
  if (!row) return false;
  upsertDocumentProjectionRow(
    slug,
    row.markdown,
    row.marks,
    row.revision,
    row.y_state_version,
    row.updated_at,
    health,
    nextReason,
  );
  return true;
}

export function getDocumentAuthStateBySlug(slug: string): DocumentAuthStateRow | undefined {
  return getDb()
    .prepare(`
      SELECT slug, doc_id, share_state, access_epoch, owner_id, owner_secret, owner_secret_hash
      FROM documents
      WHERE slug = ?
      LIMIT 1
    `)
    .get(slug) as DocumentAuthStateRow | undefined;
}

function ensureActiveCollabConnectionsTable(): void {
  if (activeCollabConnectionsTableInitialized) return;
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS ${ACTIVE_COLLAB_CONNECTIONS_TABLE} (
      connection_id TEXT PRIMARY KEY,
      document_slug TEXT NOT NULL,
      role TEXT NOT NULL,
      access_epoch INTEGER NOT NULL,
      instance_id TEXT NOT NULL,
      connected_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )
  `);
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_active_collab_connections_slug_seen
    ON ${ACTIVE_COLLAB_CONNECTIONS_TABLE}(document_slug, last_seen_at)
  `);
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_active_collab_connections_instance_seen
    ON ${ACTIVE_COLLAB_CONNECTIONS_TABLE}(instance_id, last_seen_at)
  `);
  activeCollabConnectionsTableInitialized = true;
}

export function getActiveCollabConnectionTtlMs(): number {
  return parsePositiveInt(process.env.ACTIVE_COLLAB_CONNECTION_TTL_MS, DEFAULT_ACTIVE_COLLAB_CONNECTION_TTL_MS);
}

function getDocumentLiveCollabLeaseTtlMs(): number {
  return parsePositiveInt(process.env.DOCUMENT_LIVE_COLLAB_LEASE_TTL_MS, DEFAULT_DOCUMENT_LIVE_COLLAB_LEASE_TTL_MS);
}

function maybePruneExpiredActiveCollabConnections(nowIso: string): void {
  const nowMs = Date.now();
  if (nowMs - lastActiveCollabConnectionPruneAt < DEFAULT_ACTIVE_COLLAB_CONNECTION_PRUNE_INTERVAL_MS) return;
  lastActiveCollabConnectionPruneAt = nowMs;
  const cutoffIso = new Date(Date.parse(nowIso) - getActiveCollabConnectionTtlMs()).toISOString();
  getDb().prepare(`
    DELETE FROM ${ACTIVE_COLLAB_CONNECTIONS_TABLE}
    WHERE last_seen_at < ?
  `).run(cutoffIso);
}

export function upsertActiveCollabConnection(input: ActiveCollabConnectionInput): void {
  assertWritesAllowed('upsertActiveCollabConnection');
  ensureActiveCollabConnectionsTable();
  const observedAt = input.observedAt ?? new Date().toISOString();
  maybePruneExpiredActiveCollabConnections(observedAt);
  getDb().prepare(`
    INSERT INTO ${ACTIVE_COLLAB_CONNECTIONS_TABLE} (
      connection_id,
      document_slug,
      role,
      access_epoch,
      instance_id,
      connected_at,
      last_seen_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(connection_id) DO UPDATE SET
      document_slug = excluded.document_slug,
      role = excluded.role,
      access_epoch = excluded.access_epoch,
      instance_id = excluded.instance_id,
      last_seen_at = excluded.last_seen_at
  `).run(
    input.connectionId,
    input.slug,
    input.role,
    input.accessEpoch,
    input.instanceId,
    observedAt,
    observedAt,
  );
}

export function removeActiveCollabConnection(connectionId: string): void {
  assertWritesAllowed('removeActiveCollabConnection');
  ensureActiveCollabConnectionsTable();
  getDb().prepare(`
    DELETE FROM ${ACTIVE_COLLAB_CONNECTIONS_TABLE}
    WHERE connection_id = ?
  `).run(connectionId);
}

export function countActiveCollabConnections(
  slug: string,
  accessEpoch?: number | null,
  observedAt: string = new Date().toISOString(),
): number {
  ensureActiveCollabConnectionsTable();
  const cutoffIso = new Date(Date.parse(observedAt) - getActiveCollabConnectionTtlMs()).toISOString();
  if (typeof accessEpoch === 'number' && Number.isFinite(accessEpoch)) {
    const row = getDb().prepare(`
      SELECT COUNT(*) AS count
      FROM ${ACTIVE_COLLAB_CONNECTIONS_TABLE}
      WHERE document_slug = ?
        AND access_epoch = ?
        AND last_seen_at >= ?
    `).get(slug, accessEpoch, cutoffIso) as { count?: number } | undefined;
    return typeof row?.count === 'number' ? row.count : 0;
  }
  const row = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM ${ACTIVE_COLLAB_CONNECTIONS_TABLE}
    WHERE document_slug = ?
      AND last_seen_at >= ?
  `).get(slug, cutoffIso) as { count?: number } | undefined;
  return typeof row?.count === 'number' ? row.count : 0;
}

export function countActiveCollabConnectionsForInstance(
  slug: string,
  instanceId: string,
  accessEpoch?: number | null,
  observedAt: string = new Date().toISOString(),
): number {
  ensureActiveCollabConnectionsTable();
  const cutoffIso = new Date(Date.parse(observedAt) - getActiveCollabConnectionTtlMs()).toISOString();
  if (typeof accessEpoch === 'number' && Number.isFinite(accessEpoch)) {
    const row = getDb().prepare(`
      SELECT COUNT(*) AS count
      FROM ${ACTIVE_COLLAB_CONNECTIONS_TABLE}
      WHERE document_slug = ?
        AND instance_id = ?
        AND access_epoch = ?
        AND last_seen_at >= ?
    `).get(slug, instanceId, accessEpoch, cutoffIso) as { count?: number } | undefined;
    return typeof row?.count === 'number' ? row.count : 0;
  }
  const row = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM ${ACTIVE_COLLAB_CONNECTIONS_TABLE}
    WHERE document_slug = ?
      AND instance_id = ?
      AND last_seen_at >= ?
  `).get(slug, instanceId, cutoffIso) as { count?: number } | undefined;
  return typeof row?.count === 'number' ? row.count : 0;
}

export function listActiveCollabConnectionSlugs(
  observedAt: string = new Date().toISOString(),
): string[] {
  ensureActiveCollabConnectionsTable();
  const cutoffIso = new Date(Date.parse(observedAt) - getActiveCollabConnectionTtlMs()).toISOString();
  const rows = getDb().prepare(`
    SELECT DISTINCT document_slug AS slug
    FROM ${ACTIVE_COLLAB_CONNECTIONS_TABLE}
    WHERE last_seen_at >= ?
  `).all(cutoffIso) as Array<{ slug?: string | null }>;
  return rows
    .map((row) => (typeof row.slug === 'string' ? row.slug.trim() : ''))
    .filter((slug) => slug.length > 0);
}

export function noteDocumentLiveCollabLease(
  slug: string,
  accessEpoch: number,
  observedAt: string = new Date().toISOString(),
): void {
  assertWritesAllowed('noteDocumentLiveCollabLease');
  getDb().prepare(`
    UPDATE documents
    SET live_collab_seen_at = ?, live_collab_access_epoch = ?
    WHERE slug = ? AND share_state IN ('ACTIVE', 'PAUSED')
  `).run(observedAt, accessEpoch, slug);
}

export function getRecentDocumentLiveCollabLeaseBreakdown(
  slug: string,
  accessEpoch?: number | null,
  observedAt: string = new Date().toISOString(),
): { exactEpochCount: number; anyEpochCount: number } {
  const cutoffIso = new Date(Date.parse(observedAt) - getDocumentLiveCollabLeaseTtlMs()).toISOString();
  const row = getDb().prepare(`
    SELECT live_collab_seen_at AS seenAt, live_collab_access_epoch AS leaseEpoch
    FROM documents
    WHERE slug = ?
    LIMIT 1
  `).get(slug) as { seenAt?: string | null; leaseEpoch?: number | null } | undefined;
  const seenAt = typeof row?.seenAt === 'string' ? row.seenAt : null;
  if (!seenAt || seenAt < cutoffIso) {
    return { exactEpochCount: 0, anyEpochCount: 0 };
  }
  const leaseEpoch = typeof row?.leaseEpoch === 'number' && Number.isFinite(row.leaseEpoch)
    ? row.leaseEpoch
    : null;
  const exactEpochCount = typeof accessEpoch === 'number' && Number.isFinite(accessEpoch) && leaseEpoch === accessEpoch
    ? 1
    : 0;
  return {
    exactEpochCount,
    anyEpochCount: 1,
  };
}

export function listRecentDocumentLiveCollabLeaseSlugs(
  observedAt: string = new Date().toISOString(),
): string[] {
  const cutoffIso = new Date(Date.parse(observedAt) - getDocumentLiveCollabLeaseTtlMs()).toISOString();
  const rows = getDb().prepare(`
    SELECT slug
    FROM documents
    WHERE share_state IN ('ACTIVE', 'PAUSED')
      AND live_collab_seen_at IS NOT NULL
      AND live_collab_seen_at >= ?
  `).all(cutoffIso) as Array<{ slug?: string | null }>;
  return rows
    .map((row) => (typeof row.slug === 'string' ? row.slug.trim() : ''))
    .filter((slug) => slug.length > 0);
}

export function listActiveDocuments(): DocumentRow[] {
  return getDb()
    .prepare('SELECT * FROM documents WHERE share_state = \'ACTIVE\'')
    .all() as DocumentRow[];
}

export function updateDocument(
  slug: string,
  markdown: string,
  marks?: Record<string, unknown>,
  yStateVersion?: number,
): boolean {
  assertWritesAllowed('updateDocument');
  const now = new Date().toISOString();
  if (marks !== undefined) {
    if (yStateVersion !== undefined) {
      const result = getDb().prepare(`
        UPDATE documents
        SET markdown = ?, marks = ?, updated_at = ?, revision = revision + 1, y_state_version = ?
        WHERE slug = ? AND share_state IN ('ACTIVE', 'PAUSED')
      `).run(markdown, JSON.stringify(marks), now, yStateVersion, slug);
      if (result.changes > 0) {
        const updated = getDocumentBySlug(slug);
        if (updated) upsertDocumentProjectionRow(slug, updated.markdown, updated.marks, updated.revision, updated.y_state_version, updated.updated_at);
      }
      return result.changes > 0;
    }
    const result = getDb().prepare(`
      UPDATE documents
      SET markdown = ?, marks = ?, updated_at = ?, revision = revision + 1
      WHERE slug = ? AND share_state IN ('ACTIVE', 'PAUSED')
    `).run(markdown, JSON.stringify(marks), now, slug);
    if (result.changes > 0) {
      const updated = getDocumentBySlug(slug);
      if (updated) upsertDocumentProjectionRow(slug, updated.markdown, updated.marks, updated.revision, updated.y_state_version, updated.updated_at);
    }
    return result.changes > 0;
  }

  if (yStateVersion !== undefined) {
    const result = getDb().prepare(`
      UPDATE documents
      SET markdown = ?, updated_at = ?, revision = revision + 1, y_state_version = ?
      WHERE slug = ? AND share_state IN ('ACTIVE', 'PAUSED')
    `).run(markdown, now, yStateVersion, slug);
    if (result.changes > 0) {
      const updated = getDocumentBySlug(slug);
      if (updated) upsertDocumentProjectionRow(slug, updated.markdown, updated.marks, updated.revision, updated.y_state_version, updated.updated_at);
    }
    return result.changes > 0;
  }

  const result = getDb().prepare(`
    UPDATE documents
    SET markdown = ?, updated_at = ?, revision = revision + 1
    WHERE slug = ? AND share_state IN ('ACTIVE', 'PAUSED')
  `).run(markdown, now, slug);
  if (result.changes > 0) {
    const updated = getDocumentBySlug(slug);
    if (updated) upsertDocumentProjectionRow(slug, updated.markdown, updated.marks, updated.revision, updated.y_state_version, updated.updated_at);
  }
  return result.changes > 0;
}

export function updateDocumentTitle(slug: string, title: string | null): boolean {
  assertWritesAllowed('updateDocumentTitle');
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    UPDATE documents
    SET title = ?, updated_at = ?
    WHERE slug = ? AND share_state IN ('ACTIVE', 'PAUSED')
  `).run(title, now, slug);
  return result.changes > 0;
}

export function updateDocumentAtomic(
  slug: string,
  expectedUpdatedAt: string,
  markdown: string,
  marks?: Record<string, unknown>,
): boolean {
  assertWritesAllowed('updateDocumentAtomic');
  const now = new Date().toISOString();
  if (marks !== undefined) {
    const result = getDb().prepare(`
      UPDATE documents
      SET markdown = ?, marks = ?, updated_at = ?, revision = revision + 1
      WHERE slug = ? AND updated_at = ? AND share_state IN ('ACTIVE', 'PAUSED')
    `).run(markdown, JSON.stringify(marks), now, slug, expectedUpdatedAt);
    if (result.changes > 0) {
      const updated = getDocumentBySlug(slug);
      if (updated) upsertDocumentProjectionRow(slug, updated.markdown, updated.marks, updated.revision, updated.y_state_version, updated.updated_at);
    }
    return result.changes > 0;
  }

  const result = getDb().prepare(`
    UPDATE documents
    SET markdown = ?, updated_at = ?, revision = revision + 1
    WHERE slug = ? AND updated_at = ? AND share_state IN ('ACTIVE', 'PAUSED')
  `).run(markdown, now, slug, expectedUpdatedAt);
  if (result.changes > 0) {
    const updated = getDocumentBySlug(slug);
    if (updated) upsertDocumentProjectionRow(slug, updated.markdown, updated.marks, updated.revision, updated.y_state_version, updated.updated_at);
  }
  return result.changes > 0;
}

export function updateDocumentAtomicByRevision(
  slug: string,
  expectedRevision: number,
  markdown: string,
  marks?: Record<string, unknown>,
): boolean {
  assertWritesAllowed('updateDocumentAtomicByRevision');
  const now = new Date().toISOString();
  if (marks !== undefined) {
    const result = getDb().prepare(`
      UPDATE documents
      SET markdown = ?, marks = ?, updated_at = ?, revision = revision + 1
      WHERE slug = ? AND revision = ? AND share_state IN ('ACTIVE', 'PAUSED')
    `).run(markdown, JSON.stringify(marks), now, slug, expectedRevision);
    if (result.changes > 0) {
      const updated = getDocumentBySlug(slug);
      if (updated) upsertDocumentProjectionRow(slug, updated.markdown, updated.marks, updated.revision, updated.y_state_version, updated.updated_at);
    }
    return result.changes > 0;
  }

  const result = getDb().prepare(`
    UPDATE documents
    SET markdown = ?, updated_at = ?, revision = revision + 1
    WHERE slug = ? AND revision = ? AND share_state IN ('ACTIVE', 'PAUSED')
  `).run(markdown, now, slug, expectedRevision);
  if (result.changes > 0) {
    const updated = getDocumentBySlug(slug);
    if (updated) upsertDocumentProjectionRow(slug, updated.markdown, updated.marks, updated.revision, updated.y_state_version, updated.updated_at);
  }
  return result.changes > 0;
}

export function updateMarks(slug: string, marks: Record<string, unknown>): boolean {
  assertWritesAllowed('updateMarks');
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    UPDATE documents
    SET marks = ?, updated_at = ?
    WHERE slug = ? AND share_state IN ('ACTIVE', 'PAUSED')
  `).run(JSON.stringify(marks), now, slug);
  if (result.changes > 0) {
    const updated = getDocumentBySlug(slug);
    if (updated) upsertDocumentProjectionRow(slug, updated.markdown, updated.marks, updated.revision, updated.y_state_version, updated.updated_at);
  }
  return result.changes > 0;
}

export function replaceDocumentProjection(
  slug: string,
  markdown: string,
  marks: Record<string, unknown>,
  yStateVersion?: number,
  options?: {
    health?: DocumentProjectionRow['health'];
    healthReason?: string | null;
  },
): boolean {
  assertWritesAllowed('replaceDocumentProjection');
  const current = getDocumentBySlug(slug);
  if (!current || !['ACTIVE', 'PAUSED'].includes(current.share_state)) return false;

  let nextYStateVersion = typeof current.y_state_version === 'number' ? current.y_state_version : 0;
  const projectionRow = getDocumentProjectionBySlug(slug);
  if (yStateVersion !== undefined) {
    const syncResult = getDb().prepare(`
      UPDATE documents
      SET y_state_version = ?
      WHERE slug = ? AND share_state IN ('ACTIVE', 'PAUSED')
    `).run(yStateVersion, slug);
    if (syncResult.changes === 0) return false;
    nextYStateVersion = yStateVersion;
  }

  const nextHealth = options?.health ?? projectionRow?.health ?? 'healthy';
  const nextHealthReason = nextHealth === 'quarantined'
    ? options?.healthReason ?? projectionRow?.health_reason ?? null
    : null;

  upsertDocumentProjectionRow(
    slug,
    markdown,
    JSON.stringify(marks),
    current.revision,
    nextYStateVersion,
    current.updated_at,
    nextHealth,
    nextHealthReason,
  );
  return true;
}

type BlockDescriptor = {
  ordinal: number;
  node_type: string;
  attrs_json: string;
  markdown: string;
  markdown_hash: string;
  text_preview: string;
};

function hashMarkdown(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

function buildTextPreview(text: string, limit: number = 200): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

async function buildBlockDescriptors(markdown: string): Promise<BlockDescriptor[]> {
  const parser = await getHeadlessMilkdownParser();
  const parsed = parseMarkdownWithHtmlFallback(parser, markdown ?? '');
  if (!parsed.doc) {
    throw new Error(`Failed to parse markdown into blocks: ${summarizeParseError(parsed.error)}`);
  }
  const doc = parsed.doc;
  const blocks: BlockDescriptor[] = [];

  for (let i = 0; i < doc.childCount; i += 1) {
    const node = doc.child(i);
    const blockMarkdown = await serializeSingleNode(node);
    blocks.push({
      ordinal: i + 1,
      node_type: node.type.name,
      attrs_json: JSON.stringify(node.attrs ?? {}),
      markdown: blockMarkdown,
      markdown_hash: hashMarkdown(blockMarkdown),
      text_preview: buildTextPreview(node.textContent),
    });
  }

  return blocks;
}

function blockKey(block: { node_type: string; markdown_hash: string }): string {
  return `${block.node_type}::${block.markdown_hash}`;
}

function computeLcsMatches(a: string[], b: string[]): Array<[number, number]> {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const matches: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      matches.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return matches;
}

function matchBlocks(
  oldBlocks: DocumentBlockRow[],
  newBlocks: BlockDescriptor[],
): Map<number, number> {
  const matches = new Map<number, number>(); // newIndex -> oldIndex
  const usedOld = new Set<number>();
  const usedNew = new Set<number>();

  const max = Math.min(oldBlocks.length, newBlocks.length);
  for (let i = 0; i < max; i += 1) {
    if (blockKey(oldBlocks[i]) === blockKey(newBlocks[i])) {
      matches.set(i, i);
      usedOld.add(i);
      usedNew.add(i);
    }
  }

  const remainingOld = oldBlocks.map((_, idx) => idx).filter((idx) => !usedOld.has(idx));
  const remainingNew = newBlocks.map((_, idx) => idx).filter((idx) => !usedNew.has(idx));

  if (remainingOld.length && remainingNew.length) {
    const oldKeys = remainingOld.map((idx) => blockKey(oldBlocks[idx]));
    const newKeys = remainingNew.map((idx) => blockKey(newBlocks[idx]));
    const lcsMatches = computeLcsMatches(oldKeys, newKeys);
    for (const [oldIdx, newIdx] of lcsMatches) {
      const oldIndex = remainingOld[oldIdx];
      const newIndex = remainingNew[newIdx];
      matches.set(newIndex, oldIndex);
      usedOld.add(oldIndex);
      usedNew.add(newIndex);
    }
  }

  const stillOld = oldBlocks.map((_, idx) => idx).filter((idx) => !usedOld.has(idx));
  const stillNew = newBlocks.map((_, idx) => idx).filter((idx) => !usedNew.has(idx));

  for (const newIndex of stillNew) {
    const candidates = stillOld.filter((idx) => blockKey(oldBlocks[idx]) === blockKey(newBlocks[newIndex]));
    if (candidates.length === 1) {
      matches.set(newIndex, candidates[0]);
      usedOld.add(candidates[0]);
      usedNew.add(newIndex);
      continue;
    }

    if (candidates.length > 1) {
      let prevOld = -Infinity;
      let nextOld = Infinity;
      for (let i = newIndex - 1; i >= 0; i -= 1) {
        const match = matches.get(i);
        if (match !== undefined) {
          prevOld = match;
          break;
        }
      }
      for (let i = newIndex + 1; i < newBlocks.length; i += 1) {
        const match = matches.get(i);
        if (match !== undefined) {
          nextOld = match;
          break;
        }
      }
      const constrained = candidates.filter((idx) => idx > prevOld && idx < nextOld);
      if (constrained.length === 1) {
        matches.set(newIndex, constrained[0]);
        usedOld.add(constrained[0]);
        usedNew.add(newIndex);
      }
    }
  }

  return matches;
}

export function listLiveDocumentBlocks(documentId: string): DocumentBlockRow[] {
  return getDb().prepare(`
    SELECT *
    FROM document_blocks
    WHERE document_id = ? AND retired_revision IS NULL
    ORDER BY ordinal ASC
  `).all(documentId) as DocumentBlockRow[];
}

export function listDocumentBlocks(documentId: string): DocumentBlockRow[] {
  return getDb().prepare(`
    SELECT *
    FROM document_blocks
    WHERE document_id = ?
    ORDER BY ordinal ASC
  `).all(documentId) as DocumentBlockRow[];
}

export async function rebuildDocumentBlocks(
  document: DocumentRow,
  markdown: string,
  revision: number,
): Promise<DocumentBlockRow[]> {
  assertWritesAllowed('rebuildDocumentBlocks');
  if (!document.doc_id) {
    throw new Error('Document is missing doc_id; cannot rebuild block index.');
  }

  const documentId = document.doc_id;
  const oldBlocks = listLiveDocumentBlocks(documentId);
  const newBlocks = await buildBlockDescriptors(markdown);
  const matches = matchBlocks(oldBlocks, newBlocks);

  const nextBlocks = newBlocks.map((block, index) => {
    const oldIndex = matches.get(index);
    const existing = oldIndex !== undefined ? oldBlocks[oldIndex] : null;
    return {
      document_id: documentId,
      block_id: existing?.block_id ?? randomUUID(),
      ordinal: block.ordinal,
      node_type: block.node_type,
      attrs_json: block.attrs_json,
      markdown_hash: block.markdown_hash,
      text_preview: block.text_preview,
      created_revision: existing?.created_revision ?? revision,
      last_seen_revision: revision,
      retired_revision: null,
    } satisfies DocumentBlockRow;
  });

  const oldBlockIds = new Set(oldBlocks.map((block) => block.block_id));
  const usedOldIds = new Set<string>(nextBlocks.map((block) => block.block_id));
  const retiredOld = oldBlocks.filter((block) => !usedOldIds.has(block.block_id));

  const db = getDb();
  const updateTemp = db.prepare(`
    UPDATE document_blocks
    SET ordinal = ?, node_type = ?, attrs_json = ?, markdown_hash = ?, text_preview = ?, last_seen_revision = ?, retired_revision = NULL
    WHERE document_id = ? AND block_id = ?
  `);
  const updateOrdinal = db.prepare(`
    UPDATE document_blocks
    SET ordinal = ?
    WHERE document_id = ? AND block_id = ?
  `);
  const retire = db.prepare(`
    UPDATE document_blocks
    SET retired_revision = ?
    WHERE document_id = ? AND block_id = ? AND retired_revision IS NULL
  `);
  const insert = db.prepare(`
    INSERT INTO document_blocks (
      document_id, block_id, ordinal, node_type, attrs_json, markdown_hash, text_preview,
      created_revision, last_seen_revision, retired_revision
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `);

  const tx = db.transaction(() => {
    for (const block of retiredOld) {
      retire.run(revision, documentId, block.block_id);
    }

    for (let i = 0; i < nextBlocks.length; i += 1) {
      const block = nextBlocks[i];
      if (oldBlockIds.has(block.block_id)) {
        updateTemp.run(-(i + 1), block.node_type, block.attrs_json, block.markdown_hash, block.text_preview, revision, documentId, block.block_id);
      }
    }

    for (const block of nextBlocks) {
      if (!oldBlockIds.has(block.block_id)) {
        insert.run(
          block.document_id,
          block.block_id,
          block.ordinal,
          block.node_type,
          block.attrs_json,
          block.markdown_hash,
          block.text_preview,
          block.created_revision,
          block.last_seen_revision,
        );
      }
    }

    for (const block of nextBlocks) {
      if (oldBlockIds.has(block.block_id)) {
        updateOrdinal.run(block.ordinal, documentId, block.block_id);
      }
    }
  });

  tx();
  return listLiveDocumentBlocks(documentId);
}

function updateShareState(slug: string, state: ShareState): boolean {
  assertWritesAllowed('updateShareState');
  const now = new Date().toISOString();
  if (state === 'DELETED') {
    const result = getDb().prepare(`
      UPDATE documents
      SET share_state = ?, active = 0, deleted_at = ?, updated_at = ?, access_epoch = access_epoch + 1
      WHERE slug = ?
    `).run(state, now, now, slug);
    return result.changes > 0;
  }

  const active = state === 'ACTIVE' ? 1 : 0;
  const result = getDb().prepare(`
    UPDATE documents
    SET share_state = ?, active = ?, deleted_at = NULL, updated_at = ?, access_epoch = CASE WHEN ? = 'ACTIVE' THEN access_epoch ELSE access_epoch + 1 END
    WHERE slug = ?
  `).run(state, active, now, state, slug);
  return result.changes > 0;
}

export function pauseDocument(slug: string): boolean {
  return updateShareState(slug, 'PAUSED');
}

export function resumeDocument(slug: string): boolean {
  return updateShareState(slug, 'ACTIVE');
}

export function revokeDocument(slug: string): boolean {
  return updateShareState(slug, 'REVOKED');
}

export function deleteDocument(slug: string): boolean {
  return updateShareState(slug, 'DELETED');
}

export function deactivateDocument(slug: string): boolean {
  return pauseDocument(slug);
}

export function addEvent(slug: string, eventType: string, eventData: unknown, actor: string): void {
  assertWritesAllowed('addEvent');
  const now = new Date().toISOString();
  const payload = JSON.stringify(eventData);
  const d = getDb();
  const tx = d.transaction(() => {
    const documentRevision = getDocumentRevisionForSlug(d, slug);
    d.prepare(`
      INSERT INTO events (document_slug, event_type, event_data, actor, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(slug, eventType, payload, actor, now);
    const result = d.prepare(`
      INSERT INTO document_events (
        document_slug, document_revision, event_type, event_data, actor, idempotency_key, tombstone_revision, created_at
      )
      VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
    `).run(slug, documentRevision, eventType, payload, actor, now);
    const eventId = Number(result.lastInsertRowid);
    d.prepare(`
      INSERT INTO ${MUTATION_OUTBOX_TABLE} (
        document_slug, document_revision, event_id, event_type, event_data, actor, idempotency_key, tombstone_revision, created_at, delivered_at
      )
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL)
    `).run(slug, documentRevision, eventId, eventType, payload, actor, now);
  });
  tx();
}

export function addDocumentEvent(
  slug: string,
  eventType: string,
  eventData: unknown,
  actor: string,
  idempotencyKey?: string,
  mutationRoute?: string,
): number {
  assertWritesAllowed('addDocumentEvent');
  const now = new Date().toISOString();
  const payload = JSON.stringify(eventData);
  const d = getDb();
  const tx = d.transaction(() => {
    const documentRevision = getDocumentRevisionForSlug(d, slug);
    const result = d.prepare(`
      INSERT INTO document_events (
        document_slug, document_revision, event_type, event_data, actor, idempotency_key, mutation_route, tombstone_revision, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(slug, documentRevision, eventType, payload, actor, idempotencyKey ?? null, mutationRoute ?? null, now);
    const eventId = Number(result.lastInsertRowid);
    d.prepare(`
      INSERT INTO ${MUTATION_OUTBOX_TABLE} (
        document_slug, document_revision, event_id, event_type, event_data, actor, idempotency_key, mutation_route, tombstone_revision, created_at, delivered_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)
    `).run(slug, documentRevision, eventId, eventType, payload, actor, idempotencyKey ?? null, mutationRoute ?? null, now);
    return eventId;
  });
  return tx();
}

export function listDocumentEvents(
  slug: string,
  afterId: number,
  limit: number = DEFAULT_EVENT_PAGE_SIZE,
): DocumentEventRow[] {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  return getDb().prepare(`
    SELECT * FROM document_events
    WHERE document_slug = ? AND id > ?
    ORDER BY id ASC
    LIMIT ?
  `).all(slug, afterId, safeLimit) as DocumentEventRow[];
}

export function ackDocumentEvents(slug: string, upToId: number, ackedBy: string): number {
  assertWritesAllowed('ackDocumentEvents');
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    UPDATE document_events
    SET acked_by = ?, acked_at = ?
    WHERE document_slug = ? AND id <= ? AND acked_at IS NULL
  `).run(ackedBy, now, slug, upToId);
  return result.changes;
}

export function createDocumentAccessToken(
  slug: string,
  role: ShareRole,
  providedSecret?: string,
  agent?: {
    label: string; requestedBy: string; requestedFrom: string;
    /** Cross invitation: the verified human who added this AI, and what they said is running it. */
    sponsorActor?: string | null; sponsorMemberId?: string | null; runtime?: string | null;
  },
): { tokenId: string; role: ShareRole; secret: string; createdAt: string } {
  assertWritesAllowed('createDocumentAccessToken');
  const now = new Date().toISOString();
  const secret = providedSecret ?? randomUUID();
  const tokenId = randomUUID();
  getDb().prepare(`
    INSERT INTO document_access (token_id, document_slug, role, secret_hash, created_at, revoked_at, label, requested_by, requested_from, sponsor_actor, sponsor_member_id, runtime)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
  `).run(tokenId, slug, role, hashSecret(secret), now, agent?.label ?? null, agent?.requestedBy ?? null, agent?.requestedFrom ?? null,
    agent?.sponsorActor ?? null, agent?.sponsorMemberId ?? null, agent?.runtime ?? null);
  return { tokenId, role, secret, createdAt: now };
}

export interface DocumentAgentKey {
  tokenId: string; label: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null;
  /** Cross invitation (2026-09-19): who added this AI, what runs it, and its standing permissions. */
  sponsorActor: string | null; sponsorMemberId: string | null; runtime: string | null;
  allowDirectInvite: boolean;
}

export function listDocumentAgentKeys(slug: string): DocumentAgentKey[] {
  const rows = getDb().prepare(`
    SELECT token_id AS tokenId, label, created_at AS createdAt,
      last_used_at AS lastUsedAt, revoked_at AS revokedAt,
      sponsor_actor AS sponsorActor, sponsor_member_id AS sponsorMemberId, runtime,
      allow_direct_invite AS allowDirectInvite
    FROM document_access WHERE document_slug = ? AND label IS NOT NULL
    ORDER BY created_at DESC, token_id
  `).all(slug) as Array<Omit<DocumentAgentKey, 'allowDirectInvite'> & { allowDirectInvite: string | null }>;
  return rows.map(row => ({ ...row, allowDirectInvite: row.allowDirectInvite === '1' }));
}

/** Cross invitation: an Owner grants (or withdraws) one AI's standing permission to invite. */
export function setAgentKeyDirectInvite(slug: string, tokenId: string, allow: boolean): boolean {
  assertWritesAllowed('setAgentKeyDirectInvite');
  return getDb().prepare(`
    UPDATE document_access SET allow_direct_invite = ?
    WHERE document_slug = ? AND token_id = ? AND label IS NOT NULL AND revoked_at IS NULL
  `).run(allow ? '1' : null, slug, tokenId).changes > 0;
}

/** Cross invitation: records the sponsor of a key that predates sponsors (a one-time backfill). */
export function setAgentKeySponsor(tokenId: string, sponsorActor: string, sponsorMemberId: string | null): void {
  assertWritesAllowed('setAgentKeySponsor');
  getDb().prepare(`
    UPDATE document_access SET sponsor_actor = ?, sponsor_member_id = COALESCE(sponsor_member_id, ?)
    WHERE token_id = ? AND label IS NOT NULL AND sponsor_actor IS NULL
  `).run(sponsorActor, sponsorMemberId, tokenId);
}

export function revokeDocumentAgentKey(slug: string, tokenId: string): boolean {
  assertWritesAllowed('revokeDocumentAgentKey');
  const revoked = getDb().prepare(`
    UPDATE document_access SET revoked_at = COALESCE(revoked_at, ?)
    WHERE document_slug = ? AND token_id = ? AND label IS NOT NULL
  `).run(new Date().toISOString(), slug, tokenId).changes > 0;
  if (revoked) documentAccessEvents.emit('revoked', slug, tokenId);
  return revoked;
}

/**
 * Invite person (2026-09-19): collab sessions opened without a share token carry a pseudo token
 * id ("invite:<id>" for an invited person, "guest:<mode>" for a guest) so that removing a person
 * or tightening the guest setting ends them at once, like revoking an agent key. The module that
 * issues them (server/document-team.ts) registers how to check them.
 */
const collabTokenChecks = new Map<string, (slug: string, rest: string) => boolean>();

export function registerCollabTokenCheck(prefix: string, check: (slug: string, rest: string) => boolean): void {
  collabTokenChecks.set(prefix, check);
}

export function isDocumentAccessTokenActive(slug: string, tokenId: string): boolean {
  for (const [prefix, check] of collabTokenChecks) {
    if (tokenId.startsWith(prefix)) return check(slug, tokenId.slice(prefix.length));
  }
  return Boolean(getDb().prepare(`
    SELECT 1 FROM document_access WHERE document_slug = ? AND token_id = ? AND revoked_at IS NULL
  `).get(slug, tokenId));
}

export function revokeDocumentAccessTokens(
  slug: string,
  role?: ShareRole,
  options?: { bumpEpoch?: boolean },
): number {
  assertWritesAllowed('revokeDocumentAccessTokens');
  const now = new Date().toISOString();
  const shouldBumpEpoch = options?.bumpEpoch !== false;
  let changes = 0;
  if (role) {
    const result = getDb().prepare(`
      UPDATE document_access
      SET revoked_at = ?
      WHERE document_slug = ? AND role = ? AND revoked_at IS NULL
    `).run(now, slug, role);
    changes = result.changes;
    if (changes > 0 && shouldBumpEpoch) {
      bumpDocumentAccessEpoch(slug);
    }
    return changes;
  }
  const result = getDb().prepare(`
    UPDATE document_access
    SET revoked_at = ?
    WHERE document_slug = ? AND revoked_at IS NULL
  `).run(now, slug);
  changes = result.changes;
  if (changes > 0 && shouldBumpEpoch) {
    bumpDocumentAccessEpoch(slug);
  }
  return changes;
}

/**
 * Cross invitation: server/cross-invitation.ts registers how to tell whether an agent key is
 * suspended (its sponsor lost access). Kept as a hook so that db.ts imports nothing from it.
 */
let agentKeySuspensionCheck: ((slug: string, tokenId: string) => boolean) | null = null;

export function registerAgentKeySuspensionCheck(check: (slug: string, tokenId: string) => boolean): void {
  agentKeySuspensionCheck = check;
}

export type DocumentAccessResolution = {
  role: ShareRole;
  tokenId: string | null;
  source: 'owner_secret' | 'owner_secret_legacy' | 'access_token';
};

export function resolveDocumentAccess(slug: string, presentedSecret: string): DocumentAccessResolution | null {
  if (!presentedSecret) return null;
  const hashed = hashSecret(presentedSecret);
  const doc = getDocumentAuthStateBySlug(slug);
  if (!doc) return null;
  if (doc.owner_secret_hash && timingSafeEqualString(doc.owner_secret_hash, hashed)) {
    return { role: 'owner_bot', tokenId: null, source: 'owner_secret' };
  }
  if (doc.owner_secret && timingSafeEqualString(doc.owner_secret, presentedSecret)) {
    return { role: 'owner_bot', tokenId: null, source: 'owner_secret_legacy' };
  }
  const row = getDb().prepare(`
    SELECT token_id, role, label
    FROM document_access
    WHERE document_slug = ? AND secret_hash = ? AND revoked_at IS NULL
    LIMIT 1
  `).get(slug, hashed) as { token_id?: string; role?: ShareRole; label?: string | null } | undefined;
  if (!row?.role) return null;
  if (row.label != null) {
    // Cross invitation (2026-09-19): an AI whose sponsor lost access to the document is suspended
    // with them. The key is not revoked (a re-invited sponsor brings their AI back), but it opens
    // nothing while the suspension stands.
    if (row.token_id && agentKeySuspensionCheck?.(slug, row.token_id)) return null;
    getDb().prepare('UPDATE document_access SET last_used_at = ? WHERE token_id = ?')
      .run(new Date().toISOString(), row.token_id);
  }
  return {
    role: row.role,
    tokenId: row.token_id ?? null,
    source: 'access_token',
  };
}

export function resolveDocumentAccessRole(slug: string, presentedSecret: string): ShareRole | null {
  return resolveDocumentAccess(slug, presentedSecret)?.role ?? null;
}

export function bumpDocumentAccessEpoch(slug: string): number | null {
  assertWritesAllowed('bumpDocumentAccessEpoch');
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    UPDATE documents
    SET access_epoch = access_epoch + 1, updated_at = ?
    WHERE slug = ?
  `).run(now, slug);
  if (result.changes <= 0) return null;
  const row = getDb().prepare(`
    SELECT access_epoch
    FROM documents
    WHERE slug = ?
    LIMIT 1
  `).get(slug) as { access_epoch?: number } | undefined;
  return typeof row?.access_epoch === 'number' ? row.access_epoch : null;
}

export function canMutateByOwnerIdentity(
  doc: Pick<DocumentRow, 'owner_secret' | 'owner_secret_hash' | 'owner_id'>,
  ownerSecret: unknown,
): boolean {
  if (typeof ownerSecret === 'string' && ownerSecret.length > 0) {
    const ownerSecretHash = hashSecret(ownerSecret);
    if (doc.owner_secret_hash && timingSafeEqualString(doc.owner_secret_hash, ownerSecretHash)) {
      return true;
    }
    if (doc.owner_secret && timingSafeEqualString(doc.owner_secret, ownerSecret)) {
      return true;
    }
  }
  return false;
}

function parseStoredResponse(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

type CoordinatorIdempotencyRow = {
  response_json?: string;
  request_hash?: string | null;
  status_code?: number | null;
  tombstone_revision?: number | null;
  state?: string | null;
  created_at?: string;
  completed_at?: string | null;
  lease_expires_at?: string | null;
  last_seen_at?: string | null;
};

type LegacyIdempotencyRow = {
  response_json?: string;
  request_hash?: string | null;
};

function readCoordinatorIdempotencyRow(
  documentSlug: string,
  route: string,
  idempotencyKey: string,
): CoordinatorIdempotencyRow | undefined {
  return getDb().prepare(`
    SELECT response_json, request_hash, status_code, tombstone_revision, state, created_at, completed_at, lease_expires_at, last_seen_at
    FROM ${MUTATION_IDEMPOTENCY_TABLE}
    WHERE idempotency_key = ? AND document_slug = ? AND route = ?
    LIMIT 1
  `).get(idempotencyKey, documentSlug, route) as CoordinatorIdempotencyRow | undefined;
}

function readLegacyIdempotencyRow(
  documentSlug: string,
  route: string,
  idempotencyKey: string,
): LegacyIdempotencyRow | undefined {
  return getDb().prepare(`
    SELECT response_json, request_hash
    FROM idempotency_keys
    WHERE idempotency_key = ? AND document_slug = ? AND route = ?
    LIMIT 1
  `).get(idempotencyKey, documentSlug, route) as LegacyIdempotencyRow | undefined;
}

export function getStoredIdempotencyResult(
  documentSlug: string,
  route: string,
  idempotencyKey: string,
): Record<string, unknown> | null {
  const coordinatorRow = readCoordinatorIdempotencyRow(documentSlug, route, idempotencyKey);
  const legacyRow = readLegacyIdempotencyRow(documentSlug, route, idempotencyKey);
  const completedCoordinator = coordinatorRow?.state === 'completed' ? coordinatorRow : undefined;

  if (completedCoordinator && legacyRow) {
    if (completedCoordinator.response_json === legacyRow.response_json) {
      recordMutationIdempotencyDualRead('parity_match', route);
    } else {
      recordMutationIdempotencyDualRead('parity_mismatch', route);
      console.warn('[db] idempotency dual-read parity mismatch', { documentSlug, route, idempotencyKey });
    }
  } else if (completedCoordinator) {
    recordMutationIdempotencyDualRead('new_only', route);
  } else if (legacyRow) {
    recordMutationIdempotencyDualRead('legacy_fallback', route);
  }

  const row = completedCoordinator ?? legacyRow;
  return parseStoredResponse(row?.response_json);
}

export function getStoredIdempotencyRecord(
  documentSlug: string,
  route: string,
  idempotencyKey: string,
): { response: Record<string, unknown>; requestHash: string | null } | null {
  const coordinatorRow = readCoordinatorIdempotencyRow(documentSlug, route, idempotencyKey);
  const legacyRow = readLegacyIdempotencyRow(documentSlug, route, idempotencyKey);
  const completedCoordinator = coordinatorRow?.state === 'completed' ? coordinatorRow : undefined;

  if (completedCoordinator && legacyRow) {
    const responseParity = completedCoordinator.response_json === legacyRow.response_json;
    const hashParity = (completedCoordinator.request_hash ?? null) === (legacyRow.request_hash ?? null);
    if (responseParity && hashParity) {
      recordMutationIdempotencyDualRead('parity_match', route);
    } else {
      recordMutationIdempotencyDualRead('parity_mismatch', route);
      console.warn('[db] idempotency record dual-read parity mismatch', { documentSlug, route, idempotencyKey });
    }
  } else if (completedCoordinator) {
    recordMutationIdempotencyDualRead('new_hit', route);
  } else if (legacyRow) {
    recordMutationIdempotencyDualRead('legacy_fallback', route);
  }

  const row = completedCoordinator ?? legacyRow;
  const response = parseStoredResponse(row?.response_json);
  if (!response) return null;
  return {
    response,
    requestHash: typeof row?.request_hash === 'string' ? row.request_hash : null,
  };
}

export function getMutationIdempotencyRecord(
  documentSlug: string,
  route: string,
  idempotencyKey: string,
): MutationIdempotencyRecord | null {
  const coordinatorRow = readCoordinatorIdempotencyRow(documentSlug, route, idempotencyKey);
  if (coordinatorRow) {
    return {
      state: coordinatorRow.state === 'pending' ? 'pending' : 'completed',
      response: coordinatorRow.state === 'completed' ? parseStoredResponse(coordinatorRow.response_json) : null,
      requestHash: typeof coordinatorRow.request_hash === 'string' ? coordinatorRow.request_hash : null,
      statusCode: typeof coordinatorRow.status_code === 'number' ? coordinatorRow.status_code : null,
      tombstoneRevision: typeof coordinatorRow.tombstone_revision === 'number' ? coordinatorRow.tombstone_revision : null,
      createdAt: coordinatorRow.created_at ?? new Date(0).toISOString(),
      completedAt: typeof coordinatorRow.completed_at === 'string' ? coordinatorRow.completed_at : null,
      leaseExpiresAt: typeof coordinatorRow.lease_expires_at === 'string' ? coordinatorRow.lease_expires_at : null,
      lastSeenAt: typeof coordinatorRow.last_seen_at === 'string' ? coordinatorRow.last_seen_at : null,
    };
  }

  const legacyRow = readLegacyIdempotencyRow(documentSlug, route, idempotencyKey);
  if (!legacyRow) return null;
  return {
    state: 'completed',
    response: parseStoredResponse(legacyRow.response_json),
    requestHash: typeof legacyRow.request_hash === 'string' ? legacyRow.request_hash : null,
    statusCode: 200,
    tombstoneRevision: null,
    createdAt: new Date(0).toISOString(),
    completedAt: null,
    leaseExpiresAt: null,
    lastSeenAt: null,
  };
}

export function reservePendingIdempotencyKey(
  documentSlug: string,
  route: string,
  idempotencyKey: string,
  requestHash: string,
  leaseExpiresAt: string,
  reservationToken: string = randomUUID(),
): boolean {
  assertWritesAllowed('reservePendingIdempotencyKey');
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    INSERT OR IGNORE INTO ${MUTATION_IDEMPOTENCY_TABLE} (
      idempotency_key, document_slug, route, response_json, request_hash, status_code, tombstone_revision, state, completed_at, lease_expires_at, last_seen_at, reservation_token, created_at
    )
    VALUES (?, ?, ?, ?, ?, 0, NULL, 'pending', NULL, ?, ?, ?, ?)
  `).run(
    idempotencyKey,
    documentSlug,
    route,
    '{}',
    requestHash,
    leaseExpiresAt,
    now,
    reservationToken,
    now,
  );
  return result.changes > 0;
}

export function touchPendingIdempotencyKey(
  documentSlug: string,
  route: string,
  idempotencyKey: string,
  leaseExpiresAt: string,
  reservationToken: string | null,
): boolean {
  assertWritesAllowed('touchPendingIdempotencyKey');
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    UPDATE ${MUTATION_IDEMPOTENCY_TABLE}
    SET lease_expires_at = ?, last_seen_at = ?
    WHERE idempotency_key = ? AND document_slug = ? AND route = ? AND state = 'pending'
      AND COALESCE(reservation_token, '') = COALESCE(?, '')
  `).run(leaseExpiresAt, now, idempotencyKey, documentSlug, route, reservationToken);
  return result.changes > 0;
}

export function stealExpiredPendingIdempotencyKey(
  documentSlug: string,
  route: string,
  idempotencyKey: string,
  requestHash: string,
  expiredBefore: string,
  nextLeaseExpiresAt: string,
  reservationToken: string = randomUUID(),
): boolean {
  assertWritesAllowed('stealExpiredPendingIdempotencyKey');
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    UPDATE ${MUTATION_IDEMPOTENCY_TABLE}
    SET response_json = '{}',
        request_hash = ?,
        status_code = 0,
        tombstone_revision = NULL,
        state = 'pending',
        completed_at = NULL,
        lease_expires_at = ?,
        last_seen_at = ?,
        reservation_token = ?,
        created_at = ?
    WHERE idempotency_key = ? AND document_slug = ? AND route = ? AND state = 'pending'
      AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
  `).run(
    requestHash,
    nextLeaseExpiresAt,
    now,
    reservationToken,
    now,
    idempotencyKey,
    documentSlug,
    route,
    expiredBefore,
  );
  return result.changes > 0;
}

export function completePendingIdempotencyKey(
  documentSlug: string,
  route: string,
  idempotencyKey: string,
  response: Record<string, unknown>,
  requestHash?: string | null,
  reservationToken?: string | null,
  options?: { statusCode?: number; tombstoneRevision?: number | null },
): boolean {
  assertWritesAllowed('completePendingIdempotencyKey');
  const now = new Date().toISOString();
  const statusCode = Number.isInteger(options?.statusCode) ? Number(options?.statusCode) : 200;
  const tombstoneRevision = options?.tombstoneRevision ?? null;
  const encoded = JSON.stringify(response);
  const d = getDb();
  const tx = d.transaction(() => {
    const completed = d.prepare(`
      UPDATE ${MUTATION_IDEMPOTENCY_TABLE}
      SET response_json = ?,
          request_hash = COALESCE(request_hash, ?),
          status_code = ?,
          tombstone_revision = ?,
          state = 'completed',
          completed_at = ?,
          lease_expires_at = NULL,
          last_seen_at = ?,
          reservation_token = NULL
      WHERE idempotency_key = ? AND document_slug = ? AND route = ? AND state = 'pending'
        AND COALESCE(reservation_token, '') = COALESCE(?, '')
    `).run(
      encoded,
      requestHash ?? null,
      statusCode,
      tombstoneRevision,
      now,
      now,
      idempotencyKey,
      documentSlug,
      route,
      reservationToken ?? null,
    ).changes;
    if (completed > 0) {
      d.prepare(`
        INSERT OR REPLACE INTO idempotency_keys (idempotency_key, document_slug, route, response_json, request_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(idempotencyKey, documentSlug, route, encoded, requestHash ?? null, now);
    }
    return completed > 0;
  });
  return tx();
}

export function releasePendingIdempotencyKey(
  documentSlug: string,
  route: string,
  idempotencyKey: string,
  reservationToken?: string | null,
): boolean {
  assertWritesAllowed('releasePendingIdempotencyKey');
  const result = getDb().prepare(`
    DELETE FROM ${MUTATION_IDEMPOTENCY_TABLE}
    WHERE idempotency_key = ? AND document_slug = ? AND route = ? AND state = 'pending'
      AND COALESCE(reservation_token, '') = COALESCE(?, '')
  `).run(idempotencyKey, documentSlug, route, reservationToken ?? null);
  return result.changes > 0;
}

export function hasDurableMutationRecordForIdempotencyKey(
  documentSlug: string,
  route: string,
  idempotencyKey: string,
): boolean {
  const d = getDb();
  const readMatchedDurableEvidence = (): boolean => {
    const eventRow = d.prepare(`
    SELECT 1 AS present
    FROM document_events
    WHERE document_slug = ? AND idempotency_key = ? AND mutation_route = ?
    LIMIT 1
  `).get(documentSlug, idempotencyKey, route) as { present?: number } | undefined;
    if (eventRow?.present === 1) return true;
    const outboxRow = d.prepare(`
    SELECT 1 AS present
    FROM ${MUTATION_OUTBOX_TABLE}
    WHERE document_slug = ? AND idempotency_key = ? AND mutation_route = ?
    LIMIT 1
  `).get(documentSlug, idempotencyKey, route) as { present?: number } | undefined;
    return outboxRow?.present === 1;
  };

  if (readMatchedDurableEvidence()) return true;
  backfillLegacyMutationRouteMetadata({ documentSlug, idempotencyKey });
  return readMatchedDurableEvidence();
}

export function storeIdempotencyResult(
  documentSlug: string,
  route: string,
  idempotencyKey: string,
  response: Record<string, unknown>,
  requestHash?: string | null,
  options?: { statusCode?: number; tombstoneRevision?: number | null },
): void {
  assertWritesAllowed('storeIdempotencyResult');
  const now = new Date().toISOString();
  const statusCode = Number.isInteger(options?.statusCode) ? Number(options?.statusCode) : 200;
  const tombstoneRevision = options?.tombstoneRevision ?? null;
  const encoded = JSON.stringify(response);
  const d = getDb();
  const tx = d.transaction(() => {
    d.prepare(`
      INSERT OR REPLACE INTO idempotency_keys (idempotency_key, document_slug, route, response_json, request_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(idempotencyKey, documentSlug, route, encoded, requestHash ?? null, now);
    d.prepare(`
      INSERT OR REPLACE INTO ${MUTATION_IDEMPOTENCY_TABLE} (
        idempotency_key, document_slug, route, response_json, request_hash, status_code, tombstone_revision, state, completed_at, lease_expires_at, last_seen_at, reservation_token, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, NULL, ?, NULL, ?)
    `).run(
      idempotencyKey,
      documentSlug,
      route,
      encoded,
      requestHash ?? null,
      statusCode,
      tombstoneRevision,
      now,
      now,
      now,
    );
  });
  tx();
}

export function cleanupIdempotencyKeys(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
  assertWritesAllowed('cleanupIdempotencyKeys');
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const d = getDb();
  const tx = d.transaction(() => {
    const legacy = d.prepare(`
      DELETE FROM idempotency_keys
      WHERE created_at < ?
    `).run(cutoff).changes;
    const coordinator = d.prepare(`
      DELETE FROM ${MUTATION_IDEMPOTENCY_TABLE}
      WHERE created_at < ?
    `).run(cutoff).changes;
    return legacy + coordinator;
  });
  return tx();
}

export function cleanupMutationOutbox(maxAgeMs: number = 30 * 24 * 60 * 60 * 1000): number {
  assertWritesAllowed('cleanupMutationOutbox');
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const result = getDb().prepare(`
    DELETE FROM ${MUTATION_OUTBOX_TABLE}
    WHERE created_at < ?
  `).run(cutoff);
  return result.changes;
}

export function cleanupHttpInfoIncidentEvents(
  maxAgeMs: number = 60 * 60 * 1000,
  batchSize: number = 100_000,
): number {
  assertWritesAllowed('cleanupHttpInfoIncidentEvents');
  const cutoff = new Date(Date.now() - Math.max(0, maxAgeMs)).toISOString();
  const safeBatchSize = Number.isFinite(batchSize) ? Math.max(1, Math.trunc(batchSize)) : 100_000;
  const result = getDb().prepare(`
    DELETE FROM server_incident_events
    WHERE id IN (
      SELECT id
      FROM server_incident_events
      WHERE subsystem = 'http'
        AND level = 'info'
        AND created_at < ?
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    )
  `).run(cutoff, safeBatchSize);
  return result.changes;
}

export function cleanupExpiredMarkTombstones(nowIso: string = new Date().toISOString()): number {
  assertWritesAllowed('cleanupExpiredMarkTombstones');
  const result = getDb().prepare(`
    DELETE FROM ${MARK_TOMBSTONES_TABLE}
    WHERE expires_at <= ?
  `).run(nowIso);
  return result.changes;
}

export function upsertMarkTombstone(
  slug: string,
  markId: string,
  status: 'accepted' | 'rejected' | 'resolved',
  resolvedRevision: number,
): MarkTombstoneRow {
  assertWritesAllowed('upsertMarkTombstone');
  const now = new Date().toISOString();
  const ttlDays = parsePositiveInt(process.env.MARK_TOMBSTONE_RETENTION_DAYS, MARK_TOMBSTONE_RETENTION_DAYS);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  getDb().prepare(`
    INSERT OR REPLACE INTO ${MARK_TOMBSTONES_TABLE}
      (document_slug, mark_id, status, resolved_revision, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    slug,
    markId,
    status,
    Math.max(0, Math.trunc(resolvedRevision)),
    now,
    expiresAt,
  );
  return getDb().prepare(`
    SELECT document_slug, mark_id, status, resolved_revision, created_at, expires_at
    FROM ${MARK_TOMBSTONES_TABLE}
    WHERE document_slug = ? AND mark_id = ?
    LIMIT 1
  `).get(slug, markId) as MarkTombstoneRow;
}

export function getMarkTombstone(slug: string, markId: string): MarkTombstoneRow | null {
  const row = getDb().prepare(`
    SELECT document_slug, mark_id, status, resolved_revision, created_at, expires_at
    FROM ${MARK_TOMBSTONES_TABLE}
    WHERE document_slug = ? AND mark_id = ?
    LIMIT 1
  `).get(slug, markId) as MarkTombstoneRow | undefined;
  return row ?? null;
}

export function listMarkTombstonesForDocument(slug: string): MarkTombstoneRow[] {
  return getDb().prepare(`
    SELECT document_slug, mark_id, status, resolved_revision, created_at, expires_at
    FROM ${MARK_TOMBSTONES_TABLE}
    WHERE document_slug = ?
    ORDER BY resolved_revision ASC, created_at ASC
  `).all(slug) as MarkTombstoneRow[];
}

export function shouldRejectMarkMutationByResolvedRevision(
  slug: string,
  markId: string,
  candidateRevision: number | null | undefined,
): boolean {
  if (!Number.isFinite(candidateRevision)) return false;
  const tombstone = getMarkTombstone(slug, markId);
  if (!tombstone) return false;
  return Math.trunc(candidateRevision as number) <= tombstone.resolved_revision;
}

export function removeResurrectedMarksFromPayload(
  slug: string,
  marks: Record<string, unknown>,
): { marks: Record<string, unknown>; removed: string[] } {
  const markIds = Object.keys(marks);
  if (markIds.length === 0) return { marks, removed: [] };

  const placeholders = markIds.map(() => '?').join(', ');
  const rows = getDb().prepare(`
    SELECT mark_id, status
    FROM ${MARK_TOMBSTONES_TABLE}
    WHERE document_slug = ?
      AND mark_id IN (${placeholders})
      AND expires_at > ?
  `).all(slug, ...markIds, new Date().toISOString()) as Array<{
    mark_id: string;
    status: MarkTombstoneRow['status'];
  }>;
  if (rows.length === 0) return { marks, removed: [] };

  const next: Record<string, unknown> = { ...marks };
  const removed: string[] = [];
  for (const row of rows) {
    const value = next[row.mark_id];
    const isResolvedComment = row.status === 'resolved'
      && value
      && typeof value === 'object'
      && !Array.isArray(value)
      && (value as Record<string, unknown>).resolved === true;
    if (isResolvedComment) continue;
    delete next[row.mark_id];
    removed.push(row.mark_id);
  }
  return { marks: next, removed };
}

export function backfillMutationIdempotencyBatch(limit: number = 500): {
  scanned: number;
  inserted: number;
  checkpoint: number;
  done: boolean;
} {
  assertWritesAllowed('backfillMutationIdempotencyBatch');
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 5000));
  const d = getDb();
  createMetadataTableIfNeeded(d);
  const cursor = readMetadataNumber(d, MUTATION_IDEMPOTENCY_BACKFILL_CURSOR_KEY, 0);

  const rows = d.prepare(`
    SELECT rowid, idempotency_key, document_slug, route, response_json, request_hash, created_at
    FROM idempotency_keys
    WHERE rowid > ?
    ORDER BY rowid ASC
    LIMIT ?
  `).all(cursor, safeLimit) as Array<{
    rowid: number;
    idempotency_key: string;
    document_slug: string;
    route: string;
    response_json: string;
    request_hash: string | null;
    created_at: string;
  }>;

  let inserted = 0;
  let checkpoint = cursor;
  const insertStmt = d.prepare(`
    INSERT OR IGNORE INTO ${MUTATION_IDEMPOTENCY_TABLE}
      (
        idempotency_key, document_slug, route, response_json, request_hash, status_code, tombstone_revision,
        state, completed_at, lease_expires_at, last_seen_at, reservation_token, created_at
      )
    VALUES (?, ?, ?, ?, ?, 200, NULL, 'completed', ?, NULL, ?, NULL, ?)
  `);

  const tx = d.transaction(() => {
    for (const row of rows) {
      checkpoint = row.rowid;
      inserted += insertStmt.run(
        row.idempotency_key,
        row.document_slug,
        row.route,
        row.response_json,
        row.request_hash,
        row.created_at,
        row.created_at,
        row.created_at,
      ).changes;
    }
    if (rows.length > 0) {
      writeMetadataNumber(d, MUTATION_IDEMPOTENCY_BACKFILL_CURSOR_KEY, checkpoint);
    }
  });
  tx();

  if (inserted > 0) {
    recordMutationBackfill('mutation_idempotency', 'inserted', inserted);
  }
  if (rows.length - inserted > 0) {
    recordMutationBackfill('mutation_idempotency', 'skipped', rows.length - inserted);
  }

  return {
    scanned: rows.length,
    inserted,
    checkpoint,
    done: rows.length < safeLimit,
  };
}

export function backfillMutationOutboxBatch(limit: number = 500): {
  scanned: number;
  inserted: number;
  checkpoint: number;
  done: boolean;
} {
  assertWritesAllowed('backfillMutationOutboxBatch');
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 5000));
  const d = getDb();
  createMetadataTableIfNeeded(d);
  const cursor = readMetadataNumber(d, MUTATION_OUTBOX_BACKFILL_CURSOR_KEY, 0);

  const rows = d.prepare(`
    SELECT id, document_slug, document_revision, event_type, event_data, actor, idempotency_key, tombstone_revision, created_at
         , mutation_route
    FROM document_events
    WHERE id > ?
    ORDER BY id ASC
    LIMIT ?
  `).all(cursor, safeLimit) as Array<{
    id: number;
    document_slug: string;
    document_revision: number | null;
    event_type: string;
    event_data: string;
    actor: string;
    idempotency_key: string | null;
    mutation_route: string | null;
    tombstone_revision: number | null;
    created_at: string;
  }>;

  let inserted = 0;
  let checkpoint = cursor;
  const insertStmt = d.prepare(`
    INSERT OR IGNORE INTO ${MUTATION_OUTBOX_TABLE}
      (document_slug, document_revision, event_id, event_type, event_data, actor, idempotency_key, mutation_route, tombstone_revision, created_at, delivered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `);

  const tx = d.transaction(() => {
    for (const row of rows) {
      checkpoint = row.id;
      inserted += insertStmt.run(
        row.document_slug,
        row.document_revision ?? null,
        row.id,
        row.event_type,
        row.event_data,
        row.actor,
        row.idempotency_key ?? null,
        row.mutation_route ?? null,
        row.tombstone_revision ?? null,
        row.created_at,
      ).changes;
    }
    if (rows.length > 0) {
      writeMetadataNumber(d, MUTATION_OUTBOX_BACKFILL_CURSOR_KEY, checkpoint);
    }
  });
  tx();

  if (inserted > 0) {
    recordMutationBackfill('mutation_outbox', 'inserted', inserted);
  }
  if (rows.length - inserted > 0) {
    recordMutationBackfill('mutation_outbox', 'skipped', rows.length - inserted);
  }

  return {
    scanned: rows.length,
    inserted,
    checkpoint,
    done: rows.length < safeLimit,
  };
}

export function appendYUpdate(documentSlug: string, update: Uint8Array, sourceActor?: string): number {
  assertWritesAllowed('appendYUpdate');
  assertYjsUpdateWithinLimit(documentSlug, update, sourceActor ?? null);
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    INSERT INTO document_y_updates (document_slug, update_blob, source_actor, created_at)
    VALUES (?, ?, ?, ?)
  `).run(documentSlug, Buffer.from(update), sourceActor ?? null, now);
  return Number(result.lastInsertRowid);
}

export function getYUpdatesAfter(
  documentSlug: string,
  afterSeq: number,
): Array<{ seq: number; update: Uint8Array }> {
  const rows = getDb().prepare(`
    SELECT seq, update_blob
    FROM document_y_updates
    WHERE document_slug = ? AND seq > ?
    ORDER BY seq ASC
  `).all(documentSlug, afterSeq) as Array<{ seq: number; update_blob: Buffer }>;
  return rows.map((row) => ({ seq: row.seq, update: new Uint8Array(row.update_blob) }));
}

export function getYUpdatesAtOrAfter(
  documentSlug: string,
  fromSeq: number,
): Array<{ seq: number; update: Uint8Array }> {
  const rows = getDb().prepare(`
    SELECT seq, update_blob
    FROM document_y_updates
    WHERE document_slug = ? AND seq >= ?
    ORDER BY seq ASC
  `).all(documentSlug, fromSeq) as Array<{ seq: number; update_blob: Buffer }>;
  return rows.map((row) => ({ seq: row.seq, update: new Uint8Array(row.update_blob) }));
}

export function getAccumulatedYUpdateBytesAfter(
  documentSlug: string,
  afterSeq: number,
): number {
  const row = getDb().prepare(`
    SELECT COALESCE(SUM(length(update_blob)), 0) AS total_bytes
    FROM document_y_updates
    WHERE document_slug = ? AND seq > ?
  `).get(documentSlug, afterSeq) as { total_bytes?: number } | undefined;
  const totalBytes = Number(row?.total_bytes ?? 0);
  return Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0;
}

export function getYUpdatesInRange(
  documentSlug: string,
  afterSeqExclusive: number,
  upToSeqInclusive: number,
): DocumentYUpdateRow[] {
  const rows = getDb().prepare(`
    SELECT seq, update_blob, source_actor, created_at
    FROM document_y_updates
    WHERE document_slug = ? AND seq > ? AND seq <= ?
    ORDER BY seq ASC
  `).all(documentSlug, afterSeqExclusive, upToSeqInclusive) as Array<{
    seq: number;
    update_blob: Buffer;
    source_actor: string | null;
    created_at: string;
  }>;
  return rows.map((row) => ({
    seq: row.seq,
    update: new Uint8Array(row.update_blob),
    source_actor: row.source_actor ?? null,
    created_at: row.created_at,
  }));
}

export function getYUpdateMetaPage(
  documentSlug: string,
  beforeSeqExclusive: number | null,
  limit: number,
): DocumentYUpdateMetaRow[] {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  if (typeof beforeSeqExclusive === 'number' && Number.isFinite(beforeSeqExclusive)) {
    return getDb().prepare(`
      SELECT seq, source_actor, created_at
      FROM document_y_updates
      WHERE document_slug = ? AND seq < ?
      ORDER BY seq DESC
      LIMIT ?
    `).all(documentSlug, beforeSeqExclusive, safeLimit) as DocumentYUpdateMetaRow[];
  }
  return getDb().prepare(`
    SELECT seq, source_actor, created_at
    FROM document_y_updates
    WHERE document_slug = ?
    ORDER BY seq DESC
    LIMIT ?
  `).all(documentSlug, safeLimit) as DocumentYUpdateMetaRow[];
}

export function getLatestYUpdate(documentSlug: string): DocumentYUpdateRow | null {
  const row = getDb().prepare(`
    SELECT seq, update_blob, source_actor, created_at
    FROM document_y_updates
    WHERE document_slug = ?
    ORDER BY seq DESC
    LIMIT 1
  `).get(documentSlug) as {
    seq?: number;
    update_blob?: Buffer;
    source_actor?: string | null;
    created_at?: string;
  } | undefined;
  if (!row?.update_blob || row.seq === undefined || typeof row.created_at !== 'string') return null;
  return {
    seq: row.seq,
    update: new Uint8Array(row.update_blob),
    source_actor: row.source_actor ?? null,
    created_at: row.created_at,
  };
}

export function getLatestYStateVersion(documentSlug: string): number {
  const row = getDb().prepare(`
    SELECT
      COALESCE((SELECT MAX(seq) FROM document_y_updates WHERE document_slug = ?), 0) AS max_update_seq,
      COALESCE((SELECT MAX(version) FROM document_y_snapshots WHERE document_slug = ?), 0) AS max_snapshot_version
  `).get(documentSlug, documentSlug) as {
    max_update_seq?: number;
    max_snapshot_version?: number;
  } | undefined;

  const maxUpdateSeq = Number(row?.max_update_seq ?? 0);
  const maxSnapshotVersion = Number(row?.max_snapshot_version ?? 0);
  return Math.max(
    Number.isFinite(maxUpdateSeq) ? maxUpdateSeq : 0,
    Number.isFinite(maxSnapshotVersion) ? maxSnapshotVersion : 0,
  );
}

export function updateYStateBlob(slug: string, blob: Uint8Array): void {
  assertWritesAllowed('updateYStateBlob');
  getDb().prepare(
    'UPDATE documents SET y_state_blob = ? WHERE slug = ? AND share_state IN (\'ACTIVE\', \'PAUSED\')'
  ).run(Buffer.from(blob), slug);
}

export function getYStateBlob(slug: string): Uint8Array | null {
  const row = getDb().prepare(
    'SELECT y_state_blob FROM documents WHERE slug = ?'
  ).get(slug) as { y_state_blob: Buffer | null } | undefined;
  if (!row?.y_state_blob) return null;
  return new Uint8Array(row.y_state_blob);
}

export function saveYSnapshot(documentSlug: string, version: number, snapshot: Uint8Array): void {
  assertWritesAllowed('saveYSnapshot');
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT OR REPLACE INTO document_y_snapshots (document_slug, version, snapshot_blob, created_at)
    VALUES (?, ?, ?, ?)
  `).run(documentSlug, version, Buffer.from(snapshot), now);
}

export function pruneObsoleteYHistory(
  documentSlug: string,
  latestSnapshotVersion?: number | null,
): { deletedUpdates: number; deletedSnapshots: number; snapshotVersion: number } {
  assertWritesAllowed('pruneObsoleteYHistory');
  const snapshotVersion = typeof latestSnapshotVersion === 'number' && Number.isFinite(latestSnapshotVersion)
    ? Math.max(0, Math.trunc(latestSnapshotVersion))
    : (getLatestYSnapshot(documentSlug)?.version ?? 0);

  if (snapshotVersion <= 0) {
    return {
      deletedUpdates: 0,
      deletedSnapshots: 0,
      snapshotVersion: 0,
    };
  }

  const d = getDb();
  const deletedUpdates = d.prepare(`
    DELETE FROM document_y_updates
    WHERE document_slug = ? AND seq < ?
  `).run(documentSlug, snapshotVersion).changes;
  const deletedSnapshots = d.prepare(`
    DELETE FROM document_y_snapshots
    WHERE document_slug = ? AND version < ?
  `).run(documentSlug, snapshotVersion).changes;

  return {
    deletedUpdates,
    deletedSnapshots,
    snapshotVersion,
  };
}

export function getLatestYSnapshot(documentSlug: string): { version: number; snapshot: Uint8Array } | null {
  const row = getDb().prepare(`
    SELECT version, snapshot_blob
    FROM document_y_snapshots
    WHERE document_slug = ?
    ORDER BY version DESC
    LIMIT 1
  `).get(documentSlug) as { version?: number; snapshot_blob?: Buffer } | undefined;
  if (!row?.snapshot_blob || row.version === undefined) return null;
  return {
    version: row.version,
    snapshot: new Uint8Array(row.snapshot_blob),
  };
}

export function getLatestYSnapshotAtOrBefore(documentSlug: string, seq: number): DocumentYSnapshotRow | null {
  const row = getDb().prepare(`
    SELECT version, snapshot_blob, created_at
    FROM document_y_snapshots
    WHERE document_slug = ? AND version <= ?
    ORDER BY version DESC
    LIMIT 1
  `).get(documentSlug, seq) as { version?: number; snapshot_blob?: Buffer; created_at?: string } | undefined;
  if (!row?.snapshot_blob || row.version === undefined || typeof row.created_at !== 'string') return null;
  return {
    version: row.version,
    snapshot: new Uint8Array(row.snapshot_blob),
    created_at: row.created_at,
  };
}

export function getSnapshotVersionsForSeqs(documentSlug: string, seqs: number[]): Set<number> {
  const uniqueSeqs = Array.from(new Set(seqs.filter((value) => Number.isFinite(value) && value > 0)));
  if (uniqueSeqs.length === 0) return new Set<number>();
  const placeholders = uniqueSeqs.map(() => '?').join(', ');
  const rows = getDb().prepare(`
    SELECT version
    FROM document_y_snapshots
    WHERE document_slug = ? AND version IN (${placeholders})
  `).all(documentSlug, ...uniqueSeqs) as Array<{ version: number }>;
  return new Set(rows.map((row) => row.version));
}

export function listDocumentEventsInTimeRange(
  slug: string,
  fromIsoInclusive: string,
  toIsoInclusive: string,
): DocumentEventRow[] {
  return getDb().prepare(`
    SELECT *
    FROM document_events
    WHERE document_slug = ? AND created_at >= ? AND created_at <= ?
    ORDER BY created_at ASC, id ASC
  `).all(slug, fromIsoInclusive, toIsoInclusive) as DocumentEventRow[];
}

function stringifyServerIncidentData(data: Record<string, unknown> | null | undefined): string {
  try {
    return JSON.stringify(data ?? {});
  } catch {
    return JSON.stringify({ serializationError: true });
  }
}

export function recordServerIncidentEvent(input: ServerIncidentEventInput): number {
  assertWritesAllowed('server_incident_events.insert');
  const createdAt = typeof input.timestamp === 'string' && input.timestamp.trim()
    ? input.timestamp.trim()
    : new Date().toISOString();
  const result = getDb().prepare(`
    INSERT INTO server_incident_events (
      request_id,
      slug,
      subsystem,
      level,
      event_type,
      message,
      data_json,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.requestId?.trim() || null,
    input.slug?.trim() || null,
    input.subsystem,
    input.level,
    input.eventType,
    input.message,
    stringifyServerIncidentData(input.data),
    createdAt,
  );
  return Number(result.lastInsertRowid);
}

export function listServerIncidentEventsByRequestId(
  requestId: string,
  limit: number = 250,
): ServerIncidentEventRow[] {
  const normalized = requestId.trim();
  if (!normalized) return [];
  const safeLimit = Math.max(1, Math.min(limit, 1000));
  return getDb().prepare(`
    SELECT *
    FROM server_incident_events
    WHERE request_id = ?
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).all(normalized, safeLimit) as ServerIncidentEventRow[];
}

export function listServerIncidentEventsInTimeRange(
  slug: string,
  fromIsoInclusive: string,
  toIsoInclusive: string,
  limit: number = 250,
): ServerIncidentEventRow[] {
  const safeLimit = Math.max(1, Math.min(limit, 1000));
  return getDb().prepare(`
    SELECT *
    FROM server_incident_events
    WHERE slug = ? AND created_at >= ? AND created_at <= ?
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).all(slug, fromIsoInclusive, toIsoInclusive, safeLimit) as ServerIncidentEventRow[];
}

export type DocumentBaselineCandidate = {
  slug: string;
  markdown: string;
  marks: string;
};

export type StaleProjectionCandidate = {
  slug: string;
  y_state_version: number;
  latest_y_state_version: number;
  projection_health: DocumentProjectionRow['health'];
  updated_at: string;
};

export type SuspiciousProjectionCandidate = {
  slug: string;
  updated_at: string;
  markdown_chars: number;
  y_state_version: number;
  latest_y_state_version: number;
  projection_health: DocumentProjectionRow['health'];
};

export function listDocumentsMissingYjsState(limit: number = 500): DocumentBaselineCandidate[] {
  const safeLimit = Math.max(1, Math.min(limit, 10_000));
  return getDb().prepare(`
    SELECT d.slug, d.markdown, d.marks
    FROM documents d
    WHERE d.share_state != 'DELETED'
      AND NOT EXISTS (
        SELECT 1 FROM document_y_updates u
        WHERE u.document_slug = d.slug
      )
      AND NOT EXISTS (
        SELECT 1 FROM document_y_snapshots s
        WHERE s.document_slug = d.slug
      )
    ORDER BY d.created_at ASC
    LIMIT ?
  `).all(safeLimit) as DocumentBaselineCandidate[];
}

export function listDocsWithStaleProjection(limit: number = 100): StaleProjectionCandidate[] {
  const safeLimit = Math.max(1, Math.min(limit, 1000));
  return getDb().prepare(`
    WITH latest AS (
      SELECT
        d.slug AS slug,
        d.updated_at AS updated_at,
        (
          SELECT MAX(value)
          FROM (
            SELECT COALESCE(MAX(u.seq), 0) AS value
            FROM document_y_updates u
            WHERE u.document_slug = d.slug
            UNION ALL
            SELECT COALESCE(MAX(s.version), 0) AS value
            FROM document_y_snapshots s
            WHERE s.document_slug = d.slug
          )
        ) AS latest_y_state_version
      FROM documents d
      WHERE d.share_state IN ('ACTIVE', 'PAUSED')
    )
    SELECT
      latest.slug,
      COALESCE(p.y_state_version, 0) AS y_state_version,
      latest.latest_y_state_version,
      COALESCE(p.health, 'projection_stale') AS projection_health,
      latest.updated_at
    FROM latest
    LEFT JOIN document_projections p
      ON p.document_slug = latest.slug
    WHERE latest.latest_y_state_version > COALESCE(p.y_state_version, 0)
       OR COALESCE(p.health, 'projection_stale') != 'healthy'
    ORDER BY latest.updated_at DESC
    LIMIT ?
  `).all(safeLimit) as StaleProjectionCandidate[];
}

export function listSuspiciousProjectionCandidates(
  limit: number = 100,
  minMarkdownChars: number = 1_000_000,
): SuspiciousProjectionCandidate[] {
  const safeLimit = Math.max(1, Math.min(limit, 1000));
  const safeMinChars = Math.max(1_000, Math.min(Math.trunc(minMarkdownChars), 100_000_000));
  return getDb().prepare(`
    WITH latest AS (
      SELECT
        d.slug AS slug,
        d.updated_at AS updated_at,
        (
          SELECT MAX(value)
          FROM (
            SELECT COALESCE(MAX(u.seq), 0) AS value
            FROM document_y_updates u
            WHERE u.document_slug = d.slug
            UNION ALL
            SELECT COALESCE(MAX(s.version), 0) AS value
            FROM document_y_snapshots s
            WHERE s.document_slug = d.slug
          )
        ) AS latest_y_state_version
      FROM documents d
      WHERE d.share_state IN ('ACTIVE', 'PAUSED')
    )
    SELECT
      latest.slug,
      latest.updated_at,
      LENGTH(COALESCE(p.markdown, d.markdown)) AS markdown_chars,
      COALESCE(p.y_state_version, 0) AS y_state_version,
      latest.latest_y_state_version,
      COALESCE(p.health, 'projection_stale') AS projection_health
    FROM latest
    JOIN documents d
      ON d.slug = latest.slug
    LEFT JOIN document_projections p
      ON p.document_slug = latest.slug
    WHERE LENGTH(COALESCE(p.markdown, d.markdown)) >= ?
       OR latest.latest_y_state_version > COALESCE(p.y_state_version, 0)
       OR COALESCE(p.health, 'projection_stale') != 'healthy'
    ORDER BY markdown_chars DESC, latest.updated_at DESC
    LIMIT ?
  `).all(safeMinChars, safeLimit) as SuspiciousProjectionCandidate[];
}

export function clearYjsState(documentSlug: string): { clearedUpdates: number; clearedSnapshots: number } {
  assertWritesAllowed('clearYjsState');
  const d = getDb();
  const tx = d.transaction(() => {
    const clearedUpdates = d.prepare(`
      DELETE FROM document_y_updates
      WHERE document_slug = ?
    `).run(documentSlug).changes;
    const clearedSnapshots = d.prepare(`
      DELETE FROM document_y_snapshots
      WHERE document_slug = ?
    `).run(documentSlug).changes;
    d.prepare(`
      UPDATE documents
      SET y_state_version = 0
      WHERE slug = ?
    `).run(documentSlug);
    return { clearedUpdates, clearedSnapshots };
  });
  return tx();
}

export function hasMaintenanceRun(runKey: string): boolean {
  const row = getDb()
    .prepare('SELECT run_key FROM maintenance_runs WHERE run_key = ?')
    .get(runKey) as { run_key?: string } | undefined;
  return Boolean(row?.run_key);
}

export function recordMaintenanceRun(runKey: string, summary?: unknown): void {
  assertWritesAllowed('recordMaintenanceRun');
  const now = new Date().toISOString();
  const encodedSummary = summary === undefined ? null : JSON.stringify(summary);
  getDb()
    .prepare(`
      INSERT OR REPLACE INTO maintenance_runs (run_key, completed_at, summary)
      VALUES (?, ?, ?)
    `)
    .run(runKey, now, encodedSummary);
}

export function createShareAuthSession(input: {
  sessionToken: string;
  provider?: string;
  everyUserId: number;
  email: string;
  name?: string | null;
  subscriber?: boolean;
  accessToken: string;
  refreshToken?: string | null;
  accessExpiresAt: string;
  sessionExpiresAt: string;
}): ShareAuthSessionRow {
  assertWritesAllowed('createShareAuthSession');
  const now = new Date().toISOString();
  const provider = input.provider ?? 'every';
  const hash = hashSecret(input.sessionToken);
  getDb().prepare(`
    INSERT OR REPLACE INTO share_auth_sessions (
      session_token_hash, provider, every_user_id, email, name, subscriber,
      access_token, refresh_token, access_expires_at, session_expires_at,
      last_verified_at, revoked_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(
    hash,
    provider,
    input.everyUserId,
    input.email,
    input.name ?? null,
    input.subscriber === false ? 0 : 1,
    input.accessToken,
    input.refreshToken ?? null,
    input.accessExpiresAt,
    input.sessionExpiresAt,
    now,
    now,
    now,
  );
  return getDb().prepare(`
    SELECT *
    FROM share_auth_sessions
    WHERE session_token_hash = ?
    LIMIT 1
  `).get(hash) as ShareAuthSessionRow;
}

export function getShareAuthSession(sessionToken: string): ShareAuthSessionRow | null {
  if (!sessionToken) return null;
  const hash = hashSecret(sessionToken);
  const row = getDb().prepare(`
    SELECT *
    FROM share_auth_sessions
    WHERE session_token_hash = ?
    LIMIT 1
  `).get(hash) as ShareAuthSessionRow | undefined;
  return row ?? null;
}

export function updateShareAuthSessionTokens(input: {
  sessionToken: string;
  accessToken: string;
  refreshToken?: string | null;
  accessExpiresAt: string;
}): boolean {
  assertWritesAllowed('updateShareAuthSessionTokens');
  const now = new Date().toISOString();
  const hash = hashSecret(input.sessionToken);
  const result = getDb().prepare(`
    UPDATE share_auth_sessions
    SET access_token = ?, refresh_token = ?, access_expires_at = ?, updated_at = ?, revoked_at = NULL
    WHERE session_token_hash = ?
  `).run(
    input.accessToken,
    input.refreshToken ?? null,
    input.accessExpiresAt,
    now,
    hash,
  );
  return result.changes > 0;
}

export function touchShareAuthSessionVerification(input: {
  sessionToken: string;
  email?: string | null;
  name?: string | null;
  subscriber?: boolean;
  sessionExpiresAt?: string;
}): boolean {
  assertWritesAllowed('touchShareAuthSessionVerification');
  const now = new Date().toISOString();
  const hash = hashSecret(input.sessionToken);
  const subscriberValue = input.subscriber === undefined ? null : (input.subscriber ? 1 : 0);
  const result = subscriberValue === null
    ? getDb().prepare(`
      UPDATE share_auth_sessions
      SET
        email = COALESCE(?, email),
        name = COALESCE(?, name),
        session_expires_at = COALESCE(?, session_expires_at),
        last_verified_at = ?,
        updated_at = ?
      WHERE session_token_hash = ?
    `).run(
      input.email ?? null,
      input.name ?? null,
      input.sessionExpiresAt ?? null,
      now,
      now,
      hash,
    )
    : getDb().prepare(`
      UPDATE share_auth_sessions
      SET
        email = COALESCE(?, email),
        name = COALESCE(?, name),
        subscriber = ?,
        session_expires_at = COALESCE(?, session_expires_at),
        last_verified_at = ?,
        updated_at = ?,
        revoked_at = NULL
      WHERE session_token_hash = ?
    `).run(
      input.email ?? null,
      input.name ?? null,
      subscriberValue,
      input.sessionExpiresAt ?? null,
      now,
      now,
      hash,
    );
  return result.changes > 0;
}

export function revokeShareAuthSession(sessionToken: string): boolean {
  assertWritesAllowed('revokeShareAuthSession');
  const now = new Date().toISOString();
  const hash = hashSecret(sessionToken);
  const result = getDb().prepare(`
    UPDATE share_auth_sessions
    SET revoked_at = ?, updated_at = ?
    WHERE session_token_hash = ?
  `).run(now, now, hash);
  return result.changes > 0;
}

// ── User Document Visits (dashboard) ──────────────────────────────────────────

export function upsertUserDocumentVisit(everyUserId: number, slug: string, role?: string): void {
  assertWritesAllowed('upsertUserDocumentVisit');
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO user_document_visits (every_user_id, document_slug, role, first_visited_at, last_visited_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (every_user_id, document_slug) DO UPDATE SET
      last_visited_at = excluded.last_visited_at,
      role = COALESCE(excluded.role, user_document_visits.role)
  `).run(everyUserId, slug, role ?? null, now, now);
}

export function getLibraryDocumentSlug(everyUserId: number): string | null {
  const row = getDb()
    .prepare('SELECT document_slug FROM library_documents WHERE every_user_id = ? LIMIT 1')
    .get(everyUserId) as { document_slug: string } | undefined;
  return row?.document_slug ?? null;
}

export function upsertLibraryDocument(everyUserId: number, slug: string): void {
  assertWritesAllowed('upsertLibraryDocument');
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO library_documents (every_user_id, document_slug, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (every_user_id) DO UPDATE SET
      document_slug = excluded.document_slug,
      updated_at = excluded.updated_at
  `).run(everyUserId, slug, now, now);
}

export function listDocumentVisitUserIds(slug: string, limit: number = 200): number[] {
  const rows = getDb().prepare(`
    SELECT every_user_id
    FROM user_document_visits
    WHERE document_slug = ?
    ORDER BY last_visited_at DESC
    LIMIT ?
  `).all(slug, limit) as Array<{ every_user_id: number }>;
  return rows.map((row) => row.every_user_id);
}

export interface DashboardDocumentRow {
  slug: string;
  title: string | null;
  share_state: string;
  updated_at: string;
  created_at: string;
  last_visited_at?: string;
  is_owned?: number;
  copy_url?: string;
}

export function listUserOwnedDocuments(everyUserId: number, limit: number = 50): DashboardDocumentRow[] {
  const asStr = String(everyUserId);
  return getDb().prepare(`
    SELECT slug, title, share_state, updated_at, created_at
    FROM documents
    WHERE (owner_id = ? OR owner_id = ? OR owner_id = ?)
      AND deleted_at IS NULL
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(asStr, `every:${asStr}`, `every_user:${asStr}`, limit) as DashboardDocumentRow[];
}

export function listSharedWithMeDocuments(everyUserId: number, limit: number = 50): DashboardDocumentRow[] {
  const asStr = String(everyUserId);
  return getDb().prepare(`
    SELECT d.slug, d.title, d.share_state, d.updated_at, d.created_at, v.last_visited_at
    FROM user_document_visits v
    JOIN documents d ON d.slug = v.document_slug
    WHERE v.every_user_id = ?
      AND d.deleted_at IS NULL
      AND d.share_state != 'DELETED'
      AND (d.owner_id IS NULL OR (d.owner_id != ? AND d.owner_id != ? AND d.owner_id != ?))
    ORDER BY v.last_visited_at DESC
    LIMIT ?
  `).all(everyUserId, asStr, `every:${asStr}`, `every_user:${asStr}`, limit) as DashboardDocumentRow[];
}

export function listRecentlyOpenedDocuments(everyUserId: number, limit: number = 50): DashboardDocumentRow[] {
  const asStr = String(everyUserId);
  return getDb().prepare(`
    SELECT d.slug, d.title, d.share_state, d.updated_at, d.created_at, v.last_visited_at,
      CASE
        WHEN (d.owner_id = ? OR d.owner_id = ? OR d.owner_id = ?) THEN 1
        ELSE 0
      END AS is_owned
    FROM user_document_visits v
    JOIN documents d ON d.slug = v.document_slug
    WHERE v.every_user_id = ?
      AND d.deleted_at IS NULL
      AND d.share_state != 'DELETED'
    ORDER BY v.last_visited_at DESC
    LIMIT ?
  `).all(asStr, `every:${asStr}`, `every_user:${asStr}`, everyUserId, limit) as DashboardDocumentRow[];
}

export function listDashboardDocuments(everyUserId: number, limit: number = 100): DashboardDocumentRow[] {
  const asStr = String(everyUserId);
  return getDb().prepare(`
    SELECT slug, title, share_state, updated_at, created_at, last_visited_at, is_owned
    FROM (
      SELECT
        d.slug,
        d.title,
        d.share_state,
        d.updated_at,
        d.created_at,
        NULL AS last_visited_at,
        1 AS is_owned,
        d.updated_at AS sort_at
      FROM documents d
      WHERE (d.owner_id = ? OR d.owner_id = ? OR d.owner_id = ?)
        AND d.deleted_at IS NULL

      UNION ALL

      SELECT
        d.slug,
        d.title,
        d.share_state,
        d.updated_at,
        d.created_at,
        v.last_visited_at AS last_visited_at,
        0 AS is_owned,
        COALESCE(v.last_visited_at, d.updated_at) AS sort_at
      FROM user_document_visits v
      JOIN documents d ON d.slug = v.document_slug
      WHERE v.every_user_id = ?
        AND d.deleted_at IS NULL
        AND d.share_state = 'ACTIVE'
        AND (d.owner_id IS NULL OR (d.owner_id != ? AND d.owner_id != ? AND d.owner_id != ?))
    )
    ORDER BY sort_at DESC
    LIMIT ?
  `).all(
    asStr,
    `every:${asStr}`,
    `every_user:${asStr}`,
    everyUserId,
    asStr,
    `every:${asStr}`,
    `every_user:${asStr}`,
    limit,
  ) as DashboardDocumentRow[];
}

export function updateDocumentOwnerId(slug: string, ownerId: string): boolean {
  assertWritesAllowed('updateDocumentOwnerId');
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    UPDATE documents
    SET owner_id = ?, updated_at = ?
    WHERE slug = ? AND (owner_id IS NULL OR owner_id = '')
  `).run(ownerId, now, slug);
  return result.changes > 0;
}


// ============================================================================
// Proof Documents Step 1: line marks
// ============================================================================

export interface DocumentLineMarkRow {
  id: string;
  document_slug: string;
  by_actor: string;
  actor_key: string;
  status: string;
  reason: string | null;
  line_hash: string;
  line_occurrence: number;
  line_ordinal: number;
  line_kind: string;
  line_excerpt: string;
  created_at: string;
  updated_at: string;
  /** Step B3b (null on older rows). */
  via?: string | null;
  line_text?: string | null;
  /** Step B4c: an AI's rationale (null on older rows). */
  why?: string | null;
  /** Proxy marks step: what the marker checked; a ratified proxy's origin (JSON). */
  evidence?: string | null;
  proxy_json?: string | null;
}

export function listDocumentLineMarks(slug: string): DocumentLineMarkRow[] {
  return getDb().prepare(`
    SELECT * FROM document_line_marks WHERE document_slug = ? ORDER BY updated_at ASC, id ASC
  `).all(slug) as DocumentLineMarkRow[];
}

/**
 * Replace the given actor's marks (ids in replaceIds, plus any on the same anchor) with one new
 * mark, or only delete them when next is null. Returns the ids removed.
 */
export function replaceDocumentLineMark(input: {
  slug: string;
  actorKey: string;
  replaceIds: string[];
  /** Further anchors whose marks by this actor are replaced (a line's text before an edit). */
  replaceAnchors?: Array<{ hash: string; occurrence: number }>;
  anchor: { hash: string; occurrence: number };
  next: Omit<DocumentLineMarkRow, 'document_slug' | 'actor_key' | 'created_at' | 'updated_at'> & { at: string; created_at?: string } | null;
}): string[] {
  assertWritesAllowed('replaceDocumentLineMark');
  const d = getDb();
  const tx = d.transaction(() => {
    const removed: string[] = [];
    const byAnchor = d.prepare(`
      SELECT id FROM document_line_marks
      WHERE document_slug = ? AND actor_key = ? AND line_hash = ? AND line_occurrence = ?
    `);
    const ids = new Set(input.replaceIds);
    for (const anchor of [input.anchor, ...(input.replaceAnchors ?? [])]) {
      for (const row of byAnchor.all(input.slug, input.actorKey, anchor.hash, anchor.occurrence) as Array<{ id: string }>) ids.add(row.id);
    }
    const del = d.prepare(`DELETE FROM document_line_marks WHERE document_slug = ? AND actor_key = ? AND id = ?`);
    for (const id of ids) {
      if (del.run(input.slug, input.actorKey, id).changes > 0) removed.push(id);
    }
    if (input.next) {
      const n = input.next;
      d.prepare(`
        INSERT INTO document_line_marks (
          id, document_slug, by_actor, actor_key, status, reason, line_hash, line_occurrence,
          line_ordinal, line_kind, line_excerpt, created_at, updated_at, via, line_text, why, evidence, proxy_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(n.id, input.slug, n.by_actor, input.actorKey, n.status, n.reason, n.line_hash, n.line_occurrence,
        n.line_ordinal, n.line_kind, n.line_excerpt, n.created_at ?? n.at, n.at, n.via ?? null, n.line_text ?? null, n.why ?? null,
        n.evidence ?? null, n.proxy_json ?? null);
    }
    return removed;
  });
  return tx();
}


// ============================================================================
// Proof Documents Step B3c: aligned snapshots
// ============================================================================

export interface DocumentAlignedSnapshotRow {
  id: string;
  document_slug: string;
  created_at: string;
  fingerprint: string;
  markdown: string;
  payload: string;
}

export function latestAlignedSnapshot(slug: string): DocumentAlignedSnapshotRow | undefined {
  return getDb().prepare(`
    SELECT * FROM document_aligned_snapshots WHERE document_slug = ? ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(slug) as DocumentAlignedSnapshotRow | undefined;
}

export function listAlignedSnapshots(slug: string, limit = 50): DocumentAlignedSnapshotRow[] {
  return getDb().prepare(`
    SELECT * FROM document_aligned_snapshots WHERE document_slug = ? ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(slug, Math.max(1, Math.min(limit, 500))) as DocumentAlignedSnapshotRow[];
}

export function getAlignedSnapshot(slug: string, id: string): DocumentAlignedSnapshotRow | undefined {
  return getDb().prepare(`SELECT * FROM document_aligned_snapshots WHERE document_slug = ? AND id = ?`)
    .get(slug, id) as DocumentAlignedSnapshotRow | undefined;
}

/** Inserts a snapshot and keeps only the newest `keep` for the document. */
export function insertAlignedSnapshot(row: DocumentAlignedSnapshotRow, keep: number): void {
  assertWritesAllowed('insertAlignedSnapshot');
  const d = getDb();
  d.transaction(() => {
    d.prepare(`
      INSERT INTO document_aligned_snapshots (id, document_slug, created_at, fingerprint, markdown, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(row.id, row.document_slug, row.created_at, row.fingerprint, row.markdown, row.payload);
    d.prepare(`
      DELETE FROM document_aligned_snapshots WHERE document_slug = ? AND id NOT IN (
        SELECT id FROM document_aligned_snapshots WHERE document_slug = ? ORDER BY created_at DESC, id DESC LIMIT ?
      )
    `).run(row.document_slug, row.document_slug, Math.max(1, keep));
  })();
}

// ============================================================================
// Proof Documents Step B3: asks
// ============================================================================

export interface DocumentAskRow {
  id: string;
  document_slug: string;
  by_actor: string;
  to_json: string;
  recommend: string;
  if_yes: string | null;
  line_hash: string;
  line_occurrence: number;
  line_ordinal: number;
  line_kind: string;
  line_excerpt: string;
  created_at: string;
  asked_at: string;
  withdrawn_at: string | null;
}

export interface DocumentAskAnswerRow {
  id: string;
  ask_id: string;
  document_slug: string;
  by_actor: string;
  choice: string;
  words: string;
  line_hash: string;
  created_at: string;
}

export function listDocumentAsks(slug: string, options: { includeWithdrawn?: boolean } = {}): DocumentAskRow[] {
  return getDb().prepare(`
    SELECT * FROM document_asks WHERE document_slug = ? ${options.includeWithdrawn ? '' : 'AND withdrawn_at IS NULL'}
    ORDER BY created_at ASC, id ASC
  `).all(slug) as DocumentAskRow[];
}

export function getDocumentAsk(slug: string, id: string): DocumentAskRow | undefined {
  return getDb().prepare(`SELECT * FROM document_asks WHERE document_slug = ? AND id = ?`).get(slug, id) as DocumentAskRow | undefined;
}

export function listDocumentAskAnswers(slug: string): DocumentAskAnswerRow[] {
  return getDb().prepare(`
    SELECT * FROM document_ask_answers WHERE document_slug = ? ORDER BY created_at ASC, id ASC
  `).all(slug) as DocumentAskAnswerRow[];
}

export function insertDocumentAsk(row: DocumentAskRow): void {
  assertWritesAllowed('insertDocumentAsk');
  getDb().prepare(`
    INSERT INTO document_asks (
      id, document_slug, by_actor, to_json, recommend, if_yes, line_hash, line_occurrence, line_ordinal,
      line_kind, line_excerpt, created_at, asked_at, withdrawn_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.document_slug, row.by_actor, row.to_json, row.recommend, row.if_yes, row.line_hash, row.line_occurrence,
    row.line_ordinal, row.line_kind, row.line_excerpt, row.created_at, row.asked_at, row.withdrawn_at);
}

export function insertDocumentAskAnswer(row: DocumentAskAnswerRow): void {
  assertWritesAllowed('insertDocumentAskAnswer');
  getDb().prepare(`
    INSERT INTO document_ask_answers (id, ask_id, document_slug, by_actor, choice, words, line_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.ask_id, row.document_slug, row.by_actor, row.choice, row.words, row.line_hash, row.created_at);
}

/**
 * Undo of an answer (Mike, 2026-09-19: "Undo is needed for every user change"). Removes one
 * answer, by id, only when it belongs to `by_actor` — the route checks that it is the newest one.
 */
export function deleteDocumentAskAnswer(slug: string, id: string, byActor: string): number {
  assertWritesAllowed('deleteDocumentAskAnswer');
  return getDb().prepare(`
    DELETE FROM document_ask_answers WHERE document_slug = ? AND id = ? AND by_actor = ?
  `).run(slug, id, byActor).changes;
}

/** The ask follows its line: store the line's current anchor (after an edit or a move). */
export function updateDocumentAskAnchor(slug: string, id: string, anchor: { hash: string; occurrence: number; ordinal: number; kind: string; excerpt: string }): void {
  assertWritesAllowed('updateDocumentAskAnchor');
  getDb().prepare(`
    UPDATE document_asks SET line_hash = ?, line_occurrence = ?, line_ordinal = ?, line_kind = ?, line_excerpt = ?
    WHERE document_slug = ? AND id = ?
  `).run(anchor.hash, anchor.occurrence, anchor.ordinal, anchor.kind, anchor.excerpt, slug, id);
}

export function updateDocumentAskFields(slug: string, id: string, fields: { asked_at?: string; withdrawn_at?: string | null; recommend?: string; if_yes?: string | null; to_json?: string }): void {
  assertWritesAllowed('updateDocumentAskFields');
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    sets.push(`${key} = ?`);
    values.push(value);
  }
  if (sets.length === 0) return;
  getDb().prepare(`UPDATE document_asks SET ${sets.join(', ')} WHERE document_slug = ? AND id = ?`).run(...values, slug, id);
}
