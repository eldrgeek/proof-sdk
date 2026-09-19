/**
 * Proof Documents — Familiar proxy marks in the page: "My Familiar" (in the rail's identity
 * header), the one-screen brief at the top of the right rail (Ratify all, Review the flagged, the
 * list of what the proxy covered, Undo), and on a phone a pill under the top bar that opens it.
 *
 * Authorship: Mike Wolf ruled Yes on 2026-09-19; built by Claude Opus 5 (worker proof-proxy).
 * Data and rules come from LineMarksUI (one poll) and src/shared/proxy-marks.ts.
 */
import { PROXY_POLICY, briefHeadline, flaggedWhy, HOLD_LABEL, type ProxyItem } from '../shared/proxy-marks';
import type { LineMarksUI } from './line-marks';
import './proxy-marks.css';

export interface ProxyMarksHost {
  lineMarks(): LineMarksUI;
  /** Ratify is an explicit action: commit the reading walk's provisional (scroll) accepts first. */
  beforeRatify?(): void;
  /** Moves the focus line (a line in the covered list was clicked). */
  focusLine?(lineIndex: number): void;
  /** Phones: open the right rail's sheet (where the brief sits). */
  openBrief?(): void;
}

const PHONE_QUERY = '(max-width: 700px)';
function isPhone(): boolean {
  try { return window.matchMedia(PHONE_QUERY).matches; } catch { return window.innerWidth <= 700; }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class ProxyMarksUI {
  /** "My Familiar: [select]" (the rail's identity header). */
  readonly familiarEl = el('div', 'ppx-familiar');
  /** The brief (top of the right rail). */
  readonly briefEl = el('section', 'ppx-brief');
  /** Phones: "Claude read 6 lines for you · Open" under the top bar. */
  readonly pillEl = el('div', 'ppx-pill');
  private familiarSig = '';
  private briefSig = '';
  private pillDismissed = false;
  private busy = false;
  /** The ratification this page made in this session (Undo). */
  private lastRatify: { id: string; count: number; familiar: string } | null = null;
  private message = '';
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly host: ProxyMarksHost) {
    this.briefEl.hidden = true;
    this.briefEl.setAttribute('aria-label', 'Your Familiar’s brief');
    this.familiarEl.hidden = true;
    this.pillEl.hidden = true;
    this.pillEl.setAttribute('role', 'status');
    try {
      const saved = JSON.parse(sessionStorage.getItem(this.undoKey()) || 'null');
      if (saved && typeof saved.id === 'string') this.lastRatify = saved;
    } catch { /* optional */ }
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.host.lineMarks().subscribe(() => this.render());
    if (this.pillEl.parentElement !== document.body) document.body.append(this.pillEl);
    this.render();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.pillEl.remove();
  }

  private undoKey(): string {
    return `proof:proxy-ratify:${location.pathname}`;
  }

  render(): void {
    this.renderFamiliar();
    this.renderBrief();
    this.renderPill();
  }

  // --------------------------------------------------------------------------
  // My Familiar
  // --------------------------------------------------------------------------

  private renderFamiliar(): void {
    const lm = this.host.lineMarks();
    const verified = lm.isVerifiedViewer();
    const choices = lm.familiarChoices();
    const current = lm.familiarBinding()?.familiar ?? '';
    const sig = JSON.stringify([verified, choices, current, this.busy]);
    if (sig === this.familiarSig) return;
    this.familiarSig = sig;
    this.familiarEl.replaceChildren();
    // Only a signed-in person has a Familiar; with no AI present there is nothing to choose.
    this.familiarEl.hidden = !verified || (choices.length === 0 && !current);
    if (this.familiarEl.hidden) return;
    const label = el('label', 'ppx-familiar-label');
    label.append(el('span', undefined, 'My Familiar: '));
    const select = el('select', 'ppx-familiar-select');
    select.setAttribute('aria-label', 'My Familiar: the AI that pre-marks lines for you (never counted until you ratify)');
    const none = el('option', undefined, 'none');
    none.value = '';
    select.append(none);
    for (const choice of choices) {
      const option = el('option', undefined, choice.label);
      option.value = choice.actor;
      select.append(option);
    }
    if (current && !choices.some(c => c.actor === current)) {
      const gone = el('option', undefined, `${lm.aiName(current)} (key revoked)`);
      gone.value = current;
      select.append(gone);
    }
    select.value = current;
    select.disabled = this.busy;
    select.onchange = async () => {
      this.busy = true;
      this.familiarSig = '';
      this.renderFamiliar();
      await lm.setFamiliar(select.value || null);
      this.busy = false;
      this.familiarSig = '';
      this.render();
    };
    label.append(select);
    this.familiarEl.append(label);
    this.familiarEl.title = 'Your Familiar is an AI with enough context to be your trusted advisor. It can pre-mark lines for you; none of its marks count as yours until you ratify them.';
  }

  // --------------------------------------------------------------------------
  // The brief
  // --------------------------------------------------------------------------

  private renderBrief(): void {
    const lm = this.host.lineMarks();
    const brief = lm.proxyBrief();
    const walk = lm.flaggedWalk();
    const undoable = this.lastRatify && lm.undoableRatifications().some(r => r.id === this.lastRatify!.id) ? this.lastRatify : null;
    const sig = JSON.stringify([
      brief ? [brief.familiar, brief.counts, brief.items.map(i => [i.proxy.id, i.bucket, i.lineIndex])] : null,
      walk, undoable?.id ?? null, this.busy, this.message,
    ]);
    if (sig === this.briefSig) return;
    this.briefSig = sig;
    this.briefEl.replaceChildren();
    const show = Boolean(brief && (brief.counts.read > 0 || undoable || this.message));
    this.briefEl.hidden = !show;
    if (!brief || !show) return;
    const familiar = lm.aiName(brief.familiar ?? '');
    this.briefEl.dataset.read = String(brief.counts.read);
    const head = el('p', 'ppx-headline');
    head.append(el('strong', undefined, briefHeadline(brief, familiar)));
    this.briefEl.append(head);
    this.briefEl.append(el('p', 'ppx-note', 'Its marks are not yours until you ratify them. Every one carries its evidence.'));

    const actions = el('div', 'ppx-actions');
    if (brief.ratify.length > 0) {
      const ratify = el('button', 'ppx-ratify', `Ratify all ${brief.ratify.length}`);
      ratify.type = 'button';
      ratify.disabled = this.busy;
      ratify.title = `Makes these ${brief.ratify.length} lines your Agreed, recorded as ratified from ${familiar} with its evidence and confidence (each at least ${PROXY_POLICY.ratifyThreshold}).`;
      ratify.onclick = () => { void this.ratifyAll(familiar); };
      actions.append(ratify);
    }
    if (brief.flagged.length > 0 && !walk) {
      const review = el('button', 'ppx-review', `Review the ${brief.flagged.length} flagged`);
      review.type = 'button';
      review.onclick = () => { lm.reviewFlagged(); if (isPhone()) this.host.openBrief?.(); };
      actions.append(review);
    }
    if (walk) {
      const status = el('span', 'ppx-walk', `Reviewing flagged: ${walk.visited} of ${walk.total}`);
      const next = el('button', 'ppx-walk-next', walk.visited >= walk.total ? 'Done' : 'Next flagged');
      next.type = 'button';
      next.onclick = () => lm.gotoNextIssue();
      const stop = el('button', 'ppx-walk-stop', 'Stop');
      stop.type = 'button';
      stop.onclick = () => lm.stopReviewFlagged();
      actions.append(status, next, stop);
    }
    if (actions.childElementCount) this.briefEl.append(actions);

    if (undoable) {
      const done = el('div', 'ppx-done');
      done.setAttribute('role', 'status');
      done.append(el('span', undefined, `Ratified ${undoable.count} ${undoable.count === 1 ? 'line' : 'lines'} as Agreed (from ${lm.aiName(undoable.familiar)}).`));
      const undo = el('button', 'ppx-undo', 'Undo');
      undo.type = 'button';
      undo.disabled = this.busy;
      undo.onclick = () => { void this.undo(); };
      done.append(undo);
      this.briefEl.append(done);
    }
    if (this.message) this.briefEl.append(el('p', 'ppx-message', this.message));

    // The ringer list (MDP): name every line the one click would cover, with its evidence.
    if (brief.ratify.length) this.briefEl.append(this.itemList(`What ${familiar} covered: ${brief.ratify.length} to ratify`, brief.ratify, 'ratify', true));
    if (brief.flagged.length) this.briefEl.append(this.itemList(`Flagged for you (${brief.flagged.length})`, brief.flagged, 'flagged', true));
    if (brief.seen.length) this.briefEl.append(this.itemList(`Read, no position (${brief.seen.length}): these still need you`, brief.seen, 'seen', false));
  }

  private itemList(title: string, items: ProxyItem[], kind: string, open: boolean): HTMLElement {
    const details = el('details', 'ppx-list');
    details.dataset.kind = kind;
    details.open = open && items.length <= 6;
    details.append(el('summary', undefined, title));
    const list = el('ul');
    for (const item of items) {
      const li = el('li');
      const button = el('button', 'ppx-item');
      button.type = 'button';
      button.dataset.line = String(item.lineIndex);
      button.dataset.bucket = item.bucket;
      const line = this.host.lineMarks().lineList()[item.lineIndex];
      const text = line?.text ?? item.proxy.anchor.excerpt;
      button.append(el('span', 'ppx-item-text', text.length > 110 ? `${text.slice(0, 110)}…` : text));
      button.append(el('span', 'ppx-item-why', item.bucket === 'ratify' ? `confidence ${item.proxy.confidence}` : flaggedWhy(item)));
      button.append(el('span', 'ppx-item-evidence', `Evidence: ${item.proxy.evidence}`));
      if (item.held.length) button.title = `Held for you: ${item.held.map(h => HOLD_LABEL[h]).join(', ')}`;
      button.onclick = () => this.host.focusLine?.(item.lineIndex);
      li.append(button);
      list.append(li);
    }
    details.append(list);
    return details;
  }

  private async ratifyAll(familiar: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.message = '';
    this.render();
    try {
      this.host.beforeRatify?.();
      const result = await this.host.lineMarks().ratifyAll();
      if (result.ok && result.id) {
        this.lastRatify = { id: result.id, count: result.count, familiar: this.host.lineMarks().familiarBinding()?.familiar ?? familiar };
        try { sessionStorage.setItem(this.undoKey(), JSON.stringify(this.lastRatify)); } catch { /* optional */ }
        if (result.skipped > 0) this.message = `${result.skipped} changed since the brief and were left for you.`;
      }
    } finally {
      this.busy = false;
      this.briefSig = '';
      this.render();
    }
  }

  private async undo(): Promise<void> {
    const last = this.lastRatify;
    if (!last || this.busy) return;
    this.busy = true;
    this.render();
    try {
      const ok = await this.host.lineMarks().undoRatification(last.id);
      if (ok) {
        this.lastRatify = null;
        this.message = '';
        try { sessionStorage.removeItem(this.undoKey()); } catch { /* optional */ }
      }
    } finally {
      this.busy = false;
      this.briefSig = '';
      this.render();
    }
  }

  // --------------------------------------------------------------------------
  // Phone pill
  // --------------------------------------------------------------------------

  private renderPill(): void {
    const brief = this.host.lineMarks().proxyBrief();
    const show = isPhone() && !this.pillDismissed && Boolean(brief && brief.counts.read > 0)
      && !document.querySelector('.prw-right.prw-sheet-open');
    this.pillEl.hidden = !show;
    if (!show || !brief) return;
    const familiar = this.host.lineMarks().aiName(brief.familiar ?? '');
    const sig = `${familiar}|${JSON.stringify(brief.counts)}`;
    if (this.pillEl.dataset.sig === sig) return;
    this.pillEl.dataset.sig = sig;
    this.pillEl.replaceChildren();
    const text = el('span', 'ppx-pill-text', `${familiar} read ${brief.counts.read} for you: ${brief.counts.agreed} to ratify`);
    const open = el('button', 'ppx-pill-open', 'Open');
    open.type = 'button';
    open.onclick = () => { this.pillDismissed = true; this.pillEl.hidden = true; this.host.openBrief?.(); };
    const close = el('button', 'ppx-pill-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.onclick = () => { this.pillDismissed = true; this.pillEl.hidden = true; };
    this.pillEl.append(text, open, close);
  }

  debugState(): Record<string, unknown> {
    return {
      briefHidden: this.briefEl.hidden,
      familiarHidden: this.familiarEl.hidden,
      pillHidden: this.pillEl.hidden,
      lastRatify: this.lastRatify,
      message: this.message,
    };
  }
}
