import { createHash } from 'crypto';
import { Router, type Request, type Response } from 'express';
import {
  ackDocumentEvents,
  addDocumentEvent,
  bumpDocumentAccessEpoch,
  getDocumentBySlug,
  listDocumentAgentKeys,
  getDocumentProjectionBySlug,
  listDocumentEvents,
  rebuildDocumentBlocks,
  resolveDocumentAccessRole,
  resolveDocumentAccess,
} from './db.js';
import {
  activateDurableCollabQuarantine,
  applyAgentPresenceToLoadedCollab,
  type AuthoritativeMutationBase,
  applyAgentCursorHintToLoadedCollab,
  verifyCanonicalDocumentInLoadedCollab,
  getCollabRuntime,
  getCanonicalReadableDocument,
  getLoadedCollabLastChangedAt,
  getLoadedCollabMarkdownForVerification,
  getLoadedCollabMarkdownFromFragment,
  getLoadedCollabFragmentTextHash,
  getAgentPresenceExpiresAt,
  hasAgentPresenceInLoadedCollab,
  isCanonicalReadMutationReady,
  invalidateLoadedCollabDocument,
  removeAgentPresenceFromLoadedCollab,
  invalidateLoadedCollabDocumentAndWait,
  acquireRewriteLock,
  releaseRewriteLock,
  releaseRewriteLockImmediately,
  resolveAuthoritativeMutationBase,
  syncCanonicalDocumentStateToCollab,
  traceDegradedCollabRead,
  stripEphemeralCollabSpans,
  verifyAuthoritativeMutationBaseStable,
} from './collab.js';
import { canonicalizeStoredMarks, type StoredMark } from '../src/formats/marks.js';
import { buildIssueReport, computeServerLines, listCanonicalLineMarks, resolveAgentLineTarget, writeAgentLineMark } from './line-marks.js';
import { TIER_POLICY } from '../src/shared/line-tiers.js';
import { evaluateDocumentTiers, listTierRecords, serializeTierViews, writeTiers } from './line-tiers.js';
import { bindFamiliar, briefFor, issueReportFor, listFamiliars, proxyStateReport, resolveHuman, serializeBrief, writeAgentProxyMarks } from './proxy-marks.js';
import { EVIDENCE_POLICY, PROXY_POLICY, isClaimedMark } from '../src/shared/proxy-marks.js';
import { buildSinceYou, freezeIfAligned, listSnapshotInfos, scheduleAlignmentCheck, sendSnapshotFile } from './alignment.js';
import { agentKeyActor, anchorForLine as anchorForDocLine } from '../src/shared/line-marks.js';
import { decideActor } from './identity.js';
import { answerAgentAsk, buildAskReport, createAskOnLine, createAgentAsk, listAgentAsks, listCanonicalAsks, reaskAsk, withdrawAsk } from './asks.js';
import { ASK_POLICY, askTeamActors, oneLine } from '../src/shared/asks.js';
import { createAgentDo, listAgentDos, reviseDo, revokeDo, runDo, withdrawDo } from './do.js';
import { DO_POLICY, DO_OPERATIONS } from '../src/shared/do.js';
import {
  aidsReport,
  checkSuggestionWhy,
  clearFlag,
  clearObjection,
  createAgentObjection,
  keepObjection,
  recordSuggestionNote,
  suggestionNoteFields,
  writeAgentFlag,
  writeAgentNote,
  type SuggestionNoteFields,
} from './review-aids.js';
import { ISSUE_PRIORITY, REJECT_CHIPS, SITTING_BUDGET, UNCERTAIN_POLICY, WHY_POLICY } from '../src/shared/review-aids.js';
import { OBJECTION_POLICY } from '../src/shared/objections.js';
import { normalizeActorString } from '../src/shared/identity.js';

/** Step B3: edit/v2 conflicts that an insertAfter ask retries (a keystroke landed meanwhile). */
const ASK_INSERT_RETRY_CODES = new Set(['STALE_REVISION', 'STALE_BASE', 'PROJECTION_STALE', 'LIVE_REF_DRIFT']);
import {
  deriveCollabApplied,
  deriveCursorApplied,
  derivePresenceApplied,
} from './agent-collab-status.js';
import {
  executeDocumentOperationAsync,
  finalizeSuggestionsBatchAsync,
  type AsyncDocumentMutationContext,
  type EngineExecutionResult,
} from './document-engine.js';
import {
  addToBundle,
  alternativesReport,
  bundleField,
  bundleReport,
  checkBundleField,
  checkTtl,
  clearTtl,
  decideAlternative,
  decideBundle,
  offerAlternative,
  pickAlternative,
  setBlindSetting,
  setTtl,
  ttlReport,
  withdrawAlternative,
  type LineEditor,
} from './proof-extras.js';
import { blindViewFor, redactIssues, serializeExplain, termsReport } from './proof-extras-eval.js';
import { getProofSettings, listExplains, listPicks } from './proof-extras-store.js';
import { BUNDLE_POLICY } from '../src/shared/bundles.js';
import { ALT_POLICY } from '../src/shared/alternatives.js';
import { BLIND_POLICY } from '../src/shared/blind.js';
import { EXPLAIN_POLICY, TERM_POLICY } from '../src/shared/explain.js';
import { TTL_POLICY } from '../src/shared/ttl.js';
import { getChatMessage, listChatMessages, mentionCandidates, postChatMessage, serializeChatMessage } from './chat.js';
import { CHAT_POLICY, type ChatSuggestionRef } from '../src/shared/chat.js';
import type { DocLine as ProofDocLine } from '../src/shared/line-marks.js';
import {
  recordAgentMutation,
  recordCollabRouteLatency,
  recordEditAnchorAmbiguous,
  recordEditAnchorNotFound,
  recordEditAuthoredSpanRemap,
  recordEditStructuralCleanupApplied,
  recordRewriteBarrierFailure,
  recordRewriteBarrierLatency,
  recordRewriteForceIgnored,
  recordRewriteLiveClientBlock,
} from './metrics.js';
import type { ShareRole } from './share-types.js';
import { broadcastToRoom, getActiveCollabClientBreakdown, getActiveCollabClientCount } from './ws.js';
import { getCookie, shareTokenCookieName } from './cookies.js';
import {
  authorizeDocumentOp,
  type DocumentOpType,
  parseDocumentOpRequest,
  resolveDocumentOpRoute,
} from './document-ops.js';
import { applyAgentEditOperations, type AgentEditOperation, type AgentEditTarget } from './agent-edit-ops.js';
import { getEffectiveShareStateForRole } from './share-access.js';
import {
  AGENT_DOCS_PATH,
  ALT_SHARE_TOKEN_HEADER_FORMAT,
  AUTH_HEADER_FORMAT,
  CANONICAL_CREATE_API_PATH,
  attachReportBugDiscovery,
  buildReportBugHelp,
  canonicalCreateLink,
} from './agent-guidance.js';
import { buildAgentSnapshot } from './agent-snapshot.js';
import { stripAllProofSpanTags } from './proof-span-strip.js';
import { applyAgentEditV2 } from './agent-edit-v2.js';
import { applySingleWriterMutation, isSingleWriterEditEnabled } from './collab-mutation-coordinator.js';
import {
  cloneFromCanonical,
  executeCanonicalRewrite,
  mutateCanonicalDocument,
  recoverCanonicalDocumentIfNeeded,
  repairCanonicalProjection,
} from './canonical-document.js';
import { validateRewriteApplyPayload } from './rewrite-validation.js';
import { adaptMutationResponse } from './mutation-coordinator.js';
import {
  annotateRewriteDisruptionMetadata,
  classifyRewriteBarrierFailureReason,
  evaluateRewriteLiveClientGateWithOptions,
  isHostedRewriteEnvironment,
  rewriteBarrierFailedResponseBody,
  rewriteBlockedResponseBody,
} from './rewrite-policy.js';
import {
  getMutationContractStage,
  isIdempotencyRequired,
  validateEditPrecondition,
  validateOpPrecondition,
} from './mutation-stage.js';
import {
  normalizeAgentScopedId,
  resolveExplicitAgentIdentity,
} from '../src/shared/agent-identity.js';
import { getBuildInfo } from './build-info.js';
import { getAgentMutationRouteLabelFromPath } from './agent-mutation-route.js';
import {
  appendGitHubBugReportFollowUp,
  buildBugReportEvidence,
  buildBugReportFollowUpEvidence,
  buildFixerBriefFromEvidence,
  createGitHubIssueForBugReport,
  getBugReportSpec,
  validateBugReportFollowUp,
  validateBugReportSubmission,
} from './bug-reporting.js';
import { traceServerIncident, toErrorTraceData } from './incident-tracing.js';
import { getRequestStartedAtMs, readRequestId } from './request-context.js';
import {
  beginMutationReservation,
  completeMutationReservation,
  releaseMutationReservation,
  type MutationReservation,
} from './mutation-idempotency.js';

export const agentRoutes = Router({ mergeParams: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const REWRITE_COLLAB_TIMEOUT_MS = parsePositiveInt(process.env.PROOF_REWRITE_COLLAB_TIMEOUT_MS, 3000);
const REWRITE_BARRIER_TIMEOUT_MS = parsePositiveInt(process.env.PROOF_REWRITE_BARRIER_TIMEOUT_MS, 5000);
const EDIT_COLLAB_STABILITY_MS = parsePositiveInt(process.env.AGENT_EDIT_COLLAB_STABILITY_MS, 2500);
const EDIT_COLLAB_STABILITY_SAMPLE_MS = parsePositiveInt(process.env.AGENT_EDIT_COLLAB_STABILITY_SAMPLE_MS, 100);
const EDIT_ACTIVE_COLLAB_SETTLE_MS = parsePositiveInt(process.env.AGENT_EDIT_ACTIVE_COLLAB_SETTLE_MS, 300);
const EDIT_ACTIVE_COLLAB_SETTLE_SAMPLE_MS = parsePositiveInt(process.env.AGENT_EDIT_ACTIVE_COLLAB_SETTLE_SAMPLE_MS, 50);
const EDIT_ACTIVE_COLLAB_MIN_WAIT_MS = parsePositiveInt(process.env.AGENT_EDIT_ACTIVE_COLLAB_MIN_WAIT_MS, 150);
const TEST_EDIT_V2_POST_COMMIT_DELAY_MS = parsePositiveInt(process.env.PROOF_TEST_EDIT_V2_POST_COMMIT_DELAY_MS, 0);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFeatureEnabled(value: string | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) return true;
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseAgentEditTarget(raw: unknown): { ok: true; target: AgentEditTarget } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'target must be an object' };
  if (typeof raw.anchor !== 'string' || !raw.anchor.length) {
    return { ok: false, error: 'target.anchor must be a non-empty string' };
  }

  const target: AgentEditTarget = { anchor: raw.anchor };

  if (raw.mode !== undefined) {
    if (raw.mode !== 'exact' && raw.mode !== 'normalized' && raw.mode !== 'contextual') {
      return { ok: false, error: 'target.mode must be exact, normalized, or contextual' };
    }
    target.mode = raw.mode;
  }

  if (raw.occurrence !== undefined) {
    const occurrence = raw.occurrence;
    if (occurrence === 'first' || occurrence === 'last') {
      target.occurrence = occurrence;
    } else if (Number.isInteger(occurrence) && (occurrence as number) >= 0) {
      target.occurrence = occurrence as number;
    } else {
      return { ok: false, error: 'target.occurrence must be first, last, or a 0-based integer' };
    }
  }

  if (raw.contextBefore !== undefined) {
    if (typeof raw.contextBefore !== 'string') {
      return { ok: false, error: 'target.contextBefore must be a string' };
    }
    target.contextBefore = raw.contextBefore;
  }

  if (raw.contextAfter !== undefined) {
    if (typeof raw.contextAfter !== 'string') {
      return { ok: false, error: 'target.contextAfter must be a string' };
    }
    target.contextAfter = raw.contextAfter;
  }

  return { ok: true, target };
}

function getSlug(req: Request): string | null {
  const raw = req.params.slug;
  if (typeof raw === 'string' && raw.trim()) return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string' && raw[0].trim()) return raw[0];
  return null;
}

function getPresentedSecret(req: Request, slug?: string | null): string | null {
  const shareTokenHeader = req.header('x-share-token');
  if (typeof shareTokenHeader === 'string' && shareTokenHeader.trim()) return shareTokenHeader.trim();

  const bridgeTokenHeader = req.header('x-bridge-token');
  if (typeof bridgeTokenHeader === 'string' && bridgeTokenHeader.trim()) return bridgeTokenHeader.trim();

  const authHeader = req.header('authorization');
  if (typeof authHeader === 'string') {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]?.trim()) return match[1].trim();
  }

  const queryToken = req.query.token;
  const trimmedQueryToken = typeof queryToken === 'string' ? queryToken.trim() : '';

  const resolvedSlug = typeof slug === 'string' && slug.trim() ? slug.trim() : getSlug(req);
  if (resolvedSlug) {
    const fromCookie = getCookie(req, shareTokenCookieName(resolvedSlug));
    const trimmedCookie = typeof fromCookie === 'string' ? fromCookie.trim() : '';
    if (trimmedQueryToken) {
      const roleFromQuery = resolveDocumentAccessRole(resolvedSlug, trimmedQueryToken);
      if (roleFromQuery) return trimmedQueryToken;
    }
    if (trimmedCookie) {
      const roleFromCookie = resolveDocumentAccessRole(resolvedSlug, trimmedCookie);
      if (roleFromCookie) return trimmedCookie;
    }
  }

  if (trimmedQueryToken) return trimmedQueryToken;
  return null;
}

function hasRole(role: ShareRole | null, allowed: ShareRole[]): boolean {
  if (!role) return false;
  return allowed.includes(role);
}

function getIdempotencyKey(req: Request): string | null {
  const header = req.header('idempotency-key') ?? req.header('x-idempotency-key');
  if (typeof header === 'string' && header.trim()) return header.trim();
  return null;
}

function hashRequestBody(body: unknown): string {
  try {
    return createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
  } catch {
    return createHash('sha256').update(String(body)).digest('hex');
  }
}

function hashMarkdown(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

function normalizeMarkdownForVerification(markdown: string): string {
  return stripEphemeralCollabSpans(markdown)
    .replace(/\r\n/g, '\n')
    .replace(/\s+$/g, '');
}

function stableSortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stableSortValue(entry));
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  const sorted: Record<string, unknown> = {};
  for (const [key, entryValue] of entries) {
    sorted[key] = stableSortValue(entryValue);
  }
  return sorted;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableSortValue(value));
}

function parseCanonicalMarks(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return canonicalizeStoredMarks(parsed as Record<string, StoredMark>);
    }
  } catch {
    // ignore malformed marks payload
  }
  return {};
}

function normalizeCanonicalMarksForHash(marks: Record<string, unknown> | undefined): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [markId, value] of Object.entries(marks ?? {})) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      normalized[markId] = value;
      continue;
    }
    const kind = (value as { kind?: unknown }).kind;
    if (kind === 'authored') continue;
    const status = (value as { status?: unknown }).status;
    if (
      (kind === 'insert' || kind === 'delete' || kind === 'replace')
      && (status === 'accepted' || status === 'rejected')
    ) {
      continue;
    }
    normalized[markId] = value;
  }
  return normalized;
}

function parseMarksPayload(raw: string | null | undefined): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed marks payload
  }
  return {};
}

function hashCanonicalDocument(markdown: string, marks: Record<string, unknown> | undefined): string {
  const normalizedMarkdown = normalizeMarkdownForVerification(markdown);
  return createHash('sha256')
    .update(stableStringify({ markdown: normalizedMarkdown, marks: normalizeCanonicalMarksForHash(marks) }))
    .digest('hex');
}

async function resolveRouteMutationBase(slug: string): Promise<AuthoritativeMutationBase | null> {
  const activeCollabClients = getActiveCollabClientCount(slug);
  const resolved = await resolveAuthoritativeMutationBase(slug, {
    liveRequired: activeCollabClients > 0,
  });
  return resolved.ok ? resolved.base : null;
}

function sameRouteMutationBaseContent(
  left: AuthoritativeMutationBase | null,
  right: AuthoritativeMutationBase | null,
): boolean {
  if (!left || !right) return false;
  return left.markdown === right.markdown && JSON.stringify(left.marks) === JSON.stringify(right.marks);
}

class RewriteBarrierPreconditionError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(result: { status: number; code: string; error: string }) {
    super(result.error);
    this.name = 'RewriteBarrierPreconditionError';
    this.status = result.status;
    this.code = result.code;
  }
}

function buildMutationContextDocument(
  doc: AsyncDocumentMutationContext['doc'],
  mutationBase: AuthoritativeMutationBase | null,
): AsyncDocumentMutationContext['doc'] {
  if (!mutationBase) return doc;
  return {
    ...doc,
    markdown: mutationBase.markdown,
    marks: JSON.stringify(mutationBase.marks),
    plain_text: mutationBase.markdown,
  };
}

function shouldIncludeCanonicalDiagnostics(): boolean {
  const runtimeEnv = (process.env.PROOF_ENV || process.env.NODE_ENV || '').trim().toLowerCase();
  if (runtimeEnv !== 'production' && runtimeEnv !== 'prod') return true;
  const flag = (process.env.AGENT_EDIT_CANONICAL_DIAGNOSTICS || '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on';
}

function hasUnsafeLegacyEditMarks(raw: string | null | undefined): boolean {
  const marks = parseMarksPayload(raw);
  return Object.values(marks).some((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const kind = (value as { kind?: unknown }).kind;
    return kind === 'comment'
      || kind === 'insert'
      || kind === 'delete'
      || kind === 'replace'
      || kind === 'authored';
  });
}

type IdempotencyReplayResult = {
  handled: boolean;
  idempotencyKey: string | null;
  requestHash: string | null;
  reservation: MutationReservation | null;
  settled: boolean;
};

async function maybeReplayIdempotentMutation(
  req: Request,
  res: Response,
  slug: string,
  mutationRoute: string,
  routeKey: string,
): Promise<IdempotencyReplayResult> {
  const idempotencyKey = getIdempotencyKey(req);
  if (!idempotencyKey) {
    return {
      handled: false,
      idempotencyKey: null,
      requestHash: null,
      reservation: null,
      settled: true,
    };
  }
  const requestHash = hashRequestBody(req.body);
  const begin = await beginMutationReservation({
    documentSlug: slug,
    route: routeKey,
    idempotencyKey,
    requestHash,
    mutationRoute,
    subsystem: 'agent_routes',
    slug,
    retryWithState: `/api/agent/${slug}/state`,
  });
  if (begin.kind === 'execute') {
    return {
      handled: false,
      idempotencyKey,
      requestHash,
      reservation: begin.reservation,
      settled: false,
    };
  }
  if (begin.kind === 'mismatch') {
    sendMutationResponse(
      res,
      409,
      {
        success: false,
        code: 'IDEMPOTENCY_KEY_REUSED',
        error: 'Idempotency key cannot be reused with a different payload',
      },
      { route: mutationRoute, slug },
    );
    return { handled: true, idempotencyKey, requestHash, reservation: null, settled: true };
  }
  if (begin.kind === 'in_progress') {
    res.setHeader('Retry-After', String(begin.retryAfterSeconds));
    sendMutationResponse(
      res,
      409,
      {
        success: false,
        code: 'IDEMPOTENT_REQUEST_IN_PROGRESS',
        error: 'A request with this Idempotency-Key is still in progress; retry the same request after waiting.',
        retryWithState: `/api/agent/${slug}/state`,
      },
      { route: mutationRoute, slug, retryWithState: `/api/agent/${slug}/state` },
    );
    return { handled: true, idempotencyKey, requestHash, reservation: null, settled: true };
  }
  if (begin.kind === 'result_unknown') {
    sendMutationResponse(
      res,
      409,
      {
        success: false,
        code: 'IDEMPOTENT_RESULT_UNKNOWN',
        error: 'A previous request with this Idempotency-Key may have committed, but the final result was lost. Refresh state before retrying.',
        retryWithState: `/api/agent/${slug}/state`,
      },
      { route: mutationRoute, slug, retryWithState: `/api/agent/${slug}/state` },
    );
    return { handled: true, idempotencyKey, requestHash, reservation: null, settled: true };
  }
  sendMutationResponse(res, begin.statusCode, begin.response, { route: mutationRoute, slug });
  return { handled: true, idempotencyKey, requestHash, reservation: null, settled: true };
}

function storeIdempotentMutationResult(
  replay: IdempotencyReplayResult,
  mutationRoute: string,
  slug: string,
  status: number,
  body: Record<string, unknown>,
): void {
  if (replay.settled) return;
  if (status >= 200 && status < 300) {
    completeMutationReservation(replay.reservation, body, status, {
      mutationRoute,
      subsystem: 'agent_routes',
      slug,
    });
  } else {
    releaseMutationReservation(replay.reservation, {
      mutationRoute,
      subsystem: 'agent_routes',
      slug,
      reason: typeof body.code === 'string' ? body.code : 'mutation_failed',
    });
  }
  replay.settled = true;
  replay.reservation = null;
}

function releaseIdempotentMutationResult(
  replay: IdempotencyReplayResult,
  mutationRoute: string,
  slug: string,
  reason: string,
): void {
  if (replay.settled) return;
  releaseMutationReservation(replay.reservation, {
    mutationRoute,
    subsystem: 'agent_routes',
    slug,
    reason,
  });
  replay.settled = true;
  replay.reservation = null;
}

function routeRequiresMutation(method: string, path: string): boolean {
  if (method !== 'POST') return false;
  if (path === '/events/ack' || path.endsWith('/events/ack')) return false;
  return true;
}

function getMutationRouteLabel(req: Request): string {
  return getAgentMutationRouteLabelFromPath(req.path || '/');
}

function normalizeAgentId(raw: string): string {
  const normalized = normalizeAgentScopedId(raw);
  if (normalized) return normalized;
  const trimmed = raw.trim();
  if (!trimmed) return 'ai:unknown';
  if (trimmed.includes(':')) return trimmed;
  return `ai:${trimmed}`;
}

function requiresProjectedMarkState(opType: DocumentOpType): boolean {
  return opType === 'suggestion.accept'
    || opType === 'suggestion.reject'
    || opType === 'comment.reply'
    || opType === 'comment.resolve'
    || opType === 'comment.unresolve';
}

function hasProjectedMarkFallback(
  payload: Record<string, unknown>,
  mutationBase: AuthoritativeMutationBase | null,
): boolean {
  if (mutationBase?.source !== 'live_yjs' && mutationBase?.source !== 'persisted_yjs') {
    return false;
  }
  const markId = typeof payload.markId === 'string' && payload.markId.trim().length > 0
    ? payload.markId.trim()
    : null;
  if (!markId) return false;
  return Object.prototype.hasOwnProperty.call(mutationBase.marks, markId);
}

function deriveAgentNameFromId(id: string): string {
  const base = id.replace(/^(ai:|agent:)/i, '').trim();
  if (!base) return id;
  return base
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(' ');
}

function resolveAgentIdentity(
  req: Request,
  slug: string,
  body: Record<string, unknown>,
): { id: string; name: string; color?: string; avatar?: string } {
  const agentObj = isRecord(body.agent) ? body.agent as Record<string, unknown> : {};
  const headerAgentId = typeof req.header('x-agent-id') === 'string' ? String(req.header('x-agent-id')).trim() : '';

  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : '';
  const explicitId = typeof body.agentId === 'string' && body.agentId.trim() ? body.agentId.trim()
    : typeof agentObj.id === 'string' && agentObj.id.trim() ? agentObj.id.trim()
      : typeof body.id === 'string' && body.id.trim() ? body.id.trim()
        : by;

  let id = explicitId ? normalizeAgentId(explicitId) : '';
  if (!id && headerAgentId) id = normalizeAgentId(headerAgentId);

  if (!id) {
    const doc = getDocumentBySlug(slug);
    const owner = typeof doc?.owner_id === 'string' ? doc.owner_id.trim() : '';
    if (owner.toLowerCase().startsWith('agent:')) {
      id = normalizeAgentId(owner.replace(/^agent:/i, ''));
    }
  }
  if (!id) id = 'ai:unknown';

  const explicitName = typeof body.name === 'string' && body.name.trim() ? body.name.trim()
    : typeof agentObj.name === 'string' && agentObj.name.trim() ? agentObj.name.trim()
      : '';
  const derivedName = id === 'ai:unknown' ? '' : deriveAgentNameFromId(id);
  const name = explicitName || derivedName;

  const color = typeof body.color === 'string' && body.color.trim() ? body.color.trim()
    : typeof agentObj.color === 'string' && agentObj.color.trim() ? agentObj.color.trim()
      : undefined;
  const avatar = typeof body.avatar === 'string' && body.avatar.trim() ? body.avatar.trim()
    : typeof agentObj.avatar === 'string' && agentObj.avatar.trim() ? agentObj.avatar.trim()
      : undefined;

  return { id, name, color, avatar };
}

function isLikelyBrowserUserAgent(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  return ua.includes('mozilla')
    || ua.includes('chrome')
    || ua.includes('safari')
    || ua.includes('firefox')
    || ua.includes('edg')
    || ua.includes('opr');
}

function isLikelyAgentUserAgent(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  return ua.includes('claw')
    || ua.includes('codex')
    || ua.includes('claude-code')
    || ua.includes('curl/')
    || ua.includes('python')
    || ua.includes('httpx')
    || ua.includes('go-http-client')
    || ua.includes('wget')
    || ua.includes('postman')
    || ua.includes('insomnia')
    || ua.includes('agent');
}

function deriveAgentNameFromUserAgent(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  if (ua.includes('claude') || ua.includes('anthropic')) return 'Claude';
  if (ua.includes('chatgpt') || ua.includes('openai') || ua.includes('gpt')) return 'ChatGPT';
  if (ua.includes('gemini')) return 'Gemini';
  if (ua.includes('perplexity')) return 'Perplexity';
  if (ua.includes('copilot')) return 'Copilot';
  return 'AI collaborator';
}

function hasExplicitAgentIdentitySignal(req: Request, body: Record<string, unknown>): boolean {
  const headerAgentId = req.header('x-agent-id');
  if (typeof headerAgentId === 'string' && headerAgentId.trim()) return true;

  const by = typeof body.by === 'string' ? body.by.trim().toLowerCase() : '';
  if (by.startsWith('ai:') || by.startsWith('agent:')) return true;

  const directAgentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
  if (directAgentId) return true;

  const directId = typeof body.id === 'string' ? body.id.trim() : '';
  if (directId) return true;

  const agentObj = isRecord(body.agent) ? body.agent as Record<string, unknown> : null;
  if (agentObj) {
    const nestedId = typeof agentObj.id === 'string' ? agentObj.id.trim() : '';
    if (nestedId) return true;
  }

  return false;
}

function shouldAutoJoinAgentPresence(req: Request, body: Record<string, unknown>): boolean {
  if (hasExplicitAgentIdentitySignal(req, body)) return true;
  const userAgent = (req.header('user-agent') || '').trim();
  if (!userAgent) return true;
  const ua = userAgent.toLowerCase();
  if (
    ua.includes('claude')
    || ua.includes('anthropic')
    || ua.includes('chatgpt')
    || ua.includes('openai')
    || ua.includes('gpt')
    || ua.includes('gemini')
    || ua.includes('perplexity')
    || ua.includes('copilot')
  ) {
    return false;
  }
  if (isLikelyAgentUserAgent(userAgent)) return true;
  if (isLikelyBrowserUserAgent(userAgent)) return false;
  return true;
}

function buildAutoAgentId(req: Request, slug: string): string {
  const userAgent = (req.header('user-agent') || 'unknown-agent').trim().toLowerCase();
  const token = getPresentedSecret(req, slug) || '';
  const fingerprint = createHash('sha256')
    .update(`${slug}:${token}:${userAgent}`)
    .digest('hex')
    .slice(0, 12);
  return `ai:auto-${fingerprint}`;
}

async function resolveEditOperationBaseMarkdown(
  slug: string,
  route: string,
  canonicalMarkdown: string,
  collabRuntimeEnabled: boolean,
): Promise<{ markdown: string; source: 'db' | 'live'; activeCollabClients: number }> {
  if (!collabRuntimeEnabled) {
    return { markdown: canonicalMarkdown, source: 'db', activeCollabClients: 0 };
  }

  const activeCollabClients = getActiveCollabClientCount(slug);
  if (activeCollabClients <= 0) {
    return { markdown: canonicalMarkdown, source: 'db', activeCollabClients };
  }

  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, EDIT_ACTIVE_COLLAB_SETTLE_MS);
  const minWaitUntil = startedAt + Math.max(0, EDIT_ACTIVE_COLLAB_MIN_WAIT_MS);
  let collabBase = await getLoadedCollabMarkdownFromFragment(slug);
  let lastChangedAt = getLoadedCollabLastChangedAt(slug) ?? startedAt;

  while (Date.now() < deadline) {
    await sleep(Math.max(10, EDIT_ACTIVE_COLLAB_SETTLE_SAMPLE_MS));
    const currentBase = await getLoadedCollabMarkdownFromFragment(slug);
    const currentChangedAt = getLoadedCollabLastChangedAt(slug) ?? lastChangedAt;
    if (currentBase !== collabBase || currentChangedAt !== lastChangedAt) {
      collabBase = currentBase;
      lastChangedAt = currentChangedAt;
      continue;
    }
    if (Date.now() >= minWaitUntil) break;
  }

  if (collabBase !== null && collabBase !== canonicalMarkdown) {
    console.warn('[agent-routes] /edit detected live collab/base drift; using live collab markdown for op application', {
      slug,
      route,
      activeCollabClients,
      collabLength: collabBase.length,
      canonicalLength: canonicalMarkdown.length,
      settleMs: Date.now() - startedAt,
    });
    return { markdown: collabBase, source: 'live', activeCollabClients };
  }

  return { markdown: canonicalMarkdown, source: 'db', activeCollabClients };
}

