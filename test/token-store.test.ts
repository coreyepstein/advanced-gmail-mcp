import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  getTokenLockPath,
  readStoredTokenFile,
  writeStoredTokenFile,
} from '../src/gmail/token-store.js';

function tempTokenPath(t: test.TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-token-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'tokens', 'account.json');
}

function runWriter(tokenPath: string, update: Record<string, unknown>): Promise<void> {
  const modulePath = fileURLToPath(new URL('../src/gmail/token-store.ts', import.meta.url));
  const script = [
    `const store = await import(${JSON.stringify(pathToFileURL(modulePath).href)});`,
    'store.writeStoredTokenFile(process.env.TOKEN_PATH, JSON.parse(process.env.TOKEN_UPDATE));',
  ].join('\n');

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--eval', script], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
      env: {
        ...process.env,
        TOKEN_PATH: tokenPath,
        TOKEN_UPDATE: JSON.stringify(update),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`writer exited ${code}: ${stderr}`));
    });
  });
}

function createLock(
  tokenPath: string,
  owner: { id: string; pid: number; hostname: string; createdAt: number },
): string {
  const lockPath = getTokenLockPath(tokenPath);
  fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
  return lockPath;
}

test('write preserves an omitted refresh token and accepts rotation', t => {
  const tokenPath = tempTokenPath(t);
  writeStoredTokenFile(tokenPath, {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expiry_date: 1,
  });

  const refreshed = writeStoredTokenFile(tokenPath, {
    access_token: 'access-2',
    expiry_date: 2,
  });
  assert.equal(refreshed.refresh_token, 'refresh-1');

  const rotated = writeStoredTokenFile(tokenPath, { refresh_token: 'refresh-2' });
  assert.equal(rotated.refresh_token, 'refresh-2');
  assert.equal(rotated.access_token, 'access-2');
});

test('write creates private directory and token modes on POSIX', t => {
  const tokenPath = tempTokenPath(t);
  writeStoredTokenFile(tokenPath, { access_token: 'access', refresh_token: 'refresh' });

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.dirname(tokenPath)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);

    fs.chmodSync(tokenPath, 0o644);
    readStoredTokenFile(tokenPath);
    assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
  }
});

test('an intentional token-directory link writes privately to its target', t => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-token-link-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targetDirectory = path.join(root, 'live-tokens');
  const linkedDirectory = path.join(root, 'tokens');
  fs.mkdirSync(targetDirectory, { mode: 0o755 });
  fs.symlinkSync(targetDirectory, linkedDirectory, 'dir');
  const tokenPath = path.join(linkedDirectory, 'account.json');

  writeStoredTokenFile(tokenPath, { refresh_token: 'linked-refresh' });

  assert.equal(readStoredTokenFile(tokenPath)?.refresh_token, 'linked-refresh');
  assert.equal(fs.statSync(targetDirectory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(targetDirectory, 'account.json')).mode & 0o777, 0o600);
});

test('malformed token errors never include token contents', t => {
  const tokenPath = tempTokenPath(t);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, '{secret-marker-not-json', { mode: 0o600 });

  assert.throws(
    () => readStoredTokenFile(tokenPath),
    error => error instanceof Error
      && /invalid token file/i.test(error.message)
      && !error.message.includes('secret-marker'),
  );
});

test('failed atomic replacement keeps the previous token and cleans temp files', t => {
  const tokenPath = tempTokenPath(t);
  writeStoredTokenFile(tokenPath, { access_token: 'old', refresh_token: 'durable' });

  assert.throws(
    () => writeStoredTokenFile(tokenPath, { access_token: 'new' }, {
      replaceFile: () => { throw new Error('simulated replacement failure'); },
    }),
    /simulated replacement failure/,
  );

  assert.equal(readStoredTokenFile(tokenPath)?.access_token, 'old');
  assert.deepEqual(
    fs.readdirSync(path.dirname(tokenPath)).filter(name => name.includes('.tmp-')),
    [],
  );
});

test('cross-process writers preserve all independent fields', async t => {
  const tokenPath = tempTokenPath(t);
  writeStoredTokenFile(tokenPath, { refresh_token: 'durable' });

  await Promise.all(Array.from({ length: 6 }, (_, index) =>
    runWriter(tokenPath, { [`writer_${index}`]: index })));

  const stored = readStoredTokenFile(tokenPath);
  assert.equal(stored?.refresh_token, 'durable');
  for (let index = 0; index < 6; index += 1) {
    assert.equal(stored?.[`writer_${index}`], index);
  }
});

test('a writer waits for a live lock then merges the latest refresh token', async t => {
  const tokenPath = tempTokenPath(t);
  writeStoredTokenFile(tokenPath, { access_token: 'old', refresh_token: 'old-refresh' });
  const lockPath = createLock(tokenPath, {
    id: 'test-owner',
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: Date.now(),
  });

  const writer = runWriter(tokenPath, { access_token: 'child-access' });
  await new Promise(resolve => setTimeout(resolve, 150));

  fs.writeFileSync(tokenPath, JSON.stringify({
    access_token: 'recovery-access',
    refresh_token: 'rotated-refresh',
  }), { mode: 0o600 });
  fs.rmSync(lockPath, { recursive: true, force: true });
  await writer;

  const stored = readStoredTokenFile(tokenPath);
  assert.equal(stored?.access_token, 'child-access');
  assert.equal(stored?.refresh_token, 'rotated-refresh');
});

test('lock waiting is bounded and a live owner is not stolen', t => {
  const tokenPath = tempTokenPath(t);
  const lockPath = createLock(tokenPath, {
    id: 'live-owner',
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: Date.now() - 60_000,
  });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, old, old);

  const startedAt = Date.now();
  assert.throws(
    () => writeStoredTokenFile(tokenPath, { access_token: 'blocked' }, {
      lockTimeoutMs: 80,
      lockRetryMs: 10,
      staleLockMs: 10,
    }),
    /timed out waiting for token lock/i,
  );
  assert.ok(Date.now() - startedAt < 500);
  assert.ok(fs.existsSync(lockPath));
});

test('a lock with an old dead local owner is recovered', t => {
  const tokenPath = tempTokenPath(t);
  const lockPath = createLock(tokenPath, {
    id: 'dead-owner',
    pid: 99_999_999,
    hostname: os.hostname(),
    createdAt: Date.now() - 60_000,
  });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, old, old);

  const stored = writeStoredTokenFile(tokenPath, { refresh_token: 'recovered' }, {
    lockTimeoutMs: 200,
    lockRetryMs: 5,
    staleLockMs: 10,
  });

  assert.equal(stored.refresh_token, 'recovered');
  assert.equal(fs.existsSync(lockPath), false);
});
