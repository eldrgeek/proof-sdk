import assert from 'node:assert/strict';
import { canJoin } from '@milkdown/kit/prose/transform';
import { pair, schema } from './review-history-fixture';
// Independent installed y-prosemirror manager is the oracle. Both configurations
// protect every container in this schema (the adapter extends the native filter).
import { defaultProtectedNodes } from 'y-prosemirror';
for (const name of Object.keys(schema.nodes)) if (!['doc', 'text'].includes(name)) defaultProtectedNodes.add(name);
let failed = 0;
const coverage = new Set<number>();
for (const connected of [false, true]) for (let seed = 1; seed <= 200; seed++) {
  const proof = await pair(false, connected), native = await pair(true, connected);
  let random = seed;
  const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random; };
  let step = 0;
  try {
    for (; step < 100; step++) {
      const op = next() % 7, choice = next(), grouped = next() % 3 === 0;
      coverage.add(op);
      for (const p of [proof, native]) {
        const a = p.alice;
        if (!grouped) a.native.stopCapturing();
        if (op >= 5) { a.restore(op === 6); }
        else {
          const blocks: Array<{ pos: number; size: number }> = [];
          a.view.state.doc.forEach((n: any, pos: number) => blocks.push({ pos, size: n.content.size }));
          // Leave the final paragraph for the second collaborator.
          const block = blocks[choice % Math.max(1, blocks.length - 1)];
          const at = block.pos + 1 + choice % (block.size + 1);
          a.edit(() => {
            let tr = a.view.state.tr;
            if (op === 0) tr = tr.insertText(String.fromCharCode(97 + choice % 26), at);
            if (op === 1 && block.size) tr = tr.delete(block.pos + 1 + choice % block.size, block.pos + 2 + choice % block.size);
            if (op === 2 && block.size) {
              const from = block.pos + 1, to = from + block.size;
              tr = choice % 2 ? tr.addMark(from, to, schema.marks.strong.create()) : tr.removeMark(from, to, schema.marks.strong);
            }
            if (op === 3) tr = tr.split(at);
            if (op === 4 && block.pos > 0 && canJoin(tr.doc, block.pos)) tr = tr.join(block.pos);
            a.view.dispatch(tr);
          });
        }
        if (connected && step % 7 === 0) p.bob.edit(() => p.bob.view.dispatch(p.bob.view.state.tr.insertText('B', p.bob.view.state.doc.content.size - 1)));
      }
      assert.deepEqual(proof.alice.view.state.doc.toJSON(), native.alice.view.state.doc.toJSON(), 'Alice document');
      assert.deepEqual(proof.bob.view.state.doc.toJSON(), native.bob.view.state.doc.toJSON(), 'Bob document');
      for (const who of ['alice', 'bob'] as const) {
        assert.equal(proof[who].native.undoStack.length, native[who].native.undoStack.length, `${who} undo depth`);
        assert.equal(proof[who].native.redoStack.length, native[who].native.redoStack.length, `${who} redo depth`);
      }
    }
  } catch (e) { failed++; console.error(`FAIL seed=${seed} step=${step} connected=${connected}: ${(e as Error).message}`); }
  finally { proof.close(); native.close(); }
}
assert.equal(coverage.size, 7);
console.log(`Differential seeds=1..200, alone+connected, 400 sequences x 100 steps: ${failed} failures`);
process.exitCode = failed ? 1 : 0;