async function prepareRewriteCollabBarrier(
  slug: string,
  options?: {
    validateWhileLocked?: () => Promise<void>;
  },
): Promise<void> {
  const collabRuntime = getCollabRuntime();
  if (!collabRuntime.enabled) return;
  // Acquire a rewrite lock BEFORE disconnecting clients.  This prevents any
  // client-originated onChange/onStoreDocument writes from sneaking through
  // during the window between disconnect and rewrite completion.
  acquireRewriteLock(slug);
  try {
    if (options?.validateWhileLocked) {
      await options.validateWhileLocked();
    }
    if ((process.env.PROOF_REWRITE_BARRIER_FORCE_FAIL || '').trim() === '1') {
      throw new Error('forced rewrite barrier failure');
    }
    bumpDocumentAccessEpoch(slug);
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        invalidateLoadedCollabDocumentAndWait(slug),
        new Promise<void>((_resolve, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`rewrite collab barrier timed out after ${REWRITE_BARRIER_TIMEOUT_MS}ms`));
          }, REWRITE_BARRIER_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  } catch (error) {
    if (error instanceof RewriteBarrierPreconditionError) {
      releaseRewriteLockImmediately(slug);
      throw error;
    }
    console.error('[agent-routes] Failed to prepare rewrite collab barrier:', { slug, error });
    traceServerIncident({
      slug,
      subsystem: 'agent_routes',
      level: 'error',
      eventType: 'rewrite.barrier_prepare_failed',
      message: 'Agent rewrite collab barrier failed before rewrite execution',
      data: toErrorTraceData(error),
    });
    // Best-effort fire-and-forget invalidation, but re-throw so the caller
    // does NOT proceed with the rewrite while clients may still be connected.
    invalidateLoadedCollabDocument(slug);
    throw error;
  }
}

function checkAuth(
  req: Request,
  res: Response,
  slug: string,
  allowedRoles: ShareRole[],
): ShareRole | null {
  const doc = getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ success: false, error: 'Document not found' });
    return null;
  }
  if (doc.share_state === 'DELETED') {
    res.status(410).json({ success: false, error: 'Document deleted' });
    return null;
  }

  const secret = getPresentedSecret(req, slug);
  const access = secret ? resolveDocumentAccess(slug, secret) : null;
  const role = access?.role ?? null;
  const effectiveShareState = getEffectiveShareStateForRole(doc, role, Boolean(secret && role));

  if (effectiveShareState === 'REVOKED' && role !== 'owner_bot') {
    res.status(403).json({ success: false, error: 'Document access revoked' });
    return null;
  }
  if (effectiveShareState === 'PAUSED' && role !== 'owner_bot') {
    res.status(403).json({ success: false, error: 'Document is not currently accessible' });
    return null;
  }

  if (!hasRole(role, allowedRoles)) {
    res.status(401).json({
      success: false,
      error: 'Missing or invalid share token',
      code: 'UNAUTHORIZED',
      acceptedHeaders: [
        'x-share-token: <ACCESS_TOKEN>',
        'x-bridge-token: <OWNER_SECRET>',
        'Authorization: Bearer <TOKEN>',
      ],
    });
    return null;
  }
  agentRequestTokenIds.set(req, access?.tokenId ?? null);
  return role;
}

function sendMutationResponse(
  res: Response,
  status: number,
  body: unknown,
  context: { route: string; slug?: string; retryWithState?: string },
): void {
  const adapted = adaptMutationResponse(status, body, context);
  if (isRecord(adapted.body) && status >= 400) {
    const existingHelp = isRecord(adapted.body.help) ? adapted.body.help : {};
    adapted.body.help = {
      ...existingHelp,
      reportBug: buildReportBugHelp({
        slug: context.slug,
        suggestedSummary: `Proof API trouble on ${context.route}`,
        suggestedContext: 'Include what you were trying to do, the response code/message, and any requestId or slug you have.',
        suggestedEvidence: [
          'The failing request URL, method, status, and response body',
          'The x-request-id header, if present',
          'The current /state or /snapshot payload if the issue involves read inconsistency',
        ],
      }),
    };
  }
  res.status(adapted.status).json(adapted.body);
}

