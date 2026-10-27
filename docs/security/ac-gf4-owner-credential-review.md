# ac-gf4: owner credential actor-confusion review

Status: **read-only security review and proposal; no policy or runtime code changed.**

Reviewed 2026-10-27 against local ref `origin/deploy/vps` at `c3b62db` (the requested live-build ref). Line numbers below are from that commit.

## Decision for Mike

**Recommendation: an owner credential must never create a record attributed to a human. It may act only as an explicitly named `ai:*` actor. A human-attributed answer, mark, chat message, decision, or other participation record must come from that human's verified, same-origin signed-in session. When automation needs to report for a person, it must use the existing explicit proxy-mark model rather than write as the person.**

This is the smallest control with a clean trust invariant. It closes the immediate impersonation path in one central function without removing the owner credential's authorization to administer the document or without changing agent-key behavior. It deliberately does not infer that possession of an owner secret proves the owner's human identity: the secret is a bearer automation credential, may be stored on a server, and is not a user session.

Mike's one decision is therefore: **approve or reject “owner bearer credentials are AI-only for attribution; human attribution requires that human's session (or an explicit proxy record).”**

## Finding and blast radius

Severity: **high integrity risk, bounded by document and credential access**. No misuse was reported or found in the supplied evidence.

`src/shared/identity.ts:25-36` defines `IDENTITY_POLICY`; line 36 sets `ownerCredentialMayActAsAnyone: true`. The only runtime read found is `server/identity.ts:84`. At lines 84-87, `decideActor` accepts the request's arbitrary `typedBy`, normalizes it, assigns its trust from the prefix, and returns it as `source: 'owner-credential'`. Thus `by: human:<email>` becomes a `verified` human even though no human session was presented.

Credential and request flow:

1. Page routes call `resolvePageActor` (`server/routes.ts:2033-2049`), which passes `access.ownerAuthorized` at line 2041.
2. Agent routes call `resolveAgentActor` (`server/agent-routes.ts:3921-3934`), which passes `role === 'owner_bot'` at line 3930.
3. Both reach `decideActor`; an agent key or valid human session wins earlier, but otherwise the owner credential may select any actor.
4. The returned actor is stored in authorship, participation, decision, event, or settings audit fields. Downstream code sees a `human:*` value with `verified` trust and cannot distinguish it from session-authenticated human action.

The credential is document-scoped, so direct writes require possession of that document's owner credential and are limited to routes authorized for its `owner_bot`/owner access. The integrity blast radius within that document is broad: human-attributed line status and tiers, ask answers, chat, objections and flags, discussion, alternatives and picks, dispositions and overruling, settings, suggestions/comments, and lifecycle actions can all affect alignment, team membership, “since you,” audit/event history, and UI trust labels. Exfiltration of multiple stored owner credentials scales the issue across those documents. Existing rows do not carry an authentication-source field, so a forged human row is generally indistinguishable after the request completes.

### Page API routes that accept an owner-selected actor

All routes below are in `server/routes.ts`. `pageAidRoute` resolves `body.by` centrally at lines 2246-2262. Its registrations are:

- `POST /api/documents/:slug/tiers` (2267), `/flags` (2286), `/flags/:flagId/clear` (2288), `/objections` (2291), `/objections/:objectionId/clear` (2301), `/objections/:objectionId/keep` (2304)
- `POST /api/documents/:slug/bundles/:bundleId/decision` (2352), `/bundles/:bundleId/reopen` (2357)
- `POST /api/documents/:slug/alternatives` (2363), `/alternatives/pick` (2368), `/alternatives/decide` (2373), `/alternatives/:altId/withdraw` (2378)
- `POST /api/documents/:slug/dispositions/overrule` (2398), `/dispositions/argue` (2410), `/dispositions` (2423)
- `POST /api/documents/:slug/settings` (2435), `/explain` (2438), `/threads` (2459), `/threads/:threadId/close` (2465), `/threads/:threadId/reopen` (2470), `/threads/:threadId/reply` (2474), `/threads/:threadId/undo` (2477)
- `POST /api/documents/:slug/ttl` (2482), `/ttl/:ttlId/clear` (2490), `/why-asked` (2495), and `/move-settings` (3173)

Direct users of `resolvePageActor` add:

- `POST /api/documents/:slug/chat` (`server/routes.ts:2549-2561`)
- `POST /api/documents/:slug/line-marks` (`server/routes.ts:2617-2666`)
- `POST /api/documents/:slug/asks/:askId/answer` (`server/routes.ts:2690-2718`)
- `DELETE /api/documents/:slug/asks/:askId/answer` (`server/routes.ts:2723-2734`)
- `POST /api/documents/:slug/asks/:askId/reask` (`server/routes.ts:2739-2749`)
- `DELETE /api/documents/:slug/asks/:askId` (`server/routes.ts:2752-2762`)

Two read routes also allow the credential to select the viewer identity, affecting personalized/redacted output rather than directly creating an attributed row: `GET /api/documents/:slug/dispositions` (`server/routes.ts:2384-2395`) and `GET /api/documents/:slug/since-you` (`server/routes.ts:2566-2578`).

