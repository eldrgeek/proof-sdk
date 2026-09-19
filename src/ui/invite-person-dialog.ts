/**
 * Invite person (2026-09-19): the Owner's dialog for one document's people. Invite by email
 * (optional name), see who was invited and whether they joined, copy an invite link (not a
 * credential: it opens the document only for the invited address after sign-in), remove a person,
 * and choose what people who are not signed in may do. Same shape as agent-key-dialog.ts.
 *
 * Authorship: Claude Opus 5 (worker proof-invite), 2026-09-19.
 */

export interface TeamInvite {
  id: string;
  name: string;
  email: string;
  status: 'invited' | 'joined';
  createdAt: string;
  joinedAt: string | null;
  lastSeenAt: string | null;
  lastSentAt: string | null;
  link: string;
}

export interface TeamState {
  guestAccess: string;
  guestAccessOptions: Array<{ mode: string; label: string }>;
  invites: TeamInvite[];
  mail: { transport: string };
}

export interface InviteResult {
  invite: TeamInvite;
  created: boolean;
  alreadyMember: boolean;
  email: { sent: boolean; transport: string; error?: string };
}

export function showInvitePersonDialog(actions: {
  load: () => Promise<TeamState>;
  invite: (email: string, name: string) => Promise<InviteResult>;
  resend: (id: string) => Promise<InviteResult>;
  remove: (id: string) => Promise<TeamState>;
  setGuestAccess: (mode: string) => Promise<TeamState>;
  copy: (text: string) => Promise<boolean>;
}): void {
  const existing = document.querySelector<HTMLDialogElement>('#invite-person-dialog');
  if (existing) { existing.focus(); return; }
  const opener = document.activeElement as HTMLElement | null;
  const dialog = document.createElement('dialog');
  dialog.id = 'invite-person-dialog';
  dialog.setAttribute('aria-labelledby', 'invite-person-title');
  dialog.style.cssText = 'margin:auto;width:540px;max-width:calc(100vw - 32px);max-height:88vh;overflow:auto;box-sizing:border-box;padding:24px;border:1px solid #d1d5db;border-radius:16px;background:#fff;color:#111827;box-shadow:0 20px 70px #0004;font:14px/1.5 system-ui;';
  dialog.innerHTML = `
    <style>
      #invite-person-dialog::backdrop { background: #0006; }
      #invite-person-dialog p { margin:10px 0; }
      #invite-person-dialog h3 { margin:20px 0 6px;font-size:15px; }
      #invite-person-dialog label { display:block;margin-bottom:6px;font-weight:600; }
      #invite-person-dialog button { font:inherit;cursor:pointer;border:1px solid #d1d5db;border-radius:8px;background:#f9fafb;color:#111827;padding:8px 12px;min-height:44px; }
      #invite-person-dialog button:disabled { opacity:.5;cursor:default; }
      #invite-person-dialog input[type=email], #invite-person-dialog input[type=text] { box-sizing:border-box;width:100%;font:inherit;padding:10px;border:1px solid #9ca3af;border-radius:8px;background:white;color:#111827;min-height:44px; }
      #invite-person-dialog .ip-field { margin-bottom:12px; }
      #invite-person-dialog .ip-row { display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 0;border-top:1px solid #e5e7eb; }
      #invite-person-dialog .ip-details { flex:1 1 220px;min-width:0;overflow-wrap:anywhere; }
      #invite-person-dialog .ip-actions { display:flex;gap:6px;flex-wrap:wrap; }
      #invite-person-dialog small { display:block;color:#4b5563; }
      #invite-person-dialog .ip-status { display:inline-block;margin-left:6px;padding:0 8px;border-radius:999px;background:#eef2ff;color:#3730a3;font-size:12px; }
      #invite-person-dialog .ip-status[data-status=joined] { background:#ecfdf5;color:#065f46; }
      #invite-person-dialog .ip-link { display:flex;gap:8px;margin-top:8px; }
      #invite-person-dialog .ip-link input { flex:1;min-width:0;box-sizing:border-box;font:inherit;padding:10px;border:1px solid #9ca3af;border-radius:8px;min-height:44px; }
      #invite-person-dialog .ip-guest label { display:flex;gap:10px;align-items:flex-start;font-weight:400;padding:8px 0;min-height:32px;cursor:pointer; }
      #invite-person-dialog .ip-guest input { margin-top:4px;width:18px;height:18px; }
    </style>
    <header style="display:flex;align-items:center;justify-content:space-between;gap:12px">
      <h2 id="invite-person-title" style="margin:0;font-size:20px">Invite person</h2>
      <button type="button" data-close aria-label="Close invite dialog">Close</button>
    </header>
    <p>The person joins this document only. They sign in with their email and see only the documents they were invited to.</p>
    <form data-invite-form>
      <div class="ip-field"><label for="invite-person-email">Email</label>
        <input id="invite-person-email" name="email" type="email" required autocomplete="off" inputmode="email" maxlength="254"></div>
      <div class="ip-field"><label for="invite-person-name">Name <span style="font-weight:400;color:#6b7280">(optional)</span></label>
        <input id="invite-person-name" name="name" type="text" autocomplete="off" maxlength="80"></div>
      <button type="submit" data-submit style="background:#111827;color:white">Invite</button>
    </form>
    <p data-status role="status" aria-live="polite"></p>
    <section data-result hidden>
      <label for="invite-person-link">Invite link</label>
      <div class="ip-link"><input id="invite-person-link" readonly><button type="button" data-copy-result>Copy invite link</button></div>
      <small data-result-note></small>
    </section>
    <h3>People invited to this document</h3>
    <div data-people>Loading…</div>
    <h3>People who are not signed in</h3>
    <div class="ip-guest" data-guest role="radiogroup" aria-label="People who are not signed in"></div>
  `;
  const form = dialog.querySelector<HTMLFormElement>('[data-invite-form]')!;
  const email = dialog.querySelector<HTMLInputElement>('#invite-person-email')!;
  const name = dialog.querySelector<HTMLInputElement>('#invite-person-name')!;
  const submit = dialog.querySelector<HTMLButtonElement>('[data-submit]')!;
  const status = dialog.querySelector<HTMLElement>('[data-status]')!;
  const result = dialog.querySelector<HTMLElement>('[data-result]')!;
  const resultLink = dialog.querySelector<HTMLInputElement>('#invite-person-link')!;
  const resultNote = dialog.querySelector<HTMLElement>('[data-result-note]')!;
  const people = dialog.querySelector<HTMLElement>('[data-people]')!;
  const guest = dialog.querySelector<HTMLElement>('[data-guest]')!;
  let closed = false;

  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');
  const copyLink = async (link: string) => {
    const ok = await actions.copy(link);
    status.textContent = ok ? 'Invite link copied. It opens the document only for the invited email, after they sign in.' : 'Select and copy the link.';
  };
  const mailNote = (res: InviteResult, who: string): string => {
    if (res.email.sent) return `Invitation emailed to ${who}.`;
    if (res.email.error) return `The email was not sent (${res.email.error}). Copy the invite link and send it yourself.`;
    return 'Email is not set up on this server. Copy the invite link and send it yourself.';
  };

  const render = (state: TeamState) => {
    if (closed) return;
    people.replaceChildren();
    if (state.invites.length === 0) people.textContent = 'Nobody invited yet.';
    for (const invite of state.invites) {
      const row = document.createElement('div');
      row.className = 'ip-row';
      row.dataset.inviteId = invite.id;
      const details = document.createElement('div');
      details.className = 'ip-details';
      const who = document.createElement('strong');
      who.textContent = invite.name;
      const badge = document.createElement('span');
      badge.className = 'ip-status';
      badge.dataset.status = invite.status;
      badge.textContent = invite.status === 'joined' ? 'joined' : 'invited';
      const meta = document.createElement('small');
      meta.textContent = invite.status === 'joined'
        ? `${invite.email} · last seen ${when(invite.lastSeenAt)}`
        : `${invite.email} · invited ${when(invite.createdAt)}${invite.lastSentAt ? ` · emailed ${when(invite.lastSentAt)}` : ''}`;
      details.append(who, badge, meta);
      const buttons = document.createElement('div');
      buttons.className = 'ip-actions';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = 'Copy invite link';
      copy.setAttribute('aria-label', `Copy invite link for ${invite.name}`);
      copy.onclick = () => { void copyLink(invite.link); };
      const resend = document.createElement('button');
      resend.type = 'button';
      resend.textContent = 'Resend';
      resend.setAttribute('aria-label', `Resend the invitation to ${invite.name}`);
      resend.hidden = state.mail.transport === 'none';
      resend.onclick = async () => {
        resend.disabled = true;
        try {
          const res = await actions.resend(invite.id);
          status.textContent = mailNote(res, invite.email);
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : 'Could not resend. Try again later.';
        } finally { resend.disabled = false; }
      };
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${invite.name}`);
      remove.onclick = async () => {
        remove.disabled = true;
        try {
          render(await actions.remove(invite.id));
          status.textContent = `${invite.name} was removed from this document. Their access ended now.`;
          if (resultLink.value === invite.link) result.hidden = true;
        } catch (error) {
          remove.disabled = false;
          status.textContent = error instanceof Error ? error.message : 'Could not remove. Try again.';
        }
      };
      buttons.append(copy, resend, remove);
      row.append(details, buttons);
      people.appendChild(row);
    }
    guest.replaceChildren();
    for (const option of state.guestAccessOptions) {
      const label = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'invite-person-guest-access';
      radio.value = option.mode;
      radio.checked = option.mode === state.guestAccess;
      radio.onchange = async () => {
        if (!radio.checked) return;
        guest.querySelectorAll('input').forEach(input => { input.disabled = true; });
        try {
          render(await actions.setGuestAccess(option.mode));
          status.textContent = `Saved: ${option.label.charAt(0).toLowerCase()}${option.label.slice(1)}.`;
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : 'Could not change the setting.';
          render(await actions.load().catch(() => state));
        }
      };
      const text = document.createElement('span');
      text.textContent = option.label;
      label.append(radio, text);
      guest.appendChild(label);
    }
  };

  const refresh = async () => {
    try { render(await actions.load()); } catch (error) {
      if (!closed) people.textContent = error instanceof Error ? error.message : 'Could not load. Close and reopen this dialog.';
    }
  };

  form.onsubmit = async event => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    status.textContent = 'Inviting…';
    try {
      const res = await actions.invite(email.value.trim(), name.value.trim());
      if (closed) return;
      resultLink.value = res.invite.link;
      result.hidden = false;
      resultNote.textContent = `The link opens this document only for ${res.invite.email}, after they sign in. You can send it by WhatsApp or text.`;
      status.textContent = `${res.created ? '' : 'Already invited. '}${mailNote(res, res.invite.email)}`;
      email.value = '';
      name.value = '';
      await refresh();
    } catch (error) {
      if (!closed) status.textContent = error instanceof Error ? error.message : 'Could not invite. Try again.';
    } finally {
      submit.disabled = false;
    }
  };
  dialog.querySelector<HTMLButtonElement>('[data-copy-result]')!.onclick = () => { if (resultLink.value) void copyLink(resultLink.value); };
  dialog.querySelector<HTMLButtonElement>('[data-close]')!.onclick = () => dialog.close();
  dialog.addEventListener('close', () => {
    closed = true;
    dialog.remove();
    opener?.focus();
  }, { once: true });
  document.body.appendChild(dialog);
  dialog.showModal();
  email.focus();
  void refresh();
}
