/**
 * Proof Documents Step B3 — server side of `{ask}` decision lines.
 *
 * Authorship: direction by Mike Wolf (18 Sept 2026, "incorporate the ideas in Pulse Zero");
 * built by Claude Opus 5 (worker proof-ask), 2026-09-18.
 *
 * Storage: document_asks (one row per ask) and document_ask_answers (every answer, never
 * rewritten: the audit trail of each person's exact words). Both sit beside the document, like
 * line marks, so no collab, repair or projection path can drop or duplicate an ask.
 * Agents learn about answers from `ask.answered` events and from `asks` in /state.
 */
import { randomUUID } from 'crypto';
import {
  addDocumentEvent,
  getDocumentAsk,
  insertDocumentAsk,
  insertDocumentAskAnswer,
  listDocumentAskAnswers,
  listDocumentAsks,
  updateDocumentAskAnchor,
  updateDocumentAskFields,
  type DocumentAskRow,
} from './db.js';
import { broadcastToRoom } from './ws.js';
import { computeServerLines, documentOwnerActors, listLineMarks, resolveAgentLineTarget, writeLineMark } from './line-marks.js';
import {
  ASK_POLICY,
  askIssueInputs,
  describeAsk,
  evaluateAsk,
  evaluateAsks,
  isAskedOf,
  normalizeAskActor,
  oneLine,
  parseAskChoice,
  type AskAnswer,
  type AskView,
  type ProofAsk,
} from '../src/shared/asks.js';
import { actorKey, anchorForLine, isLineAnchor, normalizeLineText, type DocLine, type LineAnchor } from '../src/shared/line-marks.js';

export type AskResult = { status: number; body: Record<string, unknown> };

const MAX_ACTOR = 120;

function fail(status: number, code: string, error: string, extra: Record<string, unknown> = {}): AskResult {
  return { status, body: { success: false, code, error, ...extra } };
}

function cleanActor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed || trimmed.length > MAX_ACTOR || /[\x00-\x1f\x7f]/.test(trimmed)) return null;
  return trimmed;
}

