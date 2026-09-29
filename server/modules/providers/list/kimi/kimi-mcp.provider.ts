import path from 'node:path';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  getKimiCodeHomePath,
  readJsonConfig,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
  writeJsonConfig,
} from '@/shared/utils.js';

/**
 * User servers live in `<KIMI_CODE_HOME>/mcp.json`, project servers in
 * `<cwd>/.kimi-code/mcp.json` (kimi 2.1.1).
 */
const getKimiMcpConfigPath = (scope: McpScope, workspacePath: string): string => (
  scope === 'user'
    ? path.join(getKimiCodeHomePath(), 'mcp.json')
    : path.join(workspacePath, '.kimi-code', 'mcp.json')
);

/**
 * Kimi Code MCP config adapter. Consumed by `KimiProvider`.
 *
 * Kimi keeps servers under `mcpServers`, Claude-style, with an explicit
 * `transport` field, at user scope and at project scope.
 */
export class KimiMcpProvider extends McpProvider {
  constructor() {
    super('kimi', ['user', 'project'], ['stdio', 'http']);
  }

  protected async readScopedServers(scope: McpScope, workspacePath: string): Promise<Record<string, unknown>> {
    const config = await readJsonConfig(getKimiMcpConfigPath(scope, workspacePath));
    return readObjectRecord(config.mcpServers) ?? {};
  }

  protected async writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
  ): Promise<void> {
    const filePath = getKimiMcpConfigPath(scope, workspacePath);
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
        transport: 'stdio',
        command: input.command,
        args: input.args ?? [],
        env: input.env ?? {},
        cwd: input.cwd,
      };
    }

    if (!input.url?.trim()) {
      throw new AppError('url is required for http MCP servers.', {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }

    return {
      transport: 'http',
      url: input.url,
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
        provider: 'kimi',
        name,
        scope,
        transport: 'stdio',
        command: config.command,
        args: readStringArray(config.args),
        env: readStringRecord(config.env),
        cwd: readOptionalString(config.cwd),
      };
    }

    if (typeof config.url === 'string') {
      return {
        provider: 'kimi',
        name,
        scope,
        transport: 'http',
        url: config.url,
        headers: readStringRecord(config.headers),
      };
    }

    return null;
  }
}
