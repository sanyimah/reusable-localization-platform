import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { check, replaceAll } from "gramma";
import translate from "translate";

type TranslateFn = typeof translate & {
  engine?: string;
  key?: string;
  url?: string;
};

async function fetchJson(url: string): Promise<unknown> {
  const response =
    typeof globalThis.fetch === "function"
      ? await globalThis.fetch(url)
      : await (await import("node-fetch")).default(url as any);
  const text = await (response as { text: () => Promise<string> }).text();
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(`Invalid JSON response: ${text.slice(0, 120)}`);
  }
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const LOCALES = [
  { file: "fr", target: "fr", grammar: "fr" },
  { file: "zh", target: "zh", grammar: "zh-CN" },
  { file: "es", target: "es", grammar: "es" },
  { file: "de", target: "de", grammar: "de-DE" },
  { file: "it", target: "it", grammar: "it" },
  { file: "pt", target: "pt", grammar: "pt-PT" },
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

export type TranslationRecoveryAction =
  | "retry"
  | "skip"
  | "abort"
  | "configure";

export interface GenerationServices {
  translateText?: (text: string, locale: string) => Promise<string>;
  checkGrammar?: (text: string, language: string) => Promise<GrammarResult>;
  chooseCorrection?: (
    locale: string,
    key: string,
    match: GrammarMatch,
  ) => Promise<number | undefined>;
  recoverTranslation?: (
    error: Error,
    key: string,
    locale: string,
  ) => Promise<TranslationRecoveryAction>;
}

interface ProgressState {
  total: number;
  completed: number;
  enabled: boolean;
  active: boolean;
}

function createProgress(total: number): ProgressState {
  return {
    total,
    completed: 0,
    enabled: process.stderr.isTTY === true && total > 0,
    active: false,
  };
}

function clearProgress(progress: ProgressState): void {
  if (!progress.enabled || !progress.active) return;
  process.stderr.write(`\r${" ".repeat(Math.min(process.stderr.columns || 80, 120))}\r`);
  progress.active = false;
}

function renderProgress(
  progress: ProgressState,
  phase: string,
  locale?: string,
  key?: string,
): void {
  if (!progress.enabled) return;
  const width = 20;
  const ratio = progress.total === 0 ? 1 : progress.completed / progress.total;
  const filled = Math.round(ratio * width);
  const bar = `${"=".repeat(filled)}${"-".repeat(width - filled)}`;
  const percent = Math.round(ratio * 100)
    .toString()
    .padStart(3, " ");
  const label = key
    ? `${locale ?? ""} ${JSON.stringify(key.length > 28 ? `${key.slice(0, 25)}...` : key)}`
    : "";
  const line = `${phase} [${bar}] ${percent}% ${progress.completed}/${progress.total} ${label}`;
  const max = Math.max(20, (process.stderr.columns || 80) - 1);
  const trimmed = line.length > max ? `${line.slice(0, max - 1)}…` : line.padEnd(max, " ");
  process.stderr.write(`\r${trimmed}`);
  progress.active = true;
}

function advanceProgress(
  progress: ProgressState,
  phase: string,
  locale?: string,
  key?: string,
): void {
  progress.completed += 1;
  renderProgress(progress, phase, locale, key);
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
  progress?: ProgressState,
): Promise<number | undefined> {
  const suggestions = match.replacements.map((replacement) => replacement.value);
  if (!suggestions.length) {
    if (progress) clearProgress(progress);
    console.log(`[${locale}] ${JSON.stringify(key)}: ${match.message}`);
    return Promise.resolve(undefined);
  }
  if (!process.stdin.isTTY) {
    if (progress) clearProgress(progress);
    console.log(
      `[${locale}] ${JSON.stringify(key)}: ${match.message} (suggestions not applied: ${suggestions.join(" / ")})`,
    );
    return Promise.resolve(undefined);
  }

  if (progress) {
    clearProgress(progress);
    process.stderr.write("\n");
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
  services: Required<Pick<GenerationServices, "translateText" | "checkGrammar">> &
    GenerationServices,
  progress?: ProgressState,
): Promise<string> {
  let result: GrammarResult;
  try {
    result = await services.checkGrammar(text, grammarLanguage);
  } catch (error) {
    if (progress) {
      clearProgress(progress);
      process.stderr.write("\n");
    }
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
      if (progress) clearProgress(progress);
      console.log(`[${locale}] ${JSON.stringify(key)}: ${match.message}`);
      continue;
    }
    const selected = services.chooseCorrection
      ? await services.chooseCorrection(locale, key, { ...match, replacements })
      : await chooseCorrection(locale, key, { ...match, replacements }, progress);
    if (selected === undefined) continue;
    corrections.push({
      offset: match.offset,
      length: match.length,
      change: replacements[selected].value,
    });
  }
  return corrections.length ? replaceAll(text, corrections) : text;
}

function configureTranslateFromEnv(): void {
  const t = translate as TranslateFn;
  const engine = process.env.TRANSLATE_ENGINE?.trim();
  const key = process.env.TRANSLATE_KEY?.trim();
  const url = process.env.TRANSLATE_URL?.trim();
  if (engine) (t as { engine?: string }).engine = engine;
  if (key) t.key = key;
  if (url) t.url = url;
}

function usesCustomTranslateService(): boolean {
  return Boolean(
    process.env.TRANSLATE_ENGINE?.trim() ||
      process.env.TRANSLATE_KEY?.trim() ||
      process.env.TRANSLATE_URL?.trim(),
  );
}

async function translateWithMyMemory(text: string, target: string): Promise<string> {
  const email =
    process.env.MYMEMORY_EMAIL?.trim() ||
    process.env.TRANSLATE_EMAIL?.trim() ||
    "you@example.com";
  const params = new URLSearchParams({
    q: text,
    langpair: `en|${target}`,
  });
  if (email) params.set("de", email);
  const url = `https://api.mymemory.translated.net/get?${params.toString()}`;
  const body = (await fetchJson(url)) as {
    responseData?: { translatedText?: string };
    responseStatus?: number | string;
    responseDetails?: string;
  };
  const status = Number(body?.responseStatus ?? 200);
  const translatedText = body?.responseData?.translatedText;
  if (status !== 200 || typeof translatedText !== "string" || !translatedText.trim()) {
    const details =
      typeof body?.responseDetails === "string" && body.responseDetails.trim()
        ? `: ${body.responseDetails}`
        : "";
    throw new Error(`MyMemory translation failed (status ${status})${details}`);
  }
  return decodeBasicEntities(translatedText);
}

export async function generateTranslationFiles(
  keys: Iterable<string>,
  cwd: string,
  translationsDir = "Translations",
  services?: GenerationServices,
): Promise<void> {
  configureTranslateFromEnv();
  const activeServices: Required<Pick<GenerationServices, "translateText" | "checkGrammar">> &
    GenerationServices = {
    translateText:
      services?.translateText ??
      (async (text, locale) => {
        const translated = usesCustomTranslateService()
          ? await translate(text, { from: "en", to: locale })
          : await translateWithMyMemory(text, locale);
        if (!translated.trim()) {
          throw new Error(
            `Translation service returned an empty ${locale} translation for ${JSON.stringify(text)}.`,
          );
        }
        return translated;
      }),
    checkGrammar:
      services?.checkGrammar ??
      (async (text, language) => (await check(text, { language })) as GrammarResult),
    chooseCorrection: services?.chooseCorrection,
    recoverTranslation: services?.recoverTranslation,
  };
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
  let missingTranslations = 0;
  for (const key of orderedKeys) {
    for (const locale of LOCALES) {
      const translations = targetFiles.get(locale)!;
      if (!Object.prototype.hasOwnProperty.call(translations, key)) missingTranslations += 1;
    }
  }
  const progress = createProgress(missingTranslations + orderedKeys.length * (LOCALES.length + 1));
  if (progress.enabled) {
    renderProgress(progress, missingTranslations > 0 ? "Translating" : "Reviewing");
  }

  try {
    for (const key of orderedKeys) {
      if (!Object.prototype.hasOwnProperty.call(english, key)) {
        english[key] = key;
      }
      for (const locale of LOCALES) {
        const translations = targetFiles.get(locale)!;
        if (!Object.prototype.hasOwnProperty.call(translations, key)) {
          let translated: string | undefined;
          while (translated === undefined) {
            try {
              renderProgress(progress, "Translating", locale.file, key);
              translated = await activeServices.translateText(key, locale.target);
              if (!translated.trim()) {
                throw new Error(
                  `Translation service returned an empty ${locale.file} translation for ${JSON.stringify(key)}.`,
                );
              }
            } catch (error) {
              const err = error instanceof Error ? error : new Error(String(error));
              if (progress.enabled) {
                clearProgress(progress);
                process.stderr.write("\n");
              }
              const recovery = activeServices.recoverTranslation
                ? await activeServices.recoverTranslation(err, key, locale.file)
                : "abort";
              if (recovery === "retry" || recovery === "configure") {
                configureTranslateFromEnv();
                translated = undefined;
                continue;
              }
              if (recovery === "skip") {
                translated = key;
                console.log(
                  `[${locale.file}] Using English text for ${JSON.stringify(key)} (translation skipped).`,
                );
                break;
              }
              throw new Error(
                `Translation failed for ${locale.file} ${JSON.stringify(key)}: ${err.message}`,
              );
            }
          }
          translations[key] = translated;
          advanceProgress(progress, "Translating", locale.file, key);
        }
      }
    }

    for (const key of orderedKeys) {
      renderProgress(progress, "Reviewing", "en", key);
      english[key] = await reviewGrammar(
        english[key],
        key,
        "en",
        GRAMMAR_LANGUAGE,
        activeServices,
        progress,
      );
      advanceProgress(progress, "Reviewing", "en", key);
      for (const locale of LOCALES) {
        const translations = targetFiles.get(locale)!;
        renderProgress(progress, "Reviewing", locale.file, key);
        translations[key] = await reviewGrammar(
          translations[key],
          key,
          locale.file,
          locale.grammar,
          activeServices,
          progress,
        );
        advanceProgress(progress, "Reviewing", locale.file, key);
      }
    }
  } finally {
    if (progress.enabled) {
      clearProgress(progress);
      process.stderr.write("\n");
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
