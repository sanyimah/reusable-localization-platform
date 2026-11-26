import { writeFile } from "node:fs/promises";
import type { RegisterSummary, ResolvedConfig, ScanResult } from "./types.js";

const MAX_LIST = 40;

function list(items: string[], verbose: boolean, indent = "    "): string {
  const shown = verbose ? items : items.slice(0, MAX_LIST);
  const lines = shown.map((i) => `${indent}${i}`);
  if (shown.length < items.length) lines.push(`${indent}... and ${items.length - shown.length} more (use --verbose)`);
  return lines.join("\n");
}

export function printScan(scan: ScanResult, cfg: ResolvedConfig, verbose = false): void {
  console.log(
    `Scanned ${scan.filesScanned} files · ${scan.keys.size} unique keys · ` +
      `${scan.dynamic.length} dynamic usages · ${scan.issues.length} key issues`,
  );

  if (scan.readErrors.length) {
    console.log(`\n  Could not read ${scan.readErrors.length} file(s):`);
    console.log(list(scan.readErrors.map((e) => `${e.file}: ${e.error}`), verbose));
  }

  if (scan.issues.length) {
    console.log("\n  Key issues:");
    console.log(
      list(scan.issues.map((i) => `[${i.level}] ${i.file}:${i.line}  ${JSON.stringify(i.key)}  (${i.message})`), verbose),
    );
  }

  if (scan.dynamic.length && cfg.dynamicKeys !== "ignore") {
    const label = cfg.dynamicKeys === "error" ? "ERROR" : "warn";
    console.log(`\n  Dynamic keys that cannot be resolved statically [${label}]:`);
    console.log(list(scan.dynamic.map((d) => `${d.file}:${d.line}:${d.column}  ${d.snippet}  -> ${d.reason}`), verbose));
    console.log(
      '    Fix: use a static string literal in t(...), or add `// i18n-keys-ignore` on the same/previous line to skip.',
    );
  }
}

export function printDiff(existing: string[], missing: string[], verbose = false): void {
  console.log(`\nExisting in DB: ${existing.length} · Missing: ${missing.length}`);
  if (missing.length) {
    console.log("\n  Missing keys:");
    console.log(list(missing.map((k) => JSON.stringify(k)), verbose));
  }
}

export function printRegister(summary: RegisterSummary, applied: boolean): void {
  if (!applied) {
    console.log(`\nDRY RUN: nothing was sent. ${summary.planned.length} key(s) would be registered.`);
    if (summary.skippedByLimit.length) console.log(`  (${summary.skippedByLimit.length} more skipped by --limit)`);
    console.log("  Re-run with --apply to register them.");
    return;
  }
  console.log(
    `\nRegistered: ${summary.registered.length} · Already existed (duplicate): ${summary.duplicates.length} · ` +
      `Failed: ${summary.failed.length} · Skipped by --limit: ${summary.skippedByLimit.length}`,
  );
  if (summary.failed.length) {
    console.log("\n  Failures:");
    console.log(list(summary.failed.map((f) => `${JSON.stringify(f.key)}  ${f.error}`), true));
  }
}

export async function writeJsonReport(
  file: string,
  data: {
    appId: string;
    command: string;
    applied: boolean;
    scan: ScanResult;
    existing: string[];
    missing: string[];
    summary?: RegisterSummary;
  },
): Promise<void> {
  const { scan } = data;
  await writeFile(
    file,
    JSON.stringify(
      {
        appId: data.appId,
        command: data.command,
        applied: data.applied,
        generatedAt: new Date().toISOString(),
        filesScanned: scan.filesScanned,
        discovered: scan.keys.size,
        existing: data.existing,
        missing: data.missing,
        registered: data.summary?.registered ?? [],
        duplicates: data.summary?.duplicates ?? [],
        failed: data.summary?.failed ?? [],
        skippedByLimit: data.summary?.skippedByLimit ?? [],
        dynamic: scan.dynamic,
        issues: scan.issues,
      },
      null,
      2,
    ),
  );
}

export async function writeMissingTranslations(
  file: string,
  missing: string[],
): Promise<void> {
  const languages = ["en", "fr", "zh", "es", "de", "it", "pt"];
  const translations: Record<string, Record<string, string>> = {};
  for (const language of languages) {
    translations[language] = Object.fromEntries(
      missing.map((key) => [key, language === "en" ? key : ""]),
    );
  }
  await writeFile(file, JSON.stringify(translations, null, 2));
}