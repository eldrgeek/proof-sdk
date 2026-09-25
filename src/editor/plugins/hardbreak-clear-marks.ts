/**
 * Milkdown's hardbreakClearMarkPlugin (@milkdown/preset-commonmark 7.22.2), with one change: it
 * appends nothing when it has nothing to change.
 *
 * The original returns a transaction after EVERY transaction whose first step adds a mark, empty
 * when the range holds no hard break. Any appended transaction resets y-prosemirror's flags for
 * the whole dispatch (addToHistory, isChangeOrigin come from the last transaction applied), so the
 * page's own stamping of the server's marks was synced to Yjs as a local, recorded change. Every
 * marks update from the server could leave an invisible Undo step, and Cmd+Z spent itself on it.
 * Found in the Accord step 4 review, 2026-09-25 (discussions-check: "Second Undo did not undo the
 * typing run"), by logging the undo manager's stack events and the appended transactions.
 */
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { AddMarkStep, ReplaceStep } from '@milkdown/kit/prose/transform';
import { hardbreakSchema } from '@milkdown/preset-commonmark';

export const hardbreakClearMarksPlugin = $prose((ctx) => new Plugin({
  key: new PluginKey('ACCORD_HARDBREAK_MARKS'),
  appendTransaction: (trs, _oldState, newState) => {
    const [tr] = trs;
    if (!tr) return null;
    const [step] = tr.steps;
    const hardbreak = hardbreakSchema.type(ctx);
    if (tr.getMeta('hardbreak')) {
      if (!(step instanceof ReplaceStep)) return null;
      return newState.tr.setNodeMarkup(step.from, hardbreak, undefined, []);
    }
    if (!(step instanceof AddMarkStep)) return null;
    let out = newState.tr;
    newState.doc.nodesBetween(step.from, step.to, (node, pos) => {
      if (node.type === hardbreak && node.marks.length) out = out.setNodeMarkup(pos, hardbreak, undefined, []);
    });
    return out.steps.length ? out : null;
  },
}));
