/**
 * Mike, 2026-09-23 (usability brief): viewer-facing tier signals use only visible marks and private proxies the viewer may read.
 * Proof Documents — line tiers, server side (storage, writes, the AI reads that cover context lines).
 * Rules live in src/shared/line-tiers.ts (TIER_POLICY).
 *
 * Authorship: Mike Wolf ruled Yes on 2026-09-19 to decision lines and context lines (idea from
 * Anthropic Fable); built by Claude Opus 5 (worker proof-tiers), 2026-09-19.
 *
 * Tags live in their own append-only table (document_line_tiers): every flip is kept with who set it
 * and when, and the newest tag still on a line is its tier. This module imports only the database,
 * the room broadcast and shared code, so server/line-marks.ts can use it without an import cycle.
 */
import { proxyVisibleTo } from '../src/shared/blind.js';
import { randomUUID } from 'crypto';
import { addDocumentEvent, assertWritesAllowed, getDb } from './db.js';
import { broadcastToRoom } from './ws.js';
import {
  actorKey,
  anchorForLine,
  isAiActor,
  normalizeLineText,
  type DocLine,
  type LineAnchor,
  type LineMark,
} from '../src/shared/line-marks.js';
import {
  TIER_POLICY,
  aiReadsFromMarks,
  cleanTierReason,
  evaluateTiers,
  isLineTier,
  tierSignalsFromProxies,
  type LineTier,
  type TierEvaluation,
  type TierFlag,
  type TierRead,
  type TierRecord,
  type TierView,
} from '../src/shared/line-tiers.js';

type Result = { status: number; body: Record<string, unknown> };
const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Result =>
  ({ status, body: { success: false, code, error, ...extra } });

interface TierRow {
  id: string; document_slug: string; tier: string; by_actor: string; reason: string | null; by_author: number;
  line_hash: string; line_occurrence: number; line_ordinal: number; line_kind: string; line_excerpt: string; line_text: string | null; at: string;
}

function rowToRecord(row: TierRow): TierRecord {
  const anchor: LineAnchor = { hash: row.line_hash, occurrence: row.line_occurrence, ordinal: row.line_ordinal, kind: row.line_kind, excerpt: row.line_excerpt ?? '' };
  if (row.line_text) anchor.text = row.line_text;
  return {
    id: row.id,
    tier: isLineTier(row.tier) ? row.tier : TIER_POLICY.defaultTier,
    by: row.by_actor,
    at: row.at,
    reason: row.reason,
    anchor,
    ...(row.by_author ? { byAuthor: true } : {}),
  };
}

/** Every tag in the document, oldest first (the history; the newest on a line wins). */
export function listTierRecords(slug: string): TierRecord[] {
  try {
    const rows = getDb().prepare(`SELECT * FROM document_line_tiers WHERE document_slug = ? ORDER BY at ASC, rowid ASC`).all(slug) as TierRow[];
    return rows.map(rowToRecord);
  } catch {
    return [];
  }
}

interface ProxyReadRow { familiar_actor: string; for_actor: string; status: string; evidence: string; line_hash: string; line_occurrence: number; line_ordinal: number; line_kind: string; line_excerpt: string; line_text: string | null }

/** Familiar proxy marks, as tier signals (read from their table directly: no import of proxy-marks.ts). */
function proxySignals(slug: string, viewer?: string): { reads: TierRead[]; flags: TierFlag[] } {
  try {
    const rows = getDb().prepare(`
      SELECT familiar_actor, for_actor, status, evidence, line_hash, line_occurrence, line_ordinal, line_kind, line_excerpt, line_text
      FROM document_proxy_marks WHERE document_slug = ? ORDER BY at ASC
    `).all(slug) as ProxyReadRow[];
    return tierSignalsFromProxies(rows.filter(row => viewer === undefined || proxyVisibleTo({ for: row.for_actor, familiar: row.familiar_actor }, viewer)).map(row => {
      const anchor: LineAnchor = { hash: row.line_hash, occurrence: row.line_occurrence, ordinal: row.line_ordinal, kind: row.line_kind, excerpt: row.line_excerpt ?? '' };
      if (row.line_text) anchor.text = row.line_text;
      return { familiar: row.familiar_actor, for: row.for_actor, status: row.status, evidence: row.evidence, anchor };
    }));
  } catch {
    return { reads: [], flags: [] };
  }
}

