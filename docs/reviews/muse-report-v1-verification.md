# Muse report v1 verification record

2026-11-15; isolated branch `dispatch/gmail-mcp/a5bdd362`, baseline `01951796d717`. Implementation checkpoint `cbefb68`, review/coverage checkpoint `95b4824`; final evidence is committed afterward on the same branch. No push/merge/deploy was attempted.

## Results actually verified

| Check | Result |
| --- | --- |
| Initial focused filer/planner/watch/v1 tests | 156 passed, 0 failed |
| Final focused tests, including actual planner consumption and literal instruction artifact check | 159 passed, 0 failed |
| Final permitted test suites (all package test files except server.test.ts) | 242 passed, 0 failed, 0 skipped; 7 suites |
| `npm run typecheck` | Passed, exit 0 |
| `npm run build` | Passed, exit 0; compiler-generated dist remains ignored |
| `git diff --check` | Passed |
| `git apply --check .data/cache/muse-activation.patch` | Passed without applying |
| `git apply --reverse --check .data/cache/muse-rollback.patch` | Passed against inactive source without applying |

An intermediate artifact check failed because the local review generator import path traversed one directory too far; the path was corrected, the artifact generated from the exported formatter, and the final focused/permitted runs passed. No test assertion was relaxed or skipped. No generated file was substituted by hand.

## Contained foreground commands

Commands ran sequentially, awaiting each foreground result. Direct Node import avoids the tsx CLI's IPC socket. Every test command set task-scoped TMPDIR and a preload; HOME was never repurposed. `.data/cache/contain-tests.cjs` redirects `os.homedir()` and test mkdtemp prefixes into this worktree's private `.data/cache` tree, rejects unmocked fetch, and blocks native socket connections. Existing synthetic invalid-webhook failure paths therefore reject locally without DNS/network. Explicit mocks still exercise success/failure assertions. No real API client or planner/filer CLI was invoked. Existing tests' apply paths use synthetic adapters and contained state only.

Final focused command:

```sh
TMPDIR="$PWD/.data/cache/tmp" NODE_OPTIONS="--require=$PWD/.data/cache/contain-tests.cjs" \
  node --import tsx --test tests/muse-report.test.ts tests/muse-filer.test.ts \
  tests/muse-planner.test.ts tests/muse-watch.test.ts
```

Final permitted suite command:

```sh
TMPDIR="$PWD/.data/cache/tmp" NODE_OPTIONS="--require=$PWD/.data/cache/contain-tests.cjs" \
  node --import tsx --test tests/calendar.test.ts tests/attachments.test.ts \
  tests/alerts.test.ts tests/send-as.test.ts tests/slack-alerts.test.ts \
  tests/muse-filer.test.ts tests/muse-report.test.ts tests/muse-watch.test.ts \
  tests/muse-planner.test.ts tests/mail-digest.test.ts
```

Then, one command at a time:

```sh
TMPDIR="$PWD/.data/cache/tmp" npm run typecheck
TMPDIR="$PWD/.data/cache/tmp" npm run build
```

Private logs retained here (ignored, not committed): `.data/cache/focused-step1.log`, `focused-final.log`, `permitted-final-tests.log`, `typecheck-final.log`, `build-final.log`. These contain synthetic test output only. The review generator and activation/rollback patches are also retained in that private cache. The committed review document pins exact generated instruction text with a test.

## Scope and limits

- **Acceptance 1:** Synthetic producer→filer→planner roundtrips passed for explicit zero/PASS, zero/known FAIL with closed regression/BLOCKED, and N new findings without issue numbers yet. Missing/duplicate/unknown headers, malformed/new fields, count mismatches, subject/run mismatch, quoted examples, command injection, unsupported version, truncation, and size/line/count bounds fail visibly. Fields remain inert data. Sender/auth/SPAM rejection still applies. Existing legacy tests passed unchanged.
- **Acceptance 2:** Default REPORT FORMAT stays exactly legacy; only explicit `reportVersion: 1` changes it. The production caller has no opt-in. The review document includes both literal instruction templates, unchanged substitutions/subject/recipient, exact activation and rollback hunks, canary steps, and an unsent approval proposal. No activation occurred.
- **Acceptance 3:** All permitted suites, typecheck, and build passed. The complete `npm test` gate, including `tests/server.test.ts`, is **not verified**: that file establishes loopback socket connections, prohibited by this task. It was not run or weakened. Deployment readiness remains subject to that required gate in an authorized environment.
- Live canaries and scheduled producer output after activation: **not verified**; no activation was authorized or performed.
- desler-dispatch worker/adapter compatibility or actual notification grouping: **not verified**; that repo was not opened or edited. Journal additions preserve current keys and provide optional stable per-producer/run correlation data only.
- Private retained reports and historical production bodies: **not verified** and not read. Unsupported historical prose still needs manual review. No live mail, issue, label, cursor, DB, schedule, service, settings, rules, hooks, or environment files were changed.
