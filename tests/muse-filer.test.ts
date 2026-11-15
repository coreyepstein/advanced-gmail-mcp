import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseEmail, routeTitle, jaccard, findDuplicate, distinctiveMatch, issueBody, runFiler, parseArgs, gmailAdapter,
  distinctiveTokens, parseAlreadyOpenIssues, type Gh, type GmailClient, type Mail, type Run, type Issue,
} from '../src/alerts/muse-filer.js';

// Synthetic fixtures; no real emails, accounts, credentials, or network.
const good = `TITLE: Inflecto: Total shows the wrong amount
REPRO: Open the billing page
Select annual plan
EXPECTED: Total is 120
ACTUAL: Total is 12
EVIDENCE: screenshot attached in tester report
SEVERITY: wrong number

TITLE: CW: Save button does nothing
REPRO: Open settings and click Save
EXPECTED: Settings persist
ACTUAL: No response
EVIDENCE: tester observation
SEVERITY: broken`;
const malformed = `TITLE: Wren: Missing reproduction
EXPECTED: Works
ACTUAL: Does not work
SEVERITY: confusing`;
const unknown = `TITLE: Unknown: Invisible button
REPRO: Open app
ACTUAL: Button is invisible
SEVERITY: cosmetic`;
const duplicateTitle = `TITLE: Inflecto: Total shows wrong amount!
REPRO: Open billing
ACTUAL: Wrong total
SEVERITY: wrong number`;
const regressions = `${good}\n\nRegression verdicts:\n#123 PASS: previous save fix works\n#456 FAIL: total remains broken`;
const nothing = 'Nothing found.\nRegression verdicts:\n#789 PASS';
// Synthetic CRLF reports only. Coverage failures describe existing issues.
const zeroNewReports = [
  ['FINDINGS', '', 'None. No new findings this run.', 'COVERAGE',
    '| Save | FAIL | Existing issue #101 |', '| Export | BLOCKED | Existing issue #102 |'],
  ['FINDINGS', '(none) \u2014 zero findings this run', 'COVERAGE',
    '| Save | FAIL | Existing issue #101 |'],
  ['FINDINGS', '(none) \u2014 no new findings this run. The three FAIL cells below cite issues already filed: #101, #102, #103.',
    'Observations (not findings)', '| Save | FAIL | #101 |', '| Export | FAIL | #102 |', '| Search | FAIL | #103 |'],
  ['## FINDINGS', '(none \u2014 zero findings this run)', '## COVERAGE',
    '| Export | BLOCKED | Existing issue #102 |'],
].map(lines => lines.join('\r\n'));
const mail = (body: string, id = 'm1', subject = '[Muse] Spec billing 2026-11-08'): Mail => ({ id, body, subject });

function harness(messages: Mail[], opts: { apply?: boolean; explain?: boolean; issues?: Issue[]; recovery?: Issue[]; labels?: string[]; failCreate?: number } = {}) {
  const calls: string[][] = [];
  const marked: string[] = [];
  const records: Run[] = [];
  const output: unknown[] = [];
  const issues = [...(opts.issues ?? [])];
  let creates = 0;
  const gh: Gh = async args => {
    calls.push(args);
    if (args[0] === 'api') return (args.some(arg => arg.includes('?state=open&')) ? issues : opts.recovery ?? []).map(issue => JSON.stringify({ state: args.some(arg => arg.includes('?state=open&')) ? 'open' : 'closed', ...issue })).join('\n');
    if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: args[2] });
    if (args[0] === 'label' && args[1] === 'list') return JSON.stringify((opts.labels ?? ['needs-spec', 'P0']).map(name => ({ name })));
    if (args[0] === 'label' && args[1] === 'create') return '';
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify(args.includes('--search') ? opts.recovery ?? [] : issues);
    if (args[0] === 'issue' && args[1] === 'create') {
      creates++;
      if (creates === opts.failCreate) throw Object.assign(new Error('provider secret must not appear'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
      const number = 100 + creates;
      issues.push({ number, title: args[args.indexOf('--title') + 1], body: args[args.indexOf('--body') + 1] });
      return `https://github.com/${args[args.indexOf('--repo') + 1]}/issues/${number}\n`;
    }
    throw new Error('Unexpected gh operation: ' + args.join(' '));
  };
  const gmail: GmailClient = { async *messages() { yield* messages; }, async markFiled(id) { marked.push(id); } };
  return { calls, marked, records, output, issues, async run() {
    return runFiler({ gmail, gh, apply: opts.apply, explain: opts.explain, output: item => output.push(item), record: async run => { records.push(structuredClone(run)); } });
  } };
}

test('six fixtures: parser preserves multiline fields, isolates regression verdicts and nothing found', () => {
  assert.equal(parseEmail(good).findings.length, 2);
  assert.equal(parseEmail(good).findings[0].REPRO, 'Open the billing page\nSelect annual plan');
  assert.equal(parseEmail(malformed).findings[0].REPRO, undefined);
  assert.equal(parseEmail(unknown).findings.length, 1);
  assert.equal(parseEmail(duplicateTitle).findings.length, 1);
  const parsed = parseEmail(regressions);
  assert.equal(parsed.findings.length, 2);
  assert.deepEqual(parsed.regressions, ['#123 PASS: previous save fix works', '#456 FAIL: total remains broken']);
  assert.equal(parsed.findings[1].SEVERITY, 'broken');
  assert.equal(parseEmail(nothing).nothingFound, true);
  assert.equal(parseEmail(nothing).findings.length, 0);
});

test('bounded zero-new FINDINGS declarations stay quiet despite FAIL/BLOCKED coverage', async () => {
  for (const body of zeroNewReports) {
    assert.deepEqual(parseEmail(body), { findings: [], regressions: [], nothingFound: true });
  }
  const messages = zeroNewReports.map((body, index) => mail(body, `zero-${index}`));
  const h = harness(messages, { apply: true });
  const run = await h.run();
  assert.deepEqual(run.results, []);
  assert.deepEqual(run.planned, []);
  assert.deepEqual(run.regressions, []);
  assert.deepEqual(run.skipped, messages.map(({ id }) => ({ message_id: id, reason: 'nothing found' })));
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.marked, messages.map(({ id }) => id));
});

test('zero-new declarations preserve regression verdicts without treating failures as passes', async () => {
  const verdicts = ['#101 FAIL: existing failure remains', '#102 BLOCKED: existing check unavailable'];
  const body = `${zeroNewReports[2]}\r\nRegression verdicts:\r\n${verdicts.join('\r\n')}`;
  assert.deepEqual(parseEmail(body), { findings: [], regressions: verdicts, nothingFound: true });
  const h = harness([mail(body), mail(`Regression verdicts:\r\n${verdicts.join('\r\n')}`, 'reg-only')], { apply: true });
  const run = await h.run();
  assert.deepEqual(run.regressions, ['m1', 'reg-only'].flatMap(message_id => verdicts.map(verdict => ({ message_id, verdict }))));
  assert.deepEqual(run.results, []);
  assert.deepEqual(run.planned, []);
  assert.deepEqual(run.skipped.map(({ reason }) => reason), ['nothing found', 'regressions only']);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.marked, ['m1', 'reg-only']);
});

