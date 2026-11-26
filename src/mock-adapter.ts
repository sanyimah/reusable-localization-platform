import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { parseExisting } from "./parse.js";
import type { ApiAdapter } from "./types.js";

/**
 * Local stand-in for your backend: a JSON file of keys or language dictionaries.
 * Lets you run the whole pipeline end to end without touching any real API.
 */
export function createMockAdapter(file: string): ApiAdapter {
  const readData = async (): Promise<unknown> => {
    if (!existsSync(file)) return { keys: [] };
    return JSON.parse(await readFile(file, "utf8"));
  };

  const readKeys = (data: unknown): string[] => {
    if (!isRecord(data)) throw invalidMockFile(file);
    if ("keys" in data) {
      if (!Array.isArray(data.keys) || data.keys.some((key) => typeof key !== "string")) {
        throw invalidMockFile(file);
      }
      return data.keys;
    }
    try {
      return parseExisting(data, "en");
    } catch (error) {
      throw new Error(`${invalidMockFile(file).message} ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return {
    concurrency: 1,
    async fetchExisting() {
      return readKeys(await readData());
    },
    async register(keys) {
      const data = await readData();
      const current = readKeys(data);
      if (isRecord(data) && !("keys" in data)) {
        const english = data.en;
        if (!isRecord(english)) throw invalidMockFile(file);
        const nextEnglish = { ...english };
        for (const key of keys) {
          if (!Object.prototype.hasOwnProperty.call(nextEnglish, key)) {
            nextEnglish[key] = key;
          }
        }
        await writeFile(file, JSON.stringify({ ...data, en: nextEnglish }, null, 2));
      } else {
        const set = new Set(current);
        for (const key of keys) set.add(key);
        await writeFile(file, JSON.stringify({ keys: [...set].sort() }, null, 2));
      }
      return { status: "registered" };
    },
    previewPayload: (keys) => ({ mockFile: file, keys }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidMockFile(file: string): Error {
  return new Error(
    `${file} must look like { "keys": ["Save", "Cancel"] } or language dictionaries such as { "en": { "Save": "Save" }, "fr": { "Save": "" } }.`,
  );
}