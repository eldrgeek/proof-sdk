/**
 * Proof Documents Steps B4c + B4d — storage for review notes, uncertain flags and objections.
 *
 * Authorship: built by Claude Opus 5 (worker proof-aids), 2026-09-19, for the COS's brief
 * "B4c review aids / B4d objections with a resolution condition".
 *
 * Three tables beside the document (server/db.ts initDatabase), never in its text or Yjs state:
 *   document_review_notes  an AI's why / reject hints / explicit priority on a suggestion or line;
 *   document_line_flags    uncertain flags (open until the flagger or an Owner clears them);
 *   document_objections    objections: covered lines (original + current anchors), the reason,
 *                          "I'd agree if…", status, and what the objector has already seen.
 * This module only reads and writes rows; it never imports server/line-marks.ts (no cycles).
 */
import { addDocumentEvent, assertWritesAllowed, getDb } from './db.js';
import { actorKey, anchorForLine, type DocLine, type LineAnchor } from '../src/shared/line-marks.js';
import type { ReviewNote, UncertainFlag } from '../src/shared/review-aids.js';
import { slotOf, type ObjectionAck, type ObjectionLine, type ObjectionView, type ProofObjection } from '../src/shared/objections.js';

// ============================================================================
// Review notes
// ============================================================================

interface ReviewNoteRow {
  id: string;
  document_slug: string;
  by_actor: string;
  actor_key: string;
  target_kind: string;
  mark_id: string | null;
  line_hash: string | null;
  line_occurrence: number | null;
  line_ordinal: number | null;
  line_kind: string | null;
  line_excerpt: string | null;
  line_text: string | null;
  why: string | null;
  reject_hints_json: string;
  priority: number | null;
  priority_reason: string | null;
  created_at: string;
  updated_at: string;
}

function parseJsonArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowAnchor(row: { line_hash: string | null; line_occurrence: number | null; line_ordinal: number | null; line_kind: string | null; line_excerpt: string | null; line_text?: string | null }): LineAnchor {
  const anchor: LineAnchor = {
    hash: row.line_hash ?? '',
    occurrence: row.line_occurrence ?? 0,
    ordinal: row.line_ordinal ?? 0,
    kind: row.line_kind ?? 'paragraph',
    excerpt: row.line_excerpt ?? '',
  };
  if (row.line_text) anchor.text = row.line_text;
  return anchor;
}

function rowToNote(row: ReviewNoteRow): ReviewNote {
  return {
    id: row.id,
    by: row.by_actor,
    target: row.target_kind === 'suggestion'
      ? { kind: 'suggestion', markId: row.mark_id ?? '' }
      : { kind: 'line', anchor: rowAnchor(row) },
    why: row.why,
    rejectHints: parseJsonArray(row.reject_hints_json).filter((h): h is string => typeof h === 'string'),
    priority: typeof row.priority === 'number' ? row.priority : null,
    priorityReason: row.priority_reason,
    at: row.updated_at,
  };
}

export function listReviewNotes(slug: string): ReviewNote[] {
  const rows = getDb().prepare(`SELECT * FROM document_review_notes WHERE document_slug = ? ORDER BY updated_at ASC, id ASC`).all(slug) as ReviewNoteRow[];
  return rows.map(rowToNote);
}

/**
 * One note per (author, target): writing again merges into it. Fields left undefined keep their
 * value; null clears a field. Returns the note.
 */
