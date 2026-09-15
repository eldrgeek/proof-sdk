# Self-hosting settings reference

Environment variables read by the Proof SDK server (`server/`). Defaults and behavior below come from the code cited in parentheses.

For local development, see [README.md](../README.md). This document targets a single-node deployment behind a TLS reverse proxy.

## Minimal example (nginx + TLS)

`npm run serve` starts one HTTP server on `PORT` (default `4000`) with collaboration multiplexed on `/ws` (`startCollabRuntimeEmbedded` in `server/index.ts`). Bridge WebSockets use the same path; collab clients are routed when the query string includes `collab=1` or `role` (`setupWebSocket` in `server/ws.ts`).

```nginx
# /etc/nginx/sites-available/proof
upstream proof_app {
    server 127.0.0.1:4000;
    keepalive 32;
}

server {
    listen 443 ssl http2;
    server_name proof.example.com;

    # ssl_certificate ...;
    # ssl_certificate_key ...;

    location / {
        proxy_pass http://proof_app;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # Collaboration and bridge WebSockets (path /ws)
    location /ws {
        proxy_pass http://proof_app;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Example environment (systemd `EnvironmentFile`, Docker env, etc.):

```bash
PORT=4000
NODE_ENV=production
PROOF_ENV=production

PROOF_PUBLIC_BASE_URL=https://proof.example.com
PROOF_PUBLIC_ORIGIN=https://proof.example.com
PROOF_TRUST_PROXY_HEADERS=true

PROOF_SHARE_MARKDOWN_AUTH_MODE=api_key
PROOF_SHARE_MARKDOWN_API_KEY=replace-with-a-long-random-secret
PROOF_LEGACY_CREATE_MODE=warn

DATABASE_PATH=/var/lib/proof/proof-share.db
PROOF_COLLAB_SIGNING_SECRET=replace-with-another-long-random-secret
COLLAB_EMBEDDED_WS=true
```

Build the editor bundle before serving share pages: `npm run build`. See [Known issues](#known-issues-when-self-hosting) for static asset serving.

Check `/health` after start; `collab.enabled` should be `true` and `collab.wsUrlBase` should be a `wss://` URL ending in `/ws` when `PROOF_PUBLIC_BASE_URL` is HTTPS (`getCollabRuntime` / `resolveEmbeddedWsUrlBase` in `server/collab.ts`).

---

## Environment variables

### Basics (port, database, environment)

| Variable | Default | What it does | When required | Wrong / missing symptom |
|----------|---------|--------------|---------------|-------------------------|
| `PORT` | `4000` | HTTP listen port for `npm run serve` (`main` in `server/index.ts`). | Set when the process cannot bind to 4000 or the reverse proxy targets another port. | Server fails to start or proxy returns connection errors. |
| `NODE_ENV` | Node default (`development` if unset) | Feeds runtime environment normalization and share HTML caching (`getRuntimeEnvironment` in `server/db.ts`, `shareWebRoutes` handler in `server/share-web-routes.ts`). | Set `production` for production deployments. | Non-production: share HTML is re-read from disk on every request (`shouldReloadShareHtml` in `server/share-web-routes.ts`). |
| `PROOF_ENV` | Falls back to `NODE_ENV`, then `development` (`getRuntimeEnvironment` in `server/db.ts`, `getRuntimeEnvironment` in `server/build-info.ts`). | Primary deployment environment label (`development`, `production`, `staging`, `test`). | Set explicitly when `NODE_ENV` does not match the deployment (e.g. `PROOF_ENV=production` with `NODE_ENV=production`). | Environment mismatch with an existing database blocks writes (`assertDatabaseEnvironmentCompatibility` in `server/db.ts`). |
| `DATABASE_PATH` | `proof-share.db` next to the repo root (`getDb` in `server/db.ts`). | SQLite database file path. | Required when the default path is not writable or not persistent. | Server cannot open DB; startup error from `getDb`. |
| `PROOF_DB_ENV_INIT` | unset | One-time label written into DB metadata when the DB has no environment key (`readOrInitializeDatabaseEnvironment` in `server/db.ts`). | Required once when upgrading an old DB that lacks environment metadata. | Startup throws: `Existing database is missing ... metadata` (`readOrInitializeDatabaseEnvironment` in `server/db.ts`). |
| `ALLOW_CROSS_ENV_WRITES` | off (`isCrossEnvironmentWriteOverrideEnabled` in `server/db.ts`) | Allows writes when runtime environment differs from the DB label (`assertDatabaseEnvironmentCompatibility` in `server/db.ts`). | Only for intentional cross-environment recovery. | Without it, environment mismatch blocks startup or writes with `environment mismatch` error. |
| `PROOF_CORS_ALLOW_ORIGINS` | `http://localhost:3000`, `http://127.0.0.1:3000`, `http://localhost:4000`, `http://127.0.0.1:4000`, `null` (`parseAllowedCorsOrigins` in `server/index.ts`). | Comma-separated allowed `Origin` values for CORS. | Required when the browser UI is served from an origin not in the default list. | Browser API calls blocked by CORS (no `Access-Control-Allow-Origin`). |
| `HOSTNAME` | OS hostname | Fallback collab instance id when Railway ids are absent (`ACTIVE_COLLAB_INSTANCE_ID` in `server/collab.ts`). | Not required. | Affects instance identity in collab connection tracking only. |

### Public URLs and proxying

