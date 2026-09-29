import crossSpawn from 'cross-spawn';

import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import { buildDefaultProviderCurrentActiveModel } from '@/shared/utils.js';

const DEFAULT_ANTIGRAVITY_MODEL = 'gemini-3.1-pro-high';

/**
 * Catalog used when `agy models` cannot be run (not installed, offline,
 * signed out). These are the ids agy 1.2.13 listed on 2026-09-29.
 */
const ANTIGRAVITY_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
    { value: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)' },
    { value: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    { value: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
    { value: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
    { value: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
    { value: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
  ],
  DEFAULT: DEFAULT_ANTIGRAVITY_MODEL,
};

/** `agy models` asks the Antigravity backend, so its answer is cached. */
const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;
const MODELS_COMMAND_TIMEOUT_MS = 20_000;

/**
 * Parses `agy models` output: one `<id>\t<label>` line per model. Lines
 * without a tab (the "Fetching available models..." banner, blank lines) are
 * skipped. The default is `gemini-3.1-pro-high` when listed, otherwise the
 * first model. Returns null when no model line is found. Exported for tests.
 */
export function parseAntigravityModelsOutput(output: string): ProviderModelsDefinition | null {
  const options: ProviderModelOption[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const tabIndex = rawLine.indexOf('\t');
    if (tabIndex <= 0) {
      continue;
    }

    const value = rawLine.slice(0, tabIndex).trim();
    const label = rawLine.slice(tabIndex + 1).trim() || value;
    if (value && !/\s/.test(value) && !options.some((option) => option.value === value)) {
      options.push({ value, label });
    }
  }

  if (options.length === 0) {
    return null;
  }

  const hasDefault = options.some((option) => option.value === DEFAULT_ANTIGRAVITY_MODEL);
  return { OPTIONS: options, DEFAULT: hasDefault ? DEFAULT_ANTIGRAVITY_MODEL : options[0].value };
}

/**
 * Runs `agy models` and resolves its stdout, or null on any failure.
 */
const runAgyModels = (): Promise<string | null> => new Promise((resolve) => {
  let stdout = '';
  let settled = false;
  const finish = (value: string | null) => {
    if (!settled) {
      settled = true;
      resolve(value);
    }
  };

  try {
    const child = crossSpawn('agy', ['models'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(null);
    }, MODELS_COMMAND_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      finish(code === 0 ? stdout : null);
    });
  } catch {
    finish(null);
  }
});

/**
 * Antigravity model catalog read from `agy models`. Consumed by
 * `AntigravityProvider`.
 */
export class AntigravityProviderModels implements IProviderModels {
  private cachedModels: { value: ProviderModelsDefinition; expiresAt: number } | null = null;
  private inFlight: Promise<ProviderModelsDefinition> | null = null;

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    if (this.cachedModels && this.cachedModels.expiresAt > Date.now()) {
      return this.cachedModels.value;
    }

    // Concurrent callers share one `agy models` process.
    this.inFlight ??= (async () => {
      const output = await runAgyModels();
      const parsed = output ? parseAntigravityModelsOutput(output) : null;
      if (parsed) {
        this.cachedModels = { value: parsed, expiresAt: Date.now() + MODELS_CACHE_TTL_MS };
      }
      return parsed ?? ANTIGRAVITY_FALLBACK_MODELS;
    })().finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  async getCurrentActiveModel(_sessionId?: string): Promise<ProviderCurrentActiveModel> {
    // agy transcripts record the model only as a human label inside a
    // settings-change note, so every session reports the catalog default.
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}