function asPayload(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

async function enforceMutationPrecondition(
  res: Response,
  slug: string,
  mutationRoute: string,
  opType: DocumentOpType,
  payload: Record<string, unknown>,
  replay?: IdempotencyReplayResult,
): Promise<AsyncDocumentMutationContext | null> {
  const doc = getDocumentBySlug(slug);
  if (!doc) {
    if (replay) releaseIdempotentMutationResult(replay, mutationRoute, slug, 'document_not_found');
    sendMutationResponse(res, 404, { success: false, error: 'Document not found' }, { route: mutationRoute, slug });
    return null;
  }

  let canonicalDoc = await getCanonicalReadableDocument(slug, 'state') ?? {
    ...doc,
    plain_text: doc.markdown,
    projection_health: 'healthy' as const,
    projection_revision: doc.revision,
    projection_y_state_version: doc.y_state_version,
    projection_updated_at: doc.updated_at,
    projection_fresh: true,
    mutation_ready: true,
    repair_pending: false,
    read_source: 'canonical_row' as const,
  };
  if (!isCanonicalReadMutationReady(canonicalDoc) || canonicalDoc.projection_fresh === false || canonicalDoc.repair_pending === true) {
    const recovered = await recoverCanonicalDocumentIfNeeded(slug, 'mutation');
    if (recovered) {
      canonicalDoc = recovered as typeof canonicalDoc;
    }
  }
  const mutationBase = await resolveRouteMutationBase(slug);
  const projectionStale = !isCanonicalReadMutationReady(canonicalDoc)
    || canonicalDoc.projection_fresh === false
    || canonicalDoc.repair_pending === true;
  if (requiresProjectedMarkState(opType) && projectionStale && !hasProjectedMarkFallback(payload, mutationBase)) {
    if (replay) releaseIdempotentMutationResult(replay, mutationRoute, slug, 'PROJECTION_STALE');
    sendMutationResponse(res, 409, {
      success: false,
      code: 'PROJECTION_STALE',
      error: 'Document projection is stale; retry after repair completes',
      retryWithState: `/api/agent/${slug}/state`,
    }, { route: mutationRoute, slug, retryWithState: `/api/agent/${slug}/state` });
    return null;
  }
  if (!isCanonicalReadMutationReady(canonicalDoc) && !mutationBase) {
    if (replay) releaseIdempotentMutationResult(replay, mutationRoute, slug, 'projection_stale');
    sendMutationResponse(res, 409, {
      success: false,
      code: 'AUTHORITATIVE_BASE_UNAVAILABLE',
      error: 'Authoritative mutation base is unavailable; retry with latest state',
      latestUpdatedAt: null,
      latestRevision: null,
      retryWithState: `/api/agent/${slug}/state`,
    }, { route: mutationRoute, slug, retryWithState: `/api/agent/${slug}/state` });
    return null;
  }

  const stage = getMutationContractStage();
  const opPrecondition = validateOpPrecondition(stage, opType, canonicalDoc, payload, mutationBase?.token ?? null);
  if (!opPrecondition.ok) {
    if (replay) releaseIdempotentMutationResult(replay, mutationRoute, slug, opPrecondition.code);
    sendMutationResponse(res, opPrecondition.status, {
      success: false,
      code: opPrecondition.code,
      error: opPrecondition.error,
      latestUpdatedAt: canonicalDoc.updated_at,
      latestRevision: canonicalDoc.revision,
      retryWithState: `/api/agent/${slug}/state`,
    }, { route: mutationRoute, slug, retryWithState: `/api/agent/${slug}/state` });
    return null;
  }
  return {
    doc: buildMutationContextDocument(canonicalDoc, mutationBase),
    mutationBase,
    enforceProjectionReadiness: requiresProjectedMarkState(opType) && projectionStale,
    precondition: opPrecondition.mode === 'token'
      ? { mode: 'token', baseToken: opPrecondition.baseToken }
      : opPrecondition.mode === 'revision'
        ? { mode: 'revision', baseRevision: opPrecondition.baseRevision }
        : opPrecondition.mode === 'updatedAt'
          ? { mode: 'updatedAt', baseUpdatedAt: opPrecondition.baseUpdatedAt }
          : { mode: 'none' },
    idempotencyKey: replay?.idempotencyKey ?? undefined,
    idempotencyRoute: replay?.reservation?.route ?? undefined,
  };
}

function maybeLogMarkHydrationMismatch(
  route: string,
  slug: string,
  payload: Record<string, unknown>,
  context: AsyncDocumentMutationContext | null,
  result: EngineExecutionResult,
): void {
  if (result.status !== 409 || !isRecord(result.body) || result.body.code !== 'MARK_NOT_HYDRATED') return;
  const build = getBuildInfo();
  console.warn('[agent-routes] mark hydration mismatch', {
    route,
    slug,
    buildSha: build.sha,
    buildEnv: build.env,
    buildGeneratedAt: build.generatedAt,
    readSource: context?.doc.read_source ?? null,
    projectionFresh: context?.doc.projection_fresh ?? null,
    revision: context?.doc.revision ?? null,
    updatedAt: context?.doc.updated_at ?? null,
    markId: typeof payload.markId === 'string' ? payload.markId : null,
    missingMarkIds: Array.isArray(result.body.missingMarkIds) ? result.body.missingMarkIds : [],
  });
}

// Capture at authentication, before asynchronous mutations can yield to revocation.
// Owner credentials resolve to null; never accept attribution from the request body.
const agentRequestTokenIds = new WeakMap<Request, string | null>();

type AgentParticipation = {
  presenceEntry: Record<string, unknown>;
  cursorHint?: { quote?: string; ttlMs?: number } | null;
};

function ensureAgentPresenceForAuthenticatedCall(
  req: Request,
  slug: string,
  body: Record<string, unknown>,
  details: string,
): boolean {
  if (!shouldAutoJoinAgentPresence(req, body)) return false;

  const identity = resolveAgentIdentity(req, slug, body);
  const fallbackName = deriveAgentNameFromUserAgent(req.header('user-agent') || '');
  const id = identity.id && identity.id !== 'ai:unknown' ? identity.id : buildAutoAgentId(req, slug);
  const name = identity.name && identity.name.trim() ? identity.name : fallbackName;

  if (hasExplicitAgentIdentitySignal(req, body) && id && id !== 'ai:unknown') {
    upgradeProvisionalAutoPresence(req, slug, id);
  }

  const now = new Date().toISOString();
  const entry = {
    id,
    name,
    color: identity.color,
    avatar: identity.avatar,
    status: 'active',
    details,
    at: now,
    expiresAt: getAgentPresenceExpiresAt(now),
    tokenId: agentRequestTokenIds.get(req) ?? null,
  };
  const activity = {
    type: 'agent.presence',
    ...entry,
    autoJoined: true,
  } satisfies Record<string, unknown>;

  const collabApplied = applyAgentPresenceToLoadedCollab(slug, entry, activity);
  if (!collabApplied) return false;

  addDocumentEvent(slug, 'agent.presence', entry, id);
  broadcastToRoom(slug, {
    type: 'agent.presence',
    source: 'agent',
    timestamp: now,
    ...entry,
    autoJoined: true,
  });
  return true;
}

function upgradeProvisionalAutoPresence(
  req: Request,
  slug: string,
  explicitAgentId: string,
): boolean {
  const trimmedExplicitAgentId = explicitAgentId.trim();
  if (!trimmedExplicitAgentId) return false;

  const provisionalId = buildAutoAgentId(req, slug);
  if (!provisionalId || provisionalId === trimmedExplicitAgentId) return false;
  if (!hasAgentPresenceInLoadedCollab(slug, provisionalId)) return false;

  const now = new Date().toISOString();
  const removed = removeAgentPresenceFromLoadedCollab(slug, provisionalId);
  if (!removed) return false;

  broadcastToRoom(slug, {
    type: 'agent.presence',
    source: 'agent',
    timestamp: now,
    id: provisionalId,
    status: 'disconnected',
    disconnected: true,
    upgradedTo: trimmedExplicitAgentId,
    collabApplied: true,
  });
  return true;
}

function findQuoteForMarkId(slug: string, markId: string): string | null {
  const doc = getDocumentBySlug(slug);
  if (!doc || typeof doc.marks !== 'string' || !doc.marks.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(doc.marks);
  } catch {
    return null;
  }

  const maxDepth = 6;
  const walk = (value: unknown, depth: number): string | null => {
    if (depth > maxDepth) return null;
    if (!value) return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (record.id === markId && typeof record.quote === 'string' && record.quote.trim()) {
        return record.quote.trim();
      }
      for (const child of Object.values(record)) {
        const found = walk(child, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };

  return walk(parsed, 0);
}

function extractCursorQuote(slug: string, body: Record<string, unknown>): string | null {
  const quote = typeof body.quote === 'string' && body.quote.trim() ? body.quote.trim() : null;
  if (quote) return quote;
  const markId = typeof body.markId === 'string' && body.markId.trim() ? body.markId.trim() : null;
  if (markId) {
    const fromMarks = findQuoteForMarkId(slug, markId);
    if (fromMarks) return fromMarks;
  }
  return null;
}

function buildParticipationFromMutation(
  req: Request,
  slug: string,
  body: Record<string, unknown>,
  options?: { quote?: string | null; details?: string | null; ttlMs?: number | null },
): AgentParticipation | null {
  const identity = resolveExplicitAgentIdentity(body, req.header('x-agent-id'));
  if (identity.kind !== 'ok') return null;
  if (identity.id && identity.id !== 'ai:unknown') {
    upgradeProvisionalAutoPresence(req, slug, identity.id);
  }
  const now = new Date().toISOString();
  const presenceEntry: Record<string, unknown> = {
    id: identity.id,
    name: identity.name,
    color: identity.color,
    avatar: identity.avatar,
    status: 'editing',
    details: options?.details ?? '',
    tokenId: agentRequestTokenIds.get(req) ?? null,
    at: now,
  };
  const quote = (options?.quote ?? extractCursorQuote(slug, body)) ?? null;
  const cursorHint = quote ? { quote, ttlMs: options?.ttlMs ?? 3000 } : null;
  return { presenceEntry, cursorHint };
}

function applyParticipationToLoadedCollab(
  slug: string,
  participation?: AgentParticipation | null,
): { presenceApplied: boolean; cursorApplied: boolean } {
  let presenceApplied = false;
  if (participation?.presenceEntry) {
    try {
      presenceApplied = applyAgentPresenceToLoadedCollab(slug, participation.presenceEntry, {
        type: 'agent.presence',
        ...participation.presenceEntry,
      });
    } catch {
      // ignore
    }
  }

  let cursorApplied = false;
  if (participation?.cursorHint?.quote) {
    try {
      cursorApplied = applyAgentCursorHintToLoadedCollab(slug, {
        id: String(participation.presenceEntry.id),
        tokenId: typeof participation.presenceEntry.tokenId === 'string' ? participation.presenceEntry.tokenId : null,
        quote: participation.cursorHint.quote,
        ttlMs: participation.cursorHint.ttlMs,
        name: typeof participation.presenceEntry.name === 'string' ? participation.presenceEntry.name : undefined,
        color: typeof participation.presenceEntry.color === 'string' ? participation.presenceEntry.color : undefined,
        avatar: typeof participation.presenceEntry.avatar === 'string' ? participation.presenceEntry.avatar : undefined,
      });
    } catch {
      // ignore
    }
  }

  return { presenceApplied, cursorApplied };
}

type CollabMutationStatus = {
  confirmed: boolean;
  reason?: string;
  markdownConfirmed?: boolean;
  fragmentConfirmed?: boolean;
  canonicalConfirmed?: boolean;
  canonicalExpectedHash?: string | null;
  canonicalObservedHash?: string | null;
  expectedFragmentTextHash?: string | null;
  liveFragmentTextHash?: string | null;
  presenceApplied?: boolean;
  cursorApplied?: boolean;
};

async function verifyLoadedCollabMarkdownStable(
  slug: string,
  expectedMarkdown: string,
  stabilityMs: number,
): Promise<boolean> {
  if (stabilityMs <= 0) return true;
  const expectedSanitized = normalizeMarkdownForVerification(expectedMarkdown);
  const deadline = Date.now() + stabilityMs;
  const sampleMs = Math.max(25, EDIT_COLLAB_STABILITY_SAMPLE_MS);
  while (Date.now() <= deadline) {
    const currentSample = await getLoadedCollabMarkdownForVerification(slug);
    const current = currentSample.markdown;
    if (current === null) return true;
    const sanitizedCurrent = normalizeMarkdownForVerification(current);
    if (sanitizedCurrent !== expectedSanitized) {
      const derived = await getLoadedCollabMarkdownFromFragment(slug);
      const sanitizedDerived = derived === null ? null : normalizeMarkdownForVerification(derived);
      if (sanitizedDerived === null || sanitizedDerived !== expectedSanitized) return false;
    }
    await new Promise((resolve) => setTimeout(resolve, sampleMs));
  }
  return true;
}

async function verifyLoadedCollabFragmentStable(
  slug: string,
  expectedFragmentTextHash: string,
  stabilityMs: number,
): Promise<boolean> {
  if (stabilityMs <= 0) return true;
  const deadline = Date.now() + stabilityMs;
  const sampleMs = Math.max(25, EDIT_COLLAB_STABILITY_SAMPLE_MS);
  while (Date.now() <= deadline) {
    const current = await getLoadedCollabFragmentTextHash(slug);
    if (current === null) return true;
    if (current !== expectedFragmentTextHash) return false;
    await new Promise((resolve) => setTimeout(resolve, sampleMs));
  }
  return true;
}

function notifyCollabMutation(
  slug: string,
  participation?: AgentParticipation | null,
  options?: { verify?: boolean; source?: string; stabilityMs?: number; fallbackBarrier?: boolean; strictLiveDoc?: boolean; apply?: boolean },
): Promise<CollabMutationStatus> {
  // Live collaboration has one authoritative source of truth: the loaded Yjs doc.
  // Canonical markdown/marks in the DB are a derived projection that must remain in
  // sync with that authoritative state. A mutation is only "confirmed" once the live
  // Yjs state converges and the derived canonical row stays stable afterward.
  return (async () => {
    const now = new Date().toISOString();
    try {
      const collab = getCollabRuntime();
      if (!collab.enabled) {
        invalidateLoadedCollabDocument(slug);
        return { confirmed: true, reason: 'collab_disabled' };
      }

      const doc = getDocumentBySlug(slug);
      if (!doc) {
        invalidateLoadedCollabDocument(slug);
        return { confirmed: false, reason: 'missing_document' };
      }

      const targetMarkdown = typeof doc.markdown === 'string' ? doc.markdown : '';
      const targetMarks = parseCanonicalMarks(doc.marks);

      let verifiedStatus: CollabMutationStatus = {
        confirmed: true,
        canonicalConfirmed: true,
        canonicalExpectedHash: hashCanonicalDocument(targetMarkdown, targetMarks),
        canonicalObservedHash: hashCanonicalDocument(targetMarkdown, targetMarks),
        presenceApplied: false,
        cursorApplied: false,
      };
      if (options?.verify) {
        const debugConvergence = (process.env.COLLAB_DEBUG_FRAGMENT_CONVERGENCE || '').trim() === '1';
        const activeCollabClients = getActiveCollabClientCount(slug);
        const finalizeVerification = async (attempt: {
          confirmed: boolean;
          reason?: string;
          markdownConfirmed: boolean;
          fragmentConfirmed: boolean;
          markdownSource?: 'ytext' | 'fragment' | 'none';
          expectedFragmentTextHash: string | null;
          liveFragmentTextHash: string | null;
        }): Promise<CollabMutationStatus> => {
          let confirmed = attempt.confirmed;
          let reason = attempt.reason;
          let markdownConfirmed = attempt.markdownConfirmed;
          let fragmentConfirmed = attempt.fragmentConfirmed;
          let expectedFragmentTextHash = attempt.expectedFragmentTextHash;
          let liveFragmentTextHash = attempt.liveFragmentTextHash;

          if (confirmed && targetMarkdown && (options.stabilityMs ?? 0) > 0) {
            const stable = await verifyLoadedCollabMarkdownStable(slug, targetMarkdown, options.stabilityMs as number);
            if (!stable) {
              confirmed = false;
              reason = 'stability_regressed';
              markdownConfirmed = false;
            }
          }
          if (confirmed && expectedFragmentTextHash && (options.stabilityMs ?? 0) > 0) {
            const stableFragment = await verifyLoadedCollabFragmentStable(
              slug,
              expectedFragmentTextHash,
              options.stabilityMs as number,
            );
            if (!stableFragment) {
              confirmed = false;
              reason = 'fragment_stability_regressed';
              fragmentConfirmed = false;
              liveFragmentTextHash = await getLoadedCollabFragmentTextHash(slug);
            }
          }

          const authoritative = await verifyAuthoritativeMutationBaseStable(slug, targetMarkdown, targetMarks, {
            liveRequired: activeCollabClients > 0,
            stabilityMs: options.stabilityMs,
            sampleMs: EDIT_COLLAB_STABILITY_SAMPLE_MS,
          });
          const canonicalConfirmed = authoritative.confirmed;
          const canonicalExpectedHash = authoritative.expectedHash;
          const canonicalObservedHash = authoritative.observedHash;

          if (confirmed && !canonicalConfirmed) {
            confirmed = false;
            reason = authoritative.reason ?? 'authoritative_read_mismatch';
          } else if (
            !confirmed
            && reason === 'no_live_doc'
            && !options?.strictLiveDoc
            && activeCollabClients === 0
            && canonicalConfirmed
          ) {
            // Non-strict routes can accept authoritative readback even if there is no
            // loaded live doc, as long as no viewers are connected and Yjs-backed state
            // already matches the intended document.
            confirmed = true;
          } else if (!canonicalConfirmed && authoritative.reason) {
            reason = authoritative.reason;
          }

          if (options?.strictLiveDoc && reason === 'no_live_doc') {
            confirmed = false;
            reason = 'live_doc_unavailable';
          }

          return {
            confirmed,
            ...(reason ? { reason } : {}),
            markdownConfirmed,
            fragmentConfirmed,
            canonicalConfirmed,
            canonicalExpectedHash,
            canonicalObservedHash,
            expectedFragmentTextHash,
            liveFragmentTextHash,
          };
        };
        const verification = options?.apply === false
          ? await verifyCanonicalDocumentInLoadedCollab(slug, {
            markdown: targetMarkdown,
            marks: targetMarks,
            source: options.source ?? 'agent',
          }, REWRITE_COLLAB_TIMEOUT_MS)
          : await (async () => {
            const syncResult = await syncCanonicalDocumentStateToCollab(slug, {
              markdown: targetMarkdown,
              marks: targetMarks,
              source: options.source ?? 'agent',
            });
            if (!syncResult.applied) {
              return {
                applied: false,
                confirmed: false,
                reason: syncResult.reason ?? 'apply_failed',
                yStateVersion: 0,
                markdownConfirmed: false,
                fragmentConfirmed: false,
                expectedFragmentTextHash: null,
                liveFragmentTextHash: null,
                markdownSource: 'none' as const,
              };
            }
            return verifyCanonicalDocumentInLoadedCollab(slug, {
              markdown: targetMarkdown,
              marks: targetMarks,
              source: options.source ?? 'agent',
            }, REWRITE_COLLAB_TIMEOUT_MS);
          })();

        let confirmed = verification.confirmed;
        let reason = verification.reason;
        let markdownConfirmed = verification.markdownConfirmed;
        let fragmentConfirmed = verification.fragmentConfirmed;
        let canonicalConfirmed = true;
        let canonicalExpectedHash = hashCanonicalDocument(targetMarkdown, targetMarks);
        let canonicalObservedHash: string | null = canonicalExpectedHash;
        let expectedFragmentTextHash = verification.expectedFragmentTextHash;
        let liveFragmentTextHash = verification.liveFragmentTextHash;
        const evaluated = await finalizeVerification({
          confirmed,
          reason,
          markdownConfirmed,
          fragmentConfirmed,
          markdownSource: verification.markdownSource,
          expectedFragmentTextHash,
          liveFragmentTextHash,
        });
        confirmed = evaluated.confirmed;
        reason = evaluated.reason;
        markdownConfirmed = evaluated.markdownConfirmed ?? markdownConfirmed;
        fragmentConfirmed = evaluated.fragmentConfirmed ?? fragmentConfirmed;
        canonicalConfirmed = evaluated.canonicalConfirmed ?? canonicalConfirmed;
        canonicalExpectedHash = evaluated.canonicalExpectedHash ?? canonicalExpectedHash;
        canonicalObservedHash = evaluated.canonicalObservedHash ?? canonicalObservedHash;
        expectedFragmentTextHash = evaluated.expectedFragmentTextHash ?? expectedFragmentTextHash;
        liveFragmentTextHash = evaluated.liveFragmentTextHash ?? liveFragmentTextHash;
        if (debugConvergence) {
          console.info('[agent-routes] collab verification diagnostics', {
            slug,
            source: options.source ?? 'agent',
            activeCollabClients,
            confirmed,
            reason,
            markdownConfirmed,
            fragmentConfirmed,
            markdownSource: verification.markdownSource,
            canonicalConfirmed,
            canonicalExpectedHash,
            canonicalObservedHash,
            expectedFragmentTextHash,
            liveFragmentTextHash,
          });
        }

        if (!confirmed && options?.fallbackBarrier) {
          console.warn('[agent-routes] collab verification drift detected; applying rewrite barrier fallback', {
            slug,
            reason,
            yStateVersion: verification.yStateVersion,
          });
          let barrierLocked = false;
          try {
            barrierLocked = true;
            await prepareRewriteCollabBarrier(slug);
          } catch (error) {
            if (barrierLocked) releaseRewriteLock(slug);
            console.warn('[agent-routes] collab fallback barrier failed', { slug, error });
            invalidateLoadedCollabDocument(slug);
            return { confirmed: false, reason: 'fallback_barrier_failed' };
          }

          try {
            const refreshed = getDocumentBySlug(slug);
            if (!refreshed) {
              invalidateLoadedCollabDocument(slug);
              return { confirmed: false, reason: 'missing_document' };
            }
            const refreshedMarks = parseCanonicalMarks(refreshed.marks);
            if (
              refreshed.markdown !== targetMarkdown
              || stableStringify(refreshedMarks) !== stableStringify(targetMarks)
            ) {
              invalidateLoadedCollabDocument(slug);
              return { confirmed: false, reason: 'canonical_changed_during_fallback' };
            }

            const retry = await (async () => {
              // Fallback barrier means we deliberately cut over to a repair/reseed lane.
              // Even callers that normally use verify-only mode need an explicit
              // canonical -> collab sync here before we can trust the retry verdict.
              const syncRetryDeadline = Date.now() + REWRITE_COLLAB_TIMEOUT_MS;
              let syncResult = await syncCanonicalDocumentStateToCollab(slug, {
                markdown: targetMarkdown,
                marks: targetMarks,
                source: `${options.source ?? 'agent'}-fallback`,
              });
              while (
                !syncResult.applied
                && syncResult.reason === 'live_doc_unretrievable'
                && Date.now() < syncRetryDeadline
              ) {
                await sleep(50);
                syncResult = await syncCanonicalDocumentStateToCollab(slug, {
                  markdown: targetMarkdown,
                  marks: targetMarks,
                  source: `${options.source ?? 'agent'}-fallback`,
                });
              }
              if (!syncResult.applied) {
                return {
                  applied: false,
                  confirmed: false,
                  reason: syncResult.reason ?? 'apply_failed',
                  yStateVersion: 0,
                  markdownConfirmed: false,
                  fragmentConfirmed: false,
                  expectedFragmentTextHash: null,
                  liveFragmentTextHash: null,
                  markdownSource: 'none' as const,
                };
              }
              return verifyCanonicalDocumentInLoadedCollab(slug, {
                markdown: targetMarkdown,
                marks: targetMarks,
                source: `${options.source ?? 'agent'}-fallback`,
              }, REWRITE_COLLAB_TIMEOUT_MS);
            })();
            confirmed = retry.confirmed;
            reason = retry.reason;
            markdownConfirmed = retry.markdownConfirmed;
            fragmentConfirmed = retry.fragmentConfirmed;
            expectedFragmentTextHash = retry.expectedFragmentTextHash;
            liveFragmentTextHash = retry.liveFragmentTextHash;
            const retryEvaluated = await finalizeVerification({
              confirmed,
              reason,
              markdownConfirmed,
              fragmentConfirmed,
              markdownSource: retry.markdownSource,
              expectedFragmentTextHash,
              liveFragmentTextHash,
            });
            confirmed = retryEvaluated.confirmed;
            reason = retryEvaluated.reason;
            markdownConfirmed = retryEvaluated.markdownConfirmed ?? markdownConfirmed;
            fragmentConfirmed = retryEvaluated.fragmentConfirmed ?? fragmentConfirmed;
            canonicalConfirmed = retryEvaluated.canonicalConfirmed ?? canonicalConfirmed;
            canonicalExpectedHash = retryEvaluated.canonicalExpectedHash ?? canonicalExpectedHash;
            canonicalObservedHash = retryEvaluated.canonicalObservedHash ?? canonicalObservedHash;
            expectedFragmentTextHash = retryEvaluated.expectedFragmentTextHash ?? expectedFragmentTextHash;
            liveFragmentTextHash = retryEvaluated.liveFragmentTextHash ?? liveFragmentTextHash;
            if (
              !confirmed
              && canonicalConfirmed
              && activeCollabClients === 0
              // Only explicit cold-room proof can upgrade the fallback retry to confirmed.
              && retry.reason === 'no_live_doc'
            ) {
              confirmed = true;
              reason = undefined;
              markdownConfirmed = true;
              fragmentConfirmed = true;
            }
            if (debugConvergence) {
              console.info('[agent-routes] collab verification retry diagnostics', {
                slug,
                confirmed,
                reason,
                markdownConfirmed,
                fragmentConfirmed,
                markdownSource: retry.markdownSource,
                canonicalConfirmed,
                canonicalExpectedHash,
                canonicalObservedHash,
                expectedFragmentTextHash,
                liveFragmentTextHash,
              });
            }
          } finally {
            if (barrierLocked) releaseRewriteLock(slug);
          }
        }

        if (!confirmed && !reason) {
          reason = 'sync_timeout';
        }

        if (!confirmed) {
          console.warn('[agent-routes] rewrite collab verification pending', {
            slug,
            reason,
            yStateVersion: verification.yStateVersion,
            markdownConfirmed,
            fragmentConfirmed,
            markdownSource: verification.markdownSource,
            canonicalConfirmed,
            canonicalExpectedHash,
            canonicalObservedHash,
          });
          invalidateLoadedCollabDocument(slug);
          return {
            confirmed: false,
            reason,
            markdownConfirmed,
            fragmentConfirmed,
            canonicalConfirmed,
            canonicalExpectedHash,
            canonicalObservedHash,
            expectedFragmentTextHash,
            liveFragmentTextHash,
            presenceApplied: false,
            cursorApplied: false,
          };
        }
        verifiedStatus = {
          confirmed: true,
          ...(reason ? { reason } : {}),
          markdownConfirmed,
          fragmentConfirmed,
          canonicalConfirmed,
          canonicalExpectedHash,
          canonicalObservedHash,
          expectedFragmentTextHash,
          liveFragmentTextHash,
          presenceApplied: false,
          cursorApplied: false,
        };
      } else if (options?.apply !== false) {
        const syncResult = await syncCanonicalDocumentStateToCollab(slug, {
          markdown: targetMarkdown,
          marks: targetMarks,
          source: options?.source ?? 'agent',
        });
        if (!syncResult.applied) {
          invalidateLoadedCollabDocument(slug);
          return {
            confirmed: false,
            reason: syncResult.reason ?? 'apply_failed',
            presenceApplied: false,
            cursorApplied: false,
          };
        }
      }
      let presenceApplied = false;
      if (participation?.presenceEntry) {
        try {
          presenceApplied = applyAgentPresenceToLoadedCollab(slug, participation.presenceEntry, {
            type: 'agent.presence',
            ...participation.presenceEntry,
          });
        } catch {
          // ignore
        }
      }
      let cursorApplied = false;
      if (participation?.cursorHint?.quote) {
        try {
          cursorApplied = applyAgentCursorHintToLoadedCollab(slug, {
            id: String(participation.presenceEntry.id),
            tokenId: typeof participation.presenceEntry.tokenId === 'string' ? participation.presenceEntry.tokenId : null,
            quote: participation.cursorHint.quote,
            ttlMs: participation.cursorHint.ttlMs,
            name: typeof participation.presenceEntry.name === 'string' ? participation.presenceEntry.name : undefined,
            color: typeof participation.presenceEntry.color === 'string' ? participation.presenceEntry.color : undefined,
            avatar: typeof participation.presenceEntry.avatar === 'string' ? participation.presenceEntry.avatar : undefined,
          });
        } catch {
          // ignore
        }
      }
      return {
        ...verifiedStatus,
        presenceApplied,
        cursorApplied,
      };
    } catch (error) {
      console.error('[agent-routes] Failed to apply agent mutation into collab runtime:', { slug, error });
      invalidateLoadedCollabDocument(slug);
      return {
        confirmed: false,
        reason: 'apply_failed',
        presenceApplied: false,
        cursorApplied: false,
      };
    } finally {
      broadcastToRoom(slug, {
        type: 'document.updated',
        source: 'agent',
        timestamp: now,
      });
    }
  })();
}

agentRoutes.get('/bug-reports/spec', (_req: Request, res: Response) => {
  res.json({
    success: true,
    ...getBugReportSpec(),
  });
});

agentRoutes.post('/bug-reports', async (req: Request, res: Response) => {
  const validation = validateBugReportSubmission(req.body);
  const requestId = readRequestId(req);
  if (!validation.ok) {
    res.status(422).json({
      success: false,
      code: 'BUG_REPORT_INCOMPLETE',
      missingFields: validation.missingFields,
      suggestedQuestions: validation.suggestedQuestions,
      requestId,
    });
    return;
  }

  const evidence = buildBugReportEvidence(validation.report);
  traceServerIncident({
    requestId,
    slug: validation.report.slug,
    subsystem: 'agent_bug_reports',
    level: 'info',
    eventType: 'received',
    message: 'Received agent bug report submission',
    data: {
      reportType: validation.report.reportType,
      severity: validation.report.severity,
      summary: validation.report.summary,
      reportRequestId: validation.report.requestId,
      occurredAt: validation.report.occurredAt,
      inferredSubsystem: evidence.inferredSubsystem,
      evidenceSummary: evidence.summary,
    },
  });

  try {
    const issue = await createGitHubIssueForBugReport(evidence);
    traceServerIncident({
      requestId,
      slug: validation.report.slug,
      subsystem: 'agent_bug_reports',
      level: 'info',
      eventType: 'github_issue_created',
      message: 'Created GitHub issue for agent bug report',
      data: {
        issueNumber: issue.issueNumber,
        issueUrl: issue.issueUrl,
        labels: issue.labels,
        inferredSubsystem: evidence.inferredSubsystem,
      },
    });
    res.status(201).json({
      success: true,
      issueNumber: issue.issueNumber,
      issueUrl: issue.issueUrl,
      labels: issue.labels,
      inferredSubsystem: evidence.inferredSubsystem,
      primaryRequest: evidence.primaryRequest,
      routeHint: evidence.routeHint,
      routeTemplate: evidence.routeTemplate,
      primaryError: evidence.primaryError,
      suspectedFiles: evidence.suspectedFiles,
      fixerBrief: buildFixerBriefFromEvidence(
        validation.report.summary,
        evidence,
        issue.issueNumber,
        issue.issueUrl,
      ),
      evidenceSummary: evidence.summary,
      requestId,
    });
  } catch (error) {
    const issueError = error as Error & {
      issueNumber?: number;
      issueUrl?: string;
      issueApiUrl?: string;
    };
    const message = issueError instanceof Error ? issueError.message : String(issueError);
    const status = message.includes('PROOF_GITHUB_ISSUES_TOKEN') ? 503 : 502;
    traceServerIncident({
      requestId,
      slug: validation.report.slug,
      subsystem: 'agent_bug_reports',
      level: 'error',
      eventType: 'github_issue_failed',
      message: 'Failed to create GitHub issue for agent bug report',
      data: {
        issueNumber: issueError.issueNumber ?? null,
        issueUrl: issueError.issueUrl ?? null,
        inferredSubsystem: evidence.inferredSubsystem,
        evidenceSummary: evidence.summary,
        ...toErrorTraceData(error),
      },
    });
    res.status(status).json({
      success: false,
      code: 'GITHUB_ISSUE_CREATE_FAILED',
      error: message,
      evidenceCapturedLocally: true,
      issueNumber: issueError.issueNumber ?? null,
      issueUrl: issueError.issueUrl ?? null,
      issueApiUrl: issueError.issueApiUrl ?? null,
      inferredSubsystem: evidence.inferredSubsystem,
      evidenceSummary: evidence.summary,
      requestId,
    });
  }
});

agentRoutes.post('/bug-reports/:issueNumber/follow-up', async (req: Request, res: Response) => {
  const rawIssueNumber = typeof req.params.issueNumber === 'string' ? req.params.issueNumber : '';
  const issueNumber = Number.parseInt(rawIssueNumber, 10);
  const requestId = readRequestId(req);
  if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
    res.status(400).json({
      success: false,
      code: 'INVALID_ISSUE_NUMBER',
      error: 'Issue number must be a positive integer',
      requestId,
    });
    return;
  }

  const validation = validateBugReportFollowUp(req.body);
  if (!validation.ok) {
    res.status(422).json({
      success: false,
      code: 'BUG_REPORT_FOLLOW_UP_INCOMPLETE',
      missingFields: validation.missingFields,
      suggestedQuestions: validation.suggestedQuestions,
      requestId,
    });
    return;
  }

  const evidence = buildBugReportFollowUpEvidence(validation.followUp);
  traceServerIncident({
    requestId,
    slug: validation.followUp.slug,
    subsystem: 'agent_bug_reports',
    level: 'info',
    eventType: 'follow_up_received',
    message: 'Received agent bug report follow-up submission',
    data: {
      issueNumber,
      reportRequestId: validation.followUp.requestId,
      occurredAt: validation.followUp.occurredAt,
      inferredSubsystem: evidence.inferredSubsystem,
      routeHint: evidence.routeHint,
      evidenceSummary: evidence.summary,
    },
  });

  try {
    await appendGitHubBugReportFollowUp(issueNumber, evidence);
    traceServerIncident({
      requestId,
      slug: validation.followUp.slug,
      subsystem: 'agent_bug_reports',
      level: 'info',
      eventType: 'follow_up_comment_created',
      message: 'Appended GitHub follow-up comment for agent bug report',
      data: {
        issueNumber,
        inferredSubsystem: evidence.inferredSubsystem,
        routeHint: evidence.routeHint,
      },
    });
    res.status(201).json({
      success: true,
      issueNumber,
      inferredSubsystem: evidence.inferredSubsystem,
      primaryRequest: evidence.primaryRequest,
      routeHint: evidence.routeHint,
      routeTemplate: evidence.routeTemplate,
      primaryError: evidence.primaryError,
      suspectedFiles: evidence.suspectedFiles,
      fixerBrief: buildFixerBriefFromEvidence(
        validation.followUp.context ?? 'Bug follow-up',
        evidence,
        issueNumber,
        `https://github.com/${process.env.PROOF_GITHUB_ISSUES_OWNER?.trim() || 'EveryInc'}/${process.env.PROOF_GITHUB_ISSUES_REPO?.trim() || 'proof'}/issues/${issueNumber}`,
      ),
      evidenceSummary: evidence.summary,
      requestId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes('PROOF_GITHUB_ISSUES_TOKEN') ? 503 : 502;
    traceServerIncident({
      requestId,
      slug: validation.followUp.slug,
      subsystem: 'agent_bug_reports',
      level: 'error',
      eventType: 'follow_up_comment_failed',
      message: 'Failed to append GitHub follow-up comment for agent bug report',
      data: {
        issueNumber,
        inferredSubsystem: evidence.inferredSubsystem,
        routeHint: evidence.routeHint,
        evidenceSummary: evidence.summary,
        ...toErrorTraceData(error),
      },
    });
    res.status(status).json({
      success: false,
      code: 'GITHUB_ISSUE_FOLLOW_UP_FAILED',
      error: message,
      evidenceCapturedLocally: true,
      issueNumber,
      inferredSubsystem: evidence.inferredSubsystem,
      primaryRequest: evidence.primaryRequest,
      routeHint: evidence.routeHint,
      suspectedFiles: evidence.suspectedFiles,
      evidenceSummary: evidence.summary,
      requestId,
    });
  }
});

agentRoutes.use((req: Request, res: Response, next) => {
  const method = req.method.toUpperCase();
  const path = req.path || '/';
  if (!routeRequiresMutation(method, path)) {
    next();
    return;
  }
  const stage = getMutationContractStage();
  if (!isIdempotencyRequired(stage)) {
    next();
    return;
  }
  const idempotencyKey = getIdempotencyKey(req);
  if (idempotencyKey) {
    next();
    return;
  }
  const slug = getSlug(req) ?? undefined;
  sendMutationResponse(
    res,
    409,
    {
      success: false,
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      error: 'Idempotency-Key header is required for mutation requests in this stage',
    },
    { route: `${method} ${path}`, slug },
  );
});

agentRoutes.use((req: Request, res: Response, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    if (!routeRequiresMutation(req.method.toUpperCase(), req.path || '/')) return;
    recordAgentMutation(
      getMutationRouteLabel(req),
      res.statusCode >= 200 && res.statusCode < 300,
      Date.now() - startedAt,
    );
  });
  next();
});

agentRoutes.get('/:slug/state', async (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) {
    res.status(400).json({ success: false, error: 'Invalid slug' });
    return;
  }
  const role = checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot']);
  if (!role) return;
  ensureAgentPresenceForAuthenticatedCall(req, slug, {}, 'state.read');
  await recoverCanonicalDocumentIfNeeded(slug, 'state');
  const result = await executeDocumentOperationAsync(slug, 'GET', '/state');
  const body = asPayload(result.body);
  const doc = getDocumentBySlug(slug);
  const mutationBase = await resolveRouteMutationBase(slug);
  if (mutationBase) {
    body.mutationBase = {
      token: mutationBase.token,
      source: mutationBase.source,
      schemaVersion: mutationBase.schemaVersion,
    };
  }
  const mutationStage = getMutationContractStage();
  const mutationReady = body.mutationReady !== false;
  const authoritativeMutations = Boolean(mutationBase);
  const revision = mutationReady
    ? (typeof body.revision === 'number' ? body.revision : doc?.revision)
    : null;
  const editV2Enabled = isFeatureEnabled(process.env.AGENT_EDIT_V2_ENABLED);
  if (typeof revision === 'number') {
    body.revision = revision;
  } else if (!mutationReady) {
    body.revision = null;
  }
  if (!mutationReady && body.updatedAt === undefined) {
    body.updatedAt = null;
  }
  body.contract = {
    ...(isRecord(body.contract) ? body.contract : {}),
    mutationStage,
    idempotencyRequired: isIdempotencyRequired(mutationStage),
    preconditionMode: mutationStage === 'A'
      ? 'optional'
      : (mutationStage === 'C' ? 'revision-only' : 'revision-or-updatedAt'),
    supportedPreconditions: ['baseToken', 'baseRevision', 'baseUpdatedAt'],
    preferredPrecondition: mutationBase ? 'baseToken' : (mutationReady ? 'baseRevision' : 'baseUpdatedAt'),
  };
  body.capabilities = {
    ...(isRecord(body.capabilities) ? body.capabilities : {}),
    snapshotV2: editV2Enabled,
    editV2: editV2Enabled && (mutationReady || authoritativeMutations),
    topLevelOnly: editV2Enabled && (mutationReady || authoritativeMutations),
    mutationReady,
    authoritativeMutations,
  };
  const links: Record<string, unknown> = {
    ...(isRecord(body._links) ? body._links : {}),
    create: canonicalCreateLink(),
    state: `/documents/${slug}/state`,
    agentState: `/api/agent/${slug}/state`,
    presence: { method: 'POST', href: `/api/agent/${slug}/presence` },
    events: `/api/agent/${slug}/events/pending?after=0`,
    docs: AGENT_DOCS_PATH,
  };
  if (mutationReady || authoritativeMutations) {
    links.ops = { method: 'POST', href: `/api/agent/${slug}/ops` };
    links.edit = { method: 'POST', href: `/api/agent/${slug}/edit` };
    links.title = { method: 'PUT', href: `/api/documents/${slug}/title` };
  }
  if (editV2Enabled) {
    links.snapshot = `/api/agent/${slug}/snapshot`;
    if (mutationReady || authoritativeMutations) {
      links.editV2 = { method: 'POST', href: `/api/agent/${slug}/edit/v2` };
    } else {
      delete links.editV2;
    }
  }
  if (role === 'owner_bot') {
    links.quarantine = { method: 'POST', href: `/api/agent/${slug}/quarantine` };
    links.repair = { method: 'POST', href: `/api/agent/${slug}/repair` };
    links.cloneFromCanonical = { method: 'POST', href: `/api/agent/${slug}/clone-from-canonical` };
  }
  body._links = links;
  const agent: Record<string, unknown> = {
    ...(isRecord(body.agent) ? body.agent : {}),
    what: 'Proof is a collaborative document editor. This is a shared doc.',
    docs: AGENT_DOCS_PATH,
    createApi: CANONICAL_CREATE_API_PATH,
    stateApi: `/documents/${slug}/state`,
    agentStateApi: `/api/agent/${slug}/state`,
    commentReadApi: `/documents/${slug}/state`,
    commentReadPath: 'marks',
    presenceApi: `/api/agent/${slug}/presence`,
    eventsApi: `/api/agent/${slug}/events/pending`,
    mutationReady,
    authoritativeMutations,
    auth: {
      tokenSource: typeof req.query.token === 'string' && req.query.token.trim()
        ? 'query:token'
        : (typeof req.header('authorization') === 'string'
          ? 'header:authorization'
          : (typeof req.header('x-share-token') === 'string'
            ? 'header:x-share-token'
            : (typeof req.header('x-bridge-token') === 'string' ? 'header:x-bridge-token' : 'cookie-or-none'))),
      headerFormat: AUTH_HEADER_FORMAT,
      altHeader: ALT_SHARE_TOKEN_HEADER_FORMAT,
    },
    mutationContract: body.contract,
  };
  if (mutationReady || authoritativeMutations) {
    agent.opsApi = `/api/agent/${slug}/ops`;
    agent.editApi = `/api/agent/${slug}/edit`;
    agent.titleApi = `/api/documents/${slug}/title`;
  }
  if (editV2Enabled) {
    agent.snapshotApi = `/api/agent/${slug}/snapshot`;
    if (mutationReady || authoritativeMutations) {
      agent.editV2Api = `/api/agent/${slug}/edit/v2`;
    }
  }
  if (role === 'owner_bot') {
    agent.quarantineApi = `/api/agent/${slug}/quarantine`;
    agent.repairApi = `/api/agent/${slug}/repair`;
    agent.cloneFromCanonicalApi = `/api/agent/${slug}/clone-from-canonical`;
  }
  attachReportBugDiscovery({ links, agent, slug });
  body.agent = agent;
  if (!mutationReady) {
    body.help = {
      ...(isRecord(body.help) ? body.help : {}),
      reportBug: buildReportBugHelp({
        slug,
        suggestedSummary: 'Proof projection looks stale while reading document state.',
        suggestedContext: 'State or snapshot returned fallback content, stale metadata, or warned that projection repair is pending.',
        suggestedEvidence: [
          'The full /state or /snapshot response payload',
          'The requestId from the read call, if present',
          'What content looked stale or inconsistent',
        ],
      }),
    };
  }

  // Proof Documents Step 1: line marks, the team and the Issue list, computed from the same
  // markdown this response returns (before span stripping, which the line parser does itself).
  if (typeof body.markdown === 'string' || typeof body.content === 'string') {
    try {
      // Step B3: asks are evaluated against the same lines, and open ones are Issues.
      let askReport: ReturnType<typeof buildAskReport> | null = null;
      const report = await buildIssueReport(
        slug,
        typeof body.markdown === 'string' ? body.markdown : String(body.content),
        isRecord(body.marks) ? body.marks : doc?.marks,
        {
          asks: (lines) => { const built = buildAskReport(slug, lines); askReport = built; return built.issueInputs; },
          teamExtra: askTeamActors(listCanonicalAsks(slug)),
        },
      );
      body.asks = (askReport as ReturnType<typeof buildAskReport> | null)?.asks ?? [];
      links.asks = { method: 'GET', href: `/api/agent/${slug}/asks` };
      links.createAsk = { method: 'POST', href: `/api/agent/${slug}/asks` };
      body.lineMarks = report.lineMarks;
      body.lines = report.lines;
      body.sections = report.sections;
      body.issues = report.issues;
      // Step B3c: an aligned report freezes a snapshot (once per distinct aligned state).
      let snapshot: Awaited<ReturnType<typeof freezeIfAligned>>['snapshot'] = null;
      try {
        snapshot = (await freezeIfAligned(slug, typeof body.markdown === 'string' ? body.markdown : String(body.content), report)).snapshot;
      } catch (error) {
        console.warn('[agent-routes] snapshot freeze failed', { slug, error: String(error) });
      }
      links.snapshots = { method: 'GET', href: `/api/agent/${slug}/snapshots` };
      links.sinceYou = { method: 'GET', href: `/api/agent/${slug}/since-you` };
      body.carriedMarks = report.carried;
      // Step B4c/B4d: uncertain flags, AI review notes, open objections; each Issue has a priority.
      body.flags = report.flags;
      body.reviewNotes = report.reviewNotes;
      body.objections = report.objections;
      body.reviewAidsPolicy = { why: WHY_POLICY, rejectChips: REJECT_CHIPS, uncertain: UNCERTAIN_POLICY, priority: ISSUE_PRIORITY, sitting: SITTING_BUDGET, objections: OBJECTION_POLICY };
      links.flags = { method: 'GET', href: `/api/agent/${slug}/flags` };
      links.notes = { method: 'GET', href: `/api/agent/${slug}/notes` };
      links.objections = { method: 'GET', href: `/api/agent/${slug}/objections` };
      // Steps B4e + B4f: bundles, open alternatives, times-to-live (expiry evaluated at
      // `evaluatedAt`), Explain threads, defined terms and the document's settings (blind).
      body.bundles = report.bundles;
      body.alternatives = report.alternatives;
      body.ttls = report.ttls;
      // {do} action lines (safe slice: approval only by a signed-in person; execution not enabled).
      body.dos = report.dos;
      body.doPolicy = { executionEnabled: DO_POLICY.executionEnabled, approvalSingleUse: DO_POLICY.approvalSingleUse, operations: Object.keys(DO_OPERATIONS) };
      links.dos = { method: 'GET', href: `/api/agent/${slug}/dos` };
      links.createDo = { method: 'POST', href: `/api/agent/${slug}/dos` };
      body.explains = report.explains;
      body.terms = report.terms;
      body.settings = report.settings;
      body.evaluatedAt = report.evaluatedAt;
      body.disagreementLines = report.disagreementLines;
      // Line tiers: decision lines need each person's mark; a context line an AI read is enough.
      body.tiers = report.tiers;
      body.tierPolicy = TIER_POLICY;
      links.tiers = { method: 'GET', href: `/api/agent/${slug}/tiers` };
      links.setTiers = { method: 'POST', href: `/api/agent/${slug}/tiers` };
      body.proofExtrasPolicy = { bundles: BUNDLE_POLICY, alternatives: ALT_POLICY, blind: BLIND_POLICY, explain: EXPLAIN_POLICY, terms: { ...TERM_POLICY, sectionPattern: String(TERM_POLICY.sectionPattern), linePatterns: TERM_POLICY.linePatterns.map(String) }, ttl: TTL_POLICY };
      links.bundles = { method: 'GET', href: `/api/agent/${slug}/bundles` };
      links.alternatives = { method: 'GET', href: `/api/agent/${slug}/alternatives` };
      links.ttl = { method: 'GET', href: `/api/agent/${slug}/ttl` };
      links.explains = { method: 'GET', href: `/api/agent/${slug}/explains` };
      links.terms = { method: 'GET', href: `/api/agent/${slug}/terms` };
      links.settings = { method: 'GET', href: `/api/agent/${slug}/settings` };
      // Step B4f: blind marking. The caller sees other members' positions only on lines it has
      // marked itself (the owner credential with no "by" reads everything).
      if (report.settings.blind) {
        const viewer = blindViewer(req, slug, role);
        body.blind = { on: true, viewer: viewer ?? null };
        if (viewer !== undefined) {
          const lines = report.docLines ?? [];
          const answered = ((askReport as ReturnType<typeof buildAskReport> | null)?.views ?? [])
            .filter(view => view.lineIndex !== null && view.ask.answers.some(a => actorKeyOf(a.by) === actorKeyOf(viewer ?? '')))
            .map(view => view.lineIndex as number);
          const view = blindViewFor({ lines, lineMarks: report.lineMarks, viewer: viewer ?? '', answeredLines: answered, picks: listPicks(slug) });
          body.lineMarks = view.lineMarks;
          body.issues = redactIssues(report.issues, view.revealed);
          body.asks = (body.asks as Array<Record<string, unknown>>).map(ask => redactAsk(ask, view.revealed, viewer ?? ''));
          body.alternatives = redactAltSets(report.alternatives, view.revealed, viewer ?? '');
          body.disagreementLines = report.disagreementLines.filter(index => view.revealed.has(index));
          body.carriedMarks = report.carried.filter(c => view.revealed.has(c.lineIndex) || actorKeyOf(c.by) === actorKeyOf(viewer ?? ''));
          body.blind = { on: true, viewer, revealedLines: [...view.revealed].sort((a, b) => a - b), hiddenPositions: view.hidden };
        }
      }
      // Familiar proxy marks: each person's Familiar and its current proxies, listed apart from
      // lineMarks. They never count: `alignment` above is computed without them.
      let unratifiedProxies = 0;
      try {
        const blindOn = report.settings.blind;
        const viewer = blindOn ? blindViewer(req, slug, role) : undefined;
        const proxyReport = proxyStateReport(slug, report, isRecord(body.marks) ? body.marks : doc?.marks, { viewer });
        body.familiars = proxyReport.familiars;
        body.proxies = proxyReport.proxies;
        unratifiedProxies = proxyReport.unratified;
        body.proxyPolicy = { ...PROXY_POLICY, evidence: EVIDENCE_POLICY };
        links.proxyMarks = { method: 'POST', href: `/api/agent/${slug}/marks/proxy` };
        links.familiars = { method: 'GET', href: `/api/agent/${slug}/familiars` };
      } catch (error) {
        console.warn('[agent-routes] proxy report failed', { slug, error: String(error) });
      }
      // Evidence: an AI line mark without evidence is "claimed".
      if (Array.isArray(body.lineMarks)) {
        body.lineMarks = (body.lineMarks as Array<Record<string, unknown>>).map(mark => (isClaimedMark(mark as { by: string; hidden?: boolean; evidence?: string | null }) ? { ...mark, claimed: true } : mark));
      }
      body.alignment = {
        aligned: report.aligned,
        team: report.team,
        owners: report.owners,
        counts: report.counts,
        unratifiedProxies,
        proxyRule: 'Proxy marks from a Familiar never count until their person ratifies them',
        lastSnapshot: snapshot ? { ...snapshot, ledger: `/api/agent/${slug}/snapshots/${snapshot.id}.md` } : null,
        teamRule: 'Step 1: owner + everyone who has line-marked, commented, replied or suggested + active agent keys (Step B3: + askers and the people asked)',
      };
      links.lineMark = { method: 'POST', href: `/api/agent/${slug}/marks/line` };
    } catch (error) {
      console.warn('[agent-routes] line-mark report failed', { slug, error: String(error) });
    }
  }

  // Strip all Proof span tags from agent-facing markdown so agents see clean text.
  if (typeof body.markdown === 'string') {
    body.markdown = stripAllProofSpanTags(body.markdown);
  }
  if (typeof body.content === 'string') {
    body.content = stripAllProofSpanTags(body.content);
  }

  if (
    (typeof body.readSource === 'string' && body.readSource !== 'projection')
    || body.repairPending === true
    || body.mutationReady === false
  ) {
    traceDegradedCollabRead({
      requestId: readRequestId(req),
      slug,
      surface: 'state',
      route: '/api/agent/:slug/state',
      role,
      shareState: doc?.share_state ?? null,
      readSource: typeof body.readSource === 'string' ? body.readSource : null,
      projectionFresh: typeof body.projectionFresh === 'boolean' ? body.projectionFresh : null,
      repairPending: body.repairPending === true,
      mutationReady,
      fallbackReason: isRecord(body.warning) && typeof body.warning.fallbackReason === 'string'
        ? body.warning.fallbackReason
        : null,
      yjsSource: isRecord(body.warning) && (body.warning.yjsSource === 'live' || body.warning.yjsSource === 'persisted')
        ? body.warning.yjsSource
        : null,
      canWrite: authoritativeMutations || mutationReady,
      sessionDowngraded: false,
    });
  }

  res.status(result.status).json(body);
});

agentRoutes.post('/:slug/quarantine', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /quarantine';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['owner_bot'])) return;
  const routeKey = 'POST /quarantine';
  const replay = await maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;

  const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
    ? req.body.reason.trim().slice(0, 160)
    : 'agent_requested_quarantine';
  const requestedBy = typeof req.body?.by === 'string' && req.body.by.trim()
    ? req.body.by.trim().slice(0, 160)
    : 'owner_bot';
  const note = typeof req.body?.note === 'string' && req.body.note.trim()
    ? req.body.note.trim().slice(0, 2000)
    : null;
  const requestId = readRequestId(req);
  const result = activateDurableCollabQuarantine(slug, {
    reason,
    source: 'agent_route',
    details: {
      by: requestedBy,
      note,
      requestId,
    },
  });

  traceServerIncident({
    slug,
    subsystem: 'agent_routes',
    level: 'warn',
    eventType: 'collab.manual_quarantine',
    message: 'Owner bot manually quarantined collab for a slug',
    data: {
      reason,
      by: requestedBy,
      note,
      requestId,
      accessEpoch: result.accessEpoch,
    },
  });

  const responseBody = {
    success: true,
    slug,
    health: 'quarantined',
    collabAvailable: false,
    code: 'COLLAB_MANUALLY_QUARANTINED',
    reason,
    accessEpoch: result.accessEpoch,
    links: {
      state: `/documents/${slug}/state`,
      agentState: `/api/agent/${slug}/state`,
      repair: { method: 'POST', href: `/api/agent/${slug}/repair` },
      cloneFromCanonical: { method: 'POST', href: `/api/agent/${slug}/clone-from-canonical` },
    },
  };
  storeIdempotentMutationResult(replay, mutationRoute, slug, 200, responseBody);
  sendMutationResponse(res, 200, responseBody, { route: mutationRoute, slug });
});

