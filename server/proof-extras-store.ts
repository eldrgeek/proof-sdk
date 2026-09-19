/**
 * Proof Documents Steps B4e + B4f — storage for review bundles, competing alternatives and picks,
 * per-document settings (blind marking), Explain threads and line times-to-live.
 *
 * Authorship: built by Claude Opus 5 (worker proof-bundles), 2026-09-19, for the COS's brief
 * "B4e review bundles / B4f alternatives, blind marking, Explain, perishable claims".
 * Tables are created in server/db.ts initDatabase. This module only reads and writes rows; it never
 * imports server/line-marks.ts (no import cycles).
 */
import { assertWritesAllowed, getDb } from './db.js';
import { actorKey, type LineAnchor } from '../src/shared/line-marks.js';
import type { BundleMember, BundleStatus, ProofBundle } from '../src/shared/bundles.js';
import type { AltPick, ProofAlternative } from '../src/shared/alternatives.js';
import type { ProofTtl, TtlCheck } from '../src/shared/ttl.js';

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

type AnchorRow = { line_hash: string; line_occurrence: number; line_ordinal: number; line_kind: string; line_excerpt: string; line_text?: string | null };

function rowAnchor(row: AnchorRow): LineAnchor {
  const anchor: LineAnchor = { hash: row.line_hash, occurrence: row.line_occurrence, ordinal: row.line_ordinal, kind: row.line_kind, excerpt: row.line_excerpt ?? '' };
  if (row.line_text) anchor.text = row.line_text;
  return anchor;
}

// ============================================================================
// Bundles
// ============================================================================

interface BundleRow {
  id: string;
  document_slug: string;
  by_actor: string;
  title: string;
  why: string | null;
  members_json: string;
  status: string;
  created_at: string;
  closed_at: string | null;
  closed_by: string | null;
}

const BUNDLE_STATUSES = new Set(['open', 'accepted', 'rejected', 'split', 'closed']);

function rowToBundle(row: BundleRow): ProofBundle {
  return {
    id: row.id,
    by: row.by_actor,
    title: row.title,
    why: row.why,
    members: parseJson<BundleMember[]>(row.members_json, []).filter(m => m && typeof m.markId === 'string'),
    createdAt: row.created_at,
    status: (BUNDLE_STATUSES.has(row.status) ? row.status : 'open') as BundleStatus,
    closedAt: row.closed_at,
    closedBy: row.closed_by,
  };
}

export function listBundles(slug: string, options: { includeClosed?: boolean } = {}): ProofBundle[] {
  const rows = getDb().prepare(`SELECT * FROM document_bundles WHERE document_slug = ? ${options.includeClosed ? '' : "AND status = 'open'"} ORDER BY created_at ASC, id ASC`).all(slug) as BundleRow[];
  return rows.map(rowToBundle);
}

export function getBundle(slug: string, id: string): ProofBundle | null {
  const row = getDb().prepare(`SELECT * FROM document_bundles WHERE document_slug = ? AND id = ?`).get(slug, id) as BundleRow | undefined;
  return row ? rowToBundle(row) : null;
}

export function insertBundle(slug: string, bundle: ProofBundle): void {
  assertWritesAllowed('insertBundle');
  getDb().prepare(`
    INSERT INTO document_bundles (id, document_slug, by_actor, title, why, members_json, status, created_at, closed_at, closed_by)
    VALUES (?, ?, ?, ?, ?, ?, 'open', ?, NULL, NULL)
  `).run(bundle.id, slug, bundle.by, bundle.title, bundle.why, JSON.stringify(bundle.members), bundle.createdAt);
}

export function updateBundleMembers(slug: string, id: string, members: BundleMember[]): void {
  assertWritesAllowed('updateBundleMembers');
  getDb().prepare(`UPDATE document_bundles SET members_json = ? WHERE document_slug = ? AND id = ?`).run(JSON.stringify(members), slug, id);
}

export function updateBundleText(slug: string, id: string, title: string, why: string | null): void {
  assertWritesAllowed('updateBundleText');
  getDb().prepare(`UPDATE document_bundles SET title = ?, why = ? WHERE document_slug = ? AND id = ?`).run(title, why, slug, id);
}

