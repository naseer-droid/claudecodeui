import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';
import { getKimiCodeHomePath } from '@/shared/utils.js';

/**
 * Kimi Code skill discovery. Consumed by `KimiProvider`.
 *
 * Mirrors the CLI's own search order (kimi 2.1.1): the brand folder
 * `.kimi-code/skills` and the generic `.agents/skills` folder, per project and
 * per user. Skills are invoked as `/<name>` (the CLI also accepts
 * `/skill:<name>`).
 */
export class KimiSkillsProvider extends SkillsProvider {
  constructor() {
    super('kimi');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    return [
      {
        scope: 'project',
        rootDir: path.join(workspacePath, '.kimi-code', 'skills'),
        commandPrefix: '/',
      },
      {
        scope: 'project',
        rootDir: path.join(workspacePath, '.agents', 'skills'),
        commandPrefix: '/',
      },
      {
        scope: 'user',
        rootDir: path.join(getKimiCodeHomePath(), 'skills'),
        commandPrefix: '/',
      },
      {
        scope: 'user',
        rootDir: path.join(os.homedir(), '.agents', 'skills'),
        commandPrefix: '/',
      },
    ];
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return {
      scope: 'user',
      rootDir: path.join(getKimiCodeHomePath(), 'skills'),
      commandPrefix: '/',
    };
  }
}
