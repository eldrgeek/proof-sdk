import assert from 'node:assert/strict';
import { ShareEventPoller } from '../bridge/share-event-poller';

const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const scheduled = new Map<number, { fn: () => void; delay: number }>();
let nextId = 1;
globalThis.setTimeout = ((fn: () => void, delay: number) => {
  const id = nextId++;
  scheduled.set(id, { fn, delay });
  return id;
}) as unknown as typeof setTimeout;
globalThis.clearTimeout = ((id: number) => scheduled.delete(id)) as unknown as typeof clearTimeout;
async function tick(expectedDelay: number) {
  assert.equal(scheduled.size, 1);
  const [id, task] = [...scheduled][0];
  scheduled.delete(id);
  assert.equal(task.delay, expectedDelay);
  task.fn();
  await Promise.resolve();
  await Promise.resolve();
}
try {
  let requests = 0;
  const tokenless = new ShareEventPoller(() => false, async () => { requests++; return 401; });
  tokenless.start();
  assert.equal(scheduled.size, 0);
  assert.equal(requests, 0);
  const rejected = new ShareEventPoller(() => true, async () => { requests++; return 401; });
  rejected.start();
  rejected.start();
  await tick(1500);
  await tick(3000);
  await tick(6000);
  assert.equal(requests, 3);
  assert.equal(scheduled.size, 0);
  rejected.start();
  assert.equal(scheduled.size, 0, 'Starting again must not bypass the auth failure ceiling');
  const statuses = [401, 200, 401, 401, 401];
  const recovered = new ShareEventPoller(() => true, async () => statuses.shift()!);
  recovered.start();
  for (const delay of [1500, 3000, 1500, 3000, 6000]) await tick(delay);
  assert.equal(scheduled.size, 0);
  let credential = true;
  const lostCredential = new ShareEventPoller(() => credential, async () => { requests++; return 200; });
  lostCredential.start();
  credential = false;
  await tick(1500);
  assert.equal(requests, 3, 'No request if the credential disappears before the timer fires');
  const stopping = new ShareEventPoller(() => true, async () => { stopping.stop(); return 401; });
  stopping.start();
  await tick(1500);
  assert.equal(scheduled.size, 0, 'An in-flight request cannot restart a stopped poller');
  console.log('✓ event poller: no credential, exponential 401 backoff, three-request ceiling, recovery and teardown');
} finally {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}

// The client also refuses direct tokenless requests, independently of the scheduler.
const originalFetch = globalThis.fetch;
(globalThis as any).window = { location: new URL('http://127.0.0.1/d/x1-tokenless'), __PROOF_CONFIG__: {} };
try {
  const { shareClient } = await import('../bridge/share-client');
  let requests = 0;
  globalThis.fetch = async (_input, init) => {
    requests++;
    assert.ok(new Headers(init?.headers).get('x-share-token'));
    return new Response(JSON.stringify({ success: true, cursor: 0, events: [] }));
  };
  assert.equal(await shareClient.fetchPendingEvents(0), null);
  assert.equal(requests, 0);
  await shareClient.fetchPendingEvents(0, { token: 'explicit-test-credential' });
  assert.equal(requests, 1);
  console.log('✓ pending-events client refuses tokenless fetches');
} finally {
  globalThis.fetch = originalFetch;
  delete (globalThis as any).window;
}
