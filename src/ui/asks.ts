/**
 * Proof Documents Step B3 — the answer control for an `{ask}` line.
 *
 * Authorship: direction by Mike Wolf (Pulse Zero ideas in Proof, 18 Sept 2026); built by Claude
 * Opus 5 (worker proof-ask), 2026-09-18.
 *
 * One control, used in three places: inline under the question line (a widget decoration),
 * in the right rail's mark box when the ask line is the focus line, and in the phone's bottom
 * sheet. It shows who is asked, the asker's recommendation, the optional "If yes" preview, and
 * three real buttons: Yes / Not yet / No. "No" and "Not yet" ask for a reason line in the
 * answerer's own words; "Yes" does not (the words field stays optional).
 */
import { actorKey, actorLabel } from '../shared/line-marks';
import {
  ANYONE,
  ASK_CHOICE_LABEL,
  ASK_POLICY,
  askStateFor,
  describeAsk,
  isAskedOf,
  type AskChoice,
  type AskView,
} from '../shared/asks';
import './asks.css';

export interface AskControlOptions {
  actor: string;
  canAnswer: boolean;
  /** Where the control lives: 'inline' (under the line), 'box' (rail / popover / sheet). */
  place: 'inline' | 'box';
  answer(choice: AskChoice, words: string): Promise<boolean>;
}

