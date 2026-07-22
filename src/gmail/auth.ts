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
  getTokenPath,
} from '../config.js';
import { readStoredToken, writeStoredToken } from './token-store.js';
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

interface GmailProfileClientLike {
  users: {
    getProfile(options: { userId: string }): Promise<{
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
  return new google.auth.OAuth2(
    credentials.client_id,
    credentials.client_secret,
    redirectUri,
  ) as unknown as OAuthClientLike;
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
  };
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

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as {
    code?: unknown;
    response?: { status?: unknown };
  };
  const status = candidate.code ?? candidate.response?.status;
  return typeof status === 'number' ? status : undefined;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as {
    response?: { data?: { error?: unknown } };
    message?: unknown;
  };
  const providerCode = candidate.response?.data?.error;
  if (typeof providerCode === 'string') return providerCode;
  if (typeof candidate.message === 'string' && candidate.message.includes('invalid_grant')) {
    return 'invalid_grant';
  }
  return undefined;
}

function requiresAuthorization(error: unknown): boolean {
  return errorStatus(error) === 401 || errorCode(error) === 'invalid_grant';
}

async function verifyProfile(
  account: AccountConfig,
  oauthClient: OAuthClientLike,
  createGmailClient: AuthFlowDependencies['createGmailClient'],
): Promise<void> {
  const gmail = createGmailClient!(oauthClient);
  const profile = await gmail.users.getProfile({ userId: 'me' });
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
  oauth2Client.setCredentials(token);

  // Preserve existing behavior until U3 installs durable token-event handling.
  if (token.expiry_date && token.expiry_date < Date.now() + 60_000) {
    try {
      const { credentials: refreshed } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(refreshed);
      writeStoredToken(account, refreshed as StoredToken);
    } catch (error) {
      throw new Error(
        `Token refresh failed for ${account.email}. `
        + `Re-authenticate: npm run auth -- ${account.alias} --force-consent\n`
        + `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
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

  if (!options.forceConsent && previousToken?.refresh_token) {
    const existingClient = dependencies.createOAuthClient(credentials, DEFAULT_REDIRECT_URI);
    existingClient.setCredentials(previousToken);
    try {
      await verifyProfile(account, existingClient, dependencies.createGmailClient);
      dependencies.log(`Already authenticated: ${account.email} (${account.alias})`);
      return;
    } catch (error) {
      if (!requiresAuthorization(error)) throw error;
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
      await verifyProfile(account, oauthClient, dependencies.createGmailClient);
      if (settled) return;

      const hasReturnedRefresh = typeof tokens.refresh_token === 'string'
        && tokens.refresh_token.length > 0;
      const mayUseStoredRefresh = !options.forceConsent
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

/** Legacy file-status command. U4 replaces this with live all-account health. */
export function checkAuthStatus(): void {
  const accounts = getAccounts();
  console.log('\nAccount Status:');
  console.log('─'.repeat(60));

  for (const account of accounts) {
    const tokenPath = getTokenPath(account);
    const exists = fs.existsSync(tokenPath);
    let status = 'NOT AUTHENTICATED';
    let scopeInfo = '';

    if (exists) {
      try {
        const token = readStoredToken(account);
        const expired = token?.expiry_date && token.expiry_date < Date.now();
        const hasSendScope = token?.scope?.includes('gmail.send');
        const hasComposeScope = token?.scope?.includes('gmail.compose');
        status = expired ? 'EXPIRED (will auto-refresh)' : 'OK';
        scopeInfo = hasSendScope && hasComposeScope
          ? ' [send+compose]'
          : hasSendScope ? ' [send only]' : ' [read/modify only]';
      } catch {
        status = 'TOKEN CORRUPT';
      }
    }

    const icon = exists && status !== 'TOKEN CORRUPT' ? '+' : '-';
    console.log(
      `  ${icon} ${account.alias.padEnd(10)} ${account.email.padEnd(30)} ${status}${scopeInfo}`,
    );
  }
  console.log('');
}
