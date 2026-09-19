/**
 * Proof Documents — Step B4f: Explain (the E key) and the per-reader term ledger (pure code,
 * shared by the browser and the server).
 *
 * Authorship: idea from Anthropic Fable (research round 2, idea 7); brief by the COS (Claude),
 * 2026-09-19; built by Claude Opus 5 (worker proof-bundles), 2026-09-19. POLICY rules are
 * Claude's decisions where the brief is silent.
 *
 * Explain: on the focus line, E (or the rail's "Explain") posts a question scoped to that line to
 * the document's AI collaborators: a comment thread on the line, tagged `explain` (stored beside
 * the document), plus an `explain.requested` event an AI can answer by replying on the thread.
 * Asking never marks the line, never counts as a rejection, and is never an Issue for the asker.
 *
 * Term ledger: a line of the form "**Term** — definition" or "Term: definition" inside a section
 * named Terms, Glossary or Definitions defines Term. A reader who has not yet seen that definition
 * line (no current Seen, Agreed, Approved or Rejected mark on it) sees the term's first use in the
 * rest of the document as a link that shows the definition. Once they have seen it, the link goes.
 */
import { actorKey, countsAsSeen, type DocLine, type LineState } from './line-marks.js';
import { computeSections } from './folding.js';

export const EXPLAIN_POLICY = {
  key: 'e',
  /** The question when the reader types none. */
  defaultQuestion: 'What does this line mean, and why is it here?',
  /** The thread's first words (the tag people see). */
  commentPrefix: 'Explain:',
  /** The question names the document's AI collaborators (@name), so their Familiar sees it. */
  mentionAis: true,
  /** An Explain thread is never an Issue (for the asker or anyone): the event is the AI's to-do. */
  commentIsIssue: false,
  /** Asking never marks the line and never counts as a rejection (brief). */
  marksLine: false,
  maxQuestion: 300,
  /** Only people and AIs with comment access can ask (it posts a comment). */
  whoMayAsk: 'commenter' as const,
} as const;

export const TERM_POLICY = {
  /** A section whose heading starts with one of these words holds definitions. */
  sectionPattern: /^\s*(terms|glossary|definitions)\b/i,
  /** "Term — definition", "Term – definition", "Term - definition" or "Term: definition". */
  linePatterns: [
    /^(.{1,60}?)\s+[—–]\s+(.+)$/,
    /^(.{1,60}?)\s*[—–]\s*(.+)$/,
    /^(.{1,60}?)\s+-{1,2}\s+(.+)$/,
    /^([^:]{1,60}):\s+(.+)$/,
  ] as readonly RegExp[],
  maxTermWords: 6,
  minTermLength: 2,
  /** Link only the first use of each term outside its Terms section (brief). */
  firstUseOnly: true,
  /** Seeing the definition line means a current mark that counts as Seen (not a skim). */
  seenMeans: 'current-mark-counts-as-seen' as const,
} as const;

export interface TermDef {
  term: string;
  definition: string;
  /** The definition line. */
  lineIndex: number;
  hash: string;
}

export interface TermUse {
  term: string;
  definition: string;
  defLineIndex: number;
  /** The line of the first use, and the character range in its normalized text. */
  lineIndex: number;
  from: number;
  to: number;
}

function cleanTerm(raw: string): string | null {
  const term = raw.replace(/^[*_`"'“”‘’\s]+|[*_`"'“”‘’\s]+$/g, '').trim();
  if (term.length < TERM_POLICY.minTermLength) return null;
  if (term.split(/\s+/).length > TERM_POLICY.maxTermWords) return null;
  if (/[.!?]$/.test(term)) return null;
  return term;
}

/** Every term the document defines, in document order (the first definition of a term wins). */
export function findTerms(lines: DocLine[]): TermDef[] {
  const out: TermDef[] = [];
  const seen = new Set<string>();
  for (const section of computeSections(lines)) {
    if (!TERM_POLICY.sectionPattern.test(lines[section.headingIndex]?.text ?? '')) continue;
    for (let i = section.headingIndex + 1; i < section.lineEnd; i += 1) {
      const line = lines[i];
      if (!line || typeof line.level === 'number' || line.kind === 'table_row' || line.kind === 'code_block') continue;
      for (const pattern of TERM_POLICY.linePatterns) {
        const match = line.text.match(pattern);
        if (!match) continue;
        const term = cleanTerm(match[1]);
        const definition = match[2]?.trim();
        if (!term || !definition) continue;
        const key = term.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ term, definition, lineIndex: line.index, hash: line.hash });
        }
        break;
      }
    }
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Lines inside any Terms section (uses there are not linked). */
function termSectionLines(lines: DocLine[]): Set<number> {
  const out = new Set<number>();
  for (const section of computeSections(lines)) {
    if (!TERM_POLICY.sectionPattern.test(lines[section.headingIndex]?.text ?? '')) continue;
    for (let i = section.headingIndex; i < section.lineEnd; i += 1) out.add(i);
  }
  return out;
}

/** The first use of each term outside the Terms sections (whole words, any case). */
export function firstTermUses(lines: DocLine[], terms: TermDef[]): TermUse[] {
  const skip = termSectionLines(lines);
  const out: TermUse[] = [];
  for (const def of terms) {
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(def.term)})(?=$|[^\\p{L}\\p{N}])`, 'iu');
    for (const line of lines) {
      if (skip.has(line.index) || line.index === def.lineIndex || line.kind === 'code_block') continue;
      const match = pattern.exec(line.text);
      if (!match) continue;
      const from = match.index + match[1].length;
      out.push({ term: def.term, definition: def.definition, defLineIndex: def.lineIndex, lineIndex: line.index, from, to: from + match[2].length });
      if (TERM_POLICY.firstUseOnly) break;
    }
  }
  return out.sort((a, b) => a.lineIndex - b.lineIndex || a.from - b.from);
}

/** Has `viewer` seen this definition line (a current mark that counts as Seen)? */
export function hasSeenLine(states: LineState[], lineIndex: number, viewer: string): boolean {
  const entry = states[lineIndex]?.marks.get(actorKey(viewer));
  return Boolean(entry && entry.current && countsAsSeen(entry.mark.status));
}

/** The term links this reader should see: first uses of terms whose definition they have not seen. */
export function termLinksFor(lines: DocLine[], states: LineState[], viewer: string): TermUse[] {
  const terms = findTerms(lines);
  if (terms.length === 0) return [];
  return firstTermUses(lines, terms).filter(use => !hasSeenLine(states, use.defLineIndex, viewer));
}

/** The comment text for an Explain question. */
export function explainCommentText(question: string, aiNames: string[]): string {
  const q = String(question ?? '').replace(/\s+/g, ' ').trim().slice(0, EXPLAIN_POLICY.maxQuestion) || EXPLAIN_POLICY.defaultQuestion;
  const mentions = EXPLAIN_POLICY.mentionAis && aiNames.length ? `${aiNames.map(name => `@${name}`).join(' ')} ` : '';
  return `${EXPLAIN_POLICY.commentPrefix} ${mentions}${q}`;
}
