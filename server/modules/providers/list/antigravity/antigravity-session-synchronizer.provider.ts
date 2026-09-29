import fsSync from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import {
  getAntigravityCliHomePath,
  normalizeProviderTimestamp,
  normalizeSessionName,
  readJsonRecord,
  readOptionalString,
  resolveAntigravityTranscriptPath,
} from '@/shared/utils.js';

const FALLBACK_TITLE = 'Untitled Antigravity Session';

/** One top-level row of agy's `conversation_summaries` table. */
type AntigravityConversationSummary = {
  conversationId: string;
  title: string | null;
  workspacePath: string;
  lastModifiedTime: string | null;
};

type ConversationSummaryRow = {
  conversation_id: string | null;
  title: string | null;
  workspace_uris: string | null;
  last_modified_time: string | null;
};

/**
 * Parses agy's SQLite datetime text (`2026-09-29 10:47:42.9008464+00:00`) into
 * an ISO string. agy writes `0001-01-01 …` for "never", which is null here.
 */
const parseAgyTimestamp = (value: string | null | undefined): string | null => {
  if (!value || value.startsWith('0001-')) {
    return null;
  }

  const date = new Date(value.replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * First workspace of a conversation as a filesystem path. agy stores a JSON
 * array of `file:///` URIs; non-file entries are ignored.
 */
const readWorkspacePath = (workspaceUris: string | null): string | null => {
  let uris: unknown;
  try {
    uris = JSON.parse(workspaceUris ?? '[]');
  } catch {
    return null;
  }

  if (!Array.isArray(uris)) {
    return null;
  }

  for (const uri of uris) {
    if (typeof uri === 'string' && uri.startsWith('file:')) {
      try {
        return fileURLToPath(uri);
      } catch {
        // Malformed URI; try the next one.
      }
    }
  }

  return null;
};

/**
 * Lists the user's own top-level CLI conversations from agy's
 * `conversation_summaries.db`, newest first. Subagent conversations
 * (`parent_conversation_id` set / `nesting_depth > 0`), conversations of the
 * Antigravity IDE (`app_data_dir = 'antigravity'`) and rows without a file
 * workspace are left out. A missing or unreadable database yields [].
 * Exported for tests.
 */
export function readAntigravityConversationSummaries(dbPath: string): AntigravityConversationSummary[] {
  if (!fsSync.existsSync(dbPath)) {
    return [];
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare(`
      SELECT conversation_id, title, workspace_uris, last_modified_time
      FROM conversation_summaries
      WHERE parent_conversation_id = ''
        AND nesting_depth = 0
        AND app_data_dir IN ('antigravity-cli', '')
      ORDER BY last_modified_time DESC
    `).all() as ConversationSummaryRow[];

    const summaries: AntigravityConversationSummary[] = [];
    for (const row of rows) {
      const conversationId = readOptionalString(row.conversation_id);
      const workspacePath = readWorkspacePath(row.workspace_uris);
      if (!conversationId || !workspacePath) {
        continue;
      }

      summaries.push({
        conversationId,
        title: readOptionalString(row.title) ?? null,
        workspacePath,
        lastModifiedTime: parseAgyTimestamp(row.last_modified_time),
      });
    }
    return summaries;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[AntigravityProvider] Failed to read conversation summaries:', message);
    return [];
  } finally {
    db?.close();
  }
}

/**
 * Reads the first user request of a transcript for sessions agy has not
 * titled yet.
 */
const readFirstUserRequest = (content: string): string | undefined => {
  for (const line of content.split(/\r?\n/)) {
    const row = readJsonRecord(line.trim());
    if (row?.type !== 'USER_INPUT' || typeof row.content !== 'string') {
      continue;
    }

    const match = row.content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
    const text = match ? match[1] : row.content;
    if (text.trim()) {
      return text;
    }
  }

  return undefined;
};

/**
 * Session indexer for agy conversations. Consumed by `AntigravityProvider`
 * (startup scan and the sessions watcher).
 */
export class AntigravitySessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'antigravity' as const;

  private readSummaries(): AntigravityConversationSummary[] {
    return readAntigravityConversationSummaries(path.join(getAntigravityCliHomePath(), 'conversation_summaries.db'));
  }

  /**
   * Upserts every top-level conversation whose transcript changed since the
   * last scan.
   */
  async synchronize(since?: Date): Promise<number> {
    let processed = 0;
    for (const summary of this.readSummaries()) {
      try {
        if (await this.upsertSummary(summary, since)) {
          processed += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[AntigravityProvider] Failed to synchronize conversation ${summary.conversationId}:`, message);
      }
    }

    return processed;
  }

  /**
   * Handles watcher changes for a conversation transcript
   * (`brain/<id>/.system_generated/logs/transcript*.jsonl`).
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    const baseName = path.basename(filePath);
    if (baseName !== 'transcript_full.jsonl' && baseName !== 'transcript.jsonl') {
      return null;
    }

    // brain/<id>/.system_generated/logs/<file>
    const conversationId = path.basename(path.dirname(path.dirname(path.dirname(filePath))));
    const summary = this.readSummaries().find((candidate) => candidate.conversationId === conversationId);
    // A conversation the index has not listed yet is picked up on its next
    // write; the runtime already bound its id from the stream's init line.
    return summary ? this.upsertSummary(summary) : null;
  }

  /**
   * Upserts one conversation and returns the canonical app session id, or null
   * when it was skipped (no transcript, or unchanged since `since`).
   */
  private async upsertSummary(summary: AntigravityConversationSummary, since?: Date): Promise<string | null> {
    const transcriptPath = await resolveAntigravityTranscriptPath(summary.conversationId);
    if (!transcriptPath) {
      return null;
    }

    const transcriptStats = await stat(transcriptPath);
    if (since && transcriptStats.mtimeMs < since.getTime()) {
      return null;
    }

    const conversationId = summary.conversationId;
    const projectPath = path.normalize(summary.workspacePath);
    const pendingAppSession = sessionsDb.getSessionByProviderSessionId(conversationId)
      ?? sessionsDb.getSessionById(conversationId)
      ?? sessionsDb.findLatestPendingAppSession(this.provider, projectPath);
    if (pendingAppSession && !pendingAppSession.provider_session_id) {
      // Bind the id to a fresh app row before the runtime reports it, so no
      // duplicate provider-id row appears.
      sessionsDb.assignProviderSessionId(pendingAppSession.session_id, conversationId);
    }

    const existingSession = sessionsDb.getSessionByProviderSessionId(conversationId)
      ?? sessionsDb.getSessionById(conversationId);
    const existingName = existingSession?.custom_name;

    let nextName: string | undefined;
    if (existingName && existingName !== FALLBACK_TITLE) {
      nextName = existingName;
    } else {
      nextName = summary.title ?? undefined;
      if (!nextName) {
        try {
          nextName = readFirstUserRequest(await fsSync.promises.readFile(transcriptPath, 'utf8'));
        } catch {
          nextName = undefined;
        }
      }
    }

    // agy spreads one conversation over brain/<id>/ and the shared summaries
    // database, so jsonl_path stays null (as for OpenCode): deleting the app
    // session must not delete one of those files and leave the rest behind.
    return sessionsDb.createSession(
      conversationId,
      this.provider,
      projectPath,
      normalizeSessionName(nextName, FALLBACK_TITLE),
      normalizeProviderTimestamp(transcriptStats.birthtimeMs),
      summary.lastModifiedTime ?? normalizeProviderTimestamp(transcriptStats.mtimeMs),
      null,
    );
  }
}
