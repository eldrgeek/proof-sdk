# Verso in Proof+

`POST /api/documents/:slug/verso` accepts `{ messages: [{ role, content }], mark? }` and returns `{ reply, proposals }`. It requires page editing access, JSON, and the configured public Origin. Unresolved presented credentials are rejected, including duplicate document cookies. Proposals do not mutate the document.

Startup reads only `ANTHROPIC_API_KEY` from the colon-separated `PROOF_VERSO_CRED_FILES` list (default `/opt/soma-infer/.env`). An empty list disables credential-file reads. No key leaves Verso unavailable. Imports and unit tests never load credentials.

`PROOF_VERSO_MODEL` defaults to `claude-haiku-4-5`. `PROOF_VERSO_DAILY_CAP` defaults to 300. The UTC daily counter is `verso-daily.json` in `PROOF_DATA_DIR`, or the database directory. It is written atomically with mode 600 and guarded by an exclusive lock across processes. Invalid counters and lock contention fail closed. If a server is killed while holding the lock, remove its stale `verso-daily.json.lock` after verifying no server still owns it. Address and document limits are 20 and 30 calls per minute per process.

Cost logs include only model, numeric token usage, and estimated USD. Unknown model prices produce `null`. The persona and document are cacheable system blocks using Anthropic's [prompt caching protocol](https://platform.claude.com/docs/en/build-with-claude/prompt-caching). The document is capped at 60,000 characters around the selected quote; conversation context is capped at 20 messages / 16,000 characters.

## Checks

`npx tsx src/tests/u2-verso.test.ts` uses a fake client and a fake credential reader. `npx tsx src/tests/u2-verso.browser.test.ts` uses a local server and fake responses.

The COS may run one live smoke on the VPS with `PROOF_VERSO_LIVE_SMOKE=1`, `PROOF_PUBLIC_ORIGIN`, and `PROOF_VERSO_SMOKE_SLUG` pointing to a disposable document, then `npx tsx src/tests/u2-verso-live.test.ts`. The script prints neither credentials nor reply text.