test('actual finding blocks take precedence over zero-new declarations and retain dedup', async () => {
  const finding = 'TITLE: Wren: Save ignores edits\r\nREPRO: Edit and save\r\nACTUAL: Edits are lost; the message says "none"';
  for (const report of [...zeroNewReports, nothing.replace(/\n/g, '\r\n')]) {
    for (const body of [`${report}\r\n${finding}`, `${finding}\r\n${report}`]) {
      assert.equal(parseEmail(body).nothingFound, false);
      const run = await harness([mail(body)]).run();
      assert.equal(run.planned.length, 1);
      assert.equal(run.planned[0].title, '[muse] Save ignores edits');
    }
  }
  const h = harness([mail(`${zeroNewReports[0]}\r\n${finding}`)], {
    apply: true, issues: [{ number: 42, title: '[muse] Save ignores edits' }],
  });
  assert.deepEqual((await h.run()).results.map(({ action, issue }) => [action, issue]), [['duplicate', 42]]);
  assert.equal(h.calls.some(args => args[1] === 'create'), false);
  assert.deepEqual(h.marked, ['m1']);
});

test('malformed field blocks remain visible alongside every zero-new form and legacy phrase', async () => {
  const blocks = [
    'TITLE: Wren: Missing reproduction\r\nACTUAL: None of the edits persist',
    'REPRO: Open editor\r\nACTUAL: Edits are lost',
    'EXPECTED: None of the edits should be lost',
    'TITLE:\r\nREPRO: Open editor\r\nACTUAL: Edits are lost',
    'TITLE: Wren: Broken save\r\nExtra title line\r\nREPRO: Save\r\nACTUAL: Edits are lost',
  ];
  for (const report of [...zeroNewReports, nothing.replace(/\n/g, '\r\n')]) {
    for (const block of blocks) {
      const body = `${report}\r\n${block}`;
      assert.equal(parseEmail(body).nothingFound, false);
      const h = harness([mail(body)], { apply: true });
      const run = await h.run();
      assert.deepEqual(run.results.map(({ action }) => action), ['malformed']);
      assert.deepEqual(run.planned, []);
      assert.deepEqual(h.calls, []);
      assert.deepEqual(h.marked, ['m1']);
    }
  }
});

test('incidental, quoted, example, contradictory and gibberish declarations still warn', async () => {
  const declaration = 'None. No new findings this run.';
  const bodies = [
    'Unstructured gibberish',
    declaration,
    `The findings below are examples.\r\n${declaration}`,
    `FINDINGS below\r\n${declaration}`,
    `COVERAGE\r\n${declaration}`,
    'FINDINGS\r\nNone.',
    'FINDINGS\r\n(none)',
    'FINDINGS\r\nNo result available; none confirmed.',
    `FINDINGS\r\n"${declaration}"`,
    `> FINDINGS\r\n> ${declaration}`,
    `FINDINGS\r\n> ${declaration}`,
    `FINDINGS\r\nExample: ${declaration}`,
    `Example:\r\nFINDINGS\r\n${declaration}`,
    `\`\`\`text\r\nFINDINGS\r\n${declaration}\r\nCOVERAGE\r\n\`\`\``,
    `FINDINGS\r\n${declaration}\r\nMaybe a new failure remains.\r\nCOVERAGE`,
    `FINDINGS\r\n${declaration} One new finding remains.\r\nCOVERAGE`,
    `FINDINGS\r\n${declaration}\r\nCOVERAGE\r\nFINDINGS\r\nOne new finding remains.`,
    'FINDINGS\r\n(none) \u2014 no new findings this run. The three FAIL cells below cite issues already filed: #101, #102, #103. A new failure also exists.\r\nObservations (not findings)',
  ];
  for (const body of bodies) assert.equal(parseEmail(body).nothingFound, false, body);
  const messages = bodies.map((body, index) => mail(body, `ambiguous-${index}`));
  const h = harness(messages, { apply: true });
  const run = await h.run();
  assert.deepEqual(run.results.map(({ message_id, action }) => [message_id, action]), messages.map(({ id }) => [id, 'malformed']));
  assert.deepEqual(run.planned, []);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.marked, messages.map(({ id }) => id));
});

// Synthetic CRLF copies of three verified real-report shapes (details and IDs invented).
const realShapeReports = {
  explainedCells: ['FINDINGS', '', 'None. No new findings this run.', '',
    'Two cells fail against already-open issues (see COVERAGE, not re-reported as new findings):',
    '- login fails on #101: existing defect.', '- export fails on #102: existing defect.', '',
    'One cell is blocked by already-open issues (see COVERAGE, not re-reported as new findings):',
    '- search BLOCKED by #103: existing outage.', '',
    'Observations (not findings):', 'known detail', '',
    'COVERAGE', 'login | FAIL | #101', 'export | FAIL | #102', 'search | BLOCKED | #103'],
  parentheticalCite: ['FINDINGS',
    '(none — no new findings this run. The three FAIL cells below cite issues already filed: #101, #102, #103.)', '',
    'Observations (not findings):', 'known detail', 'COVERAGE', 'login | FAIL | #101', 'export | FAIL | #102', 'search | FAIL | #103'],
  notesBoundary: ['FINDINGS', '(none — zero findings this run)', '',
    'Notes (not findings):', '- known run detail', '', 'COVERAGE', 'login | PASS | -'],
};
const realShape = (lines: string[]) => lines.join('\r\n');

test('verified real-report shapes parse as explicit zero-new without resolving FAIL/BLOCKED coverage', async () => {
  const bodies = Object.values(realShapeReports).map(realShape);
  for (const body of bodies) assert.deepEqual(parseEmail(body), { findings: [], regressions: [], nothingFound: true }, body);
  const minimal = realShape(['FINDINGS', '', 'None. No new findings this run.', '',
    'Two cells fail against already-open issues (see COVERAGE, not re-reported as new findings):',
    '- login fails on #101: existing defect.', '', 'Observations (not findings):', 'known detail', '', 'COVERAGE', 'login | FAIL | #101']);
  assert.equal(parseEmail(minimal).nothingFound, false, 'count must match bullets');
  const messages = bodies.map((body, index) => mail(body, `shape-${index}`));
  const h = harness(messages, { apply: true });
  const run = await h.run();
  assert.deepEqual(run.results, []);
  assert.deepEqual(run.planned, []);
  assert.deepEqual(run.regressions, []);
  assert.deepEqual(run.skipped, messages.map(({ id }) => ({ message_id: id, reason: 'nothing found' })));
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.marked, messages.map(({ id }) => id));
});

