/**
 * Shared types for the Gmail MCP server.
 */

/** Summary of an email for list/search results. */
export interface EmailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  labels: string[];
  isUnread: boolean;
}

/** Full email with body content. */
export interface EmailFull {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  date: string;
  body_text: string;
  body_html: string;
  labels: string[];
  attachments: AttachmentInfo[];
}

/** Attachment metadata (no content). */
export interface AttachmentInfo {
  filename: string;
  mimeType: string;
  size: number;
}

/** Thread with its messages. */
export interface ThreadInfo {
  id: string;
  messages: ThreadMessage[];
}

/** A message within a thread (lighter than EmailFull). */
export interface ThreadMessage {
  id: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  body_text: string;
  snippet: string;
  labels: string[];
}

/** Label metadata. */
export interface LabelInfo {
  id: string;
  name: string;
  type: string;
  messagesTotal: number;
  messagesUnread: number;
}

/** Send/draft message input. */
export interface ComposeInput {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  is_html?: boolean;
}

/** Reply message input. */
export interface ReplyInput {
  message_id: string;
  body: string;
  is_html?: boolean;
  reply_all?: boolean;
  cc?: string;
  bcc?: string;
}

/** Result from send/draft operations. */
export interface SendResult {
  id: string;
  threadId: string;
  labelIds: string[];
}

/** Result from draft creation. */
export interface DraftResult {
  draft_id: string;
  message: {
    id: string;
    threadId: string;
  };
}

/** Result from modify operations. */
export interface ModifyResult {
  success: boolean;
  id: string;
  labels?: string[];
}

/** Result from batch operations. */
export interface BatchResult {
  success: boolean;
  modified_count: number;
  message_ids: string[];
}

/** OAuth token shape stored on disk. */
export interface StoredToken {
  access_token?: string | null;
  refresh_token?: string | null;
  scope?: string;
  token_type?: string | null;
  expiry_date?: number | null;
  refresh_token_expires_in?: number;
  [key: string]: unknown;
}
