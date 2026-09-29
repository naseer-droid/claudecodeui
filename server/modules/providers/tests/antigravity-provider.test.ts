import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { AntigravityProviderAuth } from '@/modules/providers/list/antigravity/antigravity-auth.provider.js';
import { AntigravityMcpProvider } from '@/modules/providers/list/antigravity/antigravity-mcp.provider.js';
import { parseAntigravityModelsOutput } from '@/modules/providers/list/antigravity/antigravity-models.provider.js';
import {
  antigravityRuntime,
  buildAntigravityArgs,
  resolveAntigravityPermissionArgs,
} from '@/modules/providers/list/antigravity/antigravity-runtime.provider.js';
import {
  AntigravitySessionSynchronizer,
  readAntigravityConversationSummaries,
} from '@/modules/providers/list/antigravity/antigravity-session-synchronizer.provider.js';
import {
  AntigravitySessionsProvider,
  parseAntigravityTranscript,
  readAntigravityToolStepId,
} from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

// Real agy 1.2.13 output captured on 2026-09-29 (paths replaced by
// C:\work\agyspike): a new turn that writes a file, a turn that reads one, a
// failed run (unknown --model), and one conversation's two on-disk transcripts
// (transcript_full.jsonl and the argument-encoded transcript.jsonl).
const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'antigravity');
const WRITE_TURN_ID = 'a35fd2c3-77f5-4b08-a9dc-32af1569d8f6';
const READ_TURN_ID = 'e35a1352-f902-4868-86d8-882c44cd73ab';

const readFixture = (name: string) => readFile(path.join(FIXTURES_DIR, name), 'utf8');
const readFixtureEvents = async (name: string): Promise<unknown[]> =>
  (await readFixture(name)).split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));

const sessionsProvider = new AntigravitySessionsProvider();

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => nextHomeDir;
  return () => {
    (os as unknown as { homedir: () => string }).homedir = original;
  };
};

/** The subset of agy's conversation_summaries schema the synchronizer reads. */
const SUMMARIES_SCHEMA = `
CREATE TABLE conversation_summaries (
  conversation_id text PRIMARY KEY,
  title text NOT NULL DEFAULT "",
  preview text NOT NULL DEFAULT "",
  step_count integer NOT NULL DEFAULT 0,
  last_modified_time datetime NOT NULL,
  workspace_uris text NOT NULL,
  parent_conversation_id text NOT NULL DEFAULT "",
  nesting_depth integer NOT NULL DEFAULT 0,
  app_data_dir text NOT NULL DEFAULT ""
)`;

/**
 * Creates an isolated `ANTIGRAVITY_CLI_HOME` with the fixture conversation's
 * brain folder and a summaries database, laid out the way agy writes them.
 */
