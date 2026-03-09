import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface ClaudexConfig {
  base_url?: string;
  api_key?: string;
  model?: string;
  effort?: string;
}

export const CONFIG_KEYS = ["base_url", "api_key", "model", "effort"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

const configPath = join(homedir(), ".claudex", "config.json");

export function readConfig(): ClaudexConfig {
  try {
    if (!existsSync(configPath)) return {};
    return JSON.parse(readFileSync(configPath, "utf8")) as ClaudexConfig;
  } catch {
    return {};
  }
}

export function writeConfig(config: ClaudexConfig): void {
  const dir = dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function resetConfig(): void {
  try {
    if (existsSync(configPath)) unlinkSync(configPath);
  } catch {
    /* skip */
  }
}
