import { moveBundles } from '../src/shared/moves.js';
import { parseStoredMarks } from './line-marks.js';
/**
 * Proof Documents Steps B4e + B4f — server side of review bundles, competing alternatives, blind
 * marking, Explain and perishable claims.
 *
 * Authorship: brief by the COS (Claude), 2026-09-19, from the overnight research round (Anthropic
 * Fable, OpenAI Astra); built by Claude Opus 5 (worker proof-bundles), 2026-09-19.
 *
 * Every write records a document event (so a Familiar can follow along) and tells open pages
 * through the same room broadcast line marks use. Edits to the text (accepting a bundle, applying
 * the winning alternative) go through the caller's editor functions, so the routes keep their
 * usual collaboration handling.
 */
import { randomUUID } from 'crypto';
import { addDocumentEvent } from './db.js';
import { broadcastToRoom } from './ws.js';
import { computeDocumentTeam, computeServerLines, listCanonicalLineMarks, reviewMarksFromStored, resolveAgentLineTarget } from './line-marks.js';
import {
  closeAlternativeRow,
  reopenAlternativeRow,
  closeBundleRow,
  clearTtlRow,
  deletePicksForLine,
  getAlternative,
  getBundle,
  getProofSettings,
  getTtl,
  insertAlternative,
  insertBundle,
  insertExplain,
  insertTtl,
  listAlternatives,
  listBundles,
  listPicks,
  listTtls,
  setBlind,
  updateBundleMembers,
  updateBundleText,
  updateTtlChecks,
  updateTtlPeriod,
  upsertPick,
} from './proof-extras-store.js';
import { readExtras, serializeAltSet, serializeBundle, serializeTtl, serverSuggestionLocator } from './proof-extras-eval.js';
import { buildDirectory } from './identity.js';
import { listCanonicalAsks } from './asks.js';
import { currentDocumentState } from './alignment.js';
import { askTeamActors } from '../src/shared/asks.js';
import { listFlags, listObjections } from './review-aids-store.js';
import {
  actorKey,
  anchorForLine,
  buildLineStates,
  isAiActor,
  isLineAnchor,
  normalizeLineText,
  resolveLineAnchor,
  LINE_TEXT_MAX,
  type DocLine,
  type LineAnchor,
} from '../src/shared/line-marks.js';
import { BUNDLE_POLICY, cleanBundleText, evaluateBundle, isBundleId, type BundleMember, type ProofBundle } from '../src/shared/bundles.js';
import { ALT_POLICY, altLineIndex, cleanAltText, evaluateAlternatives, type AltSetView, type ProofAlternative } from '../src/shared/alternatives.js';
import { EXPLAIN_POLICY } from '../src/shared/explain.js';
import { TTL_POLICY, evaluateTtls, parseTtl, type ProofTtl } from '../src/shared/ttl.js';

export type ExtraResult = { status: number; body: Record<string, unknown> };

function fail(status: number, code: string, error: string, extra: Record<string, unknown> = {}): ExtraResult {
  return { status, body: { success: false, code, error, ...extra } };
}

function touch(slug: string, by: string): void {
  broadcastToRoom(slug, { type: 'line-marks.updated', by, timestamp: new Date().toISOString() });
}

function event(slug: string, type: string, data: Record<string, unknown>, by: string): void {
  try { addDocumentEvent(slug, type, data, by); } catch (error) { console.warn('[proof-extras] event failed', { slug, type, error: String(error) }); }
}

function cleanAnchor(anchor: LineAnchor): LineAnchor {
  const out: LineAnchor = {
    hash: anchor.hash, occurrence: anchor.occurrence, ordinal: anchor.ordinal, kind: anchor.kind,
    excerpt: normalizeLineText(String(anchor.excerpt ?? '')).slice(0, 80),
  };
  if (typeof anchor.text === 'string' && anchor.text) out.text = normalizeLineText(anchor.text).slice(0, LINE_TEXT_MAX);
  return out;
}

/** Resolves a page anchor (or an agent line target) to a current line. */
function lineFor(lines: DocLine[], target: { anchor?: unknown; body?: Record<string, unknown> }): { ok: true; line: DocLine } | { ok: false; result: ExtraResult } {
  if (target.anchor !== undefined) {
    if (!isLineAnchor(target.anchor)) return { ok: false, result: fail(400, 'INVALID_ANCHOR', 'Missing or invalid line anchor') };
    const resolved = resolveLineAnchor(lines, target.anchor as LineAnchor);
    if (!resolved || !resolved.current) return { ok: false, result: fail(409, 'LINE_CHANGED', 'That line changed; reload and try again') };
    return { ok: true, line: lines[resolved.lineIndex] };
  }
  const found = resolveAgentLineTarget(lines, target.body ?? {});
  if (!found.ok) return { ok: false, result: fail(found.status, found.code, found.error, found.candidates ? { candidates: found.candidates } : {}) };
  return { ok: true, line: found.line };
}

