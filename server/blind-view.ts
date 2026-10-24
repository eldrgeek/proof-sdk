/**
 * Viewer data for blind reads. Mike, 2026-09-23 (usability brief): every response uses the
 * shared reveal rule, including old events and exports. Undefined viewer is administrative;
 * an empty viewer has no verified identity and must never inherit a typed name's positions.
 */
import { actorKey, type DocLine } from '../src/shared/line-marks.js';
import { evaluateAsks } from '../src/shared/asks.js';
import { evaluateObjection, type ProofObjection } from '../src/shared/objections.js';
import { objectionLinesRevealed, proxyVisibleTo } from '../src/shared/blind.js';
import { altLineIndex, type ProofAlternative } from '../src/shared/alternatives.js';
import { getProofSettings, listPicks } from './proof-extras-store.js';
import { blindViewFor } from './proof-extras-eval.js';
import { listCanonicalAsks } from './asks.js';
import { computeServerLines, listCanonicalLineMarks } from './line-marks.js';
import { getDocumentBySlug } from './db.js';
import { normalizeLineText } from '../src/shared/line-marks.js';
import type { StoredMark } from '../src/formats/marks.js';
import { listObjections } from './review-aids-store.js';

export function blindReadView(slug: string, lines: DocLine[], viewer: string | undefined, lineMarks = listCanonicalLineMarks(slug), asks = listCanonicalAsks(slug)) {
  if (!getProofSettings(slug).blind || viewer === undefined) return null;
  const askViews = evaluateAsks(asks, lines);
  const answeredLines = askViews.filter(v => v.lineIndex !== null && v.ask.answers.some(a => actorKey(a.by) === actorKey(viewer))).map(v => v.lineIndex!);
  return { ...blindViewFor({ lines, lineMarks, viewer, answeredLines, picks: listPicks(slug) }), viewer, lines, askViews };
}
export type BlindReadView = NonNullable<ReturnType<typeof blindReadView>>;
export async function readBlindView(slug: string, markdown: string, viewer: string | undefined) {
  if (!getProofSettings(slug).blind || viewer === undefined) return null;
  return blindReadView(slug, await computeServerLines(markdown), viewer);
}
export function visibleObjection(objection: ProofObjection, view: BlindReadView): boolean {
  return objectionLinesRevealed(evaluateObjection(objection, view.lines, () => []).lineIndices, view.revealed);
}
export function visibleAlternative(alt: ProofAlternative, view: BlindReadView): boolean {
  const index = altLineIndex(alt, view.lines);
  return index !== null && view.revealed.has(index);
}

/** Same serializer for canonical page asks and evaluated agent asks; stored rows stay intact. */
export function redactAsk<T extends object>(ask: T, view: BlindReadView): T {
  const row = ask as Record<string, unknown>;
  const index = typeof row.lineIndex === 'number' ? row.lineIndex : view.askViews.find(v => v.ask.id === row.id)?.lineIndex ?? null;
  if (index !== null && view.revealed.has(index)) return ask;
  const hide = (answer: Record<string, unknown>) => actorKey(String(answer.by ?? answer.actor ?? '')) === actorKey(view.viewer) ? answer
    : { id: answer.id, by: answer.by, at: answer.at, lineHash: answer.lineHash, choice: 'yes', words: '', hidden: true };
  const { closed: _closed, settled: _settled, snoozedFor: _snoozed, openFor: _open, ...safe } = row;
  return {
    ...safe,
    ...(typeof row.status === 'string' ? { status: 'hidden', summary: 'Answers are hidden until you mark this line (blind marking)' } : {}),
    ...(Array.isArray(row.people) ? { people: row.people.map(p => ({ actor: p.actor, state: 'hidden', choice: null, words: null, at: null })) } : {}),
    ...(Array.isArray(row.answers) ? { answers: row.answers.map(hide) } : {}),
    ...(Array.isArray(row.history) ? { history: row.history.map(hide) } : {}),
  } as T;
}

