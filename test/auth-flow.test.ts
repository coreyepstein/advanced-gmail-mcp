import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  authenticateAccount,
  loadCredentialsFromPath,
  type AuthFlowDependencies,
  type OAuthClientLike,
} from '../src/gmail/auth.js';
import type { AccountConfig } from '../src/config.js';
import type { StoredToken } from '../src/gmail/types.js';

const account: AccountConfig = { alias: 'welgo', email: 'ed@welgo.space' };

interface HarnessOptions {
  existingToken?: StoredToken | null;
  returnedTokens?: StoredToken;
  storedProfileError?: Error & { code?: number };
  profileEmail?: string;
  timeoutMs?: number;
  tokenExchange?: () => Promise<{ tokens: StoredToken }>;
}

function createHarness(options: HarnessOptions = {}) {
  const logs: string[] = [];
  const writes: StoredToken[] = [];
  const authOptions: Array<Record<string, unknown>> = [];
  const tokenOptions: Array<{ code: string; codeVerifier?: string }> = [];
  const signalSource = new EventEmitter();
  let profileCalls = 0;
  let dynamicRedirect = '';
  let callbackServer: http.Server | null = null;

  const oauthClient: OAuthClientLike = {
    credentials: {},
    setCredentials(credentials) {
      this.credentials = credentials;
    },
    async generateCodeVerifierAsync() {
      return { codeVerifier: 'verifier-value', codeChallenge: 'challenge-value' };
    },
    generateAuthUrl(auth) {
      authOptions.push(auth as Record<string, unknown>);
      const url = new URL('https://accounts.example.test/auth');
      for (const [key, value] of Object.entries(auth)) {
        if (value !== undefined && !Array.isArray(value)) url.searchParams.set(key, String(value));
      }
      url.searchParams.set('redirect_uri', dynamicRedirect);
      return url.toString();
    },
    async getToken(input) {
      tokenOptions.push(input);
      if (options.tokenExchange) return options.tokenExchange();
      return {
        tokens: options.returnedTokens ?? {
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expiry_date: Date.now() + 3_600_000,
        },
      };
    },
  };

  const deps: AuthFlowDependencies = {
    loadCredentials: () => ({ client_id: 'client', client_secret: 'secret' }),
    createOAuthClient: (_credentials, redirectUri) => {
      dynamicRedirect = redirectUri;
      return oauthClient;
    },
    createGmailClient: () => ({
      users: {
        getProfile: async () => {
          profileCalls += 1;
          if (profileCalls === 1 && options.existingToken && options.storedProfileError) {
            throw options.storedProfileError;
          }
          return { data: { emailAddress: options.profileEmail ?? account.email } };
        },
      },
    }),
    createServer: listener => {
      callbackServer = http.createServer(listener);
      return callbackServer;
    },
    readToken: () => options.existingToken ?? null,
    writeToken: (_account, update) => {
      writes.push(update);
      return update;
    },
    log: message => logs.push(message),
    timeoutMs: options.timeoutMs ?? 2_000,
    signalSource,
  };

  return {
    deps,
    logs,
    writes,
    authOptions,
    tokenOptions,
    signalSource,
    get callbackServer() { return callbackServer; },
    get profileCalls() { return profileCalls; },
  };
}

async function waitForAuthUrl(logs: string[]): Promise<URL> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const raw = logs.find(line => line.startsWith('https://accounts.example.test/'));
    if (raw) return new URL(raw);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Authorization URL was not logged.');
}

async function request(url: URL): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    }).on('error', reject);
  });
}

function callbackFrom(authUrl: URL, params: Record<string, string>, pathname = '/oauth2callback') {
  const callback = new URL(authUrl.searchParams.get('redirect_uri')!);
  callback.pathname = pathname;
  for (const [key, value] of Object.entries(params)) callback.searchParams.set(key, value);
  return callback;
}

