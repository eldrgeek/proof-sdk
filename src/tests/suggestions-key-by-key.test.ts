import { EditorState, Plugin } from '@milkdown/kit/prose/state';

import { getHeadlessMilkdownParser, serializeMarkdown } from '../../server/milkdown-headless.js';
import { finalizeSuggestionThroughRehydration } from '../../server/proof-mark-rehydration.js';
import { stripAllProofSpanTags } from '../../server/proof-span-strip.js';
import { setCurrentActor } from '../editor/actor.js';
import { createAuthoredTrackerPlugin } from '../editor/plugins/authored-tracker.js';
import {
  accept,
  getMarkMetadataWithQuotes,
  getMarks,
  marksPluginKey,
  proofMarkActionMeta,
  reject,
  mergePendingServerMarks,
} from '../editor/plugins/marks.js';
import { wrapTransactionForSuggestions } from '../editor/plugins/suggestions.js';
import { normalizeQuote, type StoredMark } from '../formats/marks.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function createMarksStatePlugin(): Plugin {
  return new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null, composeAnchorRange: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata ?? {} };
        }
        return value;
      },
    },
  });
}

function assertSuggestionSnapshot(state: EditorState, expectedText: string): void {
  const metadata = getMarkMetadataWithQuotes(state);
  const entries = Object.entries(metadata).filter(([, mark]) => mark.kind === 'insert');
  assert(entries.length === 1, `Expected one stored insert after "${expectedText}", got ${entries.length}`);

  const [id, stored] = entries[0];
  const expectedQuote = normalizeQuote(expectedText) || expectedText;
  assert(stored.content === expectedText, `Expected content "${expectedText}", got "${stored.content ?? ''}"`);
  assert(stored.quote === expectedQuote, `Expected quote "${expectedQuote}", got "${stored.quote ?? ''}"`);
  assert(Boolean(stored.range), `Expected a range after "${expectedText}"`);
  assert(Boolean(stored.startRel && stored.endRel), `Expected relative anchors after "${expectedText}"`);
  assert(
    state.doc.textBetween(stored.range!.from, stored.range!.to, '\n', '\n') === expectedText,
    `Expected range for "${expectedText}" to cover the entire suggestion`,
  );

  const segments: Array<{ text: string; attrs: Record<string, unknown> }> = [];
  state.doc.descendants((node) => {
    if (!node.isText) return true;
    const mark = node.marks.find((candidate) => (
      candidate.type.name === 'proofSuggestion' && candidate.attrs.id === id
    ));
    if (mark) {
      segments.push({ text: node.text ?? '', attrs: mark.attrs as Record<string, unknown> });
    }
    return true;
  });
  assert(segments.length === 1, `Expected one suggestion text node after "${expectedText}", got ${segments.length}`);
  assert(segments[0].text === expectedText, `Expected one marked run containing "${expectedText}"`);
  assert(
    segments[0].attrs.content === expectedText,
    `Expected document mark attrs to carry current content "${expectedText}"`,
  );
}

async function typeSuggestionKeyByKey(text: string): Promise<EditorState> {
  const parser = await getHeadlessMilkdownParser();
  const schema = parser.schema;
  const authoredPlugin = createAuthoredTrackerPlugin();
  let state = EditorState.create({
    schema,
    doc: parser.parseMarkdown('Base'),
    plugins: [authoredPlugin, createMarksStatePlugin()],
  });
  const view = {
    get state() {
      return state;
    },
  };
  let cursor = state.doc.content.size - 1;
  let typed = '';

  for (const character of text) {
    (authoredPlugin.props.handleTextInput as any)?.(view, cursor, cursor, character);
    const wrapped = wrapTransactionForSuggestions(
      state.tr.insertText(character, cursor),
      state,
      true,
    );
    state = state.applyTransaction(wrapped).state;
    cursor += character.length;
    typed += character;
    assertSuggestionSnapshot(state, typed);
  }

  return state;
}

