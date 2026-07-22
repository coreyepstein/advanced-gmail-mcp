import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import type { AccountConfig } from '../src/config.js';
import {
  configureAuthClient,
} from '../src/gmail/auth.js';
import {
  classifyGmailError,
  formatGmailRuntimeError,
  withRetry,
} from '../src/gmail/client.js';
import { readStoredTokenFile, writeStoredTokenFile } from '../src/gmail/token-store.js';
import type { StoredToken } from '../src/gmail/types.js';

const account: AccountConfig = { alias: 'welgo', email: 'ed@welgo.space' };

class FakeOAuthClient extends EventEmitter {
  credentials: StoredToken = {};
  listenersSeenBySetCredentials = 0;

  setCredentials(credentials: StoredToken): void {
    this.listenersSeenBySetCredentials = this.listenerCount('tokens');
    this.credentials = credentials;
  }
}

function tempTokenPath(t: test.TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-auth-client-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'tokens', 'welgo.json');
}

function providerError(status: number, reason?: string, message = 'provider message'): unknown {
  return {
    code: status,
    response: {
      status,
      data: {
        error: {
          message,
          status: status === 403 ? 'PERMISSION_DENIED' : undefined,
          errors: reason ? [{ reason }] : [],
        },
      },
    },
  };
}

test('token persistence is installed before credentials and completes synchronously', t => {
  const tokenPath = tempTokenPath(t);
  writeStoredTokenFile(tokenPath, {
    access_token: 'old-access',
    refresh_token: 'durable-refresh',
  });
  const client = new FakeOAuthClient();
  const order: string[] = [];

  configureAuthClient(
    account,
    client,
    { access_token: 'old-access', refresh_token: 'durable-refresh' },
    (_selectedAccount, update) => {
      order.push('write-start');
      const stored = writeStoredTokenFile(tokenPath, update);
      order.push('write-finished');
      return stored;
    },
  );

  assert.equal(client.listenersSeenBySetCredentials, 1);
  order.push('emit-start');
  client.emit('tokens', { access_token: 'new-access' });
  order.push('emit-returned');

  assert.deepEqual(order, ['emit-start', 'write-start', 'write-finished', 'emit-returned']);
  assert.deepEqual(readStoredTokenFile(tokenPath), {
    access_token: 'new-access',
    refresh_token: 'durable-refresh',
  });
});

test('token event accepts refresh-token rotation and fails closed on storage error', t => {
  const tokenPath = tempTokenPath(t);
  writeStoredTokenFile(tokenPath, { refresh_token: 'old-refresh' });
  const rotatingClient = new FakeOAuthClient();
  configureAuthClient(
    account,
    rotatingClient,
    { refresh_token: 'old-refresh' },
    (_selectedAccount, update) => writeStoredTokenFile(tokenPath, update),
  );

  rotatingClient.emit('tokens', { refresh_token: 'rotated-refresh' });
  assert.equal(readStoredTokenFile(tokenPath)?.refresh_token, 'rotated-refresh');

  const failingClient = new FakeOAuthClient();
  configureAuthClient(account, failingClient, {}, () => {
    throw new Error('simulated persistence failure');
  });
  assert.throws(
    () => failingClient.emit('tokens', { access_token: 'not-persisted' }),
    /simulated persistence failure/,
  );
});

test('runtime classifier distinguishes auth, policy, scope, quota, transient, and network errors', () => {
  assert.equal(classifyGmailError({
    response: { status: 400, data: { error: 'invalid_grant' } },
  }).category, 'reauthorization_required');
  assert.equal(classifyGmailError(providerError(401)).category, 'reauthorization_required');
  assert.equal(classifyGmailError(providerError(403, 'insufficientPermissions')).category,
    'insufficient_scope');
  assert.equal(classifyGmailError(providerError(403, 'domainPolicy')).category, 'domain_policy');
  assert.equal(classifyGmailError(providerError(403, 'dailyLimitExceeded')).category, 'quota');
  assert.equal(classifyGmailError(providerError(429, 'rateLimitExceeded')).category, 'rate_limit');
  assert.equal(classifyGmailError(providerError(503)).category, 'transient');
  assert.equal(classifyGmailError({ code: 'ENOTFOUND', message: 'dns lookup failed' }).category,
    'network');
  assert.equal(classifyGmailError(providerError(403)).category, 'forbidden');
});

test('only credential failures instruct forced-consent recovery', () => {
  const credentialMessage = formatGmailRuntimeError(providerError(401)).message;
  assert.match(credentialMessage, /--force-consent/);

  for (const error of [
    providerError(403, 'insufficientPermissions'),
    providerError(403, 'domainPolicy'),
    providerError(403, 'dailyLimitExceeded'),
    providerError(429, 'rateLimitExceeded'),
    providerError(503),
    { code: 'ECONNRESET', message: 'socket reset' },
  ]) {
    assert.doesNotMatch(formatGmailRuntimeError(error).message, /re-?auth|force-consent/i);
  }
});

test('rate limits retain bounded retry while quota and transient failures pass through', async () => {
  let attempts = 0;
  const delays: number[] = [];
  const result = await withRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw providerError(429, 'rateLimitExceeded');
      return 'ok';
    },
    3,
    async milliseconds => { delays.push(milliseconds); },
  );
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1_000, 2_000]);

  for (const error of [providerError(403, 'dailyLimitExceeded'), providerError(503)]) {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => {
        calls += 1;
        throw error;
      }, 3, async () => {}),
    );
    assert.equal(calls, 1);
  }
});
