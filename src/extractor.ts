import ts from "typescript";
import type { DynamicUsage, FileExtraction, KeyOccurrence } from "./types.js";

export interface ExtractOptions {
  functions: string[];
  hooks: string[];
  i18nObjects: string[];
  transComponents: string[];
}

export const DEFAULT_EXTRACT_OPTIONS: ExtractOptions = {
  functions: ["t"],
  hooks: ["useTranslation"],
  i18nObjects: ["i18n", "i18next"],
  transComponents: ["Trans"],
};

function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".ts") || file.endsWith(".mts") || file.endsWith(".cts"))
    return ts.ScriptKind.TS;
  return ts.ScriptKind.JSX; // .js / .jsx (plenty of .js files contain JSX)
}

function unwrap(node: ts.Expression): ts.Expression {
  let cur = node;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isSatisfiesExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/** "a", `a`, "a" + "b" -> string. Anything else -> undefined. */
function staticString(node: ts.Expression): string | undefined {
  const n = unwrap(node);
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
    return n.text;
  if (
    ts.isBinaryExpression(n) &&
    n.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const l = staticString(n.left);
    const r = staticString(n.right);
    if (l !== undefined && r !== undefined) return l + r;
  }
  return undefined;
}

function describeDynamic(n: ts.Expression): string {
  if (ts.isTemplateExpression(n)) return "template literal with expressions";
  if (ts.isIdentifier(n)) return `variable \`${n.text}\``;
  if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n))
    return "property/element access";
  if (ts.isConditionalExpression(n)) return "conditional expression";
  if (ts.isCallExpression(n)) return "function call result";
  if (ts.isSpreadElement(n)) return "spread element";
  return `non-literal expression (${ts.SyntaxKind[n.kind]})`;
}

const DECLARE_RE = /i18n-keys:\s*(.+)$/;
const QUOTED_RE = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
const BRACE_PLACEHOLDER_RE = /\{[^{}]*\}/;

export function extractFromSource(
  file: string,
  text: string,
  options: Partial<ExtractOptions> = {},
): FileExtraction {
  const opts = { ...DEFAULT_EXTRACT_OPTIONS, ...options };
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(file),
  );
  const lines = text.split(/\r?\n/);

  const keys: KeyOccurrence[] = [];
  const dynamic: DynamicUsage[] = [];

  const fnNames = new Set(opts.functions);
  const objNames = new Set(opts.i18nObjects);
  const hooks = new Set(opts.hooks);
  const trans = new Set(opts.transComponents);

  // Pass 1: learn what `t` / `i18n` are called in this file.
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = unwrap(node.initializer);
      if (
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        hooks.has(init.expression.text)
      ) {
        const name = node.name;
        if (ts.isObjectBindingPattern(name)) {
          for (const el of name.elements) {
            if (!ts.isIdentifier(el.name)) continue;
            const prop = el.propertyName
              ? ts.isIdentifier(el.propertyName)
                ? el.propertyName.text
                : undefined
              : el.name.text;
            if (prop === "t") fnNames.add(el.name.text);
            if (prop === "i18n") objNames.add(el.name.text);
          }
        } else if (ts.isArrayBindingPattern(name)) {
          const first = name.elements[0];
          if (
            first &&
            ts.isBindingElement(first) &&
            ts.isIdentifier(first.name)
          )
            fnNames.add(first.name.text);
        } else if (ts.isIdentifier(name)) {
          objNames.add(name.text); // const translation = useTranslation(); translation.t("x")
        }
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const posOf = (node: ts.Node) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(
      node.getStart(sf),
    );
    return { line: line + 1, column: character + 1 };
  };

  const isIgnored = (node: ts.Node): boolean => {
    const { line } = posOf(node); // 1-based
    return (
      (lines[line - 1] ?? "").includes("i18n-keys-ignore") ||
      (lines[line - 2] ?? "").includes("i18n-keys-ignore")
    );
  };

  const addKey = (key: string, node: ts.Node, via: string) => {
    if (isIgnored(node) || BRACE_PLACEHOLDER_RE.test(key)) return;
    keys.push({ key, file, via, ...posOf(node) });
  };

  const addDynamic = (expr: ts.Expression, node: ts.Node) => {
    if (isIgnored(node)) return;
    dynamic.push({
      file,
      snippet: node.getText(sf).replace(/\s+/g, " ").slice(0, 80),
      reason: describeDynamic(expr),
      ...posOf(node),
    });
  };

  const handleArg = (arg: ts.Expression, via: string, node: ts.Node): void => {
    const n = unwrap(arg);
    const s = staticString(n);
    if (s !== undefined) return addKey(s, node, via);
    if (ts.isArrayLiteralExpression(n)) {
      for (const el of n.elements) handleArg(el, via, node); // t(["a", "b"]) fallback form
      return;
    }
    if (ts.isConditionalExpression(n)) {
      handleArg(n.whenTrue, via, node); // t(cond ? "A" : "B")
      handleArg(n.whenFalse, via, node);
      return;
    }
    addDynamic(n, node);
  };

  // Pass 2: collect calls.
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && fnNames.has(callee.text)) {
        handleArg(node.arguments[0], "t", node);
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "t" &&
        ts.isIdentifier(callee.expression) &&
        objNames.has(callee.expression.text)
      ) {
        handleArg(node.arguments[0], `${callee.expression.text}.t`, node);
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Keys declared by hand for dynamic usages: // i18n-keys: "Active", "Inactive"
  const declaredLines = new Set<number>();
  lines.forEach((ln, i) => {
    const m = ln.match(DECLARE_RE);
    if (!m) return;
    declaredLines.add(i + 1);
    for (const q of m[1].matchAll(QUOTED_RE)) {
      const key = q[2].replace(/\\(["'`\\])/g, "$1");
      if (BRACE_PLACEHOLDER_RE.test(key)) continue;
      keys.push({
        key,
        file,
        line: i + 1,
        column: 1,
        via: "declared",
      });
    }
  });

  // A declare comment on the same line or the line above covers that dynamic call.
  const unresolved = dynamic.filter(
    (d) => !declaredLines.has(d.line) && !declaredLines.has(d.line - 1),
  );

  return { file, keys, dynamic: unresolved };
}
