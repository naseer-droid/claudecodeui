import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  getKimiCodeHomePath,
  getKimiWirePath,
  readJsonRecord,
  readKimiSessionIndexEntries,
  readOptionalString,
} from '@/shared/utils.js';

/**
 * Catalog used when `~/.kimi-code/config.toml` is missing or lists no models.
 * These are the aliases a fresh `kimi login` writes (kimi 2.1.1).
 */
const KIMI_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'kimi-code/k3-256k', label: 'K3-256k' },
    { value: 'kimi-code/kimi-for-coding', label: 'Kimi for Coding' },
  ],
  DEFAULT: 'kimi-code/k3-256k',
};

/**
 * Unquotes one TOML string value (`"x"` / `'x'`); returns undefined for any
 * other value shape.
 */
const readTomlString = (rawValue: string): string | undefined => {
  const match = rawValue.trim().match(/^(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/);
  if (!match) {
    return undefined;
  }

  return match[1] !== undefined ? match[1].replace(/\\(["\\])/g, '$1') : match[2];
};

/**
 * Extracts the model aliases from Kimi's `config.toml`.
 *
 * Only the flat subset Kimi writes is understood: top-level `default_model`
 * and `[models."<alias>"]` tables with an optional `display_name`. Anything
 * else is ignored, which keeps this a line scanner instead of a TOML parser.
 * Exported for tests.
 */
export function parseKimiConfigModels(content: string): ProviderModelsDefinition | null {
  const options: ProviderModelOption[] = [];
  let defaultModel: string | undefined;
  let currentSection: string | null = null;
  let currentModel: ProviderModelOption | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      currentModel = null;
      const modelMatch = currentSection.match(/^models\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))$/);
      const alias = modelMatch ? (modelMatch[1] ?? modelMatch[2] ?? modelMatch[3]) : undefined;
      if (alias && !options.some((option) => option.value === alias)) {
        currentModel = { value: alias, label: alias };
        options.push(currentModel);
      }
      continue;
    }

    const keyValueMatch = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!keyValueMatch) {
      continue;
    }

    const [, key, rawValue] = keyValueMatch;
    if (currentSection === null && key === 'default_model') {
      defaultModel = readTomlString(rawValue);
    } else if (currentModel && key === 'display_name') {
      currentModel.label = readTomlString(rawValue) ?? currentModel.label;
    }
  }

  if (options.length === 0) {
    return null;
  }

  const resolvedDefault = defaultModel && options.some((option) => option.value === defaultModel)
    ? defaultModel
    : options[0].value;
  return { OPTIONS: options, DEFAULT: resolvedDefault };
}

/**
 * Finds the last model a Kimi session recorded in its wire log
 * (`usage.record.model`), or undefined when it cannot be read.
 */
const readKimiSessionModel = async (providerSessionId: string): Promise<string | undefined> => {
  const entry = (await readKimiSessionIndexEntries())
    .find((candidate) => candidate.sessionId === providerSessionId);
  if (!entry) {
    return undefined;
  }

  try {
    const content = await readFile(getKimiWirePath(entry.sessionDir), 'utf8');
    const lines = content.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const record = readJsonRecord(lines[index]);
      if (record?.type === 'usage.record') {
        const model = readOptionalString(record.model);
        if (model) {
          return model;
        }
      }
    }
  } catch {
    // Missing or unreadable transcript: fall back to the catalog default.
  }

  return undefined;
};

/**
 * Kimi model catalog read from `config.toml`. Consumed by `KimiProvider`.
 */
export class KimiProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    try {
      const content = await readFile(path.join(getKimiCodeHomePath(), 'config.toml'), 'utf8');
      return parseKimiConfigModels(content) ?? KIMI_FALLBACK_MODELS;
    } catch {
      return KIMI_FALLBACK_MODELS;
    }
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    const models = await this.getSupportedModels();
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(models);
    }

    const sessionModel = await readKimiSessionModel(sessionId.trim());
    return sessionModel ? { model: sessionModel } : buildDefaultProviderCurrentActiveModel(models);
  }
}
