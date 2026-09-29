import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { KimiProviderAuth } from '@/modules/providers/list/kimi/kimi-auth.provider.js';
import { parseKimiConfigModels } from '@/modules/providers/list/kimi/kimi-models.provider.js';
import {
  buildKimiArgs,
  kimiRuntime,
  resolveKimiPermissionArgs,
} from '@/modules/providers/list/kimi/kimi-runtime.provider.js';
import { KimiSessionSynchronizer } from '@/modules/providers/list/kimi/kimi-session-synchronizer.provider.js';
import {
  KimiSessionsProvider,
  parseKimiWireTranscript,
} from '@/modules/providers/list/kimi/kimi-sessions.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

// Real kimi 2.1.1 output captured on 2026-09-29 (paths sanitized):
// a new turn that calls Write, the resumed follow-up turn, and the session's
// on-disk wire.jsonl (system-reminder injections trimmed).
const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'kimi');
const FIXTURE_SESSION_ID = 'session_fdc95079-ce6b-408f-ad43-ecbd4828280d';

const readFixture = (name: string) => readFile(path.join(FIXTURES_DIR, name), 'utf8');
const readFixtureEvents = async (name: string): Promise<unknown[]> =>
  (await readFixture(name)).split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));

const sessionsProvider = new KimiSessionsProvider();

/**
 * Creates an isolated `KIMI_CODE_HOME` holding the fixture session, laid out
 * the way the CLI writes it.
 */
async function createKimiHome(workDir: string): Promise<{ home: string; wirePath: string; restore: () => void }> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kimi-home-'));
  const sessionDir = path.join(home, 'sessions', 'wd_kimispike_b06c8f499c84', FIXTURE_SESSION_ID);
  const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
  await mkdir(path.dirname(wirePath), { recursive: true });
  await writeFile(wirePath, await readFixture('wire.jsonl'));
  const state = JSON.parse(await readFixture('state.json'));
  state.cwd = workDir;
  await writeFile(path.join(sessionDir, 'state.json'), JSON.stringify(state));
  await writeFile(
    path.join(home, 'session_index.jsonl'),
    `${JSON.stringify({ sessionId: 'session_other', sessionDir: path.join(home, 'nope'), workDir })}\n`
      + 'not json\n'
      // Kimi writes forward slashes even on Windows.
      + `${JSON.stringify({ sessionId: FIXTURE_SESSION_ID, sessionDir: sessionDir.replace(/\\/g, '/'), workDir })}\n`,
  );

  const previous = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = home;
  return {
    home,
    wirePath,
    restore: () => {
      if (previous === undefined) {
        delete process.env.KIMI_CODE_HOME;
      } else {
        process.env.KIMI_CODE_HOME = previous;
      }
    },
  };
}

test('normalizeMessage maps a live kimi stream-json turn onto tool_use, tool_result and text', async () => {
  const events = await readFixtureEvents('stream-new-turn.jsonl');
  const messages = events.flatMap((event) => sessionsProvider.normalizeMessage(event, 'app-1'));

  assert.deepEqual(messages.map((message) => message.kind), ['tool_use', 'tool_result', 'stream_delta', 'stream_end']);
  const [toolUse, toolResult, delta] = messages;
  assert.equal(toolUse.toolName, 'Write');
  assert.equal(toolUse.toolId, 'tool_8dbsIXdlCtsk2a7ll0Pf5XP1');
  // The CLI sends arguments as a JSON string; the UI needs the object.
  assert.deepEqual(toolUse.toolInput, { path: 'hi.txt', content: 'hi\n' });
  assert.equal(toolResult.toolId, toolUse.toolId);
  assert.equal(toolResult.content, 'Wrote 3 bytes to hi.txt');
  assert.equal(toolResult.isError, false);
  assert.equal(delta.content, 'done');
  assert.ok(messages.every((message) => message.provider === 'kimi' && message.sessionId === 'app-1'));

  // meta lines (system.version, session.resume_hint) are runtime-only.
  const resumed = (await readFixtureEvents('stream-resumed-turn.jsonl'))
    .flatMap((event) => sessionsProvider.normalizeMessage(event, 'app-1'));
  assert.deepEqual(resumed.map((message) => [message.kind, message.content]), [
    ['stream_delta', 'hi.txt'],
    ['stream_end', undefined],
  ]);
});