| Variable | Default | What it does | When required | Wrong / missing symptom |
|----------|---------|--------------|---------------|-------------------------|
| `PROOF_PUBLIC_BASE_URL` | Derived from request host / proxy headers (`getPublicBaseUrl` in `server/public-base-url.ts`, `server/routes.ts`, `server/discovery-routes.ts`). | Canonical HTTPS/HTTP origin for share links, OAuth challenges, discovery, and embedded collab `wsUrlBase` derivation (`resolveEmbeddedWsUrlBase` in `server/collab.ts`). | Required behind a reverse proxy when the app must generate correct absolute URLs. | Share links, collab `wsUrlBase`, and discovery URLs point at the wrong host or `http` instead of `https`. |
| `PROOF_PUBLIC_ORIGIN` | Derived from request (`getPublicOrigin` in `server/share-web-routes.ts`, `server/share-preview.ts`). | Origin used in share HTML and preview rendering. | Set when share pages must embed a fixed public origin. | OG tags and preview links use the internal hostname. |
| `PROOF_TRUST_PROXY_HEADERS` | off (`trustProxyHeaders` in `server/public-base-url.ts`, `server/routes.ts`, `server/discovery-routes.ts`, `server/bridge.ts`). | Trust `X-Forwarded-Proto` and `X-Forwarded-Host` for public URL and client IP (`getPublicBaseUrl`, `getClientIp` in `server/routes.ts`). | Required behind nginx, Caddy, or similar TLS terminators. | Public URLs stay `http://internal:4000`; rate limits and logs use the proxy IP only if `req.ip` is configured. |

### Document creation and authentication

| Variable | Default | What it does | When required | Wrong / missing symptom |
|----------|---------|--------------|---------------|-------------------------|
| `PROOF_SHARE_MARKDOWN_AUTH_MODE` | `none` (`resolveShareMarkdownAuthMode` in `server/hosted-auth.ts`). | Auth mode for `POST /share/markdown` only (`authorizeDirectShareRequest` in `handleShareMarkdown` in `server/routes.ts`). Values used: `none`, `api_key`, `oauth`, `oauth_or_api_key` (OAuth paths always fail in OSS — `hosted-auth.ts`). Does not protect `POST /documents` or `POST /api/documents` (`apiRoutes.post('/documents', ...)` in `server/routes.ts` does not call `authorizeDirectShareRequest`). | Set `api_key` on any internet-exposed instance. | `none`: anonymous creation via `POST /share/markdown` allowed. |
| `PROOF_SHARE_MARKDOWN_API_KEY` | unset | Shared secret for `api_key` mode; accepted via `Authorization: Bearer` or `x-api-key` (`getDirectShareApiKey`, `authorizeDirectShareRequest` in `server/routes.ts`). | Required when `PROOF_SHARE_MARKDOWN_AUTH_MODE=api_key`. | `503` `DIRECT_SHARE_MISCONFIGURED` when mode is `api_key` and key is missing (`authorizeDirectShareRequest` in `server/routes.ts`). |
| `PROOF_SHARE_MARKDOWN_RATE_LIMIT_MAX_AUTH_PER_MIN` | `120` (`checkDirectShareRateLimit` in `server/routes.ts`). | Per-IP rate limit for authenticated direct-share requests. | Optional tuning. | `429`-style rate limit responses when exceeded (not determined: exact status code). |
| `PROOF_SHARE_MARKDOWN_RATE_LIMIT_MAX_UNAUTH_PER_MIN` | `20` (`checkDirectShareRateLimit` in `server/routes.ts`). | Per-IP rate limit for unauthenticated direct-share requests. | Optional tuning. | Same as above. |
| `PROOF_SHARE_MARKDOWN_RATE_LIMIT_WINDOW_MS` | `60000` (`checkDirectShareRateLimit` in `server/routes.ts`). | Rate limit window length in milliseconds. | Optional tuning. | Same as above. |
| `PROOF_LEGACY_CREATE_MODE` | `auto` → `allow` on loopback public base, else `warn` (`resolveLegacyCreateMode` in `server/agent-guidance.ts`). | Controls `POST /documents` and `POST /api/documents` (`allow`, `warn`, `disabled`, or `auto`). One handler serves both paths (`apiRoutes.post('/documents', ...)` in `server/routes.ts`; mounted at `/api` and root in `server/index.ts`) and checks the mode without inspecting the request path. | Set `disabled` on internet-exposed instances to block unauthenticated creation on those paths (`PROOF_SHARE_MARKDOWN_AUTH_MODE` does not apply to them). | `disabled`: `410` with `LEGACY_CREATE_DISABLED` and body `fix: "Use POST /documents"` (`res.status(410).json(buildLegacyCreateDisabledPayload())` in `server/routes.ts`). `warn`: deprecation headers on success. |
| `PROOF_COMMENT_UI_DEFAULT_MODE` | unset | Injects `window.__PROOF_CONFIG__.commentUiDefaultMode` into share HTML (`buildShareRuntimeConfigScript` in `server/share-web-routes.ts`). Values: `legacy`, `v2`, `auto`. | Optional. | Invalid values ignored; config line omitted. |
| `PROOF_OPS_RATE_LIMIT_MAX` | `120` (`server/routes.ts` module init). | Rate limit for ops routes. | Optional tuning. | Requests throttled when exceeded. |
| `PROOF_OPS_RATE_LIMIT_WINDOW_MS` | `60000` (`server/routes.ts` module init). | Ops rate limit window. | Optional tuning. | Same as above. |
| `BRIDGE_RATE_LIMIT_MAX_AUTH_PER_MIN` | `240` (`getRateLimitConfig` in `server/bridge.ts`). | Bridge route rate limit with bridge token. | Optional tuning. | Bridge requests throttled. |
| `BRIDGE_RATE_LIMIT_MAX_UNAUTH_PER_MIN` | `60` (`getRateLimitConfig` in `server/bridge.ts`). | Bridge route rate limit without token. | Optional tuning. | Same as above. |
| `BRIDGE_RATE_LIMIT_WINDOW_MS` | `60000` (`getRateLimitConfig` in `server/bridge.ts`). | Bridge rate limit window. | Optional tuning. | Same as above. |
| `BRIDGE_REQUEST_TIMEOUT_MS` | `10000` (`getBridgeTimeoutMs` in `server/ws.ts`). | Max wait for a browser bridge viewer to answer a bridge request (`sendBridgeRequestToClient` in `server/ws.ts`). | Optional tuning. | `504` bridge timeout (`TIMEOUT` in `server/ws.ts`). |

