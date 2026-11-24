import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./models-config";

export function getSettingsConfigPath(agentDir: string): string {
  return join(agentDir, "settings.json");
}

export function parseSettingsConfig(text: string): Record<string, unknown> {
  // Pi settings use JSON.parse, unlike models.json. Current Pi also strips a BOM.
  const raw: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!isRecord(raw))
    throw new Error("settings.json must contain a JSON object");
  return raw;
}

export async function readSettingsConfig(
  agentDir: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    return parseSettingsConfig(
      await readFile(getSettingsConfigPath(agentDir), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
