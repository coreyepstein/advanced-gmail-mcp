# Gmail MCP Server

![Advanced Gmail MCP](social-preview.png)

A Gmail [MCP server](https://modelcontextprotocol.io) for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that provides full email management across multiple Gmail accounts.

## Mail digest CLI

`npm run mail-digest` previews one plain text digest across configured accounts.
It uses the existing `accounts.json`, `credentials.json`, and stored account
tokens through `getAccounts()` and `getGmailClient()`; it never starts interactive
authentication. Existing tokens need read access and `gmail.settings.basic` to
read send-as identities, plus `gmail.send` when sending.

Set configuration in your local shell environment (never commit real addresses):

```bash
export DIGEST_TO='digest@example.invalid'
export DIGEST_FROM='source@example.invalid'
export DIGEST_SKIP_ACCOUNTS='excluded@example.invalid'
npm run mail-digest -- --dry-run
```

All three environment keys are required; `DIGEST_SKIP_ACCOUNTS=''` explicitly
means no additional exclusions. The skip list accepts comma-separated configured
emails or account aliases, and always includes `DIGEST_TO`. Use it to exclude
personal accounts. `DIGEST_FROM` must exactly match a configured account email;
both sender and recipient must be single bare addresses. No default addresses
or account aliases are embedded in the CLI.

The default is `--dry-run`: print the rendered email, send nothing, and leave
digest state untouched. An explicit `--send` sends one email only to `DIGEST_TO`.
No labels, drafts, archive, or read status are changed. An empty digest sends
nothing and produces no preview email.

The first scan covers the last 24 hours. Later scans start at the last successful
send-mode scan, recorded in `~/.local/state/mail-digest/state.json`. Empty
send-mode scans also advance that timestamp. Read or send failures preserve it.
A local `run.lock` prevents concurrent sends; after a crashed process, confirm
it has stopped before removing a stale lock. Sending is attempted once without
retries. A crash or state-write failure after Gmail accepts an email can cause
the next run to repeat that window; check the sending account before retrying.
The existing auth loader may refresh and save its stored OAuth tokens during
either mode.

Threads are included only when the latest non-draft message is within the scan
window and appears to be from a person. Owner addresses include every configured
account and every send-as identity, including skipped accounts. A latest owner
reply excludes the thread. Filters exclude automated sender patterns, GitHub,
Slack, Vercel, Supabase, Stripe notifications/receipts, List-Unsubscribe/List-Id,
bulk/auto-submitted mail, `[Muse]` subjects, and matches from the watcher's
`~/.config/gmail-alerts/rules.json` using the same account/sender/subject matching.
Missing rules mean no watcher exclusions; malformed rules abort the scan.
Person detection uses sender/header heuristics and cannot prove an email is
human; personal-mail classification is outside this CLI's scope.

The email contains counts per account, grouped sender/subject/time/snippet/link
entries, and Pacific/Honolulu times with am/pm. Subject periods use Honolulu time:
AM before 11 am, Midday from 11 am to before 2 pm, and PM thereafter. Cron setup,
replying, and personal-mail handling are outside this feature's scope.

Optional local exclusions go in `~/.config/mail-digest/ignore.txt`, one per line:
a full sender address, `@domain`, or `subject:<prefix>`. Blank lines and lines
starting with `#` are ignored. A missing file adds no exclusions; matched sender
addresses/domains and subject prefixes are case-insensitive. Subjects and snippets
have common HTML entities decoded before they appear in the digest.

Optional `DIGEST_SELECTION_OUT` is a file path. On each `--send` run, including
an empty scan, the CLI writes the threads it selected as JSON and leaves the
digest email unchanged. The file is replaced atomically (a temporary file in
the same directory, mode 0640, then rename). Each thread record has the account
alias, thread id, message id, subject, display name, and received time. It has
no body, snippet, or email address. An unset or blank value writes nothing. A
write failure logs a warning and does not fail the send. `--dry-run` never
writes this file.

## Features

- **Gmail and Google Calendar** on one server and one token store per Google account
- **Multi-account** support with simple aliases
- **OAuth2** authentication with interactive CLI flow
- **Token auto-refresh** — re-authenticates transparently
- **Rate limit retry** with exponential backoff
- **Claude Code commands** included (`/email` and `/checkemail`) for structured inbox triage

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/coreyepstein/advanced-gmail-mcp.git
cd advanced-gmail-mcp
npm install
```

### 2. Google Cloud Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Enable the **Gmail API** and the **Google Calendar API**:
   - APIs & Services → Enable APIs → search "Gmail API" → Enable
   - Search "Google Calendar API" → Enable
4. Configure the **OAuth consent screen**:
   - APIs & Services → OAuth consent screen
   - User type: External (or Internal if using Google Workspace)
   - Add your email address(es) as test users
   - Add scopes: `gmail.readonly`, `gmail.modify`, `gmail.send`, `gmail.compose`, `gmail.settings.basic`, and `https://www.googleapis.com/auth/calendar.events` (`calendar.events` — read and create/update events; this server does not request a delete scope)
5. Create **OAuth credentials**:
   - APIs & Services → Credentials → Create Credentials → OAuth client ID
   - Application type: **Desktop app**
   - Download the JSON file
6. Save the downloaded file as `credentials.json` in the project root

### 3. Configure Accounts

```bash
cp accounts.example.json accounts.json
```

Edit `accounts.json` with your Gmail accounts:

```json
{
  "accounts": [
    { "email": "you@gmail.com", "alias": "personal" },
    { "email": "you@company.com", "alias": "work" }
  ],
  "default": "personal"
}
```

You can add as many accounts as you want. Each needs a unique `alias`.

### 4. Authenticate

```bash
# Authenticate all accounts (opens browser for each)
npm run auth

# Or authenticate a single account
npm run auth -- work

# Check auth status
npm run auth:check
```

The auth flow opens a browser window for each account. Tokens are saved to `./tokens/`.

#### Calendar scope (one-time re-consent per account)

`calendar.events` was added after the original Gmail scopes. Tokens saved before that do not include it. Gmail tools keep working for those accounts. Calendar tools do not: they return an error that names the account and tells you to re-run auth. They do not crash the server.

```bash
npm run auth -- work
npm run auth:check
```

`npm run auth:check` prints `[calendar: granted]` or `[calendar: not granted]` on each account line. Re-run `npm run auth` (or `npm run auth -- <alias>`) once per account that should use Calendar. The Cloud project must already have the Calendar API enabled and `calendar.events` on the OAuth consent screen, or consent cannot grant the scope.

### 5. Add to Claude Code

Add to your MCP config (project `.mcp.json` or `~/.claude.json`):

```json
{
  "mcpServers": {
    "gmail": {
      "type": "stdio",
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/gmail-mcp/src/server.ts"]
    }
  }
}
```

> **Important:** Use the absolute path to `src/server.ts`.

### 6. (Optional) Add Commands

Copy the included Claude Code commands for structured email workflows:

```bash
# From your project root (where .claude/ lives)
mkdir -p .claude/commands
cp /path/to/gmail-mcp/.claude/commands/email.md .claude/commands/
cp /path/to/gmail-mcp/.claude/commands/checkemail.md .claude/commands/
```

Then use `/email` or `/checkemail` in Claude Code.

## Tools

| Tool | Description |
|------|-------------|
| `list_emails` | List inbox or label emails |
| `search_emails` | Search with Gmail query syntax |
| `read_email` | Read full email by ID; optional `headers` selects raw headers (including repeats), and `auth_summary: true` parses SPF/DKIM/DMARC and unsubscribe headers |
| `download_attachment` | Save an attachment by ID or exact filename to an existing directory |
| `get_thread` | Get full thread with all messages |
| `get_labels` | List all labels |
| `list_send_as` | List verified send-as aliases (wraps users.settings.sendAs.list) |
| `send_email` | Send a new email |
| `draft_email` | Create a draft |
| `reply_email` | Reply with proper threading |
| `archive_email` | Archive (remove INBOX label) |
| `label_email` | Add/remove labels |
| `trash_email` | Move to trash |
| `batch_modify` | Batch archive/trash/label |
| `calendar_list_calendars` | List calendars on the account |
| `calendar_list_events` | List events (`calendar_id` default `primary`, `time_min`, `time_max`, `max_results`, `query`) |
| `calendar_get_event` | Get one event by id |
| `calendar_freebusy` | Free/busy for a time range across a list of calendars |
| `calendar_create_event` | Create an event (`summary`, `start`, `end`, optional `timezone`, `description`, `location`, `attendees`) |
| `calendar_update_event` | Patch an event (only fields you pass) |

There is no calendar delete tool. Access is read plus create/update.

`calendar_create_event` and `calendar_update_event` send `send_updates: "none"` unless you pass `send_updates` (`none`, `all`, or `externalOnly`). If `attendees` is set, you must pass `send_updates` yourself — the tool will not assume `"none"` and will not email guests without an explicit value.

All tools accept an optional `account` parameter (alias or email). Defaults to the account set in `accounts.json`. Calendar uses the same OAuth client and token file as Gmail for that account.

## Commands

### `/email [action] [account]`

Full email management command with actions:
- **triage** — Summarize inbox, batch archive/trash
- **cleanup** — 4-phase daily email workflow
- **search {query}** — Cross-account search
- **send / draft / reply** — Compose with confirmation

### `/checkemail [account]`

Quick 3-phase inbox sweep:
1. Fetch & classify all inbox emails (auto-archive junk)
2. Batch archive on approval
3. Walk through remaining emails one at a time

## Troubleshooting

| Error | Fix |
|-------|-----|
| `accounts.json not found` | Copy `accounts.example.json` to `accounts.json` |
| `credentials.json not found` | Download OAuth credentials from GCP Console |
| `No token for...` | Run `npm run auth -- <alias>` |
| `Token refresh failed` | Re-authenticate: `npm run auth -- <alias>` |
| `403 Forbidden` | Add your email as test user in GCP OAuth consent screen |
| `403 insufficient scopes` | Re-authenticate to get updated scopes: `npm run auth -- <alias>` |
| Calendar tool: scope is not granted | Enable the Calendar API, add `calendar.events` on the OAuth consent screen, then `npm run auth -- <alias>`. Gmail tools still work before that re-consent. |

## License

MIT

## Read-only sender alerts ($0)

`npm run alerts` runs a separate watcher; the MCP server entry point and tools
are unchanged. It uses the existing account aliases and token-loading client.
Only accounts listed in rules are watched. Each account polls immediately and
then every 60 seconds, without overlapping its own requests. A slow poll delays
that account's next poll. The watcher only calls `users.history.list`
(`messageAdded`, `INBOX`), `users.messages.get` (`format=metadata`, headers
`From`, `Subject`, `Date`), and `users.getProfile`. It never reads or stores bodies,
snippets, or attachment information. Existing tokens may have broader scopes;
these operations only require `gmail.readonly`. Token refresh follows the
existing client behavior. No new dependencies, paid services, AI, Pub/Sub, or
cloud resources are used. On an ERROR alert (five failed polls or
`invalid_grant`), the watcher posts one 🔴 message per failure streak using
`SLACK_ALERTS_ACTION_WEBHOOK_URL` from `~/.config/desler/alerts.env`. When the
streak recovers, it posts one 🟢 message if
`SLACK_ALERTS_OK_WEBHOOK_URL` is configured. The file accepts `KEY='value'`
and `KEY="value"` lines. Missing action configuration and failed posts are
logged without exposing URLs or stopping the poll loop. Sender matches do not
post to Slack.

Create `~/.config/gmail-alerts/rules.json` as a JSON array, for example:

```json
[
  { "account": "tractic", "from": ["alfred.gpt@ktagroupinc.com"], "tag": "ALFRED" },
  { "account": "tractic", "from": ["greg.namrow@tractic.io"], "tag": "GREG" }
]
```

`account` must be an exact alias in the existing `accounts.json`. `from` is a
nonempty list of exact mailbox addresses, matched case-insensitively after
extracting the address from a display-name header. Optional `subject_contains`
is a nonempty array of literal, case-insensitive substrings; any one must match.
Each matching rule emits an alert. Restart the watcher after changing rules.
It does not create or edit rules, accounts, credentials, or authentication setup.

State is saved atomically in `~/.local/state/gmail-alerts/<account>.json`.
First startup seeds the current profile history ID; it does not scan old mail.
An expired history ID (404) logs a JSON `gap` event to stdout/journald and reseeds
from the profile. Mail in that gap cannot be recovered by this watcher.
History is paginated and message IDs are deduplicated within each poll. Cursors
advance only after processing all pages and messages. Delivery is at least once:
a crash or partial failure after appending alerts but before saving the cursor
can repeat alerts. Consumers can deduplicate by account, tag, and message ID.
Messages deleted before their metadata fetch (404) are skipped.

Matches append to `~/.local/state/gmail-alerts/alerts.jsonl` with exactly:

```json
{"ts":"2026-10-30T00:00:00.000Z","account":"tractic","tag":"ALFRED","from":"Alfred <alfred.gpt@ktagroupinc.com>","subject":"Status update","message_id":"example-message","thread_id":"example-thread"}
```

`ts` is observation time in UTC. After five consecutive failed polls, or
immediately on `invalid_grant`, the watcher appends an alert with tag `ERROR`,
a diagnostic subject, and empty sender/message/thread fields. It emits one
ERROR per failure streak and resets on success. Polling continues for recovery.
A daily per-account JSON `heartbeat` event and sanitized failure counts go to
stdout/journald. If state storage itself fails, an alert cannot be persisted;
the service exits and systemd retries. Alert files contain sender/subject data;
new directories/files are private. Use only one watcher process per state directory.

### Install the user service (manual)

Use a permanent checkout with its existing dependencies and authenticated tokens.
Copy the supplied unit, then edit its `WorkingDirectory` and `ExecStart` paths
for that checkout and the absolute Node executable (`command -v node`):

```bash
mkdir -p ~/.config/systemd/user
cp systemd/gmail-alerts.service ~/.config/systemd/user/
# Edit ~/.config/systemd/user/gmail-alerts.service paths before starting it.
systemctl --user daemon-reload
systemctl --user enable --now gmail-alerts.service
journalctl --user -u gmail-alerts.service -f
```

The repository ships the unit only; it does not install or enable it. User
services require an active user manager (lingering is an administrator choice).
Stop with `systemctl --user disable --now gmail-alerts.service`. Preserve the
state directory to resume at its cursor; removing state deliberately resets the
baseline and skips intervening mail. Alert rotation/retention is operator managed.

### Coordinator Monitor

Run this long-lived command through the coordinator's **Monitor** tool to receive
new JSON alerts as live events (create the file first if no match has arrived):

```bash
mkdir -p ~/.local/state/gmail-alerts
# Keep the directory private, including when creating it manually.
chmod 700 ~/.local/state/gmail-alerts
touch ~/.local/state/gmail-alerts/alerts.jsonl
chmod 600 ~/.local/state/gmail-alerts/alerts.jsonl
tail -n 0 -F ~/.local/state/gmail-alerts/alerts.jsonl | jq --unbuffered -c .
```

Inspect `ERROR` alerts for authentication failures and the service journal for
gaps or missing heartbeats. `jq` is only a convenience for the Monitor command;
the watcher does not require it.

## Slack alerts watcher

`npm run slack-alerts` runs a separate, read-only watcher (same pattern as the
Gmail alerts watcher; the MCP server is unchanged). It watches **every channel
the bot is a member of**, public and private. Channels are discovered with
`users.conversations` at startup and every 15 minutes, so channels the app is
added to later are picked up without a restart. It polls `conversations.history`
every 60 seconds using plain `fetch` against `https://slack.com/api`, with no new
dependencies. It never calls a Slack write method.

**Setup.** Create a Slack app with a bot token (`xoxb-...`) and exactly these
scopes: `channels:history`, `channels:read`, `groups:history`, `groups:read`.
Invite the bot to each channel to watch. Put the token in an env file that only
you can read (the token is never logged):

```bash
mkdir -p ~/.config/slack-alerts
printf 'SLACK_ALERTS_BOT_TOKEN=xoxb-...\n' > ~/.config/slack-alerts/env
chmod 600 ~/.config/slack-alerts/env
```

**Optional overrides**: `~/.config/slack-alerts/channels.json`. Without it every
member channel is watched and its tag is the channel name.

```json
{ "exclude": ["random"], "tags": { "fleet-red-action": "RED", "fleet-amber-watch": "AMBER", "fleet-green-ok": "GREEN" } }
```

**Files**

| File | Purpose |
|------|---------|
| `~/.local/state/slack-alerts/alerts.jsonl` | One line per new message |
| `~/.local/state/slack-alerts/state.json` | Last seen `ts` per channel ID |
| `~/.local/state/slack-alerts/backfill-<date>.jsonl` | Output of `--backfill` |

A message line is `{"ts_iso","channel","tag","color","ts","text","bot_name"|"user","thread_ts"?}`.
`text` is the first 500 characters. `color` is `red`, `amber` or `green` when the
text starts with 🔴, 🟡 or 🟢, otherwise `null`. A channel seen for the first
time (first run, or newly joined) starts at "now", so old history is not flooded
into the feed. Thread replies are not fetched. Permalinks are not included.

On an API error the watcher appends `{"ERROR":"<code>","channel","ts_iso"}`, at
most once per distinct error and channel per hour. A 429 pauses all polling for
the `Retry-After` time. A failure to write state exits the process so systemd
restarts it.

**Backfill** (one-shot, separate from the loop; does not touch `state.json`):

```bash
npm run slack-alerts -- --backfill 7
```

writes the last 7 days from all member channels to
`~/.local/state/slack-alerts/backfill-<date>.jsonl` and exits.

**Service.** `deploy/slack-alerts.service` is a user unit that reads the token
from `EnvironmentFile=%h/.config/slack-alerts/env`. It is committed but not
installed. Edit its paths, then copy it to `~/.config/systemd/user/` and run
`systemctl --user enable --now slack-alerts.service`. Use one watcher per state
directory. Follow the feed with the same Monitor `tail -F ... | jq` command as
above, pointed at the Slack `alerts.jsonl`.

## Muse email filer

`npm run muse-filer` is a standalone, deterministic Gmail-to-GitHub filer for
`kevin.m.desler@gmail.com`, resolved through the existing `accounts.json` and
OAuth client. It selects subjects starting exactly with `[Muse] Spec` and skips
messages already labeled `muse-filed`. Use the existing authenticated `gh` CLI.
It accepts only mail whose From address is exactly `kevin.m.desler@gmail.com`,
skips SPAM-labeled messages, and rejects Google authentication results containing
`dkim=fail`, `spf=fail`, or `dmarc=fail` before reading the message body.

```bash
npm run muse-filer                 # dry-run by default
npm run muse-filer -- --dry-run     # explicit preview
npm run muse-filer -- --apply       # create issues and mark completed emails
```

Dry-run prints the exact proposed repository, title, body, labels, and missing
labels; it creates no GitHub issues or labels and applies no Gmail labels.
It still writes the required local run audit and temporary process lock; existing
OAuth loading may refresh its token normally. No LLM is used. Email text is
parsed as data only and passed to `gh` as arguments without a shell. The filer
never sends email or edits, closes, deletes, or comments on existing issues.

Send an inline plain-text email in this exact format (repeat the six-field
block for each finding):

```text
Subject: [Muse] Spec <task name> <date>

TITLE: Inflecto: Total shows the wrong amount
REPRO: Open billing
Select the annual plan
EXPECTED: Total is 120
ACTUAL: Total is 12
EVIDENCE: Tester screenshot URL or observation
SEVERITY: wrong number

TITLE: CW: Save button does nothing
REPRO: Open settings and click Save
EXPECTED: Settings persist
ACTUAL: Nothing happens
EVIDENCE: Tester observation
SEVERITY: broken

Regression verdicts:
#123 PASS: Previously reported issue is fixed
#456 FAIL: Previously reported issue still reproduces
```

Field names are uppercase and start their own lines. `TITLE` is one line; other
fields continue until the next field name. `SEVERITY` is `wrong number`, `broken`,
`confusing`, or `cosmetic`. A separate `Regression verdicts:` section contains
one verdict per line with an existing `#issue` number; these lines are logged,
never filed. Reports with no new findings may use `Nothing found.` or a standalone
`FINDINGS` header followed by `None. No new findings this run.`. Bounded forms
using `(none)`, U+2014, and `zero findings this run` or `no new findings this run`
are also accepted, including a counted inline note that FAIL cells cite already
filed issues. After a blank line, the declaration may be followed only by
groups such as `Two cells fail against already-open issues (see COVERAGE, not
re-reported as new findings):` followed by bullets that each cite an `#issue`. The
section ends at `COVERAGE`, `Observations (not findings)`, or `Notes (not findings)`.
These declarations concern new findings only; FAIL/BLOCKED coverage remains
unresolved, and finding field blocks always take precedence.
Attachments and HTML-only messages are not parsed; send inline `text/plain`.

Routes (verified with read-only `gh repo view` on November 8, 2026; checked again
before each repository's first use in a run):

| TITLE prefix | Repository |
|---|---|
| Inflecto | kmdesle/inflecto-ai |
| Sendinel | kmdesle/sendinel-ai |
| Synchronex | kmdesle/synchronex |
| Tractic | tractic-io/tractic-2.0 |
| Cyber-Wingman or CW | kmdesle/cyber-wingman |
| Hashfolio | kmdesle/hashfolio |
| WFI or Hyperion | kmdesle/wfi-hyperion |
| Wren | kmdesle/wren-app |
| ACT-Now | kmdesle/act-now |

Prefix matching is case-insensitive. Issues are titled `[muse] <finding title>`
with the leading product prefix removed. Bodies contain REPRO, EXPECTED, ACTUAL,
EVIDENCE, and SEVERITY sections plus `Filed from Muse email <message_id>`.
Apply creates only a missing `muse-test` label (purple, with a Muse description).
The required `needs-spec` label must already exist; if missing, apply stops and
leaves the email pending. Other labels are never created or changed. For
`wrong number`, an existing priority label is added only when exactly one label
matches `P0`, `P1`, `priority: critical`, `priority: high`, `priority: highest`,
`priority: P0`, `priority: P1`, or `priority-critical` / `priority-high`
(space also accepted instead of the hyphen). Otherwise no priority is guessed.

Duplicate detection uses paginated GitHub REST reads: all `muse-test` issues
updated within the 14-day lookback (state=all), plus all open `muse-test` issues
and open issues whose titles start with `Muse:` or `[muse]`. There is no 200-issue
limit. Pull requests are excluded. Matching is deterministic, without an LLM:

- Rule B: extract distinctive tokens from TITLE + ACTUAL: double-quoted phrases,
  numbers (including currency, units, percentages, and bare counts), and snake_case
  tool names. Two distinct tokens shared with an existing repository issue's title +
  body identify a possibly related issue, but Rule B matches never drop a finding.
  Instead, the finding is filed normally with a trailing `## POSSIBLY RELATED\n\n#<N> (shares: <tokens>)`
  section appended to the issue body so the triaging session decides. In `--explain` output,
  this is reported as action `filed` with rule `distinctive_tokens_related` and the related issue number.
  Rule B never compares a finding against other findings planned or filed in the same run;
  in-run duplicates are detected only via the exact-title/Jaccard >= 0.7 rule.
- Normalized title token-Jaccard >= 0.7 remains a duplicate. Exact normalized
  titles with a matching `Filed from Muse email <message_id>` footer also recover
  partial runs, including closed or unlabeled issues updated within 14 days.
- Rule A: if no Jaccard, footer, or Rule B match applies, a `#N` reference in any finding field to
  an issue in the target repository that is open or closed within 14 days yields
  `possible_duplicate`. Apply never files these findings and leaves their email
  pending for review. A Rule B match still files, with the related section, even when the finding also cites an issue. Other repositories cannot resolve the reference.

Add `--explain` to print the matching rule and shared tokens for each duplicate,
related match, or possible duplicate, for example `npm run muse-filer -- --dry-run --explain`.
Recovery uses REST to avoid search-index lag; crash gaps longer than 14 days
are not covered. Duplicate issue numbers are reported. New issues are added to the
in-memory comparison set, preventing repeats within a run. At most 10 issues
are created per run (or planned in dry-run); deferred findings leave the email
pending. Run again to continue after a cap or failure.

Missing TITLE, REPRO, or ACTUAL, and multiline titles, are reported as malformed.
Malformed findings count as handled so they do not retry forever. Unknown
products are reported as unrouted and leave the email pending. Only emails whose
findings were all filed, duplicated, or reported malformed are marked
`muse-filed`; nothing-found and regression-only emails are marked as well. Apply
creates the Gmail label lazily when first marking a completed email.

Each run appends one JSON line to `~/.local/state/muse-filer/runs.jsonl`, containing
`ts`, `dry_run`, `results` (message ID, original title, action, and issue URL or
number when applicable), `planned` previews, regression verdicts, deferred/skipped
messages, and a sanitized error on failure. Results use `filed`, `duplicate`,
`possible_duplicate`, `malformed`, or `unrouted`; dry-run proposals live in `planned` so they cannot be
mistaken for completed filings. New state files/directories are private. Audit
records contain test specifications; retention is operator managed. A local
`run.lock` prevents overlapping processes using this state directory. After a
hard kill, verify no filer is active before removing a stale lock. Footer recovery reads the repository issue history once per run, which may be
slow in very large repositories. Cron and Monitor wiring are left to the coordinator.

`npm test` includes synthetic Muse fixtures with injected Gmail and `gh` clients;
no network or real issue/label creation is used by those tests.

## Muse health watch

`npm run muse-watch` checks `kevin@cyberwingman.ai` with the existing Gmail
OAuth client, independently of coordinator sessions. Gmail operations are only
label listing, message listing and message reading; it never sends email or
changes Gmail labels. `npm run muse-watch -- --dry-run` prints proposed findings
without posting to Slack or advancing alert state.

The tester runs at 08:00, 11:00, 14:00 and 17:00 HST (18:00, 21:00, 00:00 and
03:00 UTC). A slot missing an incoming subject starting `Muse Inflecto test` or
`[Muse] Spec` within two hours raises amber once. A subsequent report recovers
outstanding missing-report alerts. The first run checks the previous 24 hours;
later runs catch up from the persisted timestamp, including after downtime.

Orders from `kevin@cyberwingman.ai` or `kevin.m.desler@gmail.com` to Muse
(`kevin.m.desler@gmail.com`, the existing filer identity) with a `[Muse]` subject
prefix or a `Muse`/`[Muse]` label need an incoming `[Muse] Ack: <original subject>`
within 15 minutes. Test, Spec and Ack subjects are excluded. An unacknowledged
order raises amber once; a later matching Ack posts one green. If a late Ack
is first observed after the deadline, both transitions are recorded that run. Matching uses
the full original subject and arrival time, with repeated subjects bounded by
the next order. Incoming Acks with `Status: HOLDING` raise amber once including
the `Reason:` line; a newer Ack with the same subject and an explicit status
other than HOLDING recovers it. Old unresolved orders and Acks have no age cutoff.

State is stored atomically in `~/.local/state/muse-watch/state.json`. Alerted
slot/order/Ack IDs remain recorded after recovery so they never re-fire.
A `run.lock` prevents overlapping CLI runs; after a killed process, verify no
watcher is running before removing a stale lock. A failed Gmail scan raises
source-unknown amber and preserves existing failures; it never implies green.
Slack posts use the existing `~/.config/desler/alerts.env` plumbing:
`SLACK_ALERTS_WATCH_WEBHOOK_URL` routes 🟡 to `#fleet-amber-watch`, and
`SLACK_ALERTS_OK_WEBHOOK_URL` routes 🟢 to `#fleet-green-ok`. If a color webhook
is missing, the existing action webhook (`SLACK_ALERTS_ACTION_WEBHOOK_URL`,
`#fleet-red-action`) is used with a logged fallback and the original circle.
Missing configuration or failed posts do not mark that alert as delivered.

Install in the server user's crontab to replace session-only coordinator crons:

```cron
17 * * * * cd ~/.claude/mcp-servers/gmail-mcp && HOME=$HOME npm run muse-watch
```

Multi-product: `npm run muse-watch -- --product sendinel` (default `inflecto`) watches
only hourly REPORT MISSING slots for subject `[Muse] Spec Sendinel`, with separate
state in `~/.local/state/muse-watch/sendinel/state.json`; alerts read
`SENDINEL · Muse ...`. Order/Ack checks stay with the Inflecto instance. Cron line:

```cron
27 * * * * cd ~/.claude/mcp-servers/gmail-mcp && HOME=$HOME npm run muse-watch -- --product sendinel
```

`npm test` includes injected read-only Gmail clients and fake Slack posters;
tests do not send email or post to Slack.

## Muse test planner

`npm run muse-planner` is a standalone, deterministic test coordinator for
hourly Muse testing against `kmdesle/inflecto-ai`. Muse (an AI tester with a
browser and the Inflecto MCP) reads ONE pinned GitHub issue each hour for its
exact brief; this planner maintains a coverage ledger and rewrites that brief.

```bash
npm run muse-planner                 # dry-run by default
npm run muse-planner -- --dry-run     # explicit preview
npm run muse-planner -- --apply       # update target issue and persist ledger
```

### Inputs

1. **Coverage matrix**: fetched from `kmdesle/inflecto-ai/contents/docs/qa/muse-coverage-matrix.json`
   on `main` via `gh api`.
2. **Gmail (`kevin@cyberwingman.ai`)**: read-only scan of emails from Muse whose
   subject starts with `[Muse] Spec` or `Muse Inflecto test`. Parses the `COVERAGE`
   section following a `COVERAGE` line, matching `<cell id> | PASS|FAIL|BLOCKED | <issue refs or ->`.
   Unknown cell IDs and malformed lines are ignored. Processed message IDs are tracked in the
   ledger so each email is applied once, in chronological date order.
3. **GitHub issues**: open and closed issues labeled `muse-test` in `kmdesle/inflecto-ai`.

### Ledger and Scoreboard

State is stored in `~/.local/state/muse-planner/ledger.json` (`0o600` permissions),
recording per cell `{last_result, last_run, last_pass, last_fail, runs, issue_refs}`
alongside processed message IDs and daily walk date. Each run prints a one-line scoreboard:

```text
Scoreboard: coverage 25.0% (27/108), fails: 2, blocked: 1, never-run: 78
```

Coverage measures cells with a `last_pass` within the last 7 days over total cells.

### Brief Generation and Scheduling

Briefs are built in strict priority order within a budget of 35 estimated MCP calls
and at most 2 browser cells per hourly run:

- **RETEST**: cells whose `guards` list contains a CLOSED issue whose `last_run` is
  older than the issue's `closedAt` (or never run).
- **SMOKE**: cells with `smoke: true` are included every run.
- **FILL**: fills remaining budget, prioritizing cells never run first, then cells
  with `last_result` of `FAIL` or `BLOCKED`, then stalest by `last_run`.
- **DAILY-WALK**: once per HST calendar day, at the first run on or after 10:00 HST,
  includes every browser cell.
- **WEEKLY**: on Sundays HST, includes cells marked `weekly: true`.

If open `muse-test` issues exceed 15, the planner switches to `RETEST_ONLY` mode
(only RETEST and SMOKE cells; no fill, daily walk, weekly, or exploratory hunting).
Otherwise, ~20% of the MCP budget is left for exploratory testing.

### Target Issue and Idempotency

The planner finds the open issue in `kmdesle/inflecto-ai` with label `muse-brief`.
In `--apply`, it creates the label and issue titled `Muse next-run brief (auto-generated, do not edit)`
if missing. If the generated brief matches the existing body except for the UTC timestamp,
the update is skipped idempotently. The planner never comments on or closes issues, never
sends email, and never posts to Slack. `--dry-run` writes nothing to disk or GitHub.

### Multi-product (`--product`)

`--product inflecto|sendinel` (default `inflecto`, identical to the original behavior)
selects a config table: repo, matrix path, ledger path, report subject, TITLE prefix,
brief label and Gmail query. Sendinel uses `kmdesle/sendinel-ai`, the ledger
`~/.local/state/muse-planner/sendinel/ledger.json` (the Inflecto ledger is never read or
written), and ONE pinned `muse-brief` issue titled `Muse brief: Sendinel coordinated testing`
(found by title, otherwise created and pinned on `--apply`). Its brief restricts Muse to the
sandbox project, allowlisted targets and no production account creation, and requires
`Sendinel: ` TITLE prefixes. `muse-filer` already routes `[Muse] Spec Sendinel` emails to
`kmdesle/sendinel-ai`. Cron line:

```cron
20 * * * * cd ~/.claude/mcp-servers/gmail-mcp && HOME=$HOME npm run muse-planner -- --product sendinel --apply
```
