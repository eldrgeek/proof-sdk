/** Shared lexical rules for the editor, pasted Markdown and agent mutations. */
export interface BracketToken { kind: 'comment' | 'literal'; from: number; to: number; text: string }
const escapedAt = (text: string, at: number): boolean => { let n = 0; while (at > 0 && text[--at] === '\\') n++; return n % 2 === 1; };
export function scanBrackets(text: string): BracketToken[] {
  const tokens: BracketToken[] = [];
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] === '`' && !escapedAt(text, i)) {
      const run = text.slice(i).match(/^`+/)![0]; const end = text.indexOf(run, i + run.length);
      if (end >= 0) { i = end + run.length - 1; continue; }
    }
    if (text.startsWith('~~~', i) && (i === 0 || text[i - 1] === '\n')) { const end = text.indexOf('\n~~~', i + 3); if (end >= 0) { i = end + 3; continue; } }
    const pair = text.slice(i, i + 2); if (pair !== '[[' && pair !== ']]') continue;
    if (escapedAt(text, i)) { tokens.push({ kind: 'literal', from: i - 1, to: i + 2, text: pair }); i++; continue; }
    if (pair !== '[[') { i++; continue; }
    let end = text.indexOf(']]', i + 2);
    while (end >= 0 && escapedAt(text, end)) end = text.indexOf(']]', end + 2);
    if (end < 0) continue;
    const body = text.slice(i + 2, end).replace(/\\(\[\[|\]\])/g, '$1').trim();
    if (body) tokens.push({ kind: 'comment', from: i, to: end + 2, text: body });
    i = end + 1;
  }
  return tokens;
}
export function sentenceAnchor(text: string, position: number): { from: number; to: number } | null {
  const start = text.lastIndexOf('\n\n', Math.max(0, position - 1)) + 2;
  const paragraphStart = start === 1 ? 0 : start;
  const end = text.indexOf('\n\n', position); const paragraphEnd = end < 0 ? text.length : end;
  const paragraph = text.slice(paragraphStart, paragraphEnd);
  if (!paragraph.trim()) {
    const previous = [...text.slice(0, paragraphStart).matchAll(/[^\n]+(?:\n(?!\n)[^\n]+)*/g)].filter(m => m[0].trim()).at(-1);
    if (!previous) return null;
    const from = previous.index! + previous[0].length - previous[0].trimStart().length;
    return { from, to: previous.index! + previous[0].trimEnd().length };
  }
  const sentences = [...paragraph.matchAll(/[^.!?]+(?:[.!?]+["')]*|$)/g)];
  const chosen = sentences.find(m => paragraphStart + m.index! + m[0].length >= position) ?? sentences.at(-1);
  if (!chosen) return null;
  const from = paragraphStart + chosen.index! + chosen[0].length - chosen[0].trimStart().length;
  const to = paragraphStart + chosen.index! + chosen[0].trimEnd().length;
  return to > from ? { from, to } : null;
}
export function extractBracketComments(source: string, by: string): { markdown: string; comments: { quote: string; text: string; by: string; from: number; to: number }[] } {
  const spans = scanBrackets(source).filter(t => t.kind === 'comment');
  let markdown = source;
  for (const token of [...spans].reverse()) markdown = markdown.slice(0, token.from) + markdown.slice(token.to);
  let removed = 0;
  const comments = spans.flatMap(token => {
    const position = token.from - removed; removed += token.to - token.from;
    const range = sentenceAnchor(markdown, position);
    return range ? [{ ...range, quote: markdown.slice(range.from, range.to), text: token.text, by }] : [];
  });
  // A note with no surrounding document must stay recoverable as text.
  if (comments.length !== spans.length) return { markdown: source, comments: [] };
  return { markdown, comments };
}
