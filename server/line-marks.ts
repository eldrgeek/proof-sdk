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
  buildLineStates,
  computeIssues,
  computeStep1Team,
  extractLines,
  isLineAnchor,
  isLineMarkStatus,
  isMarkVia,
  normalizeLineText,
  LINE_TEXT_MAX,
  type MarkVia,
  type AskIssueInput,
  type DocLine,
  type IssueSummary,
  type LineAnchor,
  type LineMark,
  type LineSourceNode,
  type ReviewMarkLike,
} from '../src/shared/line-marks.js';
import { buildDirectory, clientDirectory } from './identity.js';
import { WHY_POLICY, cleanWhy } from '../src/shared/review-aids.js';
import { annotateIssues, evaluateAids, objectionInputs, serializeFlag, serializeNote, serializeObjection, uncertainInputs } from './review-aids-eval.js';
import { isAiActor } from '../src/shared/line-marks.js';
import { canonicalizeLineMarks, isEmailAddress, resolveTargetActor, verifiedHumanActor, type IdentityDirectory } from '../src/shared/identity.js';
import { FOLDING, computeSections, sectionByHeading, sectionIssueCount, sectionLineIndices } from '../src/shared/folding.js';

export type LineMarkResult = { status: number; body: Record<string, unknown> };

const MAX_REASON = 500;
const MAX_ACTOR = 120;

