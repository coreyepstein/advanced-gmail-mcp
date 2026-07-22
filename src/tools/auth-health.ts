import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  checkAuthStatus,
  createAuthHealthEnvelope,
  createAuthHealthFailure,
  type AuthHealthReport,
} from '../gmail/auth.js';
import { clearGmailClientCache } from '../gmail/client.js';

export type AuthHealthChecker = () => Promise<AuthHealthReport>;

const authHealthOutputSchema = {
  schemaVersion: z.literal(1),
  accounts: z.array(z.object({
    alias: z.string(),
    email: z.string(),
    category: z.enum([
      'healthy',
      'missing_token',
      'corrupt_token',
      'reauthorization_required',
      'insufficient_scope',
      'domain_policy',
      'quota',
      'rate_limit',
      'transient',
      'network',
      'wrong_account',
      'local_permission',
      'forbidden',
      'unknown',
    ]),
    healthy: z.boolean(),
    message: z.string(),
  })),
  healthy: z.boolean(),
  exitCode: z.union([z.literal(0), z.literal(1)]),
  error: z.object({
    category: z.literal('configuration_error'),
    message: z.string(),
  }).optional(),
};

/** Register a read-only proof that every configured Gmail account is usable. */
export function registerCheckAuthHealth(
  server: McpServer,
  checker: AuthHealthChecker = () => checkAuthStatus({ log: () => {} }),
  invalidateClients: () => void = clearGmailClientCache,
): void {
  server.registerTool(
    'check_auth_health',
    {
      description: 'Force-refresh every configured Gmail account, verify Gmail profile identity, and return one aggregate health report. Opens no browser and changes no Gmail data.',
      outputSchema: authHealthOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      let envelope;
      try {
        envelope = createAuthHealthEnvelope(await checker());
      } catch (error) {
        envelope = createAuthHealthFailure(error);
      } finally {
        invalidateClients();
      }
      return {
        structuredContent: { ...envelope } as Record<string, unknown>,
        content: [{
          type: 'text' as const,
          text: JSON.stringify(envelope, null, 2),
        }],
        ...(envelope.healthy ? {} : { isError: true }),
      };
    },
  );
}
