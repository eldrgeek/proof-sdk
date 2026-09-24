// Proof Documents Step B7 — chat beside the document: markdown-lite, mentions, unread, and the
// page and agent routes (post, read after a cursor, line pointers, a suggestion proposed from
// chat, Explain / Ask why mirrored into chat, events). Chat never changes the document's text.
// Authorship: Claude Opus 5 (worker proof-chat), 2026-09-19.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-chat-'));
process.env.DATABASE_PATH = path.join(temp, 'test.db');
Object.assign(process.env, { PROOF_ENV: 'test', PROOF_DB_ENV_INIT: 'test', PROOF_LIBRARY_ENABLED: '1' });
delete process.env.PROOF_SOMA_AUTH_ENABLED;
delete process.env.PROOF_PUBLIC_ORIGIN;

const shared = await import('../shared/line-marks');
const chat = await import('../shared/chat');
const db = await import('../../server/db');
const auth = await import('../../server/library/auth');
const serverLines = await import('../../server/line-marks');
const { apiRoutes } = await import('../../server/routes');
const { agentRoutes } = await import('../../server/agent-routes');

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const doc = `# Launch plan

We launch in the second quarter.

The budget is fixed at ten thousand.

Last line.`;

const app = express();
app.use(express.json());
app.use('/api', apiRoutes);
app.use('/api/agent', agentRoutes);
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const clientHeaders = { 'X-Proof-Client-Version': '0.33.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
const call = async (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...clientHeaders, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, body: await response.json() as Record<string, any> };
};

