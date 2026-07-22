import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import type { AccountConfig } from '../src/config.js';
import {
  checkAuthStatus,
  type AuthHealthDependencies,
  type AuthHealthReport,
} from '../src/gmail/auth.js';
import type { StoredToken } from '../src/gmail/types.js';

const personal: AccountConfig = { alias: 'personal', email: 'ed@example.com' };
const work: AccountConfig = { alias: 'work', email: 'ed@work.example' };

class FakeHealthOAuthClient extends EventEmitter {
  credentials: StoredToken = {};
  credentialsAtRefresh: StoredToken | null = null;
  refreshCalls = 0;

  constructor(
    readonly profileEmail: string,
    private readonly refreshResult: StoredToken | Error | Promise<StoredToken>,
  ) {
    super();
  }

  setCredentials(credentials: StoredToken): void {
    this.credentials = { ...credentials };
  }

  async refreshAccessToken(): Promise<{ credentials: StoredToken }> {
    this.refreshCalls += 1;
    this.credentialsAtRefresh = { ...this.credentials };
    const refreshResult = await this.refreshResult;
    if (refreshResult instanceof Error) throw refreshResult;
    this.emit('tokens', refreshResult);
    this.credentials = { ...this.credentials, ...refreshResult };
    return { credentials: this.credentials };
  }
}

function providerError(
  status: number,
  reason?: string,
  message = 'provider request failed',
): Error {
  const error = new Error(message) as Error & {
    code: number;
    response: { status: number; data: Record<string, unknown> };
  };
  error.code = status;
  error.response = {
    status,
    data: {
      error: {
        message,
        errors: reason ? [{ reason }] : [],
      },
    },
  };
  return error;
}

function healthDependencies(options: {
  accounts?: AccountConfig[];
  tokens?: Map<string, StoredToken | null | Error>;
  clients?: FakeHealthOAuthClient[];
  writes?: Array<{ alias: string; update: StoredToken }>;
  logs?: string[];
} = {}): AuthHealthDependencies {
  const clients = options.clients ?? [
    new FakeHealthOAuthClient(personal.email, { access_token: 'fresh-access', expiry_date: 2 }),
  ];
  let clientIndex = 0;
  return {
    getAccounts: () => options.accounts ?? [personal],
    loadCredentials: () => ({ client_id: 'client-id', client_secret: 'client-secret' }),
    readToken: account => {
      const value = options.tokens?.has(account.alias)
        ? options.tokens.get(account.alias)!
        : { access_token: 'still-valid-access', refresh_token: 'super-secret-refresh' };
      if (value instanceof Error) throw value;
      return value;
    },
    writeToken: (account, update) => {
      options.writes?.push({ alias: account.alias, update });
      return update;
    },
    createOAuthClient: () => clients[clientIndex++]!,
    createGmailClient: oauthClient => ({
      users: {
        getProfile: async () => ({
          data: { emailAddress: (oauthClient as FakeHealthOAuthClient).profileEmail },
        }),
      },
    }),
    log: message => { options.logs?.push(message); },
  };
}

test('health forces refresh-token exchange and ignores a valid stored access token', async () => {
  const revoked = new FakeHealthOAuthClient(
    personal.email,
    providerError(400, 'invalid_grant', 'invalid_grant'),
  );
  const report = await checkAuthStatus(healthDependencies({ clients: [revoked] }));

  assert.equal(revoked.refreshCalls, 1);
  assert.deepEqual(revoked.credentialsAtRefresh, { refresh_token: 'super-secret-refresh' });
  assert.equal(report.accounts[0]?.category, 'reauthorization_required');
  assert.equal(report.exitCode, 1);
});

test('successful forced refresh persists before Gmail profile verification', async () => {
  const writes: Array<{ alias: string; update: StoredToken }> = [];
  const client = new FakeHealthOAuthClient(
    personal.email,
    { access_token: 'fresh-access', expiry_date: 123 },
  );
  const report = await checkAuthStatus(healthDependencies({ clients: [client], writes }));

  assert.equal(report.accounts[0]?.category, 'healthy');
  assert.equal(report.exitCode, 0);
  assert.deepEqual(writes, [{
    alias: 'personal',
    update: { access_token: 'fresh-access', expiry_date: 123 },
  }]);
});

