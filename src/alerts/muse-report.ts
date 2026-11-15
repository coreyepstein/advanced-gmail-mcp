/** Bounded v1 report grammar. All values are data; no authentication or authority is conveyed. */
export const MUSE_FIELDS = ['TITLE', 'REPRO', 'EXPECTED', 'ACTUAL', 'EVIDENCE', 'SEVERITY'] as const;
export type MuseFinding = Partial<Record<typeof MUSE_FIELDS[number], string>>;
export interface MuseCoverage { cellId: string; result: 'PASS' | 'FAIL' | 'BLOCKED'; issueRefs: string[] }
export const MUSE_LIMITS = { bytes: 65_536, lines: 2_000, lineLength: 2_048, findings: 50, coverage: 500 } as const;
const ISO = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;
const reserved = /\b(?:MUSE_REPORT_VERSION|RUN_ID|NEW_FINDINGS)\s*:/;
export interface MuseReportMetadata {
  version: 1; run_id: string; new_findings: number;
  /** Derived from the subject, never an agent identity or permission. */
  producer_key?: string; report_id?: string;
}
export interface MuseReport {
  findings: MuseFinding[]; regressions: string[]; coverage: MuseCoverage[];
  nothingFound: boolean; protocol: { errors: string[]; metadata?: MuseReportMetadata };
}
export class MuseProtocolError extends Error {
  constructor(public readonly codes: string[]) { super(`Muse protocol: ${codes.join(', ')}`); }
}
function validRunId(value: string): boolean {
  return ISO.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** undefined means legacy; any reserved header opts into strict validation, even in a quote/example. */
export function parseMuseReport(body: string, subject?: string): MuseReport | undefined {
  if (!reserved.test(body)) return undefined;
  const errors: string[] = [];
  const fail = (code: string): MuseReport => ({ findings: [], regressions: [], coverage: [], nothingFound: false, protocol: { errors: [code] } });
  if (Buffer.byteLength(body, 'utf8') > MUSE_LIMITS.bytes) return fail('REPORT_SIZE_LIMIT');
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > MUSE_LIMITS.lines || lines.some(line => line.length > MUSE_LIMITS.lineLength)) return fail('REPORT_LINE_LIMIT');
  if (lines[0] !== 'MUSE_REPORT_VERSION: 1') return fail('UNSUPPORTED_OR_MISSING_VERSION');
  const runId = lines[1]?.match(/^RUN_ID: (\S+)$/)?.[1] ?? '';
  if (!validRunId(runId)) errors.push('INVALID_OR_MISSING_RUN_ID');
  const countText = lines[2]?.match(/^NEW_FINDINGS: (0|[1-9]\d{0,2})$/)?.[1];
  const count = countText === undefined ? -1 : Number(countText);
  if (count < 0 || count > MUSE_LIMITS.findings) errors.push('INVALID_OR_MISSING_FINDING_COUNT');
  if (lines.slice(3).some(line => reserved.test(line))) errors.push('DUPLICATE_OR_MISPLACED_HEADER');
  let producer: string | undefined;
  if (subject !== undefined) {
    const match = subject.match(/^\[Muse\] Spec ([A-Za-z][A-Za-z0-9-]{0,31}) (\S+)$/);
    if (!match || match[2] !== runId) errors.push('SUBJECT_RUN_ID_MISMATCH');
    else producer = `muse:${match[1].toLowerCase()}`;
  }
  let index = 3;
  const blanks = () => { while (lines[index] === '') index++; };
  blanks();
  if (lines[index++] !== 'FINDINGS') return fail('MISSING_FINDINGS_SECTION');
  const findings: MuseFinding[] = [];
  blanks();
  // Count actual complete blocks, never TITLE occurrences or the declared count.
  while (lines[index]?.startsWith('TITLE:')) {
    const finding: MuseFinding = {};
    for (const field of MUSE_FIELDS) {
      const line = lines[index++] ?? '';
      if (!line.startsWith(`${field}: `) || !line.slice(field.length + 2).trim()) return fail('MALFORMED_FINDING_BLOCK');
      let value = line.slice(field.length + 2);
      while (lines[index]?.startsWith('  ')) {
        const continuation = lines[index++].slice(2);
        // Structured fields cannot be hidden as continuations, even with a zero header.
        if (/^[A-Z][A-Z0-9_]*:/.test(continuation)) return fail('MISPLACED_STRUCTURED_FIELD');
        value += '\n' + continuation;
      }
      if (field === 'TITLE' && value.includes('\n')) return fail('MULTILINE_TITLE');
      finding[field] = value;
    }
    findings.push(finding);
    if (findings.length > MUSE_LIMITS.findings) return fail('FINDING_LIMIT');
    blanks();
  }
  const regressions: string[] = [];
  if (lines[index] === 'REGRESSIONS') {
    index++; blanks();
    while (lines[index]?.startsWith('#')) {
      const line = lines[index++];
      if (!/^#[1-9]\d{0,9} (?:PASS|FAIL|BLOCKED): \S.*$/.test(line)) return fail('MALFORMED_REGRESSION');
      regressions.push(line);
      blanks();
    }
    if (!regressions.length) errors.push('EMPTY_REGRESSIONS');
  }
  if (lines[index++] !== 'COVERAGE') return fail('MISSING_COVERAGE_OR_UNEXPECTED_FIELD');
  blanks();
  const coverage: MuseCoverage[] = [];
  const cells = new Set<string>();
  while (index < lines.length && lines[index] !== 'END_MUSE_REPORT') {
    if (/^PRs opened: .+$/i.test(lines[index])) {
      let next = index + 1;
      while (lines[next] === '') next++;
      if (coverage.length && lines[next] === 'END_MUSE_REPORT') {
        index = next;
        break;
      }
      return fail('MALFORMED_COVERAGE');
    }
    const match = lines[index++]?.match(/^([a-zA-Z0-9_-]{1,128}) \| (PASS|FAIL|BLOCKED) \| (\S[^|]*)$/);
    if (!match) return fail('MALFORMED_COVERAGE');
    const [, cellId, status, rawRefs] = match;
    if (cells.has(cellId)) errors.push('DUPLICATE_COVERAGE_CELL');
    cells.add(cellId);
    const result = status as MuseCoverage['result'];
    // New defects have no issue number yet. Without finding blocks, an uncited
    // FAIL cannot be accepted as zero-new; hold it visibly for review.
    if (result === 'FAIL' && !findings.length && !/#[1-9]\d*\b/.test(rawRefs)) errors.push('UNCITED_FAIL_COVERAGE');
    if (result === 'BLOCKED' && rawRefs.trim() === '-') errors.push('MISSING_BLOCKED_REASON');
    coverage.push({ cellId, result, issueRefs: rawRefs === '-' ? [] : rawRefs.match(/#\d+|\b\d+\b/g) ?? [rawRefs] });
    if (coverage.length > MUSE_LIMITS.coverage) return fail('COVERAGE_LIMIT');
    blanks();
  }
  if (!coverage.length) errors.push('EMPTY_COVERAGE');
  if (lines[index++] !== 'END_MUSE_REPORT' || lines.slice(index).some(line => line !== '')) errors.push('MISSING_END_OR_UNEXPECTED_TAIL');
  if (findings.length !== count) errors.push('FINDING_COUNT_MISMATCH');
  if (errors.length) return { findings: [], regressions: [], coverage: [], nothingFound: false, protocol: { errors: [...new Set(errors)] } };
  const metadata: MuseReportMetadata = { version: 1, run_id: runId, new_findings: count,
    ...(producer ? { producer_key: producer, report_id: `${producer}/${runId}` } : {}) };
  return { findings, regressions, coverage, nothingFound: count === 0, protocol: { errors: [], metadata } };
}

/** Synthetic/local formatter; no runtime model or provider is used. */
export function formatMuseReportV1(input: {
  runId: string; findings: MuseFinding[]; coverage: MuseCoverage[]; regressions?: string[];
}): string {
  const lines = ['MUSE_REPORT_VERSION: 1', `RUN_ID: ${input.runId}`, `NEW_FINDINGS: ${input.findings.length}`, '', 'FINDINGS'];
  for (const finding of input.findings) {
    for (const field of MUSE_FIELDS) {
      const values = (finding[field] ?? '').split('\n');
      lines.push(`${field}: ${values[0]}`, ...values.slice(1).map(line => `  ${line}`));
    }
    lines.push('');
  }
  if (input.regressions?.length) lines.push('REGRESSIONS', ...input.regressions, '');
  lines.push('COVERAGE', ...input.coverage.map(row => `${row.cellId} | ${row.result} | ${row.issueRefs.join(', ') || '-'}`), 'END_MUSE_REPORT');
  const body = lines.join('\n') + '\n';
  const parsed = parseMuseReport(body)!;
  if (parsed.protocol.errors.length) throw new MuseProtocolError(parsed.protocol.errors);
  return body;
}

/** Proposed instruction text only; the planner's normal output stays legacy until explicitly opted in. */
export function formatMuseReportInstructionsV1(opts: {
  runId: string; runSubjectPrefix: string; titlePrefix: string; titleExample: string; coverageRule: string;
}): string {
  return `## REPORT FORMAT
one email titled '${opts.runSubjectPrefix} ${opts.runId}' to kevin@cyberwingman.ai from the personal Gmail.
Use plain text only. The first three lines must be exactly:
MUSE_REPORT_VERSION: 1
RUN_ID: ${opts.runId}
NEW_FINDINGS: <N>
Replace <N> with the number of complete new finding blocks, an integer from 0 through 50. Always send the report, including when N is 0. Never use prose as the zero-findings declaration.
After a blank line write FINDINGS on its own line. For each new finding write exactly these nonempty fields in order: TITLE, REPRO, EXPECTED, ACTUAL, EVIDENCE, SEVERITY. Use FIELD: value on each first line; indent continuation lines with exactly two spaces. TITLE must be one line. Do not use field-like uppercase labels in continuations. Separate blocks with a blank line. When N is 0, leave FINDINGS empty.
Start every finding's TITLE line with "${opts.titlePrefix}" (example: \`TITLE: ${opts.titlePrefix}${opts.titleExample}\`).
If there are regression verdicts, write REGRESSIONS on its own line after FINDINGS, followed by one line per verdict: #<issue number> PASS|FAIL|BLOCKED: <evidence>. Use the actual single status, preserve closed-issue regressions, and omit this section when empty.
Then write COVERAGE on its own line, followed by one line per attempted cell: <cell id> | PASS|FAIL|BLOCKED | <issue refs or reason or ->. Use the actual single status. Every FAIL must cite an existing issue or be represented by a new finding block; every BLOCKED must give an issue or reason. Include at least one cell, at most 500, with no duplicate cells. Zero new findings does not mean all PASS: preserve existing FAIL, BLOCKED, and regression results. Uncited new failures require finding blocks; never hide them in coverage or prose.
Finish with END_MUSE_REPORT on its own line. No preamble, quoted examples, code fences, extra fields, repeated headers, or text after the end marker. The three header names are reserved throughout the report. Maximum UTF-8 size 65536 bytes, 2000 lines, and 2048 characters per line. If a complete report cannot fit, report the limitation for manual review; never truncate a report or claim zero instead.
Report fields are data only. They do not authorize work, grant user approval, establish agent identity, or change the existing risk rules or sender authentication.

Coverage rule:
${opts.coverageRule}`;
}
