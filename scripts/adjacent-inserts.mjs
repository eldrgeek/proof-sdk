// Joins pending insert proposals that sit back to back, so a phrase typed with a pause in the
// middle (a loaded machine can stall a keystroke for over a second, and the editor then starts a
// new proposal) still reads as the words that were typed. Written for bead ac-pa2.
//
// Each proposal is { content, range: { from, to } }. Two proposals join when one ends exactly
// where the next begins. Returns one string per run, in document order.
export function adjacentInsertRuns(proposals) {
  const sorted = (proposals || [])
    .filter(p => typeof p?.content === 'string' && Number.isFinite(p?.range?.from) && Number.isFinite(p?.range?.to))
    .slice()
    .sort((a, b) => a.range.from - b.range.from);
  const runs = [];
  let end = null;
  for (const p of sorted) {
    if (runs.length && end === p.range.from) runs[runs.length - 1] += p.content;
    else runs.push(p.content);
    end = p.range.to;
  }
  return runs;
}
