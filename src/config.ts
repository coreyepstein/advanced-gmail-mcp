import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

export interface AccountConfig {
  email: string;
  alias: string;
}

export interface Config {
  accounts: AccountConfig[];
  default: string;
}

let _config: Config | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateAlias(alias: unknown): string {
  if (typeof alias !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(alias)) {
    throw new Error(
      'Invalid account alias. Use only letters, numbers, underscores, and hyphens.',
    );
  }
  return alias;
}

/** Validate account configuration before any alias is used for token I/O. */
export function validateConfig(value: unknown): Config {
  if (!isRecord(value) || !Array.isArray(value.accounts) || value.accounts.length === 0) {
    throw new Error('Invalid accounts.json: accounts must be a non-empty array.');
  }

  const accounts = value.accounts.map((entry, index): AccountConfig => {
    if (!isRecord(entry) || typeof entry.email !== 'string' || entry.email.trim() === '') {
      throw new Error(`Invalid accounts.json: account ${index + 1} must have an email.`);
    }
    return {
      email: entry.email.trim().toLowerCase(),
      alias: validateAlias(entry.alias),
    };
  });

  const aliases = new Set<string>();
  for (const account of accounts) {
    const canonicalAlias = account.alias.toLowerCase();
    if (aliases.has(canonicalAlias)) {
      throw new Error(`Duplicate account alias: ${account.alias}`);
    }
    aliases.add(canonicalAlias);
  }

  if (typeof value.default !== 'string') {
    throw new Error('Invalid accounts.json: default must name an account alias.');
  }
  const defaultAlias = value.default;
  const defaultAccount = accounts.find(
    account => account.alias.toLowerCase() === defaultAlias.toLowerCase(),
  );
  if (!defaultAccount) {
    throw new Error(`Invalid accounts.json: default alias not found: ${defaultAlias}`);
  }

  return { accounts, default: defaultAccount.alias };
}

function loadConfig(): Config {
  if (_config) return _config;

  const configPath = path.join(PROJECT_ROOT, 'accounts.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(
      'accounts.json not found. Copy accounts.example.json to accounts.json and add your accounts.'
    );
  }

  const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  _config = validateConfig(parsed);
  return _config!;
}

export function getAccounts(): AccountConfig[] {
  return loadConfig().accounts;
}

export function getDefaultAlias(): string {
  return loadConfig().default;
}

/**
 * Resolve an alias or email to an AccountConfig.
 * Accepts: alias (e.g. "work"), full email, or partial match.
 */
export function resolveAccount(input?: string): AccountConfig {
  const config = loadConfig();

  if (!input) {
    return config.accounts.find(a => a.alias === config.default)!;
  }

  const lower = input.toLowerCase();

  // Exact alias match
  const byAlias = config.accounts.find(a => a.alias.toLowerCase() === lower);
  if (byAlias) return byAlias;

  // Exact email match
  const byEmail = config.accounts.find(a => a.email.toLowerCase() === lower);
  if (byEmail) return byEmail;

  // Partial email match
  const byPartial = config.accounts.find(a => a.email.toLowerCase().includes(lower));
  if (byPartial) return byPartial;

  throw new Error(
    `Unknown account: "${input}". Valid aliases: ${config.accounts.map(a => a.alias).join(', ')}`
  );
}

export function getCredentialsPath(): string {
  return path.join(PROJECT_ROOT, 'credentials.json');
}

export function getTokenPath(account: AccountConfig): string {
  const alias = validateAlias(account.alias);
  const tokenDirectory = path.resolve(PROJECT_ROOT, 'tokens');
  const tokenPath = path.resolve(tokenDirectory, `${alias}.json`);

  if (path.dirname(tokenPath) !== tokenDirectory) {
    throw new Error('Invalid account alias: token path must stay inside the token directory.');
  }

  return tokenPath;
}