// ============================================================================
// B4e: review bundles
// ============================================================================

/**
 * Reads a `bundle` field from a suggestion request: { id, title?, why? } (or a bare id string for a
 * bundle that already exists). Null when the request has none.
 */
export function bundleField(payload: Record<string, unknown>): { id: string; title: string | null; why: string | null } | { error: ExtraResult } | null {
  const raw = payload.bundle;
  if (raw === undefined || raw === null) return null;
  const obj = typeof raw === 'string' ? { id: raw } : (typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null);
  if (!obj || !isBundleId(obj.id)) return { error: fail(400, 'INVALID_BUNDLE', `"bundle" must be {"id": "<1-64 letters, digits, _ . : ->", "title": "...", "why": "..."}`) };
  const title = cleanBundleText(obj.title, BUNDLE_POLICY.maxTitle) || null;
  const why = cleanBundleText(obj.why, BUNDLE_POLICY.maxWhy) || null;
  return { id: obj.id as string, title, why };
}

/** Checks a bundle field before the suggestion is written (a new bundle needs a title). */
export function checkBundleField(slug: string, field: { id: string; title: string | null }): ExtraResult | null {
  const existing = getBundle(slug, field.id);
  if (existing && existing.status !== 'open') return fail(409, 'BUNDLE_CLOSED', `Bundle ${field.id} is already ${existing.status}`);
  if (!existing && BUNDLE_POLICY.titleRequired && !field.title) return fail(400, 'BUNDLE_TITLE_REQUIRED', 'A new bundle needs a "title" (what the change does, in a few words)');
  if (existing && existing.members.length >= BUNDLE_POLICY.maxMembers) return fail(400, 'BUNDLE_FULL', `A bundle holds at most ${BUNDLE_POLICY.maxMembers} suggestions`);
  return null;
}

/** Re-records every member's target hash from the document now (BUNDLE_POLICY.refreshTargetsOnAdd). */
function refreshMembers(slug: string, members: BundleMember[], lines: DocLine[], rawMarks: unknown): BundleMember[] {
  const locate = serverSuggestionLocator(slug, lines, rawMarks);
  return members.map(member => {
    const where = locate(member.markId);
    const line = where.lineIndex === null ? null : lines[where.lineIndex];
    return { ...member, lineHash: line ? line.hash : member.lineHash };
  });
}

/**
 * Adds suggestions to a bundle (creating it when new). Every id must be a pending suggestion in
 * no other open bundle. Used by POST /bundles and by the suggest routes' `bundle` field.
 */
