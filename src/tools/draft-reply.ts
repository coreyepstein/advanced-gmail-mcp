import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createDraftReply } from '../gmail/client.js';

export const draftReplyParams = {
  message_id: z.string().describe('The Gmail message ID to reply to'),
  body: z.string().describe('Reply body content. Default is Markdown — paragraphs separate by blank lines, **bold**, *italic*, [link](url), `code`, lists, and headings render to HTML for the recipient.'),
  account: z.string().optional().describe('Account alias (vyg, indigo, personal, abacus) or email. Defaults to personal.'),
  is_html: z.boolean().optional().describe('Set true ONLY when body is already raw HTML; sends a single text/html part. Default behaviour (omit or false) treats body as Markdown and emits multipart/alternative with text/plain + text/html so modern clients reflow paragraphs and old clients see clean plaintext.'),
  reply_all: z.boolean().optional().describe('Reply to all recipients (default: false, replies only to sender)'),
  cc: z.string().optional().describe('CC recipients (comma-separated). Merged with reply-all CCs if both provided.'),
  bcc: z.string().optional().describe('BCC recipients (comma-separated)'),
};

export function registerDraftReply(server: McpServer): void {
  server.tool(
    'draft_reply',
    'Create a draft reply to an existing email. Fetches original message for proper threading (In-Reply-To, References, threadId). Draft appears in Gmail for review before sending — use send_draft to send after review.',
    draftReplyParams,
    async ({ message_id, body, account, is_html, reply_all, cc, bcc }) => {
      try {
        const result = await createDraftReply({
          messageId: message_id,
          body,
          account: account ?? undefined,
          is_html: is_html ?? undefined,
          reply_all: reply_all ?? undefined,
          cc: cc ?? undefined,
          bcc: bcc ?? undefined,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
