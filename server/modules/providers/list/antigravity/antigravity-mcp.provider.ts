import path from 'node:path';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  getAntigravityConfigPath,
  readJsonConfig,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
  writeJsonConfig,
} from '@/shared/utils.js';

/** agy reads user MCP servers from `~/.gemini/config/mcp_config.json`. */
const getAntigravityMcpConfigPath = (): string => path.join(getAntigravityConfigPath(), 'mcp_config.json');

/**
 * Antigravity MCP config adapter. Consumed by `AntigravityProvider`.
 *
 * agy documents only a global file (plus plugin bundles), so only the `user`
 * scope is offered. Servers live under `mcpServers`: stdio entries use
 * `command/args/env`, remote entries a `serverUrl` (the Antigravity IDE
 * writes `serverURL`, which is read too).
 */
export class AntigravityMcpProvider extends McpProvider {
  constructor() {
    super('antigravity', ['user'], ['stdio', 'http']);
  }

  protected async readScopedServers(_scope: McpScope, _workspacePath: string): Promise<Record<string, unknown>> {
    const config = await readJsonConfig(getAntigravityMcpConfigPath());
    return readObjectRecord(config.mcpServers) ?? {};
  }

  protected async writeScopedServers(
    _scope: McpScope,
    _workspacePath: string,
    servers: Record<string, unknown>,
  ): Promise<void> {
    const filePath = getAntigravityMcpConfigPath();
    const config = await readJsonConfig(filePath);
    config.mcpServers = servers;
    await writeJsonConfig(filePath, config);
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (input.transport === 'stdio') {
      if (!input.command?.trim()) {
        throw new AppError('command is required for stdio MCP servers.', {
          code: 'MCP_COMMAND_REQUIRED',
          statusCode: 400,
        });
      }

      return {
        command: input.command,
        args: input.args ?? [],
        env: input.env ?? {},
      };
    }

    if (!input.url?.trim()) {
      throw new AppError('url is required for http MCP servers.', {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }

    return {
      serverUrl: input.url,
      headers: input.headers ?? {},
    };
  }

  protected normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null {
    const config = readObjectRecord(rawConfig);
    if (!config) {
      return null;
    }

    if (typeof config.command === 'string') {
      return {
        provider: 'antigravity',
        name,
        scope,
        transport: 'stdio',
        command: config.command,
        args: readStringArray(config.args),
        env: readStringRecord(config.env),
      };
    }

    const url = readOptionalString(config.serverUrl)
      ?? readOptionalString(config.serverURL)
      ?? readOptionalString(config.url);
    if (url) {
      return {
        provider: 'antigravity',
        name,
        scope,
        transport: 'http',
        url,
        headers: readStringRecord(config.headers),
      };
    }

    return null;
  }
}
