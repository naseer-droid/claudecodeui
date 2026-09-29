import type { ChildProcess } from 'node:child_process';

import crossSpawn from 'cross-spawn';

import { readAntigravityToolStepId } from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import {
  appendFilesInputTag,
  appendImagesInputTag,
  normalizeAttachmentDescriptors,
} from '@/shared/image-attachments.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/types.js';
import { createCompleteMessage, createNormalizedMessage, readObjectRecord, readOptionalString } from '@/shared/utils.js';

type AntigravityChildProcess = ChildProcess & { aborted?: boolean; sessionId?: string };

const NOT_INSTALLED_MESSAGE = 'Antigravity CLI (agy) is not installed. Install it from https://antigravity.google/';

/** Stderr kept for the failure message; agy prints nothing there on success. */
const STDERR_TAIL_CHARS = 2000;

const activeAntigravityProcesses = new Map<string, AntigravityChildProcess>();

/**
 * Maps the UI permission mode onto `agy` flags (agy 1.2.13, verified
 * 2026-09-29): `default` keeps agy's own `request-review` mode (no flag),
 * `acceptEdits` → `--mode accept-edits`, `plan` → `--mode plan`, and
 * `bypassPermissions` → `--dangerously-skip-permissions`. Exported for tests.
 */
export function resolveAntigravityPermissionArgs(permissionMode: unknown): string[] {
  if (permissionMode === 'acceptEdits') {
    return ['--mode', 'accept-edits'];
  }
  if (permissionMode === 'plan') {
    return ['--mode', 'plan'];
  }
  if (permissionMode === 'bypassPermissions') {
    return ['--dangerously-skip-permissions'];
  }
  return [];
}

/**
 * Builds the `agy` argument list for one headless turn. Exported for tests.
 */
export function buildAntigravityArgs(input: {
  prompt: string;
  providerSessionId?: string | null;
  model?: string | null;
  permissionMode?: unknown;
}): string[] {
  const args = ['-p', input.prompt, '--output-format', 'stream-json'];
  if (input.providerSessionId) {
    args.push('--conversation', input.providerSessionId);
  }
  if (input.model) {
    args.push('--model', input.model);
  }
  args.push(...resolveAntigravityPermissionArgs(input.permissionMode));
  return args;
}

/**
 * Reads the conversation id agy reports on its FIRST stdout line
 * (`{ event: 'init', conversation_id }`). The final `result` line repeats it
 * and serves as a fallback; a failed run reports it as an empty string.
 */
function readAntigravityConversationId(event: unknown): string | null {
  const record = readObjectRecord(event);
  if (!record) {
    return null;
  }

  if (record.event === 'init') {
    return readOptionalString(record.conversation_id) ?? null;
  }

  if (record.event === 'result') {
    return readOptionalString(readObjectRecord(record.result)?.conversation_id) ?? null;
  }

  return null;
}

