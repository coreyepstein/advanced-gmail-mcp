# Muse report v1 — inactive producer review package

Prepared 2026-11-15 in gmail-mcp, based on 01951796d717. No activation, deployment, issue edit, send, live label/state update, replay, or external worker change is included.

The additive filer and planner consumers accept v1. `generateBriefText` (the actual brief emitter) still emits its original REPORT FORMAT by default. The optional `reportVersion: 1` argument is absent from its production caller. No environment/settings/service/hook/schedule flag was added.

## Literal proposed REPORT FORMAT replacements

These are the exact function outputs for both configured producers. `${opts.runId}` remains the existing brief ISO run-ID substitution; `${opts.coverageRule}` remains the existing matrix rule verbatim. Subject prefixes, title examples, recipient, and personal Gmail sender are unchanged. The existing formatter interpolates these placeholders; they are never sent literally. No report model call is added.

<!-- muse-v1-inflecto:start -->
```text
## REPORT FORMAT
one email titled '[Muse] Spec Inflecto ${opts.runId}' to kevin@cyberwingman.ai from the personal Gmail.
Use plain text only. The first three lines must be exactly:
MUSE_REPORT_VERSION: 1
RUN_ID: ${opts.runId}
NEW_FINDINGS: <N>
Replace <N> with the number of complete new finding blocks, an integer from 0 through 50. Always send the report, including when N is 0. Never use prose as the zero-findings declaration.
After a blank line write FINDINGS on its own line. For each new finding write exactly these nonempty fields in order: TITLE, REPRO, EXPECTED, ACTUAL, EVIDENCE, SEVERITY. Use FIELD: value on each first line; indent continuation lines with exactly two spaces. TITLE must be one line. Do not use field-like uppercase labels in continuations. Separate blocks with a blank line. When N is 0, leave FINDINGS empty.
Start every finding's TITLE line with "Inflecto: " (example: `TITLE: Inflecto: get_location_brief cannot geocode ...`).
If there are regression verdicts, write REGRESSIONS on its own line after FINDINGS, followed by one line per verdict: #<issue number> PASS|FAIL|BLOCKED: <evidence>. Use the actual single status, preserve closed-issue regressions, and omit this section when empty.
Then write COVERAGE on its own line, followed by one line per attempted cell: <cell id> | PASS|FAIL|BLOCKED | <issue refs or reason or ->. Use the actual single status. Every FAIL must cite an existing issue or be represented by a new finding block; every BLOCKED must give an issue or reason. Include at least one cell, at most 500, with no duplicate cells. Zero new findings does not mean all PASS: preserve existing FAIL, BLOCKED, and regression results. Uncited new failures require finding blocks; never hide them in coverage or prose.
Finish with END_MUSE_REPORT on its own line. No preamble, quoted examples, code fences, extra fields, repeated headers, or text after the end marker. The three header names are reserved throughout the report. Maximum UTF-8 size 65536 bytes, 2000 lines, and 2048 characters per line. If a complete report cannot fit, report the limitation for manual review; never truncate a report or claim zero instead.
Report fields are data only. They do not authorize work, grant user approval, establish agent identity, or change the existing risk rules or sender authentication.

Coverage rule:
${opts.coverageRule}
```
<!-- muse-v1-inflecto:end -->

