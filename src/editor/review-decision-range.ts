import * as Y from 'yjs';

type Point = { type: Y.XmlFragment | Y.XmlText; index: number };
type Unit = { value: string; start: Point; end: Point; review?: Record<string, any> };
export type TextSnapshot = { units: Unit[]; offsets: Map<Y.AbstractType<any>, number[]> };
export type DecisionRange = { start: Y.RelativePosition; end: Y.RelativePosition; text: string };

/** Include node boundaries and review annotations; ordinary formatting is not a review decision. */
export function snapshotText(fragment: Y.XmlFragment): TextSnapshot {
  const units: Unit[] = [];
  const offsets = new Map<Y.AbstractType<any>, number[]>();
  const visit = (type: Y.XmlFragment | Y.XmlText): void => {
    const positions: number[] = []; offsets.set(type, positions);
    if (type instanceof Y.XmlText) {
      let index = 0;
      for (const part of type.toDelta()) {
        const text = typeof part.insert === 'string' ? part.insert : '\uFFFC';
        const review = Object.fromEntries(Object.entries(part.attributes ?? {})
          .filter(([name]) => /^(proofSuggestion|proofComment|proofFlagged|proofApproved)(--|$)/.test(name))
          .sort(([a], [b]) => a.localeCompare(b)));
        for (let i = 0; i < text.length; i++, index++) {
          positions[index] = units.length;
          units.push({ value: text[i], start: { type, index }, end: { type, index: index + 1 }, review });
        }
      }
      positions[index] = units.length;
    } else {
      type.toArray().forEach((child, i) => {
        positions[i] = units.length;
        if (child instanceof Y.XmlText) visit(child);
        else if (child instanceof Y.XmlElement) {
          units.push({ value: `<${child.nodeName}>`, start: { type, index: i }, end: { type: child, index: 0 } });
          visit(child);
          units.push({ value: `</${child.nodeName}>`, start: { type: child, index: child.length }, end: { type, index: i + 1 } });
        }
      });
      positions[type.length] = units.length;
    }
  };
  visit(fragment);
  return { units, offsets };
}
const textOf = (units: Unit[]) => JSON.stringify(units.map(unit => unit.value));
const sameUnit = (a: Unit, b: Unit) => a.value === b.value && JSON.stringify(a.review ?? {}) === JSON.stringify(b.review ?? {});

export function changedRange(before: TextSnapshot, after: TextSnapshot, fragment: Y.XmlFragment): DecisionRange | null {
  let start = 0, end = after.units.length, oldEnd = before.units.length;
  while (start < end && start < oldEnd && sameUnit(before.units[start], after.units[start])) start++;
  while (end > start && oldEnd > start && sameUnit(before.units[oldEnd - 1], after.units[end - 1])) { end--; oldEnd--; }
  if (start === end && start === oldEnd) return null;
  const first = after.units[start]?.start ?? after.units[start - 1]?.end ?? { type: fragment, index: 0 };
  const last = end > start ? after.units[end - 1].end : first;
  return {
    start: Y.createRelativePositionFromTypeIndex(first.type, first.index, start === end ? -1 : 0),
    end: Y.createRelativePositionFromTypeIndex(last.type, last.index, start === end ? 0 : -1),
    text: textOf(after.units.slice(start, end)),
  };
}
function rangeOffsets(doc: Y.Doc, range: DecisionRange, snapshot: TextSnapshot): { from: number; to: number } | null {
  const start = Y.createAbsolutePositionFromRelativePosition(range.start, doc);
  const end = Y.createAbsolutePositionFromRelativePosition(range.end, doc);
  if (!start || !end) return null;
  const from = snapshot.offsets.get(start.type)?.[start.index];
  const to = snapshot.offsets.get(end.type)?.[end.index];
  return from !== undefined && to !== undefined && from <= to ? { from, to } : null;
}
/** A decision that changes only mark records (accepting an insertion, resolving a
 * comment) leaves the text unchanged, so guard the text its marks cover instead. */
export function rangeBetween(doc: Y.Doc, start: Y.RelativePosition, end: Y.RelativePosition, snapshot: TextSnapshot): DecisionRange | null {
  const offsets = rangeOffsets(doc, { start, end, text: '' }, snapshot);
  return offsets ? { start, end, text: textOf(snapshot.units.slice(offsets.from, offsets.to)) } : null;
}
export function rangeMatches(doc: Y.Doc, range: DecisionRange | null): boolean {
  if (!range) return true;
  const snapshot = snapshotText(doc.getXmlFragment('prosemirror'));
  const offsets = rangeOffsets(doc, range, snapshot);
  return !!offsets && textOf(snapshot.units.slice(offsets.from, offsets.to)) === range.text;
}

/** Read before and after a remote transaction, so removals and subsequent
 * reversals of a collaborator's mark still invalidate the decision. */
export function reviewRangeState(doc: Y.Doc, range: DecisionRange, snapshot: TextSnapshot) {
  const offsets = rangeOffsets(doc, range, snapshot);
  const ids = new Set<string>();
  const annotations: unknown[] = [];
  if (offsets) for (const unit of snapshot.units.slice(offsets.from, offsets.to)) {
    if (!unit.review || !Object.keys(unit.review).length) continue;
    annotations.push(unit.review);
    for (const attrs of Object.values(unit.review)) if (typeof attrs?.id === 'string') ids.add(attrs.id);
  }
  const records = new Map([...ids].map(id => {
    const record = { ...(doc.getMap<any>('marks').get(id) ?? {}) };
    // Anchor projection follows edits elsewhere; it is not a new review action.
    for (const key of ['range', 'quote', 'startRel', 'endRel']) delete record[key];
    return [id, JSON.stringify(record)] as const;
  }));
  return { ids, records, signature: JSON.stringify(annotations) };
}
