/**
 * Proof Documents Step B4f: view-only decorations for competing alternatives and term links.
 *   - Alternatives: a block under the line's text listing its wordings, the original first, each
 *     with who offered it and (unless hidden) how many picked it.
 *   - Term links: the first use of a defined term, for a reader who has not seen its definition,
 *     is underlined; hovering shows the definition and a click opens it (src/ui/line-marks.ts).
 * Decorations never change the document, its marks or its Yjs state; the transaction that sets
 * them carries no steps and is not added to history (like the ask widgets).
 *
 * Authorship: Claude Opus 5 (worker proof-bundles), 2026-09-19.
 */
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';

export const proofExtrasViewKey = new PluginKey<DecorationSet>('proofExtrasView');

export interface AltStackSpec {
  lineIndex: number;
  /** ProseMirror position before the line's text block. */
  pos: number;
  nodeSize: number;
  sig: string;
  render(): HTMLElement;
}

export interface TermLinkSpec {
  term: string;
  definition: string;
  defLineIndex: number;
  pos: number;
  nodeSize: number;
}

interface ExtrasMeta { alts: AltStackSpec[]; terms: TermLinkSpec[] }

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The document range of the first whole-word `term` inside the text block at `pos`. */
export function termRange(doc: ProseMirrorNode, pos: number, term: string): { from: number; to: number } | null {
  const node = doc.nodeAt(pos);
  if (!node || !node.isTextblock) return null;
  const chars: number[] = [];
  let text = '';
  node.descendants((child, childPos) => {
    if (child.isText && child.text) {
      for (let i = 0; i < child.text.length; i += 1) chars.push(pos + 1 + childPos + i);
      text += child.text;
    }
    return true;
  });
  const match = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(term)})(?=$|[^\\p{L}\\p{N}])`, 'iu').exec(text);
  if (!match) return null;
  const start = match.index + match[1].length;
  const end = start + match[2].length - 1;
  if (chars[start] === undefined || chars[end] === undefined) return null;
  return { from: chars[start], to: chars[end] + 1 };
}

function build(doc: ProseMirrorNode, meta: ExtrasMeta): DecorationSet {
  const decorations: Decoration[] = [];
  for (const spec of meta.alts) {
    const end = spec.pos + spec.nodeSize - 1;
    const node = doc.nodeAt(spec.pos);
    if (!node || !node.isTextblock || end > doc.content.size) continue;
    decorations.push(Decoration.widget(end, () => spec.render(), {
      side: 2, key: `alt-stack:${spec.lineIndex}:${spec.sig}`, ignoreSelection: true, stopEvent: () => true,
    }));
  }
  for (const spec of meta.terms) {
    const range = termRange(doc, spec.pos, spec.term);
    if (!range) continue;
    decorations.push(Decoration.inline(range.from, range.to, {
      nodeName: 'span',
      class: 'pdx-term',
      'data-term': spec.term,
      'data-def-line': String(spec.defLineIndex),
      title: `${spec.term}: ${spec.definition}`,
    }));
  }
  return DecorationSet.create(doc, decorations);
}

export const proofExtrasViewPlugin = $prose(() => new Plugin<DecorationSet>({
  key: proofExtrasViewKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      const meta = tr.getMeta(proofExtrasViewKey) as ExtrasMeta | undefined;
      if (meta) return build(tr.doc, meta);
      return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
    },
  },
  props: {
    decorations(state) {
      return proofExtrasViewKey.getState(state) ?? DecorationSet.empty;
    },
  },
}));

/** Replaces the alternatives stacks and term links. A view-only transaction. */
export function setProofExtrasDecorations(view: EditorView, alts: AltStackSpec[], terms: TermLinkSpec[]): void {
  const tr = view.state.tr.setMeta(proofExtrasViewKey, { alts, terms } satisfies ExtrasMeta).setMeta('addToHistory', false);
  view.dispatch(tr);
}