export async function addToBundle(slug: string, input: {
  by: string;
  bundle: { id?: string | null; title?: unknown; why?: unknown };
  markIds: unknown;
  markdown: string;
  rawMarks: unknown;
  source: 'page' | 'agent';
}): Promise<ExtraResult> {
  const ids = Array.isArray(input.markIds) ? [...new Set(input.markIds.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 100))] : [];
  if (ids.length === 0) return fail(400, 'INVALID_MARK_IDS', '"markIds" must list one or more suggestion ids');
  const id = input.bundle.id ?? `bundle-${randomUUID().slice(0, 8)}`;
  if (!isBundleId(id)) return fail(400, 'INVALID_BUNDLE', 'A bundle id is 1-64 letters, digits, _ . : or -');
  const title = cleanBundleText(input.bundle.title, BUNDLE_POLICY.maxTitle) || null;
  const why = cleanBundleText(input.bundle.why, BUNDLE_POLICY.maxWhy) || null;
  const existing = getBundle(slug, id);
  const check = checkBundleField(slug, { id, title });
  if (check) return check;
  const marks = (input.rawMarks && typeof input.rawMarks === 'object' ? input.rawMarks : {}) as Record<string, Record<string, unknown>>;
  const others = listBundles(slug).filter(b => b.id !== id);
  const members: BundleMember[] = [...(existing?.members ?? [])];
  for (const markId of ids) {
    const mark = marks[markId];
    const kind = typeof mark?.kind === 'string' ? mark.kind : '';
    if (!mark || !['insert', 'delete', 'replace'].includes(kind) || (typeof mark.status === 'string' && mark.status !== 'pending')) {
      return fail(409, 'NOT_A_PENDING_SUGGESTION', `${markId} is not a pending suggestion`, { markId });
    }
    if (mark.move) return fail(409, 'IN_ANOTHER_BUNDLE', 'A move already belongs to its structural bundle. Decide it as one move.');
    if (BUNDLE_POLICY.onePerSuggestion) {
      const holder = others.find(b => b.members.some(m => m.markId === markId));
      if (holder) return fail(409, 'IN_ANOTHER_BUNDLE', `${markId} already belongs to bundle ${holder.id}`, { markId, bundleId: holder.id });
    }
    if (members.some(m => m.markId === markId)) continue;
    members.push({ markId, lineHash: null, quote: String(mark.quote ?? '').slice(0, 200), kind });
  }
  if (members.length > BUNDLE_POLICY.maxMembers) return fail(400, 'BUNDLE_FULL', `A bundle holds at most ${BUNDLE_POLICY.maxMembers} suggestions`);
  const lines = await computeServerLines(input.markdown);
  const refreshed = BUNDLE_POLICY.refreshTargetsOnAdd ? refreshMembers(slug, members, lines, input.rawMarks)
    : members.map(m => (m.lineHash ? m : refreshMembers(slug, [m], lines, input.rawMarks)[0]));
  const now = new Date().toISOString();
  if (existing) {
    updateBundleMembers(slug, id, refreshed);
    if ((title && title !== existing.title) || (why && why !== existing.why)) updateBundleText(slug, id, title ?? existing.title, why ?? existing.why);
    event(slug, 'bundle.updated', { bundleId: id, added: ids, members: refreshed.length, source: input.source }, input.by);
  } else {
    const bundle: ProofBundle = { id, by: input.by, title: title as string, why, members: refreshed, createdAt: now, status: 'open', closedAt: null, closedBy: null };
    insertBundle(slug, bundle);
    event(slug, 'bundle.created', { bundleId: id, title, why, members: ids, source: input.source }, input.by);
  }
  touch(slug, input.by);
  const bundle = getBundle(slug, id)!;
  return { status: 200, body: { success: true, bundle: serializeBundle(evaluateBundle(bundle, lines, serverSuggestionLocator(slug, lines, input.rawMarks)), lines) } };
}

export async function bundleReport(slug: string, markdown: string, rawMarks: unknown, includeClosed = false): Promise<Array<Record<string, unknown>>> {
  const lines = await computeServerLines(markdown);
  const locate = serverSuggestionLocator(slug, lines, rawMarks);
  return [...listBundles(slug, { includeClosed }), ...moveBundles(parseStoredMarks(rawMarks) as any).filter(b => includeClosed || b.status === "open")].map(bundle => serializeBundle(evaluateBundle(bundle, lines, locate), lines));
}

/**
 * Accept or reject a whole bundle. Accept checks every member's target first (BUNDLE_POLICY
 * .staleRefusesAll): a stale member refuses the bundle with 409 BUNDLE_STALE and the stale ids.
 * `apply` performs the edit for the pending members in one step (the engine's batch).
 */
export async function decideBundle(slug: string, input: {
  id: string;
  by: string;
  action: 'accept' | 'reject';
  markdown: string;
  rawMarks: unknown;
  apply: (markIds: string[], action: 'accept' | 'reject') => Promise<{ status: number; body: Record<string, unknown> }>;
}): Promise<ExtraResult> {
  const bundle = getBundle(slug, input.id);
  if (!bundle) return fail(404, 'BUNDLE_NOT_FOUND', 'No such bundle');
  if (bundle.status !== 'open') return fail(409, 'BUNDLE_CLOSED', `This bundle was already ${bundle.status}`);
  const lines = await computeServerLines(input.markdown);
  const view = evaluateBundle(bundle, lines, serverSuggestionLocator(slug, lines, input.rawMarks));
  if (input.action === 'accept' && !view.acceptable) {
    const code = view.stale.length ? 'BUNDLE_STALE' : 'BUNDLE_NOT_ACCEPTABLE';
    return fail(409, code, view.stale.length
      ? `${view.stale.length} of ${bundle.members.length} changes no longer match the text they were bundled on. Nothing was changed; review them one by one.`
      : 'Nothing in this bundle can be accepted now', { stale: view.stale, bundle: serializeBundle(view, lines) });
  }
  if (view.pending.length === 0) return fail(409, 'BUNDLE_NOT_ACCEPTABLE', 'No change in this bundle is pending');
  const applied = await input.apply(view.pending, input.action);
  if (applied.status < 200 || applied.status >= 300) {
    return { status: applied.status, body: { ...applied.body, success: false, stage: 'apply', bundleId: bundle.id } };
  }
  const status = input.action === 'accept' ? 'accepted' : 'rejected';
  closeBundleRow(slug, bundle.id, status, input.by, new Date().toISOString());
  event(slug, `bundle.${status}`, {
    bundleId: bundle.id, title: bundle.title, markIds: view.pending,
    ...(input.action === 'accept' ? { note: BUNDLE_POLICY.acceptNote } : {}),
  }, input.by);
  touch(slug, input.by);
  return { status: 200, body: { success: true, bundleId: bundle.id, status, markIds: view.pending, note: input.action === 'accept' ? BUNDLE_POLICY.acceptNote : undefined } };
}

