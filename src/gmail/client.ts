import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import type { Auth } from 'googleapis';
import { type AccountConfig, resolveAccount } from '../config.js';
import { getAuthClient } from './auth.js';
import {
  classifyGmailError,
  providerMessage,
  type GmailErrorClassification,
  type GmailErrorCategory,
} from './errors.js';
import type {
  EmailSummary,
  EmailFull,
  AttachmentInfo,
  ThreadInfo,
  ThreadMessage,
  LabelInfo,
  SendResult,
  DraftResult,
  ModifyResult,
  BatchResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Client cache: OAuth2Client per account with 50-min TTL
// ---------------------------------------------------------------------------

interface CachedClient {
  client: Auth.OAuth2Client;
  gmail: gmail_v1.Gmail;
  expiresAt: number;
}

const CLIENT_CACHE = new Map<string, CachedClient>();
const CLIENT_TTL_MS = 50 * 60 * 1000; // 50 minutes

export function clearGmailClientCache(): void {
  CLIENT_CACHE.clear();
}

/**
 * Get an authenticated Gmail API client for an account.
 * Caches OAuth2Client per account with 50-min TTL.
 */
export async function getGmailClient(account?: string | AccountConfig): Promise<gmail_v1.Gmail> {
  const resolved = typeof account === 'string' || account === undefined
    ? resolveAccount(account)
    : account;

  const cacheKey = resolved.email;
  const cached = CLIENT_CACHE.get(cacheKey);

  if (cached && Date.now() < cached.expiresAt) {
    return cached.gmail;
  }

  const authClient = await getAuthClient(resolved);
  const gmail = google.gmail({ version: 'v1', auth: authClient });

  CLIENT_CACHE.set(cacheKey, {
    client: authClient,
    gmail,
    expiresAt: Date.now() + CLIENT_TTL_MS,
  });

  return gmail;
}

// ---------------------------------------------------------------------------
// Retry helper for rate limits
// ---------------------------------------------------------------------------

export { classifyGmailError } from './errors.js';
export type { GmailErrorClassification, GmailErrorCategory } from './errors.js';

type Sleep = (milliseconds: number) => Promise<void>;

/** Convert classified Gmail failures into actionable, non-secret guidance. */
export function formatGmailRuntimeError(error: unknown): Error {
  const classification = classifyGmailError(error);
  const details = providerMessage(error);
  const status = classification.status ? ` (${classification.status})` : '';
  const reason = classification.reason ? ` [${classification.reason}]` : '';
  let guidance: string;

  switch (classification.category) {
    case 'reauthorization_required':
      guidance = 'Gmail credentials are no longer valid. '
        + 'Run: npm run auth -- <account-alias> --force-consent';
      break;
    case 'insufficient_scope':
      guidance = 'Gmail denied a required scope. Review the configured Gmail scopes.';
      break;
    case 'domain_policy':
      guidance = 'Google Workspace policy blocked this Gmail action. Contact the Workspace admin.';
      break;
    case 'quota':
      guidance = 'Gmail quota is exhausted. Wait for quota recovery or review the project quota.';
      break;
    case 'rate_limit':
      guidance = 'Gmail rate-limited the request after bounded retries.';
      break;
    case 'transient':
      guidance = 'Gmail is temporarily unavailable. Try the request again later.';
      break;
    case 'network':
      guidance = 'The Gmail request failed at the network layer. Check connectivity and try again.';
      break;
    case 'forbidden':
      guidance = 'Gmail forbade this action. This does not by itself mean the OAuth grant was revoked.';
      break;
    default:
      guidance = 'The Gmail request failed.';
  }

  const wrapped = new Error(
    `${guidance}${status}${reason} ${details}`,
    { cause: error },
  );
  wrapped.name = 'GmailRuntimeError';
  return wrapped;
}

const defaultSleep: Sleep = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  sleep: Sleep = defaultSleep,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      const classification = classifyGmailError(err);

      if (classification.retryable && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        await sleep(delay);
        continue;
      }
      if (classification.category === 'unknown') throw err;
      throw formatGmailRuntimeError(err);
    }
  }
  throw formatGmailRuntimeError(lastError);
}