On an internet-exposed instance, `PROOF_LEGACY_CREATE_MODE=disabled` is currently what stops unauthenticated document creation on `POST /documents` and `POST /api/documents`. `POST /share/markdown` is then the working create route; protect it with `PROOF_SHARE_MARKDOWN_AUTH_MODE=api_key` and `PROOF_SHARE_MARKDOWN_API_KEY`.

### Collaboration runtime — signing, URLs, and modes

| Variable | Default | What it does | When required | Wrong / missing symptom |
|----------|---------|--------------|---------------|-------------------------|
| `PROOF_COLLAB_SIGNING_SECRET` | Ephemeral random 32-byte hex key generated at process start (`collabSigningSecret` in `server/collab.ts`). | HMAC-SHA256 secret for collab session JWTs (`signCollabClaims`, `verifyCollabToken` in `server/collab.ts`). Tokens carry `slug`, `role`, `exp`, `accessEpoch`, `tokenId`, `jti` and are issued by `buildCollabSession` (`server/collab.ts`). | Required for non-local collab when `wsUrlBase` is not loopback (`startCollabRuntimeEmbedded`, `startCollabRuntime`, `startCollabRuntimeAttached` in `server/collab.ts`). | Non-local without secret: collab disabled, `reason`: `PROOF_COLLAB_SIGNING_SECRET is required for non-local collab runtime` (`/health` `collab` field). Local without secret: console warning and ephemeral key (`startCollabRuntimeEmbedded` in `server/collab.ts`). |
| `PROOF_COLLAB_V2` | enabled (any value other than `0`/`false`/`off`/`disabled`) | Master switch for collab runtime (`startCollabRuntimeEmbedded` in `server/collab.ts`). | Set to disable collab entirely. | `collab.enabled: false`, reason `Disabled by PROOF_COLLAB_V2 flag`. |
| `COLLAB_EMBEDDED_WS` | off (`resolveRequestScopedCollabWsBase` in `server/routes.ts`). | When rewriting a loopback runtime `wsUrlBase` to the public origin, keep the same port as the public HTTP URL instead of `port+1` (`resolveRequestScopedCollabWsBase` in `server/routes.ts`). | Set `true` behind a single-port reverse proxy. | Clients may receive a collab WebSocket URL on the wrong port (e.g. `:4001` instead of `:443`). |
| `COLLAB_PUBLIC_BASE_URL` | Derived from `PROOF_PUBLIC_BASE_URL` with `/ws` or `/collab` path, or `ws://localhost:{port}` (`resolveEmbeddedWsUrlBase`, `resolveAttachedWsUrlBase` in `server/collab.ts`). | Public WebSocket base URL returned to clients. | Override when the WS endpoint is on a different host or path than derived defaults. | Collab connections fail or target wrong endpoint. |
| `COLLAB_ATTACH_TO_MAIN_HTTP` | off (`shouldAttachToMainHttpServer` in `server/collab.ts`). | Use HTTP upgrade on the main server at `COLLAB_PATH` instead of a separate collab port (`startCollabRuntimeAttached` in `server/collab.ts`). Not used by default `npm run serve` (`startCollabRuntimeEmbedded` in `server/index.ts`). | Alternative to embedded `/ws` when using `startCollabRuntimeAttached`. | If enabled but attached startup is not used: collab disabled with reason about `COLLAB_ATTACH_TO_MAIN_HTTP` (`startCollabRuntime` in `server/collab.ts`). |
| `COLLAB_PATH` | `/collab` (`startCollabRuntimeAttached` in `server/collab.ts`). | WebSocket upgrade path when `COLLAB_ATTACH_TO_MAIN_HTTP` is used. | Only with attached mode. | Upgrades on wrong path; collab connections fail. |
| `COLLAB_PORT` | `mainHttpPort + 1` (`startCollabRuntime` in `server/collab.ts`). | Separate Hocuspocus listen port in split-port mode. | When running split-port collab (not default `npm run serve`). | Collab listens on unexpected port. |
| `COLLAB_HOST` | `0.0.0.0` (`startCollabRuntime` in `server/collab.ts`). | Bind address for split-port collab. | When collab must listen on a specific interface. | Collab unreachable from proxy or other hosts. |
| `COLLAB_SESSION_TTL_SECONDS` | `300` (`buildCollabSession` in `server/collab.ts`). | Lifetime of signed collab session tokens. | Optional tuning. | Tokens expire sooner or later than expected; reconnect may require new session. |

