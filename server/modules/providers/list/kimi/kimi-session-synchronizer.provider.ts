import fsSync from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import { sessionsDb } from '@/modules/database/index.js';
import { parseFilesInputTag, parseImagesInputTag } from '@/shared/image-attachments.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import type { KimiSessionIndexEntry } from '@/shared/types.js';
import {
  getKimiWirePath,
  normalizeProviderTimestamp,
  normalizeSessionName,
  readJsonRecord,
  readKimiSessionIndexEntries,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

const FALLBACK_TITLE = 'Untitled Kimi Session';

/**
 * Reads the first real user prompt from a wire log, stopping as soon as it is
 * found so large transcripts are not read in full just to title a session.
 */
const readFirstPromptText = async (wirePath: string): Promise<string | undefined> => {
  const stream = fsSync.createReadStream(wirePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const row = readJsonRecord(line);
      if (row?.type !== 'turn.prompt') {
        continue;
      }

      if (readOptionalString(readObjectRecord(row.origin)?.kind) === 'injection') {
        continue;
      }

      const input = Array.isArray(row.input) ? row.input : [];
      const text = input
        .map((part) => readOptionalString(readObjectRecord(part)?.text) ?? '')
        .join(' ');
      const visibleText = parseFilesInputTag(parseImagesInputTag(text).text).text;
      if (visibleText.trim()) {
        return visibleText;
      }
    }
  } catch {
    return undefined;
  } finally {
    lines.close();
    stream.destroy();
  }

  return undefined;
};

/**
 * Session indexer for Kimi Code's `~/.kimi-code/sessions` folders. Consumed by
 * `KimiProvider` (startup scan and the sessions watcher).
 */
export class KimiSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'kimi' as const;

  /**
   * Scans `session_index.jsonl` and upserts every session whose wire log
   * changed since the last scan.
   */
  async synchronize(since?: Date): Promise<number> {
    const entries = await readKimiSessionIndexEntries();
    let processed = 0;
    for (const entry of entries) {
      try {
        if (await this.upsertEntry(entry, since)) {
          processed += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[KimiProvider] Failed to synchronize session ${entry.sessionId}:`, message);
      }
    }

    return processed;
  }

  /**
   * Handles watcher changes for a session's `wire.jsonl` (new or resumed
   * turn) and for `session_index.jsonl` (newest entry).
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    const baseName = path.basename(filePath);
    const entries = await readKimiSessionIndexEntries();

    if (baseName === 'session_index.jsonl') {
      const newest = entries.at(-1);
      return newest ? this.upsertEntry(newest) : null;
    }

    if (baseName !== 'wire.jsonl') {
      return null;
    }

    // <sessionDir>/agents/main/wire.jsonl
    const sessionDir = path.dirname(path.dirname(path.dirname(filePath)));
    const sessionId = path.basename(sessionDir);
    const indexed = entries.find((entry) => entry.sessionId === sessionId);
    if (indexed) {
      return this.upsertEntry(indexed);
    }

    // The index can lag behind the first write; state.json carries the cwd.
    const state = await this.readState(sessionDir);
    const workDir = readOptionalString(state?.cwd);
    if (!workDir) {
      return null;
    }

    return this.upsertEntry({ sessionId, sessionDir, workDir });
  }

  private async readState(sessionDir: string): Promise<Record<string, unknown> | null> {
    try {
      return readJsonRecord(await readFile(path.join(sessionDir, 'state.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Upserts one Kimi session and returns the canonical app session id, or
   * null when it was skipped (no transcript, or unchanged since `since`).
   */
  private async upsertEntry(entry: KimiSessionIndexEntry, since?: Date): Promise<string | null> {
    const sessionDir = path.normalize(entry.sessionDir);
    const wirePath = getKimiWirePath(sessionDir);
    let wireStats;
    try {
      wireStats = await stat(wirePath);
    } catch {
      return null;
    }

    if (since && wireStats.mtimeMs < since.getTime()) {
      return null;
    }

    const projectPath = path.normalize(entry.workDir);
    const state = await this.readState(sessionDir);
    if (state?.archived === true) {
      return null;
    }

    const pendingAppSession = sessionsDb.getSessionByProviderSessionId(entry.sessionId)
      ?? sessionsDb.getSessionById(entry.sessionId)
      ?? sessionsDb.findLatestPendingAppSession(this.provider, projectPath);
    if (pendingAppSession && !pendingAppSession.provider_session_id) {
      // The watcher can see the new wire.jsonl before the runtime reports the
      // session id (Kimi prints it only when the turn ends). Bind the id to
      // the fresh app row first so no duplicate provider-id row appears.
      sessionsDb.assignProviderSessionId(pendingAppSession.session_id, entry.sessionId);
    }

    const existingSession = sessionsDb.getSessionByProviderSessionId(entry.sessionId)
      ?? sessionsDb.getSessionById(entry.sessionId);
    const existingName = existingSession?.custom_name;

    let nextName: string | undefined;
    if (existingName && existingName !== FALLBACK_TITLE) {
      nextName = existingName;
    } else {
      const customTitle = state?.isCustomTitle === true ? readOptionalString(state.title) : undefined;
      nextName = customTitle ?? await readFirstPromptText(wirePath);
    }

    return sessionsDb.createSession(
      entry.sessionId,
      this.provider,
      projectPath,
      normalizeSessionName(nextName, FALLBACK_TITLE),
      normalizeProviderTimestamp(state?.createdAt ?? wireStats.birthtimeMs),
      normalizeProviderTimestamp(state?.updatedAt ?? wireStats.mtimeMs),
      wirePath,
    );
  }
}
