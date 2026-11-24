import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EXTENSION_ID } from "./config-paths";
import {
  getModelsConfigPath,
  isPositiveFinite,
  isRecord,
  readModelsConfig,
} from "./models-config";
import { readSettingsConfig } from "./settings-config";

/**
 * One currency entry. `usdRate` is the sole conversion rate (USD per one
 * unit of this currency), required for every configured non-USD currency.
 * It is configured by the user and replaced in place (along with
 * `updatedAt`) when a fresh rate is fetched.
 */
export interface CurrencyRateConfig {
  /** USD per one unit of this currency. Required for every configured non-USD currency. */
  usdRate: number;
  /** Epoch milliseconds when `usdRate` was last set or fetched. */
  updatedAt?: number;
}

/** Per-model currency override inside a provider mapping. */
export interface ProviderModelCurrency {
  currency?: string;
}

/**
 * Provider mapping: the currency Pi-reported usage costs are denominated in.
 * A per-model override wins over the provider-level currency.
 */
export interface ProviderCurrencyConfig {
  currency?: string;
  models?: Record<string, ProviderModelCurrency>;
}

/** Bank of China official spot-rate table (mainland-China reachable). */
export interface BocRateSourceConfig {
  type: "boc";
  timeoutMs?: number;
}

/**
 * Fixed Frankfurter currency converter endpoint: this extension reads
 * `rates.USD` for `base=<CURRENCY>&symbols=USD` (USD per one source unit).
 * The source is built in and cannot be redirected; only the timeout is
 * configurable.
 */
export interface FrankfurterRateSourceConfig {
  type: "frankfurter";
  timeoutMs?: number;
}

export type RateSourceConfig =
  | BocRateSourceConfig
  | FrankfurterRateSourceConfig;

export interface CurrencyCostConfig {
  /** Rates keyed by normalized 3-letter currency code. */
  currencies: Record<string, CurrencyRateConfig>;
  /** Provider → currency mapping. Providers not listed here are never converted. */
  providers: Record<string, ProviderCurrencyConfig>;
  rateSource: RateSourceConfig;
}

export const DEFAULT_CONFIG: CurrencyCostConfig = {
  currencies: {},
  providers: {},
  rateSource: { type: "frankfurter" },
};

export type ConfigWarnings = string[];

export const DEFAULT_TIMEOUT_MS = 8000;
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 60000;
export const USD_CODE = "USD";

const CURRENCY_CODE_RE = /^[A-Z]{3}$/;

/**
 * Object keys that must never be used as config map keys (currency codes,
 * provider IDs, model IDs). Assigning or reading them on a normal object
 * can set or inherit from the prototype chain.
 */
const UNSAFE_CONFIG_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isSafeConfigKey(key: string): boolean {
  return !UNSAFE_CONFIG_KEYS.has(key);
}

/** Uppercase a raw currency code and validate the normalized 3-letter form. */
export function normalizeCurrencyCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toUpperCase();
  return CURRENCY_CODE_RE.test(normalized) ? normalized : undefined;
}

function applyTimeoutMs(
  raw: Record<string, unknown>,
  base: number | undefined,
  warnings: ConfigWarnings,
  sourceLabel = "rateSource",
): number | undefined {
  const value = raw.timeoutMs;
  if (value === undefined) return base;
  if (isPositiveFinite(value)) {
    return Math.min(
      MAX_TIMEOUT_MS,
      Math.max(MIN_TIMEOUT_MS, Math.trunc(value)),
    );
  }
  warnings.push(`${sourceLabel}.timeoutMs must be a positive number; ignoring`);
  return base;
}

/**
 * Derive the single `usdRate` from a raw currency entry. There is no
 * separate fallback/current rate: only `usdRate` is honored. A positive
 * finite number is returned, or undefined when the entry carries no usable
 * rate (a newer config with only a legacy field no longer migrates).
 */
function pickUsdRate(
  raw: Record<string, unknown>,
  warnings: ConfigWarnings,
): number | undefined {
  if (raw.usdRate !== undefined) {
    if (isPositiveFinite(raw.usdRate)) {
      return raw.usdRate;
    }
    warnings.push("usdRate must be a positive number; ignoring");
    return undefined;
  }
  return undefined;
}

