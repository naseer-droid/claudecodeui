import { stat } from 'node:fs/promises';
import path from 'node:path';

import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { getKimiCodeHomePath } from '@/shared/utils.js';

/**
 * A logged-in `kimi-code.json` holds OAuth tokens (~1.5 KB). A logged-out or
 * zeroed file is a few bytes, so anything this small is treated as no login.
 */
const MIN_CREDENTIALS_FILE_BYTES = 200;

/**
 * Kimi Code install/login status. Consumed by `KimiProvider` (provider auth
 * routes and the runtime's "is it installed?" error path).
 */
export class KimiProviderAuth implements IProviderAuth {
  /**
   * Checks whether the Kimi Code CLI is on the server process PATH.
   */
  private checkInstalled(): boolean {
    try {
      const result = spawn.sync('kimi', ['--version'], { stdio: 'ignore', timeout: 5000 });
      return !result.error && result.status === 0;
    } catch {
      return false;
    }
  }

  /**
   * Returns Kimi Code CLI installation and credential status.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    const credentialsPath = path.join(getKimiCodeHomePath(), 'credentials', 'kimi-code.json');

    let authenticated = false;
    let error: string | undefined = 'Kimi Code not logged in. Run `kimi login`.';
    try {
      const credentials = await stat(credentialsPath);
      authenticated = credentials.isFile() && credentials.size > MIN_CREDENTIALS_FILE_BYTES;
    } catch (statError) {
      const code = (statError as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        error = statError instanceof Error ? statError.message : 'Failed to read Kimi Code credentials';
      }
    }

    return {
      installed,
      provider: 'kimi',
      authenticated,
      email: authenticated ? 'Kimi Code account' : null,
      method: authenticated ? 'credentials_file' : null,
      error: authenticated ? undefined : error,
    };
  }
}
