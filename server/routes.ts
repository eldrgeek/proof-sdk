import { agentKeyRoutes } from './agent-key-routes.js';
import { getClientIp, trustProxyHeaders } from './client-address.js';
import { createHash, randomUUID } from 'crypto';
import { Router, text, type Request, type Response } from 'express';
import { generateSlug } from './slug.js';
import {
  applyAgentCursorHintToLoadedCollab,
  applyAgentPresenceToLoadedCollab,
  applyCanonicalDocumentToCollab,
  buildCollabSession,
  deriveCanonicalMarkdownForStorage,
  getCanonicalReadableDocumentSync,
  getCollabRuntime,
  invalidateCollabDocument,
  invalidateCollabDocumentAndWait,
  loadedCollabMarksMatch,
  preserveMarksOnlyWriteIfAuthoritativeYjsMatches,
  refreshLoadedCollabMetaFromDb,
  syncCanonicalDocumentStateToCollab,
  stripEphemeralCollabSpans,
  acquireRewriteLock,
} from './collab.js';
import { getSnapshotPublicUrl, refreshSnapshotForSlug } from './snapshot.js';
import { executeCanonicalRewrite, mutateCanonicalDocument } from './canonical-document.js';
import {
  addEvent,
  addDocumentEvent,
  bumpDocumentAccessEpoch,
  canMutateByOwnerIdentity,
  createDocument,
  createDocumentAccessToken,
  deleteDocument,
  getDocument,
  getDocumentBySlug,
  getStoredIdempotencyRecord,
  pauseDocument,
  resolveDocumentAccess,
  listDocumentAgentKeys,
  resolveDocumentAccessRole,
  rebuildDocumentBlocks,
  resumeDocument,
  revokeDocument,
  revokeDocumentAccessTokens,
  storeIdempotencyResult,
  updateDocument,
  updateDocumentTitle,
  updateMarks,
} from './db.js';
import { isShareRole, type ShareRole } from './share-types.js';
import { broadcastToRoom, closeRoom, getActiveCollabClientBreakdown, getRoomSize } from './ws.js';
import { runLegacyMarkRangeBackfillOnce } from './marks-range-backfill.js';
import { createRateLimiter } from './rate-limiter.js';
import { getCookie, getCookies, shareTokenCookieName } from './cookies.js';
import { canonicalizeStoredMarks } from '../src/formats/marks.js';
import {
  recordRewriteBarrierFailure,
  recordRewriteBarrierLatency,
  recordRewriteForceIgnored,
  recordRewriteLiveClientBlock,
} from './metrics.js';
import {
  handleOAuthCallback,
  pollOAuthFlow,
  resolveShareMarkdownAuthMode,
  revokeHostedSessionToken,
  startOAuthFlow,
  validateHostedSessionToken,
} from './hosted-auth.js';
import {
  AGENT_DOCS_PATH,
  CANONICAL_CREATE_API_PATH,
  DIRECT_SHARE_AUTH_FIX,
  LEGACY_CREATE_API_PATH,
  buildLegacyCreateDeprecationPayload,
  buildLegacyCreateDisabledPayload,
  canonicalCreateLink,
  getLegacyCreateResponseHeaders,
  resolveLegacyCreateMode,
  type LegacyCreateMode,
} from './agent-guidance.js';
import { captureDocumentCreatedTelemetry } from './telemetry.js';
import { executeDocumentOperationAsync, type EngineExecutionResult } from './document-engine.js';
import {
  type DocumentOpType,
  authorizeDocumentOp,
  parseDocumentOpRequest,
  resolveDocumentOpRoute,
} from './document-ops.js';
import { validateRewriteApplyPayload } from './rewrite-validation.js';
import { adaptMutationResponse } from './mutation-coordinator.js';
import {
  annotateRewriteDisruptionMetadata,
  classifyRewriteBarrierFailureReason,
  evaluateRewriteLiveClientGate,
  rewriteBarrierFailedResponseBody,
  rewriteBlockedResponseBody,
} from './rewrite-policy.js';
import { summarizeDocumentIntegrity } from './document-integrity.js';
import {
  getMutationContractStage,
  isIdempotencyRequired,
  validateOpPrecondition,
} from './mutation-stage.js';
import { resolveExplicitAgentIdentity } from '../src/shared/agent-identity.js';
import { activeAgentKeyActors, computeServerLines, documentOwnerActors, isLibraryDocumentCreator, listCanonicalLineMarks, listLineMarks, reviewMarksFromStored, writeLineMark, writeLineMarksBatch } from './line-marks.js';
import { answerAsk, listCanonicalAsks, reaskAsk, withdrawAnswer, withdrawAsk } from './asks.js';
import { approveDo, revokeDo, runDo } from './do.js';
import { listDos } from './do-store.js';
import { DO_POLICY, doTeamActors } from '../src/shared/do.js';
import { TIER_POLICY, isLineTier } from '../src/shared/line-tiers.js';
import { evaluateDocumentTiers, listTierRecords, tierSignals, writeTiers } from './line-tiers.js';
import { isLineAnchor, resolveLineAnchor, type DocLine } from '../src/shared/line-marks.js';
import { buildSinceYou, checkAlignment, currentDocumentState, latestSnapshotInfo, listSnapshotInfos, scheduleAlignmentCheck, sendSnapshotFile } from './alignment.js';
import { bindFamiliar, familiarOf, listFamiliars, listProxyMarks, ratifyProxies, undoableRatifications, undoRatification } from './proxy-marks.js';
import { EVIDENCE_POLICY, PROXY_POLICY } from '../src/shared/proxy-marks.js';
import { clearFlag, clearObjection, createObjection, keepObjection, writeFlag } from './review-aids.js';
import { listFlags, listObjections, listReviewNotes } from './review-aids-store.js';
import { clearTtl, decideAlternative, offerAlternative, pickAlternative, recordBundleDecision, recordExplain, setBlindSetting, setTtl, withdrawAlternative } from './proof-extras.js';
import { getProofSettings, listAlternatives, listBundles, listExplains, listPicks, listTtls } from './proof-extras-store.js';
import { blindViewFor } from './proof-extras-eval.js';
import { lineEditor } from './agent-routes.js';
import { ASK_POLICY, evaluateAsks } from '../src/shared/asks.js';
import { guestActor, isGuestActor, normalizeActorString } from '../src/shared/identity.js';
import { buildDirectory, clientDirectory, decideActor, sessionIdentity, type ActorDecision } from './identity.js';
import { attestedFor, documentSession, getGuestAccessMode, guestMarksCount, resolveTokenlessAccess } from './document-team.js';
import {
  CROSS_INVITE_POLICY,
  agentProvenanceMap,
  displayName as crossDisplayName,
  documentProvenance,
  listNominations,
  activeAttestations,
} from './cross-invitation.js';
import { IDENTITY_POLICY, actorsIn, isEmailAddress, verifiedHumanActor, type IdentityDirectory, type ViewerIdentity } from '../src/shared/identity.js';
import { actorKey, agentKeyActor } from '../src/shared/line-marks.js';
import { chatAuthors, listChatMessages, mentionCandidates, postChatMessage } from './chat.js';
import { CHAT_POLICY } from '../src/shared/chat.js';
import { EXPLAIN_POLICY } from '../src/shared/explain.js';
import { WHY_POLICY } from '../src/shared/review-aids.js';
import { getPublicOrigin } from './public-origin.js';
import { getLibrarySession, isLibraryEnabled } from './library/auth.js';
import {
  buildProofSdkAgentDescriptor,
  buildProofSdkDocumentPaths,
  buildProofSdkLinks,
} from './proof-sdk-routes.js';
import {
  EXPORT_FORMAT_ERROR,
  IMPORT_POLICY,
  applyImportedMarks,
  exportProofDocument,
  normalizeExportFormat,
  parseImport,
  type ImportAuthority,
  type ImportSummary,
} from './proof-dialect.js';
import { stripAllProofSpanTags as stripSpansForExport } from './proof-span-strip.js';
import { isEmailAddress as isEmailForImport, verifiedHumanActor as verifiedHumanForImport } from '../src/shared/identity.js';

export const apiRoutes = Router();
apiRoutes.use(agentKeyRoutes);
runLegacyMarkRangeBackfillOnce();

const DIRECT_SHARE_RATE_LIMIT_BUCKETS = new Map<string, { count: number; resetAt: number }>();
const DEFAULT_DIRECT_SHARE_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_DIRECT_SHARE_RATE_LIMIT_MAX_UNAUTH_PER_MIN = 20;
const DEFAULT_DIRECT_SHARE_RATE_LIMIT_MAX_AUTH_PER_MIN = 120;
const DIRECT_SHARE_RATE_LIMIT_MAX_BUCKETS = 10_000;
const OPS_RATE_LIMIT_WINDOW_MS = parsePositiveIntEnv('PROOF_OPS_RATE_LIMIT_WINDOW_MS', 60_000);
const OPS_RATE_LIMIT_MAX_REQUESTS = parsePositiveIntEnv('PROOF_OPS_RATE_LIMIT_MAX', 120);
const REWRITE_BARRIER_TIMEOUT_MS = parsePositiveIntEnv('PROOF_REWRITE_BARRIER_TIMEOUT_MS', 5000);
const opsRateLimiter = createRateLimiter({
  windowMs: OPS_RATE_LIMIT_WINDOW_MS,
  maxRequests: OPS_RATE_LIMIT_MAX_REQUESTS,
  keyFn: (req) => `${getClientIp(req)}:${getSlugParam(req) || 'unknown'}`,
});

export const shareMarkdownBodyParser = text({
  type: ['text/plain', 'text/markdown'],
  limit: '10mb',
});

function getSlugParam(req: Request): string | null {
  const slugParam = req.params.slug;
  if (typeof slugParam === 'string' && slugParam.length > 0) return slugParam;
  if (Array.isArray(slugParam) && typeof slugParam[0] === 'string' && slugParam[0].length > 0) return slugParam[0];
  return null;
}

function isMarksPayload(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}