test('credentials are owner-only before being read', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-creds-'));
  const file = path.join(dir, 'credentials.json');
  fs.writeFileSync(file, JSON.stringify({ installed: { client_id: 'id', client_secret: 'secret' } }), {
    mode: 0o644,
  });
  try {
    assert.equal(loadCredentialsFromPath(file).client_id, 'id');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('healthy stored token verifies profile and opens no callback server', async () => {
  const harness = createHarness({
    existingToken: { access_token: 'old', refresh_token: 'durable' },
  });

  await authenticateAccount(account, {}, harness.deps);

  assert.equal(harness.profileCalls, 1);
  assert.equal(harness.authOptions.length, 0);
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.logs.some(line => line.startsWith('https://')), false);
});

test('normal missing-token flow omits consent and binds state plus PKCE', async () => {
  const harness = createHarness();
  const completion = authenticateAccount(account, {}, harness.deps);
  const authUrl = await waitForAuthUrl(harness.logs);
  const state = authUrl.searchParams.get('state')!;
  const callback = callbackFrom(authUrl, { code: 'authorization-code', state });
  const response = await request(callback);
  await completion;

  assert.equal(response.status, 200);
  assert.equal(response.body.includes(account.email), false);
  assert.equal(harness.authOptions[0].prompt, undefined);
  assert.equal(harness.authOptions[0].code_challenge, 'challenge-value');
  assert.equal(harness.authOptions[0].code_challenge_method, 'S256');
  assert.deepEqual(harness.tokenOptions, [{ code: 'authorization-code', codeVerifier: 'verifier-value' }]);
  assert.equal(harness.writes.length, 1);
});

test('forced recovery adds consent', async () => {
  const harness = createHarness();
  const completion = authenticateAccount(account, { forceConsent: true }, harness.deps);
  const authUrl = await waitForAuthUrl(harness.logs);
  const response = await request(callbackFrom(authUrl, {
    code: 'authorization-code',
    state: authUrl.searchParams.get('state')!,
  }));
  await completion;
  assert.equal(response.status, 200);
  assert.equal(harness.authOptions[0].prompt, 'consent');
});

test('missing refresh token without stored fallback saves nothing', async () => {
  const harness = createHarness({ returnedTokens: { access_token: 'short-lived' } });
  const completion = authenticateAccount(account, {}, harness.deps);
  const rejection = assert.rejects(
    completion,
    /npm run auth -- welgo --force-consent/,
  );
  const authUrl = await waitForAuthUrl(harness.logs);
  await request(callbackFrom(authUrl, {
    code: 'authorization-code',
    state: authUrl.searchParams.get('state')!,
  }));
  await rejection;
  assert.equal(harness.writes.length, 0);
});

test('revoked stored refresh token is never reused as authorization fallback', async () => {
  const storedError = Object.assign(new Error('invalid_grant'), { code: 401 });
  const harness = createHarness({
    existingToken: { access_token: 'old-access', refresh_token: 'revoked-refresh' },
    storedProfileError: storedError,
    returnedTokens: { access_token: 'new-access-only' },
  });
  const completion = authenticateAccount(account, {}, harness.deps);
  const rejection = assert.rejects(completion, /npm run auth -- welgo --force-consent/);
  const authUrl = await waitForAuthUrl(harness.logs);
  await request(callbackFrom(authUrl, {
    code: 'authorization-code',
    state: authUrl.searchParams.get('state')!,
  }));

  await rejection;
  assert.equal(harness.writes.length, 0);
});

for (const scenario of [
  { name: 'denial', params: (state: string) => ({ error: 'access_denied', state }), pattern: /denied/i },
  { name: 'missing code', params: (state: string) => ({ state }), pattern: /missing authorization code/i },
  { name: 'state mismatch', params: () => ({ code: 'authorization-code', state: 'wrong' }), pattern: /state mismatch/i },
]) {
  test(`${scenario.name} closes flow without token mutation`, async () => {
    const harness = createHarness();
    const completion = authenticateAccount(account, {}, harness.deps);
    const rejection = assert.rejects(completion, scenario.pattern);
    const authUrl = await waitForAuthUrl(harness.logs);
    const response = await request(callbackFrom(
      authUrl,
      scenario.params(authUrl.searchParams.get('state')!),
    ));
    assert.equal(response.status, 400);
    await rejection;
    assert.equal(harness.writes.length, 0);
  });
}

test('wrong callback path is rejected but valid callback can still finish', async () => {
  const harness = createHarness();
  const completion = authenticateAccount(account, {}, harness.deps);
  const authUrl = await waitForAuthUrl(harness.logs);
  const state = authUrl.searchParams.get('state')!;
  const wrong = await request(callbackFrom(authUrl, { code: 'ignored', state }, '/wrong'));
  assert.equal(wrong.status, 404);
  const valid = await request(callbackFrom(authUrl, { code: 'good', state }));
  assert.equal(valid.status, 200);
  await completion;
  assert.equal(harness.tokenOptions.length, 1);
});

test('wrong Google account preserves existing token', async () => {
  const harness = createHarness({ profileEmail: 'wrong@gmail.com' });
  const completion = authenticateAccount(account, {}, harness.deps);
  const rejection = assert.rejects(completion, /does not match configured account/i);
  const authUrl = await waitForAuthUrl(harness.logs);
  await request(callbackFrom(authUrl, {
    code: 'authorization-code',
    state: authUrl.searchParams.get('state')!,
  }));
  await rejection;
  assert.equal(harness.writes.length, 0);
});

test('timeout and Ctrl-C terminate without token mutation', async t => {
  await t.test('timeout', async () => {
    const harness = createHarness({ timeoutMs: 25 });
    await assert.rejects(authenticateAccount(account, {}, harness.deps), /timed out/i);
    assert.equal(harness.writes.length, 0);
  });

  await t.test('Ctrl-C', async () => {
    const harness = createHarness();
    const completion = authenticateAccount(account, {}, harness.deps);
    await waitForAuthUrl(harness.logs);
    harness.signalSource.emit('SIGINT');
    await assert.rejects(completion, /interrupted/i);
    assert.equal(harness.writes.length, 0);
  });
});

test('timeout terminates an in-flight token exchange', async () => {
  const harness = createHarness({
    timeoutMs: 25,
    tokenExchange: () => new Promise(() => {}),
  });
  const completion = authenticateAccount(account, {}, harness.deps);
  const authUrl = await waitForAuthUrl(harness.logs);
  const callback = request(callbackFrom(authUrl, {
    code: 'authorization-code',
    state: authUrl.searchParams.get('state')!,
  })).catch(() => ({ status: 0, body: '' }));

  await assert.rejects(completion, /timed out/i);
  await callback;
  assert.equal(harness.writes.length, 0);
});

test('callback server errors reject once and save no token', async () => {
  const harness = createHarness();
  const completion = authenticateAccount(account, {}, harness.deps);
  await waitForAuthUrl(harness.logs);
  const rejection = assert.rejects(completion, /callback server failed/i);

  harness.callbackServer!.emit('error', new Error('simulated listener failure'));

  await rejection;
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.signalSource.listenerCount('SIGINT'), 0);
});
