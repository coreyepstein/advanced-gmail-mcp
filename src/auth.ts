#!/usr/bin/env node
/** Auth CLI for gmail-mcp. */

import { pathToFileURL } from 'node:url';
import { getAccounts, resolveAccount, type AccountConfig } from './config.js';
import {
  authenticateAccount,
  checkAuthStatus,
  createAuthHealthEnvelope,
  createAuthHealthFailure,
  type AuthHealthReport,
  type AuthFlowOptions,
} from './gmail/auth.js';

export type AuthCommand =
  | { mode: 'check'; json: boolean }
  | {
      mode: 'authenticate';
      account: string | null;
      forceConsent: boolean;
    };

export function parseAuthArgs(args: string[]): AuthCommand {
  const unknownFlags = args.filter(arg => arg.startsWith('--')
    && arg !== '--check'
    && arg !== '--json'
    && arg !== '--force-consent');
  if (unknownFlags.length > 0) {
    throw new Error(`Unknown option: ${unknownFlags[0]}`);
  }

  const checkCount = args.filter(arg => arg === '--check').length;
  const jsonCount = args.filter(arg => arg === '--json').length;
  const forceCount = args.filter(arg => arg === '--force-consent').length;
  const accounts = args.filter(arg => !arg.startsWith('--'));

  if (checkCount > 0) {
    if (checkCount !== 1 || jsonCount > 1 || forceCount > 0 || accounts.length > 0
        || args.length !== 1 + jsonCount) {
      throw new Error('--check cannot be combined with account aliases or recovery options.');
    }
    return { mode: 'check', json: jsonCount === 1 };
  }

  if (jsonCount > 0) {
    throw new Error('--json can only be used with --check.');
  }

  if (forceCount > 0) {
    if (forceCount !== 1 || accounts.length !== 1 || args.length !== 2) {
      throw new Error('--force-consent requires exactly one account alias.');
    }
    return {
      mode: 'authenticate',
      account: accounts[0],
      forceConsent: true,
    };
  }

  if (accounts.length > 1) {
    throw new Error('Normal authorization accepts at most one account alias.');
  }
  return {
    mode: 'authenticate',
    account: accounts[0] ?? null,
    forceConsent: false,
  };
}

export interface AuthCliDependencies {
  getAccounts: () => AccountConfig[];
  resolveAccount: (input?: string) => AccountConfig;
  authenticateAccount: (
    account: AccountConfig,
    options?: AuthFlowOptions,
  ) => Promise<void>;
  checkAuthStatus: (
    options?: { json?: boolean },
  ) => AuthHealthReport | Promise<AuthHealthReport>;
  log: (message: string) => void;
  error: (message: string) => void;
}

const defaultDependencies: AuthCliDependencies = {
  getAccounts,
  resolveAccount,
  authenticateAccount,
  checkAuthStatus: options => checkAuthStatus(options?.json ? { log: () => {} } : {}),
  log: console.log,
  error: console.error,
};

export async function runAuthCli(
  args: string[],
  dependencies: AuthCliDependencies = defaultDependencies,
): Promise<number> {
  let command: AuthCommand;
  try {
    command = parseAuthArgs(args);
  } catch (error) {
    dependencies.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (command.mode === 'check') {
    try {
      const report = await dependencies.checkAuthStatus({ json: command.json });
      if (command.json) {
        dependencies.log(JSON.stringify(createAuthHealthEnvelope(report)));
      }
      return report.exitCode;
    } catch (error) {
      if (command.json) {
        dependencies.log(JSON.stringify(createAuthHealthFailure(error)));
      } else {
        dependencies.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
      return 1;
    }
  }

  if (command.account) {
    try {
      const account = dependencies.resolveAccount(command.account);
      await dependencies.authenticateAccount(account, {
        forceConsent: command.forceConsent,
      });
      return 0;
    } catch (error) {
      dependencies.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  const accounts = dependencies.getAccounts();
  dependencies.log(`Authenticating all ${accounts.length} accounts...`);
  let failed = false;
  for (const account of accounts) {
    try {
      await dependencies.authenticateAccount(account, { forceConsent: false });
    } catch (error) {
      failed = true;
      dependencies.error(
        `Failed to authenticate ${account.email}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return failed ? 1 : 0;
}

async function main(): Promise<void> {
  process.exitCode = await runAuthCli(process.argv.slice(2));
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entrypoint) {
  void main().catch(error => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