function parseTo(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function rowToAsk(row: DocumentAskRow, answers: AskAnswer[]): ProofAsk {
  return {
    id: row.id,
    by: row.by_actor,
    to: parseTo(row.to_json),
    recommend: row.recommend,
    ifYes: row.if_yes,
    anchor: {
      hash: row.line_hash,
      occurrence: row.line_occurrence,
      ordinal: row.line_ordinal,
      kind: row.line_kind,
      excerpt: row.line_excerpt,
    },
    createdAt: row.created_at,
    askedAt: row.asked_at,
    answers,
  };
}

/** Every live (not withdrawn) ask in the document, with every answer. */
export function listAsks(slug: string): ProofAsk[] {
  const answersByAsk = new Map<string, AskAnswer[]>();
  for (const row of listDocumentAskAnswers(slug)) {
    const choice = parseAskChoice(row.choice);
    if (!choice) continue;
    const list = answersByAsk.get(row.ask_id) ?? [];
    list.push({ id: row.id, by: row.by_actor, choice, words: row.words, at: row.created_at, lineHash: row.line_hash });
    answersByAsk.set(row.ask_id, list);
  }
  return listDocumentAsks(slug).map(row => rowToAsk(row, answersByAsk.get(row.id) ?? []));
}

function getAsk(slug: string, id: string): ProofAsk | null {
  const row = getDocumentAsk(slug, id);
  if (!row || row.withdrawn_at) return null;
  return listAsks(slug).find(ask => ask.id === id) ?? null;
}

/**
 * An ask follows its line. When the line's text changed (or it moved), store the line's current
 * anchor so the next insertion above it cannot shift the ask onto another line. The answers keep
 * the hash they were given under, so a changed question still reopens them.
 */
export function reanchorAsks(slug: string, asks: ProofAsk[], lines: DocLine[]): void {
  for (const ask of asks) {
    const view = evaluateAsk(ask, lines);
    if (view.lineIndex === null) continue;
    const line = lines[view.lineIndex];
    const same = ask.anchor.hash === line.hash && ask.anchor.occurrence === line.occurrence && ask.anchor.ordinal === line.index;
    if (same) continue;
    const anchor = anchorForLine(line);
    try {
      updateDocumentAskAnchor(slug, ask.id, anchor);
      ask.anchor = anchor;
    } catch (error) {
      console.warn('[asks] re-anchor failed', { slug, id: ask.id, error: String(error) });
    }
  }
}

/** The JSON shape of one ask for agents (/state, GET /asks, responses). */
export function serializeAskView(view: AskView, lines: DocLine[]): Record<string, unknown> {
  const line = view.lineIndex === null ? null : lines[view.lineIndex];
  return {
    id: view.ask.id,
    by: view.ask.by,
    to: view.ask.to,
    question: line ? line.text : view.ask.anchor.excerpt,
    recommend: view.ask.recommend,
    ifYes: view.ask.ifYes,
    lineIndex: view.lineIndex,
    ref: line ? `b${line.block + 1}` : null,
    lineHash: view.lineHash,
    orphaned: view.lineIndex === null,
    createdAt: view.ask.createdAt,
    askedAt: view.ask.askedAt,
    status: view.outcome,
    summary: describeAsk(view),
    closed: view.closed,
    settled: view.settled,
    openFor: view.openFor,
    snoozedFor: view.snoozedFor,
    people: view.people.map(p => ({ actor: p.actor, state: p.state, choice: p.answer?.choice ?? null, words: p.answer?.words ?? null, at: p.answer?.at ?? null })),
    /** Answers that count now (latest per person). */
    answers: view.answers,
    /** Every answer ever given, oldest first (includes ones a re-ask or an edit set aside). */
    history: view.ask.answers,
  };
}

export interface AskReport {
  asks: Array<Record<string, unknown>>;
  views: AskView[];
  issueInputs: ReturnType<typeof askIssueInputs>;
}

/** Asks for /state and GET /asks: evaluated against the current lines, re-anchored. */
export function buildAskReport(slug: string, lines: DocLine[]): AskReport {
  const asks = listAsks(slug);
  reanchorAsks(slug, asks, lines);
  const views = evaluateAsks(asks, lines);
  return { asks: views.map(view => serializeAskView(view, lines)), views, issueInputs: askIssueInputs(views) };
}

// ============================================================================
// Create
// ============================================================================

/** Validates and normalizes `to`: an array of identities (bare names become humans). */
function parseToInput(raw: unknown, slug: string): { ok: true; to: string[] } | { ok: false; result: AskResult } {
  if (raw === undefined || raw === null) {
    return { ok: true, to: documentOwnerActors(slug) };
  }
  const list = typeof raw === 'string' ? [raw] : raw;
  if (!Array.isArray(list)) return { ok: false, result: fail(400, 'INVALID_TO', '"to" must be a list of identities, for example ["human:Mike"]') };
  if (list.length > ASK_POLICY.maxTo) return { ok: false, result: fail(400, 'INVALID_TO', `At most ${ASK_POLICY.maxTo} people per ask`) };
  const out: string[] = [];
  const keys = new Set<string>();
  for (const entry of list) {
    const actor = typeof entry === 'string' ? normalizeAskActor(entry) : '';
    if (!actor || !cleanActor(actor)) return { ok: false, result: fail(400, 'INVALID_TO', `Invalid identity in "to": ${JSON.stringify(entry)}`) };
    const key = actorKey(actor);
    if (keys.has(key)) continue;
    keys.add(key);
    out.push(actor);
  }
  return { ok: true, to: out };
}

/**
 * Creates an ask on an existing line of `markdown` (the current document). The caller resolves
 * the line; this checks the fields, writes the row, records `ask.created` and tells open pages.
 */
export function createAskOnLine(slug: string, line: DocLine, lines: DocLine[], input: {
  by: string;
  to: unknown;
  recommend: unknown;
  ifYes?: unknown;
  source: 'agent' | 'page';
}): AskResult {
  const by = cleanActor(input.by);
  if (!by) return fail(400, 'INVALID_ACTOR', 'Missing or invalid "by" (for example "ai:claude")');
  const recommend = oneLine(input.recommend, ASK_POLICY.maxRecommend);
  if (!recommend) {
    return fail(400, 'RECOMMEND_REQUIRED', 'An ask carries one recommendation line ("recommend"): what you would do, not a menu');
  }
  const ifYes = input.ifYes === undefined || input.ifYes === null ? '' : oneLine(input.ifYes, ASK_POLICY.maxIfYes);
  const to = parseToInput(input.to, slug);
  if (!to.ok) return to.result;
  if (ASK_POLICY.oneAskPerLine) {
    const existing = evaluateAsks(listAsks(slug), lines).find(view => view.lineIndex === line.index);
    if (existing) {
      return fail(409, 'ASK_EXISTS', 'This line already carries an ask. Re-ask it (POST /asks/:id/reask) or withdraw it first.', { ask: serializeAskView(existing, lines) });
    }
  }
  const now = new Date().toISOString();
  const anchor = anchorForLine(line);
  const row: DocumentAskRow = {
    id: randomUUID(),
    document_slug: slug,
    by_actor: by,
    to_json: JSON.stringify(to.to),
    recommend,
    if_yes: ifYes || null,
    line_hash: anchor.hash,
    line_occurrence: anchor.occurrence,
    line_ordinal: anchor.ordinal,
    line_kind: anchor.kind,
    line_excerpt: normalizeLineText(anchor.excerpt).slice(0, 80),
    created_at: now,
    asked_at: now,
    withdrawn_at: null,
  };
  insertDocumentAsk(row);
  const ask = rowToAsk(row, []);
  const view = evaluateAsk(ask, lines);
  try {
    addDocumentEvent(slug, 'ask.created', {
      askId: ask.id, question: line.text.slice(0, 300), recommend, ifYes: ask.ifYes, to: ask.to, lineIndex: line.index, source: input.source,
    }, by);
  } catch (error) {
    console.warn('[asks] failed to record event', { slug, error: String(error) });
  }
  broadcastToRoom(slug, { type: 'line-marks.updated', by, timestamp: now });
  return { status: 200, body: { success: true, ask: serializeAskView(view, lines) } };
}

// ============================================================================
// Answer
// ============================================================================

/**
 * Records one answer. `lines` are the document's current lines (the agent path computes them;
 * the page path passes the question line's current anchor and hash, which it just read).
 */
export function answerAsk(slug: string, input: {
  id: string;
  by: unknown;
  choice: unknown;
  words?: unknown;
  /** The question line as the answerer sees it now. */
  line: { anchor: LineAnchor } | null;
  source: 'agent' | 'page';
  canMark: boolean;
}): AskResult {
  const by = cleanActor(input.by);
  if (!by) return fail(400, 'INVALID_ACTOR', 'Missing or invalid "by"');
  const ask = getAsk(slug, input.id);
  if (!ask) return fail(404, 'ASK_NOT_FOUND', 'No such ask (it may have been withdrawn)');
  const choice = parseAskChoice(input.choice);
  if (!choice) return fail(400, 'INVALID_CHOICE', '"choice" must be yes, not_yet or no');
  // The person's exact words: only trimmed, never rewritten.
  const words = typeof input.words === 'string' ? input.words.trim().slice(0, ASK_POLICY.maxWords) : '';
  if (ASK_POLICY.reasonRequired[choice] && !words) {
    return fail(400, 'REASON_REQUIRED', `"${choice === 'no' ? 'No' : 'Not yet'}" needs a reason line in "words"`);
  }
  if (!input.line || !isLineAnchor(input.line.anchor)) {
    return fail(409, 'LINE_NOT_FOUND', 'The question line is not in the document any more');
  }
  const anchor = input.line.anchor;
  const now = new Date().toISOString();
  const answer: AskAnswer = { id: randomUUID(), by, choice, words, at: now, lineHash: anchor.hash };
  insertDocumentAskAnswer({
    id: answer.id, ask_id: ask.id, document_slug: slug, by_actor: by, choice, words, line_hash: anchor.hash, created_at: now,
  });
  // The ask follows the line the answerer saw.
  if (ask.anchor.hash !== anchor.hash || ask.anchor.occurrence !== anchor.occurrence || ask.anchor.ordinal !== anchor.ordinal) {
    try { updateDocumentAskAnchor(slug, ask.id, { ...anchor, excerpt: normalizeLineText(String(anchor.excerpt ?? '')).slice(0, 80) }); } catch { /* next read re-anchors */ }
  }
  // Answering is reading: the answerer's line mark becomes Seen when they had none (never lowered).
  let lineMarked = false;
  if (ASK_POLICY.answerMarksLineSeen && input.canMark) {
    const me = actorKey(by);
    const hasCurrent = listLineMarks(slug).some(mark => actorKey(mark.by) === me
      && mark.anchor.hash === anchor.hash && mark.anchor.occurrence === anchor.occurrence);
    if (!hasCurrent) {
      const marked = writeLineMark(slug, { by, status: 'seen', anchor, canApprove: false, source: input.source });
      lineMarked = marked.status === 200;
    }
  }
  ask.answers.push(answer);
  const askedOf = isAskedOf(ask, by);
  try {
    addDocumentEvent(slug, 'ask.answered', {
      askId: ask.id,
      choice,
      words,
      question: normalizeLineText(String(anchor.excerpt ?? '')) || ask.anchor.excerpt,
      recommend: ask.recommend,
      ifYes: ask.ifYes,
      lineHash: anchor.hash,
      askedOf,
      source: input.source,
    }, by);
  } catch (error) {
    console.warn('[asks] failed to record answer event', { slug, error: String(error) });
  }
  broadcastToRoom(slug, { type: 'line-marks.updated', by, timestamp: now });
  return { status: 200, body: { success: true, answer, askedOf, lineMarked, askId: ask.id } };
}

// ============================================================================
// Re-ask and withdraw (the asker, or the document owner)
// ============================================================================

export function reaskAsk(slug: string, input: { id: string; by: unknown; isOwner: boolean; recommend?: unknown; ifYes?: unknown; to?: unknown }): AskResult {
  const by = cleanActor(input.by);
  if (!by) return fail(400, 'INVALID_ACTOR', 'Missing or invalid "by"');
  const ask = getAsk(slug, input.id);
  if (!ask) return fail(404, 'ASK_NOT_FOUND', 'No such ask');
  if (!input.isOwner && actorKey(ask.by) !== actorKey(by)) return fail(403, 'ASKER_REQUIRED', 'Only the asker (or the document owner) can re-ask');
  const fields: Parameters<typeof updateDocumentAskFields>[2] = { asked_at: new Date().toISOString() };
  if (input.recommend !== undefined) {
    const recommend = oneLine(input.recommend, ASK_POLICY.maxRecommend);
    if (!recommend) return fail(400, 'RECOMMEND_REQUIRED', '"recommend" cannot be empty');
    fields.recommend = recommend;
  }
  if (input.ifYes !== undefined) fields.if_yes = input.ifYes === null ? null : (oneLine(input.ifYes, ASK_POLICY.maxIfYes) || null);
  if (input.to !== undefined) {
    const to = parseToInput(input.to, slug);
    if (!to.ok) return to.result;
    fields.to_json = JSON.stringify(to.to);
  }
  updateDocumentAskFields(slug, ask.id, fields);
  try { addDocumentEvent(slug, 'ask.reasked', { askId: ask.id, ...fields }, by); } catch { /* optional */ }
  broadcastToRoom(slug, { type: 'line-marks.updated', by, timestamp: new Date().toISOString() });
  return { status: 200, body: { success: true, askId: ask.id, askedAt: fields.asked_at } };
}

export function withdrawAsk(slug: string, input: { id: string; by: unknown; isOwner: boolean }): AskResult {
  const by = cleanActor(input.by);
  if (!by) return fail(400, 'INVALID_ACTOR', 'Missing or invalid "by"');
  const ask = getAsk(slug, input.id);
  if (!ask) return fail(404, 'ASK_NOT_FOUND', 'No such ask');
  if (!input.isOwner && actorKey(ask.by) !== actorKey(by)) return fail(403, 'ASKER_REQUIRED', 'Only the asker (or the document owner) can withdraw an ask');
  updateDocumentAskFields(slug, ask.id, { withdrawn_at: new Date().toISOString() });
  try { addDocumentEvent(slug, 'ask.withdrawn', { askId: ask.id }, by); } catch { /* optional */ }
  broadcastToRoom(slug, { type: 'line-marks.updated', by, timestamp: new Date().toISOString() });
  return { status: 200, body: { success: true, askId: ask.id } };
}

// ============================================================================
// Agent helpers
// ============================================================================

/** Agent create on an existing line: { lineIndex | hash[, occurrence] | ref | quote, to?, recommend, ifYes? }. */
export async function createAgentAsk(slug: string, markdown: string, body: Record<string, unknown>, by: string): Promise<AskResult> {
  const lines = await computeServerLines(markdown);
  const target = resolveAgentLineTarget(lines, body);
  if (!target.ok) return fail(target.status, target.code, target.error, target.candidates ? { candidates: target.candidates } : {});
  return createAskOnLine(slug, target.line, lines, { by, to: body.to, recommend: body.recommend, ifYes: body.ifYes, source: 'agent' });
}

/** Agent answer: the question line is found in the current text. */
export async function answerAgentAsk(slug: string, markdown: string, id: string, body: Record<string, unknown>, by: string, canMark: boolean): Promise<AskResult> {
  const lines = await computeServerLines(markdown);
  const ask = getAsk(slug, id);
  if (!ask) return fail(404, 'ASK_NOT_FOUND', 'No such ask (it may have been withdrawn)');
  const view = evaluateAsk(ask, lines);
  const line = view.lineIndex === null ? null : lines[view.lineIndex];
  return answerAsk(slug, { id, by, choice: body.choice, words: body.words, line: line ? { anchor: anchorForLine(line) } : null, source: 'agent', canMark });
}

export async function listAgentAsks(slug: string, markdown: string): Promise<AskResult> {
  const lines = await computeServerLines(markdown);
  const report = buildAskReport(slug, lines);
  return { status: 200, body: { success: true, asks: report.asks, policy: ASK_POLICY } };
}
