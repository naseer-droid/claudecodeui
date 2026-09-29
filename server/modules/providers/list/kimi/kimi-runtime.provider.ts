import type { ChildProcess } from 'node:child_process';

import crossSpawn from 'cross-spawn';

import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import {
  appendFilesInputTag,
  appendImagesInputTag,
  normalizeAttachmentDescriptors,
} from '@/shared/image-attachments.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/types.js';
import { createCompleteMessage, createNormalizedMessage, readObjectRecord, readOptionalString } from '@/shared/utils.js';

type KimiChildProcess = ChildProcess & { aborted?: boolean; sessionId?: string };

const NOT_INSTALLED_MESSAGE = 'Kimi Code CLI is not installed. Install it from https://moonshotai.github.io/kimi-code/';

/** Stderr kept for the failure message; Kimi prints nothing there on success. */
const STDERR_TAIL_CHARS = 2000;

const activeKimiProcesses = new Map<string, KimiChildProcess>();

/**
 * Maps the UI permission mode onto `kimi` flags (kimi 2.1.1).
 *
 * Print mode (`-p`) already runs tools without asking, and the CLI rejects
 * `-p` combined with `--plan`, `--auto` or `--yolo` ("Cannot combine --prompt
 * with --plan", verified 2026-09-29), so every mode adds nothing. Exported for
 * tests.
 */
export function resolveKimiPermissionArgs(_permissionMode: unknown): string[] {
  return [];
}

/**
 * Builds the `kimi` argument list for one headless turn. Exported for tests.
 */
export function buildKimiArgs(input: {
  prompt: string;
  providerSessionId?: string | null;
  model?: string | null;
  permissionMode?: unknown;
}): string[] {
  const args = ['-p', input.prompt, '--output-format', 'stream-json'];
  if (input.providerSessionId) {
    args.push('-S', input.providerSessionId);
  }
  if (input.model) {
    args.push('-m', input.model);
  }
  args.push(...resolveKimiPermissionArgs(input.permissionMode));
  return args;
}

/**
 * Reads the provider session id Kimi reports on its final stdout line
 * (`{ role: 'meta', type: 'session.resume_hint', session_id }`).
 */
function readKimiSessionId(event: unknown): string | null {
  const record = readObjectRecord(event);
  if (!record || record.role !== 'meta' || record.type !== 'session.resume_hint') {
    return null;
  }

  return readOptionalString(record.session_id) ?? null;
}

