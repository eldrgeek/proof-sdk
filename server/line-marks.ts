/**
 * Proof Documents Step 1 — server side of line marks and Issues.
 *
 * Authorship: spec by Mike Wolf (2026-09-18); built by Claude Opus 5 (worker proof-line-marks).
 *
 * Storage is the document_line_marks table: beside the document, never in its markdown,
 * its marks JSON or its Yjs state. So collab sync, projection repair and suggestion
 * accept/reject cannot drop, duplicate or re-anchor a line mark, and a line mark cannot
 * leak into the text. Browsers learn about changes through a room broadcast plus a poll.
 */
import { randomUUID } from 'crypto';
import {
  addDocumentEvent,
  getDb,
  listDocumentAgentKeys,
  listDocumentLineMarks,
  replaceDocumentLineMark,
  type DocumentLineMarkRow,
} from './db.js';
import { getHeadlessMilkdownParser, parseMarkdownWithHtmlFallback } from './milkdown-headless.js';
import { stripAllProofSpanTags } from './proof-span-strip.js';
import { broadcastToRoom } from './ws.js';
import {
  LINE_MARK_POLICY,
  actorKey,
  agentKeyActor,
  anchorForLine,
  computeIssues,
  computeStep1Team,
  extractLines,
  isLineAnchor,
  isLineMarkStatus,
  normalizeLineText,
  type DocLine,
  type IssueSummary,
  type LineAnchor,
  type LineMark,
  type LineSourceNode,
  type ReviewMarkLike,
} from '../src/shared/line-marks.js';

export type LineMarkResult = { status: number; body: Record<string, unknown> };

const MAX_REASON = 500;
const MAX_ACTOR = 120;

export function rowToLineMark(row: DocumentLineMarkRow): LineMark {
  return {
    id: row.id,
    by: row.by_actor,
    status: isLineMarkStatus(row.status) ? row.status : 'seen',
    reason: row.reason,
    at: row.updated_at,
    anchor: {
      hash: row.line_hash,
      occurrence: row.line_occurrence,
      ordinal: row.line_ordinal,
      kind: row.line_kind,
      excerpt: row.line_excerpt,
    },
  };
}

export function listLineMarks(slug: string): LineMark[] {
  return listDocumentLineMarks(slug).map(rowToLineMark);
}

/** The document's lines, computed the same way the browser computes them from its editor doc. */
export async function computeServerLines(markdown: string): Promise<DocLine[]> {
  const parser = await getHeadlessMilkdownParser();
  const parsed = parseMarkdownWithHtmlFallback(parser, stripAllProofSpanTags(markdown ?? ''));
  if (!parsed.doc) return [];
  return extractLines(parsed.doc as unknown as LineSourceNode);
}

function parseStoredMarks(raw: unknown): Record<string, Record<string, unknown>> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, Record<string, unknown>>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Comments and suggestions from the document's stored marks, as Issue candidates. */
export function reviewMarksFromStored(rawMarks: unknown): ReviewMarkLike[] {
  const out: ReviewMarkLike[] = [];
  for (const [id, mark] of Object.entries(parseStoredMarks(rawMarks))) {
    if (!mark || typeof mark !== 'object') continue;
    const kind = typeof mark.kind === 'string' ? mark.kind : '';
    const by = typeof mark.by === 'string' ? mark.by : null;
    const quote = typeof mark.quote === 'string' ? mark.quote : '';
    const repliesRaw = Array.isArray(mark.replies) ? mark.replies : (Array.isArray(mark.thread) ? mark.thread : []);
    const replies = (repliesRaw as Array<Record<string, unknown>>)
      .map(reply => ({ by: typeof reply?.by === 'string' ? reply.by : null }));
    if (kind === 'comment') {
      out.push({ id, kind, by, quote, open: mark.resolved !== true, replies });
    } else if (kind === 'insert' || kind === 'delete' || kind === 'replace') {
      const status = typeof mark.status === 'string' ? mark.status : 'pending';
      out.push({ id, kind, by, quote, open: status === 'pending', replies });
    }
  }
  return out;
}

/** Step 1 owner identity: the Documents library member who created the document, if any. */
export function documentOwnerActors(slug: string): string[] {
  try {
    const row = getDb().prepare(`
      SELECT m.name AS name FROM library_document_meta meta
      JOIN library_members m ON m.id = meta.created_by_member_id
      WHERE meta.slug = ?
    `).get(slug) as { name?: string } | undefined;
    if (row?.name && row.name.trim()) return [`human:${row.name.trim()}`];
  } catch {
    // Library tables are optional in bare SDK deployments.
  }
  return [];
}

export function isLibraryDocumentCreator(slug: string, memberId: string): boolean {
  try {
    const row = getDb().prepare(`SELECT created_by_member_id AS id FROM library_document_meta WHERE slug = ?`)
      .get(slug) as { id?: string | null } | undefined;
    return Boolean(row?.id && row.id === memberId);
  } catch {
    return false;
  }
}