// ---------------------------------------------------------------------------
// Header / body extraction helpers
// ---------------------------------------------------------------------------

function extractHeader(
  headers: Array<{ name?: string | null; value?: string | null }>,
  name: string,
): string {
  const header = headers.find(h => h.name?.toLowerCase() === name.toLowerCase());
  return header?.value || '';
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

/**
 * Recursively extract HTML and plain-text body from a MIME payload.
 */
function extractBody(payload: gmail_v1.Schema$MessagePart): { html: string; text: string } {
  let html = '';
  let text = '';

  if (payload.mimeType === 'text/html' && payload.body?.data) {
    html = decodeBase64Url(payload.body.data);
  } else if (payload.mimeType === 'text/plain' && payload.body?.data) {
    text = decodeBase64Url(payload.body.data);
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const result = extractBody(part);
      if (result.html) html = result.html;
      if (result.text) text = result.text;
    }
  }

  return { html, text };
}

/**
 * Extract attachment metadata from message parts (no content download).
 */
function extractAttachments(payload: gmail_v1.Schema$MessagePart): AttachmentInfo[] {
  const attachments: AttachmentInfo[] = [];

  if (payload.filename && payload.filename.length > 0 && payload.body?.attachmentId) {
    attachments.push({
      filename: payload.filename,
      mimeType: payload.mimeType || 'application/octet-stream',
      size: payload.body.size || 0,
    });
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      attachments.push(...extractAttachments(part));
    }
  }

  return attachments;
}

/**
 * Parse a Gmail API message into an EmailSummary.
 */
function toEmailSummary(msg: gmail_v1.Schema$Message): EmailSummary {
  const headers = msg.payload?.headers || [];
  return {
    id: msg.id || '',
    threadId: msg.threadId || '',
    from: extractHeader(headers, 'From'),
    to: extractHeader(headers, 'To'),
    subject: extractHeader(headers, 'Subject'),
    date: extractHeader(headers, 'Date'),
    snippet: msg.snippet || '',
    labels: msg.labelIds || [],
    isUnread: (msg.labelIds || []).includes('UNREAD'),
  };
}

/**
 * Parse a Gmail API message into an EmailFull.
 */
function toEmailFull(msg: gmail_v1.Schema$Message): EmailFull {
  const headers = msg.payload?.headers || [];
  const { html, text } = msg.payload ? extractBody(msg.payload) : { html: '', text: '' };
  const attachments = msg.payload ? extractAttachments(msg.payload) : [];

  return {
    id: msg.id || '',
    threadId: msg.threadId || '',
    from: extractHeader(headers, 'From'),
    to: extractHeader(headers, 'To'),
    cc: extractHeader(headers, 'Cc'),
    bcc: extractHeader(headers, 'Bcc'),
    subject: extractHeader(headers, 'Subject'),
    date: extractHeader(headers, 'Date'),
    body_text: text,
    body_html: html,
    labels: msg.labelIds || [],
    attachments,
  };
}

/**
 * Parse a Gmail API message into a ThreadMessage (lighter than EmailFull).
 */
function toThreadMessage(msg: gmail_v1.Schema$Message): ThreadMessage {
  const headers = msg.payload?.headers || [];
  const { text } = msg.payload ? extractBody(msg.payload) : { text: '' };

  return {
    id: msg.id || '',
    from: extractHeader(headers, 'From'),
    to: extractHeader(headers, 'To'),
    cc: extractHeader(headers, 'Cc'),
    subject: extractHeader(headers, 'Subject'),
    date: extractHeader(headers, 'Date'),
    body_text: text,
    snippet: msg.snippet || '',
    labels: msg.labelIds || [],
  };
}