agentRoutes.get('/:slug/snapshot', async (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) {
    res.status(400).json({ success: false, error: 'Invalid slug' });
    return;
  }
  if (!isFeatureEnabled(process.env.AGENT_EDIT_V2_ENABLED)) {
    res.status(404).json({ success: false, error: 'Edit v2 is disabled', code: 'EDIT_V2_DISABLED' });
    return;
  }
  if (!checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot'])) return;

  const revisionRaw = req.query.revision;
  const includeTextPreviewRaw = req.query.includeTextPreview;

  let revision: number | null = null;
  if (typeof revisionRaw === 'string' && revisionRaw.trim()) {
    const parsed = Number(revisionRaw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      res.status(400).json({ success: false, error: 'Invalid revision', code: 'INVALID_REQUEST' });
      return;
    }
    revision = parsed;
  }

  let includeTextPreview: boolean | undefined;
  if (typeof includeTextPreviewRaw === 'string' && includeTextPreviewRaw.trim()) {
    const normalized = includeTextPreviewRaw.trim().toLowerCase();
    includeTextPreview = !(normalized === 'false' || normalized === '0' || normalized === 'no');
  }

  try {
    const result = await buildAgentSnapshot(slug, { revision, includeTextPreview });
    if (isRecord(result.body) && (result.status >= 500 || result.status === 409 || result.body.warning)) {
      result.body.help = {
        ...(isRecord(result.body.help) ? result.body.help : {}),
        reportBug: buildReportBugHelp({
          slug,
          suggestedSummary: 'Proof snapshot returned stale or inconsistent block data.',
          suggestedContext: 'Snapshot returned stale fallback content, a projection warning, or an internal read error.',
          suggestedEvidence: [
            'The full /snapshot response payload',
            'Any block markdown versus textPreview mismatch you saw',
            'The x-request-id header from the snapshot request, if present',
          ],
        }),
      };
    }
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error('[agent-routes] Failed to build agent snapshot:', { slug, error });
    res.status(500).json({
      success: false,
      error: 'Failed to build snapshot',
      code: 'INTERNAL_ERROR',
      help: {
        reportBug: buildReportBugHelp({
          slug,
          suggestedSummary: 'Proof failed to build a snapshot for this document.',
          suggestedContext: 'The snapshot endpoint returned an internal error while I was trying to read the document.',
          suggestedEvidence: [
            'The failing /snapshot request URL and response body',
            'The x-request-id header, if present',
            'What you were trying to inspect in the document',
          ],
        }),
      },
    });
  }
});

/**
 * After a successful edit/v2 commit: confirm the collab state and tell open pages. Shared by
 * POST /edit/v2 and Step B3's POST /asks with insertAfter (an ask on a new line).
 */
async function settleEditV2Success(req: Request, slug: string, editV2Body: Record<string, unknown>, result: { status: number; body: unknown }): Promise<void> {
  if (!(result.status >= 200 && result.status < 300 && isRecord(result.body))) return;
  const participation = buildParticipationFromMutation(req, slug, editV2Body, { details: 'edit.v2' });
  if (isSingleWriterEditEnabled()) {
    const priorCollab = isRecord(result.body.collab) ? result.body.collab : {};
    const collabApplied = priorCollab.status === 'confirmed';
    let presenceApplied = false;
    let cursorApplied = false;
    if (collabApplied) {
      const appliedParticipation = applyParticipationToLoadedCollab(slug, participation);
      presenceApplied = appliedParticipation.presenceApplied;
      cursorApplied = appliedParticipation.cursorApplied;
    }
    result.body = {
      ...result.body,
      collab: {
        ...priorCollab,
        canonicalStatus: typeof priorCollab.canonicalStatus === 'string'
          ? priorCollab.canonicalStatus
          : (collabApplied ? 'confirmed' : 'pending'),
      },
      presenceApplied,
      cursorApplied,
    };
    if (collabApplied) {
      broadcastToRoom(slug, { type: 'document.updated', source: 'agent-edit-v2', timestamp: new Date().toISOString() });
    }
  } else {
    if (TEST_EDIT_V2_POST_COMMIT_DELAY_MS > 0) {
      await sleep(TEST_EDIT_V2_POST_COMMIT_DELAY_MS);
    }
    const priorCollab = isRecord(result.body.collab) ? result.body.collab : {};
    const priorConfirmed = priorCollab.status === 'confirmed';
    const {
      reason: _priorReason,
      status: _priorStatus,
      markdownStatus: _priorMarkdownStatus,
      fragmentStatus: _priorFragmentStatus,
      canonicalStatus: _priorCanonicalStatus,
      canonicalExpectedHash: _priorCanonicalExpectedHash,
      canonicalObservedHash: _priorCanonicalObservedHash,
      ...priorCollabRest
    } = priorCollab;
    const includeCanonicalDiagnostics = shouldIncludeCanonicalDiagnostics();
    const activeCollabClients = getActiveCollabClientCount(slug);
    if (priorConfirmed && activeCollabClients === 0) {
      result.body = {
        ...result.body,
        collab: {
          ...priorCollabRest,
          ...priorCollab,
          canonicalStatus: typeof priorCollab.canonicalStatus === 'string' ? priorCollab.canonicalStatus : 'confirmed',
          ...(includeCanonicalDiagnostics
            ? {
                canonicalExpectedHash: priorCollab.canonicalExpectedHash ?? null,
                canonicalObservedHash: priorCollab.canonicalObservedHash ?? null,
              }
            : {}),
        },
      };
      broadcastToRoom(slug, { type: 'document.updated', source: 'agent-edit-v2', timestamp: new Date().toISOString() });
    } else {
      const collabStatus = await notifyCollabMutation(
        slug,
        participation,
        {
          verify: true,
          source: 'edit.v2',
          stabilityMs: EDIT_COLLAB_STABILITY_MS,
          fallbackBarrier: !priorConfirmed,
          strictLiveDoc: true,
          apply: false,
        },
      );
      result.body = {
        ...result.body,
        collab: {
          ...priorCollabRest,
          status: collabStatus.confirmed ? 'confirmed' : 'pending',
          markdownStatus: collabStatus.confirmed && collabStatus.markdownConfirmed ? 'confirmed' : 'pending',
          fragmentStatus: collabStatus.confirmed && collabStatus.fragmentConfirmed ? 'confirmed' : 'pending',
          canonicalStatus: collabStatus.canonicalConfirmed ? 'confirmed' : 'pending',
          ...(includeCanonicalDiagnostics
            ? {
                canonicalExpectedHash: collabStatus.canonicalExpectedHash ?? null,
                canonicalObservedHash: collabStatus.canonicalObservedHash ?? null,
              }
            : {}),
          ...(collabStatus.confirmed ? {} : { reason: collabStatus.reason ?? 'sync_timeout' }),
        },
      };
      result.status = collabStatus.confirmed ? 200 : 202;

      if (collabStatus.confirmed) {
        // Only broadcast document.updated after collab confirmation attempt is complete.
        broadcastToRoom(slug, { type: 'document.updated', source: 'agent-edit-v2', timestamp: new Date().toISOString() });
      }
    }
  }
}

agentRoutes.post('/:slug/edit/v2', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /edit/v2';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!isFeatureEnabled(process.env.AGENT_EDIT_V2_ENABLED)) {
    sendMutationResponse(
      res,
      404,
      { success: false, error: 'Edit v2 is disabled', code: 'EDIT_V2_DISABLED' },
      { route: mutationRoute, slug },
    );
    return;
  }
  if (!checkAuth(req, res, slug, ['editor', 'owner_bot'])) return;
  const editV2Body = isRecord(req.body) ? req.body : {};
  ensureAgentPresenceForAuthenticatedCall(req, slug, editV2Body, 'edit.v2');

  const routeKey = 'POST /edit/v2';
  const replay = await maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;

  const result = await applyAgentEditV2(slug, req.body, {
    idempotencyKey: replay.idempotencyKey ?? undefined,
    idempotencyRoute: replay.reservation?.route ?? undefined,
    onCommitted: async (committed) => {
      if (!isRecord(committed.body)) return;
      storeIdempotentMutationResult(replay, mutationRoute, slug, committed.status, committed.body);
    },
  });
  if (result.status >= 200 && result.status < 300 && isRecord(result.body)) {
    await settleEditV2Success(req, slug, editV2Body, result);
  } else if (isRecord(result.body)) {
    storeIdempotentMutationResult(replay, mutationRoute, slug, result.status, result.body);
  } else {
    releaseIdempotentMutationResult(replay, mutationRoute, slug, 'invalid_result_body');
  }

  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

