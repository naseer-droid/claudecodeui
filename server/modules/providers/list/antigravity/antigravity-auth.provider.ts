import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

/**
 * A signed-in `oauth_creds.json` holds Google OAuth tokens (~1.8 KB). An empty
 * or zeroed file is a few bytes, so anything this small is treated as no login.
 */
const MIN_CREDENTIALS_FILE_BYTES = 200;

/**
 * Antigravity CLI install/login status. Consumed by `AntigravityProvider`
 * (provider auth routes and the runtime's "is it installed?" error path).
 *
 * agy 1.2.13 keeps its own token in the OS keyring ("authenticated via
 * keyring" in its cli.log) and writes no login file under
 * `~/.gemini/antigravity-cli`. The closest file marker is the Google OAuth
 * file `~/.gemini/oauth_creds.json` written by the Google sign-in (shared with
 * Gemini CLI), so that is what "connected" means here.
 */
export class AntigravityProviderAuth implements IProviderAuth {
  /**
   * Checks whether the Antigravity CLI is on the server process PATH.
   */
  private checkInstalled(): boolean {
    try {
      const result = spawn.sync('agy', ['--version'], { stdio: 'ignore', timeout: 5000 });
      return !result.error && result.status === 0;
    } catch {
      return false;
    }
  }

  /**
   * Returns Antigravity CLI installation and Google credential status.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    const credentialsPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json');

    let authenticated = false;
    let error: string | undefined = 'Antigravity is not signed in. Run `agy` and sign in with Google.';
    try {
      const credentials = await stat(credentialsPath);
      authenticated = credentials.isFile() && credentials.size > MIN_CREDENTIALS_FILE_BYTES;
    } catch (statError) {
      const code = (statError as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        error = statError instanceof Error ? statError.message : 'Failed to read Google credentials';
      }
    }

    return {
      installed,
      provider: 'antigravity',
      authenticated,
      email: authenticated ? 'Google account' : null,
      method: authenticated ? 'credentials_file' : null,
      error: authenticated ? undefined : error,
    };
  }
}
