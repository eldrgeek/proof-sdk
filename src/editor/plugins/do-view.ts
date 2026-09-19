/**
 * Proof Documents `{do}` action lines in the text (safe slice). View-only widget decorations:
 *   - a small "Do" tag at the start of the line;
 *   - the action control (state, consequence, Approve, a disabled Run) at the end of the line's
 *     content, shown as a block under the line's text.
 * Both live inside the line's own element, so a folded section hides them with the line.
 * Decorations never change the document, its marks or its Yjs state; the transaction that sets
 * them carries no steps and is not added to history.
 *
 * Authorship: Claude Opus 5 (worker proof-do), 2026-09-18, a copy of ask-view.ts (worker proof-ask).
 */
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';

export const doViewKey = new PluginKey<DecorationSet>('proofDoView');

export interface DoDecorationSpec {
  doId: string;
  /** ProseMirror position before the line's text block. */
  pos: number;
  nodeSize: number;
  /** Changes whenever the control must be rebuilt (state, approval, viewer). */
  sig: string;
  tag(): HTMLElement;
  control(): HTMLElement;
}

interface DoMeta { specs: DoDecorationSpec[] }

function build(doc: Parameters<typeof DecorationSet.create>[0], specs: DoDecorationSpec[]): DecorationSet {
  const decorations: Decoration[] = [];
  for (const spec of specs) {
    const start = spec.pos + 1;
    const end = spec.pos + spec.nodeSize - 1;
    if (start < 0 || end > doc.content.size || end < start) continue;
    const node = doc.nodeAt(spec.pos);
    if (!node || !node.isTextblock) continue;
    decorations.push(Decoration.widget(start, () => spec.tag(), {
      side: -1, key: `do-tag:${spec.doId}`, ignoreSelection: true, stopEvent: () => true, pdo: 'tag',
    }));
    decorations.push(Decoration.widget(end, () => spec.control(), {
      side: 1, key: `do-control:${spec.doId}:${spec.sig}`, ignoreSelection: true, stopEvent: () => true, pdo: 'control',
    }));
  }
  return DecorationSet.create(doc, decorations);
}

export const doViewPlugin = $prose(() => new Plugin<DecorationSet>({
  key: doViewKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      const meta = tr.getMeta(doViewKey) as DoMeta | undefined;
      if (meta) return build(tr.doc, meta.specs);
      return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
    },
  },
  props: {
    decorations(state) {
      return doViewKey.getState(state) ?? DecorationSet.empty;
    },
  },
}));

/** Replaces the {do} widgets. A view-only transaction. */
export function setDoDecorations(view: EditorView, specs: DoDecorationSpec[]): void {
  const tr = view.state.tr.setMeta(doViewKey, { specs } satisfies DoMeta).setMeta('addToHistory', false);
  view.dispatch(tr);
}
