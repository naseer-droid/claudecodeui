import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseFilesInputTag, parseImagesInputTag } from '@/shared/image-attachments.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import {
  createNormalizedMessage,
  generateMessageId,
  normalizeProviderTimestamp,
  readJsonRecord,
  readObjectRecord,
  readOptionalString,
  resolveAntigravityTranscriptPath,
  sliceTailPage,
} from '@/shared/utils.js';

const PROVIDER = 'antigravity';

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

const readUsageNumber = (value: unknown): number => (Number.isFinite(Number(value)) ? Number(value) : 0);

/**
 * Returns the stable tool id of an agy `step_update` for a tool step
 * (`<conversation_id>:<step_index>`), or null for any other event. The ACTIVE
 * and DONE updates of one tool step share it, which is how the result finds
 * its call. Consumed by the Antigravity runtime (to synthesize a missing
 * ACTIVE update) and by `normalizeMessage` below.
 */
export function readAntigravityToolStepId(event: unknown): string | null {
  const step = readObjectRecord(readObjectRecord(event)?.step_update);
  if (!step || step.step_type !== 'tool') {
    return null;
  }

  const conversationId = readOptionalString(step.conversation_id) ?? '';
  const stepIndex = Number(step.step_index);
  return Number.isFinite(stepIndex) ? `agy_${conversationId}_${stepIndex}` : null;
}

/**
 * Extracts the user's own words from an agy USER_INPUT step. agy wraps the
 * prompt as `<USER_REQUEST>…</USER_REQUEST>` followed by metadata blocks
 * (local time, settings changes) that the user never typed.
 */
const readUserRequestText = (content: string): string => {
  const match = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  return match ? match[1] : content.trim();
};

/**
 * Drops the "Created At: … / Completed At: …" header agy prefixes to every
 * tool result in its transcript.
 */
const stripToolResultHeader = (content: string): string =>
  content.replace(/^(?:(?:Created|Completed) At: [^\n]*\n)+/, '');

/**
 * `transcript.jsonl` re-encodes every tool argument as a JSON string
 * (`"\"A\\n\""`); decode those so both transcript copies yield the same input.
 */
const decodeEncodedArgs = (args: AnyRecord): AnyRecord => Object.fromEntries(
  Object.entries(args).map(([key, value]) => {
    if (typeof value !== 'string') {
      return [key, value];
    }
    try {
      return [key, JSON.parse(value)];
    } catch {
      return [key, value];
    }
  }),
);

/**
 * Parses an agy conversation transcript into normalized history messages.
 *
 * - `USER_INPUT` rows are the user's prompts (the `<USER_REQUEST>` body only).
 * - `PLANNER_RESPONSE` rows carry optional `thinking`, `content` (assistant
 *   text) and `tool_calls` (`[{ name, args }]`).
 * - Each `GENERIC` row after a tool call is that call's result (in order);
 *   `status: "ERROR"` / `error` marks a failed tool.
 * - `SYSTEM_MESSAGE` / `ERROR_MESSAGE` rows are agent-internal and skipped.
 *
 * `argsEncoded` is true for `transcript.jsonl`, whose tool arguments are
 * JSON-encoded strings. Exported for tests.
 */