// ---------------------------------------------------------------------------
// MIME construction
// ---------------------------------------------------------------------------

interface MimeOptions {
  to: string;
  subject: string;
  body: string;
  from?: string;
  cc?: string;
  bcc?: string;
  is_html?: boolean;
  in_reply_to?: string;
  references?: string;
}

/**
 * Build an RFC 2822 message and encode as base64url for the Gmail API.
 */
function buildRawMessage(opts: MimeOptions): string {
  const lines: string[] = [];

  if (opts.from) lines.push(`From: ${opts.from}`);
  lines.push(`To: ${opts.to}`);
  if (opts.cc) lines.push(`Cc: ${opts.cc}`);
  if (opts.bcc) lines.push(`Bcc: ${opts.bcc}`);
  lines.push(`Subject: ${opts.subject}`);
  if (opts.in_reply_to) lines.push(`In-Reply-To: ${opts.in_reply_to}`);
  if (opts.references) lines.push(`References: ${opts.references}`);
  lines.push(`MIME-Version: 1.0`);
  lines.push(`Content-Type: ${opts.is_html ? 'text/html' : 'text/plain'}; charset="UTF-8"`);
  lines.push(''); // blank line separates headers from body
  lines.push(opts.body);

  const raw = lines.join('\r\n');
  return Buffer.from(raw).toString('base64url');
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * List messages in a mailbox.
 * Paginates through all results up to maxResults (default 500, hard cap 1000).
 */
export async function listMessages(opts: {
  account?: string;
  label?: string;
  maxResults?: number;
  query?: string;
}): Promise<EmailSummary[]> {
  const gmail = await getGmailClient(opts.account);
  const labelIds = opts.label ? [opts.label] : ['INBOX'];
  const maxResults = Math.min(opts.maxResults ?? 500, 1000);

  // Paginate through messages.list to collect all message IDs
  const allMessageRefs: Array<{ id: string }> = [];
  let pageToken: string | undefined;

  while (allMessageRefs.length < maxResults) {
    const pageSize = Math.min(maxResults - allMessageRefs.length, 500);
    const response = await withRetry(() =>
      gmail.users.messages.list({
        userId: 'me',
        labelIds,
        maxResults: pageSize,
        q: opts.query || undefined,
        pageToken,
      })
    );

    const messages = response.data.messages || [];
    for (const msg of messages) {
      if (msg.id) allMessageRefs.push({ id: msg.id });
    }

    pageToken = response.data.nextPageToken ?? undefined;
    if (!pageToken || messages.length === 0) break;
  }

  if (allMessageRefs.length === 0) return [];

  // Fetch metadata for each message
  const results: EmailSummary[] = [];
  for (const msg of allMessageRefs) {
    const full = await withRetry(() =>
      gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      })
    );
    results.push(toEmailSummary(full.data));
  }

  return results;
}

/**
 * Get a single message by ID.
 */
export async function getMessage(opts: {
  messageId: string;
  account?: string;
  format?: 'full' | 'metadata' | 'minimal';
}): Promise<EmailFull> {
  const gmail = await getGmailClient(opts.account);
  const format = opts.format ?? 'full';

  const response = await withRetry(() =>
    gmail.users.messages.get({
      userId: 'me',
      id: opts.messageId,
      format,
    })
  );

  return toEmailFull(response.data);
}

/**
 * Search messages using Gmail query syntax.
 * Paginates through all results up to maxResults (default 500, hard cap 1000).
 */
