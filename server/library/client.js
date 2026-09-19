(() => {
  'use strict';

  const state = { filter: 'all', sort: 'edited', query: '', documents: [], focused: -1, renameSlug: null, mode: 'blank' };
  const list = document.getElementById('document-list');
  const empty = document.getElementById('empty');
  const search = document.getElementById('search');
  const sort = document.getElementById('sort');
  const accountMenu = document.getElementById('account-menu');
  const avatar = document.getElementById('avatar');
  const newDialog = document.getElementById('new-dialog');
  const renameDialog = document.getElementById('rename-dialog');
  const peopleDialog = document.getElementById('people-dialog');
  const deviceDialog = document.getElementById('device-dialog');
  const somaEnabled = document.body.dataset.soma === '1';
  // Invite person: an invited person sees only their documents and does not manage them.
  const invitedOnly = document.body.dataset.scope === 'invited';
  const LINK_ACCESS = {
    edit: 'Link copied. Anyone with this link can read and edit.',
    comment: 'Link copied. Anyone with this link can read and comment; editing and marking need signing in.',
    private: 'Link copied. Only invited people and team members can open it.',
  };
  const isOwner = document.body.dataset.owner === '1';
  let searchTimer = 0;

  const api = async (path, options = {}) => {
    const headers = { ...(options.body === undefined ? {} : { 'Content-Type': 'application/json', Origin: location.origin }), ...options.headers };
    const response = await fetch(path, { ...options, headers });
    if (response.status === 401) {
      location.reload();
      throw new Error('Signed out');
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || 'Something went wrong.');
    return payload;
  };

  const relativeTime = (iso) => {
    const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (seconds < 45) return 'just now';
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} hr ago`;
    if (seconds < 604800) return `${Math.round(seconds / 86400)} day${seconds < 172800 ? '' : 's'} ago`;
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }).format(new Date(iso));
  };

  const toast = (message, action) => {
    const node = document.createElement('div');
    node.className = 'toast';
    const text = document.createElement('span');
    text.textContent = message;
    node.append(text);
    if (action) {
      const button = document.createElement('button');
      button.textContent = action.label;
      button.addEventListener('click', async () => {
        node.remove();
        await action.run();
      });
      node.append(button);
    }
    document.getElementById('toasts').append(node);
    window.setTimeout(() => node.remove(), action ? 6000 : 3500);
  };

  const copy = async (value, message = 'Copied.') => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const input = document.createElement('textarea');
      input.value = value;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.append(input);
      input.select();
      document.execCommand('copy');
      input.remove();
    }
    toast(message);
  };

  const addSnippet = (container, doc) => {
    if (!doc.snippet) return;
    const paragraph = document.createElement('p');
    paragraph.className = 'snippet';
    const start = Math.max(0, Math.min(doc.snippet.length, doc.matchStart || 0));
    const end = Math.max(start, Math.min(doc.snippet.length, doc.matchEnd || start));
    paragraph.append(document.createTextNode(doc.snippet.slice(0, start)));
    const mark = document.createElement('mark');
    mark.textContent = doc.snippet.slice(start, end);
    paragraph.append(mark, document.createTextNode(doc.snippet.slice(end)));
    container.append(paragraph);
  };

  const closeRowMenus = (except) => {
    document.querySelectorAll('.row-menu[open]').forEach((menu) => {
      if (menu !== except) menu.removeAttribute('open');
    });
  };

  const openRename = (doc) => {
    state.renameSlug = doc.slug;
    document.getElementById('rename-title').value = doc.title;
    document.getElementById('rename-error').textContent = '';
    renameDialog.showModal();
    document.getElementById('rename-title').focus();
    document.getElementById('rename-title').select();
  };

  const archive = async (doc, archived) => {
    await api(`/library/api/documents/${encodeURIComponent(doc.slug)}`, {
      method: 'PATCH',
      body: JSON.stringify({ archived }),
    });
    await loadDocuments();
    if (archived) {
      toast('Document archived.', {
        label: 'Undo',
        run: async () => {
          await api(`/library/api/documents/${encodeURIComponent(doc.slug)}`, {
            method: 'PATCH',
            body: JSON.stringify({ archived: false }),
          });
          await loadDocuments();
        },
      });
    } else {
      toast('Document restored.');
    }
  };

  const actionButton = (label, run) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      closeRowMenus();
      run();
    });
    return button;
  };

  const render = (payload) => {
    state.documents = payload.documents;
    state.focused = Math.min(state.focused, state.documents.length - 1);
    list.replaceChildren();
    empty.hidden = true;
    document.getElementById('document-count').textContent = String(payload.documents.length);
    document.querySelectorAll('.chip').forEach((chip) => {
      const filter = chip.dataset.filter;
      chip.setAttribute('aria-pressed', filter === state.filter ? 'true' : 'false');
      chip.querySelector('span').textContent = String(payload.counts[filter] || 0);
    });

    for (const [index, doc] of state.documents.entries()) {
      const item = document.createElement('li');
      item.className = `document-row${index === state.focused ? ' keyboard-focus' : ''}`;
      item.dataset.slug = doc.slug;
      item.tabIndex = -1;
      const info = document.createElement('div');
      const title = document.createElement('a');
      title.className = `doc-title${doc.updatedSinceYouLooked ? ' unread' : ''}`;
      title.href = `/d/${encodeURIComponent(doc.slug)}`;
      title.textContent = doc.title;
      info.append(title);
      if (doc.updatedSinceYouLooked) {
        const dot = document.createElement('span');
        dot.className = 'changed-dot';
        dot.title = 'Changed since you last opened it';
        info.append(dot);
      }
      const meta = document.createElement('div');
      meta.className = 'metadata';
      const edited = document.createElement('span');
      edited.textContent = `Edited ${relativeTime(doc.updatedAt)} · Created by ${doc.createdBy}`;
      meta.append(edited);
      if (doc.pendingSuggestions) {
        const signal = document.createElement('span');
        signal.className = 'signal';
        signal.textContent = `${doc.pendingSuggestions} suggestion${doc.pendingSuggestions === 1 ? '' : 's'}`;
        signal.title = Object.entries(doc.suggestionsBy).map(([by, count]) => `${by}: ${count}`).join(' · ');
        meta.append(signal);
      }
      if (doc.openComments) {
        const signal = document.createElement('span');
        signal.className = 'signal';
        signal.textContent = `${doc.openComments} comment${doc.openComments === 1 ? '' : 's'}`;
        meta.append(signal);
      }
      info.append(meta);
      addSnippet(info, doc);

      const actions = document.createElement('div');
      actions.className = 'row-actions';
      const copyButton = actionButton('Copy link', () => copy(
        `${location.origin}/d/${encodeURIComponent(doc.slug)}`,
        LINK_ACCESS[doc.guestAccess] || LINK_ACCESS.edit,
      ));
      copyButton.className = 'btn copy-visible';
      actions.append(copyButton);
      const details = document.createElement('details');
      details.className = 'row-menu';
      details.addEventListener('toggle', () => { if (details.open) closeRowMenus(details); });
      const summary = document.createElement('summary');
      summary.className = 'btn icon-btn';
      summary.setAttribute('aria-label', `Actions for ${doc.title}`);
      summary.textContent = '⋯';
      const menu = document.createElement('div');
      menu.className = 'row-menu-popover';
      const open = document.createElement('a');
      open.href = `/d/${encodeURIComponent(doc.slug)}`;
      open.target = '_blank';
      open.rel = 'noopener';
      open.textContent = 'Open in new tab';
      menu.append(
        open,
        actionButton('Copy link', () => copy(`${location.origin}/d/${encodeURIComponent(doc.slug)}`, LINK_ACCESS[doc.guestAccess] || LINK_ACCESS.edit)),
      );
      if (!invitedOnly) {
        menu.append(
          actionButton('Rename', () => openRename(doc)),
          actionButton(doc.archived ? 'Restore' : 'Archive', () => archive(doc, !doc.archived)),
        );
      }
      details.append(summary, menu);
      actions.append(details);
      item.append(info, actions);
      item.addEventListener('click', (event) => {
        if (event.target.closest('button, a, summary, details')) return;
        location.href = title.href;
      });
      list.append(item);
    }

    if (!state.documents.length) {
      empty.hidden = false;
      const heading = document.createElement('h2');
      const text = document.createElement('p');
      if (state.query) {
        heading.textContent = `No documents match “${state.query}”.`;
        const clear = document.createElement('button');
        clear.className = 'btn';
        clear.textContent = 'Clear search';
        clear.addEventListener('click', () => {
          search.value = '';
          state.query = '';
          loadDocuments();
        });
        empty.replaceChildren(heading, clear);
        return;
      }
      if (state.filter === 'archived') {
        heading.textContent = 'Nothing archived.';
        text.textContent = 'Archived documents keep working at their links; they only leave this list.';
      } else if (state.filter === 'review') {
        heading.textContent = 'Nothing waiting for review.';
      } else if (invitedOnly) {
        heading.textContent = 'No documents are shared with you right now.';
        text.textContent = 'When someone invites you to a document, it appears here.';
      } else {
        heading.textContent = 'No documents yet.';
        const create = document.createElement('button');
        create.className = 'btn primary';
        create.textContent = 'New document';
        create.addEventListener('click', openNew);
        empty.replaceChildren(heading, create);
        return;
      }
      empty.replaceChildren(heading, text);
    }
  };

  async function loadDocuments() {
    const params = new URLSearchParams({ filter: state.filter, sort: state.sort });
    if (state.query) params.set('q', state.query);
    try {
      render(await api(`/library/api/documents?${params}`));
    } catch (error) {
      empty.hidden = false;
      empty.textContent = error.message;
    }
  }

  const setMode = (mode) => {
    state.mode = mode;
    document.querySelectorAll('[data-mode]').forEach((button) => button.setAttribute('aria-pressed', button.dataset.mode === mode ? 'true' : 'false'));
    document.getElementById('paste-panel').hidden = mode !== 'paste';
    document.getElementById('upload-panel').hidden = mode !== 'upload';
  };

  function openNew(mode = 'blank', file) {
    document.getElementById('new-form').reset();
    document.getElementById('new-error').textContent = '';
    document.getElementById('file-name').textContent = '';
    setMode(mode);
    newDialog.showModal();
    if (file) readFile(file);
    else document.getElementById('new-title').focus();
  }

  const titleFromMarkdown = (markdown) => markdown.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() || '';
  const readFile = async (file) => {
    if (!/\.(md|markdown|txt)$/i.test(file.name)) {
      document.getElementById('new-error').textContent = 'Choose a .md, .markdown or .txt file.';
      return;
    }
    const markdown = await file.text();
    document.getElementById('markdown').value = markdown;
    document.getElementById('file-name').textContent = file.name;
    const titleInput = document.getElementById('new-title');
    if (!titleInput.value.trim()) titleInput.value = titleFromMarkdown(markdown) || file.name.replace(/\.(md|markdown|txt)$/i, '');
  };

  document.getElementById('new-document').addEventListener('click', () => openNew());
  document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
  document.getElementById('file-input').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) readFile(file);
  });
  document.getElementById('new-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = document.getElementById('create-button');
    const error = document.getElementById('new-error');
    button.disabled = true;
    error.textContent = '';
    try {
      const title = document.getElementById('new-title').value.trim() || 'Untitled document';
      const markdown = state.mode === 'blank' ? undefined : document.getElementById('markdown').value;
      const created = await api('/library/api/documents', { method: 'POST', body: JSON.stringify({ title, ...(markdown === undefined ? {} : { markdown }) }) });
      location.href = created.url;
    } catch (failure) {
      error.textContent = failure.message;
      button.disabled = false;
    }
  });

  document.getElementById('rename-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = document.getElementById('rename-error');
    try {
      await api(`/library/api/documents/${encodeURIComponent(state.renameSlug)}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: document.getElementById('rename-title').value }),
      });
      renameDialog.close();
      await loadDocuments();
    } catch (failure) {
      error.textContent = failure.message;
    }
  });

  avatar.addEventListener('click', () => {
    accountMenu.hidden = !accountMenu.hidden;
    avatar.setAttribute('aria-expanded', accountMenu.hidden ? 'false' : 'true');
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.menu-wrap')) {
      accountMenu.hidden = true;
      avatar.setAttribute('aria-expanded', 'false');
    }
    if (!event.target.closest('.row-menu')) closeRowMenus();
  });
  document.getElementById('signout-button').addEventListener('click', async () => {
    await api('/library/api/signout', { method: 'POST', body: '{}' });
    if (somaEnabled && window.SomaAuth) await window.SomaAuth.signOut();
    location.replace(somaEnabled ? '/?signedout=1' : '/');
  });

  const loadPeople = async () => {
    const payload = await api('/library/api/people');
    const peopleList = document.getElementById('people-list');
    peopleList.replaceChildren();
    for (const person of payload.people) {
      const item = document.createElement('li');
      item.className = 'person';
      const info = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'person-name';
      name.textContent = person.name;
      if (person.isOwner) {
        const ownerTag = document.createElement('span');
        ownerTag.className = 'owner-tag';
        ownerTag.textContent = somaEnabled ? 'admin' : 'owner';
        name.append(' ', ownerTag);
      }
      const meta = document.createElement('div');
      meta.className = 'person-meta';
      meta.textContent = [
        person.email,
        person.invitedByName ? `Added by ${person.invitedByName}` : 'Initial member',
        person.lastActiveAt ? `Active ${relativeTime(person.lastActiveAt)}` : 'Not signed in yet',
      ].join(' · ');
      info.append(name, meta);
      item.append(info);
      if (isOwner && !person.isOwner) {
        const remove = actionButton('Remove', async () => {
          if (!confirm(`Remove ${person.name}? They are signed out everywhere. The documents they made stay.`)) return;
          await api(`/library/api/people/${encodeURIComponent(person.id)}/remove`, { method: 'POST', body: '{}' });
          await loadPeople();
        });
        remove.className = 'btn';
        item.append(remove);
      }
      peopleList.append(item);
    }
  };

  document.getElementById('people-button').addEventListener('click', async () => {
    accountMenu.hidden = true;
    document.getElementById('invite-form').hidden = somaEnabled && !isOwner;
    document.getElementById('invite-result').hidden = true;
    peopleDialog.showModal();
    await loadPeople();
  });
  document.getElementById('invite-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = document.getElementById('invite-name').value.trim();
    const error = document.getElementById('invite-error');
    error.textContent = '';
    try {
      const invited = await api('/library/api/people', {
        method: 'POST',
        body: JSON.stringify({ name, email: document.getElementById('invite-email').value }),
      });
      document.getElementById('invite-link').value = invited.link || '';
      document.getElementById('invite-help').textContent = somaEnabled ? `${name} can now sign in with SOMA Auth using that email.` : `Send this link to ${name}. It signs them in on one device, works once, and expires in 7 days.`;
      document.getElementById('invite-form').hidden = true;
      document.getElementById('invite-result').hidden = false;
      await loadPeople();
    } catch (failure) {
      error.textContent = failure.message;
    }
  });
  document.getElementById('copy-invite').addEventListener('click', () => copy(document.getElementById('invite-link').value));

  document.getElementById('device-button')?.addEventListener('click', async () => {
    accountMenu.hidden = true;
    document.getElementById('device-link').value = '';
    document.getElementById('device-error').textContent = '';
    deviceDialog.showModal();
    try {
      const result = await api('/library/api/device-link', { method: 'POST', body: '{}' });
      document.getElementById('device-link').value = result.link;
    } catch (error) {
      document.getElementById('device-error').textContent = error.message;
    }
  });
  document.getElementById('copy-device')?.addEventListener('click', () => copy(document.getElementById('device-link').value));
  document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
  document.querySelectorAll('[value="cancel"]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));

  document.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => {
    state.filter = chip.dataset.filter;
    loadDocuments();
  }));
  sort.addEventListener('change', () => {
    state.sort = sort.value;
    loadDocuments();
  });
  search.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.query = search.value.trim();
      loadDocuments();
    }, 180);
  });

  document.addEventListener('keydown', (event) => {
    const typing = event.target.matches('input, textarea, select, [contenteditable="true"]');
    if (event.key === '/' && !typing) {
      event.preventDefault();
      search.focus();
      return;
    }
    if (event.key === 'Escape' && document.activeElement === search && search.value) {
      search.value = '';
      state.query = '';
      loadDocuments();
      return;
    }
    if (event.key.toLowerCase() === 'n' && !typing && !document.querySelector('dialog[open]')) {
      event.preventDefault();
      openNew();
      return;
    }
    if (!typing && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      if (!state.documents.length) return;
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      state.focused = Math.max(0, Math.min(state.documents.length - 1, state.focused + delta));
      document.querySelectorAll('.document-row').forEach((row, index) => row.classList.toggle('keyboard-focus', index === state.focused));
      document.querySelectorAll('.document-row')[state.focused]?.scrollIntoView({ block: 'nearest' });
    } else if (!typing && event.key === 'Enter' && state.focused >= 0) {
      location.href = `/d/${encodeURIComponent(state.documents[state.focused].slug)}`;
    }
  });

  document.addEventListener('dragover', (event) => {
    if ([...(event.dataTransfer?.items || [])].some((item) => item.kind === 'file')) event.preventDefault();
  });
  document.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    event.preventDefault();
    openNew('upload', file);
  });
  window.addEventListener('focus', loadDocuments);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadDocuments(); });
  window.setInterval(() => { if (!document.hidden) loadDocuments(); }, 60000);
  loadDocuments();
})();