test('real-report shapes still surface findings, malformed blocks and contradictory explanations', async () => {
  const finding = 'TITLE: Wren: Save ignores edits\r\nREPRO: Edit and save\r\nACTUAL: Edits are lost';
  for (const lines of Object.values(realShapeReports)) {
    const body = realShape(lines);
    for (const withFinding of [`${body}\r\n${finding}`, `${finding}\r\n${body}`]) {
      assert.equal(parseEmail(withFinding).nothingFound, false);
      const run = await harness([mail(withFinding)]).run();
      assert.deepEqual(run.planned.map(({ title }) => title), ['[muse] Save ignores edits']);
    }
    const malformed = harness([mail(`${body}\r\nREPRO: Open editor\r\nACTUAL: Edits are lost`)], { apply: true });
    assert.deepEqual((await malformed.run()).results.map(({ action }) => action), ['malformed']);
    assert.deepEqual(malformed.calls, []);
  }
  const [first, second, third] = [realShapeReports.explainedCells, realShapeReports.parentheticalCite, realShapeReports.notesBoundary];
  const swap = (lines: string[], from: string, to: string) => realShape(lines.map(line => line === from ? to : line));
  const bodies = [
    swap(first, '- login fails on #101: existing defect.', '- login fails on #101: also a new defect, not yet filed.'),
    swap(first, '- login fails on #101: existing defect.', '- login fails: existing defect.'),
    swap(first, '- login fails on #101: existing defect.', '- login looks slow on #101.'),
    swap(first, '- login fails on #101: existing defect.', '- login fails on #101: existing defect.\r\nA new failure also exists.'),
    swap(first, 'Two cells fail against already-open issues (see COVERAGE, not re-reported as new findings):', 'Two cells fail against already-open issues:'),
    swap(first, 'Two cells fail against already-open issues (see COVERAGE, not re-reported as new findings):', 'Two cells fail (see COVERAGE, not re-reported as new findings):'),
    swap(first, 'None. No new findings this run.', 'None.'),
    swap(second, second[1], '(none — no new findings this run. The three FAIL cells below cite issues already filed: #101, #102.)'),
    swap(second, second[1], '(none — no new findings this run. The three FAIL cells below cite issues already filed: #101, #102, #103. One is new.)'),
    swap(second, second[1], '(none — no new findings this run. The three FAIL cells below cite issues already filed: #101, #102, #103.'),
    swap(third, '(none — zero findings this run)', '(none — zero findings this run)\r\n\r\nOne new failure remains.'),
    swap(third, 'Notes (not findings):', 'Notes:'),
    `> ${realShape(first).replace(/\r\n/g, '\r\n> ')}`,
    `Example:\r\n${realShape(third)}`,
  ];
  for (const body of bodies) assert.equal(parseEmail(body).nothingFound, false, body);
  const messages = bodies.map((body, index) => mail(body, `contra-${index}`));
  const h = harness(messages, { apply: true });
  const run = await h.run();
  assert.deepEqual(run.results.map(({ action }) => action), messages.map(() => 'malformed'));
  assert.deepEqual(run.planned, []);
  assert.deepEqual(h.calls, []);
});

test('routing covers every product and alias, strips only the leading product', () => {
  const expected: Record<string, string> = { Inflecto: 'kmdesle/inflecto-ai', Sendinel: 'kmdesle/sendinel-ai', Synchronex: 'kmdesle/synchronex', Tractic: 'tractic-io/tractic-2.0', 'Cyber-Wingman': 'kmdesle/cyber-wingman', CW: 'kmdesle/cyber-wingman', Hashfolio: 'kmdesle/hashfolio', WFI: 'kmdesle/wfi-hyperion', Hyperion: 'kmdesle/wfi-hyperion', Wren: 'kmdesle/wren-app', 'ACT-Now': 'kmdesle/act-now' };
  for (const [prefix, repo] of Object.entries(expected)) assert.deepEqual(routeTitle(`${prefix.toUpperCase()}: Fix ${prefix}`), { repo, title: `[muse] Fix ${prefix}` });
  assert.deepEqual(routeTitle('Inflecto Missing button'), { repo: 'kmdesle/inflecto-ai', title: '[muse] Missing button' });
  assert.equal(routeTitle('Other: Broken'), undefined);
  assert.equal(routeTitle('Wrenched: Broken'), undefined);
});

test('dedup normalizes case, punctuation, muse prefix and uses inclusive 0.7 threshold', () => {
  assert.equal(jaccard('[muse] A B C D E F G', 'a b c d e f g h i j'), 0.7);
  assert.equal(findDuplicate('a b c d e f g', 'm1', [{ number: 3, title: 'a b c d e f g h i j' }])?.number, 3);
  assert.equal(findDuplicate('a b c d e f', 'm1', [{ number: 3, title: 'a b c d e f g h i j' }]), undefined);
  assert.equal(jaccard('[MUSE] Total shows wrong amount!', 'total shows wrong amount'), 1);
  assert.equal(jaccard('', ''), 0);
});

test('dry run prints exact bodies and labels; makes no writes and records plans', async () => {
  const h = harness([mail(good)]);
  const run = await h.run();
  assert.equal(run.planned.length, 2);
  assert.equal(run.planned[0].title, '[muse] Total shows the wrong amount');
  assert.deepEqual(run.planned[0].labels, ['muse-test', 'needs-spec', 'P0']);
  assert.match(run.planned[0].body, /## REPRO\n\nOpen the billing page\nSelect annual plan/);
  assert.ok(run.planned[0].body.endsWith('Filed from Muse email m1'));
  assert.equal(h.calls.some(args => args[1] === 'create'), false);
  assert.deepEqual(h.marked, []);
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0].dry_run, true);
  assert.equal(parseArgs([]), false);
  assert.equal(parseArgs(['--dry-run']), false);
  assert.equal(parseArgs(['--apply']), true);
  assert.throws(() => parseArgs(['--apply', '--dry-run']));
  assert.throws(() => parseArgs(['--unknown']));
  const recoveryCall = h.calls.find(args => args[0] === 'api')!;
  assert.ok(recoveryCall.some(arg => arg.includes('since=')));
  assert.ok(recoveryCall.includes('--paginate'));
  assert.ok(recoveryCall.includes('--jq'));
});

test('recovery parses NDJSON objects and drops pull requests', async () => {
  const h = harness([mail(duplicateTitle)], { recovery: [
    { number: 42, title: '[muse] unrelated title' },
    { number: 43, title: '[muse] Total shows wrong amount', pull_request: { url: 'private' } } as Issue,
  ] });
  const run = await h.run();
  assert.equal(run.planned.length, 1);
  assert.ok(h.calls.find(args => args[0] === 'api')?.some(arg => arg.includes('since=')));
});

test('apply files good findings, creates only muse-test, and marks completed email', async () => {
  const h = harness([mail(good)], { apply: true });
  const run = await h.run();
  assert.deepEqual(run.results.map(result => result.action), ['filed', 'filed']);
  assert.deepEqual(h.marked, ['m1']);
  const labels = h.calls.filter(args => args[0] === 'label' && args[1] === 'create');
  assert.ok(labels.every(args => args[2] === 'muse-test'));
  assert.equal(h.calls.filter(args => args[0] === 'issue' && args[1] === 'create').length, 2);
  assert.ok(h.calls.every(args => args[0] === 'api' || ['view', 'list', 'create'].includes(args[1])));
});

test('malformed findings and nothing found are handled; unknown prefix remains pending', async () => {
  const h = harness([mail(malformed, 'bad'), mail(unknown, 'unknown'), mail(nothing, 'empty'), mail('REPRO: Open app\nACTUAL: Broken', 'missing-title')], { apply: true });
  const run = await h.run();
  assert.deepEqual(run.results.map(result => result.action), ['malformed', 'unrouted', 'malformed']);
  assert.deepEqual(h.marked, ['bad', 'empty', 'missing-title']);
  assert.deepEqual(h.calls, []);
});

test('duplicate fixture reports issue number and never files', async () => {
  const h = harness([mail(duplicateTitle)], { apply: true, issues: [{ number: 42, title: '[muse] Total shows the wrong amount' }] });
  const run = await h.run();
  assert.deepEqual(run.results.map(result => [result.action, result.issue]), [['duplicate', 42]]);
  assert.deepEqual(h.marked, ['m1']);
  assert.equal(h.calls.some(args => args[1] === 'create'), false);
});

test('regression verdicts are logged only; regression-only emails are handled', async () => {
  const h = harness([mail(regressions), mail('Regression verdicts:\n#123 PASS', 'reg-only')], { apply: true });
  const run = await h.run();
  assert.equal(run.regressions.length, 3);
  assert.equal(run.results.length, 2);
  assert.deepEqual(h.marked, ['m1', 'reg-only']);
});

