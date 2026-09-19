/**
 * Proof Documents `{do}` action lines — the control on the page (safe slice, 2026-09-18).
 *
 * Authorship: Claude Opus 5 (worker proof-do), after do-design.md §6 as corrected by
 * do-critique-astra.md.
 *
 * One control, used inline under the `{do}` line and in the mark box (right rail, phone sheet).
 * It shows a "Do" tag, the state, the operation's OWN consequence text and verified predicate
 * (never the author's words), the blast radius, who may approve, the approval if any, and:
 *   - Approve: only for a signed-in person named in `to` with Owner rights (the server checks again);
 *   - Revoke approval: for the approver or an Owner;
 *   - Run: DISABLED, labelled DO_POLICY.executionDisabledLabel ("Execution not enabled yet").
 */
import { actorKey, actorLabel } from '../shared/line-marks';
import { isVerifiedHumanActor } from '../shared/identity';
import { DO_POLICY, DO_STATE_LABEL, describeDo, type DoView } from '../shared/do';
import './do.css';

export interface DoControlOptions {
  actor: string;
  /** The viewer holds Owner rights (the server says so in the poll). */
  isOwner: boolean;
  /** Where the control lives: 'inline' (under the line) or 'box' (rail / sheet). */
  place: 'inline' | 'box';
  approve(): Promise<boolean>;
  revoke(): Promise<boolean>;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const RADIUS_LABEL: Record<string, string> = {
  'read-only': 'Read-only',
  reversible: 'Reversible',
  irreversible: 'Irreversible',
};

/** Signature of everything the control shows (decorations rebuild only when it changes). */
export function doControlSignature(view: DoView, actor: string, isOwner: boolean): string {
  return JSON.stringify([
    view.record.id, view.state, view.digest, view.approval?.id ?? null, view.approval?.revokedAt ?? null, view.approvalCurrent,
    view.record.to, view.lineHash, view.consequence, actorKey(actor), isOwner, DO_POLICY.executionEnabled,
  ]);
}

/** Can this viewer approve (a UI hint only: the server decides)? */
export function viewerMayApprove(view: DoView, actor: string, isOwner: boolean): boolean {
  return view.state === 'proposed'
    && isVerifiedHumanActor(actor)
    && (!DO_POLICY.approverMustBeOwner || isOwner)
    && view.record.to.some(member => actorKey(member) === actorKey(actor));
}

export function buildDoControl(view: DoView, options: DoControlOptions): HTMLElement {
  const root = el('div', `pdo pdo-${options.place}`);
  root.dataset.doId = view.record.id;
  root.dataset.state = view.state;
  root.contentEditable = 'false';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Action on this line');

  const head = el('div', 'pdo-head');
  if (options.place === 'box') head.append(el('span', 'pdo-tag', 'Do'));
  const state = el('span', 'pdo-state', DO_STATE_LABEL[view.state]);
  state.setAttribute('role', 'status');
  head.append(state);
  if (view.blastRadius) head.append(el('span', 'pdo-radius', RADIUS_LABEL[view.blastRadius] ?? view.blastRadius));
  root.append(head);

  const consequence = el('p', 'pdo-consequence');
  consequence.append(el('strong', undefined, 'If run: '), document.createTextNode(view.consequence));
  root.append(consequence);
  if (view.predicate) {
    const predicate = el('p', 'pdo-predicate');
    predicate.append(el('strong', undefined, 'Done means: '), document.createTextNode(view.predicate));
    root.append(predicate);
  }
  root.append(el('p', 'pdo-meta', `Proposed by ${actorLabel(view.record.by)} · approval: ${view.record.to.map(actorLabel).join(', ') || 'nobody named'}`));

  if (view.approval) {
    const approval = el('p', 'pdo-approval');
    approval.dataset.stale = String(!view.approvalCurrent);
    approval.textContent = view.approvalCurrent
      ? `Approved by ${actorLabel(view.approval.by)}${DO_POLICY.approvalSingleUse ? ' (one run)' : ''}`
      : `Approved by ${actorLabel(view.approval.by)} before it changed: approve it again`;
    root.append(approval);
  }

  const buttons = el('div', 'pdo-buttons');
  const hint = el('p', 'pdo-hint');
  hint.hidden = true;
  hint.setAttribute('role', 'alert');
  const act = async (button: HTMLButtonElement, fn: () => Promise<boolean>) => {
    if (root.dataset.busy) return;
    root.dataset.busy = 'true';
    const ok = await fn();
    delete root.dataset.busy;
    if (!ok) { hint.hidden = false; hint.textContent = 'That did not go through. Reload and try again.'; button.focus({ preventScroll: true }); }
  };

  const mayApprove = viewerMayApprove(view, options.actor, options.isOwner);
  if (view.state === 'proposed') {
    const approve = el('button', 'pdo-btn', 'Approve');
    approve.type = 'button';
    approve.dataset.action = 'approve';
    approve.disabled = !mayApprove;
    approve.title = mayApprove ? 'Approve exactly this action (one run)' : 'Only a signed-in person named here, with Owner rights, can approve';
    approve.onclick = (event) => { event.preventDefault(); void act(approve, options.approve); };
    buttons.append(approve);
  }
  const mayRevoke = Boolean(view.approval && !view.approval.revokedAt)
    && (options.isOwner || actorKey(view.approval!.by) === actorKey(options.actor));
  if (mayRevoke && isVerifiedHumanActor(options.actor)) {
    const revoke = el('button', 'pdo-btn', 'Revoke approval');
    revoke.type = 'button';
    revoke.dataset.action = 'revoke';
    revoke.onclick = (event) => { event.preventDefault(); void act(revoke, options.revoke); };
    buttons.append(revoke);
  }
  const run = el('button', 'pdo-btn', DO_POLICY.executionEnabled ? 'Run' : DO_POLICY.executionDisabledLabel);
  run.type = 'button';
  run.dataset.action = 'run';
  // Safe slice: Run never works. It stays visible so the reader sees where it will be.
  run.disabled = true;
  run.setAttribute('aria-disabled', 'true');
  run.title = 'Running actions from a document is not enabled yet; approval is recorded but nothing is queued';
  buttons.append(run);
  root.append(buttons, hint);

  if (view.state === 'proposed' && !mayApprove) {
    root.append(el('p', 'pdo-note-line', isVerifiedHumanActor(options.actor)
      ? 'Only the people named above, with Owner rights, can approve.'
      : 'Only a signed-in person named above can approve. Sign in to approve.'));
  }
  return root;
}

/** The small "Do" tag at the start of the line. */
export function buildDoTag(view: DoView): HTMLElement {
  const tag = el('span', 'pdo-inline-tag', 'Do');
  tag.dataset.state = view.state;
  tag.contentEditable = 'false';
  tag.title = describeDo(view);
  tag.setAttribute('aria-label', `Do: ${describeDo(view)}`);
  return tag;
}
