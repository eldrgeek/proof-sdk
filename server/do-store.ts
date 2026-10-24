/**
 * Proof Documents `{do}` action lines — storage (safe slice, 2026-09-18).
 *
 * Authorship: Claude Opus 5 (worker proof-do). Tables are created in server/db.ts initDatabase.
 * Reads and writes rows only; imports only the db and shared code, so server/line-marks.ts can
 * read `{do}` lines for the Issue report without an import cycle. Nothing here writes
 * document_do_runs: runs exist only once execution is enabled in an attended session.
 */
import { assertWritesAllowed, getDb } from './db.js';
import type { LineAnchor } from '../src/shared/line-marks.js';
import type { DoAction, DoApproval, DoReceipt, DoRun, ProofDo } from '../src/shared/do.js';

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

interface DoRow {
  id: string;
  document_slug: string;
  by_actor: string;
  to_json: string;
  presser: string;
  retry_budget: number;
  action_json: string;
  line_hash: string;
  line_occurrence: number;
  line_ordinal: number;
  line_kind: string;
  line_excerpt: string;
  created_at: string;
  withdrawn_at: string | null;
}

interface ApprovalRow {
  id: string;
  do_id: string;
  document_slug: string;
  by_actor: string;
  digest: string;
  source: string;
  created_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

interface RunRow {
  id: string;
  do_id: string;
  approval_id: string;
  attempt: number;
  digest: string;
  presser: string;
  started_at: string;
  receipts_json: string;
}

function rowToApproval(row: ApprovalRow): DoApproval {
  return { id: row.id, by: row.by_actor, at: row.created_at, digest: row.digest, source: row.source, revokedAt: row.revoked_at, revokedBy: row.revoked_by };
}

function rowToRun(row: RunRow): DoRun {
  return {
    id: row.id, attempt: row.attempt, approvalId: row.approval_id, digest: row.digest, presser: row.presser,
    startedAt: row.started_at, receipts: parseJson<DoReceipt[]>(row.receipts_json, []),
  };
}

function rowToDo(row: DoRow, approvals: DoApproval[], runs: DoRun[]): ProofDo {
  const anchor: LineAnchor = { hash: row.line_hash, occurrence: row.line_occurrence, ordinal: row.line_ordinal, kind: row.line_kind, excerpt: row.line_excerpt ?? '' };
  return {
    id: row.id,
    by: row.by_actor,
    to: parseJson<unknown[]>(row.to_json, []).filter((v): v is string => typeof v === 'string'),
    presser: row.presser || 'approver',
    retryBudget: Number.isInteger(row.retry_budget) ? row.retry_budget : 0,
    action: parseJson<DoAction>(row.action_json, {} as DoAction),
    anchor,
    createdAt: row.created_at,
    withdrawnAt: row.withdrawn_at,
    approvals,
    runs,
  };
}

/** Every `{do}` in the document (withdrawn ones only with includeWithdrawn), with approvals and runs. */
export function listDos(slug: string, options: { includeWithdrawn?: boolean } = {}): ProofDo[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM document_dos WHERE document_slug = ? ${options.includeWithdrawn ? '' : 'AND withdrawn_at IS NULL'} ORDER BY created_at ASC, id ASC`).all(slug) as DoRow[];
  if (!rows.length) return [];
  const approvals = new Map<string, DoApproval[]>();
  for (const row of db.prepare(`SELECT * FROM document_do_approvals WHERE document_slug = ? ORDER BY created_at ASC, id ASC`).all(slug) as ApprovalRow[]) {
    const list = approvals.get(row.do_id) ?? [];
    list.push(rowToApproval(row));
    approvals.set(row.do_id, list);
  }
  const runs = new Map<string, DoRun[]>();
  for (const row of db.prepare(`SELECT * FROM document_do_runs WHERE document_slug = ? ORDER BY attempt ASC`).all(slug) as RunRow[]) {
    const list = runs.get(row.do_id) ?? [];
    list.push(rowToRun(row));
    runs.set(row.do_id, list);
  }
  return rows.map(row => rowToDo(row, approvals.get(row.id) ?? [], runs.get(row.id) ?? []));
}

export function getDo(slug: string, id: string): ProofDo | null {
  return listDos(slug, { includeWithdrawn: true }).find(record => record.id === id) ?? null;
}

export function insertDo(slug: string, record: ProofDo): void {
  assertWritesAllowed('insertDo');
  getDb().prepare(`
    INSERT INTO document_dos (id, document_slug, by_actor, to_json, presser, retry_budget, action_json,
      line_hash, line_occurrence, line_ordinal, line_kind, line_excerpt, created_at, withdrawn_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(record.id, slug, record.by, JSON.stringify(record.to), record.presser, record.retryBudget, JSON.stringify(record.action),
    record.anchor.hash, record.anchor.occurrence, record.anchor.ordinal, record.anchor.kind, record.anchor.excerpt, record.createdAt);
}

export function updateDoAnchor(slug: string, id: string, anchor: LineAnchor): void {
  assertWritesAllowed('updateDoAnchor');
  getDb().prepare(`UPDATE document_dos SET line_hash = ?, line_occurrence = ?, line_ordinal = ?, line_kind = ?, line_excerpt = ? WHERE document_slug = ? AND id = ?`)
    .run(anchor.hash, anchor.occurrence, anchor.ordinal, anchor.kind, anchor.excerpt, slug, id);
}

/** A new action revision (or presser / retry budget / to). The digest changes, so approvals stop counting. */
export function updateDoFields(slug: string, id: string, fields: { action?: DoAction; presser?: string; retryBudget?: number; to?: string[] }): void {
  assertWritesAllowed('updateDoFields');
  const sets: string[] = [];
  const values: unknown[] = [];
  if (fields.action) { sets.push('action_json = ?'); values.push(JSON.stringify(fields.action)); }
  if (fields.presser !== undefined) { sets.push('presser = ?'); values.push(fields.presser); }
  if (fields.retryBudget !== undefined) { sets.push('retry_budget = ?'); values.push(fields.retryBudget); }
  if (fields.to) { sets.push('to_json = ?'); values.push(JSON.stringify(fields.to)); }
  if (!sets.length) return;
  getDb().prepare(`UPDATE document_dos SET ${sets.join(', ')} WHERE document_slug = ? AND id = ?`).run(...values, slug, id);
}

export function withdrawDoRow(slug: string, id: string, at: string): boolean {
  assertWritesAllowed('withdrawDoRow');
  return getDb().prepare(`UPDATE document_dos SET withdrawn_at = ? WHERE document_slug = ? AND id = ? AND withdrawn_at IS NULL`).run(at, slug, id).changes > 0;
}

export function insertDoApproval(slug: string, doId: string, approval: DoApproval): void {
  assertWritesAllowed('insertDoApproval');
  getDb().prepare(`
    INSERT INTO document_do_approvals (id, do_id, document_slug, by_actor, digest, source, created_at, revoked_at, revoked_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
  `).run(approval.id, doId, slug, approval.by, approval.digest, approval.source, approval.at);
}

/** Revokes every live approval of one `{do}`. Returns how many it revoked. */
export function revokeDoApprovals(slug: string, doId: string, by: string, at: string): number {
  assertWritesAllowed('revokeDoApprovals');
  return getDb().prepare(`UPDATE document_do_approvals SET revoked_at = ?, revoked_by = ? WHERE document_slug = ? AND do_id = ? AND revoked_at IS NULL`)
    .run(at, by, slug, doId).changes;
}
