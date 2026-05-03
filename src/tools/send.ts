import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sendMessage } from '../gmail/client.js';

export const sendEmailParams = {
  to: z.string().describe('Recipient email address'),
  subject: z.string().describe('Email subject line'),
  body: z.string().describe('Email body content. Default is Markdown — paragraphs separate by blank lines, **bold**, *italic*, [link](url), `code`, lists, and headings render to HTML for the recipient.'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  cc: z.string().optional().describe('CC recipients (comma-separated)'),
  bcc: z.string().optional().describe('BCC recipients (comma-separated)'),
  is_html: z.boolean().optional().describe('Set true ONLY when body is already raw HTML; sends a single text/html part. Default behaviour (omit or false) treats body as Markdown and emits multipart/alternative with text/plain + text/html so modern clients reflow paragraphs and old clients see clean plaintext.'),
};

export function registerSendEmail(server: McpServer): void {
  server.tool(
    'send_email',
    'Send an email. Returns the sent message ID, thread ID, and labels.',
    sendEmailParams,
    async ({ to, subject, body, account, cc, bcc, is_html }) => {
      try {
        const result = await sendMessage({
          to,
          subject,
          body,
          account: account ?? undefined,
          cc: cc ?? undefined,
          bcc: bcc ?? undefined,
          is_html: is_html ?? undefined,
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
