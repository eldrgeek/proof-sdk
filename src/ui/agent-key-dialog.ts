export interface AgentKey {
  tokenId: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /**
   * Cross invitation (2026-09-19): the verified human who added this AI, what they said is
   * running it, and whether it is suspended because that person lost access to the document.
   */
  sponsor?: string | null;
  sponsorName?: string | null;
  runtime?: string | null;
  suspended?: boolean;
  provenance?: string | null;
}

export interface AgentKeyList {
  keys: AgentKey[];
  /** True where a key needs a sponsor and a declared runtime (every document with sign-in). */
  runtimeRequired: boolean;
  runtimeSuggestions: string[];
}

export interface AgentKeyActions {
  isSignedInMember: boolean;
  create: (label: string, runtime: string) => Promise<AgentKey & { token: string }>;
  list: () => Promise<AgentKeyList>;
  revoke: (id: string) => Promise<void>;
  invite: (token: string) => string;
  copy: (text: string) => Promise<boolean>;
}

/** A mounted Add agent panel. */
export interface AgentKeyPanel {
  focus(): void;
  destroy(): void;
}

/**
 * Fills `root` with the Add agent panel: the Share dialog's AIs tab (Accord layout stage 2,
 * decision 12). Closing the dialog destroys the panel, which forgets the one-time key.
 */