The three `{do}` page routes are **not vulnerable through this policy**. Although they call `resolvePageActor`, `doSessionActor` then requires `decision.source === 'session'` (`server/routes.ts:2774-2794`). This covers `POST .../dos/:doId/{approve,revoke,run}` at lines 2819-2822.

### Agent API routes that accept an owner-selected actor

All routes below are mounted below `/api/agent` and are in `server/agent-routes.ts`.

Direct `resolveAgentActor` calls cover:

- `POST /:slug/marks/line` (3708; actor at 3721)
- `POST /:slug/tiers` (3780; actor at 3787)
- `POST /:slug/marks/proxy` (3845; actor at 3852)
- `POST /:slug/asks` (3999; actor at 4006)
- `POST /:slug/asks/:askId/answer` (4076; actor at 4083)
- `POST /:slug/dos` (4106; actor at 4113)
- `POST /:slug/dos/:doId/revise` (4124; actor at 4131)
- `POST /:slug/dos/:doId/revoke` (4144; actor at 4151)
- `POST /:slug/dos/:doId/run` (4159; actor at 4165)
- `DELETE /:slug/dos/:doId` (4172; actor at 4179)
- `POST /:slug/asks/:askId/reask` (4233; actor at 4240)
- `DELETE /:slug/asks/:askId` (4247; actor at 4254)
- `POST /:slug/chat` (4939; actor at 4946)
- Multi-party disposition handling for `POST /:slug/marks/accept` and `/marks/reject` resolves the actor at 5021 when multi-party mode is enabled (routes at 5081 and 5152).

The `aidRoute` helper resolves `payload.by` at lines 4493-4505. Its registrations cover:

- `POST /:slug/notes` (4533), `/flags` (4537), `/flags/:flagId/clear` (4541), `/objections` (4545), `/objections/:objectionId/clear` (4551), `/objections/:objectionId/keep` (4555)
- `POST /:slug/bundles` (4649), `/alternatives` (4691), `/alternatives/pick` (4697), `/alternatives/decide` (4703), `/alternatives/:altId/withdraw` (4708)
- `POST /:slug/settings` (4719), `/ttl` (4751), `/ttl/:ttlId/clear` (4758), `/ttl/:ttlId/check` (4761)
- `POST /:slug/dispositions/settings` (5045), `/dispositions/overrule` (5054), `/dispositions/argue` (5068)
- `POST /:slug/moves` (5581), `/move-settings` (5586)

There is also a parallel, independent actor-input surface that does **not** read `ownerCredentialMayActAsAnyone`: general document-operation endpoints pass `payload.by` into the operation layer without calling `decideActor` on the ordinary path. An owner credential can reach `POST /:slug/marks/comment` (3680), `/marks/suggest-replace` (4778), `/marks/suggest-insert` (4805), `/marks/suggest-delete` (4832), `/marks/accept` (5081), `/marks/reject` (5152), `/marks/reply` (5177), `/marks/resolve` (5199), `/marks/unresolve` (5221), and `/rewrite` (5243). These routes are not caused by the policy flag, but they are in scope for the desired invariant (“an owner credential cannot act as a human”) and must receive route-level denial tests before declaring the issue closed. The implementation should either resolve their actor through `resolveAgentActor` or prove that the operation layer enforces the same AI-only rule; changing `decideActor` alone cannot sanitize these independent `by` consumers.

## Estate callers

The task specifically names two production-side callers:

| Caller | Credential use / claimed human | Review result |
|---|---|---|
| `~/Projects/_estate/bin/ask-mike` | Owner credential; task states it records ask answers and/or line marks as `human:mw@mike-wolf.com` | **Known affected caller from the supplied brief, but file:line could not be verified in this contractor worktree.** The deploy repo independently references this transport at `docs/accord/README.md:9` and its workflow at `scripts/fixtures/estate-plan-sep23-26ksoubn.md:134`. |
| `~/Projects/_estate/accord-chat/vps_chat.py` | Owner credential; task states it records chat as `human:mw@mike-wolf.com` | **Known affected caller from the supplied brief, but file:line could not be verified in this contractor worktree.** |

I did not inspect `~/Projects/_estate`: the contractor policy requires all work and reads to stay inside the current working directory. Neither named file, nor an `_estate` source tree, exists in this worktree or in the reviewed deploy tree. Therefore a truthful exhaustive list of “other `_estate/bin` scripts,” with file:line evidence, is not possible from this checkout. No secret or `.env` value was read or printed. Before implementing the policy change, the reviewing agent should run the requested metadata-only grep in an authorized `_estate` checkout and append every match; likely search terms are `x-share-token`, `x-bridge-token`, `Authorization`, `ownerSecret`, and request fields named `by`/`actor`, with secret values redacted.

Repository evidence demonstrates the dangerous behavior independently: `src/tests/identity.test.ts:120-121` explicitly expects an owner credential to name `human:mw@mike-wolf.com`; the integration test at lines 202-204 does the same for `POST /api/agent/:slug/marks/line`. `src/tests/document-team.test.ts:147` exercises the page line-mark path with the owner secret and the same human actor. `src/tests/review-aids.test.ts:305,316,413,419,429-432` exercises additional owner-as-human review actions.