test('health checks every account and returns a failing aggregate', async () => {
  const logs: string[] = [];
  const tokens = new Map<string, StoredToken | null | Error>([
    ['personal', null],
    ['work', { refresh_token: 'work-refresh' }],
  ]);
  const report = await checkAuthStatus(healthDependencies({
    accounts: [personal, work],
    tokens,
    clients: [new FakeHealthOAuthClient(work.email, { access_token: 'work-access' })],
    logs,
  }));

  assert.deepEqual(report.accounts.map(result => result.alias), ['personal', 'work']);
  assert.deepEqual(report.accounts.map(result => result.category), ['missing_token', 'healthy']);
  assert.equal(report.exitCode, 1);
  assert.match(logs.join('\n'), /personal/);
  assert.match(logs.join('\n'), /work/);
});

test('a hung refresh times out and remaining accounts are still checked', async () => {
  const clients = [
    new FakeHealthOAuthClient(personal.email, new Promise<StoredToken>(() => {})),
    new FakeHealthOAuthClient(work.email, { access_token: 'work-access' }),
  ];
  const report = await checkAuthStatus({
    ...healthDependencies({ accounts: [personal, work], clients }),
    requestTimeoutMs: 20,
  });

  assert.deepEqual(report.accounts.map(result => result.category), ['network', 'healthy']);
  assert.equal(clients[0]!.refreshCalls, 1);
  assert.equal(clients[1]!.refreshCalls, 1);
  assert.equal(report.exitCode, 1);
});

test('health reports a wrong account after refresh', async () => {
  const client = new FakeHealthOAuthClient(
    'someone-else@example.com',
    { access_token: 'fresh-access' },
  );
  const report = await checkAuthStatus(healthDependencies({ clients: [client] }));
  assert.equal(report.accounts[0]?.category, 'wrong_account');
  assert.equal(report.exitCode, 1);
});

test('missing, corrupt, and local permission failures remain distinct', async () => {
  const accounts = [
    personal,
    work,
    { alias: 'permission', email: 'permission@example.com' },
  ];
  const permissionError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const tokens = new Map<string, StoredToken | null | Error>([
    ['personal', null],
    ['work', new Error('Invalid token file at hidden path: malformed JSON.')],
    ['permission', permissionError],
  ]);
  const report = await checkAuthStatus(healthDependencies({ accounts, tokens, clients: [] }));

  assert.deepEqual(report.accounts.map(result => result.category), [
    'missing_token',
    'corrupt_token',
    'local_permission',
  ]);
});

test('provider categories keep scope, policy, quota, rate, transient, and network distinct', async () => {
  const cases: Array<[Error, AuthHealthReport['accounts'][number]['category']]> = [
    [providerError(403, 'insufficientPermissions'), 'insufficient_scope'],
    [providerError(403, 'domainPolicy'), 'domain_policy'],
    [providerError(403, 'dailyLimitExceeded'), 'quota'],
    [providerError(429, 'rateLimitExceeded'), 'rate_limit'],
    [providerError(503), 'transient'],
    [Object.assign(new Error('dns lookup failed'), { code: 'ENOTFOUND' }), 'network'],
  ];

  for (const [error, expectedCategory] of cases) {
    const report = await checkAuthStatus(healthDependencies({
      clients: [new FakeHealthOAuthClient(personal.email, error)],
    }));
    assert.equal(report.accounts[0]?.category, expectedCategory);
  }
});

test('health output never includes credential or provider-error contents', async () => {
  const logs: string[] = [];
  const secret = 'do-not-print-refresh-token';
  const report = await checkAuthStatus(healthDependencies({
    tokens: new Map([['personal', { refresh_token: secret }]]),
    clients: [new FakeHealthOAuthClient(
      personal.email,
      providerError(400, 'invalid_grant', `invalid_grant ${secret}`),
    )],
    logs,
  }));

  assert.equal(report.exitCode, 1);
  assert.doesNotMatch(logs.join('\n'), new RegExp(secret));
});
