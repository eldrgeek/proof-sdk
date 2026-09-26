/** Mike, 2026-09-24, yfbqrau4 (ac-8ae): live typing withdraws through status writes.
 * 2026-09-26 (ac-l71, step 6): a move is two linked suggestion records over the item (remove +
 * insert). A client from before moves would draw them as a plain deletion and insertion, and
 * accepting the one or rejecting the other there deletes the item; 0.34.0 makes such clients reload.
 * Older clients must reload before editing; the ac-lhc protocol stays unchanged. */
export const COLLAB_VERSION_POLICY = {
  minVersion: '0.34.0',
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
