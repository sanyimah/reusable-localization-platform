#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import dotenv from "dotenv";
import path from "node:path";
import readline from "node:readline";
import { changedFiles, scanProject } from "./scanner.js";
import { loadConfig } from "./config.js";
import { diffKeys } from "./differ.js";
import { createHttpAdapter } from "./http-adapter.js";
import { createMockAdapter } from "./mock-adapter.js";
import {
  printDiff,
  printRegister,
  printScan,
  writeMissingTranslations,
  writeJsonReport,
} from "./report.js";
import { registerKeys } from "./registrar.js";
import type { ApiAdapter, RegisterSummary, ResolvedConfig } from "./types.js";

const HELP = `i18n-keys - find i18next keys in source and register missing ones

Usage:
  i18n-keys generate [options]   Scan t() strings in source, review English (en-GB) in en.json, translate missing strings (each string across all locales), and write locale files
  i18n-keys scan  [options]     Discover keys. No network.
  i18n-keys check [options]     Scan + compare with the API. Never writes.
  i18n-keys sync  [options]     Scan + compare + register missing keys.
  i18n-keys init                Create a starter i18n-keys.config.ts

Options:
  --config <file>   Config path (default: i18n-keys.config.*)
  --translations-dir <dir> Output directory for generated locale JSON files
  --since <ref>     Only scan files changed since a git ref (requires a git repo)
  --staged          Only scan git-staged files (requires a git repo)
  --apply           (sync) Actually POST. Without it, sync is a dry run.
  --limit <n>       (sync) Register at most n keys this run
  --yes             (sync --apply) Skip the TTY confirmation prompt
  --mock            Use the local JSON mock instead of the real API
  --fail-on-missing (check, sync) Exit 1 if keys are still missing afterwards
  --json <file>     Write a JSON report
  --export-missing <file> Write missing keys as en/fr/zh/es/de/it/pt dictionaries
  --list            (scan) Print every discovered key
  --verbose         Don't truncate long lists
  --locations       (scan --list) Show file:line for each keyks
  --filter <text>   (scan --list) Only keys containing text
`;

const TEMPLATE = `import { defineConfig } from "swd-translation-checker";

export default defineConfig({
  include: ["src/**/*.{js,jsx,ts,tsx}"],
  exclude: ["**/*.test.*", "**/*.stories.*"],
  dynamicKeys: "warn", // "warn" | "error" | "ignore"
  translationsDir: "Translations",
});
`;

const VALUE_FLAGS = new Set([
  "config",
  "since",
  "limit",
  "json",
  "filter",
  "export-missing",
  "translations-dir",
]);

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (eq !== -1) flags[name] = a.slice(eq + 1);
    else if (
      VALUE_FLAGS.has(name) &&
      argv[i + 1] &&
      !argv[i + 1].startsWith("--")
    )
      flags[name] = argv[++i];
    else flags[name] = true;
  }
  return { flags, positional };
}

function pickAdapter(cfg: ResolvedConfig, useMock: boolean): ApiAdapter {
  if (useMock) return createMockAdapter(path.resolve(cfg.cwd, cfg.mockFile));
  if (cfg.adapter) return cfg.adapter;
  if (cfg.api) return createHttpAdapter(cfg.api);
  throw new Error(
    "No API configured. Set `api` (or `adapter`) in your config, or use --mock.",
  );
}

async function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function configureTranslationSetup(): Promise<{ skipTranslation: boolean }> {
  const choice = (
    await ask(
      "\nTranslation setup: [Enter] default MyMemory, [c] configure custom engine/API key, [s] skip auto-translation (use English placeholders): ",
    )
  ).toLowerCase();

  if (choice === "s" || choice === "skip") {
    console.log("Auto-translation disabled for this run; missing locale values will use English text.");
    return { skipTranslation: true };
  }

  if (choice === "c" || choice === "configure") {
    const engine = await ask("Translate engine (google/deepl/libre/yandex) [google]: ");
    const key = await ask("Translate API key (leave blank for none): ");
    const url = await ask("Translate URL (optional, leave blank for default): ");
    if (engine) process.env.TRANSLATE_ENGINE = engine;
    if (key) process.env.TRANSLATE_KEY = key;
    if (url) process.env.TRANSLATE_URL = url;
    if (engine || key || url) {
      console.log(
        `Custom translation service configured${engine ? ` (engine: ${engine})` : ""}${key ? " with API key" : ""}.`,
      );
    } else {
      console.log("No custom translation settings entered; using default MyMemory.");
    }
  }

  return { skipTranslation: false };
}