test('parseKimiWireTranscript rebuilds both turns, skips injections and reads the newest usage', async () => {
  const { messages, tokenUsage } = parseKimiWireTranscript(await readFixture('wire.jsonl'), 'app-1');

  assert.deepEqual(
    messages.map((message) => [message.kind, message.role ?? null, message.content ?? message.toolName]),
    [
      ['text', 'user', 'Create a file hi.txt containing hi, then reply done'],
      ['thinking', null, 'Simple task: create hi.txt containing "hi". No skill really needed for this trivial file creation. Just do it.'],
      ['tool_use', null, 'Write'],
      ['text', 'assistant', 'done'],
      ['text', 'user', 'What file did you just create? one word'],
      ['text', 'assistant', 'hi.txt'],
    ],
  );
  assert.ok(messages.every((message) => !String(message.content ?? '').includes('system-reminder')));

  const toolUse = messages[2];
  assert.equal(toolUse.toolId, 'tool_8dbsIXdlCtsk2a7ll0Pf5XP1');
  assert.deepEqual(toolUse.toolInput, { path: 'hi.txt', content: 'hi\n' });
  assert.deepEqual(toolUse.toolResult, { content: 'Wrote 3 bytes to hi.txt', isError: false });
  assert.equal(messages[0].id, 'msg_01M3P9MK1ZRACNXEN2M29RY6A6');
  assert.equal(messages[0].timestamp, new Date(1790675930583).toISOString());

  // Newest usage.record: 8964 fresh + 13056 cached input, 15 output.
  assert.deepEqual(tokenUsage, {
    used: 22035,
    inputTokens: 22020,
    outputTokens: 15,
    breakdown: { input: 22020, output: 15 },
  });
});

test('fetchHistory resolves the wire log through session_index.jsonl and pages from the tail', async () => {
  const kimiHome = await createKimiHome('/work/kimispike');
  try {
    const full = await sessionsProvider.fetchHistory('app-1', { providerSessionId: FIXTURE_SESSION_ID });
    assert.equal(full.total, 6);
    assert.equal(full.hasMore, false);
    assert.equal(full.messages[0].sessionId, 'app-1');

    const page = await sessionsProvider.fetchHistory('app-1', { providerSessionId: FIXTURE_SESSION_ID, limit: 2 });
    assert.deepEqual(page.messages.map((message) => message.content), ['What file did you just create? one word', 'hi.txt']);
    assert.equal(page.hasMore, true);

    const missing = await sessionsProvider.fetchHistory('app-2', { providerSessionId: 'session_missing' });
    assert.deepEqual(missing.messages, []);
  } finally {
    kimiHome.restore();
    await rm(kimiHome.home, { recursive: true, force: true });
  }
});