/**
 * The page applied (or rejected) a bundle itself (its editor's one-step batch): record the
 * decision and the event. The server re-checks that no member is still pending.
 */
export async function recordBundleDecision(slug: string, input: { id: string; by: string; decision: unknown; markdown: string; rawMarks: unknown }): Promise<ExtraResult> {
  const bundle = getBundle(slug, input.id);
  if (!bundle) return fail(404, 'BUNDLE_NOT_FOUND', 'No such bundle');
  if (input.decision !== 'accepted' && input.decision !== 'rejected') return fail(400, 'INVALID_DECISION', '"decision" is accepted or rejected');
  if (bundle.status !== 'open') return { status: 200, body: { success: true, bundleId: bundle.id, status: bundle.status, already: true } };
  closeBundleRow(slug, bundle.id, input.decision, input.by, new Date().toISOString());
  event(slug, `bundle.${input.decision}`, {
    bundleId: bundle.id, title: bundle.title, markIds: bundle.members.map(m => m.markId), source: 'page',
    ...(input.decision === 'accepted' ? { note: BUNDLE_POLICY.acceptNote } : {}),
  }, input.by);
  touch(slug, input.by);
  return { status: 200, body: { success: true, bundleId: bundle.id, status: input.decision } };
}

// ============================================================================
// B4f: competing alternatives
// ============================================================================

export type LineEditor = (line: DocLine, lines: DocLine[], text: string, by: string) => Promise<{ status: number; body: Record<string, unknown> }>;

/** The team as /state computes it (owners, markers, commenters, keys, askers, flaggers, objectors, offerers). */
export function currentTeam(slug: string, rawMarks: unknown): string[] {
  const dir = buildDirectory(slug);
  const lineMarks = listCanonicalLineMarks(slug, dir);
  const extras = readExtras(slug);
  const aids = [...listFlags(slug).map(f => f.by), ...listObjections(slug).map(o => o.by)];
  return computeDocumentTeam(slug, lineMarks, reviewMarksFromStored(rawMarks), [...askTeamActors(listCanonicalAsks(slug, dir)), ...aids, ...extras.teamExtra], dir);
}

function altSetFor(slug: string, lines: DocLine[], lineIndex: number, team: string[]): AltSetView | null {
  return evaluateAlternatives(listAlternatives(slug), listPicks(slug), lines, team).find(view => view.lineIndex === lineIndex) ?? null;
}

/** Offers another wording for a line. */
export async function offerAlternative(slug: string, input: {
  by: string;
  anchor?: unknown;
  target?: Record<string, unknown>;
  text: unknown;
  markdown: string;
  rawMarks: unknown;
  source: 'page' | 'agent';
  applyEdit: LineEditor;
}): Promise<ExtraResult> {
  const lines = await computeServerLines(input.markdown);
  const found = lineFor(lines, { anchor: input.anchor, body: input.target });
  if (!found.ok) return found.result;
  const line = found.line;
  if (!ALT_POLICY.kinds.includes(line.kind)) return fail(400, 'KIND_NOT_SUPPORTED', `Alternatives work on ${ALT_POLICY.kinds.join(', ')} lines; edit a ${line.kind} directly or suggest a change`);
  const text = cleanAltText(input.text);
  if (!text) return fail(400, 'TEXT_REQUIRED', '"text" (the other wording, one line) is required');
  if (normalizeLineText(text) === line.text) return fail(409, 'SAME_AS_LINE', 'That wording is the line as it is now');
  const team = currentTeam(slug, input.rawMarks);
  const set = altSetFor(slug, lines, line.index, team);
  if (set && set.options.length - 1 >= ALT_POLICY.maxPerLine) return fail(409, 'TOO_MANY_ALTERNATIVES', `A line holds at most ${ALT_POLICY.maxPerLine} alternatives (keys 1-9)`);
  if (set?.options.some(o => normalizeLineText(o.text) === normalizeLineText(text))) return fail(409, 'ALTERNATIVE_EXISTS', 'That wording is already offered');
  const now = new Date().toISOString();
  const alt: ProofAlternative = { id: randomUUID(), by: input.by, text, anchor: cleanAnchor(anchorForLine(line)), createdAt: now, status: 'open', closedAt: null, closedBy: null, resolution: null };
  insertAlternative(slug, alt);
  if (ALT_POLICY.offererPicksOwn) upsertPick(slug, { id: randomUUID(), by: input.by, choice: alt.id, lineHash: line.hash, at: now });
  event(slug, 'alternative.offered', { alternativeId: alt.id, lineIndex: line.index, line: line.text.slice(0, 200), text, source: input.source }, input.by);
  touch(slug, input.by);
  const after = await settleAlternatives(slug, { line, lines, team: [...team, input.by], by: input.by, applyEdit: input.applyEdit });
  return { status: 200, body: { success: true, alternative: { id: alt.id, text, by: alt.by, lineIndex: line.index }, set: after.set, resolved: after.resolved } };
}

