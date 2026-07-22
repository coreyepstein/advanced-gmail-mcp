import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerListEmails } from './list.js';
import { registerSearchEmails } from './search.js';
import { registerReadEmail } from './read.js';
import { registerGetThread } from './thread.js';
import { registerGetLabels } from './labels.js';
import { registerSendEmail } from './send.js';
import { registerDraftEmail } from './draft.js';
import { registerReplyEmail } from './reply.js';
import { registerDraftReply } from './draft-reply.js';
import { registerSendDraft } from './send-draft.js';
import { registerArchiveEmail } from './archive.js';
import { registerLabelEmail } from './label.js';
import { registerTrashEmail } from './trash.js';
import { registerBatchModify } from './batch.js';
import { registerCheckAuthHealth } from './auth-health.js';

/**
 * Register all Gmail MCP tools with the server.
 */
export function registerAllTools(server: McpServer): void {
  // Read-only tools
  registerListEmails(server);
  registerSearchEmails(server);
  registerReadEmail(server);
  registerGetThread(server);
  registerGetLabels(server);
  registerCheckAuthHealth(server);

  // Write tools
  registerSendEmail(server);
  registerDraftEmail(server);
  registerReplyEmail(server);
  registerDraftReply(server);
  registerSendDraft(server);

  // Modify tools
  registerArchiveEmail(server);
  registerLabelEmail(server);
  registerTrashEmail(server);
  registerBatchModify(server);
}