test('KimiSessionSynchronizer indexes sessions with the first prompt as title and wire.jsonl as transcript', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'kimi-provider-db-'));
  const workDir = path.join(tempDirectory, 'project');
  const kimiHome = await createKimiHome(workDir);

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const synchronizer = new KimiSessionSynchronizer();
    assert.equal(await synchronizer.synchronize(), 1);

    const row = sessionsDb.getSessionByProviderSessionId(FIXTURE_SESSION_ID);
    assert.equal(row?.provider, 'kimi');
    assert.equal(row?.custom_name, 'Create a file hi.txt containing hi, then reply done');
    assert.equal(path.normalize(row?.jsonl_path ?? ''), path.normalize(kimiHome.wirePath));

    assert.equal(await synchronizer.synchronizeFile(kimiHome.wirePath), row?.session_id);
    assert.equal(await synchronizer.synchronizeFile(path.join(kimiHome.home, 'config.toml')), null);
  } finally {
    closeConnection();
    kimiHome.restore();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(kimiHome.home, { recursive: true, force: true });
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('parseKimiConfigModels reads model aliases, display names and default_model', () => {
  const parsed = parseKimiConfigModels([
    'default_model = "kimi-code/k3-256k"',
    '',
    '[thinking]',
    'enabled = true',
    '',
    '[models."kimi-code/kimi-for-coding"]',
    'provider = "managed:kimi-code"',
    'display_name = "K2.8 Preview"',
    '',
    '[models."kimi-code/k3-256k"]',
    'display_name = "K3-256k"',
    'support_efforts = [ "low", "high", "max" ]',
  ].join('\n'));

  assert.deepEqual(parsed, {
    OPTIONS: [
      { value: 'kimi-code/kimi-for-coding', label: 'K2.8 Preview' },
      { value: 'kimi-code/k3-256k', label: 'K3-256k' },
    ],
    DEFAULT: 'kimi-code/k3-256k',
  });
  assert.equal(parseKimiConfigModels('[thinking]\nenabled = true\n'), null);
});

test('KimiProviderAuth treats only a non-trivial credentials file as logged in', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kimi-auth-'));
  const previous = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = home;
  try {
    const auth = new KimiProviderAuth();
    assert.equal((await auth.getStatus()).authenticated, false);

    await mkdir(path.join(home, 'credentials'), { recursive: true });
    await writeFile(path.join(home, 'credentials', 'kimi-code.json'), '{}');
    assert.equal((await auth.getStatus()).authenticated, false);

    await writeFile(path.join(home, 'credentials', 'kimi-code.json'), JSON.stringify({ token: 'x'.repeat(400) }));
    const status = await auth.getStatus();
    assert.equal(status.authenticated, true);
    assert.equal(status.provider, 'kimi');
    assert.equal(status.method, 'credentials_file');
  } finally {
    if (previous === undefined) {
      delete process.env.KIMI_CODE_HOME;
    } else {
      process.env.KIMI_CODE_HOME = previous;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test('buildKimiArgs and resolveKimiPermissionArgs produce the headless CLI invocation', () => {
  assert.deepEqual(buildKimiArgs({ prompt: 'Hi' }), ['-p', 'Hi', '--output-format', 'stream-json']);
  assert.deepEqual(
    buildKimiArgs({ prompt: 'Hi', providerSessionId: FIXTURE_SESSION_ID, model: 'kimi-code/k3', permissionMode: 'plan' }),
    ['-p', 'Hi', '--output-format', 'stream-json', '-S', FIXTURE_SESSION_ID, '-m', 'kimi-code/k3'],
  );
  assert.deepEqual(resolveKimiPermissionArgs('plan'), []);
  assert.deepEqual(resolveKimiPermissionArgs('bypassPermissions'), []);
  assert.deepEqual(resolveKimiPermissionArgs('default'), []);
  assert.deepEqual(resolveKimiPermissionArgs(undefined), []);
});

// ---------------------------
// Runtime tests drive a fake `kimi` on PATH that replays a captured stream.

const findEnvKey = (name: string) =>
  Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase()) || name;

async function createFakeKimiExecutable(binDir: string): Promise<void> {
  const scriptPath = path.join(binDir, 'kimi.cjs');
  await writeFile(scriptPath, `
const fs = require('node:fs');
if (process.env.KIMI_ARGS_CAPTURE) {
  fs.writeFileSync(process.env.KIMI_ARGS_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
}
if (process.env.KIMI_FAKE_FAIL) {
  process.stderr.write('LLM provider error: 401 Unauthorized\\n');
  process.exit(1);
}
process.stdout.write(fs.readFileSync(process.env.KIMI_FAKE_STREAM, 'utf8'));
`, 'utf8');

  if (process.platform === 'win32') {
    await writeFile(path.join(binDir, 'kimi.cmd'), '@echo off\r\nnode "%~dp0kimi.cjs" %*\r\n', 'utf8');
    return;
  }

  const commandPath = path.join(binDir, 'kimi');
  await writeFile(commandPath, '#!/bin/sh\nnode "$(dirname "$0")/kimi.cjs" "$@"\n', 'utf8');
  await chmod(commandPath, 0o755);
}

async function withFakeKimi(
  env: Record<string, string>,
  runTest: (tempRoot: string) => Promise<void>,
): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kimi-cli-live-'));
  const pathKey = findEnvKey('PATH');
  const pathExtKey = findEnvKey('PATHEXT');
  const saved: Record<string, string | undefined> = {
    [pathKey]: process.env[pathKey],
    [pathExtKey]: process.env[pathExtKey],
    ...Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]])),
  };

  try {
    await createFakeKimiExecutable(tempRoot);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${saved[pathKey] || ''}`;
    if (process.platform === 'win32') {
      const previousPathExt = saved[pathExtKey];
      process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
        ? previousPathExt
        : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
    }
    Object.assign(process.env, env);
    await runTest(tempRoot);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function createWriter() {
  const messages: NormalizedMessage[] = [];
  const writer = {
    userId: null,
    sessionId: null as string | null,
    send(message: unknown) {
      messages.push(message as NormalizedMessage);
    },
    setSessionId(sessionId: string) {
      this.sessionId = sessionId;
    },
  };
  return { messages, writer };
}

const createRuntimeContext = (providerSessionIds: Record<string, string> = {}): ProviderRuntimeContext => ({
  resolveProviderSessionId: (sessionId) => (sessionId ? providerSessionIds[sessionId] ?? null : null),
  resolveResumeModel: async (_sessionId, requestedModel) => requestedModel || undefined,
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
  normalizeMessage: (raw, sessionId) => sessionsProvider.normalizeMessage(raw, sessionId),
  isProviderInstalled: async () => true,
});

test('kimiRuntime streams a new turn and reports the session id from the resume hint', async () => {
  await withFakeKimi({ KIMI_FAKE_STREAM: path.join(FIXTURES_DIR, 'stream-new-turn.jsonl') }, async (tempRoot) => {
    const argsCapturePath = path.join(tempRoot, 'args.json');
    process.env.KIMI_ARGS_CAPTURE = argsCapturePath;
    const { messages, writer } = createWriter();

    await kimiRuntime.run('Hi', { cwd: tempRoot, model: 'kimi-code/k3-256k' }, writer, createRuntimeContext());

    const kinds = messages.map((message) => message.kind);
    assert.deepEqual(kinds, ['tool_use', 'tool_result', 'stream_delta', 'stream_end', 'session_created', 'stream_end', 'complete']);
    const sessionCreated = messages.find((message) => message.kind === 'session_created');
    assert.equal(sessionCreated?.newSessionId, FIXTURE_SESSION_ID);
    assert.equal(writer.sessionId, FIXTURE_SESSION_ID);
    assert.equal(messages.at(-1)?.sessionId, FIXTURE_SESSION_ID);

    const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
    assert.deepEqual(capture.args, ['-p', 'Hi', '--output-format', 'stream-json', '-m', 'kimi-code/k3-256k']);
    assert.equal(path.resolve(capture.cwd), path.resolve(tempRoot));
    delete process.env.KIMI_ARGS_CAPTURE;
  });
});

test('kimiRuntime resumes with -S and does not re-announce the session', async () => {
  await withFakeKimi({ KIMI_FAKE_STREAM: path.join(FIXTURES_DIR, 'stream-resumed-turn.jsonl') }, async (tempRoot) => {
    const argsCapturePath = path.join(tempRoot, 'args.json');
    process.env.KIMI_ARGS_CAPTURE = argsCapturePath;
    const { messages, writer } = createWriter();

    await kimiRuntime.run(
      'What file?',
      { cwd: tempRoot, sessionId: 'app-1' },
      writer,
      createRuntimeContext({ 'app-1': FIXTURE_SESSION_ID }),
    );

    assert.equal(messages.some((message) => message.kind === 'session_created'), false);
    assert.equal(messages.find((message) => message.kind === 'stream_delta')?.content, 'hi.txt');
    assert.equal(messages.at(-1)?.kind, 'complete');
    assert.equal(messages.at(-1)?.sessionId, 'app-1');

    const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
    assert.deepEqual(capture.args, ['-p', 'What file?', '--output-format', 'stream-json', '-S', FIXTURE_SESSION_ID]);
    delete process.env.KIMI_ARGS_CAPTURE;
  });
});

test('kimiRuntime turns a non-zero exit into an error carrying the stderr tail', async () => {
  await withFakeKimi({ KIMI_FAKE_STREAM: '', KIMI_FAKE_FAIL: '1' }, async (tempRoot) => {
    const { messages, writer } = createWriter();

    await assert.rejects(
      kimiRuntime.run('Hi', { cwd: tempRoot, sessionId: 'app-9' }, writer, createRuntimeContext()),
      /exited with code 1/,
    );

    const error = messages.find((message) => message.kind === 'error');
    assert.match(error?.content ?? '', /401 Unauthorized/);
    assert.equal(messages.at(-1)?.kind, 'complete');
    assert.equal(messages.some((message) => message.kind === 'stream_end'), false);
  });
});

test('kimiRuntime.abort returns false for an unknown session', () => {
  assert.equal(kimiRuntime.abort('no-such-session'), false);
});