// Apply targeted edit operations (agent-friendly; no compatibility headers).
agentRoutes.post('/:slug/edit', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /edit';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['editor', 'owner_bot'])) return;
  const body = isRecord(req.body) ? req.body : {};
  ensureAgentPresenceForAuthenticatedCall(req, slug, body, 'edit.request');
  const routeKey = mutationRoute;
  const replay = await maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;
  const failEdit = (
    status: number,
    body: Record<string, unknown>,
    reason: string,
    retryWithState?: string,
  ): void => {
    releaseIdempotentMutationResult(replay, mutationRoute, slug, reason);
    sendMutationResponse(
      res,
      status,
      body,
      { route: mutationRoute, slug, ...(retryWithState ? { retryWithState } : {}) },
    );
  };
  const operationsRaw = body.operations;
  const operations = Array.isArray(operationsRaw) ? operationsRaw as unknown[] : [];
  if (operations.length === 0) {
    failEdit(400, { success: false, error: 'operations must be a non-empty array', code: 'INVALID_OPERATIONS' }, 'INVALID_OPERATIONS');
    return;
  }
  if (operations.length > 50) {
    failEdit(400, { success: false, error: 'Too many operations (max 50)', code: 'INVALID_OPERATIONS' }, 'INVALID_OPERATIONS');
    return;
  }

  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'ai:unknown';

  const doc = getDocumentBySlug(slug);
  if (!doc) {
    failEdit(404, { success: false, error: 'Document not found' }, 'document_not_found');
    return;
  }
  const mutationBase = await resolveRouteMutationBase(slug);
  const collabRuntime = getCollabRuntime();
  const singleWriterEditEnabled = isSingleWriterEditEnabled() && collabRuntime.enabled;
  const collabClientBreakdown = collabRuntime.enabled
    ? getActiveCollabClientBreakdown(slug)
    : null;
  const activeCollabClients = collabClientBreakdown?.total ?? 0;
  const hostedRuntime = isHostedRewriteEnvironment();
  res.setHeader('X-Proof-Agent-Routes', '1');
  res.setHeader('X-Proof-Legacy-Edit-Hosted', hostedRuntime ? '1' : '0');
  res.setHeader('X-Proof-Legacy-Edit-Collab', collabRuntime.enabled ? '1' : '0');
  res.setHeader('X-Proof-Legacy-Edit-Clients', String(activeCollabClients));
  const hostedLiveLegacyEditUnsafe = collabRuntime.enabled && hostedRuntime && activeCollabClients > 0;
  if (
    hostedLiveLegacyEditUnsafe
    || (!singleWriterEditEnabled && collabRuntime.enabled && (hostedRuntime || activeCollabClients > 0 || hasUnsafeLegacyEditMarks(doc.marks)))
  ) {
    failEdit(
      409,
      {
        success: false,
        code: 'LEGACY_EDIT_UNSAFE',
        error: hostedLiveLegacyEditUnsafe
          ? 'Legacy /edit is disabled on hosted runtimes while live collaborators are connected; retry with /edit/v2'
          : hostedRuntime
            ? 'Legacy /edit is disabled on hosted runtimes; retry with /edit/v2'
          : 'Legacy /edit is unsafe for live or marked documents; retry with /edit/v2',
        retryWithState: `/api/agent/${slug}/state`,
        recommendedEndpoint: `/api/agent/${slug}/edit/v2`,
      },
      'LEGACY_EDIT_UNSAFE',
      `/api/agent/${slug}/state`,
    );
    return;
  }
  if (!singleWriterEditEnabled && collabRuntime.enabled) {
    console.warn('[agent-routes] legacy /edit allowed in hosted runtime', {
      slug,
      route: mutationRoute,
      accessEpoch: collabClientBreakdown?.accessEpoch ?? null,
      activeCollabClients,
      exactEpochCount: collabClientBreakdown?.exactEpochCount ?? 0,
      anyEpochCount: collabClientBreakdown?.anyEpochCount ?? 0,
      documentLeaseExactCount: collabClientBreakdown?.documentLeaseExactCount ?? 0,
      documentLeaseAnyEpochCount: collabClientBreakdown?.documentLeaseAnyEpochCount ?? 0,
      recentLeaseCount: collabClientBreakdown?.recentLeaseCount ?? 0,
    });
  }
  const stage = getMutationContractStage();
  const precondition = validateEditPrecondition(stage, doc, body, mutationBase?.token ?? null);
  if (!precondition.ok) {
    failEdit(
      precondition.status,
      {
        success: false,
        code: precondition.code,
        error: precondition.error,
        latestUpdatedAt: doc.updated_at,
        latestRevision: doc.revision,
        retryWithState: `/api/agent/${slug}/state`,
      },
      precondition.code,
      `/api/agent/${slug}/state`,
    );
    return;
  }

  const baseMarkdown = doc.markdown ?? '';
  const operationBase = mutationBase
    ? {
        markdown: mutationBase.markdown,
        source: (mutationBase.source === 'projection' || mutationBase.source === 'canonical_row') ? 'db' as const : 'live' as const,
        activeCollabClients,
      }
    : await resolveEditOperationBaseMarkdown(slug, mutationRoute, baseMarkdown, collabRuntime.enabled);
  const operationBaseMarkdown = operationBase.markdown;
  const collabBase = collabRuntime.enabled ? await getLoadedCollabMarkdownFromFragment(slug) : null;
  const singleWriterMode = singleWriterEditEnabled;
  const authoritativeDoc = singleWriterMode
    ? ((await getCanonicalReadableDocument(slug, 'state')) ?? doc)
    : doc;
  const authoritativeMarks = mutationBase?.marks ?? parseCanonicalMarks(authoritativeDoc.marks);
  if (operationBase.source === 'db' && collabBase !== null && collabBase !== baseMarkdown) {
    console.warn('[agent-routes] /edit detected collab/base drift without active clients; using canonical DB markdown for op application', {
      slug,
      route: mutationRoute,
      collabLength: collabBase.length,
      canonicalLength: baseMarkdown.length,
    });
  }

  const parsedOps: AgentEditOperation[] = [];
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    if (!isRecord(op) || typeof op.op !== 'string') {
      failEdit(400, { success: false, code: 'INVALID_OPERATIONS', error: `Invalid operation at index ${i}` }, 'INVALID_OPERATIONS');
      return;
    }
    const kind = op.op;
    if (kind === 'append') {
      if (typeof op.section !== 'string' || typeof op.content !== 'string') {
        failEdit(400, { success: false, code: 'INVALID_OPERATIONS', error: `append requires section + content (index ${i})` }, 'INVALID_OPERATIONS');
        return;
      }
      if (op.content.length > 200_000) {
        failEdit(400, { success: false, code: 'INVALID_OPERATIONS', error: `content too large (index ${i})` }, 'INVALID_OPERATIONS');
        return;
      }
      parsedOps.push({ op: 'append', section: op.section, content: op.content });
      continue;
    }
    if (kind === 'replace') {
      if (typeof op.content !== 'string') {
        failEdit(400, { success: false, code: 'INVALID_OPERATIONS', error: `replace requires content (index ${i})` }, 'INVALID_OPERATIONS');
        return;
      }
      if (op.content.length > 200_000) {
        failEdit(400, { success: false, code: 'INVALID_OPERATIONS', error: `content too large (index ${i})` }, 'INVALID_OPERATIONS');
        return;
      }
      let target: AgentEditTarget | undefined;
      if (Object.prototype.hasOwnProperty.call(op, 'target')) {
        const parsedTarget = parseAgentEditTarget(op.target);
        if (!parsedTarget.ok) {
          failEdit(400, { success: false, code: 'INVALID_OPERATIONS', error: `${parsedTarget.error} (index ${i})` }, 'INVALID_OPERATIONS');
          return;
        }
        target = parsedTarget.target;
      }

      if (!target && typeof op.search !== 'string') {
        failEdit(
          400,
          { success: false, code: 'INVALID_OPERATIONS', error: `replace requires search or target.anchor + content (index ${i})` },
          'INVALID_OPERATIONS',
        );
        return;
      }
      const legacySearch = typeof op.search === 'string' ? op.search : undefined;

      parsedOps.push({
        op: 'replace',
        content: op.content,
        ...(target ? { target } : { search: legacySearch }),
      });
      continue;
    }
    if (kind === 'insert') {
      if (Object.prototype.hasOwnProperty.call(op, 'before')) {
        failEdit(
          400,
          {
            success: false,
            code: 'INVALID_OPERATIONS',
            error: `insert.before is not supported; use insert.after (index ${i})`,
          },
          'INVALID_OPERATIONS',
        );
        return;
      }
      if (typeof op.content !== 'string') {
        failEdit(400, { success: false, code: 'INVALID_OPERATIONS', error: `insert requires content (index ${i})` }, 'INVALID_OPERATIONS');
        return;
      }
      if (op.content.length > 200_000) {
        failEdit(400, { success: false, code: 'INVALID_OPERATIONS', error: `content too large (index ${i})` }, 'INVALID_OPERATIONS');
        return;
      }
      let target: AgentEditTarget | undefined;
      if (Object.prototype.hasOwnProperty.call(op, 'target')) {
        const parsedTarget = parseAgentEditTarget(op.target);
        if (!parsedTarget.ok) {
          failEdit(400, { success: false, code: 'INVALID_OPERATIONS', error: `${parsedTarget.error} (index ${i})` }, 'INVALID_OPERATIONS');
          return;
        }
        target = parsedTarget.target;
      }

      if (!target && typeof op.after !== 'string') {
        failEdit(
          400,
          { success: false, code: 'INVALID_OPERATIONS', error: `insert requires after or target.anchor + content (index ${i})` },
          'INVALID_OPERATIONS',
        );
        return;
      }
      const legacyAfter = typeof op.after === 'string' ? op.after : undefined;

      parsedOps.push({
        op: 'insert',
        content: op.content,
        ...(target ? { target } : { after: legacyAfter }),
      });
      continue;
    }
    failEdit(400, { success: false, code: 'INVALID_OPERATIONS', error: `Unknown op: ${JSON.stringify(kind)} (index ${i})` }, 'INVALID_OPERATIONS');
    return;
  }
  const applied = applyAgentEditOperations(operationBaseMarkdown, parsedOps, { by });
  if (!applied.ok) {
    if (applied.code === 'ANCHOR_AMBIGUOUS') {
      recordEditAnchorAmbiguous(mutationRoute, applied.details.mode);
    } else if (applied.code === 'ANCHOR_NOT_FOUND') {
      recordEditAnchorNotFound(mutationRoute, applied.details.mode);
    }
    if (applied.details.remapUsed) {
      recordEditAuthoredSpanRemap(mutationRoute, applied.details.mode);
    }
    // Do NOT reconcile collab state on edit failure — the in-memory collab doc may have
    // newer unsaved changes from connected clients. Forcing DB state into collab here
    // would overwrite those changes and risk data loss.
    failEdit(
      409,
      {
        success: false,
        code: applied.code,
        error: applied.message,
        opIndex: applied.opIndex,
        details: {
          candidateCount: applied.details.candidateCount,
          mode: applied.details.mode,
          remapUsed: applied.details.remapUsed,
        },
        nextSteps: applied.nextSteps,
        retryWithState: `/api/agent/${slug}/state`,
      },
      applied.code,
      `/api/agent/${slug}/state`,
    );
    return;
  }

  for (const entry of applied.metadata) {
    if (entry.remapUsed) {
      recordEditAuthoredSpanRemap(mutationRoute, entry.mode);
    }
  }
  if (applied.structuralCleanupApplied) {
    recordEditStructuralCleanupApplied(mutationRoute);
  }

  const nextMarkdown = applied.markdown;
  let updated = getDocumentBySlug(slug);

  // Presence and cursor are a byproduct of mutations: every successful edit implies
  // the agent has "joined" the doc for a short TTL.
  const details = typeof body.details === 'string'
    ? body.details
    : typeof body.summary === 'string'
      ? body.summary
      : null;
  const quoteFromOps = (() => {
    const last = parsedOps[parsedOps.length - 1] as AgentEditOperation | undefined;
    if (!last) return null;
    if (last.op === 'append' || last.op === 'insert' || last.op === 'replace') {
      const content = (last as any).content;
      if (typeof content === 'string' && content.trim()) return content.trim().slice(0, 600);
    }
    return null;
  })();

  const participation = buildParticipationFromMutation(req, slug, body, { quote: quoteFromOps, details });
  const collabSampleStartedAt = Date.now();
  let collabStatus: CollabMutationStatus;
  let commitId: string | null = null;

  if (singleWriterMode) {
    const mutationResult = await applySingleWriterMutation({
      slug,
      markdown: nextMarkdown,
      marks: authoritativeMarks,
      source: by,
      timeoutMs: REWRITE_COLLAB_TIMEOUT_MS,
      stabilityMs: EDIT_COLLAB_STABILITY_MS,
      stabilitySampleMs: EDIT_COLLAB_STABILITY_SAMPLE_MS,
      precondition: precondition.mode === 'token'
        ? { mode: 'token', value: precondition.baseToken as string }
        : precondition.mode === 'revision'
          ? { mode: 'revision', value: precondition.baseRevision as number }
          : precondition.mode === 'updatedAt'
            ? { mode: 'updatedAt', value: precondition.baseUpdatedAt as string }
            : { mode: 'none' },
      strictLiveDoc: true,
      activeCollabClients: operationBase.activeCollabClients,
      guardPathologicalGrowth: true,
    });

    if (!mutationResult.ok && mutationResult.code === 'stale_base') {
      failEdit(
        409,
        {
          success: false,
          code: precondition.mode === 'token' ? 'STALE_BASE' : 'STALE_BASE',
          error: precondition.mode === 'token'
            ? 'Document changed since baseToken'
            : 'Document has changed; retry with latest state',
          latestUpdatedAt: mutationResult.latestUpdatedAt ?? null,
          latestRevision: mutationResult.latestRevision ?? null,
          retryWithState: `/api/agent/${slug}/state`,
        },
        'STALE_BASE',
        `/api/agent/${slug}/state`,
      );
      return;
    }
    if (!mutationResult.ok && mutationResult.code === 'missing_document') {
      failEdit(404, { success: false, error: 'Document not found' }, 'document_not_found');
      return;
    }
    if (!mutationResult.ok && mutationResult.code === 'live_doc_unavailable') {
      failEdit(
        503,
        {
          success: false,
          code: 'LIVE_DOC_UNAVAILABLE',
          error: 'Live collaborative document unavailable while clients are connected',
          retryWithState: `/api/agent/${slug}/state`,
        },
        'LIVE_DOC_UNAVAILABLE',
        `/api/agent/${slug}/state`,
      );
      return;
    }
    if (!mutationResult.ok && mutationResult.code === 'persisted_yjs_corrupt') {
      failEdit(
        409,
        {
          success: false,
          code: 'PERSISTED_YJS_CORRUPT',
          error: 'Persisted collaborative state is corrupt; document is quarantined until repair',
          latestUpdatedAt: mutationResult.latestUpdatedAt ?? null,
          latestRevision: mutationResult.latestRevision ?? null,
          retryWithState: `/api/agent/${slug}/state`,
        },
        'PERSISTED_YJS_CORRUPT',
        `/api/agent/${slug}/state`,
      );
      return;
    }
    if (!mutationResult.ok && mutationResult.code === 'persisted_yjs_diverged') {
      failEdit(
        409,
        {
          success: false,
          code: 'PERSISTED_YJS_DIVERGED',
          error: 'Persisted collaborative state diverged from the canonical mutation; durable append was blocked for safety',
          latestUpdatedAt: mutationResult.latestUpdatedAt ?? null,
          latestRevision: mutationResult.latestRevision ?? null,
          retryWithState: `/api/agent/${slug}/state`,
        },
        'PERSISTED_YJS_DIVERGED',
        `/api/agent/${slug}/state`,
      );
      return;
    }
    if (!mutationResult.ok && mutationResult.code === 'apply_failed') {
      failEdit(
        503,
        {
          success: false,
          code: 'COLLAB_SYNC_FAILED',
          error: 'Failed to commit mutation through collab writer',
          retryWithState: `/api/agent/${slug}/state`,
        },
        'COLLAB_SYNC_FAILED',
        `/api/agent/${slug}/state`,
      );
      return;
    }

    updated = mutationResult.document ?? getDocumentBySlug(slug);
    if (!updated) {
      failEdit(500, { success: false, error: 'Document update persisted but could not be reloaded' }, 'document_reload_failed');
      return;
    }

    commitId = mutationResult.ok ? mutationResult.commitId : null;
    collabStatus = {
      confirmed: Boolean(mutationResult.ok),
      reason: mutationResult.ok
        ? mutationResult.policy.reason
        : (mutationResult.policy?.reason ?? mutationResult.reason),
      markdownConfirmed: mutationResult.verification?.markdownConfirmed,
      fragmentConfirmed: mutationResult.verification?.fragmentConfirmed,
      canonicalConfirmed: true,
      expectedFragmentTextHash: mutationResult.verification?.expectedFragmentTextHash ?? null,
      liveFragmentTextHash: mutationResult.verification?.liveFragmentTextHash ?? null,
    };
  } else {
    const mutation = await mutateCanonicalDocument({
      slug,
      nextMarkdown,
      nextMarks: authoritativeMarks,
      source: `legacy-edit:${by}`,
      ...(precondition.mode === 'token'
        ? { baseToken: precondition.baseToken as string }
        : precondition.mode === 'revision'
          ? { baseRevision: precondition.baseRevision as number }
          : precondition.mode === 'updatedAt'
            ? { baseUpdatedAt: precondition.baseUpdatedAt as string }
            : {}),
      strictLiveDoc: false,
      guardPathologicalGrowth: true,
    });
    if (!mutation.ok) {
      const latest = getDocumentBySlug(slug);
      failEdit(
        mutation.status,
        {
          success: false,
          code: mutation.code,
          error: mutation.error,
          latestUpdatedAt: latest?.updated_at ?? null,
          latestRevision: latest?.revision ?? null,
          ...(mutation.retryWithState ? { retryWithState: mutation.retryWithState } : { retryWithState: `/api/agent/${slug}/state` }),
        },
        mutation.code,
        mutation.retryWithState ?? `/api/agent/${slug}/state`,
      );
      return;
    }

    updated = mutation.document;
    if (!updated) {
      failEdit(500, { success: false, error: 'Document update persisted but could not be reloaded' }, 'document_reload_failed');
      return;
    }

    collabStatus = await notifyCollabMutation(
      slug,
      participation,
      {
        verify: true,
        source: by,
        stabilityMs: EDIT_COLLAB_STABILITY_MS,
        fallbackBarrier: true,
        strictLiveDoc: true,
        apply: false,
      },
    );
  }

  if (!updated) {
    failEdit(500, { success: false, error: 'Document update persisted but could not be reloaded' }, 'document_reload_failed');
    return;
  }

  try {
    await rebuildDocumentBlocks(updated, updated.markdown, updated.revision);
  } catch (error) {
    console.error('[agent-routes] Failed to rebuild block index after v1 edit:', { slug, error });
  }

  addDocumentEvent(slug, 'agent.edit', { by, operations: parsedOps }, by);

  const convergenceSampleMs = Date.now() - collabSampleStartedAt;
  const collabApplied = deriveCollabApplied(collabStatus);
  let presenceApplied = false;
  let cursorApplied = false;
  if (singleWriterMode) {
    if (collabApplied) {
      const appliedParticipation = applyParticipationToLoadedCollab(slug, participation);
      presenceApplied = appliedParticipation.presenceApplied;
      cursorApplied = appliedParticipation.cursorApplied;
    }
  } else {
    presenceApplied = derivePresenceApplied(collabStatus);
    cursorApplied = deriveCursorApplied(collabStatus);
  }
  const expectedMarkdownHash = hashMarkdown(updated.markdown ?? '');
  const liveMarkdown = await getLoadedCollabMarkdownFromFragment(slug);
  const liveMarkdownHash = typeof liveMarkdown === 'string' ? hashMarkdown(liveMarkdown) : null;
  const markdownStatus = collabApplied && collabStatus.markdownConfirmed ? 'confirmed' : 'pending';
  const fragmentStatus = collabApplied && collabStatus.fragmentConfirmed ? 'confirmed' : 'pending';
  const canonicalStatus = collabStatus.canonicalConfirmed ? 'confirmed' : 'pending';
  const includeCanonicalDiagnostics = shouldIncludeCanonicalDiagnostics();

  const responseBody = {
    success: true,
    slug,
    updatedAt: updated.updated_at,
    collabApplied,
    collab: {
      status: collabApplied ? 'confirmed' : 'pending',
      markdownStatus,
      fragmentStatus,
      canonicalStatus,
      ...(commitId ? { commitId } : {}),
      ...(includeCanonicalDiagnostics
        ? {
            canonicalExpectedHash: collabStatus.canonicalExpectedHash ?? null,
            canonicalObservedHash: collabStatus.canonicalObservedHash ?? null,
          }
        : {}),
      ...(collabApplied ? {} : { reason: collabStatus.reason ?? 'sync_timeout' }),
    },
    presenceApplied,
    cursorApplied,
    expectedMarkdownHash,
    liveMarkdownHash,
    expectedFragmentTextHash: collabStatus.expectedFragmentTextHash ?? null,
    liveFragmentTextHash: collabStatus.liveFragmentTextHash ?? null,
    convergenceSampleMs,
    _links: {
      view: `/d/${encodeURIComponent(slug)}`,
      create: canonicalCreateLink(),
      state: `/documents/${slug}/state`,
      agentState: `/api/agent/${slug}/state`,
      ops: { method: 'POST', href: `/api/agent/${slug}/ops` },
      edit: { method: 'POST', href: `/api/agent/${slug}/edit` },
      presence: { method: 'POST', href: `/api/agent/${slug}/presence` },
      events: `/api/agent/${slug}/events/pending?after=0`,
      docs: AGENT_DOCS_PATH,
    },
    agent: {
      what: 'Proof is a collaborative document editor. This is a shared doc.',
      docs: AGENT_DOCS_PATH,
      createApi: CANONICAL_CREATE_API_PATH,
      stateApi: `/documents/${slug}/state`,
      agentStateApi: `/api/agent/${slug}/state`,
      opsApi: `/api/agent/${slug}/ops`,
      editApi: `/api/agent/${slug}/edit`,
      presenceApi: `/api/agent/${slug}/presence`,
      eventsApi: `/api/agent/${slug}/events/pending`,
    },
  } satisfies Record<string, unknown>;
  attachReportBugDiscovery({
    links: responseBody._links as Record<string, unknown>,
    agent: responseBody.agent as Record<string, unknown>,
    slug,
  });

  storeIdempotentMutationResult(replay, mutationRoute, slug, 200, responseBody);
  sendMutationResponse(res, 200, responseBody, { route: mutationRoute, slug });
});

agentRoutes.post('/:slug/presence', (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) {
    res.status(400).json({ success: false, error: 'Invalid slug' });
    return;
  }
  if (!checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot'])) return;

  const body = isRecord(req.body) ? req.body : {};
  const now = new Date().toISOString();

  const identity = resolveExplicitAgentIdentity(body, req.header('x-agent-id'));
  if (identity.kind !== 'ok') {
    res.status(400).json({
      success: false,
      code: 'INVALID_AGENT_IDENTITY',
      error: 'Explicit agent identity is required. Supply X-Agent-Id, agentId, or agent.id.',
    });
    return;
  }

  const { id: agentId, name, color, avatar } = identity;
  if (agentId && agentId !== 'ai:unknown') {
    upgradeProvisionalAutoPresence(req, slug, agentId);
  }

  const entry = {
    id: agentId,
    name,
    color,
    avatar,
    status: typeof body.status === 'string' && body.status.trim() ? body.status.trim() : 'idle',
    details: typeof body.details === 'string'
      ? body.details
      : typeof body.summary === 'string'
        ? body.summary
        : '',
    at: now,
    expiresAt: getAgentPresenceExpiresAt(now),
    tokenId: agentRequestTokenIds.get(req) ?? null,
  };

  const activity = {
    type: 'agent.presence',
    ...entry,
  };

  addDocumentEvent(slug, 'agent.presence', entry, agentId);

  const collabApplied = applyAgentPresenceToLoadedCollab(slug, entry, activity);

  broadcastToRoom(slug, { type: 'agent.presence', source: 'agent', timestamp: now, ...entry });

  res.json({
    success: true,
    slug,
    collabApplied,
    _links: {
      create: canonicalCreateLink(),
      state: `/documents/${slug}/state`,
      agentState: `/api/agent/${slug}/state`,
      ops: { method: 'POST', href: `/api/agent/${slug}/ops` },
      edit: { method: 'POST', href: `/api/agent/${slug}/edit` },
      presence: { method: 'POST', href: `/api/agent/${slug}/presence` },
      events: `/api/agent/${slug}/events/pending?after=0`,
      docs: AGENT_DOCS_PATH,
    },
    agent: {
      what: 'Proof is a collaborative document editor. This is a shared doc.',
      docs: AGENT_DOCS_PATH,
      createApi: CANONICAL_CREATE_API_PATH,
      stateApi: `/documents/${slug}/state`,
      agentStateApi: `/api/agent/${slug}/state`,
      opsApi: `/api/agent/${slug}/ops`,
      editApi: `/api/agent/${slug}/edit`,
      presenceApi: `/api/agent/${slug}/presence`,
      eventsApi: `/api/agent/${slug}/events/pending`,
    },
  });
});

agentRoutes.post('/:slug/presence/disconnect', (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) {
    res.status(400).json({ success: false, error: 'Invalid slug' });
    return;
  }
  const role = checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot']);
  if (!role) return;
  if (role !== 'editor' && role !== 'owner_bot') {
    res.status(403).json({ success: false, error: 'Insufficient role for presence disconnect' });
    return;
  }

  const body = isRecord(req.body) ? req.body : {};
  const rawAgentId = typeof body.agentId === 'string' && body.agentId.trim()
    ? body.agentId.trim()
    : typeof body.id === 'string' && body.id.trim()
      ? body.id.trim()
      : '';
  if (!rawAgentId) {
    res.status(400).json({ success: false, error: 'agentId is required' });
    return;
  }
  const agentId = normalizeAgentScopedId(rawAgentId);
  if (!agentId) {
    res.status(400).json({ success: false, code: 'INVALID_AGENT_IDENTITY', error: 'agentId must be agent-scoped' });
    return;
  }

  const now = new Date().toISOString();
  const actor = typeof body.by === 'string' && body.by.trim()
    ? body.by.trim()
    : 'human:collaborator';
  const details = typeof body.details === 'string' ? body.details : 'Disconnected by collaborator';
  const activity = {
    type: 'agent.disconnected',
    id: agentId,
    status: 'disconnected',
    details,
    at: now,
  };

  const collabApplied = removeAgentPresenceFromLoadedCollab(slug, agentId, activity);
  const disconnected = true;
  addDocumentEvent(slug, 'agent.disconnected', activity, actor);
  broadcastToRoom(slug, {
    type: 'agent.presence',
    source: 'agent',
    timestamp: now,
    id: agentId,
    status: 'disconnected',
    disconnected: true,
    collabApplied,
  });

  res.json({
    success: true,
    slug,
    agentId,
    collabApplied,
    disconnected,
  });
});

// Canonical operations endpoint for comments/suggestions/rewrite (agent-friendly; no compatibility headers).
agentRoutes.post('/:slug/ops', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /ops';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }

  const parsed = parseDocumentOpRequest(req.body);
  if ('error' in parsed) {
    sendMutationResponse(res, 400, { success: false, error: parsed.error }, { route: mutationRoute, slug });
    return;
  }
  const { op, payload } = parsed;
  const routeKey = `${mutationRoute}:${op}`;

  const doc = getDocumentBySlug(slug);
  if (!doc) {
    sendMutationResponse(res, 404, { success: false, error: 'Document not found' }, { route: mutationRoute, slug });
    return;
  }

  const secret = getPresentedSecret(req, slug);
  const access = secret ? resolveDocumentAccess(slug, secret) : null;
  const role = access?.role ?? null;
  if (!role) {
    sendMutationResponse(res, 401, { success: false, error: 'Missing or invalid share token', code: 'UNAUTHORIZED' }, { route: mutationRoute, slug });
    return;
  }
  const effectiveShareState = getEffectiveShareStateForRole(doc, role, Boolean(secret && role));
  const denied = authorizeDocumentOp(op, role, role === 'owner_bot', effectiveShareState);
  if (denied) {
    const status = denied.includes('revoked') ? 403 : denied.includes('deleted') ? 410 : 403;
    traceServerIncident({
      slug,
      subsystem: 'agent_routes',
      level: 'warn',
      eventType: 'document_op.denied',
      message: 'Agent document operation denied by share-role authorization',
      data: {
        route: mutationRoute,
        op,
        role,
        denied,
        effectiveShareState,
      },
    });
    sendMutationResponse(res, status, { success: false, error: denied }, { route: mutationRoute, slug });
    return;
  }

  agentRequestTokenIds.set(req, access?.tokenId ?? null);
  // Step B4c: suggestion.add carries a "why" like the suggest-* routes.
  let opsWhyGate: WhyGate | null = null;
  if (op === 'suggestion.add') {
    opsWhyGate = suggestionWhyGate(req, res, slug, payload, mutationRoute);
    if (!opsWhyGate) return;
  }
  const participationBody = { ...asPayload(req.body), ...payload };
  ensureAgentPresenceForAuthenticatedCall(req, slug, participationBody, 'ops.request');
  const requestId = readRequestId(req);

  const replay = await maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;
  const failOps = (
    status: number,
    body: Record<string, unknown>,
    reason: string,
    retryWithState?: string,
  ): void => {
    releaseIdempotentMutationResult(replay, mutationRoute, slug, reason);
    sendMutationResponse(
      res,
      status,
      body,
      { route: mutationRoute, slug, ...(retryWithState ? { retryWithState } : {}) },
    );
  };

  const mutationContext = await enforceMutationPrecondition(res, slug, mutationRoute, op, payload, replay);
  if (!mutationContext) return;

  const opRoute = resolveDocumentOpRoute(op, payload);
  if (!opRoute) {
    failOps(400, { success: false, error: 'Unsupported operation payload' }, 'unsupported_operation_payload');
    return;
  }

  let rewriteGate: ReturnType<typeof evaluateRewriteLiveClientGate> | null = null;
  const preBarrierMutationBase = (
    op === 'rewrite.apply'
    && mutationContext.precondition?.mode === 'token'
    && mutationContext.mutationBase
  )
    ? mutationContext.mutationBase
    : null;
  let promotedBarrierBaseToken: string | null = null;
  if (op === 'rewrite.apply') {
    const rewriteValidationError = validateRewriteApplyPayload(payload);
    if (rewriteValidationError) {
      failOps(400, { success: false, error: rewriteValidationError }, 'invalid_rewrite_payload');
      return;
    }
    rewriteGate = evaluateRewriteLiveClientGateWithOptions(slug, payload, {
      route: mutationRoute,
      requestId,
    });
    if (rewriteGate.blocked) {
      recordRewriteLiveClientBlock(
        mutationRoute,
        rewriteGate.runtimeEnvironment,
        rewriteGate.forceRequested,
        rewriteGate.forceIgnored,
      );
      if (rewriteGate.forceIgnored) {
        recordRewriteForceIgnored(mutationRoute, rewriteGate.runtimeEnvironment);
      }
      console.warn('[agent-routes] rewrite blocked by live clients', {
        slug,
        route: mutationRoute,
        connectedClients: rewriteGate.connectedClients,
        forceRequested: rewriteGate.forceRequested,
        forceHonored: rewriteGate.forceHonored,
        forceIgnored: rewriteGate.forceIgnored,
        runtimeEnvironment: rewriteGate.runtimeEnvironment,
      });
      traceServerIncident({
        slug,
        subsystem: 'agent_routes',
        level: 'warn',
        eventType: 'rewrite.blocked_live_clients',
        message: 'Agent rewrite was blocked because live clients were connected',
        data: {
          route: mutationRoute,
          connectedClients: rewriteGate.connectedClients,
          forceRequested: rewriteGate.forceRequested,
          forceHonored: rewriteGate.forceHonored,
          forceIgnored: rewriteGate.forceIgnored,
          runtimeEnvironment: rewriteGate.runtimeEnvironment,
        },
      });
      failOps(409, rewriteBlockedResponseBody(rewriteGate, slug), 'rewrite_blocked_live_clients', `/api/agent/${slug}/state`);
      return;
    }
    console.warn('[agent-routes] rewrite allowed in hosted runtime', {
      slug,
      route: mutationRoute,
      connectedClients: rewriteGate.connectedClients,
      accessEpoch: rewriteGate.accessEpoch,
      exactEpochCount: rewriteGate.exactEpochCount,
      anyEpochCount: rewriteGate.anyEpochCount,
      documentLeaseExactCount: rewriteGate.documentLeaseExactCount,
      documentLeaseAnyEpochCount: rewriteGate.documentLeaseAnyEpochCount,
      recentLeaseCount: rewriteGate.recentLeaseCount,
      forceRequested: rewriteGate.forceRequested,
      runtimeEnvironment: rewriteGate.runtimeEnvironment,
    });
    const barrierStartedAt = Date.now();
    try {
      await prepareRewriteCollabBarrier(slug, {
        validateWhileLocked: async () => {
          const lockedDoc = getDocumentBySlug(slug) ?? mutationContext.doc;
          const currentMutationBase = mutationContext.precondition?.mode === 'token'
            ? await resolveRouteMutationBase(slug)
            : null;
          const lockedPrecondition = validateOpPrecondition(
            getMutationContractStage(),
            op,
            lockedDoc,
            payload,
            currentMutationBase?.token ?? null,
          );
          if (!lockedPrecondition.ok) {
            throw new RewriteBarrierPreconditionError(lockedPrecondition);
          }
        },
      });
      if (mutationContext.precondition?.mode === 'token' && preBarrierMutationBase) {
        const postBarrierMutationBase = await resolveRouteMutationBase(slug);
        const barrierOnlyTokenDrift = (
          postBarrierMutationBase
          && mutationContext.precondition.baseToken === preBarrierMutationBase.token
          && postBarrierMutationBase.token !== preBarrierMutationBase.token
          && sameRouteMutationBaseContent(postBarrierMutationBase, preBarrierMutationBase)
        );
        if (barrierOnlyTokenDrift) {
          promotedBarrierBaseToken = postBarrierMutationBase.token;
        }
      }
      recordRewriteBarrierLatency(mutationRoute, Date.now() - barrierStartedAt);
    } catch (error) {
      if (error instanceof RewriteBarrierPreconditionError) {
        const latestDoc = getDocumentBySlug(slug) ?? mutationContext.doc;
        failOps(
          error.status,
          {
            success: false,
            code: error.code,
            error: error.message,
            latestUpdatedAt: latestDoc.updated_at,
            latestRevision: latestDoc.revision,
            retryWithState: `/api/agent/${slug}/state`,
          },
          error.code,
          `/api/agent/${slug}/state`,
        );
        return;
      }
      const reason = classifyRewriteBarrierFailureReason(error);
      recordRewriteBarrierFailure(mutationRoute, reason);
      recordRewriteBarrierLatency(mutationRoute, Date.now() - barrierStartedAt);
      traceServerIncident({
        slug,
        subsystem: 'agent_routes',
        level: 'error',
        eventType: 'rewrite.barrier_failed',
        message: 'Agent rewrite failed because the collab barrier could not complete',
        data: {
          route: mutationRoute,
          reason,
          ...toErrorTraceData(error),
        },
      });
      failOps(503, rewriteBarrierFailedResponseBody(slug, reason), `rewrite_barrier_failed:${reason}`, `/api/agent/${slug}/state`);
      return;
    }
  }

  const result = op === 'rewrite.apply'
    ? await executeCanonicalRewrite(
      slug,
      promotedBarrierBaseToken !== null
        ? { ...opRoute.body, baseToken: promotedBarrierBaseToken }
        : opRoute.body,
      {
      idempotencyKey: replay.idempotencyKey ?? undefined,
      idempotencyRoute: replay.reservation?.route ?? undefined,
    },
    )
    : await executeDocumentOperationAsync(slug, opRoute.method, opRoute.path, opRoute.body, mutationContext);
  if (opRoute.path === '/marks/accept' || opRoute.path === '/marks/reject') {
    maybeLogMarkHydrationMismatch(mutationRoute, slug, opRoute.body, mutationContext, result);
  }
  if (op === 'rewrite.apply' && result.status >= 200 && result.status < 300 && rewriteGate) {
    result.body = annotateRewriteDisruptionMetadata(result.body, rewriteGate);
  }
  if (opsWhyGate) { finishSuggestionNote(res, slug, opsWhyGate, result); await finishSuggestionBundle(slug, opsWhyGate, result); }
  storeIdempotentMutationResult(replay, mutationRoute, slug, result.status, result.body);
  if (result.status >= 200 && result.status < 300 && op !== 'rewrite.apply') {
    await notifyCollabMutation(
      slug,
      buildParticipationFromMutation(req, slug, participationBody, {
        quote: typeof payload.quote === 'string' ? payload.quote : null,
        details: op,
      }),
      { verify: false, apply: false },
    );
  }
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

agentRoutes.post('/:slug/marks/comment', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /marks/comment';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['commenter', 'editor', 'owner_bot'])) return;
  const routeKey = mutationRoute;
  const replay = await maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;
  const payload = asPayload(req.body);
  const mutationContext = await enforceMutationPrecondition(res, slug, mutationRoute, 'comment.add', payload, replay);
  if (!mutationContext) return;
  const result = await executeDocumentOperationAsync(slug, 'POST', '/marks/comment', payload, mutationContext);
  storeIdempotentMutationResult(replay, mutationRoute, slug, result.status, result.body);
  if (result.status >= 200 && result.status < 300) {
    notifyCollabMutation(slug, buildParticipationFromMutation(req, slug, payload, { details: 'comment.add' }), { apply: false });
  }
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

// Proof Documents Step 1: set one line's status mark for this agent (or clear it with "unseen").
// Body: { status, reason?, by?, lineIndex | hash[, occurrence] | ref | quote }.
// Step B2 batch forms (one request, one transaction): { status, lines: [target, ...] } and
// { status, section: target } (a heading; marks every line of its section).
// A line mark never changes the document's text, so no base token is needed; the target is
// resolved against the current text, and a hash that no longer exists returns 409 LINE_CHANGED.
agentRoutes.post('/:slug/marks/line', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /marks/line';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  const role = checkAuth(req, res, slug, ['commenter', 'editor', 'owner_bot']);
  if (!role) return;
  const replay = await maybeReplayIdempotentMutation(req, res, slug, mutationRoute, mutationRoute);
  if (replay.handled) return;
  const payload = asPayload(req.body);
  // Step B6: an agent key marks as its own AI; only the owner credential may name a human.
  const actor = resolveAgentActor(req, slug, payload, role);
  if (!actor.ok) {
    sendMutationResponse(res, actor.status, actor.body, { route: mutationRoute, slug });
    return;
  }
  const by = actor.by;
  await recoverCanonicalDocumentIfNeeded(slug, 'state');
  const state = await executeDocumentOperationAsync(slug, 'GET', '/state');
  const stateBody = asPayload(state.body);
  const markdown = typeof stateBody.markdown === 'string' ? stateBody.markdown : (getDocumentBySlug(slug)?.markdown ?? '');
  const result = await writeAgentLineMark(slug, markdown, payload, { by, canApprove: role === 'owner_bot' });
  if (result.status === 200) scheduleAlignmentCheck(slug);
  storeIdempotentMutationResult(replay, mutationRoute, slug, result.status, result.body);
  if (result.status >= 200 && result.status < 300) {
    notifyCollabMutation(slug, buildParticipationFromMutation(req, slug, payload, { details: 'line_mark.set' }), { apply: false });
  }
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

// ============================================================================
// Line tiers (Mike, 2026-09-19): decision lines and context lines
// ============================================================================

// Body: { tier: "decision" | "context", reason?, lines: [target, ...] } or { tier, ...target } for one
// line (target = { lineIndex | hash[, occurrence] | ref | quote }). Any AI collaborator (or the owner
// credential) may tag; an AI's context tag shows as "AI proposed context" until a person confirms it.
agentRoutes.post('/:slug/tiers', async (req: Request, res: Response) => {
  const route = 'POST /tiers';
  const slug = getSlug(req);
  if (!slug) { sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route }); return; }
  const role = checkAuth(req, res, slug, ['commenter', 'editor', 'owner_bot']);
  if (!role) return;
  const payload = asPayload(req.body);
  const actor = resolveAgentActor(req, slug, payload, role);
  if (!actor.ok) { sendMutationResponse(res, actor.status, actor.body, { route, slug }); return; }
  const state = await currentAgentState(slug);
  const lines = await computeServerLines(state.markdown);
  const targets = Array.isArray(payload.lines) ? payload.lines : [payload];
  if (targets.length === 0) { sendMutationResponse(res, 400, { success: false, code: 'INVALID_LINES', error: '"lines" must be a non-empty array' }, { route, slug }); return; }
  if (targets.length > TIER_POLICY.maxLinesPerRequest) { sendMutationResponse(res, 400, { success: false, code: 'BATCH_TOO_LARGE', error: `At most ${TIER_POLICY.maxLinesPerRequest} lines per request` }, { route, slug }); return; }
  const resolved = [];
  for (let i = 0; i < targets.length; i += 1) {
    const raw = targets[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { sendMutationResponse(res, 400, { success: false, code: 'INVALID_LINES', error: `lines[${i}] is not a target object`, index: i }, { route, slug }); return; }
    const item = raw as Record<string, unknown>;
    const target = resolveAgentLineTarget(lines, item.target && typeof item.target === 'object' ? item.target as Record<string, unknown> : item);
    if (!target.ok) {
      sendMutationResponse(res, target.status, { success: false, code: target.code, error: Array.isArray(payload.lines) ? `lines[${i}]: ${target.error}` : target.error, index: i, ...(target.candidates ? { candidates: target.candidates } : {}) }, { route, slug });
      return;
    }
    resolved.push(target.line);
  }
  const before = evaluateDocumentTiers(slug, lines, listCanonicalLineMarks(slug));
  const result = writeTiers(slug, { by: actor.by, tier: payload.tier, reason: payload.reason, lines: resolved, before, markdown: state.markdown, rawMarks: state.marks, source: 'agent' });
  if (result.status === 200) scheduleAlignmentCheck(slug);
  sendMutationResponse(res, result.status, result.body, { route, slug });
});

// The document's tiers now (every tagged or context line) and the full history of tags.
agentRoutes.get('/:slug/tiers', async (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) { res.status(400).json({ success: false, error: 'Invalid slug' }); return; }
  if (!checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot'])) return;
  const state = await currentAgentState(slug);
  const lines = await computeServerLines(state.markdown);
  const evaluation = evaluateDocumentTiers(slug, lines, listCanonicalLineMarks(slug));
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    success: true,
    tiers: serializeTierViews(evaluation, lines),
    history: listTierRecords(slug).map(record => ({ id: record.id, tier: record.tier, by: record.by, at: record.at, reason: record.reason ?? null, byAuthor: record.byAuthor === true, excerpt: record.anchor.excerpt })),
    policy: TIER_POLICY,
  });
});