function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return isMarksPayload(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getIdempotencyKey(req: Request): string | null {
  const header = req.header('idempotency-key') ?? req.header('x-idempotency-key');
  if (typeof header !== 'string') return null;
  const trimmed = header.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hashRequestBody(body: unknown): string {
  try {
    return createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
  } catch {
    return createHash('sha256').update(String(body)).digest('hex');
  }
}


function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBlankMarkdown(markdown: string): boolean {
  return !markdown.trim();
}

type CommentEventType = 'comment.added' | 'comment.replied' | 'comment.resolved';

type CommentEventEmission = {
  type: CommentEventType;
  data: Record<string, unknown>;
  actor: string;
};

type NormalizedCommentReply = {
  by: string;
  text: string;
  at: string;
};

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readCommentReplies(mark: Record<string, unknown>): NormalizedCommentReply[] {
  const rawReplies = Array.isArray(mark.thread)
    ? mark.thread
    : (Array.isArray(mark.replies) ? mark.replies : []);
  const replies: NormalizedCommentReply[] = [];
  for (const entry of rawReplies) {
    if (!isRecord(entry)) continue;
    const by = asNonEmptyString(entry.by);
    const text = asNonEmptyString(entry.text);
    const at = asNonEmptyString(entry.at) ?? '';
    if (!by || !text) continue;
    replies.push({ by, text, at });
  }
  return replies;
}

function replyFingerprint(reply: NormalizedCommentReply): string {
  return `${reply.by}\u0000${reply.text}\u0000${reply.at}`;
}

function collectCommentEventsFromMarksDiff(
  beforeMarks: Record<string, unknown>,
  afterMarks: Record<string, unknown>,
  fallbackActor: string,
): CommentEventEmission[] {
  const events: CommentEventEmission[] = [];

  for (const [markId, rawAfterMark] of Object.entries(afterMarks)) {
    if (!isRecord(rawAfterMark)) continue;
    if (rawAfterMark.kind !== 'comment') continue;

    const beforeMark = isRecord(beforeMarks[markId]) ? beforeMarks[markId] as Record<string, unknown> : null;
    const beforeWasComment = beforeMark?.kind === 'comment';
    const commentBy = asNonEmptyString(rawAfterMark.by) ?? fallbackActor;
    const commentText = typeof rawAfterMark.text === 'string' ? rawAfterMark.text : '';
    const commentQuote = typeof rawAfterMark.quote === 'string' ? rawAfterMark.quote : '';

    if (!beforeWasComment) {
      events.push({
        type: 'comment.added',
        data: { markId, by: commentBy, quote: commentQuote, text: commentText },
        actor: commentBy,
      });
    }

    const beforeReplies = beforeMark ? readCommentReplies(beforeMark) : [];
    const afterReplies = readCommentReplies(rawAfterMark);
    if (afterReplies.length > 0) {
      const beforeCounts = new Map<string, number>();
      for (const reply of beforeReplies) {
        const key = replyFingerprint(reply);
        beforeCounts.set(key, (beforeCounts.get(key) ?? 0) + 1);
      }
      for (const reply of afterReplies) {
        const key = replyFingerprint(reply);
        const remaining = beforeCounts.get(key) ?? 0;
        if (remaining > 0) {
          beforeCounts.set(key, remaining - 1);
          continue;
        }
        events.push({
          type: 'comment.replied',
          data: { markId, by: reply.by, text: reply.text },
          actor: reply.by || fallbackActor,
        });
      }
    }

    if (beforeWasComment && !Boolean(beforeMark?.resolved) && Boolean(rawAfterMark.resolved)) {
      events.push({
        type: 'comment.resolved',
        data: { markId, by: fallbackActor },
        actor: fallbackActor,
      });
    }
  }

  return events;
}

function sendMutationResponse(
  res: Response,
  status: number,
  body: unknown,
  context: { route: string; slug?: string; retryWithState?: string },
): void {
  const adapted = adaptMutationResponse(status, body, context);
  res.status(adapted.status).json(adapted.body);
}

async function prepareRewriteCollabBarrier(slug: string): Promise<void> {
  const collabRuntime = getCollabRuntime();
  if (!collabRuntime.enabled) return;
  // Acquire a rewrite lock BEFORE disconnecting clients.  This prevents any
  // client-originated onChange/onStoreDocument writes from sneaking through
  // during the window between disconnect and rewrite completion.
  acquireRewriteLock(slug);
  try {
    if ((process.env.PROOF_REWRITE_BARRIER_FORCE_FAIL || '').trim() === '1') {
      throw new Error('forced rewrite barrier failure');
    }
    bumpDocumentAccessEpoch(slug);
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        invalidateCollabDocumentAndWait(slug),
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
    console.error('[routes] Failed to prepare rewrite collab barrier:', { slug, error });
    invalidateCollabDocument(slug);
    throw error;
  }
}

function maybeBuildAgentParticipation(
  req: Request,
  body: Record<string, unknown>,
): { presenceEntry: Record<string, unknown>; cursorQuote: string | null } | null {
  const identity = resolveExplicitAgentIdentity(body, req.header('x-agent-id'));
  if (identity.kind !== 'ok') return null;

  const presenceEntry: Record<string, unknown> = {
    id: identity.id,
    name: identity.name,
    color: identity.color,
    avatar: identity.avatar,
    status: 'editing',
    details: 'ops',
    tokenId: resolveDocumentAccess(String(req.params.slug), getPresentedSecret(req) ?? '')?.tokenId ?? null,
    at: new Date().toISOString(),
  };

  const quote = typeof body.quote === 'string' && body.quote.trim() ? body.quote.trim() : null;
  return { presenceEntry, cursorQuote: quote };
}

function getDirectShareApiKey(): string | null {
  const key = (process.env.PROOF_SHARE_MARKDOWN_API_KEY || '').trim();
  return key.length > 0 ? key : null;
}

function getDirectSharePresentedToken(req: Request): string | null {
  const headerKey = req.header('x-api-key');
  if (typeof headerKey === 'string' && headerKey.trim()) return headerKey.trim();

  const authHeader = req.header('authorization');
  if (typeof authHeader === 'string') {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match && match[1]) return match[1].trim();
  }
  return null;
}

type DirectShareAuthorizationResult = {
  authed: boolean;
  authMode: 'none' | 'api_key' | 'oauth' | 'oauth_or_api_key';
  actor: string;
};

function buildOAuthNotConfiguredPayload(errorMessage: string): Record<string, unknown> {
  return {
    error: errorMessage,
    code: 'OAUTH_NOT_CONFIGURED',
    workaround: {
      endpoint: '/api/documents',
      method: 'POST',
      description: 'Use share tokens or PROOF_SHARE_MARKDOWN_API_KEY while OAuth is unavailable.',
      body: { markdown: '# Title\n\nHello' },
    },
  };
}

function sendOAuthChallenge(req: Request, res: Response, reason: string): null {
  const publicBaseUrl = getPublicBaseUrl(req);
  const started = startOAuthFlow(publicBaseUrl);
  if (!started.ok) {
    res.status(503).json(buildOAuthNotConfiguredPayload('OAuth is not configured on this server'));
    return null;
  }

  res.status(401).json({
    error: 'Authentication required',
    code: 'AUTH_REQUIRED',
    providerCode: 'OAUTH_REQUIRED',
    reason,
    fix: DIRECT_SHARE_AUTH_FIX,
    alternative: 'Or use OAuth: open authUrl in browser',
    authUrl: started.authUrl,
    pollUrl: started.pollUrl,
    pollToken: started.pollToken,
    expiresAt: started.expiresAt,
    expiresIn: started.expiresIn,
    auth: {
      provider: 'oauth',
      requestId: started.requestId,
      authUrl: started.authUrl,
      pollUrl: started.pollUrl,
      pollToken: started.pollToken,
      expiresAt: started.expiresAt,
      expiresIn: started.expiresIn,
      startEndpoint: '/api/auth/start',
      pollEndpoint: '/api/auth/poll/:requestId',
    },
  });
  return null;
}

function applyLegacyCreateHeaders(res: Response, mode: LegacyCreateMode): void {
  const headers = getLegacyCreateResponseHeaders(mode);
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
}

function recordLegacyCreateRouteTelemetry(
  req: Request,
  mode: LegacyCreateMode,
  outcome: 'allowed' | 'allowed_warn' | 'blocked_disabled',
): void {
  console.info('[telemetry] legacy_create_route', JSON.stringify({
    mode,
    outcome,
    ip: getClientIp(req),
    host: req.get('host') || '',
    at: new Date().toISOString(),
  }));
}

function isLegacyCreatePathRequest(req: Request): boolean {
  if (req.baseUrl === '/api') return true;
  return req.originalUrl === LEGACY_CREATE_API_PATH || req.originalUrl.startsWith(`${LEGACY_CREATE_API_PATH}?`);
}

async function authorizeDirectShareRequest(
  req: Request,
  res: Response,
): Promise<DirectShareAuthorizationResult | null> {
  const publicBaseUrl = getPublicBaseUrl(req);
  const authMode = resolveShareMarkdownAuthMode(publicBaseUrl);
  const presented = getDirectSharePresentedToken(req);

  if (authMode === 'none') {
    return { authed: false, authMode, actor: 'anonymous' };
  }

  if (authMode === 'api_key') {
    const requiredApiKey = getDirectShareApiKey();
    if (!requiredApiKey) {
      res.status(503).json({
        error: 'Direct share API key mode is enabled but PROOF_SHARE_MARKDOWN_API_KEY is missing',
        code: 'DIRECT_SHARE_MISCONFIGURED',
      });
      return null;
    }
    if (presented === requiredApiKey) {
      return { authed: true, authMode, actor: 'api-key' };
    }
    res.status(401).json({
      error: 'Unauthorized direct share request',
      code: 'UNAUTHORIZED',
      hint: 'Set Authorization: Bearer <PROOF_SHARE_MARKDOWN_API_KEY> or x-api-key.',
    });
    return null;
  }

  const requiredApiKey = getDirectShareApiKey();
  if (authMode === 'oauth_or_api_key' && requiredApiKey && presented === requiredApiKey) {
    return { authed: true, authMode, actor: 'api-key' };
  }

  if (!presented) {
    return sendOAuthChallenge(req, res, 'missing_token');
  }

  const validated = await validateHostedSessionToken(presented, publicBaseUrl);
  if (validated.ok && validated.principal) {
    return {
      authed: true,
      authMode,
      actor: `oauth:${validated.principal.userId}`,
    };
  }

  return sendOAuthChallenge(req, res, validated.reason || 'invalid_token');
}

function checkDirectShareRateLimit(
  req: Request,
  authed: boolean,
): { allowed: true } | { allowed: false; retryAfterSeconds: number; max: number; windowMs: number } {
  const max = authed
    ? parsePositiveIntEnv('PROOF_SHARE_MARKDOWN_RATE_LIMIT_MAX_AUTH_PER_MIN', DEFAULT_DIRECT_SHARE_RATE_LIMIT_MAX_AUTH_PER_MIN)
    : parsePositiveIntEnv('PROOF_SHARE_MARKDOWN_RATE_LIMIT_MAX_UNAUTH_PER_MIN', DEFAULT_DIRECT_SHARE_RATE_LIMIT_MAX_UNAUTH_PER_MIN);
  const windowMs = parsePositiveIntEnv('PROOF_SHARE_MARKDOWN_RATE_LIMIT_WINDOW_MS', DEFAULT_DIRECT_SHARE_RATE_LIMIT_WINDOW_MS);
  const now = Date.now();
  if (DIRECT_SHARE_RATE_LIMIT_BUCKETS.size > 0) {
    for (const [key, bucket] of DIRECT_SHARE_RATE_LIMIT_BUCKETS.entries()) {
      if (bucket.resetAt <= now) {
        DIRECT_SHARE_RATE_LIMIT_BUCKETS.delete(key);
      }
    }
  }
  if (DIRECT_SHARE_RATE_LIMIT_BUCKETS.size > DIRECT_SHARE_RATE_LIMIT_MAX_BUCKETS) {
    const overflow = DIRECT_SHARE_RATE_LIMIT_BUCKETS.size - DIRECT_SHARE_RATE_LIMIT_MAX_BUCKETS;
    let pruned = 0;
    for (const key of DIRECT_SHARE_RATE_LIMIT_BUCKETS.keys()) {
      DIRECT_SHARE_RATE_LIMIT_BUCKETS.delete(key);
      pruned += 1;
      if (pruned >= overflow) break;
    }
  }
  const bucketKey = `${authed ? 'auth' : 'anon'}:${getClientIp(req)}`;
  const existing = DIRECT_SHARE_RATE_LIMIT_BUCKETS.get(bucketKey);

  if (!existing || existing.resetAt <= now) {
    DIRECT_SHARE_RATE_LIMIT_BUCKETS.set(bucketKey, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }

  if (existing.count >= max) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      max,
      windowMs,
    };
  }

  existing.count += 1;
  return { allowed: true };
}

function getPublicBaseUrl(req: Request): string {
  if (trustProxyHeaders()) {
    const forwardedProtoHeader = req.header('x-forwarded-proto');
    const forwardedHostHeader = req.header('x-forwarded-host');
    const forwardedProto = typeof forwardedProtoHeader === 'string'
      ? forwardedProtoHeader.split(',')[0]?.trim()
      : '';
    const forwardedHost = typeof forwardedHostHeader === 'string'
      ? forwardedHostHeader.split(',')[0]?.trim()
      : '';
    if (forwardedProto && forwardedHost) {
      return `${forwardedProto}://${forwardedHost}`;
    }
  }

  const configuredBase = (process.env.PROOF_PUBLIC_BASE_URL || '').trim();
  if (configuredBase) {
    return configuredBase.replace(/\/+$/, '');
  }

  const host = req.get('host') || '';
  if (!host) return '';
  return `${req.protocol || 'http'}://${host}`;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function resolveRequestScopedCollabWsBase(req: Request): string {
  const collabRuntime = getCollabRuntime();
  const runtimeBase = (collabRuntime.wsUrlBase || '').trim();
  if (!runtimeBase) return runtimeBase;

  const configuredPublicBase = (process.env.COLLAB_PUBLIC_BASE_URL || '').trim();
  if (configuredPublicBase) {
    return configuredPublicBase.replace(/\/+$/, '');
  }

  const embeddedRaw = (process.env.COLLAB_EMBEDDED_WS || '').trim().toLowerCase();
  const embedded = embeddedRaw === '1' || embeddedRaw === 'true' || embeddedRaw === 'yes' || embeddedRaw === 'on';

  const publicBase = getPublicBaseUrl(req);
  if (!publicBase) return runtimeBase;

  try {
    const wsUrl = new URL(runtimeBase);
    if (!isLoopbackHost(wsUrl.hostname)) {
      return runtimeBase;
    }

    const publicUrl = new URL(publicBase);
    wsUrl.protocol = publicUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.hostname = publicUrl.hostname;

    if (embedded) {
      // Embedded mode: WS is multiplexed on the main HTTP port, keep same port.
      wsUrl.port = publicUrl.port;
    } else if (isLoopbackHost(publicUrl.hostname) && publicUrl.port) {
      const appPort = Number.parseInt(publicUrl.port, 10);
      if (!Number.isFinite(appPort) || appPort <= 0) {
        return runtimeBase;
      }
      wsUrl.port = String(appPort + 1);
    } else {
      wsUrl.port = publicUrl.port;
    }
    wsUrl.search = '';
    wsUrl.hash = '';
    return wsUrl.toString().replace(/\/+$/, '');
  } catch {
    return runtimeBase;
  }
}

function buildShareLink(req: Request, slug: string): { url: string; shareUrl: string } {
  const url = `/d/${slug}`;
  const base = getPublicBaseUrl(req);
  return {
    url,
    shareUrl: base ? `${base}${url}` : url,
  };
}

function withShareToken(url: string, token: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

function getExplicitShareSecret(req: Request): string | null {
  const bodySecret = req.body?.ownerSecret;
  if (typeof bodySecret === 'string' && bodySecret.trim()) return bodySecret.trim();

  const shareTokenHeader = req.header('x-share-token');
  if (typeof shareTokenHeader === 'string' && shareTokenHeader.trim()) return shareTokenHeader.trim();

  const bridgeTokenHeader = req.header('x-bridge-token');
  if (typeof bridgeTokenHeader === 'string' && bridgeTokenHeader.trim()) return bridgeTokenHeader.trim();

  const queryToken = req.query.token;
  if (typeof queryToken === 'string' && queryToken.trim()) return queryToken.trim();

  const slugParam = req.params.slug;
  if (typeof slugParam === 'string' && slugParam.trim()) {
    const fromCookie = getCookie(req, shareTokenCookieName(slugParam.trim()));
    if (typeof fromCookie === 'string' && fromCookie.trim()) return fromCookie.trim();
  }

  const authHeader = req.header('authorization');
  if (typeof authHeader === 'string') {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match && match[1]) {
      const token = match[1].trim();
      // Hosted app-session tokens should not be treated as share secrets.
      if (token && !token.startsWith('epsess_')) {
        return token;
      }
    }
  }

  return null;
}

function getPresentedSecret(req: Request): string | null {
  const explicit = getExplicitShareSecret(req);
  if (explicit) return explicit;

  const authHeader = req.header('authorization');
  if (typeof authHeader === 'string') {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match && match[1]) return match[1].trim();
  }

  return null;
}

function getPresentedBearerToken(req: Request): string | null {
  const authHeader = req.header('authorization');
  if (typeof authHeader !== 'string') return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1]) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

function getAccessRole(req: Request, slug: string): ShareRole | null {
  const secret = getPresentedSecret(req);
  if (secret) return resolveDocumentAccessRole(slug, secret);
  // Invite person (2026-09-19): without a share token, library members and people invited to
  // this document edit; everyone else gets the document's guest setting (server/document-team.ts).
  return resolveTokenlessAccess(req, slug).role;
}

function canOwnerMutate(req: Request, doc: { owner_secret: string | null; owner_secret_hash: string | null; owner_id: string | null }): boolean {
  return canMutateByOwnerIdentity(doc, getExplicitShareSecret(req));
}

function isOAuthPrincipalOwner(ownerId: string | null | undefined, oauthUserId: number): boolean {
  if (!ownerId || !ownerId.trim()) return false;
  const normalized = ownerId.trim();
  const asString = String(oauthUserId);
  return normalized === asString
    || normalized === `oauth:${asString}`
    || normalized === `oauth_user:${asString}`;
}

async function ownerAuthorizedViaOAuth(req: Request, ownerId: string | null | undefined): Promise<boolean> {
  const bearerToken = getPresentedBearerToken(req);
  if (!bearerToken) return false;
  const validated = await validateHostedSessionToken(bearerToken, getPublicBaseUrl(req));
  if (!validated.ok || !validated.principal) return false;
  return isOAuthPrincipalOwner(ownerId, validated.principal.userId);
}

type OpenContextAccess = {
  role: ShareRole;
  tokenId: string | null;
  ownerAuthorized: boolean;
};

async function resolveOpenContextAccess(
  req: Request,
  res: Response,
  slug: string,
  doc: { owner_id: string | null; owner_secret: string | null; owner_secret_hash: string | null },
): Promise<OpenContextAccess | null> {
  // Ticket issuance must validate every presented credential, including empty
  // values and credentials shadowed by a higher-priority source. Page navigation
  // deliberately retains its separate query/cookie fallback policy.
  const bearerToken = getPresentedBearerToken(req);
  const ownerByOAuth = await ownerAuthorizedViaOAuth(req, doc.owner_id);
  const credentials = [
    req.body?.ownerSecret,
    req.header('x-share-token'),
    req.header('x-bridge-token'),
    req.query.token,
    ...getCookies(req, shareTokenCookieName(slug)),
    req.header('authorization') === undefined ? undefined : bearerToken ?? '',
  ];
  let resolved: ReturnType<typeof resolveDocumentAccess> = null;
  for (const credential of credentials) {
    if (credential === undefined || credential === null) continue;
    const secret = typeof credential === 'string' ? credential.trim() : '';
    const access = secret ? resolveDocumentAccess(slug, secret) : null;
    if (!access && !(ownerByOAuth && secret === bearerToken)) {
      res.status(401).json({ error: 'Invalid share token', code: 'UNAUTHORIZED' });
      return null;
    }
    resolved ??= access;
  }
  const ownerAuthorized = ownerByOAuth || resolved?.role === 'owner_bot';
  if (ownerAuthorized) {
    return { role: 'owner_bot', tokenId: resolved?.tokenId ?? null, ownerAuthorized: true };
  }
  if (resolved) {
    return { role: resolved.role, tokenId: resolved.tokenId, ownerAuthorized: false };
  }

  // Invite person (2026-09-19): no credential means the tokenless access of server/document-team.ts.
  const tokenless = resolveTokenlessAccess(req, slug);
  if (!tokenless.role) {
    res.status(401).json({ error: 'Sign in to open this document', code: 'SIGN_IN_REQUIRED', signInUrl: isLibraryEnabled() ? '/' : null });
    return null;
  }
  return { role: tokenless.role, tokenId: tokenless.collabTokenId, ownerAuthorized: false };
}

function deriveShareCapabilities(role: ShareRole, shareState: string): {
  canRead: boolean;
  canComment: boolean;
  canEdit: boolean;
} {
  const isOwner = role === 'owner_bot';
  // Product decision: non-owners cannot access paused/revoked shares at all.
  const canRead = shareState === 'ACTIVE' || (isOwner && shareState !== 'DELETED');
  const canEdit = isOwner
    ? (shareState === 'ACTIVE' || shareState === 'PAUSED')
    : (role === 'editor' && shareState === 'ACTIVE');
  const canComment = shareState === 'ACTIVE'
    && (role === 'commenter' || role === 'editor' || isOwner);
  return {
    canRead,
    canComment,
    canEdit,
  };
}

