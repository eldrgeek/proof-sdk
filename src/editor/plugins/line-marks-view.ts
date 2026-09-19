/**
 * Proof Documents Step 1: tells the line-marks UI when the editor view changes, and records
 * which lines the local user edits so their own mark can follow the new text
 * (LINE_MARK_POLICY.changerKeepsMark). Adds no decorations and never changes the document.
 *
 * Authorship: Claude Opus 5 (worker proof-line-marks), 2026-09-18.
 */
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { ySyncPluginKey } from 'y-prosemirror';
import { extractLines, type DocLine, type LineSourceNode } from '../../shared/line-marks';

/**
 * A line the local user changed. Tracked by content, not position: `hash` is the line's text
 * before the first local edit, `currentHash` its text after the latest one. Positions are not
 * reliable here, because collab and mark bookkeeping replace ranges around typed text.
 */
export interface LocalLineEdit {
  hash: string;
  occurrence: number;
  currentHash: string;
  at: number;
}

export interface LineMarksViewListener {
  update(view: EditorView, prevState: EditorState | null): void;
  destroy?(): void;
}

let listener: LineMarksViewListener | null = null;
let currentView: EditorView | null = null;
let pendingLocalEdits: LocalLineEdit[] = [];

export function setLineMarksViewListener(next: LineMarksViewListener | null): void {
  listener = next;
  if (next && currentView) next.update(currentView, null);
}

export function takePendingLocalLineEdits(): LocalLineEdit[] {
  const edits = pendingLocalEdits;
  pendingLocalEdits = [];
  return edits;
}

export function peekPendingLocalLineEdits(): readonly LocalLineEdit[] {
  return pendingLocalEdits;
}

function isRemote(tr: Transaction): boolean {
  const meta = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
  return Boolean(meta?.isChangeOrigin) || tr.getMeta('proofRemoteChange') === true;
}

function lineAfter(tr: Transaction, line: DocLine, newLines: DocLine[]): DocLine | undefined {
  // The node boundary before the line survives typing inside it; assoc 1 steps over a block
  // inserted at that same position.
  const start = tr.mapping.map(line.pos, 1);
  return newLines.find(candidate => candidate.pos === start)
    ?? newLines.find(candidate => candidate.pos < start + 1 && start + 1 < candidate.pos + candidate.nodeSize);
}

function recordLocalEdit(tr: Transaction, oldState: EditorState, newState: EditorState): void {
  const oldLines = extractLines(oldState.doc as unknown as LineSourceNode);
  if (oldLines.length === 0) return;
  const newLines = extractLines(newState.doc as unknown as LineSourceNode);
  const touched = new Set<number>();
  tr.mapping.maps.forEach((map, index) => {
    // Ranges are in the coordinates of the doc before step `index`; map them back to oldState.
    const back = tr.mapping.slice(0, index).invert();
    map.forEach((oldStart, oldEnd) => {
      const from = back.map(oldStart, -1);
      const to = back.map(oldEnd, 1);
      for (const line of oldLines) {
        if (line.pos <= to && line.pos + line.nodeSize >= from) touched.add(line.index);
      }
    });
  });
  const now = Date.now();
  for (const index of touched) {
    const line = oldLines[index];
    const after = lineAfter(tr, line, newLines);
    // Only a change to the line's own text counts (a comment anchor changes marks, not text).
    if (!after || after.hash === line.hash) continue;
    const chained = pendingLocalEdits.find(edit => edit.currentHash === line.hash);
    if (chained) {
      chained.currentHash = after.hash;
      chained.at = now;
    } else {
      pendingLocalEdits.push({ hash: line.hash, occurrence: line.occurrence, currentHash: after.hash, at: now });
    }
  }
  if (pendingLocalEdits.length > 200) pendingLocalEdits = pendingLocalEdits.slice(-200);
}

const lineMarksViewKey = new PluginKey('proofLineMarksView');

export const lineMarksViewPlugin = $prose(() => new Plugin({
  key: lineMarksViewKey,
  state: {
    init: () => 0,
    apply(tr, value, oldState, newState) {
      if (!tr.docChanged) return value;
      if (!isRemote(tr)) {
        try {
          recordLocalEdit(tr, oldState, newState);
        } catch (error) {
          if ((globalThis as { __plmDebug?: boolean }).__plmDebug) console.warn('[plm] recordLocalEdit failed', error);
        }
      }
      return value + 1;
    },
  },
  view(view) {
    currentView = view;
    listener?.update(view, null);
    return {
      update(nextView, prevState) {
        currentView = nextView;
        listener?.update(nextView, prevState);
      },
      destroy() {
        if (currentView === view) currentView = null;
        listener?.destroy?.();
      },
    };
  },
}));
