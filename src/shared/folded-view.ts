/**
 * Mike, 2026-09-24, Accord yfbqrau4 point 9: top sections and open items on arrival.
 * Accepted Other ideas: this view replaces Outline and Since you.
 * Claude's open proposal P5 supplies the count line and the visit rule; switches below
 * keep those choices separate from Mike's ruled behaviour. View state is never stored.
 */
import { extractLines, type DocLine, type LineSourceNode } from './line-marks';
import { computeSections } from './folding';

export const FOLDED_VIEW_POLICY = {
  // P5: a reload is a new visit.
  startsFoldedEachVisit: true,
  // P5: remote changes update counts, never disclosure choices.
  holdsStillWhileReading: true,
  // P5: the count line is above the title.
  countLine: true,
  // Own proposals waiting on the other party must also be visible.
  shows: 'all-open',
  // Opening prose has the same rules as a section body.
  openingCollapses: true,
  // Navigation exposes only the destination and its context path.
  jumpShowsLineOnly: true,
  // Input cannot reach words the reader cannot see.
  refuseEditsTouchingHidden: true,
  // A failed load must not leave the page blank indefinitely. 10 s, not 5: under load a healthy
  // page took over 5 s to receive its open items, and a fallback keeps the whole view all visit.
  loadTimeoutMs: 10000,
  // Structural context includes list parents and table headers.
  showStructuralParents: true,
  // An ordered list retains each entry's original ordinal.
  preserveListNumbers: true,
  // Empty blocks remain usable for Enter, even though extractLines skips them.
  showEmptyBlocks: true,
  // Touch rules have the same minimum target as other phone controls.
  phoneRuleTargetPx: 44,
} as const;

export function foldedStructure(lines: DocLine[]) {
  const first = lines[0];
  const title = first?.level !== undefined && !lines.slice(1).some(l => l.level !== undefined && l.level <= first.level!) ? first.index : null;
  const sections = computeSections(lines).filter(s => s.headingIndex !== title);
  const level = Math.min(...sections.map(s => s.level));
  const top = sections.filter(s => s.level === level);
  const opening = lines.filter(l => l.index !== title && l.index < (top[0]?.headingIndex ?? lines.length)).map(l => l.index);
  return { title, sections, top, opening };
}

/** Structural parents by position, without depending on a DOM or changing the document. */
export function structuralPaths(doc: LineSourceNode, lines: DocLine[]): Map<number, number[]> {
  const paths = new Map<number, number[]>();
  const visit = (node: LineSourceNode, start: number, parents: number[]) => {
    let pos = start;
    const tableHeader = node.type.name === 'table' ? lines.find(l => l.pos === start)?.pos : undefined;
    const own = node.type.name === 'list_item' ? lines.find(l => l.pos >= start && l.pos < start + node.nodeSize - 2)?.pos : undefined;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      const context = [...parents];
      if (own !== undefined && pos !== own) context.push(own);
      if (tableHeader !== undefined && pos !== tableHeader) context.push(tableHeader);
      if (lines.some(l => l.pos === pos)) paths.set(pos, context);
      if (child.childCount && !child.isTextblock && child.type.name !== 'table_row') visit(child, pos + 1, context);
      pos += child.nodeSize;
    }
  };
  visit(doc, 0, []);
  return paths;
}

export function withPaths(lines: DocLine[], positions: ReadonlySet<number>, paths: Map<number, number[]>): Set<number> {
  const shown = new Set(positions);
  const sections = computeSections(lines);
  for (const line of lines) if (positions.has(line.pos)) {
    for (const s of sections) if (s.headingIndex < line.index && s.lineEnd > line.index) shown.add(lines[s.headingIndex].pos);
    if (FOLDED_VIEW_POLICY.showStructuralParents) for (const pos of paths.get(line.pos) ?? []) shown.add(pos);
  }
  return shown;
}

export function initialShown(doc: LineSourceNode, open: ReadonlySet<number>): Set<number> {
  const lines = extractLines(doc), structure = foldedStructure(lines);
  const shown = new Set(lines.filter(l => open.has(l.index)).map(l => l.pos));
  if (structure.title !== null) shown.add(lines[structure.title].pos);
  for (const s of structure.top) shown.add(lines[s.headingIndex].pos);
  if (!FOLDED_VIEW_POLICY.openingCollapses) for (const i of structure.opening) shown.add(lines[i].pos);
  return withPaths(lines, shown, structuralPaths(doc, lines));
}

export interface PositionMapping {
  map(pos: number, assoc?: number): number;
  mapResult(pos: number, assoc?: number): { pos: number; deleted: boolean };
}
/** Map node starts with right association: inserts above follow the old item; edits within it preserve it. */
export function mapShown(shown: ReadonlySet<number>, _before: DocLine[], after: DocLine[], mapping: PositionMapping,
  created: ReadonlyArray<{ from: number; to: number }> = []): Set<number> {
  const result = new Set<number>();
  for (const pos of shown) {
    let mapped = mapping.mapResult(pos, 1);
    // Changing node markup can replace its boundary token while its content survives.
    if (mapped.deleted) mapped = mapping.mapResult(pos + 1, 1);
    if (mapped.deleted) continue;
    const line = after.find(l => mapped.pos >= l.pos && mapped.pos < l.pos + l.nodeSize);
    result.add(line?.pos ?? mapped.pos);
  }
  for (const range of created) for (const line of after) {
    if (line.pos < range.to && line.pos + line.nodeSize > range.from) result.add(line.pos);
  }
  return result;
}

