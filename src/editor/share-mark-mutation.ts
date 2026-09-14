import type {
  ShareMarkMutationResponse,
  ShareOpenContext,
  ShareRequestError,
} from '../bridge/share-client.js';
import type { StoredMark } from './plugins/marks.js';

export type ShareSuggestionFinalStatus = 'accepted' | 'rejected';

const DEFAULT_CONVERGENCE_POLL_DELAYS_MS = [500, 1_000, 2_000, 4_000] as const;

function isShareRequestError(value: unknown): value is ShareRequestError {
  return Boolean(
    value
    && typeof value === 'object'
    && 'error' in value
    && value.error
    && typeof (value as { error?: { message?: unknown } }).error?.message === 'string'
  );
}

function isShareOpenContext(value: unknown): value is ShareOpenContext {
  return Boolean(value && typeof value === 'object' && 'doc' in value);
}

function isTransientMarkMutationFailure(value: unknown): boolean {
  if (!isShareRequestError(value)) return false;
  const code = value.error.code.trim().toUpperCase();
  const message = value.error.message.trim().toLowerCase();
  return code === 'STALE_BASE'
    || code === 'PROJECTION_STALE'
    || code === 'AUTHORITATIVE_BASE_UNAVAILABLE'
    || code === 'MARK_NOT_FOUND'
    || code === 'MARK_NOT_HYDRATED'
    || code === 'COLLAB_SYNC_FAILED'
    || message.includes('stale')
    || message.includes('shadow')
    || message.includes('projection')
    || message.includes('mutation base')
    || message.includes('not found');
}

function getServerMarks(context: ShareOpenContext): Record<string, StoredMark> | null {
  const marks = context.doc?.marks;
  if (!marks || typeof marks !== 'object' || Array.isArray(marks)) return null;
  return marks as Record<string, StoredMark>;
}

