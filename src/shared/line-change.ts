/**
 * Proof Documents — Step B3b: is a line edit cosmetic or substantive?
 *
 * Authorship: direction by Mike Wolf (Proof Documents, 2026-09-18); idea from the overnight
 * research round (Anthropic Fable and OpenAI Astra, independently); built by Claude Opus 5
 * (worker proof-honest), 2026-09-18.
 *
 * Pure code shared by the browser and the server, so both always agree. A line mark whose line
 * changed only cosmetically is carried forward to the new text (tagged "carried"); any other
 * change resets it, as before. When in doubt the answer is "substantive": a wrong reset costs a
 * re-read, a wrong carry lets a real change past a reader unseen.
 *
 * Rule: Mike, 2026-09-23 (usability brief). Carry-over is computed at read time from
 * stored anchor text; no stored mark is changed.
 *
 * Cosmetic means one of:
 *   - whitespace, letter case, typographic look-alikes or a final period changed;
 *     other punctuation changes and all symbol/emoji changes require review (S5 round 3);
 *   - listed spelling corrections: the same words in the same order, each changed word
 *     a lower-case misspelling -> correction pair in COMMON_MISSPELLINGS. The reverse
 *     direction and every unlisted word change are substantive, including regional variants.
 * Always substantive: a number, amount or percentage changed; a word added, removed or moved;
 * a negation or other meaning-carrying word changed (LINE_CHANGE_POLICY.meaningWords); a
 * capitalised word that does not start a sentence changed (usually a name); a sentence gains
 * or loses ? or !.
 */

import { COMMON_MISSPELLINGS } from './common-misspellings.js';

export const LINE_CHANGE_POLICY = {
  /**
   * Words whose change always matters, even by one letter ("not" -> "now", "and" -> "any").
   * Compared lower-case with apostrophes removed.
   */
  meaningWords: new Set([
    'not', 'no', 'never', 'nor', 'none', 'neither', 'nothing', 'nobody', 'nowhere', 'without',
    'cannot', 'cant', 'wont', 'dont', 'doesnt', 'didnt', 'isnt', 'arent', 'wasnt', 'werent',
    'shouldnt', 'wouldnt', 'couldnt', 'mustnt', 'hasnt', 'havent', 'hadnt', 'aint',
    'can', 'will', 'would', 'should', 'must', 'may', 'might', 'shall', 'could',
    'all', 'any', 'some', 'every', 'each', 'only', 'most', 'least', 'more', 'less', 'fewer',
    'always', 'sometimes', 'often', 'rarely', 'yes', 'true', 'false',
    'and', 'or', 'but', 'if', 'unless', 'except', 'before', 'after', 'above', 'below',
    'in', 'on', 'off', 'up', 'down', 'to', 'from', 'yet', 'now', 'then',
  ]) as ReadonlySet<string>,
} as const;

export type LineChangeKind = 'same' | 'cosmetic' | 'substantive';

export interface LineChange {
  kind: LineChangeKind;
  /** One short phrase for people and logs ("spelling: recieve -> receive", "number changed"). */
  why: string;
  /** Cosmetic spelling fixes, old -> new, for the "what changed" view. */
  fixes?: Array<{ from: string; to: string }>;
}