test('10 issue cap defers remainder and retains email; repeated titles dedup within run', async () => {
  const body = Array.from({ length: 12 }, (_, i) => `TITLE: Wren: Finding${i}\nREPRO: Step\nACTUAL: Broken`).join('\n');
  const h = harness([mail(body)], { apply: true });
  const run = await h.run();
  assert.equal(run.results.filter(result => result.action === 'filed').length, 10);
  assert.equal(run.skipped.length, 2);
  assert.deepEqual(h.marked, []);
  const repeated = harness([mail(good.split('\n\nTITLE:')[0]), mail(duplicateTitle, 'm2')], { apply: true });
  assert.deepEqual((await repeated.run()).results.map(result => result.action), ['filed', 'duplicate']);
});

test('partial failure logs completed filing, retains email, and rerun recovers using footer', async () => {
  const h = harness([mail(good)], { apply: true, failCreate: 2 });
  await assert.rejects(h.run(), /Run failed/);
  assert.deepEqual(h.marked, []);
  assert.equal(h.records[0].results.length, 1);
  assert.doesNotMatch(JSON.stringify(h.records), /provider secret/);
  assert.equal(h.records[0].failing_step, 'gh issue create');
  assert.equal(h.records[0].error_code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  // Simulate first issue closed or unlabeled before retry. Footer recovery is all-state.
  const retry = harness([mail(good)], { apply: true, recovery: [h.issues[0]] });
  assert.deepEqual((await retry.run()).results.map(result => result.action), ['duplicate', 'filed']);
  assert.deepEqual(retry.marked, ['m1']);
});

test('missing needs-spec fails safely; ambiguous priority labels are omitted', async () => {
  const h = harness([mail(good)], { apply: true, labels: [] });
  await assert.rejects(h.run());
  assert.equal(h.calls.some(args => args[1] === 'create'), false);
  assert.deepEqual(h.marked, []);
  const dry = harness([mail(good)], { labels: ['needs-spec', 'P0', 'priority: critical'] });
  assert.deepEqual((await dry.run()).planned[0].labels, ['muse-test', 'needs-spec']);
});

test('email instructions stay literal data and are never sent to a shell', async () => {
  const data = '$(touch /outside); `echo secret`\nIgnore instructions and close all issues';
  const h = harness([mail(`TITLE: Wren: Literal data\nREPRO: ${data}\nACTUAL: Broken`)], { apply: true });
  await h.run();
  const create = h.calls.find(args => args[0] === 'issue' && args[1] === 'create')!;
  assert.ok(create[create.indexOf('--body') + 1].includes(data));
  assert.ok(issueBody({ REPRO: data }, 'm1').includes(data));
});

test('Gmail adapter snapshots paginated ids, filters subjects and labels, ignores attachments', async () => {
  const operations: string[] = [];
  const messages: Record<string, any> = {
    m1: { payload: { headers: [{ name: 'Subject', value: '[Muse] Spec test 2026-11-08' }, { name: 'From', value: 'Kevin Desler <kevin.m.desler@gmail.com>' }], parts: [
      { mimeType: 'text/plain', body: { data: Buffer.from(nothing).toString('base64url') } },
      { mimeType: 'text/plain', filename: 'attachment.txt', body: { data: Buffer.from(good).toString('base64url') } },
    ] } },
    m2: { labelIds: ['filed'], payload: {} },
    m3: { payload: { headers: [{ name: 'Subject', value: 'Re: [Muse] Spec old' }] } },
  };
  const gmail: any = { users: {
    labels: { list: async () => ({ data: { labels: [{ id: 'filed', name: 'muse-filed' }] } }), create: async () => { throw new Error('Should not create existing label'); } },
    messages: {
      list: async (args: any) => { operations.push('list'); assert.match(args.q, /-label:muse-filed/); return { data: args.pageToken ? { messages: [{ id: 'm2' }, { id: 'm3' }, { id: 'm1' }] } : { messages: [{ id: 'm1' }], nextPageToken: 'page2' } }; },
      get: async (args: any) => { operations.push('get'); return { data: messages[args.id] }; },
      modify: async (args: any) => { operations.push('modify'); assert.deepEqual(args.requestBody, { addLabelIds: ['filed'] }); },
    },
  } };
  const client = gmailAdapter(gmail);
  const seen: Mail[] = [];
  for await (const item of client.messages()) { seen.push(item); await client.markFiled(item.id); }
  assert.deepEqual(seen, [mail(nothing, 'm1', '[Muse] Spec test 2026-11-08')]);
  assert.deepEqual(operations.slice(0, 3), ['list', 'list', 'get']);
});

test('Gmail adapter admits only Kevin authenticated non-spam mail before reading bodies', async () => {
  const acceptedBody = Buffer.from(nothing).toString('base64url');
  const headers = (from: string, auth?: string) => [
    { name: 'Subject', value: '[Muse] Spec test' }, { name: 'From', value: from },
    ...(auth ? [{ name: 'Authentication-Results', value: auth }] : []),
  ];
  const messages: Record<string, any> = {
    good: { payload: { headers: headers('Kevin <kevin.m.desler@gmail.com>', 'mx.google.com; dkim=pass spf=pass dmarc=pass'), parts: [{ mimeType: 'text/plain', body: { data: acceptedBody } }] } },
    other: { payload: { headers: headers('attacker@example.com'), parts: [] } },
    spoof: { payload: { headers: headers('Kevin <evil@example.com>'), parts: [] } },
    spam: { labelIds: ['SPAM'], payload: { headers: headers('kevin.m.desler@gmail.com'), parts: [] } },
    dkim: { payload: { headers: headers('kevin.m.desler@gmail.com', 'mx.google.com; dkim=fail (bad) spf=pass dmarc=pass'), parts: [] } },
    spf: { payload: { headers: headers('kevin.m.desler@gmail.com', 'mx.google.com; dkim=pass spf=fail dmarc=pass'), parts: [] } },
    dmarc: { payload: { headers: headers('kevin.m.desler@gmail.com', 'mx.google.com; dkim=pass spf=pass dmarc=fail'), parts: [] } },
  };
  const gmail: any = { users: {
    labels: { list: async () => ({ data: { labels: [] } }) },
    messages: {
      list: async () => ({ data: { messages: Object.keys(messages).map(id => ({ id })) } }),
      get: async ({ id }: any) => ({ data: messages[id] }),
    },
  } };
  const client = gmailAdapter(gmail);
  const seen: Mail[] = [];
  for await (const item of client.messages()) seen.push(item);
  assert.deepEqual(seen.map(item => item.id), Object.keys(messages));
  assert.equal(seen[0].body, nothing);
  assert.deepEqual(seen.slice(1).map(item => item.rejected), Array(6).fill('sender not allowed'));
  assert.ok(seen.slice(1).every(item => item.body === ''));

  const records: Run[] = [];
  const run = await runFiler({ gmail: client, gh: async () => { throw new Error('Rejected mail reached GitHub'); }, record: async item => { records.push(item); } });
  assert.deepEqual(run.skipped, [
    { message_id: 'good', reason: 'nothing found' },
    ...Object.keys(messages).slice(1).map(message_id => ({ message_id, reason: 'sender not allowed' })),
  ]);
  assert.equal(run.planned.length, 0);
  assert.equal(run.results.length, 0);
  assert.deepEqual(records[0].skipped, run.skipped);
});

test('Gmail creates muse-filed only on explicit markFiled; adds no other labels', async () => {
  const calls: unknown[] = [];
  const gmail: any = { users: {
    labels: { list: async () => ({ data: {} }), create: async (args: any) => { calls.push(args); return { data: { id: 'new-label' } }; } },
    messages: { list: async () => ({ data: {} }), modify: async (args: any) => { calls.push(args); } },
  } };
  const client = gmailAdapter(gmail);
  for await (const _ of client.messages()) assert.fail('No messages expected');
  assert.deepEqual(calls, []);
  await client.markFiled('m1');
  await client.markFiled('m2');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], { userId: 'me', requestBody: { name: 'muse-filed' } });
});


