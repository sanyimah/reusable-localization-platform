import { describe, expect, it } from "vitest";
import { extractFromSource } from "../src/extractor.js";

const keysOf = (code: string, file = "a.tsx") =>
  extractFromSource(file, code).keys.map((k) => k.key);

describe("extractor", () => {
  it("finds t() from a destructured useTranslation", () => {
    const code = `
      function A() {
        const { t } = useTranslation();
        return <h1>{t("Customer Information")}</h1>;
      }`;
    expect(keysOf(code)).toEqual(["Customer Information"]);
  });

  it("does not report a dynamic usage covered by a declared-keys comment", () => {
    const code = `
      const { t } = useTranslation();
      // i18n-keys: "Active", "Inactive"
      const label = t(status);
      const other = t(\`errors.\${status}\`);`;
    const r = extractFromSource("a.tsx", code);
    expect(r.keys.map((k) => k.key).sort()).toEqual(["Active", "Inactive"]);
    expect(r.dynamic).toHaveLength(1);
  });

    it("extracts both branches of a conditional expression", () => {
    const code = `
      const { t } = useTranslation();
      t(formData?.id ? "BRV Band" : "Add BRV Band");`;
    const r = extractFromSource("a.tsx", code);
    expect(r.keys.map((k) => k.key).sort()).toEqual(["Add BRV Band", "BRV Band"]);
    expect(r.dynamic).toHaveLength(0);
  });

  it("follows a renamed t", () => {
    const code = `
      const { t: translate } = useTranslation();
      translate("Save Changes");`;
    expect(keysOf(code)).toEqual(["Save Changes"]);
  });

  it("supports the array form of useTranslation", () => {
    const code = `
      const [t] = useTranslation();
      t("Cancel");`;
    expect(keysOf(code)).toEqual(["Cancel"]);
  });

  it("supports i18n.t and i18next.t", () => {
    const code = `
      const { i18n } = useTranslation();
      i18n.t("From Hook");
      i18next.t("From Global");`;
    expect(keysOf(code).sort()).toEqual(["From Global", "From Hook"]);
  });

  it("supports const translation = useTranslation(); translation.t()", () => {
    const code = `
      const translation = useTranslation();
      translation.t("Via Object");`;
    expect(keysOf(code)).toEqual(["Via Object"]);
  });

  it("does not extract <Trans i18nKey>", () => {
    const code = `const x = <Trans i18nKey="Welcome Back" />;`;
    expect(keysOf(code)).toEqual([]);
  });

  it("extracts only title, placeholder, and label JSX attributes", () => {
    const code = `
      const component = (
        <button title="Save" aria-label={"Save changes"}>
          Save Changes
          <input label="Name" placeholder="Enter name" alt="Ignored" />
        </button>
      );`;
    expect(keysOf(code).sort()).toEqual(["Enter name", "Name", "Save"]);
  });

  it("does not extract visible JSX text", () => {
    const code = `const component = <span>Visible text ({count} items)</span>;`;
    expect(keysOf(code)).toEqual([]);
  });

  it("handles static template literals and constant concatenation", () => {
    const code = `
      const { t } = useTranslation();
      t(\`Static Template\`);
      t("Hello, " + "World");`;
    expect(keysOf(code).sort()).toEqual(["Hello, World", "Static Template"]);
  });

  it("handles the array fallback form", () => {
    const code = `
      const { t } = useTranslation();
      t(["First Choice", "Second Choice"]);`;
    expect(keysOf(code).sort()).toEqual(["First Choice", "Second Choice"]);
  });

  it("ignores the second argument (options / default value)", () => {
    const code = `
      const { t } = useTranslation();
      t("Items", { count: 3 });`;
    expect(keysOf(code)).toEqual(["Items"]);
  });

  it("ignores translation keys containing brace placeholders", () => {
    const code = `
      const { t } = useTranslation();
      t("({0} item)");
      t("{name} items");
      t("Normal item");`;
    expect(keysOf(code)).toEqual(["Normal item"]);
  });

  it("flags dynamic keys instead of guessing", () => {
    const code = `
      const { t } = useTranslation();
      t(\`status.\${s}\`);
      t(someVariable);`;
    const r = extractFromSource("a.tsx", code);
    expect(r.keys).toHaveLength(0);
    expect(r.dynamic).toHaveLength(2);
    expect(r.dynamic[0].reason).toContain("template literal");
    expect(r.dynamic[1].reason).toContain("someVariable");
  });

  it("picks up manually declared keys", () => {
    const code = `
      // i18n-keys: "Active", "Inactive"
      const label = t(status);`;
    expect(keysOf(code).sort()).toEqual(["Active", "Inactive"]);
  });

  it("skips usages marked i18n-keys-ignore", () => {
    const code = `
      const { t } = useTranslation();
      // i18n-keys-ignore
      t(someVariable);
      t("Real Key");`;
    const r = extractFromSource("a.tsx", code);
    expect(r.keys.map((k) => k.key)).toEqual(["Real Key"]);
    expect(r.dynamic).toHaveLength(0);
  });

  it("does not pick up unrelated function calls", () => {
    const code = `
      const { t } = useTranslation();
      console.log("not a key");
      format("also not a key");`;
    expect(keysOf(code)).toEqual([]);
  });

  it("works in plain .js and .ts files", () => {
    expect(keysOf(`i18next.t("In JS");`, "a.js")).toEqual(["In JS"]);
    expect(
      keysOf(`const x = <T,>(a: T) => a; i18next.t("In TS");`, "a.ts"),
    ).toEqual(["In TS"]);
  });

  it("reports line numbers", () => {
    const code = `\n\nconst { t } = useTranslation();\nt("Line Four");`;
    const r = extractFromSource("a.tsx", code);
    expect(r.keys[0].line).toBe(4);
  });
});
