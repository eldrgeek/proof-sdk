/**
 * Proof Documents — line tiers: view-only decorations. Context lines get the class
 * "ptier-context" (quieter text, a faint left rule; "ptier-proposed" while an AI's tag is not
 * confirmed); with "Show only decisions" on, context lines that are not Issues get "ptier-folded"
 * (hidden). Decorations never change the document, its marks or its Yjs state; the transaction that
 * sets them carries no steps and is not added to history (like the fold decorations).
 *
 * Authorship: Claude Opus 5 (worker proof-tiers), 2026-09-19.
 */
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';

export const tierViewKey = new PluginKey<DecorationSet>('proofTierView');

export interface TierLineSpec {
  lineIndex: number;
  /** ProseMirror position before the line's node (a text block or a table row). */
  pos: number;
  nodeSize: number;
  context: boolean;
  proposed: boolean;
  folded: boolean;
}

interface TierMeta { lines: TierLineSpec[] }

function build(doc: ProseMirrorNode, meta: TierMeta): DecorationSet {
  const decorations: Decoration[] = [];
  for (const spec of meta.lines) {
    if (!spec.context && !spec.folded) continue;
    const node = doc.nodeAt(spec.pos);
    if (!node || node.nodeSize !== spec.nodeSize || spec.pos + spec.nodeSize > doc.content.size) continue;
    const classes = [spec.context ? 'ptier-context' : '', spec.proposed ? 'ptier-proposed' : '', spec.folded ? 'ptier-folded' : ''].filter(Boolean).join(' ');
    decorations.push(Decoration.node(spec.pos, spec.pos + spec.nodeSize, { class: classes, 'data-tier-line': String(spec.lineIndex) }, { ptier: spec.folded ? 'folded' : 'context' }));
  }
  return DecorationSet.create(doc, decorations);
}

export const tierViewPlugin = $prose(() => new Plugin<DecorationSet>({
  key: tierViewKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      const meta = tr.getMeta(tierViewKey) as TierMeta | undefined;
      if (meta) return build(tr.doc, meta);
      return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
    },
  },
  props: {
    decorations(state) {
      return tierViewKey.getState(state) ?? DecorationSet.empty;
    },
  },
}));

/** How many tier decorations are present (to rebuild after a remote update dropped them). */
export function tierDecorationCount(view: EditorView): number {
  return tierViewKey.getState(view.state)?.find().length ?? 0;
}

/** Replaces the tier decorations. A view-only transaction. */
export function setTierDecorations(view: EditorView, lines: TierLineSpec[]): void {
  const tr = view.state.tr.setMeta(tierViewKey, { lines } satisfies TierMeta).setMeta('addToHistory', false);
  view.dispatch(tr);
}
