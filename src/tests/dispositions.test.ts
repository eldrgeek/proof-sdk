/**
 * Accord — multi-party dispositions (src/shared/dispositions.ts).
 *
 * Mike, 2026-10-24: every participant has a draft, an accord and a cutting room; a proposal becomes
 * common only when everyone promoted it; AIs are equal participants; observers argue but do not
 * dispose; the Owner can overrule and the disagreement is recorded.
 */
import assert from 'node:assert/strict';
import {
  DISPOSITION_POLICY,
  dispositionRefusal,
  dispositionStatusText,
  summarizeForViewer,
  viewerPiles,
  stanceText,
  PILE_FILTER_POLICY,
  evaluateProposal,
  evaluateProposals,
  finalizeAction,
  isFullAccord,
  overrule,
  parseDisposition,
  personalPiles,
  pileOf,
  voters,
  whereWeDiffer,
  type DispositionRecord,
  type RosterEntry,
} from '../shared/dispositions';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

let clock = 0;
function at(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 9, 24, 12, 0, clock)).toISOString();
}
function rec(markId: string, by: string, disposition: DispositionRecord['disposition']): DispositionRecord {
  return { markId, by, disposition, at: at() };
}

const two: RosterEntry[] = [
  { actor: 'mike@example.com', role: 'owner' },
  { actor: 'ai:claude', role: 'participant' },
];
const many: RosterEntry[] = [
  { actor: 'mike@example.com', role: 'owner' },
  { actor: 'eric@example.com', role: 'participant' },
  { actor: 'ai:claude', role: 'participant' },
  { actor: 'ai:gemini', role: 'participant' },
  { actor: 'lea@example.com', role: 'observer' },
];

test('off by default: live Accords keep today\'s behaviour until a document opts in', () => {
  assert.equal(DISPOSITION_POLICY.multiPartyDefault, false);
});

test('the proposer\'s own proposal starts in their accord; everyone else has it in their draft', () => {
  const p = { markId: 'm1', by: 'ai:claude' };
  assert.equal(pileOf(p, 'ai:claude', []), 'accord');
  assert.equal(pileOf(p, 'mike@example.com', []), 'draft');
  const view = evaluateProposal(p, many, []);
  assert.equal(view.status, 'open');
  assert.deepEqual(view.openFor, ['mike@example.com', 'eric@example.com', 'ai:gemini']);
});

test('two parties: the other party\'s accept completes unanimity, as accepting does today', () => {
  const p = { markId: 'm1', by: 'ai:claude' };
  const view = evaluateProposal(p, two, [rec('m1', 'mike@example.com', 'promote')]);
  assert.equal(view.status, 'common');
  assert.equal(finalizeAction(view), 'accept');
});

test('two parties: a reject leaves the original standing and the proposal open until the proposer cuts it too', () => {
  const p = { markId: 'm1', by: 'ai:claude' };
  const records = [rec('m1', 'mike@example.com', 'cut')];
  const view = evaluateProposal(p, two, records);
  assert.equal(view.status, 'open');
  assert.equal(view.disagree, true);
  assert.equal(finalizeAction(view), 'hold');
  records.push(rec('m1', 'ai:claude', 'cut'));
  assert.equal(finalizeAction(evaluateProposal(p, two, records)), 'reject');
});

test('many parties: common only when every participant promoted, AIs counted like people', () => {
  const p = { markId: 'm2', by: 'mike@example.com' };
  const records = [rec('m2', 'eric@example.com', 'promote'), rec('m2', 'ai:claude', 'promote')];
  assert.equal(evaluateProposal(p, many, records).status, 'open');
  assert.deepEqual(evaluateProposal(p, many, records).openFor, ['ai:gemini']);
  records.push(rec('m2', 'ai:gemini', 'promote'));
  assert.equal(evaluateProposal(p, many, records).status, 'common');
});

test('observers do not dispose and are never waited on', () => {
  assert.deepEqual(voters(many), ['mike@example.com', 'eric@example.com', 'ai:claude', 'ai:gemini']);
  assert.equal(dispositionRefusal(many, 'lea@example.com')?.code, 'OBSERVER_CANNOT_DISPOSE');
  assert.equal(dispositionRefusal(many, 'stranger@example.com')?.code, 'NOT_A_PARTICIPANT');
  assert.equal(dispositionRefusal(many, 'ai:gemini'), null);
});

