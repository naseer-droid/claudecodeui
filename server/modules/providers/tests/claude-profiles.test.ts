import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeProviderModels } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  listClaudeProfileModelOptions,
  parseClaudeProfile,
  resetClaudeProfilesCache,
  resolveClaudeProfileModel,
} from '@/modules/providers/list/claude/claude-profiles.js';
import { mapCliOptionsToSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';

type SdkOptions = { model?: string; effort?: string; env: Record<string, string | undefined> };

const KIMI_PROFILE = {
  label: 'Kimi',
  aliases: ['k'],
  models: ['k3', 'kimi-for-coding'],
  env: {
    ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/',
    ANTHROPIC_AUTH_TOKEN: 'sk-kimi-test',
    ANTHROPIC_MODEL: 'k3',
  },
};

async function withProfilesDir(files: Record<string, unknown>, run: () => Promise<void> | void) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-profiles-'));
  const previous = process.env.CLAUDE_PROFILES_DIR;
  try {
    for (const [name, body] of Object.entries(files)) {
      await writeFile(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
    }
    process.env.CLAUDE_PROFILES_DIR = dir;
    resetClaudeProfilesCache();
    await run();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PROFILES_DIR;
    else process.env.CLAUDE_PROFILES_DIR = previous;
    resetClaudeProfilesCache();
    await rm(dir, { recursive: true, force: true });
  }
}

test('profiles without a key or a model are not offered', () => {
  assert.equal(parseClaudeProfile('x', JSON.stringify({ env: { ANTHROPIC_MODEL: 'k3' } })), null);
  assert.equal(parseClaudeProfile('x', JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 't' } })), null);
  assert.equal(parseClaudeProfile('x', 'not json'), null);
  const parsed = parseClaudeProfile('kimi', `﻿${JSON.stringify(KIMI_PROFILE)}`);
  assert.deepEqual(parsed?.models, ['k3', 'kimi-for-coding']);
});

test('profile models are appended to the Claude catalog', async () => {
  await withProfilesDir({ 'kimi.json': KIMI_PROFILE, 'api.json': { env: { ANTHROPIC_API_KEY: '' } }, 'notes.txt': 'x' }, async () => {
    assert.deepEqual(
      listClaudeProfileModelOptions().map((option) => option.value),
      ['profile:kimi:k3', 'profile:kimi:kimi-for-coding'],
    );
    const catalog = await new ClaudeProviderModels().getSupportedModels();
    assert.ok(catalog.OPTIONS.some((option) => option.value === 'opus'));
    assert.equal(catalog.OPTIONS.at(-1)?.value, 'profile:kimi:kimi-for-coding');
    assert.equal(catalog.DEFAULT, 'default');
  });
});

test('a profile model overlays its env and passes the real model id', async () => {
  await withProfilesDir({ 'kimi.json': KIMI_PROFILE }, () => {
    assert.equal(resolveClaudeProfileModel('profile:gone:k3'), null);
    assert.equal(resolveClaudeProfileModel('opus'), null);

    const previousKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'host-key';
    try {
      const sdk = mapCliOptionsToSDK({ model: 'profile:kimi:k3', effort: 'high' }) as SdkOptions;
      assert.equal(sdk.model, 'k3');
      assert.equal(sdk.env.ANTHROPIC_BASE_URL, 'https://api.kimi.com/coding/');
      assert.equal(sdk.env.ANTHROPIC_AUTH_TOKEN, 'sk-kimi-test');
      assert.equal(sdk.env.ANTHROPIC_API_KEY, undefined);
      assert.equal(sdk.effort, undefined);

      const plain = mapCliOptionsToSDK({ model: 'opus' }) as SdkOptions;
      assert.equal(plain.model, 'opus');
      assert.equal(plain.env.ANTHROPIC_AUTH_TOKEN, process.env.ANTHROPIC_AUTH_TOKEN);
      assert.equal(plain.env.ANTHROPIC_API_KEY, 'host-key');
    } finally {
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousKey;
    }
  });
});
