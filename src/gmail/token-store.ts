import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { type AccountConfig, getTokenPath } from '../config.js';
import type { StoredToken } from './types.js';

const TOKEN_DIRECTORY_MODE = 0o700;
const TOKEN_FILE_MODE = 0o600;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_STALE_LOCK_MS = 30_000;
const LOCK_OWNER_FILE = 'owner.json';
const LOCK_RECOVERY_FILE = 'recovery.json';

interface LockOwner {
  id: string;
  pid: number;
  hostname: string;
}

interface StaleLockEvidence {
  device: number;
  inode: number;
  ownerId: string | null;
}

export interface TokenStoreOptions {
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  staleLockMs?: number;
  replaceFile?: (temporaryPath: string, tokenPath: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateStoredToken(value: unknown, tokenPath: string): StoredToken {
  if (!isRecord(value)) {
    throw new Error(`Invalid token file at ${tokenPath}: expected a JSON object.`);
  }

  const stringOrNullFields = ['access_token', 'refresh_token', 'token_type'] as const;
  for (const field of stringOrNullFields) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && fieldValue !== null && typeof fieldValue !== 'string') {
      throw new Error(`Invalid token file at ${tokenPath}: invalid ${field}.`);
    }
  }
  if (value.scope !== undefined && typeof value.scope !== 'string') {
    throw new Error(`Invalid token file at ${tokenPath}: invalid scope.`);
  }
  if (value.expiry_date !== undefined
      && value.expiry_date !== null
      && typeof value.expiry_date !== 'number') {
    throw new Error(`Invalid token file at ${tokenPath}: invalid expiry_date.`);
  }

  return { ...value } as StoredToken;
}

function isPosixModeSupported(): boolean {
  return process.platform !== 'win32';
}

function repairMode(targetPath: string, mode: number): void {
  if (!isPosixModeSupported()) return;
  fs.chmodSync(targetPath, mode);
}

function ensurePrivateTokenDirectory(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true, mode: TOKEN_DIRECTORY_MODE });
  const info = fs.lstatSync(directoryPath);
  if (info.isSymbolicLink()) {
    const resolvedDirectory = fs.realpathSync(directoryPath);
    if (!fs.statSync(resolvedDirectory).isDirectory()) {
      throw new Error(`Unsafe token directory at ${directoryPath}.`);
    }
    repairMode(resolvedDirectory, TOKEN_DIRECTORY_MODE);
    return;
  }
  if (!info.isDirectory()) {
    throw new Error(`Unsafe token directory at ${directoryPath}.`);
  }
  repairMode(directoryPath, TOKEN_DIRECTORY_MODE);
}

function assertRegularTokenFile(tokenPath: string): void {
  const info = fs.lstatSync(tokenPath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Unsafe token file at ${tokenPath}.`);
  }
}

/** Read a token file without ever including its contents in an error. */
export function readStoredTokenFile(tokenPath: string): StoredToken | null {
  ensurePrivateTokenDirectory(path.dirname(tokenPath));
  try {
    assertRegularTokenFile(tokenPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  repairMode(tokenPath, TOKEN_FILE_MODE);

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(tokenPath, 'utf8')) as unknown;
  } catch {
    throw new Error(`Invalid token file at ${tokenPath}: malformed JSON.`);
  }
  return validateStoredToken(parsed, tokenPath);
}

export function getTokenLockPath(tokenPath: string): string {
  return `${tokenPath}.lock`;
}

function sleepSync(milliseconds: number): void {
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitArray, 0, 0, Math.max(1, milliseconds));
}

function readLockOwner(lockPath: string): LockOwner | null {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(lockPath, LOCK_OWNER_FILE), 'utf8'),
    );
    if (!isRecord(parsed)
        || typeof parsed.id !== 'string'
        || typeof parsed.pid !== 'number'
        || typeof parsed.hostname !== 'string') {
      return null;
    }
    return parsed as unknown as LockOwner;
  } catch {
    return null;
  }
}

function isLocalProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    return true;
  }
}

function getStaleLockEvidence(
  lockPath: string,
  staleLockMs: number,
): StaleLockEvidence | null {
  let info: fs.Stats;
  try {
    info = fs.lstatSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Unsafe token lock at ${lockPath}.`);
  }
  if (Date.now() - info.mtimeMs <= staleLockMs) return null;

  const owner = readLockOwner(lockPath);
  if (!owner) {
    return { device: info.dev, inode: info.ino, ownerId: null };
  }
  if (owner.hostname !== os.hostname()) {
    return null;
  }
  if (isLocalProcessAlive(owner.pid)) return null;
  return { device: info.dev, inode: info.ino, ownerId: owner.id };
}

