import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "#src/config";
import { getGlobalConfigPath, getProjectConfigPath } from "#src/config-paths";
import { selectCurrency } from "#src/usage-cost";

describe("inline Pi configuration", () => {
  let root: string;
  let agentDir: string;
  let cwd: string;

  async function write(path: string, text: string) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-currency-cost-inline-"));
    agentDir = join(root, "agent");
    cwd = join(root, "project");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("layers valid inline model and provider currencies above legacy mappings", async () => {
    await write(
      getGlobalConfigPath(agentDir),
      JSON.stringify({
        providers: {
          gateway: { currency: "JPY", models: { legacy: { currency: "CAD" } } },
          builtin: { currency: "CHF", models: { old: { currency: "CAD" } } },
        },
      }),
    );
    await write(
      getProjectConfigPath(cwd),
      JSON.stringify({
        providers: {
          gateway: { currency: "EUR" },
          builtin: { models: { old: { currency: "GBP" } } },
        },
      }),
    );
    await write(
      join(agentDir, "models.json"),
      `{
      // These are Pi provider mappings.
      "providers": {
        "gateway": {
          "currency": " cny ",
          "models": [
            { "id": "custom", "currency": "USD" },
            { "id": "invalid", "currency": "not a currency" },
            { "id": "both", "currency": "CHF" },
          ],
          "modelOverrides": {
            "both": { "currency": "JPY" },
            "custom": { "currency": null },
          },
        },
        "builtin": {
          "currency": 42,
          "modelOverrides": { "special": { "currency": "EUR" } },
        },
      },
    }`,
    );
    const { config } = await loadConfig(agentDir, cwd);
    const currency = (id: string, model: string) =>
      selectCurrency(config.providers, id, model);
    expect(currency("gateway", "custom")).toBe("USD");
    expect(currency("gateway", "invalid")).toBe("CNY");
    expect(currency("gateway", "legacy")).toBe("CNY");
    expect(currency("gateway", "both")).toBe("JPY");
    expect(currency("builtin", "special")).toBe("EUR");
    expect(currency("builtin", "old")).toBe("GBP");
    expect(currency("builtin", "unknown")).toBe("CHF");
  });

  it("uses valid inline rate settings, falls back on invalid ones, and ignores project settings.json", async () => {
    await write(
      getGlobalConfigPath(agentDir),
      JSON.stringify({
        currencies: { CNY: { usdRate: 0.14 }, EUR: { usdRate: 1.1 } },
        rateSource: { type: "boc", timeoutMs: 2500 },
      }),
    );
    await write(
      getProjectConfigPath(cwd),
      JSON.stringify({
        currencies: { CNY: { usdRate: 0.15 }, EUR: { usdRate: 1.2 } },
      }),
    );
    await write(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        "pi-currency-cost": {
          currencies: { EUR: { usdRate: 9 } },
          exchangeRateSource: "frankfurter",
        },
      }),
    );
    await write(
      join(agentDir, "settings.json"),
      JSON.stringify({
        "pi-currency-cost": {
          currencies: {
            " cny ": { usdRate: 0.16, updatedAt: 42 },
            EUR: { usdRate: -1 },
          },
          rateSource: { type: "frankfurter" }, // Legacy field is ignored here.
          exchangeRateSource: { type: "unsupported", timeoutMs: 3500 },
        },
      }),
    );
    const { config, warnings } = await loadConfig(agentDir, cwd);
    expect(config.currencies).toEqual({
      CNY: { usdRate: 0.16, updatedAt: 42 },
      EUR: { usdRate: 1.2 },
    });
    expect(config.rateSource).toEqual({ type: "boc", timeoutMs: 3500 });
    expect(warnings.join()).toContain("settings.json: exchangeRateSource.type");
    expect(warnings.join()).not.toContain("unsupported");
  });

  it("uses exchangeRateSource without a legacy config file", async () => {
    await write(
      join(agentDir, "settings.json"),
      JSON.stringify({
        "pi-currency-cost": { exchangeRateSource: { type: "boc" } },
      }),
    );
    const { config, warnings } = await loadConfig(agentDir, cwd);
    expect(config.rateSource.type).toBe("boc");
    expect(warnings).toEqual([]);
  });

  it("ignores the former inline rate source key", async () => {
    await write(
      join(agentDir, "settings.json"),
      JSON.stringify({
        "pi-currency-cost": {
          currencyExchangeRateSource: { type: "boc", timeoutMs: 1 },
        },
      }),
    );
    const { config, warnings } = await loadConfig(agentDir, cwd);
    expect(config.rateSource.type).toBe("frankfurter");
    expect(config.rateSource.timeoutMs).not.toBe(1);
    expect(warnings).toEqual([]);
  });

  it("ignores the old models.json namespace while still reading model currencies", async () => {
    await write(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: { gateway: { currency: "CNY" } },
        "pi-currency-cost": {
          currencies: { CNY: { usdRate: 0.16 } },
          exchangeRateSource: "boc",
        },
      }),
    );
    await write(
      join(cwd, ".pi", "settings.json"),
      '{"pi-currency-cost":{"currencies":{"EUR":{"usdRate":1.2}}}}',
    );
    const { config, warnings } = await loadConfig(agentDir, cwd);
    expect(config.currencies).toEqual({});
    expect(config.rateSource.type).toBe("frankfurter");
    expect(selectCurrency(config.providers, "gateway", "model")).toBe("CNY");
    expect(warnings).toEqual([]);
  });

  it.each([
    '{"theme":"secret-value",}',
    '{/* secret-value */ "theme":"dark"}',
    '["secret-value"]',
  ])(
    "falls back when settings.json is not a strict JSON object (%s)",
    async (settings) => {
      await write(join(agentDir, "settings.json"), settings);
      await write(
        join(agentDir, "models.json"),
        '{"providers":{"gateway":{"currency":"CNY"}}}',
      );
      await write(
        getGlobalConfigPath(agentDir),
        '{"currencies":{"CNY":{"usdRate":0.14}}}',
      );
      const { config, warnings } = await loadConfig(agentDir, cwd);
      expect(config.currencies.CNY).toEqual({ usdRate: 0.14 });
      expect(selectCurrency(config.providers, "gateway", "model")).toBe("CNY");
      expect(warnings.join()).toContain("settings.json");
      expect(warnings.join()).not.toContain("secret-value");
    },
  );

  it("ignores malformed models.json without including file content in warnings", async () => {
    await write(
      getGlobalConfigPath(agentDir),
      '{"providers":{"gateway":{"currency":"CNY"}}}',
    );
    await write(join(agentDir, "models.json"), '{"apiKey": secret-value}');
    const { config, warnings } = await loadConfig(agentDir, cwd);
    expect(selectCurrency(config.providers, "gateway", "old")).toBe("CNY");
    expect(warnings.join()).toContain("models.json");
    expect(warnings.join()).not.toMatch(/apiKey|secret-value/);
  });
});
