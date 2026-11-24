import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { applyEdits, modify, type Node, parseTree } from "jsonc-parser";
import { normalizeCurrencyCode } from "./config";
import { EXTENSION_ID } from "./config-paths";
import { isPositiveFinite, isRecord } from "./models-config";
import { parseSettingsConfig } from "./settings-config";

/**
 * Read a raw config JSON file. Returns undefined when the file does not
 * exist; throws when it exists but is not valid JSON (so callers never
 * silently clobber a corrupt user config).
 */
export async function readRawConfig(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(text) as unknown;
  return isRecord(parsed) ? parsed : undefined;
}

/**
 * Write a config JSON file atomically: write to a sibling temp file, then
 * rename over the target. A failed write leaves the previous file intact and
 * cleans up the temp file.
 */
export async function writeConfigAtomic(
  path: string,
  raw: Record<string, unknown>,
): Promise<void> {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(tmpPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    await rename(tmpPath, path);
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

// Serialize config writes so concurrent refreshes cannot interleave and
// corrupt the file (last writer wins, but every write is complete).
let writeQueue: Promise<unknown> = Promise.resolve();

function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => undefined);
  return run;
}

export interface CurrencyUpdate {
  /** USD per one unit of the currency; replaces the stored `usdRate`. */
  usdRate: number;
  updatedAt: number;
}

/**
 * Merge a currency update into the config file at `path`, preserving all
 * unknown root fields, other currency entries, and unknown fields inside the
 * updated currency entry. Returns the updated root object.
 */
export async function updateWritableConfig(
  path: string,
  currency: string,
  update: CurrencyUpdate,
): Promise<Record<string, unknown>> {
  return enqueueWrite(async () => {
    const existing = (await readRawConfig(path)) ?? {};
    const currencies = isRecord(existing.currencies) ? existing.currencies : {};
    const entry = isRecord(currencies[currency]) ? currencies[currency] : {};
    const nextRoot: Record<string, unknown> = {
      ...existing,
      currencies: {
        ...currencies,
        [currency]: { ...entry, ...update },
      },
    };
    await writeConfigAtomic(path, nextRoot);
    return nextRoot;
  });
}

// Match JSON.parse's last-wins semantics for duplicate properties.
function propertyValue(node: Node | undefined, key: string): Node | undefined {
  return node?.children?.findLast(
    (child) => child.type === "property" && child.children?.[0]?.value === key,
  )?.children?.[1];
}

/** Update only an existing, effective inline rate. Never create settings.json. */
export async function updateInlineRate(
  path: string,
  code: string,
  key: string,
  update: CurrencyUpdate,
): Promise<void> {
  return enqueueWrite(async () => {
    const lock = `${path}.lock`;
    try {
      // Pi uses a sibling lock directory at the configured (unresolved) path.
      // If another writer holds it, leave the configured rate in effect.
      await mkdir(lock);
    } catch {
      throw new Error("Could not lock settings.json to update inline rate");
    }
    try {
      const target = await realpath(path);
      const info = await stat(target);
      if (!info.isFile()) throw new Error();
      const text = await readFile(target, "utf8");
      const raw = parseSettingsConfig(text);
      const settings = raw[EXTENSION_ID];
      const currencies = isRecord(settings) ? settings.currencies : undefined;
      if (!isRecord(currencies)) throw new Error();
      const effective = Object.entries(currencies).findLast(
        ([name, entry]) =>
          normalizeCurrencyCode(name) === code &&
          isRecord(entry) &&
          isPositiveFinite(entry.usdRate),
      );
      if (effective?.[0] !== key) throw new Error();

      const bomLength = text.startsWith("\uFEFF") ? 1 : 0;
      const source = text.slice(bomLength);
      const tree = parseTree(source);
      const entry = propertyValue(
        propertyValue(propertyValue(tree, EXTENSION_ID), "currencies"),
        key,
      );
      const rate = propertyValue(entry, "usdRate");
      if (!entry || !rate) throw new Error();
      const timestamp = propertyValue(entry, "updatedAt");
      const entryText = source.slice(entry.offset, entry.offset + entry.length);
      const edits = [
        {
          offset: rate.offset - entry.offset,
          length: rate.length,
          content: JSON.stringify(update.usdRate),
        },
        ...(timestamp
          ? [
              {
                offset: timestamp.offset - entry.offset,
                length: timestamp.length,
                content: JSON.stringify(update.updatedAt),
              },
            ]
          : modify(entryText, ["updatedAt"], update.updatedAt, {})),
      ];
      const edited =
        text.slice(0, bomLength + entry.offset) +
        applyEdits(entryText, edits) +
        source.slice(entry.offset + entry.length);
      parseSettingsConfig(edited);

      // Stage privately: settings.json may contain sensitive data. Apply the
      // original mode before replacing the file, without changing symlinks.
      const directory = await mkdtemp(
        join(dirname(target), ".pi-currency-cost-"),
      );
      try {
        const tmp = join(directory, "settings.json");
        await writeFile(tmp, edited, { mode: 0o600 });
        await chmod(tmp, info.mode & 0o777);
        if (
          (await realpath(path)) !== target ||
          (await readFile(target, "utf8")) !== text
        ) {
          throw new Error();
        }
        await rename(tmp, target);
      } finally {
        await rm(directory, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    } catch {
      // Parse and filesystem errors may contain sensitive text or paths.
      throw new Error("Could not safely update inline rate in settings.json");
    } finally {
      await rmdir(lock).catch(() => undefined);
    }
  });
}
