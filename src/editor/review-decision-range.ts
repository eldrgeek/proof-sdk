import * as Y from 'yjs';

type Point = { type: Y.XmlFragment | Y.XmlText; index: number };
type Unit = { value: string; start: Point; end: Point };
export type TextSnapshot = { units: Unit[]; offsets: Map<Y.AbstractType<any>, number[]> };
export type DecisionRange = { start: Y.RelativePosition; end: Y.RelativePosition; text: string };

/** Include node boundaries, but not formatting, so paragraph removal is guarded too. */
export function snapshotText(fragment: Y.XmlFragment): TextSnapshot {
  const units: Unit[] = [];
  const offsets = new Map<Y.AbstractType<any>, number[]>();
  const visit = (type: Y.XmlFragment | Y.XmlText): void => {
    const positions: number[] = []; offsets.set(type, positions);
    if (type instanceof Y.XmlText) {
      const text = type.toDelta().map((part: { insert: unknown }) => typeof part.insert === 'string' ? part.insert : '\uFFFC').join('');
      for (let i = 0; i < text.length; i++) {
        positions[i] = units.length;
        units.push({ value: text[i], start: { type, index: i }, end: { type, index: i + 1 } });
      }
      positions[text.length] = units.length;
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

export function changedRange(before: TextSnapshot, after: TextSnapshot, fragment: Y.XmlFragment): DecisionRange | null {
  let start = 0, end = after.units.length, oldEnd = before.units.length;
  while (start < end && start < oldEnd && before.units[start].value === after.units[start].value) start++;
  while (end > start && oldEnd > start && before.units[oldEnd - 1].value === after.units[end - 1].value) { end--; oldEnd--; }
  if (start === end && start === oldEnd) return null;
  const first = after.units[start]?.start ?? after.units[start - 1]?.end ?? { type: fragment, index: 0 };
  const last = end > start ? after.units[end - 1].end : first;
  return {
    start: Y.createRelativePositionFromTypeIndex(first.type, first.index, start === end ? -1 : 0),
    end: Y.createRelativePositionFromTypeIndex(last.type, last.index, start === end ? 0 : -1),
    text: textOf(after.units.slice(start, end)),
  };
}
export function rangeMatches(doc: Y.Doc, range: DecisionRange | null): boolean {
  if (!range) return true;
  const start = Y.createAbsolutePositionFromRelativePosition(range.start, doc);
  const end = Y.createAbsolutePositionFromRelativePosition(range.end, doc);
  if (!start || !end) return false;
  const snapshot = snapshotText(doc.getXmlFragment('prosemirror'));
  const from = snapshot.offsets.get(start.type)?.[start.index];
  const to = snapshot.offsets.get(end.type)?.[end.index];
  return from !== undefined && to !== undefined && from <= to && textOf(snapshot.units.slice(from, to)) === range.text;
}