async function spawnKimi(
  command: string,
  options: AnyRecord,
  ws: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
): Promise<void> {
  const sessionId = readOptionalString(options.sessionId);
  const workingDir = readOptionalString(options.cwd) ?? readOptionalString(options.projectPath) ?? process.cwd();
  // Callers pass the stable app session id; the CLI resumes with the
  // provider-native id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  // Process-map key: the app session id when the caller supplied one, so
  // abort-by-app-id always works.
  const processKey = sessionId || Date.now().toString();
  let capturedSessionId: string | null = providerSessionId;
  let sessionCreatedSent = false;
  let stdoutLineBuffer = '';
  let stderrTail = '';
  let terminalNotificationSent = false;
  let kimiProcess: KimiChildProcess | null = null;
  // Exactly one terminal `complete` per run (close and error can both fire).
  let completeSent = false;

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
        provider: 'kimi',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        stopReason: 'completed',
      });
      return;
    }

    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'kimi',
      sessionId: finalSessionId,
      sessionName: sessionSummary,
      error: error || `Kimi Code CLI exited with code ${code}`,
    });
  };

  const registerSession = (nextSessionId: string | null) => {
    if (!nextSessionId || capturedSessionId === nextSessionId) {
      return;
    }

    capturedSessionId = nextSessionId;
    // Legacy/direct callers without an app session id re-key the process
    // under the provider-native id once it is known.
    if (!sessionId && kimiProcess && processKey !== capturedSessionId) {
      activeKimiProcesses.delete(processKey);
      activeKimiProcesses.set(capturedSessionId, kimiProcess);
    }
    if (kimiProcess) {
      kimiProcess.sessionId = capturedSessionId;
    }

    ws.setSessionId?.(capturedSessionId);

    if (!providerSessionId && !sessionCreatedSent) {
      sessionCreatedSent = true;
      ws.send(createNormalizedMessage({
        kind: 'session_created',
        newSessionId: capturedSessionId,
        sessionId: capturedSessionId,
        provider: 'kimi',
      }));
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
        provider: 'kimi',
      }));
      return;
    }

    try {
      registerSession(readKimiSessionId(event));
      for (const message of context.normalizeMessage(event, currentSessionId())) {
        ws.send(message);
      }
    } catch (error) {
      const errorContent = error instanceof Error ? error.message : String(error);
      console.error('[Kimi] Failed to process JSON output:', errorContent);
      ws.send(createNormalizedMessage({
        kind: 'error',
        content: errorContent,
        sessionId: currentSessionId() ?? '',
        provider: 'kimi',
      }));
    }
  };

  const resolvedModel = await context.resolveResumeModel(sessionId, readOptionalString(options.model));
  const hasAttachments =
    normalizeAttachmentDescriptors(options.images).length > 0
    || normalizeAttachmentDescriptors(options.files).length > 0;
  // Attachments ride along as <images_input>/<files_input> path lists
  // appended to the prompt; the history reader strips the tags back out.
  // kimi is a native executable (not a .cmd shim), so newlines survive.
  const prompt = hasAttachments
    ? appendFilesInputTag(appendImagesInputTag(command?.trim() || '', options.images), options.files)
    : command?.trim() || '';
  const args = buildKimiArgs({
    prompt,
    providerSessionId,
    model: resolvedModel,
    permissionMode: options.permissionMode,
  });

  await new Promise<void>((resolve, reject) => {
    const child = crossSpawn('kimi', args, {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    }) as KimiChildProcess;
    kimiProcess = child;

    activeKimiProcesses.set(processKey, child);
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

    // Kimi's stderr is empty on success; keep a tail for the failure message
    // instead of streaming every line as an error bubble.
    child.stderr?.on('data', (data: Buffer) => {
      stderrTail = (stderrTail + data.toString()).slice(-STDERR_TAIL_CHARS);
    });

    child.on('close', async (code: number | null) => {
      const finalSessionId = sessionId || capturedSessionId || processKey;
      activeKimiProcesses.delete(finalSessionId);
      activeKimiProcesses.delete(processKey);

      if (stdoutLineBuffer.trim()) {
        processOutputLine(stdoutLineBuffer.trim());
        stdoutLineBuffer = '';
      }

      if (code === 0) {
        ws.send(createNormalizedMessage({ kind: 'stream_end', sessionId: finalSessionId, provider: 'kimi' }));
      } else if (!child.aborted) {
        let errorContent = stderrTail.trim()
          || (code === null ? 'Kimi Code CLI process was terminated' : `Kimi Code CLI exited with code ${code}`);
        if ((code === 127 || code === null) && !(await context.isProviderInstalled())) {
          errorContent = NOT_INSTALLED_MESSAGE;
        }
        ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: finalSessionId, provider: 'kimi' }));
      }

      // Skipped for aborted runs: abort already sent the aborted complete.
      if (!completeSent && !child.aborted) {
        completeSent = true;
        ws.send(createCompleteMessage({ provider: 'kimi', sessionId: finalSessionId, exitCode: code }));
      }

      notifyTerminalState({ code });
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(code === null ? 'Kimi Code CLI process was terminated' : `Kimi Code CLI exited with code ${code}`));
    });

    child.on('error', async (error: Error) => {
      const finalSessionId = sessionId || capturedSessionId || processKey;
      activeKimiProcesses.delete(finalSessionId);
      activeKimiProcesses.delete(processKey);

      const installed = await context.isProviderInstalled();
      ws.send(createNormalizedMessage({
        kind: 'error',
        content: installed ? error.message : NOT_INSTALLED_MESSAGE,
        sessionId: finalSessionId,
        provider: 'kimi',
      }));
      if (!completeSent && !child.aborted) {
        completeSent = true;
        ws.send(createCompleteMessage({ provider: 'kimi', sessionId: finalSessionId, exitCode: 1 }));
      }
      notifyTerminalState({ error });
      reject(error);
    });
  });
}

function abortKimiSession(sessionId: string): boolean {
  const child = activeKimiProcesses.get(sessionId);
  if (!child) {
    return false;
  }

  // The abort handler sends the terminal complete (aborted: true); flag the
  // process so its close handler does not emit a second one.
  child.aborted = true;
  child.kill('SIGTERM');
  activeKimiProcesses.delete(sessionId);
  return true;
}

/**
 * Headless `kimi -p` runtime. Consumed by `KimiProvider` (provider runtime
 * service: chat websocket, agent API and scheduled messages).
 */
export const kimiRuntime: IProviderRuntime = {
  run: spawnKimi,
  abort: abortKimiSession,
};