test('changing your mind: the latest disposition counts, and draft puts it back', () => {
  const p = { markId: 'm3', by: 'ai:claude' };
  const records = [rec('m3', 'mike@example.com', 'promote')];
  assert.equal(pileOf(p, 'mike@example.com', records), 'accord');
  records.push(rec('m3', 'mike@example.com', 'cut'));
  assert.equal(pileOf(p, 'mike@example.com', records), 'cutting-room');
  records.push(rec('m3', 'mike@example.com', 'draft'));
  assert.equal(pileOf(p, 'mike@example.com', records), 'draft');
  // The proposer can withdraw their own proposal too.
  records.push(rec('m3', 'ai:claude', 'cut'));
  assert.equal(pileOf(p, 'ai:claude', records), 'cutting-room');
});

test('actor names compare the way line marks compare them (case and spacing)', () => {
  const p = { markId: 'm4', by: 'ai:claude' };
  assert.equal(pileOf(p, 'Mike@Example.com ', [rec('m4', 'mike@example.com', 'promote')]), 'accord');
});

test('where we differ lists exactly the open proposals someone promoted and someone else cut', () => {
  const records = [rec('a', 'mike@example.com', 'cut'), rec('b', 'mike@example.com', 'promote')];
  const views = evaluateProposals([{ markId: 'a', by: 'ai:claude' }, { markId: 'b', by: 'ai:claude' }], two, records);
  assert.deepEqual(whereWeDiffer(views).map(v => v.markId), ['a']);
});

test('full accord: every proposal settled, so every draft is empty and the piles match', () => {
  const proposals = [{ markId: 'a', by: 'ai:claude' }, { markId: 'b', by: 'ai:claude' }];
  const records = [rec('a', 'mike@example.com', 'promote'), rec('b', 'mike@example.com', 'cut')];
  assert.equal(isFullAccord(evaluateProposals(proposals, two, records)), false);
  records.push(rec('b', 'ai:claude', 'cut'));
  assert.equal(isFullAccord(evaluateProposals(proposals, two, records)), true);
});

test('personal piles: one person\'s draft, accord and cutting room over the open proposals', () => {
  const proposals = [{ markId: 'a', by: 'ai:claude' }, { markId: 'b', by: 'eric@example.com' }, { markId: 'c', by: 'ai:gemini' }];
  const records = [rec('a', 'mike@example.com', 'promote'), rec('b', 'mike@example.com', 'cut')];
  const piles = personalPiles(evaluateProposals(proposals, many, records), 'mike@example.com');
  assert.deepEqual(piles, { draft: ['c'], accord: ['a'], 'cutting-room': ['b'] });
});

test('a roster of AIs alone never changes the shared text', () => {
  const ais: RosterEntry[] = [{ actor: 'ai:claude', role: 'participant' }, { actor: 'ai:gemini', role: 'participant' }];
  const view = evaluateProposal({ markId: 'm', by: 'ai:claude' }, ais, [rec('m', 'ai:gemini', 'promote')]);
  assert.equal(view.status, 'open');
});

test('owner overrule decides an open proposal and records who disagreed', () => {
  const p = { markId: 'm5', by: 'ai:claude' };
  const view = evaluateProposal(p, many, [rec('m5', 'eric@example.com', 'cut')]);
  const result = overrule(view, many, 'mike@example.com', 'common', at());
  assert.ok(!('code' in result));
  if ('code' in result) return;
  assert.equal(result.outcome, 'common');
  assert.deepEqual(result.dissent, [
    { actor: 'eric@example.com', pile: 'cutting-room' },
    { actor: 'ai:gemini', pile: 'draft' },
  ]);
  const refused = overrule(view, many, 'eric@example.com', 'common', at());
  assert.equal('code' in refused && refused.code, 'OWNER_ONLY');
});

test('parseDisposition accepts the page\'s words and the model\'s words', () => {
  assert.equal(parseDisposition('accept'), 'promote');
  assert.equal(parseDisposition('Promote'), 'promote');
  assert.equal(parseDisposition('reject'), 'cut');
  assert.equal(parseDisposition('cut'), 'cut');
  assert.equal(parseDisposition('draft'), 'draft');
  assert.equal(parseDisposition('maybe'), null);
});

