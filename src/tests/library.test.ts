import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const unique = `${process.pid}-${Date.now()}`;
process.env.DATABASE_PATH = path.join(os.tmpdir(), `proof-library-${unique}.db`);
process.env.SNAPSHOT_DIR = path.join(os.tmpdir(), `proof-library-snapshots-${unique}`);
process.env.PROOF_ENV = 'test';
process.env.PROOF_DB_ENV_INIT = 'test';
process.env.PROOF_LIBRARY_ENABLED = '1';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

async function main(): Promise<void> {
  const serverRoot = '../../server';
  const [{ libraryRoutes }, auth, documents, dbModule, page, shareWeb] = await Promise.all([
    import(`${serverRoot}/library/routes.js`),
    import(`${serverRoot}/library/auth.js`),
    import(`${serverRoot}/library/documents.js`),
    import(`${serverRoot}/db.js`),
    import(`${serverRoot}/library/page.js`),
    import(`${serverRoot}/share-web-routes.js`),
  ]);
  const app = express();
  app.use(express.json({ limit: '10mb' }), libraryRoutes);
  app.get('/', (req, res) => {
    if (auth.isLibraryEnabled()) page.renderLibraryHome(req, res);
    else res.type('html').send('<title>Proof SDK</title><h1>Proof SDK</h1>');
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object', 'server should listen');
  const origin = `http://127.0.0.1:${address.port}`;

  const request = async (
    method: string,
    requestPath: string,
    body?: unknown,
    cookie?: string,
    extra: Record<string, string> = {},
  ) => {
    const response = await fetch(`${origin}${requestPath}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* HTML is expected in a few cases. */ }
    return { status: response.status, text, json, headers: response.headers };
  };

  const owner = auth.createLibraryMember({ name: 'Mike Wolf', email: 'MIKE@EXAMPLE.COM', isOwner: true });
  equal(owner.email, 'mike@example.com', 'emails are lower-cased');
  const signinLink = auth.createLibrarySigninLink({ memberId: owner.id, purpose: 'operator', origin }).link;
  const rawToken = signinLink.split('#t=')[1];
  assert(rawToken && !signinLink.includes('?token='), 'token belongs in the URL fragment');

  equal((await request('POST', '/library/api/signin', { token: rawToken }, undefined, { Origin: '' })).status, 403, 'origin is required');
  const signedIn = await request('POST', '/library/api/signin', { token: rawToken });
  equal(signedIn.status, 200, 'valid link signs in');
  const setCookie = signedIn.headers.get('set-cookie') || '';
  assert(setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Lax'), 'cookie security attributes');
  const cookie = setCookie.split(';')[0];
  const rawSession = decodeURIComponent(cookie.split('=')[1] || '');

  const used = await request('POST', '/library/api/signin', { token: rawToken });
  const unknown = await request('POST', '/library/api/signin', { token: 'unknown' });
  const expiredLink = auth.createLibrarySigninLink({ memberId: owner.id, purpose: 'operator', origin }).link;
  const expiredToken = expiredLink.split('#t=')[1];
  dbModule.getDb().prepare("UPDATE library_signin_links SET expires_at='2000-01-01T00:00:00.000Z' WHERE used_at IS NULL").run();
  const expired = await request('POST', '/library/api/signin', { token: expiredToken });
  equal(used.text, unknown.text, 'used and unknown failures match');
  equal(used.text, expired.text, 'used and expired failures match');

  const secureLink = auth.createLibrarySigninLink({ memberId: owner.id, purpose: 'device', origin }).link;
  const secure = await request('POST', '/library/api/signin', { token: secureLink.split('#t=')[1] }, undefined, {
    Origin: `https://127.0.0.1:${address.port}`,
    'X-Forwarded-Proto': 'https',
  });
  assert((secure.headers.get('set-cookie') || '').includes('Secure'), 'proxied HTTPS cookie is Secure');
  for (const table of ['library_members', 'library_signin_links', 'library_sessions', 'library_document_meta', 'library_visits']) {
    const stored = JSON.stringify(dbModule.getDb().prepare(`SELECT * FROM ${table}`).all());
    assert(!stored.includes(rawToken) && !stored.includes(rawSession), `${table} stores only hashes`);
  }

  equal((await request('GET', '/library/api/documents')).status, 401, 'signed-out list is private');
  equal((await request('POST', '/library/api/documents', { title: 'CSRF' }, cookie, { Origin: '' })).status, 403, 'missing origin fails');
  equal((await request('POST', '/library/api/documents', { title: 'CSRF' }, cookie, { Origin: 'https://bad.example' })).status, 403, 'foreign origin fails');
  const wrongType = await fetch(`${origin}/library/api/documents`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'text/plain' },
    body: '{}',
  });
  equal(wrongType.status, 403, 'non-JSON state change fails');

  const now = new Date().toISOString();
  dbModule.createDocument('review-fixture', '# Review\n\n<span data-proof="authored">hidden needle phrase</span>', {
    i: { kind: 'insert', by: 'human:Eric', status: 'pending' },
    d: { kind: 'delete', by: 'human:Eric', status: 'pending' },
    r: { kind: 'replace', by: 'ai:claude', status: 'pending' },
    accepted: { kind: 'insert', by: 'ai:claude', status: 'accepted' },
    authored: { kind: 'authored', by: 'human:Mike' },
    open: { kind: 'comment', by: 'human:Eric', resolved: false },
    resolved: { kind: 'comment', by: 'human:Eric', resolved: true },
  }, 'Review');
  dbModule.getDb().prepare('INSERT INTO library_document_meta (slug, created_by_member_id) VALUES (?, ?)').run('review-fixture', owner.id);
  dbModule.createDocument('api-fixture', '# API fixture', {}, undefined);
  dbModule.createDocument('archived-fixture', '# Archived fixture', {}, 'Archived fixture');
  dbModule.getDb().prepare('INSERT INTO library_document_meta (slug, archived_at, archived_by) VALUES (?, ?, ?)').run('archived-fixture', now, owner.id);

  const signedOutHome = await request('GET', '/');
  assert(signedOutHome.text.includes('Your team’s documents'), 'signed-out home has sign-in guidance');
  assert(!signedOutHome.text.includes('review-fixture') && !signedOutHome.text.includes('Review'), 'signed-out home leaks no document data');
  const signedInHome = await request('GET', '/', undefined, cookie);
  assert(signedInHome.text.includes('Documents · Proof') && signedInHome.text.includes('New document'), 'signed-in home renders Documents UI');
  assert((await request('GET', '/library/client.js')).text.includes('loadDocuments'), 'library client is served without a build step');
  const injected = shareWeb.injectLibraryMemberIntoShareHtml('<html><head></head><body></body></html>', '</script><b>x');
  assert(injected.includes('window.__PROOF_LIBRARY_MEMBER__'), 'member global is injected');
  assert(injected.includes('\\u003c/script>') && !injected.includes('</script><b>x'), 'member name cannot escape the script');

  const review = await request('GET', '/library/api/documents?filter=review', undefined, cookie);
  equal(review.json.documents.length, 1, 'review filter');
  equal(review.json.documents[0].pendingSuggestions, 3, 'pending count');
  equal(review.json.documents[0].suggestionsBy['human:Eric'], 2, 'suggestion author breakdown');
  equal(review.json.documents[0].openComments, 1, 'open comment count');
  const search = await request('GET', '/library/api/documents?q=needle', undefined, cookie);
  equal(search.json.documents.length, 1, 'search finds span-wrapped text');
  assert(!search.json.documents[0].snippet.includes('<span'), 'snippet strips Proof spans');
  equal((await request('GET', '/library/api/documents?filter=archived', undefined, cookie)).json.documents.length, 1, 'archive filter');
  assert((await request('GET', '/library/api/documents?filter=mine', undefined, cookie)).json.documents.every((doc: any) => doc.createdBy === 'Mike Wolf'), 'mine filter');

  const blank = await request('POST', '/library/api/documents', { title: 'Blank document' }, cookie);
  const markdown = await request('POST', '/library/api/documents', { title: 'Imported', markdown: '# Imported\n\nText' }, cookie);
  equal(blank.status, 201, 'blank creation');
  equal(markdown.status, 201, 'markdown creation');
  for (const created of [blank.json, markdown.json]) {
    const meta = dbModule.getDb().prepare('SELECT created_by_member_id FROM library_document_meta WHERE slug=?').get(created.slug) as { created_by_member_id: string };
    equal(meta.created_by_member_id, owner.id, 'creator metadata');
    const event = dbModule.getDb().prepare("SELECT event_data FROM events WHERE document_slug=? AND event_type='document.created'").get(created.slug) as { event_data: string };
    equal(JSON.parse(event.event_data).source, 'library', 'library event source');
  }

  equal((await request('PATCH', `/library/api/documents/${blank.json.slug}`, { title: 'Renamed', archived: true }, cookie)).status, 200, 'rename and archive');
  assert(dbModule.getDocumentBySlug(blank.json.slug), 'archived document still opens by slug');
  equal((await request('PATCH', `/library/api/documents/${blank.json.slug}`, { archived: false }, cookie)).status, 200, 'restore');

  dbModule.getDb().prepare("INSERT INTO library_visits (member_id,slug,last_opened_at,last_left_at) VALUES (?,?,?,?)").run(owner.id, 'review-fixture', '2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z');
  dbModule.getDb().prepare("UPDATE documents SET updated_at='2020-01-03T00:00:00.000Z' WHERE slug='review-fixture'").run();
  const changed = await request('GET', '/library/api/documents?q=Review', undefined, cookie);
  assert(changed.json.documents[0].updatedSinceYouLooked, 'changed-since-last-look signal');
  equal((await request('POST', '/library/api/visits/review-fixture', { event: 'leave' }, cookie)).status, 200, 'leave visit');

  const invite = await request('POST', '/library/api/people', { name: 'Eric', email: 'ERIC@example.com' }, cookie);
  equal(invite.status, 201, 'invite member');
  assert(invite.json.link.includes('#t='), 'invite returns one-time fragment link');
  const invitedSignin = await request('POST', '/library/api/signin', { token: invite.json.link.split('#t=')[1] });
  const invitedCookie = (invitedSignin.headers.get('set-cookie') || '').split(';')[0];
  equal((await request('POST', `/library/api/people/${owner.id}/remove`, {}, invitedCookie)).status, 403, 'non-owner cannot remove');
  equal((await request('POST', `/library/api/people/${invite.json.member.id}/remove`, {}, cookie)).status, 200, 'owner removes member');
  equal((await request('GET', '/library/api/me', undefined, invitedCookie)).status, 401, 'removal revokes sessions');

  const rateKey = `rate-${unique}`;
  for (let index = 0; index < 30; index += 1) assert(documents.allowLibraryDocumentCreation(rateKey), 'first 30 creates allowed');
  assert(!documents.allowLibraryDocumentCreation(rateKey), '31st create is rate-limited');

  const storedNames = new Map<string, string>();
  Object.assign(globalThis, {
    window: { __PROOF_LIBRARY_MEMBER__: { name: 'Signed-in Writer' } },
    localStorage: {
      getItem: (key: string) => storedNames.get(key) ?? null,
      setItem: (key: string, value: string) => storedNames.set(key, value),
    },
  });
  const sourceRoot = '../ui';
  const namePrompt = await import(`${sourceRoot}/name-prompt.js`);
  equal(await namePrompt.promptForName(), 'Signed-in Writer', 'member name bypasses the viewer prompt');
  equal(storedNames.get('proof-share-viewer-name'), 'Signed-in Writer', 'member name is saved for authorship');

  process.env.PROOF_LIBRARY_ENABLED = '0';
  equal((await request('GET', '/library/api/me', undefined, cookie)).status, 404, 'flag off hides library routes');
  assert((await request('GET', '/')).text.includes('Proof SDK'), 'flag off preserves developer landing');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  console.log('library tests passed');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
