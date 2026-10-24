# Accord

**This fork is Accord, built on the open-source Proof SDK.** It is not the hosted Proof
service operated by Every. Accord is the name of the standard, the editor, and each document:
a document is "an Accord", and a document's group of people is an Accord Team. The upstream
open-source project keeps its own name, `Proof SDK`; see [TRADEMARKS.md](TRADEMARKS.md).

Every user-facing product string comes from one module, `src/shared/product-identity.ts`, so a
later rename is a config change rather than a sweep. Nothing machine-visible (API paths,
headers, field names, event types, error codes, table names, slugs, routes, CSS classes, test
selectors) carries the product name.

## Proof SDK

Proof SDK is the open-source editor, collaboration server, provenance model, and agent HTTP bridge that power collaborative documents in Proof.

If you want the hosted product, use [Proof](https://proofeditor.ai). Hosted Proof is made by [Every](https://every.to).

## What Is Included

- Collaborative markdown editor with provenance tracking
- Comments, suggestions, and rewrite operations
- Realtime collaboration server
- Agent HTTP bridge for state, marks, edits, presence, and events
- A small example app under `apps/proof-example`

## Workspace Layout

- `packages/doc-core`
- `packages/doc-editor`
- `packages/doc-server`
- `packages/doc-store-sqlite`
- `packages/agent-bridge`
- `apps/proof-example`
- `server`
- `src`

## Local Development

Requirements:

- Node.js 18+

Install dependencies:

```bash
npm install
```

Start the editor:

```bash
npm run dev
```

Start the local server:

```bash
npm run serve
```

The default setup serves the editor on `http://localhost:3000` and the API/server on `http://localhost:4000`.

For production self-hosting (environment variables, reverse proxy, WebSockets), see [docs/self-hosting.md](docs/self-hosting.md).

## Core Routes

Canonical Proof SDK routes:

- `POST /documents`
- `GET /documents/:slug/state`
- `GET /documents/:slug/snapshot`
- `POST /documents/:slug/edit`
- `POST /documents/:slug/edit/v2`
- `POST /documents/:slug/ops`
- `POST /documents/:slug/presence`
- `GET /documents/:slug/events/pending`
- `POST /documents/:slug/events/ack`
- `GET /documents/:slug/bridge/state`
- `GET /documents/:slug/bridge/marks`
- `POST /documents/:slug/bridge/comments`
- `POST /documents/:slug/bridge/suggestions`
- `POST /documents/:slug/bridge/rewrite`
- `POST /documents/:slug/bridge/presence`

Compatibility aliases remain mounted for the hosted product, but the routes above are the public SDK surface.

## Build

```bash
npm run build
```

The build outputs the web bundle to `dist/` and writes `dist/web-artifact-manifest.json`.

## Tests

```bash
npm test
```

## Docs

- `AGENT_CONTRACT.md`
- `docs/agent-docs.md`
- `docs/proof.SKILL.md`
- `docs/adr/2026-03-proof-sdk-public-core.md`

## License

- Code: `MIT` in `LICENSE`
- Trademark guidance: `TRADEMARKS.md`

### Agent presence in the share bar

AI avatars stay visible for 15 minutes after the last action. After one minute
without activity, the avatar dims and its tooltip shows the minutes since the
last action. A new action makes it active again. Set the server environment
variable `AGENT_PRESENCE_TTL_MS` to a positive number of milliseconds to override
the 15-minute retention period; the server sends that expiry to connected clients.
An agent can leave immediately by posting to `POST /api/agent/:slug/presence`
with its usual authentication and identity and `status: "left"`, for example
`{"agentId":"ai:claude","status":"left"}`. Leaving also removes its cursor.