function normalizeCurrencyEntry(
  raw: unknown,
  base: CurrencyRateConfig | undefined,
  warnings: ConfigWarnings,
): CurrencyRateConfig {
  const entry: CurrencyRateConfig = base ? { ...base } : { usdRate: NaN };
  if (!isRecord(raw)) {
    warnings.push("currency entries must be objects; ignoring entry");
    return entry;
  }
  const usdRate = pickUsdRate(raw, warnings);
  if (usdRate !== undefined) {
    entry.usdRate = usdRate;
  }
  if (raw.updatedAt !== undefined) {
    if (typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)) {
      entry.updatedAt = raw.updatedAt;
    } else {
      warnings.push("updatedAt must be a finite number; ignoring");
    }
  }
  return entry;
}

function normalizeCurrencies(
  raw: unknown,
  base: Record<string, CurrencyRateConfig>,
  warnings: ConfigWarnings,
): Record<string, CurrencyRateConfig> {
  if (raw === undefined || raw === null) return { ...base };
  if (!isRecord(raw)) {
    warnings.push("currencies must be an object of currency codes; ignoring");
    return { ...base };
  }
  const result: Record<string, CurrencyRateConfig> = { ...base };
  for (const [rawKey, value] of Object.entries(raw)) {
    const code = normalizeCurrencyCode(rawKey);
    if (!code) {
      warnings.push(
        `currency key "${rawKey}" is not a 3-letter code; ignoring`,
      );
      continue;
    }
    result[code] = normalizeCurrencyEntry(value, result[code], warnings);
    if (!isPositiveFinite(result[code].usdRate) && code !== USD_CODE) {
      warnings.push(
        `currency ${code}: a positive usdRate is required; conversions for ${code} will be skipped until one is set`,
      );
    }
  }
  return result;
}

function normalizeProviderEntry(
  raw: unknown,
  base: ProviderCurrencyConfig | undefined,
  warnings: ConfigWarnings,
): ProviderCurrencyConfig {
  const entry: ProviderCurrencyConfig = base ? { ...base } : {};
  if (!isRecord(raw)) {
    warnings.push("provider entries must be objects; ignoring entry");
    return entry;
  }
  if (raw.currency !== undefined) {
    const code = normalizeCurrencyCode(raw.currency);
    if (code) {
      entry.currency = code;
    } else {
      warnings.push("provider currency must be a 3-letter code; ignoring");
    }
  }
  if (raw.models !== undefined) {
    if (isRecord(raw.models)) {
      const models: Record<string, ProviderModelCurrency> = {
        ...(entry.models ?? {}),
      };
      for (const [modelId, modelRaw] of Object.entries(raw.models)) {
        if (!isSafeConfigKey(modelId)) {
          warnings.push(
            `model "${modelId}" ID is a reserved object key; ignoring`,
          );
          continue;
        }
        if (!isRecord(modelRaw)) {
          warnings.push(
            `model "${modelId}" override must be an object; ignoring`,
          );
          continue;
        }
        const merged = { ...(models[modelId] ?? {}) };
        if (modelRaw.currency !== undefined) {
          const code = normalizeCurrencyCode(modelRaw.currency);
          if (code) {
            merged.currency = code;
          } else {
            warnings.push(
              `model "${modelId}" currency must be a 3-letter code; ignoring`,
            );
          }
        }
        models[modelId] = merged;
      }
      entry.models = models;
    } else {
      warnings.push("provider models must be an object of model IDs; ignoring");
    }
  }
  return entry;
}

function normalizeProviders(
  raw: unknown,
  base: Record<string, ProviderCurrencyConfig>,
  warnings: ConfigWarnings,
): Record<string, ProviderCurrencyConfig> {
  if (raw === undefined || raw === null) return { ...base };
  if (!isRecord(raw)) {
    warnings.push("providers must be an object of provider IDs; ignoring");
    return { ...base };
  }
  const result: Record<string, ProviderCurrencyConfig> = { ...base };
  for (const [providerId, value] of Object.entries(raw)) {
    if (providerId.trim() === "") {
      warnings.push("provider IDs must be non-empty strings; ignoring");
      continue;
    }
    if (!isSafeConfigKey(providerId)) {
      warnings.push(
        `provider ID "${providerId}" is a reserved object key; ignoring`,
      );
      continue;
    }
    const entry = normalizeProviderEntry(value, result[providerId], warnings);
    if (entry.currency === undefined && !entry.models) {
      warnings.push(
        `provider "${providerId}": configure a currency or a models map; ignoring`,
      );
      continue;
    }
    result[providerId] = entry;
  }
  return result;
}

