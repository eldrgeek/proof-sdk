**Blind mode still leaks protected choices at commit `63372d6`.** The `/state` objection fix closes one path, but several other responses bypass it.

This was a read-only code audit. I changed no files and ran no server or tests. “Confirmed” below means I followed the producer, filtering, and response code; it does not mean a live reproduction.

The rule allows names and the fact that someone marked a line. It hides their choice until reveal. An objection requires every surviving covered line to be revealed. The owner credential’s unrestricted administrative view is an explicit exception.

1. **High — Raw objections reach both ordinary pages and agent readers. Confirmed.**

   `GET /api/documents/:slug/line-marks` returns `listObjections(slug)` unchanged at [server/routes.ts:2176](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/server/routes.ts:2176). `pageExtras()` filters marks, answers, and picks, but never receives those objections.

   `GET /api/agent/:slug/objections`, including `?closed=1`, also returns unfiltered objections at [server/agent-routes.ts:4513](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/server/agent-routes.ts:4513). Any authorized reader receives the objector, reason, condition, covered lines, and closure details.

   This is visible beyond developer tools. The page renders the reason and condition at [src/ui/line-marks.ts:2880](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/src/ui/line-marks.ts:2880). Its header also turns those objections into named per-person rejections at [src/ui/open-view.ts:249](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/src/ui/open-view.ts:249). Folding or hiding that header provides no protection.

   **Smallest fix:** apply `objectionLinesRevealed()` to both responses, including closed objections, before serialization.

2. **High — Event history publishes objections and proxy choices. Confirmed.**

   Any authorized agent reader can call `GET /api/agent/:slug/events/pending`. It returns stored event JSON without viewer filtering at [server/agent-routes.ts:5433](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/server/agent-routes.ts:5433).

   Objection creation records reasons and conditions at [server/review-aids.ts:310](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/server/review-aids.ts:310). Clear, override, and keep events also disclose protected objection details. Proxy events contain statuses, line indices, confidence, and ratification evidence at [server/proxy-marks.ts:292](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/server/proxy-marks.ts:292) and line 469. Answer withdrawal records the withdrawn choice at [server/asks.ts:373](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/server/asks.ts:373).

   Despite the endpoint’s name, its database query includes acknowledged events too. Events written before blind mode was enabled remain readable.

   **Smallest fix:** filter events when reading them. Suppress unrevealed objection events entirely, because their type and actor already disclose a rejection. Redact proxy and answer payloads under the same viewer rules. Write-time omission alone cannot protect existing history.

3. **High — Dialect exports disclose objections, proxies, and imported position history. Confirmed.**

   Both page and agent exports use `exportProofDocument()`. Its blind filter applies to ordinary line marks, answers, and picks, but skips objections at [server/proof-dialect.ts:676](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/server/proof-dialect.ts:676), proxies at line 711, and imported history at line 717.

   A document reader can download objection reasons and conditions, plus other people’s proxy statuses, confidence, and evidence. Imported history can contain rejection, objection, or proxy fields even though those imported records do not count as live marks.

   The same history appears unfiltered in `/state.dialectHistory` through [server/proof-dialect.ts:338](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/server/proof-dialect.ts:338). The agent export’s `X-Proof-Export-Counts` header also discloses objection and proxy counts, including for plain and CriticMarkup exports.

   **Smallest fix:** filter these three collections before generating text or counts. Apply the objection reveal rule, proxy ownership rule, and conservative filtering of imported position history. Filter `/state.dialectHistory` too.

4. **High — `?for=` bypasses proxy privacy. Confirmed.**

   `GET /api/agent/:slug/marks/proxy?for=human:<email>` returns the named person’s brief at [server/agent-routes.ts:3860](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/server/agent-routes.ts:3860). That branch returns before the blind-view restriction below it.

   Any authorized reader receives another person’s proxy choices, evidence, confidence, reset choices, and counts.

   **Smallest fix:** authorize the requested person before returning the brief. While blind, allow only that person, their bound Familiar, or the administrative owner credential.

