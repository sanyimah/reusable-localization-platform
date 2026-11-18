import fg from "fast-glob";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractFromSource } from "./extractor.js";
import type {
  DynamicUsage,
  KeyIssue,
  KeyOccurrence,
  ResolvedConfig,
  ScanResult,
} from "./types.js";

const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/*.d.ts",
];

const norm = (p: string) => p.replace(/\\/g, "/");

export async function discoverFiles(
  cfg: ResolvedConfig,
  restrictTo?: Set<string>,
): Promise<string[]> {
  const files = await fg(cfg.include, {
    cwd: cfg.cwd,
    ignore: [...DEFAULT_IGNORE, ...cfg.exclude],
    absolute: true,
    onlyFiles: true,
  });
  const normalized = files.map(norm).sort();
  return restrictTo ? normalized.filter((f) => restrictTo.has(f)) : normalized;
}

/** Files changed in git: staged files, or changed since a ref (e.g. origin/main). */
export function changedFiles(
  cwd: string,
  mode: { staged: true } | { since: string },
): Set<string> {
  const args =
    "staged" in mode
      ? ["diff", "--name-only", "--relative", "--diff-filter=ACMR", "--cached"]
      : [
          "diff",
          "--name-only",
          "--relative",
          "--diff-filter=ACMR",
          `${mode.since}...HEAD`,
        ];
  const out = execFileSync("git", args, { cwd, encoding: "utf8" });
  return new Set(
    out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((rel) => norm(path.resolve(cwd, rel))),
  );
}

export function validateKey(
  key: string,
  maxLen: number,
): { level: "error" | "warning"; message: string } | undefined {
  if (key.trim() === "") return { level: "error", message: "empty key" };
  if (key.length > maxLen)
    return { level: "error", message: `key longer than ${maxLen} chars` };
  if (/[\r\n]/.test(key))
    return { level: "warning", message: "key contains a line break" };
  if (key !== key.trim())
    return { level: "warning", message: "key has leading/trailing whitespace" };
  return undefined;
}

export async function scanProject(
  cfg: ResolvedConfig,
  restrictTo?: Set<string>,
): Promise<ScanResult> {
  const files = await discoverFiles(cfg, restrictTo);
  const keys = new Map<string, KeyOccurrence[]>();
  const dynamic: DynamicUsage[] = [];
  const issues: KeyIssue[] = [];
  const readErrors: { file: string; error: string }[] = [];

  const rel = (f: string) => norm(path.relative(cfg.cwd, f));
  const ignoreRes = (cfg.ignoreDynamic ?? []).map((p) => new RegExp(p));

  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      readErrors.push({
        file: rel(file),
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const result = extractFromSource(rel(file), text, cfg);
    // dynamic.push(...result.dynamic);
    dynamic.push(
      ...result.dynamic.filter(
        (d) => !ignoreRes.some((re) => re.test(`${d.file} ${d.snippet}`)),
      ),
    );

    for (const occ of result.keys) {
      const problem = validateKey(occ.key, cfg.maxKeyLength);
      if (problem) {
        issues.push({
          key: occ.key,
          file: occ.file,
          line: occ.line,
          ...problem,
        });
        if (problem.level === "error") continue; // never registered
      }
      const list = keys.get(occ.key);
      if (list) list.push(occ);
      else keys.set(occ.key, [occ]);
    }
  }

  return { filesScanned: files.length, keys, dynamic, issues, readErrors };
}
