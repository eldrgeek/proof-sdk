export interface AgentKey {
  tokenId: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function showAgentKeyDialog(actions: {
  create: (label: string) => Promise<AgentKey & { token: string }>;
  list: () => Promise<AgentKey[]>;
  revoke: (id: string) => Promise<void>;
  invite: (token: string) => string;
  copy: (text: string) => Promise<boolean>;
}): void {
  const existing = document.querySelector<HTMLDialogElement>('#agent-key-dialog');
  if (existing) { existing.focus(); return; }
  const opener = document.activeElement as HTMLElement | null;
  const dialog = document.createElement('dialog');
  dialog.id = 'agent-key-dialog';
  dialog.setAttribute('aria-labelledby', 'agent-key-title');
  dialog.style.cssText = 'margin:auto;width:520px;max-width:calc(100vw - 32px);max-height:85vh;overflow:auto;box-sizing:border-box;padding:24px;border:1px solid #d1d5db;border-radius:16px;background:#fff;color:#111827;box-shadow:0 20px 70px #0004;font:14px/1.5 system-ui;';
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
    <header style="display:flex;align-items:center;justify-content:space-between;gap:12px">
      <h2 id="agent-key-title" style="margin:0;font-size:20px">Add agent</h2>
      <button type="button" data-close aria-label="Close agent dialog">Close</button>
    </header>
    <p>The key lets your AI edit this document, and you can revoke it here at any time.</p>
    <form>
      <label for="agent-key-label">Agent name</label>
      <input id="agent-key-label" name="label" value="AI assistant" maxlength="80" required autocomplete="off">
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
  `;
  const form = dialog.querySelector('form')!;
  const label = dialog.querySelector<HTMLInputElement>('input')!;
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
      const rows = await actions.list();
      if (closed) return;
      keys.replaceChildren();
      if (rows.length === 0) keys.textContent = 'No agent keys yet.';
      for (const key of rows) {
        const row = document.createElement('div');
        row.className = 'key-row';
        const details = document.createElement('div');
        details.className = 'key-details';
        const name = document.createElement('strong');
        name.textContent = key.label;
        const dates = document.createElement('small');
        dates.textContent = `Created ${new Date(key.createdAt).toLocaleString()} · Last used ${key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : 'Never'}`;
        details.append(name, dates);
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
      const key = await actions.create(label.value.trim());
      if (closed) return;
      currentId = key.tokenId;
      instructions.value = actions.invite(key.token);
      invite.hidden = false;
      status.textContent = 'Key created. Copy the instructions to your AI.';
      await refresh();
    } catch {
      if (!closed) status.textContent = 'Could not create a key. Check your editing access, or wait a minute and try again.';
    } finally {
      create.disabled = false;
    }
  };
  copy.onclick = async () => {
    if (!instructions.value) return;
    const copied = await actions.copy(instructions.value);
    status.textContent = copied ? 'Instructions copied.' : 'Select and copy the instructions above.';
  };
  dialog.querySelector<HTMLButtonElement>('[data-close]')!.onclick = () => dialog.close();
  dialog.addEventListener('close', () => {
    closed = true;
    clearInvite();
    dialog.remove();
    opener?.focus();
  }, { once: true });
  document.body.appendChild(dialog);
  dialog.showModal();
  label.focus();
  void refresh();
}