**Ephemeral signing key:** If `PROOF_COLLAB_SIGNING_SECRET` is unset and collab runs (local `wsUrlBase` only), each process start generates a new random key (`collabSigningSecret` in `server/collab.ts`). That key signs collab session tokens (`signCollabClaims`). After a restart, tokens issued before the restart fail `verifyCollabToken` (`server/collab.ts`), and the WebSocket router closes with `4401` `Invalid or expired collab session token` (`setupWebSocket` in `server/ws.ts`). Users must reload the page or obtain a new collab session.

### Collaboration runtime — startup reconcile and repair

| Variable | Default | What it does | When required | Wrong / missing symptom |
|----------|---------|--------------|---------------|-------------------------|
| `COLLAB_STARTUP_RECONCILE_ENABLED` | `false` (`scheduleStartupProjectionReconcile` in `server/collab.ts`). | Queue projection repair for stale documents on startup. | Enable to heal stale projections after unclean shutdown. | Stale projections remain until the repair worker runs. |
| `COLLAB_STARTUP_RECONCILE_DELAY_MS` | `30000` (`scheduleStartupProjectionReconcile` in `server/collab.ts`). | Delay before startup reconcile runs. | Optional tuning. | Reconcile starts later. |
| `COLLAB_STARTUP_RECONCILE_LIMIT` | `25` (`reconcileStaleProjectionsOnStartup` in `server/collab.ts`). | Max documents reconciled per startup. | Optional tuning. | Fewer docs healed per restart. |
| `COLLAB_PROJECTION_REPAIR_WORKER_ENABLED` | `true` (`scheduleProjectionRepairWorker` in `server/collab.ts`). | Background worker scanning suspicious projections. | Set `false` to disable background repair. | Stale or suspicious projections may persist longer. |
| `COLLAB_PROJECTION_REPAIR_WORKER_DELAY_MS` | `45000` | Initial delay before repair worker starts (`server/collab.ts`). | Optional tuning. | Worker starts later. |
| `COLLAB_PROJECTION_REPAIR_WORKER_INTERVAL_MS` | `120000` | Interval between repair worker scans (`server/collab.ts`). | Optional tuning. | Less frequent repair scans. |
| `COLLAB_PROJECTION_REPAIR_WORKER_LIMIT` | `10` | Max candidates per worker scan (`scanAndQueueSuspiciousProjectionRepairs` in `server/collab.ts`). | Optional tuning. | Fewer docs repaired per cycle. |
| `COLLAB_PROJECTION_REPAIR_WORKER_MIN_CHARS` | `500000` | Minimum markdown size to consider a doc suspicious (`server/collab.ts`). | Optional tuning. | Smaller docs skipped by worker. |
| `COLLAB_PROJECTION_REPAIR_WORKER_SCAN_DELAY_MS` | `0` | Extra delay before each scan (`server/collab.ts`). | Optional tuning. | Scan timing changes. |
| `COLLAB_PROJECTION_REPAIR_WORKER_OVERSIZED_COOLDOWN_MS` | `900000` | Cooldown before re-queuing oversized repair candidates (`server/collab.ts`). | Optional tuning. | Repeated repair attempts delayed. |
| `COLLAB_ON_DEMAND_PROJECTION_REPAIR_ENABLED` | `false` (`isOnDemandProjectionRepairEnabled` in `server/canonical-document.ts`). | Enable on-demand projection repair paths. | Optional feature flag. | On-demand repair not triggered. |
| `COLLAB_PROJECTION_REPAIR_RETRY_SCHEDULE_MS` | `0,500,2000` (comma-separated) | Retry delays for projection repair (`server/collab.ts`). | Optional tuning. | Repair retries change timing. |

### Collaboration runtime — persistence, limits, and guards

