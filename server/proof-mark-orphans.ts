// Orphaned suggestion marks.
//
// A pending suggestion is "orphaned" when the text it points at no longer exists anywhere in the
// document, for example after an /edit/v2 replace_block rewrote the paragraph it lived in. An
// orphan cannot be rehydrated, so it must not count as a required mark (one orphan would otherwise
// block every mark operation on the document), and it can only be rejected, never accepted.
//
// The rule is deliberately narrow. Comments, authored marks and review marks are never orphans.
// A suggestion whose quote still occurs somewhere (even ambiguously, or split by formatting) is
// not an orphan either: those keep the strict hydration safety check.
//
// Authorship: Claude Opus 5 (worker fix/orphan-marks), 2026-09-19, for Mike Wolf's Proof fork.
import { normalizeQuote } from '../src/formats/marks.js';

/** The fields the orphan rule reads; structural so every StoredMark variant in server/ fits. */
type OrphanCandidateMark = {
  kind?: string;
  by?: string;
  quote?: string;
  status?: string;
};
import { stripAllProofSpanTags } from './proof-span-strip.js';

export const ORPHANED_SUGGESTION_POLICY = {
  /** Mark kinds that can be orphaned. */
  kinds: ['insert', 'delete', 'replace'] as ReadonlyArray<string>,
  /** Only suggestions still awaiting a decision can be orphaned. */
  statuses: ['pending', undefined] as ReadonlyArray<string | undefined>,
  /**
   * An orphan is a suggestion whose quote is not found anywhere in the document text. "Not found"
   * is tested against several progressively looser views of the text (raw with Proof spans
   * stripped, markdown syntax removed, and letters-and-digits only), so text that merely moved
   * into formatting, escaping or a different block is NOT treated as orphaned.
   */
  requireQuote: true,
  /** A mark whose Proof span (data-id) is still in the markdown is never orphaned. */
  spanInMarkdownKeepsMark: true,
  /** Accepting an orphan has nothing to apply; the engine answers 409 with this code. */
  acceptErrorCode: 'MARK_ORPHANED',
} as const;

export type OrphanedMarkSummary = {
  id: string;
  kind: string;
  by: string | null;
  quote: string;
};

function stripMarkdownSyntax(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/^\s{0,3}(#{1,6}|>|[-+*]|\d+[.)])\s+/gm, '')
    .replace(/\|/g, ' ');
}

function lettersOnly(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** True when the quote occurs in any view of the markdown's visible text. */
export function quoteExistsInMarkdown(markdown: string, quote: string): boolean {
  const q = normalizeQuote(quote);
  if (!q) return true;
  const visible = stripAllProofSpanTags(markdown ?? '');
  if (normalizeQuote(visible).includes(q)) return true;
  const plain = normalizeQuote(stripMarkdownSyntax(visible));
  if (plain.includes(q) || plain.includes(normalizeQuote(stripMarkdownSyntax(q)))) return true;
  const qLetters = lettersOnly(q);
  if (!qLetters) return true;
  return lettersOnly(visible).includes(qLetters);
}

export function isOrphanCandidateKind(mark: OrphanCandidateMark | undefined | null): boolean {
  if (!mark) return false;
  if (!mark.kind || !ORPHANED_SUGGESTION_POLICY.kinds.includes(mark.kind)) return false;
  return ORPHANED_SUGGESTION_POLICY.statuses.includes(mark.status as string | undefined);
}

function hasProofSpanForId(markdown: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`data-id\\s*=\\s*["']${escaped}["']`).test(markdown ?? '');
}

/**
 * Applies ORPHANED_SUGGESTION_POLICY to one stored mark against the current markdown. Pass the
 * mark id when known so a mark whose Proof span survives is never called an orphan.
 */
export function isOrphanedSuggestionMark(
  markdown: string,
  mark: OrphanCandidateMark | undefined | null,
  id?: string,
): boolean {
  if (!mark || !isOrphanCandidateKind(mark)) return false;
  const quote = typeof mark.quote === 'string' ? mark.quote : '';
  if (ORPHANED_SUGGESTION_POLICY.requireQuote && !normalizeQuote(quote)) return false;
  if (ORPHANED_SUGGESTION_POLICY.spanInMarkdownKeepsMark && id && hasProofSpanForId(markdown, id)) return false;
  return !quoteExistsInMarkdown(markdown, quote);
}

export function listOrphanedSuggestionMarks(
  markdown: string,
  marks: Record<string, OrphanCandidateMark>,
): OrphanedMarkSummary[] {
  const out: OrphanedMarkSummary[] = [];
  for (const [id, mark] of Object.entries(marks ?? {})) {
    if (!isOrphanedSuggestionMark(markdown, mark, id)) continue;
    out.push({
      id,
      kind: mark.kind ?? '',
      by: typeof mark.by === 'string' ? mark.by : null,
      quote: typeof mark.quote === 'string' ? mark.quote : '',
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