async function main(): Promise<number> {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  const cwd = process.cwd();

  if (!command || flags.help || command === "help") {
    console.log(HELP);
    return command ? 0 : 1;
  }

  const envFile = path.join(cwd, ".env");
  if (existsSync(envFile)) {
    const result = dotenv.config({ path: envFile });
    if (result.error) throw result.error;
  }

  if (command === "init") {
    const target = path.join(cwd, "i18n-keys.config.ts");
    if (existsSync(target)) {
      console.error("i18n-keys.config.ts already exists.");
      return 1;
    }
    writeFileSync(target, TEMPLATE);
    console.log(
      "Created i18n-keys.config.ts - adjust include/exclude and translationsDir as needed.",
    );
    return 0;
  }

  if (!["generate", "scan", "check", "sync"].includes(command)) {
    console.error(`Unknown command: ${command}\n`);
    console.log(HELP);
    return 2;
  }

  const exportMissingFile = flags["export-missing"];
  if (exportMissingFile !== undefined) {
    if (typeof exportMissingFile !== "string") {
      console.error("--export-missing requires a file path.");
      return 2;
    }
    if (!["check", "sync"].includes(command)) {
      console.error("--export-missing can only be used with check or sync.");
      return 2;
    }
  }

  const cfg = await loadConfig(
    cwd,
    flags.config as string | undefined,
    command === "scan" || command === "generate",
  );

  // Incremental scan: only affects which files are *scanned*; the DB comparison is always full.
  let restrict: Set<string> | undefined;
  if (flags.staged) restrict = changedFiles(cwd, { staged: true });
  else if (typeof flags.since === "string")
    restrict = changedFiles(cwd, { since: flags.since });

  console.log(`[${cfg.appId ?? "local"}] ${command}${restrict ? " (incremental)" : ""}`);
  const scan = await scanProject(cfg, restrict);
  printScan(scan, cfg, !!flags.verbose);

  let exitCode = 0;
  if (cfg.dynamicKeys === "error" && scan.dynamic.length) exitCode = 1;
  if (scan.issues.some((i) => i.level === "error")) exitCode = 1;

  if (command === "generate") {
    const keys = [...scan.keys.keys()];
    let skipTranslation = false;
    if (keys.length && process.stdin.isTTY) {
      ({ skipTranslation } = await configureTranslationSetup());
    }

    const translationsDir =
      typeof flags["translations-dir"] === "string"
        ? flags["translations-dir"]
        : cfg.translationsDir;
    const { generateTranslationFiles } = await import("./generator.js");
    let skipAllTranslations = false;
    const services = skipTranslation
      ? {
          translateText: async (text: string) => text,
        }
      : process.stdin.isTTY
        ? {
            recoverTranslation: async (error: Error, key: string, locale: string) => {
              if (skipAllTranslations) return "skip" as const;
              console.error(
                `\nTranslation failed for ${locale} ${JSON.stringify(key)}: ${error.message}`,
              );
              const action = (
                await ask(
                  "Choose: [r]etry, [c]onfigure service/key, [s]kip this string (use English), [k] skip all remaining (use English), [a]bort and save progress: ",
                )
              ).toLowerCase();
              if (action === "r" || action === "retry") return "retry" as const;
              if (action === "k" || action === "skip-all" || action === "all") {
                skipAllTranslations = true;
                console.log("Skipping all remaining translation failures for this run (English placeholders will be used).");
                return "skip" as const;
              }
              if (action === "s" || action === "skip") return "skip" as const;
              if (action === "c" || action === "configure") {
                await configureTranslationSetup();
                return "configure" as const;
              }
              return "abort" as const;
            },
          }
        : undefined;
    await generateTranslationFiles(keys, cwd, translationsDir, services);
    console.log(`\nLocale files written to ${translationsDir}.`);
    return exitCode;
  }

  if (command === "scan") {
    if (flags.list) {
      const needle =
        typeof flags.filter === "string"
          ? flags.filter.toLowerCase()
          : undefined;
      console.log("\nDiscovered keys:");
      for (const k of [...scan.keys.keys()].sort()) {
        if (needle && !k.toLowerCase().includes(needle)) continue;
        console.log(`  ${JSON.stringify(k)}`);
        if (flags.locations) {
          for (const o of scan.keys.get(k)!.slice(0, 3))
            console.log(`      ${o.file}:${o.line}  (${o.via})`);
        }
      }
    }
    return exitCode;
  }

  // check / sync: need the API from here on.
  if (!cfg.appId) {
    throw new Error("Config error: `appId` is required for check/sync commands.");
  }
  const appId = cfg.appId;
  const adapter = pickAdapter(cfg, !!flags.mock);
  let existingKeys: string[];
  try {
    existingKeys = await adapter.fetchExisting(appId);
  } catch (err) {
    console.error(
      `\nCould not fetch existing keys; aborting without registering anything.\n  ${(err as Error).message}`,
    );
    return 2;
  }

  const { existing, missing } = diffKeys(scan.keys.keys(), existingKeys);
  printDiff(existing, missing, !!flags.verbose);

  if (typeof exportMissingFile === "string") {
    const outputFile = path.resolve(cwd, exportMissingFile);
    await writeMissingTranslations(outputFile, missing);
    console.log(`\nMissing translations written to ${exportMissingFile}`);
  }

  const reportFile = (flags.json as string | undefined) ?? cfg.reportFile;
  const report = async (applied: boolean, summary?: RegisterSummary) => {
    if (reportFile) {
      await writeJsonReport(path.resolve(cwd, reportFile), {
        appId,
        command,
        applied,
        scan,
        existing,
        missing,
        summary,
      });
      console.log(`\nReport written to ${reportFile}`);
    }
  };

  if (command === "check") {
    await report(false);
    if (flags["fail-on-missing"] && missing.length) exitCode = 1;
    return exitCode;
  }

  // sync
  const apply = !!flags.apply;
  const limit =
    typeof flags.limit === "string" ? Number(flags.limit) : undefined;
  if (flags.limit === true || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))) {
    console.error("--limit must be a non-negative integer");
    return 2;
  }

  if (missing.length === 0) {
    console.log("\nNothing to register.");
    await report(apply, {
      planned: [],
      registered: [],
      duplicates: [],
      failed: [],
      skippedByLimit: [],
    });
    return exitCode;
  }

  const toSend = missing.slice(0, limit ?? missing.length);
  if (adapter.previewPayload && toSend.length) {
    const first = toSend.slice(0, Math.max(adapter.batchSize ?? 1, 1));
    console.log("\nFirst payload that will be sent:");
    console.log(
      JSON.stringify(adapter.previewPayload(first, appId), null, 2),
    );
  }

  if (apply && process.stdin.isTTY && !flags.yes) {
    const ok = await confirm(
      `\nRegister ${toSend.length} key(s) for "${appId}"? (y/N) `,
    );
    if (!ok) {
      console.log("Aborted.");
      return 1;
    }
  }

  const summary = await registerKeys(adapter, appId, missing, {
    limit,
    apply,
  });
  printRegister(summary, apply);
  await report(apply, summary);
  const stillMissing = !apply || summary.skippedByLimit.length > 0;
  if (summary.failed.length || (flags["fail-on-missing"] && stillMissing)) {
    exitCode = 1;
  } else if (flags["fail-on-missing"] && apply) {
    console.log("\nAll missing keys were registered.");
  }
  return exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(
      `\nError: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 2;
  },
);
