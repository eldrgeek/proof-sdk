/** Mike, 2026-09-25, yfbqrau4 point 11: an end-of-item question is a discussion.
 * Only a person's pending insert is eligible. These helpers never decide on a pause.
 */
import type { MentionCandidate } from './chat';
import type { Node } from '@milkdown/kit/prose/model';

export const TYPED_DISCUSSION_POLICY = {
  closingQuestionCharacters: '"\'”’)]}',
  mentionWinsOverQuestion: true,
  ambiguousMention: 'keep-text',
  hint: 'Enter sends this as a discussion',
  sent: 'Asked as a discussion on line {line}. Undo turns it back into text.',
  turnBackLabel: 'Turn back into text',
  threadIdPrefix: 'typed-discussion:',
  shiftEnter: 'keep-text',
  restoreAfterLaterEdits: 'new-proposal-at-current-item-end',
  redoConversion: false,
  missingOriginalPrefix: ' ',
  missingItem: 'refuse',
  failedSend: 'restore-text',
  emptyAnchor: 'keep-text',
  maxThreadCharacters: 4000,
  /** "Turn back into text" while this page still holds the conversion's history (the same visit,
   * later edits included). After a reload, resolving the comment loops Yjs's cleanup (bead ac-m23),
   * so the control is not offered then and the discussion stays a discussion. */
  turnBackAfterReload: false,
  itemTypes: ['paragraph', 'heading', 'list_item', 'table_row', 'table_header_row'],
} as const;

export type TypedRunClassification = { discussion: false } |
  { discussion: true; reason: 'question' | 'mention'; waitingOn: string[] };

export function classifyTypedRun(text: string, candidates: readonly MentionCandidate[]): TypedRunClassification {
  const trimmed = text.trim();
  if (!trimmed) return { discussion: false };
  if (trimmed.startsWith('@')) {
    const matches = candidates.flatMap(c => c.names.map(name => ({ actor: c.actor, name })))
      .filter(p => trimmed.slice(1, p.name.length + 1).toLowerCase() === p.name.toLowerCase()
        && !/[\w@-]/.test(trimmed.charAt(p.name.length + 1)))
      .sort((a, b) => b.name.length - a.name.length);
    const longest = matches[0]?.name.length;
    const actors = [...new Set(matches.filter(p => p.name.length === longest).map(p => p.actor))];
    if (actors.length === 1) return { discussion: true, reason: 'mention', waitingOn: actors };
    // An unknown or ambiguous name is not a mention, but point 11's two conditions are
    // alternatives: a run that still ends with "?" is a question for everyone (review, 2026-09-25).
  }
  let end = trimmed.length;
  while (end && TYPED_DISCUSSION_POLICY.closingQuestionCharacters.includes(trimmed[end - 1])) end--;
  return trimmed[end - 1] === '?' ? { discussion: true, reason: 'question', waitingOn: [] } : { discussion: false };
}

export interface TypedItem { from: number; to: number; end: number; kind: string }
/** Table rows and list entries take precedence over their inner paragraphs. */
export function typedItemAt(doc: Node, pos: number): TypedItem | null {
  if (pos < 0 || pos > doc.content.size) return null;
  const at = doc.resolve(pos);
  let depth = -1;
  for (let d = at.depth; d > 0; d--) {
    const name = at.node(d).type.name;
    if (name === 'table_row' || name === 'table_header_row') { depth = d; break; }
    if (depth < 0 && name === 'list_item') depth = d;
  }
  if (depth < 0 && ['paragraph', 'heading'].includes(at.parent.type.name)) depth = at.depth;
  if (depth < 0) return null;
  const node = at.node(depth), from = at.before(depth), to = at.after(depth);
  let end = from + node.nodeSize - 1;
  if (!node.isTextblock) node.descendants((child, offset) => {
    if (child.isTextblock) end = from + 1 + offset + child.nodeSize - 1;
  });
  return { from, to, end, kind: node.type.name };
}

export function isRunAtItemEnd(doc: Node, range: { from: number; to: number }): boolean {
  if (range.to <= range.from) return false;
  const item = typedItemAt(doc, range.from);
  const last = typedItemAt(doc, range.to);
  return Boolean(item && last && item.from === last.from && range.to <= item.end
    && !doc.textBetween(range.to, item.end, '', '\ufffc').trim());
}

export function typedDiscussionId(insertId: string): string { return TYPED_DISCUSSION_POLICY.threadIdPrefix + insertId; }
export function typedDiscussionInsertId(threadId: string): string | null {
  return threadId.startsWith(TYPED_DISCUSSION_POLICY.threadIdPrefix)
    ? threadId.slice(TYPED_DISCUSSION_POLICY.threadIdPrefix.length) || null : null;
}