export function rowToLineMark(row: DocumentLineMarkRow): LineMark {
  const anchor: LineAnchor = {
    hash: row.line_hash,
    occurrence: row.line_occurrence,
    ordinal: row.line_ordinal,
    kind: row.line_kind,
    excerpt: row.line_excerpt,
  };
  if (typeof row.line_text === 'string' && row.line_text) anchor.text = row.line_text;
  return {
    id: row.id,
    by: row.by_actor,
    status: isLineMarkStatus(row.status) ? row.status : 'seen',
    reason: row.reason,
    at: row.updated_at,
    anchor,
    via: isMarkVia(row.via) ? row.via : 'api',
    ...(row.why ? { why: row.why } : {}),
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

/**
 * Owner identity for the team and for an ask's default "to": the Documents library member who
 * created the document, as a verified person (Step B6: human:<email>). Documents admins have
 * Owner rights too (resolveLineMarkAccess), but join the team only when they take part
 * (IDENTITY_POLICY.adminsJoinTeam).
 */
export function documentOwnerActors(slug: string): string[] {
  try {
    const row = getDb().prepare(`
      SELECT m.name AS name, m.email AS email FROM library_document_meta meta
      JOIN library_members m ON m.id = meta.created_by_member_id
      WHERE meta.slug = ?
    `).get(slug) as { name?: string; email?: string | null } | undefined;
    if (row?.email && isEmailAddress(row.email)) return [verifiedHumanActor(row.email)];
    if (row?.name && row.name.trim()) return [`human:${row.name.trim()}`];
  } catch {
    // Library tables are optional in bare SDK deployments.
  }
  return [];
}

/** Step B6: the document's line marks read through its identity directory (merges applied). */
export function listCanonicalLineMarks(slug: string, dir: IdentityDirectory = buildDirectory(slug)): LineMark[] {
  return canonicalizeLineMarks(listLineMarks(slug), dir);
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

/** lineMarks must already be canonical (listCanonicalLineMarks). */
export function computeDocumentTeam(slug: string, lineMarks: LineMark[], reviewMarks: ReviewMarkLike[], extra: string[] = [], dir: IdentityDirectory = buildDirectory(slug)): string[] {
  return computeStep1Team({
    owners: documentOwnerActors(slug),
    lineMarks,
    reviewMarks,
    agentKeyActors: activeAgentKeyActors(slug),
    extra,
    identity: { target: actor => resolveTargetActor(actor, dir) },
  });
}

export interface IssueReport extends IssueSummary {
  lineMarks: LineMark[];
  lines: Array<Pick<DocLine, 'index' | 'kind' | 'hash' | 'occurrence' | 'block'> & { text: string; ref: string }>;
  owners: string[];
  actorLabels: Record<string, string>;
  /** Step B3b: marks carried over a cosmetic edit of their line (they count as current). */
  carried: Array<{ markId: string; by: string; status: string; lineIndex: number; from: string | null; to: string }>;
  /** Step B2: the document's outline, with each section's Issue count (same Issues as above). */
  sections: Array<{ headingIndex: number; ref: string; level: number; text: string; lineEnd: number; parent: number | null; issues: number }>;
  /** Step B4c: open uncertain flags, AI review notes (why / reject hints / priority). */
  flags: Array<Record<string, unknown>>;
  reviewNotes: Array<Record<string, unknown>>;
  /** Step B4d: open objections. */
  objections: Array<Record<string, unknown>>;
}

export async function buildIssueReport(slug: string, markdown: string, rawMarks: unknown, options: {
  /** Step B3: the open asks, evaluated against these lines (server/asks.ts buildAskReport). */
  asks?: (lines: DocLine[]) => AskIssueInput[];
  /** Step B3: askers and the people asked are team members too. */
  teamExtra?: string[];
} = {}): Promise<IssueReport> {
  const lines = await computeServerLines(markdown);
  const dir = buildDirectory(slug);
  const lineMarks = listCanonicalLineMarks(slug, dir);
  const reviewMarks = reviewMarksFromStored(rawMarks);
  // Step B4c/B4d: flags and objections are Issues too; flaggers and objectors join the team.
  const aids = evaluateAids(slug, lines, reviewMarks);
  const team = computeDocumentTeam(slug, lineMarks, reviewMarks, [...(options.teamExtra ?? []), ...aids.teamExtra], dir);
  const asks = options.asks ? options.asks(lines) : [];
  const states = buildLineStates(lines, lineMarks);
  const computed = computeIssues({ lines, lineMarks, team, reviewMarks, asks, uncertain: uncertainInputs(aids, states, team), objections: objectionInputs(aids) });
  // Step B4c: each Issue carries its team-neutral priority (rules + explicit AI priorities).
  const summary = { ...computed, issues: annotateIssues(computed.issues, aids.notes, lines) as typeof computed.issues };
  const sections = computeSections(lines).map(section => ({
    headingIndex: section.headingIndex,
    ref: `b${section.block + 1}`,
    level: section.level,
    text: lines[section.headingIndex].text.slice(0, 200),
    lineEnd: section.lineEnd,
    parent: section.parent,
    issues: sectionIssueCount(section, lines, summary).total,
  }));
  const owners = documentOwnerActors(slug);
  const carried: IssueReport['carried'] = [];
  for (const state of states) {
    for (const entry of state.marks.values()) {
      if (entry.carried) carried.push({ markId: entry.mark.id, by: entry.mark.by, status: entry.mark.status, lineIndex: state.line.index, from: entry.carriedFrom ?? null, to: state.line.text.slice(0, 200) });
    }
  }
  return {
    ...summary,
    carried,
    sections,
    owners,
    // Step B6: display names for the actors above (a verified human's actor is their email).
    actorLabels: clientDirectory(dir, [...team, ...owners, ...lineMarks.map(mark => mark.by)]).labels,
    lineMarks,
    flags: aids.flagViews.map(view => serializeFlag(view, lines)),
    reviewNotes: aids.notes.map(note => serializeNote(note, lines)),
    objections: aids.objectionViews.map(view => serializeObjection(view, lines)),
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

type ValidEntry = {
  status: LineMark['status'] | null;
  via: MarkVia;
  /** Step B4c: an AI's rationale (kept only from AI actors, WHY_POLICY). */
  why: string | null;
  reason: string;
  anchor: LineAnchor;
  replaceIds: string[];
  replaceAnchors: Array<{ hash: string; occurrence: number }>;
};

/** Checks one line-mark write (status, reason, anchor, owner rule) without writing anything. */
function validateEntry(input: {
  status: unknown;
  reason?: unknown;
  why?: unknown;
  via?: unknown;
  anchor: unknown;
  replaceIds?: unknown;
  replaceAnchors?: unknown;
  canApprove: boolean;
}): { ok: true; entry: ValidEntry } | { ok: false; result: LineMarkResult } {
  const clearing = input.status === 'unseen' || input.status === null;
  if (!clearing && !isLineMarkStatus(input.status)) {
    return { ok: false, result: { status: 400, body: { success: false, code: 'INVALID_STATUS', error: 'status must be one of seen, agreed, approved, rejected, skimmed, unseen' } } };
  }
  if (!isLineAnchor(input.anchor)) {
    return { ok: false, result: { status: 400, body: { success: false, code: 'INVALID_ANCHOR', error: 'Missing or invalid line anchor' } } };
  }
  const anchor = input.anchor as LineAnchor;
  const status = clearing ? null : input.status as LineMark['status'];
  if (status === 'approved' && LINE_MARK_POLICY.approveRequiresOwner && !input.canApprove) {
    return { ok: false, result: { status: 403, body: { success: false, code: 'OWNER_REQUIRED', error: 'Only an Owner can approve a line' } } };
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, MAX_REASON) : '';
  if (status === 'rejected' && LINE_MARK_POLICY.rejectRequiresReason && !reason) {
    return { ok: false, result: { status: 400, body: { success: false, code: 'REASON_REQUIRED', error: 'A rejection needs a one-line reason' } } };
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
  const via: MarkVia = isMarkVia(input.via) ? input.via : 'api';
  return { ok: true, entry: { status, via, why: cleanWhy(input.why), reason, anchor, replaceIds, replaceAnchors } };
}

/** Writes validated entries in one database transaction. Returns the new marks and removed ids. */
function applyEntries(slug: string, by: string, entries: ValidEntry[]): { marks: Array<LineMark | null>; removed: string[] } {
  const now = new Date().toISOString();
  const marks: Array<LineMark | null> = [];
  const removed: string[] = [];
  const key = actorKey(by);
  const run = () => {
    for (const entry of entries) {
      const { status, reason, anchor } = entry;
      const id = randomUUID();
      const excerpt = normalizeLineText(String(anchor.excerpt ?? '')).slice(0, 80);
      const lineText = typeof anchor.text === 'string' ? normalizeLineText(anchor.text).slice(0, LINE_TEXT_MAX) : '';
      const markReason = status === 'rejected' ? reason : (reason || null);
      const why = entry.why && (WHY_POLICY.lineMarkWhyFromHumans || isAiActor(by)) ? entry.why : null;
      removed.push(...replaceDocumentLineMark({
        slug,
        actorKey: key,
        replaceIds: entry.replaceIds,
        replaceAnchors: entry.replaceAnchors,
        anchor,
        next: status
          ? {
            id,
            by_actor: by,
            status,
            reason: markReason,
            line_hash: anchor.hash,
            line_occurrence: anchor.occurrence,
            line_ordinal: anchor.ordinal,
            line_kind: anchor.kind,
            line_excerpt: excerpt,
            at: now,
            via: entry.via,
            line_text: lineText || null,
            why,
          }
          : null,
      }));
      marks.push(status ? { id, by, status, reason: markReason, at: now, anchor: { ...anchor, excerpt, ...(lineText ? { text: lineText } : {}) }, via: entry.via, ...(why ? { why } : {}) } : null);
    }
  };
  if (entries.length === 1) run();
  else getDb().transaction(run)();
  return { marks, removed };
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
  /** Step B3b: how the mark was earned (MarkVia; default "api"). */
  via?: unknown;
  /** Step B4c: an AI's one-line rationale. */
  why?: unknown;
  anchor: unknown;
  replaceIds?: unknown;
  replaceAnchors?: unknown;
  canApprove: boolean;
  source: 'page' | 'agent';
}): LineMarkResult {
  const by = cleanActor(input.by);
  if (!by) return invalidActor();
  const checked = validateEntry(input);
  if (!checked.ok) return checked.result;
  const { marks, removed } = applyEntries(slug, by, [checked.entry]);
  const mark = marks[0];
  const { status, anchor } = checked.entry;
  try {
    addDocumentEvent(slug, 'line_mark.updated', { markId: mark?.id ?? null, removed, status: status ?? 'unseen', via: checked.entry.via, ...(mark?.why ? { why: mark.why } : {}), anchor: { hash: anchor.hash, excerpt: mark?.anchor.excerpt ?? anchor.excerpt }, source: input.source }, by);
  } catch (error) {
    console.warn('[line-marks] failed to record event', { slug, error: String(error) });
  }
  broadcastToRoom(slug, { type: 'line-marks.updated', by, timestamp: new Date().toISOString() });
  return { status: 200, body: { success: true, lineMark: mark, removed } };
}

function invalidActor(): LineMarkResult {
  return { status: 400, body: { success: false, code: 'INVALID_ACTOR', error: 'Missing or invalid "by" (for example "human:Mike" or "ai:claude")' } };
}

export interface LineMarkBatchEntry {
  anchor: unknown;
  why?: unknown;
  /** Overrides the batch's status for this line (an undo restores each line's own earlier mark). */
  status?: unknown;
  reason?: unknown;
  via?: unknown;
  replaceIds?: unknown;
  replaceAnchors?: unknown;
}

/**
 * Step B2: set one actor's marks on many lines in one request and one transaction (marking a
 * folded section). All entries are checked first; if any is invalid nothing is written and the
 * error names its index. One event (line_mark.batch) and one room broadcast.
 */
export function writeLineMarksBatch(slug: string, input: {
  by: unknown;
  status: unknown;
  reason?: unknown;
  /** Step B3b: default via for every entry (a section batch is "section"). */
  via?: unknown;
  /** Step B4c: default rationale for every entry (an AI's batch). */
  why?: unknown;
  lines: unknown;
  canApprove: boolean;
  source: 'page' | 'agent';
  /** Extra fields for the event and the response (for example the section heading). */
  context?: Record<string, unknown>;
}): LineMarkResult {
  const by = cleanActor(input.by);
  if (!by) return invalidActor();
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    return { status: 400, body: { success: false, code: 'INVALID_LINES', error: '"lines" must be a non-empty array' } };
  }
  if (input.lines.length > FOLDING.maxBatchLines) {
    return { status: 400, body: { success: false, code: 'BATCH_TOO_LARGE', error: `At most ${FOLDING.maxBatchLines} lines per request` } };
  }
  const entries: ValidEntry[] = [];
  const seenAnchors = new Map<string, number>();
  for (let i = 0; i < input.lines.length; i += 1) {
    const raw = input.lines[i] as LineMarkBatchEntry | null;
    if (!raw || typeof raw !== 'object') {
      return { status: 400, body: { success: false, code: 'INVALID_LINES', error: `lines[${i}] is not an object`, index: i } };
    }
    const checked = validateEntry({
      status: raw.status !== undefined ? raw.status : input.status,
      reason: raw.reason !== undefined ? raw.reason : input.reason,
      via: raw.via !== undefined ? raw.via : input.via,
      why: raw.why !== undefined ? raw.why : input.why,
      anchor: raw.anchor,
      replaceIds: raw.replaceIds,
      replaceAnchors: raw.replaceAnchors,
      canApprove: input.canApprove,
    });
    if (!checked.ok) {
      return { status: checked.result.status, body: { ...checked.result.body, index: i } };
    }
    // The same line twice: the later entry wins.
    const key = `${checked.entry.anchor.hash}:${checked.entry.anchor.occurrence}`;
    const earlier = seenAnchors.get(key);
    if (earlier !== undefined) entries[earlier] = checked.entry;
    else { seenAnchors.set(key, entries.length); entries.push(checked.entry); }
  }
  const { marks, removed } = applyEntries(slug, by, entries);
  const statuses = [...new Set(entries.map(entry => entry.status ?? 'unseen'))];
  try {
    addDocumentEvent(slug, 'line_mark.batch', {
      count: entries.length,
      statuses,
      removed: removed.length,
      anchors: entries.slice(0, 50).map(entry => ({ hash: entry.anchor.hash, excerpt: normalizeLineText(String(entry.anchor.excerpt ?? '')).slice(0, 80) })),
      source: input.source,
      ...(input.context ?? {}),
    }, by);
  } catch (error) {
    console.warn('[line-marks] failed to record batch event', { slug, error: String(error) });
  }
  broadcastToRoom(slug, { type: 'line-marks.updated', by, timestamp: new Date().toISOString() });
  return { status: 200, body: { success: true, count: entries.length, lineMarks: marks, removed, ...(input.context ?? {}) } };
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

/** This actor's stale marks that sit on `line` (from before an edit): replaced by a new mark. */
function staleIdsOnLine(lines: DocLine[], line: DocLine, own: LineMark[]): string[] {
  const anchor = anchorForLine(line);
  const ids: string[] = [];
  for (const mark of own) {
    if (mark.anchor.hash === anchor.hash && mark.anchor.occurrence === anchor.occurrence) continue;
    const onThisLine = !lines.some(candidate => candidate.hash === mark.anchor.hash) && mark.anchor.ordinal === line.index;
    if (onThisLine) ids.push(mark.id);
  }
  return ids;
}

/**
 * Agent write: resolve the target against current text, then write with that line's anchor.
 * Step B2 adds two batch forms (one request, one transaction):
 *   { status, lines: [target, ...] }  each target is { lineIndex | hash[, occurrence] | ref | quote }
 *                                     and may carry its own status and reason;
 *   { status, section: target }       the target must be a heading; every line of its section
 *                                     (the heading included) gets the mark.
 */
export async function writeAgentLineMark(slug: string, markdown: string, body: Record<string, unknown>, options: {
  by: string;
  canApprove: boolean;
}): Promise<LineMarkResult> {
  const lines = await computeServerLines(markdown);
  const own = listLineMarks(slug).filter(mark => actorKey(mark.by) === actorKey(options.by));
  const describe = (line: DocLine) => ({ lineIndex: line.index, ref: `b${line.block + 1}`, text: line.text.slice(0, 200), hash: line.hash });
  const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): LineMarkResult =>
    ({ status, body: { success: false, code, error, ...extra } });

  if (body.section !== undefined && body.section !== null) {
    if (!body.section || typeof body.section !== 'object' || Array.isArray(body.section)) {
      return fail(400, 'INVALID_SECTION', '"section" must be a target object, for example {"quote": "Heading text"}');
    }
    if ((body.status === 'rejected') && !FOLDING.allowSectionReject) {
      return fail(400, 'SECTION_REJECT_NOT_ALLOWED', 'A whole section cannot be rejected: reject a specific line, with a reason');
    }
    const target = resolveAgentLineTarget(lines, body.section as Record<string, unknown>);
    if (!target.ok) return fail(target.status, target.code, target.error, target.candidates ? { candidates: target.candidates } : {});
    const section = sectionByHeading(computeSections(lines), target.line.index);
    if (!section) return fail(409, 'NOT_A_HEADING', 'The section target must be a top-level heading line', { line: describe(target.line) });
    const members = sectionLineIndices(section).map(index => lines[index]);
    const result = writeLineMarksBatch(slug, {
      by: options.by,
      status: body.status,
      reason: body.reason,
      why: body.why,
      lines: members.map(line => ({ anchor: anchorForLine(line), replaceIds: staleIdsOnLine(lines, line, own) })),
      via: 'section',
      canApprove: options.canApprove,
      source: 'agent',
      context: { section: { heading: describe(target.line), level: section.level, lines: members.length } },
    });
    return result;
  }

  if (Array.isArray(body.lines)) {
    if (body.lines.length === 0) return fail(400, 'INVALID_LINES', '"lines" must be a non-empty array');
    if (body.lines.length > FOLDING.maxBatchLines) return fail(400, 'BATCH_TOO_LARGE', `At most ${FOLDING.maxBatchLines} lines per request`);
    const entries: LineMarkBatchEntry[] = [];
    const resolved: DocLine[] = [];
    for (let i = 0; i < body.lines.length; i += 1) {
      const raw = body.lines[i];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(400, 'INVALID_LINES', `lines[${i}] is not a target object`, { index: i });
      const item = raw as Record<string, unknown>;
      const target = resolveAgentLineTarget(lines, item);
      if (!target.ok) return fail(target.status, target.code, `lines[${i}]: ${target.error}`, { index: i, ...(target.candidates ? { candidates: target.candidates } : {}) });
      resolved.push(target.line);
      entries.push({
        anchor: anchorForLine(target.line),
        ...(item.status !== undefined ? { status: item.status } : {}),
        ...(item.reason !== undefined ? { reason: item.reason } : {}),
        ...(item.why !== undefined ? { why: item.why } : {}),
        replaceIds: staleIdsOnLine(lines, target.line, own),
      });
    }
    const result = writeLineMarksBatch(slug, {
      by: options.by,
      status: body.status,
      reason: body.reason,
      why: body.why,
      lines: entries,
      canApprove: options.canApprove,
      source: 'agent',
    });
    if (result.status === 200) result.body.lines = resolved.map(describe);
    return result;
  }

  const target = resolveAgentLineTarget(lines, body);
  if (!target.ok) return fail(target.status, target.code, target.error, target.candidates ? { candidates: target.candidates } : {});
  const result = writeLineMark(slug, {
    by: options.by,
    status: body.status,
    reason: body.reason,
    why: body.why,
    anchor: anchorForLine(target.line),
    replaceIds: staleIdsOnLine(lines, target.line, own),
    canApprove: options.canApprove,
    source: 'agent',
  });
  if (result.status === 200) result.body.line = describe(target.line);
  return result;
}