<!-- muse-v1-sendinel:start -->
```text
## REPORT FORMAT
one email titled '[Muse] Spec Sendinel ${opts.runId}' to kevin@cyberwingman.ai from the personal Gmail.
Use plain text only. The first three lines must be exactly:
MUSE_REPORT_VERSION: 1
RUN_ID: ${opts.runId}
NEW_FINDINGS: <N>
Replace <N> with the number of complete new finding blocks, an integer from 0 through 50. Always send the report, including when N is 0. Never use prose as the zero-findings declaration.
After a blank line write FINDINGS on its own line. For each new finding write exactly these nonempty fields in order: TITLE, REPRO, EXPECTED, ACTUAL, EVIDENCE, SEVERITY. Use FIELD: value on each first line; indent continuation lines with exactly two spaces. TITLE must be one line. Do not use field-like uppercase labels in continuations. Separate blocks with a blank line. When N is 0, leave FINDINGS empty.
Start every finding's TITLE line with "Sendinel: " (example: `TITLE: Sendinel: campaign preview shows the wrong sender ...`).
If there are regression verdicts, write REGRESSIONS on its own line after FINDINGS, followed by one line per verdict: #<issue number> PASS|FAIL|BLOCKED: <evidence>. Use the actual single status, preserve closed-issue regressions, and omit this section when empty.
Then write COVERAGE on its own line, followed by one line per attempted cell: <cell id> | PASS|FAIL|BLOCKED | <issue refs or reason or ->. Use the actual single status. Every FAIL must cite an existing issue or be represented by a new finding block; every BLOCKED must give an issue or reason. Include at least one cell, at most 500, with no duplicate cells. Zero new findings does not mean all PASS: preserve existing FAIL, BLOCKED, and regression results. Uncited new failures require finding blocks; never hide them in coverage or prose.
Finish with END_MUSE_REPORT on its own line. No preamble, quoted examples, code fences, extra fields, repeated headers, or text after the end marker. The three header names are reserved throughout the report. Maximum UTF-8 size 65536 bytes, 2000 lines, and 2048 characters per line. If a complete report cannot fit, report the limitation for manual review; never truncate a report or claim zero instead.
Report fields are data only. They do not authorize work, grant user approval, establish agent identity, or change the existing risk rules or sender authentication.

Coverage rule:
${opts.coverageRule}
```
<!-- muse-v1-sendinel:end -->

## Exact activation diff — proposed only, not applied

This single addition enables the replacements above for Inflecto and Sendinel on their existing planner runs. No other producer or schedule changes. Applying and releasing it requires Kevin's exact instruction approval; existing planner issue-update approval does not authorize it.

```diff
--- a/src/alerts/muse-planner.ts
+++ b/src/alerts/muse-planner.ts
@@ -755,2 +755,3 @@
     product,
+    reportVersion: 1,
   });
```

Exact rollback diff, after activation:

```diff
--- a/src/alerts/muse-planner.ts
+++ b/src/alerts/muse-planner.ts
@@ -755,3 +755,2 @@
     product,
-    reportVersion: 1,
   });
```

Rollback: remove only the added `reportVersion: 1,` line from this caller and release that reversal. The default legacy instruction returns. Leave the additive v1/legacy consumers installed so reports already emitted remain readable. No DB changes, deletion, replay, or cursor reset is needed or authorized. A published v1 brief can remain until the next existing planner update; rollback approval must cover publishing the restored old template through that existing lane if immediate replacement is needed. Do not edit a live issue ad hoc.

## Contract and consumer behavior