export function closeBundleRow(slug: string, id: string, status: BundleStatus, by: string, at: string): boolean {
  assertWritesAllowed('closeBundleRow');
  return getDb().prepare(`UPDATE document_bundles SET status = ?, closed_at = ?, closed_by = ? WHERE document_slug = ? AND id = ? AND status = 'open'`)
    .run(status, at, by, slug, id).changes > 0;
}

// ============================================================================
// Alternatives and picks
// ============================================================================

interface AltRow extends AnchorRow {
  id: string;
  document_slug: string;
  by_actor: string;
  text: string;
  created_at: string;
  status: string;
  closed_at: string | null;
  closed_by: string | null;
  resolution_json: string | null;
}

function rowToAlt(row: AltRow): ProofAlternative {
  return {
    id: row.id,
    by: row.by_actor,
    text: row.text,
    anchor: rowAnchor(row),
    createdAt: row.created_at,
    status: (['open', 'chosen', 'folded', 'withdrawn'].includes(row.status) ? row.status : 'open') as ProofAlternative['status'],
    closedAt: row.closed_at,
    closedBy: row.closed_by,
    resolution: parseJson<ProofAlternative['resolution']>(row.resolution_json, null),
  };
}

export function listAlternatives(slug: string, options: { includeClosed?: boolean } = {}): ProofAlternative[] {
  const rows = getDb().prepare(`SELECT * FROM document_alternatives WHERE document_slug = ? ${options.includeClosed ? '' : "AND status = 'open'"} ORDER BY created_at ASC, id ASC`).all(slug) as AltRow[];
  return rows.map(rowToAlt);
}

export function getAlternative(slug: string, id: string): ProofAlternative | null {
  const row = getDb().prepare(`SELECT * FROM document_alternatives WHERE document_slug = ? AND id = ?`).get(slug, id) as AltRow | undefined;
  return row ? rowToAlt(row) : null;
}

export function insertAlternative(slug: string, alt: ProofAlternative): void {
  assertWritesAllowed('insertAlternative');
  const a = alt.anchor;
  getDb().prepare(`
    INSERT INTO document_alternatives (id, document_slug, by_actor, text, line_hash, line_occurrence, line_ordinal, line_kind, line_excerpt, line_text,
      created_at, status, closed_at, closed_by, resolution_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, NULL)
  `).run(alt.id, slug, alt.by, alt.text, a.hash, a.occurrence, a.ordinal, a.kind, String(a.excerpt ?? '').slice(0, 80), a.text ?? null, alt.createdAt);
}

export function updateAlternativeAnchor(slug: string, id: string, anchor: LineAnchor): void {
  assertWritesAllowed('updateAlternativeAnchor');
  getDb().prepare(`
    UPDATE document_alternatives SET line_hash = ?, line_occurrence = ?, line_ordinal = ?, line_kind = ?, line_excerpt = ?, line_text = ?
    WHERE document_slug = ? AND id = ?
  `).run(anchor.hash, anchor.occurrence, anchor.ordinal, anchor.kind, String(anchor.excerpt ?? '').slice(0, 80), anchor.text ?? null, slug, id);
}

export function closeAlternativeRow(slug: string, id: string, status: ProofAlternative['status'], by: string, at: string, resolution: ProofAlternative['resolution']): boolean {
  assertWritesAllowed('closeAlternativeRow');
  return getDb().prepare(`
    UPDATE document_alternatives SET status = ?, closed_at = ?, closed_by = ?, resolution_json = ? WHERE document_slug = ? AND id = ? AND status = 'open'
  `).run(status, at, by, resolution ? JSON.stringify(resolution) : null, slug, id).changes > 0;
}

interface PickRow { id: string; by_actor: string; choice: string; line_hash: string; at: string }

export function listPicks(slug: string): AltPick[] {
  const rows = getDb().prepare(`SELECT * FROM document_alt_picks WHERE document_slug = ? ORDER BY at ASC, id ASC`).all(slug) as PickRow[];
  return rows.map(row => ({ by: row.by_actor, choice: row.choice, lineHash: row.line_hash, at: row.at }));
}

