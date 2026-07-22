import { google, type Auth } from 'googleapis';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { URL } from 'node:url';
import {
  type AccountConfig,
  getAccounts,
  getCredentialsPath,
} from '../config.js';
import { readStoredToken, writeStoredToken } from './token-store.js';
import { classifyGmailError, systemErrorCode } from './errors.js';
import type { StoredToken } from './types.js';

/** Preserve the existing grant request during this stability repair. */
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
];

const CALLBACK_PATH = '/oauth2callback';
const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_REDIRECT_URI = `http://${LOOPBACK_HOST}${CALLBACK_PATH}`;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const PRIVATE_FILE_MODE = 0o600;

export interface OAuthClientCredentials {
  client_id: string;
  client_secret?: string;
  redirect_uris?: string[];
}

export interface OAuthClientLike {
  credentials: StoredToken;
  setCredentials(credentials: StoredToken): void;
  generateCodeVerifierAsync(): Promise<{ codeVerifier: string; codeChallenge?: string }>;
  generateAuthUrl(options: Record<string, unknown>): string;
  getToken(options: {
    code: string;
    codeVerifier?: string;
  }): Promise<{ tokens: StoredToken }>;
}

export interface TokenPersistenceClientLike {
  on(event: 'tokens', listener: (tokens: StoredToken) => void): unknown;
  setCredentials(credentials: StoredToken): void;
}

export interface HealthOAuthClientLike extends TokenPersistenceClientLike {
  credentials: StoredToken;
  refreshAccessToken(): Promise<{ credentials: StoredToken }>;
}

export type TokenWriter = (
  account: AccountConfig,
  update: StoredToken,
) => StoredToken;

interface GmailProfileClientLike {
  users: {
    getProfile(options: { userId: string }, requestOptions?: { timeout?: number }): Promise<{
      data: { emailAddress?: string | null };
    }>;
  };
}

interface SignalSourceLike {
  once(event: 'SIGINT', listener: () => void): unknown;
  off(event: 'SIGINT', listener: () => void): unknown;
}

export interface AuthFlowOptions {
  forceConsent?: boolean;
}

export interface AuthFlowDependencies {
  loadCredentials?: () => OAuthClientCredentials;
  createOAuthClient?: (
    credentials: OAuthClientCredentials,
    redirectUri: string,
  ) => OAuthClientLike;
  createGmailClient?: (oauthClient: OAuthClientLike) => GmailProfileClientLike;
  createServer?: typeof http.createServer;
  readToken?: (account: AccountConfig) => StoredToken | null;
  writeToken?: (account: AccountConfig, update: StoredToken) => StoredToken;
  log?: (message: string) => void;
  timeoutMs?: number;
  signalSource?: SignalSourceLike;
  createState?: () => string;
  requestTimeoutMs?: number;
}

export type AuthHealthCategory =
  | 'healthy'
  | 'missing_token'
  | 'corrupt_token'
  | 'reauthorization_required'
  | 'insufficient_scope'
  | 'domain_policy'
  | 'quota'
  | 'rate_limit'
  | 'transient'
  | 'network'
  | 'wrong_account'
  | 'local_permission'
  | 'forbidden'
  | 'unknown';

export interface AccountAuthHealth {
  alias: string;
  email: string;
  category: AuthHealthCategory;
  healthy: boolean;
  message: string;
}

export interface AuthHealthReport {
  accounts: AccountAuthHealth[];
  healthy: boolean;
  exitCode: 0 | 1;
}

export interface AuthHealthEnvelope extends AuthHealthReport {
  schemaVersion: 1;
  error?: {
    category: 'configuration_error';
    message: string;
  };
}

export function createAuthHealthEnvelope(report: AuthHealthReport): AuthHealthEnvelope {
  return { schemaVersion: 1, ...report };
}

export function createAuthHealthFailure(error: unknown): AuthHealthEnvelope {
  const message = error instanceof Error ? error.message : 'Gmail health setup failed.';
  return {
    schemaVersion: 1,
    accounts: [],
    healthy: false,
    exitCode: 1,
    error: { category: 'configuration_error', message },
  };
}

export interface AuthHealthDependencies {
  getAccounts?: () => AccountConfig[];
  loadCredentials?: () => OAuthClientCredentials;
  createOAuthClient?: (
    credentials: OAuthClientCredentials,
    redirectUri: string,
  ) => HealthOAuthClientLike;
  createGmailClient?: (oauthClient: HealthOAuthClientLike) => GmailProfileClientLike;
  readToken?: (account: AccountConfig) => StoredToken | null;
  writeToken?: TokenWriter;
  log?: (message: string) => void;
  requestTimeoutMs?: number;
}

