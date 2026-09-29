import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { parseFilesInputTag, parseImagesInputTag } from '@/shared/image-attachments.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import {
  createNormalizedMessage,
  generateMessageId,
  getKimiCodeHomePath,
  getKimiWirePath,
  normalizeProviderTimestamp,
  readJsonRecord,
  readKimiSessionIndexEntries,
  readObjectRecord,
  readOptionalString,
  sliceTailPage,
} from '@/shared/utils.js';

const PROVIDER = 'kimi';

const formatToolContent = (value: unknown): string => {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

/**
 * Reads message text that Kimi may emit either as a plain string or as an
 * OpenAI-style part list (`[{ type: 'text', text }]`).
 */
const readContentText = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (!Array.isArray(value)) {
    return '';
  }

  return value
    .map((part) => {
      const record = readObjectRecord(part);
      return readOptionalString(record?.type) === 'text' ? readOptionalString(record?.text) ?? '' : '';
    })
    .join('');
};

/**
 * Tool arguments arrive as a JSON string in the live stream; parse them so the
 * UI renders the same structured input it gets from history (`args` object).
 */
const parseToolArguments = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value ?? {};
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

/**
 * Token snapshot of the newest `usage.record` row: that row's prompt size
 * (fresh + cached input) is what the context window currently holds.
 */
const buildTokenUsage = (usage: AnyRecord | null): AnyRecord | undefined => {
  if (!usage) {
    return undefined;
  }

  const readNumber = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const inputTokens = readNumber(usage.inputOther)
    + readNumber(usage.inputCacheRead)
    + readNumber(usage.inputCacheCreation);
  const outputTokens = readNumber(usage.output);
  const used = inputTokens + outputTokens;
  if (used <= 0) {
    return undefined;
  }

  return {
    used,
    inputTokens,
    outputTokens,
    breakdown: { input: inputTokens, output: outputTokens },
  };
};

/**
 * Locates a session's `wire.jsonl`: through `session_index.jsonl` first, then
 * by scanning `sessions/<workdir>/<sessionId>/` for sessions the index lost.
 */
const findKimiWirePath = async (providerSessionId: string): Promise<string | null> => {
  const entry = (await readKimiSessionIndexEntries())
    .find((candidate) => candidate.sessionId === providerSessionId);
  if (entry) {
    return getKimiWirePath(entry.sessionDir);
  }

  // Session ids are used as a path segment below; reject anything that could
  // walk out of the sessions directory.
  if (!/^[A-Za-z0-9_-]+$/.test(providerSessionId)) {
    return null;
  }

  const sessionsRoot = path.join(getKimiCodeHomePath(), 'sessions');
  try {
    const workDirs = await readdir(sessionsRoot, { withFileTypes: true });
    for (const workDir of workDirs) {
      if (!workDir.isDirectory()) {
        continue;
      }

      const wirePath = getKimiWirePath(path.join(sessionsRoot, workDir.name, providerSessionId));
      try {
        await access(wirePath);
        return wirePath;
      } catch {
        // Not in this workdir; keep scanning.
      }
    }
  } catch {
    return null;
  }

  return null;
};

/**
 * Parses a Kimi `wire.jsonl` transcript into normalized history messages.
 *
 * - `turn.prompt` rows are the user's prompts (injected system reminders are
 *   `context.append_message` rows with `origin.kind: "injection"` and are
 *   never shown).
 * - `context.append_loop_event` rows carry the assistant side: `content.part`
 *   (`text` / `think`), `tool.call`, and `tool.result`, which is attached to
 *   its `tool.call` the way the other providers' history readers do.
 * - The newest `usage.record` becomes the session's token usage.
 *
 * Exported for tests.
 */