export function parseAntigravityTranscript(
  content: string,
  sessionId: string,
  options: { argsEncoded?: boolean; conversationId?: string } = {},
): NormalizedMessage[] {
  // Tool ids must equal the live stream's (`readAntigravityToolStepId`:
  // native conversation id + the tool step's index) or the chat merges the
  // history row and the live row as two different tools.
  const conversationId = options.conversationId ?? sessionId;
  const messages: NormalizedMessage[] = [];
  const pendingToolCalls: NormalizedMessage[] = [];

  for (const line of content.split(/\r?\n/)) {
    const row = readJsonRecord(line.trim());
    if (!row) {
      continue;
    }

    const rowType = readOptionalString(row.type);
    const stepIndex = Number.isFinite(Number(row.step_index)) ? Number(row.step_index) : messages.length;
    const timestamp = normalizeProviderTimestamp(row.created_at);
    const rowContent = typeof row.content === 'string' ? row.content : '';

    if (rowType === 'USER_INPUT') {
      // Prompts sent with attachments carry <images_input>/<files_input> path
      // lists; strip them for display and surface the paths as attachments.
      const parsedImages = parseImagesInputTag(readUserRequestText(rowContent));
      const parsedFiles = parseFilesInputTag(parsedImages.text);
      if (!parsedFiles.text.trim() && parsedImages.attachments.length === 0 && parsedFiles.attachments.length === 0) {
        continue;
      }

      messages.push(createNormalizedMessage({
        id: `agy_${sessionId}_${stepIndex}`,
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

    if (rowType === 'PLANNER_RESPONSE') {
      const thinking = readOptionalString(row.thinking);
      if (thinking?.trim()) {
        messages.push(createNormalizedMessage({
          id: `agy_${sessionId}_${stepIndex}_thinking`,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'thinking',
          content: thinking,
        }));
      }

      if (rowContent.trim()) {
        messages.push(createNormalizedMessage({
          id: `agy_${sessionId}_${stepIndex}`,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'text',
          role: 'assistant',
          content: rowContent,
        }));
      }

      // A truncated row stores tool_calls as a string; nothing to render then.
      const toolCalls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
      toolCalls.forEach((toolCall, callIndex) => {
        const call = readObjectRecord(toolCall);
        const rawArgs = readObjectRecord(call?.args) ?? {};
        // Each call's result is its own step right after the planner step.
        const toolId = `agy_${conversationId}_${stepIndex + 1 + callIndex}`;
        const toolMessage = createNormalizedMessage({
          id: toolId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'tool_use',
          toolName: readOptionalString(call?.name) ?? 'Tool',
          toolInput: options.argsEncoded ? decodeEncodedArgs(rawArgs) : rawArgs,
          toolId,
        });
        pendingToolCalls.push(toolMessage);
        messages.push(toolMessage);
      });
      continue;
    }

    if (rowType === 'GENERIC') {
      const toolMessage = pendingToolCalls.shift();
      if (!toolMessage) {
        // A result with no call to attach to would render as a raw dump.
        continue;
      }

      const errorText = readOptionalString(row.error);
      toolMessage.toolResult = {
        content: errorText ?? stripToolResultHeader(rowContent),
        isError: row.status === 'ERROR' || Boolean(errorText),
      };
    }
  }

  return messages;
}

/**
 * Antigravity live-stream normalizer and transcript history reader. Consumed
 * by `AntigravityProvider` (runtime context `normalizeMessage` and session
 * routes).
 */
export class AntigravitySessionsProvider implements IProviderSessions {
  /**
   * Normalizes one `agy -p ... --output-format stream-json` stdout event.
   *
   * - `agent_response` steps stream real `text_delta` chunks; the step's DONE
   *   update closes the bubble (`stream_end`) and carries the request's
   *   `usage`, surfaced as a `token_budget` status.
   * - `tool` steps: ACTIVE → `tool_use`, DONE (with `tool_info.output`) →
   *   `tool_result`, both keyed by `readAntigravityToolStepId`.
   * - A `result` whose status is not SUCCESS becomes an `error`.
   * - `init` is consumed by the runtime (conversation id); `user_input` steps
   *   echo the prompt and are dropped.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    const eventSessionId = sessionId ?? '';

    if (raw.event === 'result') {
      const result = readObjectRecord(raw.result);
      const status = readOptionalString(result?.status) ?? '';
      if (status === 'SUCCESS') {
        return [];
      }

      return [createNormalizedMessage({
        sessionId: eventSessionId,
        provider: PROVIDER,
        kind: 'error',
        content: readOptionalString(result?.error) ?? `Antigravity run ended with status ${status || 'unknown'}`,
      })];
    }

    if (raw.event === 'error') {
      return [createNormalizedMessage({
        sessionId: eventSessionId,
        provider: PROVIDER,
        kind: 'error',
        content: readOptionalString(raw.error) ?? readOptionalString(raw.message) ?? 'Unknown Antigravity error',
      })];
    }

    const step = readObjectRecord(raw.step_update);
    if (raw.event !== 'step_update' || !step) {
      return [];
    }

    const stepType = readOptionalString(step.step_type);
    const isActive = step.state === 'ACTIVE';

    if (stepType === 'agent_response') {
      const normalized: NormalizedMessage[] = [];
      const textDelta = typeof step.text_delta === 'string' ? step.text_delta : '';
      if (textDelta) {
        normalized.push(createNormalizedMessage({
          id: generateMessageId('agy'),
          sessionId: eventSessionId,
          provider: PROVIDER,
          kind: 'stream_delta',
          content: textDelta,
        }));
      }

      if (!isActive) {
        normalized.push(createNormalizedMessage({
          sessionId: eventSessionId,
          provider: PROVIDER,
          kind: 'stream_end',
        }));

        const usage = readObjectRecord(step.usage);
        if (usage) {
          const inputTokens = readUsageNumber(usage.input_tokens);
          const outputTokens = readUsageNumber(usage.output_tokens);
          normalized.push(createNormalizedMessage({
            sessionId: eventSessionId,
            provider: PROVIDER,
            kind: 'status',
            text: 'token_budget',
            tokenBudget: {
              used: readUsageNumber(usage.total_tokens) || inputTokens + outputTokens,
              inputTokens,
              outputTokens,
              cacheReadTokens: readUsageNumber(usage.cache_read_tokens),
              breakdown: { input: inputTokens, output: outputTokens },
            },
          }));
        }
      }

      return normalized;
    }

    const toolId = readAntigravityToolStepId(raw);
    if (stepType === 'tool' && toolId) {
      const toolInfo = readObjectRecord(step.tool_info);
      if (isActive) {
        return [createNormalizedMessage({
          sessionId: eventSessionId,
          provider: PROVIDER,
          kind: 'tool_use',
          toolName: readOptionalString(toolInfo?.name) ?? readOptionalString(step.tool_name) ?? 'Tool',
          toolInput: readObjectRecord(toolInfo?.parameters) ?? {},
          toolId,
        })];
      }

      const errorText = readOptionalString(toolInfo?.error) ?? readOptionalString(step.error);
      return [createNormalizedMessage({
        sessionId: eventSessionId,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId,
        content: errorText ?? formatToolContent(toolInfo?.output),
        isError: Boolean(errorText) || (step.state !== 'DONE'),
      })];
    }

    return [];
  }

  /**
   * Loads Antigravity history from the conversation's brain transcript.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    // Brain folders are keyed by the provider-native conversation id, not the
    // app-facing id this method is addressed with.
    const providerSessionId = options.providerSessionId ?? sessionId;
    const empty: FetchHistoryResult = { messages: [], total: 0, hasMore: false, offset: 0, limit: null };

    try {
      const transcriptPath = await resolveAntigravityTranscriptPath(providerSessionId);
      if (!transcriptPath) {
        return empty;
      }

      const content = await readFile(transcriptPath, 'utf8');
      const messages = parseAntigravityTranscript(content, sessionId, {
        argsEncoded: path.basename(transcriptPath) === 'transcript.jsonl',
        conversationId: providerSessionId,
      });
      const normalizedOffset = Math.max(0, offset);
      const normalizedLimit = limit === null ? null : Math.max(0, limit);
      const { page, hasMore } = sliceTailPage(messages, normalizedLimit, normalizedOffset);

      return {
        messages: page,
        total: messages.length,
        hasMore,
        offset: normalizedOffset,
        limit: normalizedLimit,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[AntigravityProvider] Failed to load session ${sessionId}:`, message);
      }
      return empty;
    }
  }
}
