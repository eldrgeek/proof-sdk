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
// Updated: Claude Opus 5 (worker fix/orphan-short-quotes), 2026-09-19 - whole-word quote matching.
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
  /**
   * The quote must match whole words in those views (see includesAtWordBoundaries). Without this,
   * a short quote left behind by interrupted typing (" fi", "ise") was "found" inside "first" or
   * across a word boundary in the letters-only view, so the orphan was never recognised and
   * rejecting it failed with 409 MARK_NOT_HYDRATED (Mike's doc hgff4jxe, 2026-09-19). A live
   * partial-word suggestion is still safe: its Proof span keeps it (spanInMarkdownKeepsMark).
   */
  wholeWordMatch: true,
  /** A mark whose Proof span (data-id) is still in the markdown is never orphaned. */
  spanInMarkdownKeepsMark: true,
  /**
   * An unresolved comment whose quoted text is gone (no Proof span, quote not found as whole
   * words) cannot hydrate either. It is NOT an orphan: it is never listed or removed, and it stays
   * in storage with its thread. It only stops counting as a required mark, so one such comment
   * no longer blocks accepting or rejecting every suggestion (hgff4jxe, 2026-09-19).
   */
  detachedCommentsRequireHydration: false,
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

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Letters and digits only, lowercased, with every other run collapsed to one space. */
function wordsView(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * True when `needle` occurs in `haystack` without cutting a word in half: where the needle's
 * first (last) character is a letter or digit, the text just before (after) the match must not
 * be one. A short quote such as "fi" or "ise" therefore does not count as present merely because
 * "first" or "otherwise" is in the document (ORPHANED_SUGGESTION_POLICY.wholeWordMatch).
 */
export function includesAtWordBoundaries(haystack: string, needle: string): boolean {
  if (!needle) return true;
  if (!ORPHANED_SUGGESTION_POLICY.wholeWordMatch) return haystack.includes(needle);
  const checkStart = WORD_CHAR.test(needle[0]);
  const checkEnd = WORD_CHAR.test(needle[needle.length - 1]);
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) return false;
    const before = idx > 0 ? haystack[idx - 1] : '';
    const after = haystack[idx + needle.length] ?? '';
    const startOk = !checkStart || !before || !WORD_CHAR.test(before);
    const endOk = !checkEnd || !after || !WORD_CHAR.test(after);
    if (startOk && endOk) return true;
    from = idx + 1;
  }
  return false;
}

/** True when the quote occurs, as whole words, in any view of the markdown's visible text. */
export function quoteExistsInMarkdown(markdown: string, quote: string): boolean {
  const q = normalizeQuote(quote);
  if (!q) return true;
  const visible = stripAllProofSpanTags(markdown ?? '');
  if (includesAtWordBoundaries(normalizeQuote(visible), q)) return true;
  const plain = normalizeQuote(stripMarkdownSyntax(visible));
  if (includesAtWordBoundaries(plain, q)) return true;
  const plainQuote = normalizeQuote(stripMarkdownSyntax(q));
  if (plainQuote && includesAtWordBoundaries(plain, plainQuote)) return true;
  const qWords = wordsView(q);
  if (!qWords) return true;
  return includesAtWordBoundaries(wordsView(visible), qWords);
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

/**
 * An unresolved comment whose Proof span is gone and whose quote no longer occurs (as whole words)
 * in the text. See ORPHANED_SUGGESTION_POLICY.detachedCommentsRequireHydration.
 */
export function isDetachedCommentMark(
  markdown: string,
  mark: (OrphanCandidateMark & { resolved?: unknown }) | undefined | null,
  id?: string,
): boolean {
  if (!mark || mark.kind !== 'comment' || mark.resolved) return false;
  const quote = typeof mark.quote === 'string' ? mark.quote : '';
  if (!normalizeQuote(quote)) return false;
  if (id && hasProofSpanForId(markdown, id)) return false;
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