/**
 * One member picks a wording ("original" keeps the line). When every team member has picked the
 * same one, it becomes the line (ALT_POLICY.unanimity).
 */
export async function pickAlternative(slug: string, input: {
  by: string;
  anchor?: unknown;
  target?: Record<string, unknown>;
  choice: unknown;
  markdown: string;
  rawMarks: unknown;
  source: 'page' | 'agent';
  applyEdit: LineEditor;
}): Promise<ExtraResult> {
  const lines = await computeServerLines(input.markdown);
  const found = lineFor(lines, { anchor: input.anchor, body: input.target });
  if (!found.ok) return found.result;
  const line = found.line;
  const team = currentTeam(slug, input.rawMarks);
  const set = altSetFor(slug, lines, line.index, team);
  if (!set) return fail(404, 'NO_ALTERNATIVES', 'This line has no open alternatives');
  const choice = resolveChoice(set, input.choice);
  if (!choice) return fail(400, 'INVALID_CHOICE', `"choice" is "original", an alternative id, or its key 1-${set.options.length}`, { options: set.options.map((o, i) => ({ key: String(i + 1), id: o.id, text: o.text })) });
  upsertPick(slug, { id: randomUUID(), by: input.by, choice, lineHash: line.hash, at: new Date().toISOString() });
  const blind = getProofSettings(slug).blind;
  event(slug, 'alternative.picked', { lineIndex: line.index, ...(blind ? { blind: true } : { choice }), source: input.source }, input.by);
  touch(slug, input.by);
  const after = await settleAlternatives(slug, { line, lines, team, by: input.by, applyEdit: input.applyEdit });
  return { status: 200, body: { success: true, choice, set: after.set, resolved: after.resolved, ...(after.error ? { applyError: after.error } : {}) } };
}

/** An Owner decides between the wordings (the choice becomes the line). */
export async function decideAlternative(slug: string, input: {
  by: string;
  isOwner: boolean;
  anchor?: unknown;
  target?: Record<string, unknown>;
  choice: unknown;
  markdown: string;
  rawMarks: unknown;
  applyEdit: LineEditor;
}): Promise<ExtraResult> {
  if (!input.isOwner || !ALT_POLICY.ownerDecides) return fail(403, 'OWNER_REQUIRED', 'Only an Owner can decide between wordings (everyone else picks)');
  const lines = await computeServerLines(input.markdown);
  const found = lineFor(lines, { anchor: input.anchor, body: input.target });
  if (!found.ok) return found.result;
  const team = currentTeam(slug, input.rawMarks);
  const set = altSetFor(slug, lines, found.line.index, team);
  if (!set) return fail(404, 'NO_ALTERNATIVES', 'This line has no open alternatives');
  const choice = resolveChoice(set, input.choice);
  if (!choice) return fail(400, 'INVALID_CHOICE', `"choice" is "original", an alternative id, or its key 1-${set.options.length}`);
  const result = await resolveSet(slug, { set, line: found.line, lines, choice, how: 'owner', by: input.by, applyEdit: input.applyEdit });
  if (!result.ok) return fail(result.status, 'ALT_APPLY_FAILED', result.error);
  return { status: 200, body: { success: true, choice, resolved: true, line: result.text } };
}

