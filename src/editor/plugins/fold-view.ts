/**
 * Proof Documents Step B2: folding. Hides the bodies of folded sections with node decorations
 * (class "pfold-hidden"). Decorations are view-only: they never change the document, its marks
 * or its Yjs state, and the transaction that sets them carries no steps.
 *
 * Authorship: Claude Opus 5 (worker proof-fold), 2026-09-18.
 */
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';

export const foldViewKey = new PluginKey<DecorationSet>('proofFoldView');

interface FoldMeta { blocks: Array<[number, number]> }

export const foldViewPlugin = $prose(() => new Plugin<DecorationSet>({
  key: foldViewKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      const meta = tr.getMeta(foldViewKey) as FoldMeta | undefined;
      if (meta) {
        const decorations: Decoration[] = [];
        const doc = tr.doc;
        const hide = new Set<number>();
        const headings = new Set<number>();
        for (const [from, to] of meta.blocks) {
          headings.add(from - 1);
          for (let i = from; i < Math.min(to, doc.childCount); i += 1) hide.add(i);
        }
        let pos = 0;
        for (let i = 0; i < doc.childCount; i += 1) {
          const child = doc.child(i);
          if (hide.has(i)) decorations.push(Decoration.node(pos, pos + child.nodeSize, { class: 'pfold-hidden' }, { pfold: 'hidden' }));
          else if (headings.has(i)) decorations.push(Decoration.node(pos, pos + child.nodeSize, { class: 'pfold-folded-heading' }, { pfold: 'heading' }));
          pos += child.nodeSize;
        }
        return DecorationSet.create(doc, decorations);
      }
      return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
    },
  },
  props: {
    decorations(state) {
      return foldViewKey.getState(state) ?? DecorationSet.empty;
    },
  },
}));

/** Top-level block indices currently hidden by the decorations (for tests and the UI). */
export function hiddenBlocks(view: EditorView): number[] {
  const set = foldViewKey.getState(view.state);
  if (!set) return [];
  const starts = new Set(set.find(undefined, undefined, spec => spec.pfold === 'hidden').map(decoration => decoration.from));
  const out: number[] = [];
  let pos = 0;
  for (let i = 0; i < view.state.doc.childCount; i += 1) {
    if (starts.has(pos)) out.push(i);
    pos += view.state.doc.child(i).nodeSize;
  }
  return out;
}

/** Replaces the hidden top-level block ranges [from, to). A view-only transaction. */
export function setHiddenBlocks(view: EditorView, blocks: Array<[number, number]>): void {
  const tr = view.state.tr.setMeta(foldViewKey, { blocks } satisfies FoldMeta).setMeta('addToHistory', false);
  view.dispatch(tr);
}
