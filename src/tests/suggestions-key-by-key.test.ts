import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, Plugin } from '@milkdown/kit/prose/state';

import { setCurrentActor } from '../editor/actor.js';
import { createAuthoredTrackerPlugin } from '../editor/plugins/authored-tracker.js';
import { getMarks, marksPluginKey } from '../editor/plugins/marks.js';
import { wrapTransactionForSuggestions } from '../editor/plugins/suggestions.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    text: { group: 'inline' },
  },
  marks: {
    proofSuggestion: {
      attrs: {
        id: { default: null },
        kind: { default: 'replace' },
        by: { default: 'unknown' },
        content: { default: null },
        status: { default: null },
        createdAt: { default: null },
        runId: { default: null },
        focusAreaId: { default: null },
        focusAreaName: { default: null },
        agentId: { default: null },
        proposalId: { default: null },
        provisional: { default: null },
        orchestrator: { default: null },
        debugAutoFixedQuotes: { default: null },
        debugAutoFixedQuotesReason: { default: null },
      },
      inclusive: false,
      spanning: true,
    },
    proofAuthored: {
      attrs: {
        by: { default: 'human:unknown' },
        id: { default: null },
      },
      inclusive: true,
      spanning: true,
    },
  },
});

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

function typeSuggestionKeyByKey(text: string): EditorState {
  const authoredPlugin = createAuthoredTrackerPlugin();
  let state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, schema.text('Base')),
    ]),
    plugins: [authoredPlugin, createMarksStatePlugin()],
  });
  const view = {
    get state() {
      return state;
    },
  };
  let cursor = 5;

  for (const character of text) {
    (authoredPlugin.props.handleTextInput as any)?.(view, cursor, cursor, character);
    const wrapped = wrapTransactionForSuggestions(
      state.tr.insertText(character, cursor),
      state,
      true,
    );
    state = state.applyTransaction(wrapped).state;
    cursor += character.length;
  }

  return state;
}

const actor = `human:key-by-key-${Date.now()}`;
setCurrentActor(actor);
const state = typeSuggestionKeyByKey(' [abc]');
const marks = getMarks(state);
const suggestions = marks.filter((mark) => mark.kind === 'insert');
const authored = marks.filter((mark) => mark.kind === 'authored');

assert(suggestions.length === 1, `Expected one insert suggestion, got ${suggestions.length}`);
assert(authored.length === 0, `Expected no authored marks inside pending suggestion, got ${authored.length}`);

console.log('✓ key-by-key suggestion typing stays out of authorship tracking');
