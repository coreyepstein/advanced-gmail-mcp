# Gmail MCP Server

![Advanced Gmail MCP](social-preview.png)

A Gmail [MCP server](https://modelcontextprotocol.io) for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that provides full email management across multiple Gmail accounts.

## Features

- **12 tools**: list, search, read, thread, labels, send, draft, reply, archive, label, trash, batch modify
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
3. Enable the **Gmail API**:
   - APIs & Services → Enable APIs → search "Gmail API" → Enable
4. Configure the **OAuth consent screen**:
   - APIs & Services → OAuth consent screen
   - Choose **External** when the account list mixes personal Gmail and Google Workspace accounts
   - Publish the app to **In production** after setup. External apps left in Testing can receive refresh tokens that expire after seven days
   - If you intentionally keep the app in Testing, add every configured email address as a test user
   - Add scopes: `gmail.readonly`, `gmail.modify`, `gmail.send`, `gmail.compose`
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
# Authenticate all accounts. Accounts with a healthy saved token are skipped.
npm run auth

# Authenticate or verify one account
npm run auth -- work

# Check every account without opening a browser
npm run auth:check

# Explicit recovery for one account only
npm run auth -- work --force-consent
```

Normal authentication first verifies an existing token against the configured Gmail address. It
opens the Google consent flow only when no usable token is present. Normal consent does not force
Google to issue a new refresh token.

Use `--force-consent` only for explicit recovery. It requires exactly one account alias, requests
consent again, and asks Google for a replacement refresh token. Select the Gmail account that
matches the email configured for that alias.

`npm run auth:check` is a live, noninteractive health check. For each configured account it forces
a refresh-token exchange, calls the Gmail profile endpoint, and verifies that Google returned the
configured email address. It reports every account and exits with a nonzero status if any account
fails. It never opens a browser or starts a consent flow.

Tokens are saved under `./tokens/`.

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
| `read_email` | Read full email by ID |
| `get_thread` | Get full thread with all messages |
| `get_labels` | List all labels |
| `send_email` | Send a new email |
| `draft_email` | Create a draft |
| `reply_email` | Reply with proper threading |
| `archive_email` | Archive (remove INBOX label) |
| `label_email` | Add/remove labels |
| `trash_email` | Move to trash |
| `batch_modify` | Batch archive/trash/label |

All tools accept an optional `account` parameter (alias or email). Defaults to the account set in `accounts.json`.

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
| `REAUTHORIZATION_REQUIRED` or `invalid_grant` | Run `npm run auth -- <alias> --force-consent` |
| `DOMAIN_POLICY` | Ask the Google Workspace administrator to allow the app and Gmail scopes |
| `INSUFFICIENT_SCOPE` | Review the configured OAuth scopes. If the grant must change, use the forced recovery command for that alias |
| `WRONG_ACCOUNT` | Run authentication for the alias again and select its configured Gmail address |
| `QUOTA` or `RATE_LIMIT` | Wait, then retry. Forced consent does not fix Gmail quotas |
| `NETWORK` or `TRANSIENT` | Check the network and retry the live health check |
| `LOCAL_PERMISSION` or `CORRUPT_TOKEN` | Repair local ownership or remove only the affected token, then authenticate that alias again |
| Other `403 Forbidden` | Inspect the reported category. A 403 can be policy, scope, quota, or access denial. Do not assume reauthorization will fix it |

Start diagnosis with:

```bash
npm run auth:check
```

Human reauthorization cannot be eliminated in every case. Google can invalidate refresh tokens
after a user or administrator revokes access, a Gmail password change, six months without token
use, token issuance limits, account security enforcement, or a required scope change. When the
health check reports that recovery is required, use this exact order:

```bash
npm run auth:check
npm run auth -- <alias> --force-consent
```

## OAuth Scope Policy

This release intentionally preserves the existing request for these four scopes:

- `gmail.readonly`
- `gmail.modify`
- `gmail.send`
- `gmail.compose`

Reducing scopes is a separate migration. It requires an operation-by-operation access audit and a
new grant. Changing the scope list in code does not remove permissions Google already granted to a
stored refresh token. A true downscope requires revoking the old grant or token and authorizing the
smaller scope set again.

## Local Credential Safety

- `credentials.json`, `accounts.json`, and `tokens/` are ignored by Git. Never commit, copy into CI,
  paste, or log their contents.
- On POSIX systems, credential and token files are repaired to owner-only mode (`0600`) and the
  token directory to owner-only mode (`0700`).
- Token updates are merge-safe and atomically replace the saved file. A refresh-token event cannot
  erase an existing refresh token merely because Google returned only a new access token.
- Keep credentials and tokens on the machine that runs the MCP server. Treat backups as secrets.

## Continuous Integration

The GitHub Actions workflow runs on pull requests and pushes to `main`. It executes:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

CI does not receive Gmail client credentials, account configuration, or tokens. The automatic
GitHub token is restricted to read-only repository contents, checkout does not persist credentials,
and official GitHub actions are pinned to immutable commit SHAs.

## License

MIT
