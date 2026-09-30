/**
 * Proof Documents — "typing ? after a sentence means clarify" (pure code, no DOM).
 *
 * Mike, 2026-09-19: "Typing ? after a sentence means clarify." A lone `?` typed at the end of a
 * line, after existing text and separated from it by a space, is not text: it is a request to the
 * document's AIs to explain that sentence. On Enter or blur the `?` is removed from the text and
 * the existing Explain flow (the E key / the explain thread) is posted on that line, scoped to the
 * sentence the `?` followed. It is never a rejection and never an Issue for the asker — the same
 * rules the E key already follows (EXPLAIN_POLICY).
 *
 * A real question mark in prose is not eaten. "Is this right?" has no space before the `?`, so it
 * is text. Only `… word ?` at the very end of the line converts.
 *
 * Authorship: Mike Wolf's words (2026-09-19); detection rules and policy by Claude Opus 5
 * (worker proof-ux2), 2026-09-19.
 */

export const CLARIFY_POLICY = {
  enabled: true,
  /** The character that asks. */
  trigger: '?',
  /**
   * The `?` must be separated from the text by whitespace and be the last thing on the line, with
   * nothing after it. This is what keeps "Is this right?" as ordinary prose.
   */
  requireSpaceBefore: true,
  /** There must be at least this much real text before it (a line holding only "?" asks nothing). */
  minTextChars: 3,
  /** When the conversion happens. Typing the `?` alone changes nothing until one of these. */
  commitOn: ['enter', 'blur'] as readonly string[],
  /** The same conversion runs in Suggesting mode (Mike). */
  inSuggestMode: true,
  /** The question posted when the person typed only `?` (their own words win when they type more). */
  question: 'Please clarify this sentence.',
  /** The question quotes the sentence the `?` followed, up to this many characters. */
  maxSentenceChars: 200,
  /** Asking never marks the line and is never an Issue for the asker (EXPLAIN_POLICY agrees). */
  marksLine: false,
  isIssueForAsker: false,
  /** The rail and the chat both show the request (it is an ordinary explain thread). */
  showsInRail: true,
} as const;

export interface ClarifyDetection {
  /** The line's text with the trigger (and the space before it) removed. */
  text: string;
  /** The sentence the `?` followed — what the question is about. */
  sentence: string;
  /** The question to post. */
  question: string;
  /** Character offset in the ORIGINAL text where the removal starts, and how many chars go. */
  from: number;
  to: number;
}

/** The last sentence of `text` (what a trailing `?` is asking about). */
export function lastSentence(text: string): string {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return '';
  const parts = trimmed.split(/(?<=[.!?])\s+/).filter(Boolean);
  const last = parts.length ? parts[parts.length - 1] : trimmed;
  return last.slice(0, CLARIFY_POLICY.maxSentenceChars).trim();
}

/**
 * Is this line a clarify request? Returns what to remove and what to ask, or null when the line is
 * ordinary text.
 */
export function detectClarify(lineText: string): ClarifyDetection | null {
  if (!CLARIFY_POLICY.enabled) return null;
  const raw = String(lineText ?? '');
  // Trailing whitespace after the trigger is not "something after it" — a space is not content.
  const text = raw.replace(/\s+$/, '');
  if (!text.endsWith(CLARIFY_POLICY.trigger)) return null;
  const body = text.slice(0, -CLARIFY_POLICY.trigger.length);
  // Exactly one trigger: "??" is prose (or emphasis), not an ask.
  if (body.endsWith(CLARIFY_POLICY.trigger)) return null;
  if (CLARIFY_POLICY.requireSpaceBefore && !/\s$/.test(body)) return null;
  const before = body.replace(/\s+$/, '');
  if (before.trim().length < CLARIFY_POLICY.minTextChars) return null;
  const sentence = lastSentence(before);
  if (!sentence) return null;
  return {
    text: before,
    sentence,
    question: CLARIFY_POLICY.question,
    from: before.length,
    to: text.length,
  };
}

/** The explain question a clarify request posts: the fixed ask plus the sentence it points at. */
export function clarifyQuestion(detection: ClarifyDetection): string {
  return `${detection.question} “${detection.sentence}”`;
}
