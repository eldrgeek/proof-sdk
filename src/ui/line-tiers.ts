/**
 * Proof Documents — line tiers in the page: the tier row in a line's mark box and the rail control
 * ("Show only decisions" and the decision / context counts). State lives in LineMarksUI
 * (src/ui/line-marks.ts); rules in src/shared/line-tiers.ts (TIER_POLICY).
 *
 * Authorship: Mike Wolf ruled Yes on 2026-09-19 (decision lines and context lines; idea from
 * Anthropic Fable); built by Claude Opus 5 (worker proof-tiers), 2026-09-19.
 */
import { TIER_POLICY, describeContext, type LineTier, type TierView } from '../shared/line-tiers';
import type { TierCounts } from '../shared/line-marks';
import './line-tiers.css';

export interface TierRowInput {
  view: TierView;
  anyTagged: boolean;
  canTag: boolean;
  /** The viewer is a person (only people confirm an AI's proposal). */
  viewerIsPerson: boolean;
  name(actor: string): string;
  when(iso: string): string;
  /** Sets the line's tier (an explicit action). */
  set(tier: LineTier): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The tier row at the top of a line's mark box: what the line asks of you, and the flip button. */
export function buildTierRow(input: TierRowInput): HTMLElement {
  const { view } = input;
  const row = el('div', 'plm-tier-row');
  row.dataset.tier = view.tier;
  if (view.proposed) row.dataset.proposed = 'true';
  const text = el('p', 'plm-tier-text');
  if (view.tier === 'context') {
    const head = el('span', 'plm-tier-label', view.proposed ? 'AI proposed context' : 'Context');
    const detail = el('span', 'plm-tier-detail', describeContext(view, input.name).replace(/^context — /, ''));
    text.append(head, ' — ', detail);
  } else {
    const diamond = el('span', 'plm-tier-diamond', '◆');
    diamond.setAttribute('aria-hidden', 'true');
    text.append(diamond, el('span', 'plm-tier-label', 'Decision line'), ' — ', el('span', 'plm-tier-detail', 'it needs your mark'));
  }
  row.append(text);
  if (view.record) {
    const who = el('p', 'plm-tier-who', `${view.tier === 'context' ? 'Tagged context' : 'Tagged decision'} by ${input.name(view.record.by)}, ${input.when(view.record.at)}${view.record.reason ? `: ${view.record.reason}` : ''}${view.carried ? ' (carried over a small edit)' : ''}`);
    row.append(who);
  }
  const buttons = el('div', 'plm-tier-actions');
  if (view.proposed && input.viewerIsPerson) {
    const confirm = el('button', 'plm-tier-btn plm-tier-confirm', 'Confirm context');
    confirm.type = 'button';
    confirm.disabled = !input.canTag;
    confirm.onclick = () => input.set('context');
    buttons.append(confirm);
  }
  const flip = el('button', 'plm-tier-btn plm-tier-flip', view.tier === 'context' ? 'Make decision' : 'Make context');
  const key = el('span', 'plm-tier-key', ' (D)');
  key.setAttribute('aria-hidden', 'true');
  flip.append(key);
  flip.type = 'button';
  flip.dataset.to = view.tier === 'context' ? 'decision' : 'context';
  flip.disabled = !input.canTag;
  flip.title = view.tier === 'context'
    ? 'This line needs each person’s own mark again. Everyone sees the change, with your name.'
    : 'Setup, not a claim: an AI’s read is enough for people. Everyone sees the change, with your name.';
  flip.onclick = () => input.set(view.tier === 'context' ? 'decision' : 'context');
  buttons.append(flip);
  row.append(buttons);
  return row;
}

export interface TierControlInput {
  counts: Partial<TierCounts> | null;
  anyTagged: boolean;
  onlyDecisions: boolean;
  toggle(on: boolean): void;
}

/** The rail control: decision / context counts and "Show only decisions" (view-only). */
export function renderTierControl(root: HTMLElement, input: TierControlInput): void {
  const c = input.counts;
  const sig = JSON.stringify([c?.decision, c?.context, input.anyTagged, input.onlyDecisions]);
  if (root.dataset.sig === sig) return;
  root.dataset.sig = sig;
  root.className = 'plm-tiers';
  root.replaceChildren();
  root.hidden = !input.anyTagged || !c?.decision || !c?.context;
  if (root.hidden || !c?.decision || !c.context) return;
  const d = c.decision;
  const x = c.context;
  const counts = el('p', 'plm-tiers-counts');
  const dec = el('span', 'plm-tiers-decision', `◆ ${d.lines} decision ${d.lines === 1 ? 'line' : 'lines'} (${d.issues} open)`);
  const ctx = el('span', 'plm-tiers-context', `${x.lines} context (${x.readForPeople} read for you, ${x.issues} open)`);
  counts.append(dec, ' · ', ctx);
  root.append(counts);
  const label = el('label', 'plm-tiers-only');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = input.onlyDecisions;
  box.onchange = () => input.toggle(box.checked);
  label.append(box, el('span', undefined, 'Show only decisions'));
  label.title = 'Folds the context lines that are not Issues for you (view only; nothing is marked). J / K and Next issue skip them anyway.';
  root.append(label);
}

const ONLY_DECISIONS_KEY = 'proof:only-decisions';

export function loadOnlyDecisions(): boolean {
  try { return localStorage.getItem(ONLY_DECISIONS_KEY) === '1'; } catch { return false; }
}

export function saveOnlyDecisions(on: boolean): void {
  try { localStorage.setItem(ONLY_DECISIONS_KEY, on ? '1' : '0'); } catch { /* optional */ }
}

export { TIER_POLICY };
