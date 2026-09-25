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
  // A failed load must not leave the page blank indefinitely.
  loadTimeoutMs: 5000,
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
