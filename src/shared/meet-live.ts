/**
 * A room that attached this Accord can offer one quiet "Meet live" link in the top bar.
 * Mike approved the Rooms–Accord link on 2026-10-30. The page asks the rooms service after
 * load and shows the link only when that answer is a URL under the rooms site. Any other
 * answer, including a failure, leaves the bar unchanged and says nothing to the reader.
 *
 * The label is the only user-facing string. The lookup address, the allowed href prefix and
 * the page's connect-src entry are machine addresses, kept here so the page and the check
 * share one definition.
 */

export const MEET_LIVE_POLICY = {
  /** The only words the reader sees. */
  label: 'Meet live',
  /** Rooms service. The lookup is `origin + '/rooms/api/team/accord/' + slug`. */
  origin: 'https://vps.mike-wolf.com',
  /** An href is usable only when it is under this prefix. */
  hrefPrefix: 'https://vps.mike-wolf.com/rooms/',
  /** The lookup starts after the page's load event and gives up after this long. */
  timeoutMs: 3_000,
  /** The link opens a new tab. */
  openInNewTab: true,
} as const;

/** `https://vps.mike-wolf.com/rooms/api/team/accord/<slug>`. */
export function meetLiveLookupUrl(slug: string): string {
  return `${MEET_LIVE_POLICY.origin}/rooms/api/team/accord/${encodeURIComponent(slug)}`;
}

/**
 * The answer's `url`, or null when it is not an https URL under
 * `https://vps.mike-wolf.com/rooms/`. A different host, a userinfo trick, a port, a
 * non-https scheme, or a path that merely begins with the letters "rooms" is null.
 */
export function meetLiveHref(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.includes('\\')) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password) return null;
  if (url.protocol !== 'https:' || url.hostname !== 'vps.mike-wolf.com' || url.port !== '') return null;
  if (!url.pathname.startsWith('/rooms/')) return null;
  const href = `${url.origin}${url.pathname}${url.search}${url.hash}`;
  if (!href.startsWith(MEET_LIVE_POLICY.hrefPrefix)) return null;
  return href;
}

/** An https origin with no wildcard, userinfo, port or path, or null. */
export function exactHttpsOrigin(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port !== '') return null;
  if (url.hostname.length === 0 || url.hostname.includes('*')) return null;
  return url.origin;
}

/**
 * connect-src for the Accord page: the page's own origin, and the rooms origin.
 * Extra entries are exact https origins (and the matching wss host) taken from
 * configuration, such as SOMA Auth. A wildcard or a scheme-only source is dropped,
 * so the rooms allowance cannot be widened to `https:` or `*`.
 */
export function accordPageConnectSrc(extraOrigins: readonly string[] = []): string {
  const sources = ["'self'", MEET_LIVE_POLICY.origin];
  for (const raw of extraOrigins) {
    const origin = exactHttpsOrigin(raw);
    if (!origin || sources.includes(origin)) continue;
    sources.push(origin);
    const wss = `wss://${new URL(origin).host}`;
    if (!sources.includes(wss)) sources.push(wss);
  }
  return sources.join(' ');
}

/** The Content-Security-Policy value for the Accord page. connect-src only. */
export function accordPageContentSecurityPolicy(extraOrigins: readonly string[] = []): string {
  return `connect-src ${accordPageConnectSrc(extraOrigins)}`;
}

/** SOMA Auth's origin, when the server is configured with an exact https URL. */
export function connectSrcExtrasFromEnv(env: Record<string, string | undefined> | undefined): string[] {
  const configured = env?.SOMA_AUTH_URL?.trim();
  if (!configured) return [];
  const origin = exactHttpsOrigin(configured);
  return origin ? [origin] : [];
}

export interface MeetLiveResponse {
  ok: boolean;
  json(): Promise<unknown>;
}

/**
 * Ask the rooms service. Returns the checked href, or null on a non-200, a bad body,
 * a bad URL, a timeout or any throw. Callers show nothing and log nothing in that case.
 */
export async function readMeetLiveHref(
  slug: string,
  fetchImpl: (input: string, init?: { signal?: AbortSignal; credentials?: RequestCredentials; cache?: RequestCache }) => Promise<MeetLiveResponse>,
  timeoutMs: number = MEET_LIVE_POLICY.timeoutMs,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(meetLiveLookupUrl(slug), {
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const body = await response.json() as { url?: unknown } | null;
    if (!body || typeof body !== 'object') return null;
    return meetLiveHref(body.url);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Run `run` on a later turn after the page's load event, so the lookup cannot delay load. */
export function runAfterPageLoad(run: () => void): void {
  const start = () => { setTimeout(run, 0); };
  if (typeof document !== 'undefined' && document.readyState === 'complete') {
    start();
    return;
  }
  window.addEventListener('load', start, { once: true });
}
