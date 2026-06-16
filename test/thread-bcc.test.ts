/**
 * Regression test (DEV-1774 / feedback_ef1163a2): get_thread must surface the
 * full recipient set, including Bcc. `read_email` (toEmailFull) already returns
 * cc + bcc; `get_thread` (toThreadMessage) returned cc but DROPPED bcc, so an
 * agent reading a thread could not see the full recipient set and could wrongly
 * infer who was on a message. This pins that get_thread now extracts Bcc, at
 * parity with read_email.
 *
 * Pure-parser test: feeds realistic Gmail API `Schema$Message` fixtures through
 * the exported parsers — no Gmail credentials or network required. Run with the
 * repo's existing tsx (no test framework added):  npm test
 *
 * Differential: against the pre-fix toThreadMessage (no `bcc`), the first
 * assertion fails (tm.bcc is undefined); against the fix it passes.
 */
import assert from 'node:assert/strict';
import type { gmail_v1 } from 'googleapis';
import { toThreadMessage, toEmailFull } from '../src/gmail/client.js';

function b64url(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64url');
}

/** A message the account owner SENT — Gmail preserves Bcc on the sent copy. */
const sentMessage: gmail_v1.Schema$Message = {
  id: 'msg_sent_1',
  threadId: 'thr_1',
  snippet: 'Looping in the wider group',
  labelIds: ['SENT'],
  payload: {
    mimeType: 'text/plain',
    headers: [
      { name: 'From', value: 'owner@example.com' },
      { name: 'To', value: 'client@acme.com' },
      { name: 'Cc', value: 'carol@example.com, dave@example.com' },
      { name: 'Bcc', value: 'eve@example.com' },
      { name: 'Subject', value: 'Q3 planning' },
      { name: 'Date', value: 'Mon, 15 Jun 2026 10:00:00 -0700' },
    ],
    body: { data: b64url('Looping in the wider group on Q3.') },
  },
};

/** A DELIVERED message — the mail system strips Bcc from delivered copies. */
const deliveredMessage: gmail_v1.Schema$Message = {
  id: 'msg_recv_1',
  threadId: 'thr_1',
  snippet: 'Re: Q3 planning',
  labelIds: ['INBOX'],
  payload: {
    mimeType: 'text/plain',
    headers: [
      { name: 'From', value: 'client@acme.com' },
      { name: 'To', value: 'owner@example.com' },
      { name: 'Cc', value: 'carol@example.com' },
      { name: 'Subject', value: 'Re: Q3 planning' },
      { name: 'Date', value: 'Mon, 15 Jun 2026 11:00:00 -0700' },
    ],
    body: { data: b64url('Sounds good.') },
  },
};

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('get_thread Bcc completeness (DEV-1774):');

check('toThreadMessage extracts Bcc from a sent message (the fix)', () => {
  const tm = toThreadMessage(sentMessage);
  assert.equal(tm.bcc, 'eve@example.com');
  assert.equal(tm.cc, 'carol@example.com, dave@example.com');
  assert.equal(tm.to, 'client@acme.com');
  assert.equal(tm.from, 'owner@example.com');
  assert.equal(tm.body_text, 'Looping in the wider group on Q3.');
});

check('get_thread is at parity with read_email for cc + bcc', () => {
  const tm = toThreadMessage(sentMessage);
  const ef = toEmailFull(sentMessage);
  assert.equal(tm.cc, ef.cc);
  assert.equal(tm.bcc, ef.bcc);
});

check('ThreadMessage always carries a bcc field (empty when Bcc absent)', () => {
  const tm = toThreadMessage(deliveredMessage);
  assert.ok('bcc' in tm, 'bcc key must always be present');
  assert.equal(tm.bcc, ''); // delivered copies have no Bcc header
  assert.equal(tm.cc, 'carol@example.com');
});

console.log(`\nAll ${passed} assertions passed.`);
