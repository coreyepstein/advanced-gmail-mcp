import assert from 'node:assert/strict';
import test from 'node:test';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCheckAuthHealth } from '../src/tools/auth-health.js';

test('check_auth_health exposes the same read-only all-account report', async () => {
  let name = '';
  let handler: (() => Promise<unknown>) | undefined;
  const server = {
    tool(toolName: string, _description: string, toolHandler: () => Promise<unknown>) {
      name = toolName;
      handler = toolHandler;
    },
  } as unknown as McpServer;
  const report = {
    accounts: [{
      alias: 'personal',
      email: 'ed@example.com',
      category: 'healthy' as const,
      healthy: true,
      message: 'Gmail refresh and profile access verified.',
    }],
    healthy: true,
    exitCode: 0 as const,
  };

  registerCheckAuthHealth(server, async () => report);

  assert.equal(name, 'check_auth_health');
  assert.ok(handler);
  const result = await handler!() as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0]!.text), {
    schemaVersion: 1,
    ...report,
  });
});

test('check_auth_health is an MCP error when any configured account is unhealthy', async () => {
  let handler: (() => Promise<unknown>) | undefined;
  const server = {
    tool(_name: string, _description: string, toolHandler: () => Promise<unknown>) {
      handler = toolHandler;
    },
  } as unknown as McpServer;
  const report = {
    accounts: [{
      alias: 'work',
      email: 'work@example.com',
      category: 'reauthorization_required' as const,
      healthy: false,
      message: 'Google requires recovery.',
    }],
    healthy: false,
    exitCode: 1 as const,
  };

  registerCheckAuthHealth(server, async () => report);
  const result = await handler!() as { isError?: boolean };

  assert.equal(result.isError, true);
});