export function parseKimiWireTranscript(
  content: string,
  sessionId: string,
): { messages: NormalizedMessage[]; tokenUsage?: AnyRecord } {
  const messages: NormalizedMessage[] = [];
  const toolMessagesById = new Map<string, NormalizedMessage>();
  let lastUsage: AnyRecord | null = null;

  for (const line of content.split(/\r?\n/)) {
    const row = readJsonRecord(line.trim());
    if (!row) {
      continue;
    }

    const rowType = readOptionalString(row.type);
    const timestamp = normalizeProviderTimestamp(row.time);

    if (rowType === 'usage.record') {
      lastUsage = readObjectRecord(row.usage) ?? lastUsage;
      continue;
    }

    if (rowType === 'turn.prompt') {
      const origin = readObjectRecord(row.origin);
      if (readOptionalString(origin?.kind) === 'injection') {
        continue;
      }

      const rawText = readContentText(row.input);
      // Prompts sent with attachments carry <images_input>/<files_input> path
      // lists; strip them for display and surface the paths as attachments.
      const parsedImages = parseImagesInputTag(rawText);
      const parsedFiles = parseFilesInputTag(parsedImages.text);
      if (!parsedFiles.text.trim() && parsedImages.attachments.length === 0 && parsedFiles.attachments.length === 0) {
        continue;
      }

      messages.push(createNormalizedMessage({
        id: readOptionalString(row.promptId) ?? `kimi_prompt_${messages.length}`,
        sessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'text',
        role: 'user',
        content: parsedFiles.text,
        images: parsedImages.attachments.length > 0 ? parsedImages.attachments : undefined,
        files: parsedFiles.attachments.length > 0 ? parsedFiles.attachments : undefined,
      }));
      continue;
    }

    if (rowType !== 'context.append_loop_event') {
      continue;
    }

    const event = readObjectRecord(row.event);
    const eventType = readOptionalString(event?.type);
    if (!event || !eventType) {
      continue;
    }

    const eventId = readOptionalString(event.uuid) ?? `kimi_event_${messages.length}`;

    if (eventType === 'content.part') {
      const part = readObjectRecord(event.part);
      const partType = readOptionalString(part?.type);
      if (partType === 'text') {
        const text = readOptionalString(part?.text) ?? '';
        if (text.trim()) {
          messages.push(createNormalizedMessage({
            id: eventId,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'text',
            role: 'assistant',
            content: text,
          }));
        }
      } else if (partType === 'think') {
        const thinking = readOptionalString(part?.think) ?? readOptionalString(part?.text) ?? '';
        if (thinking.trim()) {
          messages.push(createNormalizedMessage({
            id: eventId,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'thinking',
            content: thinking,
          }));
        }
      }
      continue;
    }

    if (eventType === 'tool.call') {
      const toolId = readOptionalString(event.toolCallId) ?? eventId;
      const toolMessage = createNormalizedMessage({
        id: eventId,
        sessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: readOptionalString(event.name) ?? 'Tool',
        toolInput: parseToolArguments(event.args),
        toolId,
      });
      toolMessagesById.set(toolId, toolMessage);
      messages.push(toolMessage);
      continue;
    }

    if (eventType === 'tool.result') {
      const toolId = readOptionalString(event.toolCallId);
      const result = readObjectRecord(event.result);
      const isError = result?.isError === true || (result?.error !== undefined && result?.error !== null);
      const resultContent = formatToolContent(result?.output ?? result?.error ?? event.result);
      const toolMessage = toolId ? toolMessagesById.get(toolId) : undefined;
      if (toolMessage) {
        toolMessage.toolResult = { content: resultContent, isError };
      } else {
        messages.push(createNormalizedMessage({
          id: `${eventId}_result`,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'tool_result',
          toolId: toolId ?? eventId,
          content: resultContent,
          isError,
        }));
      }
    }
  }

  return { messages, tokenUsage: buildTokenUsage(lastUsage) };
}

/**
 * Kimi live-stream normalizer and wire-log history reader. Consumed by
 * `KimiProvider` (runtime context `normalizeMessage` and session routes).
 */