// Create a shared document
apiRoutes.post('/documents', async (req: Request, res: Response) => {
  const legacyPathRequest = isLegacyCreatePathRequest(req);
  const legacyCreateMode = resolveLegacyCreateMode(getPublicBaseUrl(req));
  if (legacyPathRequest) {
    if (legacyCreateMode === 'disabled') {
      recordLegacyCreateRouteTelemetry(req, legacyCreateMode, 'blocked_disabled');
      applyLegacyCreateHeaders(res, legacyCreateMode);
      res.status(410).json(buildLegacyCreateDisabledPayload());
      return;
    }
    if (legacyCreateMode === 'warn') {
      recordLegacyCreateRouteTelemetry(req, legacyCreateMode, 'allowed_warn');
      applyLegacyCreateHeaders(res, legacyCreateMode);
    } else {
      recordLegacyCreateRouteTelemetry(req, legacyCreateMode, 'allowed');
    }
  }

  let directShareAuth: DirectShareAuthorizationResult = {
    authed: false,
    authMode: 'none',
    actor: 'anonymous',
  };
  if (!legacyPathRequest) {
    const auth = await authorizeDirectShareRequest(req, res);
    if (!auth) return;
    directShareAuth = auth;

    const rateLimit = checkDirectShareRateLimit(req, auth.authed);
    if (!rateLimit.allowed) {
      res.setHeader('retry-after', String(rateLimit.retryAfterSeconds));
      res.status(429).json({
        error: 'Rate limit exceeded for direct share creation',
        code: 'RATE_LIMITED',
        retryAfterSeconds: rateLimit.retryAfterSeconds,
        maxPerWindow: rateLimit.max,
        windowMs: rateLimit.windowMs,
      });
      return;
    }
  }

  const { markdown, marks, title, ownerId } = req.body;

  if (typeof markdown !== 'string') {
    res.status(400).json({
      error: 'markdown field is required',
      code: 'MISSING_MARKDOWN',
      fix: '{"markdown":"# Title\\n\\nHello"}',
    });
    return;
  }
  const sanitizedMarkdown = stripEphemeralCollabSpans(markdown);
  if (isBlankMarkdown(sanitizedMarkdown)) {
    res.status(400).json({
      error: 'markdown must not be empty',
      code: 'EMPTY_MARKDOWN',
      fix: '{"markdown":"# Title\\n\\nHello"}',
    });
    return;
  }
  if (marks !== undefined && !isMarksPayload(marks)) {
    res.status(400).json({ error: 'marks must be an object when provided', code: 'INVALID_MARKS' });
    return;
  }

  const slug = generateSlug();
  const ownerSecret = randomUUID();
  const normalizedMarks = canonicalizeStoredMarks(marks ?? {});
  // Store canonical markdown in the collab fragment's serialization so the
  // projection derived on first load matches byte-for-byte. Without this, docs
  // containing GFM tables wedge on `readSource=yjs_fallback` / `mutationReady=false`
  // because the fragment re-serializes tables (column padding + `:---` markers).
  const canonicalMarkdown = await deriveCanonicalMarkdownForStorage(sanitizedMarkdown);
  const doc = createDocument(slug, canonicalMarkdown, normalizedMarks, title, ownerId, ownerSecret);
  const defaultAccess = createDocumentAccessToken(slug, 'editor');
  const links = buildShareLink(req, doc.slug);
  const shareUrlWithToken = withShareToken(links.shareUrl, defaultAccess.secret);
  const urlWithToken = withShareToken(links.url, defaultAccess.secret);
  refreshSnapshotForSlug(slug);

  addEvent(slug, 'document.created', {
    title,
    ownerId,
    shareState: doc.share_state,
  }, ownerId || 'anonymous');
  captureDocumentCreatedTelemetry({
    slug: doc.slug,
    source: 'api.documents',
    ownerId,
    title,
    shareState: doc.share_state,
    accessRole: defaultAccess.role,
    authMode: directShareAuth.authMode,
    authenticated: directShareAuth.authed,
    contentChars: sanitizedMarkdown.length,
  });

  res.json({
    success: true,
    slug: doc.slug,
    docId: doc.doc_id,
    // Canonical share links are clean; tokenized links are kept for compatibility/debugging.
    url: links.url,
    shareUrl: links.shareUrl,
    tokenPath: urlWithToken,
    tokenUrl: shareUrlWithToken,
    viewUrl: links.shareUrl,
    viewPath: links.url,
    ownerSecret,
    accessToken: defaultAccess.secret,
    accessRole: defaultAccess.role,
    active: true,
    shareState: doc.share_state,
    snapshotUrl: getSnapshotPublicUrl(doc.slug),
    createdAt: doc.created_at,
    _links: {
      view: links.url,
      web: links.shareUrl,
      tokenUrl: shareUrlWithToken,
      ...buildProofSdkLinks(doc.slug, {
        includeMutationRoutes: true,
        includeBridgeRoutes: true,
      }),
    },
    agent: buildProofSdkAgentDescriptor(doc.slug, {
      includeMutationRoutes: true,
      includeBridgeRoutes: true,
    }),
    ...(legacyPathRequest && legacyCreateMode === 'warn'
      ? { deprecation: buildLegacyCreateDeprecationPayload(legacyCreateMode) }
      : {}),
  });
});

apiRoutes.post('/documents/:slug/access-links', async (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }
  const doc = getCanonicalReadableDocumentSync(slug, 'share') ?? getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (doc.share_state === 'DELETED') {
    res.status(410).json({ error: 'Document deleted' });
    return;
  }

  const ownerAuthorized = canOwnerMutate(req, doc) || await ownerAuthorizedViaOAuth(req, doc.owner_id);
  const secret = getPresentedSecret(req);
  const role = secret ? resolveDocumentAccessRole(slug, secret) : null;
  const canCreateAccessLinks = ownerAuthorized || role === 'editor' || role === 'owner_bot';
  if (!canCreateAccessLinks) {
    res.status(403).json({ error: 'Not authorized to create access links' });
    return;
  }

  const requestedRole = req.body?.role;
  if (!isShareRole(requestedRole) || requestedRole === 'owner_bot') {
    res.status(400).json({ error: 'role must be viewer, commenter, or editor' });
    return;
  }

  const created = createDocumentAccessToken(slug, requestedRole);
  const links = buildShareLink(req, slug);
  const separator = links.shareUrl.includes('?') ? '&' : '?';
  const webShareUrl = `${links.shareUrl}${separator}token=${encodeURIComponent(created.secret)}`;

  res.json({
    success: true,
    slug,
    role: created.role,
    tokenId: created.tokenId,
    accessToken: created.secret,
    token: created.secret,
    webShareUrl,
    createdAt: created.createdAt,
  });
});

apiRoutes.post('/auth/start', (req: Request, res: Response) => {
  const started = startOAuthFlow(getPublicBaseUrl(req));
  if (!started.ok) {
    res.status(503).json(buildOAuthNotConfiguredPayload(started.error));
    return;
  }
  res.json({
    success: true,
    provider: 'oauth',
    ...started,
  });
});

function handleOAuthPoll(req: Request, res: Response): void {
  const requestIdParam = req.params.requestId;
  const requestId = Array.isArray(requestIdParam) ? requestIdParam[0] : requestIdParam;
  if (!requestId || !requestId.trim()) {
    res.status(400).json({ error: 'Missing requestId', code: 'BAD_REQUEST' });
    return;
  }

  const queryToken = typeof req.query.pollToken === 'string' ? req.query.pollToken.trim() : '';
  const headerToken = typeof req.header('x-auth-poll-token') === 'string'
    ? req.header('x-auth-poll-token')!.trim()
    : '';
  const pollToken = queryToken || headerToken;
  if (!pollToken) {
    res.status(400).json({ error: 'Missing poll token', code: 'MISSING_POLL_TOKEN' });
    return;
  }

  const polled = pollOAuthFlow(requestId, pollToken);
  if (!polled) {
    res.status(404).json({ error: 'Auth request not found or expired', code: 'AUTH_REQUEST_NOT_FOUND' });
    return;
  }
  if (polled.status === 'failed' && polled.error === 'Invalid poll token') {
    res.status(401).json({ error: 'Invalid poll token', code: 'UNAUTHORIZED' });
    return;
  }
  res.json({ success: polled.status === 'completed', ...polled });
}

apiRoutes.get('/auth/poll/:requestId', handleOAuthPoll);

apiRoutes.get('/auth/callback', async (req: Request, res: Response) => {
  const state = typeof req.query.state === 'string' ? req.query.state.trim() : '';
  const code = typeof req.query.code === 'string' ? req.query.code.trim() : '';
  const error = typeof req.query.error === 'string' ? req.query.error.trim() : '';
  if (!state) {
    res.status(400).type('html').send('<html><body><h1>Sign-in failed</h1><p>Missing OAuth state.</p></body></html>');
    return;
  }

  const result = await handleOAuthCallback({
    state,
    code: code || undefined,
    error: error || undefined,
    publicBaseUrl: getPublicBaseUrl(req),
  });
  const status = result.ok ? 200 : 400;
  const title = result.ok ? 'Sign-in complete' : 'Sign-in failed';
  const body = result.ok
    ? '<p>You can close this tab and return to your agent.</p>'
    : '<p>Please return to your agent and retry sign-in.</p>';
  res.status(status).type('html').send(`<!doctype html><html><body><h1>${title}</h1><p>${result.message}</p>${body}</body></html>`);
});

apiRoutes.post('/auth/logout', (req: Request, res: Response) => {
  const token = getDirectSharePresentedToken(req);
  if (!token) {
    res.status(400).json({ error: 'Missing session token', code: 'MISSING_TOKEN' });
    return;
  }
  const revoked = revokeHostedSessionToken(token);
  res.json({ success: revoked });
});

// Agent-friendly endpoint: send markdown directly and get a share link back.
apiRoutes.post(
  '/share/markdown',
  shareMarkdownBodyParser,
  handleShareMarkdown,
);

export async function createProofDocument(input: {
  markdown: string;
  marks?: Record<string, unknown>;
  title?: string;
  ownerId?: string;
  accessRole?: ShareRole;
  source: string;
  actor: string;
  authMode?: string;
  authenticated?: boolean;
}): Promise<{
  doc: ReturnType<typeof createDocument>;
  access: ReturnType<typeof createDocumentAccessToken>;
  ownerSecret: string;
  sanitizedMarkdown: string;
}> {
  const sanitizedMarkdown = stripEphemeralCollabSpans(input.markdown);
  const canonicalMarkdown = await deriveCanonicalMarkdownForStorage(sanitizedMarkdown);
  const marks = canonicalizeStoredMarks(input.marks ?? {});
  const slug = generateSlug();
  const ownerSecret = randomUUID();
  const doc = createDocument(
    slug,
    canonicalMarkdown,
    marks,
    input.title,
    input.ownerId,
    ownerSecret,
  );
  const access = createDocumentAccessToken(slug, input.accessRole ?? 'editor');
  refreshSnapshotForSlug(slug);
  addEvent(slug, 'document.created', {
    title: input.title,
    ownerId: input.ownerId,
    shareState: doc.share_state,
    source: input.source,
    accessRole: access.role,
    authMode: input.authMode ?? 'library_session',
    authenticated: input.authenticated ?? true,
  }, input.actor);
  captureDocumentCreatedTelemetry({
    slug: doc.slug,
    source: input.source,
    ownerId: input.ownerId,
    title: input.title,
    shareState: doc.share_state,
    accessRole: access.role,
    authMode: input.authMode ?? 'library_session',
    authenticated: input.authenticated ?? true,
    contentChars: sanitizedMarkdown.length,
  });
  return { doc, access, ownerSecret, sanitizedMarkdown };
}

/** Import format for /share/markdown: explicit, or the dialect when a "proof:" front matter block is present. */
function resolveImportFormat(raw: unknown, markdown: string): 'proof-dialect' | 'criticmarkup' | 'auto' | null {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  // Naming tail: "accord-dialect" / "accord" are aliases (FORMAT_ALIASES in server/proof-dialect.ts).
  if (value === 'proof-dialect' || value === 'proof' || value === 'dialect' || value === 'accord-dialect' || value === 'accord') return 'proof-dialect';
  if (value === 'criticmarkup' || value === 'critic') return 'criticmarkup';
  if (value === 'auto') return 'auto';
  if (value === 'markdown' || value === 'plain') return null;
  return /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?proof:/.test(markdown) ? 'proof-dialect' : null;
}

/**
 * Who an import may write marks as (IMPORT_POLICY in server/proof-dialect.ts): the direct-share API
 * key is the operator credential (anyone in the file's handle table); a signed-in library member
 * is only themselves; anyone else only "guest:importer".
 */
function importAuthorityFor(req: Request, authActor: string, by: unknown): ImportAuthority {
  const apiKey = getDirectShareApiKey();
  const presentedKey = getDirectSharePresentedToken(req);
  if (authActor === 'api-key' || (apiKey && presentedKey === apiKey)) {
    return { kind: 'operator', actor: typeof by === 'string' && /^(ai|human|guest):/.test(by) ? by : null };
  }
  try {
    const session = isLibraryEnabled() ? getLibrarySession(req) : null;
    const email = session?.member.email;
    if (email && isEmailForImport(email)) return { kind: 'session', actor: verifiedHumanForImport(email) };
  } catch {
    // no library
  }
  return { kind: 'anonymous' };
}