export function activeAgentKeyActors(slug: string): string[] {
  try {
    return listDocumentAgentKeys(slug).filter(key => !key.revokedAt).map(key => agentKeyActor(key.label));
  } catch {
    return [];
  }
}

export function computeDocumentTeam(slug: string, lineMarks: LineMark[], reviewMarks: ReviewMarkLike[]): string[] {
  return computeStep1Team({
    owners: documentOwnerActors(slug),
    lineMarks,
    reviewMarks,
    agentKeyActors: activeAgentKeyActors(slug),
  });
}

export interface IssueReport extends IssueSummary {
  lineMarks: LineMark[];
  lines: Array<Pick<DocLine, 'index' | 'kind' | 'hash' | 'occurrence' | 'block'> & { text: string; ref: string }>;
  owners: string[];
}

export async function buildIssueReport(slug: string, markdown: string, rawMarks: unknown): Promise<IssueReport> {
  const lines = await computeServerLines(markdown);
  const lineMarks = listLineMarks(slug);
  const reviewMarks = reviewMarksFromStored(rawMarks);
  const team = computeDocumentTeam(slug, lineMarks, reviewMarks);
  const summary = computeIssues({ lines, lineMarks, team, reviewMarks });
  return {
    ...summary,
    owners: documentOwnerActors(slug),
    lineMarks,
    lines: lines.map(line => ({
      index: line.index,
      kind: line.kind,
      hash: line.hash,
      occurrence: line.occurrence,
      block: line.block,
      ref: `b${line.block + 1}`,
      text: line.text.slice(0, 200),
    })),
  };
}

function cleanActor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed || trimmed.length > MAX_ACTOR || /[\x00-\x1f\x7f]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Set (or clear, with status "unseen") one actor's mark on one line.
 * replaceIds: that actor's earlier marks on the same line (for example a stale mark from before
 * an edit); only marks by the same actor are ever removed.
 */
export function writeLineMark(slug: string, input: {
  by: unknown;
  status: unknown;
  reason?: unknown;
  anchor: unknown;
  replaceIds?: unknown;
  replaceAnchors?: unknown;
  canApprove: boolean;
  source: 'page' | 'agent';
}): LineMarkResult {
  const by = cleanActor(input.by);
  if (!by) return { status: 400, body: { success: false, code: 'INVALID_ACTOR', error: 'Missing or invalid "by" (for example "human:Mike" or "ai:claude")' } };
  const clearing = input.status === 'unseen' || input.status === null;
  if (!clearing && !isLineMarkStatus(input.status)) {
    return { status: 400, body: { success: false, code: 'INVALID_STATUS', error: 'status must be one of seen, agreed, approved, rejected, unseen' } };
  }
  if (!isLineAnchor(input.anchor)) {
    return { status: 400, body: { success: false, code: 'INVALID_ANCHOR', error: 'Missing or invalid line anchor' } };
  }
  const anchor = input.anchor as LineAnchor;
  const status = clearing ? null : input.status as LineMark['status'];
  if (status === 'approved' && LINE_MARK_POLICY.approveRequiresOwner && !input.canApprove) {
    return { status: 403, body: { success: false, code: 'OWNER_REQUIRED', error: 'Only an Owner can approve a line' } };
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, MAX_REASON) : '';
  if (status === 'rejected' && LINE_MARK_POLICY.rejectRequiresReason && !reason) {
    return { status: 400, body: { success: false, code: 'REASON_REQUIRED', error: 'A rejection needs a one-line reason' } };
  }
  const replaceIds = Array.isArray(input.replaceIds)
    ? input.replaceIds.filter((id): id is string => typeof id === 'string' && id.length <= 64).slice(0, 20)
    : [];
  const replaceAnchors = Array.isArray(input.replaceAnchors)
    ? input.replaceAnchors
      .filter((a): a is { hash: string; occurrence: number } => Boolean(a) && typeof (a as { hash?: unknown }).hash === 'string'
        && ((a as { hash: string }).hash.length <= 32) && Number.isInteger((a as { occurrence?: unknown }).occurrence))
      .slice(0, 5)
    : [];
  const now = new Date().toISOString();
  const id = randomUUID();
  const excerpt = normalizeLineText(String(anchor.excerpt ?? '')).slice(0, 80);
  const removed = replaceDocumentLineMark({
    slug,
    actorKey: actorKey(by),
    replaceIds,
    replaceAnchors,
    anchor,
    next: status
      ? {
        id,
        by_actor: by,
        status,
        reason: status === 'rejected' ? reason : (reason || null),
        line_hash: anchor.hash,
        line_occurrence: anchor.occurrence,
        line_ordinal: anchor.ordinal,
        line_kind: anchor.kind,
        line_excerpt: excerpt,
        at: now,
      }
      : null,
  });
  const mark: LineMark | null = status
    ? { id, by, status, reason: status === 'rejected' ? reason : (reason || null), at: now, anchor: { ...anchor, excerpt } }
    : null;
  try {
    addDocumentEvent(slug, 'line_mark.updated', { markId: mark?.id ?? null, removed, status: status ?? 'unseen', anchor: { hash: anchor.hash, excerpt }, source: input.source }, by);
  } catch (error) {
    console.warn('[line-marks] failed to record event', { slug, error: String(error) });
  }
  broadcastToRoom(slug, { type: 'line-marks.updated', by, timestamp: now });
  return { status: 200, body: { success: true, lineMark: mark, removed } };
}