async function spawnAntigravity(
  command: string,
  options: AnyRecord,
  ws: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
): Promise<void> {
  const sessionId = readOptionalString(options.sessionId);
  const workingDir = readOptionalString(options.cwd) ?? readOptionalString(options.projectPath) ?? process.cwd();
  // Callers pass the stable app session id; the CLI resumes with the
  // provider-native conversation id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  // Process-map key: the app session id when the caller supplied one, so
  // abort-by-app-id always works.
  const processKey = sessionId || Date.now().toString();
  let capturedSessionId: string | null = providerSessionId;
  let sessionCreatedSent = false;
  let stdoutLineBuffer = '';
  let stderrTail = '';
  let terminalNotificationSent = false;
  let streamErrorSent = false;
  let agyProcess: AntigravityChildProcess | null = null;
  // Exactly one terminal `complete` per run (close and error can both fire).
  let completeSent = false;
  // Tool steps whose ACTIVE update produced a tool_use; a DONE update for any
  // other step gets its tool_use synthesized first so the result can attach.
  const announcedToolIds = new Set<string>();

  const currentSessionId = () => capturedSessionId || sessionId || null;

  const notifyTerminalState = ({ code = null, error = null }: { code?: number | null; error?: unknown } = {}) => {
    if (terminalNotificationSent) {
      return;
    }

    terminalNotificationSent = true;
    // Notifications are app-facing, so they carry the app session id. The
    // notification service is untyped JS, so its args come from `options`.
    const finalSessionId = options.sessionId || capturedSessionId || processKey;
    const sessionSummary = options.sessionSummary ?? null;
    if (code === 0 && !error) {
      notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'antigravity',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        stopReason: 'completed',
      });
      return;
    }

    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'antigravity',
      sessionId: finalSessionId,
      sessionName: sessionSummary,
      error: error || `Antigravity CLI exited with code ${code}`,
    });
  };

  const registerSession = (nextSessionId: string | null) => {
    if (!nextSessionId || capturedSessionId === nextSessionId) {
      return;
    }

    capturedSessionId = nextSessionId;
    // Legacy/direct callers without an app session id re-key the process
    // under the provider-native id once it is known.
    if (!sessionId && agyProcess && processKey !== capturedSessionId) {
      activeAntigravityProcesses.delete(processKey);
      activeAntigravityProcesses.set(capturedSessionId, agyProcess);
    }
    if (agyProcess) {
      agyProcess.sessionId = capturedSessionId;
    }

    ws.setSessionId?.(capturedSessionId);

    if (!providerSessionId && !sessionCreatedSent) {
      sessionCreatedSent = true;
      ws.send(createNormalizedMessage({
        kind: 'session_created',
        newSessionId: capturedSessionId,
        sessionId: capturedSessionId,
        provider: 'antigravity',
      }));
    }
  };

  const sendNormalized = (event: unknown) => {
    for (const message of context.normalizeMessage(event, currentSessionId())) {
      if (message.kind === 'tool_use' && message.toolId) {
        announcedToolIds.add(message.toolId);
      }
      if (message.kind === 'error') {
        streamErrorSent = true;
      }
      ws.send(message);
    }
  };

  const processOutputLine = (line: string) => {
    if (!line.trim()) {
      return;
    }

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      // Non-JSON stdout (warnings, banners) is shown as assistant text rather
      // than silently dropped.
      ws.send(createNormalizedMessage({
        kind: 'stream_delta',
        content: line,
        sessionId: currentSessionId() ?? '',
        provider: 'antigravity',
      }));
      return;
    }

    try {
      registerSession(readAntigravityConversationId(event));

      const record = readObjectRecord(event);
      const step = readObjectRecord(record?.step_update);
      const toolStepId = readAntigravityToolStepId(event);
      if (step && toolStepId && step.state !== 'ACTIVE' && !announcedToolIds.has(toolStepId)) {
        sendNormalized({ ...record, step_update: { ...step, state: 'ACTIVE' } });
      }

      sendNormalized(event);
    } catch (error) {
      const errorContent = error instanceof Error ? error.message : String(error);
      console.error('[Antigravity] Failed to process JSON output:', errorContent);
      ws.send(createNormalizedMessage({
        kind: 'error',
        content: errorContent,
        sessionId: currentSessionId() ?? '',
        provider: 'antigravity',
      }));
    }
  };

  const resolvedModel = await context.resolveResumeModel(sessionId, readOptionalString(options.model));
  const hasAttachments =
    normalizeAttachmentDescriptors(options.images).length > 0
    || normalizeAttachmentDescriptors(options.files).length > 0;
  // Attachments ride along as <images_input>/<files_input> path lists
  // appended to the prompt; the history reader strips the tags back out.
  // agy is a native executable (not a .cmd shim), so newlines survive.
  const prompt = hasAttachments
    ? appendFilesInputTag(appendImagesInputTag(command?.trim() || '', options.images), options.files)
    : command?.trim() || '';
  const args = buildAntigravityArgs({
    prompt,
    providerSessionId,
    model: resolvedModel,
    permissionMode: options.permissionMode,
  });

  await new Promise<void>((resolve, reject) => {
    const child = crossSpawn('agy', args, {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    }) as AntigravityChildProcess;
    agyProcess = child;

    activeAntigravityProcesses.set(processKey, child);
    child.sessionId = processKey;
    child.stdin?.end();

    child.stdout?.on('data', (data: Buffer) => {
      stdoutLineBuffer += data.toString();
      const completeLines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = completeLines.pop() || '';
      for (const line of completeLines) {
        processOutputLine(line.trim());
      }
    });

    // agy's stderr is empty on success and repeats the error on failure; keep
    // a tail for the failure message instead of streaming every line.
    child.stderr?.on('data', (data: Buffer) => {
      stderrTail = (stderrTail + data.toString()).slice(-STDERR_TAIL_CHARS);
    });

    child.on('close', async (code: number | null) => {
      const finalSessionId = sessionId || capturedSessionId || processKey;
      activeAntigravityProcesses.delete(finalSessionId);
      activeAntigravityProcesses.delete(processKey);

      if (stdoutLineBuffer.trim()) {
        processOutputLine(stdoutLineBuffer.trim());
        stdoutLineBuffer = '';
      }

      if (code === 0) {
        ws.send(createNormalizedMessage({ kind: 'stream_end', sessionId: finalSessionId, provider: 'antigravity' }));
      } else if (!child.aborted && !streamErrorSent) {
        // A failed run normally reports its error on the final `result` line;
        // only fall back to stderr when it did not.
        let errorContent = stderrTail.trim()
          || (code === null ? 'Antigravity CLI process was terminated' : `Antigravity CLI exited with code ${code}`);
        if ((code === 127 || code === null) && !(await context.isProviderInstalled())) {
          errorContent = NOT_INSTALLED_MESSAGE;
        }
        ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: finalSessionId, provider: 'antigravity' }));
      }

      // Skipped for aborted runs: abort already sent the aborted complete.
      if (!completeSent && !child.aborted) {
        completeSent = true;
        ws.send(createCompleteMessage({ provider: 'antigravity', sessionId: finalSessionId, exitCode: code }));
      }

      notifyTerminalState({ code });
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(code === null ? 'Antigravity CLI process was terminated' : `Antigravity CLI exited with code ${code}`));
    });

    child.on('error', async (error: Error) => {
      const finalSessionId = sessionId || capturedSessionId || processKey;
      activeAntigravityProcesses.delete(finalSessionId);
      activeAntigravityProcesses.delete(processKey);

      const installed = await context.isProviderInstalled();
      ws.send(createNormalizedMessage({
        kind: 'error',
        content: installed ? error.message : NOT_INSTALLED_MESSAGE,
        sessionId: finalSessionId,
        provider: 'antigravity',
      }));
      if (!completeSent && !child.aborted) {
        completeSent = true;
        ws.send(createCompleteMessage({ provider: 'antigravity', sessionId: finalSessionId, exitCode: 1 }));
      }
      notifyTerminalState({ error });
      reject(error);
    });
  });
}

function abortAntigravitySession(sessionId: string): boolean {
  const child = activeAntigravityProcesses.get(sessionId);
  if (!child) {
    return false;
  }

  // The abort handler sends the terminal complete (aborted: true); flag the
  // process so its close handler does not emit a second one.
  child.aborted = true;
  child.kill('SIGTERM');
  activeAntigravityProcesses.delete(sessionId);
  return true;
}

/**
 * Headless `agy -p` runtime. Consumed by `AntigravityProvider` (provider
 * runtime service: chat websocket, agent API and scheduled messages).
 */
export const antigravityRuntime: IProviderRuntime = {
  run: spawnAntigravity,
  abort: abortAntigravitySession,
};
