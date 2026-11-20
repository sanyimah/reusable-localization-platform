import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const appId = "demo-app";
const dbFile = new URL("./.i18n-test-db.json", import.meta.url);
const seedKeys = [
  "Active",
  "Customer Information",
  "Customer Name",
  "Inactive",
  "Logout",
  "Save Changes",
  "Welcome Back",
];

const seedTranslations = {
  en: Object.fromEntries(seedKeys.map((key) => [key, key])),
  fr: { "Welcome Back": "Bon retour" },
};

function saveTranslations(translations) {
  writeFileSync(dbFile, JSON.stringify(translations, null, 2) + "\n");
}

function readTranslations() {
  return JSON.parse(readFileSync(dbFile, "utf8"));
}

function respond(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === `/generics/translations/${appId}`) {
      return respond(res, 200, readTranslations());
    }

    if (req.method === "POST" && req.url === "/generics/translations") {
      req.setEncoding("utf8");
      let raw = "";
      for await (const chunk of req) raw += chunk;

      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        return respond(res, 400, { error: "Expected a JSON request body" });
      }
      const { key, value } = payload ?? {};
      if (typeof key !== "string" || !key.trim() || typeof value !== "string") {
        return respond(res, 400, { error: "Expected a non-empty key and a string value" });
      }

      const translations = readTranslations();
      if (Object.hasOwn(translations.en, key)) {
        return respond(res, 409, { error: "Key already registered" });
      }
      translations.en = { ...translations.en, [key]: value };
      saveTranslations(translations);
      return respond(res, 201, { key, value });
    }

    respond(res, 404, { error: "Unknown endpoint or app" });
  } catch (error) {
    console.error(error);
    respond(res, 500, { error: "Test database request failed" });
  }
});

const sync = process.argv.includes("--sync");
server.listen(sync ? 0 : 4179, "127.0.0.1", () => {
  saveTranslations(seedTranslations);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  console.log(`Translation test API listening at ${baseUrl}`);
  console.log("Seeded demo/.i18n-test-db.json");

  if (sync) {
    const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const child = spawn(process.execPath, [cli, "sync", "--apply", "--yes"], {
      cwd: new URL("./", import.meta.url),
      env: { ...process.env, I18N_DEMO_API_URL: baseUrl },
      stdio: "inherit",
    });
    child.on("error", (error) => console.error(error));
    child.on("close", (code) => {
      process.exitCode = code ?? 1;
      server.close();
    });
  }
});