/**
 * Resolve an agent's target line from { lineIndex } | { hash[, occurrence] } | { ref } | { quote }.
 * A quote must match exactly one line (substring of its visible text) unless occurrence is given.
 */
export function resolveAgentLineTarget(lines: DocLine[], body: Record<string, unknown>):
  { ok: true; line: DocLine } | { ok: false; status: number; code: string; error: string; candidates?: unknown[] } {
  const summarize = (list: DocLine[]) => list.slice(0, 10).map(line => ({ lineIndex: line.index, ref: `b${line.block + 1}`, text: line.text.slice(0, 120) }));
  if (Number.isInteger(body.lineIndex)) {
    const line = lines[Number(body.lineIndex)];
    return line ? { ok: true, line } : { ok: false, status: 404, code: 'LINE_NOT_FOUND', error: 'No line with that lineIndex' };
  }
  if (typeof body.hash === 'string' && body.hash) {
    const matches = lines.filter(line => line.hash === body.hash);
    const occurrence = Number.isInteger(body.occurrence) ? Number(body.occurrence) : 0;
    const line = matches.find(candidate => candidate.occurrence === occurrence) ?? matches[0];
    return line ? { ok: true, line } : { ok: false, status: 409, code: 'LINE_CHANGED', error: 'No line has that hash now; the line changed. Re-read /state.' };
  }
  let pool = lines;
  if (typeof body.ref === 'string' && /^b\d+$/.test(body.ref)) {
    const block = Number(body.ref.slice(1)) - 1;
    pool = lines.filter(line => line.block === block);
    if (pool.length === 0) return { ok: false, status: 404, code: 'LINE_NOT_FOUND', error: `Block ${body.ref} has no markable line` };
    if (pool.length === 1 && typeof body.quote !== 'string') return { ok: true, line: pool[0] };
  }
  const rawQuote = typeof body.quote === 'string' ? body.quote : '';
  const quote = normalizeLineText(rawQuote);
  if (!quote) {
    if (pool !== lines) {
      return { ok: false, status: 409, code: 'AMBIGUOUS_LINE', error: `Block ${String(body.ref)} holds several lines; add "quote"`, candidates: summarize(pool) };
    }
    return { ok: false, status: 400, code: 'MISSING_TARGET', error: 'Give lineIndex, hash, ref or quote' };
  }
  const matches = pool.filter(line => line.text.includes(quote));
  if (matches.length === 0) return { ok: false, status: 409, code: 'ANCHOR_NOT_FOUND', error: 'Quote not found in any line' };
  if (matches.length > 1) {
    if (Number.isInteger(body.occurrence) && matches[Number(body.occurrence)]) return { ok: true, line: matches[Number(body.occurrence)] };
    return { ok: false, status: 409, code: 'AMBIGUOUS_LINE', error: 'Quote matches several lines; quote more text or pass occurrence', candidates: summarize(matches) };
  }
  return { ok: true, line: matches[0] };
}

/** Agent write: resolve the target against current text, then write with that line's anchor. */
export async function writeAgentLineMark(slug: string, markdown: string, body: Record<string, unknown>, options: {
  by: string;
  canApprove: boolean;
}): Promise<LineMarkResult> {
  const lines = await computeServerLines(markdown);
  const target = resolveAgentLineTarget(lines, body);
  if (!target.ok) {
    return { status: target.status, body: { success: false, code: target.code, error: target.error, ...(target.candidates ? { candidates: target.candidates } : {}) } };
  }
  const anchor = anchorForLine(target.line);
  // Replace this actor's stale marks that sit on the same line (from before an edit).
  const existing = listLineMarks(slug).filter(mark => actorKey(mark.by) === actorKey(options.by));
  const replaceIds: string[] = [];
  for (const mark of existing) {
    if (mark.anchor.hash === anchor.hash && mark.anchor.occurrence === anchor.occurrence) continue;
    const onThisLine = !lines.some(line => line.hash === mark.anchor.hash) && mark.anchor.ordinal === target.line.index;
    if (onThisLine) replaceIds.push(mark.id);
  }
  const result = writeLineMark(slug, {
    by: options.by,
    status: body.status,
    reason: body.reason,
    anchor,
    replaceIds,
    canApprove: options.canApprove,
    source: 'agent',
  });
  if (result.status === 200) {
    result.body.line = { lineIndex: target.line.index, ref: `b${target.line.block + 1}`, text: target.line.text.slice(0, 200), hash: target.line.hash };
  }
  return result;
}
