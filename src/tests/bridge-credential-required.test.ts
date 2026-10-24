// ac-ok7 (2026-09-25): the bridge routes upstream left open (auth 'none') let anyone holding a
// slug read a document, comment on it, propose changes, and replace its whole text through
// /rewrite, whatever its guest setting ("private" included). Every bridge route now needs a
// credential with the role it acts with: read for GET, comment for comments and proposals, edit
// for /rewrite. Before the fix, each tokenless request below succeeded and the text was replaced.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';

async function run(): Promise<void> {
  process.env.DATABASE_PATH = path.join(tmpdir(), `proof-bridge-credential-${randomUUID()}.db`);
  const [{ bridgeRouter }, db] = await Promise.all([import('../../server/bridge'), import('../../server/db')]);

  const text = '# Private notes\n\nSecret words stay private.\n\nSecond line.';
  db.createDocument('privslug', text, {}, 'Private notes', 'owner-1', 'owner-secret');
  const commenter = db.createDocumentAccessToken('privslug', 'commenter').secret;
  const editor = db.createDocumentAccessToken('privslug', 'editor').secret;
  const stored = () => db.getDocument('privslug')?.markdown ?? '';
  const original = stored();
  assert.ok(original.includes('Secret words'));

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/d/:slug/bridge', bridgeRouter);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to start test server');
  const base = `http://127.0.0.1:${address.port}/d/privslug/bridge`;
  const call = async (method: string, route: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
  };

  try {
    // No credential: every open route refuses, and nothing is read or written.
    const state = await call('GET', '/state');
    assert.equal(state.status, 401, 'A tokenless read of the document must be refused');
    assert.ok(!JSON.stringify(state.body).includes('Secret words'), 'The refusal must not carry the text');
    assert.ok((state.body.acceptedHeaders as string[] | undefined)?.some(h => h.startsWith('x-share-token')), 'The refusal names the key header');
    assert.equal((await call('GET', '/marks')).status, 401, 'A tokenless read of the marks must be refused');
    assert.equal((await call('POST', '/marks/comment', { quote: 'Second line.', by: 'ai:stranger', text: 'hello' })).status, 401);
    assert.equal((await call('POST', '/comments', { quote: 'Second line.', by: 'ai:stranger', text: 'hello' })).status, 401);
    assert.equal((await call('POST', '/marks/suggest-replace', { quote: 'Second line.', by: 'ai:stranger', content: 'Changed.' })).status, 401);
    assert.equal((await call('POST', '/suggestions', { kind: 'insert', quote: 'Second line.', by: 'ai:stranger', content: ' more' })).status, 401);
    const revision = db.getDocument('privslug')?.revision;
    const rewrite = await call('POST', '/rewrite', { content: '# Replaced by a stranger', by: 'ai:stranger', baseRevision: revision });
    assert.equal(rewrite.status, 401, 'A tokenless rewrite must be refused');
    assert.equal(stored(), original, 'The document text is unchanged');

    // A key that is not this document's is refused the same way.
    assert.equal((await call('GET', '/state', undefined, { 'x-share-token': 'not-a-key' })).status, 401);

    // A commenter may read and comment, but not replace the text.
    assert.equal((await call('GET', '/state', undefined, { 'x-share-token': commenter })).status, 200);
    const commented = await call('POST', '/marks/comment', { quote: 'Second line.', by: 'ai:helper', text: 'hello' }, { 'x-share-token': commenter });
    assert.equal(commented.status, 200, `A commenter may comment (${JSON.stringify(commented.body).slice(0, 200)})`);
    const commenterRewrite = await call('POST', '/rewrite', { content: '# Replaced by a commenter', by: 'ai:helper', baseRevision: db.getDocument('privslug')?.revision }, { 'x-share-token': commenter });
    assert.equal(commenterRewrite.status, 403, 'A commenter may not rewrite');
    assert.equal(commenterRewrite.body.code, 'FORBIDDEN');
    // The comment itself re-saves the text (a trailing newline); the refused rewrite changed nothing.
    assert.equal(stored().trim(), original.trim(), 'The document text is still unchanged');

    // An editor key, or the owner token, passes the gate (the rewrite then runs its own checks).
    const editorRewrite = await call('POST', '/rewrite', { content: '# Rewritten by an editor\n\nNew text.', by: 'ai:helper', baseRevision: db.getDocument('privslug')?.revision }, { 'x-share-token': editor });
    assert.ok(![401, 403].includes(editorRewrite.status), `An editor key passes the credential gate (${editorRewrite.status})`);
    assert.equal((await call('GET', '/state', undefined, { 'x-bridge-token': 'owner-secret' })).status, 200, 'The owner token reads');
    assert.equal((await call('GET', '/state', undefined, { authorization: 'Bearer owner-secret' })).status, 200, 'Bearer works too');

    // An unknown document answers 404 without a credential, and without waiting for a viewer.
    const missing = await fetch(`http://127.0.0.1:${address.port}/d/nosuchdoc/bridge/state`);
    assert.equal(missing.status, 404);

    console.log('bridge-credential-required.test.ts passed');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
