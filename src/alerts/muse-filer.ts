#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, mkdir, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { gmail_v1 } from 'googleapis';

const fields = ['TITLE', 'REPRO', 'EXPECTED', 'ACTUAL', 'EVIDENCE', 'SEVERITY'] as const;
export const RECOVERY_LOOKBACK_DAYS = 14;
const RECOVERY_LOOKBACK_MS = RECOVERY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
type Field = typeof fields[number];
export type Finding = Partial<Record<Field, string>>;
export const routes: Record<string, string> = {
  inflecto: 'kmdesle/inflecto-ai', sendinel: 'kmdesle/sendinel-ai', synchronex: 'kmdesle/synchronex',
  tractic: 'tractic-io/tractic-2.0', 'cyber-wingman': 'kmdesle/cyber-wingman', cw: 'kmdesle/cyber-wingman',
  hashfolio: 'kmdesle/hashfolio', wfi: 'kmdesle/wfi-hyperion', hyperion: 'kmdesle/wfi-hyperion',
  wren: 'kmdesle/wren-app', 'act-now': 'kmdesle/act-now',
};

const countWords = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const countPattern = `(?:${countWords.join('|')}|[1-9]\\d?)`;
function countValue(word: string): number {
  const index = countWords.indexOf(word.toLowerCase());
  return index >= 0 ? index + 1 : Number(word);
}

// Matches only the declaration itself, optionally with the inline note that a
// counted list of FAIL cells cites issues that are already filed.
function isZeroNewDeclaration(text: string): boolean {
  const cite = ` The (${countPattern}) FAIL cells? below cites? issues? already filed: (#[1-9]\\d*(?:, #[1-9]\\d*)*)\\.`;
  const forms = [
    new RegExp(`^None\\. No new findings this run\\.?$`, 'i'),
    new RegExp(`^\\(none\\) \u2014 (?:zero(?: new)?|no new) findings this run(?:\\.?|\\.${cite})$`, 'i'),
    new RegExp(`^\\(none \u2014 (?:zero(?: new)?|no new) findings this run(?:\\.?|\\.${cite})\\)\\.?$`, 'i'),
  ];
  for (const form of forms) {
    const match = text.match(form);
    if (!match) continue;
    if (match[1] === undefined) return true;
    return countValue(match[1]) === match[2].split(', ').length;
  }
  return false;
}

