/**
 * Proof Documents Step B3: `{ask}` lines in the text. View-only widget decorations:
 *   - a small "Ask" tag at the start of the question line;
 *   - the answer control (recommendation, Yes / Not yet / No, words) at the end of the line's
 *     content, shown as a block under the line's text.
 * Both live inside the line's own element, so a folded section hides them with the line.
 * Decorations never change the document, its marks or its Yjs state; the transaction that sets
 * them carries no steps and is not added to history.
 *
 * Authorship: Claude Opus 5 (worker proof-ask), 2026-09-18.
 */
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';

export const askViewKey = new PluginKey<DecorationSet>('proofAskView');

export interface AskDecorationSpec {
  askId: string;
  /** ProseMirror position before the line's text block. */
  pos: number;
  nodeSize: number;
  /** Changes whenever the control must be rebuilt (answers, recommendation, viewer). */
  sig: string;
  tag(): HTMLElement;
  control(): HTMLElement;
}

interface AskMeta { specs: AskDecorationSpec[] }

function build(doc: Parameters<typeof DecorationSet.create>[0], specs: AskDecorationSpec[]): DecorationSet {
  const decorations: Decoration[] = [];
  for (const spec of specs) {
    const start = spec.pos + 1;
    const end = spec.pos + spec.nodeSize - 1;
    if (start < 0 || end > doc.content.size || end < start) continue;
    const node = doc.nodeAt(spec.pos);
    if (!node || !node.isTextblock) continue;
    decorations.push(Decoration.widget(start, () => spec.tag(), {
      side: -1, key: `ask-tag:${spec.askId}`, ignoreSelection: true, stopEvent: () => true, pask: 'tag',
    }));
    decorations.push(Decoration.widget(end, () => spec.control(), {
      side: 1, key: `ask-control:${spec.askId}:${spec.sig}`, ignoreSelection: true, stopEvent: () => true, pask: 'control',
    }));
  }
  return DecorationSet.create(doc, decorations);
}

export const askViewPlugin = $prose(() => new Plugin<DecorationSet>({
  key: askViewKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      const meta = tr.getMeta(askViewKey) as AskMeta | undefined;
      if (meta) return build(tr.doc, meta.specs);
      return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
    },
  },
  props: {
    decorations(state) {
      return askViewKey.getState(state) ?? DecorationSet.empty;
    },
  },
}));

/** Replaces the ask widgets. A view-only transaction. */
export function setAskDecorations(view: EditorView, specs: AskDecorationSpec[]): void {
  const tr = view.state.tr.setMeta(askViewKey, { specs } satisfies AskMeta).setMeta('addToHistory', false);
  view.dispatch(tr);
}
