import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@milkdown/kit/prose/state';
import { closeHistory } from '@milkdown/kit/prose/history';
import { ySyncPluginKey, yUndoPluginKey } from 'y-prosemirror';
import { scanBrackets, sentenceAnchor } from '../../formats/bracket-comments';
import { createComment } from '../../formats/marks';
import { getMarkMetadata, marksPluginKey } from './marks';
import { getCurrentActor } from '../actor';
import { getReviewStyle } from '../review-style';
import { withHumanReviewWrite } from '../review-mark-origin';
const key = new PluginKey<number>('bracketComments');

export function bracketCommentTransaction(state: EditorState, by: string): Transaction | null {
  const tokens: { kind: 'literal' | 'comment'; from: number; to: number; text: string }[] = [];
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock || node.type.spec.code) return;
    const text = node.textBetween(0, node.content.size, '', '\ufffc');
    for (const token of scanBrackets(text)) {
      const from = pos + 1 + token.from, to = pos + 1 + token.to;
      // Code spans are literal too.
      let code = false; node.nodesBetween(token.from, token.to, n => { if (n.marks.some(m => m.type.spec.code || m.type.name === 'code')) code = true; });
      if (!code) tokens.push({ ...token, from, to });
    }
  });
  if (!tokens.length) return null;
  let tr = state.tr;
  for (const token of [...tokens].reverse()) {
    if (token.kind === 'literal') {
      const type = state.schema.nodes.literalBrackets; if (!type) continue;
      tr.replaceWith(token.from, token.to, type.create({ value: token.text }));
    } else tr.delete(token.from, token.to);
  }
  const metadata = { ...getMarkMetadata(state) };
  for (const token of tokens.filter(t => t.kind === 'comment')) {
    const position = tr.mapping.map(token.from, -1), $pos = tr.doc.resolve(position);
    let range: { from: number; to: number } | null = null;
    if ($pos.parent.isTextblock && $pos.parent.content.size) {
      const text = $pos.parent.textBetween(0, $pos.parent.content.size, '', '\ufffc');
      const anchor = sentenceAnchor(text, $pos.parentOffset);
      if (anchor) range = { from: $pos.start() + anchor.from, to: $pos.start() + anchor.to };
    } else {
      tr.doc.descendants((node, at) => {
        if (node.isTextblock && node.content.size && at + node.nodeSize <= position) range = { from: at + 1, to: at + 1 + node.content.size };
      });
    }
    if (!range || !state.schema.marks.proofComment) return null;
    const quote = tr.doc.textBetween(range.from, range.to, '\n');
    const mark = createComment(quote, by, token.text, undefined, range);
    tr.addMark(range.from, range.to, state.schema.marks.proofComment.create({ id: mark.id, by }));
    metadata[mark.id] = { kind: 'comment', by, createdAt: mark.at, quote, range, text: token.text, threadId: (mark.data as any).thread, thread: [], replies: [], resolved: false };
  }
  if (!tr.docChanged) return null;
  return closeHistory(tr).setMeta(marksPluginKey, { type: 'SET_METADATA', metadata }).setMeta('proofLocalMarkChange', true).setMeta(key, true);
}
export const bracketCommentsPlugin = $prose(() => new Plugin<number>({
  key,
  state: {
    init: () => 0,
    apply(tr, value) {
      return tr.docChanged && !tr.getMeta(key) && !tr.getMeta(marksPluginKey) && !tr.getMeta('history$')
        && !tr.getMeta('document-load') && !tr.getMeta(ySyncPluginKey)?.isChangeOrigin && tr.getMeta('addToHistory') !== false ? value + 1 : value;
    },
  },
  view(view) {
    let revision = key.getState(view.state), pending = false, destroyed = false;
    return {
      update() {
        const next = key.getState(view.state); if (revision === next) return; revision = next;
        if (getReviewStyle() !== 'playmaker' || pending) return;
        pending = true;
        queueMicrotask(() => {
          pending = false; if (destroyed || getReviewStyle() !== 'playmaker' || view.composing) return;
          const tr = bracketCommentTransaction(view.state, getCurrentActor()); if (!tr) return;
          const manager = yUndoPluginKey.getState(view.state)?.undoManager;
          withHumanReviewWrite(() => {
            manager?.stopCapturing();
            view.dispatch(tr.setMeta('proofMarkSource', 'human'));
            manager?.stopCapturing();
          });
        });
      },
      destroy() { destroyed = true; },
    };
  },
}));