/** The offerer (or an Owner) withdraws an open alternative. */
export function withdrawAlternative(slug: string, input: { id: string; by: string; isOwner: boolean }): ExtraResult {
  const alt = getAlternative(slug, input.id);
  if (!alt || alt.status !== 'open') return fail(404, 'ALTERNATIVE_NOT_FOUND', 'No open alternative with that id');
  if (actorKey(alt.by) !== actorKey(input.by) && !input.isOwner) return fail(403, 'OFFERER_REQUIRED', 'Only the person who offered it (or an Owner) can withdraw it');
  closeAlternativeRow(slug, alt.id, 'withdrawn', input.by, new Date().toISOString(), { how: 'withdrawn', winner: ALT_POLICY.originalId, winnerText: '' });
  event(slug, 'alternative.withdrawn', { alternativeId: alt.id, text: alt.text }, input.by);
  touch(slug, input.by);
  return { status: 200, body: { success: true, alternativeId: alt.id } };
}

function resolveChoice(set: AltSetView, raw: unknown): string | null {
  if (typeof raw === 'number' || (typeof raw === 'string' && /^[1-9]$/.test(raw))) {
    const option = set.options[Number(raw) - 1];
    return option ? option.id : null;
  }
  if (typeof raw !== 'string') return null;
  return set.options.some(o => o.id === raw) ? raw : null;
}

/** After a pick: if the team agrees, the winning wording becomes the line. */
async function settleAlternatives(slug: string, input: { line: DocLine; lines: DocLine[]; team: string[]; by: string; applyEdit: LineEditor }): Promise<{ set: Record<string, unknown> | null; resolved: boolean; error?: string }> {
  const set = altSetFor(slug, input.lines, input.line.index, input.team);
  if (!set) return { set: null, resolved: false };
  if (!set.unanimous) return { set: serializeAltSet(set, input.lines), resolved: false };
  const result = await resolveSet(slug, { set, line: input.line, lines: input.lines, choice: set.unanimous, how: 'unanimous', by: input.by, applyEdit: input.applyEdit });
  return result.ok ? { set: null, resolved: true } : { set: serializeAltSet(set, input.lines), resolved: false, error: result.error };
}

/** Applies the winning wording (a normal edit) and folds the other wordings into history. */
async function resolveSet(slug: string, input: { set: AltSetView; line: DocLine; lines: DocLine[]; choice: string; how: 'unanimous' | 'owner'; by: string; applyEdit: LineEditor }): Promise<{ ok: true; text: string } | { ok: false; status: number; error: string }> {
  const winner = input.set.options.find(o => o.id === input.choice);
  if (!winner) return { ok: false, status: 400, error: 'Unknown choice' };
  // Close first, so a pick that arrives while the edit is applied cannot resolve the line twice.
  const now = new Date().toISOString();
  const resolution = { how: input.how, winner: winner.id, winnerText: winner.text };
  const closed: string[] = [];
  for (const option of input.set.options) {
    if (option.id === ALT_POLICY.originalId) continue;
    if (closeAlternativeRow(slug, option.id, option.id === winner.id ? 'chosen' : 'folded', input.by, now, resolution)) closed.push(option.id);
  }
  if (closed.length === 0) return { ok: false, status: 409, error: 'These wordings were already resolved' };
  if (winner.id !== ALT_POLICY.originalId) {
    const edit = await input.applyEdit(input.line, input.lines, winner.text, input.by);
    // A conflict reply can come after the edit landed: trust the document, not the reply.
    let landed = edit.status >= 200 && edit.status < 300;
    if (!landed) {
      const state = await currentDocumentState(slug);
      const lines = state ? await computeServerLines(state.markdown) : [];
      landed = lines.some(candidate => candidate.text === normalizeLineText(winner.text)) && !lines.some(candidate => candidate.text === input.line.text);
    }
    if (!landed) {
      for (const id of closed) reopenAlternativeRow(slug, id);
      const message = typeof edit.body.error === 'string' ? edit.body.error : 'The edit could not be applied';
      event(slug, 'alternative.apply_failed', { lineIndex: input.line.index, choice: winner.id, error: message }, input.by);
      touch(slug, input.by);
      return { ok: false, status: edit.status, error: message };
    }
  }
  deletePicksForLine(slug, input.line.hash);
  event(slug, 'alternative.resolved', {
    lineIndex: input.line.index, how: input.how, winner: winner.id, text: winner.text, was: input.line.text.slice(0, 300),
    history: input.set.options.filter(o => o.id !== winner.id).map(o => ({ id: o.id, by: o.by, text: o.text })),
  }, input.by);
  touch(slug, input.by);
  return { ok: true, text: winner.text };
}