/**
 * y-prosemirror applies every remote change, and every Yjs Undo or Redo, by replacing the whole
 * document (sync-plugin _typeChanged: tr.replace(0, size, …) with isChangeOrigin). Such a
 * transaction's mapping reports every position deleted, so mapShown would empty the view: a
 * remote proposal anywhere would unfold or blank the reader's page (found 2026-09-24 in review).
 * Re-find positions by content instead. Top-level blocks that did not change keep their offsets;
 * inside the changed stretch, lines are aligned by their text (longest common subsequence), and
 * an unmatched old line pairs, in order, with an unmatched new line in the same gap (an edit).
 * A position that is not a line start inside the changed stretch is dropped.
 */
type BlockNode = LineSourceNode & { eq?(other: unknown): boolean };
export function remapByContent(positions: ReadonlySet<number>, before: BlockNode, after: BlockNode): Set<number> {
  const same = (a: BlockNode, b: BlockNode) => a === b || Boolean(a.eq?.(b));
  const nb = before.childCount, na = after.childCount;
  let prefix = 0, prefixEnd = 0;
  while (prefix < nb && prefix < na && same(before.child(prefix) as BlockNode, after.child(prefix) as BlockNode)) {
    prefixEnd += before.child(prefix).nodeSize; prefix += 1;
  }
  let suffix = 0, suffixSize = 0;
  while (suffix < nb - prefix && suffix < na - prefix
    && same(before.child(nb - 1 - suffix) as BlockNode, after.child(na - 1 - suffix) as BlockNode)) {
    suffixSize += before.child(nb - 1 - suffix).nodeSize; suffix += 1;
  }
  const size = (node: LineSourceNode) => { let total = 0; for (let i = 0; i < node.childCount; i += 1) total += node.child(i).nodeSize; return total; };
  const beforeTail = size(before) - suffixSize, afterTail = size(after) - suffixSize;
  const old = extractLines(before).filter(l => l.pos >= prefixEnd && l.pos < beforeTail);
  const now = extractLines(after).filter(l => l.pos >= prefixEnd && l.pos < afterTail);
  // Longest common subsequence of the changed stretch's lines, by kind and text.
  const lcs: number[][] = Array.from({ length: old.length + 1 }, () => new Array<number>(now.length + 1).fill(0));
  for (let i = old.length - 1; i >= 0; i -= 1) for (let j = now.length - 1; j >= 0; j -= 1) {
    lcs[i][j] = old[i].hash === now[j].hash ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const pairs = new Map<number, number>();
  let gapOld: number[] = [], gapNew: number[] = [];
  const closeGap = () => { gapOld.forEach((pos, k) => { if (k < gapNew.length) pairs.set(pos, gapNew[k]); }); gapOld = []; gapNew = []; };
  for (let i = 0, j = 0; i < old.length || j < now.length;) {
    if (i < old.length && j < now.length && old[i].hash === now[j].hash) { closeGap(); pairs.set(old[i].pos, now[j].pos); i += 1; j += 1; }
    else if (j >= now.length || (i < old.length && lcs[i + 1][j] >= lcs[i][j + 1])) { gapOld.push(old[i].pos); i += 1; }
    else { gapNew.push(now[j].pos); j += 1; }
  }
  closeGap();
  const result = new Set<number>();
  for (const pos of positions) {
    if (pos < prefixEnd) result.add(pos);
    else if (pos >= beforeTail) result.add(pos - beforeTail + afterTail);
    else if (pairs.has(pos)) result.add(pairs.get(pos)!);
  }
  return result;
}

export interface HiddenRun { from: number; to: number; pos: number; label: string }
export function hiddenRunLabel(items: number, open: number): string {
  const count = `${items} ${items === 1 ? 'item' : 'items'}`;
  return open ? `${count}, ${open} open` : `${count} in accord`;
}
export function hiddenRuns(lines: DocLine[], shown: ReadonlySet<number>, open: ReadonlySet<number>): HiddenRun[] {
  const runs: HiddenRun[] = [];
  for (let i = 0; i < lines.length;) {
    if (shown.has(lines[i].pos)) { i++; continue; }
    const from = i;
    let count = 0;
    while (i < lines.length && !shown.has(lines[i].pos)) { if (open.has(i)) count++; i++; }
    runs.push({ from, to: i, pos: lines[from].pos, label: hiddenRunLabel(i - from, count) });
  }
  return runs;
}
export function foldedCountText(total: number, needsYou: number, allOpen: number): string {
  if (!allOpen) return `In accord: all ${total} ${total === 1 ? 'item' : 'items'}`;
  return [`${needsYou} open for you`, allOpen > needsYou ? `${allOpen - needsYou} waiting on others` : '', `${total - allOpen} in accord`].filter(Boolean).join(' · ');
}

/** Structural-token deletion also counts: joining across a hidden item must be refused. */
export function touchesHidden(from: number, to: number, hidden: ReadonlyArray<{ from: number; to: number }>): boolean {
  return hidden.some(h => from === to ? from > h.from && from < h.to : from < h.to && to > h.from);
}
