import assert from 'node:assert/strict';
import { pair } from './review-history-fixture';
import { comment, reply } from '../editor/plugins/marks';
let failed = 0;
for (const scenario of ['insert-delete', 'comment-reply']) {
  const p = await pair(); const a = p.alice;
  try {
    if (scenario === 'insert-delete') {
      a.edit(() => a.view.dispatch(a.view.state.tr.insertText('XY', 5)));
      a.native.stopCapturing();
      a.edit(() => a.view.dispatch(a.view.state.tr.delete(5, 7)));
    } else {
      let id = '';
      a.history.decide(() => { id = comment(a.view, 'Original', 'human:Alice', 'Comment', { from: 1, to: 9 }).id; });
      a.history.decide(() => { assert(reply(a.view, id, 'human:Alice', 'Reply')); });
    }
    assert(a.restore(), 'first undo');
    assert(a.restore(), 'second undo must follow the live redone links');
    for (const peer of [a, p.bob]) {
      assert.equal(peer.view.state.doc.textContent, 'OriginalSecond');
      assert.equal(peer.map.size, 0);
    }
    assert(a.restore(true)); assert(a.restore(true));
    console.log(`PASS ${scenario}`);
  } catch (e) { failed++; console.error(`FAIL ${scenario}: ${(e as Error).message}`); }
  finally { p.close(); }
}
process.exitCode = failed ? 1 : 0;
