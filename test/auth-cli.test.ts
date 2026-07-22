import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAuthArgs, runAuthCli } from '../src/auth.js';

test('canonical one-account forced consent parses', () => {
  assert.deepEqual(parseAuthArgs(['welgo', '--force-consent']), {
    mode: 'authenticate',
    account: 'welgo',
    forceConsent: true,
  });
});

test('forced consent requires exactly one explicit account', () => {
  assert.throws(
    () => parseAuthArgs(['--force-consent']),
    /requires exactly one account alias/i,
  );
  assert.throws(
    () => parseAuthArgs(['welgo', 'personal', '--force-consent']),
    /requires exactly one account alias/i,
  );
});

test('normal parser preserves check, one-account, and all-account modes', () => {
  assert.deepEqual(parseAuthArgs(['--check']), { mode: 'check', json: false });
  assert.deepEqual(parseAuthArgs(['--check', '--json']), { mode: 'check', json: true });
  assert.deepEqual(parseAuthArgs(['welgo']), {
    mode: 'authenticate',
    account: 'welgo',
    forceConsent: false,
  });
  assert.deepEqual(parseAuthArgs([]), {
    mode: 'authenticate',
    account: null,
    forceConsent: false,
  });
});

test('unknown flags and multiple normal accounts fail closed', () => {
  assert.throws(() => parseAuthArgs(['--wat']), /unknown option/i);
  assert.throws(() => parseAuthArgs(['--json']), /only be used with --check/i);
  assert.throws(() => parseAuthArgs(['welgo', 'personal']), /at most one account/i);
});

test('check mode returns the aggregate health exit code', async () => {
  const exitCode = await runAuthCli(['--check'], {
    getAccounts: () => [],
    resolveAccount: () => { throw new Error('not used'); },
    authenticateAccount: async () => {},
    checkAuthStatus: async () => ({
      accounts: [{
        alias: 'personal',
        email: 'ed@example.com',
        category: 'missing_token',
        healthy: false,
        message: 'Token is missing.',
      }],
      healthy: false,
      exitCode: 1,
    }),
    log: () => {},
    error: () => {},
  });

  assert.equal(exitCode, 1);
});

test('JSON check mode emits one machine-readable report without human health lines', async () => {
  const logs: string[] = [];
  const report = {
    accounts: [{
      alias: 'personal',
      email: 'ed@example.com',
      category: 'healthy' as const,
      healthy: true,
      message: 'Gmail refresh and profile access verified.',
    }],
    healthy: true,
    exitCode: 0 as const,
  };
  let requestedJson = false;

  const exitCode = await runAuthCli(['--check', '--json'], {
    getAccounts: () => [],
    resolveAccount: () => { throw new Error('not used'); },
    authenticateAccount: async () => {},
    checkAuthStatus: async options => {
      requestedJson = options?.json === true;
      return report;
    },
    log: message => { logs.push(message); },
    error: () => {},
  });

  assert.equal(exitCode, 0);
  assert.equal(requestedJson, true);
  assert.equal(logs.length, 1);
  assert.deepEqual(JSON.parse(logs[0]!), {
    schemaVersion: 1,
    ...report,
  });
});
