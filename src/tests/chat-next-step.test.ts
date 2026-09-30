import assert from 'node:assert/strict';
import { buildChatNextStep } from '../shared/chat-next-step.js';
import type { AskView } from '../shared/asks.js';
import type { OpenItem } from '../shared/open-view.js';

const items: OpenItem[] = [
  { key: 'open:3', line: 3, kinds: ['ask'], by: 'ai:cos', count: 1, because: 'Ask', detached: false, threadIds: [] },
];

const asks: AskView[] = [{
  ask: {
    id: 'a1', by: 'ai:cos', to: ['human:me@x.co'], recommend: 'Yes: every check passes', ifYes: null,
    anchor: { hash: 'h', occurrence: 0, ordinal: 0, excerpt: 'First ask?' },
    createdAt: '2026-01-01', askedAt: '2026-01-01', answers: [],
  },
  lineIndex: 3, lineHash: 'h', current: true, people: [], openFor: ['human:me@x.co'], snoozedFor: [],
  answers: [], closed: false, settled: false, outcome: 'open',
}];

assert.equal(buildChatNextStep({ count: 0, items: [], asks: [], lineText: () => '' }).plain, 'Nothing is open for you.');
const step = buildChatNextStep({
  count: 3,
  items,
  asks,
  lineText: i => (i === 3 ? 'Should we ship tonight?' : ''),
});
assert.match(step.lead, /3 decisions wait/);
assert.equal(step.line, 3);
assert.equal(step.askTitle, 'Should we ship tonight?');
assert.equal(step.recommend, 'Yes');
console.log('chat-next-step tests passed');
