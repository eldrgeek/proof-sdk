/** Mike, 2026-09-25: yfbqrau4 point 8; wa8dhyv7 proposals 7–9.
 * Moves are structural removal/insertion bundles, never text drags. The bundle lives
 * in its two suggestion records so collaboration and native Undo are one transaction.
 * Built by Codex (GPT-6), 2026-09-26, from Mike's rulings and the ac-l71 brief.
 */
import type { Node } from '@milkdown/kit/prose/model';
import type { Transaction } from '@milkdown/kit/prose/state';
import { extractLines, anchorForLine, type DocLine, type LineAnchor } from './line-marks';
import { computeSections } from './folding';
import type { StoredMark } from '../formats/marks';
import type { ProofBundle } from './bundles';
import { suggestionWithStatus } from './suggestion-status';

export const MOVE_POLICY = {
  topLevelBetweenBlocks: true,
  listEntries: 'same-parent', // Never silently merge lists or change indentation.
  tableRows: 'same-table',
  preserveHeader: true,
  sections: 'top-level-only',
  nestedParagraphs: 'refuse', // Moving one out of a quote would change its meaning.
  sourceProposalChanges: 'refuse-accept',
  unfoldedHeading: 'heading-only',
  reviewHeading: 'whole-section',
  noOp: 'ignore',
  pendingPlacement: 'original-until-accepted', // One copy; the card describes the proposed order.
  storage: 'bundle-in-shared-suggestion-records', // Text and decision share native Yjs history.
  staleSource: 'refuse-accept',
  staleDestination: 'refuse-accept',
  staleCardAnchor: 'last-known-line', // Keep the proposal reviewable when its text disappears.
  duplicateSource: 'refuse', // Content identity cannot distinguish two identical units safely.
  overlappingMoves: 'refuse',
  keyboard: { modifier: 'Alt+Shift', up: 'ArrowUp', down: 'ArrowDown' },
  desktopMinWidth: 701,
  dragThresholdPx: 5,
  edgeScrollPx: 48,
  edgeScrollSpeedPx: 12,
  labelCharacters: 48,
  outlineIndentPx: 16,
  gutterHandleOffsetPx: 62,
  mixedApiBatch: 'refuse', // A generic text batch cannot partially decide a structural move.
  maxDropDistancePx: 24,
  outlinePersists: false, // A visit's view choice must not change the next arrival.
  ownMovesDefault: [] as readonly string[],
  maxImmediateActors: 50,
} as const;

export interface MovingUnit {
  from: number; to: number; kind: string; parent: number; depth: number;
  section: boolean; line: number;
}
export interface MovePlace { line: DocLine; side: 'before' | 'after'; section?: boolean }
export interface MoveSpec {
  id: string; title: string; source: LineAnchor; section: boolean;
  sourceJSON: string; sourceMarksJSON: string; target: LineAnchor; targetJSON: string;
  side: 'before' | 'after'; targetSection: boolean;
}
export interface MoveMember { role: 'remove' | 'insert'; spec: MoveSpec }