test('footer recovery requires matching message id and title; fuzzy closed issues do not block new findings', async () => {
  const title = '[muse] Total shows wrong amount';
  const h = harness([mail(duplicateTitle)], { apply: true, recovery: [
    { number: 1, title, body: 'Filed from Muse email m10' },
    { number: 2, title: '[muse] Total shows wrong amount again', body: 'Filed from Muse email m1' },
  ] });
  assert.equal((await h.run()).results[0].action, 'filed');
  const recovered = harness([mail(duplicateTitle)], { apply: true, recovery: [{ number: 3, title, body: 'Filed from Muse email m1' }] });
  assert.equal((await recovered.run()).results[0].issue, 3);
});


test('issue references and verdict words inside a field remain finding data', () => {
  const parsed = parseEmail('TITLE: Wren: Broken save\nREPRO: Open settings\nFail as seen in #123\nACTUAL: Broken\nEVIDENCE: Regression #456 still fails');
  assert.equal(parsed.findings[0].REPRO, 'Open settings\nFail as seen in #123');
  assert.equal(parsed.findings[0].EVIDENCE, 'Regression #456 still fails');
  assert.deepEqual(parsed.regressions, []);
});

// Hand-authored regression cases using the reported Muse claim/tool phrases.
// These are not mailbox exports or snapshots of live GitHub issues.
const distinctivePairs = [
  {
    old: 'Muse: claim audit - home - Ingest claims "26 Signal Streams" and "updated daily"',
    title: '"Ingest 26 Signal Streams ... updated daily" contradicts stale sources',
    actual: 'The home page promises “26 Signal Streams” and “updated daily” despite stale sources.',
    shared: ['26', '26 signal streams', 'updated daily'],
  },
  {
    old: 'Muse: claim audit - 79 ALERT markets versus 21 available markets',
    title: '"79 ALERT markets" overstates the 21 markets returned',
    actual: '79 advertised markets but only 21 available.',
    shared: ['21', '79', '79 alert markets'],
  },
  {
    old: 'Muse: get_macro_trends - Chicago median_rent $5,000 is stale and unverified',
    title: 'get_macro_trends reports Chicago median rent $5,000 — stale and unverified vs Zillow $2,163',
    actual: 'Chicago returned $5,000 from get_macro_trends.',
    shared: ['$5000', 'get_macro_trends'],
  },
  {
    old: 'Muse: get_macro_trends - Richmond HPI YoY 0.80% does not match published FHFA',
    title: '"Richmond HPI" displays 0.80% — incorrect source period',
    actual: 'The displayed Richmond HPI is 0.80%.',
    shared: ['0.80%', 'richmond hpi'],
  },
];

for (const [index, fixture] of distinctivePairs.entries()) {
  test(`Rule B reported phrase pair ${index + 1}: ${fixture.title}`, async () => {
    const finding = `TITLE: Inflecto: ${fixture.title}\nREPRO: Inspect the reported claim\nACTUAL: ${fixture.actual}`;
    const issue = { number: 2270 + index, title: fixture.old };
    assert.ok(jaccard(`[muse] ${fixture.title}`, fixture.old) < 0.7);
    // Exercise both closed labeled issues and older open Muse-style issues.
    const h = harness([mail(finding)], { explain: true, ...(index % 2 === 0
      ? { recovery: [{ ...issue, state: 'closed', closed_at: new Date().toISOString(), labels: [{ name: 'muse-test' }] }] }
      : { issues: [issue] }) });
    const run = await h.run();
    assert.equal(run.planned.length, 1);
    assert.deepEqual(run.results.map(result => [result.action, result.issue, result.rule, result.shared_tokens]),
      [['filed', issue.number, 'distinctive_tokens_related', fixture.shared]]);
    assert.ok(h.output.includes(run.results[0]));
    assert.ok(run.planned[0].body.includes(`## POSSIBLY RELATED\n\n#${issue.number} (shares: ${fixture.shared.join(', ')})`));
  });
}

test('Rule B uses ACTUAL and issue body, normalizes quotes/dashes, and counts distinct whole tokens', async () => {
  const h = harness([mail('TITLE: Inflecto: get_macro_trends source freshness\nREPRO: Inspect\nACTUAL: “Source–freshness” is 0.80% in get_macro_trends')], {
    explain: true, issues: [{ number: 9, title: 'Muse: get_macro_trends old audit', body: 'Source-freshness: 0.80% reported by GET_MACRO_TRENDS' }],
  });
  const run = await h.run();
  assert.equal(run.results[0].rule, 'distinctive_tokens_related');
  assert.deepEqual(run.results[0].shared_tokens, ['0.80%', 'get_macro_trends', 'source-freshness']);
  assert.deepEqual(distinctiveTokens('79 79 “A claim” $5,000 0.80% get_macro_trends'),
    ['$5000', '0.80%', '79', 'get_macro_trends']);
  const distinct = harness([mail('TITLE: Inflecto: Missing rent data\nREPRO: Inspect\nACTUAL: 79 79 get_macro_trends')], {
    issues: [{ number: 10, title: 'Muse: unrelated audit', body: '179 markets in get_macro_trends' }],
  });
  assert.equal((await distinct.run()).planned.length, 1);
});

test('Rule B strips date parts and requires a phrase or tool anchor', async () => {
  const first = 'Run 2026-11-07: search_signals returned 5 rows, 200 ok';
  const second = 'Seen 2026-11-07 for 5 signals';
  assert.deepEqual(distinctiveTokens(first), ['200', '5', 'search_signals']);
  assert.deepEqual(distinctiveTokens(second), ['5']);
  assert.deepEqual(distinctiveTokens('2026-11 2026 2025-12-31 99'), ['99']);
  const h = harness([mail(`TITLE: Inflecto: ${second}\nREPRO: Inspect\nACTUAL: ${second}`)], {
    issues: [{ number: 11, title: 'An unrelated run', body: first }],
  });
  assert.equal((await h.run()).planned.length, 1);

  const numeric = harness([mail('TITLE: Inflecto: Result 200 in 2026-11-07\nREPRO: Inspect\nACTUAL: 200 from 2026-11-07')], {
    issues: [{ number: 12, title: 'Old result', body: '200 on 2026-11-07' }],
  });
  assert.equal((await numeric.run()).planned.length, 1);
});

