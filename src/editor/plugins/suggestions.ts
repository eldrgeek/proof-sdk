/**
 * Suggestions Plugin for Milkdown
 *
 * Converts edits into proofSuggestion marks + PROOF metadata
 * when suggestions mode is enabled.
 */

import { $ctx, $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state';

import {
  marksPluginKey,
  proofMarkActionMeta,
  buildSuggestionMetadata,
  getMarks,
  stampSuggestionMetadataOnDocument,
  reject,
  getMarkMetadataWithQuotes,
} from './marks';
import { generateMarkId, type InsertData, type MarkRange } from '../../formats/marks';
import { EDIT_SESSION_POLICY } from '../../shared/edit-session';
import { suggestionWithStatus, isPendingSuggestion } from '../../shared/suggestion-status';
import { Mapping, ReplaceStep } from '@milkdown/kit/prose/transform';
import type { EditorView } from '@milkdown/kit/prose/view';
import { getCurrentActor } from '../actor';

// Suggestion state
export interface SuggestionState {
  enabled: boolean;
}

// Plugin key for accessing state
export const suggestionsPluginKey = new PluginKey<SuggestionState>('suggestions');

// Context to store suggestion state
export const suggestionsCtx = $ctx<SuggestionState, 'suggestions'>({ enabled: false }, 'suggestions');

type SuggestionKind = 'insert' | 'delete' | 'replace';

type SliceNode = {
  type?: string;
  text?: string;
  content?: SliceNode[];
};

const COALESCE_WINDOW_MS = 750;

type InsertCoalesceState = { id: string; from: number; to: number; by: string; updatedAt: number };

const lastInsertByActor = new Map<string, InsertCoalesceState>();

function getCoalescableInsertCandidate(
  state: EditorState,
  pos: number,
  by: string,
  now: number
): { id: string; range: MarkRange; direction: 'append' | 'prepend' } | null {
  const cached = lastInsertByActor.get(by);
  if (!cached) return null;
  if (now - cached.updatedAt > COALESCE_WINDOW_MS) {
    lastInsertByActor.delete(by);
    return null;
  }

  const marks = getMarks(state);
  const match = marks.find(mark => mark.id === cached.id && mark.kind === 'insert' && mark.by === by);
  if (!match || !match.range) {
    lastInsertByActor.delete(by);
    return null;
  }

  const data = match.data as InsertData | undefined;
  if (data?.status && data.status !== 'pending') {
    lastInsertByActor.delete(by);
    return null;
  }

  if (match.range.to === pos) {
    return { id: match.id, range: match.range, direction: 'append' };
  }

  if (match.range.from === pos) {
    return { id: match.id, range: match.range, direction: 'prepend' };
  }

  return null;
}

function collectSliceText(nodes?: SliceNode[]): { text: string; hasNonText: boolean } {
  let text = '';
  let hasNonText = false;

  if (!nodes) return { text, hasNonText };

  for (const node of nodes) {
    if (node.text) {
      text += node.text;
    }
    if (node.type && node.type !== 'text') {
      hasNonText = true;
    }
    if (node.content) {
      const child = collectSliceText(node.content);
      text += child.text;
      if (child.hasNonText) hasNonText = true;
    }
  }

  return { text, hasNonText };
}

/**
 * Wrap a transaction to convert edits to suggestions when enabled.
 * This intercepts the transaction and converts direct edits into tracked changes:
 * - Insertions get marked with proofSuggestion kind=insert
 * - Deletions get marked with proofSuggestion kind=delete instead of being removed
 * - Replacements become proofSuggestion kind=replace with content stored in metadata
 */
/** The interceptor captures these through the same decision history as Reject. */
export const clickEditDecisionsMeta = 'proofClickEditDecisions';
export function rejectionTransaction(state: EditorState, id: string): Transaction | null {
  let result: Transaction | null = null;
  const preview = { state, dispatch(tr: Transaction) { result = tr; } } as EditorView;
  // The very same Reject implementation, without side effects during preparation.
  if (!reject(preview, id, true, true)) return null;
  result!.setMeta(clickEditDecisionsMeta, [id]);
  return result;
}

export function wrapTransactionForSuggestions(tr: Transaction, state: EditorState, enabled: boolean): Transaction {
  if (!enabled || !tr.docChanged || tr.getMeta('y-sync$') || tr.getMeta(marksPluginKey) !== undefined
    || tr.getMeta(proofMarkActionMeta) !== undefined) return tr;
  const type = state.schema.marks.proofSuggestion;
  if (!type) return tr;
  const actor = getCurrentActor();
  let metadata = getMarkMetadataWithQuotes(state);
  let out = state.tr;
  const decisions = new Set<string>();
  const originalMapping = new Mapping();
  const anchoredBefore = new Set<string>();
  state.doc.descendants(node => { for (const mark of node.marks) if (mark.type === type) anchoredBefore.add(mark.attrs.id); });
  const currentState = () => state.apply(out.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata }));
  const rejectOne = (id: string) => {
    const rejected = rejectionTransaction(currentState(), id);
    if (!rejected) return false;
    for (const step of rejected.steps) out.step(step);
    metadata = rejected.getMeta(marksPluginKey).metadata;
    decisions.add(id);
    return true;
  };
  const add = (kind: SuggestionKind, from: number, to: number, content: string | null) => {
    const id = generateMarkId();
    out.addMark(from, to, type.create({ id, kind, by: actor }));
    metadata[id] = buildSuggestionMetadata(kind, actor, content);
    return id;
  };
  const refreshInserts = () => {
    const runs = new Map<string, string>();
    const ends = new Map<string, number>();
    out.doc.descendants((node, pos) => {
      if (!node.isText) return;
      for (const mark of node.marks) if (mark.type === type && mark.attrs.kind === 'insert') {
        const end = ends.get(mark.attrs.id);
        const separator = end !== undefined && !out.doc.resolve(end).sameParent(out.doc.resolve(pos)) ? '\n' : '';
        runs.set(mark.attrs.id, (runs.get(mark.attrs.id) ?? '') + separator + node.text);
        ends.set(mark.attrs.id, pos + node.nodeSize);
      }
    });
    for (const [id, text] of runs) if (isPendingSuggestion(metadata[id])) metadata[id] = { ...metadata[id], content: text };
  };

  for (const step of tr.steps) {
    const json = step.toJSON();
    // Map from this input step's document to our tracked-change document. Kept deletions
    // occupy space only in ours; an offset based on inserted/deleted lengths cannot do this.
    const mapping = originalMapping.invert();
    mapping.appendMapping(out.mapping);
    const from = typeof json.from === 'number' ? mapping.map(json.from, 1) : 0;
    const to = json.from === json.to ? from : typeof json.to === 'number' ? mapping.map(json.to, -1) : from;
    const { text: inlineText, hasNonText } = collectSliceText(json.slice?.content);
    const text = hasNonText && step instanceof ReplaceStep
      ? step.slice.content.textBetween(0, step.slice.content.size, '\n') : inlineText;
    if (json.stepType !== 'replace' || (from === to && !text)) {
      // Keep formatting and empty paragraph-boundary operations in the engine's native
      // path. Pasted words (including multiple paragraphs) take the tracked text path.
      const mapped = step.map(mapping);
      if (mapped) out.step(mapped);
      originalMapping.appendMap(step.getMap());
      continue;
    }
    const marks = getMarks(currentState()).filter(m => isPendingSuggestion(metadata[m.id]) && m.range);
    const containing = marks.find(m => m.kind === 'insert' && m.range!.from <= from && m.range!.to >= to
      && (from < to || (m.range!.from < from && from < m.range!.to)));
    if (containing && text && containing.by === actor) {
      out.insertText(text, from, to);
      out.addMark(from, from + text.length, type.create({ id: containing.id, kind: 'insert', by: actor }));
    } else if (from === to && text) {
      const candidate = getCoalescableInsertCandidate(currentState(), from, actor, Date.now());
      out.insertText(text, from);
      const id = candidate?.id ?? add('insert', from, from + text.length, text);
      if (candidate) out.addMark(from, from + text.length, type.create({ id, kind: 'insert', by: actor }));
      lastInsertByActor.set(actor, { id, from, to: from + text.length, by: actor, updatedAt: Date.now() });
    } else if (from < to && !text) {
      lastInsertByActor.delete(actor);
      const complete = marks.filter(m => m.range!.from >= from && m.range!.to <= to
        && (m.kind === 'insert' || m.kind === 'replace')
        && (m.by === actor ? EDIT_SESSION_POLICY.withdrawOwnInsert : EDIT_SESSION_POLICY.deleteProposalRejects));
      // Work right to left. Agreed text is struck through; deleting inserted words actually
      // removes those words. A complete proposal uses Reject and keeps its decision record.
      const segments: Array<{ from: number; to: number; id?: string; kind?: string }> = [];
      out.doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isText) return;
        const mark = node.marks.find(m => m.type === type && isPendingSuggestion(metadata[m.attrs.id]));
        segments.push({ from: Math.max(from, pos), to: Math.min(to, pos + node.nodeSize), id: mark?.attrs.id, kind: mark?.attrs.kind });
      });
      const segmentMappingStart = out.mapping.maps.length;
      const handled = new Set<string>();
      let deletionId: string | undefined;
      for (const segment of segments.reverse()) {
        const segmentMapping = out.mapping.slice(segmentMappingStart);
        const segmentFrom = segmentMapping.map(segment.from, 1);
        const segmentTo = segmentMapping.map(segment.to, -1);
        if (segment.id && complete.some(m => m.id === segment.id)) {
          if (!handled.has(segment.id)) { rejectOne(segment.id); handled.add(segment.id); }
        } else if (segment.kind === 'insert') out.delete(segmentFrom, segmentTo);
        else if (!segment.kind) {
          if (!deletionId) deletionId = add('delete', segmentFrom, segmentTo, null);
          else out.addMark(segmentFrom, segmentTo, type.create({ id: deletionId, kind: 'delete', by: actor }));
        }
        // Already struck-through originals remain until an explicit decision. Backspace
        // must neither accept a pending deletion nor erase a replacement's original.
      }
      // A forward Delete moves past the retained strike so the next Delete reaches
      // the next character. Backspace and range deletion keep the start position.
      const forward = state.selection.empty && state.selection.head <= json.from;
      const caret = out.mapping.slice(segmentMappingStart).map(forward ? to : from, forward ? -1 : 1);
      out.setSelection(TextSelection.near(out.doc.resolve(Math.min(caret, out.doc.content.size))));
    } else if (from < to && text) {
      lastInsertByActor.delete(actor);
      if (containing && !EDIT_SESSION_POLICY.editOtherProposalsInPlace) {
        // Rollback policy for P2 ownership transfer: the engine makes a new insertion by
        // the editor. The untouched part of the first insertion keeps its author and id.
        out.insertText(text, from, to);
        out.removeMark(from, from + text.length, type);
        add('insert', from, from + text.length, text);
      } else {
        // A replacement's original stays anchored; its new words live in content metadata.
        // Do not strip overlapping proposals: they remain independently reviewable.
        add('replace', from, to, text);
        out.setSelection(TextSelection.near(out.doc.resolve(to)));
      }
    }
    refreshInserts();
    originalMapping.appendMap(step.getMap());
  }
  // Every explicit edit that consumes a pending anchor records an end, including structural
  // paste/joins and the legacy competing-insert path. Passive snapshots never run this code.
  const surviving = new Set<string>();
  out.doc.descendants(node => { for (const mark of node.marks) if (mark.type === type) surviving.add(mark.attrs.id); });
  for (const id of anchoredBefore) {
    if (!isPendingSuggestion(metadata[id]) || surviving.has(id)) continue;
    metadata[id] = suggestionWithStatus(metadata[id], 'rejected', actor);
    decisions.add(id);
  }
  refreshInserts();
  out = stampSuggestionMetadataOnDocument(state, out, metadata);
  out.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata });
  out.setMeta('suggestions-wrapped', true);
  if (decisions.size) out.setMeta(clickEditDecisionsMeta, [...decisions]);
  // Only explicit typing asks the browser to follow its caret; remote changes do not.
  if (tr.scrolledIntoView) out.scrollIntoView();
  return out;
}

