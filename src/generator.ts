import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { check, replaceAll } from "gramma";
import translate from "translate";

const LOCALES = [
  { file: "fr", google: "fr", grammar: "fr" },
  { file: "zh", google: "zh", grammar: "zh-CN" },
  { file: "es", google: "es", grammar: "es" },
  { file: "de", google: "de", grammar: "de-DE" },
  { file: "it", google: "it", grammar: "it" },
  { file: "pt", google: "pt", grammar: "pt-PT" },
] as const;

const GRAMMAR_LANGUAGE = "en-US";

interface GrammarReplacement {
  value: string;
}

interface GrammarMatch {
  message: string;
  offset: number;
  length: number;
  replacements: GrammarReplacement[];
}

interface GrammarResult {
  matches: GrammarMatch[];
}

type LocaleFile = Record<string, string>;

export interface GenerationServices {
  translateText: (text: string, locale: string) => Promise<string>;
  checkGrammar: (text: string, language: string) => Promise<GrammarResult>;
  chooseCorrection?: (
    locale: string,
    key: string,
    match: GrammarMatch,
  ) => Promise<number | undefined>;
}

async function readLocaleFile(file: string): Promise<LocaleFile> {
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {};
    }
    throw error;
  }

  const parsed: unknown = JSON.parse(contents);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((value) => typeof value !== "string")
  ) {
    throw new Error(`${file} must contain a JSON object with string values.`);
  }
  return parsed as LocaleFile;
}

function chooseCorrection(
  locale: string,
  key: string,
  match: GrammarMatch,
): Promise<number | undefined> {
  const suggestions = match.replacements.map((replacement) => replacement.value);
  if (!suggestions.length) {
    console.log(`[${locale}] ${JSON.stringify(key)}: ${match.message}`);
    return Promise.resolve(undefined);
  }
  if (!process.stdin.isTTY) {
    console.log(
      `[${locale}] ${JSON.stringify(key)}: ${match.message} (suggestions not applied: ${suggestions.join(" / ")})`,
    );
    return Promise.resolve(undefined);
  }

  const choices = suggestions
    .map((suggestion, index) => `${index + 1}) ${suggestion}`)
    .join("  ");
  return new Promise((resolve) => {
    const prompt = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    prompt.question(
      `\n[${locale}] ${JSON.stringify(key)}: ${match.message}\n${choices}\nChoose a correction, or 0 to keep it: `,
      (answer) => {
        prompt.close();
        const selected = Number(answer.trim());
        resolve(
          Number.isInteger(selected) && selected > 0 && selected <= suggestions.length
            ? selected - 1
            : undefined,
        );
      },
    );
  });
}

async function reviewGrammar(
  text: string,
  key: string,
  locale: string,
  grammarLanguage: string,
  services: GenerationServices,
): Promise<string> {
  let result: GrammarResult;
  try {
    result = await services.checkGrammar(text, grammarLanguage);
  } catch (error) {
    throw new Error(
      `Grammar check failed for ${locale} ${JSON.stringify(key)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const corrections: { offset: number; length: number; change: string }[] = [];
  for (const match of result.matches) {
    const replacements = match.replacements.filter(
      (replacement) => replacement.value.length > 0,
    );
    if (!replacements.length) {
      console.log(`[${locale}] ${JSON.stringify(key)}: ${match.message}`);
      continue;
    }
    const selected = await (services.chooseCorrection ?? chooseCorrection)(
      locale,
      key,
      { ...match, replacements },
    );
    if (selected === undefined) continue;
    corrections.push({
      offset: match.offset,
      length: match.length,
      change: replacements[selected].value,
    });
  }
  return corrections.length ? replaceAll(text, corrections) : text;
}

export async function generateTranslationFiles(
  keys: Iterable<string>,
  cwd: string,
  translationsDir = "Translations",
  services: GenerationServices = {
    translateText: async (text, locale) => {
      const translated = await translate(text, { from: "en", to: locale });
      if (!translated.trim()) {
        throw new Error(
          `Google Translate returned an empty ${locale} translation for ${JSON.stringify(text)}.`,
        );
      }
      return translated;
    },
    checkGrammar: async (text, language) =>
      (await check(text, { language })) as GrammarResult,
  },
): Promise<void> {
  const outputDirectory = path.resolve(cwd, translationsDir);
  const englishFile = path.join(outputDirectory, "en.json");
  const english = await readLocaleFile(englishFile);
  const targetFiles = new Map(
    await Promise.all(
      LOCALES.map(async (locale) => [
        locale,
        await readLocaleFile(path.join(outputDirectory, `${locale.file}.json`)),
      ] as const),
    ),
  );

  const orderedKeys = [...new Set(keys)].sort((a, b) => a.localeCompare(b));
  for (const key of orderedKeys) {
    if (!Object.prototype.hasOwnProperty.call(english, key)) {
      english[key] = key;
    }
    for (const locale of LOCALES) {
      const translations = targetFiles.get(locale)!;
      if (!Object.prototype.hasOwnProperty.call(translations, key)) {
        let translated: string;
        try {
          translated = await services.translateText(key, locale.google);
        } catch (error) {
          throw new Error(
            `Translation failed for ${locale.file} ${JSON.stringify(key)}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!translated.trim()) {
          throw new Error(
            `Google Translate returned an empty ${locale.file} translation for ${JSON.stringify(key)}.`,
          );
        }
        translations[key] = translated;
      }
    }
  }

  for (const key of orderedKeys) {
    english[key] = await reviewGrammar(
      english[key],
      key,
      "en",
      GRAMMAR_LANGUAGE,
      services,
    );
    for (const locale of LOCALES) {
      const translations = targetFiles.get(locale)!;
      translations[key] = await reviewGrammar(
        translations[key],
        key,
        locale.file,
        locale.grammar,
        services,
      );
    }
  }

  await mkdir(outputDirectory, { recursive: true });
  const output = [
    [englishFile, english],
    ...LOCALES.map((locale) => [
      path.join(outputDirectory, `${locale.file}.json`),
      targetFiles.get(locale)!,
    ] as const),
  ] as const;
  for (const [file, contents] of output) {
    const sorted = Object.fromEntries(
      Object.entries(contents).sort(([a], [b]) => a.localeCompare(b)),
    );
    await writeFile(file, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
  }
}
