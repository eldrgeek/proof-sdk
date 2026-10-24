// Waiting on Mike (ttq18nc1): buildLineStates must match the pre-optimization resolver on real data.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  actorKey,
  anchorText,
  buildLineStates,
  findCarryTarget,
  findLapseTarget,
  resolveLineAnchor,
  type LineMark,
  type LineState,
} from '../shared/line-marks';
import { computeServerLines } from '../../server/line-marks';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/wom-ttq18nc1');

const doc = JSON.parse(readFileSync(path.join(fixtureDir, 'wom-doc.json'), 'utf8')) as { markdown: string };
const marks = (JSON.parse(readFileSync(path.join(fixtureDir, 'lm-ttq18nc1.json'), 'utf8')) as { lineMarks: LineMark[] }).lineMarks;

function serializeStates(states: LineState[]): string {
  return JSON.stringify(states.map(state => ({
    line: state.line.index,
    marks: [...state.marks.entries()].map(([actor, entry]) => ({
      actor,
      id: entry.mark.id,
      status: entry.mark.status,
      current: entry.current,
      carried: entry.carried ?? false,
      lapsed: entry.lapsed ?? false,
    })),
  })));
}

/** Reference resolver: always runs the lapse search (no skim skip). */
function buildLineStatesReference(lines: Awaited<ReturnType<typeof computeServerLines>>, lineMarks: LineMark[]): LineState[] {
  const states: LineState[] = lines.map(line => ({ line, marks: new Map() }));
  const cache = new Map<string, boolean>();
  for (const mark of lineMarks) {
    if (!mark?.anchor) continue;
    let resolved = resolveLineAnchor(lines, mark.anchor);
    if (!resolved || !resolved.current) {
      const target = findCarryTarget(lines, mark.anchor, cache);
      if (target) resolved = { lineIndex: target.index, current: true, carried: true };
      else {
        const lapse = findLapseTarget(lines, mark.anchor);
        if (lapse) resolved = { lineIndex: lapse.index, current: false, lapsed: true };
      }
    }
    if (!resolved) continue;
    if (!resolved.current && mark.status === 'skimmed') continue;
    if (!resolved.current && !resolved.lapsed && !['agreed', 'approved', 'rejected'].includes(mark.status)) continue;
    const state = states[resolved.lineIndex];
    const key = actorKey(mark.by);
    const existing = state.marks.get(key);
    const candidate = resolved.carried
      ? { mark, current: true, carried: true, carriedFrom: anchorText(mark.anchor) ?? undefined }
      : resolved.lapsed
        ? { mark, current: false, lapsed: true, lapsedFrom: anchorText(mark.anchor) ?? undefined }
        : { mark, current: resolved.current };
    const rank = (entry: typeof candidate) => (entry.current ? (entry.carried ? 1 : 2) : 0);
    if (
      !existing
      || rank(candidate) > rank(existing)
      || (rank(candidate) === rank(existing) && String(mark.at) > String(existing.mark.at))
    ) {
      state.marks.set(key, candidate);
    }
  }
  return states;
}

const lines = await computeServerLines(doc.markdown);
const reference = serializeStates(buildLineStatesReference(lines, marks));
const optimized = serializeStates(buildLineStates(lines, marks));
assert.equal(optimized, reference, 'buildLineStates output must match the full lapse resolver on Waiting on Mike data');
console.log('✓ buildLineStates matches reference on ttq18nc1 fixtures');
