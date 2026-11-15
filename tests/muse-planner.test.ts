import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatMuseReportV1 } from '../src/alerts/muse-report.js';
import {
  parseCoverageSection,
  normalizeBrief,
  generateBriefText,
  computeScoreboard,
  isCellRunnableByMuse,
  runPlanner,
  parseArgs,
  parsePlannerArgs,
  getProduct,
  PRODUCTS,
  RUNNER_CAPABILITIES,
  type Matrix,
  type MatrixCell,
  type GitHubIssue,
  type Gh,
  type ReadonlyPlannerGmail,
  type MuseMail,
} from '../src/alerts/muse-planner.js';

function makeCell(id: string, overrides: Partial<MatrixCell> = {}): MatrixCell {
  return {
    id,
    kind: overrides.kind ?? 'valid',
    target: overrides.target ?? 'target',
    tier: overrides.tier ?? 'pro',
    surface: overrides.surface ?? 'mcp',
    steps: overrides.steps ?? [`Step 1 for ${id}`],
    pass: overrides.pass ?? `Pass condition for ${id}`,
    est_mcp_calls: overrides.est_mcp_calls ?? (overrides.surface === 'browser' ? 0 : 1),
    risk_flags: overrides.risk_flags ?? ['none'],
    guards: overrides.guards ?? [],
    smoke: overrides.smoke ?? false,
    weekly: overrides.weekly ?? false,
    ...(overrides.muse_runnable === undefined ? {} : { muse_runnable: overrides.muse_runnable }),
  };
}

function makeMatrix(cells: MatrixCell[]): Matrix {
  return {
    version: 1,
    generated: '2026-11-08',
    coverage_rule: 'Every Muse report ends with a COVERAGE section: one line per cell attempted, in the form `<cell id> | PASS|FAIL|BLOCKED | <issue refs or ->`.',
    accounts: { free: 'muse-free@inflecto.ai' },
    budget: { smoke_est_mcp_calls: 3, full_pass_est_mcp_calls: 91 },
    cells,
  };
}

function makeGmail(mails: MuseMail[]): ReadonlyPlannerGmail {
  return {
    users: {
      messages: {
        async list() {
          return { data: { messages: mails.map(m => ({ id: m.id })) } };
        },
        async get({ id }) {
          const mail = mails.find(m => m.id === id);
          if (!mail) throw new Error(`Message not found: ${id}`);
          return {
            data: {
              id: mail.id,
              internalDate: String(mail.time),
              payload: {
                headers: [{ name: 'subject', value: mail.subject }],
                parts: [{ mimeType: 'text/plain', body: { data: Buffer.from(mail.body, 'utf8').toString('base64url') } }],
              },
            },
          };
        },
      },
    },
  };
}

function makeGh(opts: {
  matrix: Matrix;
  issues?: GitHubIssue[];
  targetIssue?: GitHubIssue | null;
  labels?: { name: string }[];
}) {
  const calls: string[][] = [];
  const labels = [...(opts.labels ?? [{ name: 'muse-brief' }])];
  const issues = [...(opts.issues ?? [])];
  let currentTargetIssue = opts.targetIssue ?? null;

  const gh: Gh = async args => {
    calls.push(args);
    if (args[0] === 'api' && args[1].includes('muse-coverage-matrix.json')) {
      return Buffer.from(JSON.stringify(opts.matrix)).toString('base64');
    }
    if (args[0] === 'issue' && args[1] === 'list' && args.includes('muse-test')) {
      return JSON.stringify(issues);
    }
    if (args[0] === 'issue' && args[1] === 'list' && args.includes('muse-brief')) {
      return JSON.stringify(currentTargetIssue ? [currentTargetIssue] : []);
    }
    if (args[0] === 'label' && args[1] === 'list') {
      return JSON.stringify(labels);
    }
    if (args[0] === 'label' && args[1] === 'create') {
      labels.push({ name: args[2] });
      return '';
    }
    if (args[0] === 'issue' && args[1] === 'create') {
      const titleIdx = args.indexOf('--title');
      const bodyIdx = args.indexOf('--body');
      currentTargetIssue = {
        number: 4040,
        title: args[titleIdx + 1],
        body: args[bodyIdx + 1],
        state: 'OPEN',
      };
      return 'https://github.com/kmdesle/inflecto-ai/issues/4040\n';
    }
    if (args[0] === 'issue' && args[1] === 'pin') {
      return '';
    }
    if (args[0] === 'issue' && args[1] === 'edit') {
      const bodyIdx = args.indexOf('--body');
      if (currentTargetIssue) {
        currentTargetIssue.body = args[bodyIdx + 1];
      }
      return '';
    }
    throw new Error(`Unexpected gh call: ${args.join(' ')}`);
  };

  return { gh, calls, getTargetIssue: () => currentTargetIssue };
}

test('1. coverage parsing incl. malformed lines and unknown ids', () => {
  const validIds = new Set(['cell-1', 'cell-2', 'cell-3']);
  const emailBody = `
Random preliminary text discussing testing.
Another line with notes.

COVERAGE
cell-1 | PASS | -
malformed line with no pipes
cell-unknown | PASS | -
cell-2 | FAIL | #2258, #2260
cell-3 | BLOCKED | login quota exceeded
cell-1 | INVALID_STATUS | -
| | |
`;

  const records = parseCoverageSection(emailBody, validIds);
  assert.equal(records.length, 3);
  assert.deepEqual(records[0], { cellId: 'cell-1', result: 'PASS', issueRefs: [] });
  assert.deepEqual(records[1], { cellId: 'cell-2', result: 'FAIL', issueRefs: ['#2258', '#2260'] });
  assert.deepEqual(records[2], { cellId: 'cell-3', result: 'BLOCKED', issueRefs: ['login quota exceeded'] });
});