export async function searchMessages(opts: {
  query: string;
  account?: string;
  maxResults?: number;
}): Promise<EmailSummary[]> {
  const gmail = await getGmailClient(opts.account);
  const maxResults = Math.min(opts.maxResults ?? 500, 1000);

  // Paginate through messages.list to collect all message IDs
  const allMessageRefs: Array<{ id: string }> = [];
  let pageToken: string | undefined;

  while (allMessageRefs.length < maxResults) {
    const pageSize = Math.min(maxResults - allMessageRefs.length, 500);
    const response = await withRetry(() =>
      gmail.users.messages.list({
        userId: 'me',
        q: opts.query,
        maxResults: pageSize,
        pageToken,
      })
    );

    const messages = response.data.messages || [];
    for (const msg of messages) {
      if (msg.id) allMessageRefs.push({ id: msg.id });
    }

    pageToken = response.data.nextPageToken ?? undefined;
    if (!pageToken || messages.length === 0) break;
  }

  if (allMessageRefs.length === 0) return [];

  // Fetch metadata for each message
  const results: EmailSummary[] = [];
  for (const msg of allMessageRefs) {
    const full = await withRetry(() =>
      gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      })
    );
    results.push(toEmailSummary(full.data));
  }

  return results;
}

/**
 * Send an email.
 */
export async function sendMessage(opts: {
  to: string;
  subject: string;
  body: string;
  account?: string;
  cc?: string;
  bcc?: string;
  is_html?: boolean;
}): Promise<SendResult> {
  const resolved = resolveAccount(opts.account);
  const gmail = await getGmailClient(resolved);

  const raw = buildRawMessage({
    from: resolved.email,
    to: opts.to,
    subject: opts.subject,
    body: opts.body,
    cc: opts.cc,
    bcc: opts.bcc,
    is_html: opts.is_html,
  });

  const response = await withRetry(() =>
    gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    })
  );

  return {
    id: response.data.id || '',
    threadId: response.data.threadId || '',
    labelIds: response.data.labelIds || [],
  };
}

/**
 * Create a draft email.
 */
export async function createDraft(opts: {
  to: string;
  subject: string;
  body: string;
  account?: string;
  cc?: string;
  bcc?: string;
  is_html?: boolean;
}): Promise<DraftResult> {
  const resolved = resolveAccount(opts.account);
  const gmail = await getGmailClient(resolved);

  const raw = buildRawMessage({
    from: resolved.email,
    to: opts.to,
    subject: opts.subject,
    body: opts.body,
    cc: opts.cc,
    bcc: opts.bcc,
    is_html: opts.is_html,
  });

  const response = await withRetry(() =>
    gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: { raw },
      },
    })
  );

  return {
    draft_id: response.data.id || '',
    message: {
      id: response.data.message?.id || '',
      threadId: response.data.message?.threadId || '',
    },
  };
}

/**
 * Modify labels on a message (add/remove).
 */
export async function modifyMessage(opts: {
  messageId: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
  account?: string;
}): Promise<ModifyResult> {
  const gmail = await getGmailClient(opts.account);

  const response = await withRetry(() =>
    gmail.users.messages.modify({
      userId: 'me',
      id: opts.messageId,
      requestBody: {
        addLabelIds: opts.addLabelIds || [],
        removeLabelIds: opts.removeLabelIds || [],
      },
    })
  );

  return {
    success: true,
    id: response.data.id || '',
    labels: response.data.labelIds || [],
  };
}

/**
 * Move a message to trash.
 */
export async function trashMessage(opts: {
  messageId: string;
  account?: string;
}): Promise<ModifyResult> {
  const gmail = await getGmailClient(opts.account);

  const response = await withRetry(() =>
    gmail.users.messages.trash({
      userId: 'me',
      id: opts.messageId,
    })
  );

  return {
    success: true,
    id: response.data.id || '',
  };
}

/**
 * Batch modify messages (add/remove labels).
 */
export async function batchModify(opts: {
  messageIds: string[];
  addLabelIds?: string[];
  removeLabelIds?: string[];
  account?: string;
}): Promise<BatchResult> {
  const gmail = await getGmailClient(opts.account);

  await withRetry(() =>
    gmail.users.messages.batchModify({
      userId: 'me',
      requestBody: {
        ids: opts.messageIds,
        addLabelIds: opts.addLabelIds || [],
        removeLabelIds: opts.removeLabelIds || [],
      },
    })
  );

  return {
    success: true,
    modified_count: opts.messageIds.length,
    message_ids: opts.messageIds,
  };
}

