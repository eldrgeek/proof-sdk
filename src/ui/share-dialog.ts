/**
 * Accord layout stage 2, decision 12: one Share dialog that absorbs Invite person and Add agent
 * (the Docs convention). Three tabs:
 *   - Link: copy the link, who may open it without signing in (the guest setting), download, activity;
 *   - People: invite by email, nominations, attestations, provenance (src/ui/invite-person-dialog.ts);
 *   - AIs: add an agent key with its sponsor and runtime (src/ui/agent-key-dialog.ts).
 * Policies: src/shared/layout-chrome.ts SHARE_DIALOG_POLICY.
 *
 * Authorship: Mike Wolf (rulings), Ren (SOMA UI, the proposal), built by Claude Opus 5 (worker
 * accord-layout2), 2026-09-21.
 */
import { SHARE_DIALOG_POLICY, type ShareTab } from '../shared/layout-chrome';
import { mountAgentKeyPanel, type AgentKeyActions, type AgentKeyPanel } from './agent-key-dialog';
import { mountInvitePersonPanel, type InvitePersonActions, type InvitePersonPanel } from './invite-person-dialog';
import './chrome.css';

export interface ShareDialogHost {
  title: string;
  shareUrl: string;
  documentNoun: string;
  copyLink(): Promise<boolean>;
  download(): void;
  activity(): void;
  /** Accord layout stage 3: more document settings in the Link tab (blind marking). */
  linkExtras?: HTMLElement[];
  /** Present only for an Owner: inviting and the guest setting are an Owner's acts. */
  invite: InvitePersonActions | null;
  agents: AgentKeyActions;
}

export interface ShareDialogHandle {
  select(tab: ShareTab): void;
  close(): void;
}

let current: ShareDialogHandle | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Opens the Share dialog on `tab` (or moves an open one there). */
export function showShareDialog(host: ShareDialogHost, tab: ShareTab = 'link'): ShareDialogHandle {
  if (current && document.getElementById('share-dialog')) {
    current.select(tab);
    return current;
  }
  const opener = document.activeElement as HTMLElement | null;
  const dialog = el('dialog', 'asd-dialog');
  dialog.id = 'share-dialog';
  dialog.setAttribute('aria-labelledby', 'share-dialog-title');

  const header = el('header', 'asd-head');
  const heading = el('h2', 'asd-title', `Share “${host.title}”`);
  heading.id = 'share-dialog-title';
  const close = el('button', 'asd-close', 'Close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close share dialog');
  close.onclick = () => dialog.close();
  header.append(heading, close);

  const tablist = el('div', 'asd-tabs');
  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', 'Share');
  const panels = new Map<ShareTab, HTMLElement>();
  const tabs = new Map<ShareTab, HTMLButtonElement>();
  for (const spec of SHARE_DIALOG_POLICY.tabs) {
    const button = el('button', 'asd-tab', spec.label);
    button.type = 'button';
    button.id = `share-tab-${spec.id}`;
    button.dataset.tab = spec.id;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `share-panel-${spec.id}`);
    button.onclick = () => select(spec.id, true);
    tabs.set(spec.id, button);
    tablist.append(button);
    const panel = el('section', 'asd-panel');
    panel.id = `share-panel-${spec.id}`;
    panel.dataset.tab = spec.id;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    panels.set(spec.id, panel);
  }
  tablist.onkeydown = (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const order = SHARE_DIALOG_POLICY.tabs.map(t => t.id);
    const at = order.indexOf(selected);
    select(order[(at + (event.key === 'ArrowRight' ? 1 : -1) + order.length) % order.length], false);
    tabs.get(selected)?.focus();
  };

  // ---- Link ----
  const link = panels.get('link')!;
  link.append(el('p', 'asd-note', `Anyone who opens this link sees this ${host.documentNoun}. What they may do depends on the setting below.`));
  const row = el('div', 'asd-link-row');
  const url = el('input', 'asd-url');
  url.readOnly = true;
  url.value = host.shareUrl;
  url.setAttribute('aria-label', 'Link to this document');
  const copy = el('button', 'asd-primary asd-copy', 'Copy link');
  copy.type = 'button';
  const status = el('p', 'asd-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  copy.onclick = async () => {
    const ok = await host.copyLink();
    status.textContent = ok ? 'Link copied.' : 'Select the link above and copy it.';
    if (!ok) url.select();
  };
  row.append(url, copy);
  link.append(row, status);
  const guestHost = el('div', 'asd-guest');
  link.append(guestHost);
  if (!host.invite) link.append(el('p', 'asd-note', 'Only an Owner can change who may open it without signing in.'));
  const more = el('div', 'asd-more');
  const download = el('button', 'asd-btn', `Download as ${host.documentNoun} (.md)`);
  download.type = 'button';
  download.onclick = () => host.download();
  const activity = el('button', 'asd-btn', 'View activity');
  activity.type = 'button';
  activity.onclick = () => { dialog.close(); host.activity(); };
  more.append(download, activity);
  link.append(more);
  const extras = el('div', 'asd-link-extras');
  extras.append(...(host.linkExtras ?? []));
  if (extras.childElementCount) link.append(extras);

  // ---- People ----
  const people = panels.get('people')!;
  let invitePanel: InvitePersonPanel | null = null;
  if (host.invite) {
    const holder = el('div', 'asd-people');
    people.append(holder);
    invitePanel = mountInvitePersonPanel(holder, host.invite, { guestHost });
  } else {
    people.append(el('p', 'asd-note', 'Only an Owner can invite people to this document. You can add your own AI under AIs; it is bound to you.'));
  }

  // ---- AIs ----
  const ais = panels.get('ais')!;
  let agentPanel: AgentKeyPanel | null = null;
  const holderAi = el('div', 'asd-ais');
  ais.append(holderAi);

  let selected: ShareTab = tab;
  function select(next: ShareTab, focus: boolean): void {
    selected = next;
    for (const [id, button] of tabs) {
      const on = id === next;
      button.setAttribute('aria-selected', String(on));
      button.tabIndex = on ? 0 : -1;
      panels.get(id)!.hidden = !on;
    }
    // The key panel mounts when first shown: its one-time key lives only while the dialog is open.
    if (next === 'ais' && !agentPanel) agentPanel = mountAgentKeyPanel(holderAi, host.agents);
    if (!focus) return;
    if (next === 'people') invitePanel?.focus();
    else if (next === 'ais') agentPanel?.focus();
    else copy.focus();
  }

  dialog.append(header, tablist, ...panels.values());
  dialog.addEventListener('close', () => {
    invitePanel?.destroy();
    agentPanel?.destroy();
    dialog.remove();
    current = null;
    opener?.focus?.({ preventScroll: true });
  }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  select(tab, true);
  current = { select: (t: ShareTab) => select(t, true), close: () => dialog.close() };
  return current;
}