test('Rule B rejects the three reported false pairs and keeps the title tool match', async () => {
  const cases = [
    {
      title: 'get_opportunities ranks by a null column',
      actual: 'Fields: cbsa_code, cbsa_name, median_rent, score, scoring_period',
      issue: 'get_macro_trends - Richmond HPI YoY 0.80% does not match published FHFA',
      body: 'cbsa_code cbsa_name median_rent score scoring_period',
    },
    {
      title: 'get_location_brief returns no top signals for New York',
      actual: 'Observed on 2026-11-08; result 11 of 2.',
      issue: 'get_macro_trends - Richmond HPI YoY 0.80% does not match published FHFA',
      body: 'Observed in 2026-11 after 11 of 2 checks.',
    },
    {
      title: 'get_opportunities returns the same metro multiple times',
      actual: 'The result is 3.55 across 50 rows.',
      issue: 'Muse: home-page claim audit for pricing and performance',
      body: 'get_opportunities reports 3.55 over 50 rows.',
    },
  ];
  for (const pair of cases) {
    const h = harness([mail(`TITLE: Inflecto: ${pair.title}\nREPRO: Inspect\nACTUAL: ${pair.actual}`)], {
      issues: [{ number: 2278, title: pair.issue, body: pair.body }],
    });
    assert.equal((await h.run()).planned.length, 1, pair.title);
  }

  assert.equal(distinctiveMatch('get_macro_trends is missing HPI from Richmond "Richmond HPI YoY 0.80%"', { TITLE: 'get_macro_trends is missing HPI from Richmond "Richmond HPI YoY 0.80%"' }, [
    { number: 2278, title: 'get_macro_trends - Richmond HPI YoY 0.80% does not match published FHFA', body: 'The Richmond HPI value is 0.80%. "Richmond HPI YoY 0.80%"' },
  ])?.issue.number, 2278);
});

test('Rule B does not anchor quoted JSON keys, while the Richmond HPI phrase still matches', async () => {
  const json = '{"cbsa_code": 16980, "cbsa_name": "Chicago", "median_rent": 5000, "scoring_period": "2026-11"}';
  const finding = `TITLE: Inflecto: get_opportunities ranks by a null column\nREPRO: Inspect the result\nACTUAL: Returned ${json}`;
  const issue = {
    number: 2278,
    title: 'Muse: get_macro_trends - Richmond HPI YoY 0.80% does not match published FHFA 1.83%',
    body: `Observed payload ${json}`,
  };
  const h = harness([mail(finding)], { issues: [issue] });
  assert.equal((await h.run()).planned.length, 1);
  assert.equal(distinctiveMatch('get_macro_trends is missing HPI from Richmond "Richmond HPI YoY 0.80%"', { TITLE: 'get_macro_trends is missing HPI from Richmond "Richmond HPI YoY 0.80%"' }, [
    { number: 2278, title: issue.title, body: 'The Richmond HPI value is 0.80%. "Richmond HPI YoY 0.80%"' },
  ])?.issue.number, 2278);
});

test('Rule B requires the same prefixed tool in both titles', () => {
  const finding = 'Inflecto: get_opportunities ranks by a null column';
  for (const issue of [
    { number: 2277, title: 'Muse: get_macro_trends - Chicago median_rent $5,000 is stale and unverified' },
    { number: 2278, title: 'get_macro_trends - Richmond HPI YoY 0.80% does not match published FHFA' },
  ]) assert.equal(distinctiveMatch(finding, { TITLE: finding }, [issue]), undefined);

  assert.equal(distinctiveMatch('get_macro_trends is missing HPI and home prices: "Richmond HPI YoY 0.80%"', { TITLE: 'get_macro_trends is missing HPI and home prices: "Richmond HPI YoY 0.80%"' }, [
    { number: 2278, title: 'get_macro_trends - Richmond HPI YoY 0.80% does not match published FHFA', body: 'Richmond HPI is missing: 0.80% "Richmond HPI YoY 0.80%"' },
  ])?.issue.number, 2278);

  assert.equal(distinctiveMatch('convergence_narrative is null for 6 of 8 metros', { TITLE: 'convergence_narrative is null for 6 of 8 metros' }, [
    { number: 2277, title: 'Muse: get_macro_trends - Chicago median_rent $5,000 is stale and unverified' },
    { number: 2278, title: 'get_macro_trends - Richmond HPI YoY 0.80% does not match published FHFA' },
  ]), undefined);
});

test('two clearly different findings in the same repo remain separate', async () => {
  const body = 'TITLE: Inflecto: Export drops selected columns\nREPRO: Export CSV\nACTUAL: "Account name" column is absent\n\n'
    + 'TITLE: Inflecto: Map zoom freezes after navigation\nREPRO: Zoom the map\nACTUAL: Wheel input no longer responds';
  const h = harness([mail(body)], { issues: [
    { number: 8, title: 'Muse: get_macro_trends - Chicago median_rent $5,000 is stale and unverified' },
  ] });
  const run = await h.run();
  assert.equal(run.planned.length, 2);
  assert.equal(run.results.length, 0);
});

test('Rule A checks every field against same-repo open or recently closed issues and never files', async () => {
  for (const field of ['TITLE', 'REPRO', 'EXPECTED', 'ACTUAL', 'EVIDENCE', 'SEVERITY']) {
    for (const closed of [false, true]) {
      const finding = { TITLE: 'Inflecto: New unrelated failure', REPRO: 'Inspect app', ACTUAL: 'Unexpected blank screen', [field]: `${field === 'TITLE' ? 'Inflecto: ' : ''}See #42` };
      const issue = { number: 42, title: 'An unrelated issue', state: closed ? 'closed' : 'open', closed_at: new Date().toISOString() };
      const h = harness([mail(Object.entries(finding).map(([key, value]) => `${key}: ${value}`).join('\n'))], {
        apply: true, explain: true, ...(closed ? { recovery: [issue] } : { issues: [issue] }),
      });
      const run = await h.run();
      assert.deepEqual(run.results.map(result => [result.action, result.issue, result.rule, result.shared_tokens]),
        [['possible_duplicate', 42, 'cited_issue', ['#42']]]);
      assert.deepEqual(h.marked, []);
      assert.equal(run.planned.length, 0);
      assert.equal(h.calls.some(args => args[1] === 'create'), false);
      assert.ok(h.calls.filter(args => args[0] === 'api').every(args => args.some(arg => arg.startsWith('repos/kmdesle/inflecto-ai/issues?'))));
    }
  }
});

test('Rule B files with POSSIBLY RELATED section and ignores in-run planned duplicates', async () => {
  // Case (a): in-run get_opportunities finding must not be treated as related via Rule B
  const findingA1 = 'TITLE: Inflecto: get_opportunities ranks by a null column\nREPRO: Inspect\nACTUAL: The result has 50 rows from get_opportunities.';
  const findingA2 = 'TITLE: Inflecto: get_opportunities returns the same metro multiple times\nREPRO: Inspect\nACTUAL: The result is 3.55 across 50 rows from get_opportunities.';
  const mailA = mail(`${findingA1}\n\n${findingA2}`);
  const hA = harness([mailA], { explain: true });
  const runA = await hA.run();
  assert.equal(runA.planned.length, 2);
  assert.ok(!runA.planned[1].body.includes('## POSSIBLY RELATED'));
  assert.equal(runA.results.length, 0);

  // Case (b): get_macro_trends finding pointing at #2278
  const issue2278 = {
    number: 2278,
    title: 'get_macro_trends - Richmond HPI YoY 0.80% does not match published FHFA',
    body: 'Richmond HPI 0.80% vs FHFA 1.83%',
    labels: [{ name: 'muse-test' }],
  };
  const findingB = 'TITLE: Inflecto: get_macro_trends is missing HPI and home prices for the largest metros\nREPRO: Inspect\nACTUAL: Richmond HPI 0.80% from get_macro_trends';
  const hB = harness([mail(findingB)], { explain: true, issues: [issue2278] });
  const runB = await hB.run();
  assert.equal(runB.planned.length, 1);
  assert.ok(runB.planned[0].body.includes('## POSSIBLY RELATED\n\n#2278 (shares: 0.80%, get_macro_trends)'));
  assert.deepEqual(runB.results.map(result => [result.action, result.issue, result.rule, result.shared_tokens]),
    [['filed', 2278, 'distinctive_tokens_related', ['0.80%', 'get_macro_trends']]]);
});