try {
  // ------------------------------------------------------------------ pure
  await test('markdown-lite: code, bold, links (http/https only), bare URLs, mentions; nothing else is markup', () => {
    const segs = chat.tokenizeChat('See `x < y` and **this**, [docs](https://example.com/a) or https://example.com/b. @Claude COS, <b>no</b> [bad](javascript:alert(1))', ['Claude COS']);
    const types = segs.map(s => s.type);
    assert.deepEqual(types.filter(t => t !== 'text'), ['code', 'bold', 'link', 'link', 'mention']);
    const links = segs.filter(s => s.type === 'link') as Array<{ href: string; text: string }>;
    assert.equal(links[0].href, 'https://example.com/a');
    assert.equal(links[1].text, 'https://example.com/b', 'the trailing full stop is not part of the URL');
    const text = segs.filter(s => s.type === 'text').map(s => s.text).join('');
    assert.match(text, /<b>no<\/b>/, 'HTML stays text');
    assert.match(text, /\[bad\]\(javascript:alert\(1\)\)/, 'a javascript: link stays text');
    assert.equal(chat.safeHref('javascript:alert(1)'), null);
  });

  await test('mentions: longest name wins, word boundaries, each actor once; the composer query at the caret', () => {
    const cands = [
      { actor: 'ai:claude-cos', names: chat.mentionNamesFor('ai:claude-cos', 'Claude COS') },
      { actor: 'human:mw@mike-wolf.com', names: chat.mentionNamesFor('human:mw@mike-wolf.com', 'Mike Wolf') },
      { actor: 'guest:Ann', names: chat.mentionNamesFor('guest:Ann', 'Ann (guest)') },
    ];
    assert.deepEqual(cands[0].names, ['Claude COS', 'claude-cos', 'claude cos']);
    assert.deepEqual(chat.findMentions('@Claude COS and @mike wolf, @claude-cos again', cands), ['ai:claude-cos', 'human:mw@mike-wolf.com']);
    assert.deepEqual(chat.findMentions('email me@Ann.com or @Annabel', cands), [], 'not inside a word, not a prefix of a longer word');
    assert.deepEqual(chat.findMentions('@Ann: look', cands), ['guest:Ann']);
    assert.deepEqual(chat.mentionQueryAt('Hi @Cla', 7), { start: 3, query: 'Cla' });
    assert.equal(chat.mentionQueryAt('mail a@b', 8), null);
    const key = (a: string) => a.toLowerCase();
    const msgs = [
      { id: 1, by: 'ai:claude-cos', mentions: ['human:mw@mike-wolf.com'] },
      { id: 2, by: 'human:mw@mike-wolf.com', mentions: ['human:mw@mike-wolf.com'] },
      { id: 3, by: 'guest:Ann', mentions: [] },
      { id: 4, by: 'guest:Ann', mentions: ['HUMAN:mw@mike-wolf.com'] },
    ] as any;
    assert.equal(chat.unreadMentions(msgs, 'human:mw@mike-wolf.com', 0, key), 2, 'your own messages never count');
    assert.equal(chat.unreadMentions(msgs, 'human:mw@mike-wolf.com', 1, key), 1);
    assert.equal(chat.cleanChatText(`  a\r\nb${String.fromCharCode(0)}  `), 'a\nb', 'control characters go; line breaks stay');
    assert.equal(chat.cleanChatText('x'.repeat(5000)).length, chat.CHAT_POLICY.maxText);
  });

  // ------------------------------------------------------------------ HTTP
  const mike = auth.createLibraryMember({ name: 'Mike Wolf', email: 'mw@mike-wolf.com' });
  const eric = auth.createLibraryMember({ name: 'Eric', email: 'eric@example.test' });
  const sessionCookie = (memberId: string) => {
    const link = auth.createLibrarySigninLink({ memberId, purpose: 'operator', origin: base });
    const signedIn = auth.consumeLibrarySigninToken(new URL(link.link).hash.slice(3), null)!;
    return `${auth.LIBRARY_SESSION_COOKIE}=${encodeURIComponent(signedIn.sessionId)}`;
  };
  const slug = 'chat-test';
  db.createDocument(slug, doc, {}, 'Chat test', 'owner-1', 'owner-secret-chat');
  db.getDb().prepare(`INSERT INTO library_document_meta (slug, created_by_member_id) VALUES (?, ?)`).run(slug, mike.id);
  const share = db.createDocumentAccessToken(slug, 'commenter');
  const key = db.createDocumentAccessToken(slug, 'editor', undefined, { label: 'Claude COS', requestedBy: 'test', requestedFrom: '127.0.0.1' });
  const MIKE = { Cookie: sessionCookie(mike.id), 'x-share-token': share.secret };
  const ERIC = { Cookie: sessionCookie(eric.id), 'x-share-token': share.secret };
  const GUEST = { 'x-share-token': share.secret };
  const KEY = { 'x-share-token': key.secret };
  const lines = await serverLines.computeServerLines(doc);
  const L = (text: string) => lines.find(l => l.text.includes(text))!;
  const markdownBefore = db.getDocumentBySlug(slug)!.markdown;

  let first = 0;
  await test('page: a signed-in person posts with a line pointer; the actor is their verified identity whatever "by" says', async () => {
    const r = await call(`/api/documents/${slug}/chat`, 'POST', { by: 'guest:Impostor', text: 'Is **Q2** right? @Claude COS', lines: [shared.anchorForLine(L('second quarter'))] }, MIKE);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.message.by, 'human:mw@mike-wolf.com');
    assert.equal(r.body.trust, 'verified');
    assert.deepEqual(r.body.message.mentions, ['ai:claude-cos'], 'the @name in the text resolves to the AI');
    assert.equal(r.body.message.lines.length, 1);
    first = r.body.message.id;
  });

  await test('page: a guest posts under the typed name (unverified); a bad anchor is 400; no comment access is 403', async () => {
    const r = await call(`/api/documents/${slug}/chat`, 'POST', { by: 'Ann', text: 'Hello from a guest', mentions: ['human:mw@mike-wolf.com'] }, GUEST);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.message.by, 'guest:Ann');
    assert.deepEqual(r.body.message.mentions, ['human:mw@mike-wolf.com']);
    const bad = await call(`/api/documents/${slug}/chat`, 'POST', { by: 'Ann', text: 'x', lines: [{ hash: 1 }] }, GUEST);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'INVALID_ANCHOR');
    const empty = await call(`/api/documents/${slug}/chat`, 'POST', { by: 'Ann', text: '   ' }, GUEST);
    assert.equal(empty.body.code, 'TEXT_REQUIRED');
    const viewer = db.createDocumentAccessToken(slug, 'viewer');
    const denied = await call(`/api/documents/${slug}/chat`, 'POST', { by: 'V', text: 'hi' }, { 'x-share-token': viewer.secret });
    assert.equal(denied.status, 403);
  });

  await test('agent: GET /chat lists messages with pointers resolved to lines; ?after= is a cursor', async () => {
    const r = await call(`/api/agent/${slug}/chat`, 'GET', undefined, KEY);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.messages.length, 2);
    assert.equal(r.body.messages[0].pointers[0].lineIndex, L('second quarter').index);
    assert.equal(r.body.messages[0].pointers[0].ref, `b${L('second quarter').block + 1}`);
    const after = await call(`/api/agent/${slug}/chat?after=${first}`, 'GET', undefined, KEY);
    assert.equal(after.body.messages.length, 1);
    assert.equal(after.body.cursor, after.body.messages[0].id);
    const none = await call(`/api/agent/${slug}/chat?after=${after.body.cursor}`, 'GET', undefined, KEY);
    assert.equal(none.body.messages.length, 0);
    assert.equal(none.body.cursor, after.body.cursor);
    assert.ok(r.body.mentionable.some((c: any) => c.actor === 'ai:claude-cos'));
  });

  await test('agent: an AI replies with line targets; its identity is its key; a bad reply target is 404', async () => {
    const r = await call(`/api/agent/${slug}/chat`, 'POST', { text: 'Q2 matches the plan.', replyTo: first, lines: [{ quote: 'second quarter' }, L('budget').index] }, KEY);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.message.by, 'ai:claude-cos');
    assert.equal(r.body.message.replyTo, first);
    assert.deepEqual(r.body.message.pointers.map((p: any) => p.lineIndex), [L('second quarter').index, L('budget').index]);
    const spoof = await call(`/api/agent/${slug}/chat`, 'POST', { text: 'x', by: 'human:mw@mike-wolf.com' }, KEY);
    assert.equal(spoof.status, 403);
    const missing = await call(`/api/agent/${slug}/chat`, 'POST', { text: 'x', replyTo: 9999 }, KEY);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'REPLY_TARGET_NOT_FOUND');
    const noLine = await call(`/api/agent/${slug}/chat`, 'POST', { text: 'x', lines: [{ quote: 'not in the document' }] }, KEY);
    assert.equal(noLine.status, 409);
  });

  let suggestionMarkId = '';
  await test('agent: a chat message with a suggestion creates a normal suggestion (why required) and links it', async () => {
    const noWhy = await call(`/api/agent/${slug}/chat`, 'POST', { text: 'Change it', suggestion: { kind: 'replace', quote: 'ten thousand', content: 'twelve thousand' } }, KEY);
    assert.equal(noWhy.status, 400, JSON.stringify(noWhy.body));
    assert.equal(noWhy.body.code, 'WHY_REQUIRED');
    assert.equal(noWhy.body.stage, 'suggestion');
    const count = (await call(`/api/agent/${slug}/chat`, 'GET', undefined, KEY)).body.messages.length;
    const r = await call(`/api/agent/${slug}/chat`, 'POST', {
      text: 'The sheet says twelve.', suggestion: { kind: 'replace', quote: 'ten thousand', content: 'twelve thousand', why: 'The finance sheet was updated on Monday.' },
    }, KEY);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    suggestionMarkId = r.body.message.suggestion.markId;
    assert.ok(suggestionMarkId);
    assert.equal(r.body.suggestion.markId, suggestionMarkId);
    assert.equal(r.body.message.suggestion.why, 'The finance sheet was updated on Monday.');
    assert.equal(r.body.message.pointers[0].lineIndex, L('budget').index, 'the message points at the suggestion\'s line');
    const list = (await call(`/api/agent/${slug}/chat`, 'GET', undefined, KEY)).body.messages;
    assert.equal(list.length, count + 1, 'the refused one was not posted');
    const state = await call(`/api/agent/${slug}/state`, 'GET', undefined, KEY);
    const marks = state.body.marks ?? {};
    const mark = marks[suggestionMarkId];
    assert.ok(mark, `the suggestion is in the document's marks: ${Object.keys(marks)}`);
    assert.equal(mark.status ?? 'pending', 'pending');
    const notes = await call(`/api/agent/${slug}/notes`, 'GET', undefined, KEY);
    assert.ok(notes.body.notes.some((n: any) => n.target?.markId === suggestionMarkId && n.why), 'the why is stored as for any suggestion');
    const bad = await call(`/api/agent/${slug}/chat`, 'POST', { text: 'x', suggestion: { kind: 'rewrite', quote: 'a' } }, KEY);
    assert.equal(bad.body.code, 'INVALID_SUGGESTION');
  });

  await test('events: every message is a chat.message event with its text, mentions and pointers', async () => {
    const events = await call(`/api/agent/${slug}/events/pending?after=0&limit=200`, 'GET', undefined, KEY);
    const chatEvents = events.body.events.filter((e: any) => e.type === 'chat.message');
    assert.ok(chatEvents.length >= 4, `chat events: ${chatEvents.length}`);
    const withSuggestion = chatEvents.find((e: any) => e.data.suggestion?.markId === suggestionMarkId);
    assert.ok(withSuggestion);
    assert.equal(withSuggestion.data.lines[0].lineIndex, L('budget').index);
    assert.match(withSuggestion.data.howToAnswer, /POST \/api\/agent\/chat-test\/chat/);
    assert.ok(chatEvents.some((e: any) => e.data.mentions.includes('ai:claude-cos')));
  });

  await test('Explain and Ask why from the page also appear in the chat, linked to their thread', async () => {
    const line = L('Last line');
    const ex = await call(`/api/documents/${slug}/explain`, 'POST', { anchor: shared.anchorForLine(line), question: '', commentMarkId: 'comment-123' }, ERIC);
    assert.equal(ex.status, 200, JSON.stringify(ex.body));
    assert.ok(ex.body.chatMessageId);
    const why = await call(`/api/documents/${slug}/why-asked`, 'POST', { markId: suggestionMarkId, author: 'ai:claude-cos', anchor: shared.anchorForLine(L('budget')) }, ERIC);
    assert.equal(why.status, 200, JSON.stringify(why.body));
    const list = (await call(`/api/documents/${slug}/chat`, 'GET', undefined, ERIC)).body;
    const explainMsg = list.messages.find((m: any) => m.kind === 'explain');
    assert.equal(explainMsg.by, 'human:eric@example.test');
    assert.equal(explainMsg.commentMarkId, 'comment-123');
    assert.match(explainMsg.text, /^Explain: What does this line mean/);
    assert.deepEqual(explainMsg.mentions, ['ai:claude-cos'], 'the AI collaborators are mentioned');
    const whyMsg = list.messages.find((m: any) => m.kind === 'why');
    assert.equal(whyMsg.text, '@Claude COS Why this change?');
    assert.equal(whyMsg.commentMarkId, suggestionMarkId);
    assert.equal(whyMsg.lines.length, 1);
    const explains = await call(`/api/agent/${slug}/explains`, 'GET', undefined, KEY);
    assert.equal(explains.body.explains.length, 1, 'the Explain thread is still recorded as before');
    assert.ok(list.labels['human:eric@example.test'], 'the page gets labels for chat authors');
  });

  await test('chat never changes the document text; messages persist (a fresh read returns them all in order)', async () => {
    const state = await call(`/api/agent/${slug}/state`, 'GET', undefined, KEY);
    assert.match(state.body.markdown, /ten thousand/, 'the original text is still there until the suggestion is accepted');
    for (const line of markdownBefore.split('\n').filter(l => l.trim() && !l.includes('ten thousand'))) assert.ok(state.body.markdown.includes(line), `line kept: ${line}`);
    const all = (await call(`/api/documents/${slug}/chat`, 'GET', undefined, GUEST)).body.messages;
    const ids = all.map((m: any) => m.id);
    assert.deepEqual(ids, [...ids].sort((a: number, b: number) => a - b));
    assert.equal(all.length, 6);
    assert.ok(!(state.body.issues ?? []).some?.((i: any) => i.type === 'chat'), 'chat is never an Issue');
  });

  console.log(`\n${passed} chat tests passed`);
} finally {
  server.close();
  rmSync(temp, { recursive: true, force: true });
}
process.exit(0);