test('the count line reads the viewer\'s own draft and where we differ', () => {
  const report = {
    multiParty: true,
    roster: [{ actor: 'mike@example.com', role: 'owner' as const }, { actor: 'ai:claude', role: 'participant' as const }, { actor: 'ai:gemini', role: 'participant' as const }, { actor: 'lea@example.com', role: 'observer' as const }],
    proposals: [
      { markId: 'a', proposer: 'ai:claude', status: 'open', openFor: ['Mike@example.com', 'ai:gemini'], promotedBy: ['ai:claude'] },
      { markId: 'b', proposer: 'ai:claude', status: 'open', openFor: ['ai:gemini'], promotedBy: ['ai:claude', 'mike@example.com'] },
      { markId: 'c', proposer: 'ai:gemini', status: 'open', openFor: [], promotedBy: ['ai:gemini', 'mike@example.com'], cutBy: ['ai:claude'] },
    ],
    whereWeDiffer: ['c'],
    fullAccord: false,
  };
  assert.equal(dispositionStatusText(summarizeForViewer(report, 'mike@example.com')), '1 in your draft · 1 where we differ');
  assert.equal(dispositionStatusText(summarizeForViewer({ ...report, whereWeDiffer: [] }, 'ai:claude')), 'Nothing left in your draft · waiting on others');
  assert.equal(dispositionStatusText(summarizeForViewer(report, 'lea@example.com')), 'Observing · 3 open · 1 where we differ');
  assert.equal(dispositionStatusText(summarizeForViewer({ ...report, proposals: [], whereWeDiffer: [], fullAccord: true }, 'ai:claude')), 'Full accord');
});

test('someone who has not decided yet has every open proposal they did not make in their draft', () => {
  const report = {
    multiParty: true,
    proposals: [
      { markId: 'a', proposer: 'ai:claude', status: 'open', openFor: ['ai:gemini'], promotedBy: ['ai:claude'] },
      { markId: 'b', proposer: 'Eric', status: 'open', openFor: ['ai:claude'], promotedBy: ['eric'] },
    ],
    whereWeDiffer: [],
    fullAccord: false,
  };
  assert.equal(summarizeForViewer(report, 'Mike').draft, 2);
  assert.equal(summarizeForViewer(report, 'eric').draft, 1);
});

test('the pile switch: one person\'s draft, accord, cutting room and where we differ, by mark id', () => {
  const report = {
    multiParty: true,
    roster: [{ actor: 'mike@example.com', role: 'owner' as const }, { actor: 'ai:claude', role: 'participant' as const }, { actor: 'lea@example.com', role: 'observer' as const }],
    proposals: [
      { markId: 'a', proposer: 'ai:claude', status: 'open', openFor: ['mike@example.com'], promotedBy: ['ai:claude'] },
      { markId: 'b', proposer: 'ai:claude', status: 'open', openFor: [], promotedBy: ['ai:claude', 'Mike@example.com'] },
      { markId: 'c', proposer: 'ai:claude', status: 'open', openFor: [], promotedBy: ['ai:claude'], cutBy: ['mike@example.com'] },
      { markId: 'd', proposer: 'ai:claude', status: 'common', openFor: [], promotedBy: ['ai:claude', 'mike@example.com'] },
    ],
    whereWeDiffer: ['c'],
    fullAccord: false,
  };
  assert.deepEqual(viewerPiles(report, 'mike@example.com'), { draft: ['a'], accord: ['b'], 'cutting-room': ['c'], differ: ['c'] });
  assert.deepEqual(viewerPiles(report, 'ai:claude'), { draft: [], accord: ['a', 'b', 'c'], 'cutting-room': [], differ: ['c'] });
  assert.deepEqual(viewerPiles(report, 'lea@example.com'), { draft: [], accord: [], 'cutting-room': [], differ: ['c'] });
  assert.deepEqual(viewerPiles(report, 'newcomer'), { draft: ['a', 'b', 'c'], accord: [], 'cutting-room': [], differ: ['c'] });
  assert.deepEqual(PILE_FILTER_POLICY.filters.map(f => f.label), ['Draft', 'My accord', 'Cutting room', 'Where we differ']);
  assert.equal(PILE_FILTER_POLICY.defaultFilter, null);
});

test('stance on a change names who has it in their accord and who cut it', () => {
  const report = {
    multiParty: true,
    proposals: [
      { markId: 'a', proposer: 'ai:claude', status: 'open', openFor: ['ai:gemini'], promotedBy: ['ai:claude'], cutBy: ['mike@example.com'] },
      { markId: 'b', proposer: 'ai:claude', status: 'open', openFor: ['ai:gemini', 'mike@example.com'], promotedBy: [] },
    ],
    whereWeDiffer: ['a'],
    fullAccord: false,
  };
  const name = (a: string) => a === 'mike@example.com' ? 'Mike' : a.replace(/^ai:/, '');
  assert.equal(stanceText(report, ['a'], name), 'In accord: claude · Cut: Mike');
  assert.equal(stanceText(report, ['b'], name), null);
  assert.equal(stanceText(report, ['zzz'], name), null);
  assert.equal(stanceText(report, ['a', 'b'], name), null, 'a row with several changes shows no merged stance');
});

console.log(`\n${passed} dispositions tests passed`);