export function upsertReviewNote(slug: string, input: {
  id: string;
  by: string;
  target: ReviewNote['target'];
  why?: string | null;
  rejectHints?: string[];
  priority?: number | null;
  priorityReason?: string | null;
  now: string;
}): ReviewNote {
  assertWritesAllowed('upsertReviewNote');
  const d = getDb();
  const key = actorKey(input.by);
  const existing = (input.target.kind === 'suggestion'
    ? d.prepare(`SELECT * FROM document_review_notes WHERE document_slug = ? AND actor_key = ? AND target_kind = 'suggestion' AND mark_id = ?`).get(slug, key, input.target.markId)
    : d.prepare(`SELECT * FROM document_review_notes WHERE document_slug = ? AND actor_key = ? AND target_kind = 'line' AND line_hash = ? AND line_occurrence = ?`).get(slug, key, input.target.anchor.hash, input.target.anchor.occurrence)) as ReviewNoteRow | undefined;
  if (existing) {
    const next: ReviewNoteRow = {
      ...existing,
      why: input.why !== undefined ? input.why : existing.why,
      reject_hints_json: input.rejectHints !== undefined ? JSON.stringify(input.rejectHints) : existing.reject_hints_json,
      priority: input.priority !== undefined ? input.priority : existing.priority,
      priority_reason: input.priorityReason !== undefined ? input.priorityReason : existing.priority_reason,
      updated_at: input.now,
    };
    d.prepare(`UPDATE document_review_notes SET why = ?, reject_hints_json = ?, priority = ?, priority_reason = ?, updated_at = ? WHERE id = ?`)
      .run(next.why, next.reject_hints_json, next.priority, next.priority_reason, next.updated_at, existing.id);
    return rowToNote(next);
  }
  const anchor = input.target.kind === 'line' ? input.target.anchor : null;
  const row: ReviewNoteRow = {
    id: input.id,
    document_slug: slug,
    by_actor: input.by,
    actor_key: key,
    target_kind: input.target.kind,
    mark_id: input.target.kind === 'suggestion' ? input.target.markId : null,
    line_hash: anchor?.hash ?? null,
    line_occurrence: anchor?.occurrence ?? null,
    line_ordinal: anchor?.ordinal ?? null,
    line_kind: anchor?.kind ?? null,
    line_excerpt: anchor ? String(anchor.excerpt ?? '').slice(0, 80) : null,
    line_text: anchor?.text ?? null,
    why: input.why ?? null,
    reject_hints_json: JSON.stringify(input.rejectHints ?? []),
    priority: input.priority ?? null,
    priority_reason: input.priorityReason ?? null,
    created_at: input.now,
    updated_at: input.now,
  };
  d.prepare(`
    INSERT INTO document_review_notes (id, document_slug, by_actor, actor_key, target_kind, mark_id, line_hash, line_occurrence,
      line_ordinal, line_kind, line_excerpt, line_text, why, reject_hints_json, priority, priority_reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.document_slug, row.by_actor, row.actor_key, row.target_kind, row.mark_id, row.line_hash, row.line_occurrence,
    row.line_ordinal, row.line_kind, row.line_excerpt, row.line_text, row.why, row.reject_hints_json, row.priority, row.priority_reason,
    row.created_at, row.updated_at);
  return rowToNote(row);
}

// ============================================================================
// Uncertain flags
// ============================================================================

interface FlagRow {
  id: string;
  document_slug: string;
  by_actor: string;
  actor_key: string;
  note: string | null;
  line_hash: string;
  line_occurrence: number;
  line_ordinal: number;
  line_kind: string;
  line_excerpt: string;
  line_text: string | null;
  created_at: string;
  cleared_at: string | null;
  cleared_by: string | null;
}

function rowToFlag(row: FlagRow): UncertainFlag {
  return { id: row.id, by: row.by_actor, note: row.note, anchor: rowAnchor(row), createdAt: row.created_at };
}

/** Open flags (cleared ones are kept in the table and the event log). */
export function listFlags(slug: string): UncertainFlag[] {
  const rows = getDb().prepare(`SELECT * FROM document_line_flags WHERE document_slug = ? AND cleared_at IS NULL ORDER BY created_at ASC, id ASC`).all(slug) as FlagRow[];
  return rows.map(rowToFlag);
}

export function getFlag(slug: string, id: string): (UncertainFlag & { cleared: boolean }) | null {
  const row = getDb().prepare(`SELECT * FROM document_line_flags WHERE document_slug = ? AND id = ?`).get(slug, id) as FlagRow | undefined;
  return row ? { ...rowToFlag(row), cleared: Boolean(row.cleared_at) } : null;
}

/** This person's open flag on the same line (UNCERTAIN_POLICY.onePerPersonPerLine). */
export function findOwnFlag(slug: string, by: string, anchor: { hash: string; occurrence: number }): UncertainFlag | null {
  const row = getDb().prepare(`
    SELECT * FROM document_line_flags WHERE document_slug = ? AND actor_key = ? AND line_hash = ? AND line_occurrence = ? AND cleared_at IS NULL
  `).get(slug, actorKey(by), anchor.hash, anchor.occurrence) as FlagRow | undefined;
  return row ? rowToFlag(row) : null;
}

export function insertFlag(slug: string, flag: UncertainFlag): void {
  assertWritesAllowed('insertFlag');
  const a = flag.anchor;
  getDb().prepare(`
    INSERT INTO document_line_flags (id, document_slug, by_actor, actor_key, note, line_hash, line_occurrence, line_ordinal, line_kind,
      line_excerpt, line_text, created_at, cleared_at, cleared_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
  `).run(flag.id, slug, flag.by, actorKey(flag.by), flag.note, a.hash, a.occurrence, a.ordinal, a.kind, String(a.excerpt ?? '').slice(0, 80), a.text ?? null, flag.createdAt);
}

export function updateFlagNote(slug: string, id: string, note: string | null): void {
  assertWritesAllowed('updateFlagNote');
  getDb().prepare(`UPDATE document_line_flags SET note = ? WHERE document_slug = ? AND id = ?`).run(note, slug, id);
}

export function clearFlagRow(slug: string, id: string, by: string, at: string): boolean {
  assertWritesAllowed('clearFlagRow');
  return getDb().prepare(`UPDATE document_line_flags SET cleared_at = ?, cleared_by = ? WHERE document_slug = ? AND id = ? AND cleared_at IS NULL`)
    .run(at, by, slug, id).changes > 0;
}

/** The flag follows its line: store the line's current anchor. */
export function updateFlagAnchor(slug: string, id: string, anchor: LineAnchor): void {
  assertWritesAllowed('updateFlagAnchor');
  getDb().prepare(`
    UPDATE document_line_flags SET line_hash = ?, line_occurrence = ?, line_ordinal = ?, line_kind = ?, line_excerpt = ?, line_text = ?
    WHERE document_slug = ? AND id = ?
  `).run(anchor.hash, anchor.occurrence, anchor.ordinal, anchor.kind, String(anchor.excerpt ?? '').slice(0, 80), anchor.text ?? null, slug, id);
}

// ============================================================================
// Objections
// ============================================================================

interface ObjectionRow {
  id: string;
  document_slug: string;
  by_actor: string;
  actor_key: string;
  reason: string;
  condition: string | null;
  lines_json: string;
  ack_json: string;
  status: string;
  created_at: string;
  closed_at: string | null;
  closed_by: string | null;
  override_reason: string | null;
  kept_at: string | null;
  repair_notified_json: string | null;
}

function parseAck(raw: string, lines: ObjectionLine[]): ObjectionAck {
  try {
    const parsed = JSON.parse(raw) as Partial<ObjectionAck>;
    return {
      hashes: Array.isArray(parsed.hashes) ? parsed.hashes.map(String) : lines.map(line => line.original.hash),
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.map(String) : [],
    };
  } catch {
    return { hashes: lines.map(line => line.original.hash), suggestions: [] };
  }
}

function rowToObjection(row: ObjectionRow): ProofObjection {
  const lines = parseJsonArray(row.lines_json) as ObjectionLine[];
  return {
    id: row.id,
    by: row.by_actor,
    reason: row.reason,
    condition: row.condition,
    lines,
    createdAt: row.created_at,
    status: row.status === 'cleared' || row.status === 'overridden' ? row.status : 'open',
    closedAt: row.closed_at,
    closedBy: row.closed_by,
    overrideReason: row.override_reason,
    ack: parseAck(row.ack_json, lines),
    keptAt: row.kept_at,
  };
}

export function listObjections(slug: string, options: { includeClosed?: boolean } = {}): ProofObjection[] {
  const rows = getDb().prepare(`
    SELECT * FROM document_objections WHERE document_slug = ? ${options.includeClosed ? '' : "AND status = 'open'"}
    ORDER BY created_at ASC, id ASC
  `).all(slug) as ObjectionRow[];
  return rows.map(rowToObjection);
}

export function getObjection(slug: string, id: string): ProofObjection | null {
  const row = getDb().prepare(`SELECT * FROM document_objections WHERE document_slug = ? AND id = ?`).get(slug, id) as ObjectionRow | undefined;
  return row ? rowToObjection(row) : null;
}

export function insertObjection(slug: string, objection: ProofObjection): void {
  assertWritesAllowed('insertObjection');
  getDb().prepare(`
    INSERT INTO document_objections (id, document_slug, by_actor, actor_key, reason, condition, lines_json, ack_json, status, created_at,
      closed_at, closed_by, override_reason, kept_at, repair_notified_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL, NULL, NULL, NULL, NULL)
  `).run(objection.id, slug, objection.by, actorKey(objection.by), objection.reason, objection.condition,
    JSON.stringify(objection.lines), JSON.stringify(objection.ack), objection.createdAt);
}

export function closeObjectionRow(slug: string, id: string, input: { status: 'cleared' | 'overridden'; by: string; at: string; overrideReason?: string | null }): boolean {
  assertWritesAllowed('closeObjectionRow');
  return getDb().prepare(`
    UPDATE document_objections SET status = ?, closed_at = ?, closed_by = ?, override_reason = ? WHERE document_slug = ? AND id = ? AND status = 'open'
  `).run(input.status, input.at, input.by, input.overrideReason ?? null, slug, id).changes > 0;
}

export function keepObjectionRow(slug: string, id: string, ack: ObjectionAck, at: string): void {
  assertWritesAllowed('keepObjectionRow');
  getDb().prepare(`UPDATE document_objections SET ack_json = ?, kept_at = ?, repair_notified_json = NULL WHERE document_slug = ? AND id = ?`)
    .run(JSON.stringify(ack), at, slug, id);
}

/**
 * Objections follow their lines. After an evaluation, store each covered line's current anchor
 * (so a second edit is re-found from the first), note deletions, and record one
 * `objection.repair_proposed` event per distinct repair (for the objector's Familiar).
 */
export function persistObjectionViews(slug: string, views: ObjectionView[], docLines: DocLine[]): void {
  const d = getDb();
  const now = new Date().toISOString();
  for (const view of views) {
    if (!view.open) continue;
    const objection = view.objection;
    let changed = false;
    const lines = objection.lines.map((covered, i) => {
      const index = view.lineIndices[i];
      if (index === null) {
        if (covered.deletedAt) return covered;
        changed = true;
        return { ...covered, deletedAt: now };
      }
      const line = docLines[index];
      if (!line) return covered;
      const anchor = anchorForLine(line);
      const slot = slotOf(docLines, index);
      const same = anchor.hash === covered.current.hash && anchor.occurrence === covered.current.occurrence && anchor.ordinal === covered.current.ordinal
        && !covered.deletedAt && covered.before === slot.before && covered.after === slot.after;
      if (same) return covered;
      changed = true;
      return { ...covered, current: anchor, deletedAt: null, ...slot };
    });
    try {
      assertWritesAllowed('persistObjectionViews');
      if (changed) {
        d.prepare(`UPDATE document_objections SET lines_json = ? WHERE document_slug = ? AND id = ?`).run(JSON.stringify(lines), slug, objection.id);
        objection.lines = lines;
      }
      if (view.repairPending) {
        const sig = JSON.stringify([view.hashes, view.suggestions]);
        const row = d.prepare(`SELECT repair_notified_json AS sig FROM document_objections WHERE document_slug = ? AND id = ?`).get(slug, objection.id) as { sig: string | null } | undefined;
        if (row && row.sig !== sig) {
          d.prepare(`UPDATE document_objections SET repair_notified_json = ? WHERE document_slug = ? AND id = ?`).run(sig, slug, objection.id);
          addDocumentEvent(slug, 'objection.repair_proposed', {
            objectionId: objection.id,
            objector: objection.by,
            condition: objection.condition,
            changedLines: view.changed.map((c, i) => (c ? i : -1)).filter(i => i >= 0),
            deletedLines: view.deletedLines,
            suggestions: view.suggestions,
          }, 'system');
        }
      }
    } catch (error) {
      console.warn('[objections] persist failed', { slug, id: objection.id, error: String(error) });
    }
  }
}

