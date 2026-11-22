import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { generateTranslationFiles } from "../src/generator.js";

describe("translation file generation", () => {
  it("creates per-locale files, preserves existing translations, and only translates missing entries", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "i18n-keys-generate-"));
    const translationsPath = path.join(cwd, "Translations");
    await mkdir(translationsPath);
    await writeFile(
      path.join(translationsPath, "fr.json"),
      JSON.stringify({ Save: "Enregistrer" }),
    );
    const translateText = vi.fn(async (text: string, locale: string) => `${locale}:${text}`);
    const checkGrammar = vi.fn(async () => ({ matches: [] }));

    try {
      await generateTranslationFiles(
        ["Save", "Cancel", "Save"],
        cwd,
        "Translations",
        { translateText, checkGrammar },
      );

      expect(JSON.parse(await readFile(path.join(translationsPath, "en.json"), "utf8"))).toEqual({
        Cancel: "Cancel",
        Save: "Save",
      });
      expect(JSON.parse(await readFile(path.join(translationsPath, "fr.json"), "utf8"))).toEqual({
        Cancel: "fr:Cancel",
        Save: "Enregistrer",
      });
      expect(JSON.parse(await readFile(path.join(translationsPath, "zh.json"), "utf8"))).toEqual({
        Cancel: "zh:Cancel",
        Save: "zh:Save",
      });
      expect(translateText).toHaveBeenCalledTimes(11);
      expect(checkGrammar).toHaveBeenCalledTimes(14);

      translateText.mockClear();
      checkGrammar.mockClear();
      await generateTranslationFiles(
        ["Save", "Cancel"],
        cwd,
        "Translations",
        { translateText, checkGrammar },
      );
      expect(translateText).not.toHaveBeenCalled();
      expect(checkGrammar).toHaveBeenCalledTimes(14);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("only applies grammar suggestions selected by the user", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "i18n-keys-grammar-"));
    const checkGrammar = vi.fn(async (_text: string, language: string) => ({
      matches:
        language === "fr"
          ? [{ message: "Suggestion", offset: 0, length: 7, replacements: [{ value: "Salut" }] }]
          : [],
    }));

    try {
      await generateTranslationFiles(["Hello"], cwd, "Translations", {
        translateText: async () => "Bonjour",
        checkGrammar,
        chooseCorrection: async (locale) => (locale === "fr" ? 0 : undefined),
      });

      expect(
        JSON.parse(await readFile(path.join(cwd, "Translations", "fr.json"), "utf8")),
      ).toEqual({ Hello: "Salut" });
      expect(
        JSON.parse(await readFile(path.join(cwd, "Translations", "es.json"), "utf8")),
      ).toEqual({ Hello: "Bonjour" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
