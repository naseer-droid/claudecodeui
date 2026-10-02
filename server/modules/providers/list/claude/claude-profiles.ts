import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ProviderModelOption } from '@/shared/types.js';

/**
 * Fork-only: Claude Code "backend profiles".
 *
 * A profile is a Claude settings file in `~/.claude/profiles/<name>.json` with
 * an `env` block (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY,
 * ANTHROPIC_MODEL, ...) plus `label`, optional `aliases` and `models`. The same
 * files drive the `claude <alias>` terminal switch, so the Claude Code harness
 * can run against Kimi, DeepSeek or a plain Anthropic API key per chat.
 *
 * Each profile model is offered as `profile:<name>:<model>`; the Claude runtime
 * overlays the profile env for that turn and passes `<model>` to the SDK.
 */

export const CLAUDE_PROFILE_MODEL_PREFIX = 'profile:';

const CACHE_TTL_MS = 5_000;

type ClaudeProfile = {
  name: string;
  label: string;
  models: string[];
  env: Record<string, string>;
};

let cache: { at: number; dir: string; profiles: ClaudeProfile[] } | null = null;

export const getClaudeProfilesDir = (): string =>
  process.env.CLAUDE_PROFILES_DIR?.trim() || path.join(os.homedir(), '.claude', 'profiles');

const readStringRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
};

/** Exported for tests. Returns null for files that are not usable profiles. */
export const parseClaudeProfile = (name: string, raw: string): ClaudeProfile | null => {
  let parsed: Record<string, unknown>;
  try {
    // Files written by PowerShell may carry a BOM.
    parsed = JSON.parse(raw.replace(/^﻿/, '')) as Record<string, unknown>;
  } catch {
    return null;
  }

  const env = readStringRecord(parsed.env);
  // A profile without a key would fall back to the subscription login, which
  // is exactly what picking an "(API)" model must never do silently.
  if (!env.ANTHROPIC_AUTH_TOKEN?.trim() && !env.ANTHROPIC_API_KEY?.trim()) {
    return null;
  }

  const declared = Array.isArray(parsed.models)
    ? parsed.models.filter((model): model is string => typeof model === 'string' && model.trim() !== '')
    : [];
  const models = [...new Set([env.ANTHROPIC_MODEL, ...declared].filter((model): model is string => Boolean(model?.trim())))];
  if (models.length === 0) {
    return null;
  }

  const label = typeof parsed.label === 'string' && parsed.label.trim() ? parsed.label.trim() : name;
  return { name, label, models, env };
};

export const listClaudeProfiles = (): ClaudeProfile[] => {
  const dir = getClaudeProfilesDir();
  if (cache && cache.dir === dir && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.profiles;
  }

  let profiles: ClaudeProfile[] = [];
  try {
    profiles = readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => {
        try {
          return parseClaudeProfile(path.basename(file, '.json'), readFileSync(path.join(dir, file), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter((profile): profile is ClaudeProfile => profile !== null);
  } catch {
    // No profiles folder: the subscription models are all there is.
  }

  cache = { at: Date.now(), dir, profiles };
  return profiles;
};

export const listClaudeProfileModelOptions = (): ProviderModelOption[] =>
  listClaudeProfiles().flatMap((profile) => profile.models.map((model) => ({
    value: `${CLAUDE_PROFILE_MODEL_PREFIX}${profile.name}:${model}`,
    label: `${profile.label} · ${model} (API)`,
    description: `Claude Code on the ${profile.label} API (${profile.env.ANTHROPIC_BASE_URL || 'Anthropic'}), not the subscription.`,
  })));

/**
 * Resolves `profile:<name>:<model>` to the env overlay and the real model id.
 * Returns null for ordinary model ids and for profiles that no longer exist.
 */
export const resolveClaudeProfileModel = (
  modelId: string | undefined | null,
): { env: Record<string, string>; model: string; profile: string } | null => {
  if (typeof modelId !== 'string' || !modelId.startsWith(CLAUDE_PROFILE_MODEL_PREFIX)) {
    return null;
  }

  const rest = modelId.slice(CLAUDE_PROFILE_MODEL_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator <= 0 || separator === rest.length - 1) {
    return null;
  }

  const name = rest.slice(0, separator);
  const model = rest.slice(separator + 1);
  const profile = listClaudeProfiles().find((entry) => entry.name === name);
  return profile ? { env: profile.env, model, profile: name } : null;
};

/** Exported for tests. */
export const resetClaudeProfilesCache = (): void => {
  cache = null;
};