export async function handleShareMarkdown(req: Request, res: Response): Promise<void> {
  const auth = await authorizeDirectShareRequest(req, res);
  if (!auth) return;

  const rateLimit = checkDirectShareRateLimit(req, auth.authed);
  if (!rateLimit.allowed) {
    res.setHeader('retry-after', String(rateLimit.retryAfterSeconds));
    res.status(429).json({
      error: 'Rate limit exceeded for direct share creation',
      code: 'RATE_LIMITED',
      retryAfterSeconds: rateLimit.retryAfterSeconds,
      maxPerWindow: rateLimit.max,
      windowMs: rateLimit.windowMs,
    });
    return;
  }

  const isRawTextBody = typeof req.body === 'string';
  const body = (isRawTextBody ? null : req.body) as Record<string, unknown> | null;

  const markdownCandidate = isRawTextBody
    ? req.body
    : (body?.markdown ?? body?.content);
  const markdown = typeof markdownCandidate === 'string' ? markdownCandidate : '';
  const sanitizedMarkdown = stripEphemeralCollabSpans(markdown);
  if (!sanitizedMarkdown.trim()) {
    res.status(400).json({
      error: 'markdown field is required',
      code: 'MISSING_MARKDOWN',
      fix: '{"markdown":"# Title\\n\\nHello"}',
      hint: 'Send JSON { \"markdown\": \"...\" } or send the raw markdown body as text/plain.',
    });
    return;
  }

  const marksCandidate = body?.marks;
  if (marksCandidate !== undefined && !isMarksPayload(marksCandidate)) {
    res.status(400).json({ error: 'marks must be an object when provided', code: 'INVALID_MARKS' });
    return;
  }
  const marks = canonicalizeStoredMarks(isMarksPayload(marksCandidate) ? marksCandidate : {});

  const titleFromQuery = typeof req.query.title === 'string' ? req.query.title : undefined;
  const title = typeof body?.title === 'string'
    ? body.title
    : titleFromQuery;
  const ownerIdFromQuery = typeof req.query.ownerId === 'string' ? req.query.ownerId : undefined;
  const ownerId = typeof body?.ownerId === 'string' ? body.ownerId : ownerIdFromQuery;

  const roleFromBody = body?.accessRole ?? body?.defaultRole ?? body?.role;
  const roleFromQuery = typeof req.query.role === 'string' ? req.query.role : undefined;
  const requestedRole = roleFromBody ?? roleFromQuery ?? 'editor';
  if (!isShareRole(requestedRole) || requestedRole === 'owner_bot') {
    res.status(400).json({ error: 'role must be viewer, commenter, or editor', code: 'INVALID_ROLE' });
    return;
  }

  const source = req.path === '/share/markdown' ? 'share.markdown' : 'api.share.markdown';
  // Proof dialect / CriticMarkup import (2026-09-19): with format=proof-dialect | criticmarkup |
  // auto, or when the text carries a "proof:" front matter block, the marks become real marks.
  const importFormat = resolveImportFormat(body?.format ?? req.query.format, sanitizedMarkdown);
  if (importFormat && Buffer.byteLength(sanitizedMarkdown, 'utf8') > IMPORT_POLICY.maxBytes) {
    res.status(413).json({ error: 'Import is too large', code: 'IMPORT_TOO_LARGE' });
    return;
  }
  const parsedImport = importFormat ? parseImport(sanitizedMarkdown, importFormat) : null;
  const importTitle = parsedImport && typeof parsedImport.parsed.frontMatter.proof?.title === 'string' ? parsedImport.parsed.frontMatter.proof.title as string : undefined;
  const { doc, access, ownerSecret } = await createProofDocument({
    markdown: parsedImport ? parsedImport.markdown : sanitizedMarkdown,
    marks: parsedImport ? {} : marks,
    title: title ?? importTitle,
    ownerId,
    accessRole: requestedRole,
    source,
    actor: ownerId || auth.actor,
    authMode: auth.authMode,
    authenticated: auth.authed,
  });
  let importSummary: ImportSummary | null = null;
  if (parsedImport) {
    importSummary = await applyImportedMarks(doc.slug, {
      parsed: parsedImport.parsed,
      format: parsedImport.format,
      authority: importAuthorityFor(req, auth.actor, body?.by),
    });
  }
  const links = buildShareLink(req, doc.slug);
  const shareUrlWithToken = withShareToken(links.shareUrl, access.secret);
  const urlWithToken = withShareToken(links.url, access.secret);
  const proofSdkPaths = buildProofSdkDocumentPaths(doc.slug);

  res.json({
    success: true,
    slug: doc.slug,
    docId: doc.doc_id,
    url: links.url,
    shareUrl: links.shareUrl,
    tokenPath: urlWithToken,
    tokenUrl: shareUrlWithToken,
    viewUrl: links.shareUrl,
    viewPath: links.url,
    ownerSecret,
    accessToken: access.secret,
    accessRole: access.role,
    active: true,
    shareState: doc.share_state,
    snapshotUrl: getSnapshotPublicUrl(doc.slug),
    createdAt: doc.created_at,
    ...(importSummary ? { import: importSummary } : {}),
    _links: {
      view: links.url,
      web: links.shareUrl,
      tokenUrl: shareUrlWithToken,
      ...buildProofSdkLinks(doc.slug, {
        includeMutationRoutes: true,
        includeBridgeRoutes: true,
      }),
      comment: {
        method: 'POST',
        href: proofSdkPaths.bridgeComments,
        body: { quote: '...', text: '...', by: 'ai:your-agent' },
      },
      suggest: {
        method: 'POST',
        href: proofSdkPaths.bridgeSuggestions,
        body: { kind: 'replace', quote: '...', content: '...', by: 'ai:your-agent' },
      },
      rewrite: {
        method: 'POST',
        href: proofSdkPaths.bridgeRewrite,
        body: { content: '# New draft...', by: 'ai:your-agent' },
      },
    },
    agent: buildProofSdkAgentDescriptor(doc.slug, {
      includeMutationRoutes: true,
      includeBridgeRoutes: true,
    }),
  });
}

// Get a shared document
apiRoutes.get('/documents/:slug', (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }

  const doc = getCanonicalReadableDocumentSync(slug, 'share') ?? getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  const ownerOverride = canOwnerMutate(req, doc);
  if (doc.share_state === 'DELETED') {
    res.status(410).json({ error: 'Document deleted' });
    return;
  }
  if (doc.share_state === 'REVOKED' && !ownerOverride) {
    res.status(403).json({ error: 'Document access has been revoked' });
    return;
  }
  if (doc.share_state === 'PAUSED' && !ownerOverride) {
    res.status(403).json({ error: 'Document is not currently accessible' });
    return;
  }
  if (!ownerOverride && !getPresentedSecret(req) && resolveTokenlessAccess(req, slug).role === null) {
    res.status(401).json({ error: 'Sign in to open this document', code: 'SIGN_IN_REQUIRED' });
    return;
  }

  res.json({
    slug: doc.slug,
    docId: doc.doc_id,
    title: doc.title,
    markdown: doc.markdown,
    marks: parseJson(doc.marks),
    // Legacy compatibility for <=0.28 clients.
    active: doc.share_state === 'ACTIVE',
    shareState: doc.share_state,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
    viewers: getRoomSize(doc.slug),
    _links: buildProofSdkLinks(doc.slug, {
      includeMutationRoutes: true,
      includeSnapshotRoute: true,
      includeEditV2Route: true,
      includeBridgeRoutes: true,
    }),
    agent: buildProofSdkAgentDescriptor(doc.slug, {
      includeMutationRoutes: true,
      includeSnapshotRoute: true,
      includeEditV2Route: true,
      includeBridgeRoutes: true,
    }),
  });
});

// Update document title metadata.
apiRoutes.put('/documents/:slug/title', (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }

  const doc = getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (doc.share_state === 'DELETED') {
    res.status(410).json({ error: 'Document deleted' });
    return;
  }
  if (doc.share_state === 'REVOKED') {
    res.status(403).json({ error: 'Document access has been revoked' });
    return;
  }

  const body = isRecord(req.body) ? req.body : {};
  const title = body.title;
  const actor = typeof body.actor === 'string' ? body.actor : undefined;
  const clientId = typeof body.clientId === 'string' ? body.clientId : undefined;
  if (title !== null && typeof title !== 'string') {
    res.status(400).json({ error: 'title must be a string or null when provided' });
    return;
  }

  const accessRole = getAccessRole(req, slug);
  const ownerAuthorized = canOwnerMutate(req, doc);
  const ownerOrBot = ownerAuthorized || accessRole === 'owner_bot';
  const canEditTitle = ownerOrBot || (doc.share_state === 'ACTIVE' && accessRole === 'editor');

  if (doc.share_state === 'PAUSED' && !ownerOrBot) {
    res.status(403).json({ error: 'Document is paused' });
    return;
  }
  if (!canEditTitle) {
    res.status(403).json({ error: 'Not authorized to update document title' });
    return;
  }

  const normalizedTitle = typeof title === 'string' ? title.trim() : '';
  const canonicalTitle = normalizedTitle.length > 0 ? normalizedTitle : null;
  const writeSucceeded = updateDocumentTitle(slug, canonicalTitle);
  if (!writeSucceeded) {
    res.status(409).json({ error: 'Document changed during update; retry with latest state', code: 'STALE_BASE' });
    return;
  }

  const updatedDoc = getDocumentBySlug(slug);
  if (!updatedDoc) {
    res.status(500).json({ error: 'Document title updated but document could not be reloaded' });
    return;
  }

  broadcastToRoom(slug, {
    type: 'document.title.updated',
    title: updatedDoc.title,
    updatedAt: updatedDoc.updated_at,
    actor: actor || 'anonymous',
  }, clientId);
  addEvent(slug, 'document.title.updated', { actor }, actor || 'anonymous');

  refreshSnapshotForSlug(slug);

  res.json({
    success: true,
    title: updatedDoc.title,
    updatedAt: updatedDoc.updated_at,
  });
});

// Update document content + marks (from native app owner or web viewer)
apiRoutes.put('/documents/:slug', async (req: Request, res: Response) => {
  const { markdown, marks, title, actor, clientId, ownerSecret, ownerId } = req.body;
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }

  const doc = getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (doc.share_state === 'DELETED') {
    res.status(410).json({ error: 'Document deleted' });
    return;
  }
  if (doc.share_state === 'REVOKED') {
    res.status(403).json({ error: 'Document access has been revoked' });
    return;
  }

  const hasMarkdownUpdate = markdown !== undefined;
  const hasMarksUpdate = marks !== undefined;
  const hasTitleUpdate = title !== undefined;
  const mutationActor = (typeof actor === 'string' && actor.trim()) ? actor.trim() : 'anonymous';
  const previousMarks = hasMarksUpdate ? parseJson(doc.marks) : null;
  const accessRole = getAccessRole(req, slug);
  const ownerAuthorized = canOwnerMutate(req, doc);
  const ownerOrBot = ownerAuthorized || accessRole === 'owner_bot';
  const canEditContent = ownerOrBot || (doc.share_state === 'ACTIVE' && accessRole === 'editor');
  const canMutateMarks = ownerOrBot
    || (doc.share_state === 'ACTIVE' && (accessRole === 'commenter' || accessRole === 'editor'));
  const normalizedTitle = hasTitleUpdate && typeof title === 'string' ? title.trim() : '';

  if (hasMarkdownUpdate && typeof markdown !== 'string') {
    res.status(400).json({ error: 'markdown must be a string when provided' });
    return;
  }
  const sanitizedMarkdown = hasMarkdownUpdate ? stripEphemeralCollabSpans(markdown as string) : '';
  if (hasMarkdownUpdate && isBlankMarkdown(sanitizedMarkdown)) {
    res.status(400).json({ error: 'markdown must not be empty', code: 'EMPTY_MARKDOWN' });
    return;
  }
  if (hasMarksUpdate && !isMarksPayload(marks)) {
    res.status(400).json({ error: 'marks must be an object when provided' });
    return;
  }
  const normalizedMarks = hasMarksUpdate ? canonicalizeStoredMarks(marks as Record<string, unknown>) : undefined;
  if (hasTitleUpdate && typeof title !== 'string') {
    res.status(400).json({ error: 'title must be a string when provided' });
    return;
  }
  if (hasTitleUpdate && normalizedTitle.length === 0) {
    res.status(400).json({ error: 'title must not be empty', code: 'EMPTY_TITLE' });
    return;
  }

  if (doc.share_state === 'PAUSED' && !ownerOrBot) {
    res.status(403).json({ error: 'Document is paused' });
    return;
  }

  if (hasMarkdownUpdate && !canEditContent) {
    res.status(403).json({ error: 'Not authorized to update document content' });
    return;
  }
  if (hasMarksUpdate && !canMutateMarks) {
    res.status(403).json({ error: 'Not authorized to update document marks' });
    return;
  }
  if (hasTitleUpdate && !canEditContent) {
    res.status(403).json({ error: 'Not authorized to update document title' });
    return;
  }

  if (hasMarkdownUpdate) {
    const barrierStartedAt = Date.now();
    try {
      await prepareRewriteCollabBarrier(slug);
      recordRewriteBarrierLatency('PUT /documents/:slug', Date.now() - barrierStartedAt);
    } catch (error) {
      const reason = classifyRewriteBarrierFailureReason(error);
      recordRewriteBarrierFailure('PUT /documents/:slug', reason);
      recordRewriteBarrierLatency('PUT /documents/:slug', Date.now() - barrierStartedAt);
      res.status(503).json(rewriteBarrierFailedResponseBody(slug, reason));
      return;
    }
  }

  const currentDoc = hasMarkdownUpdate ? (getDocumentBySlug(slug) ?? doc) : doc;
  let didUpdate = false;
  let writeSucceeded = true;
  let updatedDoc = currentDoc;
  let collabSyncFailed = false;
  let marksHandledDuringUpdate = false;
  if (hasMarkdownUpdate) {
    didUpdate = true;
    const mutation = await mutateCanonicalDocument({
      slug,
      nextMarkdown: sanitizedMarkdown,
      nextMarks: hasMarksUpdate
        ? (normalizedMarks ?? {})
        : canonicalizeStoredMarks(parseJson(currentDoc.marks) as Record<string, unknown>),
      source: 'rest-put',
      baseUpdatedAt: currentDoc.updated_at,
      strictLiveDoc: false,
      guardPathologicalGrowth: true,
    });
    if (!mutation.ok) {
      res.status(mutation.status).json({
        error: mutation.error,
        code: mutation.code,
        ...(mutation.retryWithState ? { retryWithState: mutation.retryWithState } : {}),
      });
      return;
    }
    updatedDoc = mutation.document;
  } else if (hasMarksUpdate) {
    didUpdate = true;
    const previousCanonicalMarks = canonicalizeStoredMarks(parseJson(currentDoc.marks) as Record<string, unknown>);
    writeSucceeded = updateMarks(slug, normalizedMarks ?? {});
    if (writeSucceeded) {
      marksHandledDuringUpdate = true;
      const collabClientBreakdown = getActiveCollabClientBreakdown(slug);
      const preserveLiveRoomOnMarksFallback = collabClientBreakdown.anyEpochCount > 0;
      let syncResult: { applied: boolean; reason?: string } | null = null;
      try {
        syncResult = await syncCanonicalDocumentStateToCollab(slug, {
          marks: normalizedMarks ?? {},
          source: 'rest-put',
        });
      } catch (error) {
        console.error('[routes] Failed to sync marks-only write into collab runtime:', { slug, error });
      }

      if (!syncResult?.applied) {
        const liveRoomAlreadyHasRequestedMarks = loadedCollabMarksMatch(slug, normalizedMarks ?? {});
        const preservedAuthoritativeMarks = syncResult?.reason === 'fragment_unhealthy_marks_only'
          ? await preserveMarksOnlyWriteIfAuthoritativeYjsMatches(slug, normalizedMarks ?? {})
          : false;
        if (preservedAuthoritativeMarks) {
          refreshLoadedCollabMetaFromDb(slug);
        } else {
          if (
            preserveLiveRoomOnMarksFallback
            && syncResult?.reason === 'fragment_unhealthy_marks_only'
            && !liveRoomAlreadyHasRequestedMarks
          ) {
            console.error('[routes] Refused marks-only canonical sync without matching live-authoritative marks', {
              slug,
              reason: syncResult.reason,
            });
          }
          const rolledBack = updateMarks(slug, previousCanonicalMarks);
          if (!rolledBack) {
            console.error('[routes] Failed to roll back marks-only write after collab sync failure', { slug });
          }
          try {
            await invalidateCollabDocumentAndWait(slug);
          } catch (error) {
            console.error('[routes] Failed to fully invalidate collab state after marks-only sync failure', { slug, error });
          }
          collabSyncFailed = true;
          writeSucceeded = false;
        }
      }
    }
  }
  if (hasTitleUpdate) {
    didUpdate = true;
    writeSucceeded = writeSucceeded && updateDocumentTitle(slug, normalizedTitle);
  }
  if (!didUpdate) {
    res.status(400).json({ error: 'Provide title, marks, and/or markdown' });
    return;
  }
  if (!writeSucceeded) {
    if (collabSyncFailed) {
      res.status(503).json({
        error: 'Failed to synchronize marks with collab state; retry with latest state',
        code: 'COLLAB_SYNC_FAILED',
      });
      return;
    }
    res.status(409).json({ error: 'Document changed during update; retry with latest state', code: 'STALE_BASE' });
    return;
  }

  const reloadedDoc = getDocumentBySlug(slug);
  if (!reloadedDoc) {
    res.status(500).json({ error: 'Document update persisted but document could not be reloaded' });
    return;
  }
  updatedDoc = reloadedDoc;
  const integrity = summarizeDocumentIntegrity(updatedDoc.markdown);
  if (hasMarkdownUpdate) {
    try {
      await rebuildDocumentBlocks(updatedDoc, updatedDoc.markdown, updatedDoc.revision);
    } catch (error) {
      console.error('[routes] Failed to rebuild block index after document update:', { slug, error });
    }
  }
  // Only include fields that were actually updated in the broadcast.
  // This allows receivers to distinguish marks-only updates from full content updates,
  // avoiding unnecessary full document reloads (which reset cursor position).
  const payload: Record<string, unknown> = {
    type: 'document.updated',
    updatedAt: updatedDoc.updated_at,
    actor: mutationActor,
    integrity: {
      revision: updatedDoc.revision,
      ...integrity,
    },
  };
  if (hasMarkdownUpdate) {
    payload.markdown = updatedDoc.markdown;
  }
  if (hasMarksUpdate) {
    payload.marks = parseJson(updatedDoc.marks);
  }
  if (hasTitleUpdate) {
    payload.title = updatedDoc.title;
  }
  payload.shareState = updatedDoc.share_state;

  if (!hasMarkdownUpdate && !marksHandledDuringUpdate) {
    // Marks-only updates still need explicit Yjs synchronization.
    try {
      const collabRuntime = getCollabRuntime();
      if (collabRuntime.enabled && hasMarksUpdate) {
        await applyCanonicalDocumentToCollab(slug, {
          marks: parseJson(updatedDoc.marks),
          source: 'rest-put',
        });
      } else if (hasMarksUpdate) {
        invalidateCollabDocument(slug);
      }
    } catch (error) {
      console.error('[routes] Failed to apply external write into collab runtime:', { slug, error });
      invalidateCollabDocument(slug);
    }
  }

  // Broadcast only after collab propagation attempt so listeners don't race stale runtime state.
  const commentEvents = (hasMarksUpdate && previousMarks)
    ? collectCommentEventsFromMarksDiff(previousMarks, parseJson(updatedDoc.marks), mutationActor)
    : [];
  broadcastToRoom(slug, payload, clientId);
  for (const event of commentEvents) {
    addDocumentEvent(slug, event.type, event.data, event.actor);
  }
  addEvent(slug, 'document.updated', {
    actor: mutationActor,
    source: 'rest-put',
    integrity: {
      revision: updatedDoc.revision,
      ...integrity,
    },
  }, mutationActor);
  if (integrity.repeatedHeadings.length > 0) {
    console.warn('[document.updated.integrity_warning]', {
      slug,
      actor: mutationActor,
      revision: updatedDoc.revision,
      ...integrity,
    });
  }

  refreshSnapshotForSlug(slug);

  res.json({
    success: true,
    shareState: updatedDoc.share_state,
    snapshotUrl: updatedDoc.share_state === 'ACTIVE' ? getSnapshotPublicUrl(updatedDoc.slug) : null,
    updatedAt: updatedDoc.updated_at,
    _links: buildProofSdkLinks(updatedDoc.slug, {
      includeMutationRoutes: true,
      includeSnapshotRoute: true,
      includeEditV2Route: true,
      includeBridgeRoutes: true,
    }),
    agent: buildProofSdkAgentDescriptor(updatedDoc.slug, {
      includeMutationRoutes: true,
      includeSnapshotRoute: true,
      includeEditV2Route: true,
      includeBridgeRoutes: true,
    }),
  });
});