5. **High — Dedicated ask routes expose answers and reasons. Confirmed.**

   The page route returns all canonical asks at [server/routes.ts:2618](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/server/routes.ts:2618). The agent route returns the full evaluated report at [server/agent-routes.ts:3986](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/server/agent-routes.ts:3986).

   Any document reader receives Yes/No/Not yet choices, exact answer words, and answer history before reveal.

   There is also a partial leak in the otherwise filtered responses. Page placeholders preserve `not_yet` at [server/routes.ts:2235](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/server/routes.ts:2235). Agent `/state` retains `snoozedFor`, `closed`, and `settled`; its ask Issues retain `snoozedFor`. These distinguish Not yet from a closing answer.

   **Smallest fix:** use one viewer-aware ask serializer for all three paths. Remove answer-dependent state and named snooze lists as well as the answer text.

6. **High — Aligned snapshots and ledgers bypass blind mode. Confirmed.**

   Snapshot JSON and Markdown are returned without a viewer argument at [server/alignment.ts:270](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/server/alignment.ts:270). Both page and agent snapshot-file routes require only document read access.

   The stored payload contains named line statuses, reasons, and complete answer histories at [src/shared/alignment.ts:347](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/src/shared/alignment.ts:347).

   Alignment does not establish that the requester has revealed those lines. A later participant or read-only observer can retrieve earlier choices without marking anything.

   **Smallest fix:** deny blind snapshot-file downloads to non-administrative viewers until viewer filtering is implemented. Keep the stored snapshot intact.

7. **High, conditional — A typed identity can borrow another participant’s reveal. Confirmed.**

   For an unauthenticated page identity, `pageExtras()` accepts `?by=guest:<name>` as the viewer at [server/routes.ts:2223](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/server/routes.ts:2223). A reader can name an existing guest and receive positions on every line that guest has marked.

   Similarly, an ordinary share-token caller may name an unreserved AI at [server/identity.ts:89](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/server/identity.ts:89). Active agent-key identities are protected, but unkeyed AI identities—and identities whose keys are no longer active—can supply another actor’s reveal history.

   **Smallest fix:** grant reveal only from a verified session or a bound agent key, apart from the explicit owner-credential exception. A caller-supplied name must not authorize disclosure.

8. **Medium — `/state` Issue fields and counts reveal hidden decisions. Confirmed.**

   Issues are ranked before redaction. [server/proof-extras-eval.ts:279](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/server/proof-extras-eval.ts:279) removes `rejectedBy` and the rejection reason, but retains `priorityRule: "rejected-by-others"` or `"disagreement"`, their priority, and `urgent`. It also retains `lapsedFor`, which names people whose earlier mark was Agreed or Approved.

   A rejection-only Issue remains in the response after its rejection fields are removed. Its presence can therefore disclose the rejection.

   `/state` also returns unfiltered section counts and `alignment.counts`, including `objectionIssues`, at [server/agent-routes.ts:2327](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/server/agent-routes.ts:2327). The page’s alignment-check endpoint returns the true whole-document Issue count. Small documents and changes between polls make these disclosures attributable.

   **Smallest fix:** derive returned Issue rows, priorities, and counts from filtered inputs. Until then, omit secret-dependent fields and counts for blind viewers. Keep authoritative whole-document calculations internal.

9. **Medium — Tier signals disclose proxy rejections. Confirmed.**

   The page receives signals computed from unredacted marks and every proxy at [server/routes.ts:2192](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/server/routes.ts:2192).

   A proxy produces a flag specifically when its status is `rejected-suggested`, at [src/shared/line-tiers.ts:235](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/src/shared/line-tiers.ts:235). The page receives its Familiar, person, and anchor. `/state.tiers` and `GET /api/agent/:slug/tiers` expose the resulting `flaggedFor` list through [server/line-tiers.ts:124](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/server/line-tiers.ts:124).

   Thus unrelated readers can identify a hidden proxy rejection. The positive-only `readBy` signal also distinguishes qualifying positive reads from rejections.

   **Smallest fix:** apply viewer visibility before constructing tier signals and their derived lists.