export async function alternativesReport(slug: string, markdown: string, rawMarks: unknown, includeClosed = false): Promise<{ sets: Array<Record<string, unknown>>; closed?: ProofAlternative[] }> {
  const lines = await computeServerLines(markdown);
  const team = currentTeam(slug, rawMarks);
  const sets = evaluateAlternatives(listAlternatives(slug), listPicks(slug), lines, team).map(view => serializeAltSet(view, lines));
  return { sets, ...(includeClosed ? { closed: listAlternatives(slug, { includeClosed: true }).filter(a => a.status !== 'open') } : {}) };
}

/** The line's history (folded and chosen wordings), newest first, for the rail. */
export function alternativeHistory(slug: string, lines: DocLine[], lineIndex: number): ProofAlternative[] {
  const cache = new Map<string, boolean>();
  return listAlternatives(slug, { includeClosed: true })
    .filter(alt => alt.status !== 'open' && altLineIndex(alt, lines, cache) === lineIndex)
    .reverse();
}

// ============================================================================
// B4f: blind marking
// ============================================================================

export function setBlindSetting(slug: string, input: { blind: unknown; by: string; isOwner: boolean; source: 'page' | 'agent' }): ExtraResult {
  if (typeof input.blind !== 'boolean') return fail(400, 'INVALID_SETTING', '"blind" must be true or false');
  if (!input.isOwner) return fail(403, 'OWNER_REQUIRED', 'Only an Owner can turn blind marking on or off');
  const now = new Date().toISOString();
  setBlind(slug, input.blind, input.by, now);
  event(slug, 'settings.blind_changed', { blind: input.blind, source: input.source }, input.by);
  touch(slug, input.by);
  return { status: 200, body: { success: true, settings: getProofSettings(slug) } };
}

// ============================================================================
// B4f: Explain
// ============================================================================

/** Records an Explain question (the page already posted its comment thread). */
export async function recordExplain(slug: string, input: { by: string; anchor: unknown; question: unknown; commentMarkId: unknown; markdown: string; source: 'page' | 'agent' }): Promise<ExtraResult> {
  if (!isLineAnchor(input.anchor)) return fail(400, 'INVALID_ANCHOR', 'Missing or invalid line anchor');
  const anchor = cleanAnchor(input.anchor as LineAnchor);
  const question = String(input.question ?? '').replace(/\s+/g, ' ').trim().slice(0, EXPLAIN_POLICY.maxQuestion) || EXPLAIN_POLICY.defaultQuestion;
  const commentMarkId = typeof input.commentMarkId === 'string' && input.commentMarkId.length <= 100 ? input.commentMarkId : null;
  const lines = await computeServerLines(input.markdown);
  const resolved = resolveLineAnchor(lines, anchor);
  const line = resolved ? lines[resolved.lineIndex] : null;
  const explain = { id: randomUUID(), by: input.by, commentMarkId, question, anchor, createdAt: new Date().toISOString() };
  insertExplain(slug, explain);
  event(slug, 'explain.requested', {
    explainId: explain.id, commentMarkId, question, lineIndex: line?.index ?? null, ref: line ? `b${line.block + 1}` : null,
    line: line?.text.slice(0, 500) ?? anchor.excerpt, askedBy: input.by, source: input.source,
    howToAnswer: commentMarkId ? `Reply on the thread: POST /api/agent/${slug}/marks/reply {"markId": "${commentMarkId}", "text": "..."}` : 'Reply with a comment on the line',
  }, input.by);
  touch(slug, input.by);
  return { status: 200, body: { success: true, explain } };
}

// ============================================================================
// B4f: perishable claims (times-to-live)
// ============================================================================