export class KimiSessionsProvider implements IProviderSessions {
  /**
   * Normalizes one `kimi -p ... --output-format stream-json` stdout event.
   *
   * Kimi prints whole messages, not token deltas: each assistant text becomes
   * one `stream_delta` immediately closed by a `stream_end`, so text before
   * and after a tool call renders as separate bubbles. `meta` events
   * (`system.version`, `session.resume_hint`) are consumed by the runtime.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    const role = readOptionalString(raw.role);
    const eventSessionId = sessionId ?? '';

    if (role === 'assistant') {
      const normalized: NormalizedMessage[] = [];
      const thinking = readOptionalString(raw.reasoning_content) ?? readOptionalString(raw.think);
      if (thinking?.trim()) {
        normalized.push(createNormalizedMessage({
          sessionId: eventSessionId,
          provider: PROVIDER,
          kind: 'thinking',
          content: thinking,
        }));
      }

      const text = readContentText(raw.content);
      if (text.trim()) {
        normalized.push(createNormalizedMessage({
          id: generateMessageId('kimi'),
          sessionId: eventSessionId,
          provider: PROVIDER,
          kind: 'stream_delta',
          content: text,
        }));
        normalized.push(createNormalizedMessage({
          sessionId: eventSessionId,
          provider: PROVIDER,
          kind: 'stream_end',
        }));
      }

      const toolCalls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
      for (const toolCall of toolCalls) {
        const call = readObjectRecord(toolCall);
        const fn = readObjectRecord(call?.function);
        const toolId = readOptionalString(call?.id) ?? generateMessageId('kimi_tool');
        normalized.push(createNormalizedMessage({
          sessionId: eventSessionId,
          provider: PROVIDER,
          kind: 'tool_use',
          toolName: readOptionalString(fn?.name) ?? 'Tool',
          toolInput: parseToolArguments(fn?.arguments),
          toolId,
        }));
      }

      return normalized;
    }

    if (role === 'tool') {
      return [createNormalizedMessage({
        sessionId: eventSessionId,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: readOptionalString(raw.tool_call_id) ?? '',
        content: formatToolContent(
          typeof raw.content === 'string' || !Array.isArray(raw.content)
            ? raw.content
            : readContentText(raw.content),
        ),
        isError: raw.is_error === true || raw.isError === true,
      })];
    }

    if (role === 'meta') {
      const metaType = readOptionalString(raw.type) ?? '';
      if (metaType.includes('error')) {
        return [createNormalizedMessage({
          sessionId: eventSessionId,
          provider: PROVIDER,
          kind: 'error',
          content: readOptionalString(raw.content) ?? readOptionalString(raw.message) ?? 'Unknown Kimi error',
        })];
      }
    }

    return [];
  }

  /**
   * Loads Kimi history from the session's `wire.jsonl`.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    // Kimi's session folders are keyed by the provider-native id, not the
    // app-facing id this method is addressed with.
    const providerSessionId = options.providerSessionId ?? sessionId;
    const empty: FetchHistoryResult = { messages: [], total: 0, hasMore: false, offset: 0, limit: null };

    try {
      const wirePath = await findKimiWirePath(providerSessionId);
      if (!wirePath) {
        return empty;
      }

      const content = await readFile(wirePath, 'utf8');
      const { messages, tokenUsage } = parseKimiWireTranscript(content, sessionId);
      const normalizedOffset = Math.max(0, offset);
      const normalizedLimit = limit === null ? null : Math.max(0, limit);
      const { page, hasMore } = sliceTailPage(messages, normalizedLimit, normalizedOffset);

      return {
        messages: page,
        total: messages.length,
        hasMore,
        offset: normalizedOffset,
        limit: normalizedLimit,
        tokenUsage,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[KimiProvider] Failed to load session ${sessionId}:`, message);
      }
      return empty;
    }
  }
}
