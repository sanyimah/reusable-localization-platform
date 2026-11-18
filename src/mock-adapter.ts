import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { ApiAdapter } from "./types.js";
import { parseExisting } from "./parse.js";

interface MockDb {
  translations: Record<string, Record<string, string>>;
  requests: unknown[];
}

export function createMockAdapter(file: string): ApiAdapter {
  const load = async (): Promise<MockDb> =>
    existsSync(file)
      ? JSON.parse(await readFile(file, "utf8"))
      : { translations: { en: {}, de: {} }, requests: [] };

  return {
    batchSize: 1000,
    concurrency: 1,
    async fetchExisting() {
      return parseExisting((await load()).translations);
    },
    async register(keys, appId) {
      const db = await load();
      let added = 0;
      for (const key of keys) {
        if (key in db.translations.en) continue; // already there
        db.translations.en[key] = key;            // English text = the key
        db.requests.push({
          appId, key, defaultText: key, status: "needs_translation",
          requestedBy: "i18n-keys", createdAt: new Date().toISOString(),
        });
        added++;
      }
      await writeFile(file, JSON.stringify(db, null, 2));
      return { status: added > 0 ? "registered" : "duplicate" };
    },
    previewPayload: (keys, appId) => ({ appId, keys, defaultText: "same as key" }),
  };
}