// Canonical operations endpoint for comments/suggestions/rewrite.
apiRoutes.post('/documents/:slug/ops', opsRateLimiter, async (req: Request, res: Response) => {
  const mutationRoute = 'POST /documents/:slug/ops';
  const slug = getSlugParam(req);
  if (!slug) {
    sendMutationResponse(res, 400, { error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }

  const rawBody = isRecord(req.body) ? req.body : {};
  const parsed = parseDocumentOpRequest(req.body);
  if ('error' in parsed) {
    sendMutationResponse(res, 400, { error: parsed.error }, { route: mutationRoute, slug });
    return;
  }
  const { op, payload } = parsed;
  const participation = maybeBuildAgentParticipation(req, { ...rawBody, ...payload });
  const stage = getMutationContractStage();
  const idempotencyKey = getIdempotencyKey(req);
  const requestHash = hashRequestBody(req.body);
  const routeKey = `${mutationRoute}:${op}`;

  if (isIdempotencyRequired(stage) && !idempotencyKey) {
    sendMutationResponse(res, 409, {
      success: false,
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      error: 'Idempotency-Key header is required for mutation requests in this stage',
    }, { route: mutationRoute, slug });
    return;
  }
  const doc = getDocumentBySlug(slug);
  if (!doc) {
    sendMutationResponse(res, 404, { error: 'Document not found' }, { route: mutationRoute, slug });
    return;
  }

  const accessRole = getAccessRole(req, slug);
  const ownerAuthorized = canOwnerMutate(req, doc);
  const denied = authorizeDocumentOp(op, accessRole, ownerAuthorized, doc.share_state);
  if (denied) {
    const status = denied.includes('revoked') ? 403 : denied.includes('deleted') ? 410 : 403;
    sendMutationResponse(res, status, { success: false, error: denied }, { route: mutationRoute, slug });
    return;
  }

  if (idempotencyKey) {
    const existing = getStoredIdempotencyRecord(slug, routeKey, idempotencyKey);
    if (existing) {
      if (existing.requestHash && existing.requestHash !== requestHash) {
        sendMutationResponse(res, 409, {
          success: false,
          code: 'IDEMPOTENCY_KEY_REUSED',
          error: 'Idempotency key cannot be reused with a different payload',
        }, { route: mutationRoute, slug });
        return;
      }
      sendMutationResponse(res, 200, existing.response, { route: mutationRoute, slug });
      return;
    }
  }

  const opPrecondition = validateOpPrecondition(stage, op, doc, payload);
  if (!opPrecondition.ok) {
    sendMutationResponse(res, 409, {
      success: false,
      code: opPrecondition.code,
      error: opPrecondition.error,
      latestUpdatedAt: doc.updated_at,
      latestRevision: doc.revision,
      retryWithState: `/api/agent/${slug}/state`,
    }, { route: mutationRoute, slug, retryWithState: `/api/agent/${slug}/state` });
    return;
  }

  const opRoute = resolveDocumentOpRoute(op, payload);
  if (!opRoute) {
    sendMutationResponse(res, 400, { success: false, error: 'Unsupported operation payload' }, { route: mutationRoute, slug });
    return;
  }

  let rewriteGate: ReturnType<typeof evaluateRewriteLiveClientGate> | null = null;
  if (op === 'rewrite.apply') {
    const rewriteValidationError = validateRewriteApplyPayload(payload);
    if (rewriteValidationError) {
      sendMutationResponse(res, 400, { success: false, error: rewriteValidationError }, { route: mutationRoute, slug });
      return;
    }
    rewriteGate = evaluateRewriteLiveClientGate(slug, payload);
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
      console.warn('[routes] rewrite blocked by live clients', {
        slug,
        route: mutationRoute,
        connectedClients: rewriteGate.connectedClients,
        forceRequested: rewriteGate.forceRequested,
        forceHonored: rewriteGate.forceHonored,
        forceIgnored: rewriteGate.forceIgnored,
        runtimeEnvironment: rewriteGate.runtimeEnvironment,
      });
      sendMutationResponse(
        res,
        409,
        rewriteBlockedResponseBody(rewriteGate, slug),
        { route: mutationRoute, slug, retryWithState: `/api/agent/${slug}/state` },
      );
      return;
    }
    const barrierStartedAt = Date.now();
    try {
      await prepareRewriteCollabBarrier(slug);
      recordRewriteBarrierLatency(mutationRoute, Date.now() - barrierStartedAt);
    } catch (error) {
      const reason = classifyRewriteBarrierFailureReason(error);
      recordRewriteBarrierFailure(mutationRoute, reason);
      recordRewriteBarrierLatency(mutationRoute, Date.now() - barrierStartedAt);
      sendMutationResponse(
        res,
        503,
        rewriteBarrierFailedResponseBody(slug, reason),
        { route: mutationRoute, slug, retryWithState: `/api/agent/${slug}/state` },
      );
      return;
    }
  }

  const result: EngineExecutionResult = op === 'rewrite.apply'
    ? await executeCanonicalRewrite(slug, opRoute.body) as EngineExecutionResult
    : await executeDocumentOperationAsync(
      slug,
      opRoute.method,
      opRoute.path,
      opRoute.body,
    );

  if (op === 'rewrite.apply' && result.status >= 200 && result.status < 300 && rewriteGate) {
    result.body = annotateRewriteDisruptionMetadata(result.body, rewriteGate);
  }

  if (idempotencyKey && result.status >= 200 && result.status < 300) {
    storeIdempotencyResult(slug, routeKey, idempotencyKey, result.body, requestHash, { statusCode: result.status });
  }

  if (result.status >= 200 && result.status < 300) {
    // Collab mutations for rewrite.apply are committed through the canonical Yjs path.
    // Other ops still need explicit projection sync into the live room.
    if (op !== 'rewrite.apply') {
      try {
        const collabRuntime = getCollabRuntime();
        if (collabRuntime.enabled) {
          const updatedDoc = getDocumentBySlug(slug);
          if (updatedDoc) {
            const applyOptions = {
              markdown: typeof updatedDoc.markdown === 'string' ? updatedDoc.markdown : undefined,
              marks: parseJson(updatedDoc.marks),
              source: 'rest-ops',
            };
            await applyCanonicalDocumentToCollab(slug, applyOptions);

            if (participation) {
              try {
                applyAgentPresenceToLoadedCollab(slug, participation.presenceEntry, {
                  type: 'agent.presence',
                  ...participation.presenceEntry,
                });
                if (participation.cursorQuote) {
                  applyAgentCursorHintToLoadedCollab(slug, {
                    id: String(participation.presenceEntry.id),
                    tokenId: typeof participation.presenceEntry.tokenId === 'string' ? participation.presenceEntry.tokenId : null,
                    quote: participation.cursorQuote,
                    ttlMs: 3000,
                    name: typeof participation.presenceEntry.name === 'string' ? participation.presenceEntry.name : undefined,
                    color: typeof participation.presenceEntry.color === 'string' ? participation.presenceEntry.color : undefined,
                    avatar: typeof participation.presenceEntry.avatar === 'string' ? participation.presenceEntry.avatar : undefined,
                  });
                }
              } catch {
                // ignore presence/cursor coupling failures
              }
            }
          } else {
            invalidateCollabDocument(slug);
          }
        } else {
          invalidateCollabDocument(slug);
        }
      } catch (error) {
        console.error('[routes] Failed to apply /ops mutation into collab runtime:', { slug, error });
        invalidateCollabDocument(slug);
      }
    }
    broadcastToRoom(slug, {
      type: 'document.updated',
      source: 'api',
      timestamp: new Date().toISOString(),
    });
  }

  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

// Proof Documents Step 1: line marks for the page. Reads need document read access; writes
// need comment access. Approved needs an Owner: the owner credential, a Documents library
// admin, or the library member who created the document (Step B6: always a verified session).
function resolveLineMarkAccess(req: Request, slug: string, doc: NonNullable<ReturnType<typeof getDocumentBySlug>>) {
  const role = getAccessRole(req, slug);
  const ownerAuthorized = role === 'owner_bot' || canOwnerMutate(req, doc);
  // Invite person: the session counts on this document only for a library member or a person
  // invited to it; an invited person elsewhere is a guest.
  const docSession = documentSession(req, slug);
  const library: ReturnType<typeof getLibrarySession> = docSession?.session ?? null;
  const canApprove = ownerAuthorized
    || Boolean(IDENTITY_POLICY.adminsHaveOwnerRights && library?.member.isOwner && docSession?.via === 'library')
    || Boolean(library && docSession?.via === 'library' && isLibraryDocumentCreator(slug, library.member.id));
  const active = doc.share_state === 'ACTIVE';
  const canRead = doc.share_state !== 'DELETED' && (ownerAuthorized || (active && role !== null));
  const canComment = ownerAuthorized || (active && (role === 'commenter' || role === 'editor'));
  // A guest (no session, no key, no share token) marks only where the guest setting lets marks count.
  const isPlainGuest = !ownerAuthorized && !library && !getPresentedSecret(req);
  const guestMustSignIn = isPlainGuest && !guestMarksCount(slug);
  // Cross invitation (2026-09-19): an AI attested to this signed-in person. They read and comment;
  // nothing they mark counts until a human invites them. The refusal is NOT_VERIFIED, and it is a
  // refusal — never an unverified mark that could be mistaken for a counted one later.
  const attestation = isPlainGuest ? attestedFor(req, slug) : null;
  const canMark = canComment && !guestMustSignIn && !attestation;
  return { role, canRead, canComment, canMark, canApprove, ownerAuthorized, library, guestMustSignIn, attestation };
}

/** Invite person: what a guest is told when a mark, answer, pick or approval needs sign-in. */
function signInToMarkBody(): Record<string, unknown> {
  return {
    success: false,
    code: 'SIGN_IN_TO_MARK',
    error: 'Sign in to mark. Without signing in you can read, comment and chat; marks, answers, picks and approvals need a signed-in person.',
    signInUrl: isLibraryEnabled() ? '/' : null,
  };
}

/**
 * Cross invitation: what an attested person is told. They are signed in, so "sign in" would be
 * wrong: an AI vouched for them, and that is presence, not authority.
 */
function notVerifiedBody(attestedBy: string): Record<string, unknown> {
  return {
    success: false,
    code: 'NOT_VERIFIED',
    error: CROSS_INVITE_POLICY.notVerifiedMessage,
    attestedBy,
  };
}

/** Step B6: the label of the agent key this request presents, if it presents one. */
function presentedAgentKeyLabel(req: Request, slug: string): string | null {
  const secret = getExplicitShareSecret(req);
  if (!secret) return null;
  const access = resolveDocumentAccess(slug, secret);
  if (!access?.tokenId) return null;
  const key = listDocumentAgentKeys(slug).find(k => k.tokenId === access.tokenId && !k.revokedAt);
  return key?.label ?? null;
}

/**
 * Step B6: who a page request acts as (server/identity.ts decideActor). The "by" in the body is
 * only a guest's typed name: a signed-in session always wins, and an agent key always acts as
 * its own AI.
 */
function resolvePageActor(req: Request, slug: string, access: ReturnType<typeof resolveLineMarkAccess>, typedBy: unknown, kind: 'mark' | 'talk' = 'mark'): ActorDecision {
  const origin = req.header('origin');
  const decision = decideActor({
    mode: 'page',
    typedBy,
    agentKeyLabel: presentedAgentKeyLabel(req, slug),
    session: sessionIdentity(access.library?.member),
    sessionOriginOk: !origin || origin === getPublicOrigin(req),
    ownerCredential: access.ownerAuthorized,
  });
  if (kind === 'mark' && decision.ok && decision.source === 'guest' && access.attestation) {
    return { ok: false, status: 403, body: notVerifiedBody(access.attestation.actor) };
  }
  if (kind === 'mark' && decision.ok && decision.source === 'guest' && access.guestMustSignIn) {
    return { ok: false, status: 403, body: signInToMarkBody() };
  }
  return decision;
}

/** Step B6: who the page viewer is, for the right rail header and for every new mark. */
function viewerIdentity(req: Request, slug: string, access: ReturnType<typeof resolveLineMarkAccess>, dir: IdentityDirectory): ViewerIdentity {
  const signInUrl = isLibraryEnabled() ? '/' : null;
  const keyLabel = presentedAgentKeyLabel(req, slug);
  if (keyLabel) {
    const actor = agentKeyActor(keyLabel);
    return { actor, trust: 'ai', name: keyLabel, signInUrl: null };
  }
  const member = access.library?.member;
  if (member?.email && isEmailAddress(member.email)) {
    const actor = verifiedHumanActor(member.email);
    return { actor, trust: 'verified', name: member.name || dir.labels[actorKey(actor)] || member.email, email: member.email.toLowerCase(), signInUrl: null };
  }
  // Cross invitation: an attested person is signed in already, so they are not asked to sign in —
  // the rail names the AI that vouched for them and says their marks do not count yet.
  if (access.attestation) {
    // Their actor is a guest actor, not human:<email>: an attestation is presence, not authority,
    // so nothing they do may be recorded as a verified person.
    return {
      actor: guestActor(access.attestation.email), trust: 'guest', name: access.attestation.email, signInUrl: null,
      attestedBy: { actor: access.attestation.actor, name: crossDisplayName(access.attestation.actor, slug), basis: access.attestation.basis, at: access.attestation.at },
    };
  }
  // A guest: the page supplies the typed name (guest:<name>). Invite person: where the guest
  // setting keeps guests' marks from counting, the page says "Sign in to mark".
  return { actor: '', trust: 'guest', name: '', signInUrl, ...(access.guestMustSignIn ? { markNeedsSignIn: true } : {}) };
}

// Accord dialect export for the page ("Download as Accord (.accord.md)"): same output as
// GET /api/agent/<slug>/export. While blind marking is on, the reader sees only their own positions.
apiRoutes.get('/documents/:slug/export', async (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  const doc = slug ? getDocumentBySlug(slug) : undefined;
  if (!slug || !doc) { res.status(404).json({ success: false, error: 'Document not found' }); return; }
  const access = resolveLineMarkAccess(req, slug, doc);
  if (!access.canRead) { res.status(403).json({ success: false, error: 'No read access' }); return; }
  // Naming tail: format=accord-dialect is an alias of proof-dialect (FORMAT_ALIASES).
  const format = normalizeExportFormat(req.query.format);
  if (!format) {
    res.status(400).json({ success: false, code: 'INVALID_FORMAT', error: EXPORT_FORMAT_ERROR });
    return;
  }
  try {
    const state = await executeDocumentOperationAsync(slug, 'GET', '/state');
    const body = (state.body ?? {}) as Record<string, unknown>;
    const markdown = typeof body.markdown === 'string' ? body.markdown : stripSpansForExport(doc.markdown ?? '');
    const marks = body.marks && typeof body.marks === 'object' ? body.marks : doc.marks;
    const me = viewerIdentity(req, slug, access, buildDirectory(slug));
    const viewer = access.ownerAuthorized && access.role === 'owner_bot' ? null : (me.actor || 'guest:export');
    const result = await exportProofDocument(slug, { markdown, marks, format, title: doc.title ?? null, viewer, authored: req.query.authored === '1' });
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename.replace(/"/g, '')}"`);
    res.setHeader('X-Proof-Export-Warnings', String(result.warnings.length));
    res.status(200).send(result.text);
  } catch (error) {
    console.error('[routes] export failed', { slug, error: String(error) });
    res.status(500).json({ success: false, code: 'EXPORT_FAILED', error: 'Export failed' });
  }
});

apiRoutes.get('/documents/:slug/line-marks', async (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  const doc = slug ? getDocumentBySlug(slug) : undefined;
  if (!slug || !doc) {
    res.status(404).json({ success: false, error: 'Document not found' });
    return;
  }
  const access = resolveLineMarkAccess(req, slug, doc);
  if (!access.canRead) {
    res.status(403).json({ success: false, error: 'No read access' });
    return;
  }
  const dir = buildDirectory(slug);
  const lineMarks = listCanonicalLineMarks(slug, dir);
  const asks = listCanonicalAsks(slug, dir);
  const owners = documentOwnerActors(slug);
  const agentKeyActors = activeAgentKeyActors(slug);
  const me = viewerIdentity(req, slug, access, dir);
  // Comment and suggestion authors in the stored document: the page resolves them to people for
  // the team (a comment typed as "Mike Wolf" counts as the member of that name).
  const reviewAuthors = reviewMarksFromStored(doc.marks).flatMap(mark => [mark.by, ...(mark.replies ?? []).map(reply => reply.by)]);
  // Step B4c/B4d: flags, AI review notes and open objections (the page evaluates them).
  const flags = listFlags(slug);
  const reviewNotes = listReviewNotes(slug);
  const objections = listObjections(slug);
  const directory = clientDirectory(dir, [
    ...actorsIn(lineMarks, asks, [...owners, ...agentKeyActors, ...reviewAuthors, me.actor]),
    ...listLineMarks(slug).map(mark => mark.by),
    ...flags.map(flag => flag.by), ...reviewNotes.map(note => note.by), ...objections.map(objection => objection.by),
    ...doTeamActors(listDos(slug)),
  ]);
  // {do} action lines: the page evaluates them against its own lines (same poll).
  let dos: ReturnType<typeof listDos> = [];
  try { dos = listDos(slug); } catch { dos = []; }
  const blindView = await pageExtras(req, slug, doc, me, lineMarks, asks);
  const extras = blindView.extras;
  // Familiar proxy marks: the viewer's own binding, their Familiar's current proxies (never
  // counted as theirs) and the ratifications they can still undo. Other people's proxies stay off
  // the page (PROXY_POLICY.pageShowsOnlyOwnProxies).
  const binding = me.trust === 'verified' ? familiarOf(slug, me.actor) : null;
  const proxies = binding ? listProxyMarks(slug, { for: me.actor }).filter(p => actorKey(p.familiar) === actorKey(binding.familiar)) : [];
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    success: true,
    lineMarks: blindView.lineMarks,
    // Step B3: the page evaluates asks against its own lines (same poll, no extra request).
    asks: blindView.asks,
    dos,
    doPolicy: { executionEnabled: DO_POLICY.executionEnabled, executionDisabledLabel: DO_POLICY.executionDisabledLabel },
    owners,
    agentKeyActors,
    viewer: { canMark: access.canMark, canApprove: access.canApprove, canComment: access.canComment },
    // Invite person: whether this viewer may invite people and change the guest setting.
    team: { canManage: isLibraryEnabled() && access.canApprove, guestAccess: getGuestAccessMode(slug) },
    // Step B6: who this viewer is (a guest's actor is filled in by the page from the typed name).
    identity: { me, directory },
    // Step B3c: the latest aligned snapshot (the top bar's "Aligned as of").
    alignedSnapshot: latestSnapshotInfo(slug),
    flags,
    reviewNotes,
    objections,
    familiar: binding,
    familiarsBound: listFamiliars(slug).length,
    // The names people gave the AIs present ("Add agent"), for "My Familiar" and the brief.
    agentKeyLabels: Object.fromEntries(listDocumentAgentKeys(slug).filter(key => !key.revokedAt).map(key => [agentKeyActor(key.label), key.label])),
    // Cross invitation: who added each AI and what runs it, so a mark reads "Izzy — added by Eric".
    agentSponsors: agentProvenanceMap(slug),
    // Cross invitation: how everyone on this document got in (the provenance chain).
    provenance: documentProvenance(slug),
    proxies,
    ratifications: binding ? undoableRatifications(slug, me.actor) : [],
    proxyPolicy: { ratifyThreshold: PROXY_POLICY.ratifyThreshold, hold: PROXY_POLICY.hold, evidence: EVIDENCE_POLICY },
    // Line tiers: every tag (the page evaluates them against its own lines), and what covers a
    // context line: AI reads with evidence and Familiars' proxies, from the unredacted marks (so a
    // blind placeholder does not hide a read; only that an AI read the line is revealed).
    tiers: listTierRecords(slug),
    tierSignals: tierSignals(slug, lineMarks),
    tierPolicy: TIER_POLICY,
    // Steps B4e + B4f: bundles, alternatives (open, plus recent history) and picks, settings,
    // Explain threads and times-to-live. The page evaluates them against its own lines; expiry
    // is judged at `serverNow` (lazy, no timer).
    ...extras,
  });
});

/**
 * Steps B4e + B4f: the extras for the page's poll. Under blind marking, other members' marks, ask
 * answers and picks on lines this viewer has not marked are replaced by placeholders here, so
 * they never reach the browser.
 */
async function pageExtras(req: Request, slug: string, doc: NonNullable<ReturnType<typeof getDocumentBySlug>>, me: ViewerIdentity, lineMarks: ReturnType<typeof listCanonicalLineMarks>, asks: ReturnType<typeof listCanonicalAsks>): Promise<{ extras: Record<string, unknown>; lineMarks: typeof lineMarks; asks: typeof asks }> {
  const settings = getProofSettings(slug);
  const allAlternatives = listAlternatives(slug, { includeClosed: true });
  let picks = listPicks(slug);
  const extras: Record<string, unknown> = {
    settings,
    bundles: listBundles(slug),
    alternatives: allAlternatives.filter(alt => alt.status === 'open'),
    alternativeHistory: allAlternatives.filter(alt => alt.status !== 'open').slice(-100),
    explains: listExplains(slug),
    ttls: listTtls(slug).map(({ expiredNotedAt: _noted, ...ttl }) => ttl),
    serverNow: new Date().toISOString(),
  };
  if (!settings.blind) return { extras: { ...extras, picks }, lineMarks, asks };
  const typed = typeof req.query.by === 'string' ? normalizeActorString(req.query.by) : '';
  const viewer = me.actor || (typed && isGuestActor(typed) ? typed : '');
  const lines = await computeServerLines(doc.markdown ?? '');
  const views = evaluateAsks(asks, lines);
  const answered = views.filter(v => v.lineIndex !== null && v.ask.answers.some(a => actorKey(a.by) === actorKey(viewer))).map(v => v.lineIndex as number);
  const view = blindViewFor({ lines, lineMarks, viewer, answeredLines: answered, picks });
  picks = view.picks;
  const redactedAsks = asks.map(ask => {
    const at = views.find(v => v.ask.id === ask.id)?.lineIndex ?? null;
    if (at !== null && view.revealed.has(at)) return ask;
    return {
      ...ask,
      answers: ask.answers.map(answer => (actorKey(answer.by) === actorKey(viewer) ? answer
        : { ...answer, choice: (ASK_POLICY.closes[answer.choice] ? 'yes' : 'not_yet') as typeof answer.choice, words: '', hidden: true })),
    };
  });
  return {
    extras: { ...extras, picks, blind: { on: true, viewer, revealedLines: [...view.revealed].sort((a, b) => a - b), hiddenPositions: view.hidden } },
    lineMarks: view.lineMarks,
    asks: redactedAsks,
  };
}

// Proof Documents Steps B4c + B4d: flags and objections from the page. Writes need comment
// access; the actor is decided as for line marks (a signed-in session wins over a typed name).
const PAGE_TALK_ROUTES = ['/explain', '/why-asked'];
function pageAidRoute(path: string, run: (ctx: { req: Request; slug: string; by: string; access: ReturnType<typeof resolveLineMarkAccess>; body: Record<string, unknown> }) => Promise<{ status: number; body: Record<string, unknown> }> | { status: number; body: Record<string, unknown> }): void {
  apiRoutes.post(path, opsRateLimiter, async (req: Request, res: Response) => {
    const slug = getSlugParam(req);
    const doc = slug ? getDocumentBySlug(slug) : undefined;
    if (!slug || !doc) { res.status(404).json({ success: false, error: 'Document not found' }); return; }
    const access = resolveLineMarkAccess(req, slug, doc);
    if (!access.canComment) { res.status(403).json({ success: false, error: 'This needs comment access' }); return; }
    const body = isRecord(req.body) ? req.body : {};
    // Invite person: asking for an explanation is conversation (guests may); everything else here
    // is a mark that counts, which a guest makes only where the guest setting allows it.
    const kind = PAGE_TALK_ROUTES.some(suffix => path.endsWith(suffix)) ? 'talk' : 'mark';
    const actor = resolvePageActor(req, slug, access, body.by, kind);
    if (!actor.ok) { res.status(actor.status).json(actor.body); return; }
    const result = await run({ req, slug, by: actor.actor, access, body });
    if (result.status === 200) scheduleAlignmentCheck(slug);
    res.status(result.status).json({ ...result.body, actor: actor.actor, trust: actor.trust });
  });
}

// Line tiers. Body: { by, tier: "decision" | "context", anchors: [anchor, ...] (or anchor), reason? }.
// Anyone with comment access may tag or flip (TIER_POLICY.whoMayTag); every flip is recorded.
pageAidRoute('/documents/:slug/tiers', async ({ slug, by, body }) => {
  if (!isLineTier(body.tier)) return { status: 400, body: { success: false, code: 'INVALID_TIER', error: '"tier" must be "decision" or "context"' } };
  const anchors = Array.isArray(body.anchors) ? body.anchors : [body.anchor];
  if (anchors.length === 0 || anchors.length > TIER_POLICY.maxLinesPerRequest) return { status: 400, body: { success: false, code: 'INVALID_LINES', error: 'Give 1 to ' + TIER_POLICY.maxLinesPerRequest + ' anchors' } };
  const state = await currentDocumentState(slug);
  if (!state) return { status: 404, body: { success: false, error: 'Document not found' } };
  const lines = await computeServerLines(state.markdown);
  const resolved: DocLine[] = [];
  for (let i = 0; i < anchors.length; i += 1) {
    if (!isLineAnchor(anchors[i])) return { status: 400, body: { success: false, code: 'INVALID_ANCHOR', error: `anchors[${i}] is not a line anchor`, index: i } };
    const hit = resolveLineAnchor(lines, anchors[i]);
    if (!hit || !hit.current) return { status: 409, body: { success: false, code: 'LINE_CHANGED', error: 'That line changed; try again', index: i } };
    resolved.push(lines[hit.lineIndex]);
  }
  const before = evaluateDocumentTiers(slug, lines, listCanonicalLineMarks(slug));
  return writeTiers(slug, { by, tier: body.tier, reason: body.reason, lines: resolved, before, markdown: state.markdown, rawMarks: state.marks, source: 'page' });
});

// Body: { by, anchor, note? }: flag a line uncertain (or update your note on your flag there).
pageAidRoute('/documents/:slug/flags', ({ slug, by, body }) => writeFlag(slug, { by, anchor: body.anchor, note: body.note, source: 'page' }));
// The flagger (or an Owner) clears a flag.
pageAidRoute('/documents/:slug/flags/:flagId/clear', ({ req, slug, by, access }) =>
  clearFlag(slug, { id: String(req.params.flagId ?? ''), by, isOwner: access.canApprove, source: 'page' }));
// Body: { by, lines: [anchor, ...], reason, condition?, suggestions?: [markId, ...] }.
pageAidRoute('/documents/:slug/objections', async ({ slug, by, access, body }) => {
  const state = await currentDocumentState(slug);
  return createObjection(slug, {
    by, anchors: body.lines, reason: body.reason, condition: body.condition,
    suggestions: Array.isArray(body.suggestions) ? body.suggestions.filter((id): id is string => typeof id === 'string' && id.length <= 100) : [],
    lines: state ? await computeServerLines(state.markdown) : undefined,
    source: 'page', canMark: access.canMark,
  });
});
// The objector clears it; an Owner overrides it with { reason } (recorded).
pageAidRoute('/documents/:slug/objections/:objectionId/clear', ({ req, slug, by, access, body }) =>
  clearObjection(slug, { id: String(req.params.objectionId ?? ''), by, isOwner: access.canApprove, reason: body.reason, source: 'page' }));
// The objector saw the repair and still objects: { by, ack: { hashes, suggestions } }.
pageAidRoute('/documents/:slug/objections/:objectionId/keep', async ({ req, slug, by, body }) => {
  const state = await currentDocumentState(slug);
  if (!state) return { status: 404, body: { success: false, error: 'Document not found' } };
  return keepObjection(slug, { id: String(req.params.objectionId ?? ''), by, ack: body.ack, markdown: state.markdown, rawMarks: state.marks, source: 'page' });
});
// ============================================================================
// Familiar proxy marks: page routes (a signed-in person, for themselves only)
// ============================================================================

/** A route only a person signed in to this site may use, for themselves (never a guest or a key). */
function pagePersonRoute(path: string, run: (ctx: { req: Request; slug: string; human: string; body: Record<string, unknown> }) => Promise<{ status: number; body: Record<string, unknown> }> | { status: number; body: Record<string, unknown> }): void {
  apiRoutes.post(path, opsRateLimiter, async (req: Request, res: Response) => {
    const slug = getSlugParam(req);
    const doc = slug ? getDocumentBySlug(slug) : undefined;
    if (!slug || !doc) { res.status(404).json({ success: false, error: 'Document not found' }); return; }
    const access = resolveLineMarkAccess(req, slug, doc);
    if (!access.canComment) { res.status(403).json({ success: false, error: 'This needs comment access' }); return; }
    const body = isRecord(req.body) ? req.body : {};
    const actor = resolvePageActor(req, slug, access, body.by);
    if (!actor.ok) { res.status(actor.status).json(actor.body); return; }
    if (PROXY_POLICY.bindRequiresVerifiedSession && (actor.source !== 'session' || actor.trust !== 'verified')) {
      res.status(403).json({ success: false, code: 'SIGNED_IN_PERSON_REQUIRED', error: 'Only a person signed in to this site can choose a Familiar or ratify its marks' });
      return;
    }
    const result = await run({ req, slug, human: actor.actor, body });
    if (result.status === 200) scheduleAlignmentCheck(slug);
    res.status(result.status).json({ ...result.body, actor: actor.actor, trust: actor.trust });
  });
}

// { familiar: "ai:<key-name>" | null }: choose (or clear) my Familiar in this document.
pagePersonRoute('/documents/:slug/familiar', ({ slug, human, body }) =>
  bindFamiliar(slug, { human, familiar: body.familiar ?? null, by: human, source: 'page' }));
// { proxyIds: [...] }: Ratify all (the proxy-agreed lines the brief showed me).
pagePersonRoute('/documents/:slug/proxy/ratify', async ({ slug, human, body }) => {
  const state = await currentDocumentState(slug);
  if (!state) return { status: 404, body: { success: false, error: 'Document not found' } };
  return ratifyProxies(slug, { human, proxyIds: body.proxyIds, markdown: state.markdown, rawMarks: state.marks });
});
// Undo a ratification of mine: every line gets back what it held before.
pagePersonRoute('/documents/:slug/proxy/ratifications/:ratificationId/undo', ({ req, slug, human }) =>
  undoRatification(slug, { human, id: String(req.params.ratificationId ?? '') }));

// ============================================================================
// Proof Documents Steps B4e + B4f: page routes
// ============================================================================

// Step B4e: the page applied (or rejected) a whole bundle in its editor (one step): record it.
pageAidRoute('/documents/:slug/bundles/:bundleId/decision', async ({ req, slug, by, body }) => {
  const state = await currentDocumentState(slug);
  if (!state) return { status: 404, body: { success: false, error: 'Document not found' } };
  return recordBundleDecision(slug, { id: String(req.params.bundleId ?? ''), by, decision: body.decision, markdown: state.markdown, rawMarks: state.marks });
});
// Step B4f: offer another wording { anchor, text }, pick { anchor, choice }, an Owner decides.
pageAidRoute('/documents/:slug/alternatives', async ({ req, slug, by, body }) => {
  const state = await currentDocumentState(slug);
  if (!state) return { status: 404, body: { success: false, error: 'Document not found' } };
  return offerAlternative(slug, { by, anchor: body.anchor, text: body.text, markdown: state.markdown, rawMarks: state.marks, source: 'page', applyEdit: lineEditor(req, slug) });
});
pageAidRoute('/documents/:slug/alternatives/pick', async ({ req, slug, by, body }) => {
  const state = await currentDocumentState(slug);
  if (!state) return { status: 404, body: { success: false, error: 'Document not found' } };
  return pickAlternative(slug, { by, anchor: body.anchor, choice: body.choice, markdown: state.markdown, rawMarks: state.marks, source: 'page', applyEdit: lineEditor(req, slug) });
});
pageAidRoute('/documents/:slug/alternatives/decide', async ({ req, slug, by, access, body }) => {
  const state = await currentDocumentState(slug);
  if (!state) return { status: 404, body: { success: false, error: 'Document not found' } };
  return decideAlternative(slug, { by, isOwner: access.canApprove, anchor: body.anchor, choice: body.choice, markdown: state.markdown, rawMarks: state.marks, applyEdit: lineEditor(req, slug) });
});
pageAidRoute('/documents/:slug/alternatives/:altId/withdraw', ({ req, slug, by, access }) =>
  withdrawAlternative(slug, { id: String(req.params.altId ?? ''), by, isOwner: access.canApprove }));
// Step B4f: an Owner turns blind marking on or off: { blind: true | false }.
pageAidRoute('/documents/:slug/settings', ({ slug, by, access, body }) =>
  setBlindSetting(slug, { blind: body.blind, by, isOwner: access.canApprove, source: 'page' }));
// Step B4f: the page posted an Explain thread on a line: { anchor, question, commentMarkId }.
pageAidRoute('/documents/:slug/explain', async ({ slug, by, body }) => {
  const state = await currentDocumentState(slug);
  if (!state) return { status: 404, body: { success: false, error: 'Document not found' } };
  const result = await recordExplain(slug, { by, anchor: body.anchor, question: body.question, commentMarkId: body.commentMarkId, markdown: state.markdown, source: 'page' });
  // Step B7: the Explain question also appears in the chat, linked to its comment thread.
  if (result.status === 200 && CHAT_POLICY.mirrorExplain) {
    const explain = result.body.explain as { question?: string; commentMarkId?: string | null; anchor?: unknown } | undefined;
    try {
      const chat = postChatMessage(slug, {
        by, kind: 'explain', text: `${EXPLAIN_POLICY.commentPrefix} ${explain?.question ?? EXPLAIN_POLICY.defaultQuestion}`,
        anchors: explain?.anchor ? [explain.anchor] : [], mentions: activeAgentKeyActors(slug),
        commentMarkId: explain?.commentMarkId ?? null, source: 'page',
      });
      if (chat.status === 200) result.body.chatMessageId = chat.body.cursor;
    } catch (error) { console.warn('[chat] explain mirror failed', String(error)); }
  }
  return result;
});
// Step B4f: a line's time-to-live: { anchor, ttl: "7d" }; the setter or an Owner clears it.
pageAidRoute('/documents/:slug/ttl', async ({ slug, by, body }) => {
  const state = await currentDocumentState(slug);
  if (!state) return { status: 404, body: { success: false, error: 'Document not found' } };
  return setTtl(slug, { by, anchor: body.anchor, ttl: body.ttl, markdown: state.markdown, source: 'page' });
});
pageAidRoute('/documents/:slug/ttl/:ttlId/clear', ({ req, slug, by, access }) =>
  clearTtl(slug, { id: String(req.params.ttlId ?? ''), by, isOwner: access.canApprove, source: 'page' }));

// Step B4c: the reader tapped "Ask why" on a change (the page also posts the reply itself):
// recorded as review.why_asked so the author's Familiar sees the question. Body: { by, markId, author }.
pageAidRoute('/documents/:slug/why-asked', ({ slug, by, body }) => {
  const markId = typeof body.markId === 'string' ? body.markId.slice(0, 100) : '';
  if (!markId) return { status: 400, body: { success: false, error: 'Missing markId' } };
  const author = typeof body.author === 'string' ? body.author.slice(0, 120) : null;
  try { addDocumentEvent(slug, 'review.why_asked', { markId, author }, by); } catch { /* optional */ }
  // Step B7: "Ask why" also appears in the chat, linked to the change's thread and its line.
  let chatMessageId: unknown = null;
  if (CHAT_POLICY.mirrorAskWhy) {
    try {
      const authorActor = author ? normalizeActorString(author) : '';
      const name = authorActor ? (mentionCandidates(slug).find(c => actorKey(c.actor) === actorKey(authorActor))?.names[0] ?? authorActor.replace(/^(human|ai|guest):/i, '')) : '';
      const chat = postChatMessage(slug, {
        by, kind: 'why', text: `${name ? `@${name} ` : ''}${WHY_POLICY.askWhyText}`,
        anchors: body.anchor ? [body.anchor] : [], mentions: authorActor ? [authorActor] : [],
        commentMarkId: markId, source: 'page',
      });
      if (chat.status === 200) chatMessageId = chat.body.cursor;
    } catch (error) { console.warn('[chat] why mirror failed', String(error)); }
  }
  return { status: 200, body: { success: true, chatMessageId } };
});

// ============================================================================
// Proof Documents Step B7: chat beside the document (never in its text or Yjs state)
// ============================================================================

// GET ?after=<id>&limit=<n>: messages after the cursor (oldest first), or the newest page.
apiRoutes.get('/documents/:slug/chat', (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  const doc = slug ? getDocumentBySlug(slug) : undefined;
  if (!slug || !doc) { res.status(404).json({ success: false, error: 'Document not found' }); return; }
  const access = resolveLineMarkAccess(req, slug, doc);
  if (!access.canRead) { res.status(403).json({ success: false, error: 'No read access' }); return; }
  const afterRaw = typeof req.query.after === 'string' ? Number(req.query.after) : NaN;
  const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
  const after = Number.isFinite(afterRaw) && afterRaw >= 0 ? afterRaw : null;
  const messages = listChatMessages(slug, { after, limit: Number.isFinite(limitRaw) ? limitRaw : undefined });
  const candidates = mentionCandidates(slug);
  const dir = buildDirectory(slug);
  const directory = clientDirectory(dir, [...chatAuthors(slug), ...messages.flatMap(m => m.mentions), ...candidates.map(c => c.actor)]);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    success: true,
    messages,
    cursor: messages.length ? messages[messages.length - 1].id : (after ?? 0),
    candidates,
    labels: directory.labels,
    policy: { maxText: CHAT_POLICY.maxText, maxLines: CHAT_POLICY.maxLines, pollMs: CHAT_POLICY.pollMs },
    canPost: access.canComment,
  });
});

// POST { by, text, lines: [anchor], mentions?: [actor], replyTo? }. Comment access; the actor is
// decided as for line marks (a signed-in session wins over a typed guest name).
apiRoutes.post('/documents/:slug/chat', opsRateLimiter, (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  const doc = slug ? getDocumentBySlug(slug) : undefined;
  if (!slug || !doc) { res.status(404).json({ success: false, error: 'Document not found' }); return; }
  const access = resolveLineMarkAccess(req, slug, doc);
  if (!access.canComment) { res.status(403).json({ success: false, error: 'This needs comment access' }); return; }
  const body = isRecord(req.body) ? req.body : {};
  const actor = resolvePageActor(req, slug, access, body.by, 'talk');
  if (!actor.ok) { res.status(actor.status).json(actor.body); return; }
  const result = postChatMessage(slug, {
    by: actor.actor, text: body.text, anchors: body.lines, mentions: body.mentions, replyTo: body.replyTo, source: 'page',
  });
  res.status(result.status).json({ ...result.body, actor: actor.actor, trust: actor.trust });
});

// Step B3c: "Since you" for the viewer (a signed-in person, an agent key's AI, or the guest who
// types ?by=<name>): what changed since they last marked a line on purpose, and the ringer list.
apiRoutes.get('/documents/:slug/since-you', async (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  const doc = slug ? getDocumentBySlug(slug) : undefined;
  if (!slug || !doc) { res.status(404).json({ success: false, error: 'Document not found' }); return; }
  const access = resolveLineMarkAccess(req, slug, doc);
  if (!access.canRead) { res.status(403).json({ success: false, error: 'No read access' }); return; }
  const actor = resolvePageActor(req, slug, access, typeof req.query.by === 'string' ? req.query.by : undefined, 'talk');
  if (!actor.ok) { res.status(actor.status).json(actor.body); return; }
  const report = await buildSinceYou(slug, actor.actor);
  res.setHeader('Cache-Control', 'no-store');
  if (!report) { res.status(404).json({ success: false, error: 'Document not found' }); return; }
  res.json({ success: true, ...report });
});

// Step B3c: the page saw the Issue count reach 0: the server checks for itself and freezes a
// snapshot when the document really is aligned (a page can only ask, never declare).
apiRoutes.post('/documents/:slug/alignment-check', opsRateLimiter, async (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  const doc = slug ? getDocumentBySlug(slug) : undefined;
  if (!slug || !doc) { res.status(404).json({ success: false, error: 'Document not found' }); return; }
  const access = resolveLineMarkAccess(req, slug, doc);
  if (!access.canRead) { res.status(403).json({ success: false, error: 'No read access' }); return; }
  const result = await checkAlignment(slug);
  if (!result) { res.status(404).json({ success: false, error: 'Document not found' }); return; }
  res.json({ success: true, ...result });
});

apiRoutes.get('/documents/:slug/snapshots', (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  const doc = slug ? getDocumentBySlug(slug) : undefined;
  if (!slug || !doc) { res.status(404).json({ success: false, error: 'Document not found' }); return; }
  const access = resolveLineMarkAccess(req, slug, doc);
  if (!access.canRead) { res.status(403).json({ success: false, error: 'No read access' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, snapshots: listSnapshotInfos(slug) });
});

// GET /documents/:slug/snapshots/<id>.md is the markdown ledger; /<id> is the JSON.
apiRoutes.get('/documents/:slug/snapshots/:file', (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  const doc = slug ? getDocumentBySlug(slug) : undefined;
  if (!slug || !doc) { res.status(404).json({ success: false, error: 'Document not found' }); return; }
  const access = resolveLineMarkAccess(req, slug, doc);
  if (!access.canRead) { res.status(403).json({ success: false, error: 'No read access' }); return; }
  sendSnapshotFile(res, slug, String(req.params.file ?? ''));
});

apiRoutes.post('/documents/:slug/line-marks', opsRateLimiter, (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  const doc = slug ? getDocumentBySlug(slug) : undefined;
  if (!slug || !doc) {
    res.status(404).json({ success: false, error: 'Document not found' });
    return;
  }
  const access = resolveLineMarkAccess(req, slug, doc);
  if (!access.canComment) {
    res.status(403).json({ success: false, error: 'Marking lines needs comment access' });
    return;
  }
  const body = isRecord(req.body) ? req.body : {};
  const actor = resolvePageActor(req, slug, access, body.by);
  if (!actor.ok) {
    res.status(actor.status).json(actor.body);
    return;
  }
  // Step B2: { by, status, reason?, lines: [{ anchor, status?, reason?, replaceIds?, replaceAnchors? }] }
  // marks many lines in one request and one transaction (a folded section, or its undo).
  if (Array.isArray(body.lines)) {
    const batch = writeLineMarksBatch(slug, {
      by: actor.actor,
      status: body.status,
      reason: body.reason,
      // Step B3b: a folded section's batch is "section"; a skim batch from the walk says "dwell".
      via: body.via !== undefined ? body.via : (isRecord(body.section) ? 'section' : 'click'),
      lines: body.lines,
      canApprove: access.canApprove,
      source: 'page',
      context: isRecord(body.section) ? { section: { heading: String(body.section.heading ?? '').slice(0, 200), lines: body.lines.length } } : undefined,
    });
    if (batch.status === 200) scheduleAlignmentCheck(slug);
    res.status(batch.status).json({ ...batch.body, actor: actor.actor, trust: actor.trust });
    return;
  }
  scheduleAlignmentCheck(slug);
  const result = writeLineMark(slug, {
    by: actor.actor,
    status: body.status,
    reason: body.reason,
    // Step B3b: how the page earned the mark (dwell, click, key); default "click".
    via: body.via !== undefined ? body.via : 'click',
    anchor: body.anchor,
    replaceIds: body.replaceIds,
    replaceAnchors: body.replaceAnchors,
    canApprove: access.canApprove,
    source: 'page',
  });
  res.status(result.status).json({ ...result.body, actor: actor.actor, trust: actor.trust });
});

// Proof Documents Step B3: asks for the page. Reads need read access; answering needs comment access.
apiRoutes.get('/documents/:slug/asks', (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  const doc = slug ? getDocumentBySlug(slug) : undefined;
  if (!slug || !doc) {
    res.status(404).json({ success: false, error: 'Document not found' });
    return;
  }
  const access = resolveLineMarkAccess(req, slug, doc);
  if (!access.canRead) {
    res.status(403).json({ success: false, error: 'No read access' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, asks: listCanonicalAsks(slug) });
});

// Body: { by, choice: yes|not_yet|no, words?, anchor } where anchor is the question line as the
// page sees it now (the same anchor shape as a line mark). Step B6: "by" is only a guest's typed
// name; a signed-in viewer answers as their verified identity.
apiRoutes.post('/documents/:slug/asks/:askId/answer', opsRateLimiter, (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  const doc = slug ? getDocumentBySlug(slug) : undefined;
  if (!slug || !doc) {
    res.status(404).json({ success: false, error: 'Document not found' });
    return;
  }
  const access = resolveLineMarkAccess(req, slug, doc);
  if (!access.canComment) {
    res.status(403).json({ success: false, error: 'Answering needs comment access' });
    return;
  }
  const body = isRecord(req.body) ? req.body : {};
  const actor = resolvePageActor(req, slug, access, body.by);
  if (!actor.ok) {
    res.status(actor.status).json(actor.body);
    return;
  }
  const result = answerAsk(slug, {
    id: String(req.params.askId ?? ''),
    by: actor.actor,
    choice: body.choice,
    words: body.words,
    line: body.anchor ? { anchor: body.anchor as never } : null,
    source: 'page',
    canMark: access.canMark,
  });
  if (result.status === 200) scheduleAlignmentCheck(slug);
  res.status(result.status).json({ ...result.body, actor: actor.actor, trust: actor.trust });
});

// Undo of an answer (Mike, 2026-09-19): a person takes back their own newest answer. It refuses
// with 409 when someone else answered after them, or the ask was re-asked (nothing is clobbered).
apiRoutes.delete('/documents/:slug/asks/:askId/answer', opsRateLimiter, (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  const doc = slug ? getDocumentBySlug(slug) : undefined;
  if (!slug || !doc) { res.status(404).json({ success: false, error: 'Document not found' }); return; }
  const access = resolveLineMarkAccess(req, slug, doc);
  if (!access.canComment) { res.status(403).json({ success: false, error: 'Undoing an answer needs comment access' }); return; }
  const body = isRecord(req.body) ? req.body : {};
  const actor = resolvePageActor(req, slug, access, body.by);
  if (!actor.ok) { res.status(actor.status).json(actor.body); return; }
  const result = withdrawAnswer(slug, { id: String(req.params.askId ?? ''), by: actor.actor });
  if (result.status === 200) scheduleAlignmentCheck(slug);
  res.status(result.status).json({ ...result.body, actor: actor.actor, trust: actor.trust });
});

// Step B6: re-ask and withdraw from the page. The asker (by verified identity) or an Owner
// (the document's creator, a Documents admin, or the owner credential).
apiRoutes.post('/documents/:slug/asks/:askId/reask', opsRateLimiter, (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  const doc = slug ? getDocumentBySlug(slug) : undefined;
  if (!slug || !doc) { res.status(404).json({ success: false, error: 'Document not found' }); return; }
  const access = resolveLineMarkAccess(req, slug, doc);
  if (!access.canComment) { res.status(403).json({ success: false, error: 'Re-asking needs comment access' }); return; }
  const body = isRecord(req.body) ? req.body : {};
  const actor = resolvePageActor(req, slug, access, body.by);
  if (!actor.ok) { res.status(actor.status).json(actor.body); return; }
  const result = reaskAsk(slug, { id: String(req.params.askId ?? ''), by: actor.actor, isOwner: access.canApprove, recommend: body.recommend, ifYes: body.ifYes, to: body.to });
  res.status(result.status).json(result.body);
});

apiRoutes.delete('/documents/:slug/asks/:askId', opsRateLimiter, (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  const doc = slug ? getDocumentBySlug(slug) : undefined;
  if (!slug || !doc) { res.status(404).json({ success: false, error: 'Document not found' }); return; }
  const access = resolveLineMarkAccess(req, slug, doc);
  if (!access.canComment) { res.status(403).json({ success: false, error: 'Withdrawing needs comment access' }); return; }
  const body = isRecord(req.body) ? req.body : {};
  const actor = resolvePageActor(req, slug, access, body.by);
  if (!actor.ok) { res.status(actor.status).json(actor.body); return; }
  const result = withdrawAsk(slug, { id: String(req.params.askId ?? ''), by: actor.actor, isOwner: access.canApprove });
  res.status(result.status).json(result.body);
});

// ============================================================================
// {do} action lines from the page (safe slice). Approve and revoke only; Run always refuses.
// ============================================================================

/**
 * A `{do}` approval or revocation must come from a person signed in to this site, from this site.
 * Refused: no session, an agent key or share token acting (decideActor source is not 'session'),
 * a missing or foreign Origin header (CSRF), a cross-site fetch, a body that is not JSON.
 */
function doSessionActor(req: Request, slug: string, access: ReturnType<typeof resolveLineMarkAccess>):
  { ok: true; actor: string; source: string } | { ok: false; status: number; body: Record<string, unknown> } {
  const origin = req.header('origin');
  const publicOrigin = getPublicOrigin(req);
  if (DO_POLICY.approveRequiresOriginHeader && (!origin || origin !== publicOrigin)) {
    return { ok: false, status: 403, body: { success: false, code: 'SAME_ORIGIN_REQUIRED', error: 'This request must come from this site' } };
  }
  const fetchSite = req.header('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin') {
    return { ok: false, status: 403, body: { success: false, code: 'SAME_ORIGIN_REQUIRED', error: 'This request must come from this site' } };
  }
  if (!req.is('application/json')) {
    return { ok: false, status: 415, body: { success: false, code: 'JSON_REQUIRED', error: 'Send a JSON body' } };
  }
  const body = isRecord(req.body) ? req.body : {};
  const decision = resolvePageActor(req, slug, access, body.by);
  if (!decision.ok) return decision;
  if (decision.source !== 'session') {
    return { ok: false, status: 403, body: { success: false, code: 'SIGNED_IN_PERSON_REQUIRED', error: 'Only a person signed in to this site can approve a {do} (not a guest, an agent key, a share link or a script credential)', actor: decision.actor } };
  }
  return { ok: true, actor: decision.actor, source: decision.source };
}

async function doRoute(req: Request, res: Response, action: 'approve' | 'revoke' | 'run'): Promise<void> {
  const slug = getSlugParam(req);
  const doc = slug ? getDocumentBySlug(slug) : undefined;
  if (!slug || !doc) { res.status(404).json({ success: false, error: 'Document not found' }); return; }
  const access = resolveLineMarkAccess(req, slug, doc);
  if (!access.canRead) { res.status(403).json({ success: false, error: 'No read access' }); return; }
  const who = doSessionActor(req, slug, access);
  if (!who.ok) { res.status(who.status).json(who.body); return; }
  const state = await currentDocumentState(slug);
  const lines = await computeServerLines(state?.markdown ?? doc.markdown ?? '');
  const body = isRecord(req.body) ? req.body : {};
  const id = String(req.params.doId ?? '');
  const result = action === 'approve'
    ? approveDo(slug, lines, { id, actor: who.actor, source: who.source, isOwner: access.canApprove, digest: body.digest })
    : action === 'revoke'
      ? revokeDo(slug, lines, { id, actor: who.actor, isOwner: access.canApprove })
      : await runDo(slug, lines, { id, actor: who.actor, source: who.source });
  if (result.status === 200) scheduleAlignmentCheck(slug);
  res.status(result.status).json({ ...result.body, actor: who.actor });
}

// Body: { digest } — the digest of the {do} as the page showed it (it must still be current).
apiRoutes.post('/documents/:slug/dos/:doId/approve', opsRateLimiter, (req: Request, res: Response) => { doRoute(req, res, 'approve').catch(error => { console.error('[do] route failed', error); if (!res.headersSent) res.status(500).json({ success: false, error: 'Internal error' }); }); });
apiRoutes.post('/documents/:slug/dos/:doId/revoke', opsRateLimiter, (req: Request, res: Response) => { doRoute(req, res, 'revoke').catch(error => { console.error('[do] route failed', error); if (!res.headersSent) res.status(500).json({ success: false, error: 'Internal error' }); }); });
// Always refuses in this build (409 EXECUTION_NOT_ENABLED).
apiRoutes.post('/documents/:slug/dos/:doId/run', opsRateLimiter, (req: Request, res: Response) => { doRoute(req, res, 'run').catch(error => { console.error('[do] route failed', error); if (!res.headersSent) res.status(500).json({ success: false, error: 'Internal error' }); }); });

// DELETE is an alias for destructive delete.
apiRoutes.delete('/documents/:slug', (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }

  const doc = getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }

  if (!canOwnerMutate(req, doc)) {
    res.status(403).json({ error: 'Not authorized to delete document' });
    return;
  }

  deleteDocument(slug);
  revokeDocumentAccessTokens(slug, undefined, { bumpEpoch: false });
  invalidateCollabDocument(slug);
  closeRoom(slug);
  addEvent(slug, 'document.deleted', {}, 'owner');
  res.json({ success: true, shareState: 'DELETED', snapshotUrl: getSnapshotPublicUrl(slug) });
});

apiRoutes.post('/documents/:slug/pause', (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }
  const doc = getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (!canOwnerMutate(req, doc)) {
    res.status(403).json({ error: 'Not authorized to pause document' });
    return;
  }
  pauseDocument(slug);
  invalidateCollabDocument(slug);
  closeRoom(slug);
  addEvent(slug, 'document.paused', {}, 'owner');
  refreshSnapshotForSlug(slug);
  res.json({ success: true, shareState: 'PAUSED', snapshotUrl: null });
});

apiRoutes.post('/documents/:slug/resume', (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }
  const doc = getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (!canOwnerMutate(req, doc)) {
    res.status(403).json({ error: 'Not authorized to resume document' });
    return;
  }
  resumeDocument(slug);
  addEvent(slug, 'document.resumed', {}, 'owner');
  refreshSnapshotForSlug(slug);
  res.json({ success: true, shareState: 'ACTIVE', snapshotUrl: getSnapshotPublicUrl(slug) });
});

apiRoutes.post('/documents/:slug/revoke', (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }
  const doc = getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (!canOwnerMutate(req, doc)) {
    res.status(403).json({ error: 'Not authorized to revoke document' });
    return;
  }
  revokeDocument(slug);
  revokeDocumentAccessTokens(slug, undefined, { bumpEpoch: false });
  invalidateCollabDocument(slug);
  closeRoom(slug);
  addEvent(slug, 'document.revoked', {}, 'owner');
  refreshSnapshotForSlug(slug);
  res.json({ success: true, shareState: 'REVOKED', snapshotUrl: null });
});

apiRoutes.post('/documents/:slug/delete', (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }
  const doc = getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (!canOwnerMutate(req, doc)) {
    res.status(403).json({ error: 'Not authorized to delete document' });
    return;
  }
  deleteDocument(slug);
  revokeDocumentAccessTokens(slug, undefined, { bumpEpoch: false });
  invalidateCollabDocument(slug);
  closeRoom(slug);
  addEvent(slug, 'document.deleted', {}, 'owner');
  res.json({ success: true, shareState: 'DELETED', snapshotUrl: null });
});

// Get document info (lightweight, no content)
apiRoutes.get('/documents/:slug/info', (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }

  const doc = getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }

  const hidden = !getPresentedSecret(req) && resolveTokenlessAccess(req, slug).role === null;
  res.json({
    title: doc.share_state === 'ACTIVE' && !hidden ? doc.title : null,
    shareState: doc.share_state,
  });
});

apiRoutes.get('/documents/:slug/open-context', async (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }
  const doc = getCanonicalReadableDocumentSync(slug, 'share') ?? getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (doc.share_state === 'DELETED') {
    res.status(410).json({ error: 'Document deleted' });
    return;
  }

  const access = await resolveOpenContextAccess(req, res, slug, doc);
  if (!access) return;
  if (doc.share_state === 'REVOKED' && !access.ownerAuthorized) {
    res.status(403).json({ error: 'Document access has been revoked' });
    return;
  }
  if (doc.share_state === 'PAUSED' && !access.ownerAuthorized) {
    res.status(403).json({ error: 'Document is not currently accessible' });
    return;
  }

  const role = access.role;
  const capabilities = deriveShareCapabilities(role, doc.share_state);
  const collabRuntime = getCollabRuntime();
  if (!collabRuntime.enabled) {
    const snapshotUrl = doc.share_state === 'ACTIVE' ? getSnapshotPublicUrl(doc.slug) : null;
    res.json({
      success: true,
      collabAvailable: false,
      snapshotUrl,
      doc: {
        slug: doc.slug,
        docId: doc.doc_id,
        title: doc.title,
        markdown: doc.markdown,
        marks: parseJson(doc.marks),
        shareState: doc.share_state,
        active: doc.share_state === 'ACTIVE',
        createdAt: doc.created_at,
        updatedAt: doc.updated_at,
        viewers: getRoomSize(doc.slug),
      },
      capabilities,
      links: {
        webUrl: buildShareLink(req, doc.slug).shareUrl,
        snapshotUrl,
      },
      collab: collabRuntime,
    });
    return;
  }

  const session = buildCollabSession(slug, role, {
    tokenId: access.tokenId,
    wsUrlBase: resolveRequestScopedCollabWsBase(req),
  });
  if (!session) {
    res.status(500).json({ error: 'Unable to build collab session' });
    return;
  }

  const links = buildShareLink(req, doc.slug);
  res.json({
    success: true,
    doc: {
      slug: doc.slug,
      docId: doc.doc_id,
      title: doc.title,
      markdown: doc.markdown,
      marks: parseJson(doc.marks),
      shareState: doc.share_state,
      // Legacy compatibility for <=0.28 clients.
      active: doc.share_state === 'ACTIVE',
      createdAt: doc.created_at,
      updatedAt: doc.updated_at,
      viewers: getRoomSize(doc.slug),
    },
    session,
    capabilities,
    links: {
      webUrl: links.shareUrl,
      snapshotUrl: doc.share_state === 'ACTIVE' ? getSnapshotPublicUrl(doc.slug) : null,
    },
  });
});

apiRoutes.post('/documents/:slug/collab-refresh', async (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }
  const doc = getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (doc.share_state === 'DELETED') {
    res.status(410).json({ error: 'Document deleted' });
    return;
  }

  const access = await resolveOpenContextAccess(req, res, slug, doc);
  if (!access) return;
  if (doc.share_state === 'REVOKED' && !access.ownerAuthorized) {
    res.status(403).json({ error: 'Document access has been revoked' });
    return;
  }
  if (doc.share_state === 'PAUSED' && !access.ownerAuthorized) {
    res.status(403).json({ error: 'Document is not currently accessible' });
    return;
  }

  const collabRuntime = getCollabRuntime();
  if (!collabRuntime.enabled) {
    res.json({
      collabAvailable: false,
      snapshotUrl: doc.share_state === 'ACTIVE' ? getSnapshotPublicUrl(doc.slug) : null,
    });
    return;
  }

  const role = access.role;
  const session = buildCollabSession(slug, role, {
    tokenId: access.tokenId,
    wsUrlBase: resolveRequestScopedCollabWsBase(req),
  });
  if (!session) {
    res.status(500).json({ error: 'Unable to build collab session' });
    return;
  }
  res.json({
    success: true,
    session,
    capabilities: deriveShareCapabilities(role, doc.share_state),
  });
});

apiRoutes.get('/documents/:slug/collab-session', async (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }
  const doc = getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (doc.share_state === 'DELETED') {
    res.status(410).json({ error: 'Document deleted' });
    return;
  }
  const access = await resolveOpenContextAccess(req, res, slug, doc);
  if (!access) return;
  if ((doc.share_state === 'PAUSED' || doc.share_state === 'REVOKED') && !access.ownerAuthorized) {
    res.status(403).json({ error: 'Document is not currently accessible' });
    return;
  }

  const collabRuntime = getCollabRuntime();
  if (!collabRuntime.enabled) {
    res.json({
      collabAvailable: false,
      snapshotUrl: doc.share_state === 'ACTIVE' ? getSnapshotPublicUrl(doc.slug) : null,
    });
    return;
  }

  const role = access.role;

  const canRead = true;
  const canEdit = role === 'owner_bot'
    ? (doc.share_state === 'ACTIVE' || doc.share_state === 'PAUSED')
    : (role === 'editor' && doc.share_state === 'ACTIVE');
  const canComment = doc.share_state === 'ACTIVE'
    && (role === 'commenter' || role === 'editor' || role === 'owner_bot');

  const session = buildCollabSession(slug, role, {
    tokenId: access.tokenId,
    wsUrlBase: resolveRequestScopedCollabWsBase(req),
  });
  if (!session) {
    res.status(500).json({ error: 'Unable to build collab session' });
    return;
  }

  res.json({
    success: true,
    session,
    capabilities: {
      canRead,
      canComment,
      canEdit,
    },
  });
});