| Variable | Default | What it does | When required | Wrong / missing symptom |
|----------|---------|--------------|---------------|-------------------------|
| `COLLAB_PERSIST_READONLY` | off (`isCollabPersistenceReadOnly` in `server/collab.ts`). | Drop collab persistence writes when enabled. | Debugging or read-only replicas. | Document changes from collab are not saved to SQLite. |
| `COLLAB_PERSIST_DEBOUNCE_MS` | `250` (`schedulePersistDoc` in `server/collab.ts`). | Debounce before persisting Yjs updates. | Optional tuning. | More or fewer DB writes; latency to persisted state changes. |
| `COLLAB_COMPACTION_EVERY` | `100` (`server/collab.ts`, `server/canonical-document.ts`). | Yjs update count between compactions. | Optional tuning. | Larger Yjs blobs or more frequent compaction. |
| `COLLAB_COMPACTION_MAX_BYTES` | `500000` | Max bytes before compaction (`server/collab.ts`). | Optional tuning. | Compaction triggers at different sizes. |
| `COLLAB_MAX_UPDATE_BLOB_BYTES` | `8388608` (`getMaxYjsUpdateBlobBytes` in `server/db.ts`). | Max single Yjs update size. | Optional tuning. | `OversizedYjsUpdateError` when exceeded (`assertYjsUpdateWithinLimit` in `server/db.ts`). |
| `COLLAB_MAX_LOADED_DOCS` | `100` | In-memory doc cache size (`server/collab.ts`). | High doc count deployments. | Earlier eviction of loaded docs. |
| `COLLAB_DOC_IDLE_TIMEOUT_MS` | `1800000` | Idle time before evicting a loaded doc (`server/collab.ts`). | Optional tuning. | Docs evicted from memory sooner or later. |
| `COLLAB_DOC_EVICTION_INTERVAL_MS` | `300000` | How often eviction runs (`server/collab.ts`). | Optional tuning. | Eviction frequency changes. |
| `COLLAB_MAX_SLUG_YJS_WINDOW_MS` | `600000` | Window for per-slug Yjs byte rate limiting (`server/collab.ts`). | Optional tuning. | Rate limit window changes. |
| `COLLAB_MAX_SLUG_YJS_BYTES_PER_WINDOW` | `33554432` | Max Yjs bytes per slug per window (`server/collab.ts`). | Optional tuning. | Large collab sessions may be throttled or rejected (exact response not determined). |
| `COLLAB_DIRECT_CONNECTION_TIMEOUT_MS` | `5000` | Direct connection timeout (`server/collab.ts`). | Optional tuning. | Connections time out sooner or later. |
| `COLLAB_LIVE_DOC_REGISTRATION_GRACE_MS` | not determined | Grace period for live doc registration (`server/collab.ts`). | Optional tuning. | Live doc registration timing changes. |
| `COLLAB_LIVE_DOC_REGISTRATION_POLL_MS` | not determined | Poll interval during live doc registration (`server/collab.ts`). | Optional tuning. | Same as above. |
| `DOCUMENT_LIVE_COLLAB_LEASE_HEARTBEAT_MS` | `15000` | Heartbeat for live collab leases (`server/collab.ts`). | Optional tuning. | Lease expiry behavior changes. |
| `DOCUMENT_LIVE_COLLAB_LEASE_TTL_MS` | `45000` (`getDocumentLiveCollabLeaseTtlMs` in `server/db.ts`). | TTL for document live collab leases. | Optional tuning. | Agent edits may see `LIVE_DOC_UNAVAILABLE` sooner or later. |
| `ACTIVE_COLLAB_CONNECTION_TTL_MS` | `45000` (`getActiveCollabConnectionTtlMs` in `server/db.ts`). | TTL for active collab connection records. | Optional tuning. | Connection counts for live-doc gates change. |
| `COLLAB_INVALIDATION_COOLDOWN_MS` | `1000` (`releaseCollabInvalidation` in `server/collab.ts`). | Cooldown after collab invalidation. | Optional tuning. | Invalidation window length changes. |
| `COLLAB_SINGLE_WRITER_EDIT` | off (`isSingleWriterEditEnabled` in `server/collab-mutation-coordinator.ts`). | Enable single-writer edit coordination. | Multi-writer conflict tuning. | Default multi-writer collab behavior. |
| `PROOF_COLLAB_HOT_SLUG_DENYLIST` | empty | Comma-separated slugs denied hot collab paths (`getHotSlugDenylist` in `server/collab.ts`). | Block specific documents from collab. | Listed slugs blocked from collab (exact behavior not determined). |

Projection guard, admission guard, stale-on-store, repair loop breaker, and related `COLLAB_*` tuning variables in `server/collab.ts` default to the `DEFAULT_*` constants at lines 713–772 of `server/collab.ts`. They are optional; change them only when diagnosing projection pathology, repair storms, or admission quarantine behavior.

### Agent edits, mutations, and rewrites

