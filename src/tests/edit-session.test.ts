/** Local drafts and one attributed proposal. Mike, 2026-09-23 (usability brief). */
import assert from 'node:assert/strict';
import { beginDraft, draftAction, draftKey, draftPrefix, parseDraft, resolveDraft, EDIT_SESSION_POLICY, type EditDoor } from '../shared/edit-session';
import { extractLines, hashLine, type DocLine, type LineSourceNode } from '../shared/line-marks';
import { routeKey } from '../shared/reading-keys';
import { UndoStack } from '../shared/undo';
import { EditGestureUI } from '../ui/edit-gesture';
import { getMarks, reject as rejectMark, suggestReplace, modifySuggestionContent } from '../editor/plugins/marks';
import { installLocalWriteResyncPolicy } from '../editor/local-write-resync';
import { pair, schema } from './review-history-fixture';
let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log(`✓ ${name}`); }
const doc = schema.node('doc', null, ['same', 'same', 'third'].map(t => schema.node('paragraph', null, schema.text(t))));
const lines = extractLines(doc as unknown as LineSourceNode);
const draft = beginDraft(lines[1], 'same');
test('only the explicit submit doors publish; all other exits keep every character', () => {
  assert.deepEqual(EDIT_SESSION_POLICY.publishDoors, ['propose', 'cmd-enter']);
  assert.equal(EDIT_SESSION_POLICY.liveProposals, true);
  assert.equal(EDIT_SESSION_POLICY.privateDrafts, false);
  assert.equal(EDIT_SESSION_POLICY.withdrawOwnInsert, true);
  assert.equal(EDIT_SESSION_POLICY.deleteProposalRejects, true);
  assert.equal(EDIT_SESSION_POLICY.editOtherProposalsInPlace, false);
  assert.equal(EDIT_SESSION_POLICY.caretDefinesWriting, true);
  assert.equal(EDIT_SESSION_POLICY.escapeReturnsToReview, true);
  assert.equal(EDIT_SESSION_POLICY.showMarkProgress, false);
  const texts = ['', 'a', '  double  spaces  ', '🙂 é\t\n', '# heading\n\nbody', 'safe → unsafe'];
  const doors: EditDoor[] = ['propose', 'cmd-enter', 'escape', 'click-outside', 'scrolled-away', 'hover', 'blur', 'reload', 'cancel'];
  for (const proposed of texts) for (const door of doors) {
    const value = { ...draft, proposed };
    assert.equal(draftAction(value, door), door === 'cancel' ? 'discard' : door === 'propose' || door === 'cmd-enter' ? 'publish' : 'keep');
    assert.equal(value.proposed, proposed);
    assert.deepEqual(parseDraft(JSON.stringify(value)), value);
  }
  assert.equal(draftAction(draft, 'propose'), 'keep', 'unchanged drafts publish nothing');
});
test('keys isolate documents, readers and repeated passages', () => {
  const key = draftKey('doc', 'guest:Alice', draft.anchor);
  assert.ok(key.startsWith(draftPrefix('doc', 'guest:Alice')));
  assert.notEqual(key, draftKey('other', 'guest:Alice', draft.anchor));
  assert.notEqual(key, draftKey('doc', 'guest:Bob', draft.anchor));
  assert.notEqual(key, draftKey('doc', 'guest:Alice', beginDraft(lines[0], 'same').anchor));
  assert.equal(key, draftKey('doc', 'GUEST:alice', draft.anchor));
});
function rewrite(line: DocLine, text: string): DocLine {
  return { ...line, text, hash: hashLine(line.kind, text) };
}
test('a draft resolves by exact text, then by the lapsed-mark search, and never by an unrelated line', () => {
  assert.equal(resolveDraft(draft, lines)?.line.index, 1);
  assert.equal(resolveDraft(draft, lines)?.changed, false);
  // The old ordinal fallback attached this unrelated text. It must not.
  const unrelated = lines.map((l, i) => rewrite(l, `changed ${i}`));
  assert.equal(resolveDraft(draft, unrelated), null);
  assert.equal(resolveDraft(draft, []), null);
  assert.equal(parseDraft('{broken'), null);
  assert.equal(parseDraft('{"original":"x","proposed":"y","anchor":{}}'), null);

  const sentence = 'The edit gesture line is long enough to survive a small edit.';
  const longDoc = schema.node('doc', null, [
    'An intro paragraph that stays where it is.',
    sentence,
    'A closing paragraph that stays where it is.',
  ].map(t => schema.node('paragraph', null, schema.text(t))));
  const longLines = extractLines(longDoc as unknown as LineSourceNode);
  const longDraft = beginDraft(longLines[1], sentence);
  assert.equal(resolveDraft(longDraft, longLines)?.changed, false);
  assert.equal(resolveDraft(longDraft, longLines)?.line.text, sentence);
  const edited = 'The edit gesture line is long enough to survive a larger edit.';
  const editedLines = longLines.map((l, i) => i === 1 ? rewrite(l, edited) : l);
  assert.equal(resolveDraft(longDraft, editedLines)?.line.index, 1);
  assert.equal(resolveDraft(longDraft, editedLines)?.changed, true);
  assert.equal(resolveDraft(longDraft, editedLines)?.line.text, edited);
  // A new unrelated paragraph now sits at the old ordinal. The draft follows the edited sentence.
  const moved = [
    longLines[0],
    rewrite({ ...longLines[0], index: 1 }, 'Zebras seldom publish quarterly tax guidance for coastal lighthouses.'),
    rewrite({ ...longLines[1], index: 2 }, edited),
  ];
  assert.equal(resolveDraft(longDraft, moved)?.line.index, 2);
  assert.equal(resolveDraft(longDraft, moved)?.line.text, edited);
  assert.equal(resolveDraft(longDraft, moved)?.changed, true);
  const lost = longLines.map((l, i) => i === 1 ? rewrite(l, 'Zebras seldom publish quarterly tax guidance for coastal lighthouses.') : l);
  assert.equal(resolveDraft(longDraft, lost), null);
});
test('S suggests, E explains, and draft fields and direct Editing never run letter commands', () => {
  for (const key of ['s', 'S', 'e']) assert.equal(routeKey({ key, target: 'editor', writing: false }), 'command');
  for (const key of ['a', 's', 'e', 'j', '1', 'Enter']) {
    assert.equal(routeKey({ key, target: 'field', writing: false }), 'type');
    assert.equal(routeKey({ key, target: 'editor', writing: true }), 'type');
    assert.equal(routeKey({ key, target: 'control', writing: true }), 'pass');
  }
});