/** One pick per person per line text: a new pick replaces the old one. */
export function upsertPick(slug: string, pick: AltPick & { id: string }): void {
  assertWritesAllowed('upsertPick');
  const d = getDb();
  d.transaction(() => {
    d.prepare(`DELETE FROM document_alt_picks WHERE document_slug = ? AND actor_key = ? AND line_hash = ?`).run(slug, actorKey(pick.by), pick.lineHash);
    d.prepare(`INSERT INTO document_alt_picks (id, document_slug, by_actor, actor_key, choice, line_hash, at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(pick.id, slug, pick.by, actorKey(pick.by), pick.choice, pick.lineHash, pick.at);
  })();
}

export function deletePicksForLine(slug: string, lineHash: string): void {
  assertWritesAllowed('deletePicksForLine');
  getDb().prepare(`DELETE FROM document_alt_picks WHERE document_slug = ? AND line_hash = ?`).run(slug, lineHash);
}

// ============================================================================
// Settings (blind marking)
// ============================================================================

export interface ProofSettings { blind: boolean; blindSetBy: string | null; blindSetAt: string | null }

export function getProofSettings(slug: string): ProofSettings {
  try {
    const row = getDb().prepare(`SELECT * FROM document_proof_settings WHERE document_slug = ?`).get(slug) as { blind: number; blind_set_by: string | null; blind_set_at: string | null } | undefined;
    return { blind: Boolean(row?.blind), blindSetBy: row?.blind_set_by ?? null, blindSetAt: row?.blind_set_at ?? null };
  } catch {
    return { blind: false, blindSetBy: null, blindSetAt: null };
  }
}

export function setBlind(slug: string, blind: boolean, by: string, at: string): void {
  assertWritesAllowed('setBlind');
  getDb().prepare(`
    INSERT INTO document_proof_settings (document_slug, blind, blind_set_by, blind_set_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(document_slug) DO UPDATE SET blind = excluded.blind, blind_set_by = excluded.blind_set_by, blind_set_at = excluded.blind_set_at
  `).run(slug, blind ? 1 : 0, by, at);
}

// ============================================================================
// Explain threads
// ============================================================================

export interface ProofExplain { id: string; by: string; commentMarkId: string | null; question: string; anchor: LineAnchor; createdAt: string }

interface ExplainRow extends AnchorRow { id: string; by_actor: string; comment_mark_id: string | null; question: string; created_at: string }

export function listExplains(slug: string): ProofExplain[] {
  const rows = getDb().prepare(`SELECT * FROM document_explains WHERE document_slug = ? ORDER BY created_at ASC, id ASC`).all(slug) as ExplainRow[];
  return rows.map(row => ({ id: row.id, by: row.by_actor, commentMarkId: row.comment_mark_id, question: row.question, anchor: rowAnchor(row), createdAt: row.created_at }));
}

export function insertExplain(slug: string, explain: ProofExplain): void {
  assertWritesAllowed('insertExplain');
  const a = explain.anchor;
  getDb().prepare(`
    INSERT INTO document_explains (id, document_slug, by_actor, comment_mark_id, question, line_hash, line_occurrence, line_ordinal, line_kind, line_excerpt, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(explain.id, slug, explain.by, explain.commentMarkId, explain.question, a.hash, a.occurrence, a.ordinal, a.kind, String(a.excerpt ?? '').slice(0, 80), explain.createdAt);
}

// ============================================================================
// Times-to-live
// ============================================================================

interface TtlRow extends AnchorRow {
  id: string;
  by_actor: string;
  ttl_ms: number;
  label: string;
  set_at: string;
  period_start: string;
  period_hash: string;
  checks_json: string;
  expired_noted_at: string | null;
  cleared_at: string | null;
}

function rowToTtl(row: TtlRow): ProofTtl & { expiredNotedAt: string | null } {
  return {
    id: row.id,
    by: row.by_actor,
    ttlMs: row.ttl_ms,
    label: row.label,
    anchor: rowAnchor(row),
    setAt: row.set_at,
    periodStart: row.period_start,
    periodHash: row.period_hash,
    checks: parseJson<TtlCheck[]>(row.checks_json, []).filter(c => c && typeof c.by === 'string'),
    expiredNotedAt: row.expired_noted_at,
  };
}

/** Live (not cleared) times-to-live. */
export function listTtls(slug: string): Array<ProofTtl & { expiredNotedAt: string | null }> {
  const rows = getDb().prepare(`SELECT * FROM document_line_ttls WHERE document_slug = ? AND cleared_at IS NULL ORDER BY set_at ASC, id ASC`).all(slug) as TtlRow[];
  return rows.map(rowToTtl);
}

export function getTtl(slug: string, id: string): (ProofTtl & { cleared: boolean }) | null {
  const row = getDb().prepare(`SELECT * FROM document_line_ttls WHERE document_slug = ? AND id = ?`).get(slug, id) as TtlRow | undefined;
  return row ? { ...rowToTtl(row), cleared: Boolean(row.cleared_at) } : null;
}

export function insertTtl(slug: string, ttl: ProofTtl): void {
  assertWritesAllowed('insertTtl');
  const a = ttl.anchor;
  getDb().prepare(`
    INSERT INTO document_line_ttls (id, document_slug, by_actor, ttl_ms, label, line_hash, line_occurrence, line_ordinal, line_kind, line_excerpt, line_text,
      set_at, period_start, period_hash, checks_json, expired_noted_at, cleared_at, cleared_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
  `).run(ttl.id, slug, ttl.by, ttl.ttlMs, ttl.label, a.hash, a.occurrence, a.ordinal, a.kind, String(a.excerpt ?? '').slice(0, 80), a.text ?? null,
    ttl.setAt, ttl.periodStart, ttl.periodHash, JSON.stringify(ttl.checks));
}

export function clearTtlRow(slug: string, id: string, by: string, at: string): boolean {
  assertWritesAllowed('clearTtlRow');
  return getDb().prepare(`UPDATE document_line_ttls SET cleared_at = ?, cleared_by = ? WHERE document_slug = ? AND id = ? AND cleared_at IS NULL`).run(at, by, slug, id).changes > 0;
}

export function updateTtlPeriod(slug: string, id: string, input: { periodStart: string; periodHash: string; checks: TtlCheck[] }): void {
  assertWritesAllowed('updateTtlPeriod');
  getDb().prepare(`UPDATE document_line_ttls SET period_start = ?, period_hash = ?, checks_json = ?, expired_noted_at = NULL WHERE document_slug = ? AND id = ?`)
    .run(input.periodStart, input.periodHash, JSON.stringify(input.checks), slug, id);
}

export function updateTtlChecks(slug: string, id: string, checks: TtlCheck[]): void {
  assertWritesAllowed('updateTtlChecks');
  getDb().prepare(`UPDATE document_line_ttls SET checks_json = ? WHERE document_slug = ? AND id = ?`).run(JSON.stringify(checks), slug, id);
}

export function updateTtlAnchor(slug: string, id: string, anchor: LineAnchor): void {
  assertWritesAllowed('updateTtlAnchor');
  getDb().prepare(`
    UPDATE document_line_ttls SET line_hash = ?, line_occurrence = ?, line_ordinal = ?, line_kind = ?, line_excerpt = ?, line_text = ? WHERE document_slug = ? AND id = ?
  `).run(anchor.hash, anchor.occurrence, anchor.ordinal, anchor.kind, String(anchor.excerpt ?? '').slice(0, 80), anchor.text ?? null, slug, id);
}

/** Records that the expiry was noticed (so ttl.expired is recorded once per period). */
export function noteTtlExpired(slug: string, id: string, at: string): boolean {
  assertWritesAllowed('noteTtlExpired');
  return getDb().prepare(`UPDATE document_line_ttls SET expired_noted_at = ? WHERE document_slug = ? AND id = ? AND expired_noted_at IS NULL`).run(at, slug, id).changes > 0;
}

/** Undoes a close whose edit failed (the wordings compete again). */
export function reopenAlternativeRow(slug: string, id: string): void {
  assertWritesAllowed('reopenAlternativeRow');
  getDb().prepare(`UPDATE document_alternatives SET status = 'open', closed_at = NULL, closed_by = NULL, resolution_json = NULL WHERE document_slug = ? AND id = ?`).run(slug, id);
}