function isPosixModeSupported(): boolean {
  return process.platform !== 'win32';
}

/** Load OAuth client credentials only after repairing owner-only permissions. */
export function loadCredentialsFromPath(credentialPath: string): OAuthClientCredentials {
  if (!fs.existsSync(credentialPath)) {
    throw new Error(
      `credentials.json not found at ${credentialPath}. Download it from Google Cloud Console.`,
    );
  }

  const pathInfo = fs.lstatSync(credentialPath);
  const readablePath = pathInfo.isSymbolicLink()
    ? fs.realpathSync(credentialPath)
    : credentialPath;
  if (!fs.statSync(readablePath).isFile()) {
    throw new Error(`OAuth credential path is not a regular file: ${credentialPath}.`);
  }
  if (isPosixModeSupported()) fs.chmodSync(readablePath, PRIVATE_FILE_MODE);

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(readablePath, 'utf8')) as unknown;
  } catch {
    throw new Error(`Invalid OAuth credential JSON at ${credentialPath}.`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Invalid OAuth credential JSON at ${credentialPath}.`);
  }
  const container = parsed as Record<string, unknown>;
  const selected = container.installed ?? container.web;
  if (typeof selected !== 'object' || selected === null) {
    throw new Error(`OAuth credentials at ${credentialPath} lack an installed or web client.`);
  }
  const credentials = selected as Record<string, unknown>;
  if (typeof credentials.client_id !== 'string'
      || (credentials.client_secret !== undefined
        && typeof credentials.client_secret !== 'string')) {
    throw new Error(`OAuth credentials at ${credentialPath} are incomplete.`);
  }

  return credentials as unknown as OAuthClientCredentials;
}

export function loadCredentials(): OAuthClientCredentials {
  return loadCredentialsFromPath(getCredentialsPath());
}

function defaultCreateOAuthClient(
  credentials: OAuthClientCredentials,
  redirectUri: string,
): OAuthClientLike {
  return new google.auth.OAuth2({
    clientId: credentials.client_id,
    clientSecret: credentials.client_secret,
    redirectUri,
    transporterOptions: { timeout: DEFAULT_REQUEST_TIMEOUT_MS },
  }) as unknown as OAuthClientLike;
}

function defaultCreateGmailClient(oauthClient: OAuthClientLike): GmailProfileClientLike {
  return google.gmail({
    version: 'v1',
    auth: oauthClient as unknown as Auth.OAuth2Client,
  }) as unknown as GmailProfileClientLike;
}

function getDependencies(overrides: AuthFlowDependencies): Required<AuthFlowDependencies> {
  return {
    loadCredentials: overrides.loadCredentials ?? loadCredentials,
    createOAuthClient: overrides.createOAuthClient ?? defaultCreateOAuthClient,
    createGmailClient: overrides.createGmailClient ?? defaultCreateGmailClient,
    createServer: overrides.createServer ?? http.createServer,
    readToken: overrides.readToken ?? readStoredToken,
    writeToken: overrides.writeToken ?? writeStoredToken,
    log: overrides.log ?? console.log,
    timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signalSource: overrides.signalSource ?? process,
    createState: overrides.createState ?? (() => randomBytes(32).toString('base64url')),
    requestTimeoutMs: overrides.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

/**
 * Attach durable refresh persistence before credentials can trigger a request.
 * Node event listeners run synchronously, so a storage failure propagates to
 * the refresh caller instead of allowing Gmail use with an unpersisted token.
 */
export function configureAuthClient(
  account: AccountConfig,
  oauth2Client: TokenPersistenceClientLike,
  token: StoredToken,
  writeToken: TokenWriter = writeStoredToken,
): void {
  oauth2Client.on('tokens', tokens => {
    writeToken(account, tokens);
  });
  oauth2Client.setCredentials(token);
}

function sameEmail(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function stateMatches(expected: string, actual: string | null): boolean {
  if (actual === null) return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const actualBytes = Buffer.from(actual, 'utf8');
  return expectedBytes.length === actualBytes.length
    && timingSafeEqual(expectedBytes, actualBytes);
}

function requiresAuthorization(error: unknown): boolean {
  return classifyGmailError(error).category === 'reauthorization_required';
}

async function verifyProfile(
  account: AccountConfig,
  oauthClient: OAuthClientLike,
  createGmailClient: AuthFlowDependencies['createGmailClient'],
  requestTimeoutMs: number,
): Promise<void> {
  const gmail = createGmailClient!(oauthClient);
  const profile = await gmail.users.getProfile({ userId: 'me' }, { timeout: requestTimeoutMs });
  const actualEmail = profile.data.emailAddress;
  if (typeof actualEmail !== 'string' || !sameEmail(actualEmail, account.email)) {
    throw new Error(
      `Authenticated Gmail account does not match configured account ${account.email}. `
      + 'No token was saved.',
    );
  }
}

function writeStaticHtml(
  response: http.ServerResponse,
  status: number,
  title: string,
  message: string,
): void {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    Connection: 'close',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'Content-Type': 'text/html; charset=utf-8',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(
    '<!doctype html><html><head><meta charset="utf-8">'
    + `<title>${title}</title></head><body><h1>${title}</h1><p>${message}</p></body></html>`,
  );
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  const closing = new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  // server.close() stops new requests but waits for existing sockets. A token
  // exchange can hang, so terminate callback sockets after beginning shutdown.
  server.closeAllConnections?.();
  await closing;
}

async function listenOnLoopback(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(0, LOOPBACK_HOST);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('OAuth callback server did not expose a loopback port.');
  }
  return address.port;
}

/**
 * Get an authenticated OAuth client for normal MCP use.
 * U3 owns automatic token-event persistence and runtime error mapping.
 */
export async function getAuthClient(account: AccountConfig): Promise<Auth.OAuth2Client> {
  const credentials = loadCredentials();
  const oauth2Client = new google.auth.OAuth2(
    credentials.client_id,
    credentials.client_secret,
    DEFAULT_REDIRECT_URI,
  );
  const token = readStoredToken(account);
  if (!token) {
    throw new Error(
      `No token for ${account.email}. Run: npm run auth -- ${account.alias}`,
    );
  }
  configureAuthClient(
    account,
    oauth2Client as unknown as TokenPersistenceClientLike,
    token,
  );
  return oauth2Client;
}

/** Hardened installed-app OAuth flow for one account. */
export async function authenticateAccount(
  account: AccountConfig,
  options: AuthFlowOptions = {},
  dependencyOverrides: AuthFlowDependencies = {},
): Promise<void> {
  const dependencies = getDependencies(dependencyOverrides);
  const credentials = dependencies.loadCredentials();
  const previousToken = dependencies.readToken(account);
  let previousRefreshIsUsable = true;

  if (!options.forceConsent && previousToken?.refresh_token) {
    const existingClient = dependencies.createOAuthClient(credentials, DEFAULT_REDIRECT_URI);
    existingClient.setCredentials(previousToken);
    try {
      await verifyProfile(
        account,
        existingClient,
        dependencies.createGmailClient,
        dependencies.requestTimeoutMs,
      );
      dependencies.log(`Already authenticated: ${account.email} (${account.alias})`);
      return;
    } catch (error) {
      if (!requiresAuthorization(error)) throw error;
      previousRefreshIsUsable = false;
    }
  }

  let oauthClient: OAuthClientLike | null = null;
  let expectedState = '';
  let codeVerifier = '';
  let settled = false;
  let processingCallback = false;
  let timeout: NodeJS.Timeout | null = null;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;

  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const server = dependencies.createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`);
    if (requestUrl.pathname !== CALLBACK_PATH) {
      writeStaticHtml(response, 404, 'Not found', 'This is not the OAuth callback path.');
      return;
    }
    if (settled || processingCallback) {
      writeStaticHtml(response, 409, 'Already handled', 'This authorization was already handled.');
      return;
    }
    processingCallback = true;

    try {
      const actualState = requestUrl.searchParams.get('state');
      if (!stateMatches(expectedState, actualState)) {
        throw new Error('OAuth state mismatch. No token was saved.');
      }

      const providerError = requestUrl.searchParams.get('error');
      if (providerError) {
        if (providerError === 'access_denied') {
          throw new Error('Google authorization was denied. No token was saved.');
        }
        throw new Error('Google authorization failed. No token was saved.');
      }

      const code = requestUrl.searchParams.get('code');
      if (!code) throw new Error('Missing authorization code. No token was saved.');
      if (!oauthClient) throw new Error('OAuth client was not initialized.');

      const { tokens } = await oauthClient.getToken({ code, codeVerifier });
      if (settled) return;
      oauthClient.setCredentials(tokens);
      await verifyProfile(
        account,
        oauthClient,
        dependencies.createGmailClient,
        dependencies.requestTimeoutMs,
      );
      if (settled) return;

      const hasReturnedRefresh = typeof tokens.refresh_token === 'string'
        && tokens.refresh_token.length > 0;
      const mayUseStoredRefresh = !options.forceConsent
        && previousRefreshIsUsable
        && typeof previousToken?.refresh_token === 'string'
        && previousToken.refresh_token.length > 0;
      if (!hasReturnedRefresh && !mayUseStoredRefresh) {
        throw new Error(
          `Google did not return a refresh token. Run: npm run auth -- ${account.alias} --force-consent`,
        );
      }

      dependencies.writeToken(account, tokens);
      writeStaticHtml(response, 200, 'Authorization complete', 'You can close this window.');
      dependencies.log(`Token saved for ${account.email}`);
      await finalize();
    } catch (error) {
      if (!response.headersSent) {
        writeStaticHtml(response, 400, 'Authorization failed', 'No token was saved.');
      }
      await finalize(error instanceof Error ? error : new Error(String(error)));
    }
  });

  let finalization: Promise<void> | null = null;
  const onInterrupt = () => {
    void finalize(new Error('Authorization interrupted. No token was saved.'));
  };
  const onServerError = (error: Error) => {
    void finalize(new Error(`OAuth callback server failed: ${error.message}`));
  };

  function finalize(error?: Error): Promise<void> {
    if (finalization) return finalization;
    settled = true;
    finalization = (async () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      dependencies.signalSource.off('SIGINT', onInterrupt);
      server.off('error', onServerError);
      try {
        await closeServer(server);
      } catch (closeError) {
        if (!error) {
          error = closeError instanceof Error ? closeError : new Error(String(closeError));
        }
      }
      if (error) rejectCompletion(error);
      else resolveCompletion();
    })();
    return finalization;
  }

  dependencies.signalSource.once('SIGINT', onInterrupt);
  try {
    const port = await listenOnLoopback(server);
    server.on('error', onServerError);
    const redirectUri = `http://${LOOPBACK_HOST}:${port}${CALLBACK_PATH}`;
    oauthClient = dependencies.createOAuthClient(credentials, redirectUri);
    const pkce = await oauthClient.generateCodeVerifierAsync();
    if (!pkce.codeChallenge) throw new Error('OAuth PKCE challenge generation failed.');
    codeVerifier = pkce.codeVerifier;
    expectedState = dependencies.createState();
    if (!expectedState) throw new Error('OAuth state generation failed.');

    const authUrl = oauthClient.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      login_hint: account.email,
      state: expectedState,
      code_challenge: pkce.codeChallenge,
      code_challenge_method: 'S256',
      ...(options.forceConsent ? { prompt: 'consent' } : {}),
    });
    dependencies.log(`Authenticating: ${account.email} (${account.alias})`);
    dependencies.log(authUrl);
    dependencies.log(`Waiting for OAuth callback on ${redirectUri}`);

    timeout = setTimeout(() => {
      void finalize(new Error('Authorization timed out. No token was saved.'));
    }, dependencies.timeoutMs);
    timeout.unref();
  } catch (error) {
    await finalize(error instanceof Error ? error : new Error(String(error)));
  }

  return completion;
}