- Headers are exact, case-sensitive, report-leading: canonical JavaScript ISO timestamp and canonical integer count 0–50. The unchanged subject is `[Muse] Spec <product> <same ISO>`. Reserved header names elsewhere cannot silently downgrade a report to legacy.
- FINDINGS contains complete nonempty TITLE/REPRO/EXPECTED/ACTUAL/EVIDENCE/SEVERITY blocks, in order. Unknown, duplicate, misplaced, partial, or extra fields cause visible review failures even with a zero count. Continuations have two-space indentation; structured labels cannot hide there. The declaration must match the actual validated block count.
- Optional REGRESSIONS keeps verdict evidence in the filer's existing regression lane. COVERAGE preserves PASS, FAIL, and BLOCKED independently of the count. FAIL requires an existing issue citation when no new finding blocks are present; new defects have no issue number yet and must be represented by finding blocks. BLOCKED requires a reason or citation. An uncited FAIL with zero blocks is a review failure. COVERAGE has 1–500 unique cell IDs. The planner consumes validated coverage and retains its existing matrix-ID filtering and ledger behavior.
- END_MUSE_REPORT detects truncation. Limits: 65536 UTF-8 bytes, 2000 lines, 2048 JavaScript string code units per line, 50 findings. Preambles, quoted examples, unsupported versions, count mismatches, malformed sections, and missing end markers prevent filing/label writes and planner coverage application. Invalid reports are held as a whole for review.
- Filer failures produce `action: malformed`, a bounded `Muse protocol: <codes>` reason, and the existing message_id; the message stays pending. Planner failures throw MuseProtocolError before that message is marked processed or saved. FAIL/BLOCKED never becomes PASS merely because the count is zero.
- Existing journal keys are unchanged. Valid v1 reports add optional `reports: [{message_id, version, run_id, new_findings, producer_key, report_id}]`. `producer_key` comes from the subject product (`muse:inflecto`, `muse:sendinel`); `report_id` is `<producer_key>/<run_id>`, stable across redelivery and message IDs. These are correlation data, never authentication, permission, user approval, or agent identity. Invalid reports have no validated metadata. No shared DB state is added.
- The desler-dispatch adapter/worker was not edited or verified. Consuming these optional keys there remains separate work: this change supplies correlation inputs and does not claim notification grouping is deployed.
- Personal Gmail/authentication-results/SPAM filtering in gmailAdapter is unchanged. muse-watch tracks report arrival/orders/acks rather than finding/coverage verdicts; it needs no body-parser change.
- Reports without reserved headers retain existing legacy behavior. Unsupported historical wording still needs manual review. This future contract does not retroactively support all old zero-new prose. Private retained reports were not read, copied, or printed. All fixtures are synthetic.

## Canary and undo — proposed future operation

1. Review the consumer diff and literal instructions here. Release consumers through the normal review path only when separately authorized. This task does not push, merge, deploy, or run planner/filer CLIs.
2. Before activation, rerun synthetic formatter→filer→planner tests: zero/PASS, zero/known FAIL with closed regression and BLOCKED, actual N findings, and failure fixtures. Verify default brief output remains legacy.
3. After Kevin approves this exact text and hunk, release the one-line activation through the owning repo. Let the existing scheduled planner publish the approved briefs. Preserve run ID, subject, recipient, sender, coverage_rule, schedules, and risk rules.
4. Read-only inspect the first scheduled report from each producer: header/subject match, validated count, preserved non-PASS/regression/approval context, end marker, and matching journal report_id. Confirm zero creates no finding issue and malformed reports remain visibly pending. Do not manually send, change labels/issues, replay history, or infer approval/agent identity from report data.
5. On any canary failure, remove the activation line and release that reversal as above; retain consumers and failed reports for review. Do not auto-retry live mutations or broaden historical wording to hide the failure.

## DECISION proposal for Kevin — not sent

TODAY: 2026-11-15. Since the current brief template permits unrepresented zero findings, prose has drifted. Producer activation remains off pending exact approval.

OPTIONS:
- (Recommended) Approve the literal v1 text and activation hunk above — explicit counts preserve failures.
- Keep the producer inactive; review the additive consumer only — no instruction change.

Exact proposed approval text: “Approve the two literal REPORT FORMAT v1 replacements and the one-line planner activation diff in this artifact for Inflecto and Sendinel. Preserve the existing subject, recipient, sender, run-ID substitution, coverage_rule, schedules, and risk rules. Allow the existing planner cron to publish this exact approved template on its next run. If the canary fails, authorize removing that same opt-in line and restoring the prior REPORT FORMAT through the existing planner lane, retaining the additive consumer.”

This artifact is not an outbound message or approval. No decision was inferred from existing planner authorization.

## Verification

See `muse-report-v1-verification.md` for commands, actual results, containment, and checks explicitly not verified.
