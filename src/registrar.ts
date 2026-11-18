import type { ApiAdapter, RegisterSummary } from "./types.js";

export interface RegisterOptions {
  /** Max keys to register this run (use for first live tests). */
  limit?: number;
  /** false = plan only, make zero register() calls. */
  apply: boolean;
  onProgress?: (done: number, total: number) => void;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(size, 1), items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

export async function registerKeys(
  adapter: ApiAdapter,
  appId: string,
  keys: string[],
  opts: RegisterOptions,
): Promise<RegisterSummary> {
  const limit = opts.limit ?? keys.length;
  const planned = keys.slice(0, limit);
  const summary: RegisterSummary = {
    planned,
    registered: [],
    duplicates: [],
    failed: [],
    skippedByLimit: keys.slice(limit),
  };
  if (!opts.apply) return summary;

  const batches = chunk(planned, Math.max(adapter.batchSize ?? 1, 1));
  let done = 0;

  await pool(batches, adapter.concurrency ?? 3, async (batch) => {
    let outcome;
    try {
      outcome = await adapter.register(batch, appId);
    } catch (err) {
      outcome = { status: "failed" as const, error: err instanceof Error ? err.message : String(err) };
    }
    if (outcome.status === "registered") summary.registered.push(...batch);
    else if (outcome.status === "duplicate") summary.duplicates.push(...batch);
    else for (const key of batch) summary.failed.push({ key, error: outcome.error });
    done += batch.length;
    opts.onProgress?.(done, planned.length);
  });

  return summary;
}