| Variable | Default | What it does | When required | Wrong / missing symptom |
|----------|---------|--------------|---------------|-------------------------|
| `AGENT_EDIT_V2_ENABLED` | enabled (empty or truthy) (`isFeatureEnabled` in `server/agent-routes.ts`). | Gates edit v2 routes (`server/agent-routes.ts`). | Set `0`/`false` to disable v2 edit paths. | v2 edit endpoints unavailable. |
| `AGENT_EDIT_ANCHOR_V2_ENABLED` | `true` (`isAgentEditAnchorV2Enabled` in `server/anchor-resolver.ts`). | Anchor resolution v2 for agent edits. | Optional. | Falls back when set false (behavior not determined). |
| `AGENT_EDIT_FAIL_CLOSED_DUPLICATES` | `true` (`isFailClosedDuplicateHandlingEnabled` in `server/anchor-resolver.ts`). | Fail-closed duplicate anchor handling. | Optional. | Duplicate handling behavior changes. |
| `EDIT_STRUCTURAL_CLEANUP_ENABLED` | `true` in production/staging hosted env, else `false` (`isStructuralCleanupEnabled` in `server/anchor-resolver.ts`). | Structural cleanup during edits. | Optional. | Cleanup skipped when false. |
| `EDIT_AUTHORED_SPAN_REMAP_ENABLED` | `true` (`isAuthoredSpanRemapEnabled` in `server/anchor-resolver.ts`). | Authored span remapping. | Optional. | Remap behavior disabled when false. |
| `PROOF_MUTATION_CONTRACT_STAGE` | `A` (`getMutationContractStage` in `server/mutation-stage.ts`). | Mutation precondition stage (`A`, `B`, or `C`). | Set when clients use stage B/C contracts. | Wrong precondition errors (`MISSING_BASE`, `BASE_REVISION_REQUIRED`, etc. in `server/mutation-stage.ts`). |
| `PROOF_MUTATION_COORDINATOR_ENABLED` | off (`isMutationCoordinatorEnabled` in `server/mutation-coordinator.ts`). | Mutation coordinator adapter. | Optional feature flag. | Coordinator routing disabled. |
| `PROOF_IDEMPOTENCY_PENDING_LEASE_MS` | `30000` (`server/mutation-idempotency.ts`). | Pending idempotency lease duration. | Stage B/C deployments. | Duplicate idempotency handling window changes. |
| `PROOF_REWRITE_COLLAB_TIMEOUT_MS` | `3000` (`server/agent-routes.ts`, `server/agent-edit-v2.ts`). | Timeout waiting for collab during rewrites. | Optional tuning. | `COLLAB_SYNC_FAILED` or rewrite timeouts sooner. |
| `PROOF_REWRITE_BARRIER_TIMEOUT_MS` | `5000` (`server/agent-routes.ts`, `server/bridge.ts`). | Rewrite barrier wait timeout. | Optional tuning. | `REWRITE_BARRIER_FAILED` responses. |
| `AGENT_EDIT_COLLAB_STABILITY_MS` | `2500` | Wait for collab stability after edits (`server/agent-routes.ts`). | Optional tuning. | Edits may proceed before collab settles. |
| `AGENT_EDIT_COLLAB_STABILITY_SAMPLE_MS` | `100` | Poll interval during stability wait (`server/agent-routes.ts`). | Optional tuning. | Sampling frequency changes. |
| `AGENT_EDIT_ACTIVE_COLLAB_SETTLE_MS` | `300` | Active collab settle wait (`server/agent-routes.ts`). | Optional tuning. | Settle timing changes. |
| `AGENT_EDIT_ACTIVE_COLLAB_SETTLE_SAMPLE_MS` | `50` | Sample interval for settle wait (`server/agent-routes.ts`). | Optional tuning. | Same as above. |
| `AGENT_EDIT_ACTIVE_COLLAB_MIN_WAIT_MS` | `150` | Minimum wait for active collab (`server/agent-routes.ts`). | Optional tuning. | Same as above. |
| `AGENT_EDIT_V2_COLLAB_TIMEOUT_MS` | `3000` | Edit v2 collab timeout (`server/agent-edit-v2.ts`). | Optional tuning. | v2 edit collab timeouts. |
| `AGENT_EDIT_V2_COLLAB_STABILITY_MS` | `2500` | Edit v2 stability wait (`server/agent-edit-v2.ts`). | Optional tuning. | Same as above. |
| `AGENT_EDIT_V2_COLLAB_STABILITY_SAMPLE_MS` | `100` | Edit v2 stability sample (`server/agent-edit-v2.ts`). | Optional tuning. | Same as above. |
| `AGENT_EDIT_V2_BARRIER_TIMEOUT_MS` | `5000` | Edit v2 barrier timeout (`server/agent-edit-v2.ts`). | Optional tuning. | v2 barrier failures. |
| `HOSTED_LIVE_DOC_GRACE_MS` | `1500` (`server/canonical-document.ts`, `server/agent-edit-v2.ts`). | Grace wait for live doc availability. | Optional tuning. | `LIVE_DOC_UNAVAILABLE` on edits sooner. |
| `HOSTED_LIVE_DOC_GRACE_POLL_MS` | `100` | Poll interval during live doc grace (`server/canonical-document.ts`). | Optional tuning. | Poll frequency changes. |
| `AGENT_PRESENCE_TTL_MS` | `60000` (`pruneExpiredAgentEphemera` in `server/collab.ts`). | TTL for agent presence in Yjs. | Optional tuning. | Presence expires sooner or later. |
| `AGENT_CURSOR_TTL_MS` | `3000` | TTL for agent cursor hints (`server/collab.ts`). | Optional tuning. | Cursor hints expire sooner or later. |
| `AGENT_EDIT_CANONICAL_DIAGNOSTICS` | off | Extra diagnostics logging (`server/agent-routes.ts`). | Debugging only. | More log output when enabled. |
| `MARK_TOMBSTONE_RETENTION_DAYS` | `35` (`server/db.ts`). | Retention for mark tombstones. | Optional tuning. | Tombstones pruned later or sooner. |
| `SHARE_SKIP_MARK_RANGE_BACKFILL` | off | Skip mark range backfill when `1` (`server/marks-range-backfill.ts`). | Debugging or migration. | Backfill skipped. |

### Snapshots and object storage

| Variable | Default | What it does | When required | Wrong / missing symptom |
|----------|---------|--------------|---------------|-------------------------|
| `SNAPSHOT_DIR` | `snapshots/` under repo root (`server/snapshot.ts`). | Local directory for snapshot HTML files. | When not using S3. | Snapshots written to unexpected path. |
| `SNAPSHOT_PUBLIC_BASE_URL` | unset | Public base for snapshot URLs (`server/snapshot.ts`). | When snapshots are served from external storage. | Snapshot links missing or wrong (not determined). |
| `SNAPSHOT_PUBLIC_URL_TEMPLATE` | unset | URL template for snapshots (`server/snapshot.ts`). | Custom snapshot URL scheme. | Template not applied when unset. |
| `SNAPSHOT_S3_BUCKET` | unset | S3 bucket for snapshot upload (`getUploadConfig` in `server/snapshot.ts`). | Required for S3 snapshot publishing. | Upload skipped; local snapshots only. |
| `SNAPSHOT_S3_REGION` | `auto` | S3 region (`server/snapshot.ts`). | With S3 upload. | Wrong region errors from S3. |
| `SNAPSHOT_S3_ENDPOINT` | unset | Custom S3 endpoint (e.g. R2, MinIO) (`server/snapshot.ts`). | Non-AWS S3-compatible storage. | Cannot reach object storage. |
| `SNAPSHOT_S3_ACCESS_KEY_ID` | unset | S3 access key (`server/snapshot.ts`). | When bucket requires credentials. | Upload fails. |
| `SNAPSHOT_S3_SECRET_ACCESS_KEY` | unset | S3 secret key (`server/snapshot.ts`). | When bucket requires credentials. | Upload fails. |
| `SNAPSHOT_S3_PREFIX` | empty | Key prefix inside the bucket (`server/snapshot.ts`). | Optional organization. | Objects stored at bucket root. |
| `SNAPSHOT_S3_FORCE_PATH_STYLE` | off (`=== '1'`) | Path-style S3 URLs (`getS3Client` in `server/snapshot.ts`). | Some S3-compatible providers. | Virtual-hosted-style requests fail. |

