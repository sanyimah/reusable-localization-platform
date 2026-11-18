#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { changedFiles, scanProject } from "./scanner.js";
import { loadConfig } from "./config.js";
import { diffKeys } from "./differ.js";
import { createHttpAdapter } from "./http-adapter.js";
import { createMockAdapter } from "./mock-adapter.js";
import {
  printDiff,
  printRegister,
  printScan,
  writeJsonReport,
} from "./report.js";
import { registerKeys } from "./registrar.js";
import type { ApiAdapter, RegisterSummary, ResolvedConfig } from "./types.js";

const HELP = `i18n-keys - find i18next keys in source and register missing ones

Usage:
  i18n-keys scan  [options]     Discover keys. No network.
  i18n-keys check [options]     Scan + compare with the API. Never writes.
  i18n-keys sync  [options]     Scan + compare + register missing keys.
  i18n-keys init                Create a starter i18n-keys.config.ts

Options:
  --config <file>   Config path (default: i18n-keys.config.*)
  --since <ref>     Only scan files changed since a git ref (e.g. origin/main)
  --staged          Only scan git-staged files
  --apply           (sync) Actually POST. Without it, sync is a dry run.
  --limit <n>       (sync) Register at most n keys this run
  --yes             (sync --apply) Skip the confirmation prompt
  --mock            Use the local JSON mock instead of the real API
  --fail-on-missing (check) Exit 1 if any keys are unregistered
  --json <file>     Write a JSON report
  --list            (scan) Print every discovered key
  --verbose         Don't truncate long lists
  --locations       (scan --list) Show file:line for each key
  --filter <text>   (scan --list) Only keys containing text
`;

const TEMPLATE = `import { defineConfig, parseExisting } from "@sanyimah/i18n-keys";";

export default defineConfig({
  appId: "your-app-id",
  include: ["src/**/*.{js,jsx,ts,tsx}"],
  exclude: ["**/*.test.*", "**/*.stories.*"],
  dynamicKeys: "warn", // "warn" | "error" | "ignore"

  api: {
    baseUrl: process.env.I18N_API_URL!,
    headers: { Authorization: \`Bearer \${process.env.I18N_API_TOKEN}\` },

    // Tell the toolkit how YOUR API looks. Fill these in after checking the real contract.
    // GET /api/GetTranslations/{appId}  ->  return a flat string[] of existing keys
    parseExisting,

    // POST /Generics/TranslationRequests  ->  build the request body for a batch of keys
    buildPayload: (keys, appId) => {
      throw new Error("TODO: implement buildPayload() for your POST body");
    },

    batchSize: 1,
  },
});
`;

const VALUE_FLAGS = new Set(["config", "since", "limit", "json", "filter"]);

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
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await rl.question(question);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function main(): Promise<number> {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  const cwd = process.cwd();

  if (!command || flags.help || command === "help") {
    console.log(HELP);
    return command ? 0 : 1;
  }

  // Load .env if present (Node 20.12+). Ignore if unavailable.
  try {
    (process as unknown as { loadEnvFile?: () => void }).loadEnvFile?.();
  } catch {
    /* no .env - fine */
  }

  if (command === "init") {
    const target = path.join(cwd, "i18n-keys.config.ts");
    if (existsSync(target)) {
      console.error("i18n-keys.config.ts already exists.");
      return 1;
    }
    writeFileSync(target, TEMPLATE);
    console.log(
      "Created i18n-keys.config.ts - fill in appId, parseExisting and buildPayload.",
    );
    return 0;
  }

  if (!["scan", "check", "sync"].includes(command)) {
    console.error(`Unknown command: ${command}\n`);
    console.log(HELP);
    return 2;
  }

  const cfg = await loadConfig(cwd, flags.config as string | undefined);

  // Incremental scan: only affects which files are *scanned*; the DB comparison is always full.
  let restrict: Set<string> | undefined;
  if (flags.staged) restrict = changedFiles(cwd, { staged: true });
  else if (typeof flags.since === "string")
    restrict = changedFiles(cwd, { since: flags.since });

  console.log(`[${cfg.appId}] ${command}${restrict ? " (incremental)" : ""}`);
  const scan = await scanProject(cfg, restrict);
  printScan(scan, cfg, !!flags.verbose);

  let exitCode = 0;
  if (cfg.dynamicKeys === "error" && scan.dynamic.length) exitCode = 1;
  if (scan.issues.some((i) => i.level === "error")) exitCode = 1;

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
  const adapter = pickAdapter(cfg, !!flags.mock);
  let existingKeys: string[];
  try {
    existingKeys = await adapter.fetchExisting(cfg.appId);
  } catch (err) {
    console.error(
      `\nCould not fetch existing keys; aborting without registering anything.\n  ${(err as Error).message}`,
    );
    return 2;
  }

  const { existing, missing } = diffKeys(scan.keys.keys(), existingKeys);
  printDiff(existing, missing, !!flags.verbose);

  const reportFile = (flags.json as string | undefined) ?? cfg.reportFile;
  const report = async (applied: boolean, summary?: RegisterSummary) => {
    if (reportFile) {
      await writeJsonReport(path.resolve(cwd, reportFile), {
        appId: cfg.appId,
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
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
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
  if (apply && adapter.previewPayload && toSend.length) {
    const first = toSend.slice(0, Math.max(adapter.batchSize ?? 1, 1));
    console.log("\nFirst payload that will be sent:");
    console.log(
      JSON.stringify(adapter.previewPayload(first, cfg.appId), null, 2),
    );
  }

  if (apply && process.stdin.isTTY && !flags.yes) {
    const ok = await confirm(
      `\nRegister ${toSend.length} key(s) for "${cfg.appId}"? (y/N) `,
    );
    if (!ok) {
      console.log("Aborted.");
      return 1;
    }
  }

  const summary = await registerKeys(adapter, cfg.appId, missing, {
    limit,
    apply,
  });
  printRegister(summary, apply);
  await report(apply, summary);
  if (summary.failed.length) exitCode = 1;
  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(
      `\nError: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  },
);