/**
 * List all labels for an account.
 */
export async function listLabels(opts?: {
  account?: string;
}): Promise<LabelInfo[]> {
  const gmail = await getGmailClient(opts?.account);

  const response = await withRetry(() =>
    gmail.users.labels.list({ userId: 'me' })
  );

  const labels = response.data.labels || [];

  return labels.map(label => ({
    id: label.id || '',
    name: label.name || '',
    type: label.type || '',
    messagesTotal: label.messagesTotal || 0,
    messagesUnread: label.messagesUnread || 0,
  }));
}

/**
 * Get a thread with all its messages.
 */
export async function getThread(opts: {
  threadId: string;
  account?: string;
}): Promise<ThreadInfo> {
  const gmail = await getGmailClient(opts.account);

  const response = await withRetry(() =>
    gmail.users.threads.get({
      userId: 'me',
      id: opts.threadId,
      format: 'full',
    })
  );

  const messages = (response.data.messages || []).map(toThreadMessage);

  return {
    id: response.data.id || '',
    messages,
  };
}

/**
 * Send a reply to an existing message.
 * Fetches the original to get threadId, Message-ID, Subject, and From for proper threading.
 */
export async function replyToMessage(opts: {
  messageId: string;
  body: string;
  account?: string;
  is_html?: boolean;
  reply_all?: boolean;
  cc?: string;
  bcc?: string;
}): Promise<SendResult> {
  const resolved = resolveAccount(opts.account);
  const gmail = await getGmailClient(resolved);

  // Fetch the original message to get threading headers
  const original = await withRetry(() =>
    gmail.users.messages.get({
      userId: 'me',
      id: opts.messageId,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Message-ID', 'References'],
    })
  );

  const headers = original.data.payload?.headers || [];
  const originalFrom = extractHeader(headers, 'From');
  const originalTo = extractHeader(headers, 'To');
  const originalCc = extractHeader(headers, 'Cc');
  const originalSubject = extractHeader(headers, 'Subject');
  const originalMessageId = extractHeader(headers, 'Message-ID');
  const originalReferences = extractHeader(headers, 'References');

  // Build "Re:" subject if not already present
  const subject = originalSubject.startsWith('Re:')
    ? originalSubject
    : `Re: ${originalSubject}`;

  // Reply-to goes to the original sender
  let to = originalFrom;

  // Extract bare email from "Name <email>" or plain "email"
  const extractEmail = (addr: string): string => {
    const match = addr.match(/<([^>]+)>/);
    return (match ? match[1] : addr).trim().toLowerCase();
  };

  // Build CC: merge reply-all recipients + user-provided cc, deduplicated
  const ccParts: string[] = [];
  const seen = new Set<string>();
  seen.add(resolved.email.toLowerCase()); // exclude self

  if (opts.reply_all) {
    for (const addr of [originalTo, originalCc].filter(Boolean).join(', ').split(',').map(a => a.trim()).filter(a => a.length > 0)) {
      const email = extractEmail(addr);
      if (!seen.has(email)) {
        seen.add(email);
        ccParts.push(addr);
      }
    }
  }

  if (opts.cc) {
    for (const addr of opts.cc.split(',').map(a => a.trim()).filter(a => a.length > 0)) {
      const email = extractEmail(addr);
      if (!seen.has(email)) {
        seen.add(email);
        ccParts.push(addr);
      }
    }
  }

  const cc = ccParts.length > 0 ? ccParts.join(', ') : undefined;

  // Build References header: append original Message-ID
  const references = originalReferences
    ? `${originalReferences} ${originalMessageId}`
    : originalMessageId;

  const raw = buildRawMessage({
    from: resolved.email,
    to,
    cc,
    bcc: opts.bcc,
    subject,
    body: opts.body,
    is_html: opts.is_html,
    in_reply_to: originalMessageId,
    references,
  });

  const response = await withRetry(() =>
    gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw,
        threadId: original.data.threadId || undefined,
      },
    })
  );

  return {
    id: response.data.id || '',
    threadId: response.data.threadId || '',
    labelIds: response.data.labelIds || [],
  };
}

