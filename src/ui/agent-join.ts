/** URL join (ac-220): one live request list feeds the notice and Share → AIs. */
import type { AgentJoinRequest } from '../shared/agent-join';
import './agent-join.css';

let slug = '';
let stream: EventSource | null = null;
let requests: AgentJoinRequest[] = [];
const subscribers = new Set<() => void>();
const busy = new Set<string>();
let error = '';
let connectionAttempt = 0;
const renderAll = () => { for (const render of subscribers) render(); };
const base = () => `/api/documents/${encodeURIComponent(slug)}/agent-joins`;

async function decide(id: string, decision: 'admit' | 'refuse') {
  if (busy.has(id)) return;
  busy.add(id); error = ''; renderAll();
  try {
    const response = await fetch(`${base()}/${encodeURIComponent(id)}/${decision}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || 'Could not answer the join request.');
    }
    requests = requests.filter(row => row.requestId !== id);
    // Add agent lists the new ordinary key when its dialog is reopened.
  } catch (reason) { error = reason instanceof Error ? reason.message : 'Could not answer the join request.'; }
  finally { busy.delete(id); renderAll(); }
}

export function mountAgentJoinPanel(host: HTMLElement): () => void {
  host.classList.add('agent-join-list');
  host.setAttribute('aria-label', 'AI join requests');
  const render = () => {
    host.replaceChildren();
    host.hidden = !requests.length && !error;
    for (const request of requests) {
      const row = document.createElement('div');
      row.className = 'agent-join-row'; row.dataset.requestId = request.requestId;
      const label = document.createElement('span');
      label.textContent = `${request.name} (${request.runtime}) asks to join · code ${request.code}`;
      row.append(label);
      for (const action of ['admit', 'refuse'] as const) {
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = action === 'admit' ? 'Admit' : 'Refuse';
        button.className = `agent-join-${action}`;
        button.disabled = busy.has(request.requestId);
        button.onclick = () => { void decide(request.requestId, action); };
        row.append(button);
      }
      host.append(row);
    }
    if (error) {
      const status = document.createElement('p'); status.setAttribute('role', 'alert');
      status.textContent = error; host.append(status);
    }
  };
  subscribers.add(render); render();
  return () => { subscribers.delete(render); host.replaceChildren(); };
}

/** Started once per shared document; reconnects use the current session cookie. */
export function startAgentJoinNotices(documentSlug: string | null): void {
  if (!documentSlug || (slug === documentSlug && stream)) return;
  stream?.close(); slug = documentSlug; requests = []; error = ''; renderAll();
  let notice = document.getElementById('agent-join-notices');
  if (!notice) {
    notice = document.createElement('aside'); notice.id = 'agent-join-notices';
    notice.setAttribute('aria-live', 'polite');
    document.body.append(notice);
    mountAgentJoinPanel(notice);
  }
  // Check permission before opening EventSource so readers do not reconnect forever on 403.
  const connectingSlug = slug;
  const attempt = ++connectionAttempt;
  void fetch(base()).then(async response => {
    if (connectingSlug !== slug || attempt !== connectionAttempt || !response.ok) return;
    const result = await response.json();
    if (attempt !== connectionAttempt) return;
    requests = result.requests ?? []; renderAll();
    stream = new EventSource(`${base()}/events`);
    stream.onmessage = event => {
      requests = (JSON.parse(event.data) as { requests: AgentJoinRequest[] }).requests;
      error = ''; renderAll();
    };
    stream.onerror = () => {
      if (stream?.readyState === EventSource.CLOSED) { requests = []; renderAll(); }
    };
    stream.addEventListener('denied', () => {
      stream?.close(); stream = null; requests = []; error = ''; renderAll();
    });
  }).catch(() => { /* A later editor initialization can retry. */ });
}

window.addEventListener('pagehide', () => { ++connectionAttempt; stream?.close(); stream = null; });
window.addEventListener('pageshow', event => { if (event.persisted) startAgentJoinNotices(slug); });
