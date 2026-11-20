# swd-translation-checker

Find translation keys in JavaScript and TypeScript source, compare them with
your translation API, and optionally register missing keys.

The scanner works with common `i18next` patterns. The API adapter is
configurable because every translation backend has its own request and response
shape. Scanning is local; `check` and `sync` contact your configured API.

## Features

- Finds keys in `t("...")`, `i18n.t("...")`, and `<Trans i18nKey="..." />`.
- Supports configured translation function and hook names.
- Reports dynamic key usages that cannot be resolved statically.
- Compares discovered keys with an existing translation API.
- Dry-runs registration by default; live POST requests require `sync --apply`.
- Includes a local JSON mock adapter for trying the workflow without an API.

## Requirements

- Node.js 16 or later.
- `typescript` 5 or later in your project (used to parse source files).
- An API configuration or custom adapter for `check` and `sync`. The `scan`
  command works without an API.

## Install

```sh
npm install --save-dev swd-translation-checker
```

The package is named `swd-translation-checker`; the installed CLI command is
`i18n-keys`.

## Quick start

```sh
npx i18n-keys init          # creates i18n-keys.config.ts
npx i18n-keys scan --list   # no network needed
npx i18n-keys sync --mock   # try the whole flow against a local file
```

## Configure

Create `i18n-keys.config.mjs` (or run `npx i18n-keys init`):

```js
import { defineConfig } from "swd-translation-checker";

const baseUrl = process.env.I18N_API_URL;
if (!baseUrl) {
  throw new Error("Set I18N_API_URL before running i18n-keys.");
}

export default defineConfig({
  appId: "your-app-id",
  include: ["src/**/*.{js,jsx,ts,tsx}"],
  exclude: ["**/*.test.*", "**/*.stories.*"],
  dynamicKeys: "warn", // "warn", "error", or "ignore"

  api: {
    baseUrl,
    headers: () => {
      const token = process.env.I18N_API_TOKEN;
      return token ? { Authorization: `Bearer ${token}` } : {};
    },

    // Optional. By default the GET response is expected to be
    // { "<baseLang>": { "<key>": "<value or null>" } } and the keys of the
    // `baseLang` dictionary (default "en") are used. Override for other shapes:
    // baseLang: "en",
    // parseExisting: (body) => body.keys,

    // Adapt this to the request body expected by your POST endpoint.
    buildPayload: (keys, appId) => ({ appId, keys }),
  },
});
```

Set `I18N_API_URL` and, if needed, `I18N_API_TOKEN` in your environment. The
example assumes that the GET endpoint returns an English dictionary and that
the POST endpoint accepts `{ appId, keys }`; override `parseExisting` and
`buildPayload` to match your API's contract. A `.env` file in the working
directory is loaded automatically.

By default, the HTTP adapter uses
`GET /api/GetTranslations/{appId}` and
`POST /Generics/TranslationRequests`. Override these with `getUrl` and
`postUrl` if your API uses different paths. By default, each POST contains one
missing key (`batchSize: 1`), so syncing multiple keys makes multiple POST
requests. Up to three requests may be in flight at once by default; configure
`concurrency` and a larger `batchSize` if your backend accepts larger batches.
Retry behavior can also be configured to match your backend.

The CLI also supports TypeScript and JavaScript config files (`.ts`, `.mts`,
`.js`, `.cjs`) and JSON config files.

## Usage

```sh
# Scan source files; does not contact the API.
npx i18n-keys scan

# Compare discovered keys with the API; never registers keys.
npx i18n-keys check

# Preview missing keys. This is a dry run unless --apply is supplied.
npx i18n-keys sync

# Register missing keys with the configured API.
npx i18n-keys sync --apply
```

`sync --apply` asks for confirmation when run in an interactive terminal. In
non-interactive environments (CI, pipes) it **does not prompt**, so review your
payload with a dry run first. Add `--yes` to skip the prompt in a terminal.

To try the full workflow against a local JSON file instead of a real API:

```sh
npx i18n-keys sync --mock
npx i18n-keys sync --mock --apply
```

The mock stores keys in `.i18n-keys-mock.json` (override with `mockFile`). The
file may contain a flat `{ "keys": [...] }` list or language dictionaries such
as `{ "en": { "Save": "Save" }, "fr": { "Save": "Enregistrer" } }`. Dictionary
mock files are compared using their English (`en`) keys.

To create a translation handoff file without contacting the API, use
`check --mock --export-missing <file>`:

```sh
npx i18n-keys check --mock --export-missing untranslated.json
```

The export contains missing keys as dictionaries for `en`, `fr`, `zh`, `es`,
`de`, `it`, and `pt`. English values default to the key text; other language
values are empty for translators to fill in. This assumes the key itself is
the English source text.

## Key detection

By default, the scanner recognizes calls to `t`, `i18n.t`, and `i18next.t`,
including `t` or `i18n` obtained from `useTranslation()`. It also recognizes
`Trans` components with an `i18nKey` attribute. Configure `functions`, `hooks`,
`i18nObjects`, and `transComponents` to match your project.

Static string literals, string concatenations, arrays of keys, and both
branches of a conditional expression are collected. Expressions that depend
on runtime values are reported as dynamic usages. For dynamic keys, declare
the possible keys on the same line or the line above:

```ts
// i18n-keys: "Active", "Inactive"
t(status);
```

Translation strings containing brace placeholders such as `({0} item)` are
ignored rather than exported as incomplete keys.

Add `// i18n-keys-ignore` on a translation call or the line immediately above
it to omit that call from scanning. `dynamicKeys` controls whether unresolved
dynamic usages are warnings, errors, or ignored. `ignoreDynamic` can also
filter dynamic usages by regular expression.

## Options

```text
--config <file>   Use a specific config file
--since <ref>     Scan only files changed since a git ref
--staged          Scan only git-staged files
--apply           (sync) Send registration requests; otherwise sync is a dry run
--limit <n>       (sync) Register at most n missing keys
--yes             (sync --apply) Skip the interactive confirmation prompt
--mock            Use the local JSON mock instead of the configured API
--fail-on-missing Exit 1 if keys are still missing afterwards (see below)
--json <file>     Write a JSON report
--export-missing <file> Write missing keys as locale dictionaries
--list            (scan) Print each discovered key
--locations       (scan --list) Show file and line for each key
--filter <text>   (scan --list) Show only keys containing text
--verbose         Don't truncate long lists
```

`--staged` and `--since` change which source files are scanned; they do not
make the API comparison incremental.

### Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | Success |
| 1 | Key errors, `dynamicKeys: "error"` with dynamic usages, failed registrations, or `--fail-on-missing` with keys still missing |
| 2 | Usage, config, git, or API fetch error |

With `sync --apply --fail-on-missing`, the command exits 0 when every missing
key was registered successfully, and 1 if any remain (failures or `--limit`).

### CI example

```sh
npx i18n-keys check --fail-on-missing --json i18n-report.json
```

## API adapter

If you already have an API client or need custom behavior, provide an `adapter`
in the config instead of `api`. An adapter implements:

- `fetchExisting(appId)`: return all existing keys as a flat `string[]`.
- `register(keys, appId)`: register one batch and return `registered`,
  `duplicate`, or `failed`.

See the exported `ApiAdapter` type for the full interface.