function normalizeRateSource(
  raw: unknown,
  base: RateSourceConfig,
  warnings: ConfigWarnings,
): RateSourceConfig {
  if (raw === undefined || raw === null) return base;
  if (raw === "boc") return { ...base, type: "boc" };
  if (raw === "frankfurter") return { ...base, type: "frankfurter" };
  if (!isRecord(raw)) {
    warnings.push(
      'rateSource must be "boc", "frankfurter", or an object with a "type"; keeping previous',
    );
    return base;
  }
  if (raw.type === "boc") {
    return {
      type: "boc",
      timeoutMs: applyTimeoutMs(
        raw,
        base.type === "boc" ? base.timeoutMs : undefined,
        warnings,
      ),
    };
  }
  if (raw.type === "frankfurter") {
    return {
      type: "frankfurter",
      timeoutMs: applyTimeoutMs(
        raw,
        base.type === "frankfurter" ? base.timeoutMs : undefined,
        warnings,
      ),
    };
  }
  if (raw.type === "json") {
    // Custom JSON endpoints were removed; a legacy "json" source warns and
    // falls back to the built-in Frankfurter source.
    warnings.push(
      'rateSource.type "json" is no longer supported (custom JSON endpoints were removed); using "frankfurter"',
    );
    return {
      type: "frankfurter",
      timeoutMs: applyTimeoutMs(
        raw,
        base.type === "frankfurter" ? base.timeoutMs : undefined,
        warnings,
      ),
    };
  }
  warnings.push(
    'rateSource.type must be "boc" or "frankfurter"; keeping previous',
  );
  return base;
}

/**
 * Normalize one raw config object (global or project) onto a base config.
 * Project currency/provider entries merge field-by-field over the global base,
 * so a project may refine a global currency entry without repeating it.
 * Invalid values are skipped and reported as warnings.
 */
export function normalizeConfig(
  raw: unknown,
  base: CurrencyCostConfig = DEFAULT_CONFIG,
): { config: CurrencyCostConfig; warnings: ConfigWarnings } {
  const warnings: ConfigWarnings = [];
  if (raw === undefined || raw === null) {
    return { config: cloneConfig(base), warnings };
  }
  if (!isRecord(raw)) {
    warnings.push("config must be a JSON object; ignoring");
    return { config: cloneConfig(base), warnings };
  }
  const config: CurrencyCostConfig = {
    currencies: normalizeCurrencies(raw.currencies, base.currencies, warnings),
    providers: normalizeProviders(raw.providers, base.providers, warnings),
    rateSource: normalizeRateSource(raw.rateSource, base.rateSource, warnings),
  };
  return { config, warnings };
}