async function createAntigravityHome(workDir: string): Promise<{ home: string; transcriptPath: string; restore: () => void }> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'agy-home-'));
  const logsDir = (id: string) => path.join(home, 'brain', id, '.system_generated', 'logs');
  await mkdir(logsDir(WRITE_TURN_ID), { recursive: true });
  const transcriptPath = path.join(logsDir(WRITE_TURN_ID), 'transcript_full.jsonl');
  await writeFile(transcriptPath, await readFixture('transcript_full.jsonl'));
  await writeFile(path.join(logsDir(WRITE_TURN_ID), 'transcript.jsonl'), await readFixture('transcript.jsonl'));
  // A subagent conversation with its own transcript must stay out of the sidebar.
  await mkdir(logsDir('sub-1'), { recursive: true });
  await writeFile(path.join(logsDir('sub-1'), 'transcript_full.jsonl'), await readFixture('transcript_full.jsonl'));

  const workspaceUris = JSON.stringify([pathToFileURL(workDir).href]);
  const db = new Database(path.join(home, 'conversation_summaries.db'));
  db.exec(SUMMARIES_SCHEMA);
  const insert = db.prepare(`
    INSERT INTO conversation_summaries
      (conversation_id, title, last_modified_time, workspace_uris, parent_conversation_id, nesting_depth, app_data_dir)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(WRITE_TURN_ID, 'Create A.txt File', '2026-09-29 10:46:04.7257073+00:00', workspaceUris, '', 0, 'antigravity-cli');
  insert.run('sub-1', 'Subagent', '2026-09-29 10:46:05+00:00', workspaceUris, WRITE_TURN_ID, 1, 'antigravity-cli');
  insert.run('ide-1', 'IDE chat', '2026-09-29 10:46:06+00:00', workspaceUris, '', 0, 'antigravity');
  insert.run('no-transcript', '', '0001-01-01 00:00:00+00:00', workspaceUris, '', 0, 'antigravity-cli');
  insert.run('no-workspace', 'x', '2026-09-29 10:46:07+00:00', '[]', '', 0, 'antigravity-cli');
  db.close();

  const previous = process.env.ANTIGRAVITY_CLI_HOME;
  process.env.ANTIGRAVITY_CLI_HOME = home;
  return {
    home,
    transcriptPath,
    restore: () => {
      if (previous === undefined) {
        delete process.env.ANTIGRAVITY_CLI_HOME;
      } else {
        process.env.ANTIGRAVITY_CLI_HOME = previous;
      }
    },
  };
}

test('normalizeMessage maps a live agy stream onto deltas, tool_use/tool_result and token budgets', async () => {
  const events = await readFixtureEvents('stream-write-turn.jsonl');
  const messages = events.flatMap((event) => sessionsProvider.normalizeMessage(event, 'app-1'));

  assert.deepEqual(messages.map((message) => message.kind), [
    // step 1: planning step with no text; closes nothing but reports usage
    'stream_end', 'status',
    // step 2: write_to_file ACTIVE then DONE
    'tool_use', 'tool_result',
    // step 3: five real deltas, then DONE with a trailing "\n" delta
    'stream_delta', 'stream_delta', 'stream_delta', 'stream_delta', 'stream_delta', 'stream_delta',
    'stream_end', 'status',
  ]);

  const toolUse = messages[2];
  const toolResult = messages[3];
  assert.equal(toolUse.toolName, 'write_to_file');
  assert.deepEqual(toolUse.toolInput, { TargetFile: 'C:\\work\\agyspike\\a.txt' });
  assert.equal(toolResult.toolId, toolUse.toolId);
  assert.equal(toolResult.isError, false);

  const text = messages.filter((message) => message.kind === 'stream_delta').map((message) => message.content).join('');
  assert.equal(text, 'done. Created [a.txt](file:///C:/work/agyspike/a.txt).\n');

  const budget = messages.at(-1) as NormalizedMessage & { tokenBudget?: Record<string, unknown> };
  assert.equal(budget.text, 'token_budget');
  assert.deepEqual(budget.tokenBudget, {
    used: 15041,
    inputTokens: 14810,
    outputTokens: 231,
    cacheReadTokens: 0,
    breakdown: { input: 14810, output: 231 },
  });
  assert.ok(messages.every((message) => message.provider === 'antigravity' && message.sessionId === 'app-1'));

  const readTurn = (await readFixtureEvents('stream-read-turn.jsonl'))
    .flatMap((event) => sessionsProvider.normalizeMessage(event, 'app-1'));
  assert.equal(readTurn.find((message) => message.kind === 'tool_result')?.content, '2 lines, 16 bytes');

  const failed = (await readFixtureEvents('stream-error.jsonl'))
    .flatMap((event) => sessionsProvider.normalizeMessage(event, 'app-1'));
  assert.deepEqual(failed.map((message) => message.kind), ['error']);
  assert.match(failed[0].content ?? '', /invalid model selection/);
});

test('parseAntigravityTranscript rebuilds both turns from either transcript copy', async () => {
  const full = parseAntigravityTranscript(await readFixture('transcript_full.jsonl'), 'app-1');
  const encoded = parseAntigravityTranscript(await readFixture('transcript.jsonl'), 'app-1', { argsEncoded: true });

  assert.deepEqual(
    full.map((message) => [message.kind, message.role ?? null, message.content ?? message.toolName]),
    [
      ['text', 'user', 'Create a file a.txt containing A, then reply done'],
      ['tool_use', null, 'write_to_file'],
      ['text', 'assistant', 'done. Created [a.txt](file:///C:/work/agyspike/a.txt).'],
      ['text', 'user', 'What file did you just create? one word'],
      // The SYSTEM_MESSAGE step between them is agent-internal.
      ['text', 'assistant', '[a.txt](file:///C:/work/agyspike/a.txt)'],
    ],
  );
  assert.ok(full.every((message) => !String(message.content ?? '').includes('ADDITIONAL_METADATA')));

  const toolUse = full[1];
  assert.deepEqual(toolUse.toolInput, {
    CodeContent: 'A\n',
    Description: 'Create a.txt with content A',
    Overwrite: true,
    TargetFile: 'C:\\work\\agyspike\\a.txt',
    toolAction: 'Creating a.txt',
    toolSummary: 'Create a.txt file',
  });
  assert.equal(toolUse.toolResult?.isError, false);
  assert.match(String(toolUse.toolResult?.content), /^Created file file:\/\/\/C:\/work\/agyspike\/a\.txt with requested content\./);
  assert.equal(full[0].timestamp, '2026-09-29T10:44:44.000Z');

  // transcript.jsonl re-encodes every argument as a JSON string.
  assert.deepEqual(encoded.map((message) => message.content ?? message.toolInput), full.map((message) => message.content ?? message.toolInput));
});

test('fetchHistory reads the brain transcript and pages from the tail', async () => {
  const agyHome = await createAntigravityHome('/work/agyspike');
  try {
    const history = await sessionsProvider.fetchHistory('app-1', { providerSessionId: WRITE_TURN_ID });
    assert.equal(history.total, 5);
    assert.equal(history.hasMore, false);
    assert.equal(history.messages[0].sessionId, 'app-1');

    const page = await sessionsProvider.fetchHistory('app-1', { providerSessionId: WRITE_TURN_ID, limit: 2 });
    assert.deepEqual(page.messages.map((message) => message.role), ['user', 'assistant']);
    assert.equal(page.hasMore, true);

    assert.deepEqual((await sessionsProvider.fetchHistory('app-2', { providerSessionId: 'missing' })).messages, []);
    // Ids are path segments; traversal attempts resolve to nothing.
    assert.deepEqual((await sessionsProvider.fetchHistory('app-3', { providerSessionId: '../brain' })).messages, []);
  } finally {
    agyHome.restore();
    await rm(agyHome.home, { recursive: true, force: true });
  }
});

test('readAntigravityConversationSummaries keeps top-level CLI conversations with a workspace', async () => {
  const workDir = path.join(os.tmpdir(), 'agy-project');
  const agyHome = await createAntigravityHome(workDir);
  try {
    const summaries = readAntigravityConversationSummaries(path.join(agyHome.home, 'conversation_summaries.db'));
    assert.deepEqual(summaries.map((summary) => summary.conversationId), [WRITE_TURN_ID, 'no-transcript']);
    assert.equal(summaries[0].title, 'Create A.txt File');
    assert.equal(path.normalize(summaries[0].workspacePath), path.normalize(workDir));
    assert.equal(summaries[0].lastModifiedTime, '2026-09-29T10:46:04.725Z');
    // agy writes year 0001 for "never".
    assert.equal(summaries[1].lastModifiedTime, null);

    assert.deepEqual(readAntigravityConversationSummaries(path.join(agyHome.home, 'missing.db')), []);
  } finally {
    agyHome.restore();
    await rm(agyHome.home, { recursive: true, force: true });
  }
});

test('AntigravitySessionSynchronizer indexes conversations that have a transcript', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'agy-provider-db-'));
  const workDir = path.join(tempDirectory, 'project');
  const agyHome = await createAntigravityHome(workDir);

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const synchronizer = new AntigravitySessionSynchronizer();
    assert.equal(await synchronizer.synchronize(), 1);

    const row = sessionsDb.getSessionByProviderSessionId(WRITE_TURN_ID);
    assert.equal(row?.provider, 'antigravity');
    assert.equal(row?.custom_name, 'Create A.txt File');
    // The conversation spans brain/<id>/ and the shared index; nothing to delete.
    assert.equal(row?.jsonl_path ?? null, null);

    assert.equal(await synchronizer.synchronizeFile(agyHome.transcriptPath), row?.session_id);
    assert.equal(await synchronizer.synchronizeFile(path.join(agyHome.home, 'cli.log')), null);
    assert.equal(await synchronizer.synchronize(new Date(Date.now() + 60_000)), 0);
  } finally {
    closeConnection();
    agyHome.restore();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(agyHome.home, { recursive: true, force: true });
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('parseAntigravityModelsOutput reads `agy models` id/label lines', () => {
  const parsed = parseAntigravityModelsOutput([
    'Fetching available models...',
    'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
    'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
    'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
    '',
  ].join('\r\n'));

  assert.deepEqual(parsed, {
    OPTIONS: [
      { value: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
      { value: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
      { value: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
    ],
    DEFAULT: 'gemini-3.1-pro-high',
  });
  assert.equal(parseAntigravityModelsOutput('gpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n')?.DEFAULT, 'gpt-oss-120b-medium');
  assert.equal(parseAntigravityModelsOutput('Fetching available models...\n'), null);
});

test('AntigravityProviderAuth treats only a non-trivial Google OAuth file as signed in', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'agy-auth-'));
  const restoreHomeDir = patchHomeDir(home);
  try {
    const auth = new AntigravityProviderAuth();
    assert.equal((await auth.getStatus()).authenticated, false);

    await mkdir(path.join(home, '.gemini'), { recursive: true });
    await writeFile(path.join(home, '.gemini', 'oauth_creds.json'), '{}');
    assert.equal((await auth.getStatus()).authenticated, false);

    await writeFile(path.join(home, '.gemini', 'oauth_creds.json'), JSON.stringify({ refresh_token: 'x'.repeat(400) }));
    const status = await auth.getStatus();
    assert.equal(status.authenticated, true);
    assert.equal(status.provider, 'antigravity');
    assert.equal(status.method, 'credentials_file');
  } finally {
    restoreHomeDir();
    await rm(home, { recursive: true, force: true });
  }
});

test('AntigravityMcpProvider writes ~/.gemini/config/mcp_config.json and reads serverURL too', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-'));
  const restoreHomeDir = patchHomeDir(home);
  try {
    const mcp = new AntigravityMcpProvider();
    await mcp.upsertServer({ name: 'remote', scope: 'user', transport: 'http', url: 'https://example.com/mcp' });
    const configPath = path.join(home, '.gemini', 'config', 'mcp_config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(config.mcpServers.remote, { serverUrl: 'https://example.com/mcp', headers: {} });

    config.mcpServers.ide = { serverURL: 'https://ide.example.com/mcp' };
    await writeFile(configPath, JSON.stringify(config));
    const servers = await mcp.listServersForScope('user');
    assert.deepEqual(servers.map((server) => [server.name, server.transport, server.url]), [
      ['remote', 'http', 'https://example.com/mcp'],
      ['ide', 'http', 'https://ide.example.com/mcp'],
    ]);
    await assert.rejects(mcp.upsertServer({ name: 'p', scope: 'project', transport: 'stdio', command: 'x' }));
  } finally {
    restoreHomeDir();
    await rm(home, { recursive: true, force: true });
  }
});

test('buildAntigravityArgs and resolveAntigravityPermissionArgs produce the headless CLI invocation', () => {
  assert.deepEqual(buildAntigravityArgs({ prompt: 'Hi' }), ['-p', 'Hi', '--output-format', 'stream-json']);
  assert.deepEqual(
    buildAntigravityArgs({ prompt: 'Hi', providerSessionId: WRITE_TURN_ID, model: 'gemini-3.1-pro-low', permissionMode: 'plan' }),
    ['-p', 'Hi', '--output-format', 'stream-json', '--conversation', WRITE_TURN_ID, '--model', 'gemini-3.1-pro-low', '--mode', 'plan'],
  );
  assert.deepEqual(resolveAntigravityPermissionArgs('default'), []);
  assert.deepEqual(resolveAntigravityPermissionArgs(undefined), []);
  assert.deepEqual(resolveAntigravityPermissionArgs('acceptEdits'), ['--mode', 'accept-edits']);
  assert.deepEqual(resolveAntigravityPermissionArgs('plan'), ['--mode', 'plan']);
  assert.deepEqual(resolveAntigravityPermissionArgs('bypassPermissions'), ['--dangerously-skip-permissions']);
});

// ---------------------------
// Runtime tests drive a fake `agy` on PATH that replays a captured stream.

const findEnvKey = (name: string) =>
  Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase()) || name;

async function createFakeAgyExecutable(binDir: string): Promise<void> {
  const scriptPath = path.join(binDir, 'agy.cjs');
  await writeFile(scriptPath, `
const fs = require('node:fs');
if (process.env.AGY_ARGS_CAPTURE) {
  fs.writeFileSync(process.env.AGY_ARGS_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
}
if (process.env.AGY_FAKE_STREAM) {
  process.stdout.write(fs.readFileSync(process.env.AGY_FAKE_STREAM, 'utf8'));
}
if (process.env.AGY_FAKE_FAIL) {
  process.stderr.write('error: invalid model selection\\n');
  process.exit(1);
}
`, 'utf8');

  if (process.platform === 'win32') {
    await writeFile(path.join(binDir, 'agy.cmd'), '@echo off\r\nnode "%~dp0agy.cjs" %*\r\n', 'utf8');
    return;
  }

  const commandPath = path.join(binDir, 'agy');
  await writeFile(commandPath, '#!/bin/sh\nnode "$(dirname "$0")/agy.cjs" "$@"\n', 'utf8');
  await chmod(commandPath, 0o755);
}

async function withFakeAgy(
  env: Record<string, string>,
  runTest: (tempRoot: string) => Promise<void>,
): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agy-cli-live-'));
  const pathKey = findEnvKey('PATH');
  const pathExtKey = findEnvKey('PATHEXT');
  const saved: Record<string, string | undefined> = {
    [pathKey]: process.env[pathKey],
    [pathExtKey]: process.env[pathExtKey],
    AGY_ARGS_CAPTURE: process.env.AGY_ARGS_CAPTURE,
    ...Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]])),
  };

  try {
    await createFakeAgyExecutable(tempRoot);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${saved[pathKey] || ''}`;
    if (process.platform === 'win32') {
      const previousPathExt = saved[pathExtKey];
      // The fake is a .cmd shim; list it ahead of .EXE so it wins over a real agy.exe.
      process.env[pathExtKey] = `.CMD;.COM;.EXE;.BAT${previousPathExt ? `;${previousPathExt}` : ''}`;
    }
    Object.assign(process.env, env);
    process.env.AGY_ARGS_CAPTURE = path.join(tempRoot, 'args.json');
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

test('antigravityRuntime announces the session from the init line before any output', async () => {
  await withFakeAgy({ AGY_FAKE_STREAM: path.join(FIXTURES_DIR, 'stream-write-turn.jsonl') }, async (tempRoot) => {
    const { messages, writer } = createWriter();

    await antigravityRuntime.run(
      'Hi',
      { cwd: tempRoot, model: 'gemini-3.1-pro-high', permissionMode: 'acceptEdits' },
      writer,
      createRuntimeContext(),
    );

    assert.equal(messages[0].kind, 'session_created');
    assert.equal(messages[0].newSessionId, WRITE_TURN_ID);
    assert.equal(writer.sessionId, WRITE_TURN_ID);
    assert.equal(messages.filter((message) => message.kind === 'session_created').length, 1);
    assert.deepEqual(messages.slice(-2).map((message) => message.kind), ['stream_end', 'complete']);
    assert.equal(messages.at(-1)?.sessionId, WRITE_TURN_ID);

    const capture = JSON.parse(await readFile(path.join(tempRoot, 'args.json'), 'utf8'));
    assert.deepEqual(capture.args, [
      '-p', 'Hi', '--output-format', 'stream-json', '--model', 'gemini-3.1-pro-high', '--mode', 'accept-edits',
    ]);
    assert.equal(path.resolve(capture.cwd), path.resolve(tempRoot));
  });
});

test('antigravityRuntime resumes with --conversation and does not re-announce the session', async () => {
  await withFakeAgy({ AGY_FAKE_STREAM: path.join(FIXTURES_DIR, 'stream-read-turn.jsonl') }, async (tempRoot) => {
    const { messages, writer } = createWriter();

    await antigravityRuntime.run(
      'Read note.txt',
      { cwd: tempRoot, sessionId: 'app-1' },
      writer,
      createRuntimeContext({ 'app-1': READ_TURN_ID }),
    );

    assert.equal(messages.some((message) => message.kind === 'session_created'), false);
    assert.equal(messages.find((message) => message.kind === 'tool_result')?.content, '2 lines, 16 bytes');
    assert.equal(messages.at(-1)?.kind, 'complete');
    assert.equal(messages.at(-1)?.sessionId, 'app-1');

    const capture = JSON.parse(await readFile(path.join(tempRoot, 'args.json'), 'utf8'));
    assert.deepEqual(capture.args, ['-p', 'Read note.txt', '--output-format', 'stream-json', '--conversation', READ_TURN_ID]);
  });
});

test('antigravityRuntime synthesizes the tool_use when a tool step arrives already DONE', async () => {
  const tempStream = path.join(os.tmpdir(), `agy-done-only-${process.pid}.jsonl`);
  await writeFile(tempStream, [
    JSON.stringify({ event: 'init', conversation_id: 'conv-1', init: {} }),
    JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-1',
        step_index: 2,
        state: 'DONE',
        step_type: 'tool',
        tool_info: { name: 'list_dir', parameters: { DirectoryPath: '.' }, output: '3 entries' },
      },
    }),
    JSON.stringify({ event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS' } }),
  ].join('\n'));

  try {
    await withFakeAgy({ AGY_FAKE_STREAM: tempStream }, async (tempRoot) => {
      const { messages, writer } = createWriter();
      await antigravityRuntime.run('ls', { cwd: tempRoot }, writer, createRuntimeContext());

      const toolMessages = messages.filter((message) => message.kind === 'tool_use' || message.kind === 'tool_result');
      assert.deepEqual(toolMessages.map((message) => message.kind), ['tool_use', 'tool_result']);
      assert.equal(toolMessages[0].toolId, toolMessages[1].toolId);
      assert.equal(toolMessages[0].toolName, 'list_dir');
      assert.equal(toolMessages[1].content, '3 entries');
    });
  } finally {
    await rm(tempStream, { force: true });
  }
});

test('antigravityRuntime reports a failed run once, from its result line', async () => {
  await withFakeAgy(
    { AGY_FAKE_STREAM: path.join(FIXTURES_DIR, 'stream-error.jsonl'), AGY_FAKE_FAIL: '1' },
    async (tempRoot) => {
      const { messages, writer } = createWriter();

      await assert.rejects(
        antigravityRuntime.run('Hi', { cwd: tempRoot, sessionId: 'app-9', model: 'nope' }, writer, createRuntimeContext()),
        /exited with code 1/,
      );

      const errors = messages.filter((message) => message.kind === 'error');
      assert.equal(errors.length, 1);
      assert.match(errors[0].content ?? '', /not-a-real-model is not recognized/);
      assert.equal(messages.at(-1)?.kind, 'complete');
      assert.equal(messages.some((message) => message.kind === 'stream_end'), false);
      // The failed run's result carries an empty conversation id: no session.
      assert.equal(messages.some((message) => message.kind === 'session_created'), false);
    },
  );
});

test('antigravityRuntime falls back to stderr when a failed run printed no result', async () => {
  await withFakeAgy({ AGY_FAKE_FAIL: '1' }, async (tempRoot) => {
    const { messages, writer } = createWriter();

    await assert.rejects(
      antigravityRuntime.run('Hi', { cwd: tempRoot, sessionId: 'app-8' }, writer, createRuntimeContext()),
      /exited with code 1/,
    );

    const errors = messages.filter((message) => message.kind === 'error');
    assert.equal(errors.length, 1);
    assert.match(errors[0].content ?? '', /invalid model selection/);
  });
});

test('antigravityRuntime.abort returns false for an unknown session', () => {
  assert.equal(antigravityRuntime.abort('no-such-session'), false);
});

test('history tool ids equal the live stream tool ids, so the chat does not show a tool twice', async () => {
  const conversationId = 'a35fd2c3-77f5-4b08-a9dc-32af1569d8f6';
  const liveToolIds = new Set(
    (await readFixture('stream-write-turn.jsonl'))
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => readAntigravityToolStepId(JSON.parse(line)))
      .filter((id): id is string => Boolean(id)),
  );
  const history = parseAntigravityTranscript(await readFixture('transcript_full.jsonl'), 'app-1', { conversationId });
  const historyToolIds = history.filter((message) => message.kind === 'tool_use').map((message) => message.toolId);

  assert.equal(liveToolIds.size, 1);
  assert.deepEqual(historyToolIds, [...liveToolIds]);
});
