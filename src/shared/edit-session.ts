/**
 * Proposals stay local until Propose change or Cmd/Ctrl+Enter.
 * Mike, 2026-09-23 (usability brief). Leaving keeps a draft; Cancel discards it.
 * A draft follows its passage the way a lapsed mark does: exact text first, then
 * findLapseTarget. It never attaches to an unrelated line. A draft that cannot
 * re-attach stays listed for the reader. Mike, 2026-09-23 (usability brief).
 * No shared data changes.
 */
import { actorKey, anchorForLine, findLapseTarget, type DocLine, type LineAnchor } from './line-marks';

export const EDIT_SESSION_POLICY = {
  publishDoors: ['propose', 'cmd-enter'] as const,
  convertDirectEditsToProposals: false,
  undoEntriesPerPost: 1,
  noticeMs: 6000,
} as const;
export type EditDoor = 'propose' | 'cmd-enter' | 'escape' | 'click-outside' | 'scrolled-away' | 'hover' | 'blur' | 'reload' | 'cancel';
export interface EditDraft {
  anchor: LineAnchor;
  original: string;
  proposed: string;
}
export function draftKey(slug: string, reader: string, anchor: LineAnchor): string {
  return `${draftPrefix(slug, reader)}${anchor.hash}:${anchor.occurrence}`;
}
export function draftPrefix(slug: string, reader: string): string {
  return `accord:draft:v1:${encodeURIComponent(slug)}:${encodeURIComponent(actorKey(reader))}:`;
}
export function beginDraft(line: DocLine, original: string): EditDraft {
  return { anchor: anchorForLine(line), original, proposed: original };
}
export function draftAction(draft: EditDraft, door: EditDoor): 'publish' | 'keep' | 'discard' {
  if (door === 'cancel') return 'discard';
  return (door === 'propose' || door === 'cmd-enter') && draft.proposed !== draft.original ? 'publish' : 'keep';
}
/**
 * The line whose text is still the draft's passage.
 * Exact hash identity first (the same text, including a duplicate chosen by occurrence).
 * Else the similarity search a lapsed mark uses. Never the line that merely sits at the old ordinal:
 * that line can be unrelated after a teammate's edit. Null means the passage is lost.
 */
export function resolveDraft(draft: EditDraft, lines: DocLine[], taken?: ReadonlySet<number>): { line: DocLine; changed: boolean } | null {
  const exact = exactDraftLine(lines, draft.anchor, taken);
  if (exact) return { line: exact, changed: false };
  const lapse = findLapseTarget(lines, draft.anchor, taken);
  return lapse ? { line: lapse, changed: true } : null;
}

function exactDraftLine(lines: DocLine[], anchor: LineAnchor, taken?: ReadonlySet<number>): DocLine | null {
  const candidates = lines.filter(line => line.hash === anchor.hash && !taken?.has(line.index));
  if (candidates.length === 0) return null;
  const sameOccurrence = candidates.find(line => line.occurrence === anchor.occurrence);
  if (sameOccurrence) return sameOccurrence;
  let best = candidates[0];
  for (const line of candidates) {
    if (Math.abs(line.index - anchor.ordinal) < Math.abs(best.index - anchor.ordinal)) best = line;
  }
  return best;
}
export function parseDraft(value: string | null): EditDraft | null {
  try {
    const d = JSON.parse(value ?? 'null');
    if (!d || typeof d.original !== 'string' || typeof d.proposed !== 'string'
      || typeof d.anchor?.hash !== 'string' || typeof d.anchor?.kind !== 'string'
      || !Number.isInteger(d.anchor?.occurrence) || d.anchor.occurrence < 0
      || !Number.isInteger(d.anchor?.ordinal) || d.anchor.ordinal < 0) return null;
    return d;
  } catch { return null; }
}
export function postedNoticeText(lineIndex: number, phone: boolean): string {
  return phone ? `Proposed line ${lineIndex + 1}` : `Proposed line ${lineIndex + 1} — Undo takes it back.`;
}
export function describeEditProposal(lineIndex: number): string { return `proposed a change to line ${lineIndex + 1}`; }
