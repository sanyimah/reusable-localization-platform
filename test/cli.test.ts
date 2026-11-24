import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const cliPath = path.resolve(process.cwd(), "dist/cli.js");
const scratchDirectories: string[] = [];

function createScratchProject(): string {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "i18n-keys-cli-"));
  scratchDirectories.push(cwd);
  mkdirSync(path.join(cwd, "ClientApp", "src"), { recursive: true });
  writeFileSync(
    path.join(cwd, "ClientApp", "src", "app.js"),
    't("Save");\nt("Cancel");\n',
  );
  writeFileSync(
    path.join(cwd, "i18n-keys.config.json"),
    JSON.stringify({
      appId: "test",
      include: ["ClientApp/src/**/*.{js,jsx,ts,tsx}"],
    }),
  );
  writeFileSync(
    path.join(cwd, ".i18n-keys-mock.json"),
    JSON.stringify({ keys: [] }),
  );
  return cwd;
}

function runCli(cwd: string, args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args], { cwd });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stdout, stderr }));
    },
  );
}

afterAll(() => {
  for (const directory of scratchDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CLI", () => {
  it("scans the default ClientApp/src tree without a config file", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "i18n-keys-no-config-"));
    scratchDirectories.push(cwd);
    mkdirSync(path.join(cwd, "ClientApp", "src"), { recursive: true });
    writeFileSync(
      path.join(cwd, "ClientApp", "src", "app.jsx"),
      'export default function App(){ const { t } = useTranslation(); return <button>{t("Save")}</button>; }',
    );

    const result = await runCli(cwd, ["scan", "--list"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"Save"');
  });

  it("generates per-locale files without API configuration when the scan is empty", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "i18n-keys-generate-cli-"));
    scratchDirectories.push(cwd);
    mkdirSync(path.join(cwd, "src"));

    const result = await runCli(cwd, ["generate"]);

    expect(result.status).toBe(0);
    expect(
      ["en", "fr", "zh", "es", "de", "it", "pt"].map((locale) =>
        readFileSync(path.join(cwd, "Translations", `${locale}.json`), "utf8"),
      ),
    ).toEqual(Array(7).fill("{}\n"));
  });

  it("initializes a scan-only config without API settings", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "i18n-keys-init-"));
    scratchDirectories.push(cwd);
    const result = await runCli(cwd, ["init"]);
    const config = readFileSync(path.join(cwd, "i18n-keys.config.ts"), "utf8");

    expect(result.status).toBe(0);
    expect(config).toContain('include: ["ClientApp/src/**/*.{js,jsx,ts,tsx}"]');
    expect(config).toContain('translationsDir: "Translations"');
    expect(config).not.toContain("api:");
    expect(config).not.toContain("appId:");
  });

  it("passes fail-on-missing after successfully registering all missing keys", async () => {
    const cwd = createScratchProject();
    const result = await runCli(cwd, [
      "sync",
      "--mock",
      "--apply",
      "--yes",
      "--fail-on-missing",
    ]);

    expect(result.status).toBe(0);
    expect(
      JSON.parse(
        readFileSync(path.join(cwd, ".i18n-keys-mock.json"), "utf8"),
      ).keys,
    ).toEqual(["Cancel", "Save"]);
    expect(result.stdout).toContain("All missing keys were registered.");
  });

  it("exports missing keys to the configured locale dictionaries using the mock database", async () => {
    const cwd = createScratchProject();
    const mockFile = path.join(cwd, ".i18n-keys-mock.json");
    const initialMock = JSON.stringify({
      en: { Save: "Save" },
      fr: { Save: "Enregistrer" },
    });
    writeFileSync(mockFile, initialMock);

    const result = await runCli(cwd, [
      "check",
      "--mock",
      "--export-missing",
      "untranslated.json",
    ]);

    expect(result.status).toBe(0);
    const exported = JSON.parse(
      readFileSync(path.join(cwd, "untranslated.json"), "utf8"),
    );
    expect(exported).toEqual({
      en: { Cancel: "Cancel" },
      fr: { Cancel: "" },
      zh: { Cancel: "" },
      es: { Cancel: "" },
      de: { Cancel: "" },
      it: { Cancel: "" },
      pt: { Cancel: "" },
    });
    expect(readFileSync(mockFile, "utf8")).toBe(initialMock);
  });

  it("fails a dry run while missing keys remain and performs no writes", async () => {
    const cwd = createScratchProject();
    const result = await runCli(cwd, [
      "sync",
      "--mock",
      "--fail-on-missing",
    ]);

    expect(result.status).toBe(1);
    expect(
      JSON.parse(
        readFileSync(path.join(cwd, ".i18n-keys-mock.json"), "utf8"),
      ).keys,
    ).toEqual([]);
  });

  it("fails when --limit leaves keys unregistered", async () => {
    const cwd = createScratchProject();
    const result = await runCli(cwd, [
      "sync",
      "--mock",
      "--apply",
      "--yes",
      "--fail-on-missing",
      "--limit",
      "1",
    ]);

    expect(result.status).toBe(1);
    expect(
      JSON.parse(
        readFileSync(path.join(cwd, ".i18n-keys-mock.json"), "utf8"),
      ).keys,
    ).toHaveLength(1);
  });

  it("fails when a registration fails", async () => {
    const cwd = createScratchProject();
    const server = createServer((req, res) => {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ en: {} }));
        return;
      }
      res.writeHead(500);
      res.end("registration rejected");
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected the test server to have a TCP address.");
      }
      writeFileSync(
        path.join(cwd, "i18n-keys.config.mjs"),
        `export default {
          appId: "test",
          include: ["ClientApp/src/**/*.js"],
          api: {
            baseUrl: "http://127.0.0.1:${address.port}",
            getUrl: () => "/translations",
            postUrl: "/translations",
            buildPayload: (keys) => ({ keys }),
          },
        };`,
      );
      const result = await runCli(cwd, [
        "sync",
        "--config",
        "i18n-keys.config.mjs",
        "--apply",
        "--yes",
        "--fail-on-missing",
      ]);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Failed:");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each([
    ["--staged", "--staged"],
    ["--since", "--since", "HEAD"],
  ])("returns one git error line for %s outside a repository", async (_name, ...gitArgs) => {
    const cwd = createScratchProject();
    const result = await runCli(cwd, [
      "scan",
      ...gitArgs,
      "--config",
      "i18n-keys.config.json",
    ]);

    expect(result.status).toBe(2);
    const lines = result.stderr.trim().split(/\r?\n/);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("--staged/--since need a git repository with git installed");
    expect(lines[0].toLowerCase()).not.toContain("usage:");
  });
});
