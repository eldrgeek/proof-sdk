/** Shared timing policy for the bar and the collaboration server. */
export const DEFAULT_AGENT_PRESENCE_TTL_MS = 15 * 60_000;
export const AGENT_PRESENCE_IDLE_MS = 60_000;

export function getAgentPresenceDisplay(
  entry: { at: string; status?: string; expiresAt?: string },
  nowMs = Date.now(),
): { visible: boolean; idle: boolean; label: string; nextUpdateAtMs: number | null } {
  const atMs = Date.parse(entry.at);
  const configuredExpiry = Date.parse(entry.expiresAt ?? '');
  const expiresAtMs = Number.isFinite(configuredExpiry) ? configuredExpiry : atMs + DEFAULT_AGENT_PRESENCE_TTL_MS;
  if (!Number.isFinite(atMs) || entry.status === 'left' || entry.status === 'disconnected' || nowMs >= expiresAtMs) {
    return { visible: false, idle: false, label: '', nextUpdateAtMs: null };
  }
  const ageMs = Math.max(0, nowMs - atMs);
  const idle = ageMs >= AGENT_PRESENCE_IDLE_MS;
  const minutes = Math.floor(ageMs / 60_000);
  return {
    visible: true,
    idle,
    label: idle ? `last active ${minutes} min ago` : 'active now',
    nextUpdateAtMs: Math.min(expiresAtMs, atMs + (minutes + 1) * 60_000),
  };
}