### Estate callers, verified by the lead (2026-10-27, standing loop run 20261027T110006Z-morning)

The builder could not read outside its worktree, so the lead ran the grep against `~/Projects/_estate` at origin/main on 2026-10-27. Result: **no current estate caller uses an owner credential to write to an Accord as a human.**

| Caller | Accord write and its `by` | Effect of the proposed control |
|---|---|---|
| `_estate/bin/ask-mike:1426` and `:2053` | `POST .../asks` with `by: 'ai:ask-mike'`, `to: [MIKE]` | None: the actor is `ai:*`. |
| `_estate/accord-chat/vps_chat.py:123` | chat post with `payload['by'] = 'ai:claude'` | None. |
| `_estate/accord-chat/register.py` | holds an owner credential; sets no `by` | None found; re-check when the control is built. |

One related risk lies outside the Accord. `ask-mike` writes rulings attributed to `human:mw@mike-wolf.com` into the local ledger `_estate/waiting-on-mike/answers.jsonl` (`_estate/bin/ask-mike:1853` from harvest, `:1992` from `ask-mike record --words`). Any session can run `record` with words it supplies, so that ledger trusts the session that ran it. The proposed Accord control does not cover it. It should be named in the same decision.

So the only things that break under the control are proof-sdk's own tests that expect owner-as-human (`src/tests/identity.test.ts:120-121,202-204`, `src/tests/document-team.test.ts:147`).

## Proposed smallest code change (not applied)

Keep owner authorization, but make its attribution rule explicit and AI-only. The following is the exact proposed production diff against `c3b62db`:

```diff
diff --git a/src/shared/identity.ts b/src/shared/identity.ts
@@
-  /** The document owner's credential (scripts) may act as any actor it names, humans included. */
-  ownerCredentialMayActAsAnyone: true,
+  /** A document owner credential is an automation bearer credential: it may act only as a named AI. */
+  ownerCredentialMayActAsAnyone: false,
diff --git a/server/identity.ts b/server/identity.ts
@@
-  if (input.ownerCredential && IDENTITY_POLICY.ownerCredentialMayActAsAnyone) {
+  if (input.ownerCredential) {
     if (!typed) return deny(400, 'INVALID_ACTOR', 'Pass "by", for example "ai:claude"');
     const actor = normalizeActorString(typed);
+    if (!IDENTITY_POLICY.ownerCredentialMayActAsAnyone && !/^ai:/i.test(actor)) {
+      return deny(403, 'AI_ACTOR_REQUIRED', 'An owner credential is an automation credential: "by" must start with "ai:"; human actions require that human\'s signed-in session');
+    }
     return { ok: true, actor, trust: actorTrustOf(actor), source: 'owner-credential' };
   }
```

In the implementation commit, also update the stale examples/comments at `server/identity.ts:12`, `server/identity.ts:85`, and `server/agent-routes.ts:3918`; replace the owner-as-human expectations in `src/tests/identity.test.ts:120-121,202-204` and `src/tests/document-team.test.ts:147`; and add regression coverage for both agent and page routes:

- owner credential + `by: human:*` returns 403 `AI_ACTOR_REQUIRED` and creates no row;
- owner credential + bare/email/`guest:*` also returns 403;
- owner credential + `by: ai:*` continues to work;
- an agent key remains pinned to its key identity;
- a same-origin signed-in session continues to create `human:*` records;
- explicit proxy marks continue to name the human in their `for` field while retaining the AI as the acting author.

This patch intentionally retains the policy switch so rollback is a one-line, reviewable decision. A later cleanup may rename the flag to a positive AI-only policy.

## Interaction with ac-ttj / `teamOwner()`

`server/document-team-routes.ts:70-94` makes a separate **authorization** decision. An owner credential is recorded as the literal actor `owner-credential` (lines 73-79), while a signed-in creator/admin is recorded as their member identity (lines 81-93). It does not call `decideActor` and does not accept a caller-selected `by`.

Accordingly, the proposed attribution restriction should not change ac-ttj's intended owner rights for Mike's signed-in browser, nor should it remove scripts' ability to manage the team where that is intentionally authorized. `teamOwner()` should remain separate: Mike's browser gets owner rights from its verified session; an owner credential gets administrative capability but never Mike's human attribution. This separation is the desired security boundary.

## Residual risks and rollout

- Existing human-attributed rows cannot be classified by authentication source. Do not rewrite them automatically. If provenance matters, compare server request logs/backups and known caller schedules, then record any correction explicitly.
- Changing the server first will break `ask-mike` and `vps_chat.py` requests that currently send `human:mw@mike-wolf.com`. Update those callers in the same rollout to use stable `ai:*` identities. For a genuine Mike answer, require his session or add an explicit, separately modeled proxy/ratification workflow; do not create a second bearer-token impersonation exception.
- Rotate owner credentials only if there is evidence of exposure. Rotation alone does not fix the confused-deputy policy.
- Audit independent operation-layer uses of `payload.by` noted above before declaring full closure, and add a route-level invariant test that no bearer credential can persist `human:*` attribution without a human session.
