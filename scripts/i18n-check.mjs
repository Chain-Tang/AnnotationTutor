import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

const placeholders = value => [...new Set([...value.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]))].sort().join("\0");

/** Check the merged runtime dictionaries, including board and upgrade keys. */
export function validateLocaleTables(tables) {
  const errors = [];
  const english = tables.en;
  const expected = Object.keys(english).sort();
  for (const [locale, table] of Object.entries(tables)) {
    const actual = Object.keys(table).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push(`${locale}: locale keys differ from English`);
    for (const key of expected) {
      const value = table[key];
      if (typeof value !== "string" || !value.trim()) errors.push(`${locale}: empty or missing ${key}`);
      else if (placeholders(value) !== placeholders(english[key])) errors.push(`${locale}: placeholder mismatch in ${key}`);
    }
  }
  return errors;
}

/** Only inspect imported translators; comments and unrelated t() calls are ignored. */
export function auditTranslationCalls(source, file, keys) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const names = new Set(), namespaces = new Set();
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
      !/(?:^|\/)i18n(?:\.[cm]?[jt]s)?$/.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    else if (bindings) for (const binding of bindings.elements) {
      if ((binding.propertyName?.text ?? binding.name.text) === "t") names.add(binding.name.text);
    }
  }
  const errors = [];
  let literalCalls = 0, dynamicCalls = 0;
  const visit = node => {
    if (ts.isCallExpression(node) && (
      ts.isIdentifier(node.expression) && names.has(node.expression.text) ||
      ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "t" &&
        ts.isIdentifier(node.expression.expression) && namespaces.has(node.expression.expression.text)
    )) {
      const argument = node.arguments[0];
      if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
        literalCalls++;
        if (!keys.has(argument.text)) errors.push(`${file}:${parsed.getLineAndCharacterOfPosition(argument.getStart(parsed)).line + 1}: missing translation ${argument.text}`);
      } else dynamicCalls++;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return { errors, literalCalls, dynamicCalls };
}

export async function auditI18n(root = path.resolve(import.meta.dirname, "..")) {
  const output = await build({ absWorkingDir: root, entryPoints: ["src/i18n.ts"], bundle: true,
    write: false, platform: "node", format: "esm", logLevel: "silent" });
  const { localeTables } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
  const errors = validateLocaleTables(localeTables), keys = new Set(Object.keys(localeTables.en));
  let literalCalls = 0, dynamicCalls = 0;
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name.endsWith(".ts")) {
        const result = auditTranslationCalls(await readFile(file, "utf8"), path.relative(root, file), keys);
        errors.push(...result.errors); literalCalls += result.literalCalls; dynamicCalls += result.dynamicCalls;
      }
    }
  };
  await walk(path.join(root, "src"));
  return { errors, keys: keys.size, locales: Object.keys(localeTables).length, literalCalls, dynamicCalls };
}

export async function runAudit() {
  const result = await auditI18n();
  if (result.errors.length) {
    for (const error of result.errors) console.error(error);
    process.exitCode = 1;
  } else console.log(`i18n check passed: ${result.locales} merged locales, ${result.keys} keys, ${result.literalCalls} literal calls (${result.dynamicCalls} dynamic calls retained).`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await runAudit();
