#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { gmail_v1 } from 'googleapis';
import { parseMuseReport, MuseProtocolError, formatMuseReportInstructionsV1 } from './muse-report.js';

export interface MatrixCell {
  id: string;
  kind: string;
  target: string;
  tier: string;
  surface: 'mcp' | 'browser';
  steps: string[];
  pass: string;
  est_mcp_calls: number;
  risk_flags: string[];
  guards: number[];
  smoke: boolean;
  weekly: boolean;
  muse_runnable?: boolean;
  muse_blocked_reason?: string | null;
}

export interface Matrix {
  version: number;
  generated: string;
  coverage_rule: string;
  accounts: Record<string, string>;
  budget: {
    smoke_est_mcp_calls: number;
    full_pass_est_mcp_calls: number;
  };
  cells: MatrixCell[];
}

export interface GitHubIssue {
  number: number;
  state: string; // 'OPEN' | 'CLOSED'
  closedAt?: string | null;
  title: string;
  body?: string;
}

export interface CellLedgerEntry {
  last_result: 'PASS' | 'FAIL' | 'BLOCKED' | null;
  last_run: string | null;
  last_pass: string | null;
  last_fail: string | null;
  consecutive_blocked?: number;
  runs: number;
  issue_refs: string[];
}

export interface Scoreboard {
  coverage_pct: number;
  passed_7d: number;
  total: number;
  fails: number;
  blocked: number;
  never_run: number;
  not_runnable?: number;
  stuck_blocked?: number;
}

export interface PlannerState {
  version: 1;
  processed_message_ids: string[];
  cells: Record<string, CellLedgerEntry>;
  last_daily_walk?: string;
  scoreboard?: Scoreboard;
}

export interface CoverageRecord {
  cellId: string;
  result: 'PASS' | 'FAIL' | 'BLOCKED';
  issueRefs: string[];
}

export interface MuseMail {
  id: string;
  subject: string;
  time: number;
  body: string;
}

export type Gh = (args: string[]) => Promise<string>;

export interface ReadonlyPlannerGmail {
  users: {
    messages: {
      list(params: gmail_v1.Params$Resource$Users$Messages$List): Promise<{ data: gmail_v1.Schema$ListMessagesResponse }>;
      get(params: gmail_v1.Params$Resource$Users$Messages$Get): Promise<{ data: gmail_v1.Schema$Message }>;
    };
  };
}

export interface PlannerDeps {
  gh: Gh;
  gmail: ReadonlyPlannerGmail | (() => Promise<ReadonlyPlannerGmail>);
  apply?: boolean;
  statePath?: string;
  now?: number;
  output?: (line: unknown) => void;
  repo?: string;
  account?: string;
  product?: ProductId;
}

export interface PlannerResult {
  run_id: string;
  mode: 'NORMAL' | 'RETEST_ONLY';
  scoreboard: Scoreboard;
  scoreboard_line: string;
  retest_count: number;
  smoke_count: number;
  fill_count: number;
  daily_walk_count: number;
  weekly_count: number;
  target_issue: {
    number: number;
    action: 'created' | 'edited' | 'skipped' | 'would_create' | 'would_edit';
  };
  brief: string;
  state: PlannerState;
}

const DEFAULT_ACCOUNT = 'kevin@cyberwingman.ai';

export type Capabilities = Record<string, readonly string[]>;

export const RUNNER_CAPABILITIES: Capabilities = {
  mcp: ['pro', 'premium'],
  browser: ['free', 'pro', 'premium'],
};

export const SENDINEL_CAPABILITIES: Capabilities = {
  mcp: ['member'],
  browser: ['anonymous', 'member'],
};

export type ProductId = 'inflecto' | 'sendinel';

export interface ProductConfig {
  id: ProductId;
  repo: string;
  matrixPath: string;
  /** Path relative to ~/.local/state/muse-planner */
  ledgerRelPath: string;
  /** Report email subject prefix; the run id is appended after a space. */
  runSubjectPrefix: string;
  titlePrefix: string;
  titleExample: string;
  briefLabel: string;
  briefTitle: string;
  /** Pin the brief issue when it is created (Sendinel only). */
  pinBrief: boolean;
  gmailQuery: string;
  subjectPrefixes: string[];
  capabilities: Capabilities;
  /** Per-run MCP call budget in NORMAL mode (already net of the 5-call exploratory reserve). */
  maxMcpCalls: number;
  /** Per-run MCP call budget in RETEST_ONLY mode (no exploratory section, so reserve is not held back). */
  maxMcpCallsRetestOnly: number;
  /** Per-run cap on browser cells. */
  maxBrowserCells: number;
  rules: string[];
}

