export interface DiffResult {
  existing: string[];
  missing: string[];
}

/** Exact, case-sensitive match - same as i18next does at runtime. */
export function diffKeys(discovered: Iterable<string>, existingKeys: Iterable<string>): DiffResult {
  const existingSet = new Set(existingKeys);
  const existing: string[] = [];
  const missing: string[] = [];
  for (const key of new Set(discovered)) {
    (existingSet.has(key) ? existing : missing).push(key);
  }
  return { existing: existing.sort(), missing: missing.sort() };
}