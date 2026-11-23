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
      expect(checkGrammar).toHaveBeenCalledTimes(2);
      expect(checkGrammar).toHaveBeenCalledWith("Cancel", "en-GB");
      expect(checkGrammar).toHaveBeenCalledWith("Save", "en-GB");

      translateText.mockClear();
      checkGrammar.mockClear();
      await generateTranslationFiles(
        ["Save", "Cancel"],
        cwd,
        "Translations",
        { translateText, checkGrammar },
      );
      expect(translateText).not.toHaveBeenCalled();
      expect(checkGrammar).toHaveBeenCalledTimes(2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reviews English (en-GB) before translation and applies selected corrections", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "i18n-keys-grammar-"));
    const checkGrammar = vi.fn(async (text: string, language: string) => ({
      matches:
        language === "en-GB" && text === "Color"
          ? [
              {
                message: "British English spelling",
                offset: 0,
                length: 5,
                replacements: [{ value: "Colour" }],
              },
            ]
          : [],
    }));
    const translateText = vi.fn(async (text: string, locale: string) => `${locale}:${text}`);

    try {
      await generateTranslationFiles(["Color"], cwd, "Translations", {
        translateText,
        checkGrammar,
        chooseCorrection: async () => 0,
      });

      expect(checkGrammar).toHaveBeenCalledTimes(1);
      expect(checkGrammar).toHaveBeenCalledWith("Color", "en-GB");
      expect(translateText).toHaveBeenCalledWith("Colour", "fr");
      expect(
        JSON.parse(await readFile(path.join(cwd, "Translations", "en.json"), "utf8")),
      ).toEqual({ Color: "Colour" });
      expect(
        JSON.parse(await readFile(path.join(cwd, "Translations", "fr.json"), "utf8")),
      ).toEqual({ Color: "fr:Colour" });
      expect(
        JSON.parse(await readFile(path.join(cwd, "Translations", "es.json"), "utf8")),
      ).toEqual({ Color: "es:Colour" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps English text unchanged when a grammar suggestion is declined", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "i18n-keys-grammar-keep-"));
    const checkGrammar = vi.fn(async (text: string, language: string) => ({
      matches:
        language === "en-GB" && text === "Color"
          ? [
              {
                message: "British English spelling",
                offset: 0,
                length: 5,
                replacements: [{ value: "Colour" }],
              },
            ]
          : [],
    }));
    const translateText = vi.fn(async (text: string, locale: string) => `${locale}:${text}`);

    try {
      await generateTranslationFiles(["Color"], cwd, "Translations", {
        translateText,
        checkGrammar,
        chooseCorrection: async () => undefined,
      });

      expect(translateText).toHaveBeenCalledWith("Color", "fr");
      expect(
        JSON.parse(await readFile(path.join(cwd, "Translations", "en.json"), "utf8")),
      ).toEqual({ Color: "Color" });
      expect(
        JSON.parse(await readFile(path.join(cwd, "Translations", "fr.json"), "utf8")),
      ).toEqual({ Color: "fr:Color" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
