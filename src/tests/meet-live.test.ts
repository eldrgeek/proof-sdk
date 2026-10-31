/**
 * Meet live (Mike, 2026-10-30): the lookup URL, the href guard, the page's connect-src,
 * and a stubbed fetch that fails closed.
 */
import assert from 'node:assert/strict';
import {
  MEET_LIVE_POLICY,
  accordPageConnectSrc,
  accordPageContentSecurityPolicy,
  connectSrcExtrasFromEnv,
  exactHttpsOrigin,
  meetLiveHref,
  meetLiveLookupUrl,
  readMeetLiveHref,
} from '../shared/meet-live';

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const ROOM = 'https://vps.mike-wolf.com/rooms/team/accord-room';

await test('policy: one label, a 3 second timeout, and the rooms origin only', () => {
  assert.equal(MEET_LIVE_POLICY.label, 'Meet live');
  assert.equal(MEET_LIVE_POLICY.timeoutMs, 3000);
  assert.equal(MEET_LIVE_POLICY.origin, 'https://vps.mike-wolf.com');
  assert.equal(MEET_LIVE_POLICY.hrefPrefix, 'https://vps.mike-wolf.com/rooms/');
  assert.equal(MEET_LIVE_POLICY.openInNewTab, true);
  assert.equal(meetLiveLookupUrl('hgff4jxe'), 'https://vps.mike-wolf.com/rooms/api/team/accord/hgff4jxe');
  assert.equal(meetLiveLookupUrl('a/b c'), 'https://vps.mike-wolf.com/rooms/api/team/accord/a%2Fb%20c');
});

await test('meetLiveHref: a rooms URL is kept, and anything else is dropped', () => {
  assert.equal(meetLiveHref(ROOM), ROOM);
  assert.equal(meetLiveHref('https://vps.mike-wolf.com/rooms/team/x?seat=1#live'), 'https://vps.mike-wolf.com/rooms/team/x?seat=1#live');
  assert.equal(meetLiveHref('https://VPS.mike-wolf.com/rooms/team/x'), 'https://vps.mike-wolf.com/rooms/team/x');
  for (const bad of [
    'http://vps.mike-wolf.com/rooms/team/x',
    'https://vps.mike-wolf.com/rooms',
    'https://vps.mike-wolf.com/rooms-evil',
    'https://vps.mike-wolf.com.evil.example/rooms/team/x',
    'https://evil.example/rooms/team/x',
    'https://user:pass@vps.mike-wolf.com/rooms/team/x',
    'https://vps.mike-wolf.com:444/rooms/team/x',
    'https://vps.mike-wolf.com/rooms/../admin',
    'javascript:alert(1)',
    '//vps.mike-wolf.com/rooms/team/x',
    '/rooms/team/x',
    ' https://vps.mike-wolf.com/rooms/team/x',
    '',
    null,
    1,
  ]) {
    assert.equal(meetLiveHref(bad), null, `accepted ${String(bad)}`);
  }
});

await test('connect-src allows the rooms origin and no wider source', () => {
  assert.equal(accordPageConnectSrc(), "'self' https://vps.mike-wolf.com");
  assert.equal(
    accordPageContentSecurityPolicy(),
    "connect-src 'self' https://vps.mike-wolf.com",
  );
  const sources = accordPageConnectSrc().split(' ');
  for (const source of sources) {
    assert.notEqual(source, '*');
    assert.notEqual(source, 'https:');
    assert.notEqual(source, 'http:');
    assert.notEqual(source, 'wss:');
    assert.equal(source.includes('*'), false);
  }
  assert.equal(exactHttpsOrigin('https://*.mike-wolf.com'), null);
  assert.equal(exactHttpsOrigin('https://auth.example/path'), 'https://auth.example');
  assert.equal(accordPageConnectSrc(['https://*.mike-wolf.com', 'https:']), "'self' https://vps.mike-wolf.com");
  assert.equal(
    accordPageConnectSrc(['https://auth.example/auth/v1']),
    "'self' https://vps.mike-wolf.com https://auth.example wss://auth.example",
  );
  assert.deepEqual(connectSrcExtrasFromEnv({}), []);
  assert.deepEqual(connectSrcExtrasFromEnv({ SOMA_AUTH_URL: 'https://soma.example/auth' }), ['https://soma.example']);
  assert.deepEqual(connectSrcExtrasFromEnv({ SOMA_AUTH_URL: 'not a url' }), []);
});

await test('readMeetLiveHref: a 200 with a rooms url is the href', async () => {
  let called = '';
  let credentials: string | undefined;
  let cache: string | undefined;
  const href = await readMeetLiveHref('hgff4jxe', async (input, init) => {
    called = input;
    credentials = init?.credentials;
    cache = init?.cache;
    return { ok: true, json: async () => ({ url: ROOM }) };
  });
  assert.equal(href, ROOM);
  assert.equal(called, meetLiveLookupUrl('hgff4jxe'));
  assert.equal(credentials, 'omit');
  assert.equal(cache, 'no-store');
});

await test('readMeetLiveHref: 404, a bad url, a bad body and a throw show nothing', async () => {
  const cases: Array<() => Promise<{ ok: boolean; json: () => Promise<unknown> }>> = [
    async () => ({ ok: false, json: async () => ({ url: ROOM }) }),
    async () => ({ ok: true, json: async () => ({ url: 'https://evil.example/live' }) }),
    async () => ({ ok: true, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => 'https://vps.mike-wolf.com/rooms/team/x' }),
    async () => ({ ok: true, json: async () => { throw new Error('not json'); } }),
    async () => { throw new Error('offline'); },
  ];
  for (const fetchImpl of cases) {
    assert.equal(await readMeetLiveHref('hgff4jxe', fetchImpl), null);
  }
});

await test('readMeetLiveHref: the lookup aborts at the timeout and returns null', async () => {
  let signal: AbortSignal | undefined;
  const pending = readMeetLiveHref('hgff4jxe', (_input, init) => new Promise((_resolve, reject) => {
    signal = init?.signal;
    if (signal?.aborted) reject(new Error('aborted'));
    else signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }), 40);
  const href = await pending;
  assert.equal(href, null);
  assert.equal(signal?.aborted, true);
});

console.log(`${passed} meet-live tests passed`);
