function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseExisting(body: unknown, baseLang = "en"): string[] {
  if (!isRecord(body)) {
    throw new Error("GET response must be an object of language dictionaries.");
  }
  const dictionary = body[baseLang];
  if (!isRecord(dictionary)) {
    throw new Error(`GET response must contain a "${baseLang}" dictionary.`);
  }
  for (const value of Object.values(dictionary)) {
    if (value !== null && typeof value !== "string") {
      throw new Error(
        `Values in the "${baseLang}" dictionary must be strings or null.`,
      );
    }
  }
  return Object.keys(dictionary);
}