export const PRODUCTS: Record<ProductId, ProductConfig> = {
  inflecto: {
    id: 'inflecto',
    repo: 'kmdesle/inflecto-ai',
    matrixPath: 'docs/qa/muse-coverage-matrix.json',
    ledgerRelPath: 'ledger.json',
    runSubjectPrefix: '[Muse] Spec Inflecto',
    titlePrefix: 'Inflecto: ',
    titleExample: 'get_location_brief cannot geocode ...',
    briefLabel: 'muse-brief',
    briefTitle: 'Muse next-run brief (auto-generated, do not edit)',
    pinBrief: false,
    gmailQuery: '{subject:"[Muse] Spec" subject:"Muse Inflecto test"}',
    subjectPrefixes: ['[Muse] Spec', 'Muse Inflecto test'],
    capabilities: RUNNER_CAPABILITIES,
    maxMcpCalls: 30, // 35 - 5 exploratory
    maxMcpCallsRetestOnly: 35,
    maxBrowserCells: 2,
    rules: [
      'password login at /login/team only',
      'no forms that send email',
      'never Create key',
      'never checkout/Stripe/portal',
      'no early-access form',
      'quote visible strings exactly with a screenshot',
      'desktop only (mobile is covered elsewhere)',
    ],
  },
  sendinel: {
    id: 'sendinel',
    repo: 'kmdesle/sendinel-ai',
    matrixPath: 'docs/qa/muse-coverage-matrix.json',
    ledgerRelPath: 'sendinel/ledger.json',
    runSubjectPrefix: '[Muse] Spec Sendinel',
    titlePrefix: 'Sendinel: ',
    titleExample: 'campaign preview shows the wrong sender ...',
    briefLabel: 'muse-brief',
    briefTitle: 'Muse brief: Sendinel coordinated testing',
    pinBrief: true,
    gmailQuery: 'subject:"[Muse] Spec Sendinel"',
    subjectPrefixes: ['[Muse] Spec Sendinel'],
    capabilities: SENDINEL_CAPABILITIES,
    maxMcpCalls: 55, // 60 - 5 exploratory
    maxMcpCallsRetestOnly: 60,
    maxBrowserCells: 3,
    rules: [
      'use ONLY the Muse sandbox project and the Muse test user; sandbox project only',
      'allowlisted targets only: never send to anyone outside the project allowlist',
      'no prod account creation: never create accounts on production hosts',
      'never checkout/Stripe/portal',
      'quote visible strings exactly with a screenshot',
      'desktop only (mobile is covered elsewhere)',
    ],
  },
};

export function getProduct(id: string | undefined): ProductConfig {
  const product = PRODUCTS[(id ?? 'inflecto') as ProductId];
  if (!product || !Object.hasOwn(PRODUCTS, id ?? 'inflecto')) {
    throw new Error(`Unknown product: ${id}`);
  }
  return product;
}

export const stateDir = () => join(homedir(), '.local/state/muse-planner');
export const productStatePath = (product: ProductConfig) => join(stateDir(), product.ledgerRelPath);
export const defaultStatePath = () => productStatePath(PRODUCTS.inflecto);

export function isCellRunnableByMuse(cell: MatrixCell, capabilities: Capabilities = RUNNER_CAPABILITIES): boolean {
  if (cell.muse_runnable === false) return false;
  if (!Object.hasOwn(capabilities, cell.surface)) return false;
  const allowedTiers = capabilities[cell.surface];
  if (!allowedTiers) return false;
  return allowedTiers.includes(cell.tier);
}

