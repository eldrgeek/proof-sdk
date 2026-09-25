/** Position-based, view-only folding. Mike, 2026-09-24, yfbqrau4 point 9. */
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, TextSelection, type Transaction } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import type { Node } from '@milkdown/kit/prose/model';
import { extractLines } from '../../shared/line-marks';
import { computeSections } from '../../shared/folding';
import { FOLDED_VIEW_POLICY, hiddenRuns, mapShown, remapByContent, structuralPaths, withPaths, touchesHidden, type HiddenRun } from '../../shared/folded-view';
import { ySyncPluginKey } from 'y-prosemirror';

export interface FoldState {
  ready: boolean;
  whole: boolean;
  clean: boolean;
  shown: Set<number>;
  expanded: Set<number>;
  context: Set<number>;
  open: Set<number>;
  visible: Set<number>;
  hidden: Array<{ from: number; to: number }>;
  runs: HiddenRun[];
  decorations: DecorationSet;
}
export type FoldUpdate = Partial<Pick<FoldState, 'ready' | 'whole' | 'clean' | 'shown' | 'expanded' | 'context' | 'open'>>;
export const foldViewKey = new PluginKey<FoldState>('proofFoldView');
export const FOLD_RULE_EVENT = 'proof:fold-rule-expand';
export const FOLD_NOTICE_EVENT = 'proof:fold-notice';
export const FOLD_USER_EDIT = 'proofFoldUserEdit';

function build(doc: Node, state: FoldState): FoldState {
  const lines = extractLines(doc);
  const visible = new Set([...state.shown, ...state.context]);
  for (const s of computeSections(lines)) if (state.expanded.has(lines[s.headingIndex].pos)) {
    for (let i = s.headingIndex; i < s.lineEnd; i++) visible.add(lines[i].pos);
  }
  state.visible = withPaths(lines, visible, structuralPaths(doc, lines));
  state.hidden = [];
  state.runs = [];
  const decorations: Decoration[] = [];
  if (state.whole || state.clean) { state.decorations = DecorationSet.empty; return state; }
  if (!state.ready) {
    doc.forEach((node, pos) => decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'pfold-hidden' })));
    state.decorations = DecorationSet.create(doc, decorations);
    return state;
  }
  const visit = (node: Node, start: number) => {
    node.forEach((child, offset, index) => {
      const pos = start + offset, end = pos + child.nodeSize;
      const items = lines.filter(l => l.pos >= pos && l.pos < end);
      const hasShown = [...state.visible].some(p => p >= pos && p < end);
      if ((items.length || (!FOLDED_VIEW_POLICY.showEmptyBlocks && child.isTextblock)) && !hasShown) {
        state.hidden.push({ from: pos, to: end });
        decorations.push(Decoration.node(pos, end, { class: 'pfold-hidden' }, { pfold: 'hidden' }));
      } else if (child.childCount && !child.isTextblock && child.type.name !== 'table_row') visit(child, pos + 1);
      if (FOLDED_VIEW_POLICY.preserveListNumbers && node.type.name === 'ordered_list' && child.type.name === 'list_item') {
        decorations.push(Decoration.node(pos, end, { value: String(Number(node.attrs.order ?? node.attrs.start ?? 1) + index) }));
      }
    });
  };
  visit(doc, 0);
  const openIndices = new Set(lines.filter(l => state.open.has(l.pos)).map(l => l.index));
  state.runs = hiddenRuns(lines, state.visible, openIndices);
  for (const run of state.runs) {
    const container = state.hidden.find(h => run.pos >= h.from && run.pos < h.to);
    const pos = container?.from ?? run.pos;
    const parent = doc.resolve(pos).parent;
    decorations.push(Decoration.widget(pos, () => ruleWidget(run, parent), {
      side: -1, pfold: 'rule', key: `rule-${run.from}-${run.to}-${run.label}`, stopEvent: () => true,
    }));
  }
  state.decorations = DecorationSet.create(doc, decorations);
  return state;
}

export function emptyFoldState(): FoldState {
  return { ready: false, whole: false, clean: false, shown: new Set(), expanded: new Set(), context: new Set(), open: new Set(), visible: new Set(), hidden: [], runs: [], decorations: DecorationSet.empty };
}

