import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAuthArgs } from '../src/auth.js';

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
  assert.deepEqual(parseAuthArgs(['--check']), { mode: 'check' });
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
  assert.throws(() => parseAuthArgs(['welgo', 'personal']), /at most one account/i);
});
