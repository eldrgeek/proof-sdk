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

/**
 * Accord round 2 stage C: the Open view collapses everything settled to a thin rule the reader can
 * click to expand, and greys a row that settled while they worked (it must not vanish under the
 * cursor). Both ride this plugin, so the page has ONE folding mechanism, not two:
 *   - `rules` draws a clickable rule widget before a collapsed run;
 *   - `settled` greys a block with a strikethrough and leaves it where it is.
 */
export interface FoldRule {
  /** The top-level block index the rule is drawn before. */
  at: number;
  /** What the rule says ("14 lines settled"). */
  label: string;
  /** The line range the rule stands for, so the click can expand exactly it. */
  from: number;
  to: number;
}

interface FoldMeta { blocks: Array<[number, number]>; rules?: FoldRule[]; settled?: number[] }

/** The rule widget dispatches this on itself; the Open view listens for it and expands the run. */
export const FOLD_RULE_EVENT = 'proof:fold-rule-expand';

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
        const settled = new Set(meta.settled ?? []);
        const rules = new Map<number, FoldRule>();
        for (const rule of meta.rules ?? []) rules.set(rule.at, rule);
        let pos = 0;
        for (let i = 0; i < doc.childCount; i += 1) {
          const child = doc.child(i);
          const rule = rules.get(i);
          if (rule) decorations.push(Decoration.widget(pos, () => ruleWidget(rule), { side: -1, pfold: 'rule', key: `rule-${rule.from}-${rule.to}-${rule.label}` }));
          if (hide.has(i)) decorations.push(Decoration.node(pos, pos + child.nodeSize, { class: 'pfold-hidden' }, { pfold: 'hidden' }));
          else if (headings.has(i)) decorations.push(Decoration.node(pos, pos + child.nodeSize, { class: 'pfold-folded-heading' }, { pfold: 'heading' }));
          // A settled row stays in place, greyed and struck through, until the reader clears it.
          if (settled.has(i)) decorations.push(Decoration.node(pos, pos + child.nodeSize, { class: 'aov-settled' }, { pfold: 'settled' }));
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
export function setHiddenBlocks(view: EditorView, blocks: Array<[number, number]>, extra: { rules?: FoldRule[]; settled?: number[] } = {}): void {
  const tr = view.state.tr
    .setMeta(foldViewKey, { blocks, rules: extra.rules ?? [], settled: extra.settled ?? [] } satisfies FoldMeta)
    .setMeta('addToHistory', false);
  view.dispatch(tr);
}

/** The thin rule a collapsed run of settled lines shows. Clicking it expands exactly that run. */
function ruleWidget(rule: FoldRule): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'aov-rule';
  button.dataset.from = String(rule.from);
  button.dataset.to = String(rule.to);
  button.setAttribute('aria-label', `Show ${rule.label}`);
  button.title = `Show ${rule.label}`;
  const line = document.createElement('span');
  line.className = 'aov-rule-line';
  line.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'aov-rule-label';
  label.textContent = rule.label;
  button.append(line, label);
  // The press must not move the caret into the text or end the reader's writing.
  button.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    button.dispatchEvent(new CustomEvent(FOLD_RULE_EVENT, { detail: { from: rule.from, to: rule.to }, bubbles: true }));
  });
  return button;
}