/** Historical events are filtered on every read, including records made before blind was on. */
export function filterBlindEvents<T extends { event_type: string; event_data: string; actor: string | null }>(slug: string, events: T[], view: BlindReadView): T[] {
  const objections = listObjections(slug, { includeClosed: true });
  const out: T[] = [];
  for (const event of events) {
    let data: Record<string, any>;
    try { data = JSON.parse(event.event_data); } catch { continue; }
    const type = event.event_type;
    if (type.startsWith('objection.')) {
      const objection = objections.find(o => o.id === data.objectionId);
      if (!objection || !visibleObjection(objection, view)) continue;
    } else if (['suggestion.accepted', 'suggestion.rejected', 'suggestion.reopened'].includes(type)) {
      const marks = JSON.parse(getDocumentBySlug(slug)?.marks ?? '{}') as Record<string, StoredMark>;
      if (!suggestionDecisionRevealed(marks[String(data.markId)], view)) continue;
    } else if (type.startsWith('proxy.')) {
      if (!proxyVisibleTo({ for: String(data.for ?? ''), familiar: String(data.familiar ?? '') }, view.viewer)) continue;
    } else if (type === 'ask.answered' || type === 'ask.answer_withdrawn') {
      const ask = view.askViews.find(v => v.ask.id === data.askId);
      if (!ask || ask.lineIndex === null || !view.revealed.has(ask.lineIndex)) {
        data = { askId: data.askId, blind: true };
      }
    } else if (type.startsWith('line_mark.')) {
      // Old events may not have enough anchor information to prove current whole-span reveal.
      // Participation is public; status, origin and ratification context are not.
      data = { blind: true, markId: data.markId, count: data.count, anchor: data.anchor, anchors: data.anchors, source: data.source };
    } else if (type === 'ttl.expired') {
      const { decayedMarks: _decayed, openFor: _open, ...safe } = data;
      data = safe;
    } else if (['alternative.picked', 'alternative.resolved', 'alternative.apply_failed'].includes(type)) {
      // Historical indices may refer to earlier wording; no durable anchor proves reveal.
      continue;
    }
    out.push({ ...event, event_data: JSON.stringify(data) });
  }
  return out;
}

/** Omit TTL fields whose values select Agreed/Approved marks or named decisions. */
export function redactTtl<T extends Record<string, unknown>>(ttl: T, view: BlindReadView): T {
  if (typeof ttl.lineIndex === 'number' && view.revealed.has(ttl.lineIndex)) return ttl;
  const { decayedMarks: _marks, openFor: _open, ...safe } = ttl;
  return safe as T;
}

/** Decisions span the proposal's whole quote. Ambiguous or missing anchors cannot grant reveal. */
export function suggestionDecisionRevealed(mark: StoredMark | undefined, view: BlindReadView): boolean {
  const quote = normalizeLineText(mark?.quote ?? '');
  if (!quote) return false;
  const text = view.lines.map(line => normalizeLineText(line.text)).join(' ');
  const start = text.indexOf(quote);
  if (start < 0 || text.indexOf(quote, start + 1) >= 0) return false;
  let offset = 0;
  const covered: number[] = [];
  for (const line of view.lines) {
    const end = offset + normalizeLineText(line.text).length;
    if (end > start && offset < start + quote.length) covered.push(line.index);
    offset = end + 1;
  }
  return objectionLinesRevealed(covered, view.revealed);
}

/** Who/when belong to the decision; hide the new fields on unrevealed lines. */
export function redactSuggestionDecisions<T extends Record<string, unknown>>(marks: T, view: BlindReadView | null | undefined): T {
  if (!view) return marks;
  return Object.fromEntries(Object.entries(marks).map(([id, value]) => {
    const mark = value as StoredMark;
    if (!mark || typeof mark !== 'object' || suggestionDecisionRevealed(mark, view)) return [id, mark];
    const { resolvedBy: _by, resolvedAt: _at, ...safe } = mark;
    return [id, safe];
  })) as T;
}