/**
 * Create a draft reply to an existing message.
 * Same threading logic as replyToMessage, but creates a draft instead of sending.
 * The draft appears in Gmail for user review before sending.
 */
export async function createDraftReply(opts: {
  messageId: string;
  body: string;
  account?: string;
  is_html?: boolean;
  reply_all?: boolean;
  cc?: string;
  bcc?: string;
}): Promise<DraftResult> {
  const resolved = resolveAccount(opts.account);
  const gmail = await getGmailClient(resolved);

  // Fetch the original message to get threading headers
  const original = await withRetry(() =>
    gmail.users.messages.get({
      userId: 'me',
      id: opts.messageId,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Message-ID', 'References'],
    })
  );

  const headers = original.data.payload?.headers || [];
  const originalFrom = extractHeader(headers, 'From');
  const originalTo = extractHeader(headers, 'To');
  const originalCc = extractHeader(headers, 'Cc');
  const originalSubject = extractHeader(headers, 'Subject');
  const originalMessageId = extractHeader(headers, 'Message-ID');
  const originalReferences = extractHeader(headers, 'References');

  const subject = originalSubject.startsWith('Re:')
    ? originalSubject
    : `Re: ${originalSubject}`;

  const to = originalFrom;

  const extractEmail = (addr: string): string => {
    const match = addr.match(/<([^>]+)>/);
    return (match ? match[1] : addr).trim().toLowerCase();
  };

  const ccParts: string[] = [];
  const seen = new Set<string>();
  seen.add(resolved.email.toLowerCase());

  if (opts.reply_all) {
    for (const addr of [originalTo, originalCc].filter(Boolean).join(', ').split(',').map(a => a.trim()).filter(a => a.length > 0)) {
      const email = extractEmail(addr);
      if (!seen.has(email)) {
        seen.add(email);
        ccParts.push(addr);
      }
    }
  }

  if (opts.cc) {
    for (const addr of opts.cc.split(',').map(a => a.trim()).filter(a => a.length > 0)) {
      const email = extractEmail(addr);
      if (!seen.has(email)) {
        seen.add(email);
        ccParts.push(addr);
      }
    }
  }

  const cc = ccParts.length > 0 ? ccParts.join(', ') : undefined;

  const references = originalReferences
    ? `${originalReferences} ${originalMessageId}`
    : originalMessageId;

  const raw = buildRawMessage({
    from: resolved.email,
    to,
    cc,
    bcc: opts.bcc,
    subject,
    body: opts.body,
    is_html: opts.is_html,
    in_reply_to: originalMessageId,
    references,
  });

  const response = await withRetry(() =>
    gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: {
          raw,
          threadId: original.data.threadId || undefined,
        },
      },
    })
  );

  return {
    draft_id: response.data.id || '',
    message: {
      id: response.data.message?.id || '',
      threadId: response.data.message?.threadId || '',
    },
  };
}

/**
 * Send an existing draft by its draft ID.
 */
export async function sendDraft(opts: {
  draftId: string;
  account?: string;
}): Promise<SendResult> {
  const gmail = await getGmailClient(opts.account);

  const response = await withRetry(() =>
    gmail.users.drafts.send({
      userId: 'me',
      requestBody: {
        id: opts.draftId,
      },
    })
  );

  return {
    id: response.data.id || '',
    threadId: response.data.threadId || '',
    labelIds: response.data.labelIds || [],
  };
}