/**
 * Check if suggestions are enabled
 */
export function isSuggestionsEnabled(state: EditorState): boolean {
  const pluginState = suggestionsPluginKey.getState(state);
  return pluginState?.enabled ?? false;
}

/**
 * Enable suggestions
 */
export function enableSuggestions(view: { state: EditorState; dispatch: (tr: Transaction) => void }): void {
  const tr = view.state.tr.setMeta(suggestionsPluginKey, { enabled: true });
  view.dispatch(tr);
}

/**
 * Disable suggestions
 */
export function disableSuggestions(view: { state: EditorState; dispatch: (tr: Transaction) => void }): void {
  const tr = view.state.tr.setMeta(suggestionsPluginKey, { enabled: false });
  view.dispatch(tr);
}

/**
 * Toggle suggestions
 */
export function toggleSuggestions(view: { state: EditorState; dispatch: (tr: Transaction) => void }): boolean {
  const enabled = isSuggestionsEnabled(view.state);
  if (enabled) {
    disableSuggestions(view);
  } else {
    enableSuggestions(view);
  }
  return !enabled;
}

/**
 * Create the suggestions plugin
 */
export const suggestionsPlugin = $prose(() => {
  return new Plugin<SuggestionState>({
    key: suggestionsPluginKey,

    state: {
      init(): SuggestionState {
        return { enabled: false };
      },

      apply(tr, value): SuggestionState {
        const meta = tr.getMeta(suggestionsPluginKey);
        if (meta !== undefined) {
          return { ...value, ...meta };
        }
        return value;
      },
    },

    appendTransaction(_trs, oldState, newState) {
      const wasEnabled = suggestionsPluginKey.getState(oldState)?.enabled ?? false;
      const isEnabled = suggestionsPluginKey.getState(newState)?.enabled ?? false;
      if (wasEnabled !== isEnabled) {
        // Emit bridge message on next microtask to avoid dispatch-in-dispatch
        queueMicrotask(() => {
          (window as any).proof?.bridge?.sendMessage('suggestionsChanged', { enabled: isEnabled });
        });
      }
      return null;
    },
  });
});

/**
 * Export all for use in editor
 */
export const suggestionsPlugins = [suggestionsCtx, suggestionsPlugin];
