/**
 * Stored mark positions follow the text (fix/suggestion-positions, 2026-09-19).
 *
 * A stored mark carries three position hints next to its quote: `range` (ProseMirror positions),
 * and `startRel` / `endRel` (`char:<n>` offsets into the document's plain text, the same text
 * index the page resolves them with). Before this module, a server mutation that changed text
 * (an AI's /edit/v2 replace_block, /edit, /rewrite, an accepted suggestion, a new insert
 * suggestion) wrote every other mark back with the positions it had before the change. A pending
 * insertion below an intro line that grew by 11 characters then pointed 11 characters off, and a
 * short or repeated quote could resolve to the wrong words.
 *
 * mutateCanonicalDocument now diffs the document before and after the change (one token per
 * ProseMirror position), turns the diff into a ProseMirror StepMap, and maps the position hints of
 * every mark whose hints the caller left untouched. A caller that recomputed a mark's positions
 * (the mark it just created, or marks re-derived from a live editor) is trusted as is.
 *
 * Policy knobs live in MARK_POSITION_REMAP_POLICY so a later ruling is a one-line change.
 */
import type { Node as ProseMirrorNode } from '@milkdown/prose/model';
import { StepMap } from '@milkdown/prose/transform';
import { buildTextIndex, type TextIndex } from '../src/editor/utils/text-range.js';

export const MARK_POSITION_REMAP_POLICY = {
  /** Remap stored positions when a server mutation changes the text. */
  enabled: true,
  /** Mark kinds whose stored positions are remapped. Authored marks are re-derived from the text. */
  kinds: ['insert', 'delete', 'replace', 'comment', 'approved', 'flagged'] as readonly string[],
  /**
   * Largest edit distance (in ProseMirror positions) the exact diff explores. Past it, the change
   * is treated as one replaced region between the common prefix and suffix, which still maps every
   * mark outside that region exactly.
   */
  maxExactDiffDistance: 2_000,
  /**
   * Which side a range edge keeps when text is inserted exactly at it: the start stays after the
   * insertion and the end before it, so a mark never grows to cover text it did not quote.
   */
  fromAssoc: 1 as const,
  toAssoc: -1 as const,
} as const;

type StoredMarkLike = Record<string, unknown> & {
  kind?: unknown;
  range?: unknown;
  startRel?: unknown;
  endRel?: unknown;
};

export type MarkPositionRemapResult = {
  marks: Record<string, unknown>;
  remappedIds: string[];
};

function tokenizeDoc(doc: ProseMirrorNode): string[] {
  const tokens: string[] = [];
  const walk = (node: ProseMirrorNode): void => {
    if (node.isText) {
      const text = node.text ?? '';
      for (let i = 0; i < text.length; i += 1) tokens.push(`t${text[i]}`);
      return;
    }
    if (node.isLeaf) {
      tokens.push(`l${node.type.name}`);
      return;
    }
    tokens.push(`o${node.type.name}`);
    node.forEach(child => walk(child));
    tokens.push(`c${node.type.name}`);
  };
  doc.content.forEach(child => walk(child));
  return tokens;
}

export type Hunk = { oldStart: number; oldEnd: number; newStart: number; newEnd: number };

/**
 * Myers diff over the middle (prefix and suffix already trimmed). Returns the changed hunks in
 * old-document order, or null when the edit distance exceeds maxD.
 */