function recoverStaleLock(lockPath: string, evidence: StaleLockEvidence): boolean {
  const claimPath = path.join(lockPath, LOCK_RECOVERY_FILE);
  try {
    fs.writeFileSync(claimPath, `${process.pid}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: TOKEN_FILE_MODE,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOENT') return false;
    throw error;
  }

  const quarantinePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    const current = fs.lstatSync(lockPath);
    const currentOwner = readLockOwner(lockPath);
    if (current.dev !== evidence.device
        || current.ino !== evidence.inode
        || (currentOwner?.id ?? null) !== evidence.ownerId) {
      return false;
    }
    fs.renameSync(lockPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  } finally {
    fs.rmSync(claimPath, { force: true });
  }
  fs.rmSync(quarantinePath, { recursive: true, force: true });
  return true;
}

function acquireTokenLock(tokenPath: string, options: TokenStoreOptions): LockOwner {
  const lockPath = getTokenLockPath(tokenPath);
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: TOKEN_DIRECTORY_MODE });
      const owner: LockOwner = {
        id: randomUUID(),
        pid: process.pid,
        hostname: os.hostname(),
      };
      try {
        fs.writeFileSync(
          path.join(lockPath, LOCK_OWNER_FILE),
          `${JSON.stringify(owner)}\n`,
          { encoding: 'utf8', flag: 'wx', mode: TOKEN_FILE_MODE },
        );
      } catch (error) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      return owner;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const staleEvidence = getStaleLockEvidence(lockPath, staleLockMs);
    if (staleEvidence && recoverStaleLock(lockPath, staleEvidence)) {
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for token lock at ${lockPath}.`);
    }
    sleepSync(Math.min(retryMs, Math.max(1, deadline - Date.now())));
  }
}

function releaseTokenLock(tokenPath: string, owner: LockOwner): void {
  const lockPath = getTokenLockPath(tokenPath);
  const currentOwner = readLockOwner(lockPath);
  if (currentOwner?.id !== owner.id) return;
  fs.rmSync(lockPath, { recursive: true, force: true });
}

function mergeDefinedCredentials(
  current: StoredToken | null,
  update: StoredToken,
): StoredToken {
  const merged: StoredToken = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(update)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

function syncDirectory(directoryPath: string): void {
  if (!isPosixModeSupported()) return;
  const descriptor = fs.openSync(directoryPath, 'r');
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EBADF') throw error;
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Merge and durably replace a token while holding a per-account process lock.
 * The function is intentionally synchronous so OAuth token event handlers can
 * fail closed before returning to their caller.
 */
export function writeStoredTokenFile(
  tokenPath: string,
  update: StoredToken,
  options: TokenStoreOptions = {},
): StoredToken {
  if (!isRecord(update)) {
    throw new Error(`Invalid token update for ${tokenPath}: expected an object.`);
  }

  ensurePrivateTokenDirectory(path.dirname(tokenPath));
  const owner = acquireTokenLock(tokenPath, options);
  let temporaryPath: string | null = null;

  try {
    const latest = readStoredTokenFile(tokenPath);
    const merged = mergeDefinedCredentials(latest, update);
    validateStoredToken(merged, tokenPath);

    temporaryPath = path.join(
      path.dirname(tokenPath),
      `.${path.basename(tokenPath)}.tmp-${process.pid}-${randomUUID()}`,
    );
    const descriptor = fs.openSync(temporaryPath, 'wx', TOKEN_FILE_MODE);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    repairMode(temporaryPath, TOKEN_FILE_MODE);

    const replaceFile = options.replaceFile ?? fs.renameSync;
    replaceFile(temporaryPath, tokenPath);
    temporaryPath = null;
    syncDirectory(path.dirname(tokenPath));
    return merged;
  } finally {
    if (temporaryPath) fs.rmSync(temporaryPath, { force: true });
    releaseTokenLock(tokenPath, owner);
  }
}

export function readStoredToken(account: AccountConfig): StoredToken | null {
  return readStoredTokenFile(getTokenPath(account));
}

export function writeStoredToken(
  account: AccountConfig,
  update: StoredToken,
  options: TokenStoreOptions = {},
): StoredToken {
  return writeStoredTokenFile(getTokenPath(account), update, options);
}