/**
 * Mike, 2026-09-23 (usability brief): construct tier signals only from visible marks and
 * proxies belonging to this viewer. Internal alignment calls keep the full inputs.
 */
export function tierSignals(slug: string, lineMarks: LineMark[], viewer?: string): { reads: TierRead[]; flags: TierFlag[] } {
  const proxies = proxySignals(slug, viewer);
  return { reads: [...aiReadsFromMarks(lineMarks.filter(mark => !mark.hidden)), ...proxies.reads], flags: proxies.flags };
}

export function evaluateDocumentTiers(slug: string, lines: DocLine[], lineMarks: LineMark[], viewer?: string): TierEvaluation {
  const signals = tierSignals(slug, lineMarks, viewer);
  return evaluateTiers({ lines, records: listTierRecords(slug), reads: signals.reads, flags: signals.flags });
}

/** JSON for AIs: every tagged or context line (untagged decision lines are the default and omitted). */
export function serializeTierViews(evaluation: TierEvaluation, lines: DocLine[]): Array<Record<string, unknown>> {
  return evaluation.views
    .filter(view => view.tagged || view.tier !== TIER_POLICY.defaultTier)
    .map((view: TierView) => {
      const line = lines[view.lineIndex];
      return {
        lineIndex: view.lineIndex,
        ref: line ? `b${line.block + 1}` : null,
        text: line ? line.text.slice(0, 200) : '',
        tier: view.tier,
        tagged: view.tagged,
        proposed: view.proposed,
        carried: view.carried,
        by: view.record?.by ?? null,
        at: view.record?.at ?? null,
        reason: view.record?.reason ?? null,
        byAuthor: view.record?.byAuthor === true,
        readBy: view.readBy,
        flaggedFor: view.flaggedFor,
      };
    });
}

// ============================================================================
// Authorship (an AI's context tag on a line it wrote needs no confirmation)
// ============================================================================