function myersHunks(a: string[], b: string[], offsetA: number, offsetB: number, maxD: number): Hunk[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxD);
  const size = 2 * max + 3;
  const shift = max + 1;
  let v = new Int32Array(size);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[shift + k - 1] < v[shift + k + 1])) x = v[shift + k + 1];
      else x = v[shift + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      next[shift + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    v = next;
    if (found >= 0) break;
  }
  if (found < 0) return null;

  // Backtrack: each step d is one insertion or deletion at (prevX, prevY), after which the path
  // follows a diagonal of equal tokens. Collect the edits, then merge contiguous ones into hunks.
  const edits: Array<{ x: number; y: number; del: boolean }> = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const vPrev = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && vPrev[shift + k - 1] < vPrev[shift + k + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = vPrev[shift + prevK];
    const prevY = prevX - prevK;
    while (x > prevX + (down ? 0 : 1) && y > prevY + (down ? 1 : 0)) { x -= 1; y -= 1; }
    edits.push({ x: prevX, y: prevY, del: !down });
    x = prevX;
    y = prevY;
  }
  edits.reverse();
  const hunks: Hunk[] = [];
  for (const edit of edits) {
    const last = hunks[hunks.length - 1];
    if (last && last.oldEnd === edit.x && last.newEnd === edit.y) {
      if (edit.del) last.oldEnd += 1; else last.newEnd += 1;
    } else {
      hunks.push({
        oldStart: edit.x,
        oldEnd: edit.x + (edit.del ? 1 : 0),
        newStart: edit.y,
        newEnd: edit.y + (edit.del ? 0 : 1),
      });
    }
  }
  return hunks.map(h => ({
    oldStart: h.oldStart + offsetA,
    oldEnd: h.oldEnd + offsetA,
    newStart: h.newStart + offsetB,
    newEnd: h.newEnd + offsetB,
  }));
}

/** Diff two token lists into hunks; exact up to maxD, else one region between prefix and suffix. */
export function diffTokenHunks(oldTokens: string[], newTokens: string[], maxD: number): Hunk[] {
  let prefix = 0;
  const minLen = Math.min(oldTokens.length, newTokens.length);
  while (prefix < minLen && oldTokens[prefix] === newTokens[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < minLen - prefix
    && oldTokens[oldTokens.length - 1 - suffix] === newTokens[newTokens.length - 1 - suffix]
  ) suffix += 1;
  const oldMid = oldTokens.slice(prefix, oldTokens.length - suffix);
  const newMid = newTokens.slice(prefix, newTokens.length - suffix);
  if (oldMid.length === 0 && newMid.length === 0) return [];
  if (oldMid.length > 0 && newMid.length > 0) {
    const exact = myersHunks(oldMid, newMid, prefix, prefix, maxD);
    if (exact) return exact;
  }
  return [{ oldStart: prefix, oldEnd: prefix + oldMid.length, newStart: prefix, newEnd: prefix + newMid.length }];
}

/**
 * A ProseMirror StepMap from the document before a change to the document after it, and the hunks
 * it was built from (empty when the two documents hold the same content).
 */
export function buildDocumentChangeMap(
  oldDoc: ProseMirrorNode,
  newDoc: ProseMirrorNode,
  maxD: number = MARK_POSITION_REMAP_POLICY.maxExactDiffDistance,
): { map: StepMap; hunks: Hunk[] } {
  const hunks = diffTokenHunks(tokenizeDoc(oldDoc), tokenizeDoc(newDoc), maxD);
  const ranges: number[] = [];
  for (const h of hunks) ranges.push(h.oldStart, h.oldEnd - h.oldStart, h.newEnd - h.newStart);
  return { map: new StepMap(ranges), hunks };
}

function parseCharOffset(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^char:(\d+)$/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isRange(value: unknown): value is { from: number; to: number } {
  if (!value || typeof value !== 'object') return false;
  const r = value as { from?: unknown; to?: unknown };
  return Number.isInteger(r.from) && Number.isInteger(r.to);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * A char-offset lookup for one document: the text index's positions are non-decreasing, so both
 * edges resolve by binary search (a linear scan per mark is O(marks x document)).
 */
type CharLookup = { offsets: number[]; positions: number[] };

function buildCharLookup(index: TextIndex): CharLookup {
  const offsets: number[] = [];
  const positions: number[] = [];
  for (let i = 0; i < index.positions.length; i += 1) {
    const p = index.positions[i];
    if (typeof p !== 'number') continue;
    offsets.push(i);
    positions.push(p);
  }
  return { offsets, positions };
}

/** The char offset of the first text char at or after pos (the page's startRel rule). */
function charOffsetAtOrAfter(lookup: CharLookup, pos: number): number | null {
  let lo = 0;
  let hi = lookup.positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lookup.positions[mid] >= pos) hi = mid; else lo = mid + 1;
  }
  return lo < lookup.offsets.length ? lookup.offsets[lo] : null;
}

/** One past the char offset of the last text char before pos (the page's endRel rule). */
function charOffsetEndBefore(lookup: CharLookup, pos: number): number | null {
  let lo = 0;
  let hi = lookup.positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lookup.positions[mid] < pos) lo = mid + 1; else hi = mid;
  }
  return lo > 0 ? lookup.offsets[lo - 1] + 1 : null;
}