function getUnresolvedIds(
  marks: Record<string, StoredMark>,
  expectedResolutions: Record<string, ShareSuggestionFinalStatus>,
): string[] {
  return Object.entries(expectedResolutions)
    .filter(([id, finalStatus]) => {
      if (!(id in marks)) return false;
      return marks[id]?.status !== finalStatus;
    })
    .map(([id]) => id);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getShareMarkMutationFailureMessage(failure: unknown, fallbackMessage: string): string {
  if (isShareRequestError(failure)) {
    const message = failure.error.message.trim();
    return message.length > 0 ? message : fallbackMessage;
  }
  if (failure instanceof Error && failure.message.trim().length > 0) {
    return failure.message.trim();
  }
  return fallbackMessage;
}

export async function recoverShareMarksAfterMutationFailure(args: {
  failure: unknown;
  fallbackMessage: string;
  fetchOpenContext: () => Promise<ShareOpenContext | ShareRequestError | null>;
  showErrorBanner: (message: string) => void;
  applyServerMarks: (marks: Record<string, StoredMark>) => void;
  applyServerDocument?: (doc: ShareOpenContext['doc']) => void;
  expectedResolutions?: Record<string, ShareSuggestionFinalStatus>;
  initialContext?: ShareOpenContext | ShareRequestError | null;
  pollDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}): Promise<{
  message: string;
  refreshed: boolean;
  converged: boolean;
  unresolvedIds: string[];
}> {
  const message = getShareMarkMutationFailureMessage(args.failure, args.fallbackMessage);
  const expectedResolutions = args.expectedResolutions ?? {};
  const pollDelaysMs = args.pollDelaysMs ?? DEFAULT_CONVERGENCE_POLL_DELAYS_MS;
  const wait = args.sleep ?? sleep;
  const shouldPoll = isTransientMarkMutationFailure(args.failure);
  let latestContext = args.initialContext;

  try {
    if (!isShareOpenContext(latestContext)) {
      latestContext = await args.fetchOpenContext();
    }

    let latestMarks = isShareOpenContext(latestContext) && !isShareRequestError(latestContext)
      ? getServerMarks(latestContext)
      : null;
    let unresolvedIds = latestMarks
      ? getUnresolvedIds(latestMarks, expectedResolutions)
      : Object.keys(expectedResolutions);

    for (const delayMs of pollDelaysMs) {
      if (!shouldPoll || Object.keys(expectedResolutions).length === 0 || unresolvedIds.length === 0) break;
      await wait(delayMs);
      latestContext = await args.fetchOpenContext();
      latestMarks = isShareOpenContext(latestContext) && !isShareRequestError(latestContext)
        ? getServerMarks(latestContext)
        : null;
      unresolvedIds = latestMarks
        ? getUnresolvedIds(latestMarks, expectedResolutions)
        : Object.keys(expectedResolutions);
    }

    if (!isShareOpenContext(latestContext) || isShareRequestError(latestContext) || !latestMarks) {
      args.showErrorBanner(message);
      return {
        message,
        refreshed: false,
        converged: false,
        unresolvedIds: Object.keys(expectedResolutions),
      };
    }

    if (unresolvedIds.length === 0 && Object.keys(expectedResolutions).length > 0) {
      args.applyServerMarks(latestMarks);
      return { message, refreshed: true, converged: true, unresolvedIds: [] };
    }

    const restoreMessage = unresolvedIds.length > 0
      ? `${message} The server still reports ${unresolvedIds.length} suggestion${unresolvedIds.length === 1 ? '' : 's'} as pending; its latest document has been restored.`
      : message;
    args.showErrorBanner(restoreMessage);
    if (args.applyServerDocument) {
      args.applyServerDocument(latestContext.doc);
    } else {
      args.applyServerMarks(latestMarks);
    }
    return { message: restoreMessage, refreshed: true, converged: false, unresolvedIds };
  } catch {
    args.showErrorBanner(message);
    return {
      message,
      refreshed: false,
      converged: false,
      unresolvedIds: Object.keys(expectedResolutions),
    };
  }
}

export async function reconcileShareMarkMutationBatch(args: {
  markIds: string[];
  finalStatus: ShareSuggestionFinalStatus;
  mutate: (markId: string) => Promise<ShareMarkMutationResponse | ShareRequestError | null>;
  fetchOpenContext: () => Promise<ShareOpenContext | ShareRequestError | null>;
  fallbackMessage: string;
  showErrorBanner: (message: string) => void;
  applyServerMarks: (marks: Record<string, StoredMark>) => void;
  applyServerDocument: (doc: ShareOpenContext['doc']) => void;
  pollDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}): Promise<{
  converged: boolean;
  unresolvedIds: string[];
  retriedIds: string[];
}> {
  const markIds = [...new Set(args.markIds.filter(Boolean))];
  const expectedResolutions = Object.fromEntries(
    markIds.map((id) => [id, args.finalStatus]),
  ) as Record<string, ShareSuggestionFinalStatus>;
  const failures = new Map<string, unknown>();
  let lastFailure: unknown;
  let lastMutationFailure: unknown;
  let lastTransientMutationFailure: unknown;

  for (const markId of markIds) {
    try {
      const result = await args.mutate(markId);
      if (!result || isShareRequestError(result) || result.success !== true) {
        failures.set(markId, result);
        lastFailure = result;
        lastMutationFailure = result;
        if (isTransientMarkMutationFailure(result)) lastTransientMutationFailure = result;
      }
    } catch (error) {
      failures.set(markId, error);
      lastFailure = error;
      lastMutationFailure = error;
      if (isTransientMarkMutationFailure(error)) lastTransientMutationFailure = error;
    }
  }

  let context: ShareOpenContext | ShareRequestError | null = null;
  try {
    context = await args.fetchOpenContext();
  } catch (error) {
    failures.set('__context__', error);
    lastFailure = error;
  }
  const marks = isShareOpenContext(context) && !isShareRequestError(context)
    ? getServerMarks(context)
    : null;
  const unresolvedAfterFirstPass = marks
    ? getUnresolvedIds(marks, expectedResolutions)
    : [...failures.keys()].filter((id) => id !== '__context__');
  const retriedIds = [...new Set(unresolvedAfterFirstPass)];

  for (const markId of retriedIds) {
    try {
      const result = await args.mutate(markId);
      if (!result || isShareRequestError(result) || result.success !== true) {
        failures.set(markId, result);
        lastFailure = result;
        lastMutationFailure = result;
        if (isTransientMarkMutationFailure(result)) lastTransientMutationFailure = result;
      } else {
        failures.delete(markId);
      }
    } catch (error) {
      failures.set(markId, error);
      lastFailure = error;
      lastMutationFailure = error;
      if (isTransientMarkMutationFailure(error)) lastTransientMutationFailure = error;
    }
  }

  if (retriedIds.length > 0) {
    try {
      context = await args.fetchOpenContext();
    } catch (error) {
      context = null;
      failures.set('__context__', error);
      lastFailure = error;
    }
  }

  const failure = lastTransientMutationFailure
    ?? lastMutationFailure
    ?? [...failures.values()].at(-1)
    ?? lastFailure
    ?? new Error(args.fallbackMessage);
  const recovered = await recoverShareMarksAfterMutationFailure({
    failure,
    fallbackMessage: args.fallbackMessage,
    fetchOpenContext: args.fetchOpenContext,
    showErrorBanner: args.showErrorBanner,
    applyServerMarks: args.applyServerMarks,
    applyServerDocument: args.applyServerDocument,
    expectedResolutions,
    initialContext: context,
    pollDelaysMs: args.pollDelaysMs,
    sleep: args.sleep,
  });

  return {
    converged: recovered.converged,
    unresolvedIds: recovered.unresolvedIds,
    retriedIds,
  };
}