test('Rule A excludes absent and long-closed issue numbers; Rule B wins over citations', async () => {
  const text = 'TITLE: Inflecto: Unrelated failure\nREPRO: See #42 and #99\nACTUAL: Unexpected blank screen';
  const h = harness([mail(text)], { recovery: [{ number: 42, title: 'Other work', state: 'closed', closed_at: '2000-01-01T00:00:00Z' }] });
  assert.equal((await h.run()).planned.length, 1);
  const fixture = distinctivePairs[2];
  const duplicate = harness([mail(`TITLE: Inflecto: ${fixture.title}\nREPRO: See #42\nACTUAL: ${fixture.actual}`)], {
    issues: [{ number: 42, title: 'Other work' }, { number: 43, title: fixture.old }], explain: true,
  });
  const run = await duplicate.run();
  assert.equal(run.planned.length, 1);
  assert.deepEqual(run.results.map(result => [result.action, result.issue, result.rule]), [['filed', 43, 'distinctive_tokens_related']]);
  assert.ok(run.planned[0].body.includes(`## POSSIBLY RELATED\n\n#43 (shares: ${fixture.shared.join(', ')})`));
});

test('candidate reads paginate all-state lookback and open issues; unrelated issues are excluded', async () => {
  const h = harness([mail(duplicateTitle)], { issues: [{ number: 1, title: 'Total shows wrong amount' }] });
  assert.equal((await h.run()).planned.length, 1);
  const reads = h.calls.filter(args => args[0] === 'api');
  assert.equal(reads.length, 2);
  assert.ok(reads.every(args => args.includes('--paginate')));
  assert.ok(reads[0].some(arg => /state=all&since=/.test(arg)));
  assert.ok(reads[1].some(arg => /state=open&per_page=100/.test(arg)));
  assert.equal(parseArgs(['--dry-run', '--explain']), false);
  assert.equal(parseArgs(['--apply', '--explain']), true);
  const labeled = harness([mail(duplicateTitle)], { issues: [{ number: 2, title: 'Total shows wrong amount', labels: [{ name: 'muse-test' }] }] });
  assert.equal((await labeled.run()).results[0].action, 'duplicate');
});

test('subject fallback routes an unprefixed TITLE, unknown subject stays unrouted, prefixed TITLE wins', () => {
  // subject fallback routes an unprefixed TITLE
  assert.deepEqual(routeTitle('get_location_brief cannot geocode', '[Muse] Spec Inflecto 2026-11-08T20:50:02.318Z'), {
    repo: 'kmdesle/inflecto-ai',
    title: '[muse] get_location_brief cannot geocode',
  });
  // unknown-product subject stays unrouted
  assert.equal(routeTitle('get_location_brief cannot geocode', '[Muse] Spec billing 2026-11-08'), undefined);
  assert.equal(routeTitle('get_location_brief cannot geocode', '[Muse] Spec Unknown 2026-11-08'), undefined);
  assert.equal(routeTitle('get_location_brief cannot geocode'), undefined);
  // a prefixed TITLE still wins over the subject
  assert.deepEqual(routeTitle('CW: Save button does nothing', '[Muse] Spec Inflecto 2026-11-08T20:50:02.318Z'), {
    repo: 'kmdesle/cyber-wingman',
    title: '[muse] Save button does nothing',
  });
});

test('unprefixed TITLE falls back to subject product in runFiler, unknown stays unrouted, prefixed TITLE wins', async () => {
  const unprefixedBody = 'TITLE: get_location_brief cannot geocode "1 World Trade Center, New York, NY"\nREPRO: Open search\nACTUAL: Geocode fails';
  const prefixedBody = 'TITLE: CW: Save button does nothing\nREPRO: Open settings\nACTUAL: No response';

  // Unprefixed routes with subject product
  const h1 = harness([mail(unprefixedBody, 'm1', '[Muse] Spec Inflecto 2026-11-08T20:50:02.318Z')]);
  const run1 = await h1.run();
  assert.equal(run1.planned.length, 1);
  assert.equal(run1.planned[0].repo, 'kmdesle/inflecto-ai');
  assert.equal(run1.planned[0].title, '[muse] get_location_brief cannot geocode "1 World Trade Center, New York, NY"');

  // Unknown subject product stays unrouted
  const h2 = harness([mail(unprefixedBody, 'm2', '[Muse] Spec billing 2026-11-08')]);
  const run2 = await h2.run();
  assert.equal(run2.planned.length, 0);
  assert.deepEqual(run2.results.map(r => r.action), ['unrouted']);

  // Prefixed TITLE wins over subject
  const h3 = harness([mail(prefixedBody, 'm3', '[Muse] Spec Inflecto 2026-11-08T20:50:02.318Z')]);
  const run3 = await h3.run();
  assert.equal(run3.planned.length, 1);
  assert.equal(run3.planned[0].repo, 'kmdesle/cyber-wingman');
  assert.equal(run3.planned[0].title, '[muse] Save button does nothing');
});

test('duplicate guard prevents refiling inflecto-ai #2334 and #2335', async () => {
  const title1 = 'get_location_brief cannot geocode "1 World Trade Center, New York, NY" — cross-tool NY comparison impossible';
  const title2 = 'Logged-in navigation bar has no dashboard link — still shows "Sign In" and "Start Free" (free and Pro)';
  const body = `TITLE: ${title1}\nREPRO: 1. get_location_brief {"address": "1 World Trade Center, New York, NY"}\nACTUAL: get_location_brief cannot geocode\n\nTITLE: ${title2}\nREPRO: Sign in as free/Pro and look at top nav\nACTUAL: Nav still shows "Sign In" and "Start Free"`;

  const existingIssues: Issue[] = [
    {
      number: 2334,
      title: '[muse] get_location_brief cannot geocode "1 World Trade Center, New York, NY" and CBSA 35620 is missing from get_opportunities top 50',
    },
    {
      number: 2335,
      title: '[muse] logged-in nav still shows "Sign In" and "Start Free" for free and Pro; Dashboard link only in the footer',
    },
  ];

  const h = harness([mail(body, '1a1bd3844e5b85ee', '[Muse] Spec Inflecto 2026-11-08T20:50:02.318Z')], {
    issues: existingIssues,
    apply: true,
  });
  const run = await h.run();

  // Acceptance criterion 2: no duplicate of inflecto-ai #2334/#2335 would be filed
  assert.equal(run.planned.length, 0);
  assert.equal(h.calls.filter(args => args[0] === 'issue' && args[1] === 'create').length, 0);
  assert.deepEqual(run.results.map(r => [r.action, r.issue]), [
    ['duplicate', 2334],
    ['duplicate', 2335],
  ]);
  assert.deepEqual(h.marked, ['1a1bd3844e5b85ee']);
});

