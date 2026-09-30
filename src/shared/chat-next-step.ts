/**
 * The Room's first row: a code-written guide from the same Open list the margin uses.
 * Mike, 2026-09-30 (usability assessment fixes 10–12).
 */
import type { AskView } from './asks.js';
import type { OpenItem } from './open-view.js';

export interface ChatNextStepInput {
  /** Lines open for the viewer (openView.count). */
  count: number;
  items: readonly OpenItem[];
  asks: readonly AskView[];
  lineText: (lineIndex: number) => string;
}

export interface ChatNextStep {
  /** No open items for the viewer. */
  empty: boolean;
  /** Count lead-in, e.g. "3 decisions wait for you." */
  lead: string;
  /** First open line to jump to on "Go to it". */
  line: number | null;
  /** Ask question text (without forcing a trailing ?). */
  askTitle: string | null;
  /** Recommendation line for an ask, e.g. "Yes". */
  recommend: string | null;
  /** Plain sentence when there is no ask detail to show. */
  plain: string | null;
}

function recommendHead(recommend: string): string {
  const head = recommend.split(':')[0]?.trim();
  return head || recommend.trim();
}

function askQuestion(view: AskView, lineText: string): string {
  const text = lineText.trim() || view.ask.anchor.excerpt.trim();
  return text.replace(/\s+/g, ' ').slice(0, 200);
}

/** Builds the pinned first chat row from the open-items summary. */
export function buildChatNextStep(input: ChatNextStepInput): ChatNextStep {
  const count = input.count;
  if (count <= 0) {
    return { empty: true, lead: '', line: null, askTitle: null, recommend: null, plain: 'Nothing is open for you.' };
  }
  const lead = `${count} ${count === 1 ? 'decision waits' : 'decisions wait'} for you.`;
  for (const item of input.items) {
    if (!item.kinds.includes('ask')) continue;
    const view = input.asks.find(ask => ask.lineIndex === item.line);
    const title = view ? askQuestion(view, input.lineText(item.line)) : input.lineText(item.line).replace(/\s+/g, ' ').trim();
    const recommend = view?.ask.recommend ? recommendHead(view.ask.recommend) : null;
    return {
      empty: false,
      lead,
      line: item.line,
      askTitle: title,
      recommend,
      plain: null,
    };
  }
  const first = input.items[0];
  const snippet = input.lineText(first.line).replace(/\s+/g, ' ').trim() || first.because;
  return {
    empty: false,
    lead,
    line: first.line,
    askTitle: null,
    recommend: null,
    plain: `${lead} Next: ${snippet}.`,
  };
}