// Real marks, Yjs and the UI submission path, without a browser. Draft widgets are tested by draft-check.
installLocalWriteResyncPolicy();
const peers = await pair();
const saved = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  get length() { return saved.size; }, key: (i: number) => [...saved.keys()][i],
  getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key),
} });
try {
  const disabled = new EditGestureUI({ view: () => null } as any);
  assert.equal(disabled.open(0), false, 'production cannot open private drafts');
  disabled.start();
  assert.equal(disabled.debugState().started, false);
  // Exercise the retained rollback code explicitly; production never enables it.
  (EDIT_SESSION_POLICY as any).privateDrafts = true;
  const { alice, bob } = peers;
  const stack = new UndoStack();
  let allowed = true, writes = 0;
  const dispatch = alice.view.dispatch.bind(alice.view);
  alice.view.dispatch = (tr: any) => { if (tr.getMeta('proofLocalMarkChange')) writes++; dispatch(tr); };
  const host = {
    view: () => alice.view, slug: () => 'fixture', actor: () => 'human:Alice', canPropose: () => allowed,
    suggestReplace: (view: any, quote: string, by: string, content: string, range: { from: number; to: number }) => suggestReplace(view, quote, by, content, range)?.id ?? null,
    pending: (id: string, content?: string) => getMarks(alice.view.state).some(m => m.id === id && (m.data as any)?.status === 'pending' && (content === undefined || (m.data as any).content === content)),
    decide: (ids: string[]) => { for (const id of ids) assert.ok(rejectMark(alice.view, id)); },
    undoStack: () => stack, proposed: () => {}, notice: () => {},
  };
  const ui = new EditGestureUI(host);
  test('opening and typing a draft writes no shared text or marks', () => {
    assert.equal(ui.open(0), true);
    const entry = [...ui['drafts'].values()][0];
    entry.draft.proposed = 'Proposed  words 🙂'; ui['save'](entry);
    assert.equal(alice.view.state.doc.textContent, 'OriginalSecond');
    assert.equal(getMarks(alice.view.state).length, 0);
    assert.equal(writes, 0);
    assert.equal(saved.size, 1);
  });
  test('reload restores exact draft text; concurrent edits survive one attributed submission', () => {
    const resumed = new EditGestureUI(host);
    assert.equal(resumed.open(0), true);
    const entry = [...resumed['drafts'].values()][0];
    assert.equal(entry.draft.proposed, 'Proposed  words 🙂');
    bob.edit(() => bob.view.dispatch(bob.view.state.tr.insertText(' remote', 9)));
    const current = alice.view.state.doc.textContent;
    resumed['submit'](entry, 'propose');
    assert.equal(writes, 1);
    assert.equal(alice.view.state.doc.textContent, current, 'submission never rewrites the original or remote text');
    assert.equal(bob.view.state.doc.textContent, current);
    assert.equal(alice.view.state.doc.childCount, 2);
    const marks = getMarks(alice.view.state);
    assert.equal(marks.length, 1); assert.equal(marks[0].by, 'human:Alice');
    assert.equal((marks[0].data as any).content, 'Proposed  words 🙂');
    assert.equal(stack.depth(), 1); assert.equal(saved.size, 0);
    resumed['submit'](entry, 'propose'); assert.equal(writes, 1, 'double submit is ignored');
  });
  const outcome = await stack.undo();
  test('one Undo removes the proposal and preserves the concurrent text', () => {
    assert.equal(outcome.ok, true);
    assert.equal(getMarks(alice.view.state).filter(m => (m.data as any).status === 'pending').length, 0);
    assert.equal(alice.view.state.doc.child(0).textContent, 'Original remote');
    assert.equal(bob.view.state.doc.child(0).textContent, 'Original remote');
  });
  const changed = new EditGestureUI(host);
  changed.open(0);
  const changeEntry = [...changed['drafts'].values()][0];
  changeEntry.draft.proposed = 'First proposal'; changed['submit'](changeEntry, 'propose');
  const changedId = changed.posted[0].markId;
  modifySuggestionContent(bob.view, changedId, 'Collaborator changed the proposal');
  const refused = await stack.undo();
  test('Undo refuses to remove a proposal another participant revised', () => {
    assert.equal(refused.ok, false);
    assert.equal((getMarks(alice.view.state).find(m => m.id === changedId)?.data as any)?.content, 'Collaborator changed the proposal');
    assert.equal(host.pending(changedId), true);
  });
  test('revoked permission keeps the draft and refuses submission', () => {
    const other = new EditGestureUI(host); assert.ok(other.open(1));
    const entry = [...other['drafts'].values()][0]; entry.draft.proposed = 'Not permitted'; other['save'](entry);
    allowed = false;
    const before = writes; other['submit'](entry, 'cmd-enter');
    assert.equal(writes, before); assert.equal(saved.size, 1);
    assert.equal(other.open(0), false);
  });
  test('a small edit stays attached and an unrelated replacement is listed as lost', () => {
    allowed = true;
    const ui = new EditGestureUI(host);
    assert.equal(ui.open(0), true);
    const openEntry = [...ui['drafts'].values()].find(d => d.open)!;
    const original = openEntry.draft.original;
    const end = () => alice.view.state.doc.child(0).nodeSize - 1;
    alice.view.dispatch(alice.view.state.tr.insertText(`${original} today`, 1, end()));
    assert.equal(ui.lostDrafts().some(d => d.original === original), false, 'the edited passage still holds the draft');
    alice.view.dispatch(alice.view.state.tr.insertText('Zebras seldom publish quarterly tax guidance for coastal lighthouses.', 1, end()));
    const lost = ui.lostDrafts().filter(d => d.original === original);
    assert.equal(lost.length, 1);
    assert.equal(lost[0].proposed, original);
  });
} finally { (EDIT_SESSION_POLICY as any).privateDrafts = false; peers.close(); }
console.log(`\n${passed} edit-session tests passed`);