// ============================================================================
// Familiar proxy marks (Mike, 2026-09-19)
// ============================================================================

/** The AI of the agent key this request presents (null when it presents none). */
function presentedKeyActor(req: Request, slug: string): string | null {
  const tokenId = agentRequestTokenIds.get(req) ?? null;
  if (!tokenId) return null;
  const key = listDocumentAgentKeys(slug).find(k => k.tokenId === tokenId && !k.revokedAt);
  return key ? agentKeyActor(key.label) : null;
}

// The bound Familiar marks lines for its person. Body: { for: "human:<email>", lines: [{ target, status:
// agreed | seen | rejected-suggested | unseen, confidence: 0..1, evidence }] }. Never counts until ratified.
agentRoutes.post('/:slug/marks/proxy', async (req: Request, res: Response) => {
  const route = 'POST /marks/proxy';
  const slug = getSlug(req);
  if (!slug) { sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route }); return; }
  const role = checkAuth(req, res, slug, ['commenter', 'editor', 'owner_bot']);
  if (!role) return;
  const payload = asPayload(req.body);
  const actor = resolveAgentActor(req, slug, payload, role);
  if (!actor.ok) { sendMutationResponse(res, actor.status, actor.body, { route, slug }); return; }
  const keyActor = presentedKeyActor(req, slug);
  const viaAgentKey = Boolean(keyActor) && keyActor === actor.by;
  const result = await writeAgentProxyMarks(slug, await currentAgentMarkdown(slug), payload, { actor: actor.by, viaAgentKey });
  sendMutationResponse(res, result.status, result.body, { route, slug });
});

// A person's brief: GET /marks/proxy?for=human:<email> (the Familiar, the owner credential, or any reader).
agentRoutes.get('/:slug/marks/proxy', async (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) { res.status(400).json({ success: false, error: 'Invalid slug' }); return; }
  const role = checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot']);
  if (!role) return;
  const state = await currentAgentState(slug);
  const report = await issueReportFor(slug, state.markdown, state.marks);
  res.setHeader('Cache-Control', 'no-store');
  if (typeof req.query.for === 'string') {
    const human = resolveHuman(slug, req.query.for);
    if (!human) { res.status(400).json({ success: false, code: 'INVALID_FOR', error: '"for" must name a verified person: human:<email>' }); return; }
    res.json({ success: true, brief: serializeBrief(briefFor(slug, human, report, state.marks)), policy: PROXY_POLICY });
    return;
  }
  const viewer = report.settings.blind ? blindViewer(req, slug, role) : undefined;
  res.json({ success: true, ...proxyStateReport(slug, report, state.marks, { viewer }), policy: PROXY_POLICY });
});

agentRoutes.get('/:slug/familiars', (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) { res.status(400).json({ success: false, error: 'Invalid slug' }); return; }
  if (!checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot'])) return;
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, familiars: listFamiliars(slug), policy: { bindRequiresVerifiedSession: PROXY_POLICY.bindRequiresVerifiedSession, familiarMustBeActiveKey: PROXY_POLICY.familiarMustBeActiveKey } });
});

// Scripts: the owner credential binds a named person's Familiar: { for: "human:<email>", familiar: "ai:<key>" | null }.
// People choose their own in the page; an agent key can never choose (it would pick itself).
agentRoutes.post('/:slug/familiars', async (req: Request, res: Response) => {
  const route = 'POST /familiars';
  const slug = getSlug(req);
  if (!slug) { sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route }); return; }
  const role = checkAuth(req, res, slug, ['commenter', 'editor', 'owner_bot']);
  if (!role) return;
  const payload = asPayload(req.body);
  if (role !== 'owner_bot' || presentedKeyActor(req, slug)) {
    sendMutationResponse(res, 403, { success: false, code: 'OWNER_CREDENTIAL_REQUIRED', error: 'A person chooses their own Familiar in the page (My Familiar); scripts need the owner credential' }, { route, slug });
    return;
  }
  const human = resolveHuman(slug, payload.for);
  if (!human) { sendMutationResponse(res, 400, { success: false, code: 'INVALID_FOR', error: '"for" must name a verified person: human:<email>' }, { route, slug }); return; }
  const result = bindFamiliar(slug, { human, familiar: payload.familiar ?? null, by: 'owner-credential', source: 'agent' });
  sendMutationResponse(res, result.status, result.body, { route, slug });
});

// ============================================================================
// Proof Documents Step B3: {ask} decision lines
// ============================================================================

/**
 * Step B6: the actor an agent request acts as (server/identity.ts decideActor).
 *   agent key         -> its own AI (ai:<key-name>); a "by" naming anyone else is 403 ACTOR_MISMATCH;
 *   owner credential  -> the "by" it names (scripts; may name a verified human, human:<email>);
 *   other share token -> the "ai:" it names, never a human and never a key's AI.
 */
function resolveAgentActor(req: Request, slug: string, payload: Record<string, unknown>, role: ShareRole):
  { ok: true; by: string } | { ok: false; status: number; body: Record<string, unknown> } {
  const tokenId = agentRequestTokenIds.get(req) ?? null;
  const keys = listDocumentAgentKeys(slug).filter(key => !key.revokedAt);
  const keyLabel = tokenId ? keys.find(key => key.tokenId === tokenId)?.label ?? null : null;
  const decision = decideActor({
    mode: 'agent',
    typedBy: payload.by,
    agentKeyLabel: keyLabel,
    ownerCredential: role === 'owner_bot',
    activeKeyActors: keys.map(key => agentKeyActor(key.label)),
  });
  if (!decision.ok) return decision;
  return { ok: true, by: decision.actor };
}

