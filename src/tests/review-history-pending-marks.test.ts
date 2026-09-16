import assert from 'node:assert/strict';
import { pair } from './review-history-fixture';
import { accept, comment, reply, suggestInsert, suggestReplace } from '../editor/plugins/marks';
import { wrapTransactionForSuggestions } from '../editor/plugins/suggestions';
import { setCurrentActor } from '../editor/actor';

let failures = 0;
for (const decision of ['insert', 'replace']) for (const redo of [false, true]) {
  for (const change of ['insert', 'delete', 'comment', 'reply', 'removed-comment', 'outside', 'unchanged']) {
    const label = `${decision} ${redo ? 'redo' : 'undo'} ${change}`;
    if (process.argv[2] && !label.includes(process.argv[2])) continue;
    const p = await pair(); const a = p.alice, b = p.bob;
    try {
      setCurrentActor('human:Alice');
      const suggestion = decision === 'insert'
        ? suggestInsert(a.view, 'Original', 'ai:Test', ' sentence', { from: 1, to: 9 })!
        : suggestReplace(a.view, 'Original', 'ai:Test', 'Changed', { from: 1, to: 9 })!;
      let existing = '';
      if (change === 'reply' || change === 'unchanged') {
        const from = decision === 'insert' ? 12 : a.view.state.doc.content.size - 7;
        const to = decision === 'insert' ? 13 : a.view.state.doc.content.size - 1;
        existing = comment(b.view, b.view.state.doc.textBetween(from, to), 'human:Bob', 'Keep', { from, to }).id;
      }
      // Start with exactly one decision, just as on a page receiving an API proposal.
      a.native.clear(); a.native.stopCapturing();
      a.history.decide(() => assert(accept(a.view, suggestion.id)));
      if (redo) assert(a.restore());
      // Pending insertion acceptance changes annotations only, not plain text.
      const at = decision === 'insert' ? 12 : 4;
      setCurrentActor('human:Bob');
      if (change === 'insert') b.edit(() => b.view.dispatch(wrapTransactionForSuggestions(b.view.state.tr.insertText('BOB', at), b.view.state, true)));
      if (change === 'delete') b.edit(() => b.view.dispatch(wrapTransactionForSuggestions(b.view.state.tr.delete(at, at + 1), b.view.state, true)));
      if (change === 'reply' && decision === 'insert') assert(reply(b.view, existing, 'human:Bob', 'Changed existing comment'));
      else if (['comment', 'removed-comment', 'reply'].includes(change)) {
        const quote = b.view.state.doc.textBetween(at, at + 1);
        const mark = comment(b.view, quote, 'human:Bob', 'New comment', { from: at, to: at + 1 });
        if (change === 'reply') assert(reply(b.view, mark.id, 'human:Bob', 'Changed again'));
        if (change === 'removed-comment') {
          const type = b.view.state.schema.marks.proofComment;
          b.view.dispatch(b.view.state.tr.removeMark(at, at + 1, type)); b.map.delete(mark.id);
        }
      }
      if (change === 'outside') comment(b.view, 'Second', 'human:Bob', 'Elsewhere');
      const snapshot = () => [a, b].map(peer => JSON.stringify([peer.view.state.doc.toJSON(), peer.map.toJSON(), peer.native.undoStack.length, peer.native.redoStack.length, peer.native.lastChange]));
      const before = snapshot();
      if (change === 'outside' || change === 'unchanged') assert(a.restore(redo), 'Unrelated or unchanged marks must not block history');
      else {
        assert.throws(() => a.restore(redo), new RegExp(`Can't ${redo ? 'redo' : 'undo'}: someone has changed this text since.`));
        assert.deepEqual(snapshot(), before, 'Refusal leaves both documents, records and stacks untouched');
      }
      if (existing) assert(b.map.has(existing));
      console.log(`PASS ${label}`);
    } catch (error) { failures++; console.error(`FAIL ${label}: ${(error as Error).message}`); }
    finally { p.close(); }
  }
}
setCurrentActor();
process.exitCode = failures ? 1 : 0;
