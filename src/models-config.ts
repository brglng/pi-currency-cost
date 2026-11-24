import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ParseError, parseTree, stripComments } from "jsonc-parser";

export function getModelsConfigPath(agentDir: string): string {
  return join(agentDir, "models.json");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function parseModelsConfig(text: string): Record<string, unknown> {
  const source = text.replace(/^\uFEFF/, "");
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, { allowTrailingComma: true });
  if (errors.length > 0 || tree?.type !== "object") {
    throw new Error("models.json must contain a valid JSON object");
  }
  // Match Pi's support for trailing commas without touching string literals.
  // Use JSON.parse for data so object keys such as __proto__ stay own keys.
  const json = stripComments(source, " ").replace(
    /"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,
    (match, tail: string | undefined) => tail ?? match,
  );
  return JSON.parse(json) as Record<string, unknown>;
}

export async function readModelsConfig(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return parseModelsConfig(text);
}