export function movingUnit(doc: Node, item: DocLine, folded = false): MovingUnit | null {
  const at = doc.resolve(Math.min(doc.content.size, item.pos + 1));
  let depth = at.depth, entryDepth = -1;
  for (let d = at.depth; d > 0; d--) {
    const kind = at.node(d).type.name;
    if (kind === 'table_row' || kind === 'table_header_row') { depth = d; entryDepth = -1; break; }
    if (kind === 'list_item' && entryDepth < 0) entryDepth = d;
  }
  if (entryDepth > 0) depth = entryDepth;
  if (!depth) return null;
  const node = at.node(depth), kind = node.type.name;
  if (!['paragraph', 'heading', 'list_item', 'table_row', 'table_header_row'].includes(kind)) return null;
  const from = at.before(depth);
  let to = at.after(depth), section = false;
  if (kind === 'heading' && depth === 1 && folded) {
    const s = computeSections(extractLines(doc), doc.childCount).find(s => s.headingIndex === item.index);
    if (s) { to = 0; for (let n = 0; n < s.endBlock; n++) to += doc.child(n).nodeSize; section = true; }
  }
  return { from, to, kind, parent: at.start(depth - 1), depth, section, line: item.index };
}
export function dropTargets(doc: Node, unit: MovingUnit): number[] {
  if (unit.kind === 'table_header_row') return [];
  const parent = unit.depth === 1 ? doc : doc.resolve(unit.from).parent;
  const out: number[] = [];
  let pos = unit.parent;
  parent.forEach((node, offset, index) => {
    pos = unit.parent + offset;
    const header = node.type.name === 'table_header_row' || (index === 0 && node.firstChild?.type.name === 'table_header');
    if (unit.kind === 'table_row' && index === 0 && header && unit.from === pos) return;
    if (!(unit.kind === 'table_row' && index === 0 && header)) out.push(pos);
  });
  out.push(unit.parent + parent.content.size);
  return out.filter(p => p < unit.from || p > unit.to);
}
export function isValidDrop(doc: Node, unit: MovingUnit, pos: number): boolean {
  if (unit.depth !== 1 && !['list_item', 'table_row'].includes(unit.kind)) return false;
  if (unit.kind === 'table_row') {
    const row = doc.nodeAt(unit.from);
    if (row?.firstChild?.type.name === 'table_header') return false;
  }
  return dropTargets(doc, unit).includes(pos);
}
export function placePosition(doc: Node, place: MovePlace): number | null {
  const target = movingUnit(doc, place.line, place.section);
  return target ? (place.side === 'before' ? target.from : target.to) : null;
}
function unitJSON(doc: Node, unit: MovingUnit): string { return JSON.stringify(doc.slice(unit.from, unit.to).toJSON(), (key, value) => key === 'marks' && Array.isArray(value) ? value.filter(m => !m.type.startsWith('proof')) : value); }
function uniqueLine(doc: Node, anchor: LineAnchor): DocLine | null {
  const matches = extractLines(doc).filter(l => l.hash === anchor.hash && l.kind === anchor.kind);
  return matches.length === 1 ? matches[0] : null;
}
function sourceMarksJSON(marks: Record<string, StoredMark>, unit: MovingUnit): string {
  return JSON.stringify(Object.entries(marks).filter(([, m]) => !m.move && m.kind !== 'authored'
    && m.range && m.range.from < unit.to && m.range.to > unit.from)
    .sort(([a], [b]) => a.localeCompare(b)).map(([id, m]) => [id, m.kind, m.by, m.content, m.status, m.text, m.replies]));
}
export function resolveMove(doc: Node, spec: MoveSpec, marks?: Record<string, StoredMark>): { unit: MovingUnit; pos: number } | null {
  const source = uniqueLine(doc, spec.source), target = uniqueLine(doc, spec.target);
  if (!source || !target) return null;
  const unit = movingUnit(doc, source, spec.section), dest = movingUnit(doc, target, spec.targetSection);
  if (!unit || !dest || unitJSON(doc, unit) !== spec.sourceJSON || unitJSON(doc, dest) !== spec.targetJSON) return null;
  if (marks && sourceMarksJSON(marks, unit) !== spec.sourceMarksJSON) return null;
  const pos = spec.side === 'before' ? dest.from : dest.to;
  return isValidDrop(doc, unit, pos) ? { unit, pos } : null;
}
export function createMove(doc: Node, source: DocLine, place: MovePlace, section: boolean, id: string,
  by: string, existing: Record<string, StoredMark>, at = new Date().toISOString()): Record<string, StoredMark> | null {
  const unit = movingUnit(doc, source, section), dest = movingUnit(doc, place.line, place.section);
  if (!unit || !dest) throw new Error('That item cannot be moved.');
  const pos = place.side === 'before' ? dest.from : dest.to;
  if (pos >= unit.from && pos <= unit.to) return null;
  if (!isValidDrop(doc, unit, pos)) throw new Error('That is not a valid place for this item.');
  if (!uniqueLine(doc, anchorForLine(source)) || !uniqueLine(doc, anchorForLine(place.line))) throw new Error('These items have identical text. Make their text distinct before moving them.');
  for (const mark of Object.values(existing)) if (mark.move && mark.status === 'pending') {
    const other = resolveMove(doc, mark.move.spec);
    if (!other || (other.unit.from < unit.to && other.unit.to > unit.from)) throw new Error('Decide the existing move first.');
  }
  const short = (s: string) => s.length > MOVE_POLICY.labelCharacters ? `${s.slice(0, MOVE_POLICY.labelCharacters)}…` : s;
  const spec: MoveSpec = { id, title: `Moves “${short(source.text)}” to ${place.side} “${short(place.line.text)}”`,
    source: anchorForLine(source), section, sourceJSON: unitJSON(doc, unit), sourceMarksJSON: sourceMarksJSON(existing, unit), target: anchorForLine(place.line),
    targetJSON: unitJSON(doc, dest), side: place.side, targetSection: Boolean(place.section) };
  const range = { from: source.pos + 1, to: source.pos + source.nodeSize - 1 };
  return Object.fromEntries((['remove', 'insert'] as const).map(role => [`${id}:${role}`, {
    kind: role === 'remove' ? 'delete' : 'insert', by, createdAt: at, status: 'pending',
    quote: doc.textBetween(range.from, range.to, ' ', ' '), range, move: { role, spec },
  } satisfies StoredMark]));
}
export function moveBundles(marks: Record<string, StoredMark>): ProofBundle[] {
  return Object.values(marks).filter(m => m.move?.role === 'remove').map(m => {
    const spec = m.move!.spec;
    const members = (['remove', 'insert'] as const).map(role => ({ markId: `${spec.id}:${role}`,
      kind: role === 'remove' ? 'delete' : 'insert', quote: m.quote ?? '', lineHash: spec.source.hash }));
    return { id: spec.id, kind: 'move', move: spec, by: m.by ?? '', title: spec.title, why: null, members,
      createdAt: m.createdAt ?? '', status: m.status === 'pending' ? 'open' : m.status ?? 'open',
      closedAt: m.resolvedAt ?? null, closedBy: m.resolvedBy ?? null };
  });
}
/** Both members are always decided together, even if an old client selects just one. */
export function decideMove(tr: Transaction, marks: Record<string, StoredMark>, id: string,
  action: 'accept' | 'reject', by: string): Record<string, StoredMark> {
  const m = marks[id], spec = m?.move?.spec;
  if (!spec || m.status !== 'pending') throw new Error('This move is no longer pending.');
  const ids = [`${spec.id}:remove`, `${spec.id}:insert`];
  if (ids.some(key => marks[key]?.status !== 'pending' || marks[key]?.move?.spec.id !== spec.id)) throw new Error('The move is incomplete.');
  const next = { ...marks };
  if (action === 'accept') {
    const resolved = resolveMove(tr.doc, spec, marks);
    if (!resolved) throw new Error('The item or its destination changed. Reject this move and propose it again.');
    const { unit, pos } = resolved, slice = tr.doc.slice(unit.from, unit.to);
    tr.delete(unit.from, unit.to);
    const landing = pos > unit.to ? pos - (unit.to - unit.from) : pos;
    tr.insert(landing, slice.content);
    tr.setMeta('proofMove', true);
    // Existing discussion and proposal anchors travel with their content.
    for (const [key, value] of Object.entries(next)) if (value.range) {
      const r = value.range;
      const range = r.from >= unit.from && r.to <= unit.to
        ? { from: landing + r.from - unit.from, to: landing + r.to - unit.from }
        : { from: tr.mapping.map(r.from, 1), to: tr.mapping.map(r.to, -1) };
      next[key] = { ...value, range, startRel: undefined, endRel: undefined };
    }
  }
  for (const key of ids) next[key] = suggestionWithStatus(next[key], action === 'accept' ? 'accepted' : 'rejected', by);
  return next;
}

/** A stale move remains a reviewable card even after its source was edited or removed. */
export function moveSourceLine(lines: DocLine[], mark: StoredMark): DocLine | null {
  if (!mark?.move) return null;
  const matches = lines.filter(l => l.hash === mark.move!.spec.source.hash);
  return (matches.length === 1 ? matches[0] : lines[Math.min(mark.move.spec.source.ordinal, lines.length - 1)]) ?? null;
}
export function moveSourceRange(doc: Node, mark: StoredMark): { from: number; to: number } | null {
  if (!mark.move) return mark.range ?? null;
  const source = moveSourceLine(extractLines(doc), mark);
  return source ? { from: source.pos + 1, to: Math.max(source.pos + 1, source.pos + source.nodeSize - 1) } : null;
}