export function canSelectCell(cell: MatrixCell, entry: CellLedgerEntry | undefined, now: number, capabilities: Capabilities = RUNNER_CAPABILITIES): boolean {
  if (!isCellRunnableByMuse(cell, capabilities)) {
    return false;
  }
  if (!entry) {
    return true;
  }
  if ((entry.consecutive_blocked ?? 0) >= 3) {
    return false;
  }
  if (entry.last_result === 'BLOCKED' && entry.last_run) {
    const lastRunMs = Date.parse(entry.last_run);
    if (!Number.isNaN(lastRunMs) && now - lastRunMs < 24 * 3600 * 1000) {
      return false;
    }
  }
  return true;
}

export function parseCoverageSection(body: string, validCellIds: Set<string>, subject?: string): CoverageRecord[] {
  const versioned = parseMuseReport(body, subject);
  if (versioned) {
    if (versioned.protocol.errors.length) throw new MuseProtocolError(versioned.protocol.errors);
    return versioned.coverage.filter(row => validCellIds.has(row.cellId));
  }
  const records: CoverageRecord[] = [];
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let inCoverage = false;
  for (const line of lines) {
    if (!inCoverage) {
      if (/\bCOVERAGE\b/i.test(line)) {
        inCoverage = true;
      }
      continue;
    }
    const match = line.match(/^\s*([a-zA-Z0-9_-]+)\s*\|\s*(PASS|FAIL|BLOCKED)\s*\|\s*(.*?)\s*$/);
    if (!match) continue;
    const cellId = match[1];
    if (!validCellIds.has(cellId)) continue;
    const result = match[2] as 'PASS' | 'FAIL' | 'BLOCKED';
    const rawRefs = match[3].trim();
    const issueRefs: string[] = [];
    if (rawRefs && rawRefs !== '-') {
      const tokens = rawRefs.match(/#\d+|\b\d+\b/g);
      if (tokens) {
        issueRefs.push(...tokens);
      } else {
        issueRefs.push(rawRefs);
      }
    }
    records.push({ cellId, result, issueRefs });
  }
  return records;
}

export function applyCoverageRecord(
  cells: Record<string, CellLedgerEntry>,
  record: CoverageRecord,
  timeIso: string
): void {
  let entry = cells[record.cellId];
  if (!entry) {
    entry = {
      last_result: null,
      last_run: null,
      last_pass: null,
      last_fail: null,
      consecutive_blocked: 0,
      runs: 0,
      issue_refs: [],
    };
    cells[record.cellId] = entry;
  }
  entry.runs += 1;
  entry.last_run = timeIso;
  entry.last_result = record.result;
  if (record.result === 'PASS') {
    entry.last_pass = timeIso;
    entry.consecutive_blocked = 0;
  } else if (record.result === 'FAIL') {
    entry.last_fail = timeIso;
    entry.consecutive_blocked = 0;
  } else if (record.result === 'BLOCKED') {
    entry.consecutive_blocked = (entry.consecutive_blocked ?? 0) + 1;
  }
  if (record.issueRefs.length > 0) {
    entry.issue_refs = [...new Set([...entry.issue_refs, ...record.issueRefs])];
  }
}

export function normalizeBrief(text: string): string {
  return text
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<TIMESTAMP>')
    .trim();
}

function formatCell(cell: MatrixCell): string {
  const steps = cell.steps.map((s, idx) => `${idx + 1}. ${s}`).join('\n');
  return `### \`${cell.id}\`
- **Surface**: ${cell.surface}
- **Target**: ${cell.target}
- **Tier**: ${cell.tier}
- **Steps**:
${steps}
- **Pass condition**: ${cell.pass}`;
}

function formatSection(title: string, cells: MatrixCell[]): string {
  if (cells.length === 0) {
    return `## ${title}\n(none)`;
  }
  return `## ${title}\n\n` + cells.map(formatCell).join('\n\n');
}

export function generateBriefText(opts: {
  runId: string;
  mode: 'NORMAL' | 'RETEST_ONLY';
  openIssues: GitHubIssue[];
  retestCells: MatrixCell[];
  smokeCells: MatrixCell[];
  fillCells: MatrixCell[];
  dailyWalkCells: MatrixCell[];
  weeklyCells: MatrixCell[];
  coverageRule: string;
  product?: ProductConfig;
  /** Inactive by default; live instruction activation requires exact approval. */
  reportVersion?: 1;
}): string {
  const product = opts.product ?? PRODUCTS.inflecto;
  const openIssuesList = opts.openIssues.length > 0
    ? opts.openIssues
        .sort((a, b) => a.number - b.number)
        .map(i => `  - #${i.number}: ${i.title}`)
        .join('\n')
    : '  - (none open)';

  const sections = [
    `# Muse Test Brief - ${opts.runId}

- **Run ID**: ${opts.runId}
- **Mode**: ${opts.mode}
- **Open muse-test issues**: ${opts.openIssues.length}`,

    formatSection('RETEST', opts.retestCells),
    formatSection('SMOKE', opts.smokeCells),
    formatSection('FILL', opts.fillCells),
    formatSection('DAILY-WALK', opts.dailyWalkCells),
    formatSection('WEEKLY', opts.weeklyCells),
  ];

  if (opts.mode === 'NORMAL') {
    sections.push(`## EXPLORATORY\nEXPLORATORY: use judgment for up to 5 extra calls on whatever looks off in the areas above, stay inside the risk rules`);
  }

  sections.push(`## RULES
${product.rules.map(r => `- ${r}`).join('\n')}
- do not re-report issues already open:
${openIssuesList}`);

  sections.push(opts.reportVersion === 1
    ? formatMuseReportInstructionsV1({ ...product, runId: opts.runId, coverageRule: opts.coverageRule })
    : `## REPORT FORMAT
one email titled '${product.runSubjectPrefix} ${opts.runId}' to kevin@cyberwingman.ai from the personal Gmail, FINDINGS in TITLE/REPRO/EXPECTED/ACTUAL/EVIDENCE/SEVERITY blocks (zero findings is fine: send the email anyway), then a COVERAGE section per matrix coverage_rule.
Start every finding's TITLE line with "${product.titlePrefix}" (example: \`TITLE: ${product.titlePrefix}${product.titleExample}\`).

Coverage rule:
${opts.coverageRule}`);

  return sections.join('\n\n') + '\n';
}

export function computeScoreboard(cells: MatrixCell[], ledger: Record<string, CellLedgerEntry>, now: number, capabilities: Capabilities = RUNNER_CAPABILITIES): Scoreboard {
  const sevenDaysAgo = now - 7 * 24 * 3600 * 1000;
  let passed7d = 0;
  let fails = 0;
  let blocked = 0;
  let neverRun = 0;
  let notRunnable = 0;
  let stuckBlocked = 0;

  for (const cell of cells) {
    if (!isCellRunnableByMuse(cell, capabilities)) {
      notRunnable++;
    }
    const entry = ledger[cell.id];
    if (entry && (entry.consecutive_blocked ?? 0) >= 3) {
      stuckBlocked++;
    }
    if (!entry || entry.runs === 0 || !entry.last_run) {
      neverRun++;
    } else {
      if (entry.last_result === 'FAIL') fails++;
      else if (entry.last_result === 'BLOCKED') blocked++;
    }
    if (entry?.last_pass && Date.parse(entry.last_pass) >= sevenDaysAgo) {
      passed7d++;
    }
  }

  const total = cells.length;
  const coverage_pct = total > 0 ? Number(((passed7d / total) * 100).toFixed(1)) : 0;
  return {
    coverage_pct,
    passed_7d: passed7d,
    total,
    fails,
    blocked,
    never_run: neverRun,
    not_runnable: notRunnable,
    stuck_blocked: stuckBlocked,
  };
}

async function scanGmail(gmail: ReadonlyPlannerGmail, product: ProductConfig): Promise<MuseMail[]> {
  const ids = new Set<string>();
  let pageToken: string | undefined;
  do {
    const { data } = await gmail.users.messages.list({
      userId: 'me',
      q: product.gmailQuery,
      maxResults: 500,
      pageToken,
    });
    for (const message of data.messages ?? []) {
      if (message.id) ids.add(message.id);
    }
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);

  const mails: MuseMail[] = [];
  for (const id of ids) {
    const { data } = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    if (data.labelIds?.some(l => ['SPAM', 'TRASH'].includes(l))) continue;
    const header = (name: string) => data.payload?.headers?.find(h => h.name?.toLowerCase() === name)?.value ?? '';
    const subject = header('subject');
    if (!product.subjectPrefixes.some(prefix => subject.startsWith(prefix))) {
      continue;
    }
    const time = Number(data.internalDate) || Date.parse(header('date')) || 0;
    const plain: string[] = [];
    const visit = (part: gmail_v1.Schema$MessagePart) => {
      if (part.filename) return;
      if (part.mimeType === 'text/plain' && part.body?.data) {
        plain.push(Buffer.from(part.body.data, 'base64url').toString('utf8'));
      }
      for (const child of part.parts ?? []) visit(child);
    };
    if (data.payload) visit(data.payload);
    mails.push({ id, subject, time, body: plain.join('\n') });
  }
  return mails;
}

async function fetchMatrix(gh: Gh, repo: string, matrixPath: string): Promise<Matrix> {
  const stdout = await gh(['api', `repos/${repo}/contents/${matrixPath}`, '--jq', '.content']);
  let text = stdout.trim();
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf8');
    if (decoded.includes('"cells"')) {
      text = decoded;
    }
  } catch {
    // text is already raw json
  }
  return JSON.parse(text) as Matrix;
}

