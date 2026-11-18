import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { ApiAdapter } from "./types.js";

/**
 * Local stand-in for your backend: a JSON file `{ "keys": [...] }`.
 * Lets you run the whole pipeline end to end without touching any real API.
 */
export function createMockAdapter(file: string): ApiAdapter {
  const read = async (): Promise<string[]> =>
    existsSync(file) ? ((JSON.parse(await readFile(file, "utf8")) as { keys?: string[] }).keys ?? []) : [];

  return {
    batchSize: 1000,
    concurrency: 1,
    fetchExisting: read,
    async register(keys) {
      const current = await read();
      const set = new Set(current);
      for (const k of keys) set.add(k);
      await writeFile(file, JSON.stringify({ keys: [...set].sort() }, null, 2));
      return { status: "registered" };
    },
    previewPayload: (keys) => ({ mockFile: file, keys }),
  };
}