function normalize(text: string): string {
  return String(text ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Numbers with their sign, currency and percent: "$10", "-5", "1.5", "10%", "3:30", "2026-09-18". */
const NUMBER_RE = /[+\-−]?[$€£¥]?\d[\d.,:/\-]*%?/gu;

function numbers(text: string): string[] {
  return (text.match(NUMBER_RE) ?? []).map(token => token.replace(/[.,:/\-]+$/u, ''));
}

interface Token {
  text: string;
  lower: string;
  /** Starts with a capital letter. */
  capital: boolean;
  /** First word of the line or of a sentence (after . ! ? : or a line-leading marker). */
  sentenceStart: boolean;
}

/** Words (letters, with inner apostrophes and hyphens). Numbers are compared separately. */
function words(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /\p{L}[\p{L}\p{M}'’\-]*/gu;
  let match: RegExpExecArray | null;
  let lastEnd = 0;
  while ((match = re.exec(text)) !== null) {
    const raw = match[0].replace(/['’\-]+$/u, '');
    const between = text.slice(lastEnd, match.index);
    const sentenceStart = tokens.length === 0 || /[.!?:;]\s*["'“‘(\[]*\s*$/u.test(between);
    tokens.push({
      text: raw,
      lower: raw.toLowerCase(),
      capital: /^\p{Lu}/u.test(raw),
      sentenceStart,
    });
    lastEnd = match.index + match[0].length;
  }
  return tokens;
}

/** Optimal string alignment distance (Damerau-Levenshtein without repeated edits of a substring). */
export function editDistance(a: string, b: string, cap = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev2 = new Array<number>(cols).fill(0);
  let prev = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i += 1) {
    const cur = new Array<number>(cols).fill(0);
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, prev2[j - 2] + 1);
      cur[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > cap) return cap + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[cols - 1];
}

/** Preserve symbols, emoji modifiers, variation selectors, joiners and emoji tag characters. */
function symbols(text: string): string {
  return (text.match(/[\p{S}\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0e\ufe0f\u20e3\u{e0020}-\u{e007f}]/gu) ?? []).join('');
}

/** Normalize only typographic equivalents. An in-word single hyphen stays a hyphen. */
function typography(text: string): string {
  return text.replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"')
    .replace(/\.\.\./gu, '…')
    .replace(/--|[–—]|(?<=\s)-(?=\s)/gu, ' — ');
}

/** Punctuation keeps its position among letter/number runs, even when a spelling is corrected. */
function punctuation(text: string): string {
  // A lone final period is optional, including before closing quotation marks or brackets.
  // Interior periods and ellipses remain significant; numeric changes are checked separately.
  const withoutFinalPeriod = text.replace(/\.(?=["')\]}]*$)/u, '');
  const marks: Array<[number, string]> = [];
  let run = 0;
  for (const match of withoutFinalPeriod.matchAll(/[\p{L}\p{M}\p{N}]+|\p{P}/gu)) {
    if (/^\p{P}/u.test(match[0])) marks.push([run, match[0]]);
    else run += 1;
  }
  return JSON.stringify(marks);
}

/** Keep ? and ! at their word index in one scan, without repeatedly tokenizing prefixes. */
function sentenceForce(text: string): string {
  const marks: Array<[number, string]> = [];
  let wordIndex = 0;
  for (const match of text.matchAll(/\p{L}[\p{L}\p{M}'’\-]*|[.!?]+/gu)) {
    if (/^[.!?]/u.test(match[0])) {
      if (/[!?]/u.test(match[0])) marks.push([wordIndex, match[0].replace(/\./gu, '')]);
    } else wordIndex += 1;
  }
  return JSON.stringify(marks);
}

const bare = (word: string) => word.replace(/['’]/gu, '');

/**
 * Classifies the change from `before` to `after` (the text of one line, any whitespace).
 * Deterministic; spelling carry-over is directional, from listed misspelling to correction.
 */
export function classifyLineChange(before: string, after: string): LineChange {
  const a = normalize(before);
  const b = normalize(after);
  if (a === b) return { kind: 'same', why: 'unchanged' };
  if (!a || !b) return { kind: 'substantive', why: a ? 'line emptied' : 'line added' };

  if (symbols(a) !== symbols(b)) {
    return { kind: 'substantive', why: 'a symbol changed' };
  }
  const typedA = typography(a);
  const typedB = typography(b);
  if (sentenceForce(typedA) !== sentenceForce(typedB)) {
    return { kind: 'substantive', why: 'question or exclamation changed' };
  }

  // Numbers first: "$10" -> "$100", "1.5" -> "15" and "10%" -> "10" all matter.
  const numsA = numbers(a);
  const numsB = numbers(b);
  if (numsA.length !== numsB.length || numsA.some((n, i) => n !== numsB[i])) {
    return { kind: 'substantive', why: 'a number changed' };
  }

  if (punctuation(typedA) !== punctuation(typedB)) {
    return { kind: 'substantive', why: 'punctuation changed' };
  }

  const wa = words(typedA);
  const wb = words(typedB);
  // Case and punctuation only: the same words in the same order, ignoring case.
  if (wa.length === wb.length && wa.every((t, i) => t.lower === wb[i].lower)) {
    return { kind: 'cosmetic', why: 'case, punctuation or spacing only' };
  }
  if (wa.length !== wb.length) {
    return { kind: 'substantive', why: wb.length > wa.length ? 'words added' : 'words removed' };
  }
  // Moved words: the same words in another order.
  const sortedA = wa.map(t => t.lower).sort().join(' ');
  const sortedB = wb.map(t => t.lower).sort().join(' ');
  if (sortedA === sortedB) return { kind: 'substantive', why: 'words moved' };

  const oldSet = new Set(wa.map(t => t.lower));
  const newSet = new Set(wb.map(t => t.lower));
  const fixes: Array<{ from: string; to: string }> = [];
  for (let i = 0; i < wa.length; i += 1) {
    const x = wa[i];
    const y = wb[i];
    if (x.lower === y.lower) continue;
    if (LINE_CHANGE_POLICY.meaningWords.has(bare(x.lower)) || LINE_CHANGE_POLICY.meaningWords.has(bare(y.lower))
      || /n['’]t$/u.test(x.lower) || /n['’]t$/u.test(y.lower)) {
      return { kind: 'substantive', why: `meaning word changed: ${x.text} -> ${y.text}` };
    }
    if ((x.capital && !x.sentenceStart) || (y.capital && !y.sentenceStart)) {
      return { kind: 'substantive', why: `capitalised word changed: ${x.text} -> ${y.text}` };
    }
    // A word swapped with another word of the line is a move, not a spelling fix.
    if (oldSet.has(y.lower) && newSet.has(x.lower)) return { kind: 'substantive', why: 'words moved' };
    if (COMMON_MISSPELLINGS.get(x.lower) !== y.lower) {
      return { kind: 'substantive', why: `word changed: ${x.text} -> ${y.text}` };
    }
    fixes.push({ from: x.text, to: y.text });
  }
  return { kind: 'cosmetic', why: `spelling: ${fixes.map(f => `${f.from} -> ${f.to}`).join(', ')}`, fixes };
}

/** True when a mark made on `before` may be carried to `after`. */
export function isCosmeticChange(before: string, after: string): boolean {
  return classifyLineChange(before, after).kind === 'cosmetic';
}