function defaultCreateHealthOAuthClient(
  credentials: OAuthClientCredentials,
  redirectUri: string,
): HealthOAuthClientLike {
  return new google.auth.OAuth2({
    clientId: credentials.client_id,
    clientSecret: credentials.client_secret,
    redirectUri,
    transporterOptions: { timeout: DEFAULT_REQUEST_TIMEOUT_MS },
  }) as unknown as HealthOAuthClientLike;
}

function defaultCreateHealthGmailClient(
  oauthClient: HealthOAuthClientLike,
): GmailProfileClientLike {
  return google.gmail({
    version: 'v1',
    auth: oauthClient as unknown as Auth.OAuth2Client,
  }) as unknown as GmailProfileClientLike;
}

function classifyHealthError(error: unknown): AuthHealthCategory {
  const code = systemErrorCode(error);
  if (code === 'EACCES' || code === 'EPERM') {
    return 'local_permission';
  }
  if (/invalid token file|invalid oauth credential json/i.test(
    error instanceof Error ? error.message : '',
  )) {
    return 'corrupt_token';
  }
  return classifyGmailError(error).category;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(Object.assign(new Error('Google request timed out.'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    timeout.unref();
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function healthMessage(category: AuthHealthCategory, alias: string): string {
  switch (category) {
    case 'healthy': return 'Gmail refresh and profile access verified.';
    case 'missing_token': return 'No stored token was found.';
    case 'corrupt_token': return 'The stored token or OAuth credential file is invalid.';
    case 'reauthorization_required':
      return `Google requires recovery. Run: npm run auth -- ${alias} --force-consent`;
    case 'insufficient_scope': return 'The grant does not include the required Gmail scope.';
    case 'domain_policy': return 'A Google Workspace policy blocked Gmail access.';
    case 'quota': return 'A Gmail quota blocked the check.';
    case 'rate_limit': return 'Gmail temporarily rate-limited the check.';
    case 'transient': return 'Google returned a temporary service failure.';
    case 'network': return 'The check could not reach Google.';
    case 'wrong_account': return 'Google returned a different Gmail account.';
    case 'local_permission': return 'Local file permissions blocked the check.';
    case 'forbidden': return 'Google denied Gmail access without a recovery signal.';
    default: return 'The Gmail check failed for an unclassified reason.';
  }
}

function resultFor(
  account: AccountConfig,
  category: AuthHealthCategory,
): AccountAuthHealth {
  return {
    alias: account.alias,
    email: account.email,
    category,
    healthy: category === 'healthy',
    message: healthMessage(category, account.alias),
  };
}

async function checkOneAccount(
  account: AccountConfig,
  dependencies: Required<AuthHealthDependencies>,
): Promise<AccountAuthHealth> {
  try {
    const token = dependencies.readToken(account);
    if (!token) return resultFor(account, 'missing_token');
    if (typeof token.refresh_token !== 'string' || token.refresh_token.length === 0) {
      return resultFor(account, 'reauthorization_required');
    }

    const credentials = dependencies.loadCredentials();
    const oauthClient = dependencies.createOAuthClient(credentials, DEFAULT_REDIRECT_URI);
    configureAuthClient(
      account,
      oauthClient,
      { refresh_token: token.refresh_token },
      dependencies.writeToken,
    );

    // Do not use getAccessToken(): it may accept a cached access token. This
    // explicit exchange proves that the durable refresh token still works.
    await withTimeout(oauthClient.refreshAccessToken(), dependencies.requestTimeoutMs);
    const gmail = dependencies.createGmailClient(oauthClient);
    const profile = await withTimeout(
      gmail.users.getProfile({ userId: 'me' }, { timeout: dependencies.requestTimeoutMs }),
      dependencies.requestTimeoutMs,
    );
    const actualEmail = profile.data.emailAddress;
    if (typeof actualEmail !== 'string' || !sameEmail(actualEmail, account.email)) {
      return resultFor(account, 'wrong_account');
    }
    return resultFor(account, 'healthy');
  } catch (error) {
    return resultFor(account, classifyHealthError(error));
  }
}

/** Force-refresh and call Gmail for every configured account without a browser. */
export async function checkAuthStatus(
  dependencyOverrides: AuthHealthDependencies = {},
): Promise<AuthHealthReport> {
  const dependencies: Required<AuthHealthDependencies> = {
    getAccounts: dependencyOverrides.getAccounts ?? getAccounts,
    loadCredentials: dependencyOverrides.loadCredentials ?? loadCredentials,
    createOAuthClient: dependencyOverrides.createOAuthClient ?? defaultCreateHealthOAuthClient,
    createGmailClient: dependencyOverrides.createGmailClient ?? defaultCreateHealthGmailClient,
    readToken: dependencyOverrides.readToken ?? readStoredToken,
    writeToken: dependencyOverrides.writeToken ?? writeStoredToken,
    log: dependencyOverrides.log ?? console.log,
    requestTimeoutMs: dependencyOverrides.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  };
  const accounts = dependencies.getAccounts();
  const results: AccountAuthHealth[] = [];
  let cachedCredentials: OAuthClientCredentials | undefined;
  let credentialFailure: { error: unknown } | undefined;
  let credentialsLoaded = false;
  const loadCredentialsOnce = (): OAuthClientCredentials => {
    if (!credentialsLoaded) {
      credentialsLoaded = true;
      try {
        cachedCredentials = dependencies.loadCredentials();
      } catch (error) {
        credentialFailure = { error };
      }
    }
    if (credentialFailure) throw credentialFailure.error;
    return cachedCredentials!;
  };
  const checkDependencies: Required<AuthHealthDependencies> = {
    ...dependencies,
    loadCredentials: loadCredentialsOnce,
  };

  dependencies.log('Account Status:');
  for (const account of accounts) {
    const result = await checkOneAccount(account, checkDependencies);
    results.push(result);
    dependencies.log(
      `${result.healthy ? '+' : '-'} ${result.alias} ${result.email} `
      + `${result.category.toUpperCase()}: ${result.message}`,
    );
  }

  const healthy = results.every(result => result.healthy);
  dependencies.log(`Summary: ${results.filter(result => result.healthy).length}/${results.length} healthy.`);
  return { accounts: results, healthy, exitCode: healthy ? 0 : 1 };
}