function cloneConfig(config: CurrencyCostConfig): CurrencyCostConfig {
  const currencies: Record<string, CurrencyRateConfig> = {};
  for (const [code, entry] of Object.entries(config.currencies)) {
    currencies[code] = { ...entry };
  }
  const providers: Record<string, ProviderCurrencyConfig> = {};
  for (const [id, entry] of Object.entries(config.providers)) {
    providers[id] = {
      ...entry,
      models: entry.models
        ? Object.fromEntries(
            Object.entries(entry.models).map(([model, override]) => [
              model,
              { ...override },
            ]),
          )
        : undefined,
    };
  }
  return {
    currencies,
    providers,
    rateSource: { ...config.rateSource },
  };
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Never include raw model-file values or keys in configuration warnings. */
function inlineCurrency(value: unknown, warnings: ConfigWarnings) {
  if (value === undefined) return undefined;
  const code = normalizeCurrencyCode(value);
  if (!code)
    warnings.push("models.json: currency must be a 3-letter code; ignoring");
  return code;
}

function applyInlineProviders(
  raw: unknown,
  providers: CurrencyCostConfig["providers"],
  warnings: ConfigWarnings,
): void {
  if (!isRecord(raw)) return;
  for (const [id, provider] of Object.entries(raw)) {
    if (!id.trim() || !isSafeConfigKey(id) || !isRecord(provider)) continue;
    const currency = inlineCurrency(provider.currency, warnings);
    const models: Record<string, ProviderModelCurrency> = {};
    const addModel = (modelId: unknown, value: unknown) => {
      if (
        typeof modelId !== "string" ||
        !modelId.trim() ||
        !isSafeConfigKey(modelId)
      )
        return;
      const code = inlineCurrency(value, warnings);
      if (code) models[modelId] = { currency: code };
    };

    if (Array.isArray(provider.models)) {
      for (const model of provider.models) {
        if (isRecord(model)) addModel(model.id, model.currency);
      }
    }
    if (isRecord(provider.modelOverrides)) {
      for (const [modelId, override] of Object.entries(
        provider.modelOverrides,
      )) {
        if (isRecord(override)) addModel(modelId, override.currency);
      }
    }

    const legacy = Object.hasOwn(providers, id) ? providers[id] : undefined;
    if (currency) {
      // An inline provider default wins even over legacy model mappings.
      providers[id] = { currency, models };
    } else if (Object.keys(models).length > 0) {
      providers[id] = { ...legacy, models: { ...legacy?.models, ...models } };
    }
  }
}

export async function loadConfigWithSources(agentDir: string, cwd: string) {
  const inlineWarnings: ConfigWarnings = [];
  const [globalRaw, projectRaw, models, settingsRaw] = await Promise.all([
    readJson(join(agentDir, "extensions", "pi-currency-cost", "config.json")),
    readJson(join(cwd, ".pi", "extensions", "pi-currency-cost", "config.json")),
    readModelsConfig(getModelsConfigPath(agentDir)).catch(() => {
      inlineWarnings.push(
        "Could not read a valid models.json; ignoring provider/model currency declarations",
      );
      return undefined;
    }),
    readSettingsConfig(agentDir).catch(() => {
      inlineWarnings.push(
        "Could not read a valid settings.json; ignoring pi-currency-cost settings",
      );
      return undefined;
    }),
  ]);
  const global = normalizeConfig(globalRaw);
  const { config, warnings: projectWarnings } = normalizeConfig(
    projectRaw,
    global.config,
  );
  const inlineRateKeys = new Map<string, string>();
  const settings = settingsRaw?.[EXTENSION_ID];

  if (isRecord(settings)) {
    if (isRecord(settings.currencies)) {
      for (const [key, value] of Object.entries(settings.currencies)) {
        const code = normalizeCurrencyCode(key);
        if (!code || !isRecord(value) || !isPositiveFinite(value.usdRate)) {
          inlineWarnings.push(
            "settings.json: inline currency rates require a 3-letter code and positive usdRate; ignoring entry",
          );
          continue;
        }
        const warnings: ConfigWarnings = [];
        const entry = normalizeCurrencyEntry(value, undefined, warnings);
        inlineWarnings.push(
          ...warnings.map((warning) => `settings.json: ${warning}`),
        );
        config.currencies[code] = entry;
        inlineRateKeys.set(code, key);
      }
    } else if (settings.currencies !== undefined) {
      inlineWarnings.push(
        "settings.json: currencies must be an object; ignoring",
      );
    }

    const source = settings.currencyExchangeRateSource;
    if (isRecord(source)) {
      const type = source.type;
      if (type !== undefined && type !== "boc" && type !== "frankfurter") {
        inlineWarnings.push(
          'settings.json: currencyExchangeRateSource.type must be "boc" or "frankfurter"; keeping previous',
        );
      }
      config.rateSource = {
        type:
          type === "boc" || type === "frankfurter"
            ? type
            : config.rateSource.type,
        timeoutMs: applyTimeoutMs(
          source,
          config.rateSource.timeoutMs,
          inlineWarnings,
          "settings.json: currencyExchangeRateSource",
        ),
      };
    } else if (source === "boc" || source === "frankfurter") {
      config.rateSource = { ...config.rateSource, type: source };
    } else if (source !== undefined) {
      inlineWarnings.push(
        "settings.json: invalid currencyExchangeRateSource; keeping previous",
      );
    }
  } else if (settings !== undefined) {
    inlineWarnings.push(
      "settings.json: pi-currency-cost must be an object; ignoring",
    );
  }

  applyInlineProviders(models?.providers, config.providers, inlineWarnings);
  return {
    config,
    warnings: [
      ...global.warnings,
      ...projectWarnings,
      ...new Set(inlineWarnings),
    ],
    inlineRateKeys,
  };
}

/** Load the effective config without exposing internal rate write locations. */
export async function loadConfig(
  agentDir: string,
  cwd: string,
): Promise<{ config: CurrencyCostConfig; warnings: ConfigWarnings }> {
  const { config, warnings } = await loadConfigWithSources(agentDir, cwd);
  return { config, warnings };
}