export function applyFoldTransaction(tr: Transaction, previous: FoldState): FoldState {
  const state = { ...previous };
  if (tr.docChanged) {
    const before = extractLines(tr.before), after = extractLines(tr.doc);
    const created: Array<{ from: number; to: number }> = [];
    if (tr.getMeta(FOLD_USER_EDIT)) {
      tr.mapping.maps.forEach((map, i) => map.forEach((_a, _b, from, to) => {
        const rest = tr.mapping.slice(i + 1);
        created.push({ from: rest.map(from, -1), to: rest.map(to, 1) });
      }));
      // Enter leaves an empty textblock, which extractLines deliberately omits.
      if (tr.selection.$head.parent.isTextblock) created.push({ from: tr.selection.$head.before(), to: tr.selection.$head.after() });
    }
    // A Yjs-origin transaction (remote change, Undo, Redo) replaces the whole document, so its
    // mapping loses every position: re-find them by content (remapByContent).
    const whole = (tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin === true;
    const remap = (positions: ReadonlySet<number>, made: typeof created = []) => whole
      ? remapByContent(positions, tr.before, tr.doc)
      : mapShown(positions, before, after, tr.mapping, made);
    state.shown = remap(state.shown, created);
    for (const range of created) state.shown.add(range.from);
    state.expanded = remap(state.expanded);
    state.context = remap(state.context);
    state.open = remap(state.open);
  }
  Object.assign(state, tr.getMeta(foldViewKey) as FoldUpdate | undefined);
  return build(tr.doc, state);
}

export const foldViewPlugin = $prose(() => new Plugin<FoldState>({
  key: foldViewKey,
  state: { init: (_, state) => build(state.doc, { ...emptyFoldState(), whole: typeof location !== 'undefined' && !location.pathname.startsWith('/d/') }), apply: applyFoldTransaction },
  appendTransaction(_transactions, old, state) {
    const fold = foldViewKey.getState(state);
    if (!fold?.ready || fold.whole || fold.clean || !(state.selection instanceof TextSelection)) return null;
    const pos = state.selection.head;
    if (!fold.hidden.some(h => pos >= h.from && pos < h.to)) return null;
    const candidates = extractLines(state.doc).filter(l => fold.visible.has(l.pos));
    const direction = pos > old.selection.head ? 1 : -1;
    const next = direction > 0 ? candidates.find(l => l.pos > pos) ?? candidates.at(-1)
      : candidates.filter(l => l.pos < pos).at(-1) ?? candidates[0];
    if (!next) return null;
    const target = TextSelection.near(state.doc.resolve(direction > 0 ? next.pos + 1 : next.pos + next.nodeSize - 1), direction).head;
    const anchorHidden = fold.hidden.some(h => state.selection.anchor >= h.from && state.selection.anchor < h.to);
    const anchor = state.selection.empty || anchorHidden ? target : state.selection.anchor;
    return state.tr.setSelection(TextSelection.create(state.doc, anchor, target)).setMeta('addToHistory', false);
  },
  props: {
    decorations: state => foldViewKey.getState(state)?.decorations ?? DecorationSet.empty,
    editable: state => {
      const fold = foldViewKey.getState(state);
      return !fold || fold.whole || fold.clean || (fold.ready && (fold.visible.size > 0 || extractLines(state.doc).length === 0));
    },
  },
}));

export function setFoldView(view: EditorView, update: FoldUpdate): void {
  view.dispatch(view.state.tr.setMeta(foldViewKey, update).setMeta('addToHistory', false));
}
export function hiddenBlocks(view: EditorView): number[] {
  const hidden = foldViewKey.getState(view.state)?.hidden ?? [];
  const result: number[] = [];
  view.state.doc.forEach((_node, pos, index) => { if (hidden.some(h => h.from === pos)) result.push(index); });
  return result;
}

/** Test each step against hidden intervals in that step's input coordinates. */
export function transactionTouchesHidden(tr: Transaction, hidden: FoldState['hidden']): boolean {
  let ranges = hidden;
  for (const step of tr.steps) {
    const map = step.getMap();
    let touched = false;
    map.forEach((from, to) => { if (touchesHidden(from, to, ranges)) touched = true; });
    // Mark-only steps have empty maps but can still alter a selected hidden passage.
    const span = step as unknown as { from?: number; to?: number };
    if (typeof span.from === 'number' && typeof span.to === 'number' && touchesHidden(span.from, span.to, ranges)) touched = true;
    if (touched) return true;
    ranges = ranges.map(h => ({ from: map.map(h.from, 1), to: map.map(h.to, -1) }));
  }
  return false;
}

function ruleWidget(rule: HiddenRun, parent: Node): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'aov-rule'; button.contentEditable = 'false';
  button.style.setProperty('--fold-rule-target', `${FOLDED_VIEW_POLICY.phoneRuleTargetPx}px`);
  button.dataset.from = String(rule.from); button.dataset.to = String(rule.to);
  button.setAttribute('aria-label', `Show ${rule.label}`);
  const line = document.createElement('span'); line.className = 'aov-rule-line'; line.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span'); label.className = 'aov-rule-label'; label.textContent = rule.label;
  button.append(line, label);
  button.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation();
    button.dispatchEvent(new CustomEvent(FOLD_RULE_EVENT, { detail: { from: rule.from, to: rule.to }, bubbles: true }));
  });
  // A widget is valid HTML in its container, including between rows or list entries.
  if (parent.type.name === 'table') {
    const row = document.createElement('tr'), cell = document.createElement('td');
    row.className = 'aov-rule-row'; cell.colSpan = parent.firstChild?.childCount ?? 1; cell.append(button); row.append(cell); return row;
  }
  if (parent.type.name === 'ordered_list' || parent.type.name === 'bullet_list') {
    const entry = document.createElement('li'); entry.className = 'aov-rule-entry'; entry.append(button); return entry;
  }
  return button;
}