/**
 * Map the position hints of every mark in nextMarks whose hints equal those in previousMarks
 * (so the caller did not recompute them) from oldDoc to newDoc. Quotes and every other field are
 * untouched; a mark is never dropped here.
 */
export function remapStoredMarkPositions(args: {
  previousMarks: Record<string, unknown>;
  nextMarks: Record<string, unknown>;
  oldDoc: ProseMirrorNode;
  newDoc: ProseMirrorNode;
}): MarkPositionRemapResult {
  const { previousMarks, nextMarks, oldDoc, newDoc } = args;
  if (!MARK_POSITION_REMAP_POLICY.enabled || oldDoc.eq(newDoc)) {
    return { marks: nextMarks, remappedIds: [] };
  }
  const { map, hunks } = buildDocumentChangeMap(oldDoc, newDoc);
  if (hunks.length === 0) return { marks: nextMarks, remappedIds: [] };

  let oldIndex: TextIndex | null | undefined;
  let newLookup: CharLookup | null | undefined;
  const remappedIds: string[] = [];
  const out: Record<string, unknown> = { ...nextMarks };

  for (const [id, raw] of Object.entries(nextMarks)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const mark = raw as StoredMarkLike;
    if (typeof mark.kind !== 'string' || !MARK_POSITION_REMAP_POLICY.kinds.includes(mark.kind)) continue;
    const before = previousMarks[id] as StoredMarkLike | undefined;
    if (!before || typeof before !== 'object') continue;

    const next: StoredMarkLike = { ...mark };
    let changed = false;

    if (isRange(mark.range) && sameJson(mark.range, before.range)) {
      const from = map.map(mark.range.from, MARK_POSITION_REMAP_POLICY.fromAssoc);
      const to = Math.max(from, map.map(mark.range.to, MARK_POSITION_REMAP_POLICY.toAssoc));
      if (from !== mark.range.from || to !== mark.range.to) {
        next.range = { from, to };
        changed = true;
      }
    }

    const startOff = parseCharOffset(mark.startRel);
    const endOff = parseCharOffset(mark.endRel);
    if (
      startOff !== null && endOff !== null && endOff > startOff
      && mark.startRel === before.startRel && mark.endRel === before.endRel
    ) {
      if (oldIndex === undefined) oldIndex = buildTextIndex(oldDoc);
      if (newLookup === undefined) {
        const builtNewIndex = buildTextIndex(newDoc);
        newLookup = builtNewIndex ? buildCharLookup(builtNewIndex) : null;
      }
      const startPos = oldIndex?.positions[startOff];
      const lastPos = oldIndex?.positions[endOff - 1];
      if (newLookup && typeof startPos === 'number' && typeof lastPos === 'number') {
        const mappedStart = map.map(startPos, MARK_POSITION_REMAP_POLICY.fromAssoc);
        const mappedEnd = map.map(lastPos + 1, MARK_POSITION_REMAP_POLICY.toAssoc);
        const newStart = charOffsetAtOrAfter(newLookup, mappedStart);
        const newEnd = charOffsetEndBefore(newLookup, Math.max(mappedStart, mappedEnd));
        if (newStart !== null && newEnd !== null && newEnd > newStart) {
          const startRel = `char:${newStart}`;
          const endRel = `char:${newEnd}`;
          if (startRel !== mark.startRel || endRel !== mark.endRel) {
            next.startRel = startRel;
            next.endRel = endRel;
            changed = true;
          }
        }
      }
    }

    if (changed) {
      out[id] = next;
      remappedIds.push(id);
    }
  }
  return { marks: remappedIds.length ? out : nextMarks, remappedIds };
}