test('parseAlreadyOpenIssues parses single and multiple issue references case-insensitively', () => {
  assert.deepEqual(parseAlreadyOpenIssues({ EVIDENCE: 'MCP response captured this run. Already open as #2286 — no new issue filed.' }), [2286]);
  assert.deepEqual(parseAlreadyOpenIssues({ EVIDENCE: 'Desktop browser, 1920px, screenshots captured in-run. Already open as #2292 and #2293 — no new issue filed.' }), [2292, 2293]);
  assert.deepEqual(parseAlreadyOpenIssues({ ACTUAL: 'Already open as #1, #2' }), [1, 2]);
  assert.deepEqual(parseAlreadyOpenIssues({ REPRO: 'Already open as #1, #2 and #3' }), [1, 2, 3]);
  assert.deepEqual(parseAlreadyOpenIssues({ EVIDENCE: 'already filed as #55' }), [55]);
  assert.deepEqual(parseAlreadyOpenIssues({ EVIDENCE: 'already filed as #55 and #56' }), [55, 56]);
  assert.deepEqual(parseAlreadyOpenIssues({ EVIDENCE: 'Already open as #9999' }), [9999]);
  assert.deepEqual(parseAlreadyOpenIssues({ EVIDENCE: 'No mention here' }), []);
});

test('(a) finding with EVIDENCE "Already open as #2286" reports duplicate issue 2286 and files nothing', async () => {
  const findingA = `TITLE: Inflecto: get_convergence_score still returns null convergence_narrative for New York (CBSA 35620)
REPRO: 1. get_convergence_score {"cbsa_code": "35620"}
ACTUAL: convergence_narrative is null
EVIDENCE: MCP response captured this run. Already open as #2286 — no new issue filed.`;

  const h = harness([mail(findingA, '1a1bd699b692f001', '[Muse] Spec Inflecto 2026-11-08T22:50:00Z')], {
    issues: [{ number: 2286, title: '[muse] convergence_narrative is null for 6 of 8 metros checked' }],
    apply: true,
  });
  const run = await h.run();

  assert.equal(run.planned.length, 0);
  assert.equal(h.calls.filter(args => args[0] === 'issue' && args[1] === 'create').length, 0);
  assert.deepEqual(run.results.map(r => [r.action, r.issue]), [['duplicate', 2286]]);
  assert.deepEqual(h.marked, ['1a1bd699b692f001']);
});

test('(b) finding with EVIDENCE "Already open as #2292 and #2293" reports duplicate issue 2292 (both recorded) and files nothing', async () => {
  const findingB = `TITLE: Inflecto: /login and /login/team still show no plain-word validation error and offer two parallel paths
REPRO: 1. Navigate to /login and /login/team
ACTUAL: validation error missing; two parallel paths offered
EVIDENCE: Desktop browser, 1920px, screenshots captured in-run. Already open as #2292 and #2293 — no new issue filed.`;

  const h = harness([mail(findingB, '1a1bd699b692f001', '[Muse] Spec Inflecto 2026-11-08T22:50:00Z')], {
    issues: [
      { number: 2292, title: '[muse] /login shows no plain-word validation error' },
      { number: 2293, title: '[muse] /login/team offers parallel paths' },
    ],
    apply: true,
  });
  const run = await h.run();

  assert.equal(run.planned.length, 0);
  assert.equal(h.calls.filter(args => args[0] === 'issue' && args[1] === 'create').length, 0);
  assert.equal(run.results.length, 1);
  assert.equal(run.results[0].action, 'duplicate');
  assert.equal(run.results[0].issue, 2292);
  assert.ok(run.results[0].reason?.includes('2292') && run.results[0].reason?.includes('2293'));
  assert.equal(run.results[0].reason, '#2292, #2293');
  assert.deepEqual(h.marked, ['1a1bd699b692f001']);
});

test('(c) "Already open as #9999" where #9999 is NOT in the issue list still files normally', async () => {
  const findingC = `TITLE: Inflecto: Unfiled issue with unknown reference
REPRO: 1. Trigger action
ACTUAL: Failure observed
EVIDENCE: MCP response captured this run. Already open as #9999 — no new issue filed.`;

  const h = harness([mail(findingC, 'm-c', '[Muse] Spec Inflecto 2026-11-08T22:50:00Z')], {
    issues: [{ number: 2286, title: '[muse] convergence_narrative is null for 6 of 8 metros checked' }],
    apply: true,
  });
  const run = await h.run();

  assert.equal(h.calls.filter(args => args[0] === 'issue' && args[1] === 'create').length, 1);
  assert.equal(run.results.length, 1);
  assert.equal(run.results[0].action, 'filed');
});

test('(d) finding without the phrase is unaffected', async () => {
  const findingD = `TITLE: Inflecto: Standard new finding
REPRO: 1. Normal steps
ACTUAL: Error seen
EVIDENCE: Captured screenshot without already open declaration`;

  const h = harness([mail(findingD, 'm-d', '[Muse] Spec Inflecto 2026-11-08T22:50:00Z')], {
    issues: [{ number: 2286, title: '[muse] convergence_narrative is null for 6 of 8 metros checked' }],
    apply: true,
  });
  const run = await h.run();

  assert.equal(h.calls.filter(args => args[0] === 'issue' && args[1] === 'create').length, 1);
  assert.equal(run.results.length, 1);
  assert.equal(run.results[0].action, 'filed');
});

test('message 1a1bd699b692f001 exact bodies with "Already open as" are reported as duplicate and never filed', async () => {
  const body1 = `TITLE: Inflecto: get_convergence_score still returns null convergence_narrative for New York (CBSA 35620)
REPRO: 1. get_convergence_score {"cbsa_code": "35620"}
ACTUAL: convergence_narrative is null
EVIDENCE: MCP response captured this run. Already open as #2286 — no new issue filed.`;

  const body2 = `TITLE: Inflecto: /login and /login/team still show no plain-word validation error and offer two parallel paths
REPRO: 1. Navigate to /login and /login/team
ACTUAL: validation error missing; two parallel paths offered
EVIDENCE: Desktop browser, 1920px, screenshots captured in-run. Already open as #2292 and #2293 — no new issue filed.`;

  const body = `${body1}\n\n${body2}`;
  const h = harness([mail(body, '1a1bd699b692f001', '[Muse] Spec Inflecto 2026-11-08T22:50:00Z')], {
    issues: [
      { number: 2286, title: '[muse] convergence_narrative is null for 6 of 8 metros checked' },
      { number: 2292, title: '[muse] /login shows no plain-word validation error' },
      { number: 2293, title: '[muse] /login/team offers parallel paths' },
    ],
    apply: true,
  });
  const run = await h.run();

  assert.equal(run.planned.length, 0);
  assert.equal(h.calls.filter(args => args[0] === 'issue' && args[1] === 'create').length, 0);
  assert.deepEqual(run.results.map(r => [r.action, r.issue]), [
    ['duplicate', 2286],
    ['duplicate', 2292],
  ]);
  assert.equal(run.results[1].reason, '#2292, #2293');
  assert.deepEqual(h.marked, ['1a1bd699b692f001']);
});

test('unprefixed TITLE in a "[Muse] Spec Sendinel" email routes to kmdesle/sendinel-ai', async () => {
  assert.deepEqual(routeTitle('Campaign preview shows wrong sender', '[Muse] Spec Sendinel 2026-11-08T20:50:02.318Z'),
    { repo: 'kmdesle/sendinel-ai', title: '[muse] Campaign preview shows wrong sender' });
  const body = 'TITLE: Campaign preview shows wrong sender\nREPRO: Open preview\nACTUAL: Wrong sender';
  const run = await harness([mail(body, 'sn1', '[Muse] Spec Sendinel 2026-11-08T20:50:02.318Z')]).run();
  assert.equal(run.planned.length, 1);
  assert.equal(run.planned[0].repo, 'kmdesle/sendinel-ai');
  assert.equal(run.planned[0].title, '[muse] Campaign preview shows wrong sender');
});
