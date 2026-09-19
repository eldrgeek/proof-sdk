/**
 * Proof Documents — closed Issues fold (src/shared/closed-fold.ts): view-only node decorations.
 * A folded line gets the class "pclose-folded" and its one-line summary in data-pclose-summary
 * (drawn by CSS over the collapsed line). Decorations never change the document, its marks or its
 * Yjs state; the transaction that sets them carries no steps and is not added to history.
 *
 * Authorship: Claude Opus 5 (worker proof-hover), 2026-09-19.
 */
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';

export const closedFoldViewKey = new PluginKey<DecorationSet>('proofClosedFoldView');

export interface ClosedFoldSpec {
  lineIndex: number;
  /** ProseMirror position before the line's text block. */
  pos: number;
  nodeSize: number;
  summary: string;
}

interface Meta { lines: ClosedFoldSpec[] }

function build(doc: ProseMirrorNode, meta: Meta): DecorationSet {
  const decorations: Decoration[] = [];
  for (const spec of meta.lines) {
    const node = doc.nodeAt(spec.pos);
    if (!node || node.nodeSize !== spec.nodeSize || spec.pos + spec.nodeSize > doc.content.size) continue;
    decorations.push(Decoration.node(spec.pos, spec.pos + spec.nodeSize, {
      class: 'pclose-folded',
      'data-pclose-line': String(spec.lineIndex),
      'data-pclose-summary': spec.summary,
      title: 'Closed by you. Click to open this line.',
    }, { pclose: spec.lineIndex }));
  }
  return DecorationSet.create(doc, decorations);
}

export const closedFoldViewPlugin = $prose(() => new Plugin<DecorationSet>({
  key: closedFoldViewKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      const meta = tr.getMeta(closedFoldViewKey) as Meta | undefined;
      if (meta) return build(tr.doc, meta);
      return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
    },
  },
  props: {
    decorations(state) {
      return closedFoldViewKey.getState(state) ?? DecorationSet.empty;
    },
  },
}));

/** Line indices folded by the decorations now. */
export function closedFoldedLines(view: EditorView): number[] {
  const set = closedFoldViewKey.getState(view.state);
  return set ? set.find().map(d => Number((d.spec as { pclose?: number }).pclose)).filter(n => Number.isFinite(n)) : [];
}

/** Replaces the closed-fold decorations. A view-only transaction. */
export function setClosedFoldDecorations(view: EditorView, lines: ClosedFoldSpec[]): void {
  const tr = view.state.tr.setMeta(closedFoldViewKey, { lines } satisfies Meta).setMeta('addToHistory', false);
  view.dispatch(tr);
}