test('2. ledger update ordering and once-only application', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'planner-test-'));
  const statePath = join(tmpDir, 'ledger.json');

  try {
    const cells = [makeCell('cell-1'), makeCell('cell-2')];
    const matrix = makeMatrix(cells);

    // Two emails arriving out of order in Gmail list
    const mailEarlier: MuseMail = {
      id: 'msg-1',
      subject: '[Muse] Spec Run 1',
      time: Date.parse('2026-11-08T09:00:00Z'),
      body: 'COVERAGE\ncell-1 | FAIL | #100\n',
    };
    const mailLater: MuseMail = {
      id: 'msg-2',
      subject: 'Muse Inflecto test Run 2',
      time: Date.parse('2026-11-08T10:00:00Z'),
      body: 'COVERAGE\ncell-1 | PASS | -\n',
    };

    // Returned out of order: mailLater first
    const gmail = makeGmail([mailLater, mailEarlier]);
    const { gh } = makeGh({ matrix });

    // First run: apply updates ledger
    const res1 = await runPlanner({ gh, gmail, statePath, apply: true, now: Date.parse('2026-11-08T11:00:00Z') });

    // Check that msg-1 was applied first, then msg-2
    const cell1 = res1.state.cells['cell-1'];
    assert.equal(cell1.runs, 2);
    assert.equal(cell1.last_result, 'PASS');
    assert.equal(cell1.last_run, '2026-11-08T10:00:00.000Z');
    assert.equal(cell1.last_pass, '2026-11-08T10:00:00.000Z');
    assert.equal(cell1.last_fail, '2026-11-08T09:00:00.000Z');
    assert.deepEqual(cell1.issue_refs, ['#100']);
    assert.deepEqual(res1.state.processed_message_ids.sort(), ['msg-1', 'msg-2']);

    // Second run: same emails must be skipped
    const res2 = await runPlanner({ gh, gmail, statePath, apply: true, now: Date.parse('2026-11-08T12:00:00Z') });
    const cell1Run2 = res2.state.cells['cell-1'];
    assert.equal(cell1Run2.runs, 2); // not incremented
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('3. retest selection by closedAt', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'planner-test-'));
  const statePath = join(tmpDir, 'ledger.json');

  try {
    const c1 = makeCell('c-retest-older', { guards: [101] });
    const c2 = makeCell('c-retest-newer', { guards: [102] });
    const c3 = makeCell('c-retest-never', { guards: [103] });
    const c4 = makeCell('c-open-guard', { guards: [104] });
    const matrix = makeMatrix([c1, c2, c3, c4]);

    const issues: GitHubIssue[] = [
      { number: 101, state: 'CLOSED', closedAt: '2026-11-08T10:00:00Z', title: 'Issue 101' },
      { number: 102, state: 'CLOSED', closedAt: '2026-11-08T10:00:00Z', title: 'Issue 102' },
      { number: 103, state: 'CLOSED', closedAt: '2026-11-08T10:00:00Z', title: 'Issue 103' },
      { number: 104, state: 'OPEN', closedAt: null, title: 'Issue 104' },
    ];

    // Email giving c1 last_run 09:00 (older than closedAt 10:00) and c2 last_run 11:00 (newer)
    const mail: MuseMail = {
      id: 'm1',
      subject: '[Muse] Spec Test',
      time: Date.parse('2026-11-08T09:00:00Z'),
      body: 'COVERAGE\nc-retest-older | FAIL | #101\n',
    };
    const mail2: MuseMail = {
      id: 'm2',
      subject: '[Muse] Spec Test',
      time: Date.parse('2026-11-08T11:00:00Z'),
      body: 'COVERAGE\nc-retest-newer | FAIL | #102\n',
    };

    const gmail = makeGmail([mail, mail2]);
    const { gh } = makeGh({ matrix, issues });

    const res = await runPlanner({ gh, gmail, statePath, apply: true, now: Date.parse('2026-11-08T12:00:00Z') });

    // c-retest-older (last_run 09:00 < closedAt 10:00) and c-retest-never (never run) are in RETEST
    assert.equal(res.retest_count, 2);
    const retestSection = res.brief.split('## SMOKE')[0];
    assert.match(retestSection, /c-retest-older/);
    assert.match(retestSection, /c-retest-never/);
    assert.doesNotMatch(retestSection, /c-retest-newer/);
    assert.doesNotMatch(retestSection, /c-open-guard/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('4. smoke always present', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'planner-test-'));
  const statePath = join(tmpDir, 'ledger.json');

  try {
    const s1 = makeCell('smoke-mcp', { smoke: true, est_mcp_calls: 1 });
    const s2 = makeCell('smoke-browser', { surface: 'browser', smoke: true, est_mcp_calls: 0 });
    const matrix = makeMatrix([s1, s2]);

    const gmail = makeGmail([]);
    const { gh } = makeGh({ matrix });

    const res = await runPlanner({ gh, gmail, statePath, now: Date.parse('2026-11-08T12:00:00Z') });
    assert.equal(res.smoke_count, 2);
    assert.match(res.brief, /## SMOKE[\s\S]*smoke-mcp[\s\S]*smoke-browser/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('5. budget cap 35 calls / 2 browser cells in normal mode', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'planner-test-'));
  const statePath = join(tmpDir, 'ledger.json');

  try {
    // 15 MCP cells each costing 3 calls = 45 calls total
    const mcpCells = Array.from({ length: 15 }, (_, i) => makeCell(`mcp-${i}`, { est_mcp_calls: 3 }));
    // 5 browser cells
    const browserCells = Array.from({ length: 5 }, (_, i) => makeCell(`browser-${i}`, { surface: 'browser', est_mcp_calls: 0 }));
    const matrix = makeMatrix([...mcpCells, ...browserCells]);

    const gmail = makeGmail([]);
    const { gh } = makeGh({ matrix });

    // Non-daily walk hour (e.g. 09:00 HST = 19:00 UTC)
    const now = Date.parse('2026-11-08T19:00:00Z');
    const res = await runPlanner({ gh, gmail, statePath, now });

    assert.equal(res.mode, 'NORMAL');
    // Planned MCP calls should not exceed 30 (leaving 5 for exploratory)
    const selectedMcpCells = matrix.cells.filter(c => c.surface === 'mcp' && res.brief.includes(`### \`${c.id}\``));
    const totalMcpCalls = selectedMcpCells.reduce((sum, c) => sum + c.est_mcp_calls, 0);
    assert(totalMcpCalls <= 30, `totalMcpCalls was ${totalMcpCalls}, should be <= 30`);

    // Browser cells should be capped at at most 2
    const selectedBrowserCells = matrix.cells.filter(c => c.surface === 'browser' && res.brief.includes(`### \`${c.id}\``));
    assert(selectedBrowserCells.length <= 2, `selectedBrowserCells was ${selectedBrowserCells.length}, should be <= 2`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('6. RETEST_ONLY mode at 16 open issues', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'planner-test-'));
  const statePath = join(tmpDir, 'ledger.json');

  try {
    const s1 = makeCell('smoke-cell', { smoke: true });
    const f1 = makeCell('fill-cell');
    const matrix = makeMatrix([s1, f1]);

    // 16 open issues
    const issues: GitHubIssue[] = Array.from({ length: 16 }, (_, i) => ({
      number: 2000 + i,
      state: 'OPEN',
      title: `Open issue ${i}`,
    }));

    const gmail = makeGmail([]);
    const { gh } = makeGh({ matrix, issues });

    const res = await runPlanner({ gh, gmail, statePath, now: Date.parse('2026-11-08T12:00:00Z') });
    assert.equal(res.mode, 'RETEST_ONLY');
    assert.match(res.brief, /\*\*Mode\*\*:\s*RETEST_ONLY/);
    assert.match(res.brief, /Open muse-test issues/);
    // Fill cell should NOT be included
    assert.doesNotMatch(res.brief, /### `fill-cell`/);
    assert.doesNotMatch(res.brief, /## EXPLORATORY/);

    // 15 open issues -> NORMAL mode
    const issues15 = issues.slice(0, 15);
    const { gh: gh15 } = makeGh({ matrix, issues: issues15 });
    const res15 = await runPlanner({ gh: gh15, gmail, statePath, now: Date.parse('2026-11-08T12:00:00Z') });
    assert.equal(res15.mode, 'NORMAL');
    assert.match(res15.brief, /## EXPLORATORY/);
    assert.match(res15.brief, /### `fill-cell`/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('7. daily full walk fires once per HST day', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'planner-test-'));
  const statePath = join(tmpDir, 'ledger.json');

  try {
    const b1 = makeCell('b-1', { surface: 'browser' });
    const b2 = makeCell('b-2', { surface: 'browser' });
    const b3 = makeCell('b-3', { surface: 'browser' });
    const b4 = makeCell('b-4', { surface: 'browser' });
    const matrix = makeMatrix([b1, b2, b3, b4]);

    const gmail = makeGmail([]);
    const { gh } = makeGh({ matrix });

    // 10:00 HST is 20:00 UTC (10 + 10 = 20)
    const run1Time = Date.parse('2026-11-08T20:00:00Z');
    const res1 = await runPlanner({ gh, gmail, statePath, apply: true, now: run1Time });

    // First run on/after 10:00 HST: all 4 browser cells in DAILY-WALK
    assert.equal(res1.daily_walk_count, 4);
    assert.match(res1.brief, /## DAILY-WALK[\s\S]*b-1[\s\S]*b-2[\s\S]*b-3[\s\S]*b-4/);
    assert.equal(res1.state.last_daily_walk, '2026-11-08');

    // Second run on the same HST day at 11:00 HST (21:00 UTC)
    const run2Time = Date.parse('2026-11-08T21:00:00Z');
    const res2 = await runPlanner({ gh, gmail, statePath, apply: true, now: run2Time });
    // Should NOT trigger daily walk again today
    assert.equal(res2.daily_walk_count, 0);

    // Run before 10:00 HST on next day (09:00 HST on 2026-11-09 is 19:00 UTC)
    const run3Time = Date.parse('2026-11-09T19:00:00Z');
    const res3 = await runPlanner({ gh, gmail, statePath, apply: true, now: run3Time });
    assert.equal(res3.daily_walk_count, 0);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('8. weekly Sunday rule', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'planner-test-'));
  const statePath = join(tmpDir, 'ledger.json');

  try {
    const w1 = makeCell('w-1', { weekly: true });
    const matrix = makeMatrix([w1]);

    const gmail = makeGmail([]);
    const { gh } = makeGh({ matrix });

    // 2026-11-08 is Sunday (UTC 12:00 -> HST 02:00 on Sunday)
    const sundayHst = Date.parse('2026-11-08T12:00:00Z');
    const resSunday = await runPlanner({ gh, gmail, statePath, now: sundayHst });
    assert.equal(resSunday.weekly_count, 1);
    assert.match(resSunday.brief, /## WEEKLY[\s\S]*w-1/);

    // 2026-11-09 is Monday (UTC 12:00 -> HST 02:00 on Monday)
    const mondayHst = Date.parse('2026-11-09T12:00:00Z');
    const resMonday = await runPlanner({ gh, gmail, statePath, now: mondayHst });
    assert.equal(resMonday.weekly_count, 0);
    assert.match(resMonday.brief, /## WEEKLY\n\(none\)/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('9. idempotent brief', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'planner-test-'));
  const statePath = join(tmpDir, 'ledger.json');

  try {
    const c1 = makeCell('c-1');
    const matrix = makeMatrix([c1]);
    const gmail = makeGmail([]);

    // First run creates brief
    const res1 = await runPlanner({ gh: makeGh({ matrix }).gh, gmail, statePath, now: Date.parse('2026-11-08T12:00:00Z') });

    // Seed target issue with brief from run 1
    const targetIssue: GitHubIssue = {
      number: 5555,
      title: 'Muse next-run brief (auto-generated, do not edit)',
      body: res1.brief,
      state: 'OPEN',
    };

    const { gh, calls } = makeGh({ matrix, targetIssue });

    // Run again with a newer timestamp (13:00 UTC) with --apply
    const res2 = await runPlanner({ gh, gmail, statePath, apply: true, now: Date.parse('2026-11-08T13:00:00Z') });
    assert.equal(res2.target_issue.action, 'skipped');
    // gh issue edit was NOT called!
    assert.equal(calls.some(c => c[0] === 'issue' && c[1] === 'edit'), false);

    // Now change the matrix so brief content differs
    const matrix2 = makeMatrix([c1, makeCell('c-2')]);
    const { gh: gh2, calls: calls2 } = makeGh({ matrix: matrix2, targetIssue });
    const res3 = await runPlanner({ gh: gh2, gmail, statePath, apply: true, now: Date.parse('2026-11-08T14:00:00Z') });
    assert.equal(res3.target_issue.action, 'edited');
    assert.equal(calls2.some(c => c[0] === 'issue' && c[1] === 'edit'), true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('10. --dry-run writes nothing', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'planner-test-'));
  const statePath = join(tmpDir, 'ledger.json');

  try {
    const c1 = makeCell('c-1');
    const matrix = makeMatrix([c1]);
    const gmail = makeGmail([]);
    const { gh, calls } = makeGh({ matrix });

    // Dry-run (apply: false)
    const res = await runPlanner({ gh, gmail, statePath, apply: false, now: Date.parse('2026-11-08T12:00:00Z') });

    // Check ledger was not written to disk
    let fileExists = true;
    try {
      await readFile(statePath, 'utf8');
    } catch {
      fileExists = false;
    }
    assert.equal(fileExists, false, 'ledger.json should not exist in dry run');

    // Check no mutating gh calls occurred
    const writeCalls = calls.filter(c =>
      (c[0] === 'issue' && (c[1] === 'create' || c[1] === 'edit')) ||
      (c[0] === 'label' && c[1] === 'create')
    );
    assert.equal(writeCalls.length, 0, 'No write gh calls in dry run');
    assert.equal(res.target_issue.action, 'would_create');
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('11. parseArgs and scoreboard calculations', () => {
  assert.deepEqual(parseArgs([]), { apply: false });
  assert.deepEqual(parseArgs(['--dry-run']), { apply: false });
  assert.deepEqual(parseArgs(['--apply']), { apply: true });
  assert.throws(() => parseArgs(['--apply', '--dry-run']), /Usage/);
  assert.throws(() => parseArgs(['--unknown']), /Usage/);

  const now = Date.parse('2026-11-08T12:00:00Z');
  const cells = [makeCell('c-1'), makeCell('c-2'), makeCell('c-3'), makeCell('c-4')];
  const ledger = {
    'c-1': { last_result: 'PASS' as const, last_run: '2026-11-07T12:00:00Z', last_pass: '2026-11-07T12:00:00Z', last_fail: null, runs: 1, issue_refs: [] },
    'c-2': { last_result: 'FAIL' as const, last_run: '2026-11-07T12:00:00Z', last_pass: null, last_fail: '2026-11-07T12:00:00Z', runs: 1, issue_refs: ['#1'] },
    'c-3': { last_result: 'BLOCKED' as const, last_run: '2026-11-07T12:00:00Z', last_pass: null, last_fail: null, runs: 1, issue_refs: [] },
    'c-4': { last_result: null, last_run: null, last_pass: null, last_fail: null, runs: 0, issue_refs: [] },
  };

  const sb = computeScoreboard(cells, ledger, now);
  assert.equal(sb.total, 4);
  assert.equal(sb.passed_7d, 1);
  assert.equal(sb.coverage_pct, 25.0);
  assert.equal(sb.fails, 1);
  assert.equal(sb.blocked, 1);
  assert.equal(sb.never_run, 1);
});

test('12. runner capabilities gating (free mcp never selected)', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'planner-test-'));
  const statePath = join(tmpDir, 'ledger.json');

  try {
    assert.deepEqual(RUNNER_CAPABILITIES.mcp, ['pro', 'premium']);
    assert.deepEqual(RUNNER_CAPABILITIES.browser, ['free', 'pro', 'premium']);

    const mcpFree = makeCell('mcp-free-1', { surface: 'mcp', tier: 'free', smoke: true, guards: [100] });
    const mcpPro = makeCell('mcp-pro-1', { surface: 'mcp', tier: 'pro', smoke: true });
    const browserFree = makeCell('browser-free-1', { surface: 'browser', tier: 'free' });
    const matrix = makeMatrix([mcpFree, mcpPro, browserFree]);

    const issues: GitHubIssue[] = [
      { number: 100, state: 'CLOSED', closedAt: '2026-11-08T10:00:00Z', title: 'Issue 100' },
    ];
    const gmail = makeGmail([]);
    const { gh } = makeGh({ matrix, issues });

    const now = Date.parse('2026-11-08T12:00:00Z');
    const res = await runPlanner({ gh, gmail, statePath, now });

    // mcpFree should never be in brief, even though it is smoke and has a closed guard
    assert.doesNotMatch(res.brief, /mcp-free-1/);
    assert.match(res.brief, /mcp-pro-1/);
    assert.match(res.brief, /browser-free-1/);

    // Scoreboard should report NOT RUNNABLE BY MUSE
    assert.equal(res.scoreboard.not_runnable, 1);
    assert.match(res.scoreboard_line, /NOT RUNNABLE BY MUSE \(covered elsewhere\) 1/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('13. BLOCKED cells 24h throttle, FAIL re-queues immediately, stuck-blocked drops after 3', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'planner-test-'));
  const statePath = join(tmpDir, 'ledger.json');

  try {
    const blockedCell = makeCell('blocked-cell', { surface: 'mcp', tier: 'pro' });
    const failCell = makeCell('fail-cell', { surface: 'mcp', tier: 'pro' });
    const matrix = makeMatrix([blockedCell, failCell]);

    // Initial run: coverage mail reports blocked-cell BLOCKED and fail-cell FAIL at T0
    const t0 = Date.parse('2026-11-08T10:00:00Z');
    const mail1: MuseMail = {
      id: 'm1',
      subject: '[Muse] Spec Run 1',
      time: t0,
      body: 'COVERAGE\nblocked-cell | BLOCKED | quota\nfail-cell | FAIL | #200\n',
    };

    const gmail1 = makeGmail([mail1]);
    const { gh: gh1 } = makeGh({ matrix });

    // Run at T0 + 1 hour (11:00 UTC):
    // - failCell should be re-queued immediately
    // - blockedCell should be suppressed (< 24h)
    const t1 = Date.parse('2026-11-08T11:00:00Z');
    const res1 = await runPlanner({ gh: gh1, gmail: gmail1, statePath, apply: true, now: t1 });

    assert.equal(res1.state.cells['blocked-cell'].consecutive_blocked, 1);
    assert.equal(res1.state.cells['blocked-cell'].last_result, 'BLOCKED');
    assert.equal(res1.state.cells['fail-cell'].last_result, 'FAIL');

    assert.match(res1.brief, /fail-cell/);
    assert.doesNotMatch(res1.brief, /blocked-cell/);
    assert.doesNotMatch(res1.scoreboard_line, /stuck-blocked/);

    // Run at T0 + 25 hours (next day 11:00 UTC):
    // - blockedCell can be re-queued (> 24h since last_run)
    const t2 = Date.parse('2026-11-09T11:00:00Z');
    const { gh: gh2 } = makeGh({ matrix });
    const res2 = await runPlanner({ gh: gh2, gmail: makeGmail([]), statePath, apply: true, now: t2 });

    assert.match(res2.brief, /blocked-cell/);

    // Now record 2nd and 3rd BLOCKED results for blockedCell
    const mail2: MuseMail = {
      id: 'm2',
      subject: '[Muse] Spec Run 2',
      time: t2,
      body: 'COVERAGE\nblocked-cell | BLOCKED | quota\n',
    };
    const t3 = Date.parse('2026-11-10T12:00:00Z');
    const mail3: MuseMail = {
      id: 'm3',
      subject: '[Muse] Spec Run 3',
      time: t3,
      body: 'COVERAGE\nblocked-cell | BLOCKED | quota\n',
    };
    const { gh: gh3 } = makeGh({ matrix });
    const res3 = await runPlanner({ gh: gh3, gmail: makeGmail([mail2, mail3]), statePath, apply: true, now: t3 + 1000 });

    assert.equal(res3.state.cells['blocked-cell'].consecutive_blocked, 3);
    assert.equal(res3.scoreboard.stuck_blocked, 1);
    assert.match(res3.scoreboard_line, /stuck-blocked 1/);

    // Even after 48 hours, stuck-blocked cell must never be selected
    const t4 = t3 + 48 * 3600 * 1000;
    const { gh: gh4 } = makeGh({ matrix });
    const res4 = await runPlanner({ gh: gh4, gmail: makeGmail([]), statePath, apply: true, now: t4 });

    assert.doesNotMatch(res4.brief, /blocked-cell/);
    assert.match(res4.scoreboard_line, /stuck-blocked 1/);

    // If human resets or cell passes, consecutive_blocked resets
    const mailReset: MuseMail = {
      id: 'm4',
      subject: '[Muse] Spec Run 4',
      time: t4,
      body: 'COVERAGE\nblocked-cell | PASS | -\n',
    };
    const { gh: gh5 } = makeGh({ matrix });
    const res5 = await runPlanner({ gh: gh5, gmail: makeGmail([mailReset]), statePath, apply: true, now: t4 + 1000 });
    assert.equal(res5.state.cells['blocked-cell'].consecutive_blocked, 0);
    assert.doesNotMatch(res5.scoreboard_line, /stuck-blocked/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('14. rendered brief pins exact TITLE-prefix instruction line and leaves remainder unchanged', () => {
  const prefixLine = 'Start every finding\'s TITLE line with "Inflecto: " (example: `TITLE: Inflecto: get_location_brief cannot geocode ...`).';
  const brief = generateBriefText({
    runId: '2026-11-08T12:00:00.000Z',
    mode: 'NORMAL',
    openIssues: [{ number: 2300, state: 'OPEN', title: 'Inflecto: sample open issue' }],
    retestCells: [],
    smokeCells: [makeCell('smoke-1', { smoke: true })],
    fillCells: [],
    dailyWalkCells: [],
    weeklyCells: [],
    coverageRule: 'Every Muse report ends with a COVERAGE section: one line per cell attempted, in the form `<cell id> | PASS|FAIL|BLOCKED | <issue refs or ->`.',
  });

  const lines = brief.split('\n');
  assert.equal(lines.includes(prefixLine), true, 'rendered brief must include exact TITLE-prefix instruction line');

  const expectedFixtureWithoutLine = `# Muse Test Brief - 2026-11-08T12:00:00.000Z

- **Run ID**: 2026-11-08T12:00:00.000Z
- **Mode**: NORMAL
- **Open muse-test issues**: 1

## RETEST
(none)

## SMOKE

### \`smoke-1\`
- **Surface**: mcp
- **Target**: target
- **Tier**: pro
- **Steps**:
1. Step 1 for smoke-1
- **Pass condition**: Pass condition for smoke-1

## FILL
(none)

## DAILY-WALK
(none)

## WEEKLY
(none)

## EXPLORATORY
EXPLORATORY: use judgment for up to 5 extra calls on whatever looks off in the areas above, stay inside the risk rules

## RULES
- password login at /login/team only
- no forms that send email
- never Create key
- never checkout/Stripe/portal
- no early-access form
- quote visible strings exactly with a screenshot
- desktop only (mobile is covered elsewhere)
- do not re-report issues already open:
  - #2300: Inflecto: sample open issue

## REPORT FORMAT
one email titled '[Muse] Spec Inflecto 2026-11-08T12:00:00.000Z' to kevin@cyberwingman.ai from the personal Gmail, FINDINGS in TITLE/REPRO/EXPECTED/ACTUAL/EVIDENCE/SEVERITY blocks (zero findings is fine: send the email anyway), then a COVERAGE section per matrix coverage_rule.

Coverage rule:
Every Muse report ends with a COVERAGE section: one line per cell attempted, in the form \`<cell id> | PASS|FAIL|BLOCKED | <issue refs or ->\`.
`;

  const briefWithoutPrefixLine = lines.filter(l => l !== prefixLine).join('\n');
  assert.equal(briefWithoutPrefixLine, expectedFixtureWithoutLine);
});

const FIXED_NOW = Date.parse('2026-11-08T12:00:00Z');
const sendinelBriefTitle = 'Muse brief: Sendinel coordinated testing';

test('15. --product selection, default inflecto, rejects unknown', () => {
  assert.deepEqual(parsePlannerArgs([]), { apply: false, product: 'inflecto' });
  assert.deepEqual(parsePlannerArgs(['--apply']), { apply: true, product: 'inflecto' });
  assert.deepEqual(parsePlannerArgs(['--product', 'sendinel']), { apply: false, product: 'sendinel' });
  assert.deepEqual(parsePlannerArgs(['--apply', '--product=sendinel']), { apply: true, product: 'sendinel' });
  assert.throws(() => parsePlannerArgs(['--product', 'nope']), /Usage/);
  assert.throws(() => parsePlannerArgs(['--product']), /Usage/);
  assert.throws(() => parsePlannerArgs(['--product', '__proto__']), /Usage/);
  assert.equal(getProduct(undefined).repo, 'kmdesle/inflecto-ai');
  assert.equal(PRODUCTS.inflecto.ledgerRelPath, 'ledger.json');
  assert.equal(PRODUCTS.sendinel.ledgerRelPath, 'sendinel/ledger.json');
  assert.equal(PRODUCTS.sendinel.repo, 'kmdesle/sendinel-ai');
});

test('16. brief text per product', () => {
  const base = {
    runId: '2026-11-08T12:00:00.000Z',
    mode: 'NORMAL' as const,
    openIssues: [],
    retestCells: [],
    smokeCells: [makeCell('s-1', { smoke: true })],
    fillCells: [],
    dailyWalkCells: [],
    weeklyCells: [],
    coverageRule: 'rule',
  };
  const inflecto = generateBriefText(base);
  assert.equal(generateBriefText({ ...base, product: PRODUCTS.inflecto }), inflecto);
  assert.match(inflecto, /\[Muse\] Spec Inflecto 2026-11-08T12:00:00\.000Z/);
  assert.match(inflecto, /password login at \/login\/team only/);
  assert.doesNotMatch(inflecto, /Sendinel/);

  const sendinel = generateBriefText({ ...base, product: PRODUCTS.sendinel });
  assert.match(sendinel, /\[Muse\] Spec Sendinel 2026-11-08T12:00:00\.000Z/);
  assert.match(sendinel, /Start every finding's TITLE line with "Sendinel: "/);
  assert.match(sendinel, /sandbox project only/);
  assert.match(sendinel, /allowlisted targets only/);
  assert.match(sendinel, /no prod account creation/);
  assert.doesNotMatch(sendinel, /Inflecto|login\/team/);
});

test('17. Sendinel run leaves the Inflecto ledger byte-identical and uses its own ledger, repo and pinned brief', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'planner-test-'));
  try {
    const inflectoLedger = join(tmpDir, 'ledger.json');
    const sendinelLedger = join(tmpDir, 'sendinel', 'ledger.json');
    const original = '{"version":1,"processed_message_ids":["keep"],"cells":{}}\n';
    await writeFile(inflectoLedger, original);

    const matrix = makeMatrix([makeCell('sn-1', { smoke: true })]);
    const { gh, calls } = makeGh({ matrix });
    const res = await runPlanner({ gh, gmail: makeGmail([]), statePath: sendinelLedger, apply: true, product: 'sendinel', now: FIXED_NOW });

    assert.equal(await readFile(inflectoLedger, 'utf8'), original);
    assert.equal(JSON.parse(await readFile(sendinelLedger, 'utf8')).cells['sn-1'].runs, 0);
    assert.equal(res.target_issue.action, 'created');

    // Every gh call is against sendinel-ai; inflecto-ai is never touched.
    const repoOf = (c: string[]) => c.includes('--repo') ? c[c.indexOf('--repo') + 1] : c[1];
    for (const c of calls) {
      const target = c.join(' ');
      assert.doesNotMatch(target, /inflecto-ai/, target);
      assert.match(target, /sendinel-ai/, target);
      void repoOf;
    }
    const create = calls.find(c => c[0] === 'issue' && c[1] === 'create')!;
    assert.equal(create[create.indexOf('--title') + 1], sendinelBriefTitle);
    assert.equal(create[create.indexOf('--label') + 1], 'muse-brief');
    const pin = calls.find(c => c[0] === 'issue' && c[1] === 'pin');
    assert.deepEqual(pin, ['issue', 'pin', '4040', '--repo', 'kmdesle/sendinel-ai']);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('18. Sendinel finds the existing brief issue by title, edits it, never creates a second', async () => {
  const matrix = makeMatrix([makeCell('sn-1', { smoke: true })]);
  const { gh, calls } = makeGh({
    matrix,
    targetIssue: { number: 77, state: 'OPEN', title: sendinelBriefTitle, body: 'stale' },
  });
  const res = await runPlanner({ gh, gmail: makeGmail([]), apply: false, product: 'sendinel', now: FIXED_NOW, statePath: join(tmpdir(), 'does-not-exist-sendinel', 'ledger.json') });
  assert.deepEqual(res.target_issue, { number: 77, action: 'would_edit' });
  assert.equal(calls.some(c => c[0] === 'issue' && ['create', 'edit', 'pin'].includes(c[1])), false);
});

test('19. Sendinel dry run from a fixture matrix prints a Sendinel brief and writes nothing', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'planner-test-'));
  try {
    const statePath = join(tmpDir, 'sendinel', 'ledger.json');
    const matrix = makeMatrix([makeCell('sn-1', { smoke: true }), makeCell('sn-2')]);
    const { gh, calls } = makeGh({ matrix, labels: [] });
    const res = await runPlanner({ gh, gmail: makeGmail([]), statePath, apply: false, product: 'sendinel', now: FIXED_NOW });
    assert.match(res.brief, /\[Muse\] Spec Sendinel /);
    assert.equal(res.target_issue.action, 'would_create');
    assert.deepEqual(await readdir(tmpDir), []);
    assert.equal(calls.some(c => ['create', 'edit', 'pin'].includes(c[1])), false);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('13. sendinel capabilities and muse_runnable flag (51 of 69 runnable)', () => {
  assert.deepEqual(PRODUCTS.sendinel.capabilities, { mcp: ['member'], browser: ['anonymous', 'member'] });

  const cells: MatrixCell[] = [];
  const add = (n: number, surface: 'mcp' | 'browser', tier: string, runnable?: boolean) => {
    for (let i = 0; i < n; i++) {
      cells.push(makeCell(`s-${surface}-${tier}-${runnable}-${i}`, {
        surface,
        tier,
        ...(runnable === undefined ? {} : { muse_runnable: runnable }),
      }));
    }
  };
  add(44, 'mcp', 'member', true);
  add(15, 'mcp', 'member', false);
  add(3, 'mcp', 'admin', false);
  add(1, 'browser', 'anonymous', true);
  add(6, 'browser', 'member', true);
  assert.equal(cells.length, 69);

  const caps = PRODUCTS.sendinel.capabilities;
  const runnable = cells.filter(c => isCellRunnableByMuse(c, caps));
  assert.equal(runnable.length, 51);

  // Inflecto capabilities would have rejected every sendinel cell (the original bug).
  assert.equal(cells.filter(c => isCellRunnableByMuse(c, PRODUCTS.inflecto.capabilities)).length, 0);
});

test('14. muse_runnable=false blocks a cell; inflecto behavior unchanged', () => {
  const caps = PRODUCTS.inflecto.capabilities;
  assert.equal(isCellRunnableByMuse(makeCell('i1', { surface: 'mcp', tier: 'pro' }), caps), true);
  assert.equal(isCellRunnableByMuse(makeCell('i2', { surface: 'mcp', tier: 'free' }), caps), false);
  assert.equal(isCellRunnableByMuse(makeCell('i3', { surface: 'browser', tier: 'free' }), caps), true);
  assert.equal(isCellRunnableByMuse(makeCell('i4', { surface: 'mcp', tier: 'pro', muse_runnable: true }), caps), true);
  assert.equal(isCellRunnableByMuse(makeCell('i5', { surface: 'mcp', tier: 'pro', muse_runnable: false }), caps), false);
});

// Mimics gh's real behavior: `label list` returns only 30 labels unless --limit is raised.
function wrapGhLabels(inner: Gh, opts: { allLabels: { name: string }[]; createError?: string }) {
  const calls: string[][] = [];
  const gh: Gh = async args => {
    calls.push(args);
    if (args[0] === 'label' && args[1] === 'list') {
      const li = args.indexOf('--limit');
      const limit = li >= 0 ? Number(args[li + 1]) : 30;
      return JSON.stringify(opts.allLabels.slice(0, limit));
    }
    if (args[0] === 'label' && args[1] === 'create' && opts.createError) {
      throw new Error(opts.createError);
    }
    return inner(args);
  };
  return { gh, calls };
}

async function runWithMissingBrief(wrap: (inner: Gh) => { gh: Gh; calls: string[][] }) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'planner-test-'));
  try {
    const matrix = makeMatrix([makeCell('c1', { smoke: true })]);
    const base = makeGh({ matrix });
    const w = wrap(base.gh);
    const res = await runPlanner({ gh: w.gh, gmail: makeGmail([]), statePath: join(tmpDir, 'ledger.json'), apply: true, now: FIXED_NOW });
    return { res, calls: w.calls };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

test('20. label list passes --limit 1000 and does not create muse-brief when it is label #45 of 60', async () => {
  const allLabels = Array.from({ length: 60 }, (_, i) => ({ name: i === 44 ? 'muse-brief' : `label-${i}` }));
  const { res, calls } = await runWithMissingBrief(inner => wrapGhLabels(inner, { allLabels }));
  const list = calls.find(c => c[0] === 'label' && c[1] === 'list')!;
  assert.equal(list[list.indexOf('--limit') + 1], '1000');
  assert.equal(calls.some(c => c[0] === 'label' && c[1] === 'create'), false);
  assert.equal(res.target_issue.action, 'created');
});

test('21. "already exists" from label create does not abort the planner', async () => {
  const { res, calls } = await runWithMissingBrief(inner =>
    wrapGhLabels(inner, { allLabels: [], createError: 'label with name "muse-brief" already exists; use `--force` to update' }));
  assert.equal(calls.some(c => c[0] === 'label' && c[1] === 'create'), true);
  assert.equal(res.target_issue.action, 'created');
});

test('22. other label create errors still abort', async () => {
  await assert.rejects(
    runWithMissingBrief(inner => wrapGhLabels(inner, { allLabels: [], createError: 'HTTP 403: forbidden' })),
    /403/,
  );
});

// --- per-product run budget (#39) ---

// Same shape for both products; only the tier differs because each product runs a different tier set.
function budgetMatrix(tier: string) {
  const mcp = Array.from({ length: 40 }, (_, i) => makeCell(`mcp-${i}`, { tier, est_mcp_calls: 3 }));
  const browser = Array.from({ length: 8 }, (_, i) => makeCell(`browser-${i}`, { tier, surface: 'browser', est_mcp_calls: 0 }));
  return makeMatrix([...mcp, ...browser]);
}

async function planBudget(product: 'inflecto' | 'sendinel', issues?: GitHubIssue[]) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'planner-test-'));
  try {
    const matrix = budgetMatrix(product === 'sendinel' ? 'member' : 'pro');
    const { gh } = makeGh({ matrix, issues });
    const res = await runPlanner({ gh, gmail: makeGmail([]), statePath: join(tmpDir, 'ledger.json'), product, now: FIXED_NOW });
    const chosen = matrix.cells.filter(c => res.brief.includes(`### \`${c.id}\``));
    return {
      mode: res.mode,
      cells: chosen.length,
      mcpCalls: chosen.filter(c => c.surface === 'mcp').reduce((n, c) => n + c.est_mcp_calls, 0),
      browser: chosen.filter(c => c.surface === 'browser').length,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

test('23. product budget config: inflecto unchanged (30/35 calls, 2 browser), sendinel 55/60 and 3', () => {
  assert.equal(PRODUCTS.inflecto.maxMcpCalls, 30);
  assert.equal(PRODUCTS.inflecto.maxMcpCallsRetestOnly, 35);
  assert.equal(PRODUCTS.inflecto.maxBrowserCells, 2);
  assert.equal(PRODUCTS.sendinel.maxMcpCalls, 55);
  assert.equal(PRODUCTS.sendinel.maxMcpCallsRetestOnly, 60);
  assert.equal(PRODUCTS.sendinel.maxBrowserCells, 3);
});

test('24. inflecto planned budget regression: <=30 calls and <=2 browser cells in NORMAL', async () => {
  const r = await planBudget('inflecto');
  assert.equal(r.mode, 'NORMAL');
  assert.equal(r.mcpCalls, 30);
  assert.equal(r.browser, 2);
});

test('25. sendinel selects more cells than inflecto for the same matrix; browser cap 3, <=55 calls', async () => {
  const inf = await planBudget('inflecto');
  const sen = await planBudget('sendinel');
  assert.equal(sen.mode, 'NORMAL');
  assert(sen.cells > inf.cells, `sendinel ${sen.cells} should exceed inflecto ${inf.cells}`);
  assert.equal(sen.browser, 3);
  assert(sen.mcpCalls <= 55 && sen.mcpCalls > 30, `sendinel mcpCalls ${sen.mcpCalls}`);
  assert.equal(sen.mcpCalls, 54); // 18 cells x 3 calls: largest multiple of 3 within 55
});

test('26. RETEST_ONLY budget: sendinel 60 calls, inflecto 35', async () => {
  const issues: GitHubIssue[] = Array.from({ length: 16 }, (_, i) => ({ number: 3000 + i, state: 'OPEN', title: `Open ${i}` }));
  const inf = await planBudget('inflecto', issues);
  const sen = await planBudget('sendinel', issues);
  assert.equal(inf.mode, 'RETEST_ONLY');
  assert.equal(sen.mode, 'RETEST_ONLY');
  assert(inf.mcpCalls <= 35 && sen.mcpCalls <= 60);
});


test('v1 zero-new report traverses actual planner consumption with FAIL/BLOCKED intact and activated v1 brief', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'planner-v1-test-'));
  try {
    const runId = '2026-11-08T10:00:00.000Z';
    const body = formatMuseReportV1({ runId, findings: [], coverage: [
      { cellId: 'known', result: 'FAIL', issueRefs: ['#101'] },
      { cellId: 'quota', result: 'BLOCKED', issueRefs: ['approval required'] },
    ], regressions: ['#101 FAIL: closed issue still reproduces'] });
    const matrix = makeMatrix([makeCell('known'), makeCell('quota')]);
    const { gh, calls } = makeGh({ matrix });
    const statePath = join(directory, 'ledger.json');
    const mail = { id: 'v1-synthetic', subject: `[Muse] Spec Inflecto ${runId}`, time: Date.parse(runId), body };
    const result = await runPlanner({ gh, gmail: makeGmail([mail]), statePath, now: FIXED_NOW });
    assert.equal(result.state.cells.known.last_result, 'FAIL');
    assert.equal(result.state.cells.quota.last_result, 'BLOCKED');
    assert.equal(result.state.cells.quota.last_pass, null);
    assert.equal(result.scoreboard.fails, 1);
    assert.equal(result.scoreboard.blocked, 1);
    assert.deepEqual(result.state.processed_message_ids, ['v1-synthetic']);
    assert.equal(result.brief.includes('MUSE_REPORT_VERSION: 1'), true); // activated 2026-11-15 (Kevin click)
    assert.equal(result.brief.includes('END_MUSE_REPORT'), true);
    assert.deepEqual(await readdir(directory), []); // dry-run did not create ledger/cursor
    assert.ok(calls.every(args => !['edit', 'create', 'pin'].includes(args[1])));
    for (const invalidMail of [
      { ...mail, body: body.replace('NEW_FINDINGS: 0', 'NEW_FINDINGS: 1') },
      { ...mail, subject: mail.subject.replace('10:00:', '11:00:') },
    ]) {
      await assert.rejects(runPlanner({ gh, gmail: makeGmail([invalidMail]), statePath, now: FIXED_NOW }), /Muse protocol:/);
      assert.deepEqual(await readdir(directory), []);
    }
  } finally { await rm(directory, { recursive: true }); }
});
