import assert from 'node:assert/strict';
import {
  __getMarkAnchorResolutionTelemetryStateForTests,
  __reportMarkAnchorResolutionForTests,
  __resetMarkAnchorResolutionTelemetryForTests,
} from '../editor/plugins/marks.js';

type CapturedMetricRequest = {
  url: string;
  payload: Record<string, unknown>;
};

type ScheduledTimer = {
  runAtMs: number;
  callback: () => void;
};

async function run(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalDateNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;

  const requests: CapturedMetricRequest[] = [];
  const pagehideListeners: Array<() => void> = [];
  const scheduledTimers = new Map<number, ScheduledTimer>();
  let nextTimerId = 1;
  let nowMs = new Date('2026-03-21T12:00:00.000Z').getTime();

  const advanceClock = (deltaMs: number): void => {
    nowMs += deltaMs;
    while (true) {
      const dueTimers = [...scheduledTimers.entries()]
        .filter(([, timer]) => timer.runAtMs <= nowMs)
        .sort((a, b) => a[1].runAtMs - b[1].runAtMs);
      if (dueTimers.length === 0) break;
      for (const [timerId, timer] of dueTimers) {
        scheduledTimers.delete(timerId);
        timer.callback();
      }
    }
  };

  Date.now = () => nowMs;
  globalThis.setTimeout = (((handler: TimerHandler, timeout?: number) => {
    const callback = typeof handler === 'function'
      ? () => handler()
      : () => {};
    const timerId = nextTimerId;
    nextTimerId += 1;
    scheduledTimers.set(timerId, {
      runAtMs: nowMs + Math.max(0, Math.floor(timeout ?? 0)),
      callback,
    });
    return timerId as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  globalThis.clearTimeout = (((timer: ReturnType<typeof setTimeout>) => {
    scheduledTimers.delete(Number(timer));
  }) as typeof clearTimeout);

  (globalThis as { window: Record<string, unknown> }).window = {
    location: {
      origin: 'https://proof.example.test',
      pathname: '/d/telemetry-test',
    },
    addEventListener: (event: string, listener: unknown) => {
      if (event !== 'pagehide') return;
      if (typeof listener !== 'function') return;
      pagehideListeners.push(listener as () => void);
    },
    removeEventListener: (event: string, listener: unknown) => {
      if (event !== 'pagehide') return;
      if (typeof listener !== 'function') return;
      const index = pagehideListeners.findIndex((entry) => entry === listener);
      if (index >= 0) pagehideListeners.splice(index, 1);
    },
  };

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const bodyText = typeof init?.body === 'string' ? init.body : '{}';
    const payload = JSON.parse(bodyText) as Record<string, unknown>;
    requests.push({ url, payload });
    return { ok: true } as Response;
  };

  try {
    __resetMarkAnchorResolutionTelemetryForTests();
    const { flushIntervalMs, maxRequestsPerPage } = __getMarkAnchorResolutionTelemetryStateForTests();

    for (let index = 0; index < 1000; index += 1) {
      __reportMarkAnchorResolutionForTests('failure');
    }

    assert.equal(requests.length, 0, 'Expected mark-anchor metrics to batch before the flush interval');
    advanceClock(flushIntervalMs - 1);
    assert.equal(requests.length, 0, 'Expected no mark-anchor metrics request before flush interval elapses');
    advanceClock(1);
    assert.equal(requests.length, 1, 'Expected one batched mark-anchor metrics request after first flush interval');
    assert.equal(requests[0]?.payload.successCount, 0, 'Expected first flush to report no success marks');
    assert.equal(requests[0]?.payload.failureCount, 1000, 'Expected first flush to preserve all failure reports');

    for (let index = 0; index < 73; index += 1) {
      __reportMarkAnchorResolutionForTests('success');
    }
    for (let index = 0; index < 27; index += 1) {
      __reportMarkAnchorResolutionForTests('failure');
    }

    advanceClock(flushIntervalMs);
    assert(
      requests.length <= 2,
      `Expected at most two sends across one minute (one per interval), got ${requests.length}`,
    );
    assert.equal(requests.length, 2, 'Expected second interval to produce exactly one additional batched request');

    const totals = requests.reduce((acc, request) => {
      acc.success += Number(request.payload.successCount ?? 0);
      acc.failure += Number(request.payload.failureCount ?? 0);
      return acc;
    }, { success: 0, failure: 0 });
    assert.equal(totals.success, 73, 'Expected aggregated metrics to preserve success counts across interval batches');
    assert.equal(totals.failure, 1027, 'Expected aggregated metrics to preserve failure counts across interval batches');

    for (let index = 0; index < 11; index += 1) {
      __reportMarkAnchorResolutionForTests('failure');
    }
    for (const listener of [...pagehideListeners]) {
      listener();
    }
    assert.equal(requests.length, 3, 'Expected pagehide to flush pending mark-anchor metrics exactly once');
    assert.equal(requests[2]?.payload.failureCount, 11, 'Expected pagehide flush to include queued failure counts');

    __resetMarkAnchorResolutionTelemetryForTests();
    requests.length = 0;
    for (let index = 0; index < maxRequestsPerPage + 5; index += 1) {
      __reportMarkAnchorResolutionForTests('failure');
      advanceClock(flushIntervalMs);
    }
    assert.equal(
      requests.length,
      maxRequestsPerPage,
      `Expected mark-anchor telemetry sends to stop at per-page cap (${maxRequestsPerPage})`,
    );
    for (const listener of [...pagehideListeners]) {
      listener();
    }
    assert.equal(
      requests.length,
      maxRequestsPerPage,
      'Expected pagehide flush to honor hard per-page request cap after limit is reached',
    );

    console.log('mark-anchor-telemetry.test.ts passed');
  } finally {
    __resetMarkAnchorResolutionTelemetryForTests();
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
