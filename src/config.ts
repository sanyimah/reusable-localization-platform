import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import type { ResolvedConfig, ToolkitConfig } from "./types.js";

const CONFIG_NAMES = [
  "i18n-keys.config.ts",
  "i18n-keys.config.mts",
  "i18n-keys.config.js",
  "i18n-keys.config.mjs",
  "i18n-keys.config.cjs",
  "i18n-keys.config.json",
];

export function defineConfig(config: ToolkitConfig): ToolkitConfig {
  return config;
}

function defaultInclude(cwd: string): string[] {
  if (existsSync(path.join(cwd, "ClientApp", "src"))) {
    return ["ClientApp/src/**/*.{js,jsx,ts,tsx}"];
  }
  return ["src/**/*.{js,jsx,ts,tsx}"];
}

export function resolveConfig(raw: ToolkitConfig, cwd: string): ResolvedConfig {
  if (!raw) throw new Error("Config error: expected a configuration object.");
  return {
    ...raw,
    cwd,
    include: raw.include ?? defaultInclude(cwd),
    exclude: raw.exclude ?? [],
    functions: raw.functions ?? ["t"],
    hooks: raw.hooks ?? ["useTranslation"],
    i18nObjects: raw.i18nObjects ?? ["i18n", "i18next"],
    transComponents: raw.transComponents ?? ["Trans"],
    dynamicKeys: raw.dynamicKeys ?? "warn",
    maxKeyLength: raw.maxKeyLength ?? 500,
    mockFile: raw.mockFile ?? ".i18n-keys-mock.json",
    translationsDir: raw.translationsDir ?? "Translations",
  };
}

export async function loadConfig(
  cwd: string,
  explicitPath?: string,
  allowMissing = false,
): Promise<ResolvedConfig> {
  const file = explicitPath
    ? path.resolve(cwd, explicitPath)
    : CONFIG_NAMES.map((n) => path.join(cwd, n)).find((p) => existsSync(p));

  if (!file || !existsSync(file)) {
    if (allowMissing && !explicitPath) return resolveConfig({}, cwd);
    throw new Error(`No config found. Create i18n-keys.config.ts (run \`i18n-keys init\`) in ${cwd}`);
  }

  let raw: ToolkitConfig;
  if (file.endsWith(".json")) {
    raw = JSON.parse(readFileSync(file, "utf8")) as ToolkitConfig;
  } else {
    const jiti = createJiti(import.meta.url);
    raw = (await jiti.import(file, { default: true })) as ToolkitConfig;
  }
  return resolveConfig(raw, cwd);
}