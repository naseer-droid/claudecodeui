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
 * Models come live from the profile API's model list (cached 10 min), falling
 * back to the declared `models`. Each profile model is offered as `profile:<name>:<model>`; the Claude runtime
 * overlays the profile env for that turn and passes `<model>` to the SDK.
 */

export const CLAUDE_PROFILE_MODEL_PREFIX = 'profile:';

const CACHE_TTL_MS = 5_000;

type ClaudeProfile = {
  name: string;
  label: string;
  /** Declared models: the fallback when the API's model list can't be read. */
  models: string[];
  /** Optional override for the model-list endpoint. */
  modelsUrl?: string;
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
  const modelsUrl = typeof parsed.modelsUrl === 'string' && parsed.modelsUrl.trim() ? parsed.modelsUrl.trim() : undefined;
  return { name, label, models, modelsUrl, env };
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

const MODELS_CACHE_TTL_MS = 10 * 60_000;
const MODELS_FETCH_TIMEOUT_MS = 5_000;

const liveModelsCache = new Map<string, { at: number; models: string[] }>();

/**
 * Where a profile's API lists its models. Anthropic-style APIs (Anthropic,
 * Kimi Code) answer `<base>/v1/models`; APIs that only mount an Anthropic
 * shim under `/anthropic` (DeepSeek) list models on their OpenAI-style root.
 * Exported for tests.
 */
export const getClaudeProfileModelsUrls = (env: Record<string, string>, modelsUrl?: string): string[] => {
  if (modelsUrl) {
    return [modelsUrl];
  }

  const base = (env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com').replace(/\/+$/, '');
  const urls = [`${base}/v1/models`];
  if (/\/anthropic$/i.test(base)) {
    urls.push(`${base.replace(/\/anthropic$/i, '')}/models`);
  }
  return urls;
};

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

/** Exported for tests. Returns null when no endpoint answered with a model list. */
export const fetchClaudeProfileModels = async (
  profile: ClaudeProfile,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<string[] | null> => {
  const token = profile.env.ANTHROPIC_AUTH_TOKEN?.trim() || profile.env.ANTHROPIC_API_KEY?.trim() || '';
  // Anthropic wants x-api-key, the others Bearer; each ignores the other header.
  const headers = { authorization: `Bearer ${token}`, 'x-api-key': token, 'anthropic-version': '2023-06-01' };
  for (const url of getClaudeProfileModelsUrls(profile.env, profile.modelsUrl)) {
    try {
      const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS) });
      if (!response.ok) {
        continue;
      }
      const body = await response.json() as { data?: { id?: unknown }[] };
      const ids = (body.data ?? [])
        .map((entry) => entry?.id)
        .filter((id): id is string => typeof id === 'string' && id.trim() !== '');
      if (ids.length > 0) {
        return ids;
      }
    } catch {
      // Try the next endpoint; the declared models are the fallback.
    }
  }
  return null;
};

const getProfileModels = async (profile: ClaudeProfile): Promise<string[]> => {
  const cached = liveModelsCache.get(profile.name);
  if (cached && Date.now() - cached.at < MODELS_CACHE_TTL_MS) {
    return cached.models;
  }

  const live = await fetchClaudeProfileModels(profile);
  if (!live) {
    // Keep serving the last good list rather than shrinking to the fallback.
    return cached?.models ?? profile.models;
  }

  // The profile's own default model stays first even if the API omits it.
  const models = [...new Set([...profile.models.slice(0, 1), ...live])];
  liveModelsCache.set(profile.name, { at: Date.now(), models });
  return models;
};

export const listClaudeProfileModelOptions = async (): Promise<ProviderModelOption[]> => {
  const profiles = listClaudeProfiles();
  const modelLists = await Promise.all(profiles.map((profile) => getProfileModels(profile)));
  return profiles.flatMap((profile, index) => modelLists[index].map((model) => ({
    value: `${CLAUDE_PROFILE_MODEL_PREFIX}${profile.name}:${model}`,
    label: `${profile.label} · ${model} (API)`,
    description: `Claude Code on the ${profile.label} API (${profile.env.ANTHROPIC_BASE_URL || 'Anthropic'}), not the subscription.`,
  })));
};

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
  liveModelsCache.clear();
};
