import { test } from "node:test";
import * as assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..");
/** Files that may talk to VS Code: activation and the port adapters. */
const HOST = new Set(["src/extension.ts", "src/vscodeAdapters.ts"]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

test("only the host layer imports vscode", () => {
  const offenders = sources(join(ROOT, "src"))
    .map((f) => relative(ROOT, f).split("\\").join("/"))
    .filter((f) => !HOST.has(f))
    .filter((f) => /from\s+["']vscode["']|require\(\s*["']vscode["']\s*\)/.test(readFileSync(join(ROOT, f), "utf8")));
  assert.deepEqual(offenders, []);
});