async function fetchMuseTestIssues(gh: Gh, repo: string): Promise<GitHubIssue[]> {
  const stdout = await gh(['issue', 'list', '--repo', repo, '--label', 'muse-test', '--state', 'all', '--json', 'number,state,closedAt,title']);
  return (stdout.trim() ? JSON.parse(stdout) : []) as GitHubIssue[];
}

const USAGE = 'Usage: muse-planner [--dry-run | --apply] [--product inflecto|sendinel]';

export function parsePlannerArgs(args: string[]): { apply: boolean; product: ProductId } {
  const flags: string[] = [];
  let product: string = 'inflecto';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--product') {
      product = args[++i] ?? '';
    } else if (arg.startsWith('--product=')) {
      product = arg.slice('--product='.length);
    } else {
      flags.push(arg);
    }
  }
  if (flags.some(arg => !['--apply', '--dry-run'].includes(arg)) || (flags.includes('--apply') && flags.includes('--dry-run'))
    || !Object.hasOwn(PRODUCTS, product)) {
    throw new Error(USAGE);
  }
  return { apply: flags.includes('--apply'), product: product as ProductId };
}

export function parseArgs(args: string[]): { apply: boolean } {
  return { apply: parsePlannerArgs(args).apply };
}

export async function runPlanner(deps: PlannerDeps): Promise<PlannerResult> {
  const now = deps.now ?? Date.now();
  const runId = new Date(now).toISOString();
  const product = getProduct(deps.product);
  const caps = product.capabilities;
  const repo = deps.repo ?? product.repo;
  const statePath = deps.statePath ?? productStatePath(product);
  const apply = deps.apply ?? false;

  let state: PlannerState;
  try {
    state = JSON.parse(await readFile(statePath, 'utf8')) as PlannerState;
    if (state.version !== 1 || !Array.isArray(state.processed_message_ids) || typeof state.cells !== 'object') {
      throw new Error('Invalid state structure');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Corrupt state or unparseable JSON
    }
    state = {
      version: 1,
      processed_message_ids: [],
      cells: {},
    };
  }

  // 1. Fetch matrix
  const matrix = await fetchMatrix(deps.gh, repo, product.matrixPath);
  const validCellIds = new Set(matrix.cells.map(c => c.id));

  // Initialize cells in ledger if missing
  for (const cell of matrix.cells) {
    if (!state.cells[cell.id]) {
      state.cells[cell.id] = {
        last_result: null,
        last_run: null,
        last_pass: null,
        last_fail: null,
        runs: 0,
        issue_refs: [],
      };
    }
  }

  // 2. Fetch Gmail messages
  const gmail = typeof deps.gmail === 'function' ? await deps.gmail() : deps.gmail;
  const mails = await scanGmail(gmail, product);
  const unprocessedMails = mails
    .filter(m => !state.processed_message_ids.includes(m.id))
    .sort((a, b) => a.time - b.time);

  for (const mail of unprocessedMails) {
    const records = parseCoverageSection(mail.body, validCellIds, mail.subject);
    const timeIso = new Date(mail.time).toISOString();
    for (const rec of records) {
      applyCoverageRecord(state.cells, rec, timeIso);
    }
    state.processed_message_ids.push(mail.id);
  }

  // 3. Fetch GitHub muse-test issues
  const allIssues = await fetchMuseTestIssues(deps.gh, repo);
  const openIssues = allIssues.filter(i => i.state?.toUpperCase() === 'OPEN');
  const closedIssues = allIssues.filter(i => i.state?.toUpperCase() === 'CLOSED');

  // Mode selection: open muse-test issues > 15 => RETEST_ONLY
  const mode = openIssues.length > 15 ? 'RETEST_ONLY' : 'NORMAL';

  // Budget calculations
  const maxMcpCalls = mode === 'RETEST_ONLY' ? product.maxMcpCallsRetestOnly : product.maxMcpCalls;
  const maxBrowserCells = product.maxBrowserCells;
  let usedMcpCalls = 0;
  let usedBrowserCells = 0;
  const chosenCellIds = new Set<string>();

  // HST timing
  const HST_OFFSET_MS = -10 * 3600 * 1000;
  const hstTime = new Date(now + HST_OFFSET_MS);
  const hstDateString = hstTime.toISOString().slice(0, 10);
  const hstHours = hstTime.getUTCHours();
  const isSundayHst = hstTime.getUTCDay() === 0;

  const canDailyWalk = mode !== 'RETEST_ONLY' && hstHours >= 10 && state.last_daily_walk !== hstDateString;

  // (a) RETEST
  const closedMap = new Map<number, number>();
  for (const issue of closedIssues) {
    if (issue.closedAt) {
      closedMap.set(issue.number, Date.parse(issue.closedAt));
    }
  }

  const retestCells: MatrixCell[] = [];
  for (const cell of matrix.cells) {
    const entry = state.cells[cell.id];
    if (!canSelectCell(cell, entry, now, caps)) continue;
    const lastRunMs = entry?.last_run ? Date.parse(entry.last_run) : null;
    const shouldRetest = cell.guards && cell.guards.some(guardNum => {
      const closedAt = closedMap.get(guardNum);
      if (!closedAt) return false;
      return lastRunMs === null || lastRunMs < closedAt;
    });

    if (shouldRetest) {
      if (usedMcpCalls + cell.est_mcp_calls <= maxMcpCalls) {
        if (cell.surface !== 'browser' || usedBrowserCells < maxBrowserCells) {
          retestCells.push(cell);
          chosenCellIds.add(cell.id);
          usedMcpCalls += cell.est_mcp_calls;
          if (cell.surface === 'browser') usedBrowserCells++;
        }
      }
    }
  }

  // (b) SMOKE (always present)
  const smokeCells: MatrixCell[] = [];
  for (const cell of matrix.cells) {
    const entry = state.cells[cell.id];
    if (!canSelectCell(cell, entry, now, caps)) continue;
    if (cell.smoke && !chosenCellIds.has(cell.id)) {
      smokeCells.push(cell);
      chosenCellIds.add(cell.id);
      usedMcpCalls += cell.est_mcp_calls;
      if (cell.surface === 'browser') usedBrowserCells++;
    }
  }

  const fillCells: MatrixCell[] = [];
  const dailyWalkCells: MatrixCell[] = [];
  const weeklyCells: MatrixCell[] = [];

  if (mode !== 'RETEST_ONLY') {
    // (d) daily FULL WALK: once per HST calendar day, at first run on/after 10:00 HST, include every browser cell
    if (canDailyWalk) {
      for (const cell of matrix.cells) {
        const entry = state.cells[cell.id];
        if (!canSelectCell(cell, entry, now, caps)) continue;
        if (cell.surface === 'browser' && !chosenCellIds.has(cell.id)) {
          dailyWalkCells.push(cell);
          chosenCellIds.add(cell.id);
          usedMcpCalls += cell.est_mcp_calls;
          usedBrowserCells++;
        }
      }
      state.last_daily_walk = hstDateString;
    }

    // (e) weekly cells on Sundays HST
    if (isSundayHst) {
      for (const cell of matrix.cells) {
        const entry = state.cells[cell.id];
        if (!canSelectCell(cell, entry, now, caps)) continue;
        if (cell.weekly && !chosenCellIds.has(cell.id)) {
          if (usedMcpCalls + cell.est_mcp_calls <= maxMcpCalls) {
            if (cell.surface !== 'browser' || usedBrowserCells < maxBrowserCells || canDailyWalk) {
              weeklyCells.push(cell);
              chosenCellIds.add(cell.id);
              usedMcpCalls += cell.est_mcp_calls;
              if (cell.surface === 'browser') usedBrowserCells++;
            }
          }
        }
      }
    }

    // (c) FILL: cells never run first, then cells whose last_result is FAIL or BLOCKED, then stalest by last_run
    const remaining = matrix.cells.filter(c => !chosenCellIds.has(c.id) && canSelectCell(c, state.cells[c.id], now, caps));
    remaining.sort((a, b) => {
      const aEntry = state.cells[a.id];
      const bEntry = state.cells[b.id];
      const aNever = !aEntry || !aEntry.last_run || aEntry.runs === 0;
      const bNever = !bEntry || !bEntry.last_run || bEntry.runs === 0;
      if (aNever !== bNever) return aNever ? -1 : 1;
      if (aNever && bNever) return 0;

      const aFailing = aEntry.last_result === 'FAIL' || aEntry.last_result === 'BLOCKED';
      const bFailing = bEntry.last_result === 'FAIL' || bEntry.last_result === 'BLOCKED';
      if (aFailing !== bFailing) return aFailing ? -1 : 1;

      const aTime = aEntry.last_run ? Date.parse(aEntry.last_run) : 0;
      const bTime = bEntry.last_run ? Date.parse(bEntry.last_run) : 0;
      return aTime - bTime;
    });

    for (const cell of remaining) {
      if (usedMcpCalls + cell.est_mcp_calls <= maxMcpCalls) {
        if (cell.surface !== 'browser' || usedBrowserCells < maxBrowserCells || canDailyWalk) {
          fillCells.push(cell);
          chosenCellIds.add(cell.id);
          usedMcpCalls += cell.est_mcp_calls;
          if (cell.surface === 'browser') usedBrowserCells++;
        }
      }
    }
  }

  // Generate brief text
  const brief = generateBriefText({
    runId,
    mode,
    openIssues,
    retestCells,
    smokeCells,
    fillCells,
    dailyWalkCells,
    weeklyCells,
    coverageRule: matrix.coverage_rule,
    product,
    reportVersion: 1,
  });

  // Scoreboard
  const scoreboard = computeScoreboard(matrix.cells, state.cells, now, caps);
  state.scoreboard = scoreboard;
  const notRunnableCount = scoreboard.not_runnable ?? 0;
  const stuckBlockedCount = scoreboard.stuck_blocked ?? 0;
  const notRunnablePart = notRunnableCount > 0 ? `, NOT RUNNABLE BY MUSE (covered elsewhere) ${notRunnableCount}` : '';
  const stuckBlockedPart = stuckBlockedCount > 0 ? `, stuck-blocked ${stuckBlockedCount}` : '';
  const scoreboard_line = `Scoreboard: coverage ${scoreboard.coverage_pct}% (${scoreboard.passed_7d}/${scoreboard.total}), fails: ${scoreboard.fails}, blocked: ${scoreboard.blocked}, never-run: ${scoreboard.never_run}${notRunnablePart}${stuckBlockedPart}`;
  console.log(scoreboard_line);
  deps.output?.({ type: 'scoreboard', ...scoreboard, scoreboard_line });

  // Handle target issue
  const targetStdout = await deps.gh(['issue', 'list', '--repo', repo, '--label', product.briefLabel, '--state', 'open', '--json', 'number,title,body']);
  const foundTargetIssues = (targetStdout.trim() ? JSON.parse(targetStdout) : []) as GitHubIssue[];
  // Sendinel keeps ONE brief issue: prefer the exact title, never any other open muse-brief issue first.
  const openTargetIssues = product.pinBrief
    ? foundTargetIssues.filter(i => i.title === product.briefTitle)
    : foundTargetIssues;

  let targetIssueResult: { number: number; action: 'created' | 'edited' | 'skipped' | 'would_create' | 'would_edit' };

  if (openTargetIssues.length > 0) {
    const target = openTargetIssues[0];
    const isIdempotent = normalizeBrief(target.body ?? '') === normalizeBrief(brief);
    if (isIdempotent) {
      targetIssueResult = { number: target.number, action: 'skipped' };
      deps.output?.({ action: 'skipped', issue: target.number, reason: 'brief unchanged except timestamp' });
    } else if (apply) {
      await deps.gh(['issue', 'edit', String(target.number), '--repo', repo, '--body', brief]);
      targetIssueResult = { number: target.number, action: 'edited' };
      deps.output?.({ action: 'edited', issue: target.number });
    } else {
      targetIssueResult = { number: target.number, action: 'would_edit' };
      deps.output?.({ would_edit: { issue: target.number, title: target.title } });
    }
  } else {
    // Target issue missing
    if (apply) {
      const labelStdout = await deps.gh(['label', 'list', '--repo', repo, '--limit', '1000', '--json', 'name']);
      const labels = (labelStdout.trim() ? JSON.parse(labelStdout) : []) as { name: string }[];
      if (!labels.some(l => l.name === product.briefLabel)) {
        try {
          await deps.gh(['label', 'create', product.briefLabel, '--repo', repo, '--color', '0e8a16', '--description', 'Active hourly testing brief for Muse']);
        } catch (err) {
          // Label exists but was not in the list (race or list truncation): treat as success.
          if (!/already exists/i.test(err instanceof Error ? err.message : String(err))) throw err;
        }
      }
      const createStdout = await deps.gh([
        'issue', 'create',
        '--repo', repo,
        '--title', product.briefTitle,
        '--label', product.briefLabel,
        '--body', brief,
      ]);
      const issueNum = Number(createStdout.match(/\/issues\/(\d+)/)?.[1]) || Number(createStdout.trim()) || 0;
      console.log(`Created target issue #${issueNum}`);
      if (product.pinBrief && issueNum) {
        try {
          await deps.gh(['issue', 'pin', String(issueNum), '--repo', repo]);
        } catch {
          console.warn(`Could not pin brief issue #${issueNum}; pin it manually`);
        }
      }
      targetIssueResult = { number: issueNum, action: 'created' };
      deps.output?.({ action: 'created', issue: issueNum });
    } else {
      targetIssueResult = { number: 0, action: 'would_create' };
      deps.output?.({ would_create: { title: product.briefTitle, label: product.briefLabel } });
    }
  }

  // Save state if --apply
  if (apply) {
    const dir = dirname(statePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmpFile = `${statePath}.new`;
    await writeFile(tmpFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    await rename(tmpFile, statePath);
  }

  return {
    run_id: runId,
    mode,
    scoreboard,
    scoreboard_line,
    retest_count: retestCells.length,
    smoke_count: smokeCells.length,
    fill_count: fillCells.length,
    daily_walk_count: dailyWalkCells.length,
    weekly_count: weeklyCells.length,
    target_issue: targetIssueResult,
    brief,
    state,
  };
}

async function main() {
  const { apply, product: productId } = parsePlannerArgs(process.argv.slice(2));
  const product = getProduct(productId);
  const file = productStatePath(product);
  const dir = dirname(file);
  // Inflecto keeps its historical lock behavior; other products take no lock
  // (and create no directories) in a dry run so a preview writes nothing.
  const useLock = apply || product.id === 'inflecto';
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let lockPath = '';
  if (useLock) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    lockPath = join(dir, 'run.lock');
    lock = await open(lockPath, 'wx', 0o600);
  }
  try {
    const { getGmailClient } = await import('../gmail/client.js');
    const exec = promisify(execFile);
    const gh: Gh = async args => (await exec('gh', args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
    await runPlanner({
      gh,
      gmail: () => getGmailClient(DEFAULT_ACCOUNT),
      apply,
      product: product.id,
      output: line => console.log(JSON.stringify(line)),
    });
  } finally {
    if (lock) {
      await lock.close();
      await unlink(lockPath);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(err => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Muse planner failed: ${msg.slice(0, 300)}`);
    process.exitCode = 1;
  });
}
