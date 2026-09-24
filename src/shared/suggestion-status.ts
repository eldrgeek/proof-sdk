/** ac-lhc (2026-09-24): absence from a view is never a suggestion decision. */
import type { StoredMark, SuggestionStatus } from '../formats/marks.js';

export const SUGGESTION_STATUS_POLICY = {
  preservePendingOnPassiveSnapshot: true,
  restoreClientDeletion: true,
  restoreOrigin: 'server-pending-suggestion-restore',
  pruneOrigin: 'server-resolved-suggestion-prune',
  undoWindowMs: 24 * 60 * 60 * 1000,
  restoreLimit: 3,
  restoreWindowMs: 5 * 60 * 1000,
} as const;

export function isSuggestion(value: unknown): value is StoredMark {
  if (!value || typeof value !== 'object') return false;
  return ['insert', 'delete', 'replace'].includes(String((value as StoredMark).kind));
}

export function isPendingSuggestion(value: unknown): value is StoredMark & { status?: 'pending' } {
  return isSuggestion(value) && value.status !== 'accepted' && value.status !== 'rejected';
}

export function suggestionWithStatus(mark: StoredMark, status: SuggestionStatus, by: string, at = new Date().toISOString()): StoredMark {
  return { ...mark, status, resolvedBy: by, resolvedAt: at };
}
