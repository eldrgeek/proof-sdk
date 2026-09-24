/** ac-lhc: live decisions require status-writing clients; older tabs must reload. */
export const COLLAB_VERSION_POLICY = {
  minVersion: '0.32.0',
  protocol: '3',
  reloadCode: 4401, // Hocuspocus Unauthorized stops automatic socket retries, including 0913728.
  reloadReason: 'client-upgrade-required',
} as const;

export type CollabClientVersion = { version: string; build: string; protocol: string };
export const CURRENT_COLLAB_CLIENT: CollabClientVersion = {
  version: COLLAB_VERSION_POLICY.minVersion, build: 'web', protocol: COLLAB_VERSION_POLICY.protocol,
};

export function supportsSuggestionStatus(client: unknown): client is CollabClientVersion {
  if (!client || typeof client !== 'object') return false;
  const { version, build, protocol } = client as CollabClientVersion;
  if (typeof build !== 'string' || !build.trim() || protocol !== COLLAB_VERSION_POLICY.protocol) return false;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return false;
  const actual = version.split('.').map(Number);
  const minimum = COLLAB_VERSION_POLICY.minVersion.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== minimum[i]) return actual[i] > minimum[i];
  }
  return true;
}