function plain(text: string): string {
  return normalizeLineText(String(text ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`~#>|]+/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
}

/**
 * The actors whose authored text holds all of `line` (authored spans in the markdown, and authored
 * marks in the stored marks). An AI that wrote the whole line is its author.
 */
export function authorsOfLine(line: DocLine, markdown: string, rawMarks: unknown): string[] {
  const text = plain(line.text);
  if (!text) return [];
  const out = new Set<string>();
  const spans = /<span\b([^>]*)>([\s\S]*?)<\/span>/gi;
  let match: RegExpExecArray | null;
  while ((match = spans.exec(markdown ?? '')) !== null) {
    const attrs = match[1];
    if (!/data-proof\s*=\s*["']?authored/i.test(attrs)) continue;
    const by = /data-by\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (by && plain(match[2]).includes(text)) out.add(by);
  }
  let marks: Record<string, Record<string, unknown>> = {};
  try {
    marks = typeof rawMarks === 'string' ? JSON.parse(rawMarks || '{}') : (rawMarks && typeof rawMarks === 'object' ? rawMarks as Record<string, Record<string, unknown>> : {});
  } catch { marks = {}; }
  for (const mark of Object.values(marks)) {
    if (!mark || mark.kind !== 'authored' || typeof mark.by !== 'string') continue;
    if (typeof mark.quote === 'string' && plain(mark.quote).includes(text)) out.add(mark.by);
  }
  return [...out];
}

// ============================================================================
// Writes
// ============================================================================

/**
 * Tags lines (already resolved to current lines) with one tier. Anyone with comment access may
 * (TIER_POLICY.whoMayTag; the route checks access). Each line gets a new record: the history keeps
 * every flip with who and when. One event (`tier.set`) and one room broadcast.
 */
export function writeTiers(slug: string, input: {
  by: string;
  tier: unknown;
  reason?: unknown;
  lines: DocLine[];
  /** Current tiers before this write (for the event and the response). */
  before?: TierEvaluation | null;
  markdown?: string;
  rawMarks?: unknown;
  source: 'page' | 'agent';
}): Result {
  if (!isLineTier(input.tier)) return fail(400, 'INVALID_TIER', '"tier" must be "decision" or "context"');
  const tier: LineTier = input.tier;
  if (input.lines.length === 0) return fail(400, 'INVALID_LINES', 'Give at least one line');
  if (input.lines.length > TIER_POLICY.maxLinesPerRequest) return fail(400, 'BATCH_TOO_LARGE', `At most ${TIER_POLICY.maxLinesPerRequest} lines per request`);
  const reason = cleanTierReason(input.reason);
  const at = new Date().toISOString();
  const byAi = isAiActor(input.by);
  const unique = new Map<string, DocLine>();
  for (const line of input.lines) unique.set(`${line.hash}:${line.occurrence}`, line);
  const written: Array<TierRecord & { lineIndex: number; previous: LineTier; proposed: boolean }> = [];
  assertWritesAllowed('writeTiers');
  const d = getDb();
  const ins = d.prepare(`
    INSERT INTO document_line_tiers (id, document_slug, tier, by_actor, reason, by_author, line_hash, line_occurrence, line_ordinal,
      line_kind, line_excerpt, line_text, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  d.transaction(() => {
    for (const line of unique.values()) {
      const anchor = anchorForLine(line);
      const byAuthor = byAi && tier === 'context' && input.markdown !== undefined
        && authorsOfLine(line, input.markdown, input.rawMarks).some(author => actorKey(author) === actorKey(input.by));
      const id = randomUUID();
      ins.run(id, slug, tier, input.by, reason, byAuthor ? 1 : 0, anchor.hash, anchor.occurrence, anchor.ordinal, anchor.kind,
        normalizeLineText(anchor.excerpt).slice(0, 80), anchor.text ?? null, at);
      const previous = input.before?.views[line.index]?.tier ?? TIER_POLICY.defaultTier;
      const proposed = tier === 'context' && byAi && !(TIER_POLICY.aiAuthorNeedsNoConfirm && byAuthor);
      written.push({ id, tier, by: input.by, at, reason, anchor, ...(byAuthor ? { byAuthor: true } : {}), lineIndex: line.index, previous, proposed });
    }
  })();
  try {
    addDocumentEvent(slug, 'tier.set', {
      tier,
      count: written.length,
      ...(reason ? { reason } : {}),
      proposed: written.filter(w => w.proposed).length,
      lines: written.slice(0, 50).map(w => ({ lineIndex: w.lineIndex, previous: w.previous, excerpt: w.anchor.excerpt, ...(w.byAuthor ? { byAuthor: true } : {}) })),
      source: input.source,
    }, input.by);
  } catch (error) {
    console.warn('[line-tiers] failed to record event', { slug, error: String(error) });
  }
  broadcastToRoom(slug, { type: 'line-marks.updated', by: input.by, timestamp: at });
  return {
    status: 200,
    body: {
      success: true,
      tier,
      count: written.length,
      tiers: written.map(w => ({ id: w.id, lineIndex: w.lineIndex, tier: w.tier, previous: w.previous, proposed: w.proposed, byAuthor: w.byAuthor === true, excerpt: w.anchor.excerpt })),
      ...(written.some(w => w.proposed) ? { note: 'An AI\'s context tag shows as "AI proposed context" until a person confirms it (it counts as context meanwhile).' } : {}),
    },
  };
}