10. **Medium — Even an authorized proxy brief reveals other people’s objections. Confirmed.**

    The ordinary proxy report correctly limits whose proxies appear. However, `briefFor()` evaluates them against the unredacted Issue report at [server/proxy-marks.ts:340](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/server/proxy-marks.ts:340).

    The resulting `held` field says `"rejected"` or `"objection"` for specific lines. Proxy buckets and counts also change. A person or Familiar can therefore learn another participant’s hidden choice before taking their own position. Ratification refusal messages expose the same hold reasons.

    **Smallest fix:** conservatively hold every unrevealed line with a neutral explanation. Keep internal rejection checks, but do not expose different outcomes based on hidden choices.

11. **Medium — TTL reports identify hidden Agreed/Approved marks. Confirmed.**

    `/state.ttls` and `GET /api/agent/:slug/ttl` expose `decayedMarks` IDs at [server/proof-extras-eval.ts:220](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/server/proof-extras-eval.ts:220). Those IDs are selected only from Agreed or Approved marks at [src/shared/ttl.ts:140](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/src/shared/ttl.ts:140).

    Readers can join those IDs to the named hidden placeholders in `/state.lineMarks`. `ttl.expired` events also disclose the number of such marks. `openFor` exposes whether named people have made a qualifying decision since expiry.

    **Smallest fix:** omit hidden mark IDs and secret-dependent counts; compute visible status lists from filtered marks. Apply that rule to TTL creation responses and expiry events too.

12. **Medium — A hidden mark retains an origin that proves agreement. Confirmed.**

    [src/shared/blind.ts:88](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/src/shared/blind.ts:88) clears status, reason, evidence, and proxy details, but preserves `via`.

    A hidden mark with `via: "proxy"` reveals agreement because ratification always writes `status: "agreed"` at [server/proxy-marks.ts:440](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/server/proxy-marks.ts:440). Any page or agent reader receiving that placeholder can infer the choice. Blind batch-event ratification metadata has the same implication.

    **Smallest fix:** omit revealing origin metadata from hidden placeholders and blind events.

13. **Medium — Alternative summaries and history retain hidden choice information. Confirmed.**

    `redactAltSets()` clears picks and disagreement flags but preserves the original summary at [server/agent-routes.ts:3960](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/server/agent-routes.ts:3960). That summary can still say “the picks differ.”

    `/state` alternative Issues also retain `disagree`, `disagreement`, and their derived priority because `redactIssues()` only handles line Issues.

    Closed alternatives are returned unfiltered by `GET /alternatives?closed=1` and the page’s `alternativeHistory`. Their `resolution.how: "unanimous"` and winner disclose the team’s earlier choice to readers who never revealed that line. Resolution events disclose the same fact.

    **Smallest fix:** regenerate summaries and Issue metadata from redacted picks. Withhold choice-bearing resolution history and events until the viewer may see them.

**Suspected only:** legacy inline `approved`/`flagged` marks and thread rejection dispositions have no blind filter. They travel through document `marks`, the bridge, Yjs, and page thread rows. Relevant points are [server/collab.ts:6133](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/server/collab.ts:6133), [server/routes.ts:1374](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/server/routes.ts:1374), and [server/routes.ts:2218](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s4b/server/routes.ts:2218). I confirmed that transport, but found no automatic copying of a protected Accord line mark or objection into those records. I therefore cannot call it another confirmed blind leak.

I checked these paths and found them safe **within the stated limits**:

- **The fixed `/state` objection array and `participantStatus`:** they enforce whole-span reveal and recompute participant status from filtered marks. The separate fields identified above remain unsafe.
- **Collaboration broadcasts:** Accord line marks, objections, and proxies are stored outside Yjs. Their normal room notification contains only actor and time. I found no direct broadcast of their private payloads. Shared legacy marks remain the suspicion noted above.
- **“Marked by” lists:** names and participation counts are explicitly permitted by `showWhoMarked`. Ordinary hidden choices use server placeholders; the list is not concealing those choices solely with CSS. Objection rendering and `via` are the exceptions above.
- **`since-you`:** rejection lists use redacted line marks; objection repair details are restricted to the requesting objector.
- **The singular agent `/snapshot`:** `server/agent-snapshot.ts` returns document blocks and edit metadata, not Accord position records.
- **Fallback HTML snapshots and share previews:** `server/snapshot.ts`, `server/share-preview.ts`, and share Markdown/JSON responses do not attach the separate Accord position tables.
- **Plain export body:** it strips position annotations. Its agent response headers still have the count leak described above.