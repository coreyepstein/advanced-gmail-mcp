import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { checkAuthStatus, type AuthHealthReport } from '../gmail/auth.js';

export type AuthHealthChecker = () => Promise<AuthHealthReport>;

/** Register a read-only proof that every configured Gmail account is usable. */
export function registerCheckAuthHealth(
  server: McpServer,
  checker: AuthHealthChecker = () => checkAuthStatus({ log: () => {} }),
): void {
  server.tool(
    'check_auth_health',
    'Force-refresh every configured Gmail account, verify Gmail profile identity, and return one aggregate health report. Opens no browser and changes no Gmail data.',
    async () => {
      const report = await checker();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ schemaVersion: 1, ...report }, null, 2),
        }],
        ...(report.healthy ? {} : { isError: true }),
      };
    },
  );
}
