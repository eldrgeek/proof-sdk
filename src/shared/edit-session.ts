/**
 * Proposals stay local until Propose change or Cmd/Ctrl+Enter.
 * Mike, 2026-09-23 (usability brief). Leaving keeps a draft; Cancel discards it.
 * Passage identity is the same hash and occurrence used by line marks. No shared data changes.
 */
import { actorKey, anchorForLine, resolveLineAnchor, type DocLine, type LineAnchor } from './line-marks';

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
export function resolveDraft(draft: EditDraft, lines: DocLine[]): { line: DocLine; changed: boolean } | null {
  const resolved = resolveLineAnchor(lines, draft.anchor);
  return resolved ? { line: lines[resolved.lineIndex], changed: !resolved.current } : null;
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
