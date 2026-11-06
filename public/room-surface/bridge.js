// Accord as a SOMA Room surface: the bridge between a room and the Accord it shows.
// Mike, 2026-11-05: room members are the Accord's participants, and the room's chat moves with
// the Accord. Rules: src/shared/room-surface.ts. Recommendations: docs/accord/room-surface.md.
//
// The bridge needs a room that offers this interface (what we are asking SOMA Rooms to expose on
// <soma-room>; StubRoom below implements it so the surface can be tried before Rooms ships it):
//
//   room.roomId, room.roomName, room.app
//   room.members()                  -> [{ kind: 'person'|'ai', id, name, email?, role: 'host'|'member'|'observer', sponsor? }]
//   room.messages({ after })        -> Promise<[{ seq, kind: 'person'|'ai'|'system', from?, name?, text, at }]>
//   event 'soma-room-members'       detail: { members }
//   event 'soma-room-message'       detail: { message }
//
// Prototype only: here the page holds the Accord key. In production the Rooms service would hold
// it server-side and push from there, as scripts/team-room-agenda.js already does with ACCORD_TOKEN.

export function connectRoomToAccord({ room, accord, fetchImpl = fetch.bind(globalThis), onError = () => {} }) {
  const base = accord.base.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json', 'x-share-token': accord.token };
  const url = (p) => `${base}/api/agent/${encodeURIComponent(accord.slug)}${p}`;
  let lastSeq = 0;
  let queue = [];
  let sending = null;
  let stopped = false;

  // Who the Accord records as having relayed a write: the room itself, not any one person in it.
  const by = accord.by || `room:${room.roomId}`;
  const post = async (path, body) => {
    const res = await fetchImpl(url(path), { method: 'POST', headers, body: JSON.stringify({ by, ...body }) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || `HTTP ${res.status}`), { status: res.status, body: json });
    return json;
  };

  async function flush() {
    while (sending) { await sending; }
    if (!queue.length || stopped) return;
    const batch = queue.splice(0, 200);
    sending = post('/room/messages', { roomId: room.roomId, messages: batch })
      .then((r) => { lastSeq = Math.max(lastSeq, ...batch.map((m) => m.seq)); return r; })
      .catch((e) => { queue.unshift(...batch); onError(e); })
      .finally(() => { sending = null; });
    await sending;
    if (queue.length) await flush();
  }

  const onMembers = (e) => { if (!stopped) post('/room/members', { members: e.detail.members }).catch(onError); };
  const onMessage = (e) => { if (stopped) return; queue.push(e.detail.message); void flush(); };

  async function start() {
    const bound = await post('/room/bind', { roomId: room.roomId, roomName: room.roomName, app: room.app ?? null, members: room.members() });
    room.addEventListener('soma-room-members', onMembers);
    room.addEventListener('soma-room-message', onMessage);
    // Catch up: everything the room already said while this Accord was not listening. A resend is a no-op.
    const backlog = await room.messages({ after: lastSeq });
    if (backlog.length) { queue.push(...backlog); await flush(); }
    return bound;
  }

  function stop() {
    stopped = true;
    room.removeEventListener('soma-room-members', onMembers);
    room.removeEventListener('soma-room-message', onMessage);
  }

  return { start, stop, flush, detach: () => { stop(); return post('/room/unbind', {}); } };
}

/** An in-page room with the interface above, for trying the surface without a live SOMA Room. */
export class StubRoom extends EventTarget {
  constructor({ roomId, roomName, app = 'accord-demo' }) {
    super();
    this.roomId = roomId; this.roomName = roomName; this.app = app;
    this._members = []; this._log = []; this._seq = 0;
  }
  members() { return this._members.map((m) => ({ ...m })); }
  async messages({ after = 0 } = {}) { return this._log.filter((m) => m.seq > after).map((m) => ({ ...m })); }
  join(member) {
    if (this._members.some((m) => m.kind === member.kind && m.id === member.id)) return;
    this._members.push({ role: 'member', ...member });
    this._emitMembers();
    this._system(`${member.name} joined.`);
  }
  leave(id) {
    const m = this._members.find((x) => x.id === id); if (!m) return;
    this._members = this._members.filter((x) => x.id !== id);
    this._emitMembers();
    this._system(`${m.name} left.`);
  }
  setRole(id, role) { const m = this._members.find((x) => x.id === id); if (m) { m.role = role; this._emitMembers(); } }
  say(id, text) {
    const m = this._members.find((x) => x.id === id); if (!m) throw new Error('not in the room');
    return this._append({ kind: m.kind, from: m.id, name: m.name, text });
  }
  _system(text) { this._append({ kind: 'system', text }); }
  _append(partial) {
    const message = { seq: ++this._seq, at: new Date().toISOString(), ...partial };
    this._log.push(message);
    this.dispatchEvent(new CustomEvent('soma-room-message', { detail: { message: { ...message } } }));
    return message;
  }
  _emitMembers() { this.dispatchEvent(new CustomEvent('soma-room-members', { detail: { members: this.members() } })); }
}

/**
 * The same interface over a real <soma-room> element, once SOMA Rooms exposes it. Today the
 * component fires only 'soma-room-proposal' and has no public members() or messages(), so this
 * adapter throws until it does (asked of @SR on 2026-11-05).
 */
export function somaRoomAdapter(el) {
  if (typeof el.members !== 'function' || typeof el.messages !== 'function') {
    throw new Error('This <soma-room> does not expose members() and messages() yet.');
  }
  return el; // the element itself is the EventTarget and carries roomId / roomName / app
}
