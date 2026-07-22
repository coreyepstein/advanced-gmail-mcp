import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  getTokenPath,
  validateConfig,
  type AccountConfig,
} from '../src/config.js';

test('validateConfig accepts unique safe aliases', () => {
  const config = validateConfig({
    accounts: [
      { email: 'first@example.com', alias: 'first' },
      { email: 'second@example.com', alias: 'second_account' },
    ],
    default: 'first',
  });

  assert.equal(config.accounts.length, 2);
  assert.equal(config.default, 'first');
});

test('validateConfig keeps legacy account files working when default is omitted', () => {
  const config = validateConfig({
    accounts: [
      { email: 'first@example.com', alias: 'first', credentials_path: 'ignored.json' },
      { email: 'second@example.com', alias: 'second' },
    ],
  });

  assert.equal(config.default, 'first');
});

test('validateConfig rejects aliases that collide on case-insensitive filesystems', () => {
  assert.throws(
    () => validateConfig({
      accounts: [
        { email: 'first@example.com', alias: 'Work' },
        { email: 'second@example.com', alias: 'work' },
      ],
      default: 'Work',
    }),
    /duplicate account alias/i,
  );
});

test('validateConfig rejects path traversal and nested aliases', () => {
  for (const alias of ['../escape', 'nested/alias', 'nested\\alias', '.', '..', '/absolute']) {
    assert.throws(
      () => validateConfig({
        accounts: [{ email: 'unsafe@example.com', alias }],
        default: alias,
      }),
      /invalid account alias/i,
      alias,
    );
  }
});

test('getTokenPath rejects an unsafe AccountConfig before returning a path', () => {
  const unsafe = { email: 'unsafe@example.com', alias: '../escape' } satisfies AccountConfig;
  assert.throws(() => getTokenPath(unsafe), /invalid account alias/i);
});

test('getTokenPath returns a direct token-directory child for a safe alias', () => {
  const tokenPath = getTokenPath({ email: 'safe@example.com', alias: 'safe-account' });
  assert.equal(path.basename(tokenPath), 'safe-account.json');
  assert.equal(path.basename(path.dirname(tokenPath)), 'tokens');
});