export async function setTtl(slug: string, input: { by: string; anchor?: unknown; target?: Record<string, unknown>; ttl: unknown; markdown: string; source: 'page' | 'agent' }): Promise<ExtraResult> {
  const parsed = parseTtl(input.ttl);
  if (!parsed) return fail(400, 'INVALID_TTL', `"ttl" is a number and a unit, like "7d", "12h" or "30m" (at least ${TTL_POLICY.minMs / 1000}s, at most 366d)`);
  const lines = await computeServerLines(input.markdown);
  const found = lineFor(lines, { anchor: input.anchor, body: input.target });
  if (!found.ok) return found.result;
  const line = found.line;
  const now = new Date().toISOString();
  const states = buildLineStates(lines, []);
  let replaced: string | null = null;
  if (TTL_POLICY.onePerLine) {
    const existing = evaluateTtls(listTtls(slug), lines, states, [], Date.now()).find(view => view.lineIndex === line.index);
    if (existing) {
      if (actorKey(existing.ttl.by) !== actorKey(input.by) && input.source === 'agent' && isAiActor(input.by) && !isAiActor(existing.ttl.by)) {
        return fail(409, 'TTL_EXISTS', 'A person set this line\'s time-to-live; an AI cannot replace it');
      }
      clearTtlRow(slug, existing.ttl.id, input.by, now);
      replaced = existing.ttl.id;
    }
  }
  const ttl: ProofTtl = { id: randomUUID(), by: input.by, ttlMs: parsed.ms, label: parsed.label, anchor: cleanAnchor(anchorForLine(line)), setAt: now, periodStart: now, periodHash: line.hash, checks: [] };
  insertTtl(slug, ttl);
  event(slug, 'ttl.set', { ttlId: ttl.id, ttl: parsed.label, lineIndex: line.index, line: line.text.slice(0, 200), expiresAt: new Date(Date.now() + parsed.ms).toISOString(), replaced, source: input.source }, input.by);
  touch(slug, input.by);
  return { status: 200, body: { success: true, ttl: serializeTtl(evaluateTtls([ttl], lines, states, [], Date.now())[0], lines, Date.now()) } };
}

export function clearTtl(slug: string, input: { id: string; by: string; isOwner: boolean; source: 'page' | 'agent' }): ExtraResult {
  const ttl = getTtl(slug, input.id);
  if (!ttl || ttl.cleared) return fail(404, 'TTL_NOT_FOUND', 'No time-to-live with that id');
  if (actorKey(ttl.by) !== actorKey(input.by) && !input.isOwner) return fail(403, 'SETTER_REQUIRED', 'Only the person who set it (or an Owner) can remove it');
  clearTtlRow(slug, ttl.id, input.by, new Date().toISOString());
  event(slug, 'ttl.cleared', { ttlId: ttl.id, excerpt: ttl.anchor.excerpt, source: input.source }, input.by);
  touch(slug, input.by);
  return { status: 200, body: { success: true, ttlId: ttl.id } };
}

/** An AI answers "still true?" for an expiring or expired line. Yes starts a new period. */
export async function checkTtl(slug: string, input: { id: string; by: string; stillTrue: unknown; why?: unknown; markdown: string; source: 'page' | 'agent' }): Promise<ExtraResult> {
  if (TTL_POLICY.checksFromAiOnly && !isAiActor(input.by)) return fail(403, 'AI_ONLY', 'People answer by marking the line again (Agree or Reject); "still true" checks are an AI\'s');
  if (typeof input.stillTrue !== 'boolean') return fail(400, 'INVALID_CHECK', '"stillTrue" must be true or false');
  const ttl = getTtl(slug, input.id);
  if (!ttl || ttl.cleared) return fail(404, 'TTL_NOT_FOUND', 'No time-to-live with that id');
  const lines = await computeServerLines(input.markdown);
  const view = evaluateTtls([ttl], lines, buildLineStates(lines, []), [], Date.now())[0];
  const now = new Date().toISOString();
  const why = String(input.why ?? '').replace(/\s+/g, ' ').trim().slice(0, TTL_POLICY.maxWhy) || null;
  const checks = [...ttl.checks, { by: input.by, stillTrue: input.stillTrue, at: now, why }].slice(-50);
  if (input.stillTrue && TTL_POLICY.yesRenews) {
    const line = view.lineIndex === null ? null : lines[view.lineIndex];
    updateTtlPeriod(slug, ttl.id, { periodStart: now, periodHash: line?.hash ?? ttl.periodHash, checks });
  } else {
    updateTtlChecks(slug, ttl.id, checks);
  }
  event(slug, 'ttl.checked', { ttlId: ttl.id, stillTrue: input.stillTrue, why, lineIndex: view.lineIndex, renewed: input.stillTrue && TTL_POLICY.yesRenews }, input.by);
  touch(slug, input.by);
  return { status: 200, body: { success: true, ttlId: ttl.id, stillTrue: input.stillTrue, renewed: input.stillTrue && TTL_POLICY.yesRenews } };
}

export async function ttlReport(slug: string, markdown: string, rawMarks: unknown): Promise<Array<Record<string, unknown>>> {
  const lines = await computeServerLines(markdown);
  const dir = buildDirectory(slug);
  const states = buildLineStates(lines, listCanonicalLineMarks(slug, dir));
  const now = Date.now();
  const team = currentTeam(slug, rawMarks);
  return evaluateTtls(listTtls(slug), lines, states, team, now).map(view => serializeTtl(view, lines, now));
}