// After a blank line, a declaration may be followed only by groups that explain
// FAIL/BLOCKED coverage cells against existing issues, or one explicitly
// unverified cell with capped counts and an explicit no-mismatch statement.
// Each group requires its own bounded intro and matching bullets.
function isCoverageExplanation(lines: string[]): boolean {
  const intro = new RegExp(`^${countPattern} cells? (?:fails?|(?:is|are) blocked|(?:fail|are failing) or (?:are )?blocked) (?:against|by|on) (?:already[- ]open|already[- ]filed|existing) issues? \\(see COVERAGE, not re-reported as new findings\\):$`, 'i');
  const bullet = /^[-*] (?=.*\b(?:fails?|failing|FAIL|blocked)\b)(?=.*#[1-9]\d*\b)(?!.*\b(?:new|unfiled|untracked|another|also|maybe|possibly|not (?:yet )?filed)\b).+$/i;
  const unverifiedIntro = /^One cell BLOCKED:$/i;
  const unverifiedBullet = (line: string): boolean =>
    /^[-*] /.test(line)
    && /\b(?:unable|could not|cannot|couldn't|not able)\b[^.!?]*\b(?:verify|verified|verification)\b/i.test(line)
    && /\b(?:cap|caps|capped)\b/i.test(line)
    && /\bcounts?\b/i.test(line)
    && /(?:^|[.!?] )No mismatch was found\.(?: |$)/.test(line)
    && !/\b(?:new|unfiled|untracked|another|also|maybe|possibly|not (?:yet )?filed|defects?|bugs?|fails?|failing|wrong|incorrect|mismatch\w*)\b|#[1-9]\d*\b/i.test(line.replace('No mismatch was found.', ''));
  let index = 0;
  while (index < lines.length) {
    if (unverifiedIntro.test(lines[index])) {
      if (!unverifiedBullet(lines[index + 1] ?? '')) return false;
      index += 2;
      continue;
    }
    if (!intro.test(lines[index])) return false;
    let next = index + 1;
    while (next < lines.length && bullet.test(lines[next])) next++;
    if (next === index + 1) return false;
    index = next;
  }
  return lines.length > 0;
}

function hasZeroNewFindings(lines: string[]): boolean {
  const header = /^\s*(?:#{1,6}\s*)?(?:\*\*)?FINDINGS\s*:?\s*(?:\*\*)?\s*$/i;
  const starts = lines.flatMap((line, index) => header.test(line) ? [index] : []);
  if (starts.length !== 1) return false;
  const start = starts[0];
  // A quoted/example section cannot establish a report's zero-new verdict.
  if (lines.slice(0, start).some(line => /^\s*(?:>|`{3,}|~{3,}|(?:for example|examples?|quotes?|quoted (?:report|text))\s*:)/i.test(line))) return false;
  const boundary = /^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:COVERAGE|(?:Observations|Notes)\s+\(not findings\)|Observations|regression(?:s| verdicts?| results?)?)\s*:?\s*(?:\*\*)?\s*$/i;
  const remaining = lines.slice(start + 1);
  const end = remaining.findIndex(line => boundary.test(line));
  const section = (end < 0 ? remaining : remaining.slice(0, end)).map(line => line.trim());
  // Later paragraphs may only explain existing issues or explicitly unverified coverage.
  const first = section.findIndex(line => line !== '');
  if (first < 0) return false;
  const gap = section.indexOf('', first);
  const head = (gap < 0 ? section.slice(first) : section.slice(first, gap)).join(' ').replace(/\s+/g, ' ');
  if (!isZeroNewDeclaration(head)) return false;
  const rest = gap < 0 ? [] : section.slice(gap).filter(line => line !== '');
  return !rest.length || isCoverageExplanation(rest);
}

// A line grammar only. Email text never becomes code, commands, or instructions.
export function parseEmail(body: string): { findings: Finding[]; regressions: string[]; nothingFound: boolean } {
  const findings: Finding[] = [];
  const regressions: string[] = [];
  let current: Finding | undefined;
  let field: Field | undefined;
  let regressionSection = false;
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    if (/^\s*(?:#{1,6}\s*)?(?:\*\*)?regression(?:s| verdicts?| results?)?\s*:?\s*(?:\*\*)?\s*$/i.test(line)) {
      regressionSection = true;
      field = undefined;
      continue;
    }
    const match = line.match(/^\s*(TITLE|REPRO|EXPECTED|ACTUAL|EVIDENCE|SEVERITY):\s*(.*)$/);
    if (match) {
      const name = match[1] as Field;
      if (name === 'TITLE' || regressionSection || (current && current[name] !== undefined)) current = undefined;
      regressionSection = false;
      if (!current) { current = {}; findings.push(current); }
      current[name] = match[2];
      field = name;
    } else if (regressionSection && /#\d+\b/.test(line)) {
      regressions.push(line.trim());
      field = undefined;
    } else if (current && field) {
      current[field] += '\n' + line;
    }
  }
  for (const finding of findings) for (const key of fields) if (finding[key] !== undefined) finding[key] = finding[key]!.trim();
  return { findings, regressions, nothingFound: !findings.length && (/\bnothing found\b/i.test(body) || hasZeroNewFindings(lines)) };
}

export function routeTitle(title: string, subject?: string): { repo: string; title: string } | undefined {
  const match = title.match(/^\s*(Inflecto|Sendinel|Synchronex|Tractic|Cyber-Wingman|CW|Hashfolio|WFI|Hyperion|Wren|ACT-Now)(?:\s*(?::|[-–—])\s*|\s+)(\S[^\n]*)$/i);
  if (match) return { repo: routes[match[1].toLowerCase()], title: `[muse] ${match[2].trim()}` };
  if (!subject) return undefined;
  const subjectMatch = subject.match(/^\[Muse\] Spec\s+(Inflecto|Sendinel|Synchronex|Tractic|Cyber-Wingman|CW|Hashfolio|WFI|Hyperion|Wren|ACT-Now)\b/i);
  if (!subjectMatch) return undefined;
  const repo = routes[subjectMatch[1].toLowerCase()];
  if (!repo) return undefined;
  const clean = title.trim().replace(/^\[muse\]\s*/i, '');
  return { repo, title: `[muse] ${clean}` };
}

export function normalizeTitle(title: string): string[] {
  return [...new Set(title.toLowerCase().replace(/^\s*\[muse\]\s*/, '').replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean))];
}
export function jaccard(a: string, b: string): number {
  const left = new Set(normalizeTitle(a));
  const right = new Set(normalizeTitle(b));
  const union = new Set([...left, ...right]);
  return union.size ? [...left].filter(token => right.has(token)).length / union.size : 0;
}
export interface Issue {
  number: number; title: string; body?: string; url?: string;
  state?: string; closed_at?: string; labels?: { name: string }[];
}
function normalizeText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[“”„‟]/g, '"')
    .replace(/[‘’]/g, "'").replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim();
}
export function distinctiveTokens(value: string): string[] {
  const text = normalizeText(value).replace(/\b\d{4}-\d{2}(?:-\d{2})?\b/g, ' ').replace(/\b\d{4}\b/g, ' ').replace(/\b\d{2}:\d{2}\b/g, ' ');
  const phrases = [...text.matchAll(/"([^"\n]+)"/g)].map(match => match[1].trim()).filter(phrase => phrase.length >= 12);
  const numbers = [...text.matchAll(/(?<![\p{L}\p{N}_])(?:[$€£]\s*)?\d+(?:,\d{3})*(?:\.\d+)?(?:\s*(?:%|percent\b|ms\b|kg\b|gb\b|mb\b|km\b|usd\b))?(?![\p{L}\p{N}_])/gu)]
    .map(match => match[0].replace(/,/g, '').replace(/\s+/g, ''));
  const tools = [...text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)].map(match => match[0]);
  return [...new Set([...phrases, ...numbers, ...tools])].sort();
}
export function distinctiveMatch(title: string, finding: Finding, issues: Issue[]): { issue: Issue; shared_tokens: string[] } | undefined {
  const source = normalizeText(`${finding.TITLE ?? title}\n${finding.ACTUAL ?? ''}`);
  const findingTitleTools = new Set([...normalizeText(finding.TITLE ?? title).matchAll(/\b(?:get|list|search|create|update|delete|submit|snooze|dismiss|mark)_[a-z0-9_]+\b/g)].map(match => match[0]));
  const phrases = new Set([...source.matchAll(/"([^"\n]+)"/g)].map(match => match[1].trim()).filter(Boolean));
  const tokens = distinctiveTokens(source);
  for (const issue of issues) {
    const text = normalizeText(`${issue.title}\n${issue.body ?? ''}`);
    const existingTokens = new Set(distinctiveTokens(text));
    const titleNorm = normalizeText(issue.title);
    const titleTools = new Set([...titleNorm.matchAll(/\b(?:get|list|search|create|update|delete|submit|snooze|dismiss|mark)_[a-z0-9_]+\b/g)]
      .map(match => match[0]).filter(tool => findingTitleTools.has(tool)));
    const shared = tokens.filter(token => existingTokens.has(token)
      || phrases.has(token) && new RegExp(`(?<![\\p{L}\\p{N}_])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'u').test(text));
    const hasAnchor = shared.some(token => phrases.has(token) && token.length >= 12
      && token.includes(' ')
      && !/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(token)
      || titleTools.has(token));
    if (shared.length >= 2 && hasAnchor) return { issue, shared_tokens: shared };
  }
  return undefined;
}
interface DuplicateMatch { issue: Issue; rule: 'title_jaccard' | 'email_footer'; shared_tokens: string[] }
function duplicateMatch(title: string, messageId: string, issues: Issue[]): DuplicateMatch | undefined {
  const normTitle = normalizeTitle(title);
  for (const issue of issues) {
    const normIssue = normalizeTitle(issue.title);
    if (normTitle.sort().join(' ') === normIssue.sort().join(' ')
      && issue.body?.split('\n').includes(`Filed from Muse email ${messageId}`)) {
      return { issue, rule: 'email_footer', shared_tokens: normTitle };
    }
    const shared = normTitle.filter(token => normIssue.includes(token));
    if (jaccard(title, issue.title) >= 0.7 || (shared.length >= 7 && shared.length / Math.min(normTitle.length, normIssue.length) >= 0.7)) {
      return { issue, rule: 'title_jaccard', shared_tokens: shared };
    }
  }
  return undefined;
}
export function parseAlreadyOpenIssues(finding: Finding): number[] {
  const text = [finding.EVIDENCE, finding.ACTUAL, finding.REPRO].filter(Boolean).join('\n');
  const matches = [...text.matchAll(/\balready\s+(?:open|opened|filed)\s+as\s+(#\d+(?:(?:\s*,\s*(?:(?:and\b|&)\s*)?|\s+(?:(?:and\b|&)\s*)?)#\d+)*)\b/gi)];
  const cited = matches.flatMap(m => [...m[1].matchAll(/#(\d+)\b/g)].map(match => Number(match[1])));
  return [...new Set(cited)];
}

export function findDuplicate(title: string, messageId: string, issues: Issue[]): Issue | undefined {
  return duplicateMatch(title, messageId, issues)?.issue;
}
export function issueBody(finding: Finding, messageId: string, related?: { issue: Issue; shared_tokens: string[] }): string {
  let body = fields.filter(key => key !== 'TITLE').map(key => `## ${key}\n\n${finding[key] || '(not provided)'}`).join('\n\n')
    + `\n\nFiled from Muse email ${messageId}`;
  if (related) {
    body += `\n\n## POSSIBLY RELATED\n\n#${related.issue.number} (shares: ${related.shared_tokens.join(', ')})`;
  }
  return body;
}

export type Gh = (args: string[]) => Promise<string>;
export interface Mail { id: string; subject: string; body: string; rejected?: string }
export interface GmailClient {
  messages(): AsyncIterable<Mail>;
  markFiled(id: string): Promise<void>;
}
export interface Result {
  message_id: string; title: string;
  action: 'filed' | 'duplicate' | 'possible_duplicate' | 'malformed' | 'unrouted';
  issue?: string | number; reason?: string;
  rule?: DuplicateMatch['rule'] | 'distinctive_tokens_related' | 'cited_issue'; shared_tokens?: string[];
}
export interface Run {
  ts: string; dry_run: boolean; results: Result[];
  regressions: { message_id: string; verdict: string }[];
  skipped: { message_id: string; reason: string }[];
  planned: { message_id: string; title: string; repo: string; body: string; labels: string[] }[];
  error?: string;
  failing_step?: string;
  error_code?: string;
}
interface RepoState { issues: Issue[]; recovery: Issue[]; references: Issue[]; labels: string[] }

export async function runFiler(deps: {
  gmail: GmailClient; gh: Gh; apply?: boolean; explain?: boolean;
  output?: (value: unknown) => void;
  record: (run: Run) => Promise<void>;
}): Promise<Run> {
  const run: Run = { ts: new Date().toISOString(), dry_run: !deps.apply, results: [], regressions: [], skipped: [], planned: [] };
  const output = deps.output ?? console.log;
  const repos = new Map<string, RepoState>();
  let filed = 0;
  const gh = deps.gh;
  let currentStep = 'Gmail message scan';
  async function callGh(step: string, args: string[]): Promise<string> {
    currentStep = step;
    return gh(args);
  }
  async function repoState(repo: string): Promise<RepoState> {
    let state = repos.get(repo);
    if (!state) {
      const verified = JSON.parse(await callGh('gh repo view', ['repo', 'view', repo, '--json', 'nameWithOwner']));
      if (verified.nameWithOwner.toLowerCase() !== repo.toLowerCase()) throw new Error(`Repository route changed: ${repo}`);
      const labels: { name: string }[] = JSON.parse(await callGh('gh label list', ['label', 'list', '--repo', repo, '--limit', '1000', '--json', 'name']));
      // REST pagination avoids search-index lag for footer recovery, including
      // closed/unlabeled issues after an ambiguous create or Gmail-label failure.
      const since = new Date(Date.now() - RECOVERY_LOOKBACK_MS).toISOString();
      const projection = '.[] | {number,title,body,url: .html_url,state,closed_at,labels: [.labels[] | {name}],pull_request:(.pull_request!=null)}';
      const decode = (ndjson: string) => ndjson.split(/\r?\n/).filter(line => line.trim())
        .map(line => JSON.parse(line) as Issue & { pull_request?: boolean }).filter(issue => !issue.pull_request);
      const recovery = decode(await callGh('gh api issues recovery', ['api', '--method', 'GET', `repos/${repo}/issues?state=all&since=${since}&per_page=100`, '--paginate', '--jq', projection]));
      const openIssues = decode(await callGh('gh api open issues', ['api', '--method', 'GET', `repos/${repo}/issues?state=open&per_page=100`, '--paginate', '--jq', projection]));
      const candidates = [...openIssues, ...recovery];
      const issues = [...new Map(candidates.filter(issue => issue.labels?.some(label => label.name === 'muse-test')
        || (issue.state === 'open' || openIssues.some(open => open.number === issue.number)) && /^\s*(?:Muse:|\[muse\])/i.test(issue.title))
        .map(issue => [issue.number, issue])).values()];
      // All open issues and recently closed issues can resolve Rule A references.
      const references = [...new Map([...openIssues, ...recovery.filter(issue => issue.state === 'open' || issue.closed_at && issue.closed_at >= since)].map(issue => [issue.number, issue])).values()];
      state = { labels: labels.map(label => label.name), issues, recovery, references };
      repos.set(repo, state);
    }
    return state;
  }
  function report(result: Result) { run.results.push(result); output(result); }
  try {
    for await (const mail of deps.gmail.messages()) {
      if (mail.rejected) {
        run.skipped.push({ message_id: mail.id, reason: mail.rejected });
        output({ message_id: mail.id, reason: mail.rejected });
        continue;
      }
      if (!mail.subject.startsWith('[Muse] Spec')) continue;
      const parsed = parseEmail(mail.body);
      for (const verdict of parsed.regressions) {
        const item = { message_id: mail.id, verdict };
        run.regressions.push(item); output({ regression: item });
      }
      let complete = true;
      if (!parsed.findings.length) {
        const reason = parsed.nothingFound ? 'nothing found' : parsed.regressions.length ? 'regressions only' : 'No finding blocks or nothing-found declaration';
        run.skipped.push({ message_id: mail.id, reason }); output({ message_id: mail.id, reason });
        if (!parsed.nothingFound && !parsed.regressions.length) report({ message_id: mail.id, title: '', action: 'malformed', reason });
      }
      for (const finding of parsed.findings) {
        const base = { message_id: mail.id, title: finding.TITLE ?? '' };
        const missing = ['TITLE', 'REPRO', 'ACTUAL'].filter(key => !finding[key as Field]);
        if (missing.length || finding.TITLE?.includes('\n')) {
          report({ ...base, action: 'malformed', reason: missing.length ? `Missing ${missing.join(', ')}` : 'TITLE must be one line' }); continue;
        }
        const route = routeTitle(finding.TITLE!, mail.subject);
        if (!route) { report({ ...base, action: 'unrouted' }); complete = false; continue; }
        currentStep = 'repository state';
        const state = await repoState(route.repo);
        const alreadyOpen = parseAlreadyOpenIssues(finding);
        const validAlreadyOpen = alreadyOpen.filter(num => state.issues.some(issue => issue.number === num));
        if (validAlreadyOpen.length) {
          report({
            ...base,
            action: 'duplicate',
            issue: validAlreadyOpen[0],
            ...(validAlreadyOpen.length > 1 ? { reason: validAlreadyOpen.map(n => `#${n}`).join(', ') } : {}),
          });
          continue;
        }
        const exactRecovery = state.recovery.filter(issue => issue.body?.split('\n').includes(`Filed from Muse email ${mail.id}`));
        const duplicate = duplicateMatch(route.title, mail.id, state.issues)
          ?? duplicateMatch(route.title, mail.id, exactRecovery.filter(issue => normalizeTitle(route.title).sort().join(' ') === normalizeTitle(issue.title).sort().join(' ')));
        if (duplicate) { report({ ...base, action: 'duplicate', ...(duplicate.issue.number ? { issue: duplicate.issue.number } : { reason: 'Duplicates a finding already planned in this dry run' }),
          ...(deps.explain ? { rule: duplicate.rule, shared_tokens: duplicate.shared_tokens } : {}) }); continue; }
        // In-run plans use number 0 and are invisible to Rule B; Jaccard still sees them.
        const related = distinctiveMatch(route.title, finding, state.issues.filter(issue => issue.number > 0));
        const cited = new Set(Object.values(finding).flatMap(value => [...value.matchAll(/#(\d+)\b/g)].map(match => Number(match[1]))));
        const possible = state.references.find(issue => cited.has(issue.number));
        // A citation stays non-filing only when Rule B did not already relate the finding.
        if (!related && possible) {
          complete = false;
          report({ ...base, action: 'possible_duplicate', issue: possible.number,
            ...(deps.explain ? { rule: 'cited_issue' as const, shared_tokens: [`#${possible.number}`] } : {}) });
          continue;
        }
        if (filed >= 10) { complete = false; run.skipped.push({ message_id: mail.id, reason: '10-issue cap reached' }); output({ ...base, deferred: '10-issue cap reached' }); continue; }
        const labels = ['muse-test', 'needs-spec'];
        // Only use an unambiguous, already-existing highest-priority label.
        const priorities = state.labels.filter(label => /^(?:p[01]|priority:\s*(?:critical|high|highest|p[01])|priority[- ](?:critical|high))$/i.test(label));
        if (finding.SEVERITY?.toLowerCase() === 'wrong number' && priorities.length === 1) labels.push(priorities[0]);
        const body = issueBody(finding, mail.id, related);
        output({ would_file: { repo: route.repo, title: route.title, body, labels }, missing_labels: labels.filter(label => !state.labels.includes(label)) });
        const explainRelated = deps.explain && related ? { rule: 'distinctive_tokens_related' as const, shared_tokens: related.shared_tokens } : {};
        if (!deps.apply) {
          run.planned.push({ message_id: mail.id, title: route.title, repo: route.repo, body, labels });
          filed++;
          state.issues.push({ number: 0, title: route.title, body });
          if (deps.explain && related) report({ ...base, action: 'filed', issue: related.issue.number, ...explainRelated });
          continue;
        }
        if (!state.labels.includes('needs-spec')) throw new Error(`Missing existing needs-spec label in ${route.repo}`);
        if (!state.labels.includes('muse-test')) {
          await callGh('gh label create', ['label', 'create', 'muse-test', '--repo', route.repo, '--color', '7057ff', '--description', 'Findings from Muse structured test emails']);
          state.labels.push('muse-test');
        }
        const url = (await callGh('gh issue create', ['issue', 'create', '--repo', route.repo, '--title', route.title, '--body', body, ...labels.flatMap(label => ['--label', label])])).trim();
        filed++;
        const number = Number(url.match(/\/issues\/(\d+)$/)?.[1]);
        state.issues.push({ number, title: route.title, body, url });
        report({ ...base, action: 'filed', issue: deps.explain && related ? related.issue.number : url, ...explainRelated });
      }
      if (complete && deps.apply) await deps.gmail.markFiled(mail.id);
    }
    return run;
  } catch (error) {
    // Provider errors can contain credentials. Keep diagnostics local and bounded.
    run.error = 'Run failed; uncompleted emails remain pending. Check account access, repository access, and needs-spec labels.';
    run.failing_step = currentStep;
    const candidate = error as { code?: unknown; status?: unknown; name?: unknown };
    if (typeof candidate?.code === 'string' && /^[A-Z0-9_]+$/.test(candidate.code)) run.error_code = candidate.code;
    else if (typeof candidate?.code === 'number' && Number.isInteger(candidate.code)) run.error_code = `GH_EXIT_${candidate.code}`;
    else if (typeof candidate?.status === 'number' && Number.isInteger(candidate.status)) run.error_code = `GH_EXIT_${candidate.status}`;
    else if (typeof candidate?.name === 'string' && /^[A-Za-z][A-Za-z0-9]*Error$/.test(candidate.name)) run.error_code = candidate.name;
    output({ error: run.error });
    throw new Error(run.error);
  } finally {
    await deps.record(run);
  }
}

export function gmailAdapter(gmail: Pick<gmail_v1.Gmail, 'users'>): GmailClient {
  let filedLabel: string | undefined;
  return {
    async *messages() {
      const { data } = await gmail.users.labels.list({ userId: 'me' });
      filedLabel = data.labels?.find(label => label.name === 'muse-filed')?.id ?? undefined;
      // Snapshot ids before modifying labels so pagination cannot skip messages.
      const ids = new Set<string>();
      let pageToken: string | undefined;
      do {
        const { data: page } = await gmail.users.messages.list({ userId: 'me', q: 'subject:"[Muse] Spec" -label:muse-filed', maxResults: 100, pageToken });
        for (const message of page.messages ?? []) if (message.id) ids.add(message.id);
        pageToken = page.nextPageToken ?? undefined;
      } while (pageToken);
      for (const id of ids) {
        const { data: message } = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
        if (filedLabel && message.labelIds?.includes(filedLabel)) continue;
        const subject = message.payload?.headers?.find(header => header.name?.toLowerCase() === 'subject')?.value ?? '';
        if (!subject.startsWith('[Muse] Spec')) continue;
        const headers = message.payload?.headers ?? [];
        const from = headers.find(header => header.name?.toLowerCase() === 'from')?.value ?? '';
        const address = from.match(/<\s*([^<>\s]+)\s*>/)?.[1] ?? from.trim();
        const authResults = headers.filter(header => header.name?.toLowerCase() === 'authentication-results')
          .map(header => header.value ?? '').filter(value => /^\s*mx\.google\.com\s*;/i.test(value));
        const authFailed = authResults.some(value => /\b(?:dkim|spf|dmarc)=fail\b/i.test(value));
        if (address.toLowerCase() !== 'kevin.m.desler@gmail.com' || message.labelIds?.includes('SPAM') || authFailed) {
          yield { id, subject, body: '', rejected: 'sender not allowed' };
          continue;
        }
        const plain: string[] = [];
        const visit = (part: gmail_v1.Schema$MessagePart) => {
          if (part.filename) return;
          if (part.mimeType === 'text/plain' && part.body?.data) plain.push(Buffer.from(part.body.data, 'base64url').toString('utf8'));
          for (const child of part.parts ?? []) visit(child);
        };
        if (message.payload) visit(message.payload);
        if (!plain.length) throw new Error('Muse email requires an inline text/plain body');
        yield { id, subject, body: plain.join('\n') };
      }
    },
    async markFiled(id) {
      if (!filedLabel) {
        const { data } = await gmail.users.labels.create({ userId: 'me', requestBody: { name: 'muse-filed' } });
        if (!data.id) throw new Error('Gmail did not return a label id');
        filedLabel = data.id;
      }
      await gmail.users.messages.modify({ userId: 'me', id, requestBody: { addLabelIds: [filedLabel] } });
    },
  };
}

export function parseArgs(args: string[]): boolean {
  if (args.some(arg => !['--apply', '--dry-run', '--explain'].includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) {
    throw new Error('Usage: muse-filer [--dry-run | --apply] [--explain]');
  }
  return args.includes('--apply');
}

async function main() {
  const apply = parseArgs(process.argv.slice(2));
  const directory = join(homedir(), '.local/state/muse-filer');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Serialize local runs, including recovery checks and creation. A stale lock
  // after SIGKILL must be removed by the operator after checking no run is active.
  const lockPath = join(directory, 'run.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    const { getGmailClient } = await import('../gmail/client.js');
    const exec = promisify(execFile);
    await runFiler({
      gmail: gmailAdapter(await getGmailClient('kevin.m.desler@gmail.com')), apply, explain: process.argv.includes('--explain'),
      gh: async args => (await exec('gh', args, { maxBuffer: 64 * 1024 * 1024 })).stdout,
      output: value => console.log(JSON.stringify(value)),
      record: async run => { await appendFile(join(directory, 'runs.jsonl'), JSON.stringify(run) + '\n', { mode: 0o600 }); },
    });
  } finally { await lock.close(); await unlink(lockPath); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Muse filer failed. Check arguments, credentials, state lock, access, and run log.'); process.exitCode = 1; });
}