export interface AskControl {
  root: HTMLElement;
  /** Keyboard (Y / N / T): Yes answers at once; No and Not yet open the reason field. */
  choose(choice: AskChoice): boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const who = (actor: string) => (actor === ANYONE ? 'anyone' : actorLabel(actor));

/** Signature of everything the control shows (decorations rebuild only when it changes). */
export function askControlSignature(view: AskView, actor: string, canAnswer: boolean): string {
  return JSON.stringify([
    view.ask.recommend, view.ask.ifYes, view.ask.to, view.ask.askedAt, view.lineHash,
    view.answers.map(a => [a.id, a.choice, a.words]), view.openFor, view.snoozedFor, actorKey(actor), canAnswer,
  ]);
}

export function buildAskControl(view: AskView, options: AskControlOptions): AskControl {
  const mine = askStateFor(view, options.actor);
  const askedOfMe = isAskedOf(view.ask, options.actor);
  const root = el('div', `pask pask-${options.place}`);
  root.dataset.askId = view.ask.id;
  root.dataset.state = mine ? mine.state : 'other';
  root.dataset.outcome = view.outcome;
  root.contentEditable = 'false';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Decision asked on this line');

  const head = el('div', 'pask-head');
  const tag = el('span', 'pask-tag', 'Ask');
  const to = el('span', 'pask-to', view.ask.to.length ? `for ${view.ask.to.map(who).join(', ')}` : 'for anyone');
  const status = el('span', 'pask-status', describeAsk(view));
  status.setAttribute('role', 'status');
  // Inline, the line itself carries the "Ask" tag at its start; the rail and sheet repeat it.
  if (options.place === 'box') head.append(tag);
  head.append(to, status);
  root.append(head);

  const rec = el('p', 'pask-rec');
  rec.append(el('strong', undefined, 'Recommend: '), document.createTextNode(view.ask.recommend));
  const from = el('span', 'pask-from', ` — ${actorLabel(view.ask.by)}`);
  rec.append(from);
  root.append(rec);
  if (view.ask.ifYes) {
    const ifYes = el('p', 'pask-ifyes');
    ifYes.append(el('strong', undefined, 'If yes: '), document.createTextNode(view.ask.ifYes));
    root.append(ifYes);
  }

  // Answers that count now (latest per person).
  if (view.answers.length) {
    const list = el('ul', 'pask-answers');
    for (const answer of view.answers) {
      const li = el('li');
      li.dataset.choice = answer.choice;
      const me = actorKey(answer.by) === actorKey(options.actor);
      li.append(el('span', 'pask-who', me ? `${actorLabel(answer.by)} (you)` : actorLabel(answer.by)),
        el('span', 'pask-choice', ASK_CHOICE_LABEL[answer.choice]));
      if (answer.words) li.append(el('q', 'pask-words-said', answer.words));
      if (!isAskedOf(view.ask, answer.by)) li.append(el('span', 'pask-note', 'not asked'));
      list.append(li);
    }
    root.append(list);
  }

  const form = el('form', 'pask-form');
  const buttons = el('div', 'pask-buttons');
  const words = el('input', 'pask-input');
  words.type = 'text';
  words.maxLength = ASK_POLICY.maxWords;
  words.placeholder = 'Your words (optional for Yes)';
  words.setAttribute('aria-label', 'Your words');
  words.enterKeyHint = 'send';
  const hint = el('p', 'pask-hint');
  hint.hidden = true;
  hint.setAttribute('role', 'alert');
  let pending: AskChoice | null = null;
  let busy = false;

  const submit = async (choice: AskChoice): Promise<void> => {
    if (busy || !options.canAnswer) return;
    const text = words.value.trim();
    if (ASK_POLICY.reasonRequired[choice] && !text) {
      pending = choice;
      hint.hidden = false;
      hint.textContent = `${ASK_CHOICE_LABEL[choice]} needs a reason: type it, then press Enter.`;
      words.placeholder = `Why ${ASK_CHOICE_LABEL[choice].toLowerCase()}? (one line, your words)`;
      words.setAttribute('aria-invalid', 'true');
      for (const b of buttonEls) b.setAttribute('aria-pressed', String(b.dataset.choice === choice));
      words.focus({ preventScroll: true });
      return;
    }
    busy = true;
    root.dataset.busy = 'true';
    const ok = await options.answer(choice, text);
    busy = false;
    delete root.dataset.busy;
    if (!ok) { hint.hidden = false; hint.textContent = 'Could not save the answer. Try again.'; }
  };

  const buttonEls: HTMLButtonElement[] = [];
  for (const choice of ['yes', 'not_yet', 'no'] as AskChoice[]) {
    const b = el('button', 'pask-btn', ASK_CHOICE_LABEL[choice]);
    b.type = 'button';
    b.dataset.choice = choice;
    b.disabled = !options.canAnswer;
    b.title = `${ASK_CHOICE_LABEL[choice]} (key ${ASK_POLICY.keys[choice].toUpperCase()})`;
    if (mine?.answer?.choice === choice) b.setAttribute('aria-pressed', 'true');
    b.onclick = (event) => { event.preventDefault(); void submit(choice); };
    buttonEls.push(b);
    buttons.append(b);
  }
  form.onsubmit = (event) => {
    event.preventDefault();
    if (pending) void submit(pending);
    else if (words.value.trim()) { hint.hidden = false; hint.textContent = 'Choose Yes, Not yet or No.'; }
  };
  words.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') { pending = null; hint.hidden = true; words.blur(); }
  });
  form.append(buttons, words);

  // Who may answer: the people asked. Others see the status and the answers (policy:
  // outside answers are recorded but do not settle), and can still answer from the box.
  const showForm = options.canAnswer && (askedOfMe || options.place === 'box');
  if (mine && mine.state === 'answered' && mine.answer && actorKey(mine.answer.by) === actorKey(options.actor)) {
    const done = el('p', 'pask-mine');
    done.append(`You answered ${ASK_CHOICE_LABEL[mine.answer.choice]}. `);
    const change = el('button', 'pask-link', 'Change');
    change.type = 'button';
    change.onclick = (event) => { event.preventDefault(); form.hidden = false; done.remove(); words.focus({ preventScroll: true }); };
    done.append(change);
    root.append(done);
    form.hidden = true;
  } else if (!askedOfMe && options.place === 'box') {
    root.append(el('p', 'pask-note-line', `Not asked of you (${actorLabel(options.actor)}); an answer here is recorded but does not settle it.`));
  }
  if (showForm) root.append(form, hint);
  else if (!options.canAnswer) root.append(el('p', 'pask-note-line', 'You can read this ask; answering needs comment access.'));

  return {
    root,
    choose(choice: AskChoice): boolean {
      if (!options.canAnswer || !root.isConnected) return false;
      if (form.hidden) form.hidden = false;
      if (!form.isConnected) root.append(form, hint);
      if (ASK_POLICY.reasonRequired[choice] && !words.value.trim()) {
        void submit(choice); // opens the reason field
        return true;
      }
      void submit(choice);
      return true;
    },
  };
}

/** The small "Ask" tag at the start of the question line. */
export function buildAskTag(view: AskView, actor: string): HTMLElement {
  const tag = el('span', 'pask-inline-tag', 'Ask');
  const mine = askStateFor(view, actor);
  tag.dataset.state = mine ? mine.state : (view.closed ? 'closed' : 'open');
  tag.contentEditable = 'false';
  tag.title = describeAsk(view);
  tag.setAttribute('aria-label', `Ask: ${describeAsk(view)}`);
  return tag;
}