function actorKeyOf(actor: string): string {
  return String(actor ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Step B4f: who a read is for, under blind marking. An agent key is its AI; `?by=` names the
 * caller otherwise. The owner credential with no `by` reads everything (undefined); any other
 * caller that names nobody sees no one's positions ('' reveals no line).
 */
function blindViewer(req: Request, slug: string, role: ShareRole): string | undefined {
  const typed = typeof req.query.by === 'string' ? req.query.by : undefined;
  if (role === 'owner_bot' && !typed && BLIND_POLICY.ownerCredentialSeesAll) {
    const tokenId = agentRequestTokenIds.get(req) ?? null;
    if (!tokenId) return undefined;
  }
  const actor = resolveAgentActor(req, slug, typed ? { by: typed } : {}, role);
  return actor.ok ? actor.by : '';
}

/** Step B4f: an ask's answers as a blind viewer may see them (their own answer stays). */
function redactAsk(ask: Record<string, unknown>, revealed: ReadonlySet<number>, viewer: string): Record<string, unknown> {
  const index = typeof ask.lineIndex === 'number' ? ask.lineIndex : null;
  if (index !== null && revealed.has(index)) return ask;
  const me = actorKeyOf(viewer);
  const hide = (a: Record<string, unknown>) => (actorKeyOf(String(a.by ?? a.actor ?? '')) === me ? a : { by: a.by ?? a.actor, at: a.at ?? null, hidden: true });
  return {
    ...ask,
    status: 'hidden',
    summary: 'Answers are hidden until you mark this line (blind marking)',
    people: Array.isArray(ask.people) ? (ask.people as Array<Record<string, unknown>>).map(p => (actorKeyOf(String(p.actor ?? '')) === me ? p
      : { actor: p.actor, state: p.state === 'open' ? 'open' : 'hidden', choice: null, words: null, at: null })) : ask.people,
    answers: Array.isArray(ask.answers) ? (ask.answers as Array<Record<string, unknown>>).map(hide) : ask.answers,
    history: Array.isArray(ask.history) ? (ask.history as Array<Record<string, unknown>>).map(hide) : ask.history,
  };
}

/** Step B4f: alternative picks as a blind viewer may see them. */
function redactAltSets(sets: Array<Record<string, unknown>>, revealed: ReadonlySet<number>, viewer: string): Array<Record<string, unknown>> {
  const me = actorKeyOf(viewer);
  return sets.map(set => {
    const index = typeof set.lineIndex === 'number' ? set.lineIndex : null;
    if (index !== null && revealed.has(index)) return set;
    return {
      ...set,
      unanimous: null,
      disagree: false,
      picks: Array.isArray(set.picks) ? (set.picks as Array<Record<string, unknown>>).map(p => (actorKeyOf(String(p.by ?? '')) === me ? p : { by: p.by, choice: null, hidden: true })) : set.picks,
    };
  });
}

async function currentAgentMarkdown(slug: string): Promise<string> {
  await recoverCanonicalDocumentIfNeeded(slug, 'state');
  const state = await executeDocumentOperationAsync(slug, 'GET', '/state');
  const stateBody = asPayload(state.body);
  return typeof stateBody.markdown === 'string' ? stateBody.markdown : (getDocumentBySlug(slug)?.markdown ?? '');
}

// List every live ask with its answers, evaluated against the current text.
agentRoutes.get('/:slug/asks', async (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) { res.status(400).json({ success: false, error: 'Invalid slug' }); return; }
  if (!checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot'])) return;
  const result = await listAgentAsks(slug, await currentAgentMarkdown(slug));
  res.setHeader('Cache-Control', 'no-store');
  res.status(result.status).json(result.body);
});

// Create an ask. Body: { recommend, to?, ifYes?, by?, <line target> } where the line target is
// lineIndex | hash[, occurrence] | ref | quote (as for /marks/line), or { insertAfter, text } to
// add a new line after a block and make it the ask in one call (needs edit access).
agentRoutes.post('/:slug/asks', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /asks';
  const slug = getSlug(req);
  if (!slug) { sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute }); return; }
  const role = checkAuth(req, res, slug, ['commenter', 'editor', 'owner_bot']);
  if (!role) return;
  const payload = asPayload(req.body);
  const actor = resolveAgentActor(req, slug, payload, role);
  if (!actor.ok) { sendMutationResponse(res, actor.status, actor.body, { route: mutationRoute, slug }); return; }
  const replay = await maybeReplayIdempotentMutation(req, res, slug, mutationRoute, mutationRoute);
  if (replay.handled) return;
  const finish = (status: number, body: Record<string, unknown>) => {
    storeIdempotentMutationResult(replay, mutationRoute, slug, status, body);
    if (status >= 200 && status < 300) {
      notifyCollabMutation(slug, buildParticipationFromMutation(req, slug, payload, { details: 'ask.create' }), { apply: false });
    }
    sendMutationResponse(res, status, body, { route: mutationRoute, slug });
  };

  if (payload.insertAfter === undefined) {
    const result = await createAgentAsk(slug, await currentAgentMarkdown(slug), payload, actor.by);
    finish(result.status, result.body);
    return;
  }

  // insertAfter + text: one new line after a block, then the ask on it.
  if (role !== 'editor' && role !== 'owner_bot') {
    finish(403, { success: false, code: 'EDIT_REQUIRED', error: 'Adding a line needs edit access; ask on an existing line instead' });
    return;
  }
  const text = oneLine(payload.text, 2000);
  if (!text) { finish(400, { success: false, code: 'TEXT_REQUIRED', error: '"text" (the question line, one line) is required with insertAfter' }); return; }
  if (!oneLine(payload.recommend, ASK_POLICY.maxRecommend)) {
    finish(400, { success: false, code: 'RECOMMEND_REQUIRED', error: 'An ask carries one recommendation line ("recommend"): what you would do, not a menu' });
    return;
  }
  const beforeLines = await computeServerLines(await currentAgentMarkdown(slug));
  let blockRef: string | null = null;
  if (typeof payload.insertAfter === 'string' && /^b\d+$/i.test(payload.insertAfter)) {
    blockRef = payload.insertAfter.toLowerCase();
  } else if (isRecord(payload.insertAfter)) {
    const target = resolveAgentLineTarget(beforeLines, payload.insertAfter);
    if (!target.ok) { finish(target.status, { success: false, code: target.code, error: `insertAfter: ${target.error}`, ...(target.candidates ? { candidates: target.candidates } : {}) }); return; }
    blockRef = `b${target.line.block + 1}`;
  }
  if (!blockRef) { finish(400, { success: false, code: 'INVALID_INSERT_AFTER', error: '"insertAfter" must be a block ref like "b3" or a line target like {"quote": "..."}' }); return; }
  const insertedBlock = Number(blockRef.slice(1)); // 0-based index of the new block
  let edit: { status: number; body: unknown } | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = await buildAgentSnapshot(slug);
    const revision = isRecord(snapshot.body) && typeof snapshot.body.revision === 'number' ? snapshot.body.revision : null;
    if (revision === null) { edit = { status: 409, body: { success: false, code: 'SNAPSHOT_UNAVAILABLE', error: 'The document is not ready for edits; retry shortly' } }; break; }
    const editBody = { by: actor.by, baseRevision: revision, operations: [{ op: 'insert_after', ref: blockRef, blocks: [{ markdown: text }] }] };
    edit = await applyAgentEditV2(slug, editBody);
    if (edit.status >= 200 && edit.status < 300) {
      await settleEditV2Success(req, slug, editBody, edit);
      break;
    }
    const code = isRecord(edit.body) ? edit.body.code : null;
    if (!ASK_INSERT_RETRY_CODES.has(String(code))) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!edit || edit.status < 200 || edit.status >= 300) {
    finish(edit?.status ?? 500, { ...(isRecord(edit?.body) ? edit!.body as Record<string, unknown> : {}), success: false, stage: 'insert' });
    return;
  }
  const afterLines = await computeServerLines(await currentAgentMarkdown(slug));
  const wanted = afterLines.filter(line => line.block === insertedBlock);
  const plain = text.replace(/[*_`~\[\]]/g, '').slice(0, 40);
  const line = wanted.find(candidate => candidate.text.includes(plain)) ?? wanted[0];
  if (!line) { finish(500, { success: false, code: 'INSERTED_LINE_NOT_FOUND', error: `The line was added but could not be found for the ask; ask on it with {"ref": "b${insertedBlock + 1}"}` }); return; }
  const result = createAskOnLine(slug, line, afterLines, { by: actor.by, to: payload.to, recommend: payload.recommend, ifYes: payload.ifYes, source: 'agent' });
  if (result.status === 200) result.body.inserted = { ref: `b${insertedBlock + 1}`, lineIndex: line.index, text: line.text };
  finish(result.status, result.body);
});

// An AI answers an ask it was asked (or records its view). Body: { choice: yes|not_yet|no, words?, by? }.
agentRoutes.post('/:slug/asks/:askId/answer', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /asks/:id/answer';
  const slug = getSlug(req);
  if (!slug) { sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute }); return; }
  const role = checkAuth(req, res, slug, ['commenter', 'editor', 'owner_bot']);
  if (!role) return;
  const payload = asPayload(req.body);
  const actor = resolveAgentActor(req, slug, payload, role);
  if (!actor.ok) { sendMutationResponse(res, actor.status, actor.body, { route: mutationRoute, slug }); return; }
  const askId = String(req.params.askId ?? '');
  const result = await answerAgentAsk(slug, await currentAgentMarkdown(slug), askId, payload, actor.by, true);
  if (result.status === 200) scheduleAlignmentCheck(slug);
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

// ============================================================================
// {do} action lines (safe slice, 2026-09-18). An AI may propose, revise, revoke and withdraw;
// only a signed-in person approves (on the page), and nothing runs: execution is not enabled.
// ============================================================================

agentRoutes.get('/:slug/dos', async (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) { res.status(400).json({ success: false, error: 'Invalid slug' }); return; }
  if (!checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot'])) return;
  const result = await listAgentDos(slug, await currentAgentMarkdown(slug));
  res.setHeader('Cache-Control', 'no-store');
  res.status(result.status).json(result.body);
});

// Propose a {do} on an existing line. Body: { <line target>, action: <Pulse v1 action>, to?, presser?, retryBudget?, by? }.
agentRoutes.post('/:slug/dos', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /dos';
  const slug = getSlug(req);
  if (!slug) { sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute }); return; }
  const role = checkAuth(req, res, slug, ['editor', 'owner_bot']);
  if (!role) return;
  const payload = asPayload(req.body);
  const actor = resolveAgentActor(req, slug, payload, role);
  if (!actor.ok) { sendMutationResponse(res, actor.status, actor.body, { route: mutationRoute, slug }); return; }
  const result = await createAgentDo(slug, await currentAgentMarkdown(slug), payload, actor.by);
  if (result.status === 200) {
    notifyCollabMutation(slug, buildParticipationFromMutation(req, slug, payload, { details: 'do.create' }), { apply: false });
    scheduleAlignmentCheck(slug);
  }
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

// Revise: a new action (higher revision), presser, retryBudget or to. Voids any approval.
agentRoutes.post('/:slug/dos/:doId/revise', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /dos/:id/revise';
  const slug = getSlug(req);
  if (!slug) { sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute }); return; }
  const role = checkAuth(req, res, slug, ['editor', 'owner_bot']);
  if (!role) return;
  const payload = asPayload(req.body);
  const actor = resolveAgentActor(req, slug, payload, role);
  if (!actor.ok) { sendMutationResponse(res, actor.status, actor.body, { route: mutationRoute, slug }); return; }
  const lines = await computeServerLines(await currentAgentMarkdown(slug));
  const result = reviseDo(slug, lines, { id: String(req.params.doId ?? ''), by: actor.by, isOwner: role === 'owner_bot', action: payload.action, presser: payload.presser, retryBudget: payload.retryBudget, to: payload.to });
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

// Approval is never done through the agent API: an AI, a key or a share token is not a signed-in person.
agentRoutes.post('/:slug/dos/:doId/approve', (req: Request, res: Response) => {
  res.status(403).json({ success: false, code: 'SIGNED_IN_PERSON_REQUIRED', error: 'Only a person signed in to this site can approve a {do}, on the page. Ask them (an {ask} line works).' });
});

// Revoke the live approval (the proposer, or the owner credential). Always safe.
agentRoutes.post('/:slug/dos/:doId/revoke', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /dos/:id/revoke';
  const slug = getSlug(req);
  if (!slug) { sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute }); return; }
  const role = checkAuth(req, res, slug, ['commenter', 'editor', 'owner_bot']);
  if (!role) return;
  const payload = asPayload(req.body);
  const actor = resolveAgentActor(req, slug, payload, role);
  if (!actor.ok) { sendMutationResponse(res, actor.status, actor.body, { route: mutationRoute, slug }); return; }
  const lines = await computeServerLines(await currentAgentMarkdown(slug));
  const result = revokeDo(slug, lines, { id: String(req.params.doId ?? ''), actor: actor.by, isOwner: role === 'owner_bot' });
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

// Run: always refused in this build (409 EXECUTION_NOT_ENABLED).
agentRoutes.post('/:slug/dos/:doId/run', async (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) { res.status(400).json({ success: false, error: 'Invalid slug' }); return; }
  const role = checkAuth(req, res, slug, ['commenter', 'editor', 'owner_bot']);
  if (!role) return;
  const payload = asPayload(req.body);
  const actor = resolveAgentActor(req, slug, payload, role);
  if (!actor.ok) { res.status(actor.status).json(actor.body); return; }
  const lines = await computeServerLines(await currentAgentMarkdown(slug));
  const result = await runDo(slug, lines, { id: String(req.params.doId ?? ''), actor: actor.by, source: 'agent' });
  res.status(result.status).json(result.body);
});

agentRoutes.delete('/:slug/dos/:doId', async (req: Request, res: Response) => {
  const mutationRoute = 'DELETE /dos/:id';
  const slug = getSlug(req);
  if (!slug) { sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute }); return; }
  const role = checkAuth(req, res, slug, ['editor', 'owner_bot']);
  if (!role) return;
  const payload = asPayload(req.body);
  const actor = resolveAgentActor(req, slug, payload, role);
  if (!actor.ok) { sendMutationResponse(res, actor.status, actor.body, { route: mutationRoute, slug }); return; }
  const lines = await computeServerLines(await currentAgentMarkdown(slug));
  const result = withdrawDo(slug, lines, { id: String(req.params.doId ?? ''), by: actor.by, isOwner: role === 'owner_bot' });
  if (result.status === 200) scheduleAlignmentCheck(slug);
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

// ============================================================================
// Proof Documents Step B3c: aligned snapshots and "Since you"
// ============================================================================

// Every aligned snapshot of the document, newest first (no text; follow `ledger` or `json`).
agentRoutes.get('/:slug/snapshots', (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) { res.status(400).json({ success: false, error: 'Invalid slug' }); return; }
  if (!checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot'])) return;
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    success: true,
    snapshots: listSnapshotInfos(slug).map(info => ({
      ...info,
      ledger: `/api/agent/${slug}/snapshots/${info.id}.md`,
      json: `/api/agent/${slug}/snapshots/${info.id}`,
    })),
  });
});

// One snapshot: <id>.md is the markdown ledger, <id> the JSON (markdown, marks, asks, team).
agentRoutes.get('/:slug/snapshots/:file', (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) { res.status(400).json({ success: false, error: 'Invalid slug' }); return; }
  if (!checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot'])) return;
  sendSnapshotFile(res, slug, String(req.params.file ?? ''));
});

// What changed since this AI last marked a line on purpose (or since the last aligned snapshot).
// An agent key reads as its own AI; the owner credential may pass ?by= for anyone.
agentRoutes.get('/:slug/since-you', async (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) { res.status(400).json({ success: false, error: 'Invalid slug' }); return; }
  const role = checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot']);
  if (!role) return;
  const actor = resolveAgentActor(req, slug, typeof req.query.by === 'string' ? { by: req.query.by } : {}, role);
  if (!actor.ok) { res.status(actor.status).json(actor.body); return; }
  const report = await buildSinceYou(slug, actor.by);
  res.setHeader('Cache-Control', 'no-store');
  if (!report) { res.status(404).json({ success: false, error: 'Document not found' }); return; }
  res.json({ success: true, ...report });
});

// The asker re-asks (reopens it for everyone; may update recommend / ifYes / to).
agentRoutes.post('/:slug/asks/:askId/reask', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /asks/:id/reask';
  const slug = getSlug(req);
  if (!slug) { sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute }); return; }
  const role = checkAuth(req, res, slug, ['commenter', 'editor', 'owner_bot']);
  if (!role) return;
  const payload = asPayload(req.body);
  const actor = resolveAgentActor(req, slug, payload, role);
  if (!actor.ok) { sendMutationResponse(res, actor.status, actor.body, { route: mutationRoute, slug }); return; }
  const result = reaskAsk(slug, { id: String(req.params.askId ?? ''), by: actor.by, isOwner: role === 'owner_bot', recommend: payload.recommend, ifYes: payload.ifYes, to: payload.to });
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

// The asker withdraws an ask (the line stays; its answers stay in the event log).
agentRoutes.delete('/:slug/asks/:askId', async (req: Request, res: Response) => {
  const mutationRoute = 'DELETE /asks/:id';
  const slug = getSlug(req);
  if (!slug) { sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute }); return; }
  const role = checkAuth(req, res, slug, ['commenter', 'editor', 'owner_bot']);
  if (!role) return;
  const payload = asPayload(req.body ?? {});
  const actor = resolveAgentActor(req, slug, { ...payload, ...(typeof req.query.by === 'string' ? { by: req.query.by } : {}) }, role);
  if (!actor.ok) { sendMutationResponse(res, actor.status, actor.body, { route: mutationRoute, slug }); return; }
  const result = withdrawAsk(slug, { id: String(req.params.askId ?? ''), by: actor.by, isOwner: role === 'owner_bot' });
  if (result.status === 200) scheduleAlignmentCheck(slug);
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

// ============================================================================
// Proof Documents Steps B4c + B4d: review aids and objections
// ============================================================================

interface WhyGate { by: string; fields: SuggestionNoteFields; warn: boolean; bundle?: { id: string; title: string | null; why: string | null } | null }

/**
 * Step B4c: checks an AI suggestion's "why" before it is added (WHY_POLICY.enforce). Sends the
 * refusal and returns null when refused.
 */
function suggestionWhyGate(req: Request, res: Response, slug: string, payload: Record<string, unknown>, route: string): WhyGate | null {
  const fields = suggestionNoteFields(payload);
  if ('error' in fields) {
    sendMutationResponse(res, fields.error.status, fields.error.body, { route, slug });
    return null;
  }
  const tokenId = agentRequestTokenIds.get(req) ?? null;
  const key = tokenId ? listDocumentAgentKeys(slug).find(k => k.tokenId === tokenId && !k.revokedAt) ?? null : null;
  const typed = typeof payload.by === 'string' && payload.by.trim() ? payload.by : 'ai:unknown';
  const by = key ? agentKeyActor(key.label) : normalizeActorString(typed);
  // An agent key's suggestion names its own AI when it does not say who wrote it (Step B6 rule
  // for marks; before this, such suggestions showed as "unknown").
  if (key && (typeof payload.by !== 'string' || !payload.by.trim())) payload.by = by;
  const check = checkSuggestionWhy({ by, viaAgentKey: Boolean(key), fields });
  if (check.refuse) {
    sendMutationResponse(res, check.refuse.status, check.refuse.body, { route, slug });
    return null;
  }
  // Step B4e: { bundle: { id, title, why } } adds the new suggestion to that review bundle.
  const bundle = bundleField(payload);
  if (bundle && 'error' in bundle) {
    sendMutationResponse(res, bundle.error.status, bundle.error.body, { route, slug });
    return null;
  }
  if (bundle) {
    const refused = checkBundleField(slug, bundle);
    if (refused) { sendMutationResponse(res, refused.status, refused.body, { route, slug }); return null; }
  }
  return { by, fields, warn: check.warn, bundle };
}

/** Step B4c: after a suggestion was added, store its note and add the missing-why warning. */
function finishSuggestionNote(res: Response, slug: string, gate: WhyGate, result: { status: number; body: unknown }): void {
  if (result.status < 200 || result.status >= 300 || !isRecord(result.body)) return;
  const markId = typeof result.body.markId === 'string' ? result.body.markId : '';
  try {
    const note = recordSuggestionNote(slug, markId, gate.by, gate.fields);
    if (note) result.body.note = { why: note.why, rejectHints: note.rejectHints, priority: note.priority, priorityReason: note.priorityReason };
  } catch (error) {
    console.warn('[agent-routes] suggestion note failed', { slug, error: String(error) });
  }
  if (gate.warn) {
    res.setHeader(WHY_POLICY.warningHeader, WHY_POLICY.warningCode);
    const warnings = Array.isArray(result.body.warnings) ? result.body.warnings : [];
    result.body.warnings = [...warnings, { code: WHY_POLICY.warningCode, message: 'Add a one-line "why" to AI suggestions: readers see it beside the change. It will be required.' }];
  }
}

async function currentAgentState(slug: string): Promise<{ markdown: string; marks: unknown }> {
  await recoverCanonicalDocumentIfNeeded(slug, 'state');
  const state = await executeDocumentOperationAsync(slug, 'GET', '/state');
  const body = asPayload(state.body);
  const doc = getDocumentBySlug(slug);
  return {
    markdown: typeof body.markdown === 'string' ? body.markdown : (doc?.markdown ?? ''),
    marks: isRecord(body.marks) ? body.marks : doc?.marks,
  };
}

/** A small POST route with the agent's actor resolved (B6); `run` does the work. */
function aidRoute(path: string, route: string, roles: ShareRole[], run: (ctx: { req: Request; slug: string; by: string; role: ShareRole; payload: Record<string, unknown> }) => Promise<{ status: number; body: Record<string, unknown> }>): void {
  agentRoutes.post(path, async (req: Request, res: Response) => {
    const slug = getSlug(req);
    if (!slug) { sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route }); return; }
    const role = checkAuth(req, res, slug, roles);
    if (!role) return;
    const payload = asPayload(req.body);
    const actor = resolveAgentActor(req, slug, payload, role);
    if (!actor.ok) { sendMutationResponse(res, actor.status, actor.body, { route, slug }); return; }
    const result = await run({ req, slug, by: actor.by, role, payload });
    if (result.status === 200) scheduleAlignmentCheck(slug);
    sendMutationResponse(res, result.status, result.body, { route, slug });
  });
}

// Step B4c: every AI review note (why / reject hints / priority), open flags and objections.
for (const [path, key] of [['/:slug/notes', 'notes'], ['/:slug/flags', 'flags'], ['/:slug/objections', 'objections']] as const) {
  agentRoutes.get(path, async (req: Request, res: Response) => {
    const slug = getSlug(req);
    if (!slug) { res.status(400).json({ success: false, error: 'Invalid slug' }); return; }
    if (!checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot'])) return;
    const state = await currentAgentState(slug);
    const report = await aidsReport(slug, state.markdown, state.marks);
    res.setHeader('Cache-Control', 'no-store');
    if (key === 'notes') res.json({ success: true, notes: report.notes, policy: { why: WHY_POLICY, rejectChips: REJECT_CHIPS, priority: ISSUE_PRIORITY } });
    else if (key === 'flags') res.json({ success: true, flags: report.flags, policy: UNCERTAIN_POLICY });
    else res.json({ success: true, objections: report.objections, closed: req.query.closed === '1' ? report.closedObjections : undefined, policy: OBJECTION_POLICY });
  });
}

// Step B4c: an AI's note on a suggestion ({ markId }) or a line (a line target):
// { why?, rejectHints?, priority? (1-5, with priorityReason; null clears) }.
aidRoute('/:slug/notes', 'POST /notes', ['commenter', 'editor', 'owner_bot'], async ({ slug, by, payload }) =>
  writeAgentNote(slug, (await currentAgentState(slug)).markdown, payload, by));

// Step B4c: flag a line uncertain: { <line target>, note? }.
aidRoute('/:slug/flags', 'POST /flags', ['commenter', 'editor', 'owner_bot'], async ({ slug, by, payload }) =>
  writeAgentFlag(slug, (await currentAgentState(slug)).markdown, payload, by));

// Step B4c: clear a flag (the flagger, or the owner credential).
aidRoute('/:slug/flags/:flagId/clear', 'POST /flags/:id/clear', ['commenter', 'editor', 'owner_bot'], async ({ req, slug, by, role }) =>
  clearFlag(slug, { id: String(req.params.flagId ?? ''), by, isOwner: role === 'owner_bot', source: 'agent' }));

// Step B4d: object to one or more lines: { lines: [<line target>, ...] | <line target>, reason, condition? }.
aidRoute('/:slug/objections', 'POST /objections', ['commenter', 'editor', 'owner_bot'], async ({ slug, by, payload }) => {
  const state = await currentAgentState(slug);
  return createAgentObjection(slug, state.markdown, state.marks, payload, by);
});

// Step B4d: the objector clears it; the owner credential overrides it with { reason }.
aidRoute('/:slug/objections/:objectionId/clear', 'POST /objections/:id/clear', ['commenter', 'editor', 'owner_bot'], async ({ req, slug, by, role, payload }) =>
  clearObjection(slug, { id: String(req.params.objectionId ?? ''), by, isOwner: role === 'owner_bot', reason: payload.reason, source: 'agent' }));

// Step B4d: the objector saw the repair and still objects.
aidRoute('/:slug/objections/:objectionId/keep', 'POST /objections/:id/keep', ['commenter', 'editor', 'owner_bot'], async ({ req, slug, by }) => {
  const state = await currentAgentState(slug);
  return keepObjection(slug, { id: String(req.params.objectionId ?? ''), by, markdown: state.markdown, rawMarks: state.marks, source: 'agent' });
});

// ============================================================================
// Proof Documents Steps B4e + B4f: bundles, alternatives, blind marking, Explain, times-to-live
// ============================================================================

/**
 * Step B4e: accepts or rejects several suggestions as one mutation (the engine's batch), then
 * waits for live collaboration to converge, like POST /marks/accept.
 */
export function bundleApplier(req: Request | null, slug: string, by: string): (markIds: string[], action: 'accept' | 'reject') => Promise<{ status: number; body: Record<string, unknown> }> {
  return async (markIds, action) => {
    // A person's newest typing or a page's own accept may still be settling: retry like a keystroke race.
    let result = await finalizeSuggestionsBatchAsync(slug, markIds, action === 'accept' ? 'accepted' : 'rejected', by);
    for (let attempt = 0; attempt < 12 && result.status === 409 && isRecord(result.body) && ASK_INSERT_RETRY_CODES.has(String(result.body.code)); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 300));
      result = await finalizeSuggestionsBatchAsync(slug, markIds, action === 'accept' ? 'accepted' : 'rejected', by);
    }
    const body = isRecord(result.body) ? result.body : {};
    if (result.status < 200 || result.status >= 300) return { status: result.status, body };
    const payload = { by, markIds };
    const collabStatus = await notifyCollabMutation(
      slug,
      req ? buildParticipationFromMutation(req, slug, payload, { details: `bundle.${action}` }) : null,
      { verify: true, source: action === 'accept' ? 'marks.accept' : 'marks.reject', stabilityMs: EDIT_COLLAB_STABILITY_MS, strictLiveDoc: true, apply: false },
    );
    if (!collabStatus.confirmed) {
      return { status: 409, body: { success: false, code: 'COLLAB_SYNC_FAILED', error: 'The bundle was applied but did not converge to the live document yet; re-read /state', reason: collabStatus.reason ?? 'sync_timeout' } };
    }
    return { status: 200, body: { success: true, markIds: body.markIds ?? markIds } };
  };
}

/**
 * Step B4f: replaces one line's text with an edit/v2 operation (a normal edit): the whole block
 * when the line is its block (keeping a heading's, quote's or list marker's prefix), else a find /
 * replace of the line's text inside its block. Retries a keystroke race like an ask's insert.
 */
export function lineEditor(req: Request | null, slug: string): LineEditor {
  return async (line: ProofDocLine, lines: ProofDocLine[], text: string, by: string) => {
    let last: { status: number; body: Record<string, unknown> } = { status: 409, body: { success: false, error: 'Not attempted' } };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = await buildAgentSnapshot(slug);
      const snapBody = isRecord(snapshot.body) ? snapshot.body : {};
      const revision = typeof snapBody.revision === 'number' ? snapBody.revision : null;
      const blocks = Array.isArray(snapBody.blocks) ? snapBody.blocks as Array<Record<string, unknown>> : [];
      const block = blocks[line.block];
      if (revision === null || !block) return { status: 409, body: { success: false, code: 'SNAPSHOT_UNAVAILABLE', error: 'The document is not ready for edits; retry shortly' } };
      const ref = `b${line.block + 1}`;
      const blockMarkdown = typeof block.markdown === 'string' ? block.markdown : '';
      // An earlier attempt may have landed although it reported a conflict: then it is done.
      if (attempt > 0 && blockMarkdown.includes(text) && !blockMarkdown.includes(line.text)) {
        return { status: 200, body: { success: true, alreadyApplied: true } };
      }
      const alone = lines.filter(candidate => candidate.block === line.block).length === 1;
      let operation: Record<string, unknown> | null = null;
      if (blockMarkdown.includes(line.text)) {
        operation = { op: 'find_replace_in_block', ref, find: line.text, replace: text };
      } else if (alone) {
        const prefix = (blockMarkdown.match(/^(#{1,6}\s+|>\s+|[-*+]\s+|\d+[.)]\s+)/) ?? [''])[0];
        operation = { op: 'replace_block', ref, block: { markdown: `${prefix}${text}` } };
      }
      if (!operation) return { status: 409, body: { success: false, code: 'ALT_APPLY_FAILED', error: 'This line has formatting the server cannot rewrite safely; edit it by hand to the chosen wording' } };
      const editBody = { by, baseRevision: revision, operations: [operation] };
      const edit = await applyAgentEditV2(slug, editBody);
      last = { status: edit.status, body: isRecord(edit.body) ? edit.body : {} };
      if (edit.status >= 200 && edit.status < 300) {
        if (req) await settleEditV2Success(req, slug, editBody, edit);
        else broadcastToRoom(slug, { type: 'document.updated', source: 'agent-edit-v2', timestamp: new Date().toISOString() });
        return last;
      }
      if (!ASK_INSERT_RETRY_CODES.has(String(last.body.code))) return last;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return last;
  };
}

const editorFor = lineEditor;

// Step B4e: bundles (GET: open ones; ?closed=1 adds decided ones).
agentRoutes.get('/:slug/bundles', async (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) { res.status(400).json({ success: false, error: 'Invalid slug' }); return; }
  if (!checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot'])) return;
  const state = await currentAgentState(slug);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, bundles: await bundleReport(slug, state.markdown, state.marks, req.query.closed === '1'), policy: BUNDLE_POLICY });
});

// Step B4e: group existing suggestions: { id?, title, why?, markIds: [...] } (an existing id appends).
aidRoute('/:slug/bundles', 'POST /bundles', ['commenter', 'editor', 'owner_bot'], async ({ slug, by, payload }) => {
  const state = await currentAgentState(slug);
  return addToBundle(slug, {
    by, bundle: { id: typeof payload.id === 'string' ? payload.id : null, title: payload.title, why: payload.why },
    markIds: payload.markIds, markdown: state.markdown, rawMarks: state.marks, source: 'agent',
  });
});

// Step B4e: accept or reject a whole bundle (edit access). Accept refuses with 409 BUNDLE_STALE.
for (const action of ['accept', 'reject'] as const) {
  aidRoute(`/:slug/bundles/:bundleId/${action}`, `POST /bundles/:id/${action}`, ['editor', 'owner_bot'], async ({ req, slug, by }) => {
    const state = await currentAgentState(slug);
    return decideBundle(slug, { id: String(req.params.bundleId ?? ''), by, action, markdown: state.markdown, rawMarks: state.marks, apply: bundleApplier(req, slug, by) });
  });
}

// Step B4f: open alternatives per line (?closed=1 adds the folded history).
agentRoutes.get('/:slug/alternatives', async (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) { res.status(400).json({ success: false, error: 'Invalid slug' }); return; }
  const role = checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot']);
  if (!role) return;
  const state = await currentAgentState(slug);
  const report = await alternativesReport(slug, state.markdown, state.marks, req.query.closed === '1');
  let sets = report.sets;
  if (getProofSettings(slug).blind) {
    const viewer = blindViewer(req, slug, role);
    if (viewer !== undefined) {
      const lines = await computeServerLines(state.markdown);
      const view = blindViewFor({ lines, lineMarks: listCanonicalLineMarks(slug), viewer, picks: listPicks(slug) });
      sets = redactAltSets(sets, view.revealed, viewer);
    }
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, alternatives: sets, ...(report.closed ? { closed: report.closed } : {}), policy: ALT_POLICY });
});

// Step B4f: offer another wording: { <line target>, text }.
aidRoute('/:slug/alternatives', 'POST /alternatives', ['commenter', 'editor', 'owner_bot'], async ({ req, slug, by, payload }) => {
  const state = await currentAgentState(slug);
  return offerAlternative(slug, { by, target: payload, text: payload.text, markdown: state.markdown, rawMarks: state.marks, source: 'agent', applyEdit: editorFor(req, slug) });
});

// Step B4f: pick a wording: { <line target>, choice: "original" | <alternative id> | "1".."9" }.
aidRoute('/:slug/alternatives/pick', 'POST /alternatives/pick', ['commenter', 'editor', 'owner_bot'], async ({ req, slug, by, payload }) => {
  const state = await currentAgentState(slug);
  return pickAlternative(slug, { by, target: payload, choice: payload.choice, markdown: state.markdown, rawMarks: state.marks, source: 'agent', applyEdit: editorFor(req, slug) });
});

// Step B4f: the owner credential decides between the wordings.
aidRoute('/:slug/alternatives/decide', 'POST /alternatives/decide', ['owner_bot'], async ({ req, slug, by, role, payload }) => {
  const state = await currentAgentState(slug);
  return decideAlternative(slug, { by, isOwner: role === 'owner_bot', target: payload, choice: payload.choice, markdown: state.markdown, rawMarks: state.marks, applyEdit: editorFor(req, slug) });
});

aidRoute('/:slug/alternatives/:altId/withdraw', 'POST /alternatives/:id/withdraw', ['commenter', 'editor', 'owner_bot'], async ({ req, slug, by, role }) =>
  withdrawAlternative(slug, { id: String(req.params.altId ?? ''), by, isOwner: role === 'owner_bot' }));

// Step B4f: the document's settings (blind marking); the owner credential changes them.
agentRoutes.get('/:slug/settings', (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) { res.status(400).json({ success: false, error: 'Invalid slug' }); return; }
  if (!checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot'])) return;
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, settings: getProofSettings(slug), policy: { blind: BLIND_POLICY } });
});
aidRoute('/:slug/settings', 'POST /settings', ['owner_bot'], async ({ slug, by, role, payload }) =>
  setBlindSetting(slug, { blind: payload.blind, by, isOwner: role === 'owner_bot', source: 'agent' }));

// Step B4f: Explain threads (answer by replying on the thread) and the defined terms.
agentRoutes.get('/:slug/explains', (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) { res.status(400).json({ success: false, error: 'Invalid slug' }); return; }
  if (!checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot'])) return;
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, explains: listExplains(slug).map(serializeExplain), policy: EXPLAIN_POLICY });
});
agentRoutes.get('/:slug/terms', async (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) { res.status(400).json({ success: false, error: 'Invalid slug' }); return; }
  if (!checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot'])) return;
  const state = await currentAgentState(slug);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, terms: termsReport(await computeServerLines(state.markdown)) });
});

// Step B4f: times-to-live. GET evaluates expiry now (lazily); POST sets one: { <line target>, ttl: "7d" }.
agentRoutes.get('/:slug/ttl', async (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) { res.status(400).json({ success: false, error: 'Invalid slug' }); return; }
  if (!checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot'])) return;
  const state = await currentAgentState(slug);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, evaluatedAt: new Date().toISOString(), ttls: await ttlReport(slug, state.markdown, state.marks), policy: TTL_POLICY });
});
aidRoute('/:slug/ttl', 'POST /ttl', ['commenter', 'editor', 'owner_bot'], async ({ slug, by, payload }) =>
  setTtl(slug, { by, target: payload, ttl: payload.ttl, markdown: (await currentAgentState(slug)).markdown, source: 'agent' }));
aidRoute('/:slug/ttl/:ttlId/clear', 'POST /ttl/:id/clear', ['commenter', 'editor', 'owner_bot'], async ({ req, slug, by, role }) =>
  clearTtl(slug, { id: String(req.params.ttlId ?? ''), by, isOwner: role === 'owner_bot', source: 'agent' }));
// Step B4f: an AI answers "still true?": { stillTrue: true | false, why? }.
aidRoute('/:slug/ttl/:ttlId/check', 'POST /ttl/:id/check', ['commenter', 'editor', 'owner_bot'], async ({ req, slug, by, payload }) =>
  checkTtl(slug, { id: String(req.params.ttlId ?? ''), by, stillTrue: payload.stillTrue, why: payload.why, markdown: (await currentAgentState(slug)).markdown, source: 'agent' }));

/** Step B4e: after a suggestion was added with a `bundle` field, add it to that bundle. */
async function finishSuggestionBundle(slug: string, gate: WhyGate, result: { status: number; body: unknown }): Promise<void> {
  if (!gate.bundle || result.status < 200 || result.status >= 300 || !isRecord(result.body)) return;
  const markId = typeof result.body.markId === 'string' ? result.body.markId : '';
  if (!markId) return;
  try {
    const state = await currentAgentState(slug);
    const added = await addToBundle(slug, { by: gate.by, bundle: gate.bundle, markIds: [markId], markdown: state.markdown, rawMarks: state.marks, source: 'agent' });
    result.body.bundle = added.status === 200 ? added.body.bundle : { error: added.body };
  } catch (error) {
    result.body.bundle = { error: String(error) };
  }
}

agentRoutes.post('/:slug/marks/suggest-replace', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /marks/suggest-replace';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['commenter', 'editor', 'owner_bot'])) return;
  // Step B4c: an AI's suggestion carries a one-line "why" (WHY_POLICY).
  const whyGate = suggestionWhyGate(req, res, slug, asPayload(req.body), mutationRoute);
  if (!whyGate) return;
  const routeKey = mutationRoute;
  const replay = await maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;
  const payload = asPayload(req.body);
  const mutationContext = await enforceMutationPrecondition(res, slug, mutationRoute, 'suggestion.add', payload, replay);
  if (!mutationContext) return;
  const result = await executeDocumentOperationAsync(slug, 'POST', '/marks/suggest-replace', payload, mutationContext);
  finishSuggestionNote(res, slug, whyGate, result);
  await finishSuggestionBundle(slug, whyGate, result);
  storeIdempotentMutationResult(replay, mutationRoute, slug, result.status, result.body);
  if (result.status >= 200 && result.status < 300) {
    notifyCollabMutation(slug, buildParticipationFromMutation(req, slug, payload, { details: 'suggestion.add.replace' }), { apply: false });
  }
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

agentRoutes.post('/:slug/marks/suggest-insert', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /marks/suggest-insert';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['commenter', 'editor', 'owner_bot'])) return;
  // Step B4c: an AI's suggestion carries a one-line "why" (WHY_POLICY).
  const whyGate = suggestionWhyGate(req, res, slug, asPayload(req.body), mutationRoute);
  if (!whyGate) return;
  const routeKey = mutationRoute;
  const replay = await maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;
  const payload = asPayload(req.body);
  const mutationContext = await enforceMutationPrecondition(res, slug, mutationRoute, 'suggestion.add', payload, replay);
  if (!mutationContext) return;
  const result = await executeDocumentOperationAsync(slug, 'POST', '/marks/suggest-insert', payload, mutationContext);
  finishSuggestionNote(res, slug, whyGate, result);
  await finishSuggestionBundle(slug, whyGate, result);
  storeIdempotentMutationResult(replay, mutationRoute, slug, result.status, result.body);
  if (result.status >= 200 && result.status < 300) {
    notifyCollabMutation(slug, buildParticipationFromMutation(req, slug, payload, { details: 'suggestion.add.insert' }), { apply: false });
  }
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

agentRoutes.post('/:slug/marks/suggest-delete', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /marks/suggest-delete';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['commenter', 'editor', 'owner_bot'])) return;
  // Step B4c: an AI's suggestion carries a one-line "why" (WHY_POLICY).
  const whyGate = suggestionWhyGate(req, res, slug, asPayload(req.body), mutationRoute);
  if (!whyGate) return;
  const routeKey = mutationRoute;
  const replay = await maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;
  const payload = asPayload(req.body);
  const mutationContext = await enforceMutationPrecondition(res, slug, mutationRoute, 'suggestion.add', payload, replay);
  if (!mutationContext) return;
  const result = await executeDocumentOperationAsync(slug, 'POST', '/marks/suggest-delete', payload, mutationContext);
  finishSuggestionNote(res, slug, whyGate, result);
  await finishSuggestionBundle(slug, whyGate, result);
  storeIdempotentMutationResult(replay, mutationRoute, slug, result.status, result.body);
  if (result.status >= 200 && result.status < 300) {
    notifyCollabMutation(slug, buildParticipationFromMutation(req, slug, payload, { details: 'suggestion.add.delete' }), { apply: false });
  }
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

// ============================================================================
// Proof Documents Step B7: chat beside the document. Messages never touch the document's text or
// Yjs state. A message with `suggestion` first creates a normal suggestion (the same checks as
// /marks/suggest-*, including WHY_POLICY) and links to it.
// ============================================================================

/** A Response stand-in that records what a helper would have sent (status, body, headers). */
function captureResponse(): { res: Response; sent: () => { status: number; body: unknown } | null; headers: Record<string, string> } {
  let status = 200;
  let sent: { status: number; body: unknown } | null = null;
  const headers: Record<string, string> = {};
  const fake = {
    headersSent: false,
    status(code: number) { status = code; return fake; },
    json(body: unknown) { sent = { status, body }; return fake; },
    setHeader(name: string, value: string) { headers[name] = String(value); return fake; },
    getHeader(name: string) { return headers[name]; },
  };
  return { res: fake as unknown as Response, sent: () => sent, headers };
}

const CHAT_SUGGESTION_KINDS = new Set(['replace', 'insert', 'delete']);

/** Creates the suggestion a chat message proposes. Returns the result the suggest route would send. */
async function chatSuggestion(req: Request, slug: string, by: string, raw: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, string>; ref?: ChatSuggestionRef; quote?: string }> {
  const kind = typeof raw.kind === 'string' ? raw.kind : '';
  if (!CHAT_SUGGESTION_KINDS.has(kind)) return { status: 400, headers: {}, body: { success: false, code: 'INVALID_SUGGESTION', error: '"suggestion.kind" is "replace", "insert" or "delete"' } };
  const quote = typeof raw.quote === 'string' ? raw.quote : '';
  if (!quote.trim()) return { status: 400, headers: {}, body: { success: false, code: 'INVALID_SUGGESTION', error: '"suggestion.quote" (the text as the page shows it) is required' } };
  if (kind !== 'delete' && typeof raw.content !== 'string') return { status: 400, headers: {}, body: { success: false, code: 'INVALID_SUGGESTION', error: '"suggestion.content" is required for replace and insert' } };
  const payload: Record<string, unknown> = { ...raw, by };
  delete payload.kind;
  const route = `POST /chat (suggestion.${kind})`;
  const capture = captureResponse();
  const gate = suggestionWhyGate(req, capture.res, slug, payload, route);
  if (!gate) {
    const sent = capture.sent();
    return { status: sent?.status ?? 400, body: isRecord(sent?.body) ? sent!.body as Record<string, unknown> : { success: false }, headers: capture.headers };
  }
  const context = await enforceMutationPrecondition(capture.res, slug, route, 'suggestion.add', payload);
  if (!context) {
    const sent = capture.sent();
    return { status: sent?.status ?? 409, body: isRecord(sent?.body) ? sent!.body as Record<string, unknown> : { success: false }, headers: capture.headers };
  }
  const result = await executeDocumentOperationAsync(slug, 'POST', `/marks/suggest-${kind}`, payload, context);
  finishSuggestionNote(capture.res, slug, gate, result);
  await finishSuggestionBundle(slug, gate, result);
  const body = isRecord(result.body) ? result.body as Record<string, unknown> : {};
  if (result.status < 200 || result.status >= 300) return { status: result.status, body, headers: capture.headers };
  notifyCollabMutation(slug, buildParticipationFromMutation(req, slug, payload, { details: `suggestion.add.${kind}` }), { apply: false });
  const markId = typeof body.markId === 'string' ? body.markId : '';
  const why = typeof payload.why === 'string' && payload.why.trim() ? payload.why.trim().slice(0, 300) : null;
  return {
    status: result.status, body, headers: capture.headers, quote,
    ref: { markId, kind: kind as ChatSuggestionRef['kind'], quote: quote.slice(0, 2000), content: typeof raw.content === 'string' ? raw.content.slice(0, 4000) : null, why },
  };
}

// GET ?after=<id>&limit=<n>: messages after the cursor, oldest first (or the newest page), each
// with `pointers` resolved against the current lines.
agentRoutes.get('/:slug/chat', async (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) { res.status(400).json({ success: false, error: 'Invalid slug' }); return; }
  if (!checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot'])) return;
  const afterRaw = typeof req.query.after === 'string' ? Number(req.query.after) : NaN;
  const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
  const after = Number.isFinite(afterRaw) && afterRaw >= 0 ? afterRaw : null;
  const messages = listChatMessages(slug, { after, limit: Number.isFinite(limitRaw) ? limitRaw : undefined });
  const lines = await computeServerLines(await currentAgentMarkdown(slug));
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    success: true,
    messages: messages.map(message => serializeChatMessage(message, lines)),
    cursor: messages.length ? messages[messages.length - 1].id : (after ?? 0),
    mentionable: mentionCandidates(slug),
    policy: CHAT_POLICY,
  });
});

// POST { text, lines?: [<line target>], replyTo?, mentions?, suggestion?: { kind, quote, content, why, ... } }
agentRoutes.post('/:slug/chat', async (req: Request, res: Response) => {
  const route = 'POST /chat';
  const slug = getSlug(req);
  if (!slug) { sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route }); return; }
  const role = checkAuth(req, res, slug, ['commenter', 'editor', 'owner_bot']);
  if (!role) return;
  const payload = asPayload(req.body);
  const actor = resolveAgentActor(req, slug, payload, role);
  if (!actor.ok) { sendMutationResponse(res, actor.status, actor.body, { route, slug }); return; }
  if (payload.lines !== undefined && !Array.isArray(payload.lines)) {
    sendMutationResponse(res, 400, { success: false, code: 'INVALID_LINES', error: '"lines" is a list of line targets ({"quote": ...}, {"lineIndex": 3}, {"ref": "b4"})' }, { route, slug });
    return;
  }
  const targets = Array.isArray(payload.lines) ? payload.lines : [];
  if (targets.length > CHAT_POLICY.maxLines) {
    sendMutationResponse(res, 400, { success: false, code: 'TOO_MANY_LINES', error: `At most ${CHAT_POLICY.maxLines} line pointers per message` }, { route, slug });
    return;
  }
  if (payload.replyTo !== undefined && payload.replyTo !== null && !getChatMessage(slug, Number(payload.replyTo))) {
    sendMutationResponse(res, 404, { success: false, code: 'REPLY_TARGET_NOT_FOUND', error: '"replyTo" names no message in this document\'s chat' }, { route, slug });
    return;
  }
  let lines = await computeServerLines(await currentAgentMarkdown(slug));
  const anchors: unknown[] = [];
  for (const [index, raw] of targets.entries()) {
    const target = Number.isInteger(raw) ? { lineIndex: raw } : typeof raw === 'string' && /^b\d+$/i.test(raw) ? { ref: raw } : raw;
    if (!isRecord(target)) { sendMutationResponse(res, 400, { success: false, code: 'INVALID_LINES', error: `lines[${index}] is not a line target`, index }, { route, slug }); return; }
    const found = resolveAgentLineTarget(lines, target);
    if (!found.ok) {
      sendMutationResponse(res, found.status, { success: false, code: found.code, error: `lines[${index}]: ${found.error}`, index, ...(found.candidates ? { candidates: found.candidates } : {}) }, { route, slug });
      return;
    }
    anchors.push(anchorForDocLine(found.line));
  }
  let suggestion: ChatSuggestionRef | null = null;
  let suggestionBody: Record<string, unknown> | null = null;
  if (payload.suggestion !== undefined && payload.suggestion !== null) {
    if (!isRecord(payload.suggestion)) {
      sendMutationResponse(res, 400, { success: false, code: 'INVALID_SUGGESTION', error: '"suggestion" is an object: { kind, quote, content, why }' }, { route, slug });
      return;
    }
    const made = await chatSuggestion(req, slug, actor.by, payload.suggestion as Record<string, unknown>);
    for (const [name, value] of Object.entries(made.headers)) res.setHeader(name, value);
    if (!made.ref || made.status < 200 || made.status >= 300) {
      sendMutationResponse(res, made.status, { ...made.body, success: false, stage: 'suggestion' }, { route, slug });
      return;
    }
    suggestion = made.ref;
    suggestionBody = made.body;
    lines = await computeServerLines(await currentAgentMarkdown(slug));
    // The message points at the suggestion's line when it names no line itself.
    if (anchors.length === 0 && CHAT_POLICY.suggestionPointsAtItsLine && made.quote) {
      const found = resolveAgentLineTarget(lines, { quote: made.quote.split('\n')[0].slice(0, 200) });
      if (found.ok) anchors.push(anchorForDocLine(found.line));
    }
  }
  const result = postChatMessage(slug, {
    by: actor.by, text: payload.text, anchors, mentions: payload.mentions, replyTo: payload.replyTo, suggestion, source: 'agent', lines,
  });
  if (result.status === 200) {
    notifyCollabMutation(slug, buildParticipationFromMutation(req, slug, payload, { details: 'chat.message' }), { apply: false });
    if (suggestionBody) result.body.suggestion = { markId: suggestion?.markId, status: 'pending', ...(suggestionBody.note ? { note: suggestionBody.note } : {}), ...(suggestionBody.warnings ? { warnings: suggestionBody.warnings } : {}), ...(suggestionBody.bundle ? { bundle: suggestionBody.bundle } : {}) };
  }
  sendMutationResponse(res, result.status, result.body, { route, slug });
});

agentRoutes.post('/:slug/marks/accept', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /marks/accept';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['editor', 'owner_bot'])) return;
  const routeKey = mutationRoute;
  const replay = await maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;
  const payload = asPayload(req.body);
  const mutationContext = await enforceMutationPrecondition(res, slug, mutationRoute, 'suggestion.accept', payload, replay);
  if (!mutationContext) return;
  const result = await executeDocumentOperationAsync(slug, 'POST', '/marks/accept', payload, mutationContext);
  maybeLogMarkHydrationMismatch(mutationRoute, slug, payload, mutationContext, result);
  if (result.status >= 200 && result.status < 300) {
    const collabStatus = await notifyCollabMutation(
      slug,
      buildParticipationFromMutation(req, slug, payload, { details: 'suggestion.accept' }),
      {
        verify: true,
        source: 'marks.accept',
        stabilityMs: EDIT_COLLAB_STABILITY_MS,
        strictLiveDoc: true,
        apply: false,
      },
    );
    if (isRecord(result.body)) {
      result.body = {
        ...result.body,
        collab: {
          status: collabStatus.confirmed ? 'confirmed' : 'pending',
          reason: collabStatus.reason ?? (collabStatus.confirmed ? 'confirmed' : 'sync_timeout'),
          markdownConfirmed: collabStatus.markdownConfirmed ?? null,
          fragmentConfirmed: collabStatus.fragmentConfirmed ?? null,
          canonicalConfirmed: collabStatus.canonicalConfirmed ?? null,
        },
      };
    }
    if (!collabStatus.confirmed) {
      const failureBody = {
        success: false,
        code: 'COLLAB_SYNC_FAILED',
        error: 'Suggestion acceptance did not converge to live collaboration state',
        reason: collabStatus.reason ?? 'sync_timeout',
        retryWithState: `/api/agent/${slug}/state`,
        collab: {
          status: 'pending',
          reason: collabStatus.reason ?? 'sync_timeout',
          markdownConfirmed: collabStatus.markdownConfirmed ?? null,
          fragmentConfirmed: collabStatus.fragmentConfirmed ?? null,
          canonicalConfirmed: collabStatus.canonicalConfirmed ?? null,
        },
      } satisfies Record<string, unknown>;
      storeIdempotentMutationResult(replay, mutationRoute, slug, 409, failureBody);
      sendMutationResponse(
        res,
        409,
        failureBody,
        { route: mutationRoute, slug, retryWithState: `/api/agent/${slug}/state` },
      );
      return;
    }
  }
  storeIdempotentMutationResult(replay, mutationRoute, slug, result.status, result.body);
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

agentRoutes.post('/:slug/marks/reject', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /marks/reject';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['editor', 'owner_bot'])) return;
  const routeKey = mutationRoute;
  const replay = await maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;
  const payload = asPayload(req.body);
  const mutationContext = await enforceMutationPrecondition(res, slug, mutationRoute, 'suggestion.reject', payload, replay);
  if (!mutationContext) return;
  const result = await executeDocumentOperationAsync(slug, 'POST', '/marks/reject', payload, mutationContext);
  maybeLogMarkHydrationMismatch(mutationRoute, slug, payload, mutationContext, result);
  storeIdempotentMutationResult(replay, mutationRoute, slug, result.status, result.body);
  if (result.status >= 200 && result.status < 300) {
    notifyCollabMutation(slug, buildParticipationFromMutation(req, slug, payload, { details: 'suggestion.reject' }), { apply: false });
  }
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

agentRoutes.post('/:slug/marks/reply', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /marks/reply';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['commenter', 'editor', 'owner_bot'])) return;
  const routeKey = mutationRoute;
  const replay = await maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;
  const payload = asPayload(req.body);
  const mutationContext = await enforceMutationPrecondition(res, slug, mutationRoute, 'comment.reply', payload, replay);
  if (!mutationContext) return;
  const result = await executeDocumentOperationAsync(slug, 'POST', '/marks/reply', payload, mutationContext);
  storeIdempotentMutationResult(replay, mutationRoute, slug, result.status, result.body);
  if (result.status >= 200 && result.status < 300) {
    notifyCollabMutation(slug, buildParticipationFromMutation(req, slug, payload, { details: 'comment.reply' }), { apply: false });
  }
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

agentRoutes.post('/:slug/marks/resolve', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /marks/resolve';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['commenter', 'editor', 'owner_bot'])) return;
  const routeKey = mutationRoute;
  const replay = await maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;
  const payload = asPayload(req.body);
  const mutationContext = await enforceMutationPrecondition(res, slug, mutationRoute, 'comment.resolve', payload, replay);
  if (!mutationContext) return;
  const result = await executeDocumentOperationAsync(slug, 'POST', '/marks/resolve', payload, mutationContext);
  storeIdempotentMutationResult(replay, mutationRoute, slug, result.status, result.body);
  if (result.status >= 200 && result.status < 300) {
    notifyCollabMutation(slug, buildParticipationFromMutation(req, slug, payload, { details: 'comment.resolve' }), { apply: false });
  }
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

agentRoutes.post('/:slug/marks/unresolve', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /marks/unresolve';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['commenter', 'editor', 'owner_bot'])) return;
  const routeKey = mutationRoute;
  const replay = await maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;
  const payload = asPayload(req.body);
  const mutationContext = await enforceMutationPrecondition(res, slug, mutationRoute, 'comment.unresolve', payload, replay);
  if (!mutationContext) return;
  const result = await executeDocumentOperationAsync(slug, 'POST', '/marks/unresolve', payload, mutationContext);
  storeIdempotentMutationResult(replay, mutationRoute, slug, result.status, result.body);
  if (result.status >= 200 && result.status < 300) {
    notifyCollabMutation(slug, buildParticipationFromMutation(req, slug, payload, { details: 'comment.unresolve' }), { apply: false });
  }
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

agentRoutes.post('/:slug/rewrite', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /rewrite';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['editor', 'owner_bot'])) return;
  const doc = getDocumentBySlug(slug);
  if (!doc) {
    sendMutationResponse(res, 404, { success: false, error: 'Document not found' }, { route: mutationRoute, slug });
    return;
  }
  const payload = asPayload(req.body);
  const mutationBase = await resolveRouteMutationBase(slug);
  const stage = getMutationContractStage();
  const opPrecondition = validateOpPrecondition(stage, 'rewrite.apply', doc, payload, mutationBase?.token ?? null);
  if (!opPrecondition.ok) {
    sendMutationResponse(res, opPrecondition.status, {
      success: false,
      code: opPrecondition.code,
      error: opPrecondition.error,
      latestUpdatedAt: doc.updated_at,
      latestRevision: doc.revision,
      retryWithState: `/api/agent/${slug}/state`,
    }, { route: mutationRoute, slug, retryWithState: `/api/agent/${slug}/state` });
    return;
  }
  const routeKey = mutationRoute;
  const replay = await maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;
  const failRewrite = (
    status: number,
    body: Record<string, unknown>,
    reason: string,
    retryWithState?: string,
  ): void => {
    releaseIdempotentMutationResult(replay, mutationRoute, slug, reason);
    sendMutationResponse(
      res,
      status,
      body,
      { route: mutationRoute, slug, ...(retryWithState ? { retryWithState } : {}) },
    );
  };
  const rewriteValidationError = validateRewriteApplyPayload(payload);
  if (rewriteValidationError) {
    failRewrite(400, { success: false, error: rewriteValidationError }, 'invalid_rewrite_payload');
    return;
  }
  const rewriteGate = evaluateRewriteLiveClientGateWithOptions(slug, payload, {
    route: mutationRoute,
    requestId: readRequestId(req),
  });
  res.setHeader('X-Proof-Agent-Routes', '1');
  res.setHeader('X-Proof-Rewrite-Hosted', rewriteGate.hostedRuntime ? '1' : '0');
  res.setHeader('X-Proof-Rewrite-Blocked', rewriteGate.blocked ? '1' : '0');
  res.setHeader('X-Proof-Rewrite-Clients', String(rewriteGate.connectedClients));
  if (rewriteGate.blocked) {
    recordRewriteLiveClientBlock(
      mutationRoute,
      rewriteGate.runtimeEnvironment,
      rewriteGate.forceRequested,
      rewriteGate.forceIgnored,
    );
    if (rewriteGate.forceIgnored) {
      recordRewriteForceIgnored(mutationRoute, rewriteGate.runtimeEnvironment);
    }
    console.warn('[agent-routes] rewrite blocked by live clients', {
      slug,
      route: mutationRoute,
      connectedClients: rewriteGate.connectedClients,
      forceRequested: rewriteGate.forceRequested,
      forceHonored: rewriteGate.forceHonored,
      forceIgnored: rewriteGate.forceIgnored,
      runtimeEnvironment: rewriteGate.runtimeEnvironment,
    });
    traceServerIncident({
      slug,
      subsystem: 'agent_routes',
      level: 'warn',
      eventType: 'rewrite.blocked_live_clients',
      message: 'Agent rewrite endpoint was blocked because live clients were connected',
      data: {
        route: mutationRoute,
        connectedClients: rewriteGate.connectedClients,
        forceRequested: rewriteGate.forceRequested,
        forceHonored: rewriteGate.forceHonored,
        forceIgnored: rewriteGate.forceIgnored,
        runtimeEnvironment: rewriteGate.runtimeEnvironment,
      },
    });
    failRewrite(409, rewriteBlockedResponseBody(rewriteGate, slug), 'rewrite_blocked_live_clients', `/api/agent/${slug}/state`);
    return;
  }
  console.warn('[agent-routes] rewrite allowed in hosted runtime', {
    slug,
    route: mutationRoute,
    connectedClients: rewriteGate.connectedClients,
    accessEpoch: rewriteGate.accessEpoch,
    exactEpochCount: rewriteGate.exactEpochCount,
    anyEpochCount: rewriteGate.anyEpochCount,
    documentLeaseExactCount: rewriteGate.documentLeaseExactCount,
    documentLeaseAnyEpochCount: rewriteGate.documentLeaseAnyEpochCount,
    recentLeaseCount: rewriteGate.recentLeaseCount,
    forceRequested: rewriteGate.forceRequested,
    runtimeEnvironment: rewriteGate.runtimeEnvironment,
  });
  const barrierStartedAt = Date.now();
  const preBarrierMutationBase = opPrecondition.mode === 'token' ? mutationBase : null;
  let promotedBarrierBaseToken: string | null = null;
  try {
    await prepareRewriteCollabBarrier(slug, {
      validateWhileLocked: async () => {
        const lockedDoc = getDocumentBySlug(slug) ?? doc;
        const currentMutationBase = opPrecondition.mode === 'token'
          ? await resolveRouteMutationBase(slug)
          : null;
        const lockedPrecondition = validateOpPrecondition(
          stage,
          'rewrite.apply',
          lockedDoc,
          payload,
          currentMutationBase?.token ?? null,
        );
        if (!lockedPrecondition.ok) {
          throw new RewriteBarrierPreconditionError(lockedPrecondition);
        }
      },
    });
    if (opPrecondition.mode === 'token' && preBarrierMutationBase) {
      const postBarrierMutationBase = await resolveRouteMutationBase(slug);
      const barrierOnlyTokenDrift = (
        postBarrierMutationBase
        && opPrecondition.baseToken === preBarrierMutationBase.token
        && postBarrierMutationBase.token !== preBarrierMutationBase.token
        && sameRouteMutationBaseContent(postBarrierMutationBase, preBarrierMutationBase)
      );
      if (barrierOnlyTokenDrift) {
        promotedBarrierBaseToken = postBarrierMutationBase.token;
      }
    }
    recordRewriteBarrierLatency(mutationRoute, Date.now() - barrierStartedAt);
  } catch (error) {
    if (error instanceof RewriteBarrierPreconditionError) {
      const latestDoc = getDocumentBySlug(slug) ?? doc;
      failRewrite(
        error.status,
        {
          success: false,
          code: error.code,
          error: error.message,
          latestUpdatedAt: latestDoc.updated_at,
          latestRevision: latestDoc.revision,
          retryWithState: `/api/agent/${slug}/state`,
        },
        error.code,
        `/api/agent/${slug}/state`,
      );
      return;
    }
    const reason = classifyRewriteBarrierFailureReason(error);
    recordRewriteBarrierFailure(mutationRoute, reason);
    recordRewriteBarrierLatency(mutationRoute, Date.now() - barrierStartedAt);
    traceServerIncident({
      slug,
      subsystem: 'agent_routes',
      level: 'error',
      eventType: 'rewrite.barrier_failed',
      message: 'Agent rewrite endpoint failed because the collab barrier could not complete',
      data: {
        route: mutationRoute,
        reason,
        ...toErrorTraceData(error),
      },
    });
    failRewrite(503, rewriteBarrierFailedResponseBody(slug, reason), `rewrite_barrier_failed:${reason}`, `/api/agent/${slug}/state`);
    return;
  }
  const rewritePayload = promotedBarrierBaseToken !== null
    ? { ...payload, baseToken: promotedBarrierBaseToken }
    : payload;
  const result = await executeCanonicalRewrite(slug, rewritePayload, {
    idempotencyKey: replay.idempotencyKey ?? undefined,
    idempotencyRoute: replay.reservation?.route ?? undefined,
  });
  let responseStatus = result.status;
  let responseBody: Record<string, unknown> = result.body;
  if (result.status >= 200 && result.status < 300) {
    responseBody = annotateRewriteDisruptionMetadata(responseBody, rewriteGate);
  }
  storeIdempotentMutationResult(replay, mutationRoute, slug, responseStatus, responseBody);
  sendMutationResponse(res, responseStatus, responseBody, { route: mutationRoute, slug });
});

agentRoutes.post('/:slug/repair', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /repair';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['owner_bot'])) return;
  const routeKey = mutationRoute;
  const replay = await maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;

  const result = await repairCanonicalProjection(slug, {
    enforceProjectionGuard: true,
    allowAuthoritativeGrowth: true,
  });
  const projectionRow = result.ok ? getDocumentProjectionBySlug(slug) : null;
  const responseStatus = result.ok ? 200 : result.status;
  const responseBody = result.ok
    ? {
      success: true,
      slug,
      revision: result.document.revision,
      yStateVersion: result.yStateVersion,
      health: projectionRow?.health ?? 'healthy',
      ...(projectionRow?.health_reason ? { healthReason: projectionRow.health_reason } : {}),
    }
    : {
      success: false,
      code: result.code,
      error: result.error,
    };
  storeIdempotentMutationResult(replay, mutationRoute, slug, responseStatus, responseBody);
  sendMutationResponse(res, responseStatus, responseBody, { route: mutationRoute, slug });
});

agentRoutes.post('/:slug/clone-from-canonical', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /clone-from-canonical';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['owner_bot'])) return;
  const routeKey = mutationRoute;
  const replay = await maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;

  const result = await cloneFromCanonical(slug, typeof req.body?.by === 'string' ? req.body.by : 'owner');
  const responseStatus = result.ok ? 200 : result.status;
  const responseBody = result.ok
    ? {
      success: true,
      sourceSlug: slug,
      cloneSlug: result.cloneSlug ?? result.document.slug,
      revision: result.document.revision,
      ...(result.ownerSecret ? { ownerSecret: result.ownerSecret } : {}),
    }
    : {
      success: false,
      code: result.code,
      error: result.error,
    };
  storeIdempotentMutationResult(replay, mutationRoute, slug, responseStatus, responseBody);
  sendMutationResponse(res, responseStatus, responseBody, { route: mutationRoute, slug });
});

agentRoutes.get('/:slug/events/pending', (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) {
    recordCollabRouteLatency('events_pending', 'invalid_slug', 0);
    res.status(400).json({ success: false, error: 'Invalid slug' });
    return;
  }
  if (!checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot'])) return;
  const after = Number.parseInt(String(req.query.after ?? '0'), 10);
  const limit = Number.parseInt(String(req.query.limit ?? '100'), 10);
  const events = listDocumentEvents(slug, Number.isFinite(after) ? Math.max(0, after) : 0, Number.isFinite(limit) ? limit : 100);
  const startedAtMs = getRequestStartedAtMs(res) ?? Date.now();
  const durationMs = Math.max(0, Date.now() - startedAtMs);
  recordCollabRouteLatency('events_pending', 'success', durationMs);
  if (durationMs >= 500) {
    traceServerIncident({
      requestId: readRequestId(req),
      slug,
      subsystem: 'collab',
      level: 'info',
      eventType: 'collab.route.events_pending',
      message: 'events/pending request completed',
      data: {
        route: 'events_pending',
        result: 'success',
        durationMs,
        after: Number.isFinite(after) ? Math.max(0, after) : 0,
        limit: Number.isFinite(limit) ? limit : 100,
        eventCount: events.length,
      },
    });
  }
  res.json({
    success: true,
    events: events.map((event) => ({
      id: event.id,
      type: event.event_type,
      data: (() => {
        try {
          return JSON.parse(event.event_data);
        } catch {
          return {};
        }
      })(),
      actor: event.actor,
      createdAt: event.created_at,
      ackedAt: event.acked_at,
      ackedBy: event.acked_by,
    })),
    cursor: events.length > 0 ? events[events.length - 1]?.id ?? after : after,
  });
});

agentRoutes.post('/:slug/events/ack', (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) {
    res.status(400).json({ success: false, error: 'Invalid slug' });
    return;
  }
  if (!checkAuth(req, res, slug, ['editor', 'owner_bot'])) return;
  const payload = asPayload(req.body);
  const upToId = typeof payload.upToId === 'number' ? payload.upToId : Number.NaN;
  if (!Number.isFinite(upToId) || upToId < 0) {
    res.status(400).json({ success: false, error: 'Invalid upToId' });
    return;
  }
  const by = typeof payload.by === 'string' && payload.by.trim() ? payload.by.trim() : 'owner';
  const acked = ackDocumentEvents(slug, Math.trunc(upToId), by);
  res.json({ success: true, acked });
});

agentRoutes.use(async (req: Request, res: Response) => {
  const slug = getSlug(req);
  const method = req.method.toUpperCase();
  const path = req.path || '/';
  const mutationRoute = `${method} ${path}`;
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot'])) return;
  if (routeRequiresMutation(method, path)) {
      const role = resolveDocumentAccessRole(slug, getPresentedSecret(req, slug) ?? '');
    if (!hasRole(role, ['editor', 'owner_bot'])) {
      sendMutationResponse(
        res,
        403,
        { success: false, error: 'Insufficient role for mutation route' },
        { route: mutationRoute, slug },
      );
      return;
    }
  }
  const result = await executeDocumentOperationAsync(slug, method, path, asPayload(req.body));
  if (routeRequiresMutation(method, path) && result.status >= 200 && result.status < 300) {
    notifyCollabMutation(
      slug,
      buildParticipationFromMutation(req, slug, asPayload(req.body), { details: `${method} ${path}` }),
      { apply: false },
    );
  }
  if (routeRequiresMutation(method, path)) {
    sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
    return;
  }
  res.status(result.status).json(result.body);
});