export function mountAgentKeyPanel(root: HTMLElement, actions: AgentKeyActions): AgentKeyPanel {
  const dialog = root;
  dialog.id = 'agent-key-dialog';
  dialog.setAttribute('aria-labelledby', 'agent-key-title');
  dialog.innerHTML = `
    <style>
      #agent-key-dialog::backdrop { background: #0006; }
      #agent-key-dialog p { margin:12px 0; }
      #agent-key-dialog h3 { margin-top:20px; }
      #agent-key-dialog label { display:block;margin-bottom:6px; }
      #agent-key-dialog button { font:inherit;cursor:pointer;border:1px solid #d1d5db;border-radius:8px;background:#f9fafb;color:#111827;padding:8px 12px;min-height:44px; }
      #agent-key-dialog button:disabled { opacity:.5;cursor:default; }
      #agent-key-dialog input, #agent-key-dialog textarea { box-sizing:border-box;width:100%;font:inherit;padding:10px;border:1px solid #9ca3af;border-radius:8px;background:white;color:#111827; }
      #agent-key-dialog .key-row { display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid #e5e7eb; }
      #agent-key-dialog .key-details { flex:1;min-width:0;overflow-wrap:anywhere; }
      #agent-key-dialog small { display:block;color:#4b5563; }
    </style>
    <h2 id="agent-key-title" style="margin:0;font-size:17px">Add agent</h2>
    <p>The key lets your AI edit this document, and you can revoke it here at any time. The AI is bound to you: everything it marks says “added by you”, and it goes quiet if you leave the document.</p>
    <form>
      <label for="agent-key-label">Agent name</label>
      <input id="agent-key-label" name="label" value="AI assistant" maxlength="80" required autocomplete="off">
      <label for="agent-key-runtime" style="margin-top:12px">What is running it? <span data-runtime-hint style="font-weight:400;color:#6b7280"></span></label>
      <input id="agent-key-runtime" name="runtime" maxlength="120" autocomplete="off" list="agent-key-runtimes" placeholder="Claude Opus 5 (Anthropic)">
      <datalist id="agent-key-runtimes"></datalist>
      <small style="margin-top:4px">Its model or operator, in your words. It is shown next to everything this AI does.</small>
      <button type="submit" style="margin-top:12px;background:#111827;color:white">Create agent key</button>
    </form>
    <p data-status role="status" aria-live="polite"></p>
    <section data-invite hidden>
      <label for="agent-key-instructions">Instructions to paste into your AI chat</label>
      <textarea id="agent-key-instructions" rows="8" readonly spellcheck="false"></textarea>
      <button type="button" data-copy style="margin-top:8px">Copy instructions</button>
      <small>Copy these now; the key cannot be shown again after you close this dialog.</small>
    </section>
    <h3 style="margin-bottom:4px;font-size:15px">Agent keys</h3>
    <div data-keys>Loading keys…</div>
    ${actions.isSignedInMember ? '' : '<p data-revocation-note>Revoking stops that key from working. While this document can be opened from its link without signing in, anyone who has the link can still edit it.</p>'}
  `;
  const form = dialog.querySelector('form')!;
  const label = dialog.querySelector<HTMLInputElement>('#agent-key-label')!;
  const runtime = dialog.querySelector<HTMLInputElement>('#agent-key-runtime')!;
  const runtimeHint = dialog.querySelector<HTMLElement>('[data-runtime-hint]')!;
  const runtimes = dialog.querySelector<HTMLDataListElement>('#agent-key-runtimes')!;
  const create = dialog.querySelector<HTMLButtonElement>('button[type=submit]')!;
  const status = dialog.querySelector<HTMLElement>('[data-status]')!;
  const invite = dialog.querySelector<HTMLElement>('[data-invite]')!;
  const instructions = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
  const copy = dialog.querySelector<HTMLButtonElement>('[data-copy]')!;
  const keys = dialog.querySelector<HTMLElement>('[data-keys]')!;
  let currentId: string | null = null;
  let closed = false;
  const clearInvite = () => { instructions.value = ''; invite.hidden = true; currentId = null; };
  const refresh = async () => {
    try {
      const listed = await actions.list();
      if (closed) return;
      const rows = listed.keys ?? [];
      runtime.required = listed.runtimeRequired === true;
      runtimeHint.textContent = listed.runtimeRequired === true ? '' : '(optional here)';
      runtimes.replaceChildren();
      for (const suggestion of listed.runtimeSuggestions ?? []) {
        const option = document.createElement('option');
        option.value = suggestion;
        runtimes.appendChild(option);
      }
      keys.replaceChildren();
      if (rows.length === 0) keys.textContent = 'No agent keys yet.';
      for (const key of rows) {
        const row = document.createElement('div');
        row.className = 'key-row';
        row.dataset.tokenId = key.tokenId;
        const details = document.createElement('div');
        details.className = 'key-details';
        const name = document.createElement('strong');
        name.textContent = key.label;
        // Cross invitation: who added this AI and what runs it, on the row itself.
        const who = document.createElement('small');
        who.className = 'key-sponsor';
        who.textContent = [
          key.sponsorName ? `Added by ${key.sponsorName}` : 'Added before AIs had sponsors',
          key.runtime ? `runs on ${key.runtime}` : null,
          key.suspended && !key.revokedAt ? 'suspended: the person who added it left this document' : null,
        ].filter(Boolean).join(' · ');
        const dates = document.createElement('small');
        dates.textContent = `Created ${new Date(key.createdAt).toLocaleString()} · Last used ${key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : 'Never'}`;
        details.append(name, who, dates);
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.textContent = key.revokedAt ? 'Revoked' : 'Revoke';
        revoke.disabled = Boolean(key.revokedAt);
        revoke.setAttribute('aria-label', `Revoke ${key.label}`);
        revoke.onclick = async () => {
          revoke.disabled = true;
          try {
            await actions.revoke(key.tokenId);
            if (closed) return;
            if (currentId === key.tokenId) clearInvite();
            status.textContent = 'Agent key revoked.';
            await refresh();
          } catch {
            revoke.disabled = false;
            status.textContent = 'Could not revoke the key. Please try again.';
          }
        };
        row.append(details, revoke);
        keys.appendChild(row);
      }
    } catch {
      if (!closed) keys.textContent = 'Could not load keys. Close and reopen this dialog to retry.';
    }
  };
  form.onsubmit = async event => {
    event.preventDefault();
    if (create.disabled) return;
    create.disabled = true;
    status.textContent = 'Creating key…';
    try {
      const key = await actions.create(label.value.trim(), runtime.value.trim());
      if (closed) return;
      currentId = key.tokenId;
      instructions.value = actions.invite(key.token);
      invite.hidden = false;
      status.textContent = 'Key created. Copy the instructions to your AI.';
      await refresh();
    } catch (error) {
      if (!closed) status.textContent = error instanceof Error && error.message
        ? error.message
        : 'Could not create a key. Check your editing access, or wait a minute and try again.';
    } finally {
      create.disabled = false;
    }
  };
  copy.onclick = async () => {
    if (!instructions.value) return;
    const copied = await actions.copy(instructions.value);
    status.textContent = copied ? 'Instructions copied.' : 'Select and copy the instructions above.';
  };
  void refresh();
  return {
    focus: () => label.focus(),
    destroy: () => { closed = true; clearInvite(); },
  };
}

/** Add agent on its own (kept for callers outside the Share dialog). */
export function showAgentKeyDialog(actions: AgentKeyActions): void {
  if (document.querySelector('#agent-key-dialog')) return;
  const opener = document.activeElement as HTMLElement | null;
  const dialog = document.createElement('dialog');
  dialog.className = 'ak-standalone';
  dialog.style.cssText = 'margin:auto;width:520px;max-width:calc(100vw - 32px);max-height:85vh;overflow:auto;box-sizing:border-box;padding:24px;border:1px solid #d1d5db;border-radius:16px;background:#fff;color:#111827;box-shadow:0 20px 70px #0004;font:14px/1.5 system-ui;';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.setAttribute('aria-label', 'Close agent dialog');
  close.style.cssText = 'float:right';
  const body = document.createElement('div');
  dialog.append(close, body);
  const panel = mountAgentKeyPanel(body, actions);
  close.onclick = () => dialog.close();
  dialog.addEventListener('close', () => { panel.destroy(); dialog.remove(); opener?.focus(); }, { once: true });
  document.body.appendChild(dialog);
  dialog.showModal();
  panel.focus();
}
