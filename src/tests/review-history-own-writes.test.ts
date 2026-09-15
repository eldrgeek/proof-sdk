import assert from 'node:assert/strict';
import { pair } from './review-history-fixture';
import { wrapTransactionForSuggestions } from '../editor/plugins/suggestions';
import { getMarkMetadataWithQuotes } from '../editor/plugins/marks';
let failures = 0;
for (const origin of ['local-marks-sync', 'unfamiliar-page-origin', null]) {
  const p = await pair(); const a = p.alice;
  try {
    a.edit(() => a.view.dispatch(wrapTransactionForSuggestions(a.view.state.tr.insertText('OWN', 9), a.view.state, true)));
    const id = [...a.map.keys()][0]; assert(id);
    const refresh = getMarkMetadataWithQuotes(a.view.state);
    // Production collab-client adds its relative anchors when publishing metadata.
    a.doc.transact(() => a.map.set(id, { ...refresh[id], range: { from: 9, to: 12 }, quote: 'OWN', startRel: 'own-start', endRel: 'own-end' }), origin);
    assert(a.restore(), 'Own page refresh must not block undo');
    for (const peer of [a, p.bob]) {
      assert(!peer.view.state.doc.textContent.includes('OWN'));
      assert(!peer.map.has(id));
    }
    assert(a.restore(true));
    // A remote transaction remains remote even if its origin resembles ours.
    p.bob.doc.transact(() => p.bob.map.set(id, { ...p.bob.map.get(id), replies: [{ by: 'human:Bob', text: 'Keep' }] }), origin);
    const before = JSON.stringify([a.map.toJSON(), a.view.state.doc.toJSON(), a.native.undoStack, a.native.redoStack], (k, v) => k === 'meta' ? [...v.values()].map(String) : v);
    assert.throws(() => a.restore(), /someone has replied/);
    assert.equal(JSON.stringify([a.map.toJSON(), a.view.state.doc.toJSON(), a.native.undoStack, a.native.redoStack], (k, v) => k === 'meta' ? [...v.values()].map(String) : v), before);
    console.log(`PASS own refresh and remote refusal (${origin})`);
  } catch (e) { failures++; console.error(`FAIL own refresh (${origin}): ${(e as Error).message}`); }
  finally { p.close(); }
}
process.exitCode = failures ? 1 : 0;
