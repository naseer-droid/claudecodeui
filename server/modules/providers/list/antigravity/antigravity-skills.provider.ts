import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';
import { getAntigravityConfigPath } from '@/shared/utils.js';

/**
 * Antigravity skill discovery. Consumed by `AntigravityProvider`.
 *
 * Mirrors agy's documented roots (1.2.13 built-in `agy-customizations` skill):
 * the workspace `.agents/skills` folder and the global
 * `~/.gemini/config/skills`. Skills are invoked as `/<name>`.
 */
export class AntigravitySkillsProvider extends SkillsProvider {
  constructor() {
    super('antigravity');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    return [
      {
        scope: 'project',
        rootDir: path.join(workspacePath, '.agents', 'skills'),
        commandPrefix: '/',
      },
      {
        scope: 'user',
        rootDir: path.join(getAntigravityConfigPath(), 'skills'),
        commandPrefix: '/',
      },
    ];
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return {
      scope: 'user',
      rootDir: path.join(getAntigravityConfigPath(), 'skills'),
      commandPrefix: '/',
    };
  }
}