### Bug reporting and GitHub integration

| Variable | Default | What it does | When required | Wrong / missing symptom |
|----------|---------|--------------|---------------|-------------------------|
| `PROOF_GITHUB_ISSUES_TOKEN` | unset | GitHub API token for bug report filing (`server/bug-reporting.ts`). | Required to file GitHub issues from bug reports. | Bug reports cannot create GitHub issues (not determined: exact error). |
| `PROOF_GITHUB_ISSUES_OWNER` | `EveryInc` (`server/bug-reporting.ts`, `server/report-bug-bridge.ts`). | GitHub repo owner for issues. | Override for your fork. | Issues filed against wrong org. |
| `PROOF_GITHUB_ISSUES_REPO` | `proof` | GitHub repo name for issues (`server/bug-reporting.ts`). | Override for your fork. | Issues filed against wrong repo. |
| `PROOF_GITHUB_TOKEN_SCHEME` | not determined | Token scheme for GitHub API (`server/bug-reporting.ts`). | not determined | not determined |
| `PROOF_GITHUB_ISSUE_COMMENT_RETRY_DELAY_MS` | `400` (`server/bug-reporting.ts`). | Delay between GitHub comment retries. | Optional tuning. | Retries spaced differently. |
| `PROOF_APPSIGNAL_DASHBOARD_URL` | unset | AppSignal dashboard link in bug reports (`server/bug-reporting.ts`). | Optional monitoring integration. | Link omitted from reports. |

### Build metadata (usually automatic)

| Variable | Default | What it does | When required | Wrong / missing symptom |
|----------|---------|--------------|---------------|-------------------------|
| `PROOF_BUILD_SHA` | unset | Build SHA fallback (`resolveRuntimeBuildSha` in `server/build-info.ts`). | CI/CD labeling. | `/health` `buildInfo.sha` null unless other SHA env set. |
| `GITHUB_SHA` | unset | CI SHA (`server/build-info.ts`). | Set by GitHub Actions. | Same as above. |
| `COMMIT_SHA` | unset | Generic CI SHA (`server/build-info.ts`). | Set by CI. | Same as above. |
| `RAILWAY_GIT_COMMIT_SHA` | unset | Railway deploy SHA (`server/build-info.ts`, `server/rewrite-policy.ts`). | Set on Railway. | Also toggles hosted-runtime detection in rewrite policy. |

Railway-specific variables (`RAILWAY_ENVIRONMENT`, `RAILWAY_ENVIRONMENT_NAME`, `RAILWAY_PROJECT_ID`, `RAILWAY_SERVICE_ID`, `RAILWAY_DEPLOYMENT_ID`, `RAILWAY_REPLICA_ID`, `RAILWAY_STATIC_URL`) are read in `server/rewrite-policy.ts` and `server/build-info.ts` to detect hosted Railway deployments. Self-hosters normally leave them unset.

### Debug and test flags

These are for development and tests only. Do not set in production unless you intend the behavior.

| Variable | Effect (code location) |
|----------|------------------------|
| `PROOF_REWRITE_BARRIER_FORCE_FAIL=1` | Forces rewrite barrier failure (`server/routes.ts`, `server/bridge.ts`). |
| `COLLAB_DEBUG_ONCONNECT=1` | Extra on-connect logging (`server/collab.ts`). |
| `COLLAB_DEBUG_FRAGMENT_CONVERGENCE=1` | Fragment convergence debug (`server/collab.ts`, `server/agent-routes.ts`). |
| `COLLAB_DEBUG_FORENSIC=1` | Include snippets in forensic logs (`server/collab.ts`). |
| `COLLAB_FORCE_DERIVE_FRAGMENT_MARKDOWN_FAILURE=1` | Force fragment markdown derivation failure (`server/collab.ts`). |
| `PROOF_TEST_EDIT_V2_POST_COMMIT_DELAY_MS` | Artificial delay in edit v2 tests (`server/agent-routes.ts`). |

### Client build settings (`VITE_*`)

These are read at **build time** by the Vite frontend, not by the Node server.

| Variable | Default | What it does | When required | Wrong / missing symptom |
|----------|---------|--------------|---------------|-------------------------|
| `VITE_APP_VERSION` | `dev` if unset (`src/analytics/telemetry.ts`). | Version string bound into the client bundle. | Optional labeling. | Version reported as `dev`. |
| `VITE_ENABLE_TELEMETRY` | documented in `.env.example` only | Listed in `.env.example`. OSS `isTelemetryEnabled()` always returns `false` (`src/analytics/telemetry.ts`). | not determined | No telemetry is sent in OSS regardless of this value (`captureEvent` is a no-op in `src/analytics/telemetry.ts`). |

Rebuild with `npm run build` after changing `VITE_*` variables.

---

## Known issues when self-hosting

### Static assets from `dist/` are not served by default ([#52](https://github.com/EveryInc/proof-sdk/issues/52), [#73](https://github.com/EveryInc/proof-sdk/issues/73))

