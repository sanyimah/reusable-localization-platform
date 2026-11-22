# swd-translation-checker

Scan a client app for translatable UI text, generate per-language JSON files,
translate new entries with Google Translate, and review grammar suggestions.
The `generate` workflow does not connect to your app's translation API or
database.

## Features

- Finds keys in `t("...")`, `i18n.t("...")`, and `<Trans i18nKey="..." />`.
- Finds visible JSX text and common user-facing props such as `title`,
  `label`, `placeholder`, `alt`, and `aria-label`.
- Reports dynamic key usages that cannot be resolved statically.
- Writes `Translations/en.json`, `fr.json`, `zh.json`, `es.json`, `de.json`,
  `it.json`, and `pt.json`.
- Preserves existing translations and translates only missing entries.
- Prompts before applying grammar suggestions.

## Requirements

- Node.js 16 or later.
- `typescript` 5 or later in your project (used to parse source files).
- Internet access when generating translations or checking grammar.

## Install

```sh
npm install --save-dev swd-translation-checker
```

The package is named `swd-translation-checker`; the installed CLI command is
`i18n-keys`.

## Quick start

```sh
npx i18n-keys init
npx i18n-keys generate
```

`generate` scans `src/**/*.{js,jsx,ts,tsx}` by default; a config file is
optional. It creates one JSON file per locale in `Translations/`. English text
is used as the key in every locale file, and as the value in `en.json`.

New translations are sent to Google Translate, and generated text is checked
through Gramma's default LanguageTool service. Interactive runs ask before
sending text; use `--yes` to allow it without the initial prompt. Grammar
corrections are shown one at a time and are applied only when selected. In a
non-interactive run, suggestions are printed but not applied.

Existing locale values are preserved on reruns; only missing keys are
translated. Current locale values are grammar-checked on each run, but
corrections are applied only after an explicit selection. Review generated
translations before shipping.

## Configure

The config is optional. Create `i18n-keys.config.ts` (or run
`npx i18n-keys init`) to customize scan paths and output directory:

```js
import { defineConfig } from "swd-translation-checker";

export default defineConfig({
  include: ["src/**/*.{js,jsx,ts,tsx}"],
  exclude: ["**/*.test.*", "**/*.stories.*"],
  dynamicKeys: "warn", // "warn", "error", or "ignore"
  translationsDir: "Translations",
});
```

The CLI also supports JavaScript and JSON config files. The generator does not
need `appId`, API credentials, or an API section.

## Usage

```sh
# Generate or update locale JSON files.
npx i18n-keys generate

# Explicitly allow external translation/grammar services in CI.
npx i18n-keys generate --yes

# Scan and list discovered text without translating.
npx i18n-keys scan

# Legacy API workflow (optional).
npx i18n-keys check
```

`generate` uses Google Translate and LanguageTool over the network. The legacy
`check` and `sync` commands still use their configured API or `--mock`
adapter; they are separate from the per-locale generator.

## Key detection

The scanner recognizes calls to `t`, `i18n.t`, and `i18next.t`, including `t`
or `i18n` obtained from `useTranslation()`. It also recognizes `Trans`
components with an `i18nKey` attribute, visible JSX text, and common
user-facing JSX attributes.

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
--translations-dir <dir> Output directory for generated locale files
--yes             (generate) Allow external services; (sync --apply) skip prompt
--since <ref>     Scan only files changed since a git ref
--staged          Scan only git-staged files
--apply           (sync) Send registration requests; otherwise sync is a dry run
--limit <n>       (sync) Register at most n missing keys
--mock            Use the local JSON mock instead of the configured API
--fail-on-missing Exit 1 if keys are still missing afterwards (see below)
--json <file>     Write a JSON report
--export-missing <file> Write missing keys as locale dictionaries
--list            (scan) Print each discovered key
--locations       (scan --list) Show file and line for each key
--filter <text>   (scan --list) Show only keys containing text
--verbose         Don't truncate long lists
```

`--staged` and `--since` limit the source scan.

### Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | Success |
| 1 | Key errors, dynamic-key errors, failed registrations, or declined confirmation |
| 2 | Usage, config, git, or fetch error |

## Legacy API adapter

`check` and `sync` remain available for existing API workflows. If you already
have an API client, provide an `adapter` in the config. An adapter implements:

- `fetchExisting(appId)`: return all existing keys as a flat `string[]`.
- `register(keys, appId)`: register one batch and return `registered`,
  `duplicate`, or `failed`.

See the exported `ApiAdapter` type for the full interface.