async function run(): Promise<void> {
  const actor = `human:key-by-key-${Date.now()}`;
  setCurrentActor(actor);
  const parser = await getHeadlessMilkdownParser();
  const state = await typeSuggestionKeyByKey(' [abc]');
  const marks = getMarks(state);
  const suggestions = marks.filter((mark) => mark.kind === 'insert');
  const authored = marks.filter((mark) => mark.kind === 'authored');

  assert(suggestions.length === 1, `Expected one insert suggestion, got ${suggestions.length}`);
  assert(authored.length === 0, `Expected no authored marks inside pending suggestion, got ${authored.length}`);

  const markdown = await serializeMarkdown(state.doc);
  assert(
    (markdown.match(/data-proof="suggestion"/g) ?? []).length === 1,
    `Expected one serialized suggestion span, got:\n${markdown}`,
  );
  assert(!markdown.includes('data-proof="authored"'), `Expected no authored span in pending markdown:\n${markdown}`);
  assert(
    stripAllProofSpanTags(markdown).trim() === 'Base [abc]',
    `Expected serialization to preserve suggestion text exactly, got:\n${markdown}`,
  );

  const localMarks = getMarkMetadataWithQuotes(state);
  const [suggestionId] = Object.keys(localMarks);
  assert(
    localMarks[suggestionId].quote === '[abc]' && localMarks[suggestionId].content === ' [abc]',
    'Expected the stored quote to omit the leading space while content preserves it',
  );
  const actionReplacement = state.tr
    .replaceWith(localMarks[suggestionId].range!.from, localMarks[suggestionId].range!.to, state.schema.text(' [abc]'))
    .setMeta(proofMarkActionMeta, 'accept');
  assert(
    wrapTransactionForSuggestions(actionReplacement, state, true) === actionReplacement,
    'Expected an explicitly tagged mark action with replacement steps to bypass suggestion wrapping',
  );

  let locallyAcceptedState = state;
  let dispatchedAction: unknown;
  let acceptHadReplaceStep = false;
  const acceptingView = {
    get state() {
      return locallyAcceptedState;
    },
    dispatch(tr: typeof state.tr) {
      dispatchedAction = tr.getMeta(proofMarkActionMeta);
      acceptHadReplaceStep = tr.steps.some((step) => step.toJSON().stepType === 'replace');
      const intercepted = wrapTransactionForSuggestions(tr, locallyAcceptedState, true);
      assert(intercepted === tr, 'Expected suggestion wrapping to pass mark accept transactions through unchanged');
      locallyAcceptedState = locallyAcceptedState.applyTransaction(intercepted).state;
    },
  };
  const textBeforeAccept = locallyAcceptedState.doc.textContent;
  assert(accept(acceptingView as any, suggestionId, parser.parseMarkdown), 'Expected local insert accept to succeed');
  assert(dispatchedAction === 'accept', 'Expected local insert accept transaction to carry action metadata');
  assert(!acceptHadReplaceStep, 'Expected matching inline insert accept to avoid deleting or re-inserting text');
  assert(locallyAcceptedState.doc.textContent === textBeforeAccept, 'Expected local insert accept to preserve covered text exactly');
  const locallyAcceptedMarks = getMarks(locallyAcceptedState);
  assert(
    !locallyAcceptedMarks.some((mark) => mark.kind === 'insert'),
    'Expected local insert accept to remove the proofSuggestion mark in the same dispatch',
  );
  assert(
    locallyAcceptedMarks.some((mark) => mark.kind === 'authored' && mark.by === actor),
    'Expected local insert accept to assign authorship to the suggester',
  );

  let locallyRejectedState = state;
  let rejectedAction: unknown;
  const rejectingView = {
    get state() {
      return locallyRejectedState;
    },
    dispatch(tr: typeof state.tr) {
      rejectedAction = tr.getMeta(proofMarkActionMeta);
      const intercepted = wrapTransactionForSuggestions(tr, locallyRejectedState, true);
      assert(intercepted === tr, 'Expected suggestion wrapping to pass mark reject transactions through unchanged');
      locallyRejectedState = locallyRejectedState.applyTransaction(intercepted).state;
    },
  };
  assert(reject(rejectingView as any, suggestionId), 'Expected local insert reject to succeed');
  assert(rejectedAction === 'reject', 'Expected local insert reject transaction to carry action metadata');
  assert(locallyRejectedState.doc.textContent === 'Base', 'Expected local insert reject to remove the inserted text');
  assert(
    !getMarks(locallyRejectedState).some((mark) => mark.kind === 'insert'),
    'Expected local insert reject to remove the proofSuggestion mark in the same dispatch',
  );

  const staleServerMark: StoredMark = {
    ...localMarks[suggestionId],
    content: ' ',
    quote: ' ',
    range: { from: 5, to: 6 },
    startRel: 'char:4',
    endRel: 'char:5',
  };
  const merged = mergePendingServerMarks(localMarks, { [suggestionId]: staleServerMark });
  assert(merged[suggestionId].content === ' [abc]', 'Expected current local insert content to survive stale server merge');
  assert(merged[suggestionId].quote === '[abc]', 'Expected current local quote to survive stale server merge');
  assert(merged[suggestionId].range?.to === 11, 'Expected current local range to survive stale server merge');
  assert(merged[suggestionId].endRel === 'char:10', 'Expected current local relative anchor to survive stale server merge');

  const serverAcceptId = `${suggestionId}-server-accept`;
  const serverAcceptMarkdown = markdown.replaceAll(suggestionId, serverAcceptId);
  const accepted = await finalizeSuggestionThroughRehydration({
    markdown: serverAcceptMarkdown,
    marks: { [serverAcceptId]: localMarks[suggestionId] },
    markId: serverAcceptId,
    action: 'accept',
  });
  if (!accepted.ok) {
    throw new Error(
      `Expected server rehydration accept to succeed: ${accepted.code} ${accepted.error}\n`
      + `marks=${JSON.stringify(localMarks)}\nmarkdown=${serverAcceptMarkdown}`,
    );
  }
  assert(
    stripAllProofSpanTags(accepted.markdown).trimEnd() === 'Base [abc]',
    `Expected accept to preserve inserted text, got:\n${accepted.markdown}`,
  );
  assert(
    !stripAllProofSpanTags(accepted.markdown).includes('data-id='),
    `Expected accept with a normalized quote to keep proof markup out of visible text:\n${accepted.markdown}`,
  );
  assert(!accepted.markdown.includes('data-proof="suggestion"'), 'Expected accept to remove suggestion markup');
  assert(accepted.markdown.includes('data-proof="authored"'), 'Expected existing accept behavior to assign authorship');

  const rejectId = `${suggestionId}-reject`;
  const rejected = await finalizeSuggestionThroughRehydration({
    markdown: markdown.replaceAll(suggestionId, rejectId),
    marks: { [rejectId]: localMarks[suggestionId] },
    markId: rejectId,
    action: 'reject',
  });
  if (!rejected.ok) {
    throw new Error(`Expected server rehydration reject to succeed: ${rejected.code} ${rejected.error}`);
  }
  assert(
    stripAllProofSpanTags(rejected.markdown).trim() === 'Base',
    `Expected reject to remove inserted text, got:\n${rejected.markdown}`,
  );
  assert(!rejected.markdown.includes('data-proof="suggestion"'), 'Expected reject to remove suggestion markup');

  console.log('✓ key-by-key suggestion typing keeps current metadata and rehydrates for accept/reject');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