`npm run serve` serves `public/` only (`express.static` in `server/index.ts`). Share pages load HTML from `dist/index.html` (`shareWebRoutes` in `server/share-web-routes.ts`), but hashed bundles under `dist/assets/` are not automatically exposed.

**Workaround:** after `npm run build`, copy built assets into the served tree:

```bash
mkdir -p public/assets
cp -R dist/assets/. public/assets/
```

Upstream [PR #55](https://github.com/EveryInc/proof-sdk/pull/55) and [PR #30](https://github.com/EveryInc/proof-sdk/pull/30) address serving `dist/` directly.

### Share page returns 500 "Editor not built" ([#52](https://github.com/EveryInc/proof-sdk/issues/52))

If `dist/index.html` is missing, share routes respond with `500` and the text `Editor not built. Run: npm run build` (`shareWebRoutes` in `server/share-web-routes.ts`). Run `npm run build` before serving.

### `POST /documents` and `POST /api/documents` are not protected by `PROOF_SHARE_MARKDOWN_AUTH_MODE`

The document-create handler does not call `authorizeDirectShareRequest` (`apiRoutes.post('/documents', ...)` in `server/routes.ts`). Only `POST /share/markdown` enforces `PROOF_SHARE_MARKDOWN_AUTH_MODE` (`handleShareMarkdown` in `server/routes.ts`). On an internet-exposed instance, set `PROOF_LEGACY_CREATE_MODE=disabled` to block unauthenticated creation on `POST /documents` and `POST /api/documents` (both return `410` `LEGACY_CREATE_DISABLED`). Use `POST /share/markdown` with `PROOF_SHARE_MARKDOWN_AUTH_MODE=api_key` as the authenticated create route.

### Other tracked issues

- [#43](https://github.com/EveryInc/proof-sdk/issues/43) — general self-hosting discussion and reports.
- [#47](https://github.com/EveryInc/proof-sdk/issues/47) / [PR #65](https://github.com/EveryInc/proof-sdk/pull/65) — documents whose markdown is not a round-trip fixed point can be marked `PROJECTION_STALE` (projection drift handling in `server/collab.ts`).

## Proof+ SOMA integration

Enable `PROOF_LIBRARY_ENABLED=1` and `PROOF_SOMA_AUTH_ENABLED=1` to use the shared SOMA account for the document library. Set `SOMA_AUTH_URL` and the public `SOMA_AUTH_ANON_KEY`. The library offers magic links and Google. The reference browser runtime is copied verbatim from `legends-membership-site/js/soma-auth.js`; its Proof+ config enables those two methods. Supabase's UMD bundle is pinned to 2.57.4.

The operator must register the site's redirect URL and the `proof-plus` / global `*` administrator roles in SOMA Auth before enabling production sign-in. This repository does not configure Supabase. Administrators are verified with `is_app_admin`; an active `library_members` row admits other members. Add members by name and email in People, or with `npm run library -- add-member --name 'Name' --email person@example.com`. The CLI also retains `list-members`, `remove-member`, `archive`, and `unarchive`. Local `--owner` is a legacy flag and does not grant SOMA administrator authority.

SOMA tokens stay in the browser. The server verifies them remotely and stores only a hashed Proof+ session identifier and a dated role result. After 24 hours, administrator authority expires until the browser supplies a fresh token for verification. The browser schedules that check at the server's lease deadline. A failed check cannot extend administrator authority. Successful daily checks slide the existing 180-day Proof+ session. A removed administrator may remain an ordinary member if they have an active library membership.

`PROOF_FEEDBACK_ENABLED=1` independently enables the vendored chip and the two same-origin endpoints. `SOMA_FEEDBACK_ENDPOINT` defaults to `http://127.0.0.1:4252/feedback`. Set the server-only `SOMA_ADMIN_TOKEN` to route verified administrators' feedback as admin submissions. Client credentials are stripped; automatic error reports never carry admin credentials. `GET /api/soma-feedback?health=1` makes a non-writing empty-body probe of the upstream service. A failed submission returns visible JSON with status 502.

The canonical feedback assets are v4.1 (2026-08-07), copied verbatim on 2026-09-15 from `SOMA/standards/soma-feedback/`. Run `scripts/sync-soma-feedback.sh` to refresh, or add `--check` to detect drift. Override `SOMA_FEEDBACK_SOURCE` to read another checkout of the canonical directory.

Error reports contain bounded diagnostic strings, page paths, and the build identifier; they do not collect editor state, document content, DOM text, or console argument objects. URL queries and fragments are removed. `client_errors` holds one aggregate per signature for a 30-minute window, with counts and a sample. Only the first occurrence is forwarded in that window. If forwarding fails, the local record remains, and the banner does not claim delivery; no automatic retry is made within that window. Browser reporting is capped at five per page load; the server allows 20 per client address per 10 minutes. Session exchanges allow ten per client address per 10 minutes.

Behind a trusted reverse proxy, set `PROOF_TRUST_PROXY_HEADERS=1` and have nginx overwrite `X-Forwarded-For` with the client's address (`proxy_set_header X-Forwarded-For $remote_addr;`). Session, error-report, and share limiters use the same address resolver.

With SOMA auth disabled, the legacy web sign-in and device-link paths remain available for rollback. With SOMA auth enabled they return 404. The obsolete `signin-link` CLI command is removed in both modes. With feedback disabled, the chip, proxy, and error reporting are absent. Document URLs remain open under the existing sharing rules; library membership adds the member name, back link, and protected POST visits.
