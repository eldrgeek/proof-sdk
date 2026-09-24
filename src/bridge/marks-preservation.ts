export function isPendingSuggestionMark(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind !== 'insert' && kind !== 'delete' && kind !== 'replace') return false;
  const status = (value as { status?: unknown }).status;
  return status !== 'accepted' && status !== 'rejected';
}

export function shouldPreserveMissingLocalMark(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'authored') return false;
  if (isPendingSuggestionMark(value)) return true;
  const status = (value as { status?: unknown }).status;
  if (status === 'accepted' || status === 'rejected') return false;
  return true;
}

export function shouldIgnoreIncomingEmptyServerMarks(args: {
  incomingMarks: Record<string, unknown>;
  cachedServerMarks: Record<string, unknown>;
  localMetadata: Record<string, unknown>;
  isSynced: boolean;
  unsyncedChanges: number;
}): boolean {
  if (Object.keys(args.incomingMarks).length > 0) return false;
  if (Object.keys(args.cachedServerMarks).length === 0) return false;
  if (!args.isSynced) return true;
  const localHydrated = Object.keys(args.cachedServerMarks).every(
    (id) => args.localMetadata[id] !== undefined,
  );
  if (localHydrated) return false;
  return true;
}
